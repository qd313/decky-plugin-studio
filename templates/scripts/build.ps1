# Thin build wrapper — deploy via Decky Plugin Studio MCP (deck.deploy).
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm run build
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    npm run build
} else {
    Write-Error "pnpm or npm required."
    exit 1
}

Write-Host ""
Write-Host "Build complete. Deploy to Deck with Decky Plugin Studio MCP:"
Write-Host "  plugin.build  (validate + build)"
Write-Host "  deck.deploy   (build + deploy to configured Deck)"
