/**
 * The one and only Supabase client instance.
 *
 * Loaded straight from a CDN as an ES module, so the app stays a plain static
 * site: no npm install, no bundler, no build step.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { readConfig, isConfigured } from './config.js';

let client = null;

/**
 * @returns {import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm').SupabaseClient}
 * @throws {Error} when no project URL / key has been configured yet
 */
export function getClient() {
  if (client) return client;

  const config = readConfig();
  if (!isConfigured(config)) {
    throw new Error('SUPABASE_NOT_CONFIGURED');
  }

  client = createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Lets a magic-link / confirmation redirect land back on the form and
      // pick the session straight out of the URL fragment.
      detectSessionInUrl: true,
      storageKey: 'everest-job-form-auth'
    },
    realtime: {
      params: { eventsPerSecond: 5 }
    }
  });

  return client;
}

/**
 * Drops the cached instance so the next getClient() picks up new credentials.
 * Called after the settings dialog saves a different project.
 */
export async function resetClient() {
  if (client) {
    try {
      await client.removeAllChannels();
    } catch {
      /* channel teardown is best-effort */
    }
  }
  client = null;
}

export function hasClient() {
  return client !== null;
}
