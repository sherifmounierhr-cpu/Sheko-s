-- Everest Eco System, part 8: the company structure and permissions by position.
--
-- Run in the Neon SQL Editor AFTER neon/007_todos.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
-- Teams become units in a tree (a department holds teams). Every employee has
-- a position; each position carries a template of roles, so linking an account
-- gives it the right permissions. A manager now sees every unit below the ones
-- they head, and the new role `viewall` sees the whole company. Salaries open
-- to the new role `pay`. Only the system admin changes any of this.

begin;

-- ---------------------------------------------------------------- units and positions

alter table teams add column if not exists parent_id int references teams(id) on delete set null;
alter table teams add column if not exists kind text not null default 'sales';
alter table teams add column if not exists sort int not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'teams_kind_check') then
    alter table teams add constraint teams_kind_check check (kind in ('dept', 'sales', 'team'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'teams_not_own_parent') then
    alter table teams add constraint teams_not_own_parent check (parent_id is distinct from id);
  end if;
end $$;

create table if not exists org_positions (
  key        text primary key check (key ~ '^[a-z_]{2,20}$'),
  title      text not null check (length(title) between 1 and 60),
  rank       int  not null default 5,
  roles      text[] not null default '{}',
  eval_cats  text[] not null default '{}',
  eval_scope text not null default 'none' check (eval_scope in ('none', 'below', 'sales')),
  sort       int  not null default 0
);
insert into org_positions (key, title, rank, roles, eval_cats, eval_scope, sort) values
  ('owner',  'صاحب عمل',              1, '{viewall,pay,manager,meetings}', '{}', 'none', 1),
  ('gm',     'المدير العام',           2, '{viewall,pay,manager,meetings}', '{}', 'none', 2),
  ('ops',    'مدير التشغيل',           3, '{manager}', '{}', 'none', 3),
  ('hr',     'مدير الموارد البشرية',   3, '{viewall,pay,recruiter,uploader,manager}', '{}', 'none', 4),
  ('bizdev', 'مدير تطوير الأعمال',     3, '{manager}', '{}', 'none', 5),
  ('social', 'مدير السوشيال ميديا',    3, '{manager,evaluator}', '{media}', 'sales', 6),
  ('lead',   'مدير فريق مبيعات',       4, '{manager,evaluator}', '{leads,attitude}', 'below', 7),
  ('sales',  'فرد مبيعات',             5, '{}', '{}', 'none', 8),
  ('staff',  'موظف',                   5, '{}', '{}', 'none', 9)
on conflict (key) do nothing;

alter table employees add column if not exists position text references org_positions(key) on update cascade on delete set null;

-- ---------------------------------------------------------------- the tree decides who manages whom

-- true when the caller sees employee `c` as a manager: the whole company with
-- `viewall`, or with `manager` any unit they head and everything below it
create or replace function hr_manages(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select c is not null and (hr_has('viewall') or ('manager' = any(hr_roles()) and exists (
    with recursive up as (
      select t.id, t.parent_id, t.manager_code, 1 as depth
        from employees e join teams t on t.id = e.team_id where e.code = c
      union all
      select p.id, p.parent_id, p.manager_code, up.depth + 1
        from up join teams p on p.id = up.parent_id where up.depth < 20)
    select 1 from up where up.manager_code is not null and up.manager_code = hr_my_code())))
$$;

-- the nearest head above an employee (their team's, else the department's);
-- a team lead's own request goes to the head above them
create or replace function hr_manager_of(c text) returns text
language sql stable security definer set search_path = public as $$
  with recursive up as (
    select t.id, t.parent_id, t.manager_code, 1 as depth
      from employees e join teams t on t.id = e.team_id where e.code = c
    union all
    select p.id, p.parent_id, p.manager_code, up.depth + 1
      from up join teams p on p.id = up.parent_id where up.depth < 20)
  select manager_code from up where manager_code is not null and manager_code <> c order by depth limit 1
$$;

-- every unit at or below `root`
create or replace function hr_units_below(root int) returns setof int
language sql stable security definer set search_path = public as $$
  with recursive dn as (
    select id, 1 as depth from teams where id = root
    union all
    select t.id, dn.depth + 1 from dn join teams t on t.parent_id = dn.id where dn.depth < 20)
  select id from dn
$$;

-- ---------------------------------------------------------------- templates

-- internal: give one login the weekly-evaluation columns its position carries
create or replace function hr_sync_eval_for(p_user text) returns int
language plpgsql security definer set search_path = public as $$
declare pos org_positions; c text; n int := 0;
begin
  select p.* into pos from app_users u join employees e on e.code = u.employee_code
    join org_positions p on p.key = e.position where u.user_id = p_user;
  if pos.key is null or pos.eval_scope = 'none' or cardinality(pos.eval_cats) = 0 then return 0; end if;
  select employee_code into c from app_users where user_id = p_user;
  insert into eval_assignments (user_id, team_id, category)
  select p_user, t.id, cat
  from teams t cross join unnest(pos.eval_cats) cat
  where t.kind in ('sales', 'team') and (
    (pos.eval_scope = 'sales' and t.kind = 'sales') or
    (pos.eval_scope = 'below' and t.id in (select hr_units_below(h.id) from teams h where h.manager_code = c)))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- internal: the roles a position gives, keeping `admin` where it already is
create or replace function hr_template_roles(cur text[], p_position text) returns text[]
language sql stable security definer set search_path = public as $$
  select array(select distinct r from unnest(
    coalesce((select roles from org_positions where key = p_position), '{}') ||
    case when 'admin' = any(coalesce(cur, '{}')) then array['admin'] else '{}'::text[] end) r order by r)
$$;

create or replace function hr_set_position(p_code text, p_position text)
returns void language plpgsql security definer set search_path = public as $$
declare u record;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if p_position is not null and not exists (select 1 from org_positions where key = p_position) then raise exception 'no such position'; end if;
  update employees set position = p_position where code = p_code;
  if not found then raise exception 'no such employee'; end if;
  for u in select user_id, roles from app_users where employee_code = p_code loop
    update app_users set roles = hr_template_roles(u.roles, p_position) where user_id = u.user_id;
    perform hr_sync_eval_for(u.user_id);
  end loop;
end $$;

-- after the admin edits a template: everyone holding the position gets it
create or replace function hr_apply_template(p_position text)
returns int language plpgsql security definer set search_path = public as $$
declare u record; n int := 0;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  for u in select a.user_id, a.roles from app_users a join employees e on e.code = a.employee_code where e.position = p_position loop
    update app_users set roles = hr_template_roles(u.roles, p_position) where user_id = u.user_id;
    perform hr_sync_eval_for(u.user_id);
    n := n + 1;
  end loop;
  return n;
end $$;

-- refresh evaluation columns for everyone (after units or heads change)
create or replace function hr_sync_eval_all()
returns int language plpgsql security definer set search_path = public as $$
declare u record; n int := 0;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  for u in select user_id from app_users where employee_code is not null loop n := n + hr_sync_eval_for(u.user_id); end loop;
  return n;
end $$;

-- linking an account to an employee gives it the position's template
create or replace function hr_link_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare pos text;
begin
  if new.employee_code is not null and (tg_op = 'INSERT' or new.employee_code is distinct from old.employee_code) then
    select position into pos from employees where code = new.employee_code;
    if pos is not null then
      new.roles := array(select distinct r from unnest(coalesce(new.roles, '{}') || hr_template_roles(new.roles, pos)) r order by r);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists link_template on app_users;
create trigger link_template before insert or update of employee_code on app_users
  for each row execute function hr_link_template();

create or replace function hr_link_eval() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.employee_code is not null and (tg_op = 'INSERT' or new.employee_code is distinct from old.employee_code) then
    perform hr_sync_eval_for(new.user_id);
  end if;
  return null;
end $$;
drop trigger if exists link_eval on app_users;
create trigger link_eval after insert or update of employee_code on app_users
  for each row execute function hr_link_eval();

-- invites may carry the two new roles
create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator', 'viewall', 'pay')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

-- ---------------------------------------------------------------- RLS

-- salaries and payroll: admin, or the `pay` role (owners, general manager, HR)
drop policy if exists pay_admin on employee_pay;
drop policy if exists payroll_admin on payroll;
drop policy if exists pay_rw on employee_pay;
drop policy if exists payroll_rw on payroll;
create policy pay_rw on employee_pay for all to authenticated using (hr_has('admin') or hr_has('pay')) with check (hr_has('admin') or hr_has('pay'));
create policy payroll_rw on payroll for all to authenticated using (hr_has('admin') or hr_has('pay')) with check (hr_has('admin') or hr_has('pay'));

alter table org_positions enable row level security;
drop policy if exists pos_read on org_positions;
drop policy if exists pos_admin on org_positions;
create policy pos_read on org_positions for select to authenticated using (true);
create policy pos_admin on org_positions for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- everyone with an account sees the org chart: names, titles and units only
create or replace function hr_org_chart()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when auth.user_id() is null then null else jsonb_build_object(
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent', parent_id, 'kind', kind, 'head', manager_code, 'sort', sort) order by sort, name) from teams), '[]'),
    'people', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', coalesce(nullif(name, ''), code), 'unit', team_id, 'position', position, 'job', job) order by name)
                        from employees where active), '[]')) end
$$;

drop trigger if exists audit on org_positions;
create trigger audit after insert or update or delete on org_positions for each row execute function hr_audit();
drop trigger if exists audit on teams;
create trigger audit after insert or update or delete on teams for each row execute function hr_audit();

-- ---------------------------------------------------------------- grants

grant select, insert, update, delete on org_positions to authenticated;
revoke all on function hr_units_below(int), hr_sync_eval_for(text), hr_template_roles(text[], text), hr_link_template(), hr_link_eval() from public, authenticated;
revoke all on function hr_set_position(text, text), hr_apply_template(text), hr_sync_eval_all(), hr_org_chart(), hr_create_invite(text, text[]) from public;
grant execute on function hr_set_position(text, text), hr_apply_template(text), hr_sync_eval_all(), hr_org_chart(), hr_create_invite(text, text[]),
  hr_manages(text), hr_manager_of(text) to authenticated;

commit;
