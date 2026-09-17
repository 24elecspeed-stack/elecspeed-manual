<#
 대표이미지(featured_media)용 사진을 만듭니다.
 - 실제 작업 사진 위에 회사명·전화번호 문구를 합성해 1200x630(og:image 표준 비율)
   이미지로 만듭니다. 글마다 다른 사진이 되게 해서 검색엔진이 "사이트 공통 로고"가
   아니라 "콘텐츠 사진"으로 인식하게 하면서도(SEO), 사진에 브랜드 문구가 남게 합니다.
 - 지역명(구/동)처럼 글마다 다른 텍스트는 미리 넣을 수 없어서(이건 사진을 미리
   만들어두는 방식이라) 회사명·전화번호 같은 공통 문구만 넣습니다.
 - 출력 파일명은 "elecfeatured-01.jpg" 형식. 앱의 "대표이미지 검색어" 기본값이
   elecfeatured라서, 이 이름 그대로 워드프레스 미디어 라이브러리에 올리면 앱이
   찾아서 무작위로 대표이미지에 씁니다.

 사용법:
   powershell -ExecutionPolicy Bypass -File make-featured-photos.ps1 -InputDir "D:\원본사진폴더" -OutputDir "D:\대표이미지결과"

 옵션:
   -Quality   JPEG 압축 품질 0~100 (기본 55 — 대표이미지라 배경사진보다 살짝 높게)
   -MaxCount  최대 몇 장까지 만들지 (기본 100)
#>
param(
 [Parameter(Mandatory=$true)][string]$InputDir,
 [Parameter(Mandatory=$true)][string]$OutputDir,
 [int]$Quality = 55,
 [int]$MaxCount = 100
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $InputDir)) { throw "입력 폴더가 없습니다: $InputDir" }
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$allFiles = Get-ChildItem -LiteralPath $InputDir -File -Include *.jpg,*.jpeg,*.png,*.webp -Recurse
$files = if ($allFiles.Count -gt $MaxCount) { $allFiles | Get-Random -Count $MaxCount } else { $allFiles }
if ($files.Count -eq 0) { throw "입력 폴더에서 이미지 파일을 찾지 못했습니다: $InputDir" }

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$W = 1200
$H = 630
$MARGIN = 70
$MAX_TEXT_WIDTH = $W - $MARGIN - 60
# 이 사이트는 썸네일을 전부 가운데 기준 정사각형(H x H)으로 하드 크롭합니다.
# 1200x630 대표이미지가 630x630으로 잘리면 좌우 285px씩 사라지므로,
# 글자는 그 가운데 630px 안에서만 살아남습니다. 여유를 두고 560px 안전폭으로 맞춥니다.
$SAFE_WIDTH = 560
$CENTER_X = $W / 2
$navy = [System.Drawing.Color]::FromArgb(255, 13, 21, 36)
$amber = [System.Drawing.Color]::FromArgb(255, 255, 198, 41)
$white = [System.Drawing.Color]::White

# 글자가 항상 썸네일 폭 안에 맞도록, 안 맞으면 폰트를 줄여가며 맞는 크기를 찾습니다.
function Get-FitFont($g, $text, $family, $style, $maxWidth, $startSize, $minSize) {
    $size = $startSize
    while ($size -ge $minSize) {
        $f = [System.Drawing.Font]::new($family, $size, $style)
        $w = $g.MeasureString($text, $f).Width
        if ($w -le $maxWidth) { return $f }
        $f.Dispose()
        $size -= 2
    }
    return [System.Drawing.Font]::new($family, $minSize, $style)
}

# "누전수리 · 차단기 · ..." 처럼 " · "로 이어진 문구는 항목 단위로만 줄을 바꿉니다.
# 단어(공백) 단위로 자르면 "... 전기배선 ·" 처럼 가운뎃점이 줄 끝에 혼자 남아 어색해집니다.
function Split-FitPhrases($g, $text, $font, $maxWidth, $sep) {
    $items = $text -split [regex]::Escape($sep)
    $lines = @()
    $current = @()
    foreach ($item in $items) {
        $trial = ($current + $item) -join $sep
        if ($current.Count -eq 0 -or ($g.MeasureString($trial, $font)).Width -le $maxWidth) { $current += $item }
        else { $lines += ($current -join $sep); $current = @($item) }
    }
    if ($current.Count -gt 0) { $lines += ($current -join $sep) }
    return $lines
}

# 그래도 한 줄에 안 들어가면 단어 단위로 줄바꿈합니다.
function Split-FitLines($g, $text, $font, $maxWidth) {
    $words = $text -split ' '
    $lines = @()
    $current = ""
    foreach ($w in $words) {
        $trial = if ($current) { "$current $w" } else { $w }
        if (($g.MeasureString($trial, $font)).Width -le $maxWidth) { $current = $trial }
        else { if ($current) { $lines += $current }; $current = $w }
    }
    if ($current) { $lines += $current }
    return $lines
}

$i = 0
foreach ($f in $files) {
    $i++
    try {
        $img = [System.Drawing.Image]::FromFile($f.FullName)

        $ORIENTATION_ID = 0x0112
        if ($img.PropertyIdList -contains $ORIENTATION_ID) {
            $orientation = $img.GetPropertyItem($ORIENTATION_ID).Value[0]
            $rf = switch ($orientation) {
                2 { [System.Drawing.RotateFlipType]::RotateNoneFlipX }
                3 { [System.Drawing.RotateFlipType]::Rotate180FlipNone }
                4 { [System.Drawing.RotateFlipType]::Rotate180FlipX }
                5 { [System.Drawing.RotateFlipType]::Rotate90FlipX }
                6 { [System.Drawing.RotateFlipType]::Rotate90FlipNone }
                7 { [System.Drawing.RotateFlipType]::Rotate270FlipX }
                8 { [System.Drawing.RotateFlipType]::Rotate270FlipNone }
                default { [System.Drawing.RotateFlipType]::RotateNoneFlipNone }
            }
            if ($rf -ne [System.Drawing.RotateFlipType]::RotateNoneFlipNone) { $img.RotateFlip($rf) }
        }

        # 1200x630 비율로 가운데 크롭 (cover)
        $srcRatio = $img.Width / [double]$img.Height
        $dstRatio = $W / [double]$H
        if ($srcRatio -gt $dstRatio) {
            $cropW = [int]($img.Height * $dstRatio)
            $x = [int](($img.Width - $cropW) / 2)
            $srcRect = New-Object System.Drawing.Rectangle $x, 0, $cropW, $img.Height
        } else {
            $cropH = [int]($img.Width / $dstRatio)
            $y = [int](($img.Height - $cropH) / 2)
            $srcRect = New-Object System.Drawing.Rectangle 0, $y, $img.Width, $cropH
        }

        $bmp = New-Object System.Drawing.Bitmap $W, $H
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $destRect = New-Object System.Drawing.Rectangle 0, 0, $W, $H
        $g.DrawImage($img, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

        # 어두운 그라데이션(가독성용) — 가운데(글자 자리)가 가장 어둡고 양옆으로 갈수록 옅어짐.
        # 정사각형으로 잘려도 어차피 가운데만 남으므로, 잘리는 부분에 굳이 진하게 칠하지 않습니다.
        $rect = [System.Drawing.Rectangle]::new(0, 0, $W, $H)
        $gradColor1 = [System.Drawing.Color]::FromArgb(120, $navy.R, $navy.G, $navy.B)
        $gradColor2 = [System.Drawing.Color]::FromArgb(230, $navy.R, $navy.G, $navy.B)
        $ptStart = [System.Drawing.PointF]::new(0, 0)
        $ptMid = [System.Drawing.PointF]::new($CENTER_X, 0)
        $ptEnd = [System.Drawing.PointF]::new($W, 0)
        $gradBrush1 = [System.Drawing.Drawing2D.LinearGradientBrush]::new($ptStart, $ptMid, $gradColor1, $gradColor2)
        $g.FillRectangle($gradBrush1, 0, 0, [int]$CENTER_X, $H)
        $gradBrush2 = [System.Drawing.Drawing2D.LinearGradientBrush]::new($ptMid, $ptEnd, $gradColor2, $gradColor1)
        $g.FillRectangle($gradBrush2, [int]$CENTER_X, 0, [int]$CENTER_X, $H)

        $whiteBrush = [System.Drawing.SolidBrush]::new($white)
        $amberBrush = [System.Drawing.SolidBrush]::new($amber)
        $navyBrush = [System.Drawing.SolidBrush]::new($navy)
        $bold = [System.Drawing.FontStyle]::Bold

        # 가운데 정렬로 그리는 도우미 — x좌표를 CENTER_X 기준으로 계산해줍니다.
        function Draw-Centered($g, $text, $font, $brush, $centerX, $y) {
            $size = $g.MeasureString($text, $font)
            $x = $centerX - ($size.Width / 2)
            $g.DrawString($text, $font, $brush, [System.Drawing.PointF]::new($x, $y))
        }

        # 제목 — 정사각형으로 잘려도 살아남는 가운데 560px 안전폭 안에서 최대한 크게.
        $titleText = "24시 전기수리"
        $fontTitle = Get-FitFont $g $titleText "맑은 고딕" $bold $SAFE_WIDTH 96 56
        $titleH = $g.MeasureString($titleText, $fontTitle).Height
        $titleY = 70
        Draw-Centered $g $titleText $fontTitle $whiteBrush $CENTER_X $titleY

        # 부제 — 안전폭에 안 들어가면 자동으로 줄바꿈합니다.
        $subText = "누전수리 · 차단기 · 전기공사"
        $fontSub = Get-FitFont $g $subText "맑은 고딕" $bold $SAFE_WIDTH 54 30
        $subLines = if (($g.MeasureString($subText, $fontSub)).Width -le $SAFE_WIDTH) { @($subText) } else { Split-FitPhrases $g $subText $fontSub $SAFE_WIDTH " · " }
        $subLineH = $g.MeasureString("가", $fontSub).Height
        $subY = $titleY + $titleH + 14
        foreach ($line in $subLines) {
            Draw-Centered $g $line $fontSub $whiteBrush $CENTER_X $subY
            $subY += $subLineH * 1.05
        }

        # 전화번호 노란 알약 — 이것도 안전폭에 맞춰 폰트 크기를 조정하고 가운데 정렬합니다.
        $phone = "0507-1417-8239"
        $fontPhone = Get-FitFont $g $phone "맑은 고딕" $bold ($SAFE_WIDTH - 70) 56 36
        $phoneSize = $g.MeasureString($phone, $fontPhone)
        $pillW = [float]($phoneSize.Width + 70)
        $pillH = [float]($phoneSize.Height + 36)
        $pillY = [float]([Math]::Min($H - $pillH - 40, $subY + 30))
        $pillX = [float]($CENTER_X - $pillW / 2)
        $pillRect = [System.Drawing.RectangleF]::new($pillX, $pillY, $pillW, $pillH)
        $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $r = $pillH / 2
        $path.AddArc($pillRect.X, $pillRect.Y, $r*2, $r*2, 180, 90)
        $path.AddArc($pillRect.Right-$r*2, $pillRect.Y, $r*2, $r*2, 270, 90)
        $path.AddArc($pillRect.Right-$r*2, $pillRect.Bottom-$r*2, $r*2, $r*2, 0, 90)
        $path.AddArc($pillRect.X, $pillRect.Bottom-$r*2, $r*2, $r*2, 90, 90)
        $path.CloseFigure()
        $g.FillPath($amberBrush, $path)
        Draw-Centered $g $phone $fontPhone $navyBrush $CENTER_X ($pillY+18)

        $outName = "elecfeatured-{0:D2}.jpg" -f $i
        $outPath = Join-Path $OutputDir $outName
        $bmp.Save($outPath, $jpegCodec, $encParams)

        $g.Dispose(); $bmp.Dispose(); $img.Dispose(); $gradBrush1.Dispose(); $gradBrush2.Dispose(); $path.Dispose()
        Write-Output "[$i/$($files.Count)] $($f.Name) -> $outName"
    } catch {
        Write-Warning "실패: $($f.Name) — $_"
    }
}

Write-Output "완료: $OutputDir 에 $i 장 저장했습니다. 이 폴더 안 파일을 워드프레스 미디어 라이브러리에 그대로 올리세요."
