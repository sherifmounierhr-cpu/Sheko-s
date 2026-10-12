-- Everest HR, part 4: copies from Recruitment and Sales Hub (read-only bridge).
--
-- Run in the Neon SQL Editor AFTER neon/003_training.sql. Safe to re-run.
--
-- A daily GitHub job (tools/sync/sync.mjs) reads the hr_bridge views on the
-- Supabase project (tools/sync/supabase_reader.sql) and writes them here as
-- the hr_sync login, which can only write the ext_* tables and sync_runs.
-- Nothing here writes back to Recruitment or Sales Hub.
--
-- After running this file, give hr_sync a password (one line, see the end).

begin;

-- ---------------------------------------------------------------- tables

alter table employees add column if not exists source_application uuid;

-- hired candidates from Recruitment (minimum fields only)
create table if not exists ext_candidates (
  app_id          uuid primary key,
  full_name       text,
  mobile          text,
  position        text,
  auto_score      int,
  recommendation  text,
  submitted_at    timestamptz,
  interview_total int,
  interview_date  date,
  decision        text,
  decided_on      date,
  synced_at       timestamptz not null default now(),
  -- set in the portal, never by the sync
  linked_code     text references employees(code) on update cascade on delete set null,
  dismissed       boolean not null default false
);

-- Sales Hub members, weekly entries and recommendations (used from part 5)
create table if not exists ext_hub_members (
  id        uuid primary key,
  full_name text,
  team_code text,
  team_name text,
  status    text,
  joined_at date,
  synced_at timestamptz not null default now()
);
create table if not exists ext_hub_entries (
  member_id  uuid not null,
  ends_on    date not null,
  category   text not null,
  week_label text,
  starts_on  date,
  content    text,
  updated_at timestamptz,
  primary key (member_id, ends_on, category)
);
create table if not exists ext_hub_recs (
  member_id uuid not null,
  week_end  date not null,
  rule_code text not null,
  message_ar text,
  severity  text,
  primary key (member_id, week_end, rule_code)
);

create table if not exists sync_runs (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  source text not null,
  rows   int,
  ok     boolean not null,
  error  text
);

-- ---------------------------------------------------------------- the sync login

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hr_sync') then
    create role hr_sync nologin;
  end if;
end $$;
grant usage on schema public to hr_sync;
grant select, insert, update, delete on ext_hub_members, ext_hub_entries, ext_hub_recs to hr_sync;
-- the sync may not touch the two portal-owned columns (linked_code, dismissed)
revoke all on ext_candidates from hr_sync;
grant select, delete on ext_candidates to hr_sync;
grant insert (app_id, full_name, mobile, position, auto_score, recommendation, submitted_at, interview_total, interview_date, decision, decided_on, synced_at),
      update (full_name, mobile, position, auto_score, recommendation, submitted_at, interview_total, interview_date, decision, decided_on, synced_at)
  on ext_candidates to hr_sync;
grant insert on sync_runs to hr_sync;
grant usage on sequence sync_runs_id_seq to hr_sync;

-- ---------------------------------------------------------------- functions

-- Admin hires a candidate as employee `p_code` (after adding the employee).
create or replace function hr_link_candidate(p_app uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  update ext_candidates set linked_code = p_code where app_id = p_app;
  if not found then raise exception 'no such candidate'; end if;
  update employees set source_application = p_app where code = p_code;
end $$;

-- Admin hides a candidate who will not join after all (can be undone).
create or replace function hr_dismiss_candidate(p_app uuid, p_on boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  update ext_candidates set dismissed = p_on where app_id = p_app;
end $$;

-- ---------------------------------------------------------------- RLS

alter table ext_candidates  enable row level security;
alter table ext_hub_members enable row level security;
alter table ext_hub_entries enable row level security;
alter table ext_hub_recs    enable row level security;
alter table sync_runs       enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('ext_candidates', 'ext_hub_members', 'ext_hub_entries', 'ext_hub_recs', 'sync_runs')
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

-- admins read everything; the sync writes; nobody else sees these yet
create policy cand_admin on ext_candidates  for select to authenticated using (hr_has('admin'));
create policy hubm_admin on ext_hub_members for select to authenticated using (hr_has('admin'));
create policy hube_admin on ext_hub_entries for select to authenticated using (hr_has('admin'));
create policy hubr_admin on ext_hub_recs    for select to authenticated using (hr_has('admin'));
create policy sync_admin on sync_runs       for select to authenticated using (hr_has('admin'));

create policy cand_sync on ext_candidates  for all to hr_sync using (true) with check (true);
create policy hubm_sync on ext_hub_members for all to hr_sync using (true) with check (true);
create policy hube_sync on ext_hub_entries for all to hr_sync using (true) with check (true);
create policy hubr_sync on ext_hub_recs    for all to hr_sync using (true) with check (true);
create policy runs_sync on sync_runs       for insert to hr_sync with check (true);

grant select on ext_candidates, ext_hub_members, ext_hub_entries, ext_hub_recs, sync_runs to authenticated;

revoke all on function hr_link_candidate(uuid, text), hr_dismiss_candidate(uuid, boolean) from public;
grant execute on function hr_link_candidate(uuid, text), hr_dismiss_candidate(uuid, boolean) to authenticated;

commit;

-- Then, once, give the sync login a password (pick your own long one, keep it
-- out of chats, and put the resulting connection string in GitHub Secrets):
--   alter role hr_sync login password 'a-long-random-password';
