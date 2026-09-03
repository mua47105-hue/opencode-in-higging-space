# WORKLOG — OpenDesign × Hugging Face Spaces

Complete chronological record of everything done in this project.
Live deployment: **https://bot404-openclaw.hf.space** (Space ID `bot404/openclaw`)
Handover doc: [`opendesign-space/HANDOVER.md`](opendesign-space/HANDOVER.md)
Invariants & deep technical notes: [`opendesign-space/DEVELOPER_NOTES.md`](opendesign-space/DEVELOPER_NOTES.md)

> Note: the `opendesign/` directory in this workspace was a working clone of the
> upstream [`nexu-io/open-design`](https://github.com/nexu-io/open-design) repo
> (used for source analysis only). It is **not** part of this repository — the
> upstream project is public and lives on GitHub. Only the Space deployment code
> (`opendesign-space/`) and project docs are tracked here.

---

## Phase 0 — Reconnaissance & blueprint (2026-09-02)

- Studied the blueprint Space [`bot404/newsalert`](https://huggingface.co/spaces/bot404/newsalert)
  (HuggingMes / Hermes agent) end-to-end to port its architecture discipline:
  `start.sh` orchestrator, secrets-driven boot, HF Dataset persistence,
  one public port, restart supervisor, content-safety rules.
- Cloned upstream `nexu-io/open-design` and mapped its architecture:
  compiled daemon (`apps/daemon/dist`), Next.js web UI, BYOK provider model
  (browser-side `localStorage` credentials, per-request key forwarding).
- Phase-0 verified facts (documented in DEVELOPER_NOTES §3):
  - od **refuses to bind 0.0.0.0 without `OD_API_TOKEN`** (fail-closed)
  - browser `Origin` headers are **403 unless whitelisted** via `OD_ALLOWED_ORIGINS`
  - `OD_DATA_DIR` is the only durable path on the container
- Built the deployment kit in `opendesign-space/`:
  `Dockerfile` (pinned upstream image + curl/bash/python3 sync venv),
  `start.sh` (restore→auth→CORS→sync-loop→supervised daemon), `od-sync.py`
  (dataset backup/restore with secret redaction), docs, env reference.

## Phase 1 — Deploy & first fixes (2026-09-03)

**Deployed the Space `bot404/openclaw`** (free cpu-basic, Docker SDK, port 7861).
Secrets: `OD_API_TOKEN`, `HF_TOKEN` (write scope); private backup dataset
`bot404/opendesign-backup` auto-created and syncing.

| Fix | Problem | Root cause | Solution |
|---|---|---|---|
| **CORS / "daemon offline"** | Settings autosave failed inside the huggingface.co page | embedded UI sends `Origin: https://huggingface.co`; od 403s unknown origins | `start.sh` whitelists `huggingface.co` + `hf.co` embed origins |
| **Login credentials** | username hardcoded `open-design`; short passwords silently replaced | compiled constant; start.sh min-length guard | `patch-auth.sh` makes username env-driven (`OD_API_USERNAME=tohid`, password via `OD_API_TOKEN`) |

## Phase 2 — muse-spark on Zen: the Responses-API saga

End-to-end diagnosis of the user's 500 with the OpenCode Zen key
(`https://opencode.ai/zen/v1`):

- Zen serves `muse-spark-1.2/1.3(-contributor-free)` **only** on the OpenAI
  **Responses API** (`/v1/responses`); `/v1/chat/completions` → 500. Verified
  live in both directions + official docs.
- OpenDesign's openai BYOK proxy only speaks chat/completions → muse was
  unusable in stock OpenDesign.

**Built `muse-shim.js`** — a build-time patcher, run in the Dockerfile, that
surgically patches the compiled daemon (fail-loud anchors + `node --check`
gates; all original code paths kept byte-identical for non-muse models):

1. **Proxy chat path** (`routes/chat.js`): muse → in-process chat↔Responses
   translation in `/api/proxy/openai/stream` (SSE event mapping, image blocks,
   reasoning items ignored).
2. **Settings test button** (`connectionTest.js`): muse smoke test →
   `/responses` with ≥2048-token headroom (reasoning burns tokens; 100
   false-fails) + Responses-shaped completion accepted.
3. **Agent CLI path** (`runtimes/byok-opencode.js`): muse → `@ai-sdk/openai`
   (Responses) in the OpenCode CLI provider config.

## Phase 3 — Design agent unlock

**"BYOK API runs require OpenCode"**: discovered the real design-generation
flow (`POST /api/runs` → `byok-opencode` agent) spawns the **OpenCode CLI**,
which the pinned image does not ship. Bundled the official CLI
(`v1.18.27`, pinned, musl-compatible) at `OD_RESOURCE_ROOT/bin/libexec/opencode/`.
Verified end-to-end: real `/api/runs` design runs with muse 1.3 → succeeded, cost 0.

## Phase 4 — Performance optimization (no model-quality reduction)

Measured, then fixed:

| Fix | Measured effect |
|---|---|
| `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_FAST_BOOT=1` (official CLI env flags) | agent round-trip **61.8s avg / 131s worst → 10.3s avg**, outliers gone; byte-identical output |
| `OD_CONNECTION_TEST_PROVIDER_TIMEOUT_MS=30000` | reasoning models false-fail the 12s default in Settings' Test connection |
| `NODE_OPTIONS=--max-old-space-size=2560` | headroom for artifact exports / agent streams on HF free CPU |

## Phase 5 — The silent 150s failure (protocol mismatch)

User report: *"Preparing/Thinking for 2.5 minutes, then nothing."*
Live-reproduced from run records: muse requested under the **anthropic**
protocol config → Zen `/messages` → **instant 500** (muse is /responses-only)
→ CLI backoff retries (~75s) + one daemon retry → run dies
`UPSTREAM_UNAVAILABLE (upstream_5xx)` with **no UI error**.

**Fix: muse now routed to /responses from EVERY protocol** — anthropic proxy
stream (new in-process `runResponsesChatStream`), CLI provider override now
also fires for `@ai-sdk/anthropic`, and the anthropic smoke test.
Verified: the exact broken case went 150s-fail → **10s success**.
Also documented: `openai` is the universal protocol for Zen; Claude Sonnet on
Zen is PAID (401 CreditsError on a free key); other free models have rolling
per-model 429s.

## Phase 6 — The silent 2–4 min mid-run abort (permission bypass)

User report: *"agent works for a while then just stops."*
Timeline forensics on run `44ff2387`: 11 tool calls fine → "now writing the
complete rebuild" → `write` tool → **"Tool execution aborted"** → CLI exits 0 →
run reported `succeeded` with `endedWithUnfinishedWork: true`.

Root cause: **OpenCode CLI v1.18.x renamed `--dangerously-skip-permissions` to
`--auto`**. The daemon's capability probe greps `run --help` for the old flag →
never sends any bypass → headless runs auto-**deny** ask-level tools
(write/edit). Every design run died at its first file write.

Fix: compiled `opencode-permissions.js` flag constant →
`process.env.OD_OPENCODE_PERMISSION_BYPASS_FLAG || '--auto'` (one constant
feeds both the probe and the appended arg).

**Verified with 3 progressively heavier live runs** (post-fix, zero aborts):

| Run | Duration | Tool calls | Writes/Edits | Result |
|---|---|---|---|---|
| 7-step website | 80s | 20 | 7 | `ALL-SEVEN-DONE` |
| 12-page docs site | 2.9 min | 35 | 16 | `DOCS-COMPLETE-12` |
| **10-module marathon** | **4.2 min** | **58** | 22 | `MARATHON-COMPLETE` |

## Phase 7 — Full potential audit (hybrid vs stock)

File-by-file diff of pristine `ghcr.io/nexu-io/od:0.21.1` vs our hybrid:
**9,602 of 9,608 app files byte-identical** (entire UI, 460 plugins, design
systems, agent defs, prompts). All 6 changed files enumerated; **zero stock
capability removed** — every change additive or a fix. `--auto` gives the agent
**more** autonomy than stock default (no deny rules injected). Payload audit:
no dropped params; 16K output cap proven non-binding (22,957-char creative
story completed). Live A/B direct-Zen vs through-Space: full-quality streamed
output both ways. Endpoint coverage proof: the web UI only calls
`/api/proxy/openai/stream`, `/api/runs`, `/api/test/connection` — all patched.

## Phase 8 — Reasoning effort = high

User report: *"agent hurries, doesn't reason deeply. Set reasoning to high
(not xhigh)."* Verified: OpenDesign never sends a reasoning parameter (start
event `reasoning: null`) → muse ran on Zen's **server default**, which measured
429–1435 reasoning tokens on identical prompts (unpredictable). Probed Zen
live: muse accepts `reasoning: {effort: low|medium|high|xhigh}` on /responses.

**Fix: muse now runs at effort `high` by default on ALL paths** (proxy chat
payload, anthropic-route streamer, and CLI model config via
`options.reasoningEffort` which `@ai-sdk/openai` merges into the request body).
Env-tunable: `OD_MUSE_REASONING_EFFORT` (`xhigh` deeper, `medium`/`low`
faster, `default` = server default). Non-muse models untouched.
Live-verified on production: a design task that demands explicit reasoning
(color psychology → WCAG → palette) produced a structured, reasoned answer.

## Current state

- Space `bot404/openclaw`: 🟢 RUNNING, all fixes live
- Login: `tohid` / `OD_API_TOKEN` secret value
- Persistence: private dataset `bot404/opendesign-backup` (600s sync interval)
- Recommended model: `muse-spark-1.3-contributor-free` @ effort high (free)
- Full file inventory & operational runbook: [`opendesign-space/HANDOVER.md`](opendesign-space/HANDOVER.md)
