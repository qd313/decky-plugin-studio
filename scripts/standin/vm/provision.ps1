<#
.SYNOPSIS
  Provision a freshly installed stand-in VM over SSH (plan 10, lane L3).

.DESCRIPTION
  Prerequisites, done by a person once: Bazzite installed in the VM, a desktop
  login as the user, `ujust toggle-ssh` run in the guest. Then this does the rest:

    1. copies this PC's SSH public key in (one password prompt, the last one)
    2. ujust setup-decky (Decky Loader), if ~/homebrew is missing
    3. .cef-enable-remote-debugging in the guest's Steam folder
    4. the DPS virtual gamepad as a user service (guest/install-vpad.sh)
    5. the guest's Ollama endpoint pointed at this PC (an env file bonsAI's backend can read)
    6. a status report: os-release, loader, uinput, vpad, CDP

  After it: deck_deploy { machine: "<Name>" } from DPS, then the Phase 0 walk.
  The guest's Steam sign-in and Steam Guard approval stay in the user's hands (plan 10 § 4).
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$OllamaHost = "10.0.2.2",   # VirtualBox NAT: the host as seen from the guest
  [int]$OllamaPort = 11434
)
$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "== $msg" -ForegroundColor Cyan }
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$guestDir = Join-Path $repo "scripts\standin\guest"
$vpad = Join-Path $repo "bridge\tools\vpad.py"

Step "SSH key"
$pub = Get-ChildItem (Join-Path $env:USERPROFILE ".ssh") -Filter "id_*.pub" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pub) { throw "no SSH public key in ~/.ssh; create one with: ssh-keygen -t ed25519" }
$key = (Get-Content $pub.FullName -Raw).Trim()
# ssh-copy-id is not on Windows; do what it does.
ssh $Name "mkdir -p ~/.ssh && chmod 700 ~/.ssh && grep -qxF '$key' ~/.ssh/authorized_keys 2>/dev/null || echo '$key' >> ~/.ssh/authorized_keys; chmod 600 ~/.ssh/authorized_keys"
if ($LASTEXITCODE -ne 0) { throw "could not reach $Name over ssh (is the VM up, and was ujust toggle-ssh run?)" }
ssh -o BatchMode=yes $Name "echo key-auth-ok"
if ($LASTEXITCODE -ne 0) { throw "key-based ssh to $Name still fails" }

Step "Decky Loader"
ssh -o BatchMode=yes $Name 'test -d ~/homebrew && echo present || (echo installing; ujust setup-decky)'

Step "CEF remote debugging flag"
ssh -o BatchMode=yes $Name 'd=~/.steam/steam; [ -d "$d" ] || d=~/.local/share/Steam; touch "$d/.cef-enable-remote-debugging" && echo "created in $d"'

Step "virtual gamepad"
scp -q $vpad (Join-Path $guestDir "install-vpad.sh") (Join-Path $guestDir "dps-vpad.service") "${Name}:/tmp/"
ssh -o BatchMode=yes $Name 'bash /tmp/install-vpad.sh /tmp/vpad.py'

Step "Ollama on the host"
ssh -o BatchMode=yes $Name "mkdir -p ~/.config/environment.d && printf 'OLLAMA_HOST=http://${OllamaHost}:${OllamaPort}\n' > ~/.config/environment.d/50-dps-ollama.conf && echo written ~/.config/environment.d/50-dps-ollama.conf"
ssh -o BatchMode=yes $Name "curl -s -m 3 http://${OllamaHost}:${OllamaPort}/api/tags >/dev/null && echo 'host Ollama reachable from the guest' || echo 'host Ollama NOT reachable from the guest (is OLLAMA_HOST=0.0.0.0 and the firewall open?)'"

Step "report"
ssh -o BatchMode=yes $Name 'echo "--- os"; grep -E "^(ID|VERSION_ID|VARIANT_ID)=" /etc/os-release; echo "--- plugin_loader"; systemctl is-active plugin_loader.service 2>/dev/null || echo inactive; echo "--- uinput"; ls -l /dev/uinput 2>&1; echo "--- vpad"; systemctl --user is-active dps-vpad.service; echo "--- cdp"; curl -s -m 2 http://127.0.0.1:8080/json/version || echo "CDP not answering (Steam not running, or not restarted since the flag file)"'

Write-Host ""
Write-Host "Next: sign the guest's Steam in yourself (Steam Guard on the phone), set it OFFLINE, then from DPS:"
Write-Host "  deck_status { machine: '$Name' }   deck_deploy { machine: '$Name' }   deck_readFocus { machine: '$Name' }"
