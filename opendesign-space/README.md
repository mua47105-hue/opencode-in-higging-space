---
title: OpenDesign Studio
emoji: 🎨
colorFrom: purple
colorTo: pink
sdk: docker
app_port: 7861
pinned: true
license: apache-2.0
short_description: The open-source Claude Design alternative, self-hosted
---

# 🎨 OpenDesign × Hugging Face Spaces

[OpenDesign](https://github.com/nexu-io/open-design) — the open-source Claude Design
alternative — running 24/7 on a Hugging Face Docker Space, with persistent state via
a private HF Dataset.

**Architecture:** port of the [HuggingMes](https://huggingface.co/spaces/bot404/newsalert)
blueprint (boot orchestrator + secrets-driven config + HF Dataset persistence) to the
OpenDesign daemon. See `DEVELOPER_NOTES.md` for invariants and `DEPLOYMENT_README.md`
for the operator guide.

## ✨ What you get

- 🎨 **Full OpenDesign studio:** prototypes, decks, mobile, images, documents, HyperFrames
- 🔐 **Token auth:** the UI and API are protected by your `OD_API_TOKEN` secret
- 💾 **Persistent state:** projects, artifacts, brands, design systems synced to a private
  HF Dataset (restore on boot, sync every 600s, final upload on shutdown)
- 🤖 **BYO model:** paste any OpenAI-compatible endpoint (Zen free tier, OpenRouter,
  DeepSeek, Anthropic, …) into Settings — credentials stay in your browser
- 🔄 **Self-healing:** the daemon is supervised and restarted if it exits unexpectedly

## 🚀 Quick start

1. Duplicate this Space (or create a new Docker Space from this repo).
2. Add **Secrets** (Settings → Variables and secrets):

   | Secret | Value |
   |---|---|
   | `OD_API_TOKEN` | `openssl rand -hex 32` |
   | `HF_TOKEN` | HF token with **write** access (enables persistence) |

3. Open the Space, sign in with your configured username (default `open-design`) and your `OD_API_TOKEN` as password.
4. In OpenDesign **Settings**, configure your model provider (BYOK) — e.g.
   `https://opencode.ai/zen/v1` with a free Zen API key and a free model id.

## 🔐 Access control

- Everything under `/` requires `OD_API_TOKEN` (browser Basic auth or `Authorization: Bearer`).
- CORS is locked to the Space's own origin (`https://<owner>-<space>.hf.space`).
- The daemon **refuses to boot** on 0.0.0.0 without a strong token (fail-closed).

## 💾 Persistence

State lives in `OD_DATA_DIR=/opt/data` (HF persistent volume + private Dataset backup):

| Variable | Default | Description |
|---|---|---|
| `HF_TOKEN` | — | HF token with **write** scope; without it data is ephemeral |
| `BACKUP_DATASET_NAME` | `opendesign-backup` | Private dataset repo for backups |
| `SYNC_INTERVAL` | `600` | Backup cadence in seconds (±10% jitter) |
| `SYNC_MAX_FILE_BYTES` | `52428800` | Per-file cap (larger files are skipped) |

Excluded from sync: `logs/`, caches, `node_modules`, SQLite `-wal`/`-shm`/`-journal`
temp files. Secret-bearing keys in config/state files are redacted before upload.

## 🤖 Model providers

OpenDesign runs its design loop through your own model endpoint (BYOK), configured in
the UI's Settings — the credentials are stored in your **browser** (localStorage), not
on the server. Verified options:

- **OpenCode Zen free tier:** `baseUrl = https://opencode.ai/zen/v1`, free API key from
  [opencode.ai](https://opencode.ai), free model ids: `big-pickle`, `mimo-v2.5-free`,
  `ling-3.0-flash-fin-free`, `nemotron-3-ultra-free`, `nemotron-3.5-lightning-free`,
  `muse-spark-1.2-contributor-free`. Note: HF Spaces share egress IPs — expect 429s
  under load; a keyed provider avoids that.
- **Any OpenAI-compatible endpoint:** OpenRouter, DeepSeek, GLM, Kimi, Ollama, vLLM, …

## 🩺 Health

- `GET /api/health` → `{"ok":true,"version":"…"}` (platform readiness probe)
- `GET /api/ready` → 200 while serving, 503 during shutdown

## ⚠️ Notes

- Free Spaces sleep when idle; wake by opening the Space (or an external wake-on-demand
  trigger — never a scheduled pinger inside the Space).
- BYOK provider settings are per-browser by design (like any web login). Artifacts,
  projects, and design systems persist server-side regardless of browser.
- This Space runs upstream OpenDesign unmodified (pinned `ghcr.io/nexu-io/od` image);
  the surrounding orchestration is Apache-2.0 like the upstream project.
