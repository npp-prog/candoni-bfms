#!/bin/sh
# Build every report (or the codes given) through the Admin DataSource against the emulators.
set -e
cd "$(dirname "$0")/../.."
npx esbuild tests/e2e/src/reports.ts --bundle --platform=node --format=cjs --outfile=tests/e2e/.reports.cjs --external:firebase-admin --alias:@bfms/shared=./shared/src/index.ts --log-level=warning
NODE_PATH=./node_modules node tests/e2e/.reports.cjs "$@" 2>&1 | grep -v -e Metadata -e trace-warn
