[CmdletBinding()]
param([string]$Org)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
if (-not $Org) { $Org = Join-Path (Split-Path $appRoot -Parent) 'org' }
$pidFile = Join-Path $Org '.state\service.json'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No recorded native service.'; return }
$record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
$process = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
if (-not $process) { Write-Output 'Recorded service is no longer running.'; return }
if ($process.Path -ne $record.executable -or $process.StartTime.ToUniversalTime().Ticks -ne ([DateTime]$record.started).ToUniversalTime().Ticks) { throw 'Process identity changed; refusing to stop an unrelated process.' }
Stop-Process -Id $process.Id
$process.WaitForExit(10000) | Out-Null
Write-Output 'Agentic Enterprise stopped. Owned agent jobs close with the service; interrupted runs are reconciled on restart.'
