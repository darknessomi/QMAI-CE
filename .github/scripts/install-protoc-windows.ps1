$ErrorActionPreference = 'Stop'

$archiveUrl = 'https://github.com/protocolbuffers/protobuf/releases/download/v23.4/protoc-23.4-win64.zip'
$expectedHash = 'a309c39442fb75f0db343cb22c111a00f91cdf0767f332e170644b9378e2bcc6'
$archivePath = Join-Path $env:RUNNER_TEMP 'protoc-23.4-win64.zip'
$installDir = Join-Path $env:RUNNER_TEMP 'protoc-23.4-win64'

Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
$actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
if ($actualHash -ne $expectedHash) {
    throw "protoc 23.4 压缩包 SHA-256 校验失败。预期 $expectedHash，实际 $actualHash。"
}

Expand-Archive -LiteralPath $archivePath -DestinationPath $installDir -Force
$binDir = Join-Path $installDir 'bin'
if (-not (Test-Path -LiteralPath (Join-Path $binDir 'protoc.exe') -PathType Leaf)) {
    throw 'protoc 23.4 压缩包中缺少 bin/protoc.exe。'
}
Add-Content -LiteralPath $env:GITHUB_PATH -Value $binDir -Encoding utf8
