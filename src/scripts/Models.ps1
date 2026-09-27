[CmdletBinding()]
param([string]$Org)
$ErrorActionPreference = 'Stop'
if (-not $Org) { $Org = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'org' }
$models = @(
    @{ name='Qdrant/clip-ViT-B-32-text'; revision='48ca1db27cb4063eb311ec2aa7f087a808112876'; size=254102519; sha='4dbe762b11e36488304471e439cde89da053ad7acaddbf9e096745d142ec8d8b'; files=@('model.onnx','config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','README.md') },
    @{ name='Qdrant/clip-ViT-B-32-vision'; revision='e0c24ed0fa57fa3e4f97f30de74c51d944036ace'; size=351686194; sha='c68d3d9a200ddd2a8c8a5510b576d4c94d1ae383bf8b36dd8c084f94e1fb4d63'; files=@('model.onnx','config.json','preprocessor_config.json','README.md') }
)
foreach ($model in $models) {
    $cache = Join-Path $Org ('.state/models/models--' + $model.name.Replace('/','--'))
    $snapshot = Join-Path $cache ('snapshots/' + $model.revision)
    New-Item -ItemType Directory -Force -Path $snapshot,(Join-Path $cache 'refs') | Out-Null
    foreach ($file in $model.files) {
        $target = Join-Path $snapshot $file
        if (-not (Test-Path -LiteralPath $target)) {
            Write-Output "Downloading $($model.name)/$file"
            $url = "https://huggingface.co/$($model.name)/resolve/$($model.revision)/${file}?download=true"
            if ($file -eq 'model.onnx') {
                # Bounded HTTP ranges avoid long CDN stalls; validate every range and final hash.
                $parts = @(for ($offset = 0; $offset -lt $model.size; $offset += 8MB) { @{ start=$offset; end=[Math]::Min($offset+8MB-1,$model.size-1); path=($target + '.' + $offset + '.part') } })
                $parts | ForEach-Object -Parallel {
                    $ErrorActionPreference = 'Stop'
                    $part = $_; $length = $part.end-$part.start+1
                    if (-not (Test-Path -LiteralPath $part.path) -or (Get-Item -LiteralPath $part.path).Length -ne $length) {
                        & curl.exe --silent --show-error --fail --location --retry 5 --retry-all-errors --retry-delay 2 --max-time 180 --range "$($part.start)-$($part.end)" --output $part.path ($using:url + '&range=' + $part.start + '&request=' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) 2> ($part.path + '.stderr')
                        if ($LASTEXITCODE -ne 0) { throw 'Model range download failed.' }
                        Remove-Item -LiteralPath ($part.path + '.stderr') -ErrorAction SilentlyContinue
                    }
                    if ((Get-Item -LiteralPath $part.path).Length -ne $length) { throw 'Unexpected model range length.' }
                } -ThrottleLimit 4
                $output = [IO.File]::Create($target + '.partial')
                try { foreach ($part in $parts) { $input = [IO.File]::OpenRead($part.path); try { $input.CopyTo($output) } finally { $input.Dispose() } } } finally { $output.Dispose() }
                if ((Get-FileHash -LiteralPath ($target + '.partial')).Hash.ToLowerInvariant() -ne $model.sha) { throw 'Downloaded model checksum mismatch.' }
                foreach ($part in $parts) { Remove-Item -LiteralPath $part.path }
            } else { Invoke-WebRequest $url -OutFile ($target + '.partial') -TimeoutSec 60 }
            Move-Item -LiteralPath ($target + '.partial') -Destination $target
        }
        if ($file -eq 'model.onnx' -and (Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant() -ne $model.sha) { throw "Model checksum mismatch: $($model.name)" }
    }
    [IO.File]::WriteAllText((Join-Path $cache 'refs/main'), $model.revision)
    Write-Output "Verified model: $($model.name) at $($model.revision)"
}
