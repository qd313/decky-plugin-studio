<#
.SYNOPSIS
  Create one stand-in Deck VM in VirtualBox from the Bazzite deck ISO (plan 10, lane L3).

.DESCRIPTION
  EFI, 4 vCPU, 6 GB, 60 GB disk, 1280x800-capable VMSVGA with 3D on, NAT with a
  port forward for SSH (host 127.0.0.1:<SshPort> -> guest 22). Writes a ~/.ssh/config
  Host alias named after the VM so every `ssh deck@<name>` in DPS reaches it, and
  registers the machine in machines.json (kind standin, os bazzite, press uinput).

  The Bazzite installer itself is clicked through once by a person (plan 10 § 5,
  "what stays manual"): the VM is started with the ISO attached; install to the
  virtual disk with the user name below, then in the guest's desktop terminal run
  `ujust toggle-ssh` (and `ujust setup-decky`). Then: .\provision.ps1 -Name standin-1

  Host names are honest on purpose (standin-1, ...): Steam lists them in the account's
  device list and they can be removed when retired (plan 10 § 4).
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,          # standin-1
  [string]$Iso = "E:\standins\bazzite-deck-stable-amd64.iso",
  [string]$VmDir = "E:\standins\vms",
  [int]$Cpus = 4,
  [int]$MemoryMB = 6144,
  [int]$DiskGB = 60,
  [int]$SshPort = 0,                                     # default: 2200 + number in the name
  [string]$User = "deck",
  [switch]$NoStart
)
$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }

$vbm = (Get-Command VBoxManage -ErrorAction SilentlyContinue).Source
if (-not $vbm) { $vbm = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe" }
if (-not (Test-Path $vbm)) { throw "VBoxManage not found; run install-virtualbox.ps1 first" }
if (-not (Test-Path $Iso)) { throw "ISO not found: $Iso (verify-iso.ps1 checks it)" }
if ($SshPort -eq 0) {
  $n = [regex]::Match($Name, "(\d+)$").Groups[1].Value
  $SshPort = 2200 + $(if ($n) { [int]$n } else { 1 })
}

Step "VM $Name"
$existing = & $vbm list vms | Select-String -Pattern "^`"$([regex]::Escape($Name))`""
if ($existing) {
  Write-Host "   already exists; leaving it alone"
} else {
  New-Item -ItemType Directory -Force $VmDir | Out-Null
  & $vbm createvm --name $Name --ostype Fedora_64 --register --basefolder $VmDir | Out-Null
  & $vbm modifyvm $Name --firmware efi --cpus $Cpus --memory $MemoryMB --vram 128 `
      --graphicscontroller vmsvga --accelerate-3d on --audio-driver none --usb-xhci on `
      --nic1 nat --nat-pf1 "ssh,tcp,127.0.0.1,$SshPort,,22" --clipboard-mode disabled --drag-and-drop disabled `
      --boot1 dvd --boot2 disk --boot3 none --boot4 none
  $disk = Join-Path (Join-Path $VmDir $Name) "$Name.vdi"
  & $vbm createmedium disk --filename $disk --size ($DiskGB * 1024) --format VDI | Out-Null
  & $vbm storagectl $Name --name "NVMe" --add pcie --controller NVMe --bootable on
  & $vbm storageattach $Name --storagectl "NVMe" --port 0 --device 0 --type hdd --medium $disk
  & $vbm storagectl $Name --name "SATA" --add sata --controller IntelAhci --portcount 1
  & $vbm storageattach $Name --storagectl "SATA" --port 0 --device 0 --type dvddrive --medium $Iso
  Write-Host "   created: $Cpus vCPU, $MemoryMB MB, $DiskGB GB at $disk, SSH on 127.0.0.1:$SshPort"
}

Step "~/.ssh/config alias"
$sshDir = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force $sshDir | Out-Null
$cfg = Join-Path $sshDir "config"
$block = @"

# decky-plugin-studio stand-in (scripts/standin/vm/create-vm.ps1)
Host $Name
  HostName 127.0.0.1
  Port $SshPort
  User $User
  StrictHostKeyChecking accept-new
  UserKnownHostsFile ~/.ssh/known_hosts_standins
"@
$current = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { "" }
if ($current -match "(?m)^Host $([regex]::Escape($Name))\s*$") {
  Write-Host "   Host $Name already in $cfg"
} else {
  Add-Content -Path $cfg -Value $block -Encoding ascii
  Write-Host "   added Host $Name -> 127.0.0.1:$SshPort to $cfg"
}

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
$doc.machines[$Name] = [ordered]@{
  kind = "standin"; os = "bazzite"; local = $false; host = $Name; user = $User; press = "uinput"; padPort = 7690
  vm = [ordered]@{ hypervisor = "virtualbox"; name = $Name }
  note = "VirtualBox stand-in from $(Split-Path $Iso -Leaf); SSH via ~/.ssh/config alias (127.0.0.1:$SshPort). Steam OFFLINE; no games."
}
# UTF-8 without a byte-order mark (Windows PowerShell 5.1's -Encoding utf8 writes one).
[IO.File]::WriteAllText($file, (($doc | ConvertTo-Json -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding $false))
Write-Host "   machine '$Name' registered"

if (-not $NoStart) {
  Step "starting the VM with the installer attached"
  & $vbm startvm $Name --type gui | Out-Null
  Write-Host "   A window opened. Install Bazzite to the virtual disk (user '$User', host name '$Name')."
  Write-Host "   After the first boot into the desktop: open a terminal and run  ujust toggle-ssh"
  Write-Host "   then from here:  .\provision.ps1 -Name $Name"
}
