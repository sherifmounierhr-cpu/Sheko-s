-- Everest Eco System, part 9: punches straight from the fingerprint device.
--
-- Run in the Neon SQL Editor AFTER neon/008_org.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
-- The device (ZKTeco IN01-A) sits on the office network, so a small program on
-- an office PC (tools/device/sync.py) reads it every few minutes and sends the
-- new punches here. It logs in as `hr_device`, a login that can only hand over
-- punches and say "I'm alive"; it can't read anything. The admin registers the
-- device's serial number once from رفع البصمة.
--
-- After running this file, give hr_device a password once (see the end).

begin;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'hr_device') then
    create role hr_device nologin;
  end if;
end $$;

create table if not exists devices (
  serial     text primary key check (serial ~ '^[A-Za-z0-9_-]{3,40}$'),
  name       text not null default 'جهاز البصمة',
  added_at   timestamptz not null default now(),
  last_seen  timestamptz,
  last_punch timestamp,
  last_count int,
  last_error text,
  error_at   timestamptz
);

-- The office program sends rows of ["code", "YYYY-MM-DD HH:MM:SS"] in the
-- device's own (Cairo) time. Duplicates are skipped. Returns how many were new.
create or replace function hr_device_punches(p_serial text, p_rows jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int := 0; latest timestamp;
begin
  if not exists (select 1 from devices where serial = p_serial) then raise exception 'unknown device'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'bad rows'; end if;
  with src as (
    select btrim(r->>0) as code, (r->>1)::timestamp as ts
    from jsonb_array_elements(p_rows) r
    where jsonb_typeof(r) = 'array' and coalesce(btrim(r->>0), '') ~ '^[0-9A-Za-z]{1,20}$'),
  ins as (
    insert into punches (code, ts, uploaded_by)
    select code, date_trunc('minute', ts), 'device:' || p_serial from src
    where ts between timestamp '2020-01-01' and (now() at time zone 'Africa/Cairo') + interval '1 day'
    on conflict (code, ts) do nothing
    returning ts)
  select count(*), max(ts) into n, latest from ins;
  update devices set last_seen = now(), last_count = n, last_error = null,
    last_punch = greatest(last_punch, latest) where serial = p_serial;
  return n;
end $$;

-- A heartbeat, or the last problem the office program ran into.
create or replace function hr_device_ping(p_serial text, p_error text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_error is null then
    update devices set last_seen = now(), last_error = null where serial = p_serial;
  else
    update devices set last_error = left(p_error, 300), error_at = now() where serial = p_serial;
  end if;
end $$;

-- For رفع البصمة: each device and how it's doing (admin and uploaders).
create or replace function hr_device_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select case when hr_has('admin') or hr_has('uploader') then coalesce(jsonb_agg(jsonb_build_object(
    'serial', d.serial, 'name', d.name, 'last_seen', d.last_seen, 'last_punch', d.last_punch,
    'last_count', d.last_count, 'last_error', d.last_error, 'error_at', d.error_at,
    'today', (select count(*) from punches p where p.uploaded_by = 'device:' || d.serial
              and p.ts::date = (now() at time zone 'Africa/Cairo')::date)) order by d.added_at), '[]') end
  from devices d
$$;

create or replace function hr_device_add(p_serial text, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  insert into devices (serial, name) values (btrim(p_serial), coalesce(nullif(btrim(p_name), ''), 'جهاز البصمة'))
  on conflict (serial) do update set name = excluded.name;
end $$;

create or replace function hr_device_remove(p_serial text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  delete from devices where serial = p_serial;
end $$;

alter table devices enable row level security;
drop policy if exists dev_read on devices;
create policy dev_read on devices for select to authenticated using (hr_has('admin') or hr_has('uploader'));

drop trigger if exists audit on devices;
create trigger audit after insert or update of serial, name or delete on devices for each row execute function hr_audit();

revoke all on devices from hr_device;
grant select on devices to authenticated;
revoke all on function hr_device_punches(text, jsonb), hr_device_ping(text, text), hr_device_status(), hr_device_add(text, text), hr_device_remove(text) from public;
grant execute on function hr_device_punches(text, jsonb), hr_device_ping(text, text) to hr_device;
grant execute on function hr_device_status(), hr_device_add(text, text), hr_device_remove(text) to authenticated;
grant usage on schema public to hr_device;

commit;

-- Then, once, give the device login a password (your own long one, letters and
-- digits only; keep it out of chats). It goes only into config.ini on the
-- office PC, inside the connection string:
--   alter role hr_device login password 'a-long-random-password';
