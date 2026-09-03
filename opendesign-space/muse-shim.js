#!/usr/bin/env node
/**
 * OpenDesign × HF Spaces — build-time muse-spark Responses-API shim.
 *
 * WHY: OpenCode Zen serves muse-spark-1.2/1.3 (incl. -contributor-free) ONLY
 * on the OpenAI Responses API (/v1/responses), while OpenDesign's openai BYOK
 * proxy only speaks /v1/chat/completions → Zen returns 500 "Internal server
 * error" for those models. Verified live on 2026-09-03 against
 * https://opencode.ai/zen/v1 (docs list /responses for muse; chat/completions
 * → 500, /responses → 200).
 *
 * WHAT: translates, in-process inside the daemon's /api/proxy/openai/stream
 * handler (compiled file), ONLY for models matching the muse pattern
 * (+ OD_RESPONSES_API_MODELS env extras, + OD_RESPONSES_API_ALL=1 force):
 *   request : chat/completions body → Responses body (instructions = system,
 *             input = role/content blocks, max_output_tokens = maxTokens,
 *             stream: true)
 *   response: Responses SSE (response.output_text.delta / response.completed /
 *             response.failed) → the same {start, delta, end} SSE the browser
 *             already consumes. Reasoning items are ignored by design.
 * Every other model keeps the ORIGINAL code path (byte-identical behavior).
 *
 * SAFETY: every anchor replacement asserts its occurrence count and FAILS the
 * docker build on mismatch — a silently half-applied auth-critical daemon is
 * worse than a failed build. Idempotent: re-running is a no-op.
 */
const fs = require('fs');

const CHAT = '/app/apps/daemon/dist/routes/chat.js';
const CONN = '/app/apps/daemon/dist/connectionTest.js';
const BYOK = '/app/apps/daemon/dist/runtimes/byok-opencode.js';

function mustRead(file) {
  if (!fs.existsSync(file)) die(`${file} not found — image layout changed?`);
  return fs.readFileSync(file, 'utf8');
}
function die(msg) {
  console.error(`[muse-shim] FATAL: ${msg}`);
  process.exit(1);
}
function count(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}
function replaceFirstAfter(hay, needle, from, replacement, label) {
  const idx = hay.indexOf(needle, from);
  if (idx === -1) die(`anchor not found after position ${from}: ${label}`);
  return hay.slice(0, idx) + replacement + hay.slice(idx + needle.length);
}
function replaceOnce(hay, needle, replacement, label) {
  const n = count(hay, needle);
  if (n !== 1) die(`anchor count ${n} (expected 1): ${label}`);
  return hay.replace(needle, replacement);
}

/* ─────────────────────────── routes/chat.js ─────────────────────────── */
let chat = mustRead(CHAT);
if (chat.includes('muse-shim')) {
  console.log('[muse-shim] chat.js already patched — skipping');
} else {
  // Anchor A: the openai-route URL + log line (unique in this file).
  const anchorA =
    "        const url = appendVersionedApiPath(baseUrl, '/chat/completions');\n" +
    '        console.log(`[proxy:openai] ${req.method} ${validated.parsed.hostname} model=${model}`);';
  if (count(chat, anchorA) !== 1) {
    die(`anchor A count ${count(chat, anchorA)} (expected 1) in chat.js`);
  }
  const anchorARepl = `        /* muse-shim: begin — route Responses-API-only models (Zen muse-spark) to /responses */
        const museRe = buildMuseResponsesModelRe();
        const useResponsesApi = museRe.test(String(model)) || process.env.OD_RESPONSES_API_ALL === '1';
        const url = useResponsesApi
            ? appendVersionedApiPath(baseUrl, '/responses')
            : appendVersionedApiPath(baseUrl, '/chat/completions');
        console.log(\`[proxy:openai] \${req.method} \${validated.parsed.hostname} model=\${model}\${useResponsesApi ? ' (responses-api)' : ''}\`);
        function buildMuseResponsesModelRe() {
            const extra = String(process.env.OD_RESPONSES_API_MODELS || '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
                .map(escapeRegExp);
            const patterns = ['muse-spark-1\\\\.[23](?:-[a-z0-9.-]+)?'].concat(extra);
            return new RegExp('^(?:' + patterns.join('|') + ')$', 'i');
        }
        function escapeRegExp(s) {
            return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        }
        function buildResponsesPayload(responsesModel, chatMessages, systemPromptText, maxTokensCap) {
            const input = (Array.isArray(chatMessages) ? chatMessages : []).map((msg) => {
                const role = msg && msg.role === 'assistant' ? 'assistant' : 'user';
                const textType = role === 'assistant' ? 'output_text' : 'input_text';
                const content = msg ? msg.content : '';
                if (typeof content === 'string') {
                    return { role, content: [{ type: textType, text: content }] };
                }
                const blocks = [];
                if (Array.isArray(content)) {
                    for (const b of content) {
                        if (b && b.type === 'text' && typeof b.text === 'string') {
                            blocks.push({ type: textType, text: b.text });
                        }
                        else if (b && b.type === 'image_url' && b.image_url && typeof b.image_url.url === 'string') {
                            blocks.push({ type: 'input_image', image_url: b.image_url.url });
                        }
                        else {
                            try {
                                blocks.push({ type: 'input_text', text: JSON.stringify(b) });
                            }
                            catch (_) { /* skip unusable block */ }
                        }
                    }
                }
                return { role, content: blocks.length > 0 ? blocks : [{ type: textType, text: '' }] };
            });
            const body = { model: responsesModel, input, max_output_tokens: maxTokensCap, stream: true };
            const effort = String(process.env.OD_MUSE_REASONING_EFFORT || 'high').toLowerCase();
            if (effort && effort !== 'default') {
                body.reasoning = { effort }; /* od-shim: reasoning effort (default high) */
            }
            if (typeof systemPromptText === 'string' && systemPromptText) {
                body.instructions = systemPromptText;
            }
            return body;
        }
        function extractResponsesText(data) {
            if (data && typeof data === 'object'
                && data.type === 'response.output_text.delta'
                && typeof data.delta === 'string') {
                return data.delta;
            }
            return '';
        }
        /* muse-shim: end */`;
  chat = chat.replace(anchorA, () => anchorARepl);
  const idxA = chat.indexOf('/* muse-shim: begin');

  // Anchor B: the openai-route payload builder. Exactly 1 on the pristine
  // pinned image (the azure route uses buildMaxCompletionTokensParam and a
  // different shape). Must also sit after the muse block (positional sanity).
  const anchorB = `        const payload = {
            model,
            messages: payloadMessages,
            ...buildOpenAIChatTokenParam(model, effectiveMaxTokens),
            stream: true,
        };`;
  const totalB = count(chat, anchorB);
  if (totalB !== 1) {
    die(`anchor B total count ${totalB} (expected 1)`);
  }
  const idxB = chat.indexOf(anchorB, idxA);
  if (idxB === -1) die('anchor B: no occurrence after muse block');
  const anchorBRepl = `        let payload;
        if (useResponsesApi) {
            const sysFirst = payloadMessages.length > 0 && payloadMessages[0] && payloadMessages[0].role === 'system'
                ? payloadMessages[0]
                : null;
            const sysText = sysFirst
                ? (typeof sysFirst.content === 'string' ? sysFirst.content : JSON.stringify(sysFirst.content))
                : '';
            const chatMsgs = sysFirst ? payloadMessages.slice(1) : payloadMessages;
            payload = buildResponsesPayload(model, chatMsgs, sysText, effectiveMaxTokens);
        }
        else {
            payload = {
                model,
                messages: payloadMessages,
                ...buildOpenAIChatTokenParam(model, effectiveMaxTokens),
                stream: true,
            };
        }`;
  chat = chat.slice(0, idxB) + anchorBRepl + chat.slice(idxB + anchorB.length);

  // Anchor C: inside THIS route's SSE loop (first `let ended = false;` after
  // our insertion point), translate Responses events before the chat extractor.
  const loopStart = chat.indexOf('let ended = false;', idxA);
  if (loopStart === -1) die('anchor C: SSE loop not found after muse block');
  const anchorC = '                const delta = extractOpenAIText(data);';
  const deltaIdx = chat.indexOf(anchorC, loopStart);
  if (deltaIdx === -1) die('anchor C: chat delta extractor not found in openai SSE loop');
  // Ensure this is the openai loop and not a later route's: the next
  // occurrence must belong to this handler (it is the FIRST after loopStart).
  const anchorCRepl = `                if (useResponsesApi) {
                    const museText = extractResponsesText(data);
                    if (museText) {
                        guard.sendDelta(museText);
                        if (guard.contaminated) {
                            sse.send('end', {});
                            ended = true;
                            return true;
                        }
                    }
                    if (data && data.type === 'response.completed') {
                        sse.send('end', {});
                        ended = true;
                        return true;
                    }
                    if (data && data.type === 'response.failed') {
                        const failErr = data.response && data.response.error;
                        const failMsg = (failErr && failErr.message) || 'Responses API request failed';
                        sendProxyError(sse, \`Provider error: \${failMsg}\`, { details: failErr, retryable: true });
                        ended = true;
                        return true;
                    }
                    if (data && data.type === 'response.incomplete' && data.response && data.response.incomplete_details) {
                        console.warn('[proxy:openai] responses incomplete:', JSON.stringify(data.response.incomplete_details));
                    }
                }
                const delta = extractOpenAIText(data);`;
  chat = chat.slice(0, deltaIdx) + anchorCRepl + chat.slice(deltaIdx + anchorC.length);

  fs.writeFileSync(CHAT, chat);
  console.log('[muse-shim] chat.js patched: muse-spark* → /responses (in-process), others untouched');
}

/* ── chat.js, anthropic proxy route + shared Responses streamer ──────────
 * The Side-Chat / quick-chat UI can run under an ANTHROPIC-protocol BYOK
 * config (the Settings form saves protocol=anthropic for Zen-style setups
 * because the model list works there too). The anthropic proxy route posts
 * to /messages, where Zen does NOT serve muse → 500 + CLI/browser-side
 * retry loops → the endless "Preparing/Thinking" and eventual silent
 * failure seen live on 2026-09-03. Fix: for muse models, the anthropic
 * route now streams via the Responses API with Bearer auth instead. Every
 * non-muse model keeps the original /messages path untouched.
 */
let chat2 = mustRead(CHAT);
if (chat2.includes('muse-shim-anthropic')) {
  console.log('[muse-shim] chat.js anthropic route already patched — skipping');
} else {
  // Anchor G: the exact tail of the /api/proxy/anthropic/stream route.
  const anchorG = `        const url = appendVersionedApiPath(baseUrl, '/messages');
        console.log(\`[proxy:anthropic] \${req.method} \${validated.parsed.hostname} model=\${model}\`);
        return runAnthropicChatStream(res, {
            url,
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            payload: buildAnthropicChatPayload(model, systemPrompt, messages, maxTokens),
            logTag: 'proxy:anthropic',
        });`;
  const totalG = count(chat2, anchorG);
  if (totalG !== 1) {
    die(`anchor G count ${totalG} (expected 1) in chat.js (anthropic proxy route)`);
  }
  const anchorGRepl = `        /* muse-shim-anthropic: muse-spark* are Responses-API-only on Zen;
           /messages 500s for them, so stream them via /responses here. */
        const useResponsesApi = museResponsesModelPredicate().test(String(model))
            || process.env.OD_RESPONSES_API_ALL === '1';
        if (useResponsesApi) {
            const responsesUrl = appendVersionedApiPath(baseUrl, '/responses');
            console.log(\`[proxy:anthropic] \${req.method} \${validated.parsed.hostname} model=\${model} (responses-api)\`);
            return runResponsesChatStream(res, {
                url: responsesUrl,
                headers: { Authorization: \`Bearer \${apiKey}\` },
                model: String(model),
                systemPrompt,
                messages,
                maxTokens,
                logTag: 'proxy:anthropic',
            });
        }
        const url = appendVersionedApiPath(baseUrl, '/messages');
        console.log(\`[proxy:anthropic] \${req.method} \${validated.parsed.hostname} model=\${model}\`);
        return runAnthropicChatStream(res, {
            url,
            headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            payload: buildAnthropicChatPayload(model, systemPrompt, messages, maxTokens),
            logTag: 'proxy:anthropic',
        });`;
  chat2 = chat2.replace(anchorG, () => anchorGRepl);

  // Anchor H: insert the shared Responses streamer + model predicate just
  // before buildGeminiChatPayload (same closure scope as the routes).
  const anchorH = '    const buildGeminiChatPayload = (systemPrompt, messages, maxTokens) => {';
  if (count(chat2, anchorH) !== 1) {
    die(`anchor H count ${count(chat2, anchorH)} (expected 1) in chat.js (gemini payload fn)`);
  }
  const anchorHRepl = `    function museResponsesModelPredicate() { /* muse-shim-anthropic */
        const extra = String(process.env.OD_RESPONSES_API_MODELS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const patterns = ['muse-spark-1[.][23](?:-[a-z0-9.-]+)?'].concat(extra);
        return new RegExp('^(?:' + patterns.join('|') + ')$', 'i');
    }
    const runResponsesChatStream = async (res, opts) => { /* muse-shim-anthropic */
        const sse = createSseResponse(res);
        let proxyDispatcher = null;
        try {
            proxyDispatcher = proxyDispatcherRequestInit();
            const signal = clientDisconnectSignal(res);
            sse.send('start', { model: opts.model });
            const input = (Array.isArray(opts.messages) ? opts.messages : []).map((msg) => {
                const role = msg && msg.role === 'assistant' ? 'assistant' : 'user';
                const textType = role === 'assistant' ? 'output_text' : 'input_text';
                const content = msg ? msg.content : '';
                if (typeof content === 'string') {
                    return { role, content: [{ type: textType, text: content }] };
                }
                const blocks = [];
                if (Array.isArray(content)) {
                    for (const b of content) {
                        if (b && b.type === 'text' && typeof b.text === 'string') {
                            blocks.push({ type: textType, text: b.text });
                        }
                        else if (b && b.type === 'image_url' && b.image_url && typeof b.image_url.url === 'string') {
                            blocks.push({ type: 'input_image', image_url: b.image_url.url });
                        }
                        else {
                            try {
                                blocks.push({ type: 'input_text', text: JSON.stringify(b) });
                            }
                            catch (_) { /* skip unusable block */ }
                        }
                    }
                }
                return { role, content: blocks.length > 0 ? blocks : [{ type: textType, text: '' }] };
            });
            const payload = {
                model: opts.model,
                input,
                max_output_tokens: typeof opts.maxTokens === 'number' && opts.maxTokens > 0 ? opts.maxTokens : 8192,
                stream: true,
            };
            const effort = String(process.env.OD_MUSE_REASONING_EFFORT || 'high').toLowerCase();
            if (effort && effort !== 'default') {
                payload.reasoning = { effort }; /* od-shim: reasoning effort (default high) */
            }
            if (typeof opts.systemPrompt === 'string' && opts.systemPrompt) {
                payload.instructions = opts.systemPrompt;
            }
            const response = await fetch(opts.url, {
                ...proxyDispatcher.requestInit,
                signal,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...opts.headers },
                body: JSON.stringify(payload),
                redirect: 'error',
            });
            if (!response.ok) {
                const errorText = await response.text();
                console.error(\`[\${opts.logTag}] responses upstream error: \${response.status} \${redactAuthTokens(errorText)}\`);
                sendProxyError(sse, \`Upstream error: \${response.status}\`, {
                    code: proxyErrorCode(response.status),
                    details: errorText,
                    retryable: response.status === 429 || response.status >= 500,
                });
                return sse.end();
            }
            let ended = false;
            const guard = createDeltaGuard(sse);
            await streamUpstreamSse(response, ({ data }) => {
                if (!data)
                    return false;
                if (data.type === 'response.output_text.delta' && typeof data.delta === 'string') {
                    guard.sendDelta(data.delta);
                    if (guard.contaminated) {
                        sse.send('end', {});
                        ended = true;
                        return true;
                    }
                }
                if (data.type === 'response.completed') {
                    sse.send('end', {});
                    ended = true;
                    return true;
                }
                if (data.type === 'response.failed') {
                    const failErr = data.response && data.response.error;
                    const failMsg = (failErr && failErr.message) || 'Responses API request failed';
                    sendProxyError(sse, 'Responses error: ' + failMsg, { details: failErr, retryable: true });
                    ended = true;
                    return true;
                }
                if (data.type === 'error') {
                    const message = (data.error && data.error.message) || data.message || 'Responses API upstream error';
                    sendProxyError(sse, message, { details: data });
                    ended = true;
                    return true;
                }
                return false;
            });
            if (!ended)
                sse.send('end', {});
            sse.end();
        }
        catch (err) {
            console.error(\`[\${opts.logTag}] responses internal error: \${err.message}\`);
            sendProxyError(sse, err.message, { code: 'INTERNAL_ERROR' });
            sse.end();
        }
        finally {
            await proxyDispatcher?.close();
        }
    };
    const buildGeminiChatPayload = (systemPrompt, messages, maxTokens) => {`;
  chat2 = chat2.replace(anchorH, () => anchorHRepl);

  fs.writeFileSync(CHAT, chat2);
  console.log('[muse-shim] chat.js anthropic route patched: muse → /responses stream, others unchanged');
}

function syntaxCheck(file) {
  const { execFileSync } = require('child_process');
  const tmp = `/tmp/syntax-${require('path').basename(file)}.mjs`;
  fs.copyFileSync(file, tmp);
  try {
    execFileSync('node', ['--check', tmp], { stdio: 'pipe' });
  } catch (err) {
    die(`patched ${file} fails node --check: ${err.stderr || err.message}`);
  } finally {
    fs.unlinkSync(tmp);
  }
}

/* ───────────────────────── connectionTest.js ───────────────────────── */
let conn = mustRead(CONN);
if (conn.includes('muse-shim')) {
  console.log('[muse-shim] connectionTest.js already patched — skipping');
} else {
  // D: send muse models through the Responses smoke test (chat/completions
  // 500s for them, so the Settings "Test connection" would false-fail).
  const anchorD = 'const runProviderPackage = resolveOpenAIConnectionTestRunProviderPackage(input);';
  if (count(conn, anchorD) !== 1) {
    die(`anchor D count ${count(conn, anchorD)} (expected 1) in connectionTest.js`);
  }
  const anchorDRepl = `const runProviderPackage = new RegExp('^(?:muse-spark-1\\\\.[23](?:-[a-z0-9.-]+)?' + String(process.env.OD_RESPONSES_API_MODELS || '')
                .split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('|') + ')$', 'i').test(String(input.model)) /* muse-shim */
            ? '@ai-sdk/openai'
            : resolveOpenAIConnectionTestRunProviderPackage(input);`;
  conn = conn.replace(anchorD, () => anchorDRepl);

  // E: reasoning burn needs headroom in the smoke test (100 tokens exhausts
  // inside reasoning → empty text → false failure).
  const anchorE = 'max_output_tokens: PROVIDER_MAX_TOKENS,';
  if (count(conn, anchorE) !== 1) {
    die(`anchor E count ${count(conn, anchorE)} (expected 1) in connectionTest.js`);
  }
  conn = conn.replace(anchorE, () => 'max_output_tokens: Math.max(PROVIDER_MAX_TOKENS, 2048), /* muse-shim */');

  fs.writeFileSync(CONN, conn);
  console.log('[muse-shim] connectionTest.js patched: muse smoke test → /responses with headroom');
}

/* ── connectionTest.js, anthropic-protocol muse branch ──────────────────
 * If the Settings provider is saved under the ANTHROPIC protocol (Zen's
 * /messages works for claude models, so users legitimately pick that
 * protocol there), the smoke test posts muse to /messages → 500 → Settings
 * shows "connection failed". Route muse to /responses with Bearer auth and
 * accept a Responses-shaped body in the completion check. All non-muse
 * anthropic models keep the exact original call + check.
 */
let conn2 = mustRead(CONN);
if (conn2.includes('muse-shim-anthropic')) {
  console.log('[muse-shim] connectionTest.js anthropic branch already patched — skipping');
} else {
  // Anchor I: the anthropic case in buildProviderCall.
  const anchorI = `        case 'anthropic':
            return {
                url: appendVersionedApiPath(baseUrl, '/messages'),
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: {
                    model,
                    max_tokens: PROVIDER_MAX_TOKENS,
                    messages: [{ role: 'user', content: SMOKE_PROMPT }],
                    stream: false,
                },
                extractText: (data) => {
                    const blocks = data.content;
                    if (!Array.isArray(blocks))
                        return '';
                    for (const block of blocks) {
                        if (block &&
                            typeof block === 'object' &&
                            block.type === 'text' &&
                            typeof block.text === 'string') {
                            return block.text;
                        }
                    }
                    return '';
                },
            };`;
  const totalI = count(conn2, anchorI);
  if (totalI !== 1) {
    die(`anchor I count ${totalI} (expected 1) in connectionTest.js (anthropic provider call)`);
  }
  const anchorIRepl = `        case 'anthropic': {
            /* muse-shim-anthropic: muse-spark* live on /responses (Bearer),
               not /messages (x-api-key) — Zen 500s the latter for them. */
            const museRe = new RegExp('^(?:muse-spark-1[.][23](?:-[a-z0-9.-]+)?'
                + String(process.env.OD_RESPONSES_API_MODELS || '')
                    .split(',').map((s) => s.trim()).filter(Boolean).join('|') + ')$', 'i');
            if (museRe.test(model) || process.env.OD_RESPONSES_API_ALL === '1') {
                return openAIResponsesProviderCall(baseUrl, apiKey, model);
            }
            return {
                url: appendVersionedApiPath(baseUrl, '/messages'),
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: {
                    model,
                    max_tokens: PROVIDER_MAX_TOKENS,
                    messages: [{ role: 'user', content: SMOKE_PROMPT }],
                    stream: false,
                },
                extractText: (data) => {
                    const blocks = data.content;
                    if (!Array.isArray(blocks))
                        return '';
                    for (const block of blocks) {
                        if (block &&
                            typeof block === 'object' &&
                            block.type === 'text' &&
                            typeof block.text === 'string') {
                            return block.text;
                        }
                    }
                    return '';
                },
            };
        }`;
  conn2 = conn2.replace(anchorI, () => anchorIRepl);

  // Anchor J: inspectProviderCompletion — the anthropic check requires an
  // Anthropic-shaped body (content array / stop_reason). muse now returns a
  // Responses-shaped body, so accept that too (muse models only).
  const anchorJ = `    if (protocol === 'anthropic') {
        return {
            valid: Array.isArray(obj.content) ||
                typeof obj.stop_reason === 'string',
            sample: 'valid completion',
        };
    }`;
  const totalJ = count(conn2, anchorJ);
  if (totalJ !== 1) {
    die(`anchor J count ${totalJ} (expected 1) in connectionTest.js (anthropic completion check)`);
  }
  const anchorJRepl = `    if (protocol === 'anthropic') {
        /* muse-shim-anthropic: muse responses come back Responses-shaped. */
        const museShaped = typeof obj.status === 'string'
            && (Array.isArray(obj.output) || typeof obj.output_text === 'string');
        if (museShaped) {
            return {
                valid: true,
                sample: 'valid completion',
            };
        }
        return {
            valid: Array.isArray(obj.content) ||
                typeof obj.stop_reason === 'string',
            sample: 'valid completion',
        };
    }`;
  conn2 = conn2.replace(anchorJ, () => anchorJRepl);

  fs.writeFileSync(CONN, conn2);
  console.log('[muse-shim] connectionTest.js anthropic branch patched: muse → /responses smoke test');
}// Final gate: both patched files MUST parse as ESM, or the build fails here
// instead of producing a boot-looping daemon.
syntaxCheck(CHAT);
syntaxCheck(CONN);

/* ─────────────── runtimes/byok-opencode.js (agent CLI path) ───────────────
 * The REAL design agent runs the OpenCode CLI whose provider entry picks
 * '@ai-sdk/openai' (Responses API) only for api.openai.com hosts — every
 * other host gets '@ai-sdk/openai-compatible' (/chat/completions), which
 * 500s for muse. Override the npm package for muse models AFTER the entry
 * is built (rawModel is in scope there; inside buildProviderEntry it is NOT).
 */
let byok = mustRead(BYOK);
if (byok.includes('muse-shim')) {
  console.log('[muse-shim] byok-opencode.js already patched — skipping');
} else {
  const anchorF = "    const providerEntry = buildProviderEntry(protocol, baseUrl, provider.apiVersion, needsApiKey);";
  const totalF = count(byok, anchorF);
  if (totalF !== 1) {
    die(`byok anchor F count ${totalF} (expected 1)`);
  }
  const anchorFRepl = `    let providerEntry = buildProviderEntry(protocol, baseUrl, provider.apiVersion, needsApiKey);
    if (providerEntry && (providerEntry.npm === '@ai-sdk/openai-compatible' || providerEntry.npm === '@ai-sdk/anthropic' || providerEntry.npm === '@ai-sdk/openai')
        && new RegExp('^(?:muse-spark-1\\\\.[23](?:-[a-z0-9.-]+)?' + String(process.env.OD_RESPONSES_API_MODELS || '')
            .split(',').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')).join('|') + ')$', 'i').test(rawModel)) { /* muse-shim */
        providerEntry = { ...providerEntry, npm: '@ai-sdk/openai' };
    }`;
  byok = byok.replace(anchorF, () => anchorFRepl);
  // Muse reasoning effort for the AGENT path: add `reasoning.effort` to the
  // model entry the daemon hands the CLI (merged into each Responses request
  // body by the @ai-sdk/openai provider). Default high, env-overridable.
  const anchorL = `                    [rawModel]: {
                        name: rawModel,
                        limit: {
                            context: DEFAULT_CONTEXT_TOKEN_LIMIT,
                            output: DEFAULT_OUTPUT_TOKEN_LIMIT,
                        },
                    },`;
  const totalL = count(byok, anchorL);
  if (totalL !== 1) {
    die(`byok anchor L count ${totalL} (expected 1)`);
  }
  const anchorLRepl = `                    [rawModel]: {
                        name: rawModel,
                        limit: {
                            context: DEFAULT_CONTEXT_TOKEN_LIMIT,
                            output: DEFAULT_OUTPUT_TOKEN_LIMIT,
                        },
                        ...(new RegExp('^(?:muse-spark-1\\\\\\\\.[23](?:-[a-z0-9.-]+)?' + String(process.env.OD_RESPONSES_API_MODELS || '')
                            .split(',').map((s) => s.trim()).filter(Boolean).join('|') + ')$', 'i').test(rawModel)
                            ? { options: { reasoningEffort: String(process.env.OD_MUSE_REASONING_EFFORT || 'high').toLowerCase() } }
                            : {}), /* muse-shim: reasoning effort */
                    },`;
  byok = byok.replace(anchorL, () => anchorLRepl);
  fs.writeFileSync(BYOK, byok);
  console.log('[muse-shim] byok-opencode.js patched: muse → @ai-sdk/openai (Responses) + reasoning effort in CLI runtime config');
}
syntaxCheck(BYOK);

/* ───────── opencode-permissions.js: headless permission bypass ───────────
 * OpenCode CLI v1.18.x REPLACED `--dangerously-skip-permissions` with `--auto`
 * ("auto-approve permissions that are not explicitly denied"). The daemon's
 * capability probe greps `run --help` for the OLD flag, finds nothing, and
 * never sends any bypass. Headless runs then auto-DENY the ask-level tools
 * (write/edit) → "Tool execution aborted" → the CLI exits 0 and the run is
 * reported "succeeded" with endedWithUnfinishedWork:true — i.e. every design
 * run that reached its first file write died at 2–4 min with no error shown.
 * Fix: point the flag constant at `--auto`. Both consumers (help probe +
 * appended arg) read the SAME constant, so one replacement fixes the pair.
 * Env-overridable in case a future CLI renames it again.
 */
const PERM = '/app/apps/daemon/dist/runtimes/opencode-permissions.js';
let perm = mustRead(PERM);
if (perm.includes('od-shim: permission bypass')) {
  console.log('[muse-shim] opencode-permissions.js already patched — skipping');
} else {
  const anchorK = "export const OPENCODE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';";
  const totalK = count(perm, anchorK);
  if (totalK !== 1) {
    die(`anchor K count ${totalK} (expected 1) in opencode-permissions.js`);
  }
  const anchorKRepl = `export const OPENCODE_SKIP_PERMISSIONS_FLAG = process.env.OD_OPENCODE_PERMISSION_BYPASS_FLAG || '--auto'; /* od-shim: permission bypass — CLI v1.18.x renamed --dangerously-skip-permissions to --auto; without it headless runs auto-deny write/edit ("Tool execution aborted") */`;
  perm = perm.replace(anchorK, () => anchorKRepl);
  fs.writeFileSync(PERM, perm);
  console.log('[muse-shim] opencode-permissions.js patched: bypass flag → --auto (env-overridable)');
}
syntaxCheck(PERM);

console.log('[muse-shim] done');
