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

/**
 * A visitor who lands anonymously and then opens the staff dialog solves two
 * separate challenges within seconds -- one automatic (the anonymous session),
 * one for their sign-in, each needing its own single-use token. That pattern
 * is rare enough that Turnstile occasionally refuses the second one outright
 * (error-callback fires with no challenge ever shown), even for a genuine
 * visitor on the correct domain. One silent retry, each attempt in a brand
 * new container, clears that in practice without bothering anyone with it.
 */
const MAX_ATTEMPTS = 2;

let scriptPromise = null;
/** The <div> currently holding a live (or just-finished) widget, if any. */
let mountEl = null;

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
 * Tears down whatever widget is currently mounted and gives the next attempt
 * a brand new, empty element to render into -- rather than remove() followed
 * by render() on the *same* container, which is the pattern that was in place
 * when the second-challenge-in-one-session failures were reported. remove()
 * is documented to clear its own DOM, but nothing rules out Cloudflare keeping
 * state keyed to the container element itself across that remove/render pair;
 * a fresh element sidesteps the question rather than depending on the answer.
 */
function remount(container) {
  if (mountEl) {
    try {
      window.turnstile.remove(mountEl);
    } catch {
      /* best-effort teardown of a widget we're discarding regardless */
    }
  }

  mountEl = document.createElement('div');
  container.replaceChildren(mountEl);
  return mountEl;
}

/** One render-and-wait cycle. Resolves with a token or rejects HUMAN_CHECK_FAILED. */
function runChallenge(el) {
  return new Promise((resolve, reject) => {
    let widgetId = window.turnstile.render(el, {
      sitekey: TURNSTILE_SITE_KEY,
      language: getLang() === 'ar' ? 'ar' : 'en',
      callback: resolve,
      'error-callback': () => reject(new Error('HUMAN_CHECK_FAILED')),
      'timeout-callback': () => reject(new Error('HUMAN_CHECK_FAILED')),
      'expired-callback': () => window.turnstile.reset(widgetId)
    });
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
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await runChallenge(remount(container));
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError;
  } finally {
    overlay?.classList.remove('open');
  }
}
