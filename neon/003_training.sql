-- Everest HR, part 3: onboarding and training for new hires.
--
-- Run in the Neon SQL Editor AFTER neon/002_portal.sql. Safe to re-run.
--
-- Adds:
--   employees.hire_date / experience   asked when an employee is added
--   training_plans     a trainee's training period (default 30 days), split
--                      into periods of N days (default 7); each period ends
--                      with a self survey and a mentor survey
--   survey_templates   the questions (1-5 scale or free text), editable by admins
--   survey_responses   one per plan, period and side (self / mentor)
--   training_videos    Google Drive videos, with an optional NotebookLM notebook
--   quizzes            questions per video; the answer key is never sent to employees
--   quiz_attempts      scored on the server
--   video_views        "I watched it"
-- No health or psychological questions are stored anywhere.

begin;

-- ---------------------------------------------------------------- tables

alter table employees add column if not exists hire_date  date;
alter table employees add column if not exists experience text;
alter table employees drop constraint if exists employees_experience_chk;
alter table employees add constraint employees_experience_chk check (experience is null or experience in ('experienced', 'fresh'));

create table if not exists training_plans (
  id            bigserial primary key,
  code          text not null references employees(code) on update cascade on delete cascade,
  start_date    date not null default current_date,
  days          int  not null default 30 check (days between 7 and 180),
  survey_every  int  not null default 7  check (survey_every between 3 and 31),
  mentor_code   text references employees(code) on update cascade on delete set null,
  status        text not null default 'active' check (status in ('active', 'passed', 'ended')),
  goals         text,
  created_by    text default auth.user_id(),
  created_at    timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text
);
create unique index if not exists training_one_active on training_plans (code) where status = 'active';

create table if not exists survey_templates (
  id        serial primary key,
  side      text not null check (side in ('self', 'mentor')),
  -- [{"id":"q1","text":"...","type":"scale"|"text"}]
  questions jsonb not null default '[]',
  active    boolean not null default true
);

create table if not exists survey_responses (
  id           bigserial primary key,
  plan_id      bigint not null references training_plans(id) on delete cascade,
  period_n     int not null check (period_n >= 1),
  side         text not null check (side in ('self', 'mentor')),
  answers      jsonb not null,
  score        numeric,                 -- 0-100 from the scale questions
  respondent   text default auth.user_id(),
  submitted_at timestamptz not null default now(),
  unique (plan_id, period_n, side)
);

create table if not exists training_videos (
  id             serial primary key,
  title          text not null,
  drive_url      text not null check (drive_url ~ '^https://'),
  notebooklm_url text check (notebooklm_url is null or notebooklm_url ~ '^https://'),
  period_n       int not null default 1 check (period_n >= 1),
  summary        text,
  active         boolean not null default true,
  sort           int not null default 0
);

create table if not exists quizzes (
  id            serial primary key,
  video_id      int not null unique references training_videos(id) on delete cascade,
  -- [{"q":"...","options":["..","..",".."],"answer":0,"why":"..."}]
  questions     jsonb not null check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) between 1 and 40),
  pass_mark     int not null default 70 check (pass_mark between 1 and 100),
  max_attempts  int not null default 2 check (max_attempts between 1 and 10),
  minutes       int not null default 15 check (minutes between 1 and 120)
);

create table if not exists quiz_attempts (
  id         bigserial primary key,
  code       text not null references employees(code) on update cascade on delete cascade,
  quiz_id    int not null references quizzes(id) on delete cascade,
  attempt_no int not null,
  answers    jsonb not null,
  score      int not null,
  passed     boolean not null,
  at         timestamptz not null default now(),
  unique (code, quiz_id, attempt_no)
);

create table if not exists video_views (
  code     text not null references employees(code) on update cascade on delete cascade,
  video_id int not null references training_videos(id) on delete cascade,
  at       timestamptz not null default now(),
  primary key (code, video_id)
);

create index if not exists training_code on training_plans (code);
create index if not exists training_mentor on training_plans (mentor_code) where status = 'active';
create index if not exists quiz_att_code on quiz_attempts (code, quiz_id);

-- default survey questions, only when there are none yet
insert into survey_templates (side, questions)
select 'self', '[
  {"id":"s1","text":"فاهم المشاريع اللي بنبيعها (الأسعار، المساحات، أنظمة السداد)","type":"scale"},
  {"id":"s2","text":"واثق في طريقة كلامي مع العميل في المكالمة والاجتماع","type":"scale"},
  {"id":"s3","text":"بعرف أسجل العملاء والمتابعات بشكل صحيح","type":"scale"},
  {"id":"s4","text":"واخد الدعم اللي محتاجه من المدرب والفريق","type":"scale"},
  {"id":"s5","text":"إيه أكتر حاجة اتعلمتها الفترة دي؟","type":"text"},
  {"id":"s6","text":"إيه اللي محتاج مساعدة فيه الفترة الجاية؟","type":"text"}
]'::jsonb where not exists (select 1 from survey_templates where side = 'self');
insert into survey_templates (side, questions)
select 'mentor', '[
  {"id":"m1","text":"معرفة المشاريع والمنتج","type":"scale"},
  {"id":"m2","text":"مهارات التواصل والمكالمات","type":"scale"},
  {"id":"m3","text":"المتابعة مع العملاء وتسجيلها","type":"scale"},
  {"id":"m4","text":"الالتزام بالمواعيد والتعليمات","type":"scale"},
  {"id":"m5","text":"التعاون مع الفريق وتقبل الملاحظات","type":"scale"},
  {"id":"m6","text":"المبادرة والسرعة في التعلم","type":"scale"},
  {"id":"m7","text":"نقط القوة","type":"text"},
  {"id":"m8","text":"المطلوب تحسينه في الفترة الجاية","type":"text"}
]'::jsonb where not exists (select 1 from survey_templates where side = 'mentor');

-- ---------------------------------------------------------------- helpers

-- true when the signed-in user mentors employee `c` in an active plan
create or replace function hr_mentors(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from training_plans
                 where code = c and status = 'active' and mentor_code is not null and mentor_code = hr_my_code())
$$;

-- true when `c` is the mentor of the signed-in trainee (so the trainee sees their name)
create or replace function hr_my_mentor(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from training_plans where code = hr_my_code() and mentor_code = c)
$$;

-- who may follow a trainee: admin, their team manager, their mentor
create or replace function hr_follows(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select hr_has('admin') or hr_manages(c) or hr_mentors(c)
$$;

-- number of survey periods in a plan; the last one may be shorter
create or replace function hr_period_count(p training_plans) returns int
language sql immutable as $$ select ceil(p.days::numeric / p.survey_every)::int $$;

-- ---------------------------------------------------------------- functions

-- Admin starts a training plan (marks the employee as "fresh").
create or replace function hr_start_training(p_code text, p_start date, p_days int, p_every int, p_mentor text, p_goals text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare pid bigint;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  if p_mentor is not null and p_mentor = p_code then raise exception 'mentor cannot be the trainee'; end if;
  insert into training_plans (code, start_date, days, survey_every, mentor_code, goals)
  values (p_code, coalesce(p_start, current_date), coalesce(p_days, 30), coalesce(p_every, 7), nullif(p_mentor, ''), p_goals)
  returning id into pid;
  update employees set experience = 'fresh', hire_date = coalesce(hire_date, p_start, current_date) where code = p_code;
  perform hr_notify(p_code, null, 'training', 'بدأت فترة التدريب',
    coalesce(p_days, 30) || ' يوم، واستبيان متابعة كل ' || coalesce(p_every, 7) || ' أيام. افتح (تدريبي) تشوف الخطة.', 'training_plans', pid);
  if nullif(p_mentor, '') is not null then
    perform hr_notify(p_mentor, null, 'training', 'اتعينت مدرب',
      'هتتابع ' || (select name from employees where code = p_code) || ' في فترة التدريب.', 'training_plans', pid);
  end if;
  return pid;
end $$;

-- Admin closes a plan (passed / ended) or extends it by p_extend days.
create or replace function hr_decide_training(plan bigint, p_status text, p_note text, p_extend int default 0)
returns void language plpgsql security definer set search_path = public as $$
declare p training_plans;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  select * into p from training_plans where id = plan for update;
  if p.id is null or p.status <> 'active' then raise exception 'plan is not active'; end if;
  if p_status = 'extend' then
    if coalesce(p_extend, 0) < 1 or p.days + p_extend > 180 then raise exception 'bad extension'; end if;
    update training_plans set days = days + p_extend, decision_note = p_note, decided_by = auth.user_id(), decided_at = now() where id = plan;
    perform hr_notify(p.code, null, 'training', 'فترة التدريب اتمدت ' || p_extend || ' يوم', p_note, 'training_plans', plan);
  elsif p_status in ('passed', 'ended') then
    update training_plans set status = p_status, decision_note = p_note, decided_by = auth.user_id(), decided_at = now() where id = plan;
    perform hr_notify(p.code, null, 'training',
      case p_status when 'passed' then 'مبروك، خلصت فترة التدريب بنجاح' else 'انتهت فترة التدريب' end, p_note, 'training_plans', plan);
  else raise exception 'bad status'; end if;
end $$;

-- The trainee (side=self) or their mentor / manager / admin (side=mentor)
-- answers the survey of a period that has started.
create or replace function hr_submit_survey(plan bigint, p_period int, p_side text, p_answers jsonb)
returns numeric language plpgsql security definer set search_path = public as $$
declare p training_plans; t survey_templates; q jsonb; v numeric; tot numeric := 0; cnt int := 0; sc numeric;
begin
  select * into p from training_plans where id = plan;
  if p.id is null or p.status <> 'active' then raise exception 'plan is not active'; end if;
  if p_side = 'self' then
    if p.code is distinct from hr_my_code() then raise exception 'not allowed'; end if;
  elsif p_side = 'mentor' then
    if not hr_follows(p.code) or p.code = hr_my_code() then raise exception 'not allowed'; end if;
  else raise exception 'bad side'; end if;
  if p_period < 1 or p_period > hr_period_count(p) then raise exception 'bad period'; end if;
  if p.start_date + (p_period - 1) * p.survey_every > current_date then raise exception 'period not started'; end if;
  if jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 8000 then raise exception 'bad answers'; end if;

  select * into t from survey_templates where side = p_side and active order by id desc limit 1;
  for q in select * from jsonb_array_elements(coalesce(t.questions, '[]')) loop
    if q->>'type' = 'scale' then
      v := nullif(p_answers->>(q->>'id'), '')::numeric;
      if v is null or v < 1 or v > 5 then raise exception 'answer every rated question (1-5)'; end if;
      tot := tot + v; cnt := cnt + 1;
    end if;
  end loop;
  sc := case when cnt > 0 then round((tot / cnt - 1) / 4 * 100) end;

  insert into survey_responses (plan_id, period_n, side, answers, score)
  values (plan, p_period, p_side, p_answers, sc)
  on conflict (plan_id, period_n, side) do update
    set answers = excluded.answers, score = excluded.score, respondent = auth.user_id(), submitted_at = now();

  if p_side = 'mentor' then
    perform hr_notify(p.code, null, 'training', 'تقييم المدرب للفترة ' || p_period || ' اتسجل',
      'افتح (تدريبي) تشوف الملاحظات.', 'training_plans', plan);
  end if;
  return sc;
end $$;

-- Questions without the answer key.
create or replace function hr_quiz_get(p_quiz int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare z quizzes; used int;
begin
  select * into z from quizzes where id = p_quiz;
  if z.id is null then raise exception 'no such quiz'; end if;
  select count(*) into used from quiz_attempts where quiz_id = p_quiz and code = hr_my_code();
  return jsonb_build_object(
    'id', z.id, 'pass_mark', z.pass_mark, 'max_attempts', z.max_attempts, 'minutes', z.minutes, 'used', used,
    'questions', (select coalesce(jsonb_agg(jsonb_build_object('q', x->>'q', 'options', x->'options') order by i), '[]')
                  from jsonb_array_elements(z.questions) with ordinality as a(x, i)));
end $$;

-- Which videos have a quiz, without the questions (for the trainee's list).
create or replace function hr_quiz_list()
returns setof jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', id, 'video_id', video_id, 'pass_mark', pass_mark, 'max_attempts', max_attempts,
                            'minutes', minutes, 'count', jsonb_array_length(questions))
  from quizzes order by id
$$;

-- Scores an attempt. Correct answers and explanations come back only once the
-- trainee passes or has no attempts left; before that, only right / wrong.
create or replace function hr_quiz_submit(p_quiz int, p_answers jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare z quizzes; me text := hr_my_code(); used int; n int; ok int := 0; sc int; pass boolean; last boolean; review jsonb := '[]'; x jsonb; i int := 0; chosen int;
begin
  if me is null then raise exception 'not allowed'; end if;
  select * into z from quizzes where id = p_quiz;
  if z.id is null then raise exception 'no such quiz'; end if;
  if jsonb_typeof(p_answers) <> 'array' then raise exception 'bad answers'; end if;
  perform pg_advisory_xact_lock(hashtext(me || ':' || p_quiz));
  select count(*) into used from quiz_attempts where quiz_id = p_quiz and code = me;
  if used >= z.max_attempts then raise exception 'no attempts left'; end if;
  if exists (select 1 from quiz_attempts where quiz_id = p_quiz and code = me and passed) then raise exception 'already passed'; end if;
  n := jsonb_array_length(z.questions);
  for x in select * from jsonb_array_elements(z.questions) loop
    chosen := case when jsonb_typeof(p_answers->i) = 'number' then (p_answers->>i)::int end;
    if chosen = (x->>'answer')::int then ok := ok + 1; end if;
    review := review || jsonb_build_object('chosen', chosen, 'right', chosen = (x->>'answer')::int, 'answer', (x->>'answer')::int, 'why', x->>'why');
    i := i + 1;
  end loop;
  sc := round(ok * 100.0 / n);
  pass := sc >= z.pass_mark;
  insert into quiz_attempts (code, quiz_id, attempt_no, answers, score, passed) values (me, p_quiz, used + 1, p_answers, sc, pass);
  last := pass or used + 1 >= z.max_attempts;
  if not last then
    review := (select jsonb_agg(jsonb_build_object('chosen', r->'chosen', 'right', r->'right')) from jsonb_array_elements(review) r);
  end if;
  return jsonb_build_object('score', sc, 'passed', pass, 'correct', ok, 'total', n, 'left', z.max_attempts - used - 1, 'review', review);
end $$;

-- ---------------------------------------------------------------- RLS

alter table training_plans   enable row level security;
alter table survey_templates enable row level security;
alter table survey_responses enable row level security;
alter table training_videos  enable row level security;
alter table quizzes          enable row level security;
alter table quiz_attempts    enable row level security;
alter table video_views      enable row level security;

do $$ declare r record; begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public'
    and (tablename in ('training_plans', 'survey_templates', 'survey_responses', 'training_videos', 'quizzes', 'quiz_attempts', 'video_views')
         or policyname in ('emp_mentor_read', 'emp_my_mentor_read'))
  loop execute format('drop policy %I on %I', r.policyname, r.tablename); end loop;
end $$;

-- a mentor also sees the employee row of the person they train
create policy emp_mentor_read on employees for select to authenticated using (hr_mentors(code));
-- and the trainee sees their mentor's row (name, team) to know who to ask
create policy emp_my_mentor_read on employees for select to authenticated using (hr_my_mentor(code));

create policy tp_read on training_plans for select to authenticated using (code = hr_my_code() or hr_follows(code));
create policy tp_admin_update on training_plans for update to authenticated using (hr_has('admin')) with check (hr_has('admin'));
create policy tp_admin_delete on training_plans for delete to authenticated using (hr_has('admin'));

create policy st_read on survey_templates for select to authenticated using (true);
create policy st_admin on survey_templates for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- the trainee sees the mentor's notes too: feedback is the point
create policy sr_read on survey_responses for select to authenticated using (
  exists (select 1 from training_plans p where p.id = plan_id and (p.code = hr_my_code() or hr_follows(p.code))));

create policy tv_read on training_videos for select to authenticated using (true);
create policy tv_admin on training_videos for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

-- the answer key: admins only; everyone else goes through hr_quiz_get
create policy qz_admin on quizzes for all to authenticated using (hr_has('admin')) with check (hr_has('admin'));

create policy qa_read on quiz_attempts for select to authenticated using (code = hr_my_code() or hr_follows(code));

create policy vv_read on video_views for select to authenticated using (code = hr_my_code() or hr_follows(code));
create policy vv_insert on video_views for insert to authenticated with check (code = hr_my_code());

-- audit decisions and changes to what trainees are tested on
do $$ declare t text; begin
  foreach t in array array['training_plans', 'survey_templates', 'quizzes'] loop
    execute format('drop trigger if exists audit on %I', t);
    execute format('create trigger audit after insert or update or delete on %I for each row execute function hr_audit()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- grants

grant select, update, delete on training_plans to authenticated;
grant select, insert, update, delete on survey_templates, training_videos, quizzes to authenticated;
grant select on survey_responses, quiz_attempts to authenticated;
grant select, insert on video_views to authenticated;
grant usage, select on all sequences in schema public to authenticated;

revoke all on function hr_mentors(text), hr_my_mentor(text), hr_follows(text), hr_period_count(training_plans),
  hr_start_training(text, date, int, int, text, text), hr_decide_training(bigint, text, text, int),
  hr_submit_survey(bigint, int, text, jsonb), hr_quiz_get(int), hr_quiz_list(), hr_quiz_submit(int, jsonb) from public;
grant execute on function hr_mentors(text), hr_my_mentor(text), hr_follows(text), hr_period_count(training_plans),
  hr_start_training(text, date, int, int, text, text), hr_decide_training(bigint, text, text, int),
  hr_submit_survey(bigint, int, text, jsonb), hr_quiz_get(int), hr_quiz_list(), hr_quiz_submit(int, jsonb) to authenticated;

commit;
