# OpenDesign × Hugging Face Spaces
# Blueprint: bot404/newsalert (HuggingMes) Dockerfile discipline:
#   - FROM the upstream prebuilt image (pin the tag; never :latest)
#   - permissive modes on every path the runtime UID must write
#     (HF runs containers as an ARBITRARY non-root UID - verified in
#     Phase 0 that a fresh-volume uid-4242 boot works with this setup)
#   - HEALTHCHECK on the public port; start.sh as the single entrypoint
#
# Phase 0 verified facts baked in:
#   * od binds 0.0.0.0 and REFUSES to start without OD_API_TOKEN
#   * data root is OD_DATA_DIR (single source of truth, /opt/data here)
#   * upstream runtime image is Alpine + node:24, entrypoint tini,
#     app tree /app owned by uid 1001, no system python

ARG OD_IMAGE=ghcr.io/nexu-io/od:0.21.1
FROM ${OD_IMAGE}

USER root

# curl for the Docker HEALTHCHECK; bash for start.sh; python3 for the sync
# stack (the od image ships neither curl nor a usable system python).
RUN apk add --no-cache curl bash python3

# Make the daemon's Basic-auth username env-configurable (upstream
# hardcodes it as 'open-design'; no upstream env override exists).
COPY --chmod=0755 patch-auth.sh /tmp/patch-auth.sh
RUN /tmp/patch-auth.sh && rm -f /tmp/patch-auth.sh

# Zen muse-spark* models are served ONLY on the OpenAI Responses API;
# add an in-process chat→responses translation for exactly those models
# (all other models keep the original proxy path — zero impact).
COPY --chmod=0755 muse-shim.js /tmp/muse-shim.js
RUN node /tmp/muse-shim.js && rm -f /tmp/muse-shim.js

# The REAL design agent (BYOK API runs) spawns the OpenCode CLI. The pinned
# image does not ship it, so every design-generation run fails with
# "BYOK API runs require OpenCode". Bundle the official release into the
# resource root the daemon scans first (OD_RESOURCE_ROOT/bin/libexec/opencode).
# Pinned for reproducibility (verified working on linux-x64/musl 2026-09-03).
ARG OPENCODE_VERSION=1.18.27
RUN apk add --no-cache curl bash \
    && curl -fsSL https://opencode.ai/install -o /tmp/oc-install.sh \
    && OPENCODE_VERSION="${OPENCODE_VERSION}" bash /tmp/oc-install.sh \
        --version "${OPENCODE_VERSION}" --no-modify-path \
    && mkdir -p /app/bin/libexec/opencode \
    && mv "$HOME/.opencode/bin/opencode" /app/bin/libexec/opencode/opencode \
    && chmod 0755 /app/bin/libexec/opencode/opencode \
    && rm -f /tmp/oc-install.sh \
    && /app/bin/libexec/opencode/opencode --version

# huggingface_hub + deps for od-sync.py (dataset backup/restore), isolated
# in a dedicated venv so nothing touches the daemon's node_modules.
RUN python3 -m venv /opt/sync-venv \
    && /opt/sync-venv/bin/pip install --no-cache-dir \
        "huggingface_hub[cli]>=0.34,<2" \
        hf_transfer

COPY --chmod=0755 start.sh /usr/local/bin/start.sh
COPY --chmod=0755 od-sync.py /app/od-sync.py

# HF runs the container as an arbitrary non-root UID. Make the whole app
# tree writable by any uid (same a+rwX discipline HuggingMes applies to
# /opt/hermes) so the daemon can write bundled-plugin state inside /app
# and the sync venv stays usable. /opt/data is the persistent volume.
RUN mkdir -p /opt/data \
    && chown -R 1001:1001 /app \
    && chmod -R a+rwX /app \
    && chmod 777 /opt/data \
    && chmod -R a+rX /opt/sync-venv \
    && chmod -R a+rX /app/apps/daemon/dist

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=2560 \
    OD_BIND_HOST=0.0.0.0 \
    OD_PORT=7861 \
    OD_DATA_DIR=/opt/data \
    OD_RESOURCE_ROOT=/app \
    PORT=7861

EXPOSE 7861

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7861/api/health || exit 1

# start.sh owns the process tree: restore, env wiring, supervised od,
# background sync loop, graceful shutdown with a final upload.
# (tini remains as PID 1 via the base image ENTRYPOINT; bash is our
# immediate child and reaps node + python.)
CMD ["/bin/bash", "/usr/local/bin/start.sh"]
