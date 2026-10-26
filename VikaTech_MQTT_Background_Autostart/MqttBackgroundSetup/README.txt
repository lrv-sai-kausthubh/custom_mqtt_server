VikaTech MQTT + Cloudflare Tunnel Windows background startup

WHAT THIS DOES
- Starts `npm.cmd start` and `start-tunnel.ps1` hidden in the background.
- Runs at Windows startup, before you open a terminal.
- Works while the desktop is locked and can run when you are not logged in.
- Checks for exited/failed processes every 5 seconds and retries that process after 45 seconds.
- Keeps separate stdout/stderr logs for each process run.
- Task Scheduler also restarts the supervisor if the supervisor itself exits unexpectedly.

CURRENT SCRIPTS
- The scheduled task runs C:\Users\Lenovo\Downloads\mqtt_server\Run-MqttStack.ps1.
- That supervisor launches `npm.cmd start` and the project root `start-tunnel.ps1` every time it starts.
- You do not need to reinstall the task when `server.js`, `start-tunnel.ps1`, `.env`, or the frontend changes. Restart the task instead.
- `start-tunnel.ps1` accepts both the main `SUPABASE_*` names and the older `DISCOVERY_*` names. Use `DISCOVERY_*` only when the discovery table is in a separate Supabase project.

IMPORTANT LIMITS
- A laptop that is fully powered off cannot run anything. The task starts after Windows boots.
- If Windows sleeps/hibernates, server and tunnel work may pause until it wakes. Change Windows power settings if the laptop must remain available continuously.
- The tunnel script and Node server still need to handle their own network reconnects while the processes stay alive. The supervisor restarts a process when it exits; it does not detect every possible hung-but-still-running process.
- A temporary Cloudflare Quick Tunnel (`trycloudflare.com`) usually gets a different URL after a tunnel restart. Your start-tunnel.ps1 must update the app_discovery row correctly on each new URL. For production reliability, use a named tunnel and stable hostname.
- If Node.js or cloudflared is available only because your interactive PowerShell profile sets PATH/variables, the background task may not inherit those settings. Configure them in the Windows environment or inside the script.

INSTALL
1. Extract all files from this ZIP.
2. Open PowerShell as Administrator.
3. Run:
   powershell.exe -ExecutionPolicy Bypass -File ".\Install-MqttStackAutostart.ps1"
4. Enter your Windows account password when prompted. Use the password, not a Windows Hello PIN. This lets Task Scheduler run while you are logged out.
5. It starts immediately; you do not need to reboot to test.

The scripts assume the project folder is:
C:\Users\Lenovo\Downloads\mqtt_server
If yours is different, edit `$ProjectDir` in the scripts before installing.

CHECK STATUS
- Open Task Scheduler -> Task Scheduler Library -> VikaTech-MQTT-and-Cloudflare-Tunnel.
- Check Status and Last Run Result.
- Review logs in:
  C:\Users\Lenovo\Downloads\mqtt_server\background-logs\
  supervisor.log records starts, exits, and retry times.

RESTART AFTER UPDATES
Use an elevated PowerShell window. This lets the supervisor stop its child process trees cleanly before the task starts again:

  $task = 'VikaTech-MQTT-and-Cloudflare-Tunnel'
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\Users\Lenovo\Downloads\mqtt_server\Stop-MqttStack.ps1"
  Start-Sleep -Seconds 10
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $task
  Start-Sleep -Seconds 20
  Get-ScheduledTask -TaskName $task | Select-Object TaskName,State
  Get-Content 'C:\Users\Lenovo\Downloads\mqtt_server\background-logs\supervisor.log' -Tail 20

Do not run Install-MqttStackAutostart.ps1 just to pick up code changes. The task already points to the root Run-MqttStack.ps1, and that supervisor launches the current start-tunnel.ps1 and server.js. Reinstall only if Run-MqttStack.ps1, Stop-MqttStack.ps1, Install-MqttStackAutostart.ps1, the task user, or the schedule itself changes.

A Cloudflare Quick Tunnel gets a new URL when it restarts. start-tunnel.ps1 updates app_discovery automatically. If a browser has a saved backend URL, clear it or update it.

VERIFY
  Get-NetTCPConnection -State Listen -LocalPort 3000
  Get-Process node,cloudflared
  Get-Content 'C:\Users\Lenovo\Downloads\mqtt_server\background-logs\supervisor.log' -Tail 20

STOP TEMPORARILY
Run PowerShell:
  powershell.exe -ExecutionPolicy Bypass -File "C:\Users\Lenovo\Downloads\mqtt_server\Stop-MqttStack.ps1"
The auto-start task remains installed, but the current supervisor exits. On the next reboot the supervisor starts normally again.

UNINSTALL AUTO-START
Run PowerShell as Administrator:
  powershell.exe -ExecutionPolicy Bypass -File "C:\Users\Lenovo\Downloads\mqtt_server\Uninstall-MqttStackAutostart.ps1"

TEST
- After installation, make sure no manually launched `npm start` or `start-tunnel.ps1` copies are still running, to avoid port conflicts or duplicate tunnels.
- Lock Windows (Win+L), wait, unlock, and check the logs.
- Reboot once and confirm the task starts automatically.
