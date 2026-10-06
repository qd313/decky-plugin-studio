<#
.SYNOPSIS
  Start the DPS virtual gamepad on this Windows PC (plan 10, Route A": this PC as a stand-in Deck).

.DESCRIPTION
  Runs bridge/tools/vpad.py as a hidden background process serving a ViGEmBus
  Xbox 360 pad on 127.0.0.1:<Port>. Steam sees a controller; DPS presses it
  over that port with no python spawned per press.

  Needs: the ViGEmBus driver (service "ViGEmBus" running; install once with
  `winget install ViGEm.ViGEmBus`) and `python -m pip install --user vgamepad`.

  -AtLogon also drops a shortcut in the Startup folder so the pad exists
  before Steam starts after a reboot.

  Stop it with: python bridge\tools\vpad.py release ; Stop-Process -Name pythonw
  (or just press the Deck killswitch in VS Code, which releases it, then kill the process).
#>
param(
  [int]$Port = 7690,
  [switch]$AtLogon
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$vpad = Join-Path $repo "bridge\tools\vpad.py"
if (-not (Test-Path $vpad)) { throw "vpad.py not found at $vpad" }

$svc = Get-Service -Name ViGEmBus -ErrorAction SilentlyContinue
if (-not $svc) {
  Write-Host "ViGEmBus driver is NOT installed. Install it once (needs admin approval):" -ForegroundColor Yellow
  Write-Host "    winget install --id ViGEm.ViGEmBus --accept-package-agreements --accept-source-agreements"
  exit 2
}
if ($svc.Status -ne "Running") { Write-Host "ViGEmBus service is $($svc.Status); starting it" ; Start-Service ViGEmBus }

python -c "import vgamepad" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host "the vgamepad package is missing; installing for this user" -ForegroundColor Yellow
  python -m pip install --user --timeout 30 vgamepad
  if ($LASTEXITCODE -ne 0) { throw "pip install vgamepad failed" }
}

function Test-PadUp {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.Connect("127.0.0.1", $Port)
    $c.Close()
    return $true
  } catch { return $false }
}

if (Test-PadUp) {
  Write-Host "a vpad daemon already answers on 127.0.0.1:$Port"
} else {
  $pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
  if (-not $pyw) { $pyw = (Get-Command python).Source }
  $logDir = Join-Path $env:LOCALAPPDATA "decky-plugin-studio"
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $log = Join-Path $logDir "vpad.log"
  Start-Process -FilePath $pyw -ArgumentList "`"$vpad`"", "serve", "--backend", "vigem", "--bind", "127.0.0.1", "--port", $Port `
    -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" | Out-Null
  $deadline = (Get-Date).AddSeconds(8)
  while (-not (Test-PadUp) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-PadUp)) {
    Write-Host "vpad did not come up on port $Port. Log:" -ForegroundColor Red
    Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | Select-Object -Last 20
    exit 1
  }
  Write-Host "vpad started (log: $log)"
}

python $vpad status --port $Port

if ($AtLogon) {
  $startup = [Environment]::GetFolderPath("Startup")
  $lnk = Join-Path $startup "DPS virtual pad.lnk"
  $pyw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
  if (-not $pyw) { $pyw = (Get-Command python).Source }
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $pyw
  $s.Arguments = "`"$vpad`" serve --backend vigem --bind 127.0.0.1 --port $Port"
  $s.WorkingDirectory = (Split-Path $vpad)
  $s.Description = "Decky Plugin Studio virtual gamepad"
  $s.Save()
  Write-Host "will start at logon: $lnk"
}
