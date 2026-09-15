# 取 Windows 版外置工具到 vendor/，供构建时内嵌进 WeTube.exe。
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-bundled-tools-windows.ps1
#
# 与 macOS 打包脚本同一套约定：版本 pin 死 + SHA256 校验，哈希对不上直接失败，
# 防止供应链投毒；vendor/ 不入库（见 .gitignore），只在打包时本地生成。
#
# 两个工具：
#   yt-dlp —— 官方 release（PyInstaller 打包，GPLv3+，与本项目 GPL-3.0 兼容）
#   ffmpeg —— gyan.dev essentials 构建（GPLv3，含合并音视频所需的全部封装器）
param(
  [string]$YtDlpVersion = "2026.08.19",
  [string]$YtDlpSha256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a",
  [string]$FfmpegVersion = "9.0.1",
  [string]$FfmpegSha256 = "fec81ae03971d9dd4be3ebe02e263bd2ec1d789483f931bdba5f5715e65da2e9",
  [switch]$KeepArchive
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root "vendor"
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
$ProgressPreference = "SilentlyContinue"

function Get-Sha256([string]$path) {
  return (Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower()
}

# ---- yt-dlp ----
$ytdlp = Join-Path $vendor "yt-dlp.exe"
$ytdlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/download/$YtDlpVersion/yt-dlp.exe"
if ((Test-Path $ytdlp) -and ((Get-Sha256 $ytdlp) -eq $YtDlpSha256.ToLower())) {
  Write-Host "yt-dlp $YtDlpVersion 已存在且校验通过"
} else {
  Write-Host "下载 yt-dlp $YtDlpVersion ..."
  Invoke-WebRequest -Uri $ytdlpUrl -OutFile $ytdlp -TimeoutSec 900
  if ((Get-Sha256 $ytdlp) -ne $YtDlpSha256.ToLower()) {
    Remove-Item -Force $ytdlp
    throw "yt-dlp SHA256 校验失败（已删除下载文件）"
  }
}
Set-Content -Path (Join-Path $vendor "yt-dlp.version") -Value $YtDlpVersion -NoNewline -Encoding ASCII

# ---- ffmpeg ----
# 只取压缩包里的 bin/ffmpeg.exe，不落 ffplay/ffprobe（一个就 98MB，没必要）。
$ffmpeg = Join-Path $vendor "ffmpeg.exe"
$zip = Join-Path $vendor "ffmpeg-$FfmpegVersion-essentials_build.zip"
$ffmpegUrl = "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/ffmpeg-$FfmpegVersion-essentials_build.zip"
if ((Test-Path $ffmpeg) -and ((Get-Sha256 $ffmpeg) -eq $FfmpegSha256.ToLower())) {
  Write-Host "ffmpeg $FfmpegVersion 已存在且校验通过"
} else {
  Write-Host "下载 ffmpeg $FfmpegVersion（约 106MB）..."
  Invoke-WebRequest -Uri $ffmpegUrl -OutFile $zip -TimeoutSec 1800
  $zipHash = Get-Sha256 $zip
  if ($zipHash -ne $FfmpegSha256.ToLower()) {
    Remove-Item -Force $zip
    throw "ffmpeg 压缩包 SHA256 校验失败：期望 $FfmpegSha256，实际 $zipHash（已删除下载文件）"
  }
  Write-Host "解出 bin/ffmpeg.exe ..."
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $entry = $archive.Entries | Where-Object { $_.FullName -like "*/bin/ffmpeg.exe" } | Select-Object -First 1
    if (-not $entry) { throw "压缩包里找不到 bin/ffmpeg.exe" }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $ffmpeg, $true)
  } finally {
    $archive.Dispose()
  }
  if (-not $KeepArchive) { Remove-Item -Force $zip }
}
Set-Content -Path (Join-Path $vendor "ffmpeg.version") -Value $FfmpegVersion -NoNewline -Encoding ASCII

Write-Host ""
Write-Host "完成："
Get-ChildItem $vendor | Select-Object Name, @{n = "MB"; e = { [math]::Round($_.Length / 1MB, 1) } } | Format-Table -AutoSize
