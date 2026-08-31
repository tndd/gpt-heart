#!/bin/sh
set -eu

mkdir -p /data/browser /data/state /tmp/raspi-chatgpt-loop

Xvfb :99 -screen 0 1440x1000x24 -ac +extension RANDR > /tmp/raspi-chatgpt-loop/xvfb.log 2>&1 &

display_attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  display_attempt=$((display_attempt + 1))
  if [ "$display_attempt" -ge 100 ]; then
    echo "Xvfb did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done

x11vnc -display :99 -forever -shared -rfbport 5900 -nopw > /tmp/raspi-chatgpt-loop/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 > /tmp/raspi-chatgpt-loop/novnc.log 2>&1 &

case "${LOGIN_ONLY:-false}" in
  true|TRUE|1)
    chromium_binary=$(find /ms-playwright -type f -path '*/chrome-linux*/chrome' -print -quit)
    if [ -z "$chromium_binary" ]; then
      echo "Chromium executable was not found" >&2
      exit 1
    fi
    exec "$chromium_binary" \
      --no-sandbox \
      --disable-dev-shm-usage \
      --no-first-run \
      --no-default-browser-check \
      --password-store=basic \
      --user-data-dir=/data/browser \
      "${PROJECT_URL:-https://chatgpt.com/}"
    ;;
esac

exec node /app/dist/index.js
