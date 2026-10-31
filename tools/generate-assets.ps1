$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetDir = Join-Path $repoRoot 'demo-vault/Assets'
New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
$ink = [System.Drawing.ColorTranslator]::FromHtml('#101827')
$cool = [System.Drawing.ColorTranslator]::FromHtml('#294957')
$amber = [System.Drawing.ColorTranslator]::FromHtml('#F3BD70')
$mint = [System.Drawing.ColorTranslator]::FromHtml('#8CDDC5')
$paper = [System.Drawing.ColorTranslator]::FromHtml('#F4F1E8')
$titles = @('CONCEPT A / COMPACT GLOW', 'CONCEPT B / BROAD GLOW', 'ROUTE STUDY / TWO PATHS', 'SHOT BOARD / THREE BEATS', 'MOSSLIGHT COURIER / TITLE CARD', 'CONTROL CARDS / ACTION LABELS')
$names = @('lantern-concept-a', 'lantern-concept-b', 'room-route', 'trailer-board', 'title-card', 'control-cards')

for ($index = 0; $index -lt $names.Count; $index++) {
    $bitmap = New-Object System.Drawing.Bitmap 1000,600
    $canvas = [System.Drawing.Graphics]::FromImage($bitmap)
    $canvas.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Rectangle]::new(0,0,1000,600)),$ink,$cool,35
    $canvas.FillRectangle($gradient,0,0,1000,600)
    $whiteBrush = [System.Drawing.SolidBrush]::new($paper)
    $amberBrush = [System.Drawing.SolidBrush]::new($amber)
    $mintBrush = [System.Drawing.SolidBrush]::new($mint)
    $darkBrush = [System.Drawing.SolidBrush]::new($ink)
    $labelFont = [System.Drawing.Font]::new('Arial',14,[System.Drawing.FontStyle]::Bold)
    $titleFont = [System.Drawing.Font]::new('Arial',25,[System.Drawing.FontStyle]::Bold)
    $bodyFont = [System.Drawing.Font]::new('Arial',18)
    $canvas.DrawString('LANTERN FOX GAMES / PLACEHOLDER ART',$labelFont,$mintBrush,40,30)
    $canvas.DrawString($titles[$index],$titleFont,$whiteBrush,40,78)
    $canvas.DrawString('FICTIONAL DEMO / SHAPES ONLY / NO GAME CAPTURE',$labelFont,$whiteBrush,40,550)

    if ($index -lt 2) {
        $haloSize = @(260,390)[$index]
        $haloBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(44,$amber))
        $canvas.FillEllipse($haloBrush,500-$haloSize/2,330-$haloSize/2,$haloSize,$haloSize)
        $canvas.FillRectangle($amberBrush,445,248,110,150)
        $canvas.FillRectangle($darkBrush,463,268,74,105)
        $canvas.FillEllipse($amberBrush,480,292,40,58)
        $canvas.FillRectangle($mintBrush,360,442,280,14)
        $canvas.DrawString(@('Small halo, square silhouette','Wide halo, same silhouette')[$index],$bodyFont,$whiteBrush,40,492)
        $haloBrush.Dispose()
    } elseif ($index -eq 2) {
        $gridPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(45,$paper),1)
        for ($x = 100; $x -le 900; $x += 100) { $canvas.DrawLine($gridPen,$x,180,$x,480) }
        for ($y = 180; $y -le 480; $y += 100) { $canvas.DrawLine($gridPen,100,$y,900,$y) }
        $routePen = [System.Drawing.Pen]::new($amber,14)
        $curvePen = [System.Drawing.Pen]::new($mint,10)
        $canvas.DrawLine($routePen,150,380,850,380)
        $canvas.DrawBezier($curvePen,150,380,350,100,650,100,850,380)
        $canvas.FillEllipse($whiteBrush,128,358,44,44)
        $canvas.FillRectangle($whiteBrush,828,358,44,44)
        $canvas.DrawString('ENTRANCE',$labelFont,$whiteBrush,100,495)
        $canvas.DrawString('LANTERN DOCK',$labelFont,$whiteBrush,735,495)
        $gridPen.Dispose(); $routePen.Dispose(); $curvePen.Dispose()
    } elseif ($index -eq 3) {
        $shotLabels = @('01 / ENTER', '02 / CROSS', '03 / DELIVER')
        for ($shot = 0; $shot -lt 3; $shot++) {
            $left = 45 + $shot * 315
            $canvas.FillRectangle($darkBrush,$left,190,285,270)
            $canvas.FillRectangle($mintBrush,$left+22,380,240,12)
            $canvas.FillEllipse($amberBrush,$left+105,260,75,75)
            $canvas.DrawString($shotLabels[$shot],$bodyFont,$whiteBrush,$left+20,415)
        }
    } elseif ($index -eq 4) {
        $largeFont = [System.Drawing.Font]::new('Arial',52,[System.Drawing.FontStyle]::Bold)
        $canvas.DrawString('MOSSLIGHT',$largeFont,$whiteBrush,95,210)
        $canvas.DrawString('COURIER',$largeFont,$whiteBrush,95,290)
        $canvas.FillRectangle($amberBrush,735,225,100,145)
        $canvas.FillRectangle($darkBrush,755,250,60,95)
        $canvas.FillEllipse($amberBrush,772,275,26,45)
        $canvas.DrawString('A fictional lantern-delivery game',$bodyFont,$mintBrush,100,425)
        $largeFont.Dispose()
    } else {
        $actions = @('MOVE', 'CARRY', 'PLACE')
        for ($card = 0; $card -lt 3; $card++) {
            $left = 45 + $card * 315
            $canvas.FillRectangle($darkBrush,$left,190,285,285)
            if ($card -eq 0) { $canvas.FillRectangle($mintBrush,$left+75,280,135,24) }
            elseif ($card -eq 1) { $canvas.FillEllipse($amberBrush,$left+105,245,75,75) }
            else { $canvas.FillRectangle($mintBrush,$left+95,245,95,75) }
            $canvas.DrawString($actions[$card],$titleFont,$whiteBrush,$left+58,385)
        }
    }
    $bitmap.Save((Join-Path $assetDir ($names[$index] + '.png')),[System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Dispose(); $bitmap.Dispose(); $gradient.Dispose()
    $whiteBrush.Dispose(); $amberBrush.Dispose(); $mintBrush.Dispose(); $darkBrush.Dispose()
    $labelFont.Dispose(); $titleFont.Dispose(); $bodyFont.Dispose()
}
Write-Output 'Generated six labelled placeholder PNGs (1000 x 600).'
