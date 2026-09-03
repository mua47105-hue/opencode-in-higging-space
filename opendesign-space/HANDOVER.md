# OpenDesign × Hugging Face Spaces — Developer Handover

**Space:** [`bot404/openclaw`](https://huggingface.co/spaces/bot404/openclaw) · **Live URL:** https://bot404-openclaw.hf.space
**Blueprint:** [`bot404/newsalert`](https://huggingface.co/spaces/bot404/newsalert) (HuggingMes — same architecture discipline)
**Payload:** [`nexu-io/open-design`](https://github.com/nexu-io/open-design) v0.21.1 (pinned image `ghcr.io/nexu-io/od:0.21.1`)
**Agent runtime:** OpenCode CLI `1.18.27` (bundled) → OpenCode Zen (`https://opencode.ai/zen/v1`, keyed, free models $0)
**Status:** WORKING as of 2026-09-03 — design generation verified end-to-end on the live Space with `muse-spark-1.3-contributor-free` and `big-pickle` (`/api/runs` → succeeded, cost 0).

---

## 1. Read me first (60 seconds)

- This Space runs **OpenDesign** (open-source Claude Design alternative) as a single Docker container. The daemon serves UI + API on **port 7861**; HF proxies it at `https://bot404-openclaw.hf.space`.
- Login is **HTTP Basic**: username = `OD_API_USERNAME` (Space variable, currently `tohid`), password = `OD_API_TOKEN` (Space secret).
- The AI key is **BYOK**: the user pastes their Zen key in the studio Settings; it lives in **browser localStorage**, is forwarded per-run to the daemon in memory, and is **never persisted server-side**.
- Persistence works like the blueprint (Hermes): at boot, state is **restored** from a private HF Dataset (`bot404/opendesign-backup`); every 600 s and on shutdown it **syncs** back up. No `HF_TOKEN` secret ⇒ no persistence (by design).
- Two build-time patchers adapt the upstream daemon (`muse-shim.js`, `patch-auth.sh`). Both **fail the Docker build loudly** if the upstream compiled code ever changes shape. Upgrading the pinned od tag requires re-checking their anchors.

## 2. Architecture (what actually happens on a design prompt)

```
Browser (studio UI, Basic-auth session)
  │  POST /api/runs  {agentId:"byok-opencode", model, byokProvider{protocol,baseUrl,apiKey}}
  ▼
od daemon (node, port 7861, PID-1 tree: tini → start.sh → node + od-sync loop)
  │  hasCompleteByokOpenCodeConfig() validates the provider
  │  buildOpenCodeByokProviderConfig() → provider entry {npm, options, models}
  │      └─ muse-shim overrides npm to '@ai-sdk/openai' (Responses API) for muse*
  │  spawns bundled CLI: /app/bin/libexec/opencode/opencode run --format json -m open-design-byok/<model>
  │      env: OPENCODE_CONFIG_CONTENT={provider…}, OPEN_DESIGN_BYOK_API_KEY=<key>, fast-boot flags
  ▼
OpenCode CLI (bun binary)
  │  @ai-sdk/openai → POST https://opencode.ai/zen/v1/responses   (muse models)
  │  @ai-sdk/openai-compatible → POST …/chat/completions          (all other models)
  ▼
OpenCode Zen → model streams → CLI emits JSON events → daemon relays as SSE
  → browser renders text_delta / artifacts; usage & cost reported per run
```

Two code paths exist and BOTH are needed:

| Path | Route | Used for | Muse fix location |
|---|---|---|---|
| **Agent runs** (the real design generation) | `POST /api/runs` → spawns OpenCode CLI | Home composer, project generation | `muse-shim.js` patch of `dist/runtimes/byok-opencode.js` (npm override AFTER entry build — `rawModel` scope) |
| **Proxy chat** (lightweight BYOK chat) | `POST /api/proxy/openai/stream` → daemon fetch | Side chat, quick prompts | `muse-shim.js` patch of `dist/routes/chat.js` (chat→Responses translation, in-process) |
| Settings smoke test | `POST /api/test/connection`, `/api/provider/models` | "Test connection" button | `muse-shim.js` patch of `dist/connectionTest.js` (muse → `/responses`, 2048-token headroom) |

Zen serves `muse-spark-1.2/1.3(-contributor-free)` **only** on `/v1/responses`; on `/chat/completions` they 500 ("Internal server error"). That single fact explains the original 500s and drives the shim design. Verified live 2026-09-03 (docs: opencode.ai/docs/zen — Endpoint table).

## 3. File inventory (this repo)

| File | Role | Touch when… |
|---|---|---|
| `Dockerfile` | FROM pinned `ghcr.io/nexu-io/od:0.21.1`; installs curl/bash/python3; runs patchers; bundles OpenCode CLI at `/app/bin/libexec/opencode/opencode`; `OD_RESOURCE_ROOT=/app`; sync venv at `/opt/sync-venv`; arbitrary-UID perms; HEALTHCHECK | Bumping od image tag / CLI version / adding system deps |
| `start.sh` | Boot orchestrator: dataset restore → token guard (fail-closed with 0.0.0.0) → CORS auto-derivation (`$SPACE_HOST` + huggingface.co/hf.co embed origins) → fast-boot CLI env → supervised daemon with restart-backoff → background sync loop → SIGTERM = graceful final sync | Changing env wiring, ports, or supervisor behavior |
| `od-sync.py` | Dataset backup/restore engine (ported from HuggingMes `hermes-sync.py`): WAL-safe SQLite handling, secret redaction, >50 MB skip, fingerprint dedup + 10% jitter, boot restore best-effort, shutdown final upload | Changing what's persisted or cadence (`SYNC_INTERVAL` secret) |
| `muse-shim.js` | Build-time patcher (see §2). Anchors assert counts; `node --check` gates patched files | od tag bump, or adding more Responses-API-only models (`OD_RESPONSES_API_MODELS` env, no code change needed for most cases) |
| `patch-auth.sh` | Makes Basic-auth username env-driven (`OD_API_USERNAME`, default `open-design`) | od tag bump |
| `README.md` | HF Space metadata (`sdk: docker`, `app_port: 7861`) + quickstart | Branding / description changes |
| `DEPLOYMENT_README.md` | Secrets table, deploy steps, Definition-of-Done checklist, troubleshooting | Operational changes |
| `DEVELOPER_NOTES.md` | Invariants (§3.x), verified facts, do-not-do list | Always keep in sync with reality |
| `.env.example` | Full env/secret reference | New env vars |
| `HANDOVER.md` | This document | — |

## 4. Space secrets & variables (Settings → Variables and secrets)

| Name | Kind | Value | Purpose |
|---|---|---|---|
| `OD_API_TOKEN` | **Secret** | `<your-OD_API_TOKEN>` | Login password + API Bearer token (daemon refuses 0.0.0.0 without it) |
| `HF_TOKEN` | **Secret** | write-scope token | Dataset persistence (backup/restore) |
| `OD_API_USERNAME` | Variable | `tohid` | Login username (patched daemon reads it at runtime) |
| `GATEWAY_TOKEN` | (optional) | — | Alias accepted by start.sh if you prefer that name |
| `SYNC_INTERVAL` | (optional) | `600` | Backup cadence seconds |
| `BACKUP_DATASET_NAME` | (optional) | `opendesign-backup` | Private dataset repo name |
| `OD_EXTRA_ORIGINS` | (optional) | — | Extra CORS origins (custom domain in front) |
| `OD_RESPONSES_API_MODELS` | (optional) | — | Extra model regexes to route to `/responses` (muse already default) |
| `OD_CONNECTION_TEST_PROVIDER_TIMEOUT_MS` | (optional) | `30000` | Set by start.sh by default — reasoning models false-fail the 12 s default |

Platform-injected (never set manually): `SPACE_HOST`, `SPACE_ID`, `PORT`.

## 5. Verified facts (don't re-guess — these were tested live)

1. **od auth guard:** binding `0.0.0.0` without `OD_API_TOKEN` → daemon exits (fail-closed). start.sh generates an ephemeral token only when no secret is set (login then changes every restart).
2. **CORS:** any browser `Origin` not whitelisted → 403 "Cross-origin requests are not allowed" (symptom: Settings autosave says "daemon offline"). Derived origins: `https://$SPACE_HOST`, `https://huggingface.co`, `https://hf.co` (iframe embeds).
3. **Data root:** everything durable lives under `OD_DATA_DIR=/opt/data` (`app.sqlite` + `projects/ artifacts/ memory/ skills/ …`). Anything written elsewhere dies on rebuild.
4. **Design generation REQUIRES the CLI:** `/api/runs` hard-fails without the OpenCode binary ("BYOK API runs require OpenCode"). The binary must be inside the image at a path `detectAgents()` scans: `$OD_RESOURCE_ROOT/bin/libexec/opencode/opencode` (or PATH). Verified via `GET /api/agents` → `available: true`.
5. **Zen auth:** keyed (free account). Key format `sk-…`. `Authorization: Bearer` works. Free models return `"cost":"0"`.
6. **Muse endpoint:** `/responses` only (see §2). `deepseek-v4-flash-free` was provider-down on 2026-09-03 (400 "Model is unavailable") — Zen-side outages happen; retry/pick another model.
7. **Key-shape validation:** the Settings dialog rejects a Zen `sk-…` key under the *anthropic* protocol ("Invalid API key") — protocol must be **openai** (first-party `api.openai.com` check only fires for that host; `opencode.ai` skips shape checks).
8. **Perf (measured on the Space, cpu-basic):** health 45 ms; UI 47 ms; muse proxy-chat first token ≈ 2.3 s; **full agent round-trip ≈ 7.5–10 s** with fast-boot flags (was 60–130 s worst-case before — CLI auto-update/models-fetch stalls; fixed via `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_FAST_BOOT=1`; output byte-identical, cost 0).
9. **Free-tier sleep:** idle Spaces pause (cold start ≈ 60–90 s incl. restore). Not a bug.
10. **Arbitrary UID:** HF runs containers as a random non-root UID; every path the runtime writes is chmodded a+rwX in the image.

## 6. Common operations

```bash
# Login check (200 expected)
curl -o /dev/null -w '%{http_code}\n' -u tohid:<your-OD_API_TOKEN> https://bot404-openclaw.hf.space/

# Health (no auth)
curl -s https://bot404-openclaw.hf.space/api/health

# Is the design agent available?
curl -s -u tohid:<your-OD_API_TOKEN> https://bot404-openclaw.hf.space/api/agents \
  | python3 -c "import json,sys;[print(a['id'],a.get('available')) for a in json.load(sys.stdin)['agents'] if a['id'] in ('byok-opencode','opencode')]"

# Headless agent run (same shape the studio sends)
curl -N -u tohid:<your-OD_API_TOKEN> -H 'Content-Type: application/json' \
  -X POST https://bot404-openclaw.hf.space/api/runs -d '{
    "agentId":"byok-opencode","message":"…","model":"muse-spark-1.3-contributor-free",
    "projectId":null,"conversationId":null,"sessionMode":"chat","attachments":[],"skillIds":[],
    "byokProvider":{"protocol":"openai","baseUrl":"https://opencode.ai/zen/v1","apiKey":"sk-…"},
    "locale":"en"}'

# Live logs (SSE)
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/bot404/openclaw/logs/run"
curl -N -H "Authorization: Bearer $HF_TOKEN" "https://huggingface.co/api/spaces/bot404/openclaw/logs/build"
```

Deploy = `git push` to the Space repo (HF builds automatically, ~4–6 min incl. CLI download). Monitor stage via `GET https://huggingface.co/api/spaces/bot404/openclaw` (`runtime.stage`).

## 7. Troubleshooting map

| Symptom | Root cause | Fix |
|---|---|---|
| "Invalid API key" in Settings | Key shape vs. protocol mismatch (anthropic selected) | Use **openai** protocol; Zen keys are `sk-…` |
| "BYOK API runs require OpenCode" | CLI missing/not detected | Check `GET /api/agents`; verify `/app/bin/libexec/opencode/opencode` + `OD_RESOURCE_ROOT=/app` |
| muse models 500 | Someone removed the shim, or od tag changed anchors | Rebuild (patcher fails loudly); re-check anchors in `muse-shim.js` |
| Settings says daemon offline / 403 cross-origin | Origin not whitelisted | Check boot log `OD_ALLOWED_ORIGINS auto-derived`; add `OD_EXTRA_ORIGINS` |
| Login loops / password prompt every restart | `OD_API_TOKEN` secret missing → ephemeral token per boot | Set the secret |
| Projects vanish after rebuild | `HF_TOKEN` unset → persistence disabled | Set the secret; old data unrecoverable (by design) |
| Agent run hangs 40s+ before first token | Fast-boot flags removed, or Zen slow | Verify `OPENCODE_FAST_BOOT=1` in daemon env; try another free model |
| 429s from Zen | Shared HF egress IP budget | Retry later or switch model; consider keyed provider |
| Build fails at `node /tmp/muse-shim.js` | od image changed → anchor mismatch (WORKING AS INTENDED) | Re-map anchors against the new compiled files, bump `OPENCODE_VERSION` if needed |

## 8. Upgrade runbook (od image / CLI)

1. Read the new od release notes for data-migration or auth changes.
2. `docker build` locally — `muse-shim.js` will **fail fast** if anchors moved; re-map them from the new compiled files (`docker create` + `docker cp` the three files, diff, adjust).
3. Bump `OPENCODE_VERSION` ARG only after running the local smoke matrix: CLI `--version`, `/api/agents` availability, one `/api/runs` run with muse + one with a non-muse model, one proxy-chat stream, Settings test-connection.
4. Verify `DEVELOPER_NOTES.md` facts still hold (auth guard, CORS, data root, endpoint matrix).
5. Push; watch build logs; then run the §6 checks against the live Space.

## 9. Known limitations (accepted)

- Free cpu-basic hardware: enough for single-user design work; heavy parallel runs will queue.
- Muse reasoning tokens are invisible in proxy-chat (by design, clean output); agent runs stream normally.
- Zen contributor-free models are community-donated compute — occasional upstream outages/queues are Zen-side, not fixable here.
- Settings "Test connection" on `big-pickle` may still time out on very cold links (30 s budget now; reasoning can exceed it). Real chat/runs are unaffected.
- BYOK credentials are per-browser (localStorage) — re-enter after clearing site data or on new devices.
