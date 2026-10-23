# Everest Eco System

Attendance, requests, client meetings and payroll for Everest Real Estate,
with a login per person and permissions enforced by the database.
Plain static site (no build step) backed by Neon: Neon Auth for sign-in and
the Neon Data API for queries, with row level security on every table.

## Who can do what

| Role (app_users.roles) | Can |
| --- | --- |
| `admin` | everything: employees, salaries, payroll, settings, teams, users |
| `uploader` | upload the fingerprint device export; view attendance |
| `meetings` | record client meetings for any employee |
| `manager` | approve or reject requests from the team they manage; see the team's attendance |
| *(no role)* | an employee: send excuse/leave requests, see their own attendance, pay to date, penalties and bonuses, compare months, check in with location, file client meetings |

Salaries and bank accounts are readable by `admin` only; an employee gets
their own pay through `hr_my_pay()`, with the bank account masked to the last
4 digits. A manager can never decide their own request, meeting or penalty.
Penalties and bonuses: a manager proposes for their team, an admin approves,
and only then the employee is notified with the value and the reason; the
employee confirms or files an objection. Location is taken once, when the
employee presses the button, with the server's time; coordinates are dropped
after 90 days. Money, people, roles and rules changes are written to
`audit_log`. All of this lives in `neon/schema.sql` and `neon/002_portal.sql`,
not in the UI.

## Training for new hires (`neon/003_training.sql`)

When an admin adds an employee they answer "experienced or not". A hire
without experience gets a training plan: 30 days by default, split into
periods of 7 days (both set per person; defaults under محتوى التدريب).

- Each period ends with a self survey from the trainee and an evaluation from
  their mentor or team manager (1-5 ratings plus notes). Questions are editable
  and never ask about health or feelings.
- Training videos live on Google Drive and open by period. HR turns each video
  into a quiz with NotebookLM: the prompt is on the محتوى التدريب page; paste
  NotebookLM's answer back, preview, save.
- The answer key is admin-only. Trainees get questions through `hr_quiz_get()`
  and are scored on the server by `hr_quiz_submit()`; right answers and
  explanations show only after they pass or run out of attempts.
- The trainee sees their plan, surveys, videos, scores and the mentor's notes;
  the mentor, team manager and admin see the trainee's card and late surveys.
  Only an admin confirms, extends (up to 180 days in total) or ends training,
  and the trainee is notified with the reason.

## Recruitment (`neon/004_recruitment.sql`)

Applicants fill in `hr/apply.html` from a public link, with no account. They
reach the database as the Data API's `anonymous` role, which may only read
the open positions and call `hr_apply()`. That function keeps known fields
only, checks required ones, limits one application per mobile per 30 days,
computes the preliminary score on the server and notifies HR. No national ID
or health questions are asked.

The `recruiter` role (and admins) see applications under التوظيف: filters,
the full answers, the 9-criteria interview score, the decision, and the
"تعيين" button that adds the employee (with the experience question) and
links the application. Rejected or withdrawn applications can be purged
after 12 months with `hr_purge_applications()`.

## Weekly sales evaluation (`neon/005_sales_eval.sql`)

Replaces the Sales Hub sheet. Every week (Friday to Thursday) each
salesperson gets a 1-5 rating and a note in four columns: media, leads,
attitude, development. The admin assigns each `evaluator` to teams and
columns; evaluators only see and rate those people. The week locks on Thursday
23:59 Cairo time and an admin can reopen it for 48 hours. Managers follow
their team, see who has finished, send reminders and write the team's monthly
plan. Employees see their own last four weeks (the admin can turn that off).
The page also flags two low weeks in a row, sharp drops, strong/weak gaps,
low attitude with attendance problems, and people with nothing last week.

## Initial evaluation and reports

Each trainee card shows a 0-100 initial evaluation built from the quizzes,
mentor surveys, attendance, weekly sales ratings and self surveys (weights in
محتوى التدريب; a missing part gives its weight to the rest), with the
recruitment scores as the baseline and a suggested next step. التقارير has a
printable report for senior management, HR, team managers and each employee.

Every Thursday the "Eco System weekly email" Action (`tools/report/weekly.mjs`) logs in
as `hr_report`, which may only call `hr_weekly_report()`
(`neon/006_weekly_report.sql`), and emails the company summary to admins and
each manager their team's figures through Resend. Secrets: `NEON_REPORT_URL`,
`RESEND_API_KEY`, `MAIL_FROM`. Scheduled Actions run from the default branch.

## To-do lists (`neon/007_todos.sql`)

لوحتي opens with مهامي: the person's own tasks (due date, عاجل, repeat daily
or weekly, overdue in red) under a short list of things the portal knows are
waiting on them (requests to decide, ratings due before Thursday, a training
survey, unwatched videos, new applications). مهام الفريق lets a manager or
admin assign tasks and see each person's open, overdue and done counts. The
person, their team manager and the admin can add tasks; the assignee is
notified, and so is whoever assigned it when it is done. Finishing a
repeating task brings it back with the next date. Tasks are never deleted,
only marked cancelled.

## Company structure and permissions (`neon/008_org.sql`)

Teams are units in a tree: a department (قسم) holds teams. Each employee has a
position (صاحب عمل، المدير العام، مدير التشغيل، مدير الموارد البشرية، مدير
تطوير الأعمال، مدير السوشيال ميديا، مدير فريق مبيعات، فرد مبيعات، موظف), and
each position carries a template of roles. Linking an account to an employee
gives it the position's template; editing a template and pressing طبّق
updates everyone in that position, including their weekly-evaluation columns.

Visibility follows the tree: `hr_manages` is true for every unit at or below
one the caller heads (with the `manager` role), and for everyone with the new
`viewall` role. Salaries open to the new `pay` role. Only the admin edits the
structure, positions and templates, from the الهيكل الوظيفي tab, which also
lists accounts waiting to be linked (with a best-guess employee) and warns
about units without a head, people without a position and sales teams
missing an evaluator. Everyone else sees the chart as names and titles only
(`hr_org_chart`).

## Punches straight from the device (`neon/009_device.sql`, `tools/device/`)

The ZKTeco IN01-A has no cloud option, and the cloud can't reach the office
network, so `tools/device/sync.py` runs on an office PC (Task Scheduler, every
5 minutes and at sign-in). It reads the device over TCP 4370 with pyzk, never
writes to it, and hands new punches to `hr_device_punches` as the `hr_device`
login, which can do nothing else. A PC switched off at night catches up in the
morning; duplicates are skipped. رفع البصمة shows each device's last contact,
today's count and last error, and admins and uploaders get a red banner when a
device is silent for 30+ minutes after the shift start on a work day. Manual
upload stays as the fallback. Setup steps in Arabic: `tools/device/README.md`.

## Security hardening (`neon/010_security.sql`)

- **Seeing and deciding are separate.** `hr_manages` (all read policies) is
  the tree, or the whole company with `viewall` or `approveall`. `hr_decides`
  (every decision: requests, meetings, penalty proposals, other people's
  to-dos, mentor surveys) is the tree or `approveall`, and never oneself.
  Owners and the general manager get `approveall` in their templates; HR keeps
  `viewall` (sees, doesn't approve). The UI mirrors this in `decidesFor`
  (`hr/js/viewas.js`).
- **Pay:** the `pay` role reads every salary but can't change its own salary
  or payroll line.
- **Punches:** the device login only adds punches for codes in `employees`,
  from the last 3 days (or since just before its last punch). Unknown codes
  show on the device card. An uploader's own punches are skipped and can't be
  deleted by them; `uploaded_by` is stamped by the server; punches, requests,
  meetings, check-ins, comments and surveys are in the audit log.
- **Meetings:** the meetings role can't approve its own.
- **Unlinked logins** (no employee, no role) read nothing: teams, settings,
  rules, positions, videos, templates and the org chart need `hr_member()`.
- **Admin claim** works only on a brand-new system, never again later.
- **Comments** on a penalty or bonus aren't shown to the employee until it's
  approved; `hr_ref_code` only answers for rows the caller can see;
  `hr_manager_of` is internal.
- **Quiz time** is checked by the server (`quiz_starts`); late answers score 0.
- **Repeating to-dos** spawn their next copy once only.
- **Apply form:** cap of 300 an hour; past 20 an hour, applications save
  without notifying.
- **Logins' emails** come from Neon Auth (`neon_auth."user"` or the JWT), not
  the browser.
- No `hr_*` function is executable by PUBLIC; every definer function uses
  `search_path = public, pg_temp`.
- The pages carry a strict Content-Security-Policy limited to this project's
  Neon hosts, and admin-entered links open only if they are `https://`.

## CVs, interview invitations and leavers (`neon/011_cv_leavers.sql`)

- **CV:** the public form takes an optional CV (PDF, Word, JPG or PNG, up to
  3 MB). It's sent right after the application through `hr_apply_cv`, which
  needs the reference number and mobile, works within two hours and once, and
  checks the file's real type. Files live in `application_files`, readable
  only through `hr_app_cv` (recruiters and admins). The audit log records the
  upload without its contents.
- **Profile:** in the application, HR writes a short profile and marks whether
  the CV matches the answers (`hr_app_about`). Once hired, the profile shows
  on the person in الهيكل الوظيفي for admins, HR and the managers above them
  (`hr_emp_profile`); only admins and HR can download the CV.
- **Interview invitation:** HR sets the day, time and place
  (`hr_app_invite`, stored in Cairo time). The portal builds the message and
  opens WhatsApp on the applicant's number, or an email, ready to send.
- **Leavers:** unticking "شغال" on an employee locks their login at once:
  `hr_my_code()` and `hr_roles()` return nothing for them (an admin keeps
  admin), and the sign-in screen says the account is stopped. Ticking it
  again restores everything. No invite can be made for someone who left.
- **Sign-up** asks for the password twice, and the show-password eye sits on
  the far side of the typed password.

## CRM, phase 1 (`neon/012_crm.sql`)

- **Leads** (`crm_leads`) come in by hand (WhatsApp, calls, walk-ins, referrals),
  from rows pasted from Excel (`hr_lead_import`, all or nothing with a per-row
  report), or from a landing page with no login (`hr_lead_capture`, rate
  limited; it always answers "ok", and a repeat sign-up only notifies the owner).
  One open lead per phone number; numbers are normalised to `01xxxxxxxxx`.
- **Distribution:** new leads wait unassigned. The admin and the new
  permission `leads_assign` (توزيع الليدز, on the operations template) assign
  them from the توزيع الليدز tab, which suggests salespeople: present today by
  fingerprint first, then the fewest open leads, then the best conversion.
- **Who sees what:** a salesperson sees their own leads, managers their tree,
  distributors everything. The phone column isn't readable directly; only the
  owner and distributors get numbers (`hr_lead_contacts`).
- **Follow-up** (`hr_lead_log`) is structured and enforces the policy:
  no answer → next call within 24 hours; thinking → within 3 days; a call that
  got through needs a real note; lost needs a reason. A "visit done" is checked
  against the owner's field check-ins in the last 3 hours; if none, the
  manager is told.
- **6-hour clock** (policy 4.2) runs from assignment to the first follow-up;
  عملائي shows a live countdown, and the team table shows breaches.
- When an employee leaves, their open leads go back to the unassigned pool.

## The administration (`neon/013_admin.sql`)

- Every position belongs to a track: الإدارة (administration), المبيعات
  (sales) or عام (general). The owner, the GM, department heads and admin staff
  (accountant, reception, office, IT) are on the administration track; the
  org chart draws them in their own الإدارة section by who reports to whom,
  not inside a team.
- **Direct manager** (`employees.reports_to`): anyone can have one. That
  manager, and everyone above them, sees the person and decides on their
  requests (with the `manager` permission), and requests are sent to them.
  People without one fall back to their unit's head, as before. A manager
  can't be someone below the person.
- **Personal permissions:** a person gets their position's template plus
  their own additions, minus their own removals (`roles_plus` /
  `roles_minus`, set from the person's panel). Applying a template keeps them.
- The admin adds positions from the templates card (`hr_add_position`), can
  move one to another track, rename an added one, and delete an added one
  nobody holds.

## Commissions (`neon/014_commissions.sql`)

- **Confidential by design.** Only `commissions` (the commissions owner: full
  access) and `commissions_view` (read-only) see anything. Being system admin
  doesn't let you in, and neither do `manager`, `viewall` or `approveall`.
  The admin can name the first owner (never themself) while nobody holds the
  permission; after that only an owner grants or removes it, and every change
  notifies the owners. Changes are logged in `com_audit`, not the shared
  `audit_log`.
- **Deals** record the client, project, unit, price and the company's rate;
  the commission is worked out by the database. Each deal names the staff
  who share in it and their percentage of the commission before VAT (role
  defaults in settings, editable per deal, never above 100% in total).
- **Parts** are the claims/invoices to the developer: G (includes VAT) or N
  (VAT on top), with or without withholding. Marking a part collected creates
  everyone's share of it (an entitlement); a collected part is locked.
- **Entitlements** are approved, shown to the employee when the owner chooses
  (plus a master switch), and marked paid with date and method. Payroll is
  not involved. A payment recorded by mistake can be undone with a reason.
- **Cancelling** a deal voids unpaid shares and claws back paid ones as a
  negative line against the employee's next payment.
- Employees see only their own published lines in **عمولاتي**
  (`hr_my_commissions`); their notification never carries an amount.
- **The old ledger** comes in once from its Excel export (`neon/015_com_import.sql`,
  `hr/js/xlsx.js` reads .xlsx/.csv in the browser with no library). A preview
  shows new deals, deals whose empty fields get filled, errors per row and
  unmatched names; then everything is imported or nothing. Money already
  collected becomes a collected part whose staff shares are marked paid
  (optional) and never shown to staff by the import.
- **Deductions before the split** (`neon/017_com_deductions.sql`): each deal
  can deduct taxes (14%, on by default) straight from the commission, then an
  admin/collection fee of 11% or 21% from what's left. Staff shares come from
  that net. The rates are in settings; the fee is stored on the deal.
- **Who sees which part of a deal:** the owner named first is the primary
  owner. Only they grant or remove the commissions permissions, and they open
  "نصيب الموظفين" and "المطالبة والدفعات" person by person; everyone else,
  other owners included, starts with the deal only. The database enforces it.
- **The first owner:** while nobody holds `commissions`, the admin sees a card in
  الإعدادات to name one (never themself). It disappears after that.

## English

Each person picks عربي or English in the menu; the choice is kept on their
device. The portal is written in Arabic: with English on, `hr/js/i18n.js`
swaps every Arabic text the page shows (text, placeholders, labels, tooltips,
toasts, dialogs, the tab title) for its line in `hr/js/en.js`, and the page
reads left to right. A key is the Arabic exactly as shown; `{}` stands for a
part that varies and `{#}` for a number, time or date. Text without an
English line stays Arabic, and data people typed (names, notes) is never
touched. The WhatsApp invitation to applicants always stays Arabic.

## "شوف شاشته" (admin preview)

In الإعدادات, each user has a "شوف شاشته" button. The portal then shows
exactly that person's tabs and data, read-only: `hr/js/db.js` refuses every
write while the preview is on, and `hr/js/viewas.js` trims the admin's data
with the same rules as the database policies (keep the two in step when a
policy changes). The person's inbox comes from `hr_peek_notifications`
(admin only).

## Set up

1. In the Neon Console create a project, then enable **Neon Auth** and the
   **Data API** (choose Neon Auth as the Data API's auth provider).
2. Open the SQL Editor and run `neon/schema.sql`, then `neon/002_portal.sql`,
   then `neon/003_training.sql`, `neon/004_recruitment.sql`,
   `neon/005_sales_eval.sql`, `neon/006_weekly_report.sql`,
   `neon/007_todos.sql`, `neon/008_org.sql`, `neon/009_device.sql` and
   `neon/010_security.sql`, `neon/011_cv_leavers.sql`, `neon/012_crm.sql`,
   `neon/013_admin.sql`, `neon/014_commissions.sql`, `neon/015_com_import.sql`,
   `neon/016_identity.sql` and `neon/017_com_deductions.sql`
   (all safe to re-run).
   For the public application form, allow anonymous access in the Data API
   settings so the `anonymous` role exists, then re-run 004.
3. Run the private `seed.sql` generated by `tools/attendance/make_seed.py`
   (it contains real salaries and punches; never commit it).
4. Put the Auth URL and the Data API URL in `hr/js/config.js`.
5. Publish the repository with GitHub Pages and add the Pages domain to
   Neon Auth's trusted domains.
6. Sign up at `/hr/` with the admin email and press "انا أول مدير للنظام".
   That works once, on a brand-new system only.
7. For each employee the admin makes an activation code under الإعدادات
   (دخول الموظفين) and sends it on WhatsApp. The employee signs up with their
   email, types the code, and is linked to their employee record. A code
   works once, for 14 days; five wrong tries lock it for an hour.

## Releasing a change

Bump the same build stamp in `hr/version.json`, `BUILD` in `hr/js/app.js` and
`hr/js/apply.js`, and every `?v=` in the HTML and module imports. Open pages
compare `version.json` (fetched without cache) to their `BUILD` and reload
once when a newer build is out, so nobody needs Ctrl+Shift+R.

## Files

```
hr/index.html        login, pending and app views, styles
hr/js/config.js      Neon Auth URL + Data API URL (public; RLS protects the data)
hr/js/db.js          sign-in, loading per month, every write
hr/js/engine.js      attendance and payroll rules, device export parsing
hr/js/app.js         role-based tabs and screens
hr/js/viewas.js      "شوف شاشته": the database's read rules, applied in the browser
hr/js/vendor/neon.js @neondatabase/neon-js 0.7.0-beta bundled with esbuild
neon/schema.sql      tables, helper functions, RLS policies, grants
neon/002_portal.sql  employee portal: invites, rules, penalties/bonuses,
                     notifications, check-ins, comments, audit log
neon/003_training.sql new-hire training: plans, surveys, videos, quizzes
neon/004_recruitment.sql job applications, interview scores, hiring
neon/005_sales_eval.sql  weekly 1-5 ratings per column, evaluators, team plans
neon/006_weekly_report.sql  figures for the Thursday email, hr_report login
neon/007_todos.sql     to-do lists per person, admin read of an inbox for "شوف شاشته"
neon/008_org.sql       units in a tree, positions with role templates, viewall/pay roles
neon/009_device.sql    devices, hr_device login: punches from the office sync program
neon/010_security.sql  see vs decide (approveall), pay, punches, audit, tighter grants
neon/011_cv_leavers.sql  CV upload, HR profile, interview invitation, lock out leavers
neon/012_crm.sql       CRM: leads, distribution, structured follow-up, landing-page capture
neon/013_admin.sql     the administration: tracks, direct manager, personal permissions
neon/014_commissions.sql  commissions: deals, invoices, staff shares, payouts (confidential)
neon/015_com_import.sql   one-time import of the old commissions ledger from Excel
neon/016_identity.sql     a signed-in request without its identity fails (and is retried) instead of coming back empty
neon/017_com_deductions.sql  taxes and admin fee before the staff split; per-person access to shares and parts
tools/device/          office PC program that reads the fingerprint device (pyzk)
tools/report/weekly.mjs     builds and sends the Thursday emails
hr/apply.html        public job application (no login)
hr/js/applyForm.js   the application's sections and fields
```

To rebuild the vendor bundle:
`npx esbuild entry.js --bundle --format=esm --platform=browser --minify --outfile=hr/js/vendor/neon.js`
with `entry.js` exporting `createClient` and `SupabaseAuthAdapter` from `@neondatabase/neon-js`.
