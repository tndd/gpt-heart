FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci && \
    npx playwright install --with-deps chromium && \
    apt-get update && \
    apt-get install -y --no-install-recommends xvfb x11vnc novnc websockify fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

COPY docker/entrypoint.sh /usr/local/bin/raspi-chatgpt-loop
COPY docker/cleanup-browser-profile.sh /usr/local/bin/cleanup-browser-profile
RUN chmod +x /usr/local/bin/raspi-chatgpt-loop /usr/local/bin/cleanup-browser-profile && \
    mkdir -p /data/browser /data/state && \
    chown -R node:node /data /app /ms-playwright

USER node
EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/raspi-chatgpt-loop"]
