-- Everest Eco System, part 18: the company structure is no longer open to everyone.
--
-- Run in the Neon SQL Editor AFTER neon/017_com_deductions.sql. Safe to re-run.
-- It changes no data. Then: notify pgrst, 'reload schema';
--
--   * The structure (units, who's in them, positions, who reports to whom) is
--     seen by the system admin, by "يشوف الشركة كلها" (viewall), and by anyone
--     given the new permission "يشوف الهيكل" (org_view). Everyone else gets nothing.
--   * org_view can be granted like the others: in a position's template or as a
--     personal addition.

begin;

create or replace function hr_grantable() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['viewall', 'approveall', 'manager', 'pay', 'leads_assign', 'recruiter', 'uploader', 'meetings', 'evaluator', 'org_view']
$$;

create or replace function hr_org_chart()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_has('viewall') or hr_has('org_view') then jsonb_build_object(
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent', parent_id, 'kind', kind, 'head', manager_code, 'sort', sort) order by sort, name) from teams), '[]'),
    'people', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', coalesce(nullif(name, ''), code), 'unit', team_id, 'position', position, 'job', job,
                          'reports', reports_to) order by name)
                        from employees where active), '[]')) end
$$;

-- activation codes can carry the new permission too (same as neon/012_crm.sql plus org_view)
create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code and coalesce(active, true)) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator',
       'viewall', 'approveall', 'pay', 'leads_assign', 'org_view')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

revoke all on function hr_org_chart(), hr_create_invite(text, text[]) from public;
grant execute on function hr_org_chart(), hr_create_invite(text, text[]) to authenticated;

commit;

notify pgrst, 'reload schema';
