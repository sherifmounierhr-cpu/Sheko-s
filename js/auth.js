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

export async function signInWithPassword(email, password) {
  const { data, error } = await getClient().auth.signInWithPassword({
    email: email.trim(),
    password
  });
  if (error) throw error;
  return data;
}

export async function signUpWithPassword(email, password, fullName) {
  const { data, error } = await getClient().auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: { full_name: (fullName || '').trim() || null },
      emailRedirectTo: window.location.href.split('#')[0]
    }
  });
  if (error) throw error;
  return data;
}

export async function sendMagicLink(email) {
  const { error } = await getClient().auth.signInWithOtp({
    email: email.trim(),
    options: { emailRedirectTo: window.location.href.split('#')[0] }
  });
  if (error) throw error;
}

export async function sendPasswordReset(email) {
  const { error } = await getClient().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: window.location.href.split('#')[0]
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await getClient().auth.signOut();
  if (error) throw error;
}
