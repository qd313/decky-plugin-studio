<#
.SYNOPSIS
  Make this Windows PC a stand-in Deck (plan 10, Route A"): Decky Loader for
  Windows into this PC's Steam, and a registry entry DPS can drive.

.DESCRIPTION
  Does by script what the community "Decky Loader Installer.exe" does by
  click (its source: ACCESS-DENIIED/Decky-Loader-For-Windows, MainForm.cs):

    1. <Steam>\.cef-enable-remote-debugging   so Steam's CEF debugger answers on 127.0.0.1:8080
    2. %USERPROFILE%\homebrew\{services,plugins,settings,logs}
    3. PluginLoader.Win.zip from the project's latest release, unzipped into homebrew\services
    4. a Startup-folder shortcut so PluginLoader_noconsole.exe starts at logon
    5. PluginLoader_noconsole.exe started now
    6. machines.json entry: { kind: standin, os: windows, local: true, press: vigem }

  Nothing here touches the Steam account, signs in, or presses anything.
  Steam itself is NOT restarted by this script; CDP only answers after a Steam
  restart, and the script says so at the end. Plan 10 § 4 rules for this PC:
  Steam goes to offline mode for the duration of an automated run, and
  automation never launches a game here.

  Re-runnable. -ZipPath skips the download (e.g. E:\standins\PluginLoader.Win.zip).
#>
param(
  [string]$MachineName = "this-pc",
  [int]$PadPort = 7690,
  [string]$ZipPath = "",
  [switch]$NoStart,
  [switch]$SkipRegister
)
$ErrorActionPreference = "Stop"
$releaseApi = "https://api.github.com/repos/ACCESS-DENIIED/Decky-Loader-For-Windows/releases/latest"

function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }

# ---- 1. Steam path and the CEF debugging flag file --------------------------
Step "Steam"
$steamPath = $null
foreach ($key in @("HKLM:\SOFTWARE\WOW6432Node\Valve\Steam", "HKLM:\SOFTWARE\Valve\Steam")) {
  $v = (Get-ItemProperty $key -ErrorAction SilentlyContinue).InstallPath
  if ($v) { $steamPath = $v; break }
}
if (-not $steamPath) { $steamPath = (Get-ItemProperty "HKCU:\Software\Valve\Steam" -ErrorAction SilentlyContinue).SteamPath }
if (-not $steamPath) { $steamPath = Join-Path ${env:ProgramFiles(x86)} "Steam" }
$steamPath = $steamPath -replace "/", "\"
if (-not (Test-Path (Join-Path $steamPath "steam.exe"))) { throw "steam.exe not found under $steamPath" }
Write-Host "   Steam at $steamPath"

$cefFlag = Join-Path $steamPath ".cef-enable-remote-debugging"
$cefCreated = $false
if (Test-Path $cefFlag) {
  Write-Host "   .cef-enable-remote-debugging already present"
} else {
  try {
    New-Item -ItemType File -Path $cefFlag | Out-Null
    $cefCreated = $true
    Write-Host "   created $cefFlag"
  } catch {
    Write-Host "   could not create $cefFlag ($($_.Exception.Message))." -ForegroundColor Yellow
    Write-Host "   Run this once in an elevated PowerShell, then re-run this script:" -ForegroundColor Yellow
    Write-Host "       New-Item -ItemType File -Path '$cefFlag'" -ForegroundColor Yellow
  }
}

# ---- 2. homebrew layout --------------------------------------------------------
Step "homebrew folders"
$homebrew = Join-Path $env:USERPROFILE "homebrew"
$services = Join-Path $homebrew "services"
foreach ($d in @($homebrew, $services, (Join-Path $homebrew "plugins"), (Join-Path $homebrew "settings"), (Join-Path $homebrew "logs"))) {
  New-Item -ItemType Directory -Force $d | Out-Null
}
Write-Host "   $homebrew"

# ---- 3. PluginLoader binaries ----------------------------------------------------
Step "PluginLoader for Windows"
$loaderExe = Join-Path $services "PluginLoader_noconsole.exe"
if (-not $ZipPath) {
  $tmp = Join-Path $env:TEMP "PluginLoader.Win.zip"
  Write-Host "   asking GitHub for the latest release"
  $rel = Invoke-RestMethod -Uri $releaseApi -Headers @{ "User-Agent" = "decky-plugin-studio" }
  $asset = $rel.assets | Where-Object { $_.name -like "PluginLoader*.zip" } | Select-Object -First 1
  if (-not $asset) { throw "no PluginLoader zip in release $($rel.tag_name)" }
  Write-Host "   $($rel.tag_name): $($asset.name) ($([math]::Round($asset.size/1MB,1)) MB)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
  $ZipPath = $tmp
}
Write-Host "   extracting $ZipPath into $services"
# Stop a running loader first or the exe is locked.
Get-Process -Name PluginLoader, PluginLoader_noconsole -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Expand-Archive -Path $ZipPath -DestinationPath $services -Force
if (-not (Test-Path $loaderExe)) {
  # The zip may carry a folder; find the exe and move the contents up.
  $found = Get-ChildItem $services -Recurse -Filter "PluginLoader_noconsole.exe" | Select-Object -First 1
  if (-not $found) { throw "PluginLoader_noconsole.exe not found after extraction" }
  Get-ChildItem $found.DirectoryName | Move-Item -Destination $services -Force
}
Write-Host "   $loaderExe"

# ---- 4. autostart ----------------------------------------------------------------
Step "autostart"
$startup = [Environment]::GetFolderPath("Startup")
$lnk = Join-Path $startup "Decky Loader.lnk"
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($lnk)
$s.TargetPath = $loaderExe
$s.WorkingDirectory = $services
$s.Description = "Decky Loader Autostart"
$s.Save()
Write-Host "   $lnk"

# ---- 5. start it now -------------------------------------------------------------
if (-not $NoStart) {
  Step "starting PluginLoader"
  Start-Process -FilePath $loaderExe -WorkingDirectory $services -WindowStyle Hidden | Out-Null
  $deadline = (Get-Date).AddSeconds(15)
  $loaderUp = $false
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -Uri "http://127.0.0.1:1337/" -UseBasicParsing -TimeoutSec 2 | Out-Null; $loaderUp = $true; break }
    catch { if ($_.Exception.Response) { $loaderUp = $true; break } }
    Start-Sleep -Milliseconds 500
  }
  Write-Host ("   PluginLoader answers on 127.0.0.1:1337: {0}" -f $loaderUp)
}

# ---- 6. register the machine -----------------------------------------------------
if (-not $SkipRegister) {
  Step "machines.json"
  $cfgDir = Join-Path $env:USERPROFILE ".config\decky-plugin-studio"
  New-Item -ItemType Directory -Force $cfgDir | Out-Null
  $file = Join-Path $cfgDir "machines.json"
  $doc = @{ machines = @{} }
  if (Test-Path $file) {
    $raw = Get-Content $file -Raw | ConvertFrom-Json
    $doc = @{}
    foreach ($p in $raw.PSObject.Properties) { $doc[$p.Name] = $p.Value }
    if (-not $doc.machines) { $doc.machines = @{} }
    $m = @{}
    foreach ($p in $doc.machines.PSObject.Properties) { $m[$p.Name] = $p.Value }
    $doc.machines = $m
  }
  $doc.machines[$MachineName] = [ordered]@{
    kind = "standin"; os = "windows"; local = $true; press = "vigem"; padPort = $PadPort
    pluginsDir = (Join-Path $homebrew "plugins")
    note = "this PC: Steam Big Picture + Decky Loader for Windows (plan 10 Route A''). Steam OFFLINE during runs; no games."
  }
  # UTF-8 WITHOUT a byte-order mark: Windows PowerShell 5.1's -Encoding utf8 writes one, and
  # the server strips it, but other readers of this file (the extension, a human's editor) may not.
  [IO.File]::WriteAllText($file, (($doc | ConvertTo-Json -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "   $file -> machine '$MachineName'"
}

# ---- what is left -----------------------------------------------------------------
Step "next"
$cdpUp = $false
try { Invoke-WebRequest -Uri "http://127.0.0.1:8080/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null; $cdpUp = $true } catch {}
if ($cdpUp) {
  Write-Host "   Steam's CEF debugger answers on 127.0.0.1:8080."
} else {
  Write-Host "   Steam's CEF debugger is NOT answering yet. Restart Steam (fully: Steam > Exit, then start it)" -ForegroundColor Yellow
  Write-Host "   so it picks up .cef-enable-remote-debugging. No game may be running when you do." -ForegroundColor Yellow
}
Write-Host "   Before an automated run on this PC: Steam > Go Offline (plan 10 rule 1), open Big Picture."
Write-Host "   Virtual controller: scripts\standin\windows\start-vpad.ps1 -AtLogon"
Write-Host "   Then from DPS: deck_status { machine: '$MachineName' }, deck_readFocus { machine: '$MachineName' }."
