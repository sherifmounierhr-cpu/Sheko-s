-- Everest HR, part 4: recruitment inside the portal.
--
-- Run in the Neon SQL Editor AFTER neon/003_training.sql. Safe to re-run.
--
-- Adds:
--   job_positions        the jobs the public form offers (admin edits the list)
--   applications         one row per application from the public link
--   application_reviews  interview scores (9 criteria x 10), notes, decision
-- and the role `recruiter` (HR): sees and manages applications, nothing else.
--
-- The public form needs no account. Visitors without a login reach the
-- database as the Data API's `anonymous` role, which may only read the open
-- positions and call hr_apply(). Everything else is closed to them.
-- No health or family-medical questions are collected.

begin;

-- ---------------------------------------------------------------- tables

create table if not exists job_positions (
  id     serial primary key,
  title  text not null unique check (length(title) between 2 and 80),
  active boolean not null default true,
  sort   int not null default 0
);
insert into job_positions (title, sort)
select t, n from unnest(array['مستشار مبيعات عقاري', 'كبير مستشاري المبيعات', 'قائد فريق مبيعات', 'مدير مبيعات',
  'أخصائي تسويق', 'أخصائي سوشيال ميديا', 'مصمم جرافيك', 'مصور ومونتير', 'خدمة عملاء', 'موارد بشرية', 'محاسب',
  'إداري / سكرتارية']) with ordinality as x(t, n)
where not exists (select 1 from job_positions);

create sequence if not exists application_ref_seq;

create table if not exists applications (
  id          uuid primary key default gen_random_uuid(),
  ref         text not null unique,
  created_at  timestamptz not null default now(),
  position    text not null,
  full_name   text not null,
  mobile      text not null,
  email       text,
  source      text,
  answers     jsonb not null,
  auto_score  int not null default 0 check (auto_score between 0 and 100),
  status      text not null default 'new'
              check (status in ('new', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  status_at   timestamptz not null default now(),
  hired_code  text references employees(code) on update cascade on delete set null
);
create index if not exists applications_created on applications (created_at desc);
create index if not exists applications_mobile on applications (mobile, created_at desc);
create index if not exists applications_hired on applications (hired_code) where hired_code is not null;

create table if not exists application_reviews (
  application_id  uuid primary key references applications(id) on delete cascade,
  scores          jsonb not null default '{}',          -- {"0":7,"1":8,...} one per criterion, 1-10
  interview_total int not null default 0 check (interview_total between 0 and 90),
  interview_date  date,
  interviewer     text,
  hr_notes        text check (length(hr_notes) <= 3000),
  decision        text check (decision in ('قوي تعيين', 'تعيين', 'مقابلة ثانية', 'قيد الانتظار', 'رفض')),
  decision_note   text check (length(decision_note) <= 1000),
  decided_by      text,
  decided_at      timestamptz,
  updated_by      text default auth.user_id(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers

create or replace function hr_recruits() returns boolean
language sql stable security definer set search_path = public as $$
  select hr_has('recruiter')
$$;

-- The preliminary score out of 100, same rules as the old recruitment form.
create or replace function hr_apply_score(a jsonb) returns int
language plpgsql immutable as $$
declare s numeric := 0; yrs numeric; sk numeric := 0; n int := 0; i int; v text;
begin
  if a->>'re_exp' = 'نعم' then s := s + 15; end if;
  if a->>'sales_exp' = 'نعم' then
    s := s + 10;
    yrs := coalesce(nullif(regexp_replace(coalesce(a->>'sales_years', ''), '[^0-9.]', '', 'g'), '')::numeric, 0);
    s := s + least(yrs, 5) * 2;
  end if;
  for i in 0..7 loop
    v := a->>('skill_' || i);
    if v is not null and v <> '' then
      n := n + 1;
      sk := sk + case v when 'ممتاز' then 4 when 'جيد' then 3 when 'متوسط' then 2 when 'يحتاج تحسين' then 1 else 0 end;
    end if;
  end loop;
  if n > 0 then s := s + sk / (n * 4) * 20; end if;
  s := s + case a->>'lang_1' when 'ممتاز' then 10 when 'جيد' then 6 when 'أساسي' then 2 else 0 end;
  if a->>'accept_kpi' = 'نعم' then s := s + 5; end if;
  if a->>'accept_commission' = 'نعم' then s := s + 5; end if;
  if a->>'weekend_work' = 'نعم' then s := s + 5; end if;
  s := s + case a->>'join_time' when 'فورًا' then 10 when 'خلال أسبوع' then 7 when 'خلال أسبوعين' then 4 when 'خلال شهر' then 2 else 0 end;
  s := s + case a->>'commute' when 'أقل من 30 دقيقة' then 10 when 'من 30 إلى 60 دقيقة' then 5 when 'أكثر من ساعة' then 2 else 0 end;
  return greatest(0, least(100, round(s)))::int;
end $$;

-- ---------------------------------------------------------------- the public form

-- Anyone (no login) submits an application. Returns the reference number.
create or replace function hr_apply(p_answers jsonb)
returns text language plpgsql security definer set search_path = public as $$
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

  -- one application per mobile per 30 days; at most 60 an hour in total
  perform pg_advisory_xact_lock(hashtext('hr_apply'));
  if exists (select 1 from applications where mobile = mob and created_at > now() - interval '30 days') then
    raise exception 'already applied';
  end if;
  if (select count(*) from applications where created_at > now() - interval '1 hour') >= 60 then
    raise exception 'busy';
  end if;

  ref := 'EV' || to_char(now() at time zone 'Africa/Cairo', 'YYMM') || '-' || lpad(nextval('application_ref_seq')::text, 4, '0');
  insert into applications (ref, position, full_name, mobile, email, source, answers, auto_score)
  values (ref, pos, a->>'full_name', mob, a->>'email', a->>'source', a || jsonb_build_object('mobile', mob), hr_apply_score(a))
  returning id into aid;

  insert into notifications (user_id, kind, title, body, ref_table, ref_id)
  select user_id, 'application', 'طلب توظيف جديد: ' || (a->>'full_name'), pos || ' · ' || ref, 'applications', null
  from app_users where 'admin' = any(roles) or 'recruiter' = any(roles);
  return ref;
end $$;

-- ---------------------------------------------------------------- staff actions

-- Interview scores (criterion index -> 1..10), date, interviewer, notes.
create or replace function hr_app_review(p_app uuid, p_scores jsonb, p_date date, p_interviewer text, p_notes text)
returns int language plpgsql security definer set search_path = public as $$
declare tot int := 0; k text; v int;
begin
  if not hr_recruits() then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_scores) <> 'object' then raise exception 'bad scores'; end if;
  for k, v in select key, (value #>> '{}')::int from jsonb_each(p_scores) loop
    if k !~ '^[0-8]$' or v not between 1 and 10 then raise exception 'bad scores'; end if;
    tot := tot + v;
  end loop;
  insert into application_reviews (application_id, scores, interview_total, interview_date, interviewer, hr_notes, updated_by, updated_at)
  values (p_app, p_scores, tot, p_date, nullif(btrim(p_interviewer), ''), nullif(btrim(p_notes), ''), auth.user_id(), now())
  on conflict (application_id) do update set scores = excluded.scores, interview_total = excluded.interview_total,
    interview_date = excluded.interview_date, interviewer = excluded.interviewer, hr_notes = excluded.hr_notes,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  update applications set status = 'interview', status_at = now() where id = p_app and status in ('new', 'screening');
  return tot;
end $$;

-- The hiring decision; moves the application along the pipeline.
create or replace function hr_app_decide(p_app uuid, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_recruits() then raise exception 'not allowed'; end if;
  insert into application_reviews (application_id, decision, decision_note, decided_by, decided_at)
  values (p_app, p_decision, nullif(btrim(p_note), ''), auth.user_id(), now())
  on conflict (application_id) do update set decision = excluded.decision, decision_note = excluded.decision_note,
    decided_by = excluded.decided_by, decided_at = excluded.decided_at;
  update applications set status = case p_decision when 'رفض' then 'rejected' when 'تعيين' then 'offer' when 'قوي تعيين' then 'offer' else 'interview' end,
    status_at = now()
  where id = p_app and status <> 'hired';
end $$;

-- Manual pipeline moves (hired only through hr_app_hire).
create or replace function hr_app_status(p_app uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_recruits() then raise exception 'not allowed'; end if;
  if p_status not in ('new', 'screening', 'interview', 'offer', 'rejected', 'withdrawn') then raise exception 'bad status'; end if;
  update applications set status = p_status, status_at = now() where id = p_app and status <> 'hired';
end $$;

-- After the admin adds the employee: link the application to them.
create or replace function hr_app_hire(p_app uuid, p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = p_code) then raise exception 'no such employee'; end if;
  update applications set status = 'hired', status_at = now(), hired_code = p_code where id = p_app;
  if not found then raise exception 'no such application'; end if;
end $$;

-- Privacy: drop rejected / withdrawn applications older than N months (admin).
create or replace function hr_purge_applications(p_months int default 12)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  delete from applications where status in ('rejected', 'withdrawn') and status_at < now() - make_interval(months => greatest(p_months, 3));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- RLS

alter table job_positions       enable row level security;
alter table applications        enable row level security;
alter table application_reviews enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('job_positions', 'applications', 'application_reviews')
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

create policy jp_read on job_positions for select using (active or hr_has('admin'));
create policy jp_admin on job_positions for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- applicants' data: recruiters and admins only; changes go through the functions
create policy app_read on applications for select to authenticated using (hr_recruits());
create policy app_admin_delete on applications for delete to authenticated using (hr_has('admin'));
create policy rev_read on application_reviews for select to authenticated using (hr_recruits());

-- audit interview scores and decisions
drop trigger if exists audit on application_reviews;
create trigger audit after insert or update or delete on application_reviews for each row execute function hr_audit();

-- ---------------------------------------------------------------- grants

grant select, insert, update, delete on job_positions to authenticated;
grant select, delete on applications to authenticated;
grant select on application_reviews to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke all on function hr_recruits(), hr_apply_score(jsonb), hr_apply(jsonb), hr_app_review(uuid, jsonb, date, text, text),
  hr_app_decide(uuid, text, text), hr_app_status(uuid, text), hr_app_hire(uuid, text), hr_purge_applications(int) from public;
grant execute on function hr_recruits(), hr_apply_score(jsonb), hr_apply(jsonb), hr_app_review(uuid, jsonb, date, text, text),
  hr_app_decide(uuid, text, text), hr_app_status(uuid, text), hr_app_hire(uuid, text), hr_purge_applications(int) to authenticated;

-- the public form: visitors without a login (Data API `anonymous` role)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'grant usage on schema public to anonymous';
    execute 'grant select on job_positions to anonymous';
    execute 'grant execute on function hr_apply(jsonb) to anonymous';
  else
    raise notice 'No anonymous role yet: enable anonymous access in the Data API settings, then re-run this file.';
  end if;
end $$;

-- invites may now give the recruiter role
create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

commit;
