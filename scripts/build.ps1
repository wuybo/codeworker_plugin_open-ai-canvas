# Code Worker 电商客服插件打包脚本
# 用法: .\scripts\build.ps1
# 产物: dist\ecom-cs-bot-<version>.cwplugin

param(
    [string]$SourceDirectory = "..",
    [string]$OutputDir = "..\dist",
    [string]$PluginId = "ecom-cs-bot"
)

$ErrorActionPreference = "Stop"

Write-Host "=== Code Worker 电商客服插件打包 ===" -ForegroundColor Cyan

# 确定版本号
$manifestPath = Join-Path $SourceDirectory "codeworker-plugin.json"
if (-not (Test-Path $manifestPath)) {
    Write-Error "找不到 codeworker-plugin.json"
    exit 1
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
Write-Host "插件版本: $version" -ForegroundColor Green

# 确保输出目录存在
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
}

$outputFile = Join-Path $OutputDir "${PluginId}-${version}.cwplugin"

# 删除旧产物
if (Test-Path $outputFile) {
    Remove-Item $outputFile -Force
    Write-Host "已删除旧产物" -ForegroundColor Yellow
}

# Step 1: 构建 service.exe
Write-Host "`n[1/3] 构建后台服务..." -ForegroundColor Cyan
$serviceDir = Join-Path $SourceDirectory "service"
$seaScript = Join-Path $serviceDir "scripts\build-sea.js"

if (Test-Path $seaScript) {
    Push-Location $serviceDir
    try {
        node scripts\build-sea.js
        if ($LASTEXITCODE -ne 0) {
            Write-Error "SEA 打包失败"
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Host "  service.exe 构建完成" -ForegroundColor Green
} else {
    Write-Host "  未找到 SEA 构建脚本，跳过（请手动构建 service）" -ForegroundColor Yellow
}

# Step 2: 校验必需文件
Write-Host "`n[2/3] 校验文件..." -ForegroundColor Cyan
$requiredFiles = @(
    "codeworker-plugin.json",
    "LICENSE",
    "ui\index.html",
    "ui\app.js",
    "ui\style.css"
)

foreach ($f in $requiredFiles) {
    $fullPath = Join-Path $SourceDirectory $f
    if (-not (Test-Path $fullPath)) {
        Write-Error "缺少必需文件: $f"
        exit 1
    }
    Write-Host "  OK: $f" -ForegroundColor Green
}

# 检查 service.exe（打包必须存在）
$serviceExe = Join-Path $SourceDirectory "service\ecom-cs-service.exe"
if (-not (Test-Path $serviceExe)) {
    Write-Warning "service\ecom-cs-service.exe 不存在！打包将不包含后台服务。"
    Write-Warning "请先运行 service\scripts\build-sea.js 构建。"
}

# Step 3: 打包 .cwplugin (ZIP)
Write-Host "`n[3/3] 打包 .cwplugin..." -ForegroundColor Cyan

# 使用 .NET 的 System.IO.Compression 打包
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# 删除临时文件
$tempZip = Join-Path $env:TEMP "$PluginId-$version-temp.zip"
if (Test-Path $tempZip) { Remove-Item $tempZip -Force }

# 创建 ZIP
if (Test-Path $tempZip) { Remove-Item $tempZip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($SourceDirectory, $tempZip)

# 重命名为 .cwplugin
Copy-Item $tempZip $outputFile -Force
Remove-Item $tempZip -Force

# 计算 SHA-256
$hash = (Get-FileHash $outputFile -Algorithm SHA256).Hash
Write-Host "`n=== 打包完成 ===" -ForegroundColor Cyan
Write-Host "产物: $outputFile" -ForegroundColor Green
Write-Host "大小: $([math]::Round((Get-Item $outputFile).Length / 1MB, 1)) MB" -ForegroundColor Green
Write-Host "SHA-256: $hash" -ForegroundColor Green
Write-Host ""
Write-Host "安装方式: Code Worker → 设置 → 插件 → 导入本地插件包 → 选择 $outputFile" -ForegroundColor Yellow
