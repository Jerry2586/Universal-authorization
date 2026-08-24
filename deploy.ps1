$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectDirectory = $PSScriptRoot
Set-Location -LiteralPath $ProjectDirectory

function Write-Step([string]$Message) {
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Stop-WithLogs([string]$Message) {
  Write-Host "`n$Message" -ForegroundColor Red
  docker compose ps
  docker compose logs --tail 120 app
  exit 1
}

Write-Step '检查 Docker 环境'
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw '没有找到 Docker。请先安装并启动 Docker Desktop，然后重新运行本脚本。'
}

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  throw 'Docker 服务没有运行。请启动 Docker Desktop，然后重新运行本脚本。'
}

docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  throw '当前 Docker 没有 Compose 插件，请安装最新版 Docker Desktop。'
}

Write-Step '自动生成或补全安全环境配置'
$Mount = "type=bind,source=$ProjectDirectory,target=/workspace"
docker run --rm --mount $Mount -w /workspace node:22-alpine node scripts/create-production-env.mjs
if ($LASTEXITCODE -ne 0) {
  throw '生成 .env 配置失败。'
}

Write-Step '构建并启动 PostgreSQL、Redis 和授权服务器'
docker compose up -d --build --remove-orphans
if ($LASTEXITCODE -ne 0) {
  throw 'Docker 服务构建或启动失败。'
}

Write-Step '等待授权服务器完成迁移并进入健康状态'
$ContainerId = [string](docker compose ps -q app)
$ContainerId = $ContainerId.Trim()
if (-not $ContainerId) {
  Stop-WithLogs '没有找到授权服务器容器。'
}

$Healthy = $false
for ($Attempt = 1; $Attempt -le 90; $Attempt++) {
  $Status = [string](docker inspect --format '{{.State.Health.Status}}' $ContainerId 2>$null)
  $Status = $Status.Trim()
  if ($Status -eq 'healthy') {
    $Healthy = $true
    break
  }
  if ($Status -eq 'unhealthy') {
    Stop-WithLogs '授权服务器健康检查失败。'
  }
  Start-Sleep -Seconds 2
}

if (-not $Healthy) {
  Stop-WithLogs '等待授权服务器启动超时。'
}

$PortLine = Get-Content -LiteralPath '.env' | Where-Object { $_ -match '^PORT=' } | Select-Object -First 1
$Port = if ($PortLine) { ($PortLine -split '=', 2)[1].Trim() } else { '3000' }

Write-Host "`n========================================" -ForegroundColor Green
Write-Host '  通用 Key 授权服务器搭建成功' -ForegroundColor Green
Write-Host "  健康检查：http://127.0.0.1:$Port/health" -ForegroundColor Green
Write-Host "  就绪检查：http://127.0.0.1:$Port/ready" -ForegroundColor Green
Write-Host '  查看日志：docker compose logs -f app' -ForegroundColor Green
Write-Host '  停止服务：docker compose down' -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
