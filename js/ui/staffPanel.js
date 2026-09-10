/**
 * The HR / admin applications list.
 *
 * Only reachable when the profile role is hr or admin, but that is a
 * convenience, not the boundary: listApplications() returns an empty array for
 * an applicant because of the RLS policy on public.applications.
 *
 * The list is kept live by realtime -- main.js feeds row changes in through
 * upsertRow() / removeRow().
 */

import { $, openModal, closeModal, escapeHtml, setText } from './dom.js';
import { setPanelStatus, describeError } from './status.js';
import { getLang, onLangChange, t } from '../i18n.js';
import { listApplications, deleteApplication, deleteAllApplications } from '../applications.js';
import { isAdmin } from '../auth.js';
import { bandFor } from '../scoring.js';

/** @type {Map<string, object>} applications by id, newest activity first */
const rows = new Map();

let onOpenApplication = () => {};
let query = '';
let selectedId = null;

function applicantName(row) {
  return (
    row.applicant?.full_name ||
    row.answers?.full_name ||
    row.applicant?.email ||
    t('متقدم بدون اسم', 'Unnamed applicant')
  );
}

function matches(row) {
  if (!query) return true;

  const haystack = [
    row.applicant?.full_name,
    row.applicant?.email,
    row.answers?.full_name,
    row.answers?.position,
    row.answers?.mobile
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return date.toLocaleDateString(getLang() === 'ar' ? 'ar-EG' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function rowHtml(row) {
  const band = bandFor(row.score ?? 0);
  const submitted = row.status === 'submitted';
  const deleteLabel = t('حذف الطلب', 'Delete application');

  // A <button> cannot nest another <button>, so the row is a plain container
  // with two independent buttons: one to open the application, one -- admins
  // only, per the RLS boundary in applications.js -- to delete it outright.
  return `
    <div class="staff-row${row.id === selectedId ? ' is-selected' : ''}" data-application-id="${escapeHtml(row.id)}">
      <button type="button" class="staff-row-open" data-open-id="${escapeHtml(row.id)}">
        <span class="staff-score" style="background:${band.color}">${escapeHtml(row.score ?? 0)}</span>
        <span class="staff-main">
          <span class="staff-name">${escapeHtml(applicantName(row))}</span>
          <span class="staff-meta">
            ${escapeHtml(row.answers?.position || t('وظيفة غير محددة', 'No position given'))}
            &middot; ${escapeHtml(formatDate(row.updated_at))}
          </span>
        </span>
        <span class="staff-state ${submitted ? 'is-submitted' : 'is-draft'}">
          ${escapeHtml(submitted ? t('مُرسل', 'Submitted') : t('مسودة', 'Draft'))}
        </span>
      </button>
      ${
        isAdmin()
          ? `<button type="button" class="staff-delete" data-delete-id="${escapeHtml(row.id)}" title="${escapeHtml(deleteLabel)}" aria-label="${escapeHtml(deleteLabel)}">&times;</button>`
          : ''
      }
    </div>
  `;
}

function render() {
  const list = $('staffList');
  if (!list) return;

  const visible = [...rows.values()]
    .filter(matches)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

  if (!visible.length) {
    list.innerHTML = `<div class="staff-empty">${escapeHtml(
      rows.size
        ? t('لا توجد نتائج مطابقة', 'No matching applications')
        : t('لا توجد طلبات بعد', 'No applications yet')
    )}</div>`;
  } else {
    list.innerHTML = visible.map(rowHtml).join('');
  }

  setText(
    $('staffCount'),
    getLang() === 'ar'
      ? `${visible.length} من ${rows.size}`
      : `${visible.length} of ${rows.size}`
  );
}

/** Inserts or replaces one application row and repaints. */
export function upsertRow(row) {
  if (!row?.id) return;

  const existing = rows.get(row.id);
  // Realtime payloads carry no embedded profile; keep the one we already have.
  rows.set(row.id, { ...existing, ...row, applicant: row.applicant ?? existing?.applicant });
  render();
}

export function removeRow(id) {
  if (rows.delete(id)) render();
}

export function markSelected(id) {
  selectedId = id;
  render();
}

export async function refreshStaffList() {
  setPanelStatus('staffStatus', { ar: 'جاري التحميل...', en: 'Loading...' }, 'pending');

  try {
    const data = await listApplications();
    rows.clear();
    data.forEach((row) => rows.set(row.id, row));
    render();
    setPanelStatus('staffStatus', null);
  } catch (err) {
    setPanelStatus('staffStatus', describeError(err), 'err');
  }
}

/**
 * Wipes every application and review.
 *
 * The button is only rendered for admins and this re-checks the role, but
 * neither is the boundary: the delete runs under RLS, which for a non-admin
 * matches only their own row.
 */
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
    rows.clear();
    render();

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

/**
 * Deletes one application after a confirmation.
 *
 * Single confirm, not the double confirm the danger zone uses -- this removes
 * one candidate's record, not the whole project's data, and the row it was
 * just clicked from is right there to identify by name.
 */
async function handleDeleteRow(id) {
  if (!isAdmin()) return; // the button is not rendered for anyone else; this is belt-and-braces

  const row = rows.get(id);
  const name = row ? applicantName(row) : id;

  const confirmMsg = t(
    `هل تريد حذف طلب "${name}"؟ لا يمكن التراجع عن هذا الإجراء.`,
    `Delete the application from "${name}"? This cannot be undone.`
  );
  if (!window.confirm(confirmMsg)) return;

  setPanelStatus('staffStatus', { ar: 'جاري الحذف...', en: 'Deleting...' }, 'pending');

  try {
    await deleteApplication(id);

    rows.delete(id);
    if (selectedId === id) selectedId = null;
    render();

    setPanelStatus('staffStatus', { ar: 'تم حذف الطلب', en: 'Application deleted' }, 'ok');
  } catch (err) {
    setPanelStatus('staffStatus', describeError(err), 'err');
  }
}

export function openStaffPanel() {
  // The danger zone is admin-only; HR staff never see it.
  const zone = $('dangerZone');
  if (zone) zone.hidden = !isAdmin();

  setPanelStatus('clearStatus', null);
  openModal($('staffOverlay'));
  refreshStaffList();
}

export function closeStaffPanel() {
  closeModal($('staffOverlay'));
}

export function initStaffPanel(handlers = {}) {
  onOpenApplication = handlers.onOpenApplication ?? (() => {});

  $('staffClose')?.addEventListener('click', closeStaffPanel);
  $('staffRefresh')?.addEventListener('click', refreshStaffList);
  $('deleteAllBtn')?.addEventListener('click', deleteEverything);

  // Without this there is no way back from reviewing someone else's form.
  $('staffMine')?.addEventListener('click', async () => {
    await handlers.onOpenOwn?.();
    closeStaffPanel();
  });

  $('staffSearch')?.addEventListener('input', (event) => {
    query = event.target.value.trim().toLowerCase();
    render();
  });

  $('staffList')?.addEventListener('click', (event) => {
    const deleteBtn = event.target.closest('[data-delete-id]');
    if (deleteBtn) {
      handleDeleteRow(deleteBtn.dataset.deleteId);
      return;
    }

    const openBtn = event.target.closest('[data-open-id]');
    if (!openBtn) return;

    const id = openBtn.dataset.openId;
    const row = rows.get(id);
    if (!row) return;

    markSelected(id);
    onOpenApplication(row);
    closeStaffPanel();
  });

  onLangChange(render);
}
