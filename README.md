# نموذج طلب توظيف — إيفرست · Everest Job Application Form

A bilingual (Arabic RTL / English LTR) job application form, backed by Supabase.
Still a plain static site: no framework, no bundler, no build step.

---

## What changed

The form's markup and styling are untouched. What was replaced is the backend
and the way the JavaScript is organised.

| Before | After |
| --- | --- |
| One 300-line inline `<script>` | 20 ES modules under `js/` |
| Submitted to a Google Apps Script URL | Supabase Postgres, autosaved as you type |
| Anyone with the file could submit | Applicants submit anonymously; staff sign in; every row protected by RLS |
| HR section visible to everyone | HR section is staff-only, in a separate table |
| No multi-device story | Realtime sync across tabs and devices |
| "Clear Sheet" wiped the spreadsheet | "Delete All Applications", admin-only, inside the applications panel |

`sherifmounierhr@gmail.com` is granted the `admin` role automatically, by a
database trigger, on sign-up. That account already existed in the project and
was promoted by the migration's backfill.

---

## Layout

```
index.html                      the form (markup unchanged, script swapped for a module)
css/app-supabase.css            styles for the new elements only
js/
  config.js          project URL + publishable key, client id
  supabaseClient.js  the single client, imported from the jsDelivr CDN
  i18n.js            AR/EN toggle
  formSchema.js      skills, languages, criteria, field lists — one source of truth
  formBuilder.js     renders the three generated tables
  conditionalFields.js follow-ups shown only after a given answer (data-show-when)
  formState.js       reads/writes the DOM form
  scoring.js         preliminary score, age, interview total
  auth.js            sign in/up, anonymous sessions, role
  humanCheck.js      Cloudflare Turnstile in front of anonymous sign-in
  requiredFields.js  red asterisks + submit validation, from one list
  authRedirect.js    reads the email-callback params before the client strips them
  applications.js    queries against applications + application_reviews
  realtime.js        one channel, both tables, self-echo filtered
  main.js            wiring and bootstrap
  ui/
    dom.js  status.js  authPanel.js  staffPanel.js
supabase/migrations/
  0001_init.sql                  tables, roles, triggers, RLS, realtime
  0002_harden_functions.sql      linter fixes: search_path, RPC surface
  0003_application_profile_fk.sql lets PostgREST embed the applicant profile
  0004_anonymous_applicants.sql  makes profiles.email nullable for anonymous users
```

All four migrations are already applied to project `nhmbbulidexzczrwjmyx`.

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
  put a service-role key there. There is no in-app settings dialog: applicants
  have no business repointing the form, so the credentials live in `config.js`
  and changing project means editing that file and redeploying.

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

Then open <http://localhost:4173/>.

## Deploying it

Upload the repository as-is to any static host — Netlify, Vercel, GitHub Pages,
Cloudflare Pages, S3. There is no build step. Four things to set in the Supabase
dashboard once you know the public URL:

1. **Authentication → URL Configuration** — set *Site URL* to the deployed
   origin and add it to *Redirect URLs*. If this still says `localhost`, every
   confirmation email sends the recipient to a page their device cannot reach
   ("This site can't be reached"), which looks like a broken signup but is
   purely this setting.
2. **Authentication → Sign In / Providers → Anonymous sign-ins** — turn this
   **on**. Applicants never create an account; they get an anonymous session,
   which is what ties their answers to a row only they can read. With it off the
   form falls back to the staff dialog and says so.
3. **Authentication → Attack Protection → Enable CAPTCHA protection** — choose
   Cloudflare Turnstile and paste the *secret* key, then put the matching *site*
   key in `TURNSTILE_SITE_KEY` in `js/config.js`. Both halves must be switched on
   together, or every sign-in fails. Leaving both empty skips the check.

   This setting is project-wide: it also gates the staff sign-in dialog, not
   only the applicant's anonymous session. Both paths get a token from the same
   Turnstile widget before calling Supabase -- see js/humanCheck.js and
   resolveHumanToken() in js/ui/authPanel.js. A staff sign-in that fails with
   "no captcha_token found" or "invalid-input-response" almost always means the
   site key here and the secret key in Supabase belong to two different
   Cloudflare widgets -- each widget has its own matched pair, and they are not
   interchangeable.
   Also confirm the widget's Hostname Management in the Cloudflare dashboard
   lists the exact deployed domain -- Turnstile error 110200 means it does not.
4. **Authentication → Providers → Email** — decide whether to require email
   confirmation for staff accounts.

The form lives at `index.html`, so the deployed root URL serves it directly.
(It was originally named `نموذج طلب توظيف - إيفرست.html`; a static host has
nothing to serve at `/` unless the entry file is called `index.html`, which is
what produced a 404 on the first deploy.)

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
- **Anonymous drafts are per browser.** The session lives in localStorage, so an
  applicant returning on the same device resumes their draft, but the same
  person on a different device starts over. There is no way to recover a draft
  from a lost session -- which is the trade for not making them register.

The original single-file version is the first commit in this repository, so
`git diff <first-commit> -- '*.html'` shows exactly what the migration changed
to the markup.
