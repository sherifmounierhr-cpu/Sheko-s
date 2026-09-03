# نموذج طلب توظيف — إيفرست · Everest Job Application Form

A bilingual (Arabic RTL / English LTR) job application form, backed by Supabase.
Still a plain static site: no framework, no bundler, no build step.

---

## What changed

The form's markup and styling are untouched. What was replaced is the backend
and the way the JavaScript is organised.

| Before | After |
| --- | --- |
| One 300-line inline `<script>` | 13 ES modules under `js/` |
| Submitted to a Google Apps Script URL | Supabase Postgres, autosaved as you type |
| Anyone with the file could submit | Supabase Auth; every row protected by RLS |
| HR section visible to everyone | HR section is staff-only, in a separate table |
| No multi-device story | Realtime sync across tabs and devices |
| "Clear Sheet" wiped the spreadsheet | "Delete All Applications", admin-only |

`sherifmounierhr@gmail.com` is granted the `admin` role automatically, by a
database trigger, on sign-up. That account already existed in the project and
was promoted by the migration's backfill.

---

## Layout

```
نموذج طلب توظيف - إيفرست.html   the form (markup unchanged, script swapped for a module)
css/app-supabase.css            styles for the new elements only
js/
  config.js          project URL + publishable key, per-browser override, client id
  supabaseClient.js  the single client, imported from the jsDelivr CDN
  i18n.js            AR/EN toggle
  formSchema.js      skills, languages, criteria, field lists — one source of truth
  formBuilder.js     renders the three generated tables
  formState.js       reads/writes the DOM form
  scoring.js         preliminary score, age, interview total
  auth.js            sign in/up, session, role
  applications.js    queries against applications + application_reviews
  realtime.js        one channel, both tables, self-echo filtered
  main.js            wiring and bootstrap
  ui/
    dom.js  status.js  authPanel.js  staffPanel.js  settingsPanel.js
supabase/migrations/
  0001_init.sql                  tables, roles, triggers, RLS, realtime
  0002_harden_functions.sql      linter fixes: search_path, RPC surface
  0003_application_profile_fk.sql lets PostgREST embed the applicant profile
```

All three migrations are already applied to project `nhmbbulidexzczrwjmyx`.

---

## Data model

**`profiles`** — one row per auth user, carrying `role` (`applicant` | `hr` | `admin`).
Created by the `on_auth_user_created` trigger.

**`applications`** — one row per user (`user_id` is unique, so the client upserts).
The applicant's answers live in an `answers` jsonb column keyed by input `name`.

**`application_reviews`** — the HR evaluation, keyed by `application_id`.

The HR review is a **separate table on purpose**. RLS is row-level, not
column-level: if the interview scores and HR notes lived on the application row,
any applicant who can read their own row could read their own evaluation. In a
separate table with a staff-only policy, they cannot.

---

## Security model

Nothing is enforced in the browser. The client reads `profiles.role` only to
decide what to *show*; a tampered client can flip itself into "admin" mode and
still read nothing extra.

- `anon` has no grants at all on the three tables — an unauthenticated request
  is refused before RLS is even consulted.
- Applicants: see their own application, and no reviews.
- HR / admin: see every application and every review.
- Only admins can delete other people's applications.
- `guard_profile_role` makes `id`, `email` and `role` read-only from an ordinary
  session, so a user can neither set `role = 'admin'` nor rewrite their profile
  email to the bootstrap admin address. Email changes only flow in from
  `auth.users` via a trigger that sets a transaction-local flag.
- The publishable key in `js/config.js` is a public credential by design. Never
  put a service-role key there.

These were verified against the live database with throwaway fixtures (since
deleted): a probe applicant saw 1 application and **0** reviews; the admin saw
all of both; and both escalation attempts were silently reverted.

---

## Running it

It must be served over `http://` or `https://` — ES modules do not load from
`file://`. Any static server works:

```bash
python -m http.server 4173
```

Then open <http://localhost:4173/> and pick the HTML file.

## Deploying it

Upload the repository as-is to any static host — Netlify, Vercel, GitHub Pages,
Cloudflare Pages, S3. There is no build step. Two things to set in the Supabase
dashboard once you know the public URL:

1. **Authentication → URL Configuration** — add the deployed URL to *Site URL*
   and *Redirect URLs*, or magic links and email confirmations will bounce back
   to localhost.
2. **Authentication → Providers → Email** — decide whether to require email
   confirmation. With it on, sign-up returns no session and the dialog tells the
   user to check their inbox.

Consider renaming the HTML file to `index.html` (or adding a redirect) so the
site has a clean root URL; the Arabic filename percent-encodes to a long path.

---

## Known follow-ups

- **Leaked-password protection is off.** Supabase can check new passwords
  against HaveIBeenPwned. Turn it on under *Authentication → Policies*; it is a
  dashboard setting, not something a migration can do.
- **Granting the `hr` role** has no UI yet. Do it from the SQL editor:
  ```sql
  update public.profiles set role = 'hr' where email = 'someone@example.com';
  ```
  (Run as the service role, or while signed in as an admin.)
- **No CSV export.** The Arabic column labels the old Google Sheet used are
  still in `js/formSchema.js` if you want to add one.

The original single-file version is the first commit in this repository, so
`git diff <first-commit> -- '*.html'` shows exactly what the migration changed
to the markup.
