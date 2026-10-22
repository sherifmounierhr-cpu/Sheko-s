-- Everest Eco System, part 14: commissions (العمولات).
--
-- Run in the Neon SQL Editor AFTER neon/013_admin.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * Deals, claims, tax invoices and collections from developers, recorded
--     by the commissions owner (permission `commissions`) only.
--   * Each deal names the staff who share in it and their percentage of the
--     company's commission (before VAT). When a part is collected, everyone's
--     share of that part is worked out at once (an entitlement).
--   * Entitlements are approved, shown to the employee when the owner chooses,
--     and marked paid with a date and method. Nothing goes through payroll.
--   * Cancelling a deal voids what wasn't paid and claws back what was.
--   * Confidential: only `commissions` (full) and `commissions_view` (read)
--     see any of it. The system admin is NOT let in by being admin, managers
--     and viewall see nothing, and an employee sees only their own published
--     entitlements through hr_my_commissions(). The admin can hand
--     `commissions` to someone only while nobody holds it; after that only a
--     commissions owner grants or removes these two permissions.
--   * Changes are logged in com_audit (not the shared audit_log the admin reads).

begin;

-- ---------------------------------------------------------------- who's allowed

-- strict: the role itself, no admin bypass (hr_roles is empty for people who left)
create or replace function hr_com(r text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select r = any(hr_roles())
$$;
create or replace function hr_com_read() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_com('commissions') or hr_com('commissions_view')
$$;

-- templates and personal changes keep the commissions permissions where they are
-- (they are never part of a template: see hr_grantable in 013)
create or replace function hr_person_roles(p_code text, cur text[]) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select array(select distinct r from (
      select unnest(coalesce(p.roles, '{}') || coalesce(e.roles_plus, '{}')) r
        from employees e left join org_positions p on p.key = e.position where e.code = p_code) x
    where r <> all(coalesce((select roles_minus from employees where code = p_code), '{}'))
    union select k from unnest(array['admin', 'commissions', 'commissions_view']) k where k = any(coalesce(cur, '{}'))
    order by 1)
$$;

-- Guard on logins: only a commissions owner adds or removes the two permissions,
-- except the very first owner, whom the admin may name (never themself) while nobody holds it.
-- (The SQL Editor, with no signed-in user, is the database owner and isn't checked.)
create or replace function hr_com_role_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o text[] := case when tg_op = 'INSERT' then '{}' else array(select r from unnest(old.roles) r where r in ('commissions', 'commissions_view') order by r) end;
  n text[] := case when tg_op = 'DELETE' then '{}' else array(select r from unnest(new.roles) r where r in ('commissions', 'commissions_view') order by r) end;
begin
  if o = n or auth.user_id() is null then return case when tg_op = 'DELETE' then old else new end; end if;
  if not (hr_com('commissions') or (
      hr_has('admin') and tg_op = 'UPDATE' and n = array['commissions'] and o = '{}' and new.user_id is distinct from auth.user_id()
      and not exists (select 1 from app_users where 'commissions' = any(roles)))) then
    raise exception 'commissions permission is managed by the commissions owner';
  end if;
  insert into notifications (user_id, kind, title, body, ref_table)
  select u.user_id, 'commissions', 'تغيير في صلاحيات العمولات',
         coalesce((select coalesce(nullif(display_name, ''), email) from app_users where user_id = coalesce(new.user_id, old.user_id)), 'حساب')
           || case when cardinality(n) > cardinality(o) then ': اتضافت له صلاحية العمولات' else ': اتشالت منه صلاحية العمولات' end,
         'com'
  from app_users u where 'commissions' = any(u.roles) and u.user_id is distinct from auth.user_id();
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists com_role_guard on app_users;
create trigger com_role_guard before insert or update of roles or delete on app_users
  for each row execute function hr_com_role_guard();

create or replace function hr_com_grant(p_user text, p_role text, p_on boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_role not in ('commissions', 'commissions_view') then raise exception 'bad role'; end if;
  update app_users set roles = case when p_on then array(select distinct r from unnest(roles || array[p_role]) r order by r)
                                    else array_remove(roles, p_role) end
   where user_id = p_user;
  if not found then raise exception 'no such user'; end if;
end $$;

-- ---------------------------------------------------------------- tables

create table if not exists com_settings (
  id    int primary key default 1 check (id = 1),
  vat   numeric(5, 4) not null default 0.14 check (vat between 0 and 0.5),
  wht   numeric(5, 4) not null default 0.05 check (wht between 0 and 0.5),
  show  boolean not null default true,           -- the master switch: employees see published entitlements
  docs  jsonb not null default '{"contract":["العقد","البطاقة"],"claim":["خطاب المطالبة"],"invoice":["الفاتورة الضريبية"],"collect":["إيصال التحصيل"]}'
);
insert into com_settings (id) values (1) on conflict do nothing;

create table if not exists com_roles (
  key   text primary key check (key ~ '^[a-z_]{2,20}$'),
  title text not null check (length(btrim(title)) between 1 and 60),
  pct   numeric(5, 2) not null check (pct between 0 and 100),
  sort  int not null default 0,
  active boolean not null default true
);
insert into com_roles (key, title, pct, sort) values
  ('sales', 'السيلز (ليد من الشركة)', 25, 1),
  ('self',  'السيلز (عميل جابه بنفسه)', 35, 2),
  ('lead',  'قائد الفريق', 10, 3),
  ('ops',   'مدير التشغيل', 5, 4)
on conflict (key) do nothing;

create table if not exists com_deals (
  id            bigserial primary key,
  ref           text check (length(ref) <= 40),                 -- the old ledger's number, if imported
  client        text not null check (length(btrim(client)) between 1 and 120),
  phone         text check (phone ~ '^[0-9]{8,15}$'),
  project_id    int references crm_projects(id) on delete set null,
  project       text check (length(project) <= 80),             -- name as written (imports, or a project not in the list)
  developer     text check (length(developer) <= 80),
  unit          text check (length(unit) <= 80),
  price         numeric(14, 2) not null default 0 check (price >= 0),
  rate          numeric(7, 5) not null default 0 check (rate between 0 and 0.3),
  resale_amount numeric(14, 2) not null default 0 check (resale_amount >= 0),
  method        text not null default 'developer' check (method in ('developer', 'direct', 'nawy', 'resale', 'other')),
  register      text check (length(register) <= 40),
  status        text not null default 'reservation' check (status in ('reservation', 'contract', 'cancelled')),
  sale_date     date not null default current_date,
  contract_date date,
  lead_id       bigint references crm_leads(id) on delete set null,
  notes         text check (length(notes) <= 2000),
  commission    numeric(14, 2) generated always as (round(price * rate + resale_amount, 2)) stored,
  cancel_reason text check (length(cancel_reason) <= 500),
  cancelled_at  timestamptz,
  created_by    text default auth.user_id(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists com_deals_sale on com_deals (sale_date);

create table if not exists com_shares (
  id      bigserial primary key,
  deal_id bigint not null references com_deals(id) on delete restrict,
  code    text not null references employees(code) on update cascade on delete restrict,
  role    text not null references com_roles(key) on update cascade,
  pct     numeric(5, 2) not null check (pct > 0 and pct <= 100),
  unique (deal_id, code, role)
);

create table if not exists com_parts (
  id             bigserial primary key,
  deal_id        bigint not null references com_deals(id) on delete restrict,
  amount         numeric(14, 2) not null check (amount > 0),
  inv_type       text not null default 'G' check (inv_type in ('G', 'N')),   -- G: includes VAT, N: VAT added on top
  wht            boolean not null default true,
  ref            text check (length(ref) <= 60),
  claim_date     date,
  sent_date      date,
  due_date       date,
  collected_date date,
  received       numeric(14, 2) check (received >= 0),                       -- what actually arrived, if different
  note           text check (length(note) <= 500),
  created_at     timestamptz not null default now()
);
create index if not exists com_parts_deal on com_parts (deal_id);

create table if not exists com_payouts (
  id         bigserial primary key,
  code       text not null references employees(code) on update cascade on delete restrict,
  paid_on    date not null,
  method     text not null check (method in ('cash', 'transfer', 'cheque', 'other')),
  ref        text check (length(ref) <= 80),
  amount     numeric(14, 2) not null,
  note       text check (length(note) <= 500),
  status     text not null default 'paid' check (status in ('paid', 'reversed')),
  created_by text default auth.user_id(),
  created_at timestamptz not null default now()
);

create table if not exists com_entitlements (
  id           bigserial primary key,
  deal_id      bigint not null references com_deals(id) on delete restrict,
  part_id      bigint references com_parts(id) on delete restrict,
  share_id     bigint references com_shares(id) on delete restrict,
  code         text not null references employees(code) on update cascade on delete restrict,
  role         text not null,
  kind         text not null default 'share' check (kind in ('share', 'clawback')),
  pct          numeric(5, 2) not null,
  base         numeric(14, 2) not null,             -- the part's amount before VAT
  amount       numeric(14, 2) not null,             -- negative for a clawback
  status       text not null default 'due' check (status in ('due', 'approved', 'paid', 'void')),
  published_at timestamptz,
  approved_at  timestamptz,
  approved_by  text,
  payout_id    bigint references com_payouts(id) on delete restrict,
  created_at   timestamptz not null default now()
);
create index if not exists com_ent_code on com_entitlements (code, status);
create index if not exists com_ent_part on com_entitlements (part_id);

create table if not exists com_files (
  id         bigserial primary key,
  deal_id    bigint not null references com_deals(id) on delete restrict,
  slot       text not null check (slot in ('contract', 'id', 'claim', 'invoice', 'receipt', 'other')),
  name       text not null check (length(name) between 1 and 120),
  mime       text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  size       int not null check (size between 1 and 5242880),
  data       bytea not null,
  created_by text default auth.user_id(),
  created_at timestamptz not null default now()
);

create table if not exists com_audit (
  id     bigserial primary key,
  at     timestamptz not null default now(),
  actor  text,
  tbl    text not null,
  op     text not null,
  row_id bigint,
  old    jsonb,
  new    jsonb
);

-- ---------------------------------------------------------------- rules

-- the part's amount before VAT, at today's VAT rate
create or replace function hr_com_base(p_amount numeric, p_type text) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select round(case when p_type = 'G' then p_amount / (1 + (select vat from com_settings where id = 1)) else p_amount end, 2)
$$;

create or replace function hr_com_deal_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.status = 'cancelled' then raise exception 'deal cancelled'; end if;
  if tg_op = 'UPDATE' and new.status = 'cancelled' and old.status <> 'cancelled' and current_setting('com.cancelling', true) is distinct from 'on' then
    raise exception 'use hr_com_cancel';
  end if;
  if new.phone is not null then new.phone := nullif(hr_phone(new.phone), ''); end if;
  if new.status = 'contract' and new.contract_date is null then new.contract_date := current_date; end if;
  if new.project_id is not null and (new.project is null or new.developer is null) then
    select coalesce(new.project, name), coalesce(new.developer, developer) into new.project, new.developer from crm_projects where id = new.project_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists com_deal_guard on com_deals;
create trigger com_deal_guard before insert or update on com_deals for each row execute function hr_com_deal_guard();

-- a deal's shares can't add up to more than 100%; a share already paid out can't be removed
create or replace function hr_com_share_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare did bigint := coalesce(new.deal_id, old.deal_id);
begin
  if (select status from com_deals where id = did) = 'cancelled' then raise exception 'deal cancelled'; end if;
  if tg_op <> 'DELETE' and (select coalesce(sum(pct), 0) from com_shares where deal_id = did and id <> new.id) + new.pct > 100 then
    raise exception 'shares over 100';
  end if;
  if tg_op = 'DELETE' and exists (select 1 from com_entitlements where share_id = old.id) then raise exception 'share has entitlements'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists com_share_guard on com_shares;
create trigger com_share_guard before insert or update or delete on com_shares for each row execute function hr_com_share_guard();

-- Parts: a collected part is locked (amount, type, WHT). Marking it collected
-- creates everyone's share of it; un-marking voids them unless one was paid.
create or replace function hr_com_part_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select status from com_deals where id = coalesce(new.deal_id, old.deal_id)) = 'cancelled' then raise exception 'deal cancelled'; end if;
  if tg_op = 'DELETE' then
    if old.collected_date is not null then raise exception 'collected part locked'; end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.collected_date is not null and new.collected_date is not null
     and (new.amount, new.inv_type, new.wht, new.deal_id) is distinct from (old.amount, old.inv_type, old.wht, old.deal_id) then
    raise exception 'collected part locked';
  end if;
  if tg_op = 'UPDATE' and old.collected_date is not null and new.collected_date is null then
    if exists (select 1 from com_entitlements where part_id = old.id and status = 'paid') then raise exception 'already paid'; end if;
    update com_entitlements set status = 'void' where part_id = old.id and status <> 'void';
  end if;
  return new;
end $$;
drop trigger if exists com_part_guard on com_parts;
create trigger com_part_guard before insert or update or delete on com_parts for each row execute function hr_com_part_guard();

create or replace function hr_com_part_collected() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare b numeric;
begin
  if new.collected_date is not null and (tg_op = 'INSERT' or old.collected_date is null) then
    b := hr_com_base(new.amount, new.inv_type);
    insert into com_entitlements (deal_id, part_id, share_id, code, role, pct, base, amount)
    select new.deal_id, new.id, s.id, s.code, s.role, s.pct, b, round(b * s.pct / 100, 2)
      from com_shares s where s.deal_id = new.deal_id;
  end if;
  return null;
end $$;
drop trigger if exists com_part_collected on com_parts;
create trigger com_part_collected after insert or update of collected_date on com_parts for each row execute function hr_com_part_collected();

-- entitlements and payouts change only through the functions below
create or replace function hr_com_ent_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then raise exception 'no delete'; end if;
  if tg_op = 'UPDATE' and old.status = 'paid' and new.status <> 'paid' and current_setting('com.reversing', true) is distinct from 'on' then
    raise exception 'already paid';
  end if;
  if tg_op = 'UPDATE' and (new.amount, new.code, new.deal_id, new.part_id) is distinct from (old.amount, old.code, old.deal_id, old.part_id) then
    raise exception 'entitlement locked';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists com_ent_guard on com_entitlements;
create trigger com_ent_guard before update or delete on com_entitlements for each row execute function hr_com_ent_guard();

create or replace function hr_com_no_delete() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin raise exception 'no delete'; end $$;
drop trigger if exists com_no_delete on com_deals;
create trigger com_no_delete before delete on com_deals for each row execute function hr_com_no_delete();
drop trigger if exists com_no_delete on com_payouts;
create trigger com_no_delete before delete on com_payouts for each row execute function hr_com_no_delete();

-- ---------------------------------------------------------------- actions

-- approve, publish or hide entitlements (one call for many rows)
create or replace function hr_com_approve(p_ids bigint[])
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  update com_entitlements set status = 'approved', approved_at = now(), approved_by = auth.user_id()
   where id = any(p_ids) and status = 'due';
  get diagnostics n = row_count; return n;
end $$;

create or replace function hr_com_publish(p_ids bigint[], p_on boolean)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  update com_entitlements set published_at = case when p_on then coalesce(published_at, now()) end
   where id = any(p_ids) and status <> 'void';
  get diagnostics n = row_count;
  -- the employee hears that something changed, never the amount (the admin can peek at inboxes)
  if p_on then
    insert into notifications (code, kind, title, ref_table)
    select distinct code, 'commissions', 'فيه تحديث في عمولاتك', 'com' from com_entitlements where id = any(p_ids) and status <> 'void';
  end if;
  return n;
end $$;

-- record a payment to one employee for the chosen approved entitlements (clawbacks net against them)
create or replace function hr_com_pay(p_ids bigint[], p_paid_on date, p_method text, p_ref text, p_note text default null)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare who text; total numeric; pid bigint;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  if p_paid_on is null or p_paid_on > current_date + 1 then raise exception 'bad date'; end if;
  if (select count(distinct code) from com_entitlements where id = any(p_ids)) <> 1 then raise exception 'one employee per payment'; end if;
  if exists (select 1 from com_entitlements where id = any(p_ids) and not (status = 'approved' or (kind = 'clawback' and status in ('due', 'approved')))) then
    raise exception 'not approved';
  end if;
  select min(code), sum(amount) into who, total from com_entitlements where id = any(p_ids);
  insert into com_payouts (code, paid_on, method, ref, amount, note) values (who, p_paid_on, p_method, nullif(btrim(p_ref), ''), total, nullif(btrim(p_note), ''))
  returning id into pid;
  update com_entitlements set status = 'paid', payout_id = pid where id = any(p_ids);
  if exists (select 1 from com_entitlements where payout_id = pid and published_at is not null) then
    insert into notifications (code, kind, title, ref_table) values (who, 'commissions', 'فيه تحديث في عمولاتك', 'com');
  end if;
  return pid;
end $$;

-- undo a payment recorded by mistake: its entitlements go back to approved
create or replace function hr_com_unpay(p_payout bigint, p_reason text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required'; end if;
  update com_payouts set status = 'reversed', note = left(coalesce(note || ' | ', '') || 'اتلغى: ' || p_reason, 500) where id = p_payout and status = 'paid';
  if not found then raise exception 'not found'; end if;   -- (checked before any perform)
  perform set_config('com.reversing', 'on', true);
  update com_entitlements set status = 'approved', payout_id = null where payout_id = p_payout;
  perform set_config('com.reversing', 'off', true);
end $$;

-- Cancel a deal: unpaid shares are voided, paid ones are clawed back (a negative
-- line that nets against the employee's next payment), shown to them only if the
-- original was.
create or replace function hr_com_cancel(p_deal bigint, p_reason text)
returns int language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required'; end if;
  perform set_config('com.cancelling', 'on', true);
  update com_deals set status = 'cancelled', cancel_reason = btrim(p_reason), cancelled_at = now() where id = p_deal and status <> 'cancelled';
  get diagnostics n = row_count;
  perform set_config('com.cancelling', 'off', true);
  if n = 0 then raise exception 'not found'; end if;
  update com_entitlements set status = 'void' where deal_id = p_deal and status in ('due', 'approved') and kind = 'share';
  insert into com_entitlements (deal_id, part_id, share_id, code, role, kind, pct, base, amount, status, published_at)
  select deal_id, part_id, share_id, code, role, 'clawback', pct, base, -amount, 'due', published_at
    from com_entitlements where deal_id = p_deal and status = 'paid' and kind = 'share';
  get diagnostics n = row_count;
  return n;
end $$;

-- the people a commissions owner can pick from (they can't read employees otherwise)
create or replace function hr_com_people()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_com_read() then coalesce((
    select jsonb_agg(jsonb_build_object('code', e.code, 'name', coalesce(nullif(e.name, ''), e.code), 'position', e.position, 'team', t.name,
      'user', u.user_id, 'roles', to_jsonb(array(select r from unnest(coalesce(u.roles, '{}')) r where r in ('commissions', 'commissions_view'))),
      'active', coalesce(e.active, true)) order by e.name)
    from employees e left join teams t on t.id = e.team_id left join app_users u on u.employee_code = e.code), '[]') end
$$;

-- what an employee sees: their own published lines, while the master switch is on
create or replace function hr_my_commissions()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'project', coalesce(d.project, ''), 'unit', coalesce(d.unit, ''), 'role', r.title, 'kind', x.kind,
      'part', (select count(*) from com_parts p2 where p2.deal_id = x.deal_id and p2.id <= x.part_id),
      'parts', (select count(*) from com_parts p3 where p3.deal_id = x.deal_id),
      'amount', x.amount, 'status', x.status, 'published', x.published_at, 'collected', p.collected_date,
      'paid_on', po.paid_on, 'method', po.method) order by coalesce(p.collected_date, x.created_at::date) desc, x.id desc)
    from com_entitlements x join com_deals d on d.id = x.deal_id left join com_parts p on p.id = x.part_id
      left join com_roles r on r.key = x.role left join com_payouts po on po.id = x.payout_id and po.status = 'paid'
    where x.code = hr_my_code() and x.published_at is not null and x.status <> 'void'
      and (select show from com_settings where id = 1)), '[]')
$$;

-- deal documents: PDF or a photo, up to 5 MB
create or replace function hr_com_file_add(p_deal bigint, p_slot text, p_name text, p_mime text, p_b64 text)
returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare bin bytea; head bytea; ok boolean; fid bigint;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  if not exists (select 1 from com_deals where id = p_deal) then raise exception 'not found'; end if;
  if p_b64 is null or length(p_b64) > 7000000 then raise exception 'too big'; end if;
  begin bin := decode(p_b64, 'base64'); exception when others then raise exception 'bad file'; end;
  if length(bin) > 5242880 then raise exception 'too big'; end if;
  head := substring(bin from 1 for 4);
  ok := case p_mime when 'application/pdf' then head = '\x25504446'::bytea
                    when 'image/jpeg' then substring(head from 1 for 3) = '\xffd8ff'::bytea
                    when 'image/png' then head = '\x89504e47'::bytea else false end;
  if not coalesce(ok, false) then raise exception 'bad file'; end if;
  insert into com_files (deal_id, slot, name, mime, size, data)
  values (p_deal, p_slot, left(coalesce(nullif(btrim(p_name), ''), 'file'), 120), p_mime, length(bin), bin) returning id into fid;
  return fid;
end $$;

create or replace function hr_com_file(p_id bigint)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_com_read() then (select jsonb_build_object('name', name, 'mime', mime, 'b64', encode(data, 'base64')) from com_files where id = p_id) end
$$;

-- ---------------------------------------------------------------- audit (kept apart from the shared audit_log)

create or replace function hr_com_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare o jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end; n jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
begin
  if tg_table_name = 'com_files' then o := o - 'data'; n := n - 'data'; end if;
  insert into com_audit (actor, tbl, op, row_id, old, new)
  values (auth.user_id(), tg_table_name, tg_op, case when coalesce(n ->> 'id', o ->> 'id') ~ '^[0-9]+$' then coalesce(n ->> 'id', o ->> 'id')::bigint end, o, n);
  return null;
end $$;
do $$ declare t text; begin
  foreach t in array array['com_settings', 'com_roles', 'com_deals', 'com_shares', 'com_parts', 'com_entitlements', 'com_payouts', 'com_files'] loop
    execute format('drop trigger if exists com_audit on %I', t);
    execute format('create trigger com_audit after insert or update or delete on %I for each row execute function hr_com_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- row-level security

do $$ declare t text; begin
  foreach t in array array['com_settings', 'com_roles', 'com_deals', 'com_shares', 'com_parts', 'com_entitlements', 'com_payouts', 'com_files', 'com_audit'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    execute format('revoke all on %I from authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'anonymous') then execute format('revoke all on %I from anonymous', t); end if;
    execute format('drop policy if exists com_read on %I', t);
    execute format('drop policy if exists com_write on %I', t);
  end loop;
end $$;

-- read: owners and viewers; files only through hr_com_file, audit only for owners
do $$ declare t text; begin
  foreach t in array array['com_settings', 'com_roles', 'com_deals', 'com_shares', 'com_parts', 'com_entitlements', 'com_payouts'] loop
    execute format('create policy com_read on %I for select to authenticated using (hr_com_read())', t);
    execute format('grant select on %I to authenticated', t);
  end loop;
  -- write: the owner only, and only where a change is a plain edit
  foreach t in array array['com_settings', 'com_roles', 'com_deals', 'com_shares', 'com_parts'] loop
    execute format('create policy com_write on %I for all to authenticated using (hr_com(''commissions'')) with check (hr_com(''commissions''))', t);
  end loop;
end $$;
grant update (vat, wht, show, docs) on com_settings to authenticated;
grant insert, update on com_roles to authenticated;
grant insert, update (ref, client, phone, project_id, project, developer, unit, price, rate, resale_amount, method, register, status,
  sale_date, contract_date, lead_id, notes) on com_deals to authenticated;
grant insert, update, delete on com_shares to authenticated;
grant insert, update, delete on com_parts to authenticated;
grant usage on sequence com_deals_id_seq, com_shares_id_seq, com_parts_id_seq to authenticated;
-- documents: the list (never the contents) is readable like the rest; contents only through hr_com_file
create policy com_read on com_files for select to authenticated using (hr_com_read());
grant select (id, deal_id, slot, name, mime, size, created_at) on com_files to authenticated;
create policy com_read on com_audit for select to authenticated using (hr_com('commissions'));
grant select on com_audit to authenticated;

-- ---------------------------------------------------------------- grants on functions

revoke all on function hr_com(text), hr_com_read(), hr_person_roles(text, text[]), hr_com_role_guard(), hr_com_grant(text, text, boolean),
  hr_com_base(numeric, text), hr_com_deal_guard(), hr_com_share_guard(), hr_com_part_guard(), hr_com_part_collected(), hr_com_ent_guard(),
  hr_com_no_delete(), hr_com_approve(bigint[]), hr_com_publish(bigint[], boolean), hr_com_pay(bigint[], date, text, text, text),
  hr_com_unpay(bigint, text), hr_com_cancel(bigint, text), hr_com_people(), hr_my_commissions(),
  hr_com_file_add(bigint, text, text, text, text), hr_com_file(bigint), hr_com_audit() from public;
grant execute on function hr_com(text), hr_com_read(), hr_com_grant(text, text, boolean), hr_com_approve(bigint[]),
  hr_com_publish(bigint[], boolean), hr_com_pay(bigint[], date, text, text, text), hr_com_unpay(bigint, text), hr_com_cancel(bigint, text),
  hr_com_people(), hr_my_commissions(), hr_com_file_add(bigint, text, text, text, text), hr_com_file(bigint) to authenticated;

commit;
