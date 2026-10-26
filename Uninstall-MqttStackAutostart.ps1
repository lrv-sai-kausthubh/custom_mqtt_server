# Removes the auto-start task and requests the server/tunnel processes to stop.
$ErrorActionPreference = 'Continue'
$ProjectDir = 'C:\Users\Lenovo\Downloads\mqtt_server'
$TaskName = 'VikaTech-MQTT-and-Cloudflare-Tunnel'
$StopRequest = Join-Path $ProjectDir 'Stop-MqttStack.request'
if (Test-Path -LiteralPath $ProjectDir) {
    New-Item -ItemType File -Path $StopRequest -Force | Out-Null
}
try {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {}
Write-Host "Removed startup task '$TaskName'." -ForegroundColor Green
Write-Host 'The supervisor stop request was sent. If child processes remain, check Task Manager and the background-logs folder.'
