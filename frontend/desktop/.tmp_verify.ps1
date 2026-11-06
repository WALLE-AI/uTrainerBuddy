Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct RECTV { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32v {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECTV lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[Win32v]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Id 5996 -ErrorAction SilentlyContinue
if (-not $proc) {
  $proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'AionUi-Dev' } | Select-Object -First 1
}
$hwnd = $proc.MainWindowHandle
[Win32v]::ShowWindow($hwnd, 9) | Out-Null

$fg = [Win32v]::GetForegroundWindow()
$dummy = [uint32]0
$fgThread = [Win32v]::GetWindowThreadProcessId($fg, [ref]$dummy)
$curThread = [Win32v]::GetCurrentThreadId()
[Win32v]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
[Win32v]::BringWindowToTop($hwnd) | Out-Null
[Win32v]::SetForegroundWindow($hwnd) | Out-Null
[Win32v]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null

Start-Sleep -Milliseconds 800

$rect = New-Object RECTV
[Win32v]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
$bmp.Save("F:\WALLE-AI\uFrontendUI\.tmp_verify.png")
Write-Output "saved pid=$($proc.Id) title=$($proc.MainWindowTitle)"
