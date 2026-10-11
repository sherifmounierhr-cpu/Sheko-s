-- Everest HR bridge: read-only views on the shared Supabase project
-- (Recruitment + Sales Hub) for the HR portal's daily sync.
--
-- Run once in the Supabase SQL Editor. Safe to re-run.
-- Adds a separate schema `hr_bridge` with four views and one login role,
-- `hr_reader`, that can read those views and nothing else. It changes no
-- existing table, function or policy of either project.
-- Before running, replace the password placeholder with a long random
-- password. Keep it only in GitHub Secrets; never paste it in a chat.

begin;

create schema if not exists hr_bridge;
revoke all on schema hr_bridge from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on schema hr_bridge from anon, authenticated'; end if;
end $$;

-- Hired candidates only, minimum fields: no national ID, family, health or salary expectations.
create or replace view hr_bridge.candidates as
select a.id                    as app_id,
       a.answers->>'full_name' as full_name,
       a.answers->>'mobile'    as mobile,
       coalesce(nullif(a.answers->>'position_other', ''), a.answers->>'position') as position,
       a.score                 as auto_score,
       a.recommendation,
       a.submitted_at,
       r.interview_total,
       r.interview_date,
       trim(r.final_decision)  as decision,
       r.final_date            as decided_on
from public.applications a
join public.application_reviews r on r.application_id = a.id
where a.status = 'submitted'
  and trim(r.final_decision) in ('قوي تعيين', 'تعيين');

-- Sales Hub: real teams only, last 26 weeks.
create or replace view hr_bridge.hub_members as
select m.id, m.full_name, t.name as team_code, t.display_name_ar as team_name, m.status::text as status, m.joined_at
from public.hub_members m
join public.hub_teams t on t.id = m.team_id
where not t.is_test;

create or replace view hr_bridge.hub_entries as
select e.member_id, w.label as week_label, w.starts_on, w.ends_on, e.category::text as category, e.content, e.updated_at
from public.hub_evaluation_entries e
join public.hub_weeks w   on w.id = e.week_id
join public.hub_members m on m.id = e.member_id
join public.hub_teams t   on t.id = m.team_id
where not t.is_test and w.ends_on > current_date - 182;

create or replace view hr_bridge.hub_recs as
select r.member_id, w.ends_on as week_end, r.rule_code, r.message_ar, r.severity::text as severity
from public.hub_recommendations r
join public.hub_weeks w on w.id = r.week_id
where r.member_id is not null and w.ends_on > current_date - 182;

revoke all on all tables in schema hr_bridge from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on all tables in schema hr_bridge from anon, authenticated'; end if;
end $$;

-- The login the daily GitHub job uses.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hr_reader') then
    create role hr_reader login password 'CHANGE-ME-to-a-long-random-password';
  end if;
end $$;
alter role hr_reader set statement_timeout = '30s';
alter role hr_reader set default_transaction_read_only = on;
grant usage on schema hr_bridge to hr_reader;
grant select on all tables in schema hr_bridge to hr_reader;

commit;
