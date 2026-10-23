# Everest Eco System

The staff portal for Everest Real Estate: attendance, requests, pay, training,
recruitment, weekly evaluation, to-dos and the company structure. It's a
static site on GitHub Pages, backed by Neon (Neon Auth plus the Data API, with
row-level security on every table).

- Portal: `hr/` (see `hr/README.md`)
- Public job application form: `hr/apply.html`
- Database, in order: `neon/schema.sql`, then `neon/002_*.sql` through `neon/019_no_punch.sql`
- Fingerprint device sync for the office PC: `tools/device/`
- Weekly email report: `tools/report/` and `.github/workflows/hr-weekly.yml`

The site root redirects to `hr/`.

## The old application form

The earlier Supabase-based application form that used to live at the site root
was retired from the published site (its code is in this repository's git
history, and `supabase/migrations/` keeps its database scripts for reference).
The Supabase project it used is shared with other apps and wasn't changed.

## Security in short

- Nothing secret is in this repository. Passwords and connection strings live
  in GitHub Secrets (the weekly report) and in `config.ini` on the office PC
  (the device sync), never here.
- No real employee data is committed: spreadsheets, `seed.sql`, `state.json`
  and `config.ini` are ignored by git.
- Every table has row-level security. Seeing and deciding are separate
  permissions (`viewall` / `approveall`); see `neon/010_security.sql`.
