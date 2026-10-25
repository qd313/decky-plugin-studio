# Un-minimize the Steam Big Picture window (deck_focusBigPicture, Windows stand-in).
# Steam's own SteamClient.Window.ShowWindow / BringToFront do not restore a minimized window
# (measured 2026-10-25 on the maintainer's PC); one Win32 ShowWindow(SW_RESTORE) does, and
# a background process is allowed to call it. Nothing else is touched: focus is taken
# afterwards by Steam itself, over CDP.
# Usage: powershell -NoProfile -File restore-window.ps1
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int cmd); [DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);'
$p = Get-Process | Where-Object { $_.MainWindowTitle -like 'Steam Big Picture*' } | Select-Object -First 1
if (-not $p) { Write-Error 'no window titled "Steam Big Picture*" found'; exit 2 }
$h = $p.MainWindowHandle
if (-not [W.U]::IsIconic($h)) { Write-Output 'not minimized; nothing to restore'; exit 0 }
[void][W.U]::ShowWindow($h, 9)   # SW_RESTORE
Start-Sleep -Milliseconds 300
if ([W.U]::IsIconic($h)) { Write-Error 'ShowWindow(SW_RESTORE) returned but the window is still minimized'; exit 3 }
Write-Output 'restored'
