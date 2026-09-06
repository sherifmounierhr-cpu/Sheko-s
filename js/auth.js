/**
 * Supabase Authentication.
 *
 * Roles are never decided here. The client only *reads* public.profiles.role;
 * the value is written by a database trigger, and every table is guarded by RLS
 * policies that call is_staff() / is_admin() server-side. A tampered client can
 * flip the UI into "admin" mode and still read nothing extra.
 */

import { getClient } from './supabaseClient.js';
import { BOOTSTRAP_ADMIN_EMAIL } from './config.js';

/** @type {{session: object|null, profile: object|null}} */
const state = {
  session: null,
  profile: null
};

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn({ ...state }));
}

/** @param {(s: {session: object|null, profile: object|null}) => void} fn */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSession() {
  return state.session;
}

export function getUser() {
  return state.session?.user ?? null;
}

export function getProfile() {
  return state.profile;
}

export function getRole() {
  return state.profile?.role ?? 'applicant';
}

export function isStaff() {
  return ['hr', 'admin'].includes(getRole());
}

export function isAdmin() {
  return getRole() === 'admin';
}

/**
 * True for an applicant who arrived through the shared link and never signed
 * up. Supabase marks these sessions with an is_anonymous claim; they still
 * carry the ordinary `authenticated` role, which is why every RLS policy keeps
 * working without a special case.
 */
export function isAnonymous() {
  return Boolean(state.session?.user?.is_anonymous);
}

/**
 * Opens a throwaway session so an applicant can fill and submit the form
 * without creating an account.
 *
 * @param {string|null} captchaToken from the Turnstile challenge, when enabled
 * @throws {Error} ANONYMOUS_SIGNIN_DISABLED when the project has anonymous
 *   sign-ins switched off, which is the default for a new project
 */
export async function signInAnonymously(captchaToken = null) {
  const options = captchaToken ? { captchaToken } : undefined;

  const { data, error } = await getClient().auth.signInAnonymously({ options });

  if (error) {
    if (/anonymous.*(disabled|not enabled)/i.test(error.message || '')) {
      throw new Error('ANONYMOUS_SIGNIN_DISABLED');
    }
    throw error;
  }

  return data;
}

export function isBootstrapAdminEmail(email) {
  return (email || '').trim().toLowerCase() === BOOTSTRAP_ADMIN_EMAIL;
}

/**
 * Reads the caller's own profile row.
 *
 * The row is created by the on_auth_user_created trigger. On a brand new
 * sign-up the SELECT can land microseconds before the trigger commits, so this
 * retries briefly, then falls back to inserting the row itself (which the
 * profiles_insert_self policy permits, with role defaulting to 'applicant').
 */
async function loadProfile(user) {
  if (!user) return null;

  const supabase = getClient();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, created_at')
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;
    if (data) return data;

    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      id: user.id,
      email: user.email,
      full_name: user.user_metadata?.full_name ?? null
    })
    .select('id, email, full_name, role, created_at')
    .single();

  if (error) throw error;
  return data;
}

async function adopt(session) {
  state.session = session ?? null;

  try {
    state.profile = session ? await loadProfile(session.user) : null;
  } catch (err) {
    console.error('[auth] could not load profile', err);
    state.profile = null;
  }

  emit();
}

/**
 * Restores any persisted session and starts listening for auth changes.
 * @returns {Promise<{session: object|null, profile: object|null}>}
 */
export async function initAuth() {
  const supabase = getClient();

  const { data } = await supabase.auth.getSession();
  await adopt(data.session);

  supabase.auth.onAuthStateChange((event, session) => {
    // TOKEN_REFRESHED fires on a timer and carries the same user; re-reading
    // the profile on every tick would be pointless traffic.
    if (event === 'TOKEN_REFRESHED' && state.session?.user?.id === session?.user?.id) {
      state.session = session;
      return;
    }
    adopt(session);
  });

  return { ...state };
}

/**
 * Turning on Supabase's "Enable CAPTCHA protection" applies to every auth
 * endpoint in the project -- signInWithPassword, signUp, signInWithOtp,
 * resetPasswordForEmail and signInAnonymously alike. Each of the functions
 * below therefore takes the same optional token and forwards it the same way;
 * omitting it is fine only while that project setting is off.
 */

export async function signInWithPassword(email, password, captchaToken = null) {
  const { data, error } = await getClient().auth.signInWithPassword({
    email: email.trim(),
    password,
    options: captchaToken ? { captchaToken } : undefined
  });
  if (error) throw error;
  return data;
}

export async function signUpWithPassword(email, password, fullName, captchaToken = null) {
  const { data, error } = await getClient().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { full_name: (fullName || '').trim() || null },
      emailRedirectTo: window.location.href.split('#')[0],
      ...(captchaToken ? { captchaToken } : null)
    }
  });
  if (error) throw error;
  return data;
}

export async function sendMagicLink(email, captchaToken = null) {
  const { error } = await getClient().auth.signInWithOtp({
    email: email.trim(),
    options: {
      emailRedirectTo: window.location.href.split('#')[0],
      ...(captchaToken ? { captchaToken } : null)
    }
  });
  if (error) throw error;
}

export async function sendPasswordReset(email, captchaToken = null) {
  const { error } = await getClient().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.href.split('#')[0],
    ...(captchaToken ? { captchaToken } : null)
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
}
