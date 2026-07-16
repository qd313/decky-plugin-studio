# Watch dist/ and debounced-deploy to Steam Deck.
param(
    [switch]$Local
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$DebounceMs = 1500

if (!(Test-Path "$RepoRoot\.env")) {
    Write-Error ".env required (run .\scripts\setup-dev.ps1 first)."
}

function Invoke-Deploy {
    if ($Local) {
        & bash "$PSScriptRoot\build.sh" deploy --local
    } else {
        & "$PSScriptRoot\build.ps1"
    }
}

function Schedule-Deploy {
    if ($script:DeployTimer) {
        try { $script:DeployTimer.Dispose() } catch {}
    }
    $script:DeployTimer = [System.Threading.Timer]::new({
        Write-Host "Deploying after dist change..." -ForegroundColor Green
        try { Invoke-Deploy } catch { Write-Host $_ -ForegroundColor Red }
    }, $null, $DebounceMs, [System.Threading.Timeout]::Infinite)
}

Write-Host "Decky watch-deploy (debounce ${DebounceMs}ms)" -ForegroundColor Cyan
if ($Local) {
    Write-Host "  deploy target: local (build.sh deploy --local)" -ForegroundColor Cyan
} else {
    Write-Host "  deploy target: remote Deck (.env)" -ForegroundColor Cyan
}

if (!(Test-Path "$RepoRoot\dist\index.js")) {
    Write-Host "No dist/index.js — running one-shot build..." -ForegroundColor Cyan
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm run build } else { npm run build }
    Invoke-Deploy
}

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = Join-Path $RepoRoot "dist"
$watcher.IncludeSubdirectories = $true
$watcher.EnableRaisingEvents = $true
$watcher.Filter = "*.*"

Register-ObjectEvent -InputObject $watcher -EventName Changed -Action { Schedule-Deploy } | Out-Null
Register-ObjectEvent -InputObject $watcher -EventName Created -Action { Schedule-Deploy } | Out-Null

try {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { pnpm run watch } else { npm run watch }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
    if ($script:DeployTimer) { $script:DeployTimer.Dispose() }
}
