<#
.SYNOPSIS
  Measure a running stand-in VM (plan 10, lane L3): guest memory, CDP round trip,
  and a D-pad press-to-focus-change latency through the virtual pad.

.DESCRIPTION
  Numbers plan 67 § 4 asked for, measured rather than estimated. Needs the VM up,
  Steam running in it with CDP on, and the DPS MCP server built (uses its machine
  context through a tiny Node script). Read-only except for the presses, which are
  N DOWN presses followed by N UP presses so the ring ends where it started.
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Presses = 5
)
$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$vbm = (Get-Command VBoxManage -ErrorAction SilentlyContinue).Source
if (-not $vbm) { $vbm = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe" }

Write-Host "== VM memory (VirtualBox metrics)" -ForegroundColor Cyan
if (Test-Path $vbm) {
  & $vbm metrics setup --period 1 --samples 1 $Name "Guest/RAM/Usage/*,CPU/Load/User" | Out-Null
  Start-Sleep -Seconds 2
  & $vbm metrics query $Name "Guest/RAM/Usage/Total,Guest/RAM/Usage/Free,CPU/Load/User"
} else { Write-Host "   VBoxManage not found; skipped" }

Write-Host "== guest view (ssh)" -ForegroundColor Cyan
ssh -o BatchMode=yes $Name 'free -m | head -2; echo; ps -o rss=,comm= -C steam,steamwebhelper,gamescope,PluginLoader 2>/dev/null | sort -rn | head -8'

Write-Host "== CDP round trip and press latency (through the DPS server's own code)" -ForegroundColor Cyan
$node = @"
import { resolveMachine, runWithMachine } from '$($repo -replace '\\','/')/mcp-server/dist/machines.js';
import { openCdpTunnel } from '$($repo -replace '\\','/')/mcp-server/dist/deck/cdpTunnel.js';
import { readFocusAt } from '$($repo -replace '\\','/')/mcp-server/dist/deck/readFocus.js';
import { pressButton } from '$($repo -replace '\\','/')/mcp-server/dist/deck/pressButton.js';
import { focusKey } from '$($repo -replace '\\','/')/mcp-server/dist/deck/focusKey.js';
const m = resolveMachine('$Name');
await runWithMachine(m, async () => {
  const t = await openCdpTunnel();
  const rt = [];
  for (let i = 0; i < 5; i++) { const s = Date.now(); await readFocusAt(t.base, 10000); rt.push(Date.now() - s); }
  console.log('readFocus round trips ms:', rt.join(' '));
  const lat = [];
  for (const dir of [...Array($Presses).fill('DOWN'), ...Array($Presses).fill('UP')]) {
    const before = await readFocusAt(t.base, 10000);
    const s = Date.now();
    const p = await pressButton({ buttons: [dir] });
    if (!p.ok) { console.log('press refused:', p.reason); break; }
    let after = before;
    while (Date.now() - s < 3000) { after = await readFocusAt(t.base, 10000); if (focusKey(after) !== focusKey(before)) break; await new Promise(r => setTimeout(r, 40)); }
    lat.push(focusKey(after) !== focusKey(before) ? Date.now() - s : -1);
  }
  console.log('press -> focus change ms (-1 = no change within 3 s):', lat.join(' '));
});
"@
$tmp = Join-Path $env:TEMP "dps-measure-$Name.mjs"
Set-Content -Path $tmp -Value $node -Encoding utf8
node $tmp
