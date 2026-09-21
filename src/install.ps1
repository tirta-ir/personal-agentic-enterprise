[CmdletBinding()]
param([string]$Ref = $(if ($env:AE_REF) { $env:AE_REF } else { 'main' }))
$ErrorActionPreference = 'Stop'
$installRoot = if ($env:AE_INSTALL_DIR) { $env:AE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'AgenticEnterprise' }
foreach ($tool in @('gh','git','cargo','node','npm.cmd','cl.exe')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        if ($tool -eq 'cl.exe' -and (Test-Path "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe")) { continue }
        throw "Install authenticated GitHub CLI, Git, Node 22+, Rust 1.94+ and Visual Studio C++ Build Tools, then rerun. Missing: $tool"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $installRoot '.git'))) {
    git -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' clone https://github.com/tirta-ir/personal-agentic-enterprise.git $installRoot
    if ($LASTEXITCODE) { throw 'Clone failed.' }
}
git -C $installRoot diff --quiet
if ($LASTEXITCODE) { throw 'Installation checkout has local changes. Preserve them before updating.' }
git -C $installRoot diff --cached --quiet
if ($LASTEXITCODE) { throw 'Installation checkout has staged changes. Preserve them before updating.' }
git -C $installRoot -c credential.helper= -c 'credential.https://github.com.helper=!gh auth git-credential' fetch origin $Ref
if ($LASTEXITCODE) { throw 'Fetch failed.' }
git -C $installRoot checkout --detach FETCH_HEAD
if ($LASTEXITCODE) { throw 'Checkout failed.' }
& (Join-Path $installRoot 'src/scripts/Build.ps1')
$binary = Join-Path $installRoot 'src/target/debug/agentic-enterprise.exe'
$binDirectory = Join-Path $installRoot 'bin'
New-Item -ItemType Directory -Force -Path $binDirectory | Out-Null
@'
@echo off
"%~dp0..\src\target\debug\agentic-enterprise.exe" --org "%~dp0..\org" --frontend "%~dp0..\src\frontend\dist" %*
'@ | Set-Content -LiteralPath (Join-Path $binDirectory 'agentic-enterprise.cmd') -Encoding ascii
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($binDirectory -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', "$binDirectory;$userPath", 'User') }
$env:Path = "$binDirectory;$env:Path"
if ($env:AE_CONTROLLER_URL) {
    $state = if ($env:AE_WORKER_STATE) { $env:AE_WORKER_STATE } else { Join-Path $env:LOCALAPPDATA 'AgenticWorker' }
    $workdir = if ($env:AE_WORKDIR) { $env:AE_WORKDIR } else { Join-Path $env:USERPROFILE 'agentic-workdir' }
    New-Item -ItemType Directory -Force -Path $state,$workdir | Out-Null
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $state /inheritance:r /grant:r "${identity}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE) { throw 'Could not protect worker state.' }
    & $binary --worker --worker-state $state --worker-root $workdir --enroll-only
    if ($LASTEXITCODE) { throw 'Enrollment failed.' }
    $action = New-ScheduledTaskAction -Execute $binary -Argument "--worker --worker-state `"$state`" --worker-root `"$workdir`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName 'Agentic Enterprise Worker' -Action $action -Trigger $trigger -Settings $settings -User $identity -Force | Out-Null
    Start-ScheduledTask -TaskName 'Agentic Enterprise Worker'
    Write-Output 'Registered worker installed and started.'
} else {
    Write-Output "Installed: $binary --org `"$installRoot/org`" --frontend `"$installRoot/src/frontend/dist`""
}
