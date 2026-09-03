/**
 * Email callback handling.
 *
 * When someone clicks a confirmation, magic-link or password-reset link,
 * Supabase sends them back here with parameters in the URL — in the hash for
 * the implicit flow (`#access_token=…&type=signup`), in the query string for
 * PKCE (`?code=…`) and for errors (`?error_description=…`).
 *
 * The client is configured with detectSessionInUrl, so it consumes and strips
 * those parameters as soon as it starts. This module therefore reads them at
 * import time — before getClient() is ever called — so the app can still tell
 * the user *why* they suddenly find themselves signed in.
 */

function params(source) {
  return new URLSearchParams(source.replace(/^[#?]/, ''));
}

const fromHash = params(window.location.hash);
const fromQuery = params(window.location.search);

function read(key) {
  return fromHash.get(key) ?? fromQuery.get(key);
}

/** Snapshot of the auth parameters this page was opened with. */
export const callback = Object.freeze({
  /** 'signup' | 'magiclink' | 'recovery' | 'invite' | 'email_change' | null */
  type: read('type'),
  error: read('error') ?? read('error_code'),
  errorDescription: read('error_description'),
  /** true when the URL carried credentials, whatever the flow */
  present: Boolean(read('access_token') || read('code') || read('type') || read('error')),
  isError: Boolean(read('error') || read('error_code') || read('error_description'))
});

const SUCCESS = {
  signup: {
    ar: 'تم تفعيل الحساب بنجاح',
    en: 'Account activated successfully'
  },
  invite: {
    ar: 'تم تفعيل الحساب بنجاح',
    en: 'Account activated successfully'
  },
  magiclink: {
    ar: 'تم تسجيل الدخول بنجاح',
    en: 'Signed in successfully'
  },
  email_change: {
    ar: 'تم تحديث البريد الإلكتروني بنجاح',
    en: 'Email address updated successfully'
  },
  recovery: {
    ar: 'تم تسجيل الدخول من رابط الاسترجاع',
    en: 'Signed in from your recovery link'
  }
};

/**
 * Supabase returns these in English only. The ones users actually hit get an
 * Arabic rendering; anything else falls through to the raw text.
 */
function describeCallbackError() {
  const raw = (callback.errorDescription || callback.error || '').replace(/\+/g, ' ');

  if (/expired|invalid/i.test(raw)) {
    return {
      ar: 'رابط التفعيل غير صالح أو انتهت صلاحيته. اطلب رابطًا جديدًا وسجّل الدخول مرة أخرى.',
      en: 'This link is invalid or has expired. Request a new one and sign in again.'
    };
  }

  if (/access_denied/i.test(raw)) {
    return {
      ar: 'تم رفض الوصول. جرّب فتح الرابط من نفس المتصفح الذي سجّلت منه.',
      en: 'Access denied. Try opening the link in the same browser you signed up from.'
    };
  }

  return { ar: raw, en: raw };
}

/**
 * @returns {{message: {ar: string, en: string}, tone: 'ok'|'err'}|null}
 */
export function callbackMessage() {
  if (!callback.present) return null;

  if (callback.isError) {
    return { message: describeCallbackError(), tone: 'err' };
  }

  const success = SUCCESS[callback.type];
  if (success) return { message: success, tone: 'ok' };

  return {
    message: { ar: 'تم تسجيل الدخول بنجاح', en: 'Signed in successfully' },
    tone: 'ok'
  };
}

/**
 * Strips the auth parameters from the address bar so a refresh does not replay
 * the message, and so the tokens do not sit in history.
 */
export function clearCallbackFromUrl() {
  if (!callback.present) return;

  window.history.replaceState({}, document.title, window.location.pathname);
}
