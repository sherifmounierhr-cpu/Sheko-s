-- ============================================================================
--  0004_anonymous_applicants.sql
--
--  Applicants now reach the form through a shared link and never create an
--  account. They get a Supabase *anonymous* session instead: a real row in
--  auth.users, carrying a normal `authenticated` JWT plus an `is_anonymous`
--  claim.
--
--  That choice keeps every existing policy working untouched -- an anonymous
--  applicant still owns exactly one application row, still cannot see anyone
--  else's, and still cannot see any HR review. The only thing standing in the
--  way was profiles.email, which anonymous users do not have.
--
--  Enabling anonymous sign-ins is a dashboard setting
--  (Authentication -> Sign In / Providers -> Anonymous sign-ins); this
--  migration only makes the schema able to receive them.
-- ============================================================================

-- An anonymous auth.users row has email = NULL, and handle_new_user() mirrors
-- that column straight across, so the NOT NULL constraint would abort the
-- sign-up trigger and surface as a 500 from /auth/v1/signup.
alter table public.profiles alter column email drop not null;

comment on column public.profiles.email is
  'NULL for anonymous applicants. Mirrored from auth.users by handle_new_user().';

-- The existing role logic is already NULL-safe by accident rather than by
-- design: lower(NULL) = '…' evaluates to NULL, so the CASE falls through to
-- 'applicant' and guard_profile_role()'s bootstrap check does not fire. Both
-- are restated here with explicit NULL handling so the intent is on the record
-- and a future edit cannot quietly break it.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform set_config('app.auth_sync', '1', true);

  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    nullif(new.raw_user_meta_data ->> 'full_name', ''),
    case
      when new.email is not null and lower(new.email) = public.bootstrap_admin_email()
        then 'admin'::public.app_role
      else 'applicant'::public.app_role
    end
  )
  on conflict (id) do update
    set email     = excluded.email,
        full_name = coalesce(excluded.full_name, profiles.full_name),
        role      = case
                      when excluded.email is not null
                       and lower(excluded.email) = public.bootstrap_admin_email()
                        then 'admin'::public.app_role
                      else profiles.role
                    end;

  perform set_config('app.auth_sync', '0', true);
  return new;
end
$$;

create or replace function public.guard_profile_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  syncing boolean := coalesce(current_setting('app.auth_sync', true), '0') = '1';
begin
  new.id := old.id;

  if not syncing then
    -- email is owned by auth.users; never accept a client-supplied value
    new.email := old.email;

    if new.role is distinct from old.role and not public.is_admin() then
      new.role := old.role;
    end if;
  end if;

  -- The bootstrap admin address always holds the admin role. Anonymous
  -- profiles have no email and can never match it.
  if new.email is not null and lower(new.email) = public.bootstrap_admin_email() then
    new.role := 'admin'::public.app_role;
  end if;

  new.updated_at := now();
  return new;
end
$$;

revoke all on function public.handle_new_user()    from public, anon, authenticated;
revoke all on function public.guard_profile_role() from public, anon, authenticated;
