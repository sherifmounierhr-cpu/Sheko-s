-- Everest Eco System, part 10: security hardening.
--
-- Run in the Neon SQL Editor AFTER neon/009_device.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
-- What changes:
--   * Seeing and deciding are now two permissions. `viewall` sees the whole
--     company; the new `approveall` may also decide (requests, meetings,
--     penalties, to-dos) for anyone. A manager still decides for their tree.
--     Nobody decides on their own request.
--   * The `pay` role can't change their own salary or payroll line.
--   * The fingerprint device only sends punches for known employees, from the
--     last few days. Uploaders can't touch their own punches; every punch
--     change lands in the audit log.
--   * The meetings role can't approve their own meeting.
--   * A login that isn't linked to an employee (and has no role) sees nothing.
--   * "Become admin" works only on a brand-new system, never again later.
--   * An employee doesn't see comments on a penalty that isn't approved yet.
--   * Quiz time is checked by the server.
--   * The public apply form is harder to flood shut.
--   * A login's email comes from the sign-in service, not from the browser.

begin;

-- ---------------------------------------------------------------- see vs decide

-- visibility (all read policies use this): the tree, or the whole company
-- with `viewall` or `approveall`
create or replace function hr_manages(c text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c is not null and (hr_has('viewall') or hr_has('approveall') or ('manager' = any(hr_roles()) and exists (
    with recursive up as (
      select t.id, t.parent_id, t.manager_code, 1 as depth
        from employees e join teams t on t.id = e.team_id where e.code = c
      union all
      select p.id, p.parent_id, p.manager_code, up.depth + 1
        from up join teams p on p.id = up.parent_id where up.depth < 20)
    select 1 from up where up.manager_code is not null and up.manager_code = hr_my_code())))
$$;

-- decisions: the head of a unit above them, or `approveall`; never oneself
create or replace function hr_decides(c text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select c is not null and c is distinct from hr_my_code() and (hr_has('approveall') or ('manager' = any(hr_roles()) and exists (
    with recursive up as (
      select t.id, t.parent_id, t.manager_code, 1 as depth
        from employees e join teams t on t.id = e.team_id where e.code = c
      union all
      select p.id, p.parent_id, p.manager_code, up.depth + 1
        from up join teams p on p.id = up.parent_id where up.depth < 20)
    select 1 from up where up.manager_code is not null and up.manager_code = hr_my_code())))
$$;

-- a real member of the company: linked to an employee, or given any role
create or replace function hr_member() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_my_code() is not null or cardinality(hr_roles()) > 0
$$;

create or replace function hr_decide_request(req_id bigint, new_status text, note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  if new_status not in ('pending', 'approved', 'rejected') then raise exception 'bad status'; end if;
  select code into c from requests where id = req_id;
  if c is null then raise exception 'not found'; end if;
  if not (hr_has('admin') or hr_decides(c)) then raise exception 'not allowed'; end if;
  update requests set status = new_status, decision_note = note,
         decided_by = auth.user_id(), decided_at = now()
   where id = req_id;
end $$;

create or replace function hr_propose_action(p_code text, p_kind text, p_reason text, p_day date default current_date,
  p_days numeric default 0, p_amount numeric default 0, p_policy int default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare rid bigint; occ int; st text;
begin
  if p_kind not in ('penalty', 'warning', 'bonus') then raise exception 'bad kind'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'reason required'; end if;
  if not (hr_has('admin') or hr_decides(p_code)) then raise exception 'not allowed'; end if;
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

-- the meetings role decides for everyone but themself
create or replace function hr_decide_meeting(meet_id bigint, new_status text, p_note text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  if new_status not in ('pending', 'approved', 'rejected') then raise exception 'bad status'; end if;
  select code into c from meetings where id = meet_id;
  if c is null then raise exception 'not found'; end if;
  if not (hr_has('admin') or hr_decides(c) or (hr_has('meetings') and c is distinct from hr_my_code())) then
    raise exception 'not allowed';
  end if;
  update meetings set status = new_status, decision_note = p_note, decided_by = auth.user_id(), decided_at = now()
   where id = meet_id;
end $$;

drop policy if exists meet_write on meetings;
create policy meet_write on meetings for all to authenticated
  using (hr_has('meetings') and (hr_has('admin') or code is distinct from hr_my_code()))
  with check (hr_has('meetings') and (hr_has('admin') or code is distinct from hr_my_code()));

-- training: rating a trainee as their mentor or manager is a decision too
create or replace function hr_survey_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text;
begin
  -- the SQL Editor (no signed-in user) isn't limited
  if new.side = 'mentor' and auth.user_id() is not null then
    select code into c from training_plans where id = new.plan_id;
    if not (hr_has('admin') or hr_decides(c) or (hr_mentors(c) and c is distinct from hr_my_code())) then
      raise exception 'not allowed';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists survey_guard on survey_responses;
create trigger survey_guard before insert or update on survey_responses for each row execute function hr_survey_guard();

-- ---------------------------------------------------------------- to-dos

-- may the signed-in user write to employee `c`'s list? (themself, a manager above them, admin)
create or replace function hr_todo_write(c text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_has('admin') or hr_decides(c) or (c is not null and c = hr_my_code())
$$;

alter table todos add column if not exists spawned_id bigint;

create or replace function hr_todo_add(p_code text, p_title text, p_note text, p_due date, p_priority text, p_repeat text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare tid bigint; me text := hr_my_code(); who text;
begin
  if p_code is null or not hr_todo_write(p_code) then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = p_code) then raise exception 'unknown employee'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'title required'; end if;
  insert into todos (code, title, note, due, priority, repeat, created_by, created_by_code)
  values (p_code, btrim(p_title), nullif(btrim(p_note), ''), p_due,
          case when p_priority = 'high' then 'high' else 'normal' end,
          case when p_repeat in ('daily', 'weekly') then p_repeat else 'none' end,
          auth.user_id(), me)
  returning id into tid;
  if me is distinct from p_code then
    select coalesce(nullif(name, ''), code) into who from employees where code = me;
    perform hr_notify(p_code, null, 'todo', 'مهمة جديدة: ' || btrim(p_title),
      coalesce('من ' || who, 'من الإدارة') || coalesce(' · التسليم ' || to_char(p_due, 'DD/MM'), ''), 'todos', tid);
  end if;
  return tid;
end $$;

-- Finish (or reopen) a task. Finishing a repeating task adds the next one,
-- once: reopening and finishing again doesn't add another.
create or replace function hr_todo_set(p_id bigint, p_done boolean)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare t todos; nid bigint; who text;
begin
  select * into t from todos where id = p_id for update;
  if not found or not hr_todo_write(t.code) then raise exception 'not allowed'; end if;
  if t.status = 'cancelled' then raise exception 'cancelled'; end if;
  if p_done then
    if t.status = 'done' then return null; end if;
    update todos set status = 'done', done_at = now(), done_by = auth.user_id() where id = p_id;
    if t.created_by is distinct from auth.user_id() and t.created_by is not null then
      select coalesce(nullif(name, ''), code) into who from employees where code = t.code;
      perform hr_notify(null, t.created_by, 'todo', coalesce(who, t.code) || ' خلّص: ' || t.title, null, 'todos', p_id);
    end if;
    if t.repeat <> 'none' and t.spawned_id is null then
      insert into todos (code, title, note, due, priority, repeat, created_by, created_by_code)
      values (t.code, t.title, t.note,
              hr_todo_next(greatest(coalesce(t.due, (now() at time zone 'Africa/Cairo')::date), (now() at time zone 'Africa/Cairo')::date), t.repeat),
              t.priority, t.repeat, t.created_by, t.created_by_code)
      returning id into nid;
      update todos set spawned_id = nid where id = p_id;
    end if;
    return nid;
  end if;
  update todos set status = 'open', done_at = null, done_by = null where id = p_id;
  return null;
end $$;

create or replace function hr_todo_edit(p_id bigint, p_title text, p_note text, p_due date, p_priority text, p_repeat text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t todos;
begin
  select * into t from todos where id = p_id;
  if not found or not ((t.created_by = auth.user_id() and hr_todo_write(t.code)) or hr_has('admin') or hr_decides(t.code)) then
    raise exception 'not allowed';
  end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'title required'; end if;
  update todos set title = btrim(p_title), note = nullif(btrim(p_note), ''), due = p_due,
    priority = case when p_priority = 'high' then 'high' else 'normal' end,
    repeat = case when p_repeat in ('daily', 'weekly') then p_repeat else 'none' end
  where id = p_id;
end $$;

create or replace function hr_todo_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare t todos;
begin
  select * into t from todos where id = p_id;
  if not found or not ((t.created_by = auth.user_id() and hr_todo_write(t.code)) or hr_has('admin') or hr_decides(t.code)) then
    raise exception 'not allowed';
  end if;
  update todos set status = 'cancelled' where id = p_id;
end $$;

-- ---------------------------------------------------------------- positions and invites

-- owners and the general manager decide for the whole company; HR sees it
update org_positions set roles = '{approveall,manager,meetings,pay,viewall}' where key in ('owner', 'gm')
  and roles = '{viewall,pay,manager,meetings}';

create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator', 'viewall', 'approveall', 'pay')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

-- ---------------------------------------------------------------- salaries

-- the `pay` role reads everyone's, and changes everyone's but their own
drop policy if exists pay_rw on employee_pay;
drop policy if exists payroll_rw on payroll;
drop policy if exists pay_read on employee_pay;
drop policy if exists pay_write on employee_pay;
drop policy if exists payroll_read on payroll;
drop policy if exists payroll_write on payroll;
create policy pay_read on employee_pay for select to authenticated using (hr_has('admin') or hr_has('pay'));
create policy pay_write on employee_pay for all to authenticated
  using (hr_has('admin') or (hr_has('pay') and code is distinct from hr_my_code()))
  with check (hr_has('admin') or (hr_has('pay') and code is distinct from hr_my_code()));
create policy payroll_read on payroll for select to authenticated using (hr_has('admin') or hr_has('pay'));
create policy payroll_write on payroll for all to authenticated
  using (hr_has('admin') or (hr_has('pay') and code is distinct from hr_my_code()))
  with check (hr_has('admin') or (hr_has('pay') and code is distinct from hr_my_code()));

-- ---------------------------------------------------------------- punches

-- from the device: known employees only, and only the last few days (or since
-- just before the last punch it sent, so a device that was offline catches up)
create or replace function hr_device_punches(p_serial text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; latest timestamp; skipped int := 0; floor_ts timestamp; now_c timestamp := now() at time zone 'Africa/Cairo';
begin
  select least(now_c - interval '3 days', coalesce(last_punch - interval '1 day', now_c)) into floor_ts from devices where serial = p_serial;
  if not found then raise exception 'unknown device'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'bad rows'; end if;
  with src as (
    select btrim(r->>0) as code, date_trunc('minute', (r->>1)::timestamp) as ts
    from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r) = 'array' and coalesce(btrim(r->>0), '') ~ '^[0-9A-Za-z]{1,20}$'
      and coalesce(r->>1, '') ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$'),
  win as (
    select s.code, s.ts, exists (select 1 from employees e where e.code = s.code) as known
    from src s where s.ts >= floor_ts and s.ts <= now_c + interval '1 day'),
  ins as (
    insert into punches (code, ts, uploaded_by)
    select code, ts, 'device:' || p_serial from win where known
    on conflict (code, ts) do nothing
    returning ts)
  select (select count(*) from ins), (select max(ts) from ins), (select count(*) from win where not known)
    into n, latest, skipped;
  update devices set last_seen = now(), last_count = n,
    last_error = case when skipped > 0 then skipped || ' بصمة لكود مش متسجل في الموظفين' end,
    error_at = case when skipped > 0 then clock_timestamp() else error_at end,
    last_punch = greatest(last_punch, latest) where serial = p_serial;
  return n;
end $$;

-- from an uploader: the server stamps who uploaded; an uploader's own punches
-- are skipped (the device sends those); admins aren't limited
create or replace function hr_punch_stamp() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  -- inside a server function (the device) current_user is the owner: keep its stamp
  if current_user <> 'authenticated' then return new; end if;
  new.uploaded_by := auth.user_id();
  new.uploaded_at := now();
  if not hr_has('admin') and new.code = hr_my_code() then return null; end if;
  return new;
end $$;
drop trigger if exists punch_stamp on punches;
create trigger punch_stamp before insert on punches for each row execute function hr_punch_stamp();

drop policy if exists punch_write on punches;
drop policy if exists punch_delete on punches;
create policy punch_write on punches for insert to authenticated with check (
  hr_has('uploader') and (hr_has('admin') or code is distinct from hr_my_code()));
create policy punch_delete on punches for delete to authenticated using (
  hr_has('uploader') and (hr_has('admin') or code is distinct from hr_my_code()));

-- ---------------------------------------------------------------- reads for members only

drop policy if exists teams_read on teams;
create policy teams_read on teams for select to authenticated using (hr_member());
drop policy if exists set_read on settings;
create policy set_read on settings for select to authenticated using (hr_member());
drop policy if exists pol_read on policy_items;
create policy pol_read on policy_items for select to authenticated using (hr_member());
drop policy if exists pos_read on org_positions;
create policy pos_read on org_positions for select to authenticated using (hr_member());
drop policy if exists st_read on survey_templates;
create policy st_read on survey_templates for select to authenticated using (hr_member());
drop policy if exists tv_read on training_videos;
create policy tv_read on training_videos for select to authenticated using (hr_member());
drop policy if exists ew_read on eval_weeks;
create policy ew_read on eval_weeks for select to authenticated using (hr_member());
drop policy if exists tp_plan_read on team_month_plans;
create policy tp_plan_read on team_month_plans for select to authenticated using (hr_member());

create or replace function hr_org_chart()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_member() then jsonb_build_object(
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent', parent_id, 'kind', kind, 'head', manager_code, 'sort', sort) order by sort, name) from teams), '[]'),
    'people', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'name', coalesce(nullif(name, ''), code), 'unit', team_id, 'position', position, 'job', job) order by name)
                        from employees where active), '[]')) end
$$;

create or replace function hr_quiz_list()
returns setof jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', id, 'video_id', video_id, 'pass_mark', pass_mark, 'max_attempts', max_attempts,
                            'minutes', minutes, 'count', jsonb_array_length(questions))
  from quizzes where hr_member() order by id
$$;

-- ---------------------------------------------------------------- admin claim

-- only on a brand-new system: never once anyone has been admin
create or replace function hr_claim_admin() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.user_id() is null then return false; end if;
  perform pg_advisory_xact_lock(hashtext('hr_claim_admin'));
  if exists (select 1 from app_users where 'admin' = any(roles)) then return false; end if;
  if exists (select 1 from audit_log where tbl = 'app_users' and (new->'roles' ? 'admin' or old->'roles' ? 'admin')) then return false; end if;
  if coalesce((select data->>'admin_claimed' from settings where id = 1), '') = 'yes' then return false; end if;
  insert into app_users (user_id, roles) values (auth.user_id(), '{admin}')
  on conflict (user_id) do update set roles = array_append(app_users.roles, 'admin');
  update settings set data = data || '{"admin_claimed": "yes"}' where id = 1;
  return true;
end $$;
update settings set data = data || '{"admin_claimed": "yes"}'
 where id = 1 and exists (select 1 from app_users where 'admin' = any(roles));

-- ---------------------------------------------------------------- notifications and comments

drop policy if exists notif_mark on notifications;
create policy notif_mark on notifications for update to authenticated
  using (user_id = auth.user_id() or (code is not null and code = hr_my_code()))
  with check (user_id = auth.user_id() or (code is not null and code = hr_my_code()));

-- who owns the row a comment points at; only answers for rows the caller may see
create or replace function hr_ref_code(t text, rid bigint) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c text;
begin
  case t
    when 'meetings' then select code into c from meetings where id = rid;
    when 'checkins' then select code into c from checkins where id = rid;
    when 'requests' then select code into c from requests where id = rid;
    when 'actions'  then select code into c from actions  where id = rid;
    else c := null;
  end case;
  if c is null or hr_has('admin') or hr_manages(c) or c = hr_my_code() then return c; end if;
  return null;
end $$;

-- the employee sees comments on their own rows, except on a penalty or bonus
-- that hasn't been approved yet
drop policy if exists com_read on comments;
create policy com_read on comments for select to authenticated using (
  hr_has('admin') or hr_manages(hr_ref_code(ref_table, ref_id)) or (
    hr_ref_code(ref_table, ref_id) = hr_my_code() and (ref_table <> 'actions' or exists (
      select 1 from actions a where a.id = ref_id and a.status = 'approved'))));

-- ---------------------------------------------------------------- quiz time

create table if not exists quiz_starts (
  code       text not null,
  quiz_id    int  not null,
  attempt_no int  not null,
  started_at timestamptz not null default now(),
  primary key (code, quiz_id, attempt_no)
);
alter table quiz_starts enable row level security;
revoke all on quiz_starts from authenticated, anonymous;

-- Questions without the answer key; opening them starts the clock.
drop function if exists hr_quiz_get(int);
create function hr_quiz_get(p_quiz int)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare z quizzes; used int; me text := hr_my_code();
begin
  if not hr_member() then raise exception 'not allowed'; end if;
  select * into z from quizzes where id = p_quiz;
  if z.id is null then raise exception 'no such quiz'; end if;
  select count(*) into used from quiz_attempts where quiz_id = p_quiz and code = me;
  if me is not null then
    insert into quiz_starts (code, quiz_id, attempt_no) values (me, p_quiz, used + 1) on conflict do nothing;
  end if;
  return jsonb_build_object(
    'id', z.id, 'pass_mark', z.pass_mark, 'max_attempts', z.max_attempts, 'minutes', z.minutes, 'used', used,
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('q', x->>'q', 'options', x->'options') order by i), '[]')
                  from jsonb_array_elements(z.questions) with ordinality as a(x, i)));
end $$;

-- Scores an attempt. Answers sent after the time limit (plus a minute of
-- grace) count as zero.
create or replace function hr_quiz_submit(p_quiz int, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare z quizzes; me text := hr_my_code(); used int; n int; ok int := 0; sc int; pass boolean; last boolean; review jsonb := '[]'; x jsonb; i int := 0; chosen int; started timestamptz; late boolean := false;
begin
  if me is null then raise exception 'not allowed'; end if;
  select * into z from quizzes where id = p_quiz;
  if z.id is null then raise exception 'no such quiz'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'bad answers'; end if;
  perform pg_advisory_xact_lock(hashtext(me || ':' || p_quiz));
  select count(*) into used from quiz_attempts where quiz_id = p_quiz and code = me;
  if used >= z.max_attempts then raise exception 'no attempts left'; end if;
  if exists (select 1 from quiz_attempts where quiz_id = p_quiz and code = me and passed) then raise exception 'already passed'; end if;
  select started_at into started from quiz_starts where code = me and quiz_id = p_quiz and attempt_no = used + 1;
  if coalesce(z.minutes, 0) > 0 then
    late := started is null or now() > started + make_interval(mins => z.minutes + 1);
  end if;
  n := jsonb_array_length(z.questions);
  for x in select * from jsonb_array_elements(z.questions) loop
    chosen := case when jsonb_typeof(p_answers->i) = 'number' then (p_answers->>i)::int end;
    if chosen = (x->>'answer')::int and not late then ok := ok + 1; end if;
    review := review || jsonb_build_object('chosen', chosen, 'right', chosen = (x->>'answer')::int and not late, 'answer', (x->>'answer')::int, 'why', x->>'why');
    i := i + 1;
  end loop;
  sc := round(ok * 100.0 / greatest(n, 1));
  pass := sc >= z.pass_mark;
  insert into quiz_attempts (code, quiz_id, attempt_no, answers, score, passed) values (me, p_quiz, used + 1, p_answers, sc, pass);
  last := pass or used + 1 >= z.max_attempts;
  if not last then
    review := (select jsonb_agg(jsonb_build_object('chosen', r->'chosen', 'right', r->'right')) from jsonb_array_elements(review) r);
  end if;
  return jsonb_build_object('score', sc, 'passed', pass, 'correct', ok, 'total', n, 'left', z.max_attempts - used - 1, 'review', review, 'late', late);
end $$;

-- ---------------------------------------------------------------- the public apply form

-- One application per mobile per 30 days, as before. The hourly cap goes from
-- 60 to 300 so a flood can't shut real applicants out, and past 20 an hour
-- applications still save but stop notifying, so the inbox stays usable.
create or replace function hr_apply(p_answers jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare
  allowed text[] := array[
    'position', 'position_other', 'source', 'referrer', 'full_name', 'dob', 'nationality', 'marital', 'mobile', 'whatsapp',
    'email', 'military', 'address', 'governorate', 'city', 'district', 'lives_with', 'transport', 'commute',
    'instagram', 'facebook', 'linkedin', 'brothers_count', 'sisters_count', 'sibling_order',
    'school_type', 'university', 'faculty', 'major', 'grad_year', 'grade',
    'job1_company', 'job1_title', 'job1_period', 'job1_salary', 'job1_reason',
    'job2_company', 'job2_title', 'job2_period', 'job2_salary', 'job2_reason',
    'job3_company', 'job3_title', 'job3_period', 'job3_salary', 'job3_reason',
    'sales_exp', 'sales_years', 're_exp', 'prev_re_company',
    'skill_0', 'skill_1', 'skill_2', 'skill_3', 'skill_4', 'skill_5', 'skill_6', 'skill_7', 'skills_notes',
    'lang_0', 'lang_1', 'other_lang_name', 'course1_name', 'course1_org', 'course2_name', 'course2_org', 'course3_name', 'course3_org',
    'expected_salary', 'expected_commission', 'join_time', 'accept_kpi', 'accept_commission', 'weekend_work', 'career_goal',
    'emg_name', 'emg_relation', 'emg_phone', 'declare_name', 'declare_ok'];
  a jsonb; k text; pos text; mob text; ref text; aid uuid;
begin
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 20000 then
    raise exception 'bad form';
  end if;
  -- keep known fields only, as trimmed text of sane length
  select coalesce(jsonb_object_agg(key, left(btrim(value #>> '{}'), 1000)), '{}') into a
  from jsonb_each(p_answers) where key = any(allowed) and jsonb_typeof(value) in ('string', 'number') and btrim(value #>> '{}') <> '';

  foreach k in array array['position', 'full_name', 'mobile', 'dob', 'city', 'declare_name', 'declare_ok'] loop
    if a->>k is null then raise exception 'missing %', k; end if;
  end loop;
  if length(a->>'full_name') < 5 then raise exception 'missing full_name'; end if;
  mob := regexp_replace(translate(a->>'mobile', '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g');
  if length(mob) not between 10 and 15 then raise exception 'bad mobile'; end if;
  if a->>'email' is not null and a->>'email' !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad email'; end if;
  if (a->>'dob') !~ '^\d{4}-\d{2}-\d{2}$' or (a->>'dob')::date not between current_date - interval '70 years' and current_date - interval '16 years' then
    raise exception 'bad dob';
  end if;
  if a->>'position' = 'أخرى' then
    if a->>'position_other' is null then raise exception 'missing position_other'; end if;
    pos := 'أخرى: ' || (a->>'position_other');
  elsif exists (select 1 from job_positions where title = a->>'position' and active) then
    pos := a->>'position';
  else raise exception 'bad position'; end if;

  -- one application per mobile per 30 days; at most 300 an hour in total
  perform pg_advisory_xact_lock(hashtext('hr_apply'));
  if exists (select 1 from applications where mobile = mob and created_at > now() - interval '30 days') then
    raise exception 'already applied';
  end if;
  if (select count(*) from applications where created_at > now() - interval '1 hour') >= 300 then
    raise exception 'busy';
  end if;

  ref := 'EV' || to_char(now() at time zone 'Africa/Cairo', 'YYMM') || '-' || lpad(nextval('application_ref_seq')::text, 4, '0');
  insert into applications (ref, position, full_name, mobile, email, source, answers, auto_score)
  values (ref, pos, a->>'full_name', mob, a->>'email', a->>'source', a || jsonb_build_object('mobile', mob), hr_apply_score(a))
  returning id into aid;

  -- a flood doesn't bury the inbox: past 20 an hour, applications still save quietly
  insert into notifications (user_id, kind, title, body, ref_table, ref_id)
  select user_id, 'application', 'طلب توظيف جديد: ' || (a->>'full_name'), pos || ' · ' || ref, 'applications', null
  from app_users where ('admin' = any(roles) or 'recruiter' = any(roles))
    and (select count(*) from applications where created_at > now() - interval '1 hour') <= 20;
  return ref;
end $$;

-- ---------------------------------------------------------------- login emails

-- the email and name on a login come from the sign-in service, not the browser
create or replace function hr_user_stamp() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare em text; nm text;
begin
  begin
    em := nullif(current_setting('request.jwt.claims', true)::jsonb->>'email', '');
  exception when others then em := null;
  end;
  begin
    if to_regclass('neon_auth."user"') is not null then
      execute 'select email, name from neon_auth."user" where id::text = $1' into em, nm using new.user_id;
    end if;
  exception when others then null;
  end;
  if em is not null then new.email := lower(em); end if;
  if tg_op = 'INSERT' and nullif(btrim(nm), '') is not null then new.display_name := left(nm, 80); end if;
  return new;
end $$;
drop trigger if exists user_stamp on app_users;
create trigger user_stamp before insert or update of email on app_users for each row execute function hr_user_stamp();

-- ---------------------------------------------------------------- audit

do $$ declare t text; begin
  foreach t in array array['punches', 'requests', 'meetings', 'checkins', 'comments', 'survey_responses'] loop
    execute format('drop trigger if exists audit on %I', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function hr_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- functions: tighter defaults

-- every server function looks only in public (and never a caller's temp schema first)
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prosecdef and p.proname like 'hr\_%'
  loop execute format('alter function %s set search_path = public, pg_temp', f.sig); end loop;
end $$;

-- no function is open to everyone by default: keep what logins already use,
-- then take the rest away from PUBLIC
do $$ declare f record; begin
  for f in select p.oid, p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'hr\_%'
  loop
    if has_function_privilege('authenticated', f.oid, 'execute') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'anonymous') and has_function_privilege('anonymous', f.oid, 'execute')
       and f.sig::text in ('hr_has(text)', 'hr_roles()', 'hr_apply(jsonb)') then
      execute format('grant execute on function %s to anonymous', f.sig);
    end if;
    execute format('revoke execute on function %s from public', f.sig);
  end loop;
end $$;

grant execute on function hr_decides(text), hr_member(), hr_todo_write(text), hr_quiz_get(int) to authenticated;
-- internal only: triggers and server functions
revoke execute on function hr_manager_of(text), hr_survey_guard(), hr_punch_stamp(), hr_user_stamp(),
  hr_audit() from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'grant execute on function hr_apply(jsonb) to anonymous';
  end if;
end $$;
grant execute on function hr_device_punches(text, jsonb), hr_device_ping(text, text) to hr_device;

commit;
