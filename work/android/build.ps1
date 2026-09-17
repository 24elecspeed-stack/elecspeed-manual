param(
 [string]$JavaBin = 'C:/Program Files/Android/Android Studio/jbr/bin',
 [string]$BuildTools = 'C:/Users/manowar/AppData/Local/Android/Sdk/build-tools/36.0.0',
 [string]$PlatformJar = 'C:/Users/manowar/AppData/Local/Android/Sdk/platforms/android-35/android.jar',
 [string]$OutputApk = (Join-Path $PSScriptRoot '../../outputs/elecspeed-chatgpt.apk')
)
$ErrorActionPreference='Stop'
function Run-Native([string]$Program, [string[]]$Arguments) {
 & $Program @Arguments
 if ($LASTEXITCODE -ne 0) { throw "Tool failed ($LASTEXITCODE): $Program" }
}
$buildPath=Join-Path $PSScriptRoot ('build-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force "$buildPath/classes","$buildPath/dex","$buildPath/compiler" | Out-Null
$sources=@(Get-ChildItem -LiteralPath "$PSScriptRoot/src/com/elecspeed/manual" -Filter '*.java' | ForEach-Object FullName)
Run-Native "$JavaBin/javac.exe" @('-encoding','UTF-8','-d',"$buildPath/compiler","$PSScriptRoot/CompileAndroid.java")
Run-Native "$JavaBin/java.exe" (@('-cp',"$buildPath/compiler",'CompileAndroid',$PlatformJar,"$buildPath/classes")+$sources)
$classes=@(Get-ChildItem -LiteralPath "$buildPath/classes" -Recurse -Filter '*.class' | ForEach-Object FullName)
Run-Native "$JavaBin/java.exe" (@('-cp',"$BuildTools/lib/d8.jar",'com.android.tools.r8.D8','--lib',$PlatformJar,'--min-api','26','--output',"$buildPath/dex")+$classes)
Run-Native "$BuildTools/aapt.exe" @('package','-f','-M',"$PSScriptRoot/AndroidManifest.xml",'-S',"$PSScriptRoot/res",'-I',$PlatformJar,'-A',"$PSScriptRoot/assets",'-F',"$buildPath/base.apk")
# ZipArchiveMode 열거형은 System.IO.Compression.dll에 있어서 FileSystem 어셈블리만 불러오면
# Windows PowerShell 5.1에서 "Unable to find type [IO.Compression.ZipArchiveMode]"로 실패합니다.
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zip=[System.IO.Compression.ZipFile]::Open("$buildPath/base.apk",[System.IO.Compression.ZipArchiveMode]::Update)
try { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,"$buildPath/dex/classes.dex",'classes.dex') | Out-Null } finally { $zip.Dispose() }
Run-Native "$BuildTools/zipalign.exe" @('-f','4',"$buildPath/base.apk","$buildPath/aligned.apk")
Run-Native "$JavaBin/java.exe" @('-jar',"$BuildTools/lib/apksigner.jar",'sign','--ks',"$PSScriptRoot/signing.jks",'--ks-key-alias','manual','--ks-pass','pass:android','--key-pass','pass:android','--out',$OutputApk,"$buildPath/aligned.apk")
Run-Native "$JavaBin/java.exe" @('-jar',"$BuildTools/lib/apksigner.jar",'verify','--verbose',$OutputApk)
Write-Output "APK created: $OutputApk"
