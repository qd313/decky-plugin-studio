# build.ps1 — Decky Plugin Studio: build + one-click deploy to Steam Deck.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot
. (Join-Path $PSScriptRoot "lib\PluginEnv.ps1")
Import-DeckyEnv -RepoRoot $RepoRoot

if ([string]::IsNullOrWhiteSpace($DECK_IP) -or [string]::IsNullOrWhiteSpace($DECK_USER)) {
    Write-Error ".env file not found. Copy .env.example to .env and run .\scripts\setup-dev.ps1 first."
    exit 1
}

$HostIp = $DECK_IP
$User = $DECK_USER
$PluginName = Resolve-DeckyPluginName -RepoRoot $RepoRoot
$sources = Get-DeckyDeploySources -RepoRoot $RepoRoot

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    pnpm install
    pnpm run build
} elseif (Get-Command npm -ErrorAction SilentlyContinue) {
    npm install
    npm run build
} else {
    Write-Error "pnpm or npm required."
    exit 1
}

if (!(Test-Path "dist\index.js")) {
    Write-Error "Build failed — dist/index.js not found."
    exit 1
}

Write-Host "Uploading to temporary Deck directory..." -ForegroundColor Cyan
$TempName = "decky_temp_$PluginName"
ssh "$User@$HostIp" "mkdir -p ~/$TempName"

foreach ($entry in $sources) {
    $localPath = Join-Path $RepoRoot $entry
    if (Test-Path $localPath -PathType Container) {
        ssh "$User@$HostIp" "mkdir -p ~/$TempName/$entry"
        scp -r $localPath "${User}@${HostIp}:~/$TempName/$entry"
    } else {
        scp $localPath "${User}@${HostIp}:~/$TempName/$entry"
    }
}

Write-Host "Overwriting plugin files and restarting plugin_loader..." -ForegroundColor Cyan
$PluginHomePath = "/home/$User/homebrew/plugins/$PluginName"
$RemoteCommand = @(
    "sudo -n systemctl stop plugin_loader.service 2>/dev/null || sudo systemctl stop plugin_loader.service",
    "sudo -n mkdir -p $PluginHomePath",
    "sudo -n chown -R ${User}:${User} $PluginHomePath",
    "cp -rf ~/$TempName/* ~/homebrew/plugins/$PluginName/",
    "rm -rf ~/$TempName",
    "sudo -n systemctl start plugin_loader.service 2>/dev/null || sudo systemctl start plugin_loader.service"
) -join " && "

ssh "$User@$HostIp" $RemoteCommand
Write-Host "Deployment complete! Reload your plugin in QAM if needed." -ForegroundColor Green
