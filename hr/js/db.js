// Neon Auth + Neon Data API. Every read and write goes through row level
// security in neon/schema.sql; the UI only hides what the database refuses.
import { createClient, SupabaseAuthAdapter } from "./vendor/neon.js?v=202610221500";
import { NEON_AUTH_URL, NEON_DATA_API_URL } from "./config.js?v=202610221500";

export const configured = Boolean(NEON_AUTH_URL && NEON_DATA_API_URL);

// Every Data API request skips the browser cache, and the last few are noted
// (table, status, rows, the sign-in token's subject and minutes left; never
// the token itself) so the connection check can show what a bad load saw.
export const TRACE = [];
const jwtInfo = (h) => {
  try {
    const t = String(h || "").replace(/^Bearer /, ""), p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return { sub: String(p.sub || "").slice(0, 8), left: p.exp ? Math.round(p.exp - Date.now() / 1000) : null };
  } catch { return { sub: "", left: null }; }
};
async function traced(url, opts = {}) {
  const res = await fetch(url, { ...opts, cache: "no-store" });
  try {
    const h = new Headers(opts.headers), u = new URL(String(url));
    TRACE.push({ t: new Date().toLocaleTimeString("en-GB"), what: u.pathname.split("/").pop(), st: res.status, range: res.headers.get("content-range") || "", ...jwtInfo(h.get("Authorization")) });
    if (TRACE.length > 40) TRACE.shift();
  } catch { /* tracing never breaks a request */ }
  return res;
}

const raw = configured
  ? createClient({
      auth: { adapter: SupabaseAuthAdapter(), url: NEON_AUTH_URL },
      // never answer a read from the browser's cache: an answer saved for one
      // sign-in (or none) must not be reused for another
      dataApi: { url: NEON_DATA_API_URL, options: { global: { fetch: traced } } },
    })
  : null;

// "شوف شاشته": while an admin previews someone else's screen, every write is
// refused here, before it reaches the database. Reads (and the RPCs that only
// read) still go through, with the admin's own permissions.
let readOnly = false;
export const READ_ONLY_MSG = "وضع العرض فقط: مينفعش تعدّل وانت شايف شاشة حد تاني";
const READ_RPCS = new Set(["hr_device_status", "hr_org_chart", "hr_punch_months", "hr_last_punch_day", "hr_my_pay", "hr_quiz_list", "hr_eval_week", "hr_eval_open", "hr_roles", "hr_peek_notifications", "hr_my_state", "hr_emp_profile", "hr_app_cv", "hr_lead_contacts", "hr_com_people", "hr_my_commissions", "hr_com_file"]);
const refuse = () => { throw Object.assign(new Error(READ_ONLY_MSG), { readOnly: true }); };
export function setReadOnly(on) { readOnly = !!on; }
export const isReadOnly = () => readOnly;
export const client = raw && new Proxy(raw, {
  get(target, prop) {
    const v = target[prop];
    if (prop === "rpc") return (name, ...a) => (readOnly && !READ_RPCS.has(name) ? refuse() : v.call(target, name, ...a));
    if (prop === "from") return (table) => {
      const q = v.call(target, table);
      return new Proxy(q, { get(t, k) { const f = t[k]; if (readOnly && ["insert", "update", "upsert", "delete"].includes(k)) return refuse; return typeof f === "function" ? f.bind(t) : f; } });
    };
    return typeof v === "function" ? v.bind(target) : v;
  },
});

const STATUS_AR = { pending: "قيد المراجعة", approved: "معتمد", rejected: "مرفوض" };
const STATUS_EN = { "قيد المراجعة": "pending", "معتمد": "approved", "مرفوض": "rejected" };
export const toAr = (s) => STATUS_AR[s] || s;
export const toEn = (s) => STATUS_EN[s] || s;

function check({ data, error }) {
  if (error) throw Object.assign(new Error(error.message || "DB error"), { code: error.code });
  return data;
}

const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
const nullIfEmpty = (v) => (v === "" || v === undefined ? null : v);

// ---------------------------------------------------------------- auth

export async function currentUser() {
  const { data } = await client.auth.getSession();
  return data?.session?.user || null;
}

export async function signIn(email, password) {
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email, password, name) {
  const { error } = await client.auth.signUp({ email, password, options: { data: { name } } });
  if (error) throw error;
}

export async function signOut() {
  await client.auth.signOut();
}

// Creates the caller's app_users row (no roles) the first time they sign in.
export async function me(user) {
  let rows = check(await client.from("app_users").select("*").eq("user_id", user.id));
  if (!rows.length) {
    await client.from("app_users").insert({ user_id: user.id, email: user.email, display_name: user.user_metadata?.name || "" });
    rows = check(await client.from("app_users").select("*").eq("user_id", user.id));
  }
  const row = rows[0] || { roles: [] };
  // effective roles: someone who left (neon/011_cv_leavers.sql) has none
  const st = await client.rpc("hr_my_state").then((r) => (r.error ? null : r.data)).catch(() => null);
  if (st) return { id: user.id, email: user.email, roles: st.roles || [], code: st.code || "", off: !!st.off };
  return { id: user.id, email: user.email, roles: row.roles || [], code: row.employee_code || "" };
}

export async function claimAdmin() {
  return check(await client.rpc("hr_claim_admin"));
}

// ---------------------------------------------------------------- reads

const get = async (query) => check(await query);
// Portal tables come from neon/002_portal.sql; until it runs the rest of the site still works.
export let portalReady = true;
const soft = (p) => p.catch((e) => { if (/schema cache|does not exist|PGRST20/i.test(e.message)) { portalReady = false; return []; } throw e; });

async function all(query) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const page = check(await query().range(from, from + 999));
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

export async function months() {
  return (check(await client.rpc("hr_punch_months")) || []).map((r) => (typeof r === "string" ? r : Object.values(r)[0]));
}

// Runs each read on its own and reports row counts or the exact error,
// so a setup problem (schema cache, grants, RLS, auth) is visible.
export async function diagnose(ym) {
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`, end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const out = [];
  const user = await currentUser().catch((e) => ({ err: e }));
  out.push(["المستخدم", user?.id ? `${user.email} (${user.id})` : `غير مسجل ${user?.err?.message || ""}`]);
  const probes = [
    ["app_users (حسابي)", () => client.from("app_users").select("user_id,roles,employee_code")],
    ["teams", () => client.from("teams").select("id").limit(1000)],
    ["employees", () => client.from("employees").select("code").limit(1000)],
    ["employee_pay", () => client.from("employee_pay").select("code").limit(1000)],
    [`punches ${ym}`, () => client.from("punches").select("code,ts").gte("ts", start).lt("ts", end).limit(1000)],
    ["punches (أي شهر)", () => client.from("punches").select("code,ts").limit(5)],
    ["requests", () => client.from("requests").select("id").limit(1000)],
    ["payroll", () => client.from("payroll").select("code").eq("month", ym)],
    ["settings", () => client.from("settings").select("data")],
    ["actions", () => client.from("actions").select("id").limit(1000)],
    ["notifications", () => client.from("notifications").select("id").limit(1000)],
    ["checkins", () => client.from("checkins").select("id").limit(1000)],
    ["policy_items", () => client.from("policy_items").select("id")],
    ["rpc hr_roles", () => client.rpc("hr_roles")],
    ["rpc hr_my_state", () => client.rpc("hr_my_state")],
    ["applications", () => client.from("applications").select("ref,status").limit(1000)],
    ["application_reviews", () => client.from("application_reviews").select("application_id").limit(1000)],
    ["rpc hr_punch_months", () => client.rpc("hr_punch_months")],
    ["rpc hr_last_punch_day", () => client.rpc("hr_last_punch_day")],
  ];
  for (const [name, q] of probes) {
    try {
      const { data, error } = await q();
      if (error) out.push([name, `خطأ: ${error.message}${error.code ? ` (${error.code})` : ""}${error.hint ? ` - ${error.hint}` : ""}`]);
      else if (Array.isArray(data)) out.push([name, `${data.length} صف ${data.length ? "- مثال: " + JSON.stringify(data[0]).slice(0, 120) : ""}`]);
      else out.push([name, JSON.stringify(data).slice(0, 160)]);
    } catch (e) { out.push([name, `خطأ: ${e.message || e}`]); }
  }
  return out;
}

export async function lastPunchDay() {
  const d = check(await client.rpc("hr_last_punch_day"));
  return d ? String(d).slice(0, 10) : "";
}

// Calendar day in Cairo for a timestamptz, so check-ins land on the right day.
export const cairoDay = (ts) => new Date(ts).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
export const cairoTime = (ts) => new Date(ts).toLocaleTimeString("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit" });

const shiftDay = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10);
const mapPayroll = (p) => ({
  commission: Number(p.commission) || 0, ret: Number(p.ret) || 0, adminDed: Number(p.admin_ded) || 0,
  daysDed: Number(p.days_ded) || 0, regDed: Number(p.reg_ded) || 0, advance: Number(p.advance) || 0,
  approvedDays: p.approved_days ?? "", lateAmt: p.late_amt ?? "", note: p.note || "",
});
const mapAction = (a) => ({
  id: a.id, code: a.code, kind: a.kind, policyId: a.policy_item_id, occurrence: a.occurrence, day: a.day,
  days: Number(a.days) || 0, amount: Number(a.amount) || 0, reason: a.reason || "", status: a.status,
  createdAt: a.created_at, decisionNote: a.decision_note || "", ackAt: a.ack_at, objection: a.objection || "",
});
export const mapCheckin = (c) => ({
  id: c.id, code: c.code, ts: c.ts, day: cairoDay(c.ts), time: cairoTime(c.ts), kind: c.kind,
  lat: c.lat, lng: c.lng, accuracy: c.accuracy, place: c.place || "", note: c.note || "", meetingId: c.meeting_id,
});

// Builds the same state shape the attendance engine was written for.
// R: the caller's roles; an employee without staff roles also gets their own pay through hr_my_pay.
// only: limit every read to one employee code (the month comparison on the home tab).
export async function load(ym, R = {}, only = "") {
  const isAdmin = !!R.admin;
  const f = (q, col = "code") => (only ? q.eq(col, only) : q);
  const [y, m] = ym.split("-").map(Number);
  const start = `${ym}-01`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

  const [settingsRows, teams, employees, punches, requests, meetings, overrides, actions, checkins, policy] = await Promise.all([
    get(client.from("settings").select("data").eq("id", 1)),
    get(client.from("teams").select("*").order("name")),
    all(() => f(client.from("employees").select("*")).order("code")),
    all(() => f(client.from("punches").select("code,ts")).gte("ts", start).lt("ts", end).order("ts")),
    all(() => f(client.from("requests").select("*")).lt("date_from", end).or(`date_to.gte.${start},and(date_to.is.null,date_from.gte.${start})`).order("date_from")),
    all(() => f(client.from("meetings").select("*")).gte("date", start).lt("date", end).order("date")),
    all(() => f(client.from("overrides").select("*")).gte("day", start).lt("day", end)),
    soft(all(() => f(client.from("actions").select("*")).gte("day", start).lt("day", end).order("day"))),
    soft(all(() => f(client.from("checkins").select("*")).gte("ts", shiftDay(start, -1)).lt("ts", shiftDay(end, 1)).order("ts", { ascending: false }))),
    soft(get(client.from("policy_items").select("*").order("sort").order("id"))),
  ]);

  let pay = [], payroll = [], users = [], invites = [];
  if (isAdmin || R.pay) {
    [pay, payroll, users, invites] = await Promise.all([
      all(() => f(client.from("employee_pay").select("*"))),
      all(() => f(client.from("payroll").select("*")).eq("month", ym)),
      isAdmin ? all(() => client.from("app_users").select("*").order("created_at")) : [],
      isAdmin ? soft(get(client.from("invites").select("employee_code,created_at,expires_at,used_at"))) : [],
    ]);
  } else if (R.code) {
    const mine = await soft(client.rpc("hr_my_pay", { ym }).then(check));
    if (mine) {
      pay = [{ code: R.code, salary: mine.salary, account: mine.account_last4 ? `****${mine.account_last4}` : "", pay_method: mine.pay_method }];
      if (mine.payroll) payroll = [mine.payroll];
    }
  }
  const payBy = Object.fromEntries(pay.map((p) => [p.code, p]));

  const S = {
    meta: { month: ym },
    settings: settingsRows[0]?.data || {},
    teams: teams.map((t) => ({ id: t.id, name: t.name, manager: t.manager_code || "", parent: t.parent_id ?? "", kind: t.kind || "sales", sort: t.sort || 0 })),
    employees: employees.map((e) => {
      const p = payBy[e.code] || {};
      return {
        code: e.code, name: e.name || "", fullName: e.full_name || "", device: e.device_name || "",
        teamId: e.team_id ?? "", job: e.job || "", dept: e.dept || "",
        in: hhmm(e.shift_in), out: hhmm(e.shift_out), off: e.off_day ?? "", exempt: !!e.exempt, active: e.active !== false,
        hireDate: e.hire_date || "", experience: e.experience || "", position: e.position || "",
        reportsTo: e.reports_to || "", plus: e.roles_plus || [], minus: e.roles_minus || [],
        salary: Number(p.salary) || 0, account: p.account || "", pay: p.pay_method || (p.account ? "bank" : "cash"),
      };
    }),
    punches: {},
    perms: requests.map((r) => ({
      id: r.id, code: r.code, type: r.type, from: r.date_from, to: r.date_to || "", tFrom: hhmm(r.time_from), tTo: hhmm(r.time_to),
      status: toAr(r.status), rawStatus: r.status, note: r.reason || "", decisionNote: r.decision_note || "",
      createdAt: r.created_at, decidedAt: r.decided_at,
    })),
    meetings: meetings.map((x) => ({
      id: x.id, code: x.code, date: x.date, tFrom: hhmm(x.time_from), tTo: hhmm(x.time_to), kind: x.kind || "", client: x.client || "",
      phone: x.phone || "", project: x.project || "", place: x.place || "", source: x.source || "", result: x.result || "",
      follow: x.follow_up || "", status: toAr(x.status), rawStatus: x.status, note: x.note || "",
      lat: x.lat, lng: x.lng, decisionNote: x.decision_note || "",
    })),
    actions: actions.map(mapAction),
    checkins: checkins.map(mapCheckin).filter((c) => c.day >= start && c.day < end),
    policy: policy.map((p) => ({ id: p.id, ref: p.ref || "", category: p.category || "", title: p.title, body: p.body || "", steps: p.steps || [], active: p.active !== false, sort: p.sort || 0 })),
    invites: invites.map((i) => ({ code: i.employee_code, createdAt: i.created_at, expiresAt: i.expires_at, usedAt: i.used_at })),
    overrides: Object.fromEntries(overrides.map((o) => [`${o.code}|${o.day}`, { ded: o.ded ?? "", note: o.note || "" }])),
    payroll: {
      [ym]: Object.fromEntries(payroll.map((p) => [p.code, mapPayroll(p)])),
    },
    users: users.map((u) => ({ id: u.user_id, email: u.email || "", name: u.display_name || "", code: u.employee_code || "", roles: u.roles || [] })),
  };
  for (const p of punches) {
    const t = String(p.ts).replace("T", " ").slice(0, 16);
    (S.punches[p.code] ??= []).push(t);
  }
  return S;
}

// ---------------------------------------------------------------- writes

const EMP_COLS = { name: "name", fullName: "full_name", device: "device_name", teamId: "team_id", job: "job", dept: "dept",
  in: "shift_in", out: "shift_out", off: "off_day", exempt: "exempt", active: "active", hireDate: "hire_date", experience: "experience" };
const PAY_COLS = { salary: "salary", account: "account", pay: "pay_method" };

export async function updateEmployee(code, field, value) {
  if (EMP_COLS[field]) {
    check(await client.from("employees").update({ [EMP_COLS[field]]: nullIfEmpty(value) }).eq("code", code));
  } else if (PAY_COLS[field]) {
    check(await client.from("employee_pay").upsert({ code, [PAY_COLS[field]]: nullIfEmpty(value) ?? (field === "salary" ? 0 : null) }, { onConflict: "code" }));
  }
}

export async function addEmployee(code, name, teamId, extra = {}) {
  const row = { code, name, team_id: nullIfEmpty(teamId) };
  // only send the 003 columns when filled, so adding still works before that file runs
  for (const [k, col] of [["hireDate", "hire_date"], ["experience", "experience"], ["job", "job"]]) if (nullIfEmpty(extra[k]) != null) row[col] = extra[k];
  check(await client.from("employees").insert(row));
}

export async function saveSettings(data) {
  check(await client.from("settings").upsert({ id: 1, data }, { onConflict: "id" }));
}

export async function addTeam(name) { check(await client.from("teams").insert({ name })); }
export async function updateTeam(id, fields) {
  const row = {};
  if ("name" in fields) row.name = fields.name;
  if ("manager" in fields) row.manager_code = nullIfEmpty(fields.manager);
  if ("parent" in fields) row.parent_id = nullIfEmpty(fields.parent) == null ? null : Number(fields.parent);
  if ("kind" in fields) row.kind = fields.kind;
  if ("sort" in fields) row.sort = Number(fields.sort) || 0;
  check(await client.from("teams").update(row).eq("id", id));
}
export async function deleteTeam(id) { check(await client.from("teams").delete().eq("id", id)); }

export async function updateUser(id, fields) {
  const row = {};
  if ("roles" in fields) row.roles = fields.roles;
  if ("code" in fields) row.employee_code = nullIfEmpty(fields.code);
  check(await client.from("app_users").update(row).eq("user_id", id));
}
export async function deleteUser(id) { check(await client.from("app_users").delete().eq("user_id", id)); }

export async function setOverride(code, day, ded, note) {
  if ((ded === "" || ded == null) && !note) {
    check(await client.from("overrides").delete().eq("code", code).eq("day", day));
  } else {
    check(await client.from("overrides").upsert({ code, day, ded: nullIfEmpty(ded), note: note || null }, { onConflict: "code,day" }));
  }
}

const PAYROLL_COLS = { commission: "commission", ret: "ret", adminDed: "admin_ded", daysDed: "days_ded", regDed: "reg_ded",
  advance: "advance", approvedDays: "approved_days", lateAmt: "late_amt", note: "note" };
export async function setPayroll(month, code, field, value) {
  const col = PAYROLL_COLS[field];
  const nullable = ["approved_days", "late_amt", "note"].includes(col);
  const v = value === "" ? (nullable ? null : 0) : value;
  check(await client.from("payroll").upsert({ month, code, [col]: v }, { onConflict: "month,code" }));
}

export async function addRequest(r) {
  check(await client.from("requests").insert({
    code: r.code, type: r.type, date_from: r.from, date_to: nullIfEmpty(r.to), time_from: nullIfEmpty(r.tFrom),
    time_to: nullIfEmpty(r.tTo), reason: nullIfEmpty(r.note), ...(r.status ? { status: toEn(r.status) } : {}),
  }));
}
export async function deleteRequest(id) { check(await client.from("requests").delete().eq("id", id)); }
export async function decideRequest(id, status, note) {
  check(await client.rpc("hr_decide_request", { req_id: id, new_status: toEn(status), note: note || null }));
}

export async function addMeeting(m) {
  return check(await client.from("meetings").insert({
    ...(m.lat != null ? { lat: m.lat, lng: m.lng, accuracy: m.accuracy } : {}),
    code: m.code, date: m.date, time_from: m.tFrom, time_to: m.tTo, kind: m.kind, client: nullIfEmpty(m.client),
    phone: nullIfEmpty(m.phone), project: nullIfEmpty(m.project), place: nullIfEmpty(m.place), source: nullIfEmpty(m.source),
    result: nullIfEmpty(m.result), follow_up: nullIfEmpty(m.follow), status: toEn(m.status || "معتمد"), note: nullIfEmpty(m.note),
  }).select("id"))?.[0]?.id;
}
export async function updateMeeting(id, field, value) {
  const col = { result: "result", status: "status", tTo: "time_to" }[field];
  check(await client.from("meetings").update({ [col]: field === "status" ? toEn(value) : nullIfEmpty(value) }).eq("id", id));
}
export async function deleteMeeting(id) { check(await client.from("meetings").delete().eq("id", id)); }
export async function decideMeeting(id, status, note) {
  check(await client.rpc("hr_decide_meeting", { meet_id: id, new_status: toEn(status), p_note: note || null }));
}

// ---------------------------------------------------------------- portal

// One-time code an admin sends an employee so their login gets linked to them.
export async function createInvite(code, roles = []) { return check(await client.rpc("hr_create_invite", { emp_code: code, emp_roles: roles })); }
export async function redeemInvite(token) { return check(await client.rpc("hr_redeem_invite", { token })); }

export async function proposeAction(a) {
  return check(await client.rpc("hr_propose_action", {
    p_code: a.code, p_kind: a.kind, p_reason: a.reason, p_day: a.day, p_days: Number(a.days) || 0,
    p_amount: Number(a.amount) || 0, p_policy: a.policyId ? Number(a.policyId) : null,
  }));
}
export async function decideAction(id, status, note) { check(await client.rpc("hr_decide_action", { act_id: id, new_status: status, note: note || null })); }
export async function ackAction(id, objection) { check(await client.rpc("hr_ack_action", { act_id: id, p_objection: objection || null })); }

export async function addPolicy(p) { check(await client.from("policy_items").insert(p)); }
export async function updatePolicy(id, fields) { check(await client.from("policy_items").update(fields).eq("id", id)); }
export async function deletePolicy(id) { check(await client.from("policy_items").delete().eq("id", id)); }

export async function notifications(limit = 50) {
  return check(await client.from("notifications").select("*").order("created_at", { ascending: false }).limit(limit));
}
// Admin only (neon/007_todos.sql): someone else's inbox, for "شوف شاشته".
export async function notificationsOf(user, limit = 50) {
  return check(await client.rpc("hr_peek_notifications", { p_user: user, p_limit: limit })) || [];
}
export async function markRead(ids) {
  if (!ids.length || readOnly) return;
  check(await client.from("notifications").update({ read_at: new Date().toISOString() }).in("id", ids));
}

export async function addCheckin(c) {
  return check(await client.from("checkins").insert({
    code: c.code, kind: c.kind, lat: c.lat ?? null, lng: c.lng ?? null, accuracy: c.accuracy ?? null,
    place: nullIfEmpty(c.place), note: nullIfEmpty(c.note), meeting_id: c.meetingId ?? null,
  }).select("id"))?.[0]?.id;
}
export async function deleteCheckin(id) { check(await client.from("checkins").delete().eq("id", id)); }

// Today's check-ins and punches for everyone the caller may see: the live board.
export async function live(day) {
  const [checkins, punches, meetings] = await Promise.all([
    get(client.from("checkins").select("*").gte("ts", shiftDay(day, -1)).lt("ts", shiftDay(day, 1)).order("ts", { ascending: false })),
    get(client.from("punches").select("code,ts").gte("ts", day).lt("ts", shiftDay(day, 1)).order("ts")),
    get(client.from("meetings").select("*").eq("date", day)),
  ]);
  return { checkins: checkins.map(mapCheckin).filter((c) => c.day === day), punches, meetings };
}

export async function comments(table, ids) {
  if (!ids.length) return [];
  return check(await client.from("comments").select("*").eq("ref_table", table).in("ref_id", ids).order("created_at"));
}
export async function addComment(table, id, body) { check(await client.from("comments").insert({ ref_table: table, ref_id: id, body })); }

export async function audit(limit = 200) {
  return check(await client.from("audit_log").select("*").order("at", { ascending: false }).limit(limit));
}
export async function purgeLocations() { return check(await client.rpc("hr_purge_locations")); }

// Inserts punches 500 at a time; duplicates (same code and minute) are skipped.
export async function addPunches(list, onProgress) {
  for (let i = 0; i < list.length; i += 500) {
    const rows = list.slice(i, i + 500).map(([code, ts]) => ({ code, ts }));
    check(await client.from("punches").upsert(rows, { onConflict: "code,ts", ignoreDuplicates: true }));
    onProgress?.(Math.min(i + 500, list.length), list.length);
  }
}

// ---------------------------------------------------------------- training (neon/003_training.sql)

export let trainingReady = true;
const softT = (p) => p.catch((e) => { if (/schema cache|does not exist|PGRST20/i.test(e.message)) { trainingReady = false; return []; } throw e; });
const mapPlan = (p) => ({
  id: p.id, code: p.code, start: p.start_date, days: p.days, every: p.survey_every, mentor: p.mentor_code || "",
  status: p.status, goals: p.goals || "", decisionNote: p.decision_note || "", decidedAt: p.decided_at,
});

// Everything the training pages need; RLS trims it to what the caller may see.
export async function loadTraining(R = {}) {
  const [plans, responses, templates, videos, attempts, views, quizzes] = await Promise.all([
    softT(all(() => client.from("training_plans").select("*").order("start_date", { ascending: false }))),
    softT(all(() => client.from("survey_responses").select("*"))),
    softT(get(client.from("survey_templates").select("*").eq("active", true).order("id", { ascending: false }))),
    softT(get(client.from("training_videos").select("*").order("period_n").order("sort").order("id"))),
    softT(all(() => client.from("quiz_attempts").select("id,code,quiz_id,attempt_no,score,passed,at").order("at"))),
    softT(all(() => client.from("video_views").select("*"))),
    R.admin ? softT(get(client.from("quizzes").select("*"))) : softT(client.rpc("hr_quiz_list").then(check)),
  ]);
  return {
    plans: plans.map(mapPlan),
    responses: responses.map((r) => ({ id: r.id, plan: r.plan_id, n: r.period_n, side: r.side, answers: r.answers || {}, score: r.score == null ? null : Number(r.score), at: r.submitted_at })),
    templates: { self: templates.find((t) => t.side === "self"), mentor: templates.find((t) => t.side === "mentor") },
    videos: videos.map((v) => ({ id: v.id, title: v.title, drive: v.drive_url, notebook: v.notebooklm_url || "", period: v.period_n, summary: v.summary || "", active: v.active !== false, sort: v.sort })),
    attempts: attempts.map((a) => ({ id: a.id, code: a.code, quiz: a.quiz_id, no: a.attempt_no, score: a.score, passed: a.passed, at: a.at })),
    views: views.map((v) => ({ code: v.code, video: v.video_id, at: v.at })),
    quizzes: (quizzes || []).map((q) => ({ id: q.id, video: q.video_id, questions: q.questions || [], count: q.count ?? (q.questions || []).length, pass: q.pass_mark, attempts: q.max_attempts, minutes: q.minutes })),
  };
}

export async function startTraining(code, start, days, every, mentor, goals) {
  return check(await client.rpc("hr_start_training", { p_code: code, p_start: nullIfEmpty(start), p_days: Number(days) || 30, p_every: Number(every) || 7, p_mentor: nullIfEmpty(mentor), p_goals: nullIfEmpty(goals) }));
}
export async function decideTraining(plan, status, note, extend = 0) {
  check(await client.rpc("hr_decide_training", { plan, p_status: status, p_note: nullIfEmpty(note), p_extend: Number(extend) || 0 }));
}
export async function submitSurvey(plan, period, side, answers) {
  return check(await client.rpc("hr_submit_survey", { plan, p_period: period, p_side: side, p_answers: answers }));
}
export async function quizGet(id) { return check(await client.rpc("hr_quiz_get", { p_quiz: id })); }
export async function quizSubmit(id, answers) { return check(await client.rpc("hr_quiz_submit", { p_quiz: id, p_answers: answers })); }
export async function markWatched(code, video) {
  const { error } = await client.from("video_views").insert({ code, video_id: video });
  if (error && error.code !== "23505") check({ error });
}
export async function addVideo(v) { return check(await client.from("training_videos").insert(v).select("id"))?.[0]?.id; }
export async function updateVideo(id, fields) { check(await client.from("training_videos").update(fields).eq("id", id)); }
export async function deleteVideo(id) { check(await client.from("training_videos").delete().eq("id", id)); }
export async function saveQuiz(videoId, q) {
  check(await client.from("quizzes").upsert({ video_id: videoId, questions: q.questions, pass_mark: q.pass, max_attempts: q.attempts, minutes: q.minutes }, { onConflict: "video_id" }));
}
export async function deleteQuiz(videoId) { check(await client.from("quizzes").delete().eq("video_id", videoId)); }
export async function saveTemplate(side, questions) {
  check(await client.from("survey_templates").update({ active: false }).eq("side", side));
  check(await client.from("survey_templates").insert({ side, questions }));
}

// ---------------------------------------------------------------- recruitment (neon/004_recruitment.sql)

export let recruitReady = true;
export async function loadRecruit() {
  const [apps, reviews, positions] = await Promise.all([
    all(() => client.from("applications").select("*").order("created_at", { ascending: false })),
    all(() => client.from("application_reviews").select("*")),
    get(client.from("job_positions").select("*").order("sort").order("title")),
  ]).catch((e) => { if (/schema cache|does not exist|PGRST20/i.test(e.message)) { recruitReady = false; return [[], [], []]; } throw e; });
  const rev = Object.fromEntries(reviews.map((r) => [r.application_id, r]));
  return {
    apps: apps.map((a) => {
      const r = rev[a.id] || {};
      return { id: a.id, ref: a.ref, at: a.created_at, position: a.position, name: a.full_name, mobile: a.mobile, email: a.email || "", source: a.source || "",
        answers: a.answers || {}, auto: a.auto_score, status: a.status, statusAt: a.status_at, hired: a.hired_code || "",
        scores: r.scores || {}, interview: r.interview_total ?? null, intDate: r.interview_date || "", interviewer: r.interviewer || "", notes: r.hr_notes || "",
        decision: r.decision || "", decisionNote: r.decision_note || "", decidedAt: r.decided_at,
        hasCv: !!a.has_cv, about: r.about || "", cvMatch: r.cv_match || "", cvNote: r.cv_note || "",
        interviewAt: r.interview_at || "", interviewPlace: r.interview_place || "", invitedAt: r.invited_at || "" };
    }),
    positions: positions.map((p) => ({ id: p.id, title: p.title, active: p.active, sort: p.sort })),
  };
}
export async function appReview(id, scores, date, interviewer, notes) {
  return check(await client.rpc("hr_app_review", { p_app: id, p_scores: scores, p_date: nullIfEmpty(date), p_interviewer: interviewer || null, p_notes: notes || null }));
}
export async function appDecide(id, decision, note) { check(await client.rpc("hr_app_decide", { p_app: id, p_decision: decision, p_note: note || null })); }
export async function appStatus(id, status) { check(await client.rpc("hr_app_status", { p_app: id, p_status: status })); }
// CVs, HR's profile and interview invitations (neon/011_cv_leavers.sql)
export async function appCv(id) { return check(await client.rpc("hr_app_cv", { p_app: id })); }
export async function appAbout(id, about, match, note) { check(await client.rpc("hr_app_about", { p_app: id, p_about: about || null, p_match: match || null, p_note: note || null })); }
export async function appInvite(id, at, place) { check(await client.rpc("hr_app_invite", { p_app: id, p_at: at, p_place: place || null })); }
export async function empProfile(code) { return check(await client.rpc("hr_emp_profile", { p_code: code })); }
export async function hireApplication(id, code) { check(await client.rpc("hr_app_hire", { p_app: id, p_code: code })); }
export async function addPosition(title, sort) { check(await client.from("job_positions").insert({ title, sort })); }
export async function updatePosition(id, fields) { check(await client.from("job_positions").update(fields).eq("id", id)); }

// ---------------------------------------------------------------- weekly sales evaluation (neon/005_sales_eval.sql)

export let evalReady = true;
const softE = (p) => p.catch((e) => { if (/schema cache|does not exist|PGRST20|hr_eval_week/i.test(e.message)) { evalReady = false; return null; } throw e; });
// The selected week plus the 5 before it (for trends and alerts).
export async function loadEval(day) {
  const wid = await softE(client.rpc("hr_eval_week", { p_day: day || null }).then(check));
  if (wid == null) return null;
  const weeks = await get(client.from("eval_weeks").select("*").lte("id", wid).order("starts_on", { ascending: false }).limit(6));
  const ids = weeks.map((w) => w.id);
  const [entries, assignments, plans] = await Promise.all([
    all(() => client.from("eval_entries").select("*").in("week_id", ids)),
    get(client.from("eval_assignments").select("*")),
    get(client.from("team_month_plans").select("*")),
  ]);
  return {
    week: weeks.find((w) => w.id === wid),
    weeks: weeks.map((w) => ({ id: w.id, start: w.starts_on, end: w.ends_on, reopened: w.reopened_until })),
    entries: entries.map((x) => ({ code: x.code, week: x.week_id, cat: x.category, rating: x.rating, note: x.note || "", at: x.updated_at })),
    assignments: assignments.map((a) => ({ user: a.user_id, team: a.team_id, cat: a.category })),
    plans: plans.map((p) => ({ team: p.team_id, month: p.month, tasks: p.tasks || "", vision: p.vision || "" })),
  };
}
export async function evalOpen(week) { return check(await client.rpc("hr_eval_open", { p_week: week })); }
export async function evalSave(code, week, cat, rating, note) {
  check(await client.rpc("hr_eval_save", { p_code: code, p_week: week, p_category: cat, p_rating: rating, p_note: note || null }));
}
export async function evalReopen(week) { check(await client.rpc("hr_eval_reopen", { p_week: week, p_hours: 48 })); }
export async function evalRemind(week) { return check(await client.rpc("hr_eval_remind", { p_week: week })); }
export async function teamPlanSave(team, month, tasks, vision) { check(await client.rpc("hr_team_plan_save", { p_team: team, p_month: month, p_tasks: tasks, p_vision: vision })); }
export async function setAssignment(user, team, cat, on) {
  if (on) check(await client.from("eval_assignments").insert({ user_id: user, team_id: team, category: cat }));
  else check(await client.from("eval_assignments").delete().eq("user_id", user).eq("team_id", team).eq("category", cat));
}

// ---------------------------------------------------------------- to-do lists (neon/007_todos.sql)

export let todoReady = true;
const mapTodo = (t) => ({
  id: t.id, code: t.code, title: t.title, note: t.note || "", due: t.due || "", priority: t.priority, repeat: t.repeat,
  status: t.status, doneAt: t.done_at, doneBy: t.done_by || "", by: t.created_by || "", byCode: t.created_by_code || "", at: t.created_at,
});
// Open tasks plus the last 14 days of finished ones; RLS trims it to the caller's own and their team's.
export async function loadTodos() {
  const since = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  try {
    const rows = await all(() => client.from("todos").select("*").or(`status.eq.open,done_at.gte.${since}`).order("due", { ascending: true, nullsFirst: false }).order("id"));
    todoReady = true;
    return rows.map(mapTodo);
  } catch (e) { if (/schema cache|does not exist|PGRST20/i.test(e.message)) { todoReady = false; return []; } throw e; }
}
export async function todoAdd(code, title, note, due, priority, repeat) {
  return check(await client.rpc("hr_todo_add", { p_code: code, p_title: title, p_note: nullIfEmpty(note), p_due: nullIfEmpty(due), p_priority: priority || "normal", p_repeat: repeat || "none" }));
}
export async function todoSet(id, done) { return check(await client.rpc("hr_todo_set", { p_id: id, p_done: !!done })); }
export async function todoEdit(id, t) {
  check(await client.rpc("hr_todo_edit", { p_id: id, p_title: t.title, p_note: nullIfEmpty(t.note), p_due: nullIfEmpty(t.due), p_priority: t.priority || "normal", p_repeat: t.repeat || "none" }));
}
export async function todoCancel(id) { check(await client.rpc("hr_todo_cancel", { p_id: id })); }

// ---------------------------------------------------------------- company structure (neon/008_org.sql)

export let orgReady = true, orgError = "", deviceError = "";
// "the SQL file hasn't been run (or the API hasn't reloaded)" vs any other problem
const missing = (e) => /schema cache|PGRST20[0-9]|42883|42P01|does not exist/i.test(`${e.code || ""} ${e.message || ""}`);
// Units, people and positions. Everyone gets names and titles through hr_org_chart();
// the admin also edits units (teams) and positions directly.
export async function loadOrg() {
  try {
    const [chart, positions] = await Promise.all([client.rpc("hr_org_chart").then(check), get(client.from("org_positions").select("*").order("sort"))]);
    orgReady = true; orgError = "";
    return {
      units: (chart?.units || []).map((u) => ({ id: u.id, name: u.name, parent: u.parent ?? "", kind: u.kind || "sales", head: u.head || "", sort: u.sort || 0 })),
      people: (chart?.people || []).map((p) => ({ code: p.code, name: p.name, unit: p.unit ?? "", position: p.position || "", job: p.job || "", reports: p.reports || "" })),
      positions: positions.map((p) => ({ key: p.key, title: p.title, rank: p.rank, roles: p.roles || [], evalCats: p.eval_cats || [], evalScope: p.eval_scope || "none", sort: p.sort, track: p.track || "staff" })),
    };
  } catch (e) { orgError = e.message || String(e); orgReady = !missing(e); return null; }
}
export async function addUnit(name, parent, kind) {
  return check(await client.from("teams").insert({ name, parent_id: nullIfEmpty(parent) == null ? null : Number(parent), kind: kind || "sales" }).select("id"))?.[0]?.id;
}
export async function setPosition(code, position) { check(await client.rpc("hr_set_position", { p_code: code, p_position: nullIfEmpty(position) })); }
export async function savePosition(key, fields) {
  const row = {};
  if ("roles" in fields) row.roles = fields.roles;
  if ("evalCats" in fields) row.eval_cats = fields.evalCats;
  if ("evalScope" in fields) row.eval_scope = fields.evalScope;
  if ("title" in fields) row.title = fields.title;
  if ("track" in fields) row.track = fields.track;
  check(await client.from("org_positions").update(row).eq("key", key));
}
// the administration (neon/013_admin.sql): direct manager, personal permissions, new positions
export async function setReportsTo(code, boss) { check(await client.rpc("hr_set_reports_to", { p_code: code, p_boss: boss || null })); }
export async function setPersonRoles(code, plus, minus) { return check(await client.rpc("hr_set_person_roles", { p_code: code, p_plus: plus, p_minus: minus })); }
export async function addOrgPosition(title, track, roles) { return check(await client.rpc("hr_add_position", { p_title: title, p_track: track, p_roles: roles })); }
export async function dropOrgPosition(key) { check(await client.rpc("hr_drop_position", { p_key: key })); }
export async function applyTemplate(key) { return check(await client.rpc("hr_apply_template", { p_position: key })); }
export async function syncEvalAll() { return check(await client.rpc("hr_sync_eval_all")); }

// ---------------------------------------------------------------- fingerprint device sync (neon/009_device.sql)

export async function deviceStatus() {
  try { deviceError = ""; return (check(await client.rpc("hr_device_status")) || []).map((d) => ({ serial: d.serial, name: d.name, lastSeen: d.last_seen, lastPunch: d.last_punch, lastCount: d.last_count, error: d.last_error || "", errorAt: d.error_at, today: d.today || 0 })); }
  catch (e) { deviceError = e.message || String(e); if (missing(e)) return null; throw e; }
}
export async function deviceAdd(serial, name) { check(await client.rpc("hr_device_add", { p_serial: serial, p_name: name || null })); }
export async function deviceRemove(serial) { check(await client.rpc("hr_device_remove", { p_serial: serial })); }

// ---------------------------------------------------------------- CRM (neon/012_crm.sql)

export let crmReady = true;
const LEAD_COLS = "id,name,phone_tail,source,campaign,project_id,budget,notes,owner_code,assigned_at,stage,lost_reason,next_action_at,first_action_at,last_action_at,created_at,created_by_code";
// Open leads plus those closed in the last 90 days; phone numbers only where the caller may see them.
export async function loadCrm() {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const [leads, projects, contacts] = await Promise.all([
    all(() => client.from("crm_leads").select(LEAD_COLS).or(`stage.not.in.(won,lost),last_action_at.gte.${since},created_at.gte.${since}`).order("created_at", { ascending: false })),
    get(client.from("crm_projects").select("*").order("sort").order("name")),
    client.rpc("hr_lead_contacts").then(check),
  ]).catch((e) => { if (/schema cache|does not exist|PGRST20|hr_lead/i.test(e.message)) { crmReady = false; return [[], [], []]; } throw e; });
  crmReady = true;
  const ph = Object.fromEntries((contacts || []).map((c) => [c.id, c]));
  return {
    leads: leads.map((l) => ({ id: l.id, name: l.name, tail: l.phone_tail, phone: ph[l.id]?.phone || "", phone2: ph[l.id]?.phone2 || "", source: l.source, campaign: l.campaign || "",
      project: l.project_id, budget: l.budget || "", notes: l.notes || "", owner: l.owner_code || "", assignedAt: l.assigned_at, stage: l.stage, lost: l.lost_reason || "",
      next: l.next_action_at, first: l.first_action_at, last: l.last_action_at, at: l.created_at, by: l.created_by_code || "" })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, developer: p.developer || "", area: p.area || "", active: p.active !== false })),
  };
}
export async function crmActivities(id) { return get(client.from("crm_activities").select("*").eq("lead_id", id).order("at", { ascending: false }).limit(100)); }
export async function crmAdd(v) {
  return check(await client.rpc("hr_lead_add", { p_name: v.name, p_phone: v.phone, p_source: v.source || "manual", p_campaign: v.campaign || null,
    p_project: v.project ? Number(v.project) : null, p_notes: v.notes || null, p_owner: v.owner || null, p_phone2: v.phone2 || null, p_budget: v.budget || null }));
}
export async function crmAssign(id, code) { check(await client.rpc("hr_lead_assign", { p_id: id, p_code: code || null })); }
export async function crmLog(id, kind, result, note, next) { return check(await client.rpc("hr_lead_log", { p_id: id, p_kind: kind, p_result: result || null, p_note: note || null, p_next: next || null })); }
export async function crmClose(id, reason) { check(await client.rpc("hr_lead_close", { p_id: id, p_reason: reason })); }
export async function crmImport(rows) { return check(await client.rpc("hr_lead_import", { p_rows: rows })); }
export async function crmAddProject(name, developer, area) { check(await client.from("crm_projects").insert({ name, developer: developer || null, area: area || null })); }

// ---------------------------------------------------------------- commissions (neon/014_commissions.sql)

export let comReady = true;
const num = (v) => (v == null || v === "" ? null : Number(v));
// Everything the commissions owner (or viewer) works with. Anyone else gets empty
// lists from the database, so this returns null for them.
export async function loadCom() {
  try {
    const [settings, roles, deals, shares, parts, ents, payouts, files, people] = await Promise.all([
      get(client.from("com_settings").select("*")), get(client.from("com_roles").select("*").order("sort")),
      get(client.from("com_deals").select("*").order("sale_date", { ascending: false })), get(client.from("com_shares").select("*")),
      get(client.from("com_parts").select("*").order("id")), get(client.from("com_entitlements").select("*").order("id")),
      get(client.from("com_payouts").select("*").order("paid_on", { ascending: false })),
      get(client.from("com_files").select("id,deal_id,slot,name,mime,size,created_at")), client.rpc("hr_com_people").then(check)]);
    comReady = true;
    if (!settings.length) return null;
    const st = settings[0];
    return {
      settings: { vat: Number(st.vat), wht: Number(st.wht), show: !!st.show, docs: st.docs || {} },
      roles: roles.map((r) => ({ key: r.key, title: r.title, pct: Number(r.pct), sort: r.sort, active: r.active !== false })),
      deals: deals.map((d) => ({ id: d.id, ref: d.ref || "", client: d.client, phone: d.phone || "", projectId: d.project_id ?? "", project: d.project || "", developer: d.developer || "",
        unit: d.unit || "", price: Number(d.price), rate: Number(d.rate), resale: Number(d.resale_amount), method: d.method, register: d.register || "", status: d.status,
        sale: d.sale_date, contract: d.contract_date || "", leadId: d.lead_id ?? "", notes: d.notes || "", commission: Number(d.commission), cancelReason: d.cancel_reason || "" })),
      shares: shares.map((x) => ({ id: x.id, deal: x.deal_id, code: x.code, role: x.role, pct: Number(x.pct) })),
      parts: parts.map((p) => ({ id: p.id, deal: p.deal_id, amount: Number(p.amount), type: p.inv_type, wht: !!p.wht, ref: p.ref || "", claim: p.claim_date || "", sent: p.sent_date || "",
        due: p.due_date || "", collected: p.collected_date || "", received: num(p.received), note: p.note || "" })),
      ents: ents.map((e) => ({ id: e.id, deal: e.deal_id, part: e.part_id, code: e.code, role: e.role, kind: e.kind, pct: Number(e.pct), base: Number(e.base), amount: Number(e.amount),
        status: e.status, published: e.published_at || "", payout: e.payout_id ?? "", at: e.created_at })),
      payouts: payouts.map((p) => ({ id: p.id, code: p.code, paidOn: p.paid_on, method: p.method, ref: p.ref || "", amount: Number(p.amount), note: p.note || "", status: p.status })),
      files: files.map((f) => ({ id: f.id, deal: f.deal_id, slot: f.slot, name: f.name, size: f.size })),
      people: people || [],
    };
  } catch (e) { comReady = !missing(e); if (missing(e)) return null; throw e; }
}
const DEAL_COLS = { ref: "ref", client: "client", phone: "phone", projectId: "project_id", project: "project", developer: "developer", unit: "unit", price: "price", rate: "rate",
  resale: "resale_amount", method: "method", register: "register", status: "status", sale: "sale_date", contract: "contract_date", notes: "notes" };
const NUMERIC = new Set(["price", "rate", "resale_amount", "project_id"]);
function dealRow(f) {
  const row = {};
  for (const [k, c] of Object.entries(DEAL_COLS)) if (k in f) row[c] = NUMERIC.has(c) ? num(f[k]) : nullIfEmpty(f[k]);
  return row;
}
export async function comSaveDeal(id, fields) {
  if (id) { check(await client.from("com_deals").update(dealRow(fields)).eq("id", id)); return id; }
  return check(await client.from("com_deals").insert(dealRow(fields)).select("id"))?.[0]?.id;
}
export async function comAddShare(deal, code, role, pct) { check(await client.from("com_shares").insert({ deal_id: deal, code, role, pct: Number(pct) })); }
export async function comSetShare(id, pct) { check(await client.from("com_shares").update({ pct: Number(pct) }).eq("id", id)); }
export async function comDropShare(id) { check(await client.from("com_shares").delete().eq("id", id)); }
export async function comAddPart(deal, f) {
  check(await client.from("com_parts").insert({ deal_id: deal, amount: Number(f.amount), inv_type: f.type || "G", wht: !!f.wht, ref: nullIfEmpty(f.ref), due_date: nullIfEmpty(f.due) }));
}
// one step forward on a part: claimed, invoice sent, collected (dates default to today)
export async function comPartStep(id, field, date, extra = {}) {
  const col = { claim: "claim_date", sent: "sent_date", collected: "collected_date", due: "due_date" }[field];
  check(await client.from("com_parts").update({ [col]: nullIfEmpty(date), ...extra }).eq("id", id));
}
export async function comDropPart(id) { check(await client.from("com_parts").delete().eq("id", id)); }
export async function comCancel(deal, reason) { return check(await client.rpc("hr_com_cancel", { p_deal: deal, p_reason: reason })); }
export async function comApprove(ids) { return check(await client.rpc("hr_com_approve", { p_ids: ids })); }
export async function comPublish(ids, on) { return check(await client.rpc("hr_com_publish", { p_ids: ids, p_on: on })); }
export async function comPay(ids, date, method, ref, note) { return check(await client.rpc("hr_com_pay", { p_ids: ids, p_paid_on: date, p_method: method, p_ref: ref || null, p_note: note || null })); }
export async function comUnpay(id, reason) { check(await client.rpc("hr_com_unpay", { p_payout: id, p_reason: reason })); }
export async function comGrant(user, role, on) { check(await client.rpc("hr_com_grant", { p_user: user, p_role: role, p_on: on })); }
export async function comSaveSettings(f) { check(await client.from("com_settings").update(f).eq("id", 1)); }
export async function comSaveRole(key, f) { check(await client.from("com_roles").update(f).eq("key", key)); }
export async function comAddRole(key, title, pct, sort) { check(await client.from("com_roles").insert({ key, title, pct: Number(pct), sort })); }
export async function comFileAdd(deal, slot, file) {
  const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  return check(await client.rpc("hr_com_file_add", { p_deal: deal, p_slot: slot, p_name: file.name, p_mime: file.type, p_b64: b64 }));
}
export async function comFile(id) { return check(await client.rpc("hr_com_file", { p_id: id })); }
export async function myCommissions() {
  try { return (check(await client.rpc("hr_my_commissions")) || []); } catch (e) { if (missing(e)) return []; throw e; }
}
