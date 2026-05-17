#!/bin/bash
set -euo pipefail

PID=$(pgrep -f "cc-connect/bin/cc-connect" | head -1)

if [ -z "$PID" ]; then
  echo "cc-connect not running, starting fresh..."
  cc-connect &
  exit 0
fi

echo "Stopping cc-connect (PID $PID)..."
kill "$PID"

# Wait for it to actually stop
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

echo "Starting cc-connect..."
cc-connect &