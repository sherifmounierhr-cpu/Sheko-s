-- ============================================================================
--  0002_harden_functions.sql
--
--  Addresses the Supabase database linter warnings raised by 0001:
--
--  * 0011 function_search_path_mutable
--        A function without a pinned search_path can be hijacked by a caller
--        who puts a same-named object earlier on their own search_path.
--
--  * 0028 / 0029 (anon|authenticated)_security_definer_function_executable
--        PostgREST exposes every function in the `public` schema as an RPC
--        endpoint. The trigger functions have no business being reachable that
--        way, and the role helpers should only be callable by signed-in users.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Pin search_path on the two functions that were missing it
-- ---------------------------------------------------------------------------
create or replace function public.bootstrap_admin_email()
returns text
language sql
immutable
set search_path = ''
as $$ select 'sherifmounierhr@gmail.com'::text $$;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Trigger functions are never called directly -- close the RPC surface
-- ---------------------------------------------------------------------------
revoke all on function public.handle_new_user()        from public, anon, authenticated;
revoke all on function public.guard_profile_role()     from public, anon, authenticated;
revoke all on function public.guard_application()      from public, anon, authenticated;
revoke all on function public.touch_updated_at()       from public, anon, authenticated;
revoke all on function public.bootstrap_admin_email()  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Role helpers: signed-in users only (the RLS policies call them as the
-- invoking role, so `authenticated` must keep EXECUTE)
-- ---------------------------------------------------------------------------
revoke all on function public.current_app_role() from public, anon;
revoke all on function public.is_staff()         from public, anon;
revoke all on function public.is_admin()         from public, anon;

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_staff()         to authenticated;
grant execute on function public.is_admin()         to authenticated;

-- ---------------------------------------------------------------------------
-- Nothing in this app is readable without signing in
-- ---------------------------------------------------------------------------
revoke all on table public.profiles            from anon;
revoke all on table public.applications        from anon;
revoke all on table public.application_reviews from anon;
