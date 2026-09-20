[CmdletBinding()]
param([string]$Org, [ValidateRange(1, 65535)][int]$Port = 8765, [string]$InterfaceAlias)
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
if (-not $Org) { $Org = Join-Path (Split-Path $appRoot -Parent) 'org' }
$Org = [IO.Path]::GetFullPath($Org)
$binary = Join-Path $appRoot 'target\debug\agentic-enterprise.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build the application first with scripts\Build.ps1.' }
$stateDir = Join-Path $Org '.state'
$configPath = Join-Path $stateDir 'deployment.json'
if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('Port')) { $Port = [int]$config.port }
    if (-not $PSBoundParameters.ContainsKey('InterfaceAlias')) { $InterfaceAlias = [string]$config.interface_alias }
}
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Saved deployment port must be between 1 and 65535.' }
$bindAddress = '127.0.0.1'
if ($InterfaceAlias) {
    $addresses = @(Get-NetIPAddress -InterfaceAlias $InterfaceAlias -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.AddressState -eq 'Preferred' })
    if ($addresses.Count -ne 1) { throw "Interface '$InterfaceAlias' must have exactly one preferred IPv4 address. Connect it before starting." }
    $bindAddress = $addresses[0].IPAddress
}
$baseUrl = "http://${bindAddress}:$Port"
$healthUrl = "$baseUrl/api/health"
$pidFile = Join-Path $stateDir 'service.json'
if (Test-Path -LiteralPath $pidFile) {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $existing = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($existing -and $existing.Path -eq $record.executable -and $existing.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$record.started).ToUniversalTime().Ticks) {
        $recordAddress = if ($record.bind_address) { $record.bind_address } else { '127.0.0.1' }
        if ($record.port -ne $Port -or $recordAddress -ne $bindAddress) { throw 'This organization is already running at another address. Stop it before changing the deployment binding.' }
        $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
        if ($health.product -ne 'Agentic Enterprise') { throw 'Recorded process failed its health check.' }
        Write-Output "Agentic Enterprise is already running at $baseUrl"; return
    }
}
try {
    $health = Invoke-RestMethod $healthUrl -TimeoutSec 2
    if ($health.product -eq 'Agentic Enterprise') { throw "Address $baseUrl already serves another organization or an untracked instance. Choose another port." }
} catch [System.Net.Http.HttpRequestException] { }
catch [System.Threading.Tasks.TaskCanceledException] { }
$codexPath = (Get-Command codex -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $codexPath) { $codexPath = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe' }
if (-not (Test-Path -LiteralPath $codexPath)) { throw 'Codex CLI is not installed or available on PATH.' }
$logsDir = Join-Path $stateDir 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
$arguments = @('--org', ('"' + $Org + '"'), '--port', $Port, '--bind', $bindAddress, '--frontend', ('"' + (Join-Path $appRoot 'frontend\dist') + '"'), '--codex', ('"' + $codexPath + '"'))
$process = Start-Process -FilePath $binary -ArgumentList $arguments -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logsDir 'service.stdout.log') -RedirectStandardError (Join-Path $logsDir 'service.stderr.log')
@{ pid = $process.Id; executable = $binary; started = $process.StartTime.ToUniversalTime().ToString('o'); port = $Port; bind_address = $bindAddress; url = $baseUrl } | ConvertTo-Json | Set-Content -LiteralPath $pidFile
$ready = $false
try {
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        $process.Refresh()
        if ($process.HasExited) { throw "Service exited. Read $logsDir\service.stderr.log" }
        try {
            $health = Invoke-RestMethod $healthUrl -TimeoutSec 1
            if ($health.product -eq 'Agentic Enterprise') {
                @{ port = $Port; interface_alias = $InterfaceAlias } | ConvertTo-Json | Set-Content -LiteralPath $configPath
                $ready = $true
                Write-Output "Agentic Enterprise ready at $baseUrl (PID $($process.Id))"; return
            }
        } catch [System.Net.Http.HttpRequestException] { }
        catch [System.Threading.Tasks.TaskCanceledException] { }
    }
    throw 'Service did not become ready. Inspect the service logs.'
} finally {
    if (-not $ready -and -not $process.HasExited) { $process | Stop-Process }
}
