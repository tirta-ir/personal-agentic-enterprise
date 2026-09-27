[CmdletBinding()]
param([string]$Org)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
if (-not $Org) { $Org = Join-Path (Split-Path $appRoot -Parent) 'org' }
& (Join-Path $PSScriptRoot 'Start.ps1') -Org $Org
$stateDir = Join-Path $Org '.state'
$record = Get-Content -LiteralPath (Join-Path $stateDir 'service.json') -Raw | ConvertFrom-Json
$baseUrl = if ($record.url) { $record.url } else { "http://127.0.0.1:$($record.port)" }
$ownerKey = (Get-Content -LiteralPath (Join-Path $stateDir 'owner.key') -Raw).Trim()
# Fragment is consumed and removed by the UI; it is never sent in an HTTP URL.
Start-Process "$baseUrl/#key=$ownerKey"
