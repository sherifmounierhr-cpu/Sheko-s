-- Everest HR, part 2: employee portal.
--
-- Run in the Neon SQL Editor AFTER neon/schema.sql. Safe to re-run.
--
-- Adds:
--   invites        one-time codes an admin hands an employee to link their login
--   policy_items   the company rules (اللائحة), with a penalty per repeat
--   actions        penalties, warnings and exceptional bonuses
--                  (a team manager proposes, an admin approves)
--   notifications  what each employee sees in their own inbox
--   checkins       "I am here" with the phone's location, on demand only
--   comments       manager / employee discussion on a meeting, check-in, request or action
--   audit_log      who changed what on money, people and rules
-- and lets an employee file their own client meetings (pending until approved).

begin;

-- ---------------------------------------------------------------- tables

create table if not exists invites (
  token_hash    text primary key,          -- sha256 of the code; the code itself is never stored
  employee_code text not null references employees(code) on update cascade on delete cascade,
  roles         text[] not null default '{}',
  created_by    text default auth.user_id(),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '14 days',
  used_by       text,
  used_at       timestamptz
);

create table if not exists invite_failures (
  user_id text not null,
  at      timestamptz not null default now()
);

create table if not exists policy_items (
  id         serial primary key,
  ref        text,                          -- رقم البند
  category   text,
  title      text not null,
  body       text,
  -- penalty by occurrence in the same month: [{"kind":"warning"},{"kind":"days","value":0.25},...]
  steps      jsonb not null default '[]',
  active     boolean not null default true,
  sort       int not null default 0
);

create table if not exists actions (
  id             bigserial primary key,
  code           text not null references employees(code) on update cascade on delete cascade,
  kind           text not null check (kind in ('penalty', 'warning', 'bonus')),
  policy_item_id int references policy_items(id) on delete set null,
  occurrence     int,
  day            date not null default current_date,
  days           numeric not null default 0 check (days >= 0),
  amount         numeric not null default 0 check (amount >= 0),
  reason         text not null,
  status         text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  created_by     text default auth.user_id(),
  created_at     timestamptz not null default now(),
  decided_by     text,
  decided_at     timestamptz,
  decision_note  text,
  ack_at         timestamptz,
  objection      text,
  objection_at   timestamptz
);

create table if not exists notifications (
  id         bigserial primary key,
  code       text references employees(code) on update cascade on delete cascade,  -- an employee
  user_id    text,                                                                 -- or a login (admins)
  kind       text not null,
  title      text not null,
  body       text,
  ref_table  text,
  ref_id     bigint,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  check (code is not null or user_id is not null)
);

create table if not exists checkins (
  id         bigserial primary key,
  code       text not null references employees(code) on update cascade on delete cascade,
  ts         timestamptz not null default now(),
  kind       text not null default 'office' check (kind in ('office', 'meeting', 'site', 'other', 'leave')),
  lat        double precision check (lat between -90 and 90),
  lng        double precision check (lng between -180 and 180),
  accuracy   real,
  place      text,
  note       text,
  meeting_id bigint references meetings(id) on delete set null,
  created_by text default auth.user_id()
);

create table if not exists comments (
  id          bigserial primary key,
  ref_table   text not null check (ref_table in ('meetings', 'checkins', 'requests', 'actions')),
  ref_id      bigint not null,
  author_user text not null default auth.user_id(),
  author_code text,
  body        text not null check (length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);

create table if not exists audit_log (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  actor  text,
  tbl    text not null,
  op     text not null,
  old    jsonb,
  new    jsonb
);

-- meetings filed by the employee from the field
alter table meetings add column if not exists lat           double precision;
alter table meetings add column if not exists lng           double precision;
alter table meetings add column if not exists accuracy      real;
alter table meetings add column if not exists decided_by    text;
alter table meetings add column if not exists decided_at    timestamptz;
alter table meetings add column if not exists decision_note text;

create index if not exists actions_code on actions (code, day);
create index if not exists notif_code on notifications (code, created_at desc);
create index if not exists notif_user on notifications (user_id, created_at desc);
create index if not exists checkins_code on checkins (code, ts desc);
create index if not exists comments_ref on comments (ref_table, ref_id);
create index if not exists audit_at on audit_log (at desc);

-- one login per employee
do $$ begin
  create unique index if not exists app_users_code_uniq on app_users (employee_code) where employee_code is not null;
exception when unique_violation then
  raise notice 'two logins share an employee code; fix app_users then re-run to add the unique index';
end $$;

-- ---------------------------------------------------------------- helpers

-- the employee code that owns a row other tables point at
create or replace function hr_ref_code(t text, rid bigint) returns text
language plpgsql stable security definer set search_path = public as $$
declare c text;
begin
  case t
    when 'meetings' then select code into c from meetings where id = rid;
    when 'checkins' then select code into c from checkins where id = rid;
    when 'requests' then select code into c from requests where id = rid;
    when 'actions'  then select code into c from actions  where id = rid;
    else c := null;
  end case;
  return c;
end $$;

create or replace function hr_manager_of(c text) returns text
language sql stable security definer set search_path = public as $$
  select t.manager_code from employees e join teams t on t.id = e.team_id where e.code = c
$$;

-- internal: called by the functions and triggers below, never by the site
create or replace function hr_notify(p_code text, p_user text, p_kind text, p_title text, p_body text, p_table text, p_id bigint)
returns void language sql security definer set search_path = public as $$
  insert into notifications (code, user_id, kind, title, body, ref_table, ref_id)
  select p_code, p_user, p_kind, p_title, p_body, p_table, p_id
  where p_code is not null or p_user is not null
$$;

create or replace function hr_notify_admins(p_kind text, p_title text, p_body text, p_table text, p_id bigint)
returns void language sql security definer set search_path = public as $$
  insert into notifications (user_id, kind, title, body, ref_table, ref_id)
  select user_id, p_kind, p_title, p_body, p_table, p_id from app_users where 'admin' = any(roles)
$$;

-- ---------------------------------------------------------------- onboarding

-- Admin makes a one-time code for an employee and sends it to them (WhatsApp).
-- Only its hash is stored. Valid 14 days, once.
create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

-- The employee, signed in, types the code. Returns their name, or null when
-- the code is wrong, used or expired. Five wrong tries an hour locks it.
create or replace function hr_redeem_invite(token text)
returns text language plpgsql security definer set search_path = public as $$
declare inv invites; me text := auth.user_id(); nm text;
begin
  if me is null then return null; end if;
  if (select count(*) from invite_failures where user_id = me and at > now() - interval '1 hour') >= 5 then
    raise exception 'too many tries, wait an hour';
  end if;
  select * into inv from invites
   where token_hash = encode(sha256(convert_to(upper(trim(token)), 'UTF8')), 'hex')
     and used_at is null and expires_at > now();
  if inv.token_hash is null then
    insert into invite_failures (user_id) values (me);
    return null;
  end if;
  if exists (select 1 from app_users where employee_code = inv.employee_code and user_id <> me) then
    raise exception 'this employee already has a login';
  end if;
  insert into app_users (user_id, employee_code, roles) values (me, inv.employee_code, inv.roles)
  on conflict (user_id) do update
    set employee_code = excluded.employee_code,
        roles = (select array(select distinct unnest(app_users.roles || excluded.roles)));
  update invites set used_by = me, used_at = now() where token_hash = inv.token_hash;
  select name into nm from employees where code = inv.employee_code;
  return nm;
end $$;

-- ---------------------------------------------------------------- pay for the employee

-- Salary and this month's payroll line for the signed-in employee only.
-- The bank account comes back as its last 4 digits.
create or replace function hr_my_pay(ym text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'salary', p.salary,
    'pay_method', p.pay_method,
    'account_last4', right(p.account, 4),
    'payroll', (select to_jsonb(r) from payroll r where r.month = ym and r.code = p.code))
  from employee_pay p where p.code = hr_my_code()
$$;

-- ---------------------------------------------------------------- penalties and bonuses

-- A team manager proposes for someone in their team (pending); an admin's goes straight to approved.
create or replace function hr_propose_action(p_code text, p_kind text, p_reason text, p_day date default current_date,
  p_days numeric default 0, p_amount numeric default 0, p_policy int default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare rid bigint; occ int; st text;
begin
  if p_kind not in ('penalty', 'warning', 'bonus') then raise exception 'bad kind'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;
  if not (hr_has('admin') or (hr_manages(p_code) and p_code is distinct from hr_my_code())) then
    raise exception 'not allowed';
  end if;
  st := case when hr_has('admin') then 'approved' else 'pending' end;
  if p_policy is not null then
    select count(*) + 1 into occ from actions
     where code = p_code and policy_item_id = p_policy and date_trunc('month', day) = date_trunc('month', p_day)
       and status in ('pending', 'approved');
  end if;
  insert into actions (code, kind, policy_item_id, occurrence, day, days, amount, reason, status,
                       decided_by, decided_at)
  values (p_code, p_kind, p_policy, occ, p_day, coalesce(p_days, 0), coalesce(p_amount, 0), p_reason, st,
          case when st = 'approved' then auth.user_id() end, case when st = 'approved' then now() end)
  returning id into rid;
  return rid;
end $$;

create or replace function hr_decide_action(act_id bigint, new_status text, note text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if new_status not in ('approved', 'rejected', 'cancelled') then raise exception 'bad status'; end if;
  update actions set status = new_status, decision_note = note, decided_by = auth.user_id(), decided_at = now()
   where id = act_id;
  if not found then raise exception 'not found'; end if;
end $$;

-- The employee confirms they saw it, optionally with an objection (تظلم).
create or replace function hr_ack_action(act_id bigint, p_objection text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  update actions set ack_at = coalesce(ack_at, now()),
         objection = coalesce(nullif(trim(p_objection), ''), objection),
         objection_at = case when nullif(trim(p_objection), '') is not null then now() else objection_at end
   where id = act_id and code = hr_my_code() and status = 'approved';
  if not found then raise exception 'not allowed'; end if;
end $$;

-- ---------------------------------------------------------------- meetings from the field

create or replace function hr_decide_meeting(meet_id bigint, new_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if new_status not in ('pending', 'approved', 'rejected') then raise exception 'bad status'; end if;
  select code into c from meetings where id = meet_id;
  if c is null then raise exception 'not found'; end if;
  if not (hr_has('meetings') or (hr_manages(c) and c is distinct from hr_my_code())) then
    raise exception 'not allowed';
  end if;
  update meetings set status = new_status, decision_note = p_note, decided_by = auth.user_id(), decided_at = now()
   where id = meet_id;
end $$;

-- Location older than 90 days is dropped; the place text and time stay.
create or replace function hr_purge_locations() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not hr_has('admin') then return 0; end if;
  update checkins set lat = null, lng = null, accuracy = null
   where ts < now() - interval '90 days' and lat is not null;
  get diagnostics n = row_count;
  update meetings set lat = null, lng = null, accuracy = null
   where date < current_date - 90 and lat is not null;
  return n;
end $$;

-- ---------------------------------------------------------------- triggers

-- check-ins: the server sets the time and the author; the employee cannot backdate
create or replace function hr_checkin_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.ts := now();
  new.created_by := auth.user_id();
  return new;
end $$;
drop trigger if exists checkin_stamp on checkins;
create trigger checkin_stamp before insert on checkins for each row execute function hr_checkin_stamp();

create or replace function hr_comment_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.author_user := auth.user_id();
  new.author_code := hr_my_code();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists comment_stamp on comments;
create trigger comment_stamp before insert on comments for each row execute function hr_comment_stamp();

-- requests: tell the manager about a new one, the employee about the decision
create or replace function hr_requests_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare what text := new.type || ' ' || to_char(new.date_from, 'DD/MM');
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform hr_notify(hr_manager_of(new.code), null, 'request', 'طلب جديد مستني قرارك',
      (select name from employees where code = new.code) || ': ' || what, 'requests', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform hr_notify(new.code, null, 'request',
      case new.status when 'approved' then 'اتوافق على طلبك' else 'اترفض طلبك' end,
      what || coalesce(' - ' || new.decision_note, ''), 'requests', new.id);
  end if;
  return new;
end $$;
drop trigger if exists requests_notify on requests;
create trigger requests_notify after insert or update of status on requests for each row execute function hr_requests_notify();

create or replace function hr_meetings_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare what text := coalesce(new.kind, 'اجتماع') || coalesce(' - ' || new.client, '') || ' ' || to_char(new.date, 'DD/MM');
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform hr_notify(hr_manager_of(new.code), null, 'meeting', 'اجتماع جديد من الفريق',
      (select name from employees where code = new.code) || ': ' || what, 'meetings', new.id);
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status and new.status in ('approved', 'rejected') then
    perform hr_notify(new.code, null, 'meeting',
      case new.status when 'approved' then 'اتعتمد الاجتماع' else 'اترفض الاجتماع' end,
      what || coalesce(' - ' || new.decision_note, ''), 'meetings', new.id);
  end if;
  return new;
end $$;
drop trigger if exists meetings_notify on meetings;
create trigger meetings_notify after insert or update of status on meetings for each row execute function hr_meetings_notify();

-- actions: admins hear about proposals and objections, the employee about approved ones
create or replace function hr_actions_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  label text := case new.kind when 'penalty' then 'جزاء' when 'warning' then 'إنذار' else 'منحة استثنائية' end;
  val text := concat_ws(' + ',
    case when new.days > 0 then new.days::text || ' يوم' end,
    case when new.amount > 0 then new.amount::text || ' جنيه' end);
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform hr_notify(new.code, null, new.kind, label || coalesce(': ' || nullif(val, ''), ''),
      new.reason || ' (' || to_char(new.day, 'DD/MM/YYYY') || ')', 'actions', new.id);
  elsif tg_op = 'INSERT' and new.status = 'pending' then
    perform hr_notify_admins('action', 'مقترح ' || label || ' مستني اعتمادك',
      (select name from employees where code = new.code) || ': ' || new.reason, 'actions', new.id);
  elsif tg_op = 'UPDATE' and new.objection_at is distinct from old.objection_at and new.objection is not null then
    perform hr_notify_admins('objection', 'تظلم على ' || label,
      (select name from employees where code = new.code) || ': ' || new.objection, 'actions', new.id);
  end if;
  return new;
end $$;
drop trigger if exists actions_notify on actions;
create trigger actions_notify after insert or update on actions for each row execute function hr_actions_notify();

-- comments: the owner hears from others; the owner's comment goes to their manager
create or replace function hr_comments_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner text := hr_ref_code(new.ref_table, new.ref_id);
begin
  if owner is distinct from new.author_code then
    perform hr_notify(owner, null, 'comment', 'تعليق جديد', left(new.body, 200), new.ref_table, new.ref_id);
  else
    perform hr_notify(hr_manager_of(owner), null, 'comment',
      'رد من ' || (select name from employees where code = owner), left(new.body, 200), new.ref_table, new.ref_id);
  end if;
  return new;
end $$;
drop trigger if exists comments_notify on comments;
create trigger comments_notify after insert on comments for each row execute function hr_comments_notify();

-- overrides: tell the employee when a day's deduction is changed by hand
create or replace function hr_overrides_notify() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform hr_notify(new.code, null, 'override', 'تعديل خصم يوم ' || to_char(new.day, 'DD/MM'),
    coalesce('الخصم: ' || new.ded::text || ' يوم', 'اتلغى التعديل') || coalesce(' - ' || new.note, ''), null, null);
  return new;
end $$;
drop trigger if exists overrides_notify on overrides;
create trigger overrides_notify after insert or update of ded on overrides for each row execute function hr_overrides_notify();

-- audit trail on money, people, rules and roles
create or replace function hr_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_log (actor, tbl, op, old, new)
  values (auth.user_id(), tg_table_name, tg_op,
          case when tg_op <> 'INSERT' then to_jsonb(old) end,
          case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['employees', 'employee_pay', 'payroll', 'overrides', 'actions', 'policy_items',
                           'app_users', 'settings', 'teams', 'invites'] loop
    execute format('drop trigger if exists audit on %I', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function hr_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- RLS

alter table invites         enable row level security;
alter table invite_failures enable row level security;
alter table policy_items    enable row level security;
alter table actions         enable row level security;
alter table notifications   enable row level security;
alter table checkins        enable row level security;
alter table comments        enable row level security;
alter table audit_log       enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and (tablename in ('invites', 'invite_failures', 'policy_items', 'actions', 'notifications', 'checkins',
                       'comments', 'audit_log')
         or policyname in ('meet_self_insert', 'meet_self_update', 'meet_self_delete'))
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

create policy inv_admin on invites for select to authenticated using (hr_has('admin'));
create policy inv_admin_del on invites for delete to authenticated using (hr_has('admin'));

create policy pol_read on policy_items for select to authenticated using (true);
create policy pol_admin on policy_items for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- the employee sees their approved actions; the manager their team's; writes go through the functions
create policy act_read on actions for select to authenticated using (
  hr_has('admin') or hr_manages(code) or (code = hr_my_code() and status = 'approved'));

create policy notif_read on notifications for select to authenticated using (
  user_id = auth.user_id() or (code is not null and code = hr_my_code()));
create policy notif_mark on notifications for update to authenticated using (
  user_id = auth.user_id() or (code is not null and code = hr_my_code()));

-- check-ins: the employee writes their own; may delete within 10 minutes
create policy chk_read on checkins for select to authenticated using (
  hr_has('admin') or hr_manages(code) or code = hr_my_code());
create policy chk_insert on checkins for insert to authenticated with check (code = hr_my_code());
create policy chk_delete on checkins for delete to authenticated using (
  hr_has('admin') or (code = hr_my_code() and ts > now() - interval '10 minutes'));

-- comments on anything the commenter can see
create policy com_read on comments for select to authenticated using (
  hr_has('admin') or hr_manages(hr_ref_code(ref_table, ref_id)) or hr_ref_code(ref_table, ref_id) = hr_my_code());
create policy com_insert on comments for insert to authenticated with check (
  hr_has('admin') or hr_manages(hr_ref_code(ref_table, ref_id)) or hr_ref_code(ref_table, ref_id) = hr_my_code());

create policy audit_read on audit_log for select to authenticated using (hr_has('admin'));

-- meetings: an employee files their own from the field as pending and may fix or withdraw it while pending
create policy meet_self_insert on meetings for insert to authenticated with check (
  code = hr_my_code() and status = 'pending' and decided_by is null);
create policy meet_self_update on meetings for update to authenticated
  using (code = hr_my_code() and status = 'pending')
  with check (code = hr_my_code() and status = 'pending' and decided_by is null);
create policy meet_self_delete on meetings for delete to authenticated using (code = hr_my_code() and status = 'pending');

-- ---------------------------------------------------------------- grants

grant select, delete on invites to authenticated;
grant select, insert, update, delete on policy_items to authenticated;
grant select on actions to authenticated;
grant select on notifications to authenticated;
grant update (read_at) on notifications to authenticated;
grant select, insert, delete on checkins to authenticated;
grant select, insert on comments to authenticated;
grant select on audit_log to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke all on function hr_notify(text, text, text, text, text, text, bigint),
  hr_notify_admins(text, text, text, text, bigint) from public;
revoke all on function hr_create_invite(text, text[]), hr_redeem_invite(text), hr_my_pay(text),
  hr_propose_action(text, text, text, date, numeric, numeric, int), hr_decide_action(bigint, text, text),
  hr_ack_action(bigint, text), hr_decide_meeting(bigint, text, text), hr_purge_locations(),
  hr_ref_code(text, bigint), hr_manager_of(text) from public;
grant execute on function hr_create_invite(text, text[]), hr_redeem_invite(text), hr_my_pay(text),
  hr_propose_action(text, text, text, date, numeric, numeric, int), hr_decide_action(bigint, text, text),
  hr_ack_action(bigint, text), hr_decide_meeting(bigint, text, text), hr_purge_locations(),
  hr_ref_code(text, bigint), hr_manager_of(text) to authenticated;

commit;
