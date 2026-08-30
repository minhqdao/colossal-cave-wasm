#!/usr/bin/env bash
# Runs the jsdom-based browser smoke tests for web/launcher.js without
# adding a package.json: jsdom lands in a gitignored scratch folder under
# scripts/ and the test itself requires it from there.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d scripts/node_modules/jsdom ]; then
  echo "installing jsdom into scripts/node_modules (one time)..."
  npm install --no-save --no-package-lock --prefix scripts --silent jsdom@26
fi

exec node --test scripts/browser-smoke.test.mjs "$@"
