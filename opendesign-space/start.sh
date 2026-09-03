#!/bin/bash
set -euo pipefail
umask 0077

# ════════════════════════════════════════════════════════════════
# OpenDesign × HF Spaces — boot orchestrator
# Blueprint: bot404/newsalert (HuggingMes) start.sh discipline:
#   restore first (best-effort), env wins over defaults, one public
#   port, supervised service, never let persistence kill the boot.
# Phase 0 findings baked in (see DEVELOPER_NOTES.md):
#   * od REFUSES to bind 0.0.0.0 without OD_API_TOKEN (fail-closed)
#   * browser Origin headers are 403 unless whitelisted via
#     OD_ALLOWED_ORIGINS -> derive from $SPACE_HOST automatically
# ════════════════════════════════════════════════════════════════

APP_DIR="/app"
# The upstream od image is Alpine with NO system python; the sync venv is
# installed at build time (see Dockerfile). Fall back to system python3 for
# local/dev runs.
SYNC_PYTHON="${SYNC_PYTHON:-/opt/sync-venv/bin/python3}"
[ -x "$SYNC_PYTHON" ] || SYNC_PYTHON="$(command -v python3 || echo python3)"
OD_PORT="${OD_PORT:-7861}"
export OD_PORT
export OD_BIND_HOST="${OD_BIND_HOST:-0.0.0.0}"
export OD_DATA_DIR="${OD_DATA_DIR:-/opt/data}"
export NODE_ENV="${NODE_ENV:-production}"

# Login username (Basic-auth user, patched to be env-driven in the image).
export OD_API_USERNAME="${OD_API_USERNAME:-open-design}"

# ── CLI performance flags (measured 2026-09-03) ──
# The bundled OpenCode CLI otherwise does an auto-update check and a
# models-catalog fetch on every spawn; on a constrained network either can
# stall 40–130s before the model even starts. Disabling both (the config we
# inject is fully explicit, no catalog needed) + upstream FAST_BOOT cut the
# agent round-trip from avg 61.8s (worst 131s) to avg 10.3s in A/B tests —
# with byte-identical model output and cost. Model quality is untouched.
export OPENCODE_DISABLE_AUTOUPDATE="${OPENCODE_DISABLE_AUTOUPDATE:-1}"
export OPENCODE_DISABLE_MODELS_FETCH="${OPENCODE_DISABLE_MODELS_FETCH:-1}"
export OPENCODE_FAST_BOOT="${OPENCODE_FAST_BOOT:-1}"
# Settings "Test connection" default is 12s — too tight for reasoning models
# on a cold link (false failures). 30s removes the false timeout; happy paths
# still return in ~1s so nothing feels slower.
export OD_CONNECTION_TEST_PROVIDER_TIMEOUT_MS="${OD_CONNECTION_TEST_PROVIDER_TIMEOUT_MS:-30000}"

# Node heap: upstream tunes 192MB for a 384MB container cap; HF free CPU
# gives ~16GB, and artifact exports / agent streams want headroom.
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2048}"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║       🎨 OpenDesign × HF Spaces          ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""
echo "[boot] login username: ${OD_API_USERNAME}"

mkdir -p "$OD_DATA_DIR"

# ── 1. Restore workspace/state from HF Dataset (best-effort) ──
if [ -n "${HF_TOKEN:-}" ]; then
  echo "[boot] restoring OpenDesign state from HF Dataset..."
  "$SYNC_PYTHON" "$APP_DIR/od-sync.py" restore || echo "[boot] restore failed (continuing with current data root)"
else
  echo "[boot] HF_TOKEN not set - dataset persistence is DISABLED."
  echo "[boot] All projects/artifacts will be lost on every Space restart."
fi

# ── 2. Auth: OD_API_TOKEN is mandatory when binding 0.0.0.0 ──
# (od exits with a clear error otherwise - verified in Phase 0.)
# Accept GATEWAY_TOKEN as an alias so operators can reuse the same secret
# name as other gateway Spaces. Never print the token value to the log.
if [ -z "${OD_API_TOKEN:-}" ] && [ -n "${GATEWAY_TOKEN:-}" ]; then
  export OD_API_TOKEN="$GATEWAY_TOKEN"
fi
if [ -z "${OD_API_TOKEN:-}" ]; then
  # node is guaranteed in the od image; python may not be.
  OD_API_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")"
  export OD_API_TOKEN
  echo "[boot] WARNING: no OD_API_TOKEN/GATEWAY_TOKEN secret set."
  echo "[boot] Generated an ephemeral token for THIS BOOT only - the browser"
  echo "[boot] will ask for it after every restart. Set the OD_API_TOKEN"
  echo "[boot] secret for a stable login."
else
  echo "[boot] OD_API_TOKEN secret is set (password auth active)."
fi

# ── 3. CORS: browser Origin headers are 403 unless whitelisted ──
# On HF, the UI is served from https://$SPACE_HOST and can be framed from
# huggingface.co. Derive both unless the operator set an explicit value.
if [ -z "${OD_ALLOWED_ORIGINS:-}" ]; then
  _origins=""
  if [ -n "${SPACE_HOST:-}" ]; then
    _origins="https://${SPACE_HOST}"
  fi
  # HF embeds Spaces in an iframe on huggingface.co; the embedded UI's
  # API fetches carry Origin: https://huggingface.co and od 403s any
  # non-whitelisted origin (Settings autosave then reports the daemon
  # as offline). Whitelist HF's own embed origins.
  for _o in https://huggingface.co https://hf.co; do
    _origins="${_origins:+${_origins},}${_o}"
  done
  _extra="${OD_EXTRA_ORIGINS:-}"
  if [ -n "$_extra" ]; then
    _origins="${_origins:+${_origins},}${_extra}"
  fi
  if [ -n "$_origins" ]; then
    export OD_ALLOWED_ORIGINS="$_origins"
    echo "[boot] OD_ALLOWED_ORIGINS auto-derived (SPACE_HOST + HF embed origins)"
  fi
fi

# ── 4. Optional operator hook (replayed every boot) ──
if [ -n "${OD_SPACE_RUN:-}" ]; then
  echo "[boot] running OD_SPACE_RUN hook..."
  bash -c "${OD_SPACE_RUN}" || echo "[boot] OD_SPACE_RUN failed (non-fatal)"
fi

# ── 5. Background persistence loop ──
sync_pid=""
if [ -n "${HF_TOKEN:-}" ]; then
  "$SYNC_PYTHON" "$APP_DIR/od-sync.py" loop &
  sync_pid=$!
  echo "[boot] backup sync loop started (pid $sync_pid)"
fi

# ── 6. Graceful shutdown: forward signal, final sync, exit ──
od_pid=""
shutdown() {
  echo ""
  echo "[shutdown] SIGTERM received - stopping services..."
  if [ -n "$od_pid" ]; then
    kill -TERM "$od_pid" 2>/dev/null || true
  fi
  if [ -n "$sync_pid" ]; then
    kill -TERM "$sync_pid" 2>/dev/null || true
    wait "$sync_pid" 2>/dev/null || true
  fi
  # Best-effort final upload so the last minutes of work survive restarts.
  if [ -n "${HF_TOKEN:-}" ]; then
    echo "[shutdown] final state upload..."
    timeout 120 "$SYNC_PYTHON" "$APP_DIR/od-sync.py" sync-once || echo "[shutdown] final sync failed (non-fatal)"
  fi
  exit 0
}
trap shutdown TERM INT

# ── 7. Supervised od launch (restart with backoff on crash) ──
restart_delay="${OD_RESTART_DELAY:-5}"
max_restarts="${OD_MAX_RESTARTS:-0}"   # 0 = unlimited, like the blueprint
restarts=0

while true; do
  echo "[boot] starting OpenDesign daemon on 0.0.0.0:${OD_PORT}..."
  node "$APP_DIR/apps/daemon/dist/cli.js" --no-open &
  od_pid=$!
  # set +e: wait returns the child's exit code; under set -e a non-zero
  # wait would abort start.sh before we can capture/supervise it.
  set +e
  wait "$od_pid"
  code=$?
  set -e

  if [ -n "$max_restarts" ] && [ "$max_restarts" -gt 0 ]; then
    restarts=$((restarts + 1))
    if [ "$restarts" -ge "$max_restarts" ]; then
      echo "[supervisor] od exited (code=$code); restart limit reached - exiting so the platform can rebuild."
      shutdown
    fi
  fi

  echo "[supervisor] od exited (code=$code); restarting in ${restart_delay}s..."
  sleep "$restart_delay"
done
