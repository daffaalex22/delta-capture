# Generates the DeltaCapture extension icons (camera glyph on a navy rounded square).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\make-icons.ps1

Add-Type -AssemblyName System.Drawing

function New-Icon {
  param(
    [int]$size,
    [string]$path
  )

  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  try {
    $navy  = [System.Drawing.Color]::FromArgb(255, 30, 62, 96)
    $white = [System.Drawing.Color]::White

    # ---- rounded-square background -------------------------------------
    $bg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [Math]::Max(3.0, [float]($size * 0.20))
    $bg.AddArc(0, 0, $r, $r, 180, 90)
    $bg.AddArc($size - $r, 0, $r, $r, 270, 90)
    $bg.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
    $bg.AddArc(0, $size - $r, $r, $r, 90, 90)
    $bg.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush $navy), $bg)

    # ---- viewfinder bump (drawn first; body overlaps its bottom) -------
    $whiteBrush = New-Object System.Drawing.SolidBrush $white
    $g.FillRectangle($whiteBrush,
      [float]($size * 0.34), [float]($size * 0.26),
      [float]($size * 0.16), [float]($size * 0.18))

    # ---- camera body (white rounded rect) ------------------------------
    $body = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bx = [float]($size * 0.18); $by = [float]($size * 0.38)
    $bw = [float]($size * 0.64); $bh = [float]($size * 0.36)
    $br = [Math]::Max(2.0, [float]($size * 0.09))
    $body.AddArc($bx, $by, $br, $br, 180, 90)
    $body.AddArc($bx + $bw - $br, $by, $br, $br, 270, 90)
    $body.AddArc($bx + $bw - $br, $by + $bh - $br, $br, $br, 0, 90)
    $body.AddArc($bx, $by + $bh - $br, $br, $br, 90, 90)
    $body.CloseFigure()
    $g.FillPath($whiteBrush, $body)

    # ---- lens (navy ring w/ center dot, white tail hits the eye) -------
    $lensBrush = New-Object System.Drawing.SolidBrush $navy
    $lensWhite = New-Object System.Drawing.SolidBrush $white
    $ld = [float]($size * 0.20)
    $lx = [float]($size * 0.50 - $ld / 2)
    $ly = [float]($size * 0.56 - $ld / 2)
    $g.FillEllipse($lensBrush, $lx, $ly, $ld, $ld)
    $dd = [float]($size * 0.07)
    $g.FillEllipse($lensWhite,
      [float]($size * 0.50 - $dd / 2), [float]($size * 0.56 - $dd / 2), $dd, $dd)

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $g.Dispose()
    $bmp.Dispose()
  }
}

New-Icon 128 "icons/icon128.png"
New-Icon 48  "icons/icon48.png"
New-Icon 32  "icons/icon32.png"
New-Icon 16  "icons/icon16.png"

Write-Host "Icons written:"
Get-ChildItem "icons" | ForEach-Object { Write-Host ("  {0}  ({1} bytes)" -f $_.Name, $_.Length) }
