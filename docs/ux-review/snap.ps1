# Capture a Clippity window (by title) to a PNG in docs/ux-review/snapshots.
# Captures the composited screen cropped to the window rect, so the app's
# transparent / Mica chrome renders exactly as the user sees it.
#
# Usage:
#   .\snap.ps1 -Name screen-01-capture-default            # foreground window
#   .\snap.ps1 -Name screen-02-overlay -Title "Clippity Region Capture"
#   .\snap.ps1 -Name screen-03-full -FullScreen
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Title = "",
  [switch]$FullScreen,
  [int]$Pad = 0
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Snap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][Win32Snap]::SetProcessDPIAware()

$outDir = Join-Path $PSScriptRoot "snapshots"
New-Item -ItemType Directory -Force $outDir | Out-Null
$outFile = Join-Path $outDir ($Name + ".png")

$bounds = $null
if ($FullScreen) {
  $screen = [System.Windows.Forms.Screen]::PrimaryScreen
  Add-Type -AssemblyName System.Windows.Forms
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bounds = @{ X = $b.X; Y = $b.Y; W = $b.Width; H = $b.Height }
} else {
  $clippityPids = (Get-Process | Where-Object { $_.ProcessName -eq "clippity" }).Id
  $found = New-Object System.Collections.ArrayList
  $cb = [Win32Snap+EnumProc]{
    param($h, $l)
    if (-not [Win32Snap]::IsWindowVisible($h)) { return $true }
    $procId = 0
    [void][Win32Snap]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($clippityPids -notcontains [int]$procId) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [void][Win32Snap]::GetWindowText($h, $sb, 256)
    [void]$found.Add(@{ H = $h; T = $sb.ToString() })
    return $true
  }
  [void][Win32Snap]::EnumWindows($cb, [IntPtr]::Zero)

  $target = $null
  if ($Title -ne "") {
    $target = $found | Where-Object { $_.T -eq $Title } | Select-Object -First 1
  } else {
    $fg = [Win32Snap]::GetForegroundWindow()
    $target = $found | Where-Object { $_.H -eq $fg } | Select-Object -First 1
    if (-not $target) { $target = $found | Select-Object -First 1 }
  }
  if (-not $target) { Write-Error "No visible Clippity window found (title='$Title'). Visible: $(($found | ForEach-Object { $_.T }) -join ', ')"; exit 1 }

  $r = New-Object Win32Snap+RECT
  [void][Win32Snap]::GetWindowRect($target.H, [ref]$r)
  $bounds = @{ X = $r.L - $Pad; Y = $r.T - $Pad; W = ($r.R - $r.L) + 2 * $Pad; H = ($r.B - $r.T) + 2 * $Pad }
}

$bmp = New-Object System.Drawing.Bitmap($bounds.W, $bounds.H)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, (New-Object System.Drawing.Size($bounds.W, $bounds.H)))
$bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output "saved: $outFile ($($bounds.W)x$($bounds.H))"
