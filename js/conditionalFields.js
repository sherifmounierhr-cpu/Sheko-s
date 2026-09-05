/**
 * Follow-up fields that only make sense after a particular answer.
 *
 * Declared in the markup rather than in code, so adding another one is a
 * single attribute:
 *
 *   <div class="field" data-show-when="traveled=نعم"> … </div>
 *
 * A field that disappears is emptied, so an answer the applicant has since
 * contradicted cannot sit in the database out of sight.
 */

import { readField, writeField } from './formState.js';

/** @type {{el: HTMLElement, name: string, value: string, fields: string[]}[]} */
let rules = [];

function collectRules(root) {
  return [...root.querySelectorAll('[data-show-when]')].map((el) => {
    const raw = el.dataset.showWhen;
    const split = raw.indexOf('=');

    return {
      el,
      name: raw.slice(0, split),
      value: raw.slice(split + 1),
      fields: [...el.querySelectorAll('input, select, textarea')]
        .map((input) => input.name)
        .filter(Boolean)
    };
  });
}

/**
 * @param {{clearHidden?: boolean}} options
 *   clearHidden empties the inputs of any rule that is now hidden. Left off
 *   while hydrating from the database, where the incoming row is the truth and
 *   nothing should be rewritten on the way in.
 */
export function applyConditionalFields({ clearHidden = false } = {}) {
  rules.forEach((rule) => {
    const visible = readField(rule.name) === rule.value;

    if (!visible && clearHidden) {
      rule.fields.forEach((name) => writeField(name, ''));
    }

    rule.el.hidden = !visible;
  });
}

export function initConditionalFields(form = document.getElementById('jobForm')) {
  if (!form) return;

  rules = collectRules(form);

  // Programmatic writes do not fire change, so this only ever runs off a real
  // answer from the applicant -- which is exactly when clearing is correct.
  form.addEventListener('change', () => applyConditionalFields({ clearHidden: true }));

  applyConditionalFields();
}
