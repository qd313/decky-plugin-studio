<#
.SYNOPSIS
  Take, restore or list VirtualBox snapshots of a stand-in VM; or clone one.

.EXAMPLE
  .\snapshot.ps1 -Name standin-1 -Take clean          # after provisioning and the Steam sign-in
  .\snapshot.ps1 -Name standin-1 -Restore clean       # back to the clean state (VM is powered off first)
  .\snapshot.ps1 -Name standin-1 -List
  .\snapshot.ps1 -Name standin-1 -CloneTo standin-2   # a second VM from the clean snapshot (then sign it in, honest host name)
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Take = "",
  [string]$Restore = "",
  [switch]$List,
  [string]$CloneTo = ""
)
$ErrorActionPreference = "Stop"
$vbm = (Get-Command VBoxManage -ErrorAction SilentlyContinue).Source
if (-not $vbm) { $vbm = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe" }
if (-not (Test-Path $vbm)) { throw "VBoxManage not found" }

function Running { (& $vbm showvminfo $Name --machinereadable | Select-String '^VMState="running"') -ne $null }

if ($List) { & $vbm snapshot $Name list --details; exit 0 }
if ($Take) {
  & $vbm snapshot $Name take $Take --description "decky-plugin-studio stand-in snapshot $(Get-Date -Format s)" --live
  Write-Host "snapshot '$Take' taken"
}
if ($Restore) {
  if (Running) { & $vbm controlvm $Name poweroff; Start-Sleep -Seconds 2 }
  & $vbm snapshot $Name restore $Restore
  Write-Host "restored '$Restore'; start with: VBoxManage startvm $Name --type gui"
}
if ($CloneTo) {
  if (Running) { throw "power the VM off before cloning" }
  & $vbm clonevm $Name --name $CloneTo --register --mode machine --options keepdisknames=false
  $n = [regex]::Match($CloneTo, "(\d+)$").Groups[1].Value
  $port = 2200 + $(if ($n) { [int]$n } else { 9 })
  & $vbm modifyvm $CloneTo --nat-pf1 delete ssh
  & $vbm modifyvm $CloneTo --nat-pf1 "ssh,tcp,127.0.0.1,$port,,22"
  Write-Host "cloned to '$CloneTo' (SSH forward 127.0.0.1:$port). Now: create-vm.ps1 -Name $CloneTo -NoStart to write its ssh alias and registry entry"
  Write-Host "(it will see the VM exists and only add the alias and the entry), then in the guest: hostnamectl set-hostname $CloneTo, and a fresh Steam sign-in."
}
