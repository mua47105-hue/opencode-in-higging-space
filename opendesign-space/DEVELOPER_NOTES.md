# DEVELOPER NOTES — READ THIS FIRST

> Handoff for anyone (human or AI) continuing this Space. Like the HuggingMes
> blueprint (`bot404/newsalert/DEVELOPER_NOTES.md`), treat **Invariants** and
> **What not to do** as hard rules. Everything below was verified against the
> actual `nexu-io/open-design` source and live container runs on 2026-09-02
> (image `ghcr.io/nexu-io/od:0.21.1`, digest `sha256:441daca881e6996…`).

## 1. What this is

[OpenDesign](https://github.com/nexu-io/open-design) — open-source Claude Design
alternative — running on a HF Docker Space. Port of the HuggingMes architecture:
`start.sh` orchestrator, secrets-driven boot, HF Dataset persistence (`od-sync.py`),
one public port (7861). The daemon serves UI + API + auth itself; there is **no**
Node shim (unlike HuggingMes' health-server.js) because od already does that job
natively and better-tested.

## 2. Boot sequence

1. Docker build: pinned upstream image + curl/bash + `/opt/sync-venv` (python3 +
   huggingface_hub) + `a+rwX /app` + `chmod 777 /opt/data`.
2. `start.sh`:
   - `od-sync.py restore` (best-effort; never fatal).
   - Map `GATEWAY_TOKEN` → `OD_API_TOKEN` (alias); generate an ephemeral strong
     token if missing/short (od exits otherwise — see §3.1).
   - Derive `OD_ALLOWED_ORIGINS` from `$SPACE_HOST` if unset (§3.2).
   - Start `od-sync.py loop` in background (if `HF_TOKEN`).
   - Launch `node /app/apps/daemon/dist/cli.js --no-open` under a restart supervisor.
   - SIGTERM → forward to od, stop sync, final `sync-once` upload, exit.
3. HF probes `/api/health` (Docker HEALTHCHECK + platform) on 7861.

## 3. Invariants — do not violate

### 3.1 `OD_API_TOKEN` must be set whenever binding 0.0.0.0
od's own guard (`server.js:1740` area): `OD_BIND_HOST=0.0.0.0` without a token
**exits at startup** (verified live). HF Spaces require 0.0.0.0, so the Space
must always export a ≥16-char token. start.sh generates an ephemeral one when
the secret is missing so the Space never crash-loops — but then login changes
per boot; always set the secret.

### 3.2 `OD_ALLOWED_ORIGINS` must include the browser origin
Any request with an `Origin` header that is not whitelisted → **403** on all
`/api/*` (verified live). On hf.space the UI's own fetches carry
`Origin: https://<owner>-<space>.hf.space`, so start.sh derives
`https://$SPACE_HOST` automatically. If you add a custom domain, set
`OD_EXTRA_ORIGINS` (comma-separated) — do not disable the guard.

### 3.3 `OD_DATA_DIR=/opt/data` is the only durable path
Everything that must survive restarts (app.sqlite, projects/, artifacts/,
memory/, skills/, plugins/, brands/, design-systems/, design-templates/,
library/, critique-artifacts/) lives under it and is synced by od-sync.py.
Nothing else in the container is persistent. `/app` is made world-writable
because HF's runtime UID is arbitrary; od writes plugin/bundled state there.

### 3.4 BYOK credentials are browser-side — by design
The web app keeps provider config in `localStorage['open-design:config']`
(`apps/web/src/state/config.ts`, STORAGE_KEY). The daemon's BYOK forwarding routes take
`baseUrl + apiKey + model` **per request** (`apps/daemon/src/routes/chat.ts`) and
forward `Authorization: Bearer <key>` (OpenAI route) or `x-api-key` (Anthropic
route). There is no server-side credential file to seed; do not add one. This
also means the sync backup never carries provider keys in project files — the
redaction pass in od-sync.py covers the config/state files that do exist.

### 3.5 Zen is keyed now
Verified 2026-09-02: `POST https://opencode.ai/zen/v1/chat/completions` without a
valid key → 401 `AuthError` (with any Bearer) or 500 (no auth header);
`/v1/models` lists models but that does not make chat keyless. Free models
(`big-pickle`, `mimo-v2.5-free`, `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`,
`nemotron-3.5-lightning-free`, `laguna-s-2.1-free`) cost $0 with a free Zen
account key. HF egress IPs are shared → 429s under load are the HuggingMes
lesson all over again; document it, don't engineer around it inside the Space.

### 3.5b muse-spark Responses-API shim (muse-shim.js, added 2026-09-03)
Zen serves `muse-spark-1.2/1.3(-contributor-free)` ONLY on the OpenAI
**Responses API** (`/v1/responses`); on `/chat/completions` they 500
("Internal server error") — verified live both ways. OpenDesign's openai BYOK
proxy only speaks chat/completions, so the Dockerfile runs `muse-shim.js` at
build time to translate, **in-process**, inside the compiled
`/api/proxy/openai/stream` handler:
- only models matching `muse-spark-1.[23](-…)*` (plus `OD_RESPONSES_API_MODELS`
  extras, or `OD_RESPONSES_API_ALL=1` to force all) go to `/responses`;
- chat body → Responses body (`instructions`=system, `input`=role/content
  blocks, `max_output_tokens`, `stream:true`); Responses SSE events
  (`response.output_text.delta` / `.completed` / `.failed`) → the same
  `{start,delta,end}` frames the browser already consumes. Reasoning items
  are ignored (never leak into the reply).
- every other model takes the ORIGINAL code path — zero behavioral or
  performance impact. `connectionTest.js` smoke test also routes muse to
  `/responses` with `max_output_tokens>=2048` headroom (reasoning burns
  tokens; 100 would false-fail).
- the patcher FAILS THE BUILD on any anchor mismatch and gates on
  `node --check` of the patched files; headroom is fixed at 2048 in the
  smoke test only.
Upgrading the pinned od tag ⇒ re-check anchors (patcher is fail-loud, not
fail-silent).

### 3.5c Design agent requires the bundled OpenCode CLI (added 2026-09-03)
The REAL design-generation flow (Home composer → `POST /api/runs` →
`byok-opencode` agent) spawns the **OpenCode CLI binary**; the daemon never
falls back to the proxy-stream route. The pinned image does NOT ship it →
every design run failed with "BYOK API runs require OpenCode. Install
OpenCode…". Fix baked into the Dockerfile:
- official installer pins `OPENCODE_VERSION=1.18.27` (works on Alpine/musl)
- binary placed at `/app/bin/libexec/opencode/opencode` and
  `OD_RESOURCE_ROOT=/app` set — the FIRST location `detectAgents()` scans
  (verified via `GET /api/agents` → `available: true`, `path: …`).
- The CLI's provider config (`runtimes/byok-opencode.js`) picks
  `@ai-sdk/openai-compatible` (chat/completions) for non-OpenAI hosts, which
  500s muse → muse-shim.js overrides it to `@ai-sdk/openai` (Responses API)
  for muse models only, AFTER the entry is built (rawModel in scope there —
  NOT inside `buildProviderEntry`, where patching threw ReferenceError).
- Live-verified: `/api/runs` with muse 1.3 → text_delta AGENT-OK, cost 0,
  status succeeded; big-pickle regression also succeeded.
Note: `requiresApiKey` for byok is enforced by the daemon; the CLI gets the
key via `OPEN_DESIGN_BYOK_API_KEY` env (injected per run, never persisted).

### 3.5g muse reasoning effort = high (added 2026-09-03)
OpenDesign never sends a reasoning-effort parameter (start event `reasoning:
null`), so muse ran on Zen's server default — measured 429–1435 reasoning tokens
on identical prompts (unpredictable depth). muse accepts
`reasoning: {effort: low|medium|high|xhigh}` on /responses (verified live on
all four; token counts move accordingly: low≈246–576, high≈411–1512). Fix:
muse-shim.js now injects `reasoning: {effort}` on ALL muse paths — proxy chat
payload, anthropic-route Responses streamer, and the CLI model config
(`options.reasoningEffort`, which @ai-sdk/openai merges into the request body).
Default **high** (user requirement: maximum reasoning quality, explicitly not
xhigh), env-overridable via `OD_MUSE_REASONING_EFFORT` (e.g. `low` for snappy
side-chat, `default` to restore server default). Non-muse models: nothing
injected, stock behavior.

### 3.5f CLI permission bypass: --auto (added 2026-09-03, live-reproduced)
OpenCode CLI v1.18.x REPLACED `--dangerously-skip-permissions` with `--auto`.
The daemon's capability probe greps `run --help` for the OLD flag → resolves
`skipPermissions: false` → never appends any bypass → headless runs auto-DENY
ask-level tools (write/edit) → `Tool execution aborted` (isError) → CLI exits 0
→ run reported `succeeded` with `endedWithUnfinishedWork: true`. Every design
run that reached its first file write died at 2–4 min with NO error in the UI.
Live-reproduced from run 44ff2387 (11 tool calls OK, then write → aborted).
Fix in muse-shim.js: the compiled `opencode-permissions.js` flag constant is
now `process.env.OD_OPENCODE_PERMISSION_BYPASS_FLAG || '--auto'` — both the
help-probe and the appended arg read that one constant, so one replacement
fixes the pair. Env-overridable if the CLI renames the flag again.
Verified locally: write tool → `Wrote file successfully.` (was aborted),
run succeeds with the file actually created.

### 3.5e muse must be routed from EVERY protocol (added 2026-09-03, live-reproduced)
The Settings BYOK config is protocol-tagged, and users legitimately save Zen under
the **anthropic** protocol (its /messages serves claude models and the model list
works). But Zen serves muse-spark* ONLY on /v1/responses, so muse reached Zen's
`/messages` → **instant 500** → the OpenCode CLI retries with backoff (~75s per
attempt) → the daemon retries once → run dies at ~150s with
`UPSTREAM_UNAVAILABLE / upstream_5xx` while the UI still shows
"Preparing/Thinking". Live-reproduced 2026-09-03 (run 3efb1412, two 500s, 150.8s).
muse-shim.js therefore routes muse from ALL THREE paths, regardless of protocol:
- `chat.js` `/api/proxy/anthropic/stream`: muse → new in-process
  `runResponsesChatStream` (Responses SSE → {start,delta,end} frames, Bearer auth);
- `runtimes/byok-opencode.js`: CLI provider override now fires for BOTH
  `@ai-sdk/openai-compatible` AND `@ai-sdk/anthropic` → muse runs on `@ai-sdk/openai`;
- `connectionTest.js`: anthropic-protocol muse smoke test → /responses (Bearer),
  and `inspectProviderCompletion` accepts Responses-shaped bodies for muse.
Non-muse models keep the byte-identical original paths. NOTE: this does NOT make
other models work under the anthropic protocol on Zen (big-pickle via /messages
still 500s — it was never served there); the universal protocol for Zen remains
**openai** (§2 of DEPLOYMENT_README). Zen free-tier realities measured the same
day: muse 200 in 1–3s (not rate-limited); big-pickle/mimo 429 FreeUsageLimitError
(rolling per-model limits); ling-3.0-flash 503 (Zen outage); nemotron-3-ultra 200
but 61s (shared infra); claude-sonnet-4-5 → 401 CreditsError (PAID, needs payment
method — cannot be free on a free key).

### 3.5d CLI fast-boot (added 2026-09-03, measured)
The bundled CLI otherwise runs an auto-update check and a models-catalog
fetch per spawn; either can stall 40–130s on a constrained link before the
model starts. start.sh exports `OPENCODE_DISABLE_AUTOUPDATE=1`,
`OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_FAST_BOOT=1` (all official CLI
env vars; the injected config is fully explicit so no catalog is needed).
A/B measured: avg agent run 61.8s → 10.3s, worst-case 131s outliers gone,
byte-identical output, cost still 0. Also `OD_CONNECTION_TEST_PROVIDER_TIMEOUT_MS=30000`
(reasoning models false-fail the 12s default in Settings' Test connection).

### 3.6 Sync safety (ported from hermes-sync.py)
- SQLite temp files (`-wal`/`-shm`/`-journal`, incl. `app.sqlite-wal`) are
  excluded; vanished-mid-scan files are skipped, never fatal.
- Secret-bearing keys (`api_key/token/secret/password/authorization`) are
  redacted at staging; policy-flagged content is never staged.
- Uploads dedupe by fingerprint+marker with 10% jitter; boot restore is
  best-effort; shutdown does one final bounded (`timeout 120`) upload.

### 3.7 Content-safety rule (from the blueprint, unchanged)
No keep-alive pingers, no egress-relay/remote-management tooling, no
prohibited-pattern keywords in any file/comment/commit. Wake-on-demand stays
external (single GET on demand). Scrub check belongs in the verify checklist:
`grep -riE "cloudflar[e]|tunne[l]|prox[y]|[T]OR|vn[c]|ngro[k]|chrome remot[e]" .`
→ zero REAL matches (the 3-letter substring inside ordinary words like
operator/editor is a documented false positive).

## 4. What NOT to do

- ❌ Run od with `OD_BIND_HOST=0.0.0.0` and no `OD_API_TOKEN` (§3.1 — it exits).
- ❌ Ship without `OD_ALLOWED_ORIGINS` derivation (§3.2 — the UI will 403 itself).
- ❌ Write anywhere outside `OD_DATA_DIR` for state; `/app` is image-internal.
- ❌ Add a server-side BYOK seeding file (§3.4 — credent