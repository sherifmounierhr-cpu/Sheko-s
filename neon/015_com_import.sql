-- Everest Eco System, part 15: bring the old commissions ledger in from Excel.
--
-- Run in the Neon SQL Editor AFTER neon/014_commissions.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
--   * The commissions owner uploads the old ledger's Excel export. The portal
--     reads it, and hr_com_import shows a preview first (new deals, deals that
--     get their empty fields filled, and anything wrong, row by row), then
--     imports everything or nothing.
--   * A deal already in the portal (same client and unit) only has its empty
--     fields filled; nothing typed by hand is overwritten.
--   * Salesperson and team-leader names are matched to employees. A name that
--     doesn't match is reported and the deal comes in without that share.
--   * Money already collected becomes a collected part. The staff shares of it
--     are marked paid (the old ledger didn't track payouts) unless the owner
--     unticks that, and they are never shown to the employee by the import.

begin;

-- Arabic text compared loosely: alef/ya/ta marbuta forms, tatweel, diacritics, spaces
create or replace function hr_ar_norm(t text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(t, '')), 'أإآٱةىـًٌٍَُِّْ', 'ااااهي'),
    '\s+', ' ', 'g'))
$$;

alter table com_entitlements add column if not exists note text check (length(note) <= 200);

-- p_rows: [{client, phone, project, developer, unit, price, rate, resale, method, status, register,
--           sale, contract, notes, sales, team, inv_type, wht, claim, sent, collected, collected_on}]
-- rate is a fraction (0.04) or a percent (4); dates are yyyy-mm-dd.
create or replace function hr_com_import(p_rows jsonb, p_apply boolean, p_history_paid boolean default true)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r jsonb; i int := 0; errs jsonb := '[]'; warns jsonb := '[]'; plan jsonb := '[]';
  cl text; un text; v_rate numeric; v_price numeric; did bigint; ex com_deals; act text;
  scode text; tcode text; n_new int := 0; n_upd int := 0; coll numeric; pid bigint; rem numeric;
  sd date; cd date; cod date; st text; meth text; typ text;
begin
  if not hr_com('commissions') then raise exception 'not allowed'; end if;
  -- needs the staff shares and the parts sections too (neon/017_com_deductions.sql); run 015 and 017 together
  if not (hr_com_sees('shares') and hr_com_sees('parts')) then raise exception 'section hidden'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then raise exception 'bad rows'; end if;

  -- pass 1: check every row and say what would happen
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    cl := btrim(coalesce(r->>'client', '')); un := btrim(coalesce(r->>'unit', ''));
    if cl = '' then errs := errs || jsonb_build_object('row', i, 'msg', 'اسم العميل فاضي'); continue; end if;
    begin
      v_price := nullif(r->>'price', '')::numeric; v_rate := nullif(r->>'rate', '')::numeric;
      coll := nullif(r->>'collected', '')::numeric;
      sd := nullif(r->>'sale', '')::date; cd := nullif(r->>'contract', '')::date; cod := nullif(r->>'collected_on', '')::date;
      perform nullif(r->>'claim', '')::date, nullif(r->>'sent', '')::date, nullif(r->>'resale', '')::numeric;
    exception when others then
      errs := errs || jsonb_build_object('row', i, 'msg', cl || ': رقم أو تاريخ مش مفهوم'); continue;
    end;
    if v_rate > 1 then v_rate := v_rate / 100; end if;
    if v_price < 0 or v_rate < 0 or v_rate > 0.3 then errs := errs || jsonb_build_object('row', i, 'msg', cl || ': السعر أو النسبة مش منطقية'); continue; end if;
    if coll < 0 then errs := errs || jsonb_build_object('row', i, 'msg', cl || ': المبلغ المحصّل بالسالب'); continue; end if;
    select * into ex from com_deals d where hr_ar_norm(d.client) = hr_ar_norm(cl) and hr_ar_norm(d.unit) = hr_ar_norm(un) and d.status <> 'cancelled' order by id limit 1;
    act := case when ex.id is null then 'new' else 'update' end;
    if nullif(btrim(coalesce(r->>'sales', '')), '') is not null and
       (select count(*) from employees e where hr_ar_norm(e.name) = hr_ar_norm(r->>'sales') or hr_ar_norm(e.full_name) = hr_ar_norm(r->>'sales')) <> 1 then
      warns := warns || jsonb_build_object('row', i, 'msg', cl || ': مش لاقي موظف واحد باسم ' || btrim(r->>'sales') || '، الصفقة هتدخل من غير نصيبه');
    end if;
    if nullif(btrim(coalesce(r->>'team', '')), '') is not null and
       (select count(*) from employees e where hr_ar_norm(e.name) = hr_ar_norm(r->>'team') or hr_ar_norm(e.full_name) = hr_ar_norm(r->>'team')) <> 1 then
      warns := warns || jsonb_build_object('row', i, 'msg', cl || ': مش لاقي موظف واحد باسم ' || btrim(r->>'team') || ' (تيم ليدر)');
    end if;
    plan := plan || jsonb_build_object('row', i, 'client', cl, 'unit', un, 'action', act,
      'commission', round(coalesce(v_price, 0) * coalesce(v_rate, 0) + coalesce(nullif(r->>'resale', '')::numeric, 0), 2), 'collected', coalesce(coll, 0));
    if act = 'new' then n_new := n_new + 1; else n_upd := n_upd + 1; end if;
  end loop;
  if not p_apply or jsonb_array_length(errs) > 0 then
    return jsonb_build_object('ok', jsonb_array_length(errs) = 0, 'applied', false, 'new', n_new, 'update', n_upd, 'errors', errs, 'warnings', warns, 'plan', plan);
  end if;

  -- pass 2: write it all (any failure rolls the whole import back)
  for r in select * from jsonb_array_elements(p_rows) loop
    cl := btrim(r->>'client'); un := btrim(coalesce(r->>'unit', ''));
    v_rate := nullif(r->>'rate', '')::numeric; if v_rate > 1 then v_rate := v_rate / 100; end if;
    v_price := nullif(r->>'price', '')::numeric; coll := coalesce(nullif(r->>'collected', '')::numeric, 0);
    sd := nullif(r->>'sale', '')::date; cd := nullif(r->>'contract', '')::date; cod := nullif(r->>'collected_on', '')::date;
    st := case when r->>'status' in ('contract', 'reservation') then r->>'status'
               when cd is not null or coll > 0 or nullif(r->>'claim', '') is not null then 'contract' else 'reservation' end;
    meth := case when r->>'method' in ('developer', 'direct', 'nawy', 'resale', 'other') then r->>'method' else 'developer' end;
    typ := case when upper(coalesce(r->>'inv_type', '')) = 'N' then 'N' else 'G' end;
    select * into ex from com_deals d where hr_ar_norm(d.client) = hr_ar_norm(cl) and hr_ar_norm(d.unit) = hr_ar_norm(un) and d.status <> 'cancelled' order by id limit 1;
    if ex.id is null then
      insert into com_deals (client, phone, project, developer, unit, price, rate, resale_amount, method, register, status, sale_date, contract_date, notes)
      values (left(cl, 120), nullif(hr_phone(r->>'phone'), ''), left(nullif(btrim(coalesce(r->>'project', '')), ''), 80), left(nullif(btrim(coalesce(r->>'developer', '')), ''), 80),
              left(nullif(un, ''), 80), coalesce(v_price, 0), coalesce(v_rate, 0), coalesce(nullif(r->>'resale', '')::numeric, 0), meth,
              left(nullif(btrim(coalesce(r->>'register', '')), ''), 40), st, coalesce(sd, cd, current_date), cd, left(nullif(btrim(coalesce(r->>'notes', '')), ''), 2000))
      returning id into did;
    else
      did := ex.id;
      update com_deals set
        phone = coalesce(phone, nullif(hr_phone(r->>'phone'), '')),
        project = coalesce(nullif(project, ''), left(nullif(btrim(coalesce(r->>'project', '')), ''), 80)),
        developer = coalesce(nullif(developer, ''), left(nullif(btrim(coalesce(r->>'developer', '')), ''), 80)),
        price = case when price = 0 then coalesce(v_price, 0) else price end,
        rate = case when rate = 0 then coalesce(v_rate, 0) else rate end,
        register = coalesce(nullif(register, ''), left(nullif(btrim(coalesce(r->>'register', '')), ''), 40)),
        contract_date = coalesce(contract_date, cd),
        status = case when status = 'reservation' and st = 'contract' then 'contract' else status end,
        notes = coalesce(nullif(notes, ''), left(nullif(btrim(coalesce(r->>'notes', '')), ''), 2000))
      where id = did;
    end if;
    -- shares, only on a deal that has none yet
    if not exists (select 1 from com_shares where deal_id = did) then
      if nullif(btrim(coalesce(r->>'sales', '')), '') is not null then
        select min(e.code) into scode from employees e where hr_ar_norm(e.name) = hr_ar_norm(r->>'sales') or hr_ar_norm(e.full_name) = hr_ar_norm(r->>'sales') having count(*) = 1;
      end if;
      if nullif(btrim(coalesce(r->>'team', '')), '') is not null then
        select min(e.code) into tcode from employees e where hr_ar_norm(e.name) = hr_ar_norm(r->>'team') or hr_ar_norm(e.full_name) = hr_ar_norm(r->>'team') having count(*) = 1;
      end if;
      if scode is not null then insert into com_shares (deal_id, code, role, pct) select did, scode, 'sales', pct from com_roles where key = 'sales'; end if;
      if tcode is not null and tcode is distinct from scode then insert into com_shares (deal_id, code, role, pct) select did, tcode, 'lead', pct from com_roles where key = 'lead'; end if;
      scode := null; tcode := null;
    end if;
    -- money: only for a deal the import created, and only if it has no parts yet
    if ex.id is null and not exists (select 1 from com_parts where deal_id = did) then
      if coll > 0 then
        insert into com_parts (deal_id, amount, inv_type, wht, claim_date, sent_date, collected_date, ref, note)
        values (did, coll, typ, coalesce((r->>'wht')::boolean, true), nullif(r->>'claim', '')::date, nullif(r->>'sent', '')::date,
                coalesce(cod, nullif(r->>'sent', '')::date, cd, sd, current_date), null, 'من الدفتر القديم')
        returning id into pid;
        if p_history_paid then
          update com_entitlements set status = 'paid', note = 'من الدفتر القديم: اتعتبرت اتصرفت' where part_id = pid;
        else
          update com_entitlements set note = 'من الدفتر القديم' where part_id = pid;
        end if;
      end if;
      select commission into rem from com_deals where id = did;
      rem := rem - coll;
      if st = 'contract' and rem > 1 then
        insert into com_parts (deal_id, amount, inv_type, wht, claim_date, sent_date, note)
        values (did, rem, typ, coalesce((r->>'wht')::boolean, true), nullif(r->>'claim', '')::date, case when coll = 0 then nullif(r->>'sent', '')::date end, 'من الدفتر القديم: الباقي');
      end if;
    end if;
    ex := null;
  end loop;
  return jsonb_build_object('ok', true, 'applied', true, 'new', n_new, 'update', n_upd, 'errors', '[]'::jsonb, 'warnings', warns, 'plan', plan);
end $$;

revoke all on function hr_ar_norm(text), hr_com_import(jsonb, boolean, boolean) from public;
grant execute on function hr_ar_norm(text), hr_com_import(jsonb, boolean, boolean) to authenticated;

commit;
