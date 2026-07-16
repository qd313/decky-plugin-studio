# setup-dev.ps1 — Decky Plugin Studio: SSH key + passwordless sudo for remote dev.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\PluginEnv.ps1")
Import-DeckyEnv -RepoRoot $RepoRoot

if ([string]::IsNullOrWhiteSpace($DECK_IP) -or [string]::IsNullOrWhiteSpace($DECK_USER)) {
    Write-Error ".env file not found or missing DECK_IP/DECK_USER. Copy .env.example to .env and fill in your values."
    exit 1
}

$HostIp = $DECK_IP
$User = $DECK_USER
$PluginName = Resolve-DeckyPluginName -RepoRoot $RepoRoot

Write-Host "=== Decky Plugin Studio — Dev Setup ===" -ForegroundColor Cyan

$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519"
if (!(Test-Path "$KeyPath.pub")) {
    Write-Host "Generating new passwordless SSH key..."
    ssh-keygen -t ed25519 -f $KeyPath -N '""'
}

Write-Host "Copying SSH key to Deck (enter Deck password when prompted)..."
$PubKey = (Get-Content "$KeyPath.pub" -Raw).Trim()
ssh "$User@$HostIp" "mkdir -p ~/.ssh && echo '$PubKey' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys"

Write-Host "Setting up passwordless sudo for deploy (dev-only; run revert-dev.ps1 when done)..."
$SudoersBlock = @(
    "Defaults:$User !authenticate",
    "$User ALL=(root) NOPASSWD: ALL"
) -join "`n"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($SudoersBlock))
ssh -t "$User@$HostIp" "printf '%s' '$b64' | base64 -d | tr -d '\r' > /tmp/decky_restart.new && sudo visudo -cf /tmp/decky_restart.new && sudo install -o root -g root -m 0440 /tmp/decky_restart.new /etc/sudoers.d/decky_restart && rm -f /tmp/decky_restart.new"

Write-Host "Taking ownership of the plugin folder..."
ssh -t "$User@$HostIp" "sudo mkdir -p ~/homebrew/plugins/$PluginName && sudo chown -R ${User}:${User} ~/homebrew/plugins/$PluginName"

Write-Host "=== Setup complete! Run .\scripts\build.ps1 to build and deploy. ===" -ForegroundColor Green
