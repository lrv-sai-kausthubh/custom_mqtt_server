
$ErrorActionPreference = 'Stop'

# ------------------------------------------------------------
# 1. Read settings from the .env file beside this script
# ------------------------------------------------------------

$EnvPath = Join-Path $PSScriptRoot '.env'

if (-not (Test-Path -LiteralPath $EnvPath)) {
    throw "Missing .env file at '$EnvPath'."
}

$Config = @{}

foreach ($line in Get-Content -LiteralPath $EnvPath) {
    if ($line -match '^\s*([^#=\s]+)\s*=(.*)$') {
        $key = $Matches[1].Trim()
        $value = $Matches[2].Trim()

        # Remove matching surrounding quotes
        if (
            ($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))
        ) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        $Config[$key] = $value
    }
}

# ------------------------------------------------------------
# 2. Load configuration
# ------------------------------------------------------------

$SupabaseUrl = $Config['SUPABASE_URL']
$ServiceRoleKey = $Config['SUPABASE_SERVICE_ROLE_KEY']

$UserId = $Config['SUPABASE_TUNNEL_USER_ID']
$Table = $Config['SUPABASE_TUNNEL_TABLE']
$DiscoveryTable = $Config['SUPABASE_DISCOVERY_TABLE']

$Port = $Config['PORT']
if (-not $Port) {
    $Port = '3000'
}

$LocalUrl = "http://127.0.0.1:$Port"

if (-not $SupabaseUrl) {
    throw 'SUPABASE_URL is missing from .env.'
}

$SupabaseUrl = $SupabaseUrl.TrimEnd('/')

if (-not $ServiceRoleKey) {
    throw 'SUPABASE_SERVICE_ROLE_KEY is missing from .env.'
}

# Legacy service_role keys are JWTs and normally begin with eyJ.
if (-not $ServiceRoleKey.StartsWith('eyJ')) {
    throw 'SUPABASE_SERVICE_ROLE_KEY does not look like a legacy service_role JWT. Check that you copied the legacy service_role key, not a publishable or sb_secret key.'
}

if (-not $UserId) {
    $UserId = 'test_device_one'
}

if (-not $Table) {
    $Table = 'device_tunnels'
}

if (-not $DiscoveryTable) {
    $DiscoveryTable = 'app_discovery'
}

if ($Table -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw 'SUPABASE_TUNNEL_TABLE must be a simple table name.'
}

if ($DiscoveryTable -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw 'SUPABASE_DISCOVERY_TABLE must be a simple table name.'
}

# ------------------------------------------------------------
# 3. Find cloudflared
# ------------------------------------------------------------

$Cloudflared = Get-Command 'cloudflared.exe' -ErrorAction SilentlyContinue

if (-not $Cloudflared) {
    $Cloudflared = Get-Command 'cloudflared' -ErrorAction SilentlyContinue
}

if (-not $Cloudflared) {
    throw 'cloudflared was not found on PATH. Install it or add its folder to PATH.'
}

$CloudflaredPath = $Cloudflared.Source

# ------------------------------------------------------------
# 4. Prepare Supabase REST API headers
# ------------------------------------------------------------

# Use the legacy service_role key for server-side database access.
# Do not use this key in frontend JavaScript.
$SupabaseHeaders = @{
    'apikey'        = $ServiceRoleKey
    'Authorization' = "Bearer $ServiceRoleKey"
    'Content-Type'  = 'application/json'
    'Prefer'        = 'return=representation'
}

# ------------------------------------------------------------
# 5. Update the existing device_tunnels row
# ------------------------------------------------------------

function Update-TunnelRow([string]$TunnelUrl) {

    $EncodedUserId = [System.Uri]::EscapeDataString($UserId)
    $EncodedTable = [System.Uri]::EscapeDataString($Table)

    # Filter by the existing user_id. This does not insert a row.
    $Uri = "$SupabaseUrl/rest/v1/$EncodedTable`?user_id=eq.$EncodedUserId&select=id,user_id,tunnel_url,updated_at"

    $Body = @{
        tunnel_url = $TunnelUrl
        updated_at = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress

    $Result = Invoke-RestMethod `
        -Uri $Uri `
        -Method Patch `
        -Headers $SupabaseHeaders `
        -Body $Body `
        -TimeoutSec 20

    $Rows = @($Result)

    if ($Rows.Count -lt 1 -or -not $Rows[0].id) {
        throw "Supabase updated no rows. Confirm public.$Table contains an existing row with user_id '$UserId' and check its permissions."
    }

    Write-Host "[SUCCESS] Updated the existing Supabase row." -ForegroundColor Green
    Write-Host "Row ID: $($Rows[0].id)"
    Write-Host "User ID: $($Rows[0].user_id)"
    Write-Host "Tunnel URL: $($Rows[0].tunnel_url)"
}

# The static frontend reads this single row to discover the latest tunnel.
# A failure here must not stop the MQTT backend or the tunnel itself.
function Update-DiscoveryRow([string]$BackendUrl) {

    $EncodedDiscoveryTable = [System.Uri]::EscapeDataString($DiscoveryTable)
    $Uri = "$SupabaseUrl/rest/v1/$EncodedDiscoveryTable`?id=eq.true"

    $Body = @{
        backend_url = $BackendUrl
        updated_at  = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Compress

    $Result = Invoke-RestMethod `
        -Uri $Uri `
        -Method Patch `
        -Headers $SupabaseHeaders `
        -Body $Body `
        -TimeoutSec 20

    $Rows = @($Result)

    if ($Rows.Count -lt 1) {
        throw "Supabase updated no row in public.$DiscoveryTable. Run sql/tunnel_discovery.sql first."
    }

    Write-Host "[SUCCESS] Updated the public discovery row." -ForegroundColor Green
}

# ------------------------------------------------------------
# 6. Start the Quick Tunnel, capture its URL, and sync it
# ------------------------------------------------------------

while ($true) {

    Write-Host ""
    Write-Host "Starting Cloudflare Quick Tunnel for $LocalUrl ..." -ForegroundColor Cyan

    $RunId = [Guid]::NewGuid().ToString('N')

    $StdoutLog = Join-Path $env:TEMP "cloudflared-$RunId.stdout.log"
    $StderrLog = Join-Path $env:TEMP "cloudflared-$RunId.stderr.log"

    $Process = $null
    $Synced = $false
    $UrlCaptured = $false
    $TunnelUrl = $null

    $LastSyncAttempt = [DateTime]::MinValue
    $StartTime = Get-Date

    try {

        $Process = Start-Process `
            -FilePath $CloudflaredPath `
            -ArgumentList @(
                'tunnel',
                '--url',
                $LocalUrl,
                '--no-autoupdate'
            ) `
            -RedirectStandardOutput $StdoutLog `
            -RedirectStandardError $StderrLog `
            -PassThru `
            -WindowStyle Hidden

        while (-not $Process.HasExited) {

            # Read the logs to find the generated trycloudflare.com URL.
            $LogText = ''

            foreach ($LogPath in @($StdoutLog, $StderrLog)) {
                if (Test-Path -LiteralPath $LogPath) {
                    try {
                        $LogText += "`n" + (
                            Get-Content `
                                -LiteralPath $LogPath `
                                -Raw `
                                -ErrorAction SilentlyContinue
                        )
                    }
                    catch {
                        # Log file may still be in use by cloudflared.
                    }
                }
            }

            if (-not $UrlCaptured) {

                $UrlMatch = [regex]::Match(
                    $LogText,
                    'https://[a-z0-9-]+\.trycloudflare\.com'
                )

                if ($UrlMatch.Success) {
                    $TunnelUrl = $UrlMatch.Value.TrimEnd('.', ',', ')', ']')
                    $UrlCaptured = $true

                    Write-Host "Captured tunnel URL: $TunnelUrl" -ForegroundColor Green
                }
            }

            # Retry Supabase synchronization every 10 seconds until successful.
            if (
                $UrlCaptured -and
                -not $Synced -and
                (((Get-Date) - $LastSyncAttempt).TotalSeconds -ge 10)
            ) {

                $LastSyncAttempt = Get-Date

                try {
                    Update-TunnelRow -TunnelUrl $TunnelUrl

                    $Synced = $true

                    Write-Host 'The tunnel URL was saved to Supabase.' -ForegroundColor Green
                    Write-Host 'Your frontend can now retrieve the latest URL.' -ForegroundColor Green

                    try {
                        Update-DiscoveryRow -BackendUrl $TunnelUrl
                    }
                    catch {
                        Write-Host "[WARN] Tunnel works, but the discovery row was not updated: $($_.Exception.Message)" -ForegroundColor Yellow
                        Write-Host 'Run sql/tunnel_discovery.sql and restart this script to publish the URL.' -ForegroundColor Yellow
                    }
                }
                catch {
                    Write-Host "[ERROR] Could not update Supabase: $($_.Exception.Message)" -ForegroundColor Red
                    Write-Host 'Will retry while this tunnel remains active.' -ForegroundColor Yellow
                }
            }

            # If synchronization never succeeds, restart the tunnel process.
            if (
                -not $Synced -and
                ((Get-Date) - $StartTime).TotalSeconds -gt 90
            ) {
                Write-Host '[ERROR] No successful Supabase URL sync after 90 seconds; restarting tunnel.' -ForegroundColor Red

                $Process.Kill()
                break
            }

            Start-Sleep -Milliseconds 750
            $Process.Refresh()
        }
    }
    catch {
        Write-Host "[ERROR] Tunnel startup or monitoring failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    finally {

        if ($Process -and -not $Process.HasExited) {
            try {
                $Process.Kill()
                $Process.WaitForExit()
            }
            catch {}
        }

        Remove-Item `
            -LiteralPath $StdoutLog, $StderrLog `
            -Force `
            -ErrorAction SilentlyContinue
    }

    Write-Host 'Tunnel stopped. Restarting in 5 seconds...' -ForegroundColor Yellow
    Start-Sleep -Seconds 5
}
