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
import { listApplications } from '../applications.js';
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

  return `
    <button type="button" class="staff-row${row.id === selectedId ? ' is-selected' : ''}" data-application-id="${escapeHtml(row.id)}">
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

export function openStaffPanel() {
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
    const button = event.target.closest('[data-application-id]');
    if (!button) return;

    const id = button.dataset.applicationId;
    const row = rows.get(id);
    if (!row) return;

    markSelected(id);
    onOpenApplication(row);
    closeStaffPanel();
  });

  onLangChange(render);
}
