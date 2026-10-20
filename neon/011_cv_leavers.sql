-- Everest Eco System, part 11: CVs, interview invitations, and people who left.
--
-- Run in the Neon SQL Editor AFTER neon/010_security.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * The public form can attach a CV (PDF, Word or a photo, up to 3 MB) right
--     after applying. Only recruiters and admins can open it.
--   * HR writes a short profile of the applicant and whether the CV matches
--     what they said. When the applicant is hired, managers above them see that
--     profile on the employee.
--   * An interview invitation (day, time, place) is saved on the application;
--     the portal builds the WhatsApp and email message from it.
--   * An employee marked "not working" (active = false) is locked out at once:
--     their login sees nothing. Their records stay; ticking them active again
--     restores everything. An admin is never locked out of admin.

begin;

-- ---------------------------------------------------------------- CV files

create table if not exists application_files (
  application_id uuid primary key references applications(id) on delete cascade,
  name       text not null check (length(name) between 1 and 120),
  mime       text not null check (mime in ('application/pdf', 'application/msword',
               'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png')),
  size       int  not null check (size between 1 and 3145728),
  data       bytea not null,
  created_at timestamptz not null default now()
);
alter table application_files enable row level security;   -- no policies: only through the functions below
revoke all on application_files from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then execute 'revoke all on application_files from anonymous'; end if;
end $$;
revoke all on application_files from authenticated;

alter table applications add column if not exists has_cv boolean not null default false;

alter table application_reviews add column if not exists about text;
alter table application_reviews add column if not exists cv_match text;
alter table application_reviews add column if not exists cv_note text;
alter table application_reviews add column if not exists interview_at timestamptz;
alter table application_reviews add column if not exists interview_place text;
alter table application_reviews add column if not exists invited_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'rev_about_len') then
    alter table application_reviews add constraint rev_about_len check (length(about) <= 3000);
    alter table application_reviews add constraint rev_cv_match check (cv_match in ('match', 'partial', 'mismatch'));
    alter table application_reviews add constraint rev_cv_note_len check (length(cv_note) <= 1000);
    alter table application_reviews add constraint rev_place_len check (length(interview_place) <= 200);
  end if;
end $$;

-- The applicant attaches a CV to the application they just sent: they need its
-- reference number and their mobile, within two hours, once.
create or replace function hr_apply_cv(p_ref text, p_mobile text, p_name text, p_mime text, p_b64 text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare aid uuid; bin bytea; mob text; head bytea; ok boolean;
begin
  mob := regexp_replace(translate(coalesce(p_mobile, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g');
  select id into aid from applications
   where ref = upper(btrim(coalesce(p_ref, ''))) and mobile = mob and created_at > now() - interval '2 hours';
  if aid is null then raise exception 'not found'; end if;
  if exists (select 1 from application_files where application_id = aid) then raise exception 'already uploaded'; end if;
  if p_b64 is null or length(p_b64) > 4200000 then raise exception 'too big'; end if;
  begin
    bin := decode(p_b64, 'base64');
  exception when others then raise exception 'bad file';
  end;
  if length(bin) > 3145728 then raise exception 'too big'; end if;
  head := substring(bin from 1 for 4);
  ok := case p_mime
      when 'application/pdf' then head = '\x25504446'::bytea
      when 'application/msword' then head = '\xd0cf11e0'::bytea
      when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then head = '\x504b0304'::bytea
      when 'image/jpeg' then substring(head from 1 for 3) = '\xffd8ff'::bytea
      when 'image/png' then head = '\x89504e47'::bytea
      else false end;
  if not coalesce(ok, false) then raise exception 'bad file'; end if;
  insert into application_files (application_id, name, mime, size, data)
  values (aid, left(coalesce(nullif(btrim(p_name), ''), 'cv'), 120), p_mime, length(bin), bin);
  update applications set has_cv = true where id = aid;
  return true;
end $$;

-- Recruiters and admins open a CV (base64, for the browser to download).
create or replace function hr_app_cv(p_app uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare f application_files;
begin
  if not (hr_has('admin') or hr_has('recruiter')) then raise exception 'not allowed'; end if;
  select * into f from application_files where application_id = p_app;
  if f.application_id is null then return null; end if;
  return jsonb_build_object('name', f.name, 'mime', f.mime, 'size', f.size, 'b64', encode(f.data, 'base64'));
end $$;

-- HR's profile of the applicant and whether the CV matches their answers.
create or replace function hr_app_about(p_app uuid, p_about text, p_match text, p_note text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_has('recruiter') then raise exception 'not allowed'; end if;
  if p_match is not null and p_match not in ('match', 'partial', 'mismatch') then raise exception 'bad match'; end if;
  if not exists (select 1 from applications where id = p_app) then raise exception 'not found'; end if;
  insert into application_reviews (application_id, about, cv_match, cv_note, updated_by, updated_at)
  values (p_app, nullif(btrim(p_about), ''), p_match, nullif(btrim(p_note), ''), auth.user_id(), now())
  on conflict (application_id) do update set about = excluded.about, cv_match = excluded.cv_match, cv_note = excluded.cv_note,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at;
end $$;

-- An interview invitation: when and where. Moves the application to "interview".
create or replace function hr_app_invite(p_app uuid, p_at timestamptz, p_place text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_has('recruiter') then raise exception 'not allowed'; end if;
  if p_at is null or p_at < now() - interval '1 day' then raise exception 'bad time'; end if;
  if not exists (select 1 from applications where id = p_app and status not in ('hired', 'rejected', 'withdrawn')) then raise exception 'not found'; end if;
  insert into application_reviews (application_id, interview_at, interview_date, interview_place, invited_at, updated_by, updated_at)
  values (p_app, p_at, (p_at at time zone 'Africa/Cairo')::date, left(nullif(btrim(p_place), ''), 200), now(), auth.user_id(), now())
  on conflict (application_id) do update set interview_at = excluded.interview_at, interview_date = excluded.interview_date,
    interview_place = excluded.interview_place, invited_at = excluded.invited_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  update applications set status = 'interview', status_at = now() where id = p_app and status in ('new', 'screening');
end $$;

-- An employee's profile from their hiring: admin, HR and the managers above them.
create or replace function hr_emp_profile(p_code text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_has('admin') or hr_has('recruiter') or hr_manages(p_code) then (
    select jsonb_build_object('app', a.id, 'ref', a.ref, 'position', a.position, 'applied', a.created_at,
      'auto', a.auto_score, 'interview', r.interview_total, 'about', r.about, 'match', r.cv_match, 'note', r.cv_note,
      'cv', a.has_cv and (hr_has('admin') or hr_has('recruiter')))
    from applications a left join application_reviews r on r.application_id = a.id
    where a.hired_code = p_code order by a.status_at desc limit 1) end
$$;

-- ---------------------------------------------------------------- people who left

-- A login linked to an employee who isn't working any more has no code and no
-- roles (an admin keeps admin), so every policy shows them nothing.
create or replace function hr_roles() returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select case when u.employee_code is null or coalesce(e.active, true) then u.roles
                when 'admin' = any(u.roles) then array['admin']
                else '{}'::text[] end
    from app_users u left join employees e on e.code = u.employee_code
    where u.user_id = auth.user_id()), '{}')
$$;

create or replace function hr_my_code() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select u.employee_code from app_users u join employees e on e.code = u.employee_code
  where u.user_id = auth.user_id() and coalesce(e.active, true)
$$;

-- What the portal needs at sign-in: effective roles, code, and whether the
-- account was stopped because the employee left.
create or replace function hr_my_state()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('roles', to_jsonb(hr_roles()), 'code', hr_my_code(),
    'off', exists (select 1 from app_users u join employees e on e.code = u.employee_code
                   where u.user_id = auth.user_id() and not coalesce(e.active, true)))
$$;

-- an invite can't be made for someone who isn't working
create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code and coalesce(active, true)) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator', 'viewall', 'approveall', 'pay')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

-- ---------------------------------------------------------------- audit and grants

-- CVs are logged without their contents
create or replace function hr_audit_cv() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r application_files := case when tg_op = 'DELETE' then old else new end;
begin
  insert into audit_log (actor, tbl, op, old, new)
  values (auth.user_id(), tg_table_name, tg_op, null,
          jsonb_build_object('application_id', r.application_id, 'name', r.name, 'mime', r.mime, 'size', r.size));
  return null;
end $$;
drop trigger if exists audit on application_files;
create trigger audit after insert or delete on application_files for each row execute function hr_audit_cv();

revoke all on function hr_apply_cv(text, text, text, text, text), hr_app_cv(uuid), hr_app_about(uuid, text, text, text),
  hr_app_invite(uuid, timestamptz, text), hr_emp_profile(text), hr_my_state(), hr_audit_cv(),
  hr_roles(), hr_my_code(), hr_create_invite(text, text[]) from public;
grant execute on function hr_app_cv(uuid), hr_app_about(uuid, text, text, text), hr_app_invite(uuid, timestamptz, text),
  hr_emp_profile(text), hr_my_state(), hr_roles(), hr_my_code(), hr_create_invite(text, text[]) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'grant execute on function hr_apply_cv(text, text, text, text, text), hr_roles() to anonymous';
  end if;
end $$;

commit;
