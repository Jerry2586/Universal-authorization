param(
  [string]$AdminUsername = 'admin',
  [string]$AdminPassword = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'

function New-RandomSecret([int]$Bytes = 32) {
  $buffer = New-Object byte[] $Bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToBase64String($buffer).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

if (Test-Path -LiteralPath $envPath) {
  $existing = [System.IO.File]::ReadAllText($envPath)
  $missing = [System.Collections.Generic.List[string]]::new()
  $defaults = [ordered]@{
    APPGOG_SURFACE = 'license-center'
    BUILD_CENTER_PORT = '8788'
    INTERNAL_LICENSE_URL = 'http://127.0.0.1:8787'
    INTERNAL_SERVICE_TOKEN = (New-RandomSecret 48)
    BUILD_CENTER_PUBLIC_URL = 'http://127.0.0.1:8788/build'
    OFFLINE_GRACE_SECONDS = '2592000'
  }
  foreach ($entry in $defaults.GetEnumerator()) {
    if ($existing -notmatch "(?m)^$([regex]::Escape($entry.Key))=") {
      $missing.Add("$($entry.Key)=$($entry.Value)")
    }
  }
  if ($missing.Count -gt 0) {
    $prefix = if ($existing.EndsWith("`n")) { '' } else { "`r`n" }
    [System.IO.File]::AppendAllText($envPath, $prefix + ($missing -join "`r`n") + "`r`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host '已保留原 .env，并补充缺失的分层部署配置。'
  } else {
    Write-Host '.env 已存在且分层部署配置完整，未覆盖。'
  }
  Write-Host '使用 scripts/start.ps1 可强制以授权中心、客户中心和独立 Worker 三进程运行。'
  exit 0
}

if ([string]::IsNullOrWhiteSpace($AdminPassword)) {
  $AdminPassword = "Appgog-$(New-RandomSecret 18)"
}

$content = @"
NODE_ENV=development
PORT=8787
APPGOG_SURFACE=license-center
BUILD_CENTER_PORT=8788
INTERNAL_LICENSE_URL=http://127.0.0.1:8787
INTERNAL_SERVICE_TOKEN=$(New-RandomSecret 48)
DATABASE_PATH=./var/data/appgog.sqlite
SIGNING_PRIVATE_KEY_PATH=./var/keys/ed25519-private.pem
SIGNING_PUBLIC_KEY_PATH=./var/keys/ed25519-public.pem
KEY_HASH_PEPPER=$(New-RandomSecret 48)
ADMIN_TOKEN=$(New-RandomSecret 48)
ADMIN_USERNAME=$AdminUsername
ADMIN_PASSWORD=$AdminPassword
WORKER_TOKEN=$(New-RandomSecret 48)
SESSION_SECRET=$(New-RandomSecret 48)
DELIVERY_ENCRYPTION_KEY=$(New-RandomSecret 48)
PUBLIC_BASE_URL=http://127.0.0.1:8787
BUILD_CENTER_PUBLIC_URL=http://127.0.0.1:8788/build
ARTIFACT_ROOT=./var/artifacts
UPLOAD_ROOT=./var/uploads
ACTIVATION_TOKEN_TTL_SECONDS=604800
OFFLINE_GRACE_SECONDS=2592000
BUILD_TICKET_TTL_SECONDS=900
WEB_SESSION_TTL_SECONDS=28800
MAX_SOURCE_UPLOAD_BYTES=134217728
EMBEDDED_WORKER=false
"@

[System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))
Write-Host 'APPGOG 本地配置已创建。'
Write-Host "管理员账号: $AdminUsername"
Write-Host "管理员密码: $AdminPassword"
Write-Host '请立即保存密码；修改 .env 不会自动修改已创建数据库中的管理员密码。'
