// "شوف شاشته": the admin previews the portal as another user.
//
// The admin's session reads everything, so the preview trims the loaded data
// with the same rules the database applies to that user (the read policies in
// neon/schema.sql and neon/002-007). Keep the two in step: tools/viewas test
// compares this against the real policies for every test user.

// target: { id, code, roles } (roles as stored; admin previews are not trimmed). evalTeams: team ids the target rates (eval_assignments).
export function visibleCodes(target, S, TR, evalTeams = []) {
  const has = (r) => target.roles.includes(r);
  const mine = target.code || "";
  // hr_manages in neon/010_security.sql: everyone with viewall or approveall; with manager, every unit at or below one they head
  const managed = has("viewall") || has("approveall") ? new Set(S.employees.map((e) => e.code)) : treeCodes(target, S);
  const evaluated = new Set(S.employees.filter((e) => evalTeams.some((t) => String(t) === String(e.teamId))).map((e) => e.code));
  const plans = TR?.plans || [];
  const mentees = new Set(mine ? plans.filter((p) => p.status === "active" && p.mentor && p.mentor === mine).map((p) => p.code) : []);
  const myMentors = new Set(mine ? plans.filter((p) => p.code === mine && p.mentor).map((p) => p.mentor) : []);
  const self = (c) => !!mine && c === mine;
  return { mine, managed, evaluated, mentees, myMentors, self, has,
    team: (c) => managed.has(c) || self(c),
    follows: (c) => managed.has(c) || mentees.has(c) };
}

// employees in the units `target` heads and everything below them
function treeCodes(target, S) {
  const mine = target.code || "";
  const units = new Set(target.roles.includes("manager") && mine ? S.teams.filter((t) => t.manager === mine).map((t) => String(t.id)) : []);
  for (let grew = true; grew;) { grew = false; for (const t of S.teams) if (t.parent !== "" && t.parent != null && units.has(String(t.parent)) && !units.has(String(t.id))) { units.add(String(t.id)); grew = true; } }
  return new Set(S.employees.filter((e) => units.has(String(e.teamId))).map((e) => e.code));
}

// hr_decides in neon/010_security.sql: who `me` may decide for (never themself);
// approveall decides for anyone, a manager for their tree. viewall alone only sees.
export function decidesFor(me, S) {
  const mine = me.code || "";
  if (me.roles.includes("admin")) return () => true;
  if (me.roles.includes("approveall")) return (c) => !!c && c !== mine;
  const tree = treeCodes(me, S);
  return (c) => !!c && c !== mine && tree.has(c);
}

export function scopeAs(target, S, TR, REC, evalTeams = []) {
  const v = visibleCodes(target, S, TR, evalTeams), { has, team, self } = v;
  const empOk = (c) => has("uploader") || has("meetings") || team(c) || v.evaluated.has(c) || v.mentees.has(c) || v.myMentors.has(c);
  const punchOk = (c) => has("uploader") || team(c);
  const meetOk = (c) => has("meetings") || team(c);

  const out = { ...S };
  const payOk = has("pay");
  out.employees = S.employees.map((e) => (self(e.code) || payOk ? e : { ...e, salary: 0, account: "", pay: "cash" })).filter((e) => empOk(e.code));
  out.punches = Object.fromEntries(Object.entries(S.punches).filter(([c]) => punchOk(c)));
  out.perms = S.perms.filter((p) => team(p.code));
  out.meetings = S.meetings.filter((m) => meetOk(m.code));
  out.overrides = Object.fromEntries(Object.entries(S.overrides).filter(([k]) => team(k.split("|")[0])));
  out.actions = S.actions.filter((a) => v.managed.has(a.code) || (self(a.code) && a.status === "approved"));
  out.checkins = S.checkins.filter((c) => team(c.code));
  out.payroll = Object.fromEntries(Object.entries(S.payroll).map(([m, rows]) => [m, Object.fromEntries(Object.entries(rows).filter(([c]) => payOk || self(c)))]));
  out.users = [];
  out.invites = [];

  let tr = TR;
  if (TR) {
    const planOk = (p) => self(p.code) || v.follows(p.code);
    const plans = TR.plans.filter(planOk), ids = new Set(plans.map((p) => p.id));
    tr = { ...TR, plans,
      responses: TR.responses.filter((r) => ids.has(r.plan)),
      attempts: TR.attempts.filter((a) => self(a.code) || v.follows(a.code)),
      views: TR.views.filter((x) => self(x.code) || v.follows(x.code)),
      // the answer key is admin-only; others get the question count only
      quizzes: TR.quizzes.map((q) => ({ ...q, questions: [] })) };
  }
  const rec = has("recruiter") ? REC : null;
  return { S: out, TR: tr, REC: rec, v };
}

// Weekly evaluation: what the target may read (neon/005_sales_eval.sql).
export function scopeEval(target, EV, S, v) {
  if (!EV) return EV;
  const show = S.settings?.evalToEmployee !== false;
  return { ...EV,
    entries: EV.entries.filter((x) => v.managed.has(x.code) || v.evaluated.has(x.code) || (show && v.self(x.code))),
    assignments: EV.assignments.filter((a) => a.user === target.id || v.has("manager")) };
}

// To-do lists: own, plus the team the target manages.
export const scopeTodos = (list, v) => list.filter((t) => v.team(t.code));

// Today's live board: the target's team only.
export function scopeLive(L, v) {
  if (!L) return L;
  return { checkins: L.checkins.filter((c) => v.team(c.code)), punches: L.punches.filter((p) => v.has("uploader") || v.team(p.code)), meetings: L.meetings.filter((m) => v.has("meetings") || v.team(m.code)) };
}
