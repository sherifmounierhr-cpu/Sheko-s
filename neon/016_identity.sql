-- Everest Eco System, part 16: a signed-in request that arrives without its identity fails loudly.
--
-- Run in the Neon SQL Editor AFTER neon/015_com_import.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
-- On the first load, some reads came back empty with no error (employees,
-- to-dos, applications, payroll) while others in the same burst, with the same
-- sign-in, came back full. The reading: the Data API ran those requests as
-- `authenticated` but without the user's identity, so every permission check
-- said "nobody" and the rows were filtered out silently.
--
-- Now the permission helpers raise "no identity" in that case. The request
-- fails instead of looking empty, and the portal retries it (hr/js/db.js).
-- Who may see what doesn't change. The public forms (`anonymous`), the device
-- login and the SQL Editor are not affected.

begin;

create or replace function hr_need_identity() returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('role', true), '') = 'authenticated' and auth.user_id() is null then
    raise exception 'no identity' using hint = 'signed-in request arrived without its user; retry';
  end if;
end $$;

-- same as neon/011_cv_leavers.sql, plus the check
create or replace function hr_roles() returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform hr_need_identity();
  return coalesce((
    select case when u.employee_code is null or coalesce(e.active, true) then u.roles
                when 'admin' = any(u.roles) then array['admin']
                else '{}'::text[] end
    from app_users u left join employees e on e.code = u.employee_code
    where u.user_id = auth.user_id()), '{}');
end $$;

create or replace function hr_my_code() returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform hr_need_identity();
  return (select u.employee_code from app_users u join employees e on e.code = u.employee_code
          where u.user_id = auth.user_id() and coalesce(e.active, true));
end $$;

revoke all on function hr_need_identity(), hr_roles(), hr_my_code() from public;
grant execute on function hr_need_identity(), hr_roles(), hr_my_code() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'grant execute on function hr_need_identity(), hr_roles() to anonymous';
  end if;
end $$;

commit;
