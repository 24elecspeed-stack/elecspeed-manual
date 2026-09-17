<#
 원본 작업 사진 폴더를 받아 "저품질" 사진으로 일괄 변환합니다.
 - 가로 폭을 줄이고 JPEG 압축률을 낮춰서 파일 용량과 화질을 함께 낮춥니다.
 - 출력 파일명은 전부 "elecbg-01.jpg" 형식으로 통일합니다.
   앱의 "대표이미지 검색어" 기본값이 elecbg라서, 이 이름 그대로 워드프레스
   미디어 라이브러리에 올리면 앱이 검색해서 찾아낼 수 있습니다.

 사용법:
   powershell -ExecutionPolicy Bypass -File make-low-quality-photos.ps1 -InputDir "D:\원본사진폴더" -OutputDir "D:\저품질결과"

 옵션:
   -MaxWidth  결과 이미지의 최대 가로 폭 (기본 900px)
   -Quality   JPEG 압축 품질 0~100, 낮을수록 저품질 (기본 35)
   -MaxCount  최대 몇 장까지 만들지 (기본 100, 원본이 더 적으면 있는 만큼만)

 폰 사진은 실제 픽셀은 안 돌리고 EXIF에 "회전 정보"만 저장하는 경우가 많습니다.
 System.Drawing은 그 정보를 무시하고 그리기 때문에 이 정보를 읽어 먼저
 올바르게 회전/반전시킨 뒤에 리사이즈합니다.
#>
param(
 [Parameter(Mandatory=$true)][string]$InputDir,
 [Parameter(Mandatory=$true)][string]$OutputDir,
 [int]$MaxWidth = 900,
 [int]$Quality = 35,
 [int]$MaxCount = 100
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $InputDir)) { throw "입력 폴더가 없습니다: $InputDir" }
New-Item -ItemType Directory -Force $OutputDir | Out-Null

$allFiles = Get-ChildItem -LiteralPath $InputDir -File -Include *.jpg,*.jpeg,*.png,*.webp -Recurse
$files = if ($allFiles.Count -gt $MaxCount) { $allFiles | Get-Random -Count $MaxCount } else { $allFiles }

if ($files.Count -eq 0) { throw "입력 폴더에서 이미지 파일을 찾지 못했습니다: $InputDir" }

$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
             Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, [int64]$Quality)

$i = 0
foreach ($f in $files) {
    $i++
    try {
        $img = [System.Drawing.Image]::FromFile($f.FullName)

        # EXIF Orientation 태그(0x0112)를 읽어 실제 픽셀을 바로잡습니다.
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
            if ($rf -ne [System.Drawing.RotateFlipType]::RotateNoneFlipNone) {
                $img.RotateFlip($rf)
            }
        }

        $ratio = [Math]::Min(1.0, $MaxWidth / [double]$img.Width)
        $w = [int]($img.Width * $ratio)
        $h = [int]($img.Height * $ratio)

        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $g.DrawImage($img, 0, 0, $w, $h)

        $outName = "elecbg-{0:D2}.jpg" -f $i
        $outPath = Join-Path $OutputDir $outName
        $bmp.Save($outPath, $jpegCodec, $encParams)

        $g.Dispose(); $bmp.Dispose(); $img.Dispose()
        Write-Output "[$i/$($files.Count)] $($f.Name) -> $outName"
    } catch {
        Write-Warning "실패: $($f.Name) — $_"
    }
}

Write-Output "완료: $OutputDir 에 $i 장 저장했습니다. 이 폴더 안 파일을 워드프레스 미디어 라이브러리에 그대로 올리세요."
