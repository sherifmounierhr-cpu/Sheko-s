/**
 * Realtime synchronisation.
 *
 * One channel carries changes to both tables. What actually arrives is decided
 * by RLS: an applicant's socket only ever receives their own application row
 * and never a review, because they hold no SELECT policy on
 * public.application_reviews.
 *
 * Changes this tab made are filtered out by last_client_id, so a local edit
 * never bounces back and overwrites what the user is still typing.
 */

import { getClient } from './supabaseClient.js';
import { CLIENT_ID } from './config.js';

let channel = null;

function isEcho(payload) {
  return payload?.new?.last_client_id === CLIENT_ID;
}

/**
 * @param {{
 *   onApplication?: (row: object, payload: object) => void,
 *   onApplicationDelete?: (row: object) => void,
 *   onReview?: (row: object, payload: object) => void,
 *   onStatus?: (status: string) => void
 * }} handlers
 */
export async function subscribe(handlers = {}) {
  await unsubscribe();

  const supabase = getClient();

  // Realtime authorises the socket with its own copy of the JWT; without this
  // an authenticated user would still be subscribed as `anon` and RLS would
  // (correctly) deliver nothing.
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) {
    supabase.realtime.setAuth(data.session.access_token);
  }

  channel = supabase
    .channel('everest-job-form')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'applications' },
      (payload) => {
        if (payload.eventType === 'DELETE') {
          handlers.onApplicationDelete?.(payload.old ?? {});
          return;
        }
        if (isEcho(payload)) return;
        handlers.onApplication?.(payload.new, payload);
      }
    )
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'application_reviews' },
      (payload) => {
        if (payload.eventType === 'DELETE') return;
        if (isEcho(payload)) return;
        handlers.onReview?.(payload.new, payload);
      }
    )
    .subscribe((status) => handlers.onStatus?.(status));

  return channel;
}

export async function unsubscribe() {
  if (!channel) return;

  try {
    await getClient().removeChannel(channel);
  } catch {
    /* the socket may already be gone; nothing useful to do */
  }

  channel = null;
}

export function isSubscribed() {
  return channel !== null;
}
