# OpenDesign on Hugging Face Spaces — Complete Deployment Plan

> **Goal:** Run [nexu-io/open-design](https://github.com/nexu-io/open-design) — the open-source
> Claude Design alternative — inside a Hugging Face **Docker Space**, using the same proven
> architecture as `bot404/newsalert` (HuggingMes): single-container boot orchestrator,
> secrets-driven configuration, one public port (7861), HF **Dataset** persistence with
> boot-time restore + periodic sync, and a self-healing process model.
>
> **Reference repos (both studied end-to-end):**
> - Blueprint: `bot404/newsalert` (Hermes Agent gateway on HF Spaces)
> - Payload: `nexu-io/open-design` (Apache-2.0; daemon `od` + web UI + BYOK proxy)
>
> Everything below is derived from the actual code of both repos — no guessed interfaces.

---

## 1. Why this port is unusually clean

The two projects were practically made for each other:

| Concern | HuggingMes (blueprint) | OpenDesign (payload) | Fit |
|---|---|---|---|
| Public surface | `health-server.js` on 7861 (`app_port: 7861`) | daemon serves API **and** built web UI on one port (`OD_PORT=7456`) | The health-server pattern shrinks to a thin auth+health shim in front of `od`, or is dropped entirely (od has native auth) |
| Auth | `GATEWAY_TOKEN` (Bearer + session cookie) | `OD_API_TOKEN` (Bearer + browser Basic auth) | Same single-token model — map HF secret `GATEWAY_TOKEN` → `OD_API_TOKEN` |
| Data dir | `HERMES_HOME=/opt/data` (HF persistent volume) | `OD_DATA_DIR` (single root for SQLite, projects, artifacts, config, plugin state) | One env var points od's entire data root at `/opt/data` (HF volume) |
| Health | `/health` JSON | `/api/health` (`{ok:true, version}`) + `/api/ready` (503 while draining) | Direct mapping |
| Persistence | `hermes-sync.py` (restore at boot, sync every 600s to private HF Dataset) | Same script pattern, new target dir | Copy + adapt (od already emits JSON-friendly state; SQLite WAL-safe staging logic ports as-is) |
| Secrets → config | `start.sh` maps HF secrets → env/config | od is already 100% env-configurable (`OD_*`) | `start.sh` shrinks dramatically — no YAML generation needed at all |
| Model backend | OpenCode Zen (keyless OpenAI-compatible) | BYOK proxy accepts any OpenAI-compatible endpoint | Point od's BYOK at the Zen endpoint or any keyed provider |

**The hard constraints that carry over from HuggingMes (invariants, not suggestions):**
1. **One public port = 7861** — HF probes this; `app_port: 7861` in README metadata.
2. **HF runs containers as an arbitrary non-root UID** — the image must be writable for uid 1001
   (od's compose user) *and* tolerate a random uid at runtime; `/app` and `/app/.od` get
   group/other-write + the data root gets permissive modes (same trick HuggingMes uses with
   `chmod a+rwx` on `/opt/hermes`).
3. **No keep-alive pingers, no relay/tunnel tooling, no prohibited-pattern keywords** in any file —
   HF's RepoScanner flags them; the HuggingMes DEPLOYMENT_README documents this as a hard rule.
   Wake-on-demand stays external (GitHub Actions hitting the Space URL).
4. **The data root is the only persistent mount** — everything that must survive a restart lives
   under `OD_DATA_DIR=/opt/data`; nothing else in the container is durable.
5. **Boot must never depend on the network** — Dataset restore, model config, and health server all
   degrade gracefully (`|| true` semantics) so a network hiccup can never crash-loop the Space.

---

## 2. Target architecture

```
                        Hugging Face Space (sdk: docker, app_port: 7861)
  ┌────────────────────────────────────────────────────────────────────────┐
  │  Browser ──https──▶ :7861 (od daemon, NODE_ENV=production)             │
  │                        ├── GET  /            → OpenDesign web UI       │
  │                        ├── GET  /api/health  → HF readiness probe      │
  │                        ├── POST /api/proxy/openai/stream            │   │
  │                        │      /api/proxy/anthropic/stream  (BYOK,     │
  │                        │      SSRF-guarded) → Zen / OpenRouter / etc.  │
  │                        └── auth: OD_API_TOKEN (Bearer / Basic)         │
  │                                                                        │
  │  start.sh (PID 1 wrapper):                                             │
  │    1. restore from HF Dataset (od-sync.py restore, best-effort)        │
  │    2. export OD_* env (from HF secrets/variables)                      │
  │    3. exec od daemon (node apps/daemon/dist/cli.js --no-open)          │
  │    4. (supervisor loop: if od dies → backoff restart)                  │
  │                                                                        │
  │  background: od-sync.py sync loop → private HF Dataset (600s)          │
  │                                                                        │
  │  /opt/data  ◀── OD_DATA_DIR — the ONLY durable path (HF volume)        │
  │      projects/ artifacts/ sqlite config/ memory/ plugins/ logs/        │
  └────────────────────────────────────────────────────────────────────────┘
```

**Design decision — who owns port 7861:** OpenDesign's daemon already serves the UI, API, and
auth on a single port with a battle-tested token scheme. Reimplementing that in a Node shim
(like HuggingMes does for Hermes) would add attack surface for zero benefit. So the port roles
from the blueprint change:

| Blueprint role | HuggingMes implementation | OpenDesign Space implementation |
|---|---|---|
| Public port 7861 | `health-server.js` (auth + forwards) | **the od daemon itself** (native `OD_API_TOKEN` auth) |
| Internal API | gateway on 8642 | not needed (no split) |
| Internal dashboard | Hermes UI on 9119 | not needed (UI is served by od) |
| Health probe | `/health` on health-server | `/api/health` on od (plus optional tiny `/health` alias in start.sh's supervisor if HF needs root-level probe) |

HF's Docker runtime only requires *something* to listen on `app_port`; it does not require a
root-path 200, so od serving directly on 7861 is sufficient. We will still verify this in
Phase 0 and add a micro health shim only if the platform demands it.

**Design decision — the design engine (which "model" runs the design loop):**
OpenDesign does not bundle agent CLIs, and installing Claude Code/Codex inside the Space is
out of scope (licensing + footprint + HF account risk). The intended engine is the **BYOK
proxy**: the Space operator pastes an OpenAI-compatible `baseUrl + apiKey + model` in the UI's
BYOK settings, stored under `OD_DATA_DIR` and therefore persisted by the Dataset sync. Two
supported configurations:

**Phase 0 correction (verified live):** OpenDesign keeps BYOK credentials **browser-side**
(`localStorage['open-design:config']` in the web app; the daemon proxy takes `baseUrl + apiKey +
model` per request and forwards `Authorization: Bearer <key>` on the OpenAI route,
`x-api-key` on the Anthropic route — `apps/daemon/src/routes/chat.ts`). There is **no
server-side settings file to seed**, so the `start.sh` "BYOK seeding" idea from the first
draft is dropped. The operator pastes the provider config into the UI **once per browser**;
it survives Space restarts (same browser) and project/artifact data persists server-side
via the Dataset backup regardless.

- **A. Zen free-tier key (chosen):** Zen is now a **keyed** gateway (verified 2026-09-02:
  keyless requests 401/500; opencode.ai/docs/zen says "sign in … copy your API key"). The
  **free models are still $0** (big-pickle, mimo-v2.5-free, ling-3.0-flash-fin-free,
  nemotron-3-ultra-free, nemotron-3.5-lightning-free, muse-spark-1.2-contributor-free).
  Operator signs up free at opencode.ai, pastes `baseUrl=https://opencode.ai/zen/v1` + key
  + a free model id into OpenDesign Settings (BYOK, OpenAI-compatible). Note: HF Spaces
  share egress IPs → subject to Zen's shared-IP budget (the HuggingMes 429 lesson).
- **B. Any keyed provider:** same UI path with OpenRouter / DeepSeek / Anthropic / OpenAI /
  GLM etc. Not IP-shared; recommended if Zen 429s in practice.

---

## 3. The new Space repo — file inventory

```
opendesign-space/
├── README.md              # HF Space metadata (sdk: docker, app_port: 7861, secrets)
├── Dockerfile             # FROM ghcr.io/nexu-io/od:<pinned> + HF adjustments
├── start.sh               # boot orchestrator (restore → env → exec od, supervisor)
├── od-sync.py             # HF Dataset backup/restore for /opt/data (ports hermes-sync.py)
├── healthz.js             # ~40-line sidecar ONLY IF Phase 0 shows HF needs a root /health
├── .env.example           # documentation of every supported variable
├── DEVELOPER_NOTES.md     # invariants + failure modes (port of HuggingMes discipline)
├── DEPLOYMENT_README.md   # operator guide: secrets table, verify checklist
└── scripts/
    └── check-reachability.sh   # outbound diagnostics (from HuggingMes)
```

### 3.1 `README.md` (HF Space metadata — the contract with the platform)

```yaml
---
title: OpenDesign Studio
emoji: 🎨
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 7861
pinned: true
license: apache-2.0
secrets:
  - name: OD_API_TOKEN          # → OD_API_TOKEN (dashboard + API auth)
    description: "Strong token for the OpenDesign UI/API (openssl rand -hex 32)."
  - name: LLM_API_KEY           # → BYOK provider key (seeded into od settings)
    description: "API key for the design agent's model provider (OpenRouter, DeepSeek, Anthropic, OpenAI, Zen…)."
  - name: HF_TOKEN              # → Dataset backup (write scope)
    description: "HF token with write access; enables automatic workspace backup."
  - name: LLM_BASE_URL          # optional: custom OpenAI-compatible endpoint
  - name: LLM_MODEL             # optional: model id for the seeded provider
  - name: OD_ALLOWED_ORIGINS    # optional: extra CORS origins
---
```

### 3.2 `Dockerfile` (the core of the port)

```dockerfile
# OpenDesign on HF Spaces — single-stage adaptation of deploy/Dockerfile's
# runtime posture, but FROM the official prebuilt image (no rebuild of the
# pnpm monorepo inside HF's builder; faster, cheaper, upstream-identical).
ARG OD_IMAGE=ghcr.io/nexu-io/od:0.21.1
FROM ${OD_IMAGE}

USER root

# Poppler/git already present upstream; add only what HF needs.
# tini is already the upstream entrypoint.
RUN apk add --no-cache curl bash

# HF runs the container as an arbitrary non-root UID. Upstream ships
# /app owned by uid 1001 (open-design). Make the tree writable by any uid
# (same a+rwx discipline HuggingMes applies to /opt/hermes) so the daemon
# can write plugins/, skills/, .od scratch, and serve its static export.
RUN mkdir -p /app/.od /opt/data \
    && chown -R 1001:1001 /app \
    && chmod -R a+rwX /app \
    && chmod 777 /opt/data

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=2048 \
    OD_BIND_HOST=0.0.0.0 \
    OD_PORT=7861 \
    OD_DATA_DIR=/opt/data \
    OD_DATA_ROOT=/opt/data

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD curl -fsS http://127.0.0.1:7861/api/health || exit 1

# start.sh wraps od with restore + supervisor semantics (HF kills PID 1
# children when the Space restarts; tini reaps, we supervise).
COPY --chmod=0755 start.sh /usr/local/bin/start.sh
COPY --chmod=0755 od-sync.py /app/od-sync.py

CMD ["/bin/bash", "/usr/local/bin/start.sh"]
```

> Note on `OD_DATA_ROOT`: only set if Phase 0 proves the daemon reads it; `OD_DATA_DIR` is the
> documented, code-verified truth (`server.ts: resolveDataDir(process.env.OD_DATA_DIR, …)`).
> `NODE_OPTIONS` raised from upstream's 192MB to 2GB: HF free CPU basic gives 16GB and design
> exports/agent streams are the workload; 192MB was tuned for a 384MB container cap that we
> do not impose.

### 3.3 `start.sh` (boot orchestrator — HuggingMes discipline, OpenDesign surface)

```bash
#!/bin/bash
set -euo pipefail
umask 0077

OD_PORT="${OD_PORT:-7861}"
export OD_PORT OD_BIND_HOST="${OD_BIND_HOST:-0.0.0.0}"
export OD_DATA_DIR="${OD_DATA_DIR:-/opt/data}"

echo "  ╔══════════════════════════════════════╗"
echo "  ║        🎨 OpenDesign × HF Spaces     ║"
echo "  ╚══════════════════════════════════════╝"

mkdir -p "$OD_DATA_DIR"

# ── 1. Restore from HF Dataset (best-effort, never fatal) ──
if [ -n "${HF_TOKEN:-}" ]; then
  echo "[boot] restoring workspace from HF Dataset…"
  python3 /app/od-sync.py restore || echo "[boot] restore failed (continuing with empty workspace)"
else
  echo "[boot] HF_TOKEN not set — persistence disabled (data is ephemeral!)"
fi

# ── 2. Map HF secrets → od env (the HuggingMes 'env wins' rule) ──
# Auth: HF secret GATEWAY_TOKEN/OD_API_TOKEN → OD_API_TOKEN. If unset or
# <16 chars, generate an ephemeral one and print it ONCE to the run log —
# same self-heal as HuggingMes' API_SERVER_KEY path, minus the .env
# poison risk (od reads env directly; there is no .env override file).
if [ -z "${OD_API_TOKEN:-}" ] && [ -n "${GATEWAY_TOKEN:-}" ]; then
  export OD_API_TOKEN="$GATEWAY_TOKEN"
fi
if [ -z "${OD_API_TOKEN:-}" ] || [ "${#OD_API_TOKEN}" -lt 16 ]; then
  OD_API_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  export OD_API_TOKEN
  echo "[boot] WARNING: no strong OD_API_TOKEN secret set; generated an ephemeral token for this boot (check logs or set the secret for a stable login)."
fi

# CORS: HF serves the UI from *.hf.space (and huggingface.co iframe);
# allow the live origin unless the operator overrides it.
if [ -z "${OD_ALLOWED_ORIGINS:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
  export OD_ALLOWED_ORIGINS="https://${SPACE_HOST},https://huggingface.co"
fi

# NOTE: BYOK provider credentials are browser-side (localStorage) by design —
# verified in Phase 0. Nothing to seed server-side; see DEPLOYMENT_README.

# ── 3. Launch od under a restart supervisor ──
restart_delay="${OD_RESTART_DELAY:-5}"
while true; do
  node /app/apps/daemon/dist/cli.js --no-open &
  od_pid=$!
  wait "$od_pid"
  code=$?
  echo "[supervisor] od exited (code=$code); restarting in ${restart_delay}s"
  sleep "$restart_delay"
done
```

(Plus the background `od-sync.py sync` loop started once before the supervisor, guarded by
`HF_TOKEN` presence — exactly hermes-sync's cadence: restore at boot, sync every `SYNC_INTERVAL`.)

### 3.4 `od-sync.py` (persistence engine)

Direct port of HuggingMes' `hermes-sync.py` with three changes: target dir `/opt/data`
(= `OD_DATA_DIR`), dataset repo default `opendesign-backup`, and od-specific excludes
(`node_modules`, caches, `.tmp/`, `*.sqlite-wal/-shm/-journal`, files >50MB via
`SYNC_MAX_FILE_BYTES`). Secret redaction at staging time (token/authorization/password keys →
`[REDACTED]`) carries over verbatim. HF_TOKEN is read from env; restore is idempotent; a
vanished SQLite WAL file mid-scan is skipped, never fatal.

### 3.5 Explicitly NOT ported from the blueprint (with reasons)

| Blueprint piece | Why it's not needed here |
|---|---|
| `health-server.js` (auth/forward shim) | od natively serves UI+API+auth on one port |
| `99-huggingmes-gateway-owner` cont-init (s6 race) | od image has **no s6** — single process, tini entrypoint; the double-spawn failure mode doesn't exist |
| Embedded Python config-gen (Zen YAML) | od is env-configurable; no config file generation needed (BYOK settings seeding is a tiny JSON touch, not YAML surgery) |
| API_SERVER_KEY `.env` force-write | od reads env directly; no `.env` override file exists to poison the volume |
| Chromium + Playwright env | od's browser tooling is optional; add only if a Space-side feature needs it (keep image lean) |
| Provider prefix case-mapping | replaced by the simpler LLM_API_KEY/BASE_URL/MODEL seeding |

---

## 4. Secrets & variables (Space settings)

| Secret / Variable | Maps to | Required | Notes |
|---|---|---|---|
| `OD_API_TOKEN` | `OD_API_TOKEN` | required | `openssl rand -hex 32`. Single token for UI (browser Basic auth) + API Bearer |
| *(none)* | BYOK provider config | — | **Deliberately no LLM_* secrets**: BYOK lives in the browser's localStorage (Phase 0 verified). Paste `https://opencode.ai/zen/v1` + free-tier key + a free model into the UI once. It is per-browser by design, like any web login. |
| `HF_TOKEN` | od-sync.py | recommended | **write** scope; without it all data is ephemeral |
| `BACKUP_DATASET_NAME` | od-sync.py | optional | default `opendesign-backup` |
| `SYNC_INTERVAL` | od-sync.py | optional | default 600 |
| `OD_ALLOWED_ORIGINS` | daemon CORS | optional | auto-derived from `SPACE_HOST` if unset |
| `OD_DISABLE_API_AUTH` | daemon | **avoid** | only if an external authenticated proxy fronts the Space |
| `OD_CODEX_SANDBOX` | daemon | n/a | not used (no Codex CLI in image) |

Platform notes: `SPACE_HOST`, `SPACE_ID`, `SPACE_AUTHOR_NAME` are **injected by HF
automatically** — never set them manually. The UI's BYOK credentials typed in the browser are
stored under `OD_DATA_DIR` and ride the Dataset backup automatically.

---

## 5. Phased execution plan

### Phase 0 — Local verification (no HF account needed) — *this is where we are next*
1. `docker pull ghcr.io/nexu-io/od:0.21.1` (tag format verified: `0.21.1`, no `v` prefix; `latest` is mutable).
2. Run it with the exact env matrix the Space will use (`OD_PORT=7861`, `OD_DATA_DIR=/opt/data`,
   `OD_API_TOKEN=…`, bind 0.0.0.0) and a host-mounted data dir.
3. Verify — **✅ DONE 2026-09-02, image digest `sha256:441daca8…`, all green:**
   - `GET /api/health` → 200 `{"ok":true,"version":"0.21.1"}` (no auth); `/api/ready` → 200
   - UI at `/` returns 401 without credentials (auth gate live), 200 with Basic/Bearer
   - `OD_BIND_HOST=0.0.0.0` binds **0.0.0.0:7861** (verified via netstat + host curl) —
     the `listening on http://127.0.0.1:7861` log line is cosmetic
   - **Guard found:** od **refuses to start** with `0.0.0.0` unless `OD_API_TOKEN` is set
     (fail-closed by design — `server.js:1740`). The Space's start.sh always sets it.
   - **CORS guard found:** any request with a browser `Origin` header is **403** unless the
     origin is in `OD_ALLOWED_ORIGINS`. start.sh auto-derives
     `https://$SPACE_HOST,https://huggingface.co` → **mandatory, not optional**.
   - data root layout under `OD_DATA_DIR`: `app.sqlite` (+`-wal`/`-shm`), `projects/`,
     `artifacts/`, `memory/`, `skills/`, `plugins/`, `brands/`, `design-systems/`,
     `design-templates/`, `library/`, `critique-artifacts/` — the od-sync include list
   - **uid-4242 test (fresh volume):** boots and creates all data dirs owned by the runtime
     uid — HF's arbitrary-uid runtime is safe with a plain `chmod 777 /opt/data` at build
   - BYOK credentials confirmed **browser-side** (`localStorage['open-design:config']`);
     daemon proxy forwards per-request `baseUrl+apiKey+model` (Bearer on OpenAI route,
     `x-api-key` on Anthropic route) — no server-side seeding exists or is needed
   - Zen keyless is dead (401/500 keyless; docs: sign-in + API key). Free models remain $0
     with a free Zen account key. Upstream image already bundles git; tini entrypoint intact.
4. `healthz.js` go/no-go: **NO-GO** — root `/` returning 401 is fine for HF; no shim needed.

**Exit criteria: met.** No upstream changes required. Proceed to Phase 1 with:
- `OD_ALLOWED_ORIGINS` auto-derivation is REQUIRED in start.sh
- `OD_API_TOKEN` is REQUIRED whenever `OD_BIND_HOST=0.0.0.0`
- Image pinned: `ghcr.io/nexu-io/od:0.21.1` (digest `sha256:441daca881e699657bacf28e0c27b16cd6be551dfff4bd63368dd74bec581f39`)

### Phase 1 — Author the Space repo
Build every file from §3 against the Phase 0 findings; then locally:
`docker build` + full boot test with a populated data dir + restore/sync cycle against a real
(private) HF dataset repo — the same way HuggingMes was verified in this workspace.

### Phase 2 — Ship to HF *(needs you)*
1. You create the new Space (Docker type) — name of your choice, e.g. `bot404/opendesign` —
   and add the secrets from §4 (`OD_API_TOKEN`, `LLM_API_KEY`, `HF_TOKEN` first).
2. I push the repo (you provide write access to that Space — the newsalert Space is untouched).
3. Verify live: build logs clean → `/api/health` 200 → UI loads → BYOK chat works → kill/restart
   the Space → data survives (Dataset restore round-trip proven).
4. Optional: enable the wake-on-demand GitHub Actions workflow (single GET, no schedule)
   copied from HuggingMes' `.github/workflows/wake-on-demand.yml`.

### Risks & mitigations
| Risk | Mitigation |
|---|---|
| HF's arbitrary runtime UID breaks writes to upstream-owned paths | `chmod a+rwX /app` at build; verified by uid-4242 test in Phase 0 |
| RepoScanner flags | zero tooling/keywords; wake-on-demand only, external; scrub check in the verify checklist |
| Model 429s on shared egress IPs (HuggingMes Zen lesson) | keyed BYOK provider recommended; keyless Zen only as fallback |
| Memory ceiling on free tier | upstream image idles at ~20MB; `NODE_OPTIONS=2048` headroom; no mem_limit imposed (unlike compose) |
| Build-time drift (mutable `latest`) | pin `OD_IMAGE` digest in the Dockerfile ARG |
| Dataset sync of hot SQLite files | port hermes-sync's WAL-safe staging (skip vanished `-wal/-shm`), tested in Phase 1 |
| ~~od image arch support~~ | **resolved pre-Phase-0:** `ghcr.io/nexu-io/od:0.21.1` verified via manifest inspect — `linux/amd64` + `linux/arm64` present (HF-safe) |

---

## 6. What I need from you (nothing else)

1. **Confirmation of the two design decisions** (§2): od owns 7861 directly (no Node shim), and
   the design engine = BYOK provider seeded from secrets (config A), with keyless Zen fallback (B).
2. **Phase 0 go-ahead** — I verify the pinned image locally exactly as the Space will run it.
3. Later: **the new Space's name/write access + the secrets** — created by you in HF settings;
   never pasted into chat or committed.
