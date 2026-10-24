# Grab the Steam Big Picture window's rectangle to a PNG (stand-in fallback when CDP capture fails).
# Usage: powershell -NoProfile -File grab-window.ps1 -Out <path.png>
param([Parameter(Mandatory = $true)][string]$Out)
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r); [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }'
$p = Get-Process | Where-Object { $_.MainWindowTitle -like 'Steam Big Picture*' } | Select-Object -First 1
if (-not $p) { Write-Error 'no window titled "Steam Big Picture*" found'; exit 2 }
$r = New-Object W.U+RECT
[void][W.U]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.R - $r.L; $h = $r.B - $r.T
if ($w -le 0 -or $h -le 0) { Write-Error "window rect is empty ($w x $h); is it minimised?"; exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $h
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
