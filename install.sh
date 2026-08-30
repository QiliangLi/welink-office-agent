#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node scripts/agent.mjs init
echo "Initialized. Edit config/*.json, then run: npm run preflight"
