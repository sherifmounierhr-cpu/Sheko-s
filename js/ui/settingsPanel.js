/**
 * Connection settings + danger zone.
 *
 * This dialog used to hold the Google Apps Script URL. It now holds the
 * Supabase project URL and publishable key, which is what keeps a single static
 * build repointable at a staging project without editing config.js.
 */

import { $, openModal, closeModal } from './dom.js';
import { setPanelStatus, describeError } from './status.js';
import { t } from '../i18n.js';
import { readConfig, writeConfig, resetConfig, DEFAULT_CONFIG } from '../config.js';
import { resetClient } from '../supabaseClient.js';
import { deleteAllApplications } from '../applications.js';
import { isAdmin } from '../auth.js';

export function openSettings() {
  const config = readConfig();

  const urlInput = $('supabaseUrlInput');
  const keyInput = $('supabaseKeyInput');
  if (urlInput) urlInput.value = config.url;
  if (keyInput) keyInput.value = config.anonKey;

  // The danger zone deletes every application in the project; only an admin
  // can actually do it, and RLS enforces that regardless of this toggle.
  const zone = $('dangerZone');
  if (zone) zone.hidden = !isAdmin();

  setPanelStatus('settingsStatus', null);
  setPanelStatus('clearStatus', null);
  openModal($('settingsOverlay'));
}

export function closeSettings() {
  closeModal($('settingsOverlay'));
}

async function saveSettings() {
  const url = $('supabaseUrlInput')?.value.trim() ?? '';
  const anonKey = $('supabaseKeyInput')?.value.trim() ?? '';

  if (!url && !anonKey) {
    resetConfig();
  } else if (!/^https:\/\/.+/i.test(url) || !anonKey) {
    setPanelStatus(
      'settingsStatus',
      {
        ar: 'أدخل رابط المشروع (https://...) والمفتاح العام معًا',
        en: 'Enter both the project URL (https://...) and the publishable key'
      },
      'err'
    );
    return;
  } else {
    writeConfig({ url, anonKey });
  }

  setPanelStatus(
    'settingsStatus',
    { ar: 'تم الحفظ — جاري إعادة التحميل...', en: 'Saved — reloading...' },
    'ok'
  );

  await resetClient();
  // A different project means a different session store and a different schema
  // cache; a reload is the honest way to start clean.
  setTimeout(() => window.location.reload(), 600);
}

function restoreDefaults() {
  const urlInput = $('supabaseUrlInput');
  const keyInput = $('supabaseKeyInput');
  if (urlInput) urlInput.value = DEFAULT_CONFIG.url;
  if (keyInput) keyInput.value = DEFAULT_CONFIG.anonKey;

  setPanelStatus(
    'settingsStatus',
    { ar: 'تمت استعادة الإعدادات الافتراضية — اضغط حفظ', en: 'Defaults restored — press Save' },
    'pending'
  );
}

async function deleteEverything() {
  if (!isAdmin()) {
    setPanelStatus(
      'clearStatus',
      { ar: 'هذا الإجراء متاح لمدير النظام فقط', en: 'This action is available to administrators only' },
      'err'
    );
    return;
  }

  const first = t(
    'هل أنت متأكد؟ سيتم حذف كل طلبات التوظيف وتقييمات الموارد البشرية نهائيًا.',
    'Are you sure? Every application and HR evaluation will be permanently deleted.'
  );
  if (!window.confirm(first)) return;

  const second = t(
    'تأكيد أخير: لا يمكن التراجع بعد هذه الخطوة. متأكد؟',
    'Final confirmation: this cannot be undone. Proceed?'
  );
  if (!window.confirm(second)) return;

  setPanelStatus('clearStatus', { ar: 'جاري الحذف...', en: 'Deleting...' }, 'pending');

  try {
    const removed = await deleteAllApplications();
    setPanelStatus(
      'clearStatus',
      {
        ar: `تم حذف ${removed} طلب`,
        en: `Deleted ${removed} application${removed === 1 ? '' : 's'}`
      },
      'ok'
    );
  } catch (err) {
    setPanelStatus('clearStatus', describeError(err), 'err');
  }
}

export function initSettingsPanel() {
  $('settingsSave')?.addEventListener('click', saveSettings);
  $('settingsClose')?.addEventListener('click', closeSettings);
  $('settingsDefaults')?.addEventListener('click', restoreDefaults);
  $('deleteAllBtn')?.addEventListener('click', deleteEverything);
}
