#!/bin/bash
# Поддерживает headless Chrome с CDP на :9222, перезапускает при падении.
PORT=${PORT:-9222}
PROFILE=${PROFILE:-/tmp/opencode/cprof}
LOG=${LOG:-/tmp/opencode/chrome.log}

while true; do
  echo "[chrome] $(date +%T) starting on :$PORT"
  google-chrome \
    --headless=new --no-sandbox --disable-gpu \
    --remote-debugging-port=$PORT \
    --user-data-dir=$PROFILE \
    --window-size=1920,1080 \
    about:blank >>"$LOG" 2>&1
  code=$?
  echo "[chrome] $(date +%T) exited code=$code, restarting in 3s"
  sleep 3
done
