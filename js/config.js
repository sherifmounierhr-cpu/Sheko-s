/**
 * Runtime configuration.
 *
 * These values are baked into the bundle on purpose: the publishable key is a
 * public credential, and every table it can reach is protected by Row Level
 * Security. Never put a service-role key here.
 *
 * To point the form at a different project (staging, a fork), edit this file
 * and redeploy. There is deliberately no in-app settings dialog -- applicants
 * have no business repointing the form, and an editable connection panel in
 * the toolbar was only ever a source of confusion.
 */

export const SUPABASE_URL = 'https://nhmbbulidexzczrwjmyx.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_-w_EpUVpf2q9Kv0JvyIVbQ_7uwd-2z9';

/** Email that the database grants the `admin` role to on sign-up. */
export const BOOTSTRAP_ADMIN_EMAIL = 'sherifmounierhr@gmail.com';

/** Debounce window for autosaving the form to Postgres, in milliseconds. */
export const AUTOSAVE_DELAY_MS = 1200;

/**
 * Identifies this browser tab for the lifetime of the page. Written alongside
 * every row change so that the realtime subscription can recognise -- and skip
 * -- the echo of a change this tab just made.
 */
export const CLIENT_ID =
  globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Guards against a build that was published with the placeholders still in. */
export function isConfigured() {
  return /^https:\/\/.+\.supabase\.co$/i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;
}
