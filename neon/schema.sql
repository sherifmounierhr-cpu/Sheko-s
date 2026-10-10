-- Everest HR on Neon: attendance, requests, meetings and payroll.
--
-- Run once in the Neon SQL Editor AFTER enabling Neon Auth and the Data API
-- (the Data API creates the `authenticated` role this file grants to).
-- Every table has row level security; auth.user_id() is the signed-in user.
--
-- Roles live in app_users.roles (text[]):
--   admin      everything, including salaries, settings, users and teams
--   uploader   uploads the fingerprint device export
--   meetings   records client meetings for any employee
--   manager    approves or rejects requests from the team they manage
--   (none)     an employee: sends their own requests, sees their own attendance
-- An employee is linked to a login through app_users.employee_code.

begin;

-- ---------------------------------------------------------------- tables

create table if not exists teams (
  id           serial primary key,
  name         text not null unique,
  manager_code text            -- employees.code of the team manager
);

create table if not exists employees (
  code        text primary key,  -- the fingerprint device code
  name        text not null,
  full_name   text,
  device_name text,
  team_id     int references teams(id) on delete set null,
  job         text,
  dept        text,
  shift_in    time,
  shift_out   time,
  off_day     smallint check (off_day between 0 and 6),  -- 0 = Sunday
  exempt      boolean not null default false,            -- exempt from fingerprint
  active      boolean not null default true
);

alter table teams drop constraint if exists teams_manager_fk;
alter table teams add constraint teams_manager_fk
  foreign key (manager_code) references employees(code) on update cascade on delete set null;

-- Salary and bank details are kept apart so only admins can read them.
create table if not exists employee_pay (
  code       text primary key references employees(code) on update cascade on delete cascade,
  salary     numeric not null default 0,
  account    text,
  pay_method text not null default 'cash' check (pay_method in ('bank', 'cash'))
);

create table if not exists app_users (
  user_id       text primary key default auth.user_id(),
  email         text,
  display_name  text,
  employee_code text references employees(code) on update cascade on delete set null,
  roles         text[] not null default '{}',
  created_at    timestamptz not null default now()
);

create table if not exists punches (
  id          bigserial primary key,
  code        text not null,
  ts          timestamp not null,
  uploaded_by text default auth.user_id(),
  uploaded_at timestamptz not null default now(),
  unique (code, ts)
);

create table if not exists requests (
  id            bigserial primary key,
  code          text not null references employees(code) on update cascade on delete cascade,
  type          text not null,          -- إذن تأخير / إذن انصراف مبكر / إذن خلال اليوم / إجازة ...
  date_from     date not null,
  date_to       date,
  time_from     time,
  time_to       time,
  reason        text,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,
  created_by    text default auth.user_id(),
  created_at    timestamptz not null default now()
);

create table if not exists meetings (
  id         bigserial primary key,
  code       text not null references employees(code) on update cascade on delete cascade,
  date       date not null,
  time_from  time not null,
  time_to    time not null,
  kind       text,
  client     text,
  phone      text,
  project    text,
  place      text,
  source     text,
  result     text,
  follow_up  date,
  status     text not null default 'approved' check (status in ('pending', 'approved', 'rejected')),
  note       text,
  created_by text default auth.user_id(),
  created_at timestamptz not null default now()
);

create table if not exists overrides (
  code text not null references employees(code) on update cascade on delete cascade,
  day  date not null,
  ded  numeric,
  note text,
  primary key (code, day)
);

create table if not exists payroll (
  month         text not null,   -- 'YYYY-MM'
  code          text not null references employees(code) on update cascade on delete cascade,
  commission    numeric not null default 0,
  ret           numeric not null default 0,
  approved_days numeric,         -- HR's approved deduction days; null = use attendance
  late_amt      numeric,         -- fixed lateness deduction amount; overrides days x rate
  admin_ded     numeric not null default 0,
  days_ded      numeric not null default 0,
  reg_ded       numeric not null default 0,
  advance       numeric not null default 0,
  note          text,
  primary key (month, code)
);

create table if not exists settings (
  id   int primary key default 1 check (id = 1),
  data jsonb not null
);

create index if not exists punches_code_ts on punches (code, ts);
create index if not exists requests_code on requests (code, date_from);
create index if not exists meetings_code on meetings (code, date);

-- ---------------------------------------------------------------- helpers
-- security definer so policies can read app_users/teams without recursing
-- through their own RLS.

create or replace function hr_roles() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select roles from app_users where user_id = auth.user_id()), '{}')
$$;

create or replace function hr_has(role text) returns boolean
language sql stable security definer set search_path = public as $$
  select role = any(hr_roles()) or 'admin' = any(hr_roles())
$$;

create or replace function hr_my_code() returns text
language sql stable security definer set search_path = public as $$
  select employee_code from app_users where user_id = auth.user_id()
$$;

-- true when the signed-in user is a manager and `c` is in a team they manage
create or replace function hr_manages(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select 'manager' = any(hr_roles()) and exists (
    select 1 from employees e join teams t on t.id = e.team_id
    where e.code = c and t.manager_code = hr_my_code())
$$;

-- The first person to call this becomes admin, and only while nobody is.
create or replace function hr_claim_admin() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.user_id() is null then return false; end if;
  if exists (select 1 from app_users where 'admin' = any(roles)) then return false; end if;
  insert into app_users (user_id, roles) values (auth.user_id(), '{admin}')
  on conflict (user_id) do update set roles = array_append(app_users.roles, 'admin');
  return true;
end $$;

-- Requests are decided through this function so a manager can change the
-- status and nothing else, and never on their own request.
create or replace function hr_decide_request(req_id bigint, new_status text, note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if new_status not in ('pending', 'approved', 'rejected') then raise exception 'bad status'; end if;
  select code into c from requests where id = req_id;
  if c is null then raise exception 'not found'; end if;
  if not (hr_has('admin') or (hr_manages(c) and c is distinct from hr_my_code())) then
    raise exception 'not allowed';
  end if;
  update requests set status = new_status, decision_note = note,
         decided_by = auth.user_id(), decided_at = now()
   where id = req_id;
end $$;

revoke all on function hr_claim_admin(), hr_decide_request(bigint, text, text) from public;

-- Months that have punches the caller may see (RLS applies: security invoker).
create or replace function hr_punch_months() returns setof text
language sql stable as $$
  select distinct to_char(ts, 'YYYY-MM') from punches order by 1 desc
$$;

-- The latest day any punch exists, so days after it are "not yet" rather
-- than absences, even for someone who can only see their own punches.
create or replace function hr_last_punch_day() returns date
language sql stable security definer set search_path = public as $$
  select max(ts)::date from punches
$$;

-- ---------------------------------------------------------------- RLS

alter table teams        enable row level security;
alter table employees    enable row level security;
alter table employee_pay enable row level security;
alter table app_users    enable row level security;
alter table punches      enable row level security;
alter table requests     enable row level security;
alter table meetings     enable row level security;
alter table overrides    enable row level security;
alter table payroll      enable row level security;
alter table settings     enable row level security;

-- drop and recreate so the file can be re-run
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('teams','employees','employee_pay','app_users','punches','requests',
                      'meetings','overrides','payroll','settings')
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

-- teams and settings: everyone signed in reads, admins write
create policy teams_read  on teams    for select to authenticated using (true);
create policy teams_admin on teams    for all    to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy set_read    on settings for select to authenticated using (true);
create policy set_admin   on settings for all    to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- employees: staff roles see everyone, a manager their team, an employee themself
create policy emp_read on employees for select to authenticated using (
  hr_has('uploader') or hr_has('meetings') or hr_manages(code) or code = hr_my_code());
create policy emp_admin on employees for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- salaries and bank accounts: admins only
create policy pay_admin on employee_pay for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy payroll_admin on payroll  for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- app_users: you read your own row and may create it once, with no roles;
-- only admins assign roles and employee codes
create policy users_self_read on app_users for select to authenticated using (user_id = auth.user_id() or hr_has('admin'));
create policy users_self_insert on app_users for insert to authenticated
  with check (user_id = auth.user_id() and roles = '{}' and employee_code is null);
create policy users_admin_update on app_users for update to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy users_admin_delete on app_users for delete to authenticated using (hr_has('admin'));

-- punches: uploaders write; everyone reads what they may see
create policy punch_read on punches for select to authenticated using (
  hr_has('uploader') or hr_manages(code) or code = hr_my_code());
create policy punch_write on punches for insert to authenticated with check (hr_has('uploader'));
create policy punch_delete on punches for delete to authenticated using (hr_has('uploader'));

-- requests: an employee files their own as pending and may withdraw it
-- while pending; managers and admins decide through hr_decide_request()
create policy req_read on requests for select to authenticated using (
  hr_has('admin') or hr_manages(code) or code = hr_my_code());
create policy req_insert on requests for insert to authenticated with check (
  hr_has('admin') or (code = hr_my_code() and status = 'pending' and decided_by is null));
create policy req_admin_update on requests for update to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy req_delete on requests for delete to authenticated using (
  hr_has('admin') or (code = hr_my_code() and status = 'pending'));

-- meetings: the meetings role and admins write; managers see their team
create policy meet_read on meetings for select to authenticated using (
  hr_has('meetings') or hr_manages(code) or code = hr_my_code());
create policy meet_write on meetings for all to authenticated using (hr_has('meetings')) with check (hr_has('meetings'));

-- deduction overrides: admins write; managers and the employee read
create policy ovr_read on overrides for select to authenticated using (
  hr_has('admin') or hr_manages(code) or code = hr_my_code());
create policy ovr_admin on overrides for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- ---------------------------------------------------------------- grants

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function hr_roles(), hr_has(text), hr_my_code(), hr_manages(text),
  hr_claim_admin(), hr_decide_request(bigint, text, text),
  hr_punch_months(), hr_last_punch_day() to authenticated;

insert into settings (id, data) values (1, '{}'::jsonb) on conflict (id) do nothing;

commit;
