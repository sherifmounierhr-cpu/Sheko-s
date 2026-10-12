# Everest HR

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

Every Thursday the "HR weekly email" Action (`tools/report/weekly.mjs`) logs in
as `hr_report`, which may only call `hr_weekly_report()`
(`neon/006_weekly_report.sql`), and emails the company summary to admins and
each manager their team's figures through Resend. Secrets: `NEON_REPORT_URL`,
`RESEND_API_KEY`, `MAIL_FROM`. Scheduled Actions run from the default branch.

## Set up

1. In the Neon Console create a project, then enable **Neon Auth** and the
   **Data API** (choose Neon Auth as the Data API's auth provider).
2. Open the SQL Editor and run `neon/schema.sql`, then `neon/002_portal.sql`,
   then `neon/003_training.sql`, `neon/004_recruitment.sql` and
   `neon/005_sales_eval.sql` (all safe to re-run).
   For the public application form, allow anonymous access in the Data API
   settings so the `anonymous` role exists, then re-run 004.
3. Run the private `seed.sql` generated by `tools/attendance/make_seed.py`
   (it contains real salaries and punches; never commit it).
4. Put the Auth URL and the Data API URL in `hr/js/config.js`.
5. Publish the repository with GitHub Pages and add the Pages domain to
   Neon Auth's trusted domains.
6. Sign up at `/hr/` with the admin email and press "انا أول مدير للنظام".
   That works once, while no admin exists.
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
hr/js/vendor/neon.js @neondatabase/neon-js 0.7.0-beta bundled with esbuild
neon/schema.sql      tables, helper functions, RLS policies, grants
neon/002_portal.sql  employee portal: invites, rules, penalties/bonuses,
                     notifications, check-ins, comments, audit log
neon/003_training.sql new-hire training: plans, surveys, videos, quizzes
neon/004_recruitment.sql job applications, interview scores, hiring
neon/005_sales_eval.sql  weekly 1-5 ratings per column, evaluators, team plans
neon/006_weekly_report.sql  figures for the Thursday email, hr_report login
tools/report/weekly.mjs     builds and sends the Thursday emails
hr/apply.html        public job application (no login)
hr/js/applyForm.js   the application's sections and fields
```

To rebuild the vendor bundle:
`npx esbuild entry.js --bundle --format=esm --platform=browser --minify --outfile=hr/js/vendor/neon.js`
with `entry.js` exporting `createClient` and `SupabaseAuthAdapter` from `@neondatabase/neon-js`.
