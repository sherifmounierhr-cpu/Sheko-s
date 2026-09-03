/**
 * The sign-in / sign-up dialog.
 *
 * Reuses the page's existing .modal-overlay / .modal-box / .tbtn styling so it
 * reads as part of the form rather than as a bolted-on login screen.
 */

import { $, $$, openModal, closeModal } from './dom.js';
import { setPanelStatus, describeError } from './status.js';
import { getLang, onLangChange } from '../i18n.js';
import {
  signInWithPassword,
  signUpWithPassword,
  sendMagicLink,
  sendPasswordReset,
  isBootstrapAdminEmail
} from '../auth.js';

/** @type {'signin'|'signup'} */
let mode = 'signin';
let busy = false;

const COPY = {
  signin: {
    title: { ar: 'تسجيل الدخول', en: 'Sign In' },
    action: { ar: 'دخول', en: 'Sign In' },
    hint: {
      ar: 'سجّل الدخول لحفظ طلبك ومتابعته. بياناتك محفوظة باسمك ولا يراها متقدم آخر.',
      en: 'Sign in to save and track your application. Your data is stored under your account and no other applicant can see it.'
    }
  },
  signup: {
    title: { ar: 'إنشاء حساب جديد', en: 'Create an Account' },
    action: { ar: 'إنشاء الحساب', en: 'Create Account' },
    hint: {
      ar: 'أنشئ حسابًا بالبريد الإلكتروني. قد تحتاج لتأكيد بريدك من رسالة تصلك.',
      en: 'Create an account with your email. You may need to confirm it from a message we send you.'
    }
  }
};

function pick(pair) {
  return getLang() === 'ar' ? pair.ar : pair.en;
}

/** Sets both language variants and the visible text in one go. */
function setBilingual(el, pair) {
  if (!el) return;
  el.setAttribute('data-ar', pair.ar);
  el.setAttribute('data-en', pair.en);
  el.textContent = pick(pair);
}

function renderMode() {
  const copy = COPY[mode];

  setBilingual($('authTitle'), copy.title);
  setBilingual($('authHint'), copy.hint);
  setBilingual($('authSubmit'), copy.action);

  $$('.auth-tab').forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.authMode === mode);
    tab.setAttribute('aria-selected', String(tab.dataset.authMode === mode));
  });

  $$('[data-auth-signup-only]').forEach((el) => {
    el.hidden = mode !== 'signup';
  });

  const password = $('authPassword');
  if (password) {
    password.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  }
}

function setBusy(next) {
  busy = next;
  ['authSubmit', 'authMagicLink', 'authForgot'].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = next;
  });
}

function readForm() {
  return {
    email: $('authEmail')?.value.trim() ?? '',
    password: $('authPassword')?.value ?? '',
    fullName: $('authFullName')?.value.trim() ?? ''
  };
}

function requireEmail(email) {
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return true;

  setPanelStatus(
    'authStatus',
    { ar: 'من فضلك أدخل بريدًا إلكترونيًا صحيحًا', en: 'Please enter a valid email address' },
    'err'
  );
  return false;
}

async function handleSubmit() {
  if (busy) return;

  const { email, password, fullName } = readForm();
  if (!requireEmail(email)) return;

  if (password.length < 6) {
    setPanelStatus(
      'authStatus',
      { ar: 'كلمة المرور 6 أحرف على الأقل', en: 'Password must be at least 6 characters' },
      'err'
    );
    return;
  }

  setBusy(true);
  setPanelStatus(
    'authStatus',
    mode === 'signup'
      ? { ar: 'جاري إنشاء الحساب...', en: 'Creating your account...' }
      : { ar: 'جاري تسجيل الدخول...', en: 'Signing you in...' },
    'pending'
  );

  try {
    if (mode === 'signup') {
      const result = await signUpWithPassword(email, password, fullName);

      // With email confirmation on, signUp returns a user but no session.
      if (!result.session) {
        setPanelStatus(
          'authStatus',
          {
            ar: 'تم إنشاء الحساب. افتح بريدك واضغط رابط التأكيد ثم عُد لتسجيل الدخول.',
            en: 'Account created. Open your email, click the confirmation link, then sign in.'
          },
          'ok'
        );
        setBusy(false);
        return;
      }
    } else {
      await signInWithPassword(email, password);
    }

    // The auth listener in main.js closes the dialog once the session lands.
    setPanelStatus(
      'authStatus',
      isBootstrapAdminEmail(email)
        ? { ar: 'تم الدخول كمدير للنظام', en: 'Signed in as administrator' }
        : { ar: 'تم تسجيل الدخول', en: 'Signed in' },
      'ok'
    );
  } catch (err) {
    setPanelStatus('authStatus', describeError(err), 'err');
  } finally {
    setBusy(false);
  }
}

async function handleMagicLink() {
  if (busy) return;

  const { email } = readForm();
  if (!requireEmail(email)) return;

  setBusy(true);
  setPanelStatus('authStatus', { ar: 'جاري الإرسال...', en: 'Sending...' }, 'pending');

  try {
    await sendMagicLink(email);
    setPanelStatus(
      'authStatus',
      {
        ar: 'أرسلنا رابط دخول إلى بريدك. افتحه من نفس المتصفح.',
        en: 'We emailed you a sign-in link. Open it in this browser.'
      },
      'ok'
    );
  } catch (err) {
    setPanelStatus('authStatus', describeError(err), 'err');
  } finally {
    setBusy(false);
  }
}

async function handleForgot() {
  if (busy) return;

  const { email } = readForm();
  if (!requireEmail(email)) return;

  setBusy(true);
  setPanelStatus('authStatus', { ar: 'جاري الإرسال...', en: 'Sending...' }, 'pending');

  try {
    await sendPasswordReset(email);
    setPanelStatus(
      'authStatus',
      {
        ar: 'أرسلنا رابط إعادة تعيين كلمة المرور إلى بريدك.',
        en: 'We emailed you a password reset link.'
      },
      'ok'
    );
  } catch (err) {
    setPanelStatus('authStatus', describeError(err), 'err');
  } finally {
    setBusy(false);
  }
}

export function openAuthPanel() {
  openModal($('authOverlay'));
  renderMode();
  $('authEmail')?.focus();
}

export function closeAuthPanel() {
  closeModal($('authOverlay'));
  setPanelStatus('authStatus', null);

  const password = $('authPassword');
  if (password) password.value = '';
}

export function initAuthPanel() {
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      mode = tab.dataset.authMode === 'signup' ? 'signup' : 'signin';
      setPanelStatus('authStatus', null);
      renderMode();
    });
  });

  $('authSubmit')?.addEventListener('click', handleSubmit);
  $('authMagicLink')?.addEventListener('click', handleMagicLink);
  $('authForgot')?.addEventListener('click', handleForgot);

  // Enter submits from any of the three inputs.
  ['authEmail', 'authPassword', 'authFullName'].forEach((id) => {
    $(id)?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleSubmit();
      }
    });
  });

  onLangChange(renderMode);
  renderMode();
}
