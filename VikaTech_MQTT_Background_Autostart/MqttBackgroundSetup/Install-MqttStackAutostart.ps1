# Run this script from an elevated PowerShell window.
# It copies the supervisor into the MQTT project folder and registers a task
# that starts at boot, whether or not the Windows user is logged in.

$ErrorActionPreference = 'Stop'
$ProjectDir = 'C:\Users\Lenovo\Downloads\mqtt_server'
$TaskName = 'VikaTech-MQTT-and-Cloudflare-Tunnel'
$SupervisorSource = Join-Path $PSScriptRoot 'Run-MqttStack.ps1'
$StopSource = Join-Path $PSScriptRoot 'Stop-MqttStack.ps1'
$UninstallSource = Join-Path $PSScriptRoot 'Uninstall-MqttStackAutostart.ps1'

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if (-not (Test-Path -LiteralPath $ProjectDir)) {
    throw "Project folder not found: $ProjectDir. Edit `$ProjectDir in this installer if your folder is different."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'package.json'))) {
    throw "package.json not found in $ProjectDir. Make sure this is the mqtt_server folder."
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'start-tunnel.ps1'))) {
    throw "start-tunnel.ps1 was not found in $ProjectDir."
}
if (-not (Test-Path -LiteralPath $SupervisorSource)) {
    throw "Run-MqttStack.ps1 not found beside this installer. Extract the whole ZIP first."
}

Copy-Item -LiteralPath $SupervisorSource -Destination (Join-Path $ProjectDir 'Run-MqttStack.ps1') -Force
if (Test-Path -LiteralPath $StopSource) {
    Copy-Item -LiteralPath $StopSource -Destination (Join-Path $ProjectDir 'Stop-MqttStack.ps1') -Force
}
if (Test-Path -LiteralPath $UninstallSource) {
    Copy-Item -LiteralPath $UninstallSource -Destination (Join-Path $ProjectDir 'Uninstall-MqttStackAutostart.ps1') -Force
}

$powerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$supervisorPath = Join-Path $ProjectDir 'Run-MqttStack.ps1'
$action = New-ScheduledTaskAction -Execute $powerShellExe `
    -Argument ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $supervisorPath) `
    -WorkingDirectory $ProjectDir
$trigger = New-ScheduledTaskTrigger -AtStartup -RandomDelay (New-TimeSpan -Seconds 20)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

Write-Host ''
Write-Host "Task name: $TaskName" -ForegroundColor Cyan
Write-Host "Runs as:   $identity"
Write-Host 'Windows will ask for the account password so this can run while you are logged out.' -ForegroundColor Yellow
Write-Host 'Use the actual Windows account password, not the Windows Hello PIN.' -ForegroundColor Yellow
$credential = Get-Credential -UserName $identity -Message 'Enter the Windows account password for the background startup task'
if ($null -eq $credential) { throw 'No credential supplied; task was not registered.' }

Register-ScheduledTask -TaskName $TaskName `
    -Description 'Runs the VikaTech MQTT Node.js server and Cloudflare tunnel hidden at system startup; restarts failed child processes.' `
    -Action $action -Trigger $trigger -Settings $settings `
    -User $credential.UserName `
    -Password $credential.GetNetworkCredential().Password `
    -RunLevel Highest -Force | Out-Null

# Start the task now, too; there is no need to reboot to test it.
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 3
$task = Get-ScheduledTask -TaskName $TaskName
Write-Host ''
Write-Host 'Installed and started the background task.' -ForegroundColor Green
Write-Host "Project: $ProjectDir"
Write-Host "Logs:    $(Join-Path $ProjectDir 'background-logs')"
Write-Host "Task Scheduler: $TaskName"
Write-Host 'Test it by locking the laptop, then checking logs after unlocking.'
Write-Host 'If the task fails to launch, open Task Scheduler and check Last Run Result.'
