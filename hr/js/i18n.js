// English for the portal. Each person picks Arabic or English in the menu; the choice
// is kept on their device. The portal is written in Arabic, and when English is on,
// every Arabic text the page shows (text, placeholders, labels, tooltips, the tab
// title, toasts and dialogs) is swapped for its English line from en.js as it appears.
// A text with no English line yet stays Arabic, so nothing ever breaks.
// Data people typed (names, notes, inputs) is never touched.
import { EN } from "./en.js?v=202610231700";

const KEY = "hr-lang";
export const LANG = (() => { try { return localStorage.getItem(KEY) === "en" ? "en" : "ar"; } catch { return "ar"; } })();
export const isEn = LANG === "en";
// dates and times in the person's language (digits always Latin)
export const LOCALE = isEn ? "en-GB" : "ar-EG-u-nu-latn";

export function setLang(l) {
  try { localStorage.setItem(KEY, l === "en" ? "en" : "ar"); } catch { /* storage blocked: stays Arabic */ }
  location.reload();
}

const AR = /[؀-ۿ]/;
const norm = (s) => s.replace(/\s+/g, " ").trim();
const EXACT = new Map(), PATTERNS = [];
// A pattern is a list of literal pieces and slots: {} takes any text, {#} only a number,
// a time or a date (so "{#} دقيقة" never swallows an Arabic sentence ending in "دقيقة").
function add(k, en) {
  if (!k) return;
  if (!/\{#?\}/.test(k)) { if (!EXACT.has(k)) EXACT.set(k, en); return; }
  const parts = k.split(/(\{#?\})/).filter((x) => x !== "").map((x) => (x === "{}" ? { slot: "any" } : x === "{#}" ? { slot: "num" } : x));
  // with almost no Arabic of its own (a lone letter like "{} م"), a pattern must not take Arabic slots
  const strict = (k.replace(/\{#?\}/g, "").match(/[؀-ۿ]/g) || []).length < 2;
  PATTERNS.push({ parts, en, len: k.length, strict, first: typeof parts[0] === "string" ? parts[0] : null });
}
for (const [ar, en] of Object.entries(EN)) {
  let k = norm(ar), e = en;
  // "{}" stuck to the start of a text is an icon drawn before it, not text
  if (/^\{\}[؀-ۿ]/.test(k) && e.startsWith("{}")) { k = k.slice(2); e = e.slice(2); }
  add(k, e);
  if (/\S\{\}$/.test(k) && e.endsWith("{}")) add(k.slice(0, -2).trim(), e.slice(0, -2).trim());
}
PATTERNS.sort((a, b) => b.len - a.len);

const NUM = /^[\d.,:/\-+% ]+$/;
// how well a pattern fits a text: every way of filling the slots is tried, and the one
// leaving the fewest Arabic parts without an English line wins
function fit(parts, s) {
  let best = null;
  (function go(pi, si, vals, miss) {
    if (best && best.miss === 0) return;
    if (pi === parts.length) { if (si === s.length && (!best || miss < best.miss)) best = { vals: [...vals], miss }; return; }
    const t = parts[pi];
    if (typeof t === "string") { if (s.startsWith(t, si)) go(pi + 1, si + t.length, vals, miss); return; }
    const next = parts[pi + 1];
    const ends = [];
    if (next === undefined) ends.push(s.length);
    else for (let j = s.indexOf(next, si + 1); j !== -1; j = s.indexOf(next, j + 1)) ends.push(j);
    for (const e of ends) {
      const v = s.slice(si, e).trim(); if (!v) continue;
      if (t.slot === "num" && !NUM.test(v)) continue;
      const known = !AR.test(v) || EXACT.has(norm(v)) || tr(v) !== v;
      go(pi + 1, e, [...vals, v], miss + (known ? 0 : 1));
    }
  })(0, 0, [], 0);
  return best;
}

// one text: an exact line, else the best-fitting pattern, its slots filled in order
// ({1} {2} in the English reorder them); an Arabic slot with its own English line is translated too
const CACHE = new Map();
export function tr(text) {
  if (!isEn || !text || !AR.test(text)) return text;
  const k = norm(text), hit = EXACT.get(k) ?? CACHE.get(k);
  if (hit != null) return hit;
  const out = translate(k);
  if (CACHE.size > 5000) CACHE.clear();
  CACHE.set(k, out);
  return out;
}
function translate(k) {
  for (const p of PATTERNS) {
    if (p.first && !k.startsWith(p.first)) continue;
    const m = fit(p.parts, k); if (!m) continue;
    if (p.strict && m.miss > 0) continue;
    const vals = m.vals.map((v) => (AR.test(v) ? EXACT.get(norm(v)) ?? tr(v) : v));
    let i = 0;
    return p.en.replace(/\{(\d*)\}/g, (_, n) => (n ? vals[Number(n) - 1] : vals[i++]) ?? "");
  }
  return k;
}

const SKIP = "script,style,textarea,[contenteditable],[data-noi18n]";
const ATTRS = ["placeholder", "aria-label", "title", "label"];
function textNode(n) {
  const v = n.nodeValue;
  if (!AR.test(v) || n.parentElement?.closest(SKIP)) return;
  const t = tr(v);
  if (t !== norm(v)) { const lead = v.match(/^\s*/)[0], tail = v.match(/\s*$/)[0]; n.nodeValue = lead + t + tail; }
}
function element(el) {
  if (el.closest?.(SKIP)) return;
  for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v && AR.test(v)) { const t = tr(v); if (t !== norm(v)) el.setAttribute(a, t); } }
}
function walk(root) {
  if (root.nodeType === 3) { textNode(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9) return;
  if (root.nodeType === 1) element(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? textNode(n) : element(n);
}

// English pages read left to right; everything new on the page is translated as it appears
export function startTranslation() {
  if (!isEn) return;
  document.documentElement.lang = "en"; document.documentElement.dir = "ltr";
  walk(document.documentElement);
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") textNode(m.target);
      else if (m.type === "attributes") element(m.target);
      else m.addedNodes.forEach(walk);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
