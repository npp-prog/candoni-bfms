#!/bin/sh
# Start an isolated emulator set (auth, firestore, functions) for end-to-end scripts.
#   tests/e2e/emulators.sh start [SLOT]   # SLOT 1–9 uses ports 10x01 / 10x80 / 10x99; 0 = firebase.json defaults
#   tests/e2e/emulators.sh stop  [SLOT]
# Then: E2E_SLOT=SLOT node tests/e2e/00-setup.cjs && E2E_SLOT=SLOT node tests/e2e/10-budget.cjs
set -e
cd "$(dirname "$0")/../.."
CMD=${1:-start}; SLOT=${2:-0}
CFG=firebase.json
if [ "$SLOT" != "0" ]; then
  B=$((10000 + SLOT * 100)); CFG=".firebase.e2e-$SLOT.json"
  cat > "$CFG" <<JSON
{ "firestore": { "rules": "firestore.rules", "indexes": "firestore.indexes.json" },
  "functions": [{ "source": "functions", "codebase": "bfms", "runtime": "nodejs22" }],
  "emulators": { "auth": { "port": $((B + 99)) }, "functions": { "port": $((B + 1)) },
    "firestore": { "port": $((B + 80)), "websocketPort": $((B + 81)) }, "hub": { "port": $((B + 40)) },
    "logging": { "port": $((B + 50)) }, "eventarc": { "port": $((B + 60)) }, "tasks": { "port": $((B + 70)) },
    "ui": { "enabled": false }, "singleProjectMode": true } }
JSON
fi
LOG=".firebase.e2e-$SLOT.log"
if [ "$CMD" = "stop" ]; then
  for p in $(pgrep -f -- "--config $CFG"); do kill "$p" 2>/dev/null || true; done
  for p in $(pgrep -f -- "e2e-slot-$SLOT"); do kill "$p" 2>/dev/null || true; done
  echo "stopped slot $SLOT"; exit 0
fi
npm run build -w functions >/dev/null
nohup npx firebase emulators:start --only auth,firestore,functions --project demo-bfms --config "$CFG" --log-verbosity QUIET > "$LOG" 2>&1 &
for i in $(seq 1 80); do grep -q "All emulators ready" "$LOG" 2>/dev/null && break; sleep 3; done
grep -q "All emulators ready" "$LOG" && echo "emulators ready (slot $SLOT, log $LOG)" || { echo "emulators failed to start; see $LOG"; tail -20 "$LOG"; exit 1; }
