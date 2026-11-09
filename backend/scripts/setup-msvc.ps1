#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$toolRoot = Join-Path $projectRoot '.tools/msvc'
$temporary = Join-Path $projectRoot '.tools/tmp'
$packageCache = Join-Path $projectRoot '.tools/vsc'
if ($packageCache.Length -gt 50) { throw 'Visual Studio package cache path must not exceed 50 characters; use a shorter project path.' }
New-Item -ItemType Directory -Force -Path $toolRoot, $temporary | Out-Null
$env:TEMP = $temporary
$env:TMP = $temporary
$env:TMPDIR = $temporary
$installer = Join-Path $temporary 'vs_buildtools.exe'
Start-Transcript -Path (Join-Path $temporary 'msvc-setup.log') -Append
try {
    # Official VS 2022 bootstrapper. Install/cache/shared paths are selected on first install.
    # Microsoft installer services and some SDK components may still use the system drive.
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://aka.ms/vs/17/release/vs_buildtools.exe' -OutFile $installer -TimeoutSec 180
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw 'Build Tools bootstrapper must have a valid Microsoft signature'
    }
    $arguments = @('--quiet', '--wait', '--norestart',
        '--installPath', ('"' + (Join-Path $toolRoot 'install') + '"'),
        '--path', ('cache="' + $packageCache + '"'),
        '--path', ('shared="' + (Join-Path $toolRoot 'shared') + '"'),
        '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '--add', 'Microsoft.VisualStudio.Component.Windows11SDK.26100')
    Write-Output ('Installing MSVC and Windows SDK under ' + $toolRoot)
    $process = Start-Process -FilePath $installer -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -notin @(0, 3010)) { throw ('MSVC installation failed with exit code ' + $process.ExitCode) }
    if ($process.ExitCode -eq 3010) { Write-Output 'Installer requests a reboot; no reboot performed.' }
    Write-Output ('Installer completed with exit code ' + $process.ExitCode + '; verify a real Rust link before claiming readiness.')
} catch {
    Write-Output $_
    exit 1
} finally {
    Stop-Transcript
}
