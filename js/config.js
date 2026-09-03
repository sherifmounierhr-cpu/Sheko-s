/**
 * Runtime configuration.
 *
 * The defaults below point at the project this app was provisioned against.
 * They are baked into the bundle on purpose: the publishable key is a public
 * credential, and every table it can reach is protected by Row Level Security.
 * Never put a service-role key here.
 *
 * The values can be overridden per browser from the "إعدادات الربط" dialog,
 * which is what lets the same static build point at a staging project without
 * a rebuild.
 */

const STORAGE_KEY = 'everest_supabase_config';

export const DEFAULT_CONFIG = Object.freeze({
  url: 'https://nhmbbulidexzczrwjmyx.supabase.co',
  anonKey: 'sb_publishable_-w_EpUVpf2q9Kv0JvyIVbQ_7uwd-2z9'
});

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
  (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function safeStorage() {
  try {
    // Throws in private-mode Safari and when site data is blocked.
    globalThis.localStorage.getItem(STORAGE_KEY);
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** @returns {{url: string, anonKey: string}} */
export function readConfig() {
  const store = safeStorage();
  if (!store) return { ...DEFAULT_CONFIG };

  try {
    const raw = store.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };

    const parsed = JSON.parse(raw);
    return {
      url: (parsed.url || DEFAULT_CONFIG.url).trim().replace(/\/+$/, ''),
      anonKey: (parsed.anonKey || DEFAULT_CONFIG.anonKey).trim()
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig({ url, anonKey }) {
  const store = safeStorage();
  if (!store) return false;

  const next = {
    url: (url || '').trim().replace(/\/+$/, ''),
    anonKey: (anonKey || '').trim()
  };

  if (!next.url || !next.anonKey) {
    store.removeItem(STORAGE_KEY);
    return true;
  }

  store.setItem(STORAGE_KEY, JSON.stringify(next));
  return true;
}

export function resetConfig() {
  safeStorage()?.removeItem(STORAGE_KEY);
}

export function isConfigured(config = readConfig()) {
  return Boolean(config.url && config.anonKey && /^https?:\/\//i.test(config.url));
}
