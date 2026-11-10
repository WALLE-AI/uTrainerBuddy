#Requires -RunAsAdministrator
param([switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$temporary = Join-Path $projectRoot '.tools/tmp'
New-Item -ItemType Directory -Force -Path $temporary | Out-Null
$env:TEMP = $temporary
$env:TMP = $temporary
$env:TMPDIR = $temporary
$wsl = Join-Path $env:SystemRoot 'System32/wsl.exe'
$stdout = Join-Path $temporary 'wsl-install.stdout.log'
$stderr = Join-Path $temporary 'wsl-install.stderr.log'
# Install only the Windows runtime. A project-owned Linux image is a separate step.
# No default distribution, automatic Linux launch, or system reboot.
$resultPath = Join-Path $temporary 'wsl-install-result.json'
if ($InspectOnly) {
    $installExitCode = (Get-Content -Raw -LiteralPath $resultPath | ConvertFrom-Json).exitCode
} else {
    $process = Start-Process -FilePath $wsl -ArgumentList @('--install', '--no-distribution', '--web-download') -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    $installExitCode = $process.ExitCode
}
$features = @{}
foreach ($name in @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')) {
    $features[$name] = [string](Get-WindowsOptionalFeature -Online -FeatureName $name).State
}
$windowsRebootPending = (Test-Path 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/Component Based Servicing/RebootPending') -or (Test-Path 'HKLM:/SOFTWARE/Microsoft/Windows/CurrentVersion/WindowsUpdate/Auto Update/RebootRequired')
$result = [ordered]@{
    recordedAt = (Get-Date).ToUniversalTime().ToString('o')
    exitCode = $installExitCode
    features = $features
    windowsRebootPending = $windowsRebootPending
    rebootRequired = ($installExitCode -eq 3010 -or $features.Values -contains 'EnablePending' -or $windowsRebootPending)
    distributionCreated = $false
    linuxAcceptancePassed = $false
    stdout = $stdout
    stderr = $stderr
}
$result | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 -LiteralPath $resultPath
if ($installExitCode -notin @(0, 3010)) { throw ('WSL installation failed with exit code ' + $installExitCode + '; inspect ' + $stdout + ' and ' + $stderr) }
Write-Output 'WSL installation state recorded; verify Linux execution separately.'
if ($result.rebootRequired) { Write-Output 'A Windows restart is required. No restart was performed.' }
