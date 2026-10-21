-- DEPRECATED: this file belongs to the old Supabase Auth flow.
-- Use sql/app_auth_setup.sql instead. Supabase Auth and Supabase email are no
-- longer used by this project.
--
-- Run this in Supabase Dashboard -> SQL Editor.
-- This creates the approval table; it does NOT alter your existing device_tunnels table.

create table if not exists public.user_access (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  role text not null default 'user'
    check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users (id) on delete set null
);

alter table public.user_access enable row level security;
revoke all on table public.user_access from anon, authenticated;
grant select on table public.user_access to authenticated;

drop policy if exists "Users can read their own access status" on public.user_access;
create policy "Users can read their own access status"
  on public.user_access
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Create a pending row automatically for every new Supabase Auth user.
create or replace function public.handle_new_auth_user_access()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_access (user_id, status, role)
  values (new.id, 'pending', 'user')
  on conflict (user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_auth_user_access() from public, anon, authenticated;

drop trigger if exists on_auth_user_created_access on auth.users;
create trigger on_auth_user_created_access
  after insert on auth.users
  for each row execute function public.handle_new_auth_user_access();

-- Backfill accounts created before this trigger existed. Existing access rows are unchanged.
insert into public.user_access (user_id, status, role)
select id, 'pending', 'user'
from auth.users
on conflict (user_id) do nothing;

-- After creating your own account through Supabase Auth, run a one-time command
-- in the SQL Editor to make YOUR account the initial administrator. Replace email:
--
-- insert into public.user_access (user_id, status, role, reviewed_at)
-- select id, 'approved', 'admin', now()
-- from auth.users where lower(email) = lower('YOUR_SIGNUP_EMAIL')
-- on conflict (user_id) do update
-- set status = 'approved', role = 'admin', reviewed_at = now();
