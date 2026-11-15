#!/bin/sh
# Serve this folder on localhost and open it in the default browser.
cd "$(dirname "$0")" || exit 1
PORT=8765
echo "PDF Filler: http://127.0.0.1:$PORT/  (Ctrl+C to stop)"
( sleep 1; xdg-open "http://127.0.0.1:$PORT/" >/dev/null 2>&1 ) &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
