/**
 * Required-field marking and validation.
 *
 * Both come from REQUIRED_FIELDS, so the red asterisk and the submit check can
 * never disagree about which fields matter.
 */

import { REQUIRED_FIELDS } from './formSchema.js';
import { readField } from './formState.js';

/** Finds the .field wrapper a named input belongs to. */
function wrapperFor(name) {
  const input = document.getElementsByName(name)[0];
  return input?.closest('.field') ?? null;
}

/** Draws the red asterisk. Idempotent — safe to call more than once. */
export function markRequiredFields() {
  REQUIRED_FIELDS.forEach((name) => {
    const wrapper = wrapperFor(name);
    const label = wrapper?.querySelector('label');
    if (!label || label.querySelector('.req')) return;

    const star = document.createElement('span');
    star.className = 'req';
    star.textContent = '*';
    // aria-hidden because the input itself carries required="", which is what
    // a screen reader announces.
    star.setAttribute('aria-hidden', 'true');

    label.appendChild(star);

    document.getElementsByName(name).forEach((input) => {
      input.setAttribute('required', '');
    });
  });
}

function isFilled(name) {
  return readField(name).trim() !== '';
}

/** Clears any red borders left over from a previous attempt. */
export function clearInvalid() {
  document.querySelectorAll('.field.is-invalid').forEach((el) => {
    el.classList.remove('is-invalid');
  });
}

/**
 * @returns {{ok: true} | {ok: false, missing: string[], first: HTMLElement|null}}
 */
export function validateRequired() {
  clearInvalid();

  const missing = REQUIRED_FIELDS.filter((name) => !isFilled(name));

  missing.forEach((name) => wrapperFor(name)?.classList.add('is-invalid'));

  if (!missing.length) return { ok: true };

  return { ok: false, missing, first: wrapperFor(missing[0]) };
}

/** Scrolls to the first offending field and puts the cursor in it. */
export function focusFirstInvalid(wrapper) {
  if (!wrapper) return;

  wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
  wrapper.querySelector('input, select, textarea')?.focus({ preventScroll: true });
}

/**
 * Drops the red border off a field as soon as it is filled in, so the form
 * stops nagging while the applicant is fixing it.
 */
export function initRequiredFields(form = document.getElementById('jobForm')) {
  markRequiredFields();

  form?.addEventListener('input', (event) => {
    const name = event.target?.name;
    if (!name || !REQUIRED_FIELDS.includes(name)) return;

    if (isFilled(name)) wrapperFor(name)?.classList.remove('is-invalid');
  });

  form?.addEventListener('change', (event) => {
    const name = event.target?.name;
    if (!name || !REQUIRED_FIELDS.includes(name)) return;

    if (isFilled(name)) wrapperFor(name)?.classList.remove('is-invalid');
  });
}
