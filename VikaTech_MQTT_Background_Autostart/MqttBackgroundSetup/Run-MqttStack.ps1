# Runs the MQTT Node.js server and Cloudflare tunnel in the background.
# Install this file into C:\Users\Lenovo\Downloads\mqtt_server.

$ErrorActionPreference = 'Stop'
$ProjectDir = 'C:\Users\Lenovo\Downloads\mqtt_server'
$TunnelScript = Join-Path $ProjectDir 'start-tunnel.ps1'
$StopRequest = Join-Path $ProjectDir 'Stop-MqttStack.request'
$LogDir = Join-Path $ProjectDir 'background-logs'
$SupervisorLog = Join-Path $LogDir 'supervisor.log'
$RetrySeconds = 45
$CheckEverySeconds = 5

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

# Clear a stale stop request left by a previous manual stop.
if (Test-Path -LiteralPath $StopRequest) {
    Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
}

function Write-SupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)
    $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Add-Content -LiteralPath $SupervisorLog -Value $line -Encoding UTF8
}

function Get-LogPath {
    param([string]$Name, [string]$Stream)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    return (Join-Path $LogDir (('{0}-{1}-{2}.log') -f $Name, $stamp, $Stream))
}

function Stop-ProcessTree {
    param([System.Diagnostics.Process]$Process, [string]$Name)
    if ($null -eq $Process) { return }
    try {
        if (-not $Process.HasExited) {
            Write-SupervisorLog "Stopping $Name process tree (PID $($Process.Id))."
            & "$env:WINDIR\System32\taskkill.exe" /PID $Process.Id /T /F 2>&1 | Out-Null
        }
    } catch {
        Write-SupervisorLog "WARN: could not stop $Name process tree: $($_.Exception.Message)"
    }
}

function Start-NodeServer {
    $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand -or [string]::IsNullOrWhiteSpace($npmCommand.Source)) {
        $fallbacks = @(
            (Join-Path $env:ProgramFiles 'nodejs\npm.cmd'),
            (Join-Path ${env:ProgramFiles(x86)} 'nodejs\npm.cmd'),
            (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\npm.cmd')
        )
        $npmPath = $null
        foreach ($candidate in $fallbacks) {
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
                $npmPath = $candidate
                break
            }
        }
        if (-not $npmPath) { throw 'npm.cmd was not found. Install Node.js or add its folder to the Windows PATH.' }
    } else {
        $npmPath = $npmCommand.Source
    }

    $outLog = Get-LogPath 'mqtt-server' 'stdout'
    $errLog = Get-LogPath 'mqtt-server' 'stderr'
    # cmd.exe quoting form: /d /s /c ""C:\Program Files\nodejs\npm.cmd" start"
    $cmdArgs = '/d /s /c ""{0}" start"' -f $npmPath
    $process = Start-Process -FilePath "$env:WINDIR\System32\cmd.exe" `
        -ArgumentList $cmdArgs -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -WindowStyle Hidden -PassThru
    Write-SupervisorLog "Started npm start (PID $($process.Id)); stdout=$outLog; stderr=$errLog"
    return $process
}

function Start-Tunnel {
    if (-not (Test-Path -LiteralPath $TunnelScript)) {
        throw "Tunnel script not found: $TunnelScript"
    }
    $powershellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $outLog = Get-LogPath 'cloudflare-tunnel' 'stdout'
    $errLog = Get-LogPath 'cloudflare-tunnel' 'stderr'
    $args = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $TunnelScript
    $process = Start-Process -FilePath $powershellExe `
        -ArgumentList $args -WorkingDirectory $ProjectDir `
        -RedirectStandardOutput $outLog -RedirectStandardError $errLog `
        -WindowStyle Hidden -PassThru
    Write-SupervisorLog "Started start-tunnel.ps1 (PID $($process.Id)); stdout=$outLog; stderr=$errLog"
    return $process
}

if (-not (Test-Path -LiteralPath $ProjectDir)) {
    Write-SupervisorLog "FATAL: project folder not found: $ProjectDir"
    exit 2
}
if (-not (Test-Path -LiteralPath (Join-Path $ProjectDir 'package.json'))) {
    Write-SupervisorLog "FATAL: package.json not found in $ProjectDir"
    exit 2
}

# Keep one instance of each child process. The server's MQTT client and cloudflared
# should handle transient network reconnects themselves; this supervisor restarts
# either process if it exits or fails to launch.
$nodeProcess = $null
$tunnelProcess = $null
$nodeNextStart = Get-Date
$tunnelNextStart = (Get-Date).AddSeconds(8)
Write-SupervisorLog 'Supervisor started. Child processes will be restarted 45 seconds after exit/failure.'

while ($true) {
    if (Test-Path -LiteralPath $StopRequest) {
        Write-SupervisorLog 'Stop request received.'
        Stop-ProcessTree -Process $nodeProcess -Name 'MQTT server'
        Stop-ProcessTree -Process $tunnelProcess -Name 'Cloudflare tunnel'
        Write-SupervisorLog 'Supervisor stopped by request.'
        Remove-Item -LiteralPath $StopRequest -Force -ErrorAction SilentlyContinue
        exit 0
    }

    $now = Get-Date

    if ($null -ne $nodeProcess) {
        try {
            if ($nodeProcess.HasExited) {
                $exitCode = $nodeProcess.ExitCode
                Write-SupervisorLog "MQTT server process exited with code $exitCode. Retry in $RetrySeconds seconds."
                $nodeProcess.Dispose()
                $nodeProcess = $null
                $nodeNextStart = $now.AddSeconds($RetrySeconds)
            }
        } catch {
            Write-SupervisorLog "WARN: error checking MQTT server process: $($_.Exception.Message)"
        }
    }

    if ($null -eq $nodeProcess -and $now -ge $nodeNextStart) {
        try {
            $nodeProcess = Start-NodeServer
        } catch {
            Write-SupervisorLog "ERROR: failed to start MQTT server: $($_.Exception.Message). Retry in $RetrySeconds seconds."
            $nodeNextStart = (Get-Date).AddSeconds($RetrySeconds)
        }
    }

    if ($null -ne $tunnelProcess) {
        try {
            if ($tunnelProcess.HasExited) {
                $exitCode = $tunnelProcess.ExitCode
                Write-SupervisorLog "Cloudflare tunnel process exited with code $exitCode. Retry in $RetrySeconds seconds."
                $tunnelProcess.Dispose()
                $tunnelProcess = $null
                $tunnelNextStart = $now.AddSeconds($RetrySeconds)
            }
        } catch {
            Write-SupervisorLog "WARN: error checking tunnel process: $($_.Exception.Message)"
        }
    }

    if ($null -eq $tunnelProcess -and $now -ge $tunnelNextStart) {
        try {
            $tunnelProcess = Start-Tunnel
        } catch {
            Write-SupervisorLog "ERROR: failed to start Cloudflare tunnel: $($_.Exception.Message). Retry in $RetrySeconds seconds."
            $tunnelNextStart = (Get-Date).AddSeconds($RetrySeconds)
        }
    }

    Start-Sleep -Seconds $CheckEverySeconds
}
