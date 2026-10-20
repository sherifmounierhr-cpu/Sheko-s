// Public job application: no account. Talks to the database as the Data API's
// anonymous role, which can only read open positions and call hr_apply().
import { createClient, SupabaseAuthAdapter } from "./vendor/neon.js?v=202610221000";
import { NEON_AUTH_URL, NEON_DATA_API_URL } from "./config.js?v=202610221000";
import { SECTIONS } from "./applyForm.js?v=202610221000";

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = "everest-apply-draft";
const client = NEON_AUTH_URL && NEON_DATA_API_URL
  ? createClient({ auth: { adapter: SupabaseAuthAdapter(), url: NEON_AUTH_URL, allowAnonymous: true }, dataApi: { url: NEON_DATA_API_URL } })
  : null;

let step = 0, positions = [], data = {};
// The draft (personal details) stays on this device for a day at most.
const DAY = 24 * 60 * 60 * 1000;
try {
  const kept = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  if (kept.at && Date.now() - kept.at < DAY && kept.data) data = kept.data; else localStorage.removeItem(KEY);
} catch { data = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* private mode: the draft lives in memory only */ } };

const shown = (x) => !x.showWhen || data[x.showWhen[0]] === x.showWhen[1];
const attrs = (x) => ["autocomplete", "dir", "inputmode", "min", "max", "minlength"].filter((k) => x[k] != null).map((k) => ` ${k}="${esc(x[k])}"`).join("");

function field(x) {
  const id = `f_${x.name}`, req = x.required ? ' required aria-required="true"' : "", star = x.required ? ' <span class="req" aria-hidden="true">*</span>' : "";
  const v = data[x.name] ?? x.value ?? "";
  const hide = shown(x) ? "" : " hidden";
  if (x.type === "grid") {
    return `<fieldset class="wide grid-q"><legend>${esc(x.label)}</legend><div class="tbl flat"><table><thead><tr><th scope="col"><span class="sr-only">البند</span></th>${x.options.map((o) => `<th scope="col">${esc(o)}</th>`).join("")}</tr></thead><tbody>
      ${x.rows.map((r, i) => `<tr><th scope="row">${esc(r)}</th>${x.options.map((o) => `<td class="num"><input type="radio" name="${x.name}_${i}" value="${esc(o)}"${data[`${x.name}_${i}`] === o ? " checked" : ""} aria-label="${esc(r)}: ${esc(o)}"></td>`).join("")}</tr>`).join("")}
      </tbody></table></div></fieldset>`;
  }
  if (x.type === "radio") {
    return `<fieldset class="wide choice" data-for="${x.name}"${hide}><legend>${esc(x.label)}${star}</legend>${x.options.map((o) => `<label><input type="radio" name="${x.name}" value="${esc(o)}"${v === o ? " checked" : ""}${req}> ${esc(o)}</label>`).join("")}</fieldset>`;
  }
  if (x.type === "check") {
    return `<label class="wide check" data-for="${x.name}"${hide}><input type="checkbox" name="${x.name}" value="نعم"${v ? " checked" : ""}${req}> <span>${esc(x.label)}${star}</span></label>`;
  }
  const list = x.options === "positions" ? [...positions, "أخرى"] : x.options;
  const control = x.type === "select"
    ? `<select id="${id}" name="${x.name}"${req}><option value="">اختار</option>${list.map((o) => `<option${v === o ? " selected" : ""}>${esc(o)}</option>`).join("")}</select>`
    : x.type === "textarea" ? `<textarea id="${id}" name="${x.name}" rows="3" maxlength="900"${req}>${esc(v)}</textarea>`
    : `<input id="${id}" type="${x.type}" name="${x.name}" value="${esc(v)}"${attrs(x)}${req}>`;
  return `<label class="${x.wide || x.type === "textarea" ? "wide" : ""}" data-for="${x.name}"${hide} for="${id}">${esc(x.label)}${star}${control}</label>`;
}

function render(focus = true) {
  const s = SECTIONS[step], last = step === SECTIONS.length - 1;
  $("#steps").innerHTML = SECTIONS.map((x, i) => `<li class="${i < step ? "done" : i === step ? "now" : ""}"${i === step ? ' aria-current="step"' : ""}><span>${i + 1}</span><b>${esc(x.title)}</b></li>`).join("");
  $("#bar").style.width = `${Math.round(((step + 1) / SECTIONS.length) * 100)}%`;
  $("#bar").parentElement.setAttribute("aria-valuenow", String(step + 1));
  $("#formBody").innerHTML = `<h2 id="secTitle" tabindex="-1">${step + 1}. ${esc(s.title)}</h2>
    ${s.id === "exp" ? '<p class="note">آخر 3 أماكن اشتغلت فيها. لو أول شغل ليك، سيبهم فاضيين.</p>' : ""}
    <div class="add">${s.fields.map(field).join("")}</div>
    <p class="err" id="formErr" role="alert"></p>
    <div class="row nav-row">${step ? '<button class="btn" type="button" id="back">السابق</button>' : ""}<span class="spacer"></span>
      <button class="btn primary" type="submit" id="next">${last ? "ابعت الطلب" : "التالي"}</button></div>`;
  if (focus) $("#secTitle").focus();
}

function collect() {
  for (const el of $("#applyForm").elements) {
    if (!el.name) continue;
    if (el.type === "radio") { if (el.checked) data[el.name] = el.value; continue; }
    if (el.type === "checkbox") { data[el.name] = el.checked ? el.value : ""; continue; }
    data[el.name] = el.value.trim();
  }
  save();
}

function validate() {
  const s = SECTIONS[step];
  for (const x of s.fields) {
    if (!x.required || !shown(x)) continue;
    if (!data[x.name]) return [x.name, x.type === "check" ? "لازم توافق على الإقرار عشان تبعت الطلب" : `${x.type === "select" || x.type === "radio" ? "اختار" : "اكتب"} ${x.label.replace(/\s*\(.*\)$/, "").replace(/؟$/, "")}`];
  }
  if (s.id === "me") {
    const digits = (data.mobile || "").replace(/[٠-٩]/g, (d) => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) return ["mobile", "رقم الموبايل مش مظبوط"];
    if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) return ["email", "الإيميل مش مظبوط"];
    const age = (Date.now() - Date.parse(data.dob)) / 3.156e10;
    if (!(age >= 16 && age <= 70)) return ["dob", "اتأكد من تاريخ الميلاد"];
    if ((data.full_name || "").split(/\s+/).length < 3) return ["full_name", "اكتب اسمك ثلاثي على الأقل"];
  }
  return null;
}

function showErr(name, msg) {
  $("#formErr").textContent = msg;
  const el = $("#applyForm").elements[name];
  const target = el?.length && !el.tagName ? el[0] : el;
  target?.setAttribute?.("aria-invalid", "true");
  target?.focus?.();
}

async function submit() {
  const btn = $("#next"); btn.disabled = true; btn.textContent = "بنبعت...";
  const answers = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== "" && v != null));
  try {
    const { data: ref, error } = await client.rpc("hr_apply", { p_answers: answers });
    if (error) throw error;
    try { localStorage.removeItem(KEY); } catch { /* nothing saved */ }
    $("#applyForm").hidden = true; $("#steps").hidden = true; $("#progress").hidden = true;
    $("#done").hidden = false; $("#refNo").textContent = ref; $("#done h2").focus();
  } catch (e) {
    const m = String(e?.message || e);
    const msg = /already applied/.test(m) ? "انت قدّمت قبل كده من نفس الرقم في آخر 30 يوم. هنتواصل معاك قريب."
      : /busy/.test(m) ? "فيه ضغط على الفورم دلوقتي. جرب كمان شوية."
      : /missing (\w+)/.test(m) ? "فيه بيانات مطلوبة ناقصة. ارجع للخطوات اللي قبل كده وكمّلها."
      : /bad (mobile|email|dob)/.test(m) ? "فيه بيانات مش مظبوطة (الموبايل أو الإيميل أو تاريخ الميلاد)."
      : /bad position/.test(m) ? "الوظيفة دي مبقتش متاحة. اختار وظيفة تانية."
      : "مقدرناش نبعت الطلب. اتأكد من النت وجرب تاني.";
    $("#formErr").textContent = msg;
    btn.disabled = false; btn.textContent = "ابعت الطلب";
  }
}

document.addEventListener("change", (ev) => {
  const t = ev.target; if (!t.form) return;
  collect();
  for (const x of SECTIONS[step].fields) if (x.showWhen && x.showWhen[0] === t.name) {
    const box = $(`[data-for="${x.name}"]`); if (box) box.hidden = !shown(x);
  }
  t.removeAttribute("aria-invalid");
});
document.addEventListener("input", (ev) => { if (ev.target.form) { collect(); $("#formErr").textContent = ""; } });
document.addEventListener("click", (ev) => {
  if (ev.target.closest("#back")) { collect(); step--; render(); window.scrollTo({ top: 0 }); }
  if (ev.target.closest("#restart")) { location.reload(); }
});
$("#applyForm").addEventListener("submit", (ev) => {
  ev.preventDefault(); collect();
  const bad = validate(); if (bad) { showErr(...bad); return; }
  if (step < SECTIONS.length - 1) { step++; render(); window.scrollTo({ top: 0 }); return; }
  submit();
});

const BUILD = "202610221000";
async function boot() {
  try {
    const { v } = await (await fetch("version.json", { cache: "no-store" })).json();
    if (v && v !== BUILD && sessionStorage.getItem("apply-build") !== v) { sessionStorage.setItem("apply-build", v); location.reload(); return; }
  } catch { /* carry on */ }
  if (!client) { $("#formBody").innerHTML = '<p class="note">الفورم مش متاح دلوقتي.</p>'; return; }
  try {
    const { data: rows, error } = await client.from("job_positions").select("title").eq("active", true).order("sort").order("title");
    if (error) throw error;
    positions = rows.map((r) => r.title);
  } catch {
    $("#formBody").innerHTML = '<p class="err" role="alert">الفورم مش متاح دلوقتي. جرب كمان شوية، أو كلمنا على رقم الشركة.</p>'; return;
  }
  render(false);
}
boot();
