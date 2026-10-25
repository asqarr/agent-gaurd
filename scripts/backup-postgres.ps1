param(
  [string]$OutputDirectory = "./backups"
)

$ErrorActionPreference = "Stop"
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$targetDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
$backupPath = Join-Path $targetDirectory "agentguard-$timestamp.sql"

docker compose exec -T postgres pg_dump --clean --if-exists --no-owner --no-privileges -U agentguard agentguard | Out-File -FilePath $backupPath -Encoding utf8
Write-Host "Backup written to $backupPath"
