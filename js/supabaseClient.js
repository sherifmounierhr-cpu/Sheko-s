/**
 * The one and only Supabase client instance.
 *
 * Loaded straight from a CDN as an ES module, so the app stays a plain static
 * site: no npm install, no bundler, no build step.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from './config.js';

let client = null;

/**
 * @returns {import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm').SupabaseClient}
 * @throws {Error} when config.js still holds placeholder credentials
 */
export function getClient() {
  if (client) return client;

  if (!isConfigured()) {
    throw new Error('SUPABASE_NOT_CONFIGURED');
  }

  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
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

export function hasClient() {
  return client !== null;
}
