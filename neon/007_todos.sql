-- Everest Eco System, part 7: a to-do list for everyone, and the admin's "view as".
--
-- Run in the Neon SQL Editor AFTER neon/006_weekly_report.sql. Safe to re-run.
-- Then: notify pgrst, 'reload schema';
--
-- todos: each task belongs to one employee. The employee, their team manager
-- and the admin can add tasks; whoever assigned a task hears when it is done.
-- A repeating task (daily or weekly) comes back with the next date when it is
-- finished. Nothing is ever deleted: a removed task is marked cancelled.
--
-- hr_peek_notifications: lets an admin read one user's notifications, so
-- "شوف شاشته" can show that person's inbox. It reads only; it changes nothing.

begin;

-- ---------------------------------------------------------------- table

create table if not exists todos (
  id              bigserial primary key,
  code            text not null references employees(code) on update cascade on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 200),
  note            text check (length(note) <= 1000),
  due             date,
  priority        text not null default 'normal' check (priority in ('high', 'normal')),
  repeat          text not null default 'none' check (repeat in ('none', 'daily', 'weekly')),
  status          text not null default 'open' check (status in ('open', 'done', 'cancelled')),
  done_at         timestamptz,
  done_by         text,
  created_by      text default auth.user_id(),
  created_by_code text,
  created_at      timestamptz not null default now()
);
create index if not exists todos_code_status on todos (code, status, due);

-- ---------------------------------------------------------------- helpers

-- may the signed-in user manage employee `c`'s list? (themself, their manager, admin)
create or replace function hr_todo_can(c text) returns boolean
language sql stable security definer set search_path = public as $$
  select hr_has('admin') or hr_manages(c) or (c is not null and c = hr_my_code())
$$;

-- the next working day after `d` (skips the weekly days off from settings)
create or replace function hr_todo_next(d date, rep text) returns date
language plpgsql stable security definer set search_path = public as $$
declare
  wk int[] := coalesce((select array_agg(x::int) from jsonb_array_elements_text(
                 coalesce((select data->'weekend' from settings where id = 1), '[5]')) x), '{5}');
  n date := d;
begin
  if rep = 'weekly' then return d + 7; end if;
  loop
    n := n + 1;
    exit when extract(dow from n)::int <> all(wk) or n > d + 7;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------- actions

create or replace function hr_todo_add(p_code text, p_title text, p_note text, p_due date, p_priority text, p_repeat text)
returns bigint language plpgsql security definer set search_path = public as $$
declare tid bigint; me text := hr_my_code(); who text;
begin
  if p_code is null or not hr_todo_can(p_code) then raise exception 'not allowed'; end if;
  if not exists (select 1 from employees where code = p_code) then raise exception 'unknown employee'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'title required'; end if;
  insert into todos (code, title, note, due, priority, repeat, created_by, created_by_code)
  values (p_code, btrim(p_title), nullif(btrim(p_note), ''), p_due,
          case when p_priority = 'high' then 'high' else 'normal' end,
          case when p_repeat in ('daily', 'weekly') then p_repeat else 'none' end,
          auth.user_id(), me)
  returning id into tid;
  if me is distinct from p_code then
    select coalesce(nullif(name, ''), code) into who from employees where code = me;
    perform hr_notify(p_code, null, 'todo', 'مهمة جديدة: ' || btrim(p_title),
      coalesce('من ' || who, 'من الإدارة') || coalesce(' · التسليم ' || to_char(p_due, 'DD/MM'), ''), 'todos', tid);
  end if;
  return tid;
end $$;

-- Finish (or reopen) a task. Finishing a repeating task adds the next one.
create or replace function hr_todo_set(p_id bigint, p_done boolean)
returns bigint language plpgsql security definer set search_path = public as $$
declare t todos; nid bigint; who text;
begin
  select * into t from todos where id = p_id;
  if not found or not hr_todo_can(t.code) then raise exception 'not allowed'; end if;
  if t.status = 'cancelled' then raise exception 'cancelled'; end if;
  if p_done then
    if t.status = 'done' then return null; end if;
    update todos set status = 'done', done_at = now(), done_by = auth.user_id() where id = p_id;
    if t.created_by is distinct from auth.user_id() and t.created_by is not null then
      select coalesce(nullif(name, ''), code) into who from employees where code = t.code;
      perform hr_notify(null, t.created_by, 'todo', coalesce(who, t.code) || ' خلّص: ' || t.title, null, 'todos', p_id);
    end if;
    if t.repeat <> 'none' then
      insert into todos (code, title, note, due, priority, repeat, created_by, created_by_code)
      values (t.code, t.title, t.note,
              hr_todo_next(greatest(coalesce(t.due, (now() at time zone 'Africa/Cairo')::date), (now() at time zone 'Africa/Cairo')::date), t.repeat),
              t.priority, t.repeat, t.created_by, t.created_by_code)
      returning id into nid;
    end if;
    return nid;
  end if;
  update todos set status = 'open', done_at = null, done_by = null where id = p_id;
  return null;
end $$;

-- Edit: whoever created the task, or the employee's manager or the admin.
create or replace function hr_todo_edit(p_id bigint, p_title text, p_note text, p_due date, p_priority text, p_repeat text)
returns void language plpgsql security definer set search_path = public as $$
declare t todos;
begin
  select * into t from todos where id = p_id;
  if not found or not (t.created_by = auth.user_id() or hr_has('admin') or hr_manages(t.code)) then raise exception 'not allowed'; end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'title required'; end if;
  update todos set title = btrim(p_title), note = nullif(btrim(p_note), ''), due = p_due,
    priority = case when p_priority = 'high' then 'high' else 'normal' end,
    repeat = case when p_repeat in ('daily', 'weekly') then p_repeat else 'none' end
  where id = p_id;
end $$;

-- Remove from the list without deleting the row.
create or replace function hr_todo_cancel(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare t todos;
begin
  select * into t from todos where id = p_id;
  if not found or not (t.created_by = auth.user_id() or hr_has('admin') or hr_manages(t.code)) then raise exception 'not allowed'; end if;
  update todos set status = 'cancelled' where id = p_id;
end $$;

-- Admin only: one user's notifications, read-only, for "شوف شاشته".
create or replace function hr_peek_notifications(p_user text, p_limit int default 60)
returns setof notifications language plpgsql stable security definer set search_path = public as $$
declare c text;
begin
  if not hr_has('admin') then raise exception 'not allowed'; end if;
  select employee_code into c from app_users where user_id = p_user;
  return query select * from notifications n
    where n.user_id = p_user or (c is not null and n.code = c)
    order by n.created_at desc limit least(greatest(coalesce(p_limit, 60), 1), 200);
end $$;

-- ---------------------------------------------------------------- RLS

alter table todos enable row level security;
do $$ declare r record; begin
  for r in select policyname from pg_policies where schemaname = 'public' and tablename = 'todos'
  loop execute format('drop policy %I on todos', r.policyname); end loop;
end $$;
create policy todo_read on todos for select to authenticated using (hr_todo_can(code));

drop trigger if exists audit on todos;
create trigger audit after insert or update or delete on todos for each row execute function hr_audit();

-- ---------------------------------------------------------------- grants

grant select on todos to authenticated;
revoke all on function hr_todo_can(text), hr_todo_next(date, text), hr_todo_add(text, text, text, date, text, text),
  hr_todo_set(bigint, boolean), hr_todo_edit(bigint, text, text, date, text, text), hr_todo_cancel(bigint),
  hr_peek_notifications(text, int) from public;
grant execute on function hr_todo_can(text), hr_todo_next(date, text), hr_todo_add(text, text, text, date, text, text),
  hr_todo_set(bigint, boolean), hr_todo_edit(bigint, text, text, date, text, text), hr_todo_cancel(bigint),
  hr_peek_notifications(text, int) to authenticated;

commit;
