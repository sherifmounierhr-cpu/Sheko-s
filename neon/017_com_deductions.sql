-- Everest Eco System, part 17: deductions before the split, and who sees which part of a deal.
--
-- Run in the Neon SQL Editor AFTER neon/015_com_import.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * Each deal can deduct taxes (14%, ticked by default) straight from the
--     commission, then an admin/collection fee of 11% or 21% from what's left.
--     Staff shares are worked out from that net. The rates live in settings;
--     the fee chosen is stored on the deal so a later change doesn't move it.
--   * The commissions owner who was named first (the "primary" owner) decides,
--     person by person, who else sees a deal's staff shares and its claims and
--     parts. Everyone else, other commissions owners included, starts with the
--     deal only. Only the primary owner grants or removes the commissions
--     permissions from now on.

begin;

-- ---------------------------------------------------------------- deductions

alter table com_settings add column if not exists tax_rate numeric(5, 4) not null default 0.14 check (tax_rate between 0 and 0.5);
alter table com_settings add column if not exists fee_low  numeric(5, 4) not null default 0.11 check (fee_low between 0 and 0.9);
alter table com_settings add column if not exists fee_high numeric(5, 4) not null default 0.21 check (fee_high between 0 and 0.9);
alter table com_settings add column if not exists owner_user text;

alter table com_deals add column if not exists tax_on boolean not null default true;
alter table com_deals add column if not exists admin_fee numeric(5, 4) not null default 0 check (admin_fee between 0 and 0.9);

-- the share of a deal's commission left for staff shares, after taxes and the fee
create or replace function hr_com_factor(p_deal bigint) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select (1 - case when d.tax_on then s.tax_rate else 0 end) * (1 - d.admin_fee)
  from com_deals d cross join com_settings s where d.id = p_deal and s.id = 1
$$;

-- a fee must be one of the two in settings (or none) when it's set or changed
create or replace function hr_com_fee_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.admin_fee <> 0 and (tg_op = 'INSERT' or new.admin_fee is distinct from old.admin_fee)
     and new.admin_fee not in (select fee_low from com_settings where id = 1 union select fee_high from com_settings where id = 1) then
    raise exception 'bad fee';
  end if;
  return new;
end $$;
drop trigger if exists com_fee_guard on com_deals;
create trigger com_fee_guard before insert or update of admin_fee on com_deals for each row execute function hr_com_fee_guard();

-- shares are worked out from the part's amount after the deal's deductions
create or replace function hr_com_part_collected() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare b numeric;
begin
  if new.collected_date is not null and (tg_op = 'INSERT' or old.collected_date is null) then
    b := round(new.amount * coalesce(hr_com_factor(new.deal_id), 1), 2);
    insert into com_entitlements (deal_id, part_id, share_id, code, role, pct, base, amount)
    select new.deal_id, new.id, s.id, s.code, s.role, s.pct, b, round(b * s.pct / 100, 2)
      from com_shares s where s.deal_id = new.deal_id;
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------- the primary owner and section access

-- the owner named first; while none is set, every commissions owner counts as primary
update com_settings set owner_user = (
  select min(user_id) from app_users where 'commissions' = any(roles) and not 'admin' = any(roles)
  having count(*) = 1)
where id = 1 and owner_user is null;

create table if not exists com_access (
  user_id text primary key,
  shares  boolean not null default false,   -- نصيب الموظفين, المستحقات والصرف
  parts   boolean not null default false,   -- المطالبة والدفعات, الفواتير, المستندات
  updated_at timestamptz not null default now()
);

create or replace function hr_com_primary() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_com('commissions') and coalesce((select owner_user from com_settings where id = 1) = auth.user_id(),
                                            (select owner_user from com_settings where id = 1) is null)
$$;

create or replace function hr_com_sees(p_section text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select hr_com_read() and (hr_com_primary() or coalesce((
    select case p_section when 'shares' then a.shares when 'parts' then a.parts else false end
    from com_access a where a.user_id = auth.user_id()), false))
$$;

create or replace function hr_com_access(p_user text, p_shares boolean, p_parts boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not hr_com_primary() then raise exception 'only the primary commissions owner'; end if;
  if p_user = auth.user_id() then raise exception 'not for yourself'; end if;
  insert into com_access (user_id, shares, parts, updated_at) values (p_user, coalesce(p_shares, false), coalesce(p_parts, false), now())
  on conflict (user_id) do update set shares = excluded.shares, parts = excluded.parts, updated_at = now();
  insert into notifications (user_id, kind, title, ref_table) values (p_user, 'commissions', 'اتغيّر اللي تقدر تشوفه في العمولات', 'com');
end $$;

-- From now on only the primary owner adds or removes the two permissions. The admin
-- still names the first owner while nobody holds it, and that owner becomes primary.
create or replace function hr_com_role_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o text[] := case when tg_op = 'INSERT' then '{}' else array(select r from unnest(old.roles) r where r in ('commissions', 'commissions_view') order by r) end;
  n text[] := case when tg_op = 'DELETE' then '{}' else array(select r from unnest(new.roles) r where r in ('commissions', 'commissions_view') order by r) end;
  boot boolean;
  who text := coalesce(case when tg_op = 'DELETE' then old.user_id else new.user_id end, '');
begin
  if o = n then return case when tg_op = 'DELETE' then old else new end; end if;
  boot := tg_op = 'UPDATE' and n = array['commissions'] and o = '{}' and new.user_id is distinct from auth.user_id()
          and not exists (select 1 from app_users where 'commissions' = any(roles));
  if auth.user_id() is not null and not (hr_com_primary() or (hr_has('admin') and boot)) then
    raise exception 'commissions permission is managed by the commissions owner';
  end if;
  -- the first owner becomes primary; a primary owner who loses the permission stops being primary
  if boot then update com_settings set owner_user = who where id = 1; end if;
  if not ('commissions' = any(n)) then update com_settings set owner_user = null where id = 1 and owner_user = who; end if;
  if auth.user_id() is not null then
    insert into notifications (user_id, kind, title, body, ref_table)
    select u.user_id, 'commissions', 'تغيير في صلاحيات العمولات',
           coalesce((select coalesce(nullif(display_name, ''), email) from app_users where user_id = who), 'حساب')
             || case when cardinality(n) > cardinality(o) then ': اتضافت له صلاحية العمولات' else ': اتشالت منه صلاحية العمولات' end,
           'com'
    from app_users u where 'commissions' = any(u.roles) and u.user_id is distinct from auth.user_id();
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

-- Writes that touch a section need that section. A row written by another
-- trigger (a collection creating its staff shares) is part of that action.
create or replace function hr_com_section_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare sec text := tg_argv[0];
begin
  if auth.user_id() is not null and pg_trigger_depth() = 1 and not hr_com_sees(sec) then raise exception 'section hidden'; end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
do $$ declare t text; s text; begin
  for t, s in select * from (values ('com_shares', 'shares'), ('com_entitlements', 'shares'), ('com_payouts', 'shares'),
                                    ('com_parts', 'parts'), ('com_files', 'parts')) v(t, s) loop
    execute format('drop trigger if exists com_section_guard on %I', t);
    execute format('create trigger com_section_guard before insert or update or delete on %I for each row execute function hr_com_section_guard(%L)', t, s);
  end loop;
end $$;

-- cancelling touches the shares and the parts, so it needs both
create or replace function hr_com_cancel_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'cancelled' and old.status <> 'cancelled' and auth.user_id() is not null
     and not (hr_com_sees('shares') and hr_com_sees('parts')) then
    raise exception 'section hidden';
  end if;
  return new;
end $$;
drop trigger if exists com_cancel_guard on com_deals;
create trigger com_cancel_guard before update of status on com_deals for each row execute function hr_com_cancel_guard();

-- reads follow the same split. The write policies from 014 were "for all", which
-- also let any commissions owner read; they now need the section as well.
drop policy if exists com_write on com_shares;
create policy com_write on com_shares for all to authenticated
  using (hr_com('commissions') and hr_com_sees('shares')) with check (hr_com('commissions') and hr_com_sees('shares'));
drop policy if exists com_write on com_parts;
create policy com_write on com_parts for all to authenticated
  using (hr_com('commissions') and hr_com_sees('parts')) with check (hr_com('commissions') and hr_com_sees('parts'));
drop policy if exists com_read on com_shares;
create policy com_read on com_shares for select to authenticated using (hr_com_sees('shares'));
drop policy if exists com_read on com_entitlements;
create policy com_read on com_entitlements for select to authenticated using (hr_com_sees('shares'));
drop policy if exists com_read on com_payouts;
create policy com_read on com_payouts for select to authenticated using (hr_com_sees('shares'));
drop policy if exists com_read on com_parts;
create policy com_read on com_parts for select to authenticated using (hr_com_sees('parts'));
drop policy if exists com_read on com_files;
create policy com_read on com_files for select to authenticated using (hr_com_sees('parts'));
drop policy if exists com_read on com_audit;
create policy com_read on com_audit for select to authenticated using (hr_com_primary());

alter table com_access enable row level security;
revoke all on com_access from public;
revoke all on com_access from authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anonymous') then execute 'revoke all on com_access from anonymous'; end if;
end $$;
drop policy if exists com_read on com_access;
create policy com_read on com_access for select to authenticated using (hr_com_primary() or (user_id = auth.user_id() and hr_com_read()));
grant select on com_access to authenticated;
drop trigger if exists com_audit on com_access;
create trigger com_audit after insert or update or delete on com_access for each row execute function hr_com_audit();

create or replace function hr_com_file(p_id bigint)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_com_sees('parts') then (select jsonb_build_object('name', name, 'mime', mime, 'b64', encode(data, 'base64')) from com_files where id = p_id) end
$$;

-- the people list also says who is primary and, for the primary, everyone's access
create or replace function hr_com_people()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select case when hr_com_read() then coalesce((
    select jsonb_agg(jsonb_build_object('code', e.code, 'name', coalesce(nullif(e.name, ''), e.code), 'position', e.position, 'team', t.name,
      'user', u.user_id, 'roles', to_jsonb(array(select r from unnest(coalesce(u.roles, '{}')) r where r in ('commissions', 'commissions_view'))),
      'primary', u.user_id is not null and u.user_id = (select owner_user from com_settings where id = 1),
      'shares', case when hr_com_primary() or u.user_id = auth.user_id() then coalesce(a.shares, false) end,
      'parts', case when hr_com_primary() or u.user_id = auth.user_id() then coalesce(a.parts, false) end,
      'active', coalesce(e.active, true)) order by e.name)
    from employees e left join teams t on t.id = e.team_id left join app_users u on u.employee_code = e.code
      left join com_access a on a.user_id = u.user_id), '[]') end
$$;

grant update (vat, wht, show, docs, tax_rate, fee_low, fee_high) on com_settings to authenticated;
grant insert, update (tax_on, admin_fee) on com_deals to authenticated;

revoke all on function hr_com_factor(bigint), hr_com_fee_guard(), hr_com_primary(), hr_com_sees(text), hr_com_access(text, boolean, boolean),
  hr_com_section_guard(), hr_com_cancel_guard() from public;
grant execute on function hr_com_factor(bigint), hr_com_primary(), hr_com_sees(text), hr_com_access(text, boolean, boolean) to authenticated;

commit;
