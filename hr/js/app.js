import * as db from "./db.js";
import { DAYS, toMin, dur, monthDays, createEngine, readExport } from "./engine.js";

const PERM_TYPES = ["إذن تأخير", "إذن انصراف مبكر", "إذن خلال اليوم", "إجازة اعتيادية", "إجازة عارضة", "إجازة مرضية", "إجازة بدون مرتب"];
const STATUSES = ["معتمد", "قيد المراجعة", "مرفوض"];
const MEET_KINDS = ["اجتماع مع عميل خارج المكتب", "معاينة موقع مع عميل", "اجتماع مع عميل في المكتب", "مأمورية عمل", "معرض / إيفنت"];
const RESULTS = ["حجز / تعاقد", "مهتم", "متابعة لاحقة", "غير مهتم", "لم يحضر العميل"];
const SOURCES = ["فيسبوك", "إنستجرام", "جوجل", "تيك توك", "واتساب", "ترشيح (ريفرال)", "مكالمة واردة", "زيارة مباشرة", "معرض"];
const ROLES = [["admin", "مدير النظام"], ["uploader", "رفع البصمة"], ["meetings", "الاجتماعات"], ["manager", "مدير فريق"]];

// tab id, label, who sees it
const TABS = [
  ["dash", "لوحة المتابعة", (r) => r.admin || r.manager || r.uploader],
  ["mine", "طلباتي وحضوري", (r) => !!r.code],
  ["requests", "الأذونات والإجازات", (r) => r.admin || r.manager],
  ["daily", "الحضور اليومي", (r) => r.admin || r.manager || r.uploader],
  ["meet", "اجتماعات العملاء", (r) => r.admin || r.meetings || r.manager],
  ["upload", "رفع البصمة", (r) => r.uploader],
  ["sum", "ملخص الحضور", (r) => r.admin || r.manager],
  ["pay", "المرتبات", (r) => r.admin],
  ["emp", "الموظفين", (r) => r.admin],
  ["set", "الإعدادات والفرق", (r) => r.admin],
];

let ME = null, R = {}, S = null, E = null, MONTHS = [], LAST = "";
let tab = "", dailyEmp = "", dailyFilter = "", empFilter = "", payFilter = "", reqFilter = "pending", meetPrefill = null, busy = false;

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMin = (m) => (m == null ? "" : String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
const to12 = (m) => { if (m == null) return ""; let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, "0"), p = h >= 12 ? "م" : "ص"; h = h % 12 || 12; return `${h}:${mm} ${p}`; };
const n2 = (v) => (Math.round(v * 100) / 100).toLocaleString("en-US");
const money = (v) => Math.round(v).toLocaleString("en-US");
const fmtDate = (d) => { const [, m, dd] = d.split("-"); return `${dd}/${m}`; };
const empName = (e) => e?.name?.trim() || `بدون اسم - ${e?.code ?? ""}`;
const empBy = (code) => S.employees.find((e) => e.code === code);
const nameOf = (code) => (empBy(code) ? empName(empBy(code)) : code);
const teamOf = (id) => S.teams.find((t) => String(t.id) === String(id));
const has = (v) => v !== "" && v != null;
const N0 = (v) => Number(v) || 0;
const opts = (list, sel, blank) => (blank != null ? `<option value="">${esc(blank)}</option>` : "") +
  list.map((v) => { const [val, lab] = Array.isArray(v) ? v : [v, v]; return `<option value="${esc(val)}"${String(val) === String(sel) ? " selected" : ""}>${esc(lab)}</option>`; }).join("");
const empOpts = (sel, blank, list = S.employees) => opts(list.map((e) => [e.code, `${e.code} - ${empName(e)}`]), sel, blank);

function toast(t, bad) { const el = $("#toast"); el.textContent = t; el.classList.toggle("bad", !!bad); el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), 4000); }
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
  const cur = new Date().toISOString().slice(0, 7);
  await refresh(MONTHS[0] || cur);
}

function show(view) { for (const v of ["setup", "login", "pending", "app"]) $(`#view-${v}`).hidden = v !== view; }

async function refresh(month = S?.meta.month) {
  busy = true; $("#main").setAttribute("aria-busy", "true");
  try {
    S = await db.load(month, R.admin);
    E = createEngine(S, LAST);
    if (!tab || !visibleTabs().some(([k]) => k === tab)) tab = visibleTabs()[0][0];
    render();
  } catch (e) { toast(errMsg(e), true); }
  finally { busy = false; $("#main").removeAttribute("aria-busy"); }
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); }
  catch (e) { toast(errMsg(e), true); render(); }
}

const visibleTabs = () => TABS.filter(([, , f]) => f(R));

// ---------------------------------------------------------------- render
function render() {
  $("#tabs").innerHTML = visibleTabs().map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="${k === tab}">${l}${k === "requests" ? badge() : ""}</button>`).join("");
  const set = new Set([S.meta.month, ...MONTHS]);
  $("#month").innerHTML = opts([...set].sort().reverse().map((m) => [m, m.split("-").reverse().join(" / ")]), S.meta.month);
  $("#roleChips").innerHTML = (R.admin ? [["admin", "مدير النظام"]] : ROLES.filter(([r]) => ME.roles.includes(r))).map(([, l]) => `<span class="pill p-acc">${l}</span>`).join("") + (ME.code ? `<span class="pill p-mute">${esc(nameOf(ME.code))}</span>` : "");
  const views = { dash, mine, requests, daily, meet, upload, sum, pay, emp, set: settings };
  $("#main").innerHTML = `<section class="panel">${views[tab](S.meta.month)}</section>`;
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
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="الحضور اليومي" style="width:100%;height:auto">${grid}${bars}</svg></div>
    <div class="card"><h2>الأقل التزامًا بالمواعيد</h2><div class="rank">${ranked.slice(0, 10).map(rk).join("") || '<p class="note">مفيش بيانات للشهر ده.</p>'}</div></div>
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
  const e = empBy(dailyEmp); if (!e) return '<p class="note">مفيش موظفين ظاهرين ليك.</p>';
  return `<div class="row"><label class="row" style="gap:6px">الموظف <select id="dailyEmp">${empOpts(dailyEmp, null, list)}</select></label>
    <label class="row" style="gap:6px">الحالة <select id="dailyFilter">${opts(["غياب", "تأخير", "انصراف مبكر", "بصمة ناقصة", "مهمة خارجية", "إجازة", "حاضر", "معفى"], dailyFilter, "الكل")}</select></label>
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
  <div class="card"><h2>طلباتي</h2><div class="tbl" style="border:0"><table><thead><tr><th>النوع</th><th>من</th><th>إلى</th><th>الوقت</th><th>السبب</th><th>الحالة</th><th>رد المدير</th><th></th></tr></thead><tbody>
  ${my.map((p) => `<tr><td>${esc(p.type)}</td><td>${fmtDate(p.from)}</td><td>${p.to ? fmtDate(p.to) : ""}</td><td>${p.tFrom ? `${to12(toMin(p.tFrom))} - ${to12(toMin(p.tTo))}` : ""}</td><td>${esc(p.note)}</td><td>${pill(p.status)}</td><td>${esc(p.decisionNote)}</td>
    <td>${p.rawStatus === "pending" ? `<button class="btn danger" data-rdel="${p.id}">سحب الطلب</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="8" class="note">مفيش طلبات في الشهر ده.</td></tr>'}
  </tbody></table></div></div>
  <h2>حضوري</h2>
  ${dailyTable(e, ym, false)}`;
}

function requests(ym) {
  let list = S.perms.slice().sort((a, b) => (a.rawStatus === "pending" ? 0 : 1) - (b.rawStatus === "pending" ? 0 : 1) || b.from.localeCompare(a.from));
  if (reqFilter) list = list.filter((p) => p.rawStatus === reqFilter);
  return `
  <div class="row"><label class="row" style="gap:6px">عرض <select id="reqFilter">${opts([["pending", "مستني قرار"], ["approved", "معتمد"], ["rejected", "مرفوض"]], reqFilter, "الكل")}</select></label>
  <p class="note">${R.admin ? "انت شايف طلبات كل الموظفين." : "انت شايف طلبات فريقك بس. طلباتك انت بيوافق عليها مدير النظام."}</p></div>
  <div class="tbl"><table><thead><tr><th>الموظف</th><th>النوع</th><th>من</th><th>إلى</th><th>الوقت</th><th>المدة</th><th>من الرصيد</th><th>السبب</th><th>الحالة</th><th>القرار</th></tr></thead><tbody>
  ${list.map((p) => { const L = E.ledger[p.id]; return `<tr><td>${esc(nameOf(p.code))}</td><td>${esc(p.type)}</td><td>${fmtDate(p.from)}</td><td>${p.to ? fmtDate(p.to) : ""}</td><td>${p.tFrom ? `${to12(toMin(p.tFrom))} - ${to12(toMin(p.tTo))}` : ""}</td><td class="num">${dur(p.tFrom, p.tTo) || ""}</td>
    <td class="num">${L ? `${L.charge}${L.over ? ' <span class="pill p-bad">تجاوز الرصيد</span>' : ""}` : ""}</td><td>${esc(p.note)}</td><td>${pill(p.status)}</td>
    <td>${canDecide(p) ? `<div class="row" style="gap:4px;flex-wrap:nowrap"><button class="btn ok" data-decide="${p.id}" data-s="معتمد">موافقة</button><button class="btn danger" data-decide="${p.id}" data-s="مرفوض">رفض</button>${p.rawStatus !== "pending" ? `<button class="btn" data-decide="${p.id}" data-s="قيد المراجعة">إرجاع</button>` : ""}</div><input type="text" class="plain" style="width:200px" data-dnote="${p.id}" placeholder="ملاحظة للموظف (اختياري)" aria-label="ملاحظة القرار">` : '<span class="note">-</span>'}
    ${p.decisionNote ? `<div class="note">${esc(p.decisionNote)}</div>` : ""}</td></tr>`; }).join("") || '<tr><td colspan="10" class="note">مفيش طلبات هنا.</td></tr>'}
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
  <div class="tbl"><table><thead><tr><th>التاريخ</th><th>الموظف</th><th>الوقت</th><th>النوع</th><th>العميل</th><th>الموبايل</th><th>المشروع</th><th>المكان</th><th>المصدر</th><th>النتيجة</th><th>متابعة</th><th>الحالة</th><th>ملاحظات</th>${canWrite ? "<th></th>" : ""}</tr></thead><tbody>
  ${list.map((m) => `<tr><td>${fmtDate(m.date)}</td><td>${esc(nameOf(m.code))}</td><td>${to12(toMin(m.tFrom))} - ${to12(toMin(m.tTo))}</td><td>${esc(m.kind)}</td><td>${esc(m.client)}</td><td dir="ltr">${esc(m.phone)}</td><td>${esc(m.project)}</td><td>${esc(m.place)}</td><td>${esc(m.source)}</td>
    <td>${canWrite ? `<select data-mres="${m.id}">${opts(RESULTS, m.result, "-")}</select>` : esc(m.result)}</td><td>${m.follow ? fmtDate(m.follow) : ""}</td>
    <td>${canWrite ? `<select data-mstat="${m.id}">${opts(STATUSES, m.status)}</select>` : pill(m.status)}</td><td>${esc(m.note)}</td>
    ${canWrite ? `<td><button class="btn danger" data-mdel="${m.id}">حذف</button></td>` : ""}</tr>`).join("") || '<tr><td colspan="14" class="note">مفيش اجتماعات في الشهر ده.</td></tr>'}
  </tbody></table></div>`;
}

function upload() {
  const counts = Object.entries(S.punches).map(([c, l]) => [c, l.length]);
  return `<div class="card"><h2>رفع كشف البصمة</h2>
    <p class="note">ارفع ملف التصدير من جهاز البصمة (.xls زي ملف سبتمبر، أو CSV). البصمات المتكررة مش بتتضاف مرتين.${R.admin ? " الأكواد الجديدة بتتضاف للموظفين." : " لو فيه أكواد جديدة، مدير النظام هيضيفهم للموظفين."}</p>
    <div class="row"><input type="file" id="imp" accept=".xls,.csv,.txt"><span class="note" id="impMsg"></span></div></div>
  <div class="card"><h2>بصمات الشهر ده</h2><p class="note">${counts.reduce((a, [, n]) => a + n, 0)} بصمة لـ ${counts.length} كود. آخر يوم فيه بصمات: ${LAST || "-"}.</p></div>`;
}

function sum(ym) {
  const sums = staff().map((e) => E.summary(e, ym));
  const T = (k) => sums.reduce((a, s) => a + s[k], 0);
  return `<div class="row"><p class="note" style="margin-inline-end:auto">ملخص الحضور حسب بصمات الجهاز وقواعد الإعدادات.</p><button class="btn" id="exportSum">تصدير CSV</button></div>
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
  <div class="row"><label class="row" style="gap:6px">عرض <select id="payFilter">${opts([["bank", "تحويل بنكي"], ["cash", "نقدي"], ["noacc", "بنك من غير رقم حساب"], ["diff", "أيام الخصم مختلفة عن الحضور"]], payFilter, "الكل")}</select></label>
    <span style="margin-inline-end:auto"></span><button class="btn" id="exportPay">كشف المرتبات CSV</button><button class="btn" id="exportBank">ملف التحويل البنكي CSV</button><button class="btn" id="exportCash">كشف النقدي CSV</button></div>
  <p class="note">سعر اليوم = الراتب ÷ ${E.st.workDays}. أيام الخصم المعتمدة من كشف المرتبات، ولو فاضية بتتحسب من الحضور. الصافي بيتقرب لأقرب 5 جنيه.</p>
  <div class="tbl"><table><thead><tr><th>الكود</th><th>الاسم</th><th>الوظيفة</th><th>الراتب</th><th>سعر اليوم</th><th>عمولات</th><th>مردودات</th><th>الاستحقاقات</th><th>أيام الخصم المعتمدة</th><th>خصم التأخير</th><th>خصم مبلغ ثابت</th><th>خصومات إدارية</th><th>خصومات الأيام</th><th>تطبيق اللائحة</th><th>سلف</th><th>الاستقطاعات</th><th>الصافي</th><th>طريقة الصرف</th><th>رقم الحساب</th><th>ملاحظة</th></tr></thead><tbody>
  ${rows.map((r) => { const c = esc(r.e.code), diff = r.appr != null && Math.abs(r.appr - r.s.ddays) > 0.001; return `<tr><td>${c}</td><td>${esc(empName(r.e))}</td><td>${esc(r.e.job)}</td>
    <td><input type="number" style="width:90px" data-e="${c}" data-f="salary" value="${r.sal || ""}"></td><td class="num">${n2(r.rate)}</td><td>${inp(r, "commission")}</td><td>${inp(r, "ret")}</td><td class="num"><b>${money(r.earn)}</b></td>
    <td>${inp(r, "approvedDays", 70)}<div class="note">الحضور: ${n2(r.s.ddays)}${diff ? ' <span class="pill p-warn">مختلف</span>' : ""}</div></td>
    <td class="num">${money(r.late)}</td><td>${inp(r, "lateAmt")}</td><td>${inp(r, "adminDed")}</td><td>${inp(r, "daysDed")}</td><td>${inp(r, "regDed")}</td><td>${inp(r, "advance")}</td>
    <td class="num"><b>${money(r.ded)}</b></td><td class="num"><b>${r.rnd < 0 ? `<span class="pill p-bad">${money(r.rnd)}</span>` : money(r.rnd)}</b></td>
    <td><select data-e="${c}" data-f="pay">${opts([["bank", "بنك"], ["cash", "نقدي"]], r.method)}</select>${r.method === "bank" && !r.e.account ? '<div><span class="pill p-bad">مفيش رقم حساب</span></div>' : ""}</td>
    <td><input type="text" dir="ltr" style="width:110px" data-e="${c}" data-f="account" value="${esc(r.e.account)}"></td>
    <td><input type="text" class="plain" style="width:120px" data-pay="${c}" data-f="note" value="${esc(r.p.note || "")}"></td></tr>`; }).join("")}
  <tr><th></th><th>الإجمالي (${rows.length})</th><th></th><th>${money(T(rows, "sal"))}</th><th></th><th></th><th></th><th>${money(T(rows, "earn"))}</th><th>${n2(T(rows, "days"))}</th><th>${money(T(rows, "late"))}</th><th></th><th></th><th></th><th></th><th></th><th>${money(T(rows, "ded"))}</th><th>${money(T(rows, "rnd"))}</th><th></th><th></th><th></th></tr>
  </tbody></table></div>`;
}

function emp() {
  let list = S.employees;
  if (empFilter === "nameless") list = list.filter((e) => !e.name?.trim());
  if (empFilter === "exempt") list = list.filter((e) => e.exempt);
  if (empFilter === "noteam") list = list.filter((e) => !has(e.teamId));
  const teamOpts = (sel) => opts(S.teams.map((t) => [t.id, t.name]), sel, "بدون فريق");
  return `<div class="row"><label class="row" style="gap:6px">عرض <select id="empFilter">${opts([["nameless", "بدون اسم"], ["exempt", "مرفوع عنهم البصمة"], ["noteam", "بدون فريق"]], empFilter, "كل الموظفين")}</select></label>
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
    ${st[k].map((t, i) => `<tr><td><input type="number" min="0" data-tier="${k}" data-i="${i}" data-j="0" value="${t[0]}"></td><td><input type="number" step="0.25" min="0" data-tier="${k}" data-i="${i}" data-j="1" value="${t[1]}"></td><td>${i ? `<button class="btn danger" data-tdel="${k}" data-i="${i}">حذف</button>` : ""}</td></tr>`).join("")}
    </tbody></table><div><button class="btn" data-tadd="${k}">إضافة شريحة</button></div></div>`;
  const members = (id) => S.employees.filter((e) => String(e.teamId) === String(id));
  return `
  <div class="card"><h2>الفرق</h2>
  <p class="note">مدير الفريق بيوافق أو يرفض طلبات فريقه، وبيشوف حضورهم. لازم كمان يكون حسابه عليه دور (مدير فريق) تحت.</p>
  <div class="tbl" style="border:0"><table><thead><tr><th>الفريق</th><th>المدير</th><th>عدد الأفراد</th><th></th></tr></thead><tbody>
  ${S.teams.map((t) => `<tr><td><input type="text" data-team="${t.id}" data-f="name" value="${esc(t.name)}" style="width:160px"></td>
    <td><select data-team="${t.id}" data-f="manager">${empOpts(t.manager, "بدون مدير")}</select></td><td class="num">${members(t.id).length}</td>
    <td><button class="btn danger" data-teamdel="${t.id}">حذف</button></td></tr>`).join("")}
  </tbody></table></div>
  <form class="row" id="teamForm"><input type="text" name="name" placeholder="اسم الفريق الجديد" required><button class="btn" type="submit">إضافة فريق</button></form></div>

  <div class="card"><h2>المستخدمين والصلاحيات</h2>
  <p class="note">أي حد يعمل حساب من صفحة الدخول بيظهر هنا من غير صلاحيات. اربطه بكود الموظف بتاعه، وعلّم الأدوار اللي ليه. الموظف العادي مش محتاج أي دور: بيبعت طلباته ويشوف حضوره بس.</p>
  <div class="tbl" style="border:0"><table><thead><tr><th>الإيميل</th><th>الاسم</th><th>كود الموظف</th>${ROLES.map(([, l]) => `<th>${l}</th>`).join("")}<th></th></tr></thead><tbody>
  ${S.users.map((u) => `<tr class="${!u.code && !u.roles.length ? "missing-name" : ""}"><td dir="ltr">${esc(u.email)}</td><td>${esc(u.name)}</td>
    <td><select data-user="${esc(u.id)}" data-f="code">${empOpts(u.code, "غير مربوط")}</select></td>
    ${ROLES.map(([r]) => `<td class="num"><input type="checkbox" data-user="${esc(u.id)}" data-role="${r}"${u.roles.includes(r) ? " checked" : ""}${u.id === ME.id && r === "admin" ? " disabled" : ""} aria-label="${r}"></td>`).join("")}
    <td>${u.id === ME.id ? '<span class="note">انت</span>' : `<button class="btn danger" data-userdel="${esc(u.id)}">حذف</button>`}</td></tr>`).join("")}
  </tbody></table></div></div>

  <div class="card"><h2>المواعيد والقواعد</h2><form class="add" onsubmit="return false">
    <label>ميعاد الحضور<input type="time" data-s="in" value="${st.in}"></label><label>ميعاد الانصراف<input type="time" data-s="out" value="${st.out}"></label>
    <label>عدد الأيام لحساب سعر اليوم<input type="number" data-s="workDays" value="${st.workDays}"></label>
    <label>خصم البصمة الناقصة (يوم)<input type="number" step="0.25" data-s="missDed" value="${st.missDed}"></label>
    <label>خصم الغياب بدون إذن (يوم)<input type="number" step="0.25" data-s="absDed" value="${st.absDed}"></label>
    <label>رصيد الأذونات الشهري (ساعات)<input type="number" step="0.5" data-s="permAllowH" value="${st.permAllowH}"></label>
    <label>وحدة خصم الإذن (دقيقة)<input type="number" step="15" min="0" data-s="permUnit" value="${st.permUnit}"></label></form>
  <div class="row"><span class="note">الإجازة الأسبوعية:</span>${DAYS.map((d, i) => `<label class="row" style="gap:4px"><input type="checkbox" data-wk="${i}"${st.weekend.includes(i) ? " checked" : ""}>${d}</label>`).join("")}</div></div>
  <div class="tiers">${tierT("lateTiers", "شرائح خصم التأخير")}${tierT("earlyTiers", "شرائح خصم الانصراف المبكر")}
  <div class="card"><h2>الإجازات الرسمية</h2>${(st.holidays || []).slice().sort().map((h) => `<div class="row"><span>${h.split("-").reverse().join("/")}</span><button class="btn danger" data-hdel="${h}">حذف</button></div>`).join("")}
    <div class="row"><input type="date" id="hNew"><button class="btn" id="hAdd">إضافة</button></div></div></div>`;
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
  if (d.tab) { tab = d.tab; render(); return; }
  if (d.go) { tab = d.go; render(); return; }
  if (d.emp) { dailyEmp = d.emp; tab = "daily"; render(); return; }
  if (d.payf) { payFilter = d.payf; render(); return; }
  if (t.id === "refresh") { LAST = await db.lastPunchDay().catch(() => LAST); refresh(); return; }
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
  if (t.id === "exportPay") { saveCsv(`مرتبات-${ym}.csv`, [["الكود", "الاسم", "الاسم بالكامل", "الوظيفة", "الراتب", "عمولات", "مردودات", "الاستحقاقات", "أيام الخصم", "خصم التأخير", "إدارية", "خصم أيام", "لائحة", "سلف", "الاستقطاعات", "الصافي", "طريقة الصرف", "رقم الحساب", "ملاحظة"], ...payRows(ym).map((r) => [r.e.code, empName(r.e), r.e.fullName, r.e.job, r.sal, N0(r.p.commission), N0(r.p.ret), Math.round(r.earn), n2(r.days), Math.round(r.late), N0(r.p.adminDed), N0(r.p.daysDed), N0(r.p.regDed), N0(r.p.advance), Math.round(r.ded), r.rnd, r.method === "bank" ? "بنك" : "نقدي", r.e.account, r.p.note || ""])]); return; }
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

async function login(v) {
  const btn = $("#loginBtn"); btn.disabled = true;
  try {
    if (v.mode === "signup") { await db.signUp(v.email.trim(), v.password, v.name?.trim() || ""); }
    await db.signIn(v.email.trim(), v.password);
    location.reload();
  } catch (e) {
    toast(v.mode === "signup" ? `مقدرتش أعمل الحساب: ${e.message || e}` : "الإيميل أو الباسورد غلط.", true);
  } finally { btn.disabled = false; }
}
document.addEventListener("input", (ev) => {
  if (ev.target.name === "mode") { const signup = ev.target.value === "signup"; $("#nameRow").hidden = !signup; $("#loginBtn").textContent = signup ? "إنشاء الحساب" : "دخول"; }
});

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
