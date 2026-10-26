
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

# The discovery row may live in a separate Supabase project. Prefer the
# explicit DISCOVERY_* values used by the older bridge-only copy, then fall
# back to the main SUPABASE_* values used by this project.
$SupabaseUrl = $Config['DISCOVERY_SUPABASE_URL']
if (-not $SupabaseUrl) {
    $SupabaseUrl = $Config['SUPABASE_URL']
}

$ServiceRoleKey = $Config['DISCOVERY_SUPABASE_SERVICE_ROLE_KEY']
if (-not $ServiceRoleKey) {
    $ServiceRoleKey = $Config['SUPABASE_SERVICE_ROLE_KEY']
}
if (-not $ServiceRoleKey) {
    $ServiceRoleKey = $Config['SUPABASE_SECRET_KEY']
}

$UserId = $Config['SUPABASE_TUNNEL_USER_ID']
$Table = $Config['SUPABASE_TUNNEL_TABLE']
$DiscoveryTable = $Config['DISCOVERY_TABLE']
if (-not $DiscoveryTable) {
    $DiscoveryTable = $Config['SUPABASE_DISCOVERY_TABLE']
}

$Port = $Config['PORT']
if (-not $Port) {
    $Port = '3000'
}

$LocalUrl = "http://127.0.0.1:$Port"

if (-not $SupabaseUrl) {
    throw 'DISCOVERY_SUPABASE_URL or SUPABASE_URL is missing from .env.'
}

$SupabaseUrl = $SupabaseUrl.TrimEnd('/')

if (-not $ServiceRoleKey) {
    throw 'DISCOVERY_SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_SECRET_KEY is missing from .env.'
}

# Supabase projects may use either legacy JWT service_role keys or the newer
# sb_secret server-only keys. Both are valid for the REST API; never use a
# publishable/anon key here because this script updates app_discovery.
if (-not ($ServiceRoleKey.StartsWith('eyJ') -or $ServiceRoleKey.StartsWith('sb_secret_'))) {
    throw 'The server-only Supabase key must be a legacy service_role JWT or an sb_secret key.'
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
    throw 'DISCOVERY_TABLE or SUPABASE_DISCOVERY_TABLE must be a simple table name.'
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

# Use a server-only Supabase key for database access.
# Do not use this key in frontend JavaScript.
$SupabaseHeaders = @{
    'apikey'        = $ServiceRoleKey
    'Authorization' = "Bearer $ServiceRoleKey"
    'Content-Type'  = 'application/json'
    'Prefer'        = 'return=representation'
}

# ------------------------------------------------------------
# 5. Update tunnel discovery rows
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

# app_discovery is the canonical row read by the Edge Function and ESP32.
# The row must already exist; this script updates it whenever the tunnel URL
# changes. The legacy device_tunnels row above is optional.
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
                    # app_discovery is the canonical row used by the Edge
                    # Function and ESP32. device_tunnels is legacy/optional.
                    try {
                        Update-TunnelRow -TunnelUrl $TunnelUrl
                    }
                    catch {
                        Write-Host "[WARN] Legacy device_tunnels row was not updated: $($_.Exception.Message)" -ForegroundColor Yellow
                    }

                    Update-DiscoveryRow -BackendUrl $TunnelUrl
                    $Synced = $true

                    Write-Host 'The app_discovery tunnel URL was saved to Supabase.' -ForegroundColor Green
                    Write-Host 'The Edge Function and ESP32 will use this URL on their next refresh.' -ForegroundColor Green
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
