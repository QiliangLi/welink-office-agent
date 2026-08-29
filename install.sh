#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node .claude/skills/welink-office-agent/scripts/agent.mjs init
echo "Initialized. Edit config/*.json, then run: npm run preflight"
