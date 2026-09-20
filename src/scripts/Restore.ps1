[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
$Destination = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $Destination) { throw 'Restore requires a new destination directory; existing data is never overwritten.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
    $manifestEntry = $zip.GetEntry('manifest.json')
    if (-not $manifestEntry) { throw 'Backup manifest missing.' }
    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($manifest.version -ne 1) { throw 'Unsupported backup format.' }
    $entries = @{}
    foreach ($item in $manifest.files) {
        $relative = $item.path.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $target = [IO.Path]::GetFullPath((Join-Path $Destination $relative))
        if (-not $target.StartsWith($Destination + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe backup path.' }
        if ($entries.ContainsKey($target)) { throw 'Duplicate backup path.' }
        $entry = $zip.GetEntry($item.path)
        if (-not $entry -or $entry.Length -gt 100MB) { throw 'Missing or oversized backup entry.' }
        $stream = $entry.Open()
        try { $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() } finally { $stream.Dispose() }
        if ($hash -ne $item.sha256) { throw "Backup integrity failure: $($item.path)" }
        $entries[$target] = $entry
    }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($target in $entries.Keys) {
        New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[$target], $target, $false)
    }
} finally { $zip.Dispose() }
Set-Content -LiteralPath (Join-Path $Destination '.state\restore.pending') -Value 'Reset native sessions and derived indexes on first startup.'
Write-Output "Restored verified organization to $Destination. First startup resets native session handles; reconnect credentials and reindex knowledge. External codebases are not part of this backup."
