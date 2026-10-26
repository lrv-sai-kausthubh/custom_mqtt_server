-- Run this in Supabase Dashboard -> SQL Editor.
-- Creates a single public row that the static frontend, the mqtt-dispatch Edge
-- Function and the ESP32 can read to discover the latest Cloudflare Quick
-- Tunnel URL. Only the backend URL is exposed.
--
-- app_discovery is the canonical discovery row. The legacy device_tunnels table
-- is optional. start-tunnel.ps1 updates this row whenever it captures a new URL.

create table if not exists public.app_discovery (
  id boolean primary key default true check (id),
  backend_url text,
  updated_at timestamptz not null default now()
);

insert into public.app_discovery (id, backend_url)
values (true, null)
on conflict (id) do nothing;

alter table public.app_discovery enable row level security;

revoke all on table public.app_discovery from anon, authenticated;
grant select on table public.app_discovery to anon, authenticated;

drop policy if exists "Anyone can read the backend URL" on public.app_discovery;
create policy "Anyone can read the backend URL"
  on public.app_discovery
  for select
  to anon, authenticated
  using (true);

-- If a tunnel is already running when you create this table, either restart
-- start-tunnel.ps1 or seed the current URL manually:
-- update public.app_discovery
-- set backend_url = 'https://your-current-tunnel.trycloudflare.com', updated_at = now()
-- where id = true;

-- The Edge Function and ESP32 should re-read backend_url when they reconnect,
-- because Quick Tunnel URLs change whenever cloudflared restarts. No additional
-- table is needed for the device gateway: relay commands travel over MQTT and
-- the gateway keeps live sockets in memory.
