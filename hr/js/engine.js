// Attendance and payroll rules. Pure functions over the state built in db.js;
// the same rules as the Excel workbook in tools/attendance.

export const DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

export const DEFAULT_SETTINGS = {
  in: "11:00", out: "19:00", workDays: 30, weekend: [5], missDed: 0.5, absDed: 1,
  permAllowH: 2, permUnit: 60, holidays: [], maxPenaltyDays: 5,
  lateTiers: [[0, 0], [16, 0.25], [31, 0.5], [61, 1]],
  earlyTiers: [[0, 0], [1, 0.25], [61, 0.5], [121, 1]],
};

export const toMin = (t) => { if (!t) return null; const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
export const dur = (a, b) => { const x = toMin(a), y = toMin(b); return x == null || y == null ? 0 : Math.max(0, y - x); };
export const wd = (d) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
export const daysIn = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); };
export const monthDays = (ym) => Array.from({ length: daysIn(ym) }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`);
const tier = (v, t) => { let r = 0; for (const [from, ded] of t) if (v >= from) r = ded; return r; };
const N0 = (v) => Number(v) || 0;
const has = (v) => v !== "" && v != null;

export function createEngine(S, lastPunchDay) {
  const st = { ...DEFAULT_SETTINGS, ...S.settings };
  st.weekend = (st.weekend || []).map(Number);
  const isPermLeave = (p) => p.type.startsWith("إجازة");

  // punches by code|day, minutes since midnight
  const punchIdx = {};
  for (const [code, list] of Object.entries(S.punches)) {
    for (const p of list) (punchIdx[`${code}|${p.slice(0, 10)}`] ??= []).push(toMin(p.slice(11, 16)));
  }
  const lastDay = lastPunchDay || Object.keys(punchIdx).map((k) => k.split("|")[1]).sort().pop() || "";

  // permission balance: permAllowH hours a month, charged in permUnit steps, oldest first
  const ledger = {};
  {
    const allow = N0(st.permAllowH) * 60, unit = N0(st.permUnit), used = {};
    S.perms.map((p, i) => [p, i]).filter(([p]) => p.status === "معتمد" && !isPermLeave(p))
      .sort((a, b) => a[0].from.localeCompare(b[0].from) || a[1] - b[1])
      .forEach(([p]) => {
        const k = `${p.code}|${p.from.slice(0, 7)}`, d = dur(p.tFrom, p.tTo);
        const charge = unit > 0 ? Math.ceil(d / unit) * unit : d, before = used[k] || 0;
        used[k] = before + charge;
        ledger[p.id] = { charge, covered: Math.min(d, Math.max(0, allow - before)), before, left: Math.max(0, allow - before - charge), over: before + charge > allow };
      });
  }
  const permUsed = (code, ym) => S.perms.filter((p) => p.code === code && p.status === "معتمد" && !isPermLeave(p) && p.from.startsWith(ym))
    .reduce((a, p) => a + (ledger[p.id]?.charge || 0), 0);

  function dayRow(e, d) {
    const w = wd(d), code = e.code;
    const offDay = e.off !== "" && e.off != null && Number(e.off) === w;
    const type = st.weekend.includes(w) || offDay ? "إجازة أسبوعية" : (st.holidays || []).includes(d) ? "إجازة رسمية" : "يوم عمل";
    const ps = (punchIdx[`${code}|${d}`] || []).slice().sort((a, b) => a - b);
    const pin = ps.length ? ps[0] : null, pout = ps.length > 1 ? ps[ps.length - 1] : null;
    const rin = toMin(e.in || st.in), rout = toMin(e.out || st.out);
    const ok = (x) => x.code === code && x.status === "معتمد";
    const leave = S.perms.some((p) => ok(p) && isPermLeave(p) && p.from <= d && (p.to || p.from) >= d);
    const permMin = S.perms.filter((p) => ok(p) && !isPermLeave(p) && p.from === d).reduce((a, p) => a + (ledger[p.id]?.covered || 0), 0);
    const meets = S.meetings.filter((m) => ok(m) && m.date === d);
    const meetMin = meets.reduce((a, m) => a + dur(m.tFrom, m.tTo), 0);
    const late = pin == null ? null : Math.max(0, pin - rin), early = pout == null ? null : Math.max(0, rout - pout);
    const nlate = late == null ? null : Math.max(0, late - permMin - meetMin);
    const nearly = early == null ? null : Math.max(0, early - Math.max(0, permMin + meetMin - (late || 0)));
    const future = !lastDay || d > lastDay;
    const lateHit = nlate > 0 && tier(nlate, st.lateTiers) > 0, earlyHit = nearly > 0 && tier(nearly, st.earlyTiers) > 0;
    let status;
    if (type !== "يوم عمل") status = type;
    else if (leave) status = "إجازة";
    else if (future) status = "لم يأتِ بعد";
    else if (e.exempt) status = "معفى من البصمة";
    else if (pin == null) status = meetMin > 0 ? "مهمة خارجية" : "غياب";
    else if (pout == null) status = meetMin > 0 ? "حاضر - مهمة خارجية" : "بصمة ناقصة";
    else if (lateHit && earlyHit) status = "تأخير وانصراف مبكر";
    else if (lateHit) status = "تأخير";
    else if (earlyHit) status = "انصراف مبكر";
    else status = "حاضر";
    let dl = 0, de = 0, dm = 0, da = 0;
    if (type === "يوم عمل" && !leave && !future && !e.exempt) {
      if (nlate > 0) dl = tier(nlate, st.lateTiers);
      if (nearly > 0) de = tier(nearly, st.earlyTiers);
      if (status === "بصمة ناقصة") dm = N0(st.missDed);
      if (status === "غياب") da = N0(st.absDed);
    }
    const calc = dl + de + dm + da, key = `${code}|${d}`, ov = S.overrides[key];
    const fin = ov && has(ov.ded) ? Number(ov.ded) : calc;
    return { lateHit, earlyHit, d, w, type, pin, pout, count: ps.length, hrs: pin != null && pout != null ? (pout - pin) / 60 : null,
      rin, rout, leave, permMin, meetMin, meets, late, early, nlate, nearly, status, calc, fin, key, ov, future };
  }

  function summary(e, ym) {
    const rows = monthDays(ym).map((d) => dayRow(e, d));
    const work = rows.filter((r) => r.type === "يوم عمل" && !r.future);
    const c = (s) => rows.filter((r) => r.status === s).length;
    const abs = c("غياب"), lv = c("إجازة"), miss = c("بصمة ناقصة");
    const onTime = rows.filter((r) => ["حاضر", "حاضر - مهمة خارجية", "مهمة خارجية"].includes(r.status)).length;
    const ex = !!e.exempt;
    const latec = ex ? 0 : rows.filter((r) => r.lateHit && r.type === "يوم عمل").length;
    const latem = ex ? 0 : rows.reduce((a, r) => a + (r.type === "يوم عمل" && r.nlate ? r.nlate : 0), 0);
    const earlyc = ex ? 0 : rows.filter((r) => r.earlyHit && r.type === "يوم عمل").length;
    const permH = permUsed(e.code, ym) / 60;
    const ms = S.meetings.filter((m) => m.code === e.code && m.status === "معتمد" && m.date.startsWith(ym));
    const deals = ms.filter((m) => m.result === "حجز / تعاقد").length;
    const denom = work.length - lv;
    return { e, rows, req: work.length, pres: work.length - abs - lv, abs, lv, miss, latec, latem, earlyc, permH,
      permOver: permH > N0(st.permAllowH), meetC: ms.length, meetH: ms.reduce((a, m) => a + dur(m.tFrom, m.tTo), 0) / 60, deals,
      commit: ex ? null : denom > 0 ? onTime / denom : null, ddays: rows.reduce((a, r) => a + r.fin, 0) };
  }

  // approved penalties and bonuses of the month; penalties are capped at maxPenaltyDays of pay
  const actionsOf = (code, ym) => (S.actions || []).filter((a) => a.code === code && a.status === "approved" && a.day.startsWith(ym));
  function actionTotals(e, ym, rate) {
    const list = actionsOf(e.code, ym);
    const val = (a) => N0(a.days) * rate + N0(a.amount);
    const penRaw = list.filter((a) => a.kind === "penalty").reduce((x, a) => x + val(a), 0);
    const cap = N0(st.maxPenaltyDays) > 0 ? N0(st.maxPenaltyDays) * rate : Infinity;
    const pen = Math.min(penRaw, cap), bonus = list.filter((a) => a.kind === "bonus").reduce((x, a) => x + val(a), 0);
    return { list, pen, penRaw, capped: penRaw > pen, bonus };
  }

  function payRow(e, ym) {
    const p = S.payroll?.[ym]?.[e.code] || {}, s = summary(e, ym);
    const sal = N0(e.salary), rate = sal / (N0(st.workDays) || 30);
    const appr = has(p.approvedDays) ? Number(p.approvedDays) : null, days = appr ?? s.ddays;
    const late = has(p.lateAmt) ? Number(p.lateAmt) : days * rate;
    const A = actionTotals(e, ym, rate);
    const earn = sal + N0(p.commission) + N0(p.ret) + A.bonus;
    const ded = late + N0(p.adminDed) + N0(p.daysDed) + N0(p.regDed) + N0(p.advance) + A.pen;
    const net = earn - ded, rnd = Math.round(net / 5) * 5;
    return { e, p, s, sal, rate, appr, days, late, pen: A.pen, penCapped: A.capped, bonus: A.bonus, actions: A.list,
      earn, ded, net, rnd, method: e.pay || (e.account ? "bank" : "cash"), inPay: !!S.payroll?.[ym]?.[e.code] };
  }

  // Pay earned so far: salary for the days up to the last fingerprint day,
  // less what the month's deductions come to by then.
  function toDate(e, ym) {
    const r = payRow(e, ym), total = daysIn(ym);
    const elapsed = !lastDay || lastDay < `${ym}-01` ? 0 : lastDay.slice(0, 7) > ym ? total : Number(lastDay.slice(8, 10));
    const earned = (r.sal * elapsed) / total;
    const net = earned + N0(r.p.commission) + N0(r.p.ret) + r.bonus - r.ded;
    return { ...r, elapsed, total, earned, upTo: elapsed ? `${ym}-${String(elapsed).padStart(2, "0")}` : "", netToDate: net };
  }

  return { st, ledger, permUsed, dayRow, summary, payRow, toDate, actionsOf, lastDay };
}

// --- device export parsing (legacy .xls BIFF2/BIFF3 labels, or CSV)
export function parseTime(t) {
  t = String(t).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  let y, mo, d, h, mi, ap;
  if (m) [, y, mo, d, h, mi, ap] = m;
  else { m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/); if (!m) return null; [, d, mo, y, h, mi, ap] = m; }
  h = Number(h);
  if (ap) { ap = ap.toUpperCase(); if (ap === "PM" && h < 12) h += 12; if (ap === "AM" && h === 12) h = 0; }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${mi}`;
}

export function readBiff(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), rows = {};
  if (v.getUint32(0, true) === 0xE011CFD0) throw new Error("ole");
  const dec = new TextDecoder("utf-8");
  let i = 0;
  while (i + 4 <= buf.byteLength) {
    const t = v.getUint16(i, true), l = v.getUint16(i + 2, true), b = i + 4;
    if (t === 0x0004) { const r = v.getUint16(b, true), c = v.getUint16(b + 2, true), n = u8[b + 7]; (rows[r] ??= {})[c] = dec.decode(u8.subarray(b + 8, b + 8 + n)); }
    else if (t === 0x0204) { const r = v.getUint16(b, true), c = v.getUint16(b + 2, true), n = v.getUint16(b + 6, true); (rows[r] ??= {})[c] = dec.decode(u8.subarray(b + 8, b + 8 + n)); }
    i = b + l;
  }
  return Object.keys(rows).map(Number).sort((a, b) => a - b).map((r) => [0, 1, 2].map((c) => rows[r][c] ?? ""));
}

export async function readExport(file) {
  const rows = /\.xls$/i.test(file.name)
    ? readBiff(await file.arrayBuffer())
    : (await file.text()).split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((x) => x.replace(/^"|"$/g, "")));
  const out = [], names = {};
  for (const r of rows) {
    const code = String(r[0]).trim(), time = parseTime(r[2] ?? "");
    if (!/^\d+$/.test(code) || !time) continue;
    out.push([code, time]); names[code] ??= String(r[1]).trim();
  }
  return { punches: out, names };
}
