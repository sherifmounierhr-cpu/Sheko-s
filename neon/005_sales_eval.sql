-- Everest HR, part 5: the weekly sales evaluation (replaces the Sales Hub sheet).
--
-- Run in the Neon SQL Editor AFTER neon/004_recruitment.sql. Safe to re-run.
--
-- Every week (Friday to Thursday) each salesperson gets four ratings from 1 to 5
-- with a short note: media, leads, attitude, development. Each column is rated
-- by the evaluator the admin assigns to that team and column (role `evaluator`).
-- A week locks on Thursday at 23:59 Cairo time; an admin can reopen it for 48h.
--
-- Adds: eval_weeks, eval_assignments, eval_entries, team_month_plans.

begin;

-- ---------------------------------------------------------------- tables

create table if not exists eval_weeks (
  id             serial primary key,
  starts_on      date not null unique check (extract(isodow from starts_on) = 5),   -- Friday
  ends_on        date not null generated always as (starts_on + 6) stored,          -- Thursday
  reopened_until timestamptz
);

create table if not exists eval_assignments (
  user_id  text not null references app_users(user_id) on delete cascade,
  team_id  int  not null references teams(id) on delete cascade,
  category text not null check (category in ('media', 'leads', 'attitude', 'development')),
  primary key (user_id, team_id, category)
);

create table if not exists eval_entries (
  id         bigserial primary key,
  code       text not null references employees(code) on update cascade on delete cascade,
  week_id    int  not null references eval_weeks(id) on delete cascade,
  category   text not null check (category in ('media', 'leads', 'attitude', 'development')),
  rating     smallint not null check (rating between 1 and 5),
  note       text check (length(note) <= 500),
  entered_by text default auth.user_id(),
  updated_at timestamptz not null default now(),
  unique (code, week_id, category)
);
create index if not exists eval_entries_week on eval_entries (week_id);

create table if not exists team_month_plans (
  team_id    int  not null references teams(id) on delete cascade,
  month      text not null check (month ~ '^\d{4}-\d{2}$'),
  tasks      text check (length(tasks) <= 3000),
  vision     text check (length(vision) <= 2000),
  updated_by text default auth.user_id(),
  updated_at timestamptz not null default now(),
  primary key (team_id, month)
);

-- ---------------------------------------------------------------- helpers

-- the week (Friday..Thursday) a day falls in; creates the row the first time
create or replace function hr_eval_week(p_day date default null)
returns int language plpgsql security definer set search_path = public as $$
declare d date := coalesce(p_day, (now() at time zone 'Africa/Cairo')::date); f date; wid int;
begin
  if auth.user_id() is null then raise exception 'not allowed'; end if;
  f := d - ((extract(isodow from d)::int - 5 + 7) % 7);
  if f > (now() at time zone 'Africa/Cairo')::date then raise exception 'future week'; end if;
  insert into eval_weeks (starts_on) values (f) on conflict (starts_on) do nothing;
  select id into wid from eval_weeks where starts_on = f;
  return wid;
end $$;

-- open until Thursday 23:59 Cairo, or while an admin's reopening lasts
create or replace function hr_eval_open(p_week int) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select now() < ((ends_on + 1)::timestamp at time zone 'Africa/Cairo')
                       or coalesce(reopened_until > now(), false)
                   from eval_weeks where id = p_week), false)
$$;

-- may the signed-in user rate column `cat` for employee `c`?
create or replace function hr_can_eval(c text, cat text) returns boolean
language sql stable security definer set search_path = public as $$
  select hr_has('admin') or exists (
    select 1 from eval_assignments a join employees e on e.team_id = a.team_id
    where a.user_id = auth.user_id() and a.category = cat and e.code = c)
$$;

-- does the signed-in user evaluate anyone in employee `c`'s team?
create or replace function hr_evaluates(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from eval_assignments a join employees e on e.team_id = a.team_id
                 where a.user_id = auth.user_id() and e.code = c)
$$;

-- employees see their own ratings unless the admin turned it off
create or replace function hr_eval_visible() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select (data->>'evalToEmployee')::boolean from settings where id = 1), true)
$$;

-- ---------------------------------------------------------------- actions

-- Save one rating (and note). A null rating removes the entry.
create or replace function hr_eval_save(p_code text, p_week int, p_category text, p_rating int, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_can_eval(p_code, p_category) then raise exception 'not allowed'; end if;
  if not hr_eval_open(p_week) then raise exception 'week locked'; end if;
  if p_code = hr_my_code() then raise exception 'not allowed'; end if;
  if p_rating is null then
    delete from eval_entries where code = p_code and week_id = p_week and category = p_category;
    return;
  end if;
  if p_rating not between 1 and 5 then raise exception 'bad rating'; end if;
  insert into eval_entries (code, week_id, category, rating, note, entered_by, updated_at)
  values (p_code, p_week, p_category, p_rating, nullif(btrim(p_note), ''), auth.user_id(), now())
  on conflict (code, week_id, category) do update
    set rating = excluded.rating, note = excluded.note, entered_by = excluded.entered_by, updated_at = now();
end $$;

-- Admin reopens a locked week for some hours (default 48).
create or replace function hr_eval_reopen(p_week int, p_hours int default 48)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  update eval_weeks set reopened_until = now() + make_interval(hours => least(greatest(p_hours, 1), 168)) where id = p_week;
end $$;

-- Remind evaluators who still have empty cells this week (admin: all teams;
-- manager: their own team). Returns how many people were reminded.
create or replace function hr_eval_remind(p_week int)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; r record; lbl text;
begin
  if not (hr_has('admin') or hr_has('manager')) then raise exception 'not allowed'; end if;
  select 'الأسبوع من ' || to_char(starts_on, 'DD/MM') || ' لـ ' || to_char(ends_on, 'DD/MM') into lbl from eval_weeks where id = p_week;
  for r in
    select a.user_id, count(*) as missing
    from eval_assignments a
    join teams t on t.id = a.team_id
    join employees e on e.team_id = a.team_id and e.active
    left join eval_entries x on x.code = e.code and x.week_id = p_week and x.category = a.category
    where x.id is null and e.code is distinct from (select employee_code from app_users u where u.user_id = a.user_id)
      and (hr_has('admin') or t.manager_code = hr_my_code())
    group by a.user_id
  loop
    perform hr_notify(null, r.user_id, 'eval', 'باقي ' || r.missing || ' تقييم لـ ' || lbl,
      'افتح (التقييم الأسبوعي) وكمّلهم قبل الخميس الساعة 12 بالليل.', 'eval_weeks', p_week);
    n := n + 1;
  end loop;
  return n;
end $$;

-- The team's monthly tasks and vision: admin or that team's manager.
create or replace function hr_team_plan_save(p_team int, p_month text, p_tasks text, p_vision text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (hr_has('admin') or exists (select 1 from teams where id = p_team and manager_code = hr_my_code() and hr_has('manager'))) then
    raise exception 'not allowed';
  end if;
  insert into team_month_plans (team_id, month, tasks, vision, updated_by, updated_at)
  values (p_team, p_month, nullif(btrim(p_tasks), ''), nullif(btrim(p_vision), ''), auth.user_id(), now())
  on conflict (team_id, month) do update set tasks = excluded.tasks, vision = excluded.vision,
    updated_by = excluded.updated_by, updated_at = now();
end $$;

-- ---------------------------------------------------------------- RLS

alter table eval_weeks       enable row level security;
alter table eval_assignments enable row level security;
alter table eval_entries     enable row level security;
alter table team_month_plans enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and (tablename in ('eval_weeks', 'eval_assignments', 'eval_entries', 'team_month_plans') or policyname = 'emp_eval_read')
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

create policy ew_read on eval_weeks for select to authenticated using (true);

create policy ea_read on eval_assignments for select to authenticated using (user_id = auth.user_id() or hr_has('admin') or hr_has('manager'));
create policy ea_admin on eval_assignments for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- ratings: admin, the team manager, the team's evaluators, and the employee (if allowed)
create policy ee_read on eval_entries for select to authenticated using (
  hr_has('admin') or hr_manages(code) or hr_evaluates(code) or (code = hr_my_code() and hr_eval_visible()));

create policy tp_plan_read on team_month_plans for select to authenticated using (true);

-- evaluators see the people of the teams they rate
create policy emp_eval_read on employees for select to authenticated using (hr_evaluates(code));

drop trigger if exists audit on eval_entries;
create trigger audit after insert or update or delete on eval_entries for each row execute function hr_audit();
drop trigger if exists audit on eval_assignments;
create trigger audit after insert or update or delete on eval_assignments for each row execute function hr_audit();

-- ---------------------------------------------------------------- grants

grant select on eval_weeks, eval_entries, team_month_plans to authenticated;
grant select, insert, update, delete on eval_assignments to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke all on function hr_eval_week(date), hr_eval_open(int), hr_can_eval(text, text), hr_evaluates(text), hr_eval_visible(),
  hr_eval_save(text, int, text, int, text), hr_eval_reopen(int, int), hr_eval_remind(int), hr_team_plan_save(int, text, text, text) from public;
grant execute on function hr_eval_week(date), hr_eval_open(int), hr_can_eval(text, text), hr_evaluates(text), hr_eval_visible(),
  hr_eval_save(text, int, text, int, text), hr_eval_reopen(int, int), hr_eval_remind(int), hr_team_plan_save(int, text, text, text) to authenticated;

commit;
