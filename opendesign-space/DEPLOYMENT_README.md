# OpenDesign on HF Spaces — Deployment Guide

Version: 1.0.0 (2026-09-02)
Target: Hugging Face Docker Space (free CPU basic works)
Blueprint: [bot404/newsalert](https://huggingface.co/spaces/bot404/newsalert) (HuggingMes)
Payload: [nexu-io/open-design](https://github.com/nexu-io/open-design) v0.21.1

---

## 1. Deploy steps

1. Create a new Hugging Face **Docker Space** (or duplicate this one).
2. Push this repo to the Space (main branch).
3. In **Settings → Variables and secrets**, add these as **Secrets** (never plain
   variables, never the dashboard env editor):

   | Secret | Purpose | Required |
   |---|---|---|
   | `OD_API_TOKEN` | UI + API auth token = your login **password**. (`GATEWAY_TOKEN` accepted as alias.) | ✅ |
   | `OD_API_USERNAME` | Login username (Basic auth). Default `open-design`. | optional |
   | `HF_TOKEN` | HF token with **write** scope — enables Dataset backup/restore | strongly recommended |
   | `BACKUP_DATASET_NAME` | Private dataset repo name (default `opendesign-backup`) | optional |
   | `SYNC_INTERVAL` | Backup cadence seconds (default `600`) | optional |
   | `OD_EXTRA_ORIGINS` | Extra comma-separated origins if you front the Space with a custom domain | optional |
   | `OD_SPACE_RUN` | Bash snippet replayed on every boot (advanced) | optional |

   Platform-injected (do NOT set): `SPACE_HOST`, `SPACE_ID`, `SPACE_AUTHOR_NAME`, `PORT`.

4. Build & run (automatic on push). First boot creates a private `<owner>/opendesign-backup`
   dataset on first sync if it doesn't exist.

## 2. First use

1. Open the Space URL. The browser asks for credentials:
   - username: your `OD_API_USERNAME` (default `open-design`)
   - password: your `OD_API_TOKEN` secret value
2. In **Settings** (the OpenDesign web UI), configure the model provider (BYOK):
   - OpenAI-compatible endpoint, e.g. `https://opencode.ai/zen/v1`
   - Your API key (Zen free key works with the free models)
   - A model id, e.g. `muse-spark-1.2-contributor-free`, `muse-spark-1.3-contributor-free`,
     `big-pickle`, `mimo-v2.5-free` or `nemotron-3-ultra-free`
   - **Use the `openai` protocol for Zen** — it is the only protocol where every
     Zen model works. muse-spark models are additionally rerouted to Zen's
     Responses API automatically from ANY protocol (in-process shim — no extra
     hop); claude-sonnet models on Zen are PAID (need a payment method on the
     Zen account), not part of the free tier.
   - Free-tier note: per-model rolling limits (HTTP 429) can appear under load —
     retry later or switch model; muse-spark rarely hits them.
   - These credentials live in your **browser** (localStorage), not the server —
     like any web login. Projects/artifacts persist server-side regardless.

## 3. Verification checklist (Definition of Done)

```bash
curl -sS https://<owner>-<space>.hf.space/api/health
# → {"ok":true,"version":"0.21.1"}

curl -sS -o /dev/null -w '%{http_code}\n' https://<owner>-<space>.hf.space/
# → 401 (auth gate live)

# UI sign-in works (configured username / token) and the studio loads

# Persistence: create a project → wait one sync interval (or restart the
# Space, which triggers the shutdown final-sync) → restart → sign in →
# the project is still there (restored from the dataset)

# Scrub check (must be zero REAL matches; see DEVELOPER_NOTES §3.7)
grep -riE "cloudflar[e]|tunne[l]|prox[y]|[T]OR|vn[c]|ngro[k]|chrome remot[e]" .
```

## 4. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Space boot-loops with `OD_BIND_HOST=0.0.0.0 requires OD_API_TOKEN` | Secret missing entirely. Set `OD_API_TOKEN` — start.sh generates an ephemeral token only when no secret is present. |
| UI loads but API calls fail with 403 "Cross-origin requests are not allowed" | `OD_ALLOWED_ORIGINS` missing your origin. Auto-derived from `SPACE_HOST`; if behind a custom domain set `OD_EXTRA_ORIGINS`. |
| Login asks for a new token after every restart | No `OD_API_TOKEN` secret set — start.sh generates an ephemeral one each boot. Set the secret. |
| Data gone after restart | `HF_TOKEN` unset → persistence disabled by design. Add the secret; old data is unrecoverable. |
| Model 429s | Zen free tier shares per-IP budget across HF Spaces. Use a keyed provider (OpenRouter etc.) or retry later. |
| "Invalid API key" when pasting the Zen key | Protocol set to anthropic/other — Zen keys are `sk-…` and must use the **openai** protocol. |
| "BYOK API runs require OpenCode" | Bundled CLI not detected. Check `GET /api/agents` and that `OD_RESOURCE_ROOT=/app` + `/app/bin/libexec/opencode/opencode` exist. |
| "Run works for 2–4 min, then stops early with no error (says succeeded but nothing was written) | Fixed 2026-09-03: CLI v1.18 renamed the permission bypass to `--auto`; the shim now sends it. If a future CLI update reintroduces this, set the Space variable `OD_OPENCODE_PERMISSION_BYPASS_FLAG` (see DEVELOPER_NOTES §3.5f). |
| Agent answers feel rushed / under-reasoned | muse now runs at reasoning effort **high** by default (was Zen server default, which varies run to run). Tune with Space variable `OD_MUSE_REASONING_EFFORT`: `xhigh` deeper, `medium`/`low` faster (see DEVELOPER_NOTES §3.5g). |
| Design run spins on "Preparing/Thinking" then silently fails after ~2.5 min | `GET /api/runs` → the run shows `failed / UPSTREAM_UNAVAILABLE (upstream_5xx)`. muse models under the **anthropic** protocol hit Zen's /messages (muse is /responses-only; the shim now reroutes muse from any protocol, but other models still need the **openai** protocol). |
| First agent response takes 40s+ | Fast-boot flags missing (see DEVELOPER_NOTES §3.5d): `OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_FAST_BOOT=1`. |
| Backup dataset empty | Check runtime log for `OpenDesign sync failed:` lines; verify `HF_TOKEN` has write scope and the dataset name is right. |

## 5. Operational notes

- Secrets live only in Space Secrets; the sync redacts secret-bearing keys before upload.
- Files >50MB are skipped by the sync (`SYNC_MAX_FILE_BYTES`); `logs/` never leaves the container.
- Free Spaces sleep when idle; wake on demand by opening the Space (cold start ≈ 1 min).
- The upstream image is pinned by tag+digest; bump deliberately (check od release notes
  for data-migration notes before upgrading).
