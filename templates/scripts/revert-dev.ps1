# revert-dev.ps1 — Undo setup-dev.ps1 (remove sudoers + local SSH key from Deck).
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot "lib\PluginEnv.ps1")
Import-DeckyEnv -RepoRoot $RepoRoot

if ([string]::IsNullOrWhiteSpace($DECK_IP) -or [string]::IsNullOrWhiteSpace($DECK_USER)) {
    Write-Error ".env file not found or missing DECK_IP/DECK_USER."
    exit 1
}

$HostIp = $DECK_IP
$User = $DECK_USER

Write-Host "=== Decky Plugin Studio — Dev Reversal ===" -ForegroundColor Cyan

Write-Host "Revoking passwordless sudo (enter Deck password if prompted)..."
ssh -t "$User@$HostIp" "sudo rm -f /etc/sudoers.d/decky_restart"

$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519.pub"
if (!(Test-Path $KeyPath)) {
    $KeyPath = "$env:USERPROFILE\.ssh\id_rsa.pub"
}
if (Test-Path $KeyPath) {
    $PubKey = (Get-Content $KeyPath -Raw).Trim()
    Write-Host "Removing this SSH key from Deck authorized_keys..."
    $escaped = $PubKey -replace "'", "'\\''"
    ssh "$User@$HostIp" "touch ~/.ssh/authorized_keys 2>/dev/null; grep -Fv '$escaped' ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp 2>/dev/null && mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys || true"
} else {
    Write-Host "No local SSH public key found — skipped key removal."
}

Write-Host "=== Reversal complete. Deck is back to default SSH/sudo behavior. ===" -ForegroundColor Green
