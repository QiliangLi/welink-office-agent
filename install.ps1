$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
node scripts/agent.mjs init
Write-Host "Initialized. Edit config/*.json, then run: npm run preflight"
