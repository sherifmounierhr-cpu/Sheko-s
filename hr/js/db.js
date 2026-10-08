// Neon Auth + Neon Data API. Every read and write goes through row level
// security in neon/schema.sql; the UI only hides what the database refuses.
import { createClient, SupabaseAuthAdapter } from "./vendor/neon.js";
import { NEON_AUTH_URL, NEON_DATA_API_URL } from "./config.js";

export const configured = Boolean(NEON_AUTH_URL && NEON_DATA_API_URL);

export const client = configured
  ? createClient({
      auth: { adapter: SupabaseAuthAdapter(), url: NEON_AUTH_URL },
      dataApi: { url: NEON_DATA_API_URL },
    })
  : null;

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
  if (isAdmin) {
    [pay, payroll, users, invites] = await Promise.all([
      all(() => f(client.from("employee_pay").select("*"))),
      all(() => f(client.from("payroll").select("*")).eq("month", ym)),
      all(() => client.from("app_users").select("*").order("created_at")),
      soft(get(client.from("invites").select("employee_code,created_at,expires_at,used_at"))),
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
    teams: teams.map((t) => ({ id: t.id, name: t.name, manager: t.manager_code || "" })),
    employees: employees.map((e) => {
      const p = payBy[e.code] || {};
      return {
        code: e.code, name: e.name || "", fullName: e.full_name || "", device: e.device_name || "",
        teamId: e.team_id ?? "", job: e.job || "", dept: e.dept || "",
        in: hhmm(e.shift_in), out: hhmm(e.shift_out), off: e.off_day ?? "", exempt: !!e.exempt, active: e.active !== false,
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
  in: "shift_in", out: "shift_out", off: "off_day", exempt: "exempt", active: "active" };
const PAY_COLS = { salary: "salary", account: "account", pay: "pay_method" };

export async function updateEmployee(code, field, value) {
  if (EMP_COLS[field]) {
    check(await client.from("employees").update({ [EMP_COLS[field]]: nullIfEmpty(value) }).eq("code", code));
  } else if (PAY_COLS[field]) {
    check(await client.from("employee_pay").upsert({ code, [PAY_COLS[field]]: nullIfEmpty(value) ?? (field === "salary" ? 0 : null) }, { onConflict: "code" }));
  }
}

export async function addEmployee(code, name, teamId) {
  check(await client.from("employees").insert({ code, name, team_id: nullIfEmpty(teamId) }));
}

export async function saveSettings(data) {
  check(await client.from("settings").upsert({ id: 1, data }, { onConflict: "id" }));
}

export async function addTeam(name) { check(await client.from("teams").insert({ name })); }
export async function updateTeam(id, fields) {
  const row = {};
  if ("name" in fields) row.name = fields.name;
  if ("manager" in fields) row.manager_code = nullIfEmpty(fields.manager);
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
export async function markRead(ids) {
  if (!ids.length) return;
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
