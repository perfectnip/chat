# Use Debian-based image so better-sqlite3 prebuilt binaries work (Alpine/musl has no prebuilds)
FROM node:20-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json ./
COPY scripts ./scripts
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv make g++ tesseract-ocr ffmpeg && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv /app/.schoology-venv
COPY schoology-requirements.txt ./
RUN /app/.schoology-venv/bin/pip install --no-cache-dir -r schoology-requirements.txt
COPY schoology/ ./schoology/
RUN npm install --omit=dev

# Copy schoology-mcp for the Flask server (already has .git removed)
COPY schoology-mcp/ ./schoology-mcp/
RUN /app/.schoology-venv/bin/pip install --no-cache-dir -r /app/schoology-mcp/requirements.txt

FROM base AS runner
ENV NODE_ENV=production
ENV PORT=8080
# Stable per-deploy version for /api/version (auto-update) + asset cache-busting.
# Must NOT be boot-time (that made every restart change the version and reload
# all open chats). Override at deploy with --build-arg ASSET_VERSION=$(git rev-parse --short HEAD).
ARG ASSET_VERSION=2026-09-24.1
ENV ASSET_VERSION=${ASSET_VERSION}
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nodejs
# Install python3 BEFORE copying venvs so symlinks resolve correctly
# tesseract-ocr + ffmpeg are needed by AI Assistant file readers (OCR, audio analysis, video).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv tesseract-ocr ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.schoology-venv /app/.schoology-venv
COPY . .
# schoology/ files can carry unreadable local modes (600/700 from AI editors) which
# Docker COPY preserves; nodejs user then can't read them (e.g. /schoology/ served
# the chat SPA fallback instead of the dashboard, 2026-08-25). Normalize at build.
# Same bug class hit server/webpush.js on 2026-08-27 (Node EACCES at boot) —
# normalize the whole app tree so AI-written files can never break boot again.
RUN chmod -R a+rX /app/schoology /app/server /app/public /app/bridge
# Socket.IO browser bundle for game.html (/socket.io.min.js); file may be untracked in git
RUN cp -f node_modules/socket.io/client-dist/socket.io.min.js public/socket.io.min.js
RUN mkdir -p /data && chown -R nodejs:nodejs /data
# Create playwright cache dir and install browsers before switching to nodejs user
RUN mkdir -p /home/nodejs/.cache/ms-playwright && chown -R nodejs:nodejs /home/nodejs
ENV PLAYWRIGHT_BROWSERS_DIR=/home/nodejs/.cache/ms-playwright
RUN /app/.schoology-venv/bin/playwright install-deps chromium && \
    /app/.schoology-venv/bin/playwright install chromium && \
    cp -r /root/.cache/ms-playwright/* /home/nodejs/.cache/ms-playwright/ && \
    chown -R nodejs:nodejs /home/nodejs/.cache/ms-playwright
USER nodejs
EXPOSE 8080 8081
ENV DATA_DIR=/data
ENV SCHOOLOGY_HEADLESS=true
ENV SCHOOLOGY_KEEPALIVE=false
ENV SCHOOLOGY_STORAGE_STATE=/data/schoology_storage.json
# AI tool env (optional): JUDGE0_KEY enables [RUN:lang code] for C/C++/Rust/Go/Java/etc.
# ENV JUDGE0_KEY=
# ENV JUDGE0_URL=https://judge0-ce.p.rapidapi.com
CMD ["sh", "-c", "cd /app/schoology; nohup sh /app/scripts/setup-whisper.sh > /data/whisper-setup.log 2>&1 & /app/.schoology-venv/bin/gunicorn -b 0.0.0.0:8081 --workers 1 --threads 8 -c /app/schoology/gunicorn.conf.py server:app & node /app/server/index.js"]