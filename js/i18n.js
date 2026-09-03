/**
 * Arabic / English toggle.
 *
 * Behaviour is unchanged from the original inline script: every element that
 * carries data-ar / data-en has its text swapped, and the document direction
 * flips between rtl and ltr. Modules that render their own copy subscribe with
 * onLangChange() instead of re-reading a global.
 */

const listeners = new Set();

let currentLang = 'ar';

export function getLang() {
  return currentLang;
}

/** Picks the Arabic or English variant of a string pair. */
export function t(ar, en) {
  return currentLang === 'ar' ? ar : en;
}

/**
 * Swaps the visible text of every [data-ar] element and flips the document
 * direction. Safe to call repeatedly.
 */
export function applyLang() {
  const root = document.getElementById('htmlRoot') || document.documentElement;

  root.setAttribute('dir', currentLang === 'ar' ? 'rtl' : 'ltr');
  root.setAttribute('lang', currentLang);

  const label = document.getElementById('langBtnLabel');
  if (label) label.textContent = currentLang === 'ar' ? 'EN' : 'AR';

  document.querySelectorAll('[data-ar]').forEach((el) => {
    const val = currentLang === 'ar' ? el.getAttribute('data-ar') : el.getAttribute('data-en');
    if (val !== null) el.textContent = val;
  });

  // Placeholders are not text nodes, so they need their own pass.
  document.querySelectorAll('[data-ar-placeholder]').forEach((el) => {
    const val =
      currentLang === 'ar'
        ? el.getAttribute('data-ar-placeholder')
        : el.getAttribute('data-en-placeholder');
    if (val !== null) el.setAttribute('placeholder', val);
  });

  listeners.forEach((fn) => fn(currentLang));
}

export function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'ar';
  applyLang();
}

export function toggleLang() {
  setLang(currentLang === 'ar' ? 'en' : 'ar');
}

/** @param {(lang: 'ar'|'en') => void} fn */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
