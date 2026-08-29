$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node .claude/skills/welink-office-agent/scripts/agent.mjs init
Write-Host "Initialized. Edit config/*.json, then run: npm run preflight"
