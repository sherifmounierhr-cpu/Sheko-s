/** Tiny DOM helpers shared by the UI modules. */

export const $ = (id) => document.getElementById(id);

export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function show(el, visible = true) {
  if (!el) return;
  el.hidden = !visible;
}

export function setText(el, text) {
  if (el) el.textContent = text ?? '';
}

export function openModal(el) {
  el?.classList.add('open');
}

export function closeModal(el) {
  el?.classList.remove('open');
}

export function isModalOpen(el) {
  return Boolean(el?.classList.contains('open'));
}

/** Coalesces rapid calls into one, `delay` ms after the last of them. */
export function debounce(fn, delay) {
  let timer = null;

  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, delay);
  };

  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };

  wrapped.flush = (...args) => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    fn(...args);
  };

  return wrapped;
}

/** Escapes a string for safe interpolation into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}
