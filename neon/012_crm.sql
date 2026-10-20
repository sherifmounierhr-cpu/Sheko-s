-- Everest Eco System, part 12: the CRM, phase 1 (leads, distribution, follow-up).
--
-- Run in the Neon SQL Editor AFTER neon/011_cv_leavers.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * Leads come in by hand (WhatsApp, calls, walk-ins), from pasted Excel
--     rows, or from the company's landing pages (hr_lead_capture, no login).
--   * New leads wait unassigned. The admin and anyone with the new permission
--     `leads_assign` (توزيع الليدز) pick the salesperson. From that moment the
--     6-hour feedback clock in the company policy (4.2) runs.
--   * A salesperson sees only their own leads; managers see their tree; the
--     phone number itself goes only to the owner, the distributors and admins.
--   * Every follow-up is structured (result + next step). The policy rules are
--     enforced: no answer -> next call within 24 hours; "thinking" -> within 3
--     days. A "visit done" is checked against the salesperson's field check-ins.
--   * When an employee leaves, their open leads go back to the unassigned pool.

begin;

-- ---------------------------------------------------------------- tables

create table if not exists crm_projects (
  id        serial primary key,
  name      text not null unique check (length(btrim(name)) between 1 and 80),
  developer text check (length(developer) <= 80),
  area      text check (length(area) <= 60),
  active    boolean not null default true,
  sort      int not null default 0
);

create table if not exists crm_leads (
  id              bigserial primary key,
  name            text not null check (length(btrim(name)) between 1 and 120),
  phone           text not null check (phone ~ '^[0-9]{8,15}$'),
  phone2          text check (phone2 ~ '^[0-9]{8,15}$'),
  phone_tail      text generated always as (right(phone, 3)) stored,
  source          text not null default 'manual'
                  check (source in ('landing', 'facebook', 'whatsapp', 'call', 'walkin', 'referral', 'excel', 'manual', 'other')),
  campaign        text check (length(campaign) <= 120),
  project_id      int references crm_projects(id) on delete set null,
  budget          text check (length(budget) <= 60),
  notes           text check (length(notes) <= 2000),
  owner_code      text references employees(code) on update cascade on delete set null,
  assigned_at     timestamptz,
  assigned_by     text,
  stage           text not null default 'new'
                  check (stage in ('new', 'contacted', 'qualified', 'visit', 'offer', 'reserved', 'won', 'lost')),
  lost_reason     text check (length(lost_reason) <= 300),
  next_action_at  timestamptz,
  first_action_at timestamptz,     -- first follow-up after the current assignment (the 6-hour clock)
  last_action_at  timestamptz,
  created_at      timestamptz not null default now(),
  created_by      text default auth.user_id(),
  created_by_code text
);
create index if not exists crm_leads_owner on crm_leads (owner_code, stage, next_action_at);
create index if not exists crm_leads_unassigned on crm_leads (created_at) where owner_code is null;
-- one open lead per phone number (closed ones may come back as new leads)
create unique index if not exists crm_leads_phone_open on crm_leads (phone) where stage not in ('won', 'lost');

create table if not exists crm_activities (
  id         bigserial primary key,
  lead_id    bigint not null references crm_leads(id) on delete cascade,
  code       text,                       -- who did it (employee code), null for the system / the public form
  kind       text not null check (kind in ('call', 'whatsapp', 'visit', 'meeting', 'offer', 'note', 'assign', 'system')),
  result     text check (result in ('answered', 'no_answer', 'busy', 'wrong_number', 'interested', 'thinking',
                                    'not_interested', 'visit_booked', 'visit_done', 'offer_sent', 'reserved', 'won', 'lost')),
  note       text check (length(note) <= 1000),
  next_at    timestamptz,
  checkin_id bigint,
  verified   boolean,                    -- for a visit: a matching field check-in was found
  at         timestamptz not null default now(),
  by_user    text default auth.user_id()
);
create index if not exists crm_activities_lead on crm_activities (lead_id, at desc);

-- ---------------------------------------------------------------- who sees what

-- distributors: the admin and the `leads_assign` permission
create or replace function hr_lead_distributor() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_has('leads_assign')
$$;

-- may the caller see this lead's row (not its phone)?
create or replace function hr_lead_sees(owner text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_lead_distributor() or (owner is not null and (owner = hr_my_code() or hr_manages(owner)))
$$;

alter table crm_projects   enable row level security;
alter table crm_leads      enable row level security;
alter table crm_activities enable row level security;
do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('crm_projects', 'crm_leads', 'crm_activities')
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

create policy crmp_read on crm_projects for select to authenticated using (hr_member());
create policy crmp_admin on crm_projects for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy crml_read on crm_leads for select to authenticated using (hr_lead_sees(owner_code));
create policy crma_read on crm_activities for select to authenticated using (
  exists (select 1 from crm_leads l where l.id = lead_id and hr_lead_sees(l.owner_code)));

-- the phone columns are not readable directly; owners and distributors get them here
revoke all on crm_leads from authenticated;
grant select (id, name, phone_tail, source, campaign, project_id, budget, notes, owner_code, assigned_at, assigned_by,
  stage, lost_reason, next_action_at, first_action_at, last_action_at, created_at, created_by_code) on crm_leads to authenticated;
grant select on crm_activities, crm_projects to authenticated;
grant insert, update, delete on crm_projects to authenticated;

create or replace function hr_lead_contacts()
returns table (id bigint, phone text, phone2 text)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.id, l.phone, l.phone2 from crm_leads l
  where hr_lead_distributor() or (l.owner_code is not null and l.owner_code = hr_my_code())
$$;

-- ---------------------------------------------------------------- helpers

create or replace function hr_phone(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case
    when d ~ '^20[0-9]{10}$' then '0' || substr(d, 3)       -- +20 1xx... -> 01xx...
    when d ~ '^1[0-9]{9}$' then '0' || d                     -- 1xx... -> 01xx...
    else d end
  from (select regexp_replace(translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩', '0123456789'), '[^0-9]', '', 'g') as d) x
$$;

create or replace function hr_lead_notify_distributors(p_lead bigint, p_title text, p_body text)
returns void language sql security definer set search_path = public, pg_temp as $$
  insert into notifications (user_id, kind, title, body, ref_table, ref_id)
  select user_id, 'lead', p_title, p_body, 'crm_leads', p_lead
  from app_users where 'admin' = any(roles) or 'leads_assign' = any(roles)
$$;

-- the stage a follow-up result moves the lead to (never backwards, except lost)
create or replace function hr_lead_stage(cur text, res text) returns text
language sql immutable set search_path = public, pg_temp as $$
  with o(s, n) as (values ('new', 0), ('contacted', 1), ('qualified', 2), ('visit', 3), ('offer', 4), ('reserved', 5), ('won', 6), ('lost', 7)),
  t as (select case res
      when 'answered' then 'contacted' when 'interested' then 'qualified' when 'thinking' then 'qualified'
      when 'visit_booked' then 'qualified' when 'visit_done' then 'visit' when 'offer_sent' then 'offer'
      when 'reserved' then 'reserved' when 'won' then 'won'
      when 'lost' then 'lost' when 'not_interested' then 'lost' when 'wrong_number' then 'lost'
      else null end as s)
  select case when t.s is null then cur
              when t.s = 'lost' then 'lost'
              when (select n from o where s = t.s) > (select n from o where s = cur) then t.s
              else cur end
  from t
$$;

-- ---------------------------------------------------------------- adding leads

-- By hand. A salesperson's own lead is theirs at once; a distributor may pick
-- the owner or leave it unassigned.
create or replace function hr_lead_add(p_name text, p_phone text, p_source text default 'manual', p_campaign text default null,
  p_project int default null, p_notes text default null, p_owner text default null, p_phone2 text default null, p_budget text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare me text := hr_my_code(); dist boolean := hr_lead_distributor(); ph text := hr_phone(p_phone); own text; lid bigint; dup bigint;
begin
  if not (dist or me is not null) then raise exception 'not allowed'; end if;
  if ph !~ '^[0-9]{8,15}$' then raise exception 'bad phone'; end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'name required'; end if;
  select id into dup from crm_leads where phone = ph and stage not in ('won', 'lost');
  if dup is not null then
    if dist then raise exception 'duplicate:%', dup; end if;
    raise exception 'duplicate';
  end if;
  own := case when dist then nullif(btrim(p_owner), '') else me end;
  if own is not null and not exists (select 1 from employees where code = own and coalesce(active, true)) then raise exception 'no such employee'; end if;
  insert into crm_leads (name, phone, phone2, source, campaign, project_id, budget, notes, owner_code, assigned_at, assigned_by, created_by_code)
  values (btrim(p_name), ph, nullif(hr_phone(p_phone2), ''),
          case when p_source in ('landing', 'facebook', 'whatsapp', 'call', 'walkin', 'referral', 'excel', 'manual', 'other') then p_source else 'manual' end,
          nullif(btrim(p_campaign), ''), p_project, nullif(btrim(p_budget), ''), nullif(btrim(p_notes), ''),
          own, case when own is not null then now() end, case when own is not null then auth.user_id() end, me)
  returning id into lid;
  insert into crm_activities (lead_id, code, kind, note) values (lid, me, 'system', 'اتضاف' || case when own is null then ' ومستني التوزيع' else '' end);
  if own is not null and own is distinct from me then
    perform hr_notify(own, null, 'lead', 'ليد جديد: ' || btrim(p_name), 'عندك 6 ساعات للفيدباك الأول.', 'crm_leads', lid);
  end if;
  return lid;
end $$;

-- Distribute (or move) a lead. The 6-hour clock restarts for the new owner.
create or replace function hr_lead_assign(p_id bigint, p_code text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare l crm_leads;
begin
  if not hr_lead_distributor() then raise exception 'not allowed'; end if;
  select * into l from crm_leads where id = p_id for update;
  if l.id is null then raise exception 'not found'; end if;
  if l.stage in ('won', 'lost') then raise exception 'lead closed'; end if;
  if p_code is not null and not exists (select 1 from employees where code = p_code and coalesce(active, true)) then raise exception 'no such employee'; end if;
  if p_code is not distinct from l.owner_code then return; end if;
  update crm_leads set owner_code = p_code, assigned_at = case when p_code is null then null else now() end,
    assigned_by = auth.user_id(), first_action_at = null where id = p_id;
  insert into crm_activities (lead_id, code, kind, note)
  values (p_id, hr_my_code(), 'assign', coalesce('اتحوّل لـ ' || (select coalesce(nullif(name, ''), code) from employees where code = p_code), 'رجع للتوزيع'));
  if p_code is not null then
    perform hr_notify(p_code, null, 'lead', 'ليد جديد: ' || l.name, 'عندك 6 ساعات للفيدباك الأول.', 'crm_leads', p_id);
  end if;
end $$;

-- Pasted Excel rows: [{name, phone, source, campaign, project, owner, notes, budget}].
-- All or nothing: any bad row stops the import and every problem is reported.
create or replace function hr_lead_import(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; i int := 0; errs jsonb := '[]'; ph text; own text; pid int; seen text[] := '{}'; n int := 0;
begin
  if not hr_lead_distributor() then raise exception 'not allowed'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then raise exception 'bad rows'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    ph := hr_phone(r->>'phone');
    own := nullif(btrim(coalesce(r->>'owner', '')), '');
    if coalesce(btrim(r->>'name'), '') = '' then errs := errs || jsonb_build_object('row', i, 'msg', 'الاسم فاضي'); end if;
    if ph !~ '^[0-9]{8,15}$' then errs := errs || jsonb_build_object('row', i, 'msg', 'رقم الموبايل مش مظبوط'); continue; end if;
    if ph = any(seen) then errs := errs || jsonb_build_object('row', i, 'msg', 'الرقم مكرر في الملف'); end if;
    if exists (select 1 from crm_leads where phone = ph and stage not in ('won', 'lost')) then errs := errs || jsonb_build_object('row', i, 'msg', 'الرقم موجود كليد مفتوح'); end if;
    if own is not null and not exists (select 1 from employees where code = own and coalesce(active, true)) then errs := errs || jsonb_build_object('row', i, 'msg', 'كود السيلز مش موجود: ' || own); end if;
    if nullif(btrim(coalesce(r->>'project', '')), '') is not null and not exists (select 1 from crm_projects where name = btrim(r->>'project')) then
      errs := errs || jsonb_build_object('row', i, 'msg', 'المشروع مش متسجل: ' || btrim(r->>'project'));
    end if;
    seen := seen || ph;
  end loop;
  if jsonb_array_length(errs) > 0 then return jsonb_build_object('ok', false, 'errors', errs); end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    own := nullif(btrim(coalesce(r->>'owner', '')), '');
    select id into pid from crm_projects where name = btrim(coalesce(r->>'project', ''));
    insert into crm_leads (name, phone, source, campaign, project_id, budget, notes, owner_code, assigned_at, assigned_by, created_by_code)
    values (left(btrim(r->>'name'), 120), hr_phone(r->>'phone'),
            case when r->>'source' in ('landing', 'facebook', 'whatsapp', 'call', 'walkin', 'referral', 'excel', 'manual', 'other') then r->>'source' else 'excel' end,
            left(nullif(btrim(coalesce(r->>'campaign', '')), ''), 120), pid, left(nullif(btrim(coalesce(r->>'budget', '')), ''), 60),
            left(nullif(btrim(coalesce(r->>'notes', '')), ''), 2000), own, case when own is not null then now() end,
            case when own is not null then auth.user_id() end, hr_my_code());
    pid := null; n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'inserted', n);
end $$;

-- The public landing-page form (no login). Always answers "ok" so it can't be
-- used to learn whether a number is already a lead.
create or replace function hr_lead_capture(p jsonb)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare ph text; nm text; pid int; lid bigint; camp text; l crm_leads;
begin
  if p is null or jsonb_typeof(p) <> 'object' or length(p::text) > 4000 then raise exception 'bad form'; end if;
  ph := hr_phone(p->>'phone'); nm := left(btrim(coalesce(p->>'name', '')), 120);
  if ph !~ '^[0-9]{10,15}$' then raise exception 'bad phone'; end if;
  if nm = '' then raise exception 'name required'; end if;
  perform pg_advisory_xact_lock(hashtext('hr_lead_capture'));
  if (select count(*) from crm_leads where source = 'landing' and created_at > now() - interval '1 hour') >= 300 then raise exception 'busy'; end if;
  select id into pid from crm_projects where name = btrim(coalesce(p->>'project', '')) and active;
  camp := left(concat_ws(' / ', nullif(btrim(coalesce(p->>'campaign', '')), ''), nullif(btrim(coalesce(p->>'utm_source', '')), ''),
                         nullif(btrim(coalesce(p->>'utm_campaign', '')), ''), nullif(btrim(coalesce(p->>'page', '')), '')), 120);
  select * into l from crm_leads where phone = ph and stage not in ('won', 'lost');
  if l.id is not null then
    insert into crm_activities (lead_id, kind, note) values (l.id, 'system', left('سجّل تاني من صفحة الإنزال' || coalesce(' (' || camp || ')', ''), 1000));
    if l.owner_code is not null then
      perform hr_notify(l.owner_code, null, 'lead', l.name || ' سجّل تاني من الإعلان', 'العميل مهتم. كلّمه دلوقتي.', 'crm_leads', l.id);
    end if;
    return 'ok';
  end if;
  insert into crm_leads (name, phone, source, campaign, project_id, notes)
  values (nm, ph, 'landing', nullif(camp, ''), pid, left(nullif(btrim(coalesce(p->>'message', '')), ''), 2000))
  returning id into lid;
  insert into crm_activities (lead_id, kind, note) values (lid, 'system', 'وصل من صفحة الإنزال');
  perform hr_lead_notify_distributors(lid, 'ليد جديد من الإعلانات: ' || nm, 'مستني توزيع.');
  return 'ok';
end $$;

-- ---------------------------------------------------------------- follow-up

-- One structured follow-up by the lead's owner. Policy rules:
--   no answer / busy -> the next call within 24 hours
--   thinking         -> the next call within 3 days
--   interested, visit booked, offer sent -> a next step is required
--   a call that got through needs a note of at least 10 characters
--   lost / not interested needs a reason
create or replace function hr_lead_log(p_id bigint, p_kind text, p_result text, p_note text, p_next timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare l crm_leads; me text := hr_my_code(); nxt timestamptz := p_next; chk bigint; ver boolean; st text;
begin
  select * into l from crm_leads where id = p_id for update;
  if l.id is null then raise exception 'not found'; end if;
  if not (hr_has('admin') or (l.owner_code is not null and l.owner_code = me)) then raise exception 'not allowed'; end if;
  if l.stage in ('won', 'lost') then raise exception 'lead closed'; end if;
  if p_kind not in ('call', 'whatsapp', 'visit', 'meeting', 'offer', 'note') then raise exception 'bad kind'; end if;
  if p_result is not null and p_result not in ('answered', 'no_answer', 'busy', 'wrong_number', 'interested', 'thinking',
       'not_interested', 'visit_booked', 'visit_done', 'offer_sent', 'reserved', 'won', 'lost') then raise exception 'bad result'; end if;
  if nxt is not null and nxt < now() - interval '5 minutes' then raise exception 'next in the past'; end if;
  if p_result in ('no_answer', 'busy') then
    if nxt is null or nxt > now() + interval '24 hours' then raise exception 'next within 24h'; end if;
  elsif p_result = 'thinking' then
    if nxt is null or nxt > now() + interval '3 days' then raise exception 'next within 3 days'; end if;
  elsif p_result in ('answered', 'interested', 'visit_booked', 'offer_sent', 'visit_done') then
    if nxt is null then raise exception 'next required'; end if;
  end if;
  if p_result in ('answered', 'interested', 'thinking', 'visit_booked', 'visit_done', 'offer_sent', 'reserved', 'won')
     and length(btrim(coalesce(p_note, ''))) < 10 then raise exception 'note too short'; end if;
  if p_result in ('lost', 'not_interested', 'wrong_number') and length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'reason required'; end if;
  if p_result in ('lost', 'not_interested', 'wrong_number', 'won') then nxt := null; end if;

  -- a visit is checked against the owner's field check-ins (meeting or site) within 3 hours
  if p_result = 'visit_done' or p_kind = 'visit' then
    select id into chk from checkins where code = l.owner_code and kind in ('meeting', 'site', 'other')
      and ts between now() - interval '3 hours' and now() + interval '10 minutes' order by ts desc limit 1;
    ver := chk is not null;
  end if;

  st := hr_lead_stage(l.stage, p_result);
  insert into crm_activities (lead_id, code, kind, result, note, next_at, checkin_id, verified)
  values (p_id, coalesce(me, l.owner_code), p_kind, p_result, nullif(btrim(p_note), ''), nxt, chk, ver);
  update crm_leads set stage = st, next_action_at = nxt, last_action_at = now(),
    first_action_at = coalesce(first_action_at, now()),
    lost_reason = case when st = 'lost' then left(btrim(p_note), 300) else lost_reason end
  where id = p_id;
  if p_result = 'visit_done' and not ver then
    perform hr_notify(hr_manager_of(l.owner_code), null, 'lead', 'زيارة من غير تسجيل تواجد: ' || l.name,
      (select coalesce(nullif(name, ''), code) from employees where code = l.owner_code) || ' سجّل زيارة تمت ومفيش تسجيل تواجد في الوقت ده.', 'crm_leads', p_id);
  end if;
  return jsonb_build_object('stage', st, 'verified', ver);
end $$;

-- Close a lead without contact (e.g. a duplicate the distributor spotted).
create or replace function hr_lead_close(p_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_lead_distributor() then raise exception 'not allowed'; end if;
  if length(btrim(coalesce(p_reason, ''))) < 3 then raise exception 'reason required'; end if;
  update crm_leads set stage = 'lost', lost_reason = left(btrim(p_reason), 300), next_action_at = null where id = p_id and stage not in ('won', 'lost');
  if not found then raise exception 'not found'; end if;
  insert into crm_activities (lead_id, code, kind, result, note) values (p_id, hr_my_code(), 'note', 'lost', left(btrim(p_reason), 1000));
end $$;

-- ---------------------------------------------------------------- people who leave

create or replace function hr_lead_release() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare l record;
begin
  if coalesce(old.active, true) and not coalesce(new.active, true) then
    for l in update crm_leads set owner_code = null, assigned_at = null, first_action_at = null
             where owner_code = new.code and stage not in ('won', 'lost') returning id loop
      insert into crm_activities (lead_id, kind, note) values (l.id, 'system', 'رجع للتوزيع لأن ' || coalesce(nullif(new.name, ''), new.code) || ' ساب الشغل');
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists lead_release on employees;
create trigger lead_release after update of active on employees for each row execute function hr_lead_release();

-- ---------------------------------------------------------------- the new permission

update org_positions set roles = array(select distinct r from unnest(roles || '{leads_assign}'::text[]) r order by r)
 where key = 'ops' and not ('leads_assign' = any(roles));

create or replace function hr_create_invite(emp_code text, emp_roles text[] default '{}')
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = emp_code and coalesce(active, true)) then raise exception 'no such employee'; end if;
  if exists (select 1 from unnest(emp_roles) r where r not in ('admin', 'uploader', 'meetings', 'manager', 'recruiter', 'evaluator',
       'viewall', 'approveall', 'pay', 'leads_assign')) then
    raise exception 'bad role';
  end if;
  tok := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  delete from invites where employee_code = emp_code and used_at is null;
  insert into invites (token_hash, employee_code, roles)
  values (encode(sha256(convert_to(tok, 'UTF8')), 'hex'), emp_code, emp_roles);
  return tok;
end $$;

-- ---------------------------------------------------------------- audit and grants

do $$ declare t text; begin
  foreach t in array array['crm_leads', 'crm_projects'] loop
    execute format('drop trigger if exists audit on %I', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function hr_audit()', t);
  end loop;
end $$;

revoke all on function hr_lead_distributor(), hr_lead_sees(text), hr_lead_contacts(), hr_phone(text),
  hr_lead_notify_distributors(bigint, text, text), hr_lead_stage(text, text),
  hr_lead_add(text, text, text, text, int, text, text, text, text), hr_lead_assign(bigint, text), hr_lead_import(jsonb),
  hr_lead_capture(jsonb), hr_lead_log(bigint, text, text, text, timestamptz), hr_lead_close(bigint, text),
  hr_lead_release(), hr_create_invite(text, text[]) from public;
grant execute on function hr_lead_distributor(), hr_lead_sees(text), hr_lead_contacts(),
  hr_lead_add(text, text, text, text, int, text, text, text, text), hr_lead_assign(bigint, text), hr_lead_import(jsonb),
  hr_lead_log(bigint, text, text, text, timestamptz), hr_lead_close(bigint, text), hr_create_invite(text, text[]) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then
    execute 'grant execute on function hr_lead_capture(jsonb) to anonymous';
  end if;
end $$;
grant usage, select on all sequences in schema public to authenticated;

commit;
