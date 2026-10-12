// Copies the read-only hr_bridge views (Supabase: Recruitment + Sales Hub)
// into the HR portal's ext_* tables on Neon. Runs daily from GitHub Actions.
//
//   SUPABASE_RO_URL  connection string for the hr_reader login (read-only views)
//   NEON_SYNC_URL    connection string for the hr_sync login (ext_* tables only)
//
// Each source is copied in its own transaction and logged to sync_runs.
// Row contents are never printed: logs show counts and errors only.
import pg from "pg";

const { SUPABASE_RO_URL, NEON_SYNC_URL, SUPABASE_CA } = process.env;
if (!SUPABASE_RO_URL || !NEON_SYNC_URL) {
  console.error("Missing SUPABASE_RO_URL or NEON_SYNC_URL");
  process.exit(2);
}
const local = (url) => /@(localhost|127\.0\.0\.1)|host=\//.test(url);
// Supabase's pooler certificate is signed by Supabase's own CA; pass it in SUPABASE_CA to verify it.
const src = new pg.Client({ connectionString: SUPABASE_RO_URL, ssl: local(SUPABASE_RO_URL) ? false : SUPABASE_CA ? { ca: SUPABASE_CA } : { rejectUnauthorized: false } });
const dst = new pg.Client({ connectionString: NEON_SYNC_URL, ssl: local(NEON_SYNC_URL) ? false : { rejectUnauthorized: true } });

const SOURCES = [
  {
    name: "candidates",
    read: "select app_id, full_name, mobile, position, auto_score, recommendation, submitted_at, interview_total, interview_date, decision, decided_on from hr_bridge.candidates",
    // linked_code / dismissed belong to the portal and are never written here; linked rows are kept
    write: [
      `insert into ext_candidates (app_id, full_name, mobile, position, auto_score, recommendation, submitted_at, interview_total, interview_date, decision, decided_on, synced_at)
       select x.*, now() from jsonb_to_recordset($1::jsonb) as x(app_id uuid, full_name text, mobile text, position text, auto_score int, recommendation text,
         submitted_at timestamptz, interview_total int, interview_date date, decision text, decided_on date)
       on conflict (app_id) do update set full_name = excluded.full_name, mobile = excluded.mobile, position = excluded.position,
         auto_score = excluded.auto_score, recommendation = excluded.recommendation, submitted_at = excluded.submitted_at,
         interview_total = excluded.interview_total, interview_date = excluded.interview_date, decision = excluded.decision,
         decided_on = excluded.decided_on, synced_at = excluded.synced_at`,
      `delete from ext_candidates where linked_code is null and app_id not in (select (x->>'app_id')::uuid from jsonb_array_elements($1::jsonb) x)`,
    ],
  },
  {
    name: "hub_members",
    read: "select id, full_name, team_code, team_name, status, joined_at from hr_bridge.hub_members",
    write: [
      `insert into ext_hub_members (id, full_name, team_code, team_name, status, joined_at, synced_at)
       select x.*, now() from jsonb_to_recordset($1::jsonb) as x(id uuid, full_name text, team_code text, team_name text, status text, joined_at date)
       on conflict (id) do update set full_name = excluded.full_name, team_code = excluded.team_code, team_name = excluded.team_name,
         status = excluded.status, joined_at = excluded.joined_at, synced_at = excluded.synced_at`,
      `delete from ext_hub_members where id not in (select (x->>'id')::uuid from jsonb_array_elements($1::jsonb) x)`,
    ],
  },
  {
    name: "hub_entries",
    read: "select member_id, ends_on, category, week_label, starts_on, content, updated_at from hr_bridge.hub_entries",
    write: [
      "delete from ext_hub_entries",
      `insert into ext_hub_entries (member_id, ends_on, category, week_label, starts_on, content, updated_at)
       select * from jsonb_to_recordset($1::jsonb) as x(member_id uuid, ends_on date, category text, week_label text, starts_on date, content text, updated_at timestamptz)
       on conflict do nothing`,
    ],
  },
  {
    name: "hub_recs",
    read: "select member_id, week_end, rule_code, message_ar, severity from hr_bridge.hub_recs",
    write: [
      "delete from ext_hub_recs",
      `insert into ext_hub_recs (member_id, week_end, rule_code, message_ar, severity)
       select * from jsonb_to_recordset($1::jsonb) as x(member_id uuid, week_end date, rule_code text, message_ar text, severity text)
       on conflict do nothing`,
    ],
  },
];

const short = (e) => String(e?.message || e).replace(/postgres(ql)?:\/\/\S+/g, "[url]").slice(0, 300);
let failed = 0;
try { await dst.connect(); } catch (e) { console.error(`HR portal (Neon): cannot connect - ${short(e)}`); process.exit(1); }
try { await src.connect(); } catch (e) {
  console.error(`Recruitment/Sales Hub (Supabase): cannot connect - ${short(e)}`);
  await dst.query("insert into sync_runs (source, ok, error) values ('connect', false, $1)", [short(e)]).catch(() => {});
  await dst.end(); process.exit(1);
}
for (const s of SOURCES) {
  try {
    const { rows } = await src.query(s.read);
    const json = JSON.stringify(rows);
    await dst.query("begin");
    for (const q of s.write) await dst.query(q, q.includes("$1") ? [json] : []);
    await dst.query("insert into sync_runs (source, rows, ok) values ($1, $2, true)", [s.name, rows.length]);
    await dst.query("commit");
    console.log(`${s.name}: ${rows.length} rows`);
  } catch (e) {
    failed++;
    await dst.query("rollback").catch(() => {});
    await dst.query("insert into sync_runs (source, ok, error) values ($1, false, $2)", [s.name, short(e)]).catch(() => {});
    console.error(`${s.name}: failed - ${short(e)}`);
  }
}
await src.end();
await dst.end();
process.exit(failed ? 1 : 0);
