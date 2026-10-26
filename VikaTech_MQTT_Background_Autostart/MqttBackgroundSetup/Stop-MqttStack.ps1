# Requests the supervisor to stop both child process trees.
$ProjectDir = 'C:\Users\Lenovo\Downloads\mqtt_server'
$StopRequest = Join-Path $ProjectDir 'Stop-MqttStack.request'
if (-not (Test-Path -LiteralPath $ProjectDir)) { throw "Project folder not found: $ProjectDir" }
New-Item -ItemType File -Path $StopRequest -Force | Out-Null
Write-Host 'Stop requested. The supervisor should stop the Node.js server and Cloudflare tunnel within a few seconds.' -ForegroundColor Yellow
