/**
 * The two status readouts: the submit message under each submit bar, and the
 * small sync chip in the toolbar.
 *
 * Both remember their last message as an {ar, en} pair so a language toggle
 * re-renders them instead of leaving stale text in the other language.
 */

import { $, setText } from './dom.js';
import { getLang, onLangChange } from '../i18n.js';

const SUBMIT_STATUS_IDS = ['submitStatus', 'submitStatus2'];

let lastSubmit = null;
let lastSync = null;

function pick(pair) {
  return getLang() === 'ar' ? pair.ar : pair.en;
}

/**
 * @param {{ar: string, en: string}|null} message
 * @param {'ok'|'err'|'pending'|''} [tone]
 */
export function setSubmitStatus(message, tone = '') {
  lastSubmit = message ? { message, tone } : null;

  SUBMIT_STATUS_IDS.forEach((id) => {
    const el = $(id);
    if (!el) return;
    setText(el, message ? pick(message) : '');
    el.className = `submit-status ${tone}`.trim();
  });
}

/** @param {{ar: string, en: string}|null} message */
export function setSyncStatus(message, tone = '') {
  lastSync = message ? { message, tone } : null;

  const el = $('syncChip');
  if (!el) return;

  setText(el, message ? pick(message) : '');
  el.className = `sync-chip ${tone}`.trim();
  el.hidden = !message;
}

/** @param {{ar: string, en: string}|null} message */
export function setPanelStatus(id, message, tone = '') {
  const el = $(id);
  if (!el) return;

  setText(el, message ? pick(message) : '');
  el.className = `submit-status ${tone}`.trim();
}

/**
 * Turns a Supabase error into something a person can read. Auth errors come
 * back in English only, so the Arabic side is written here for the handful that
 * users actually hit.
 */
export function describeError(error) {
  const raw = (error?.message || String(error || '')).trim();

  const known = {
    'Invalid login credentials': {
      ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
      en: 'Invalid email or password'
    },
    'Email not confirmed': {
      ar: 'من فضلك أكّد بريدك الإلكتروني من الرسالة المُرسلة إليك أولًا',
      en: 'Please confirm your email from the message we sent you first'
    },
    'User already registered': {
      ar: 'هذا البريد مسجل بالفعل — سجّل الدخول بدلًا من إنشاء حساب',
      en: 'This email is already registered — sign in instead'
    },
    SUPABASE_NOT_CONFIGURED: {
      ar: 'لم يتم ضبط بيانات الاتصال بقاعدة البيانات. افتح "إعدادات الربط".',
      en: 'Database connection is not configured. Open "Sheet Settings".'
    }
  };

  if (known[raw]) return known[raw];

  if (/password/i.test(raw) && /least|short|6/i.test(raw)) {
    return {
      ar: 'كلمة المرور قصيرة جدًا — 6 أحرف على الأقل',
      en: 'Password is too short — use at least 6 characters'
    };
  }

  if (/row-level security|permission denied/i.test(raw)) {
    return {
      ar: 'لا تملك صلاحية تنفيذ هذا الإجراء',
      en: 'You do not have permission to do that'
    };
  }

  if (/fetch|network|Failed to/i.test(raw)) {
    return {
      ar: 'تعذر الاتصال بالخادم. تأكد من الإنترنت وحاول مرة أخرى.',
      en: 'Could not reach the server. Check your connection and try again.'
    };
  }

  return { ar: raw, en: raw };
}

// Re-render both readouts when the language flips.
onLangChange(() => {
  if (lastSubmit) setSubmitStatus(lastSubmit.message, lastSubmit.tone);
  if (lastSync) setSyncStatus(lastSync.message, lastSync.tone);
});
