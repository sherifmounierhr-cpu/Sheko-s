-- Everest Eco System, part 19: people who stopped punching.
--
-- Run in the Neon SQL Editor AFTER neon/018_org_view.sql. Safe to re-run.
-- It adds two columns and changes no existing data. Then: notify pgrst, 'reload schema';
--
--   * The fingerprint upload page lists, for the admin, everyone working who has
--     no punch in the 14 days before the last day the device sent. New hires of
--     the last 14 days and people exempt from the fingerprint are left out.
--   * Each one gets three choices:
--       ساب الشغل      -> not working any more (active = false, left_on = today):
--                         locked out, records kept, can be ticked back.
--       فريلانس        -> work_type = 'freelance' and exempt: out of attendance and
--                         payroll, but the account keeps working (leads, commissions).
--       معفى من البصمة -> exempt only.

begin;

alter table employees add column if not exists work_type text not null default 'staff';
alter table employees drop constraint if exists employees_work_type_check;
alter table employees add constraint employees_work_type_check check (work_type in ('staff', 'freelance'));
alter table employees add column if not exists left_on date;

-- The reference day is the last day the device sent anything, so a late upload
-- doesn't make everyone look absent.
drop function if exists hr_no_punch(int);
create function hr_no_punch(p_days int default 14)
returns table (code text, name text, team_id int, job text, hire_date date, last_punch date)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ref date; d int := least(greatest(coalesce(p_days, 14), 3), 90);
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  select max(ts)::date into ref from punches;
  if ref is null then return; end if;
  return query
    select e.code, coalesce(nullif(e.name, ''), e.code), e.team_id, e.job, e.hire_date,
           (select max(p.ts)::date from punches p where p.code = e.code)
      from employees e
     where coalesce(e.active, true) and not coalesce(e.exempt, false) and e.work_type = 'staff'
       and (e.hire_date is null or e.hire_date <= ref - d)
       and not exists (select 1 from punches p where p.code = e.code and p.ts >= ref - d + 1)
     order by 6 nulls first, 2;
end $$;

revoke all on function hr_no_punch(int) from public;
grant execute on function hr_no_punch(int) to authenticated;

commit;

notify pgrst, 'reload schema';
