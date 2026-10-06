<#
.SYNOPSIS
  Install VirtualBox on this Windows PC for the stand-in VMs (plan 10, lane L3), and
  check the two things that make it slow or impossible.

.DESCRIPTION
  1. Virtualization in firmware (VT-x): VirtualBox cannot run 64-bit guests without it.
  2. Windows' own hypervisor: when Memory Integrity (Core isolation) or Hyper-V is on,
     VirtualBox falls back to a slow compatibility engine (the "green turtle"). Measured
     on this PC 2026-10-05: Windows switched Memory Integrity ON by itself the moment
     VT-x became available. Turning it off is a Windows Security toggle plus a reboot,
     and it is the user's call -- this script only reports it.
  3. winget install Oracle.VirtualBox. Needs one admin (UAC) approval.

  Re-runnable.
#>
param([switch]$SkipInstall)
$ErrorActionPreference = "Stop"

function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }

Step "firmware virtualization"
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$hv = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
# When Windows' own hypervisor is running, Windows reports VirtualizationFirmwareEnabled
# as False even though it is on (the hypervisor owns VT-x). HypervisorPresent = True is
# itself proof the firmware setting is on.
$vtx = $cpu.VirtualizationFirmwareEnabled -or $hv
Write-Host ("   VT-x available: {0}  (HypervisorPresent={1})" -f $vtx, $hv)
if (-not $vtx) {
  Write-Host "   Virtualization is OFF in the BIOS. docs/planning/10-stand-in-decks.md section 7 has the ASUS menu path." -ForegroundColor Red
  exit 2
}

Step "Windows hypervisor / Memory Integrity"
$dg = Get-CimInstance -Namespace root\Microsoft\Windows\DeviceGuard -ClassName Win32_DeviceGuard -ErrorAction SilentlyContinue
$hvci = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity" -ErrorAction SilentlyContinue).Enabled
$vbsRunning = $dg -and $dg.VirtualizationBasedSecurityStatus -eq 2
$hyperv = (Get-Service -Name vmcompute -ErrorAction SilentlyContinue) -and (Get-Service -Name vmcompute).Status -eq "Running"
Write-Host ("   Virtualization-based security running: {0}; Memory Integrity (HVCI) enabled: {1}; Hyper-V services: {2}" -f $vbsRunning, ($hvci -eq 1), [bool]$hyperv)
if ($hv) {
  Write-Host "   A hypervisor is already running under Windows. VirtualBox will work but in its SLOW mode." -ForegroundColor Yellow
  Write-Host "   To give VirtualBox VT-x directly (user's call, needs a reboot):" -ForegroundColor Yellow
  Write-Host "     Windows Security > Device security > Core isolation details > Memory integrity: Off" -ForegroundColor Yellow
  Write-Host "     then, in an elevated prompt:  bcdedit /set hypervisorlaunchtype off   and reboot." -ForegroundColor Yellow
  Write-Host "     (Windows may re-enable Memory Integrity after a feature update; re-run this script to check.)" -ForegroundColor Yellow
} else {
  Write-Host "   No hypervisor under Windows: VirtualBox gets VT-x directly." -ForegroundColor Green
}

Step "VirtualBox"
$vbox = Get-Command VBoxManage -ErrorAction SilentlyContinue
if (-not $vbox) {
  $candidate = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
  if (Test-Path $candidate) { $vbox = Get-Item $candidate }
}
if ($vbox) {
  Write-Host ("   installed: {0}" -f (& $vbox.Source --version))
} elseif ($SkipInstall) {
  Write-Host "   not installed (skipped)"
} else {
  Write-Host "   installing with winget (expect ONE admin approval prompt) ..."
  winget install --id Oracle.VirtualBox --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
  if ($LASTEXITCODE -ne 0) { throw "winget install exited $LASTEXITCODE" }
  $candidate = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
  if (Test-Path $candidate) { Write-Host ("   installed: {0}" -f (& $candidate --version)) }
  Write-Host "   Open a NEW terminal for VBoxManage to be on PATH, or use $candidate."
}
