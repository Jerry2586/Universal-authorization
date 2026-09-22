$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if (-not (Test-Path -LiteralPath '.env')) {
  & (Join-Path $PSScriptRoot 'setup.ps1')
}

$bundledNode = 'C:\Users\WDDN\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  & $node.Source 'scripts/start-split.js'
} elseif (Test-Path -LiteralPath $bundledNode) {
  & $bundledNode 'scripts/start-split.js'
} else {
  throw '未找到 Node.js 24 或更高版本。'
}
