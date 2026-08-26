# Compile + flash one sketch folder to the board.
#   .\flash.ps1 02_gamepad_usb            # compile and upload
#   .\flash.ps1 02_gamepad_usb -NoUpload  # compile only
param(
  [Parameter(Mandatory = $true)][string]$Sketch,
  [string]$Port = "COM7",
  [switch]$NoUpload
)
$ErrorActionPreference = "Stop"
$cli = "C:\Users\still\tools\arduino-cli\arduino-cli.exe"

# USBMode=default  -> USB-OTG (TinyUSB). Required for HID; without it the
#                     native port is a debug console and cannot be a gamepad.
# CDCOnBoot=default-> USB CDC On Boot DISABLED, so Serial goes out the CH343
#                     "COM" port and leaves the native port free.
# PSRAM=disabled   -> not needed for a gamepad; one less thing to misconfigure.
$fqbn = "esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=default,FlashSize=16M,FlashMode=qio,PSRAM=disabled,PartitionScheme=app3M_fat9M_16MB"

$fw = Join-Path (Split-Path $PSScriptRoot -Parent) "firmware"
$dir = Join-Path $fw $Sketch
if (-not (Test-Path $dir)) { $dir = Join-Path (Join-Path $fw "spikes") $Sketch }
if (-not (Test-Path $dir)) { throw "no such sketch folder: $Sketch (looked in $fw and $fw\spikes)" }

& $cli compile --fqbn $fqbn $dir
if ($LASTEXITCODE -ne 0) { throw "compile failed" }
if ($NoUpload) { return }

& $cli upload -p $Port --fqbn $fqbn $dir
if ($LASTEXITCODE -ne 0) { throw "upload failed" }
Write-Host "flashed $Sketch to $Port" -ForegroundColor Green
