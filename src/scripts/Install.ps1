[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
$orgPath = Join-Path (Split-Path $appRoot -Parent) 'org'
New-Item -ItemType Directory -Force -Path $orgPath | Out-Null
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $orgPath /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict organization directory access.' }
$pwshPath = (Get-Command pwsh.exe).Source
$shell = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
$link = $shell.CreateShortcut((Join-Path $startup 'Agentic Enterprise.lnk'))
$link.TargetPath = $pwshPath
$link.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Start.ps1') + '"'
$link.WorkingDirectory = $appRoot
$link.WindowStyle = 7
$link.Save()
$desktop = [Environment]::GetFolderPath('Desktop')
$link = $shell.CreateShortcut((Join-Path $desktop 'Agentic Enterprise.lnk'))
$link.TargetPath = $pwshPath
$link.Arguments = '-NoProfile -WindowStyle Hidden -File "' + (Join-Path $PSScriptRoot 'Open.ps1') + '"'
$link.WorkingDirectory = $appRoot
$link.WindowStyle = 7
$link.Save()
& (Join-Path $PSScriptRoot 'Start.ps1')
Write-Output 'Native deployment installed. Desktop launcher and sign-in startup entry created.'
