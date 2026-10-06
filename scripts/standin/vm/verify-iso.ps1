<#
.SYNOPSIS
  Check a Bazzite ISO against its published CHECKSUM file.

.EXAMPLE
  .\verify-iso.ps1 -Iso E:\standins\bazzite-deck-stable-amd64.iso
  (expects E:\standins\bazzite-deck-stable-amd64.iso-CHECKSUM beside it, the
  file download.bazzite.gg publishes; -Checksum overrides.)
#>
param(
  [Parameter(Mandatory = $true)][string]$Iso,
  [string]$Checksum = ""
)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Iso)) { throw "ISO not found: $Iso" }
if (-not $Checksum) { $Checksum = "$Iso-CHECKSUM" }
if (-not (Test-Path $Checksum)) { throw "checksum file not found: $Checksum (download it from the same page as the ISO)" }

$name = Split-Path $Iso -Leaf
$line = Get-Content $Checksum | Where-Object { $_ -match "SHA256 \($([regex]::Escape($name))\) = ([0-9a-f]{64})" -or $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($name))$" } | Select-Object -First 1
if (-not $line) { throw "no SHA256 line for $name in $Checksum" }
$expected = ([regex]::Match($line, "[0-9a-f]{64}")).Value
Write-Host "expected $expected"
Write-Host "hashing $Iso ($([math]::Round((Get-Item $Iso).Length/1GB,2)) GB) ..."
$actual = (Get-FileHash -Algorithm SHA256 $Iso).Hash.ToLower()
Write-Host "actual   $actual"
if ($actual -ne $expected) { Write-Host "MISMATCH -- do not install from this ISO" -ForegroundColor Red; exit 1 }
Write-Host "OK -- the ISO matches its published checksum" -ForegroundColor Green
