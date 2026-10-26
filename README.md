# MQTT backend — local accounts, approval-based access, ESP32 gateway

This project keeps Mosquitto private on the laptop. Express connects to Mosquitto using backend-only credentials.

Supabase is used **only as a database**. Supabase Auth, Supabase email, confirmation links and rate-limited email delivery are not used anywhere in this project.

Accounts are created locally in two tables:

- `public.app_users` — email, scrypt password hash, approval status, role.
- `public.app_sessions` — opaque sign-in sessions issued only to approved accounts.

Anyone may register. New accounts are created with `status = 'pending'` and **receive no session**, so they cannot sign in, open a Socket.IO connection, or publish MQTT messages. An administrator approves or rejects them from the website's admin panel. While pending, a user sees the pending message on the sign-in screen when they try to sign in. No email is sent at any point.

## What changed in the `custom_mqtt_server` update

- `deviceGateway.js` was added: an ESP32 WebSocket gateway plus a signed HTTP command endpoint. It also deduplicates overlapping Mosquitto deliveries so the ESP32 does not receive the same relay command twice when a browser is tuned to `home/#`.
- `server.js` now loads `deviceGateway.js`, keeps the raw JSON body for HMAC verification, and closes the gateway during shutdown.
- `package.json` / `package-lock.json` now declare `ws` directly. It is required by `deviceGateway.js`; relying on the MQTT client's transitive dependency is fragile.
- `start-tunnel.ps1` now treats `app_discovery` as the canonical discovery row. The legacy `device_tunnels` update is optional, either a legacy `service_role` JWT or a newer `sb_secret_...` key is accepted, and the older `DISCOVERY_*` environment names are still supported.
- `.env.example` was added and the real `.env` now contains the device-gateway secrets.
- `public/` and `sql/` did not need code changes: the browser UI is still the approved-user MQTT console, and the existing `tunnel_discovery.sql` already creates the `app_discovery` row used by the Edge Function and ESP32.

## 1. Files

```
mqtt_server/
├── server.js                   <-- HTTP + Socket.IO + MQTT bridge
├── deviceGateway.js            <-- ESP32 WebSocket + signed command endpoint
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── logs.html               <-- admin server-log viewer
│   ├── logs.js
│   ├── socket.io.min.js        <-- browser Socket.IO client
│   └── config.js               <-- frontend/backend discovery settings
├── sql/
│   ├── app_auth_setup.sql      <-- run this one
│   ├── tunnel_discovery.sql    <-- run this one for a separate frontend / ESP32
│   └── supa_base_setup.sql     <-- old Supabase Auth version, no longer used
├── esp32/
│   └── device_gateway_example/ <-- known-good ESP32 WebSocket example
├── start-tunnel.ps1
├── package.json
├── .env.example
└── .env                        <-- secrets, never commit
```

## 2. Install packages

From the project directory in PowerShell:

```powershell
npm.cmd install
```

This project expects Node.js 20 or newer. Password hashing uses Node's built-in `crypto.scrypt`, so no extra auth package is required. `ws` is installed as a direct dependency for the device gateway.

## 3. Create the database tables

1. Open Supabase Dashboard -> SQL Editor.
2. Run `sql/app_auth_setup.sql`.
3. Run `sql/tunnel_discovery.sql`.
4. Register your own account on the website with the **Create account** tab.
5. Run the one-time administrator `UPDATE` at the bottom of `sql/app_auth_setup.sql`, replacing `YOUR_ADMIN_EMAIL` with that account's email.
6. Sign in. The admin panel appears.

The SQL enables RLS and revokes all access from the `anon` and `authenticated` roles. Only the backend's service-role key can read or write the account tables, so password hashes are never exposed to a browser. The discovery table exposes only `backend_url`.

**No new table is required for the device gateway.** It keeps board sockets in memory and uses MQTT topics for relay commands.

## 4. Configure `.env`

A complete sample is in `.env.example`. Required values:

- `SUPABASE_URL` — your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` **or** `SUPABASE_SECRET_KEY` — server-only key used for database access. Both names are accepted. Use a legacy `service_role` JWT (`eyJ...`) or a newer `sb_secret_...` key. Never use the anon/publishable key here.
- `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` — the Mosquitto account used by the backend.
- `DEVICE_WS_TOKEN` — shared only with the ESP32 firmware. The gateway refuses to start if this is empty.
- `MQTT_INGEST_SECRET` — shared only with the Supabase `mqtt-dispatch` Edge Function. The gateway refuses to start if this is empty.
- `DEVICE_WS_PATH` — optional, default `/device`.
- `DEVICE_HEARTBEAT_MS` — optional, default `15000`, minimum `5000`.
- `AUTH_SESSION_DAYS` — optional session lifetime, default `7`, maximum `30`.
- `LOG_BUFFER_LIMIT` — optional number of entries kept for the admin log viewer, default `1000`, allowed range `100`–`5000`.
- `ALLOWED_ORIGINS` — browser origins allowed to call the API and Socket.IO. Use `*` while testing a Vercel preview, then replace it with exact origins such as `https://app.niat.tech,https://your-app.vercel.app`.
- `DISCOVERY_SUPABASE_URL`, `DISCOVERY_SUPABASE_SERVICE_ROLE_KEY`, `DISCOVERY_TABLE` — optional aliases used by `start-tunnel.ps1` when the discovery table lives in a different Supabase project. They take precedence over the main `SUPABASE_*` values.

The Supabase anon key is not used by the backend. The static frontend's `public/config.js` uses it only to read the single `public.app_discovery` row. `start-tunnel.ps1` uses the server-only key for its tunnel updates.

Do not copy `.env` into `public/` or share it.

## 5. Start the backend

```powershell
npm.cmd start
```

Check `http://127.0.0.1:3000/api/status`. It should return JSON with `server` and MQTT connection status.

### Server logs UI

After signing in as an administrator, open:

```text
http://127.0.0.1:3000/logs.html
```

or, through the tunnel:

```text
https://<current-tunnel-host>/logs.html
```

The **Server logs** button in the admin panel opens the same page. It uses the existing `homelink.session` token from `localStorage`; it does not need a separate password or a new database table.

The viewer shows the last `LOG_BUFFER_LIMIT` entries (default 1000) and updates live over Socket.IO. It supports level filtering, text search, pause/resume, auto-scroll, copy, and clearing the view. Logs are in memory only and reset when the backend restarts. Session tokens and passwords are never written to the log.

The same buffer is available as JSON for scripts:

```text
GET /api/admin/logs?limit=200
Authorization: Bearer <admin session token>
```

`LOG_LEVEL` still controls which entries are captured. Leave it at `info` for normal use; set `debug` to include Socket.IO polling and successful auth checks.

## 6. Start the tunnel

Open a second PowerShell window in this project directory:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\start-tunnel.ps1
```

The script reads `.env`, starts a Cloudflare Quick Tunnel to `127.0.0.1:3000`, and updates the single `public.app_discovery` row with `backend_url`. It also tries to update the legacy `public.device_tunnels` row when it exists; a failure there only prints a warning. The frontend, the Edge Function and the ESP32 all discover the current tunnel through `app_discovery`.

`start-tunnel.ps1` accepts both the main `SUPABASE_*` names and the older `DISCOVERY_SUPABASE_URL`, `DISCOVERY_SUPABASE_SERVICE_ROLE_KEY`, and `DISCOVERY_TABLE` names used by the bridge-only copy. If both sets are present, the `DISCOVERY_*` values are used. This is useful when `app_discovery` lives in a separate Supabase project from the account tables.

Run `sql/tunnel_discovery.sql` once before the first tunnel start, then restart `start-tunnel.ps1` so the row is populated.

Quick Tunnels are suitable for development; the URL changes on restart and anyone who knows the URL can reach the public HTTP service. The approval checks below still apply.

## 7. Hosting the frontend separately (Vercel / niat.tech)

`public/index.html`, `public/styles.css`, `public/app.js`, `public/socket.io.min.js` and `public/config.js` are plain static files. Copy them to Vercel or any static host.

On startup the frontend finds the backend in this order:

1. A backend URL saved in the browser's **Connection settings**.
2. `backendUrl` in `public/config.js`.
3. The latest `backend_url` from the Supabase `app_discovery` table.
4. Same origin, which is correct only when the backend serves the page.

For Quick Tunnels, leave `backendUrl` empty and let discovery work. For a stable named tunnel, set `backendUrl` to something like `https://mqtt.niat.tech` in `config.js` and skip discovery.

`public/config.js` already contains the Supabase project URL and public anon key for the discovery read. That key is safe in a browser because `app_discovery` only exposes `backend_url`, and the account tables remain locked to the service role. Keep RLS enabled on every other public table before deploying, because anon keys are public by design.

After a tunnel restart, reload the frontend page so it discovers the new URL.

## 8. ESP32 device gateway

### WebSocket connection

The ESP32 connects to the backend over WSS and does **not** need MQTT credentials:

```
wss://<tunnel-host>/device?board=<boardId>
X-Device-Token: <DEVICE_WS_TOKEN>
```

- `boardId` must match `[A-Za-z0-9_-]{1,64}`.
- Send the token in the `x-device-token` header when possible. A `?token=` query parameter is also accepted, but headers are less likely to appear in proxy logs.
- Local development can use `ws://127.0.0.1:3000/device?board=test_board`.
- Cloudflare Quick Tunnels support WebSocket upgrades; no extra tunnel configuration is needed.
- `DEVICE_WS_TOKEN` is a single shared device token, not a per-board credential. Treat board IDs as public identifiers and rotate the token if it leaks.

The server sends JSON messages:

```json
{ "type": "hello", "board": "test_board", "mqtt": "connected", "ts": "..." }
{ "type": "heartbeat", "mqtt": "connected", "ts": "..." }
{ "type": "mqtt", "topic": "home/test_board/device/0/set", "payload": "..." }
```

The ESP32 may reply with `{ "type": "pong" }`. The server only broadcasts downlink MQTT commands; it does not accept arbitrary publish operations from the device.

### ESP32 firmware rules (read this if it reconnects constantly)

The gateway is **JSON over WebSocket**, not an MQTT broker. The most common mistake is sending MQTT bytes or raw JSON to the socket instead of a WebSocket text frame.

- Send JSON with `webSocket.sendTXT(...)`. Do **not** use `client.print(...)`, `client.write(...)`, or raw `WiFiClientSecure` writes after the upgrade.
- Use `sendTXT` for JSON, not `sendBIN`.
- Do **not** call `webSocket.enableHeartbeat(...)`. Some `arduinoWebSockets` versions corrupt frame headers when the heartbeat and a send call overlap, producing `Invalid WebSocket frame: RSV2 and RSV3 must be clear`. The backend already sends a JSON heartbeat every `DEVICE_HEARTBEAT_MS`; answer it with `{"type":"pong"}`.
- Keep every `sendTXT` and `webSocket.loop()` call on the same task. If another RTOS task needs to send, queue the message and drain the queue from `loop()`.
- Do not send MQTT `CONNECT`/`PUBLISH` packets. If your firmware uses an MQTT-over-WebSocket client, it must connect to Mosquitto's WebSocket listener, not to `/device`.

A known-good Links2004/arduinoWebSockets + ArduinoJson example is in:

```text
esp32/device_gateway_example/device_gateway_example.ino
```

If it still disconnects, the server now logs the first bytes it received:

```text
WARN device_ws_bad_frame boardId=test_1_board error="..." hex=... text=...
```

Use that line:

- `hex=7b...` / `text={"type"...` — raw JSON written directly to the socket. Use `sendTXT`.
- `hex=30...` or `hex=10...` — MQTT packet bytes. The device is speaking MQTT, not the JSON gateway.
- `hex=54...` / `text=This is a webSocket client!` — Links2004 rejected its own handshake (the client's `Sec-WebSocket-Accept` check failed) and wrote raw text after the server had already accepted the upgrade. Update `arduinoWebSockets`, use `beginSSL(host, 443, ...)` with the tunnel hostname, and compare with the example sketch.
- Random/corrupted hex — usually the heartbeat/send race; disable `enableHeartbeat` and serialize sends on one task.

### Relay command topic and payload

When the server publishes a relay command it uses:

```
home/<boardId>/device/<relayIndex>/set
```

with QoS 1 and `retain: true`, so an ESP32 that reconnects receives the latest relay state. The payload is:

```json
{
  "v": 1,
  "command_id": "uuid-or-string",
  "state": true,
  "last_changed": "2026-10-25T12:00:00.000Z",
  "issued_at": "2026-10-25T12:00:00.000Z"
}
```

`relayIndex` is 0–31.

### Signed HTTP command endpoint

The Supabase `mqtt-dispatch` Edge Function (or another trusted server) calls:

```
POST https://<tunnel-host>/api/device/command
Content-Type: application/json
X-MQTT-Timestamp: <unix seconds>
X-MQTT-Signature: <hex HMAC-SHA256>
```

The signature is computed over the **exact raw request body**:

```
HMAC-SHA256(MQTT_INGEST_SECRET, `${timestamp}.${rawBody}`)
```

Body:

```json
{
  "board_identifier": "test_board",
  "relay_index": 0,
  "state": true,
  "command_id": "optional-id",
  "last_changed": "optional ISO timestamp"
}
```

Responses:

- `202` — command published to MQTT.
- `400` — invalid board, relay index, state, or command ID.
- `401` — missing/invalid signature or stale timestamp (more than 120 seconds of clock skew).
- `503` — the backend's MQTT client is disconnected.

Example Node.js signing code:

```js
const crypto = require("crypto");

const body = JSON.stringify({
  board_identifier: "test_board",
  relay_index: 0,
  state: true,
});
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = crypto
  .createHmac("sha256", process.env.MQTT_INGEST_SECRET)
  .update(`${timestamp}.${body}`)
  .digest("hex");

await fetch(`${backendUrl}/api/device/command`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-mqtt-timestamp": timestamp,
    "x-mqtt-signature": signature,
  },
  body,
});
```

## 9. Supabase Edge Function changes

The backend does not call Supabase for device commands, so no new tables or RLS policies are needed. The `mqtt-dispatch` Edge Function must be updated to:

1. Store `MQTT_INGEST_SECRET` as an Edge Function secret with the **same value** as `.env`.
2. Read the current backend URL from `public.app_discovery` (`select backend_url from app_discovery where id = true`) or use a fixed URL in development.
3. Build the command JSON, sign the exact raw body as shown above, and `POST` it to `<backend_url>/api/device/command`.
4. Handle `202`, `400`, `401` and `503` explicitly so the UI can show a useful error.
5. Send the request quickly after signing. The timestamp check allows only 120 seconds of clock skew.

Set the secret from the Supabase CLI:

```powershell
supabase secrets set MQTT_INGEST_SECRET=<value from .env>
supabase functions deploy mqtt-dispatch
```

If `app_discovery` lives in the separate discovery project (currently `https://htlrmrkhuzunrceshsrk.supabase.co`) while the Edge Function runs in the application project (`https://ojuvphlkzbxwjhqzexbt.supabase.co`), use discovery-project credentials. Set `DISCOVERY_SUPABASE_URL` and `DISCOVERY_SUPABASE_SERVICE_ROLE_KEY` as Edge Function secrets. If both tables are in one project, the fallbacks below keep the snippet working.

A minimal Deno signing helper for the Edge Function looks like this (add your own browser-user authentication before it):

```ts
import { createClient } from "npm:@supabase/supabase-js@2";

const discovery = createClient(
  Deno.env.get("DISCOVERY_SUPABASE_URL") ?? Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("DISCOVERY_SUPABASE_SERVICE_ROLE_KEY") ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  // Authenticate the browser user here, then read the request body.
  const { board_identifier, relay_index, state, command_id } = await req.json();

  const { data, error } = await discovery
    .from("app_discovery")
    .select("backend_url")
    .eq("id", true)
    .single();
  if (error || !data?.backend_url) {
    return new Response(JSON.stringify({ error: "Backend URL is not published." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }

  const body = JSON.stringify({ board_identifier, relay_index, state, command_id });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(
    Deno.env.get("MQTT_INGEST_SECRET")!,
    `${timestamp}.${body}`,
  );

  const response = await fetch(`${data.backend_url}/api/device/command`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mqtt-timestamp": timestamp,
      "x-mqtt-signature": signature,
    },
    body,
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
});
```

If the Edge Function needs database access, use the same server-only key already used by the backend. Do not put either secret in the frontend.

## 10. Mosquitto access control

The backend MQTT user must be able to:

- publish and subscribe to `home/#` for the browser radio tuner;
- publish and subscribe to `home/+/device/+/set` for the device gateway.

If Mosquitto uses an ACL file, add rules for the backend user. The ESP32 does not connect to Mosquitto directly when it uses the WebSocket gateway, so it does not need a broker password for this flow.

## 11. Radio tuner and MQTT subscriptions

The MQTT console is a radio tuner. Each station maps a frequency to an MQTT topic filter:

- `88.1 FM` — `home/#` (scan every message)
- `91.3 FM` — `home/test`
- `94.7 FM` — `home/living-room/#`
- `98.1 FM` — `home/kitchen/#`
- `101.5 FM` — `home/bedroom/#`
- `104.3 FM` — `home/security/#`
- `107.1 FM` — `home/energy/#`

Tuning sends a `tune` Socket.IO event. The backend keeps a reference-counted subscription per filter and performs a real `subscribe` / `unsubscribe` on Mosquitto. Messages are routed only to sockets whose filter matches. `+` matches one topic level and `#` matches all levels below it. A plain topic receives only itself.

Users can add custom stations with their own frequency and filter. Custom stations are stored in that browser's `localStorage`, so they are personal. Presets are fixed. Publishing still targets a concrete `home/...` topic and cannot include wildcards. Messages are not retained by this app: if nobody is tuned to a filter, the backend has no subscription for it and messages published at that moment are missed, just like a radio station with no listeners.

## 12. Authentication flow

1. `POST /api/auth/register` — creates a `pending` account. No session is returned and no email is sent.
2. `POST /api/auth/login` — verifies the password.
   - `pending` or `rejected` -> HTTP 403 with `{ "status": "pending" | "rejected" }`, no token.
   - `approved` -> HTTP 200 with an opaque session token.
3. `POST /api/auth/logout` — deletes the current session.
4. `GET /api/access/me` — returns the signed-in account, status and role.
5. `GET /api/admin/users` — administrator-only list of accounts.
6. `PATCH /api/admin/users/:userId/approval` — administrator-only body `{ "status": "approved" }` or `{ "status": "rejected" }`.

Browser requests send `Authorization: Bearer <session token>`. Socket.IO uses `auth: { token }`. Every request re-checks the account's approval status, and rejecting an account deletes its sessions and disconnects any open socket.

A successful `publish-message` acknowledgement means Mosquitto accepted the publish. It does not confirm that a device performed the requested action.

## 13. Troubleshooting

- **Backend exits with `DEVICE_WS_TOKEN and MQTT_INGEST_SECRET must be configured`** — add both values to `.env`. The migration already generated them; do not leave them empty.
- **`Cannot find module './deviceGateway'`** — the require path must be `require("./deviceGateway")`, not `require(".\deviceGateway")`. The main `server.js` has been corrected.
- **ESP32 connects then immediately reconnects with `Invalid WebSocket frame: RSV2 and RSV3 must be clear`** — the TCP/WebSocket upgrade succeeded, but the ESP32 sent bytes that are not valid WebSocket frames. This is a firmware bug, not a network problem. Check the new `device_ws_bad_frame` log line for the first bytes:
  - `hex=7b...` means raw JSON went to the socket; use `webSocket.sendTXT(...)`.
  - `hex=30...` or `hex=10...` means MQTT packet bytes; the gateway is not an MQTT broker.
  - `hex=54...` / `text=This is a webSocket client!` means the ESP32 library rejected its own handshake and wrote raw text. Update the library and check the tunnel hostname / `beginSSL` call.
  - Corrupted/random bytes usually mean `enableHeartbeat` is racing with `sendTXT`/`sendBIN`; disable the heartbeat and send from one task. See `esp32/device_gateway_example`.
- **ESP32 connects but receives nothing** — check that the MQTT broker is connected and that the backend user may subscribe to `home/<boardId>/device/+/set`.
- **Edge Function gets 401** — recompute the HMAC over the exact body string you send. Do not sign a re-serialized object. Check the timestamp is in seconds, not milliseconds.
- **Tunnel changed** — restart `start-tunnel.ps1` or wait for its periodic sync; `app_discovery.backend_url` must contain the new URL. The ESP32 and Edge Function should re-read discovery on reconnect.
- **`SUPABASE_SERVICE_ROLE_KEY` rejected** — either use a legacy `eyJ...` service_role JWT or a newer `sb_secret_...` key. `start-tunnel.ps1` accepts both; an anon/publishable key is rejected.

## 14. Notes

- Sessions expire after `AUTH_SESSION_DAYS`. Expired sessions are rejected and cleaned up opportunistically.
- Passwords are stored as `scrypt$<salt>$<hash>` and compared with a timing-safe comparison.
- There is no password-reset email because email is intentionally not used. If a user forgets a password, an administrator must reset it directly in the database (generate a new scrypt hash) or the account must be recreated.
- Existing Supabase Auth users cannot be migrated automatically because Supabase does not export password hashes. Have each user register again through the website, then approve them.
- If you no longer need the old `public.user_access` table, the optional cleanup statements are at the bottom of `sql/app_auth_setup.sql`. They do not delete Supabase Auth users.

## 15. Quick start

Open PowerShell in the project folder:

```powershell
cd C:\Users\Lenovo\Downloads\mqtt_server
npm.cmd install
npm.cmd start
```

Use `npm.cmd`, not `npm`, because your PowerShell execution policy blocks `npm.ps1`.

Expected startup logs:

```text
INFO  server_started url=http://127.0.0.1:3000 ...
INFO  mqtt_connected broker=mqtt://127.0.0.1:1883 restoredFilters=0
```

Start the Cloudflare tunnel in a second PowerShell window:

```powershell
cd C:\Users\Lenovo\Downloads\mqtt_server
powershell.exe -ExecutionPolicy Bypass -File .\start-tunnel.ps1
```

Keep that window open. It starts `cloudflared`, captures the new `trycloudflare.com` URL, and writes it to Supabase.

## 16. Windows background autostart

The optional `VikaTech_MQTT_Background_Autostart\MqttBackgroundSetup` folder registers a Task Scheduler entry named `VikaTech-MQTT-and-Cloudflare-Tunnel`. It runs `Run-MqttStack.ps1`, which starts `npm.cmd start` and `start-tunnel.ps1` at boot.

After changing `server.js`, `start-tunnel.ps1`, or `.env`, restart the task instead of reinstalling it. The exact stop/start and verification commands are in `VikaTech_MQTT_Background_Autostart\MqttBackgroundSetup\README.txt`.
