-- Everest HR, part 6: the weekly email report.
--
-- Run in the Neon SQL Editor AFTER neon/005_sales_eval.sql. Safe to re-run.
--
-- A GitHub Action (tools/report/weekly.mjs, every Thursday evening) logs in as
-- `hr_report`, a login that can do exactly one thing: call hr_weekly_report().
-- That function returns the week's figures (no salaries, no personal data
-- beyond names) and who should get which email: admins get the company
-- summary, each team manager gets their own team.
--
-- After running this file, give hr_report a password once (see the end).

begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hr_report') then
    create role hr_report nologin;
  end if;
end $$;

create or replace function hr_weekly_report()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Africa/Cairo')::date;
  d0 date := today - 6;
  st jsonb := coalesce((select data from settings where id = 1), '{}');
  weekend int[] := coalesce((select array_agg(x::int) from jsonb_array_elements_text(coalesce(st->'weekend', '[5]')) x), '{5}');
  holidays date[] := coalesce((select array_agg(x::date) from jsonb_array_elements_text(coalesce(st->'holidays', '[]')) x), '{}');
  def_in time := coalesce(nullif(st->>'in', '')::time, '11:00');
  grace int := coalesce((select (t->>0)::int from jsonb_array_elements(coalesce(st->'lateTiers', '[]')) t
                         where (t->>1)::numeric > 0 order by (t->>0)::int limit 1), 15);
  wk_start date := today - ((extract(isodow from today)::int - 5 + 7) % 7);
  wk int := (select id from eval_weeks where starts_on = wk_start);
  -- attendance only up to the last day the fingerprint export covers
  last_punch date := (select max((ts at time zone 'Africa/Cairo')::date) from punches);
  att jsonb; teams jsonb; company jsonb; recipients jsonb;
begin
  -- attendance (approximate: no punch on a work day without an approved leave = absent;
  -- first punch later than the shift start + the first penalised minute = late)
  with days as (
    select d::date as d from generate_series(d0, least(today, coalesce(last_punch, d0 - 1)), interval '1 day') d
    where extract(dow from d)::int <> all(weekend) and d::date <> all(holidays)),
  emp as (select code, name, team_id, coalesce(shift_in, def_in) as sin, off_day from employees where active and not exempt),
  grid as (
    select e.code, e.name, e.team_id, dd.d, e.sin,
      (select min(p.ts) from punches p where p.code = e.code and (p.ts at time zone 'Africa/Cairo')::date = dd.d) as first_in,
      exists (select 1 from requests r where r.code = e.code and r.status = 'approved' and r.type like 'إجازة%'
              and dd.d between r.date_from and coalesce(r.date_to, r.date_from)) as on_leave
    from emp e cross join days dd where e.off_day is null or e.off_day <> extract(dow from dd.d)::int)
  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'name', name, 'team', team_id, 'abs', abs, 'late', late)), '[]') into att
  from (select code, max(name) as name, max(team_id) as team_id,
          count(*) filter (where first_in is null and not on_leave) as abs,
          count(*) filter (where first_in is not null and ((first_in at time zone 'Africa/Cairo')::time > sin + make_interval(mins => grace))) as late
        from grid group by code) x;

  -- per team: people, attendance, weekly evaluation progress and average
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id, 'name', t.name,
    'members', (select count(*) from employees e where e.team_id = t.id and e.active),
    'abs', (select coalesce(sum((a->>'abs')::int), 0) from jsonb_array_elements(att) a where (a->>'team')::int = t.id),
    'late', (select coalesce(sum((a->>'late')::int), 0) from jsonb_array_elements(att) a where (a->>'team')::int = t.id),
    'top_abs', (select coalesce(jsonb_agg(jsonb_build_object('name', a->>'name', 'abs', (a->>'abs')::int) order by (a->>'abs')::int desc), '[]')
                from jsonb_array_elements(att) a where (a->>'team')::int = t.id and (a->>'abs')::int >= 2),
    'eval_avg', (select round(avg(x.rating), 1) from eval_entries x join employees e on e.code = x.code where x.week_id = wk and e.team_id = t.id),
    'eval_done', (select count(*) from eval_entries x join employees e on e.code = x.code where x.week_id = wk and e.team_id = t.id),
    'eval_need', (select count(*) from eval_assignments a join employees e on e.team_id = a.team_id and e.active where a.team_id = t.id),
    'trainees', (select count(*) from training_plans p join employees e on e.code = p.code where p.status = 'active' and e.team_id = t.id),
    'pending_requests', (select count(*) from requests r join employees e on e.code = r.code where r.status = 'pending' and e.team_id = t.id),
    'manager_email', (select u.email from app_users u where u.employee_code = t.manager_code and 'manager' = any(u.roles) and u.email is not null limit 1)
  ) order by t.name), '[]') into teams from teams t;

  company := jsonb_build_object(
    'employees', (select count(*) from employees where active),
    'hires', (select count(*) from employees where hire_date between d0 and today),
    'applications', (select count(*) from applications where (created_at at time zone 'Africa/Cairo')::date between d0 and today),
    'interviews', (select count(*) from application_reviews where interview_date between d0 and today),
    'hired', (select count(*) from applications where status = 'hired' and (status_at at time zone 'Africa/Cairo')::date between d0 and today),
    'open_applications', (select count(*) from applications where status in ('new', 'screening', 'interview', 'offer')),
    'trainees', (select count(*) from training_plans where status = 'active'),
    'surveys', (select count(*) from survey_responses where (submitted_at at time zone 'Africa/Cairo')::date between d0 and today),
    'abs', (select coalesce(sum((a->>'abs')::int), 0) from jsonb_array_elements(att) a),
    'late', (select coalesce(sum((a->>'late')::int), 0) from jsonb_array_elements(att) a),
    'pending_requests', (select count(*) from requests where status = 'pending'),
    'pending_actions', (select count(*) from actions where status = 'pending'),
    'pending_meetings', (select count(*) from meetings where status = 'pending'),
    'eval_done', (select count(*) from eval_entries where week_id = wk),
    'eval_need', (select count(*) from eval_assignments a join employees e on e.team_id = a.team_id and e.active));

  recipients := jsonb_build_object('admins', (select coalesce(jsonb_agg(email), '[]') from app_users where 'admin' = any(roles) and email is not null));

  return jsonb_build_object('from', d0, 'to', today, 'attendance_until', case when last_punch >= d0 then least(last_punch, today) end, 'company', company, 'teams', teams, 'recipients', recipients);
end $$;

revoke all on function hr_weekly_report() from public;
grant execute on function hr_weekly_report() to hr_report;
grant usage on schema public to hr_report;

commit;

-- Then, once, give the report login a password (pick your own long one, keep
-- it out of chats, and put the connection string in GitHub Secrets as
-- NEON_REPORT_URL):
--   alter role hr_report login password 'a-long-random-password';
