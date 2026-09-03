/**
 * Reading and writing the DOM form.
 *
 * Two disjoint slices: the applicant's answers and the HR review. Keeping them
 * apart in code mirrors keeping them apart in the database, where they live in
 * two tables with different RLS policies.
 */

import { APPLICANT_FIELDS, HR_FIELDS } from './formSchema.js';

/** Reads one field by its `name`, handling radio groups. */
export function readField(name) {
  const els = document.getElementsByName(name);
  if (!els.length) return '';

  if (els[0].type === 'radio') {
    for (const el of els) if (el.checked) return el.value;
    return '';
  }

  return els[0].value ?? '';
}

/** Writes one field by its `name`, handling radio groups. */
export function writeField(name, value) {
  const els = document.getElementsByName(name);
  if (!els.length) return;

  const next = value == null ? '' : String(value);

  if (els[0].type === 'radio') {
    els.forEach((el) => {
      el.checked = el.value === next;
    });
    return;
  }

  if (els[0].value !== next) els[0].value = next;
}

function collect(fields) {
  const out = {};
  fields.forEach((name) => {
    const value = readField(name);
    if (value !== '') out[name] = value;
  });
  return out;
}

function apply(fields, values, { skipActiveElement = true } = {}) {
  const active = skipActiveElement ? document.activeElement : null;
  const source = values || {};

  fields.forEach((name) => {
    // Never yank text out from under someone who is mid-sentence.
    if (active && active.name === name) return;
    writeField(name, source[name] ?? '');
  });
}

export function collectAnswers() {
  return collect(APPLICANT_FIELDS);
}

export function applyAnswers(values, options) {
  apply(APPLICANT_FIELDS, values, options);
}

export function collectReview() {
  return collect(HR_FIELDS);
}

export function applyReview(values, options) {
  apply(HR_FIELDS, values, options);
}

/** Clears every field the form owns. Used when staff switch applications. */
export function clearForm() {
  applyAnswers({}, { skipActiveElement: false });
  applyReview({}, { skipActiveElement: false });
}
