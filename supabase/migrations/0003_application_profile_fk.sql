-- ============================================================================
--  0003_application_profile_fk.sql
--
--  applications.user_id already references auth.users(id), but PostgREST can
--  only embed a related table when it can see a foreign key between the two.
--  auth.users is not in the exposed schema, so the HR list had no way to pull
--  the applicant's name and email alongside the application.
--
--  A second FK on the same column -- to public.profiles(id), which is itself
--  keyed to auth.users(id) -- gives PostgREST the relationship it needs without
--  changing the data model. The embed is still filtered by the profiles RLS
--  policy, so only staff can actually read the joined rows.
-- ============================================================================

do $$
begin
  alter table public.applications
    add constraint applications_user_id_profiles_fkey
    foreign key (user_id) references public.profiles (id) on delete cascade;
exception
  when duplicate_object then null;
end
$$;
