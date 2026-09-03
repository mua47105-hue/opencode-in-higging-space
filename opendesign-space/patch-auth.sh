#!/bin/sh
# ════════════════════════════════════════════════════════════════
# OpenDesign × HF Spaces — build-time auth patch
#
# Upstream hardcodes the Basic-auth username:
#   export const API_TOKEN_BASIC_USERNAME = 'open-design';
#
# There is no upstream env override for it, so we patch the compiled
# daemon (pinned image tag = patch matches a known file revision) to
# read OD_API_USERNAME at runtime, falling back to the upstream name.
# Only the auth check and the 401 help text are touched.
# ════════════════════════════════════════════════════════════════
set -eu

AUTH_FILE="/app/apps/daemon/dist/api-token-auth.js"

[ -f "$AUTH_FILE" ] || { echo "[patch] $AUTH_FILE not found - image layout changed?"; exit 1; }

sed -i "s|export const API_TOKEN_BASIC_USERNAME = 'open-design';|export const API_TOKEN_BASIC_USERNAME = (process.env.OD_API_USERNAME \|\| 'open-design').trim();|" "$AUTH_FILE"

# Fail the build if the patch did not apply (never ship a broken auth).
grep -q "OD_API_USERNAME" "$AUTH_FILE" || { echo "[patch] username patch did NOT apply"; exit 1; }

# The 401 help text names the old default; make it name-agnostic.
for f in /app/apps/daemon/dist/*.js; do
  [ -f "$f" ] || continue
  if grep -q 'Use username "open-design"' "$f"; then
    sed -i 's|Use username "open-design" and OD_API_TOKEN as the password.|Use your configured username and OD_API_TOKEN as the password.|' "$f"
  fi
done

echo "[patch] auth username is now env-driven (OD_API_USERNAME)"
