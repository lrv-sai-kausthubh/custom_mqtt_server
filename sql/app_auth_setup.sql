-- Run this in Supabase Dashboard -> SQL Editor.
-- Supabase is used only as a database. Supabase Auth and Supabase email are not used.
--
-- This creates:
--   public.app_users    - local accounts, password hashes, approval status and role
--   public.app_sessions - opaque sign-in sessions issued only after approval
--
-- Only the backend service-role key can access these tables. Browsers never
-- receive a Supabase key, so RLS is enabled and anon/authenticated are revoked.

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  role text not null default 'user'
    check (role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.app_users (id) on delete set null
);

-- Email matching is case-insensitive because the backend stores lowercase emails.
create unique index if not exists app_users_email_lower_key
  on public.app_users (lower(email));

create index if not exists app_users_status_idx
  on public.app_users (status, created_at desc);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists app_sessions_user_id_idx
  on public.app_sessions (user_id);

create index if not exists app_sessions_expires_at_idx
  on public.app_sessions (expires_at);

alter table public.app_users enable row level security;
alter table public.app_sessions enable row level security;

-- The backend uses the service-role key, which bypasses RLS.
-- Revoke direct browser access through the anon/authenticated roles.
revoke all on table public.app_users from anon, authenticated;
revoke all on table public.app_sessions from anon, authenticated;

-- ---------------------------------------------------------------------------
-- One-time administrator bootstrap
-- ---------------------------------------------------------------------------
-- 1. Open the website and register your own account with the "Create account" tab.
--    New accounts are always created as pending/user.
-- 2. Replace the email below with that account's email and run this UPDATE.
-- 3. Sign in with that account. The admin panel will appear.
--
-- update public.app_users
-- set status = 'approved',
--     role = 'admin',
--     reviewed_at = now()
-- where lower(email) = lower('YOUR_ADMIN_EMAIL');

-- ---------------------------------------------------------------------------
-- Optional cleanup of the old Supabase Auth approval table.
-- Only run this after you have confirmed the new login flow works and you no
-- longer need the old data. It does not delete Supabase Auth users.
-- ---------------------------------------------------------------------------
-- drop trigger if exists on_auth_user_created_access on auth.users;
-- drop function if exists public.handle_new_auth_user_access();
-- drop table if exists public.user_access;
