-- Everest Eco System, part 21: punching from the phone.
--
-- Run in the Neon SQL Editor AFTER neon/020_com_vat.sql. Safe to re-run.
-- It adds tables and columns and changes no existing data. Then: notify pgrst, 'reload schema';
--
--   * An employee the admin allows registers their phone once (a passkey: the
--     phone's own Face ID / fingerprint / screen lock). The admin approves the phone.
--   * A punch needs, all checked here in the database:
--       - a fresh challenge signed by that phone, with its "user verified" flag set
--         (the phone really asked for the face or the finger),
--       - a location inside the office radius, accurate to 100 m or better,
--       - a selfie (a small JPEG), kept 90 days for a person to look at.
--     It then lands in punches like a device punch, marked source = 'mobile'.
--   * No face template is stored: the phone checks the face, we check its signature.
--   * The signature is ES256 (P-256). Postgres has no built-in for it, so the check
--     is written here in plain numeric maths rather than adding a server.

begin;

-- ---------------------------------------------------------------- ES256 (P-256) signature check

create or replace function hr_b2n(b bytea) returns numeric
language plpgsql immutable set search_path = public, pg_temp as $$
declare n numeric := 0;
begin
  for i in 0 .. length(b) - 1 loop n := n * 256 + get_byte(b, i); end loop;
  return n;
end $$;

create or replace function hr_modinv(a numeric, m numeric) returns numeric
language plpgsql immutable set search_path = public, pg_temp as $$
declare r0 numeric := m; r1 numeric := mod(a, m); t0 numeric := 0; t1 numeric := 1; q numeric; x numeric;
begin
  while r1 <> 0 loop
    q := div(r0, r1);
    x := r0 - q * r1; r0 := r1; r1 := x;
    x := t0 - q * t1; t0 := t1; t1 := x;
  end loop;
  if r0 <> 1 then return null; end if;
  return mod(t0 + m, m);
end $$;

-- points are Jacobian {x, y, z}; z = 0 is the point at infinity
create or replace function hr_p256_dbl(x1 numeric, y1 numeric, z1 numeric, p numeric) returns numeric[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare delta numeric; gamma numeric; beta numeric; alpha numeric; x3 numeric;
begin
  if z1 = 0 or y1 = 0 then return array[1, 1, 0]::numeric[]; end if;
  delta := mod(z1 * z1, p); gamma := mod(y1 * y1, p); beta := mod(x1 * gamma, p);
  alpha := mod(3 * mod(x1 - delta + p, p) * mod(x1 + delta, p), p);
  x3 := mod(alpha * alpha + 8 * (p - beta), p);
  return array[x3,
    mod(alpha * mod(4 * beta + p - x3, p) + 8 * (p - mod(gamma * gamma, p)), p),
    mod((y1 + z1) * (y1 + z1) + (p - gamma) + (p - delta), p)];
end $$;

create or replace function hr_p256_add(x1 numeric, y1 numeric, z1 numeric, x2 numeric, y2 numeric, z2 numeric, p numeric) returns numeric[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare z1z1 numeric; z2z2 numeric; u1 numeric; u2 numeric; s1 numeric; s2 numeric; h numeric; r numeric; hh numeric; hhh numeric; v numeric; x3 numeric;
begin
  if z1 = 0 then return array[x2, y2, z2]; end if;
  if z2 = 0 then return array[x1, y1, z1]; end if;
  z1z1 := mod(z1 * z1, p); z2z2 := mod(z2 * z2, p);
  u1 := mod(x1 * z2z2, p); u2 := mod(x2 * z1z1, p);
  s1 := mod(y1 * z2 * z2z2, p); s2 := mod(y2 * z1 * z1z1, p);
  h := mod(u2 - u1 + p, p); r := mod(s2 - s1 + p, p);
  if h = 0 then
    if r = 0 then return hr_p256_dbl(x1, y1, z1, p); end if;
    return array[1, 1, 0]::numeric[];
  end if;
  hh := mod(h * h, p); hhh := mod(h * hh, p); v := mod(u1 * hh, p);
  x3 := mod(r * r + (p - hhh) + 2 * (p - v), p);
  return array[x3, mod(r * mod(v + p - x3, p) + (p - mod(s1 * hhh, p)), p), mod(h * z1 * z2, p)];
end $$;

-- is (x, y) a point on the curve, and so a usable public key
create or replace function hr_p256_on_curve(qx bytea, qy bytea) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare p numeric := hr_b2n('\xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  b numeric := hr_b2n('\x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b');
  x numeric; y numeric;
begin
  if qx is null or qy is null or length(qx) <> 32 or length(qy) <> 32 then return false; end if;
  x := hr_b2n(qx); y := hr_b2n(qy);
  if x >= p or y >= p or (x = 0 and y = 0) then return false; end if;
  return mod(y * y, p) = mod(mod(x * x, p) * x + 3 * (p - x) + b, p);
end $$;

-- ECDSA over P-256: sig is r || s (64 bytes), hash is the SHA-256 of the signed message
create or replace function hr_p256_verify(qx bytea, qy bytea, sig bytea, hash bytea) returns boolean
language plpgsql immutable set search_path = public, pg_temp as $$
declare p numeric := hr_b2n('\xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
  n numeric := hr_b2n('\xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
  gx numeric := hr_b2n('\x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296');
  gy numeric := hr_b2n('\x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5');
  x numeric; y numeric; r numeric; s numeric; z numeric; w numeric; u1 numeric; u2 numeric;
  gq numeric[]; acc numeric[] := array[1, 1, 0]::numeric[]; b1 boolean[]; b2 boolean[]; zi numeric;
begin
  if sig is null or hash is null or length(sig) <> 64 or length(hash) <> 32 or not hr_p256_on_curve(qx, qy) then return false; end if;
  x := hr_b2n(qx); y := hr_b2n(qy);
  r := hr_b2n(substring(sig from 1 for 32)); s := hr_b2n(substring(sig from 33 for 32)); z := hr_b2n(hash);
  if r < 1 or r >= n or s < 1 or s >= n then return false; end if;
  w := hr_modinv(s, n);
  u1 := mod(z * w, n); u2 := mod(r * w, n);
  for i in 0 .. 255 loop
    b1[i] := mod(u1, 2) = 1; u1 := div(u1, 2);
    b2[i] := mod(u2, 2) = 1; u2 := div(u2, 2);
  end loop;
  gq := hr_p256_add(gx, gy, 1, x, y, 1, p);
  for i in reverse 255 .. 0 loop
    acc := hr_p256_dbl(acc[1], acc[2], acc[3], p);
    if b1[i] and b2[i] then acc := hr_p256_add(acc[1], acc[2], acc[3], gq[1], gq[2], gq[3], p);
    elsif b1[i] then acc := hr_p256_add(acc[1], acc[2], acc[3], gx, gy, 1, p);
    elsif b2[i] then acc := hr_p256_add(acc[1], acc[2], acc[3], x, y, 1, p);
    end if;
  end loop;
  if acc[3] = 0 then return false; end if;
  zi := hr_modinv(acc[3], p);
  return mod(mod(acc[1] * mod(zi * zi, p), p), n) = r;
end $$;

-- ---------------------------------------------------------------- tables

alter table employees add column if not exists mobile_punch boolean not null default false;
alter table employees add column if not exists selfie_consent_at timestamptz;
alter table punches add column if not exists source text not null default 'device';

-- where the portal lives: a passkey is tied to this address
create table if not exists punch_config (
  id      int primary key default 1 check (id = 1),
  rp_id   text not null default 'sherifmounierhr-cpu.github.io',
  origins text[] not null default '{https://sherifmounierhr-cpu.github.io}'
);
insert into punch_config (id) values (1) on conflict do nothing;

create table if not exists punch_devices (
  id          bigserial primary key,
  code        text not null references employees(code) on update cascade on delete cascade,
  cred        text not null unique check (length(cred) between 8 and 700),
  qx          bytea not null,
  qy          bytea not null,
  label       text check (length(label) <= 60),
  status      text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at  timestamptz not null default now(),
  decided_by  text,
  decided_at  timestamptz,
  last_used   timestamptz
);
create unique index if not exists punch_devices_one_active on punch_devices (code) where status = 'active';

create table if not exists punch_challenges (
  challenge  bytea primary key,
  code       text not null,
  created_at timestamptz not null default now()
);

create table if not exists mobile_punches (
  id        bigserial primary key,
  code      text not null references employees(code) on update cascade on delete cascade,
  ts        timestamptz not null default now(),
  lat       double precision not null,
  lng       double precision not null,
  accuracy  real,
  distance  int not null,
  device_id bigint references punch_devices(id) on delete set null,
  photo     bytea
);
create index if not exists mobile_punches_code_ts on mobile_punches (code, ts);

-- only through the functions below
do $$ declare t text; begin
  foreach t in array array['punch_config', 'punch_devices', 'punch_challenges', 'mobile_punches'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    execute format('revoke all on %I from authenticated', t);
    if exists (select 1 from pg_roles where rolname = 'anonymous') then execute format('revoke all on %I from anonymous', t); end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- the employee's side

-- what the phone needs to draw the button: allowed? consent? which phone?
create or replace function hr_punch_state() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c text := hr_my_code(); e employees;
begin
  if c is null then return null; end if;
  select * into e from employees where code = c;
  return jsonb_build_object(
    'allowed', coalesce(e.mobile_punch, false) and coalesce(e.active, true),
    'consent', e.selfie_consent_at is not null,
    'device', (select jsonb_build_object('id', d.id, 'status', d.status, 'label', d.label, 'cred', d.cred)
                 from punch_devices d where d.code = c and d.status in ('active', 'pending') order by (d.status = 'active') desc, d.id desc limit 1),
    'rp_id', (select rp_id from punch_config where id = 1),
    'today', coalesce((select jsonb_agg(jsonb_build_object('ts', m.ts, 'distance', m.distance) order by m.ts)
                         from mobile_punches m where m.code = c and (m.ts at time zone 'Africa/Cairo')::date = (now() at time zone 'Africa/Cairo')::date), '[]'));
end $$;

-- the employee accepts the selfie notice
create or replace function hr_punch_consent() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := hr_my_code();
begin
  if c is null then raise exception 'not allowed'; end if;
  update employees set selfie_consent_at = now() where code = c and selfie_consent_at is null;
end $$;

-- the phone registers its passkey; the admin approves it before it can punch
create or replace function hr_punch_register(p_cred text, p_x text, p_y text, p_label text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := hr_my_code(); e employees; x bytea; y bytea; did bigint;
begin
  if c is null then raise exception 'not allowed'; end if;
  select * into e from employees where code = c;
  if not (coalesce(e.mobile_punch, false) and coalesce(e.active, true)) then raise exception 'punch not allowed'; end if;
  if e.selfie_consent_at is null then raise exception 'no consent'; end if;
  x := decode(p_x, 'base64'); y := decode(p_y, 'base64');
  if not hr_p256_on_curve(x, y) then raise exception 'bad key'; end if;
  delete from punch_devices where code = c and status = 'pending';
  insert into punch_devices (code, cred, qx, qy, label) values (c, p_cred, x, y, nullif(left(coalesce(p_label, ''), 60), '')) returning id into did;
  perform hr_notify_admins('punch', 'موبايل جديد مستني موافقتك: ' || coalesce(nullif(e.name, ''), c), null, 'punch_devices', did);
  return did;
end $$;

create or replace function hr_punch_challenge() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := hr_my_code(); d punch_devices; ch bytea;
begin
  if c is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = c and mobile_punch and coalesce(active, true)) then raise exception 'punch not allowed'; end if;
  select * into d from punch_devices where code = c and status = 'active';
  if d.id is null then raise exception 'no device'; end if;
  delete from punch_challenges where created_at < now() - interval '10 minutes' or code = c;
  ch := sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text || clock_timestamp()::text, 'UTF8'));
  insert into punch_challenges (challenge, code) values (ch, c);
  return jsonb_build_object('challenge', encode(ch, 'base64'), 'cred', d.cred, 'rp_id', (select rp_id from punch_config where id = 1));
end $$;

-- meters between two points
create or replace function hr_meters(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision) returns int
language sql immutable set search_path = public, pg_temp as $$
  select round(2 * 6371000 * asin(least(1, sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))))::int
$$;

-- The punch. p_auth, p_client and p_photo are base64; p_sig is base64 of r || s.
create or replace function hr_punch_mobile(p_auth text, p_client text, p_sig text, p_lat double precision, p_lng double precision, p_accuracy real, p_photo text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare c text := hr_my_code(); d punch_devices; cfg punch_config; ad bytea; cd bytea; cj jsonb; ch bytea; v_photo bytea;
  o jsonb; dist int; radius int; ts0 timestamptz := now(); n int;
begin
  if c is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = c and mobile_punch and coalesce(active, true)) then raise exception 'punch not allowed'; end if;
  select * into d from punch_devices where code = c and status = 'active';
  if d.id is null then raise exception 'no device'; end if;
  select * into cfg from punch_config where id = 1;
  begin
    ad := decode(p_auth, 'base64'); cd := decode(p_client, 'base64'); cj := convert_from(cd, 'UTF8')::jsonb;
    ch := decode(rpad(translate(cj->>'challenge', '-_', '+/'), 4 * ceil(length(cj->>'challenge') / 4.0)::int, '='), 'base64');
  exception when others then raise exception 'bad signature';
  end;
  -- the challenge is ours, this employee's, fresh, and used once
  delete from punch_challenges where challenge = ch and code = c and created_at > now() - interval '2 minutes';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'bad challenge'; end if;
  if cj->>'type' <> 'webauthn.get' or not (cj->>'origin' = any(cfg.origins)) then raise exception 'bad origin'; end if;
  if length(ad) < 37 or substring(ad from 1 for 32) <> sha256(convert_to(cfg.rp_id, 'UTF8')) then raise exception 'bad origin'; end if;
  -- flags: 0x01 the person was there, 0x04 the phone verified them (face, finger or screen lock)
  if get_byte(ad, 32) & 5 <> 5 then raise exception 'not verified'; end if;
  if not hr_p256_verify(d.qx, d.qy, decode(p_sig, 'base64'), sha256(ad || sha256(cd))) then raise exception 'bad signature'; end if;
  -- where
  select data->'office' into o from settings where id = 1;
  if o is null or (o->>'lat') is null or (o->>'lng') is null then raise exception 'no office'; end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'no location'; end if;
  if p_accuracy is null or p_accuracy > 100 then raise exception 'poor accuracy'; end if;
  radius := greatest(20, coalesce((o->>'radius')::numeric, 150))::int;
  dist := hr_meters((o->>'lat')::double precision, (o->>'lng')::double precision, p_lat, p_lng);
  if dist > radius then raise exception 'outside office %', dist; end if;
  -- the selfie
  begin v_photo := decode(p_photo, 'base64'); exception when others then raise exception 'bad photo'; end;
  if v_photo is null or length(v_photo) < 500 or length(v_photo) > 61440 or substring(v_photo from 1 for 3) <> '\xffd8ff' then raise exception 'bad photo'; end if;
  if exists (select 1 from mobile_punches where code = c and ts > ts0 - interval '2 minutes') then raise exception 'too soon'; end if;
  insert into punches (code, ts, source) values (c, date_trunc('second', ts0 at time zone 'Africa/Cairo'), 'mobile') on conflict (code, ts) do nothing;
  insert into mobile_punches (code, ts, lat, lng, accuracy, distance, device_id, photo) values (c, ts0, p_lat, p_lng, p_accuracy, dist, d.id, v_photo);
  update punch_devices set last_used = ts0 where id = d.id;
  -- selfies are kept 90 days
  update mobile_punches set photo = null where photo is not null and ts < ts0 - interval '90 days';
  return jsonb_build_object('ts', ts0, 'distance', dist);
end $$;

-- ---------------------------------------------------------------- the admin's and managers' side

create or replace function hr_punch_devices() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'code', d.code, 'name', coalesce(nullif(e.name, ''), d.code), 'label', d.label,
      'status', d.status, 'created', d.created_at, 'last_used', d.last_used) order by (d.status = 'pending') desc, d.created_at desc)
    from punch_devices d join employees e on e.code = d.code where d.status in ('pending', 'active')), '[]');
end $$;

-- approve a phone (the employee's older one stops working) or switch one off
create or replace function hr_punch_device_set(p_id bigint, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare d punch_devices;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if p_status not in ('active', 'revoked') then raise exception 'bad status'; end if;
  select * into d from punch_devices where id = p_id;
  if d.id is null then raise exception 'no device'; end if;
  if p_status = 'active' then
    update punch_devices set status = 'revoked', decided_by = auth.user_id(), decided_at = now() where code = d.code and status = 'active' and id <> p_id;
  end if;
  update punch_devices set status = p_status, decided_by = auth.user_id(), decided_at = now() where id = p_id;
  perform hr_notify(d.code, null, 'punch', case when p_status = 'active' then 'موبايلك اتوافق عليه. تقدر تبصم منه دلوقتي' else 'بصمة الموبايل اتوقفت على موبايلك. كلم الإدارة' end, null, 'punch_devices', p_id);
end $$;

-- a month's mobile punches, without the photos: the admin, the managers above, and the person
create or replace function hr_punch_list(p_month text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_month !~ '^\d{4}-\d{2}$' then raise exception 'bad month'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'ts', m.ts, 'distance', m.distance, 'accuracy', m.accuracy, 'photo', m.photo is not null) order by m.ts)
    from mobile_punches m
    where to_char(m.ts at time zone 'Africa/Cairo', 'YYYY-MM') = p_month and (hr_has('admin') or hr_manages(m.code) or m.code = hr_my_code())), '[]');
end $$;

create or replace function hr_punch_photo(p_id bigint) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m mobile_punches;
begin
  select * into m from mobile_punches where id = p_id;
  if m.id is null or not (hr_has('admin') or hr_manages(m.code) or m.code = hr_my_code()) then raise exception 'not allowed'; end if;
  return encode(m.photo, 'base64');
end $$;

drop trigger if exists audit on punch_devices;
create trigger audit after insert or update or delete on punch_devices for each row execute function hr_audit();

revoke all on function hr_b2n(bytea), hr_modinv(numeric, numeric), hr_p256_dbl(numeric, numeric, numeric, numeric),
  hr_p256_add(numeric, numeric, numeric, numeric, numeric, numeric, numeric), hr_p256_on_curve(bytea, bytea), hr_p256_verify(bytea, bytea, bytea, bytea),
  hr_meters(double precision, double precision, double precision, double precision),
  hr_punch_state(), hr_punch_consent(), hr_punch_register(text, text, text, text), hr_punch_challenge(),
  hr_punch_mobile(text, text, text, double precision, double precision, real, text),
  hr_punch_devices(), hr_punch_device_set(bigint, text), hr_punch_list(text), hr_punch_photo(bigint) from public;
grant execute on function hr_punch_state(), hr_punch_consent(), hr_punch_register(text, text, text, text), hr_punch_challenge(),
  hr_punch_mobile(text, text, text, double precision, double precision, real, text),
  hr_punch_devices(), hr_punch_device_set(bigint, text), hr_punch_list(text), hr_punch_photo(bigint) to authenticated;

commit;

notify pgrst, 'reload schema';
