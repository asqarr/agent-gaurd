param(
  [Parameter(Mandatory = $true)]
  [string]$BackupFile
)

$ErrorActionPreference = "Stop"
$resolved = (Resolve-Path -LiteralPath $BackupFile).Path
Write-Host "Restoring $resolved into the local AgentGuard database."
Get-Content -Raw -LiteralPath $resolved | docker compose exec -T postgres psql -U agentguard -d agentguard
Write-Host "Restore completed. Run the integration suite before serving traffic."
