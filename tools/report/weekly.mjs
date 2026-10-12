// Weekly HR email. Runs from GitHub Actions every Thursday evening.
//
//   NEON_REPORT_URL  connection string for the hr_report login (can only call hr_weekly_report)
//   RESEND_API_KEY   Resend key; without it the emails are written to ./out instead of sent
//   MAIL_FROM        e.g. "Everest HR <hr@everest-realestate.net>" (a domain verified in Resend)
//   PORTAL_URL       link to the portal
//
// Logs show counts only, never names or addresses.
import pg from "pg";
import fs from "node:fs";

const { NEON_REPORT_URL, RESEND_API_KEY, MAIL_FROM, PORTAL_URL = "https://sherifmounierhr-cpu.github.io/Sheko-s/hr/" } = process.env;
if (!NEON_REPORT_URL) { console.error("Missing NEON_REPORT_URL"); process.exit(2); }
if (RESEND_API_KEY && !MAIL_FROM) { console.error("Missing MAIL_FROM"); process.exit(2); }

const local = /@(localhost|127\.0\.0\.1)|host=\//.test(NEON_REPORT_URL);
const db = new pg.Client({ connectionString: NEON_REPORT_URL, ssl: local ? false : { rejectUnauthorized: true } });
await db.connect();
const { rows } = await db.query("select hr_weekly_report() as r");
await db.end();
const R = rows[0].r, C = R.company;

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dm = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : "");
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : "-");
const period = `من ${dm(R.from)} لـ ${dm(R.to)}`;
const A = (n) => (R.attendance_until ? n : "-");
const attNote = R.attendance_until ? `الحضور محسوب لحد ${dm(R.attendance_until)} (آخر بصمة اترفعت)، وبشكل تقريبي.` : "مفيش بصمة اترفعت للأسبوع ده، فالحضور مش محسوب.";

const tile = (label, value, warn) => `<td style="padding:6px"><div style="border:1px solid #d2dfdd;border-radius:10px;padding:10px 12px;background:#fff">
  <div style="color:#5b6d6b;font-size:13px">${label}</div><div style="font-size:22px;font-weight:700;color:${warn ? "#ab2f25" : "#10262c"}">${value}</div></div></td>`;
const grid = (cells) => `<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>${cells.slice(0, 3).join("")}</tr><tr>${cells.slice(3, 6).join("")}</tr>${cells.length > 6 ? `<tr>${cells.slice(6, 9).join("")}</tr>` : ""}</table>`;
const layout = (title, body) => `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f7f7;font-family:Tahoma,Arial,sans-serif;color:#10262c">
  <div style="max-width:640px;margin:0 auto;padding:16px">
    <div style="background:linear-gradient(160deg,#0f7e76,#0a4f49);color:#fff;border-radius:14px;padding:18px">
      <div style="font-size:13px;opacity:.9">Everest HR · ${period}</div><div style="font-size:20px;font-weight:700;margin-top:4px">${title}</div></div>
    <div style="padding:8px 0">${body}</div>
    <p style="color:#5b6d6b;font-size:13px">${attNote}</p>
    <p style="text-align:center;margin:18px 0"><a href="${esc(PORTAL_URL)}" style="background:#0f7e76;color:#fff;text-decoration:none;padding:10px 22px;border-radius:10px;font-weight:700">افتح البوابة</a></p>
    <p style="color:#8a9b99;font-size:12px;text-align:center">إيميل تلقائي كل خميس من بوابة Everest HR. الأرقام بس، والتفاصيل جوه البوابة.</p>
  </div></body></html>`;

function teamTable(teams) {
  return `<table width="100%" cellspacing="0" cellpadding="6" style="border-collapse:collapse;background:#fff;border:1px solid #d2dfdd;border-radius:10px;font-size:14px">
    <tr style="background:#e9f0ef;color:#5b6d6b"><th align="right">الفريق</th><th>غياب</th><th>تأخير</th><th>التقييم الأسبوعي</th><th>متوسط</th></tr>
    ${teams.map((t) => `<tr style="border-top:1px solid #e3ecea"><td>${esc(t.name)}</td><td align="center">${A(t.abs)}</td><td align="center">${A(t.late)}</td><td align="center">${t.eval_need ? pct(t.eval_done, t.eval_need) : "-"}</td><td align="center">${t.eval_avg ?? "-"}</td></tr>`).join("")}</table>`;
}

const mails = [];
if (R.recipients.admins.length) {
  const body = grid([
    tile("الموظفين", C.employees), tile("طلبات توظيف جديدة", C.applications), tile("اتعينوا", C.hired),
    tile("أيام غياب", A(C.abs), C.abs > 0), tile("مرات تأخير", A(C.late), C.late > 0), tile("متدربين", C.trainees),
    tile("التقييم الأسبوعي", pct(C.eval_done, C.eval_need), C.eval_need && C.eval_done < C.eval_need),
    tile("طلبات مستنية قرار", C.pending_requests + C.pending_actions + C.pending_meetings, C.pending_requests + C.pending_actions + C.pending_meetings > 0),
    tile("طلبات توظيف مفتوحة", C.open_applications),
  ]) + `<h3 style="margin:16px 0 8px">الفرق</h3>` + teamTable(R.teams);
  mails.push({ to: R.recipients.admins, subject: `ملخص الأسبوع ${period} | Everest HR`, html: layout("ملخص الشركة الأسبوعي", body) });
}
for (const t of R.teams) {
  if (!t.manager_email) continue;
  const body = grid([
    tile("أعضاء الفريق", t.members), tile("أيام غياب", A(t.abs), t.abs > 0), tile("مرات تأخير", A(t.late), t.late > 0),
    tile("التقييم الأسبوعي", t.eval_need ? pct(t.eval_done, t.eval_need) : "-", t.eval_need && t.eval_done < t.eval_need), tile("متوسط التقييم", t.eval_avg ?? "-"), tile("أذونات مستنية", t.pending_requests, t.pending_requests > 0),
  ]) + (t.top_abs.length ? `<h3 style="margin:16px 0 8px">محتاجين متابعة في الحضور</h3><ul>${t.top_abs.slice(0, 8).map((x) => `<li>${esc(x.name)}: ${x.abs} أيام غياب</li>`).join("")}</ul>` : "")
    + (t.trainees ? `<p>عندك ${t.trainees} متدرب في الفريق. تابع استبياناتهم من (المتدربين).</p>` : "");
  mails.push({ to: [t.manager_email], subject: `فريق ${t.name}: ملخص الأسبوع ${period}`, html: layout(`ملخص فريق ${esc(t.name)}`, body) });
}

if (!RESEND_API_KEY) {
  fs.mkdirSync("out", { recursive: true });
  mails.forEach((m, i) => fs.writeFileSync(`out/mail-${i + 1}.html`, m.html));
  console.log(`dry run: ${mails.length} emails written to ./out`);
  process.exit(0);
}
let failed = 0;
for (const m of mails) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: MAIL_FROM, to: m.to, subject: m.subject, html: m.html }),
  });
  if (!res.ok) { failed++; console.error(`send failed: HTTP ${res.status}`); }
}
console.log(`sent ${mails.length - failed} of ${mails.length} emails`);
process.exit(failed ? 1 : 0);
