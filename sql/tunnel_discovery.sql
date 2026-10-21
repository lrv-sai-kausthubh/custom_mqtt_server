-- Run this in Supabase Dashboard -> SQL Editor.
-- Creates a single public row that the static frontend can read to discover the
-- latest Cloudflare Quick Tunnel URL. Only the backend URL is exposed.
--
-- start-tunnel.ps1 updates this row whenever it captures a new tunnel URL.

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
