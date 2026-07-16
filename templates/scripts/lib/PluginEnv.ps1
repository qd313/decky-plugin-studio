# Shared .env + plugin name resolution for Decky Plugin Studio PowerShell scripts.

function Get-DeckyRepoRoot {
    param([string]$ScriptsDir = $PSScriptRoot)
    if ($env:DECKY_STUDIO_WORKSPACE) { return $env:DECKY_STUDIO_WORKSPACE }
    return (Split-Path -Parent (Split-Path -Parent $ScriptsDir))
}

function Import-DeckyEnv {
    param([string]$RepoRoot)
    if (Test-Path "$RepoRoot\.env") {
        Get-Content "$RepoRoot\.env" | ForEach-Object {
            if ($_ -match '^\s*([^#]\S+?)\s*=\s*(.+)$') {
                Set-Variable -Scope Script -Name $matches[1] -Value $matches[2].Trim() -Force
            }
        }
    }
    if (-not $script:DECK_PORT) { $script:DECK_PORT = 22 }
    if (-not $script:DECK_USER) { $script:DECK_USER = 'deck' }
    if (-not $script:DECK_DIR) { $script:DECK_DIR = '/home/deck' }
}

function Get-DeckyPluginNameSlug {
    param([string]$Raw)
    return ($Raw.ToLowerInvariant() -replace '\s+', '-')
}

function Resolve-DeckyPluginName {
    param([string]$RepoRoot)
    if ($script:PLUGIN_NAME) { return $script:PLUGIN_NAME }
    $pluginJson = Join-Path $RepoRoot 'plugin.json'
    if (!(Test-Path $pluginJson)) {
        throw 'plugin.json not found and PLUGIN_NAME not set in .env'
    }
    $json = Get-Content $pluginJson -Raw | ConvertFrom-Json
    $name = if ($json.name) { [string]$json.name } else { Split-Path -Leaf $RepoRoot }
    return (Get-DeckyPluginNameSlug $name)
}

function Get-DeckyDeploySources {
    param([string]$RepoRoot)
    $entries = @('dist', 'main.py', 'plugin.json', 'package.json', 'assets', 'py_modules', 'defaults', 'bin', 'locales')
    $sources = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $entries) {
        if (Test-Path (Join-Path $RepoRoot $entry)) {
            $sources.Add($entry)
        }
    }
    $skip = @{ 'main.py' = $true; 'setup.py' = $true; 'conftest.py' = $true }
    Get-ChildItem -Path $RepoRoot -Filter '*.py' -File | ForEach-Object {
        if (-not $skip.ContainsKey($_.Name)) {
            $sources.Add($_.Name)
        }
    }
    return $sources
}
