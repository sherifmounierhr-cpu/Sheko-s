-- Everest Eco System, part 13: the administration (الإدارة) beside the teams.
--
-- Run in the Neon SQL Editor AFTER neon/012_crm.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * Every position belongs to a track: administration, sales, or general.
--     Owners, the GM, department heads and admin staff (accountant, reception,
--     office, IT) are the administration; they don't need a team.
--   * Anyone can have a direct manager (reports_to). That manager, and everyone
--     above them, sees the person and decides on their requests, the same way
--     the head of a unit does for its members.
--   * Permissions per person: the position's template, plus additions and minus
--     removals kept on the employee, so applying a template doesn't wipe them.
--   * The admin adds and removes positions from the portal.

begin;

-- ---------------------------------------------------------------- tracks and positions

alter table org_positions add column if not exists track text not null default 'staff';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'org_positions_track_check') then
    alter table org_positions add constraint org_positions_track_check check (track in ('admin', 'sales', 'staff'));
    update org_positions set track = 'admin' where key in ('owner', 'gm', 'ops', 'hr', 'bizdev', 'social');
    update org_positions set track = 'sales' where key in ('lead', 'sales');
  end if;
end $$;

insert into org_positions (key, title, rank, roles, track, sort) values
  ('accountant', 'محاسب',               4, '{pay}',      'admin', 10),
  ('reception',  'سكرتارية / ريسيبشن',  5, '{meetings}', 'admin', 11),
  ('office',     'أوفيس جيرل',          5, '{}',         'admin', 12),
  ('it',         'IT',                  5, '{uploader}', 'admin', 13)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- direct manager and personal permissions

alter table employees add column if not exists reports_to text references employees(code) on update cascade on delete set null;
alter table employees add column if not exists roles_plus text[] not null default '{}';
alter table employees add column if not exists roles_minus text[] not null default '{}';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'employees_not_own_boss') then
    alter table employees add constraint employees_not_own_boss check (reports_to is distinct from code);
  end if;
end $$;

-- the roles a template or a person may carry (admin is only ever given by hand)
create or replace function hr_grantable() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['viewall', 'approveall', 'manager', 'pay', 'leads_assign', 'recruiter', 'uploader', 'meetings', 'evaluator']
$$;

-- Everyone above `c`: the heads of their unit and every unit above it, their
-- direct manager, and then the same again for each of those, up the chain.
create or replace function hr_bosses(c text) returns setof text
language sql stable security definer set search_path = public, pg_temp as $$
  with recursive g(kind, id, depth) as (
    select 'p'::text, c, 0
    union
    select n.kind, n.id, g.depth + 1 from g cross join lateral (
      select 'u'::text, e.team_id::text from employees e where g.kind = 'p' and e.code = g.id and e.team_id is not null
      union all
      select 'p', e.reports_to from employees e where g.kind = 'p' and e.code = g.id and e.reports_to is not null
      union all
      select 'p', t.manager_code from teams t where g.kind = 'u' and t.id::text = g.id and t.manager_code is not null
      union all
      select 'u', t.parent_id::text from teams t where g.kind = 'u' and t.id::text = g.id and t.parent_id is not null
    ) n(kind, id) where g.depth < 40)
  select distinct id from g where kind = 'p' and depth > 0
$$;

-- seeing: the whole company with viewall/approveall, else a manager above them
create or replace function hr_manages(c text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c is not null and (hr_has('viewall') or hr_has('approveall') or ('manager' = any(hr_roles()) and
    exists (select 1 from hr_bosses(c) b where b = hr_my_code())))
$$;

-- deciding: approveall, or a manager above them; never oneself
create or replace function hr_decides(c text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c is not null and c is distinct from hr_my_code() and (hr_has('approveall') or ('manager' = any(hr_roles()) and
    exists (select 1 from hr_bosses(c) b where b = hr_my_code())))
$$;

-- who a request is sent to: the direct manager, else the nearest unit head
create or replace function hr_manager_of(c text) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select e.reports_to from employees e join employees b on b.code = e.reports_to where e.code = c and coalesce(b.active, true)),
    (with recursive up as (
       select t.id, t.parent_id, t.manager_code, 1 as depth
         from employees e join teams t on t.id = e.team_id where e.code = c
       union all
       select p.id, p.parent_id, p.manager_code, up.depth + 1
         from up join teams p on p.id = up.parent_id where up.depth < 20)
     select manager_code from up where manager_code is not null and manager_code <> c order by depth limit 1))
$$;

-- a direct manager can't be someone below the person, nor someone who left;
-- personal permissions only from the grantable list
create or replace function hr_emp_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.reports_to is not null and (tg_op = 'INSERT' or new.reports_to is distinct from old.reports_to) then
    if not exists (select 1 from employees where code = new.reports_to and coalesce(active, true)) then raise exception 'bad manager'; end if;
    if exists (select 1 from hr_bosses(new.reports_to) b where b = new.code) then raise exception 'manager cycle'; end if;
  end if;
  if not (coalesce(new.roles_plus, '{}') <@ hr_grantable() and coalesce(new.roles_minus, '{}') <@ hr_grantable()) then
    raise exception 'bad role';
  end if;
  new.roles_plus := array(select distinct r from unnest(coalesce(new.roles_plus, '{}')) r order by r);
  new.roles_minus := array(select distinct r from unnest(coalesce(new.roles_minus, '{}')) r where r <> all(new.roles_plus) order by r);
  return new;
end $$;
drop trigger if exists emp_guard on employees;
create trigger emp_guard before insert or update of reports_to, roles_plus, roles_minus on employees
  for each row execute function hr_emp_guard();

-- ---------------------------------------------------------------- templates with personal changes

-- internal: a person's roles = the position's template + their additions - their removals,
-- keeping `admin` where it already is
create or replace function hr_person_roles(p_code text, cur text[]) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select array(select distinct r from (
      select unnest(coalesce(p.roles, '{}') || coalesce(e.roles_plus, '{}')) r
        from employees e left join org_positions p on p.key = e.position where e.code = p_code) x
    where r <> all(coalesce((select roles_minus from employees where code = p_code), '{}'))
    union select 'admin' where 'admin' = any(coalesce(cur, '{}'))
    order by 1)
$$;

create or replace function hr_set_position(p_code text, p_position text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare u record;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if p_position is not null and not exists (select 1 from org_positions where key = p_position) then raise exception 'no such position'; end if;
  update employees set position = p_position where code = p_code;
  if not found then raise exception 'no such employee'; end if;
  for u in select user_id, roles from app_users where employee_code = p_code loop
    update app_users set roles = hr_person_roles(p_code, u.roles) where user_id = u.user_id;
    perform hr_sync_eval_for(u.user_id);
  end loop;
end $$;

create or replace function hr_apply_template(p_position text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare u record; n int := 0;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  for u in select a.user_id, a.roles, a.employee_code from app_users a join employees e on e.code = a.employee_code where e.position = p_position loop
    update app_users set roles = hr_person_roles(u.employee_code, u.roles) where user_id = u.user_id;
    perform hr_sync_eval_for(u.user_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- the admin changes one person's additions and removals; their account follows at once
create or replace function hr_set_person_roles(p_code text, p_plus text[], p_minus text[])
returns text[] language plpgsql security definer set search_path = public, pg_temp as $$
declare u record; r text[];
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  update employees set roles_plus = coalesce(p_plus, '{}'), roles_minus = coalesce(p_minus, '{}') where code = p_code;
  if not found then raise exception 'no such employee'; end if;
  for u in select user_id, roles from app_users where employee_code = p_code loop
    update app_users set roles = hr_person_roles(p_code, u.roles) where user_id = u.user_id;
    perform hr_sync_eval_for(u.user_id);
  end loop;
  r := hr_person_roles(p_code, '{}');
  return r;
end $$;

create or replace function hr_set_reports_to(p_code text, p_boss text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  update employees set reports_to = nullif(btrim(coalesce(p_boss, '')), '') where code = p_code;
  if not found then raise exception 'no such employee'; end if;
end $$;

-- linking an account to an employee gives it the person's roles (the invite's roles stay,
-- minus anything removed from this person)
create or replace function hr_link_template() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare minus text[];
begin
  if new.employee_code is not null and (tg_op = 'INSERT' or new.employee_code is distinct from old.employee_code) then
    select roles_minus into minus from employees where code = new.employee_code;
    new.roles := array(select distinct r from unnest(coalesce(new.roles, '{}') || hr_person_roles(new.employee_code, new.roles)) r
                       where r = 'admin' or r <> all(coalesce(minus, '{}')) order by r);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------- positions from the portal

create or replace function hr_add_position(p_title text, p_track text, p_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare k text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if coalesce(btrim(p_title), '') = '' or length(btrim(p_title)) > 60 then raise exception 'bad title'; end if;
  if p_track not in ('admin', 'sales', 'staff') then raise exception 'bad track'; end if;
  if not coalesce(p_roles, '{}') <@ hr_grantable() then raise exception 'bad role'; end if;
  if exists (select 1 from org_positions where title = btrim(p_title)) then raise exception 'duplicate title'; end if;
  k := 'p_' || translate(substr(md5(gen_random_uuid()::text), 1, 10), '0123456789', 'ghijklmnop');
  insert into org_positions (key, title, rank, roles, track, sort)
  values (k, btrim(p_title), case when p_track = 'admin' then 4 else 5 end,
          array(select distinct r from unnest(coalesce(p_roles, '{}')) r order by r), p_track,
          coalesce((select max(sort) from org_positions), 0) + 1);
  return k;
end $$;

-- only a position the admin added, and only while nobody holds it
create or replace function hr_drop_position(p_key text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if p_key not like 'p\_%' then raise exception 'built-in position'; end if;
  if exists (select 1 from employees where position = p_key) then raise exception 'position in use'; end if;
  delete from org_positions where key = p_key;
end $$;

-- ---------------------------------------------------------------- the chart

create or replace function hr_org_chart()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_member() then jsonb_build_object(
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent', parent_id, 'kind', kind, 'head', manager_code, 'sort', sort) order by sort, name) from teams), '[]'),
    'people', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', coalesce(nullif(name, ''), code), 'unit', team_id, 'position', position, 'job', job,
                          'reports', reports_to) order by name)
                        from employees where active), '[]')) end
$$;

-- ---------------------------------------------------------------- grants

revoke all on function hr_grantable(), hr_bosses(text), hr_manages(text), hr_decides(text), hr_manager_of(text), hr_emp_guard(),
  hr_person_roles(text, text[]), hr_set_position(text, text), hr_apply_template(text), hr_set_person_roles(text, text[], text[]),
  hr_set_reports_to(text, text), hr_link_template(), hr_add_position(text, text, text[]), hr_drop_position(text), hr_org_chart() from public;
grant execute on function hr_grantable(), hr_manages(text), hr_decides(text), hr_set_position(text, text), hr_apply_template(text),
  hr_set_person_roles(text, text[], text[]), hr_set_reports_to(text, text), hr_add_position(text, text, text[]), hr_drop_position(text),
  hr_org_chart() to authenticated;

commit;
