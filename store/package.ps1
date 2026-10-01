# Windows-only maintainer packaging. No runtime build step or downloaded dependency.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$extension = Join-Path $root 'extension'
$source = Join-Path $PSScriptRoot 'icon-source.png'
if (!(Test-Path -LiteralPath $source)) { throw "Missing generated PNG: $source. No ZIP was created." }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$image = [System.Drawing.Image]::FromFile($source)
try {
    if ($image.RawFormat.Guid -ne [System.Drawing.Imaging.ImageFormat]::Png.Guid -or $image.Width -ne $image.Height -or $image.Width -lt 128) {
        throw 'Icon source must be a square PNG of at least 128 pixels.'
    }
    New-Item -ItemType Directory -Force (Join-Path $extension 'icons') | Out-Null
    foreach ($size in @(16, 32, 48, 128)) {
        $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($image, 0, 0, $size, $size)
            $bitmap.Save((Join-Path $extension "icons/icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $graphics.Dispose(); $bitmap.Dispose() }
    }
} finally { $image.Dispose() }
$manifestPath = Join-Path $extension 'manifest.json'
$manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
if ($manifest.manifest_version -ne 3 -or $manifest.version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw 'Unexpected manifest version.' }
foreach ($size in @(16, 32, 48, 128)) {
    if ($manifest.icons."$size" -ne "icons/icon$size.png") { throw "Manifest icon $size is missing." }
}
foreach ($size in @(16, 32)) {
    if ($manifest.action.default_icon."$size" -ne "icons/icon$size.png") { throw "Action icon $size is missing." }
}
# A fixed allowlist prevents test pages, secrets, browser profiles and store materials entering the ZIP.
$files = @('manifest.json', 'shared.js', 'background.js', 'jev.js', 'dom.js', 'evidence.js', 'placement.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', '_locales/zh_CN/messages.json', '_locales/zh/messages.json', '_locales/en/messages.json', 'fonts/SpaceGrotesk.woff2', 'fonts/OFL.txt', 'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png')
# The repo keeps one Chinese pack (zh, which Chrome also uses for zh-CN); the ZIP still ships zh_CN for the store listing.
$aliases = @{ '_locales/zh_CN/messages.json' = '_locales/zh/messages.json' }
function SourceOf($file) { Join-Path $extension $(if ($aliases.ContainsKey($file)) { $aliases[$file] } else { $file }) }
foreach ($file in $files) { if (!(Test-Path -LiteralPath (SourceOf $file))) { throw "Missing package file: $file" } }
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$destination = Join-Path $dist "pricelens-$($manifest.version).zip"
$temp = Join-Path $dist (([guid]::NewGuid().ToString()) + '.zip')
try {
    $zip = [System.IO.Compression.ZipFile]::Open($temp, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) { [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (SourceOf $file), $file, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null }
    } finally { $zip.Dispose() }
    $check = [System.IO.Compression.ZipFile]::OpenRead($temp)
    try { if (@(Compare-Object ($files | Sort-Object) ($check.Entries.FullName | Sort-Object)).Count) { throw 'ZIP file list mismatch.' } }
    finally { $check.Dispose() }
    Move-Item -LiteralPath $temp -Destination $destination -Force
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = ([System.BitConverter]::ToString($sha.ComputeHash([System.IO.File]::ReadAllBytes($destination)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    [System.IO.File]::WriteAllText("$destination.sha256", "$hash  $([System.IO.Path]::GetFileName($destination))`n", [System.Text.UTF8Encoding]::new($false))
    Write-Output "Created $destination ($($files.Count) files)"
    Write-Output "SHA256 $hash"
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
