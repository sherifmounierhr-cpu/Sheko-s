/**
 * "Are you human?" check in front of anonymous applications.
 *
 * Uses Cloudflare Turnstile, which is free, needs no account from the visitor,
 * and unlike a homegrown puzzle is actually verified server-side: the token
 * produced here is handed to Supabase Auth, which calls Cloudflare to confirm
 * it before issuing a session. A check that only ran in the browser would stop
 * nobody, so this deliberately has no client-only fallback.
 *
 * With no site key configured the check is skipped entirely and the form works
 * as before -- see TURNSTILE_SITE_KEY in config.js for why both halves must be
 * switched on together.
 */

import { TURNSTILE_SITE_KEY } from './config.js';
import { getLang } from './i18n.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;
let widgetId = null;

export function isHumanCheckEnabled() {
  return Boolean(TURNSTILE_SITE_KEY);
}

function loadScript() {
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('HUMAN_CHECK_UNAVAILABLE'));
    document.head.appendChild(script);
  });

  return scriptPromise;
}

/** Turnstile only exposes itself once its own bootstrap has run. */
function whenReady() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;

    (function poll() {
      if (window.turnstile?.render) return resolve();
      if (Date.now() > deadline) return reject(new Error('HUMAN_CHECK_UNAVAILABLE'));
      setTimeout(poll, 100);
    })();
  });
}

/**
 * Shows the challenge and resolves with a token to pass to Supabase Auth.
 *
 * @returns {Promise<string|null>} null when the check is switched off
 * @throws {Error} HUMAN_CHECK_UNAVAILABLE | HUMAN_CHECK_FAILED
 */
export async function getHumanToken() {
  if (!isHumanCheckEnabled()) return null;

  await loadScript();
  await whenReady();

  const overlay = document.getElementById('humanOverlay');
  const container = document.getElementById('humanWidget');
  if (!container) throw new Error('HUMAN_CHECK_UNAVAILABLE');

  overlay?.classList.add('open');

  try {
    return await new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        overlay?.classList.remove('open');
        fn(value);
      };

      // A second attempt has to reuse the widget rather than stack another one.
      if (widgetId !== null) {
        window.turnstile.reset(widgetId);
      }

      widgetId = window.turnstile.render(container, {
        sitekey: TURNSTILE_SITE_KEY,
        language: getLang() === 'ar' ? 'ar' : 'en',
        callback: (token) => finish(resolve, token),
        'error-callback': () => finish(reject, new Error('HUMAN_CHECK_FAILED')),
        'timeout-callback': () => finish(reject, new Error('HUMAN_CHECK_FAILED')),
        'expired-callback': () => window.turnstile.reset(widgetId)
      });
    });
  } catch (err) {
    overlay?.classList.remove('open');
    throw err;
  }
}
