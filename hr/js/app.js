import * as db from "./db.js?v=202610081549";
import { DAYS, toMin, dur, monthDays, createEngine, readExport } from "./engine.js?v=202610081549";

const PERM_TYPES = ["إذن تأخير", "إذن انصراف مبكر", "إذن خلال اليوم", "إجازة اعتيادية", "إجازة عارضة", "إجازة مرضية", "إجازة بدون مرتب"];
const STATUSES = ["معتمد", "قيد المراجعة", "مرفوض"];
const MEET_KINDS = ["اجتماع مع عميل خارج المكتب", "معاينة موقع مع عميل", "اجتماع مع عميل في المكتب", "مأمورية عمل", "معرض / إيفنت"];
const RESULTS = ["حجز / تعاقد", "مهتم", "متابعة لاحقة", "غير مهتم", "لم يحضر العميل"];
const SOURCES = ["فيسبوك", "إنستجرام", "جوجل", "تيك توك", "واتساب", "ترشيح (ريفرال)", "مكالمة واردة", "زيارة مباشرة", "معرض"];
const ROLES = [["admin", "مدير النظام"], ["uploader", "رفع البصمة"], ["meetings", "الاجتماعات"], ["manager", "مدير فريق"]];
const KIND_AR = { penalty: "جزاء", warning: "إنذار", bonus: "منحة استثنائية" };
const ACT_ST = { pending: "قيد المراجعة", approved: "معتمد", rejected: "مرفوض", cancelled: "ملغي" };
const CHECK_KINDS = [["office", "في المكتب"], ["meeting", "اجتماع مع عميل"], ["site", "معاينة / موقع مشروع"], ["other", "مأمورية / أخرى"], ["leave", "مغادرة"]];
const checkKind = (k) => CHECK_KINDS.find(([v]) => v === k)?.[1] || k;

// tab id, label, who sees it
// tab id, label, who sees it, icon, nav group, short label for the phone bar
const TABS = [
  ["home", "لوحتي", (r) => !!r.code, "home", "me", "لوحتي"],
  ["inbox", "الإشعارات", (r) => !!r.code || r.admin || r.manager, "bell", "me", "الإشعارات"],
  ["field", "تواجدي واجتماعاتي", (r) => !!r.code, "map-pin", "me", "تواجدي"],
  ["mine", "طلباتي وحضوري", (r) => !!r.code, "calendar-event", "me", "طلباتي"],
  ["live", "الفريق مباشر", (r) => r.admin || r.manager, "broadcast", "team", "مباشر"],
  ["dash", "لوحة المتابعة", (r) => r.admin || r.manager || r.uploader, "chart-bar", "team", "المتابعة"],
  ["requests", "الأذونات والإجازات", (r) => r.admin || r.manager, "clipboard-check", "team", "الطلبات"],
  ["actions", "الجزاءات والمنح", (r) => r.admin || r.manager, "gavel", "team", "الجزاءات"],
  ["daily", "الحضور اليومي", (r) => r.admin || r.manager || r.uploader, "clock", "team", "اليومي"],
  ["meet", "اجتماعات العملاء", (r) => r.admin || r.meetings || r.manager, "briefcase", "team", "الاجتماعات"],
  ["sum", "ملخص الحضور", (r) => r.admin || r.manager, "list-details", "team", "الملخص"],
  ["upload", "رفع البصمة", (r) => r.uploader, "upload", "admin", "رفع البصمة"],
  ["pay", "المرتبات", (r) => r.admin, "cash", "admin", "المرتبات"],
  ["emp", "الموظفين", (r) => r.admin, "users", "admin", "الموظفين"],
  ["set", "الإعدادات والفرق", (r) => r.admin, "settings", "admin", "الإعدادات"],
];
const GROUPS = [["me", "ليا"], ["team", "الفريق"], ["admin", "الإدارة"]];
const icon = (n, cls = "") => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true" focusable="false"><use href="icons.svg#${n}"/></svg>`;
const empty = (ic, title, text = "") => `<div class="empty">${icon(ic)}<b>${esc(title)}</b>${text ? `<span>${text}</span>` : ""}</div>`;

let ME = null, R = {}, S = null, E = null, MONTHS = [], LAST = "";
let tab = "", dailyEmp = "", dailyFilter = "", empFilter = "", payFilter = "", reqFilter = "pending", meetPrefill = null, busy = false;
let NOTIF = [], LIVE = null, LIVE_AT = "", COMP = null, CMT = {}, AUDIT = null, INVITE = null;

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMin = (m) => (m == null ? "" : String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
const to12 = (m) => { if (m == null) return ""; let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, "0"), p = h >= 12 ? "م" : "ص"; h = h % 12 || 12; return `${h}:${mm} ${p}`; };
const n2 = (v) => (Math.round(v * 100) / 100).toLocaleString("en-US");
const money = (v) => Math.round(v).toLocaleString("en-US");
const fmtDate = (d) => { const [, m, dd] = d.split("-"); return `${dd}/${m}`; };
const today = () => db.cairoDay(Date.now());
const nowHM = () => db.cairoTime(Date.now());
const mapLink = (lat, lng) => (lat == null ? "" : `<a href="https://maps.google.com/?q=${Number(lat)},${Number(lng)}" target="_blank" rel="noopener noreferrer">الخريطة</a>`);
// metres between two points
function dist(a, b) {
  const R = 6371000, r = (x) => (x * Math.PI) / 180, dLat = r(b.lat - a.lat), dLng = r(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function officeTag(c) {
  const o = E?.st.office; if (!o?.lat || c.lat == null) return "";
  const m = Math.round(dist(o, c));
  return m <= (N0(o.radius) || 150) ? '<span class="pill p-ok">داخل المكتب</span>' : `<span class="pill p-mute">${m >= 1000 ? (m / 1000).toFixed(1) + " كم" : m + " م"} من المكتب</span>`;
}
const fmtTs = (ts) => `${fmtDate(db.cairoDay(ts))} ${to12(toMin(db.cairoTime(ts)))}`;
function locate() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("الجهاز مش بيدعم تحديد الموقع"));
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      (e) => rej(new Error(e.code === 1 ? "اسمح للموقع باستخدام الـ Location من إعدادات المتصفح" : "مقدرتش أحدد الموقع")),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  });
}
const empName = (e) => e?.name?.trim() || `بدون اسم - ${e?.code ?? ""}`;
const empBy = (code) => S.employees.find((e) => e.code === code);
const nameOf = (code) => (empBy(code) ? empName(empBy(code)) : code);
const teamOf = (id) => S.teams.find((t) => String(t.id) === String(id));
const has = (v) => v !== "" && v != null;
const N0 = (v) => Number(v) || 0;
const opts = (list, sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : "") +
  list.map((v) => { const [val, lab] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}"${String(val) === String(sel) ? " selected" : ""}>${esc(lab)}</option>`; }).join("");
const empOpts = (sel, blank, list = S.employees) => opts(list.map((e) => [e.code, `${e.code} - ${empName(e)}`]), sel, blank);

// Success toasts are polite and fade; errors are alerts and stay until closed.
function toast(t, bad) {
  const box = $("#toasts"), el = document.createElement("div");
  el.className = `toast${bad ? " bad" : ""}`;
  el.setAttribute("role", bad ? "alert" : "status");
  el.innerHTML = `<span>${esc(t)}</span><button class="btn" type="button" aria-label="إغلاق">${icon("x")}</button>`;
  el.querySelector("button").onclick = () => el.remove();
  if (!bad) setTimeout(() => el.remove(), 4500);
  box.querySelectorAll(".toast:not(.bad)").forEach((x) => x.remove());
  box.append(el);
  while (box.children.length > 3) box.firstElementChild.remove();
}
const announce = (t) => { const a = $("#announce"); a.textContent = ""; setTimeout(() => (a.textContent = t), 50); };

// Accessible yes/no in a <dialog>; resolves true on تأكيد.
function ask(title, text = "", yes = "تأكيد", danger = false) {
  const d = $("#confirmDlg");
  $("#confirmTitle").textContent = title; $("#confirmText").textContent = text;
  const y = $("#confirmYes"); y.textContent = yes; y.className = `btn ${danger ? "danger" : "primary"}`;
  d.returnValue = "";
  return new Promise((res) => { d.addEventListener("close", () => res(d.returnValue === "yes"), { once: true }); d.showModal(); y.focus(); });
}
function errMsg(e) { const m = String(e?.message || e); if (/not allowed|permission|policy|42501/i.test(m)) return "مالكش صلاحية تعمل ده."; return `حصلت مشكلة: ${m}`; }

// ---------------------------------------------------------------- boot / auth
async function boot() {
  if (!db.configured) { show("setup"); return; }
  const user = await db.currentUser().catch(() => null);
  if (!user) { show("login"); return; }
  try { ME = await db.me(user); } catch (e) { show("login"); toast(errMsg(e), true); return; }
  R = { admin: ME.roles.includes("admin") };
  for (const [r] of ROLES) R[r] = R.admin || ME.roles.includes(r);
  R.code = ME.code;
  if (!TABS.some(([, , f]) => f(R))) { show("pending"); $("#pendingEmail").textContent = ME.email || ""; return; }
  show("app");
  $("#who").textContent = ME.email || "";
  MONTHS = await db.months().catch(() => []);
  LAST = await db.lastPunchDay().catch(() => "");
  const cur = today().slice(0, 7);
  await refresh(MONTHS.includes(cur) || !MONTHS.length ? cur : MONTHS[0]);
  pollNotifications();
  setInterval(tick, 1000);
  setInterval(() => { if (document.visibilityState === "visible") pollNotifications(); }, 60000);
  setInterval(() => { if (document.visibilityState === "visible" && tab === "live") loadLive(); }, 30000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { pollNotifications(); if (tab === "live") loadLive(); } });
  if (R.admin) db.purgeLocations().catch(() => {});
}

// live clock in Cairo time, updated in place
const clockFmt = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { timeZone: "Africa/Cairo", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("ar-EG-u-nu-latn", { timeZone: "Africa/Cairo", hour: "numeric", minute: "2-digit", second: "2-digit" });
function tick() {
  const d = new Date();
  document.querySelectorAll("[data-clock]").forEach((el) => (el.textContent = timeFmt.format(d)));
  document.querySelectorAll("[data-date]").forEach((el) => (el.textContent = clockFmt.format(d)));
}

const unread = () => NOTIF.filter((n) => !n.read_at).length;
let notifSeen = null;
async function pollNotifications() {
  try {
    NOTIF = await db.notifications(60);
    const ids = NOTIF.filter((n) => !n.read_at).map((n) => n.id);
    if (notifSeen && ids.some((id) => !notifSeen.has(id))) toast(`عندك ${unread()} إشعار جديد`);
    notifSeen = new Set(ids);
    renderTabs();
    if (tab === "inbox" && !typing()) render();
  } catch { /* the inbox is optional; the rest of the page still works */ }
}

const typing = () => { const a = document.activeElement; return a && $("#main").contains(a) && /INPUT|TEXTAREA|SELECT/.test(a.tagName); };
async function loadLive() {
  try {
    LIVE = await db.live(today()); LIVE_AT = timeFmt.format(new Date());
    await loadThreads("meetings", [...LIVE.meetings.map((m) => m.id), ...S.meetings.filter((m) => m.rawStatus === "pending").map((m) => m.id)]);
    if (tab === "live" && !typing()) render();
  } catch (e) { toast(errMsg(e), true); }
}

async function loadThreads(table, ids) {
  ids = [...new Set(ids)];
  const rows = await db.comments(table, ids).catch(() => []);
  for (const id of ids) CMT[`${table}|${id}`] = [];
  for (const c of rows) (CMT[`${c.ref_table}|${c.ref_id}`] ??= []).push(c);
}

function show(view) { for (const v of ["setup", "login", "pending", "app"]) $(`#view-${v}`).hidden = v !== view; }

async function refresh(month = S?.meta.month) {
  busy = true; $("#main").setAttribute("aria-busy", "true");
  if (!S) skeleton();
  try {
    S = await db.load(month, R);
    E = createEngine(S, LAST);
    COMP = null;
    if (!tab || !visibleTabs().some(([k]) => k === tab)) tab = visibleTabs()[0][0];
    await beforeTab();
    render();
  } catch (e) { toast(errMsg(e), true); }
  finally { busy = false; $("#main").removeAttribute("aria-busy"); }
}

async function act(fn, okMsg) {
  // yield a task first so a Tab that triggered the save lands on the next field before we re-render
  try { await fn(); await new Promise((r) => setTimeout(r)); if (okMsg) toast(okMsg); await refresh(); }
  catch (e) { toast(errMsg(e), true); render(); }
}

const visibleTabs = () => TABS.filter(([, , f]) => f(R));

// data a tab needs beyond the month load
async function beforeTab() {
  if (tab === "field" && ME.code) await loadThreads("meetings", S.meetings.filter((m) => m.code === ME.code).map((m) => m.id));
  if (tab === "live") await loadLive();
  if (tab === "home" || tab === "actions") await loadThreads("actions", S.actions.map((a) => a.id));
  if (tab === "inbox" && unread()) { const ids = NOTIF.filter((n) => !n.read_at).map((n) => n.id); db.markRead(ids).then(() => { const t = new Date().toISOString(); NOTIF.forEach((n) => (n.read_at ??= t)); renderTabs(); }).catch(() => {}); }
}
async function go(t) { tab = t; render(); await beforeTab(); render(); }

// ---------------------------------------------------------------- render
// Desktop: grouped sidebar. Phone: the 4 most used places plus "المزيد".
function renderTabs() {
  if (!S) return;
  const badges = { requests: badge(), inbox: unread() ? `<span class="badge" aria-label="${unread()} جديد">${unread()}</span>` : "", actions: actBadge(), live: meetBadge() };
  const vis = visibleTabs();
  const item = ([k, l, , ic], short) => `<button class="nav-item" data-tab="${k}"${k === tab ? ' aria-current="page"' : ""}>${icon(ic)}<span>${short || l}</span>${badges[k] || ""}</button>`;
  const groups = GROUPS.map(([g, gl]) => { const list = vis.filter((t) => t[4] === g); return list.length ? `<div class="nav-group" role="group" aria-label="${gl}"><h2>${gl}</h2>${list.map((t) => item(t)).join("")}</div>` : ""; }).join("");
  $("#side").innerHTML = groups;
  $("#moreList").innerHTML = groups;
  const top = vis.slice(0, vis.length > 5 ? 4 : 5);
  const moreBadge = vis.slice(top.length).some(([k]) => badges[k]);
  $("#bottom").style.gridTemplateColumns = `repeat(${top.length + (vis.length > top.length ? 1 : 0)}, 1fr)`;
  $("#bottom").innerHTML = top.map((t) => item(t, t[5])).join("") +
    (vis.length > top.length ? `<button class="nav-item" id="moreBtn" aria-haspopup="dialog"${vis.slice(top.length).some(([k]) => k === tab) ? ' aria-current="page"' : ""}>${icon("dots")}<span>المزيد</span>${moreBadge ? '<span class="badge" aria-label="فيه جديد">•</span>' : ""}</button>` : "");
}
// Re-rendering replaces the page, so remember which control had focus and put it back.
const focusKey = () => keyOf(document.activeElement);
function keyOf(a) {
  if (!a || a === document.body || !$("#main").contains(a)) return null;
  if (a.id) return `#${CSS.escape(a.id)}`;
  const attrs = [...a.attributes].filter((x) => x.name.startsWith("data-") || x.name === "name").map((x) => `[${x.name}="${CSS.escape(x.value)}"]`).join("");
  const form = a.form?.id ? `#${CSS.escape(a.form.id)} ` : "";
  return attrs ? `${form}${a.tagName.toLowerCase()}${attrs}` : null;
}
function render() {
  const fk = focusKey();
  renderTabs();
  $("#who").textContent = ME.code && empBy(ME.code) ? `${nameOf(ME.code)} · ${ME.email || ""}` : ME.email || "";
  const set = new Set([S.meta.month, ...MONTHS]);
  $("#month").innerHTML = opts([...set].sort().reverse().map((m) => [m, m.split("-").reverse().join(" / ")]), S.meta.month);
  $("#roleChips").innerHTML = (R.admin ? [["admin", "مدير النظام"]] : ROLES.filter(([r]) => ME.roles.includes(r))).map(([, l]) => `<span class="pill p-acc">${l}</span>`).join("") + (ME.code ? `<span class="pill p-mute">${esc(nameOf(ME.code))}</span>` : "");
  const views = { home, inbox, field, live, actions, dash, mine, requests, daily, meet, upload, sum, pay, emp, set: settings };
  const warn = !db.portalReady && R.admin ? `<div class="banner">${icon("alert-triangle")}جداول بوابة الموظفين لسه مش ظاهرة. شغّل neon/002_portal.sql في Neon SQL Editor، وبعدين حدّث الـ schema cache من صفحة Data API.</div>` : "";
  const [, label, , ic] = TABS.find(([k]) => k === tab);
  const title = ["home", "field", "live"].includes(tab) ? `<h2 class="sr-only">${label}</h2>` : `<div class="page-title">${icon(ic)}<h2>${label}</h2></div>`;
  $("#main").innerHTML = `<section class="panel" aria-label="${label}">${title}${warn}${views[tab](S.meta.month)}</section>`;
  document.title = `${label} | Everest HR`;
  tick();
  labelControls();
  if (fk) { const el = document.querySelector(fk); if (el) el.focus({ preventScroll: true }); }
}
// Inputs inside table cells get their name from the column header and the row's first cell.
function labelControls() {
  for (const el of $("#main").querySelectorAll("td input, td select")) {
    if (el.getAttribute("aria-label") || el.labels?.length) continue;
    const td = el.closest("td"), tr = td.parentElement, table = tr.closest("table");
    const head = table.tHead?.rows[0]?.cells[td.cellIndex]?.textContent.trim() || "";
    const first = tr.cells[0] === td ? "" : (tr.cells[1] && tr.cells[0].textContent.trim().length < 6 ? `${tr.cells[0].textContent.trim()} ${tr.cells[1].querySelector("input")?.value || tr.cells[1].textContent.trim()}` : tr.cells[0].querySelector("input")?.value || tr.cells[0].textContent.trim());
    el.setAttribute("aria-label", [head, first].filter(Boolean).join(": ").slice(0, 80));
  }
  for (const th of $("#main").querySelectorAll("thead th:empty")) th.innerHTML = '<span class="sr-only">إجراء</span>';
  for (const box of $("#main").querySelectorAll(".tbl")) if (!box.querySelector("input,select,button,a")) { box.tabIndex = 0; box.setAttribute("role", "region"); box.setAttribute("aria-label", box.closest(".card")?.querySelector("h2")?.textContent || "جدول"); }
}
function skeleton() { $("#main").innerHTML = '<section class="panel"><div class="skel" aria-hidden="true"><i class="h"></i><i></i><i class="s"></i><i></i><i class="s"></i></div><p class="sr-only">جاري التحميل</p></section>'; }
const actBadge = () => { const n = R.admin ? S.actions.filter((a) => a.status === "pending" || (a.objection && !a.decisionNote)).length : 0; return n ? `<span class="badge">${n}</span>` : ""; };
const canDecideMeet = (m) => R.meetings || (R.manager && m.code !== ME.code && S.employees.some((e) => e.code === m.code));
const meetBadge = () => { const n = S.meetings.filter((m) => m.rawStatus === "pending" && canDecideMeet(m)).length; return n ? `<span class="badge">${n}</span>` : ""; };

// a comment thread under a meeting or an action
function thread(table, id) {
  const list = CMT[`${table}|${id}`];
  if (!list) return "";
  return `<div class="thread">${list.map((c) => `<div class="cm${c.author_code && c.author_code === ME.code ? " me" : ""}"><b>${esc(c.author_code ? nameOf(c.author_code) : "الإدارة")}</b> <span class="note">${fmtTs(c.created_at)}</span><div>${esc(c.body)}</div></div>`).join("")}
    <form class="row cform" data-ct="${table}" data-cid="${id}"><input type="text" name="body" maxlength="2000" placeholder="اكتب تعليق أو رد" required class="grow" aria-label="تعليق"><button class="btn" type="submit">إرسال</button></form></div>`;
}

const kindPill = (k) => `<span class="pill ${k === "bonus" ? "p-ok" : k === "warning" ? "p-warn" : "p-bad"}">${KIND_AR[k] || k}</span>`;
const actValue = (a, rate) => [a.days ? `${n2(a.days)} يوم` : "", a.amount ? `${money(a.amount)} جنيه` : ""].filter(Boolean).join(" + ") + (rate && a.days ? ` <span class="note">(${money(a.days * rate)} ج)</span>` : "");

// ---------------------------------------------------------------- employee home
// status -> heatmap tone
const tone = (st) => /حاضر|مهمة|معفى/.test(st) ? "ok" : /تأخير|انصراف|ناقصة/.test(st) ? "warn" : st === "غياب" ? "bad" : st === "إجازة" ? "info" : "";
function monthCal(e, ym) {
  const rows = E.summary(e, ym).rows, first = rows[0].w, td = today();
  const head = [0, 1, 2, 3, 4, 5, 6].map((i) => `<span class="dn" aria-hidden="true">${"حنثرخجس"[i]}</span>`).join("");
  const blanks = Array.from({ length: first }, () => '<span class="d blank" aria-hidden="true"></span>').join("");
  const cells = rows.map((r) => {
    const t = r.type !== "يوم عمل" ? "" : r.future ? "" : tone(r.status);
    const tip = `${DAYS[r.w]} ${fmtDate(r.d)}: ${r.status}${r.pin != null ? `، دخول ${to12(r.pin)}` : ""}${r.pout != null ? `، خروج ${to12(r.pout)}` : ""}${r.fin ? `، خصم ${n2(r.fin)} يوم` : ""}`;
    return `<button type="button" class="d ${t}${r.d === td ? " today" : ""}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">${Number(r.d.slice(8))}</button>`;
  }).join("");
  return `<div class="cal" role="group" aria-label="حضور الشهر يوم بيوم">${head}${blanks}${cells}</div>
    <p class="cal-tip note" id="calTip" aria-live="polite">اضغط على أي يوم تشوف تفاصيله.</p>
    <div class="legend"><span><i style="background:var(--ok)"></i>في الميعاد</span><span><i style="background:var(--warn)"></i>تأخير أو ناقصة</span><span><i style="background:var(--bad)"></i>غياب</span><span><i style="background:var(--info)"></i>إجازة</span></div>`;
}
// Remembers which sections the user opened, so a re-render keeps them open.
const OPEN = new Map();
document.addEventListener("toggle", (ev) => { const k = ev.target.dataset?.fold; if (k) OPEN.set(k, ev.target.open); }, true);
const fold = (ic, title, body, open = false, extra = "") => `<details class="fold" data-fold="${ic}"${OPEN.get(ic) ?? open ? " open" : ""}><summary>${icon(ic)}<span>${title}</span>${extra}${icon("chevron-down", "chev")}</summary><div class="body">${body}</div></details>`;

function home(ym) {
  const e = empBy(ME.code);
  if (!e) return empty("alert-triangle", "حسابك مربوط بكود موظف مش ظاهر", "كلم مدير النظام يراجع ربط حسابك.");
  const r = E.toDate(e, ym), s = r.s, st = E.st;
  const used = E.permUsed(ME.code, ym), allow = N0(st.permAllowH) * 60;
  const acts = S.actions.filter((a) => a.code === ME.code && a.status === "approved").sort((a, b) => b.day.localeCompare(a.day));
  const fresh = acts.filter((a) => !a.ackAt);
  const offDays = [...new Set([...st.weekend, ...(has(e.off) ? [Number(e.off)] : [])])].map((i) => DAYS[i]).join(" و ");
  const lastCheck = S.checkins.find((c) => c.code === ME.code);
  const grace = (st.lateTiers.find((t) => t[1] > 0)?.[0] ?? 1) - 1;
  const pct = Math.round((r.elapsed / r.total) * 100);
  return `
  <div class="card hero"><img class="wm" src="img/mark-white.png" alt="">
    <div class="row"><div class="spacer"><h2>أهلاً ${esc(empName(e))}</h2><div class="note" data-date></div></div><b class="clock tabnum" data-clock aria-hidden="true"></b></div>
    <div><div class="note">المستحق لحد ${r.upTo ? fmtDate(r.upTo) : "دلوقتي"} (تقديري)</div><div class="big tabnum">${money(r.netToDate)} <small>جنيه</small></div></div>
    <div><span class="track" role="progressbar" aria-label="أيام الشهر اللي عدت" aria-valuemin="0" aria-valuemax="${r.total}" aria-valuenow="${r.elapsed}"><i style="width:${pct}%"></i></span>
      <div class="note">${r.elapsed} من ${r.total} يوم في الشهر · صافي الشهر المتوقع ${money(r.rnd)}</div></div>
    <div class="hero-stats">
      <div><span>خصم الحضور</span><b class="tabnum">${money(r.late)}</b></div>
      <div><span>جزاءات</span><b class="tabnum">${money(r.pen)}</b></div>
      <div><span>منح وعمولات</span><b class="tabnum">${money(r.bonus + N0(r.p.commission) + N0(r.p.ret))}</b></div>
      <div><span>رصيد الأذونات</span><b class="tabnum">${fmtMin(Math.max(0, allow - used))}</b></div>
    </div>
    <div class="row"><button class="btn primary" data-go="field">${icon("map-pin")}سجل تواجدي</button><button class="btn" data-go="mine">${icon("calendar-event")}اطلب إذن أو إجازة</button>
    ${lastCheck ? `<span class="note">آخر تسجيل: ${esc(checkKind(lastCheck.kind))} ${fmtTs(lastCheck.ts)}</span>` : ""}</div></div>
  ${fresh.length ? `<div class="banner">${icon("bell")}عندك ${fresh.length} ${fresh.length === 1 ? "إجراء جديد" : "إجراءات جديدة"} من الإدارة. راجعها في (الجزاءات والمنح) تحت وأكد إنك اطلعت.</div>` : ""}
  <div class="grid2">
    <div class="card"><h2>${icon("calendar-event")}حضوري الشهر ده</h2>${monthCal(e, ym)}
      <div class="kpis">
        <div class="kpi"><span>حضور</span><b>${s.pres}<small class="note"> / ${s.req}</small></b></div>
        <div class="kpi ${s.abs ? "bad" : ""}"><span>غياب</span><b>${s.abs}</b></div>
        <div class="kpi"><span>تأخير</span><b>${s.latec}<small class="note"> مرة</small></b></div>
        <div class="kpi"><span>الالتزام</span><b>${s.commit == null ? "-" : Math.round(s.commit * 100) + "%"}</b></div>
      </div>
      <div><button class="btn" data-go="mine">التفاصيل يوم بيوم</button></div></div>
    <div class="card"><h2>${icon("clock")}مواعيدي</h2><table class="kv"><tbody>
      <tr><th>الحضور</th><td>${e.exempt ? '<span class="pill p-info">معفى من البصمة</span>' : to12(toMin(e.in || st.in))}</td></tr>
      <tr><th>الانصراف</th><td>${e.exempt ? "-" : to12(toMin(e.out || st.out))}</td></tr>
      <tr><th>الإجازة الأسبوعية</th><td>${offDays || "-"}</td></tr>
      <tr><th>رصيد الأذونات</th><td>${fmtMin(Math.max(0, allow - used))} من ${n2(st.permAllowH)} ساعة</td></tr>
      <tr><th>السماح في التأخير</th><td>${grace} دقيقة</td></tr>
      <tr><th>آخر يوم بصمة متسجل</th><td>${LAST ? fmtDate(LAST) : "-"}</td></tr></tbody></table></div>
  </div>
  ${fold("gavel", "الجزاءات والمنح", acts.length ? acts.map((a) => `<div class="act">
    <div class="row">${kindPill(a.kind)}<b>${actValue(a, r.rate)}</b><span class="note">${fmtDate(a.day)}</span>${a.ackAt ? '<span class="pill p-mute">اطلعت</span>' : ""}</div>
    <div>${esc(a.reason)}${a.policyId ? ` <span class="note">(${esc(S.policy.find((p) => p.id === a.policyId)?.title || "بند لائحة")}${a.occurrence ? ` - مرة ${a.occurrence}` : ""})</span>` : ""}</div>
    ${a.objection ? `<div class="note">تظلمك: ${esc(a.objection)}</div>` : ""}
    ${a.ackAt ? "" : `<div class="row"><button class="btn ok" data-ack="${a.id}">اطلعت</button><input type="text" data-objt="${a.id}" placeholder="عندك اعتراض؟ اكتبه هنا" class="grow" aria-label="تظلم"><button class="btn" data-obj="${a.id}">إرسال تظلم</button></div>`}
    ${thread("actions", a.id)}</div>`).join("") + (r.penCapped ? `<p class="note">الجزاءات اتحددت بحد أقصى ${n2(st.maxPenaltyDays)} يوم في الشهر.</p>` : "")
    : empty("check", "مفيش جزاءات أو منح الشهر ده"), fresh.length > 0, fresh.length ? `<span class="badge">${fresh.length}</span>` : "")}
  ${fold("cash", `تفاصيل الراتب (${ym.split("-").reverse().join("/")})`, `<table class="kv"><tbody>
    <tr><th>الراتب</th><td>${money(r.sal)}</td></tr><tr><th>المستحق عن ${r.elapsed} من ${r.total} يوم</th><td>${money(r.earned)}</td></tr>
    ${N0(r.p.commission) ? `<tr><th>عمولات</th><td>${money(r.p.commission)}</td></tr>` : ""}${N0(r.p.ret) ? `<tr><th>مردودات</th><td>${money(r.p.ret)}</td></tr>` : ""}
    ${r.bonus ? `<tr><th>منح استثنائية</th><td>${money(r.bonus)}</td></tr>` : ""}
    <tr><th>خصم الحضور (${n2(r.days)} يوم × ${n2(r.rate)})</th><td>- ${money(r.late)}</td></tr>
    ${r.pen ? `<tr><th>جزاءات</th><td>- ${money(r.pen)}</td></tr>` : ""}
    ${["adminDed", "daysDed", "regDed", "advance"].map((k) => (N0(r.p[k]) ? `<tr><th>${{ adminDed: "خصومات إدارية", daysDed: "خصم أيام", regDed: "تطبيق اللائحة", advance: "سلف" }[k]}</th><td>- ${money(r.p[k])}</td></tr>` : "")).join("")}
    <tr><th>طريقة الصرف</th><td>${r.method === "bank" ? `بنك <span dir="ltr">${esc(e.account)}</span>` : "نقدي"}</td></tr></tbody></table>
    <p class="note">الأرقام تقديرية لحد ما الإدارة تعتمد كشف المرتبات.</p>`)}
  ${fold("chart-bar", "مقارنة الشهور", compareView(), !!COMP)}
  ${S.policy.some((p) => p.active) ? fold("file-text", "لائحة الشركة", `<div class="tbl flat"><table><thead><tr><th>رقم</th><th>البند</th><th>التفاصيل</th><th>الجزاء بالتكرار في الشهر</th></tr></thead><tbody>
    ${S.policy.filter((p) => p.active).map((p) => `<tr><td>${esc(p.ref)}</td><td>${esc(p.title)}${p.category ? ` <span class="note">(${esc(p.category)})</span>` : ""}</td><td class="wrap">${esc(p.body)}</td><td>${p.steps.map((x, i) => `${i + 1}: ${stepText(x)}`).join("، ")}</td></tr>`).join("")}
  </tbody></table></div>`) : ""}`;
}

// Net pay per month as direct-labelled bars, with the same numbers in a table for screen readers and detail.
function compareView() {
  if (!COMP) return `<div><button class="btn" id="loadComp">${icon("chart-bar")}اعرض مقارنة الشهور</button></div>`;
  if (!COMP.length) return empty("chart-bar", "مفيش شهور سابقة لسه");
  const max = Math.max(1, ...COMP.map((c) => Math.max(c.sal, c.rnd)));
  const lab = (ym) => ym.split("-").reverse().join("/");
  return `<div class="bars" aria-hidden="true">${COMP.map((c) => `<div class="b"><span>${lab(c.ym)}</span><span class="track"><i class="${c.days > 2 ? "low" : c.days > 0.5 ? "mid" : ""}" style="width:${Math.max(2, Math.min(100, Math.round((c.rnd / max) * 100)))}%"></i></span><b class="tabnum">${money(c.rnd)}</b></div>`).join("")}</div>
  <div class="legend" aria-hidden="true"><span><i style="background:var(--accent)"></i>خصم أقل من نص يوم</span><span><i style="background:var(--warn)"></i>لحد يومين</span><span><i style="background:var(--bad)"></i>أكتر من يومين</span></div>
  <div class="tbl flat"><table><caption class="sr-only">مقارنة صافي المرتب والخصومات بالشهور</caption><thead><tr><th>الشهر</th><th>غياب</th><th>تأخير (مرات / د)</th><th>أيام الخصم</th><th>جزاءات</th><th>منح</th><th>الصافي</th></tr></thead><tbody>
  ${COMP.map((c) => `<tr><td>${lab(c.ym)}</td><td class="num">${c.abs}</td><td class="num">${c.latec} / ${c.latem}</td><td class="num">${n2(c.days)}</td><td class="num">${c.pen ? money(c.pen) : "-"}</td><td class="num">${c.bonus ? money(c.bonus) : "-"}</td><td class="num"><b>${money(c.rnd)}</b></td></tr>`).join("")}
  </tbody></table></div>`;
}

async function loadComparison() {
  const list = (MONTHS.length ? MONTHS : [S.meta.month]).slice(0, 6);
  const out = [];
  for (const ym of list) {
    const S2 = await db.load(ym, R, ME.code), E2 = createEngine(S2, LAST), e2 = S2.employees.find((x) => x.code === ME.code);
    if (!e2) continue;
    const r = E2.payRow(e2, ym);
    out.push({ ym, abs: r.s.abs, latec: r.s.latec, latem: r.s.latem, days: r.days, pen: r.pen, bonus: r.bonus, rnd: r.rnd, sal: r.sal });
  }
  COMP = out;
}

// ---------------------------------------------------------------- notifications
const NOTIF_GO = { requests: "mine", actions: "home", meetings: "field", checkins: "field" };
function inbox() {
  const goFor = (n) => { if (n.ref_table === "actions" && (R.admin || R.manager) && n.kind !== "penalty" && n.kind !== "bonus" && n.kind !== "warning") return "actions"; if (n.ref_table === "requests" && n.kind === "request" && /قرارك/.test(n.title)) return "requests"; if (n.ref_table === "meetings" && /الفريق/.test(n.title)) return "live"; return NOTIF_GO[n.ref_table]; };
  return `<div class="row"><p class="note spacer">الإشعارات بتتحدث كل دقيقة.</p></div>
  <div class="card">${NOTIF.map((n) => { const g = goFor(n); return `<div class="notif${n.read_at ? "" : " new"}"><div class="row"><b>${esc(n.title)}</b><span class="note">${fmtTs(n.created_at)}</span>
    ${g && TABS.some(([k, , f]) => k === g && f(R)) ? `<button class="btn" data-go="${g}">افتح</button>` : ""}</div>
    ${n.body ? `<div>${esc(n.body)}</div>` : ""}</div>`; }).join("") || empty("bell", "مفيش إشعارات لسه", "هيوصلك إشعار هنا لما طلب يتوافق عليه أو حد يعلق على اجتماعك.")}</div>`;
}

// ---------------------------------------------------------------- field: check-in and own meetings
function field() {
  const e = empBy(ME.code);
  if (!e) return '<p class="note">حسابك مش مربوط بموظف.</p>';
  const mine = S.checkins.filter((c) => c.code === ME.code);
  const meets = S.meetings.filter((m) => m.code === ME.code).sort((a, b) => (b.date + b.tFrom).localeCompare(a.date + a.tFrom));
  const fresh = (c) => Date.now() - Date.parse(c.ts) < 9.5 * 60000;
  return `
  <div class="card hero"><div class="row"><h2 class="spacer">سجل تواجدك</h2><span class="note" data-date></span><b class="clock" data-clock></b></div>
  <p class="note">لما تضغط، الموقع بيتسجل مرة واحدة بس والوقت من السيرفر. مفيش تتبع في الخلفية، ومديرك بيشوف التسجيل ويقدر يعلق عليه.</p>
  <form class="add" id="checkForm">
    <label>أنا دلوقتي<select name="kind">${opts(CHECK_KINDS, "office")}</select></label>
    <label>المكان<input type="text" name="place" placeholder="مثال: مكتب سموحة / موقع المشروع"></label>
    <label class="wide">ملاحظة<input type="text" name="note"></label>
    <fieldset class="wide meetbox"><legend>لو اجتماع مع عميل (بيروح لمديرك يعتمده)</legend><div class="add">
      <label>اسم العميل<input type="text" name="client"></label><label>موبايل العميل<input type="tel" name="phone" dir="ltr"></label>
      <label>المشروع<input type="text" name="project"></label><label>مصدر العميل<select name="source">${opts(SOURCES, "", "-")}</select></label>
      <label>هيخلص حوالي<input type="time" name="tTo"></label><label>النتيجة<select name="result">${opts(RESULTS, "", "-")}</select></label></div></fieldset>
    <div><button class="btn primary" type="submit" id="checkBtn">سجل موقعي دلوقتي</button></div>
  </form></div>
  <div class="card"><h2>تسجيلاتي الشهر ده</h2><div class="tbl flat"><table><thead><tr><th>الوقت</th><th>النوع</th><th>المكان</th><th>الموقع</th><th>ملاحظة</th><th></th></tr></thead><tbody>
  ${mine.map((c) => `<tr><td>${fmtTs(c.ts)}</td><td>${esc(checkKind(c.kind))}</td><td>${esc(c.place)}</td><td>${mapLink(c.lat, c.lng)} ${officeTag(c)}${c.accuracy ? ` <span class="note">±${c.accuracy}م</span>` : ""}</td><td>${esc(c.note)}</td>
    <td>${fresh(c) ? `<button class="btn danger" data-chkdel="${c.id}">إلغاء</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="6">${empty("map-pin", "مفيش تسجيلات الشهر ده", "اضغط (سجل موقعي دلوقتي) فوق أول ما توصل.")}</td></tr>`}
  </tbody></table></div></div>
  <div class="card"><h2>اجتماعاتي</h2>
  ${meets.map((m) => `<div class="act"><div class="row">${pill(m.status)}<b>${esc(m.kind || "اجتماع")}${m.client ? ` - ${esc(m.client)}` : ""}</b><span class="note">${fmtDate(m.date)} ${to12(toMin(m.tFrom))} - ${to12(toMin(m.tTo))}</span>${mapLink(m.lat, m.lng)}</div>
    <div class="note">${[m.project, m.place, m.result].filter(Boolean).map(esc).join(" · ")}</div>
    ${m.rawStatus === "pending" ? `<div class="row"><label class="row field-inline">النتيجة<select data-myres="${m.id}">${opts(RESULTS, m.result, "-")}</select></label><label class="row field-inline">خلص الساعة<input type="time" data-myto="${m.id}" value="${m.tTo}"></label><button class="btn danger" data-mymdel="${m.id}">سحب</button></div>` : ""}
    ${m.decisionNote ? `<div class="note">رد المدير: ${esc(m.decisionNote)}</div>` : ""}
    ${thread("meetings", m.id)}</div>`).join("") || empty("briefcase", "مفيش اجتماعات الشهر ده", "لما تكون مع عميل، اختار (اجتماع مع عميل) واكتب بياناته.")}</div>`;
}

// ---------------------------------------------------------------- live team board
const liveMeet = (m) => ({ id: m.id, code: m.code, kind: m.kind || "", client: m.client || "", project: m.project || "", place: m.place || "", result: m.result || "",
  date: m.date, tFrom: String(m.time_from).slice(0, 5), tTo: String(m.time_to).slice(0, 5), status: db.toAr(m.status), rawStatus: m.status,
  decisionNote: m.decision_note || "", lat: m.lat, lng: m.lng });
function live() {
  if (!LIVE) return '<p class="note">جاري التحميل...</p>';
  const now = toMin(nowHM()), lm = LIVE.meetings.map(liveMeet);
  const rows = staff().filter((e) => e.code !== ME.code || R.admin).map((e) => {
    const last = LIVE.checkins.find((c) => c.code === e.code);
    const ps = LIVE.punches.filter((p) => p.code === e.code).map((p) => toMin(String(p.ts).replace("T", " ").slice(11, 16)));
    const ms = lm.filter((m) => m.code === e.code);
    const inMeet = ms.find((m) => m.rawStatus !== "rejected" && toMin(m.tFrom) <= now && now <= toMin(m.tTo));
    let st = '<span class="pill p-mute">لم يسجل</span>';
    if (inMeet) st = '<span class="pill p-info">في اجتماع</span>';
    else if (last?.kind === "leave") st = '<span class="pill p-mute">غادر</span>';
    else if (last) st = `<span class="pill p-ok">${esc(checkKind(last.kind))}</span>`;
    else if (ps.length) st = '<span class="pill p-ok">بصم</span>';
    return { e, last, ps, ms, st, rank: inMeet ? 0 : last ? 1 : ps.length ? 2 : 3 };
  }).sort((a, b) => a.rank - b.rank || empName(a.e).localeCompare(empName(b.e), "ar"));
  const pend = S.meetings.filter((m) => m.rawStatus === "pending" && canDecideMeet(m));
  const todayRest = lm.filter((m) => !pend.some((p) => p.id === m.id));
  return `
  <div class="card hero"><div class="row"><h2 class="spacer">الفريق النهارده</h2><span class="note" data-date></span><b class="clock" data-clock></b></div>
  <p class="note">بيتحدث تلقائي كل 30 ثانية، آخر تحديث ${esc(LIVE_AT)}. تسجيل التواجد بيظهر على طول، والبصمة بتظهر بعد رفع ملف الجهاز.</p>
  <div class="kpis"><div class="kpi"><span>سجلوا تواجد</span><b>${rows.filter((r) => r.last).length}</b></div><div class="kpi"><span>في اجتماع دلوقتي</span><b>${rows.filter((r) => r.rank === 0).length}</b></div>
    <div class="kpi"><span>اجتماعات النهارده</span><b>${lm.length}</b></div><div class="kpi ${rows.some((r) => r.rank === 3) ? "bad" : ""}"><span>لم يسجل</span><b>${rows.filter((r) => r.rank === 3).length}</b></div></div>
  <div><button class="btn" id="liveNow">تحديث دلوقتي</button></div></div>
  <div class="tbl"><table><thead><tr><th>الموظف</th><th>الحالة</th><th>آخر تسجيل</th><th>المكان</th><th>البصمة</th><th>اجتماعات النهارده</th></tr></thead><tbody>
  ${rows.map((r) => `<tr><td>${esc(empName(r.e))}</td><td>${r.st}</td><td>${r.last ? to12(toMin(r.last.time)) : ""}</td>
    <td>${r.last ? `${esc(r.last.place)} ${mapLink(r.last.lat, r.last.lng)} ${officeTag(r.last)}` : ""}</td>
    <td>${r.ps.length ? `${to12(r.ps[0])}${r.ps.length > 1 ? ` - ${to12(r.ps[r.ps.length - 1])}` : ""}` : ""}</td>
    <td>${r.ms.map((m) => `${pill(m.status)} ${to12(toMin(m.tFrom))} ${esc(m.client)}`).join("<br>")}</td></tr>`).join("") || `<tr><td colspan="6">${empty("users", "مفيش موظفين في فريقك", "اطلب من مدير النظام يحددك كمدير لفريقك.")}</td></tr>`}
  </tbody></table></div>
  <div class="card"><h2>اجتماعات مستنية قرارك (${pend.length})</h2>${pend.map(meetCard).join("") || empty("check", "مفيش اجتماعات مستنية قرارك")}</div>
  <div class="card"><h2>باقي اجتماعات النهارده</h2>${todayRest.map(meetCard).join("") || empty("briefcase", "مفيش اجتماعات تانية النهارده")}</div>`;
}
function meetCard(m) {
  return `<div class="act"><div class="row">${pill(m.status)}<b>${esc(nameOf(m.code))}</b><span>${esc(m.kind)}${m.client ? ` - ${esc(m.client)}` : ""}</span><span class="note">${fmtDate(m.date)} ${to12(toMin(m.tFrom))} - ${to12(toMin(m.tTo))}</span>${mapLink(m.lat, m.lng)}</div>
    <div class="note">${[m.project, m.place, m.result].filter(Boolean).map(esc).join(" · ")}</div>
    ${m.rawStatus === "pending" && canDecideMeet(m) ? `<div class="row"><button class="btn ok" data-mdec="${m.id}" data-s="معتمد">اعتماد</button><button class="btn danger" data-mdec="${m.id}" data-s="مرفوض">رفض</button><input type="text" data-mnote="${m.id}" placeholder="رأيك أو ملاحظتك (اختياري)" class="grow" aria-label="ملاحظة"></div>` : ""}
    ${m.decisionNote ? `<div class="note">القرار: ${esc(m.decisionNote)}</div>` : ""}
    ${thread("meetings", m.id)}</div>`;
}

// ---------------------------------------------------------------- penalties and bonuses
function suggestStep(code, policyId, day) {
  const p = S.policy.find((x) => String(x.id) === String(policyId)); if (!p || !p.steps.length || !code || !day) return null;
  const n = S.actions.filter((a) => a.code === code && String(a.policyId) === String(policyId) && a.day.slice(0, 7) === day.slice(0, 7) && ["pending", "approved"].includes(a.status)).length;
  return { occ: n + 1, step: p.steps[Math.min(n, p.steps.length - 1)] };
}
const stepText = (x) => (x.kind === "warning" ? "إنذار" : x.kind === "days" ? `${x.value} يوم` : `${x.value} جنيه`);
function actions() {
  const list = S.actions.slice().sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1) || b.day.localeCompare(a.day));
  const team = staff().filter((e) => R.admin || e.code !== ME.code);
  const rate = (code) => N0(empBy(code)?.salary) / (N0(E.st.workDays) || 30);
  return `
  <div class="card"><h2>${R.admin ? "جزاء أو منحة" : "اقتراح جزاء أو منحة"}</h2>
  <p class="note">${R.admin ? "اللي بتسجله بيتعتمد على طول ويوصل للموظف إشعار بالقيمة والسبب." : "اقتراحك بيروح لمدير النظام يعتمده، وبعد الاعتماد بس بيوصل للموظف."} لو اخترت بند من اللائحة، الجزاء بيتقترح حسب عدد المرات في الشهر.</p>
  <form class="add" id="actForm">
    <label>الموظف<select name="code" required>${empOpts("", "اختار", team)}</select></label>
    <label>النوع<select name="kind">${opts(Object.entries(KIND_AR), "penalty")}</select></label>
    <label>بند اللائحة<select name="policyId">${opts(S.policy.filter((p) => p.active).map((p) => [p.id, `${p.ref ? p.ref + " - " : ""}${p.title}`]), "", "بدون بند")}</select></label>
    <label>التاريخ<input type="date" name="day" required value="${today()}"></label>
    <label>أيام<input type="number" name="days" step="0.25" min="0" value="0"></label>
    <label>مبلغ (جنيه)<input type="number" name="amount" step="any" min="0" value="0"></label>
    <label class="wide">السبب (بيظهر للموظف)<input type="text" name="reason" required maxlength="500"></label>
    <div class="wide note" id="actHint"></div>
    <div><button class="btn primary" type="submit">${R.admin ? "تسجيل" : "إرسال للاعتماد"}</button></div></form></div>
  <div class="tbl"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>النوع</th><th>القيمة</th><th>السبب</th><th>البند</th><th>الحالة</th><th>الموظف</th>${R.admin ? "<th>القرار</th>" : ""}</tr></thead><tbody>
  ${list.map((a) => `<tr><td>${fmtDate(a.day)}</td><td>${esc(nameOf(a.code))}</td><td>${kindPill(a.kind)}</td><td>${actValue(a, rate(a.code))}</td><td class="wrap">${esc(a.reason)}</td>
    <td>${a.policyId ? esc(S.policy.find((p) => p.id === a.policyId)?.title || "") + (a.occurrence ? ` (${a.occurrence})` : "") : ""}</td><td>${pill(ACT_ST[a.status])}</td>
    <td>${a.status !== "approved" ? "" : a.objection ? `<span class="pill p-warn">تظلم</span><div class="note" style="white-space:normal">${esc(a.objection)}</div>` : a.ackAt ? '<span class="pill p-ok">اطلع</span>' : '<span class="pill p-mute">لم يطلع</span>'}</td>
    ${R.admin ? `<td><div class="row nowrap">${a.status !== "approved" ? `<button class="btn ok" data-adec="${a.id}" data-s="approved">اعتماد</button>` : ""}${a.status === "pending" ? `<button class="btn danger" data-adec="${a.id}" data-s="rejected">رفض</button>` : ""}${a.status === "approved" ? `<button class="btn danger" data-adec="${a.id}" data-s="cancelled">إلغاء</button>` : ""}</div>
      <input type="text" class="plain" data-anote="${a.id}" placeholder="ملاحظة / رد على التظلم" value="${esc(a.decisionNote)}" style="width:200px" aria-label="ملاحظة"></td>` : ""}</tr>`).join("") || `<tr><td colspan="${R.admin ? 9 : 8}">${empty("gavel", "مفيش جزاءات أو منح الشهر ده")}</td></tr>`}
  </tbody></table></div>`;
}

function badge() { const n = S.perms.filter((p) => p.rawStatus === "pending" && canDecide(p)).length; return n ? `<span class="badge">${n}</span>` : ""; }
const canDecide = (p) => R.admin || (R.manager && p.code !== ME.code && S.employees.some((e) => e.code === p.code));

function pill(s) {
  const m = { "حاضر": "p-ok", "حاضر - مهمة خارجية": "p-ok", "مهمة خارجية": "p-info", "تأخير": "p-warn", "انصراف مبكر": "p-warn", "تأخير وانصراف مبكر": "p-warn", "بصمة ناقصة": "p-warn", "غياب": "p-bad", "إجازة": "p-acc", "إجازة أسبوعية": "p-mute", "إجازة رسمية": "p-mute", "لم يأتِ بعد": "p-mute", "معفى من البصمة": "p-info", "معتمد": "p-ok", "قيد المراجعة": "p-warn", "مرفوض": "p-bad" };
  return `<span class="pill ${m[s] || "p-mute"}">${esc(s)}</span>`;
}
const staff = () => S.employees.filter((e) => e.active !== false);

function dash(ym) {
  const sums = staff().map((e) => E.summary(e, ym));
  const active = sums.filter((s) => !s.e.exempt && s.rows.some((r) => r.count > 0));
  const cm = active.filter((s) => s.commit != null);
  const avg = cm.length ? cm.reduce((a, s) => a + s.commit, 0) / cm.length : 0;
  const tot = (k) => sums.reduce((a, s) => a + s[k], 0);
  const pending = S.perms.filter((p) => p.rawStatus === "pending" && canDecide(p)).length;
  const days = monthDays(ym);
  const series = days.map((d) => { let p = 0, l = 0, a = 0, w = false; for (const e of staff()) { if (e.exempt) continue; const r = E.dayRow(e, d); if (r.type !== "يوم عمل" || r.future) continue; w = true; if (r.status === "غياب") a++; else if (/تأخير|انصراف|ناقصة/.test(r.status)) l++; else if (r.status !== "إجازة") p++; } return { d, p, l, a, w }; });
  const max = Math.max(1, ...series.map((s) => s.p + s.l + s.a));
  const W = 640, H = 200, pl = 28, pb = 22, bw = (W - pl - 8) / days.length, y = (v) => H - pb - (v / max) * (H - pb - 10);
  let bars = "";
  series.forEach((s, i) => {
    const x = pl + i * bw + 2, w = bw - 4;
    if (!s.w) { bars += `<rect x="${x}" y="${H - pb - 3}" width="${w}" height="3" fill="var(--line)"/>`; return; }
    let base = 0;
    [[s.p, "var(--ok)"], [s.l, "var(--warn)"], [s.a, "var(--bad)"]].forEach(([v, c]) => { if (!v) return; bars += `<rect x="${x}" y="${y(base + v)}" width="${w}" height="${y(base) - y(base + v)}" fill="${c}"><title>${fmtDate(s.d)}: ${v}</title></rect>`; base += v; });
    if (i % 3 === 0) bars += `<text x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${Number(s.d.slice(8))}</text>`;
  });
  const grid = [0, Math.round(max / 2), max].map((t) => `<line x1="${pl}" x2="${W - 4}" y1="${y(t)}" y2="${y(t)}" stroke="var(--line)" stroke-dasharray="2 3"/><text x="${pl - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("");
  const ranked = cm.slice().sort((a, b) => a.commit - b.commit);
  const rk = (s) => { const p = Math.round(s.commit * 100); return `<div class="r"><span title="${esc(empName(s.e))}">${esc(empName(s.e))}</span><span class="track"><i class="${p < 60 ? "low" : p < 80 ? "mid" : ""}" style="width:${p}%"></i></span><span class="num">${p}%</span></div>`; };
  return `
  ${pending ? `<div class="banner">فيه ${pending} طلب مستني قرارك. <button class="btn" data-go="requests">راجع الطلبات</button></div>` : ""}
  <div class="kpis">
    <div class="kpi"><span>موظفين بصموا الشهر ده</span><b>${active.length}</b></div>
    <div class="kpi ${avg >= 0.8 ? "ok" : avg < 0.6 ? "bad" : ""}"><span>متوسط الالتزام بالمواعيد</span><b>${Math.round(avg * 100)}%</b></div>
    <div class="kpi bad"><span>أيام غياب</span><b>${tot("abs")}</b></div>
    <div class="kpi"><span>مرات تأخير</span><b>${tot("latec")}</b></div>
    <div class="kpi"><span>بصمات ناقصة</span><b>${tot("miss")}</b></div>
    <div class="kpi"><span>اجتماعات عملاء</span><b>${tot("meetC")}</b></div>
  </div>
  <div class="grid2">
    <div class="card"><h2>الحضور يوم بيوم</h2>
      <div class="legend"><span><i style="background:var(--ok)"></i>في الميعاد</span><span><i style="background:var(--warn)"></i>تأخير أو انصراف مبكر أو بصمة ناقصة</span><span><i style="background:var(--bad)"></i>غياب</span></div>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="الحضور يوم بيوم: أعلى يوم فيه ${max} موظف. التفاصيل في الجدول المخفي بعده." style="width:100%;height:auto">${grid}${bars}</svg>
      <table class="sr-only"><caption>الحضور يوم بيوم</caption><thead><tr><th>اليوم</th><th>في الميعاد</th><th>تأخير أو ناقصة</th><th>غياب</th></tr></thead><tbody>${series.filter((x) => x.w).map((x) => `<tr><td>${fmtDate(x.d)}</td><td>${x.p}</td><td>${x.l}</td><td>${x.a}</td></tr>`).join("")}</tbody></table></div>
    <div class="card"><h2>الأقل التزامًا بالمواعيد</h2><div class="rank">${ranked.slice(0, 10).map(rk).join("") || empty("chart-bar", "مفيش بيانات للشهر ده", "ارفع ملف البصمة الأول.")}</div></div>
  </div>
  <div class="card"><h2>الأكثر التزامًا</h2><div class="rank">${ranked.slice().reverse().slice(0, 10).map(rk).join("")}</div></div>`;
}

function dailyTable(e, ym, editable) {
  const s = E.summary(e, ym);
  let rows = s.rows; if (dailyFilter) rows = rows.filter((r) => r.status.includes(dailyFilter));
  return `
  <div class="kpis">
    <div class="kpi"><span>أيام العمل</span><b>${s.req}</b></div><div class="kpi ${s.commit == null ? "" : s.commit >= 0.8 ? "ok" : s.commit < 0.6 ? "bad" : ""}"><span>الالتزام</span><b>${s.commit == null ? "-" : Math.round(s.commit * 100) + "%"}</b></div>
    <div class="kpi bad"><span>غياب</span><b>${s.abs}</b></div><div class="kpi"><span>تأخير (مرات / دقائق)</span><b>${s.latec} / ${s.latem}</b></div>
    <div class="kpi"><span>أيام الخصم</span><b>${n2(s.ddays)}</b></div></div>
  <div class="tbl"><table><thead><tr><th>التاريخ</th><th>اليوم</th><th>أول بصمة</th><th>آخر بصمة</th><th>ساعات</th><th>تأخير (د)</th><th>انصراف مبكر (د)</th><th>أذونات / اجتماعات (د)</th><th>الحالة</th><th>الخصم</th>${editable ? "<th>تعديل الخصم</th>" : ""}<th>ملاحظات</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="${r.type !== "يوم عمل" ? "off" : ""}"><td>${fmtDate(r.d)}</td><td>${DAYS[r.w]}</td><td>${to12(r.pin)}</td><td>${to12(r.pout)}</td><td class="num">${r.hrs == null ? "" : r.hrs.toFixed(1)}</td>
    <td class="num">${r.nlate || ""}</td><td class="num">${r.nearly || ""}</td><td class="num">${r.permMin + r.meetMin || ""}</td><td>${pill(r.status)}</td><td class="num">${r.fin ? n2(r.fin) : ""}</td>
    ${editable ? `<td><input type="number" step="0.25" min="0" style="width:80px" data-ov="${esc(r.key)}" value="${r.ov?.ded ?? ""}" placeholder="${r.calc ? n2(r.calc) : "-"}" aria-label="تعديل خصم ${r.d}"></td>
    <td><input type="text" class="plain" style="width:180px" data-ovn="${esc(r.key)}" value="${esc(r.ov?.note || "")}" aria-label="ملاحظة ${r.d}"></td>` : `<td>${esc(r.ov?.note || "")}</td>`}</tr>`).join("")}
  </tbody></table></div>`;
}

function daily(ym) {
  const list = staff();
  if (!dailyEmp || !empBy(dailyEmp)) dailyEmp = list[0]?.code || "";
  const e = empBy(dailyEmp); if (!e) return empty("users", "مفيش موظفين ظاهرين ليك");
  return `<div class="row"><label class="row field-inline">الموظف <select id="dailyEmp">${empOpts(dailyEmp, null, list)}</select></label>
    <label class="row field-inline">الحالة <select id="dailyFilter">${opts(["غياب", "تأخير", "انصراف مبكر", "بصمة ناقصة", "مهمة خارجية", "إجازة", "حاضر", "معفى"], dailyFilter, "الكل")}</select></label>
    <button class="btn" id="exportDaily">تصدير CSV</button></div>
  ${dailyTable(e, ym, R.admin)}
  ${R.admin ? '<p class="note">اكتب في (تعديل الخصم) الرقم اللي انت عايزه بالأيام، أو 0 لإلغاء الخصم.</p>' : ""}`;
}

// employee self-service: send requests, follow them, see own attendance
function mine(ym) {
  const e = empBy(ME.code);
  if (!e) return '<p class="note">حسابك مربوط بكود موظف مش ظاهر. كلم مدير النظام.</p>';
  const my = S.perms.filter((p) => p.code === ME.code).sort((a, b) => b.from.localeCompare(a.from));
  const used = E.permUsed(ME.code, ym), allow = N0(E.st.permAllowH) * 60;
  return `
  <div class="card"><h2>طلب إذن أو إجازة</h2>
  <p class="note">رصيد الأذونات ${n2(E.st.permAllowH)} ساعة في الشهر، المستخدم منه ${fmtMin(used)} والباقي ${fmtMin(Math.max(0, allow - used))}. الطلب بيروح لمدير فريقك يوافق عليه أو يرفضه.</p>
  <form class="add" id="myReqForm">
    <label>النوع<select name="type">${opts(PERM_TYPES)}</select></label>
    <label>من تاريخ<input type="date" name="from" required></label>
    <label>إلى تاريخ (للإجازات)<input type="date" name="to"></label>
    <label>من الساعة<input type="time" name="tFrom"></label>
    <label>إلى الساعة<input type="time" name="tTo"></label>
    <label class="wide">السبب / العذر<input type="text" name="note" required></label>
    <div><button class="btn primary" type="submit">إرسال الطلب</button></div>
  </form></div>
  <div class="card"><h2>طلباتي</h2><div class="tbl flat"><table><thead><tr><th>النوع</th><th>من</th><th>إلى</th><th>الوقت</th><th>السبب</th><th>الحالة</th><th>رد المدير</th><th></th></tr></thead><tbody>
  ${my.map((p) => `<tr><td>${esc(p.type)}</td><td>${fmtDate(p.from)}</td><td>${p.to ? fmtDate(p.to) : ""}</td><td>${p.tFrom ? `${to12(toMin(p.tFrom))} - ${to12(toMin(p.tTo))}` : ""}</td><td>${esc(p.note)}</td><td>${pill(p.status)}</td><td>${esc(p.decisionNote)}</td>
    <td>${p.rawStatus === "pending" ? `<button class="btn danger" data-rdel="${p.id}">سحب الطلب</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="8">${empty("calendar-event", "مفيش طلبات الشهر ده", "لو محتاج إذن أو إجازة، املا الفورم اللي فوق.")}</td></tr>`}
  </tbody></table></div></div>
  <h2>حضوري</h2>
  ${dailyTable(e, ym, false)}`;
}

function requests(ym) {
  let list = S.perms.slice().sort((a, b) => (a.rawStatus === "pending" ? 0 : 1) - (b.rawStatus === "pending" ? 0 : 1) || b.from.localeCompare(a.from));
  if (reqFilter) list = list.filter((p) => p.rawStatus === reqFilter);
  return `
  <div class="row"><label class="row field-inline">عرض <select id="reqFilter">${opts([["pending", "مستني قرار"], ["approved", "معتمد"], ["rejected", "مرفوض"]], reqFilter, "الكل")}</select></label>
  <p class="note">${R.admin ? "انت شايف طلبات كل الموظفين." : "انت شايف طلبات فريقك بس. طلباتك انت بيوافق عليها مدير النظام."}</p></div>
  <div class="tbl"><table><thead><tr><th>الموظف</th><th>النوع</th><th>من</th><th>إلى</th><th>الوقت</th><th>المدة</th><th>من الرصيد</th><th>السبب</th><th>الحالة</th><th>القرار</th></tr></thead><tbody>
  ${list.map((p) => { const L = E.ledger[p.id]; return `<tr><td>${esc(nameOf(p.code))}</td><td>${esc(p.type)}</td><td>${fmtDate(p.from)}</td><td>${p.to ? fmtDate(p.to) : ""}</td><td>${p.tFrom ? `${to12(toMin(p.tFrom))} - ${to12(toMin(p.tTo))}` : ""}</td><td class="num">${dur(p.tFrom, p.tTo) || ""}</td>
    <td class="num">${L ? `${L.charge}${L.over ? ' <span class="pill p-bad">تجاوز الرصيد</span>' : ""}` : ""}</td><td>${esc(p.note)}</td><td>${pill(p.status)}</td>
    <td>${canDecide(p) ? `<div class="row nowrap"><button class="btn ok" data-decide="${p.id}" data-s="معتمد">موافقة</button><button class="btn danger" data-decide="${p.id}" data-s="مرفوض">رفض</button>${p.rawStatus !== "pending" ? `<button class="btn" data-decide="${p.id}" data-s="قيد المراجعة">إرجاع</button>` : ""}</div><input type="text" class="plain" style="width:200px" data-dnote="${p.id}" placeholder="ملاحظة للموظف (اختياري)" aria-label="ملاحظة القرار">` : '<span class="note">-</span>'}
    ${p.decisionNote ? `<div class="note">${esc(p.decisionNote)}</div>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="10">${empty("clipboard-check", "مفيش طلبات هنا", "غيّر (عرض) لـ (الكل) عشان تشوف الطلبات اللي اتقرر فيها.")}</td></tr>`}
  </tbody></table></div>
  ${R.admin ? `<div class="card"><h2>تسجيل إذن أو إجازة لموظف (مدير النظام)</h2><form class="add" id="permForm">
    <label>الموظف<select name="code" required>${empOpts("", "اختار")}</select></label>
    <label>النوع<select name="type">${opts(PERM_TYPES)}</select></label>
    <label>من تاريخ<input type="date" name="from" required></label><label>إلى تاريخ<input type="date" name="to"></label>
    <label>من الساعة<input type="time" name="tFrom"></label><label>إلى الساعة<input type="time" name="tTo"></label>
    <label>الحالة<select name="status">${opts(STATUSES, "معتمد")}</select></label>
    <label class="wide">السبب<input type="text" name="note"></label><div><button class="btn primary" type="submit">إضافة</button></div></form></div>` : ""}`;
}

function meet(ym) {
  const canWrite = R.meetings;
  const list = S.meetings.filter((m) => m.date.startsWith(ym)).sort((a, b) => (b.date + b.tFrom).localeCompare(a.date + a.tFrom));
  const p = meetPrefill || {}; meetPrefill = null;
  return `
  ${canWrite ? `<div class="card"><h2>تسجيل اجتماع أو مأمورية</h2>
  <p class="note">الاجتماع المعتمد وقته مش بيتحسب تأخير أو غياب.</p>
  <form class="add" id="meetForm">
    <label>الموظف<select name="code" required>${empOpts(p.code || "", "اختار")}</select></label>
    <label>التاريخ<input type="date" name="date" required value="${p.date || ""}"></label>
    <label>من<input type="time" name="tFrom" required value="${E.st.in}"></label><label>إلى<input type="time" name="tTo" required></label>
    <label>نوع المهمة<select name="kind">${opts(MEET_KINDS)}</select></label>
    <label>اسم العميل<input type="text" name="client"></label><label>موبايل العميل<input type="tel" name="phone" dir="ltr"></label>
    <label>المشروع<input type="text" name="project"></label><label>مكان الاجتماع<input type="text" name="place"></label>
    <label>مصدر العميل<select name="source">${opts(SOURCES, "", "-")}</select></label>
    <label>نتيجة الاجتماع<select name="result">${opts(RESULTS, "", "-")}</select></label>
    <label>ميعاد المتابعة<input type="date" name="follow"></label>
    <label>الحالة<select name="status">${opts(STATUSES, "معتمد")}</select></label>
    <label class="wide">ملاحظات<input type="text" name="note"></label>
    <div><button class="btn primary" type="submit">إضافة الاجتماع</button></div></form></div>` : '<p class="note">انت شايف اجتماعات فريقك. التسجيل لمستخدم الاجتماعات.</p>'}
  ${S.meetings.some((m) => m.rawStatus === "pending" && canDecideMeet(m)) ? `<div class="banner">فيه اجتماعات سجلها الموظفين من الموقع مستنية اعتماد. <button class="btn" data-go="live">راجعها</button></div>` : ""}
  <div class="tbl"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>الوقت</th><th>النوع</th><th>العميل</th><th>الموبايل</th><th>المشروع</th><th>المكان</th><th>المصدر</th><th>النتيجة</th><th>متابعة</th><th>الحالة</th><th>ملاحظات</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
  ${list.map((m) => `<tr><td>${fmtDate(m.date)}</td><td>${esc(nameOf(m.code))}</td><td>${to12(toMin(m.tFrom))} - ${to12(toMin(m.tTo))}</td><td>${esc(m.kind)}</td><td>${esc(m.client)}</td><td dir="ltr">${esc(m.phone)}</td><td>${esc(m.project)}</td><td>${esc(m.place)} ${mapLink(m.lat, m.lng)}</td><td>${esc(m.source)}</td>
    <td>${canWrite ? `<select data-mres="${m.id}">${opts(RESULTS, m.result, "-")}</select>` : esc(m.result)}</td><td>${m.follow ? fmtDate(m.follow) : ""}</td>
    <td>${canWrite ? `<select data-mstat="${m.id}">${opts(STATUSES, m.status)}</select>` : pill(m.status)}</td><td>${esc(m.note)}</td>
    ${canWrite ? `<td><button class="btn danger" data-mdel="${m.id}">حذف</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="14">${empty("briefcase", "مفيش اجتماعات الشهر ده")}</td></tr>`}
  </tbody></table></div>`;
}

function upload() {
  const counts = Object.entries(S.punches).map(([c, l]) => [c, l.length]);
  return `<div class="card"><h2>رفع كشف البصمة</h2>
    <p class="note">ارفع ملف التصدير من جهاز البصمة (.xls زي ملف سبتمبر، أو CSV). البصمات المتكررة مش بتتضاف مرتين.${R.admin ? " الأكواد الجديدة بتتضاف للموظفين." : " لو فيه أكواد جديدة، مدير النظام هيضيفهم للموظفين."}</p>
    <div class="row"><input type="file" id="imp" accept=".xls,.csv,.txt" aria-label="ملف البصمة"><span class="note" id="impMsg"></span></div></div>
  <div class="card"><h2>بصمات الشهر ده</h2><p class="note">${counts.reduce((a, [, n]) => a + n, 0)} بصمة لـ ${counts.length} كود. آخر يوم فيه بصمات: ${LAST || "-"}.</p></div>`;
}

function sum(ym) {
  const sums = staff().map((e) => E.summary(e, ym));
  const T = (k) => sums.reduce((a, s) => a + s[k], 0);
  return `<div class="row"><p class="note spacer">ملخص الحضور حسب بصمات الجهاز وقواعد الإعدادات.</p><button class="btn" id="exportSum">تصدير CSV</button></div>
  <div class="tbl"><table><thead><tr><th>الكود</th><th>الاسم</th><th>الفريق</th><th>أيام العمل</th><th>حضور</th><th>غياب</th><th>إجازات</th><th>تأخير (مرات)</th><th>تأخير (دقائق)</th><th>انصراف مبكر</th><th>بصمة ناقصة</th><th>أذونات (س)</th><th>اجتماعات</th><th>حجوزات</th><th>الالتزام</th><th>أيام الخصم</th></tr></thead><tbody>
  ${sums.map((s) => { const p = s.commit == null ? null : Math.round(s.commit * 100); return `<tr><td>${esc(s.e.code)}</td><td><button class="btn" style="padding:2px 8px" data-emp="${esc(s.e.code)}">${esc(empName(s.e))}</button></td><td>${esc(teamOf(s.e.teamId)?.name || "")}</td>
    <td class="num">${s.req}</td><td class="num">${s.pres}</td><td class="num">${s.abs ? `<span class="pill ${s.abs >= 2 ? "p-bad" : "p-warn"}">${s.abs}</span>` : 0}</td><td class="num">${s.lv}</td><td class="num">${s.latec}</td><td class="num">${s.latem}</td><td class="num">${s.earlyc}</td><td class="num">${s.miss}</td>
    <td class="num">${s.permH ? `<span class="pill ${s.permOver ? "p-bad" : "p-mute"}">${n2(s.permH)}</span>` : ""}</td><td class="num">${s.meetC || ""}</td><td class="num">${s.deals || ""}</td>
    <td class="num">${s.e.exempt ? '<span class="pill p-info">معفى</span>' : p == null ? "-" : `<span class="pill ${p >= 80 ? "p-ok" : p >= 60 ? "p-warn" : "p-bad"}">${p}%</span>`}</td><td class="num"><b>${n2(s.ddays)}</b></td></tr>`; }).join("")}
  <tr><th></th><th>الإجمالي</th><th></th><th></th><th></th><th>${T("abs")}</th><th>${T("lv")}</th><th>${T("latec")}</th><th>${T("latem")}</th><th>${T("earlyc")}</th><th>${T("miss")}</th><th>${n2(T("permH"))}</th><th>${T("meetC")}</th><th>${T("deals")}</th><th></th><th>${n2(T("ddays"))}</th></tr>
  </tbody></table></div>`;
}

const payRows = (ym) => S.employees.filter((e) => N0(e.salary) > 0 || S.payroll?.[ym]?.[e.code]).map((e) => E.payRow(e, ym));
function pay(ym) {
  const all = payRows(ym);
  let rows = all;
  if (payFilter === "bank") rows = all.filter((r) => r.method === "bank");
  if (payFilter === "cash") rows = all.filter((r) => r.method === "cash");
  if (payFilter === "noacc") rows = all.filter((r) => r.method === "bank" && !r.e.account);
  if (payFilter === "diff") rows = all.filter((r) => r.appr != null && Math.abs(r.appr - r.s.ddays) > 0.001);
  const T = (list, k) => list.reduce((a, r) => a + r[k], 0), pos = (list) => list.reduce((a, r) => a + Math.max(0, r.rnd), 0);
  const bank = all.filter((r) => r.method === "bank"), cash = all.filter((r) => r.method === "cash"), noAcc = bank.filter((r) => !r.e.account).length;
  const inp = (r, f, w = 80) => `<input type="number" step="any" style="width:${w}px" data-pay="${esc(r.e.code)}" data-f="${f}" value="${has(r.p[f]) && (r.p[f] !== 0 || f === "approvedDays") ? r.p[f] : ""}" aria-label="${f}">`;
  return `
  <div class="kpis">
    <div class="kpi"><span>صافي الرواتب (بعد التقريب)</span><b>${money(pos(all))}</b></div>
    <div class="kpi ok"><span>تحويل بنكي (${bank.length} موظف)</span><b>${money(pos(bank))}</b></div>
    <div class="kpi"><span>نقدي (${cash.length} موظف)</span><b>${money(pos(cash))}</b></div>
    <div class="kpi"><span>إجمالي الاستحقاقات</span><b>${money(T(all, "earn"))}</b></div>
    <div class="kpi bad"><span>إجمالي الاستقطاعات</span><b>${money(T(all, "ded"))}</b></div></div>
  ${noAcc ? `<div class="banner">فيه ${noAcc} موظف طريقة صرفهم بنك ومالهمش رقم حساب. <button class="btn" data-payf="noacc">اعرضهم</button></div>` : ""}
  <div class="row"><label class="row field-inline">عرض <select id="payFilter">${opts([["bank", "تحويل بنكي"], ["cash", "نقدي"], ["noacc", "بنك من غير رقم حساب"], ["diff", "أيام الخصم مختلفة عن الحضور"]], payFilter, "الكل")}</select></label>
    <span class="spacer"></span><button class="btn" id="exportPay">كشف المرتبات CSV</button><button class="btn" id="exportBank">ملف التحويل البنكي CSV</button><button class="btn" id="exportCash">كشف النقدي CSV</button></div>
  <p class="note">سعر اليوم = الراتب ÷ ${E.st.workDays}. أيام الخصم المعتمدة من كشف المرتبات، ولو فاضية بتتحسب من الحضور. الصافي بيتقرب لأقرب 5 جنيه.</p>
  <div class="tbl"><table><thead><tr><th>الكود</th><th>الاسم</th><th>الوظيفة</th><th>الراتب</th><th>سعر اليوم</th><th>عمولات</th><th>مردودات</th><th>الاستحقاقات</th><th>أيام الخصم المعتمدة</th><th>خصم التأخير</th><th>خصم مبلغ ثابت</th><th>خصومات إدارية</th><th>خصومات الأيام</th><th>تطبيق اللائحة</th><th>سلف</th><th>جزاءات / منح النظام</th><th>الاستقطاعات</th><th>الصافي</th><th>طريقة الصرف</th><th>رقم الحساب</th><th>ملاحظة</th></tr></thead><tbody>
  ${rows.map((r) => { const c = esc(r.e.code), diff = r.appr != null && Math.abs(r.appr - r.s.ddays) > 0.001; return `<tr><td>${c}</td><td>${esc(empName(r.e))}</td><td>${esc(r.e.job)}</td>
    <td><input type="number" style="width:90px" data-e="${c}" data-f="salary" value="${r.sal || ""}"></td><td class="num">${n2(r.rate)}</td><td>${inp(r, "commission")}</td><td>${inp(r, "ret")}</td><td class="num"><b>${money(r.earn)}</b></td>
    <td>${inp(r, "approvedDays", 70)}<div class="note">الحضور: ${n2(r.s.ddays)}${diff ? ' <span class="pill p-warn">مختلف</span>' : ""}</div></td>
    <td class="num">${money(r.late)}</td><td>${inp(r, "lateAmt")}</td><td>${inp(r, "adminDed")}</td><td>${inp(r, "daysDed")}</td><td>${inp(r, "regDed")}</td><td>${inp(r, "advance")}</td>
    <td class="num">${r.pen ? `<span class="pill p-bad">-${money(r.pen)}</span>` : ""}${r.bonus ? ` <span class="pill p-ok">+${money(r.bonus)}</span>` : ""}</td>
    <td class="num"><b>${money(r.ded)}</b></td><td class="num"><b>${r.rnd < 0 ? `<span class="pill p-bad">${money(r.rnd)}</span>` : money(r.rnd)}</b></td>
    <td><select data-e="${c}" data-f="pay">${opts([["bank", "بنك"], ["cash", "نقدي"]], r.method)}</select>${r.method === "bank" && !r.e.account ? '<div><span class="pill p-bad">مفيش رقم حساب</span></div>' : ""}</td>
    <td><input type="text" dir="ltr" style="width:110px" data-e="${c}" data-f="account" value="${esc(r.e.account)}"></td>
    <td><input type="text" class="plain" style="width:120px" data-pay="${c}" data-f="note" value="${esc(r.p.note || "")}"></td></tr>`; }).join("")}
  <tr><th></th><th>الإجمالي (${rows.length})</th><th></th><th>${money(T(rows, "sal"))}</th><th></th><th></th><th></th><th>${money(T(rows, "earn"))}</th><th>${n2(T(rows, "days"))}</th><th>${money(T(rows, "late"))}</th><th></th><th></th><th></th><th></th><th></th><th>${T(rows, "pen") || T(rows, "bonus") ? `-${money(T(rows, "pen"))} / +${money(T(rows, "bonus"))}` : ""}</th><th>${money(T(rows, "ded"))}</th><th>${money(T(rows, "rnd"))}</th><th></th><th></th><th></th></tr>
  </tbody></table></div>`;
}

function emp() {
  let list = S.employees;
  if (empFilter === "nameless") list = list.filter((e) => !e.name?.trim());
  if (empFilter === "exempt") list = list.filter((e) => e.exempt);
  if (empFilter === "noteam") list = list.filter((e) => !has(e.teamId));
  const teamOpts = (sel) => opts(S.teams.map((t) => [t.id, t.name]), sel, "بدون فريق");
  return `<div class="row"><label class="row field-inline">عرض <select id="empFilter">${opts([["nameless", "بدون اسم"], ["exempt", "مرفوع عنهم البصمة"], ["noteam", "بدون فريق"]], empFilter, "كل الموظفين")}</select></label>
  <p class="note">أي تعديل بيتحفظ على طول. الفرق ومديرينها بتتعدل من (الإعدادات والفرق).</p></div>
  <div class="tbl"><table><thead><tr><th>الكود</th><th>الاسم</th><th>الفريق</th><th>الوظيفة</th><th>حضور خاص</th><th>انصراف خاص</th><th>يوم راحة</th><th>مرفوع عنه البصمة</th><th>شغال</th><th>الاسم بالكامل (للبنك)</th><th>الراتب</th><th>رقم الحساب</th><th>طريقة الصرف</th></tr></thead><tbody>
  ${list.map((e) => { const c = esc(e.code); return `<tr class="${!e.name?.trim() ? "missing-name" : ""}${e.active === false ? " off" : ""}"><td>${c}</td>
    <td><input type="text" data-e="${c}" data-f="name" value="${esc(e.name)}" style="width:160px"></td>
    <td><select data-e="${c}" data-f="teamId">${teamOpts(e.teamId)}</select></td>
    <td><input type="text" data-e="${c}" data-f="job" value="${esc(e.job)}" style="width:110px"></td>
    <td><input type="time" data-e="${c}" data-f="in" value="${esc(e.in)}"></td><td><input type="time" data-e="${c}" data-f="out" value="${esc(e.out)}"></td>
    <td><select data-e="${c}" data-f="off">${opts(DAYS.map((d, i) => [i, d]), e.off, "لا يوجد")}</select></td>
    <td class="num"><input type="checkbox" data-e="${c}" data-f="exempt"${e.exempt ? " checked" : ""} aria-label="مرفوع عنه البصمة"></td>
    <td class="num"><input type="checkbox" data-e="${c}" data-f="active"${e.active !== false ? " checked" : ""} aria-label="شغال"></td>
    <td><input type="text" data-e="${c}" data-f="fullName" value="${esc(e.fullName)}" style="width:190px"></td>
    <td><input type="number" data-e="${c}" data-f="salary" value="${e.salary || ""}" style="width:90px"></td>
    <td><input type="text" dir="ltr" data-e="${c}" data-f="account" value="${esc(e.account)}" style="width:110px"></td>
    <td><select data-e="${c}" data-f="pay">${opts([["bank", "بنك"], ["cash", "نقدي"]], e.pay)}</select></td></tr>`; }).join("")}
  </tbody></table></div>
  <div class="card"><h2>إضافة موظف</h2><form class="add" id="empForm">
    <label>كود البصمة<input type="text" name="code" required></label><label>الاسم<input type="text" name="name" required></label>
    <label>الفريق<select name="teamId">${teamOpts("")}</select></label><div><button class="btn primary" type="submit">إضافة</button></div></form></div>`;
}

function settings() {
  const st = E.st;
  const tierT = (k, label) => `<div class="card"><h2>${label}</h2><table><thead><tr><th>من (دقيقة)</th><th>الخصم (يوم)</th><th></th></tr></thead><tbody>
    ${st[k].map((t, i) => `<tr><td><input type="number" min="0" class="w-sm" data-tier="${k}" data-i="${i}" data-j="0" value="${t[0]}" aria-label="${label}: الشريحة ${i + 1} من دقيقة"></td><td><input type="number" step="0.25" min="0" class="w-sm" data-tier="${k}" data-i="${i}" data-j="1" value="${t[1]}" aria-label="${label}: الشريحة ${i + 1} الخصم بالأيام"></td><td>${i ? `<button class="btn danger sm" data-tdel="${k}" data-i="${i}">حذف</button>` : ""}</td></tr>`).join("")}
    </tbody></table><div><button class="btn" data-tadd="${k}">إضافة شريحة</button></div></div>`;
  const members = (id) => S.employees.filter((e) => String(e.teamId) === String(id));
  const linked = new Set(S.users.map((u) => u.code).filter(Boolean));
  const invOf = (code) => S.invites.find((i) => i.code === code && !i.usedAt && Date.parse(i.expiresAt) > Date.now());
  const o = st.office || {};
  return `
  <div class="card"><h2>دخول الموظفين</h2>
  <p class="note">${linked.size} من ${S.employees.filter((e) => e.active !== false).length} موظف ليهم حساب. اعمل كود تفعيل للموظف وابعتهوله واتساب: يعمل حساب بإيميله، وبعدين يكتب الكود فيتربط بنفسه. الكود بيشتغل مرة واحدة ولمدة 14 يوم.</p>
  <form class="add" id="invForm">
    <label>الموظف<select name="code" required>${empOpts("", "اختار", S.employees.filter((e) => e.active !== false && !linked.has(e.code)))}</select></label>
    ${ROLES.filter(([r]) => r !== "admin").map(([r, l]) => `<label class="row" style="flex-direction:row;gap:6px;align-self:center"><input type="checkbox" name="role_${r}"> ${l}</label>`).join("")}
    <div><button class="btn primary" type="submit">اعمل كود تفعيل</button></div></form>
  ${INVITE ? `<div class="card" style="background:var(--ok-soft)"><b>كود ${esc(nameOf(INVITE.code))}: <span dir="ltr" style="font-size:20px;letter-spacing:2px">${esc(INVITE.token)}</span></b>
    <textarea id="invMsg" rows="6" readonly style="width:100%">${esc(inviteText(INVITE))}</textarea>
    <div class="row"><button class="btn" id="invCopy">نسخ الرسالة</button><a class="btn" target="_blank" rel="noopener noreferrer" href="https://wa.me/?text=${encodeURIComponent(inviteText(INVITE))}">إرسال واتساب</a></div></div>` : ""}
  <details><summary>الموظفين اللي لسه ملهمش حساب (${S.employees.filter((e) => e.active !== false && !linked.has(e.code)).length})</summary>
    <div class="tbl flat"><table><tbody>${S.employees.filter((e) => e.active !== false && !linked.has(e.code)).map((e) => `<tr><td>${esc(e.code)}</td><td>${esc(empName(e))}</td><td>${invOf(e.code) ? `<span class="pill p-warn">اتبعتله كود ينتهي ${fmtDate(invOf(e.code).expiresAt.slice(0, 10))}</span>` : '<span class="pill p-mute">مفيش كود</span>'}</td></tr>`).join("")}</tbody></table></div></details></div>

  <div class="card"><h2>لائحة الشركة</h2>
  <p class="note">كل بند ليه جزاء حسب عدد مرات تكراره في نفس الشهر. اكتب الجزاءات بالترتيب مفصولة بفاصلة، مثال: <b>إنذار، 0.25 يوم، 0.5 يوم، 1 يوم</b> أو <b>200 جنيه</b>. الموظف بيشوف اللائحة كاملة في صفحته.</p>
  <div class="tbl flat"><table><thead><tr><th>رقم</th><th>التصنيف</th><th>البند</th><th>التفاصيل</th><th>الجزاء بالتكرار</th><th>مفعّل</th><th></th></tr></thead><tbody>
  ${S.policy.map((p) => `<tr><td><input type="text" data-pol="${p.id}" data-f="ref" value="${esc(p.ref)}" style="width:60px" aria-label="رقم"></td>
    <td><input type="text" data-pol="${p.id}" data-f="category" value="${esc(p.category)}" style="width:110px" aria-label="التصنيف"></td>
    <td><input type="text" data-pol="${p.id}" data-f="title" value="${esc(p.title)}" style="width:200px" aria-label="البند"></td>
    <td><input type="text" data-pol="${p.id}" data-f="body" value="${esc(p.body)}" style="width:260px" aria-label="التفاصيل"></td>
    <td><input type="text" data-pol="${p.id}" data-f="steps" value="${esc(p.steps.map(stepText).join("، "))}" style="width:220px" aria-label="الجزاء"></td>
    <td class="num"><input type="checkbox" data-pol="${p.id}" data-f="active"${p.active ? " checked" : ""} aria-label="مفعّل"></td>
    <td><button class="btn danger" data-poldel="${p.id}">حذف</button></td></tr>`).join("") || `<tr><td colspan="7">${empty("file-text", "مفيش بنود لسه", "ضيف أول بند من الفورم اللي تحت.")}</td></tr>`}
  </tbody></table></div>
  <form class="add" id="polForm"><label>رقم البند<input type="text" name="ref"></label><label>التصنيف<input type="text" name="category" placeholder="مواعيد / سلوك / عملاء"></label>
    <label>البند<input type="text" name="title" required></label><label>الجزاء بالتكرار<input type="text" name="steps" placeholder="إنذار، 0.25 يوم، 0.5 يوم"></label>
    <label class="wide">التفاصيل<input type="text" name="body"></label><div><button class="btn primary" type="submit">إضافة بند</button></div></form>
  <form class="add"><label>أقصى جزاءات في الشهر (أيام، 0 = بدون حد)<input type="number" step="0.5" min="0" data-s="maxPenaltyDays" value="${st.maxPenaltyDays ?? 5}"></label></form></div>

  <div class="card"><h2>موقع المكتب</h2>
  <p class="note">بيُستخدم عشان تسجيل التواجد يبين (داخل المكتب) أو المسافة منه. افتح الصفحة من المكتب واضغط الزرار.</p>
  <div class="row"><span>${o.lat ? `${Number(o.lat).toFixed(5)}, ${Number(o.lng).toFixed(5)} ${mapLink(o.lat, o.lng)}` : "مش متحدد"}</span>
    <label class="row field-inline">نطاق المكتب (متر)<input type="number" min="20" step="10" data-office="radius" value="${o.radius || 150}" style="width:90px"></label>
    <button class="btn" id="setOffice">استخدم موقعي الحالي</button></div></div>

  <div class="card"><h2>سجل التعديلات</h2><p class="note">كل تعديل في المرتبات والموظفين والجزاءات والصلاحيات واللائحة بيتسجل باسم اللي عمله.</p>
  ${AUDIT ? auditView() : '<div><button class="btn" id="loadAudit">اعرض آخر 200 تعديل</button></div>'}</div>

  <div class="card"><h2>فحص الاتصال</h2><p class="note">لو الأرقام صفر أو فيه حاجة مش ظاهرة، اضغط الزرار وابعت صورة النتيجة.</p><div><button class="btn" id="diag">فحص الاتصال</button></div><div id="diagOut"></div></div>
  <div class="card"><h2>الفرق</h2>
  <p class="note">مدير الفريق بيوافق أو يرفض طلبات فريقه، وبيشوف حضورهم. لازم كمان يكون حسابه عليه دور (مدير فريق) تحت.</p>
  <div class="tbl flat"><table><thead><tr><th>الفريق</th><th>المدير</th><th>عدد الأفراد</th><th></th></tr></thead><tbody>
  ${S.teams.map((t) => `<tr><td><input type="text" data-team="${t.id}" data-f="name" value="${esc(t.name)}" style="width:160px"></td>
    <td><select data-team="${t.id}" data-f="manager">${empOpts(t.manager, "بدون مدير")}</select></td><td class="num">${members(t.id).length}</td>
    <td><button class="btn danger" data-teamdel="${t.id}">حذف</button></td></tr>`).join("")}
  </tbody></table></div>
  <form class="row" id="teamForm"><input type="text" name="name" placeholder="اسم الفريق الجديد" required><button class="btn" type="submit">إضافة فريق</button></form></div>

  <div class="card"><h2>المستخدمين والصلاحيات</h2>
  <p class="note">أي حد يعمل حساب من صفحة الدخول بيظهر هنا من غير صلاحيات. اربطه بكود الموظف بتاعه، وعلّم الأدوار اللي ليه. الموظف العادي مش محتاج أي دور: بيبعت طلباته ويشوف حضوره بس.</p>
  <div class="tbl flat"><table><thead><tr><th>الإيميل</th><th>الاسم</th><th>كود الموظف</th>${ROLES.map(([, l]) => `<th>${l}</th>`).join("")}<th></th></tr></thead><tbody>
  ${S.users.map((u) => `<tr class="${!u.code && !u.roles.length ? "missing-name" : ""}"><td dir="ltr">${esc(u.email)}</td><td>${esc(u.name)}</td>
    <td><select data-user="${esc(u.id)}" data-f="code">${empOpts(u.code, "غير مربوط")}</select></td>
    ${ROLES.map(([r]) => `<td class="num"><input type="checkbox" data-user="${esc(u.id)}" data-role="${r}"${u.roles.includes(r) ? " checked" : ""}${u.id === ME.id && r === "admin" ? " disabled" : ""} aria-label="${r}"></td>`).join("")}
    <td>${u.id === ME.id ? '<span class="note">انت</span>' : `<button class="btn danger" data-userdel="${esc(u.id)}">حذف</button>`}</td></tr>`).join("")}
  </tbody></table></div></div>

  <div class="card"><h2>المواعيد والقواعد</h2><form class="add">
    <label>ميعاد الحضور<input type="time" data-s="in" value="${st.in}"></label><label>ميعاد الانصراف<input type="time" data-s="out" value="${st.out}"></label>
    <label>عدد الأيام لحساب سعر اليوم<input type="number" data-s="workDays" value="${st.workDays}"></label>
    <label>خصم البصمة الناقصة (يوم)<input type="number" step="0.25" data-s="missDed" value="${st.missDed}"></label>
    <label>خصم الغياب بدون إذن (يوم)<input type="number" step="0.25" data-s="absDed" value="${st.absDed}"></label>
    <label>رصيد الأذونات الشهري (ساعات)<input type="number" step="0.5" data-s="permAllowH" value="${st.permAllowH}"></label>
    <label>وحدة خصم الإذن (دقيقة)<input type="number" step="15" min="0" data-s="permUnit" value="${st.permUnit}"></label></form>
  <div class="row"><span class="note">الإجازة الأسبوعية:</span>${DAYS.map((d, i) => `<label class="row" style="gap:4px"><input type="checkbox" data-wk="${i}"${st.weekend.includes(i) ? " checked" : ""}>${d}</label>`).join("")}</div></div>
  <div class="tiers">${tierT("lateTiers", "شرائح خصم التأخير")}${tierT("earlyTiers", "شرائح خصم الانصراف المبكر")}
  <div class="card"><h2>الإجازات الرسمية</h2>${(st.holidays || []).slice().sort().map((h) => `<div class="row"><span>${h.split("-").reverse().join("/")}</span><button class="btn danger" data-hdel="${h}">حذف</button></div>`).join("")}
    <div class="row"><input type="date" id="hNew" aria-label="تاريخ الإجازة الرسمية الجديدة"><button class="btn" id="hAdd">${icon("plus")}إضافة</button></div></div></div>`;
}

const SITE = location.origin + location.pathname;
const inviteText = (i) => `أهلاً ${nameOf(i.code)}،\nده رابط نظام الحضور والمرتبات في Everest:\n${SITE}\n1) اختار (حساب جديد) واعمل حساب بإيميلك وباسورد قوي.\n2) اكتب كود التفعيل ده: ${i.token}\nالكود لمرة واحدة وصالح 14 يوم. متبعتوش لحد.`;

const TBL_AR = { employees: "الموظفين", employee_pay: "الرواتب", payroll: "كشف المرتبات", overrides: "تعديل خصم", actions: "جزاءات ومنح", policy_items: "اللائحة", app_users: "الصلاحيات", settings: "الإعدادات", teams: "الفرق", invites: "أكواد التفعيل" };
const OP_AR = { INSERT: "إضافة", UPDATE: "تعديل", DELETE: "حذف" };
function auditView() {
  const who = (id) => S.users.find((u) => u.id === id)?.email || (id ? id.slice(0, 8) : "النظام");
  const diff = (a) => {
    if (a.op !== "UPDATE") { const r = a.new || a.old || {}; return esc(r.code || r.name || r.title || r.email || ""); }
    return Object.keys(a.new || {}).filter((k) => JSON.stringify(a.old?.[k]) !== JSON.stringify(a.new[k]) && k !== "token_hash")
      .map((k) => `${esc(k)}: ${esc(JSON.stringify(a.old?.[k] ?? "")).slice(0, 40)} ← ${esc(JSON.stringify(a.new[k] ?? "")).slice(0, 40)}`).join("<br>");
  };
  return `<div class="tbl flat" style="max-height:420px"><table><thead><tr><th>الوقت</th><th>مين</th><th>الجدول</th><th>العملية</th><th>الكود</th><th>التغيير</th></tr></thead><tbody>
  ${AUDIT.map((a) => `<tr><td>${fmtTs(a.at)}</td><td dir="ltr">${esc(who(a.actor))}</td><td>${TBL_AR[a.tbl] || esc(a.tbl)}</td><td>${OP_AR[a.op] || a.op}</td><td>${esc((a.new || a.old || {}).code || (a.new || a.old || {}).employee_code || "")}</td><td class="wrap">${diff(a)}</td></tr>`).join("")}
  </tbody></table></div>`;
}
// "إنذار، 0.25 يوم، 200 جنيه" <-> [{kind:"warning"},{kind:"days",value:0.25},{kind:"amount",value:200}]
function parseSteps(t) {
  return String(t || "").split(/[,،\n]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    if (/إنذار|انذار|لفت/.test(x)) return { kind: "warning" };
    const v = Number((x.match(/[\d.]+/) || [])[0]);
    if (!v) return null;
    return /جنيه|ج/.test(x) ? { kind: "amount", value: v } : { kind: "days", value: v };
  }).filter(Boolean);
}

// ---------------------------------------------------------------- csv
function saveCsv(name, rows) {
  const csv = "﻿" + rows.map((r) => r.map((c) => { c = String(c ?? ""); return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------------- settings writes
function settingsData() { const { ...d } = E.st; return d; }
const saveSettings = (mut) => act(async () => { const d = settingsData(); mut(d); await db.saveSettings(d); }, "اتحفظ");

// ---------------------------------------------------------------- events
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("button"); if (!t || busy) return;
  const d = t.dataset;
  if (d.tab || d.go) {
    const sheet = $("#moreSheet"); if (sheet.open) sheet.close();
    await go(d.tab || d.go);
    if (d.tab) $("#main").focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
    return;
  }
  if (t.id === "moreBtn") { $("#moreSheet").showModal(); $("#moreSheet .nav-item")?.focus(); return; }
  if (t.id === "menuBtn") { toggleMenu(); return; }
  if (d.themeSet) { setTheme(d.themeSet); return; }
  if (d.tip != null) { const box = $("#calTip"); if (box) box.textContent = d.tip; return; }
  if (t.id === "pwToggle") { const i = $("#loginForm [name=password]"), on = i.type === "password"; i.type = on ? "text" : "password"; t.setAttribute("aria-pressed", String(on)); t.setAttribute("aria-label", on ? "إخفاء الباسورد" : "إظهار الباسورد"); t.innerHTML = icon(on ? "eye-off" : "eye"); return; }
  if (t.id === "loadComp") { t.disabled = true; t.textContent = "جاري التحميل..."; try { await loadComparison(); } catch (e) { toast(errMsg(e), true); COMP = null; } render(); return; }
  if (t.id === "liveNow") { loadLive(); return; }
  if (t.id === "loadAudit") { try { AUDIT = await db.audit(200); } catch (e) { toast(errMsg(e), true); } render(); return; }
  if (t.id === "invCopy") { navigator.clipboard?.writeText($("#invMsg").value).then(() => toast("اتنسخت")); return; }
  if (t.id === "setOffice") {
    t.disabled = true;
    try { const p = await locate(); saveSettings((s) => { s.office = { ...(s.office || {}), lat: p.lat, lng: p.lng, radius: s.office?.radius || 150 }; }); }
    catch (e) { toast(e.message, true); t.disabled = false; }
    return;
  }
  if (d.ack) { act(() => db.ackAction(Number(d.ack)), "تمام، اتسجل إنك اطلعت"); return; }
  if (d.obj) { const v = document.querySelector(`[data-objt="${d.obj}"]`)?.value.trim(); if (!v) { toast("اكتب سبب التظلم الأول", true); return; } act(() => db.ackAction(Number(d.obj), v), "اتبعت التظلم للإدارة"); return; }
  if (d.adec) { const note = document.querySelector(`[data-anote="${d.adec}"]`)?.value || ""; act(() => db.decideAction(Number(d.adec), d.s, note), d.s === "approved" ? "اتعتمد ووصل للموظف" : "اتسجل"); return; }
  if (d.mdec) { const note = document.querySelector(`[data-mnote="${d.mdec}"]`)?.value || ""; act(async () => { await db.decideMeeting(Number(d.mdec), d.s, note); LIVE = null; }, d.s === "معتمد" ? "اتعتمد الاجتماع" : "اترفض الاجتماع"); return; }
  if (d.chkdel) { act(() => db.deleteCheckin(Number(d.chkdel)), "اتلغى التسجيل"); return; }
  if (d.mymdel) { act(() => db.deleteMeeting(Number(d.mymdel)), "اتسحب الاجتماع"); return; }
  if (d.poldel) { if (await ask("تحذف البند ده من اللائحة؟", "الجزاءات اللي اتسجلت عليه قبل كده هتفضل موجودة.", "حذف", true)) act(() => db.deletePolicy(Number(d.poldel)), "اتحذف البند"); return; }
  if (d.emp) { dailyEmp = d.emp; tab = "daily"; render(); return; }
  if (d.payf) { payFilter = d.payf; render(); return; }
  if (t.id === "diag") {
    const box = $("#diagOut"); box.textContent = "جاري الفحص...";
    const rows = await db.diagnose(S.meta.month);
    rows.push(["محمّل في الصفحة", `موظفين ${S.employees.length}، أكواد ليها بصمات ${Object.keys(S.punches).length}، آخر يوم ${LAST || "-"}، الشهور ${MONTHS.join(",") || "-"}`]);
    box.innerHTML = `<div class="tbl flat"><table><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="wrap" dir="auto">${esc(v)}</td></tr>`).join("")}</tbody></table></div>`;
    return;
  }
  if (t.id === "refresh") { closeMenu(); LAST = await db.lastPunchDay().catch(() => LAST); await refresh(); toast("البيانات اتحدثت"); return; }
  if (t.id === "logout" || t.id === "logout2") { await db.signOut(); location.reload(); return; }
  if (t.id === "claim") { try { const ok = await db.claimAdmin(); if (ok) location.reload(); else toast("فيه مدير نظام بالفعل. اطلب منه يفعّل حسابك.", true); } catch (e) { toast(errMsg(e), true); } return; }
  if (d.decide) { const note = document.querySelector(`[data-dnote="${d.decide}"]`)?.value || ""; act(() => db.decideRequest(Number(d.decide), d.s, note), d.s === "معتمد" ? "اتوافق على الطلب" : d.s === "مرفوض" ? "اترفض الطلب" : "رجع للمراجعة"); return; }
  if (d.rdel) { act(() => db.deleteRequest(Number(d.rdel)), "اتسحب الطلب"); return; }
  if (d.mdel) { act(() => db.deleteMeeting(Number(d.mdel)), "اتحذف"); return; }
  if (d.teamdel) { act(() => db.deleteTeam(Number(d.teamdel)), "اتحذف الفريق"); return; }
  if (d.userdel) { act(() => db.deleteUser(d.userdel), "اتحذف المستخدم"); return; }
  if (d.tadd) { saveSettings((s) => { const a = s[d.tadd]; a.push([(a.at(-1)?.[0] || 0) + 30, (a.at(-1)?.[1] || 0) + 0.25]); }); return; }
  if (d.tdel) { saveSettings((s) => s[d.tdel].splice(Number(d.i), 1)); return; }
  if (d.hdel) { saveSettings((s) => { s.holidays = (s.holidays || []).filter((h) => h !== d.hdel); }); return; }
  if (t.id === "hAdd") { const v = $("#hNew").value; if (v) saveSettings((s) => { s.holidays = [...new Set([...(s.holidays || []), v])]; }); return; }
  const ym = S?.meta.month;
  if (t.id === "exportSum") { saveCsv(`ملخص-الحضور-${ym}.csv`, [["الكود", "الاسم", "أيام العمل", "حضور", "غياب", "إجازات", "مرات التأخير", "دقائق التأخير", "انصراف مبكر", "بصمة ناقصة", "ساعات الأذونات", "اجتماعات", "الالتزام %", "أيام الخصم"], ...staff().map((e) => { const s = E.summary(e, ym); return [e.code, empName(e), s.req, s.pres, s.abs, s.lv, s.latec, s.latem, s.earlyc, s.miss, n2(s.permH), s.meetC, s.commit == null ? "" : Math.round(s.commit * 100), n2(s.ddays)]; })]); return; }
  if (t.id === "exportDaily") { const e = empBy(dailyEmp), s = E.summary(e, ym); saveCsv(`حضور-${e.code}-${ym}.csv`, [["التاريخ", "اليوم", "أول بصمة", "آخر بصمة", "تأخير", "انصراف مبكر", "الحالة", "الخصم"], ...s.rows.map((r) => [r.d, DAYS[r.w], fmtMin(r.pin), fmtMin(r.pout), r.nlate ?? "", r.nearly ?? "", r.status, r.fin])]); return; }
  if (t.id === "exportPay") { saveCsv(`مرتبات-${ym}.csv`, [["الكود", "الاسم", "الاسم بالكامل", "الوظيفة", "الراتب", "عمولات", "مردودات", "منح النظام", "الاستحقاقات", "أيام الخصم", "خصم التأخير", "إدارية", "خصم أيام", "لائحة", "سلف", "جزاءات النظام", "الاستقطاعات", "الصافي", "طريقة الصرف", "رقم الحساب", "ملاحظة"], ...payRows(ym).map((r) => [r.e.code, empName(r.e), r.e.fullName, r.e.job, r.sal, N0(r.p.commission), N0(r.p.ret), Math.round(r.bonus), Math.round(r.earn), n2(r.days), Math.round(r.late), N0(r.p.adminDed), N0(r.p.daysDed), N0(r.p.regDed), N0(r.p.advance), Math.round(r.pen), Math.round(r.ded), r.rnd, r.method === "bank" ? "بنك" : "نقدي", r.e.account, r.p.note || ""])]); return; }
  if (t.id === "exportBank") { const b = payRows(ym).filter((r) => r.method === "bank" && r.rnd > 0); saveCsv(`تحويل-بنكي-${ym}.csv`, [["م", "الاسم", "رقم الحساب", "المبلغ"], ...b.map((r, i) => [i + 1, r.e.fullName || empName(r.e), r.e.account, r.rnd]), ["", "الإجمالي", "", b.reduce((a, r) => a + r.rnd, 0)]]); return; }
  if (t.id === "exportCash") { const c = payRows(ym).filter((r) => r.method === "cash" && r.rnd > 0); saveCsv(`صرف-نقدي-${ym}.csv`, [["م", "الكود", "الاسم", "المبلغ", "التوقيع"], ...c.map((r, i) => [i + 1, r.e.code, empName(r.e), r.rnd, ""]), ["", "", "الإجمالي", c.reduce((a, r) => a + r.rnd, 0), ""]]); return; }
});

document.addEventListener("change", async (ev) => {
  const t = ev.target, d = t.dataset; if (busy && t.id !== "month") return;
  if (t.id === "month") { refresh(t.value); return; }
  if (t.id === "dailyEmp") { dailyEmp = t.value; render(); return; }
  if (t.id === "dailyFilter") { dailyFilter = t.value; render(); return; }
  if (t.id === "empFilter") { empFilter = t.value; render(); return; }
  if (t.id === "payFilter") { payFilter = t.value; render(); return; }
  if (t.id === "reqFilter") { reqFilter = t.value; render(); return; }
  if (t.id === "imp" && t.files[0]) { importFile(t.files[0]); return; }
  if (d.e) {
    const v = t.type === "checkbox" ? t.checked : d.f === "salary" ? N0(t.value) : d.f === "teamId" || d.f === "off" ? (t.value === "" ? "" : Number(t.value)) : t.value.trim();
    act(async () => { await db.updateEmployee(d.e, d.f, v); if (d.f === "account" && v) await db.updateEmployee(d.e, "pay", "bank"); }, "اتحفظ");
    return;
  }
  if (d.pay) { act(() => db.setPayroll(S.meta.month, d.pay, d.f, d.f === "note" ? t.value : t.value === "" ? "" : Number(t.value)), "اتحفظ"); return; }
  if (d.ov != null) { const o = S.overrides[d.ov] || {}; const [code, day] = d.ov.split("|"); act(() => db.setOverride(code, day, t.value === "" ? "" : Number(t.value), o.note), "اتحفظ"); return; }
  if (d.ovn != null) { const o = S.overrides[d.ovn] || {}; const [code, day] = d.ovn.split("|"); act(() => db.setOverride(code, day, o.ded ?? "", t.value), "اتحفظ"); return; }
  if (d.mres) { act(() => db.updateMeeting(Number(d.mres), "result", t.value), "اتحفظ"); return; }
  if (d.myres) { act(() => db.updateMeeting(Number(d.myres), "result", t.value), "اتحفظ"); return; }
  if (d.myto) { act(() => db.updateMeeting(Number(d.myto), "tTo", t.value), "اتحفظ"); return; }
  if (d.pol) {
    const v = d.f === "active" ? t.checked : d.f === "steps" ? parseSteps(t.value) : t.value.trim();
    if (d.f === "title" && !v) { toast("البند لازم يكون ليه اسم", true); render(); return; }
    act(() => db.updatePolicy(Number(d.pol), { [d.f]: v === "" ? null : v }), "اتحفظ"); return;
  }
  if (d.office) { saveSettings((s) => { s.office = { ...(s.office || {}), [d.office]: Number(t.value) }; }); return; }
  if (t.form?.id === "actForm" && ["code", "policyId", "day", "kind"].includes(t.name)) { actHint(t.form); return; }
  if (d.mstat) { act(() => db.updateMeeting(Number(d.mstat), "status", t.value), "اتحفظ"); return; }
  if (d.team) { act(() => db.updateTeam(Number(d.team), { [d.f]: t.value }), "اتحفظ"); return; }
  if (d.user && d.f === "code") { act(() => db.updateUser(d.user, { code: t.value }), "اتحفظ"); return; }
  if (d.user && d.role) { const u = S.users.find((x) => x.id === d.user); const roles = new Set(u.roles); t.checked ? roles.add(d.role) : roles.delete(d.role); act(() => db.updateUser(d.user, { roles: [...roles] }), "اتحفظ"); return; }
  if (d.s) { saveSettings((s) => { s[d.s] = t.type === "time" ? t.value : Number(t.value); }); return; }
  if (d.wk != null) { const i = Number(d.wk); saveSettings((s) => { s.weekend = t.checked ? [...new Set([...s.weekend, i])] : s.weekend.filter((x) => x !== i); }); return; }
  if (d.tier) { saveSettings((s) => { s[d.tier][Number(d.i)][Number(d.j)] = Number(t.value); s[d.tier].sort((a, b) => a[0] - b[0]); }); return; }
});

document.addEventListener("submit", async (ev) => {
  ev.preventDefault(); if (busy) return;
  const f = ev.target, v = Object.fromEntries(new FormData(f));
  if (f.id === "loginForm") return login(v);
  if (f.id === "inviteForm") {
    const err = $("#invErr"), btn = f.querySelector("button[type=submit]"); err.textContent = ""; btn.disabled = true;
    try { const name = await db.redeemInvite(v.token); if (name) { toast(`أهلاً ${name}، حسابك اتفعل`); setTimeout(() => location.reload(), 800); return; } err.textContent = "الكود غلط أو اتستخدم قبل كده أو انتهى. اطلب كود جديد من الإدارة."; }
    catch (e) { err.textContent = /too many/.test(e.message) ? "محاولات كتير غلط. استنى ساعة وجرب تاني." : /already/.test(e.message) ? "الموظف ده ليه حساب بالفعل. لو ده انت، كلم الإدارة." : errMsg(e); }
    btn.disabled = false; f.token.focus();
    return;
  }
  if (f.classList.contains("cform")) { const body = v.body.trim(); if (!body) return; const tbl = f.dataset.ct, id = Number(f.dataset.cid); try { await db.addComment(tbl, id, body); await loadThreads(tbl, [id]); render(); } catch (e) { toast(errMsg(e), true); } return; }
  if (f.id === "checkForm") return checkIn(v);
  if (f.id === "actForm") {
    if (!N0(v.days) && !N0(v.amount) && v.kind !== "warning") { toast("حدد عدد أيام أو مبلغ", true); return; }
    act(() => db.proposeAction(v), R.admin ? "اتسجل ووصل للموظف" : "اتبعت لمدير النظام يعتمده"); return;
  }
  if (f.id === "polForm") { act(() => db.addPolicy({ ref: v.ref || null, category: v.category || null, title: v.title.trim(), body: v.body || null, steps: parseSteps(v.steps), sort: S.policy.length + 1 }), "اتضاف البند"); return; }
  if (f.id === "invForm") {
    const roles = ROLES.map(([r]) => r).filter((r) => v[`role_${r}`]);
    try { const token = await db.createInvite(v.code, roles); INVITE = { code: v.code, token }; await refresh(); } catch (e) { toast(errMsg(e), true); }
    return;
  }
  if (f.id === "myReqForm") {
    if (!v.type.startsWith("إجازة") && dur(v.tFrom, v.tTo) <= 0) { toast("الإذن محتاج ساعة بداية ونهاية", true); return; }
    act(() => db.addRequest({ ...v, code: ME.code }), "اتبعت الطلب لمدير فريقك"); return;
  }
  if (f.id === "permForm") {
    if (!v.type.startsWith("إجازة") && dur(v.tFrom, v.tTo) <= 0) { toast("الإذن محتاج ساعة بداية ونهاية", true); return; }
    act(() => db.addRequest(v), "اتسجل"); return;
  }
  if (f.id === "meetForm") { if (dur(v.tFrom, v.tTo) <= 0) { toast("ميعاد النهاية لازم يكون بعد البداية", true); return; } act(() => db.addMeeting(v), "اتسجل الاجتماع"); return; }
  if (f.id === "empForm") { act(() => db.addEmployee(v.code.trim(), v.name.trim(), v.teamId), "اتضاف الموظف"); return; }
  if (f.id === "teamForm") { act(() => db.addTeam(v.name.trim()), "اتضاف الفريق"); return; }
});

function actHint(form) {
  const v = Object.fromEntries(new FormData(form)), box = $("#actHint");
  const sg = v.kind === "penalty" || v.kind === "warning" ? suggestStep(v.code, v.policyId, v.day) : null;
  if (!sg) { box.textContent = ""; return; }
  box.textContent = `دي المرة رقم ${sg.occ} الشهر ده، والجزاء حسب اللائحة: ${stepText(sg.step)}.`;
  form.days.value = sg.step.kind === "days" ? sg.step.value : 0;
  form.amount.value = sg.step.kind === "amount" ? sg.step.value : 0;
  form.kind.value = sg.step.kind === "warning" ? "warning" : "penalty";
  const p = S.policy.find((x) => String(x.id) === String(v.policyId));
  if (p && !form.reason.value) form.reason.value = `مخالفة بند ${p.ref ? p.ref + ": " : ""}${p.title}`;
}

// one check-in; a client meeting also files a pending meeting for the manager
async function checkIn(v) {
  const btn = $("#checkBtn"); btn.disabled = true; btn.textContent = "بحدد موقعك...";
  let pos = null;
  try { pos = await locate(); } catch (e) { if (!(await ask("مقدرتش أحدد موقعك", `${e.message}. تحب تسجل من غير موقع؟`, "سجل من غير موقع"))) { btn.disabled = false; btn.textContent = "سجل موقعي دلوقتي"; return; } }
  try {
    let meetingId = null;
    if (v.kind === "meeting" && v.client.trim()) {
      const from = nowHM(), to = v.tTo && v.tTo > from ? v.tTo : fmtMin(Math.min(23 * 60 + 59, toMin(from) + 60));
      meetingId = await db.addMeeting({ code: ME.code, date: today(), tFrom: from, tTo: to, kind: MEET_KINDS[0], client: v.client, phone: v.phone, project: v.project,
        place: v.place, source: v.source, result: v.result, note: v.note, status: "قيد المراجعة", ...(pos || {}) });
    }
    await db.addCheckin({ code: ME.code, kind: v.kind, place: v.place, note: v.note, meetingId, ...(pos || {}) });
    toast(meetingId ? "اتسجل تواجدك والاجتماع راح لمديرك" : `اتسجل تواجدك${pos ? "" : " (من غير موقع)"}`);
    await refresh();
  } catch (e) { toast(errMsg(e), true); btn.disabled = false; btn.textContent = "سجل موقعي دلوقتي"; }
}

async function login(v) {
  const btn = $("#loginBtn"), err = $("#loginErr"), label = btn.textContent;
  err.textContent = "";
  if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) { err.textContent = "اكتب إيميل صحيح."; $("#loginForm [name=email]").focus(); return; }
  if (v.password.length < 8) { err.textContent = "الباسورد لازم يكون 8 حروف أو أكتر."; $("#loginForm [name=password]").focus(); return; }
  btn.disabled = true; btn.textContent = "لحظة...";
  try {
    if (v.mode === "signup") { await db.signUp(v.email.trim(), v.password, v.name?.trim() || ""); }
    await db.signIn(v.email.trim(), v.password);
    location.reload();
  } catch (e) {
    err.textContent = v.mode === "signup" ? `مقدرتش أعمل الحساب: ${e.message || e}` : "الإيميل أو الباسورد غلط. جرب تاني.";
  } finally { btn.disabled = false; btn.textContent = label; }
}
document.addEventListener("input", (ev) => {
  if (ev.target.name === "mode") {
    const signup = ev.target.value === "signup";
    $("#nameRow").hidden = !signup; $("#pwHint").hidden = !signup;
    $("#loginBtn").textContent = signup ? "إنشاء الحساب" : "دخول";
    $("#loginForm [name=password]").autocomplete = signup ? "new-password" : "current-password";
  }
});

// header menu: theme, refresh, sign out
function toggleMenu(force) {
  const pop = $("#menuPop"), b = $("#menuBtn"), open = force ?? pop.hidden;
  pop.hidden = !open; b.setAttribute("aria-expanded", String(open));
  if (open) { syncTheme(); pop.querySelector("button")?.focus(); }
}
const closeMenu = () => { if (!$("#menuPop").hidden) toggleMenu(false); };
function setTheme(t) {
  try { if (t === "auto") localStorage.removeItem("hr-theme"); else localStorage.setItem("hr-theme", t); } catch { /* storage blocked: applies for this visit only */ }
  if (t === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  syncTheme();
}
function syncTheme() { const cur = document.documentElement.dataset.theme || "auto"; document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.themeSet === cur))); }
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("#menuPop").hidden) { toggleMenu(false); $("#menuBtn").focus(); } });
document.addEventListener("click", (ev) => { if (!ev.target.closest(".menu")) closeMenu(); });
$("#moreSheet").addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) ev.currentTarget.close(); });


async function importFile(file) {
  const msg = $("#impMsg");
  let res;
  try { res = await readExport(file); } catch (e) { msg.textContent = e.message === "ole" ? "الملف ده بصيغة Excel أحدث. افتحه واحفظه CSV وارفعه تاني." : "مقدرتش أقرا الملف."; return; }
  if (!res.punches.length) { msg.textContent = "مفيش بصمات في الملف."; return; }
  const known = new Set(S.employees.map((e) => e.code));
  const newCodes = Object.keys(res.names).filter((c) => !known.has(c));
  try {
    busy = true;
    await db.addPunches(res.punches, (n, all) => (msg.textContent = `جاري الرفع ${n} من ${all}...`));
    if (R.admin) for (const c of newCodes) { const nm = res.names[c]; await db.addEmployee(c, nm && nm !== c ? nm : `موظف ${c}`, ""); }
    busy = false;
    MONTHS = await db.months().catch(() => MONTHS); LAST = await db.lastPunchDay().catch(() => LAST);
    const target = res.punches.map((p) => p[1].slice(0, 7)).sort().pop();
    toast(`اترفع ${res.punches.length} بصمة.${newCodes.length ? ` فيه ${newCodes.length} كود جديد${R.admin ? " اتضاف للموظفين" : "، مدير النظام هيضيفهم"}.` : ""}`);
    await refresh(target);
  } catch (e) { busy = false; msg.textContent = errMsg(e); }
}

boot();
