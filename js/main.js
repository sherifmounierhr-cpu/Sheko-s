/**
 * Application entry point.
 *
 * Wires the form modules to Supabase: authentication gate, autosaved
 * persistence, realtime reconciliation, and role-aware UI.
 */

import { AUTOSAVE_DELAY_MS, isConfigured } from './config.js';
// Imported early: it snapshots the URL before the Supabase client strips it.
import { callbackMessage, clearCallbackFromUrl } from './authRedirect.js';
import { applyLang, toggleLang, getLang, onLangChange } from './i18n.js';
import { APPLICANT_FIELDS, HR_FIELDS, ROLE_LABELS } from './formSchema.js';
import { renderGeneratedTables } from './formBuilder.js';
import {
  collectAnswers,
  applyAnswers,
  collectReview,
  applyReview,
  clearForm,
  readField
} from './formState.js';
import { calcAge, calcInterviewTotal, updateScore } from './scoring.js';
import {
  initAuth,
  onAuthChange,
  getUser,
  getProfile,
  getRole,
  isStaff,
  isAdmin,
  signOut
} from './auth.js';
import {
  fetchMyApplication,
  saveMyApplication,
  fetchReview,
  saveReview,
  reviewToFields
} from './applications.js';
import { subscribe, unsubscribe } from './realtime.js';

import { $, debounce, setText, closeModal } from './ui/dom.js';
import { setSubmitStatus, setSyncStatus, setPanelStatus, describeError } from './ui/status.js';
import { initAuthPanel, openAuthPanel, closeAuthPanel } from './ui/authPanel.js';
import {
  initStaffPanel,
  openStaffPanel,
  refreshStaffList,
  upsertRow,
  removeRow,
  markSelected
} from './ui/staffPanel.js';

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

const state = {
  /** id of the application currently shown in the form */
  applicationId: null,
  /** true when that application belongs to the signed-in user */
  viewingOwn: true,
  status: 'draft',
  /** blocks autosave while a remote row is being written into the DOM */
  hydrating: false
};

/* -------------------------------------------------------------------------- */
/* Role-driven chrome                                                         */
/* -------------------------------------------------------------------------- */

function renderSessionChip() {
  const chip = $('sessionChip');
  const user = getUser();

  if (!chip) return;

  if (!user) {
    chip.hidden = true;
    return;
  }

  const role = ROLE_LABELS[getRole()] ?? ROLE_LABELS.applicant;
  const name = getProfile()?.full_name || user.email;

  setText(chip, `${name} · ${getLang() === 'ar' ? role.ar : role.en}`);
  chip.hidden = false;
}

function applyRoleClasses() {
  const body = document.body;
  body.classList.toggle('is-authenticated', Boolean(getUser()));
  body.classList.toggle('is-staff', isStaff());
  body.classList.toggle('is-admin', isAdmin());
  body.classList.toggle('is-reviewing', !state.viewingOwn);

  const staffBtn = $('staffBtn');
  if (staffBtn) staffBtn.hidden = !isStaff();

  const signOutBtn = $('signOutBtn');
  if (signOutBtn) signOutBtn.hidden = !getUser();
}

/**
 * Staff reviewing someone else's application may fill in the HR section but
 * must not rewrite the applicant's own answers.
 */
function setApplicantFieldsEditable(editable) {
  APPLICANT_FIELDS.forEach((name) => {
    document.getElementsByName(name).forEach((el) => {
      if (el.id === 'age') return; // always derived, always read-only

      if (el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'SELECT') {
        el.disabled = !editable;
      } else {
        el.readOnly = !editable;
      }
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

const saveAnswers = debounce(async () => {
  const user = getUser();
  if (!user || !state.viewingOwn) return;

  const { score, recommendation } = updateScore();

  setSyncStatus({ ar: 'جاري الحفظ...', en: 'Saving...' }, 'pending');

  try {
    const row = await saveMyApplication({
      userId: user.id,
      answers: collectAnswers(),
      score,
      recommendation
    });

    state.applicationId = row.id;
    state.status = row.status;

    setSyncStatus({ ar: 'تم الحفظ', en: 'Saved' }, 'ok');
    if (isStaff()) upsertRow(row);
  } catch (err) {
    console.error('[autosave] application', err);
    setSyncStatus(describeError(err), 'err');
  }
}, AUTOSAVE_DELAY_MS);

const saveHrReview = debounce(async () => {
  const user = getUser();
  if (!user || !isStaff() || !state.applicationId) return;

  setSyncStatus({ ar: 'جاري حفظ التقييم...', en: 'Saving evaluation...' }, 'pending');

  try {
    await saveReview({
      applicationId: state.applicationId,
      reviewerId: user.id,
      values: collectReview(),
      interviewTotal: calcInterviewTotal()
    });

    setSyncStatus({ ar: 'تم حفظ التقييم', en: 'Evaluation saved' }, 'ok');
  } catch (err) {
    console.error('[autosave] review', err);
    setSyncStatus(describeError(err), 'err');
  }
}, AUTOSAVE_DELAY_MS);

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

async function hydrate(application, review) {
  state.hydrating = true;

  try {
    applyAnswers(application?.answers ?? {});
    applyReview(reviewToFields(review));
    calcAge();
    calcInterviewTotal();
    updateScore();
  } finally {
    state.hydrating = false;
  }
}

/** Loads (or creates the local view of) the signed-in user's own application. */
async function loadOwnApplication() {
  const user = getUser();
  if (!user) return;

  setSyncStatus({ ar: 'جاري التحميل...', en: 'Loading...' }, 'pending');

  try {
    const application = await fetchMyApplication(user.id);

    state.applicationId = application?.id ?? null;
    state.viewingOwn = true;
    state.status = application?.status ?? 'draft';

    // Staff can see reviews; applicants get null back and the section stays empty.
    const review = application && isStaff() ? await fetchReview(application.id) : null;

    await hydrate(application, review);
    setApplicantFieldsEditable(true);
    markSelected(state.applicationId);
    applyRoleClasses();

    if (application?.status === 'submitted') {
      setSubmitStatus(
        {
          ar: 'تم استلام طلبك. أي تعديل يُحفظ تلقائيًا.',
          en: 'Your application has been received. Any edit is saved automatically.'
        },
        'ok'
      );
    } else {
      setSubmitStatus(null);
    }

    setSyncStatus(
      application
        ? { ar: 'متصل ومتزامن', en: 'Connected & synced' }
        : { ar: 'متصل', en: 'Connected' },
      'ok'
    );
  } catch (err) {
    console.error('[load] own application', err);
    setSyncStatus(describeError(err), 'err');
  }
}

/** Staff clicked an applicant in the list. */
async function openApplication(row) {
  const user = getUser();
  if (!user) return;

  const own = row.user_id === user.id;

  state.applicationId = row.id;
  state.viewingOwn = own;
  state.status = row.status;

  setSyncStatus({ ar: 'جاري فتح الطلب...', en: 'Opening application...' }, 'pending');

  try {
    const review = await fetchReview(row.id);

    clearForm();
    await hydrate(row, review);
    setApplicantFieldsEditable(own);
    applyRoleClasses();

    const name = row.applicant?.full_name || row.answers?.full_name || row.applicant?.email || '';
    setSubmitStatus(
      own
        ? { ar: 'تعرض طلبك أنت.', en: 'Viewing your own application.' }
        : {
            ar: `تعرض طلب: ${name} — يمكنك تعبئة قسم الموارد البشرية فقط.`,
            en: `Viewing: ${name} — you can fill in the HR section only.`
          },
      'pending'
    );

    setSyncStatus({ ar: 'متصل ومتزامن', en: 'Connected & synced' }, 'ok');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    console.error('[load] application', err);
    setSyncStatus(describeError(err), 'err');
  }
}

/* -------------------------------------------------------------------------- */
/* Realtime                                                                   */
/* -------------------------------------------------------------------------- */

async function startRealtime() {
  await subscribe({
    onApplication(row) {
      if (isStaff()) upsertRow(row);

      if (row.id !== state.applicationId) return;

      // Someone edited this same application elsewhere -- another tab, another
      // device, or HR. Merge it in without disturbing the field in focus.
      state.hydrating = true;
      try {
        applyAnswers(row.answers ?? {});
        calcAge();
        updateScore();
        state.status = row.status;
      } finally {
        state.hydrating = false;
      }

      setSyncStatus({ ar: 'تم التحديث من جهاز آخر', en: 'Updated from another device' }, 'ok');
    },

    onApplicationDelete(old) {
      removeRow(old.id);

      if (old.id === state.applicationId) {
        state.applicationId = null;
        state.viewingOwn = true;
        clearForm();
        updateScore();
        setSubmitStatus({ ar: 'تم حذف هذا الطلب', en: 'This application was deleted' }, 'err');
      }
    },

    onReview(row) {
      if (!isStaff() || row.application_id !== state.applicationId) return;

      state.hydrating = true;
      try {
        applyReview(reviewToFields(row));
        calcInterviewTotal();
      } finally {
        state.hydrating = false;
      }

      setSyncStatus({ ar: 'تم تحديث التقييم', en: 'Evaluation updated' }, 'ok');
    },

    onStatus(status) {
      if (status === 'SUBSCRIBED') {
        setSyncStatus({ ar: 'متصل ومتزامن', en: 'Connected & synced' }, 'ok');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setSyncStatus({ ar: 'انقطع التزامن اللحظي', en: 'Live sync interrupted' }, 'err');
      }
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Submit                                                                     */
/* -------------------------------------------------------------------------- */

async function submitApplication() {
  const user = getUser();

  if (!user) {
    openAuthPanel();
    return;
  }

  if (!state.viewingOwn) {
    setSubmitStatus(
      {
        ar: 'أنت تراجع طلب متقدم آخر — لا يمكن إرساله نيابة عنه.',
        en: 'You are reviewing another applicant — you cannot submit on their behalf.'
      },
      'err'
    );
    return;
  }

  if (!readField('full_name').trim()) {
    setSubmitStatus(
      { ar: 'من فضلك اكتب الاسم بالكامل قبل الإرسال', en: 'Please enter your full name before submitting' },
      'err'
    );
    document.getElementById('full_name')?.focus();
    return;
  }

  if (!readField('mobile').trim() && !readField('email').trim()) {
    setSubmitStatus(
      {
        ar: 'من فضلك أدخل رقم الموبايل أو البريد الإلكتروني للتواصل',
        en: 'Please provide a mobile number or an email address so we can reach you'
      },
      'err'
    );
    return;
  }

  // Anything still queued would otherwise overwrite the submit with a draft.
  saveAnswers.cancel();

  const { score, recommendation } = updateScore();
  setSubmitStatus({ ar: 'جاري الإرسال...', en: 'Sending...' }, 'pending');

  try {
    const row = await saveMyApplication({
      userId: user.id,
      answers: collectAnswers(),
      score,
      recommendation,
      status: 'submitted'
    });

    state.applicationId = row.id;
    state.status = row.status;

    setSubmitStatus(
      { ar: 'تم إرسال الطلب بنجاح وحفظه في قاعدة البيانات', en: 'Application submitted and saved successfully' },
      'ok'
    );
    setSyncStatus({ ar: 'تم الحفظ', en: 'Saved' }, 'ok');

    if (isStaff()) upsertRow(row);
  } catch (err) {
    console.error('[submit]', err);
    setSubmitStatus(describeError(err), 'err');
  }
}

/* -------------------------------------------------------------------------- */
/* Form change routing                                                        */
/* -------------------------------------------------------------------------- */

const HR_FIELD_SET = new Set(HR_FIELDS);

function handleFormChange(event) {
  if (state.hydrating) return;

  const name = event.target?.name;
  if (!name) return;

  if (HR_FIELD_SET.has(name)) {
    calcInterviewTotal();
    saveHrReview();
    return;
  }

  if (name === 'dob') calcAge();

  updateScore();
  saveAnswers();
}

/* -------------------------------------------------------------------------- */
/* Auth transitions                                                           */
/* -------------------------------------------------------------------------- */

async function handleSignedIn() {
  closeAuthPanel();
  applyRoleClasses();
  renderSessionChip();

  await loadOwnApplication();
  await startRealtime();

  if (isStaff()) refreshStaffList();
}

async function handleSignedOut() {
  await unsubscribe();

  state.applicationId = null;
  state.viewingOwn = true;
  state.status = 'draft';

  clearForm();
  setApplicantFieldsEditable(true);
  updateScore();
  applyRoleClasses();
  renderSessionChip();

  setSubmitStatus(null);
  setSyncStatus(null);

  closeModal($('staffOverlay'));
  openAuthPanel();
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

async function bootstrap() {
  renderGeneratedTables();
  applyLang();
  updateScore();

  initAuthPanel();
  initStaffPanel({
    onOpenApplication: openApplication,
    onOpenOwn: async () => {
      clearForm();
      await loadOwnApplication();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // One delegated pair of listeners replaces every inline onchange/oninput the
  // original markup carried.
  $('jobForm')?.addEventListener('input', handleFormChange);
  $('jobForm')?.addEventListener('change', handleFormChange);

  $('langBtn')?.addEventListener('click', toggleLang);
  $('printBtn')?.addEventListener('click', () => window.print());
  $('staffBtn')?.addEventListener('click', openStaffPanel);
  $('signOutBtn')?.addEventListener('click', async () => {
    try {
      await signOut();
    } catch (err) {
      setSyncStatus(describeError(err), 'err');
    }
  });

  document.querySelectorAll('[data-submit-application]').forEach((btn) => {
    btn.addEventListener('click', submitApplication);
  });

  onLangChange(renderSessionChip);

  // Only trips if js/config.js was deployed with placeholder credentials.
  if (!isConfigured()) {
    setSubmitStatus(
      {
        ar: 'إعدادات الاتصال بقاعدة البيانات ناقصة في js/config.js.',
        en: 'Database credentials are missing from js/config.js.'
      },
      'err'
    );
    return;
  }

  let signedIn = false;

  try {
    // initAuth() emits synchronously for a restored session, so the listener is
    // registered afterwards -- otherwise the restore would be handled twice.
    const { session } = await initAuth();
    signedIn = Boolean(session);

    onAuthChange((next) => {
      const nowSignedIn = Boolean(next.session);

      if (nowSignedIn === signedIn) {
        // Same session, new profile data (role resolved, name changed).
        renderSessionChip();
        applyRoleClasses();
        return;
      }

      signedIn = nowSignedIn;
      if (nowSignedIn) handleSignedIn();
      else handleSignedOut();
    });

    if (session) await handleSignedIn();
    else openAuthPanel();

    // Someone arriving from a confirmation / magic link deserves to be told
    // what just happened, rather than silently landing on a form.
    const callback = callbackMessage();
    if (callback) {
      if (session) setSubmitStatus(callback.message, callback.tone);
      else setPanelStatus('authStatus', callback.message, callback.tone);
    }
    clearCallbackFromUrl();
  } catch (err) {
    console.error('[bootstrap]', err);
    setSubmitStatus(describeError(err), 'err');
  }
}

// Save anything still pending when the tab goes away.
window.addEventListener('pagehide', () => {
  saveAnswers.flush();
  saveHrReview.flush();
});

bootstrap();
