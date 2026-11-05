-- Everest Eco System, part 20: VAT and the 5% withholding, worked out like the accounts sheet.
--
-- Run in the Neon SQL Editor AFTER neon/019_no_punch.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * Each deal says whether its commission already includes the 14% VAT (type G
--     in the sheet) and whether 5% is withheld at source. Both are ticked by default.
--   * The base for staff shares is now: commission ÷ 1.14 when VAT is included,
--     minus 5% of that when withheld, then minus the admin/collection fee.
--     (017 took 14% straight off, which is less than the sheet for a G commission.)
--   * A deal's parts that aren't collected yet follow the deal's two ticks, and the
--     first part of a deal (the old-ledger import) sets them.
--     Staff shares already created keep their amounts.

begin;

alter table com_deals add column if not exists vat_incl boolean not null default true;
alter table com_deals add column if not exists wht_on   boolean not null default true;
-- deals from 017: "taxes ticked" meant the commission carried the VAT
do $$ begin
  if exists (select 1 from information_schema.columns where table_name = 'com_deals' and column_name = 'tax_on') then
    execute 'update com_deals set vat_incl = tax_on where vat_incl is distinct from tax_on and not exists (select 1 from com_parts p where p.deal_id = com_deals.id)';
  end if;
end $$;

-- what one collected part leaves for staff shares
create or replace function hr_com_part_base(p_amount numeric, p_type text, p_wht boolean, p_fee numeric) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select round(b * (1 - case when p_wht then s.wht else 0 end) * (1 - coalesce(p_fee, 0)), 2)
  from com_settings s, lateral (select case when p_type = 'G' then p_amount / (1 + s.vat) else p_amount end as b) x
  where s.id = 1
$$;

-- the same, for the whole deal (estimates on screen)
create or replace function hr_com_factor(p_deal bigint) returns numeric
language sql stable security definer set search_path = public, pg_temp as $$
  select (case when d.vat_incl then 1 / (1 + s.vat) else 1 end) * (1 - case when d.wht_on then s.wht else 0 end) * (1 - d.admin_fee)
  from com_deals d cross join com_settings s where d.id = p_deal and s.id = 1
$$;

create or replace function hr_com_part_collected() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare b numeric;
begin
  if new.collected_date is not null and (tg_op = 'INSERT' or old.collected_date is null) then
    b := hr_com_part_base(new.amount, new.inv_type, new.wht, (select admin_fee from com_deals where id = new.deal_id));
    insert into com_entitlements (deal_id, part_id, share_id, code, role, pct, base, amount)
    select new.deal_id, new.id, s.id, s.code, s.role, s.pct, b, round(b * s.pct / 100, 2)
      from com_shares s where s.deal_id = new.deal_id;
  end if;
  return null;
end $$;

-- the first part of a deal sets its ticks (the old-ledger import brings G/N and the 5% per row)
drop trigger if exists com_part_defaults on com_parts;
drop function if exists hr_com_part_defaults();
create or replace function hr_com_part_first() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (select count(*) from com_parts where deal_id = new.deal_id) = 1 then
    update com_deals set vat_incl = (new.inv_type = 'G'), wht_on = new.wht
     where id = new.deal_id and (vat_incl is distinct from (new.inv_type = 'G') or wht_on is distinct from new.wht);
  end if;
  return null;
end $$;
drop trigger if exists com_part_first on com_parts;
create trigger com_part_first after insert on com_parts for each row execute function hr_com_part_first();

-- changing the deal's ticks moves its parts that aren't collected yet
create or replace function hr_com_deal_ticks() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.vat_incl is distinct from old.vat_incl or new.wht_on is distinct from old.wht_on then
    update com_parts set inv_type = case when new.vat_incl then 'G' else 'N' end, wht = new.wht_on
     where deal_id = new.id and collected_date is null;
  end if;
  return null;
end $$;
drop trigger if exists com_deal_ticks on com_deals;
create trigger com_deal_ticks after update of vat_incl, wht_on on com_deals for each row execute function hr_com_deal_ticks();

revoke all on function hr_com_part_base(numeric, text, boolean, numeric), hr_com_factor(bigint), hr_com_part_collected(),
  hr_com_part_first(), hr_com_deal_ticks() from public;
grant execute on function hr_com_part_base(numeric, text, boolean, numeric), hr_com_factor(bigint) to authenticated;
grant insert, update (vat_incl, wht_on) on com_deals to authenticated;

commit;

notify pgrst, 'reload schema';
