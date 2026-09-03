-- ============================================================================
--  Everest Job Application Form — Supabase schema
--  0001_init.sql
--
--  Creates:
--    * profiles              — one row per auth user, carries the role
--    * applications          — the applicant-owned part of the form
--    * application_reviews   — the HR-only part of the form (separate table so
--                              that RLS can actually keep applicants out of it)
--
--  Plus: role helper functions, an auto-provisioning trigger that grants the
--  'admin' role to sherifmounierhr@gmail.com, RLS policies, and realtime.
-- ============================================================================

-- gen_random_uuid() is built into Postgres 14+; no extension needed.

-- ---------------------------------------------------------------------------
-- 0. Constants
-- ---------------------------------------------------------------------------
-- The bootstrap administrator. Kept in a function so it is referenced in
-- exactly one place and can be changed with a single CREATE OR REPLACE.
create or replace function public.bootstrap_admin_email()
returns text
language sql
immutable
as $$ select 'sherifmounierhr@gmail.com'::text $$;

-- ---------------------------------------------------------------------------
-- 1. Role type
-- ---------------------------------------------------------------------------
do $$
begin
  create type public.app_role as enum ('applicant', 'hr', 'admin');
exception
  when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  full_name  text,
  role       public.app_role not null default 'applicant',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Public mirror of auth.users carrying the application role.';

-- One application per user: lets the client upsert on user_id and keeps the
-- "my form" lookup a single-row read.
create table if not exists public.applications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null unique references auth.users (id) on delete cascade,
  status         text not null default 'draft' check (status in ('draft', 'submitted')),
  answers        jsonb not null default '{}'::jsonb,
  score          integer not null default 0 check (score between 0 and 100),
  recommendation text,
  submitted_at   timestamptz,
  -- Identifies the browser tab that made the last write, so realtime
  -- subscribers can ignore the echo of their own change.
  last_client_id text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on column public.applications.answers is
  'Applicant-filled fields, keyed by the form input name attribute.';

create table if not exists public.application_reviews (
  application_id  uuid primary key references public.applications (id) on delete cascade,
  scores          jsonb not null default '{}'::jsonb,
  interview_total integer not null default 0,
  interview_date  date,
  interviewer     text,
  hr_notes        text,
  final_decision  text,
  final_date      date,
  final_notes     text,
  reviewer_id     uuid references auth.users (id) on delete set null,
  last_client_id  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.application_reviews is
  'HR-only evaluation. Separate table because RLS is row-level, not column-level.';

create index if not exists applications_status_idx     on public.applications (status);
create index if not exists applications_updated_at_idx on public.applications (updated_at desc);
create index if not exists profiles_role_idx           on public.profiles (role);

-- ---------------------------------------------------------------------------
-- 3. Role helpers
--
-- SECURITY DEFINER so that a policy on public.profiles can read public.profiles
-- without re-entering its own RLS check (which would recurse infinitely).
-- ---------------------------------------------------------------------------
create or replace function public.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid()),
    'applicant'::public.app_role
  )
$$;

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.current_app_role() in ('hr', 'admin') $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$ select public.current_app_role() = 'admin' $$;

revoke all on function public.current_app_role() from public;
revoke all on function public.is_staff()         from public;
revoke all on function public.is_admin()         from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_staff()         to authenticated;
grant execute on function public.is_admin()         to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Automatic profile provisioning + admin assignment
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Tells guard_profile_role that this write is the authoritative sync from
  -- auth.users, not an end user editing their own profile row. Transaction
  -- local (third argument true), so it cannot leak into another statement.
  perform set_config('app.auth_sync', '1', true);

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    case
      when lower(new.email) = public.bootstrap_admin_email()
        then 'admin'::public.app_role
      else 'applicant'::public.app_role
    end
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(excluded.full_name, profiles.full_name),
        role      = case
                      when lower(excluded.email) = public.bootstrap_admin_email()
                        then 'admin'::public.app_role
                      else profiles.role
                    end;

  perform set_config('app.auth_sync', '0', true);
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Keep the profile email in sync when the user changes it in auth, and
-- re-apply the admin grant if the bootstrap address is claimed later.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of email on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 5. Guard rails
-- ---------------------------------------------------------------------------
-- Without this, the "update your own profile" policy would let any user
-- promote themselves to admin -- either by writing role directly, or by
-- rewriting their profile email to the bootstrap admin address.
--
-- So: from an ordinary session, id/email/role are all read-only and only
-- full_name is editable. Role changes require is_admin(). Email changes
-- require the auth.users sync path, which sets app.auth_sync.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  syncing boolean := coalesce(current_setting('app.auth_sync', true), '0') = '1';
begin
  new.id := old.id;

  if not syncing then
    -- email is owned by auth.users; never accept a client-supplied value
    new.email := old.email;

    if new.role is distinct from old.role and not public.is_admin() then
      new.role := old.role;
    end if;
  end if;

  -- The bootstrap admin address always holds the admin role, whichever path
  -- the write came in on.
  if lower(new.email) = public.bootstrap_admin_email() then
    new.role := 'admin'::public.app_role;
  end if;

  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before update on public.profiles
  for each row execute function public.guard_profile_role();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

drop trigger if exists applications_touch on public.applications;
create trigger applications_touch
  before update on public.applications
  for each row execute function public.touch_updated_at();

drop trigger if exists application_reviews_touch on public.application_reviews;
create trigger application_reviews_touch
  before update on public.application_reviews
  for each row execute function public.touch_updated_at();

-- An applicant must not be able to reassign their row to someone else, nor
-- silently rewrite submitted_at.
create or replace function public.guard_application()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
  end if;

  if new.status = 'submitted' and new.submitted_at is null then
    new.submitted_at := now();
  elsif new.status = 'draft' then
    new.submitted_at := null;
  end if;

  return new;
end
$$;

drop trigger if exists applications_guard on public.applications;
create trigger applications_guard
  before insert or update on public.applications
  for each row execute function public.guard_application();

-- ---------------------------------------------------------------------------
-- 6. Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.applications        enable row level security;
alter table public.application_reviews enable row level security;

-- profiles -------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles
  for insert to authenticated
  with check (id = auth.uid());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_delete_admin on public.profiles;
create policy profiles_delete_admin on public.profiles
  for delete to authenticated
  using (public.is_admin());

-- applications ---------------------------------------------------------------
drop policy if exists applications_select on public.applications;
create policy applications_select on public.applications
  for select to authenticated
  using (user_id = auth.uid() or public.is_staff());

drop policy if exists applications_insert_own on public.applications;
create policy applications_insert_own on public.applications
  for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists applications_update on public.applications;
create policy applications_update on public.applications
  for update to authenticated
  using (user_id = auth.uid() or public.is_staff())
  with check (user_id = auth.uid() or public.is_staff());

drop policy if exists applications_delete on public.applications;
create policy applications_delete on public.applications
  for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- application_reviews --------------------------------------------------------
-- No policy grants the applicant anything here, so the HR evaluation is
-- invisible to the person being evaluated.
drop policy if exists reviews_staff_all on public.application_reviews;
create policy reviews_staff_all on public.application_reviews
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- ---------------------------------------------------------------------------
-- 7. Realtime
-- ---------------------------------------------------------------------------
-- FULL replica identity so UPDATE/DELETE payloads carry the old row, which the
-- client needs to reconcile changes it did not originate.
alter table public.applications        replica identity full;
alter table public.application_reviews replica identity full;
alter table public.profiles            replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.applications;
exception when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.application_reviews;
exception when duplicate_object then null;
end
$$;

do $$
begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object then null;
end
$$;

-- ---------------------------------------------------------------------------
-- 8. Backfill for accounts that already existed before this migration
-- ---------------------------------------------------------------------------
insert into public.profiles (id, email, full_name, role)
select
  u.id,
  u.email,
  nullif(u.raw_user_meta_data ->> 'full_name', ''),
  case
    when lower(u.email) = public.bootstrap_admin_email() then 'admin'::public.app_role
    else 'applicant'::public.app_role
  end
from auth.users u
where u.email is not null
on conflict (id) do nothing;

update public.profiles
   set role = 'admin'::public.app_role
 where lower(email) = public.bootstrap_admin_email()
   and role <> 'admin';
