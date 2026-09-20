[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$appRoot = Split-Path $PSScriptRoot -Parent
Push-Location $appRoot
try {
    if (-not (Test-Path tools\protoc\bin\protoc.exe)) {
        New-Item -ItemType Directory -Force -Path tools\protoc | Out-Null
        Invoke-WebRequest 'https://github.com/protocolbuffers/protobuf/releases/download/v36.2/protoc-36.2-win64.zip' -OutFile tools\protoc.zip
        Expand-Archive -LiteralPath tools\protoc.zip -DestinationPath tools\protoc -Force
    }
    cargo build --locked
    if ($LASTEXITCODE) { throw 'Rust build failed.' }
    & .\target\debug\agentic-enterprise.exe --export-types
    if ($LASTEXITCODE) { throw 'Type generation failed.' }
    $ortVersion = '1.24.4'
    $ortFile = "onnxruntime-win-x64-$ortVersion.zip"
    if (-not (Test-Path "tools\onnxruntime-win-x64-$ortVersion\lib\onnxruntime.dll")) {
        $release = Invoke-RestMethod "https://api.github.com/repos/microsoft/onnxruntime/releases/tags/v$ortVersion"
        $asset = $release.assets | Where-Object name -eq $ortFile
        Invoke-WebRequest $asset.browser_download_url -OutFile "tools\$ortFile"
        if ($asset.digest -and $asset.digest -ne ('sha256:' + (Get-FileHash "tools\$ortFile").Hash.ToLowerInvariant())) { throw 'ONNX Runtime checksum mismatch.' }
        Expand-Archive -LiteralPath "tools\$ortFile" -DestinationPath tools -Force
    }
    Copy-Item -Path "tools\onnxruntime-win-x64-$ortVersion\lib\*.dll" -Destination target\debug -Force
    Push-Location frontend
    try {
        npm.cmd ci
        if ($LASTEXITCODE) { throw 'Frontend dependency installation failed.' }
        npm.cmd run build
        if ($LASTEXITCODE) { throw 'Frontend build failed.' }
    } finally { Pop-Location }
} finally { Pop-Location }
