# Record Deck screen (requires DECK_IP in .env)
# Open QAM + your plugin on the Deck before recording.
param(
    [int]$Seconds = 15,
    [ValidateSet('auto', 'game', 'desktop')]
    [string]$Mode = 'auto'
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Recordings = Join-Path $RepoRoot "recordings"
New-Item -ItemType Directory -Force -Path $Recordings | Out-Null
Write-Host "Use MCP deck.record or deck.deploy + on-device ffmpeg."
Write-Host "Clips target: $Recordings\DeckRecord_*.mkv"
Write-Host "Seconds: $Seconds Mode: $Mode"
