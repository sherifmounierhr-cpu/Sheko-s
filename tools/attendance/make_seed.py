"""Turn the interactive page's state.json into SQL for the Neon database.

Usage: python make_seed.py state.json teams.json > seed.sql

teams.json: {"Team name": {"manager": "355", "members": ["355", "357", ...]}, ...}

The output holds real employee data (salaries, bank accounts, punches):
run it in the Neon SQL Editor and never commit it.
"""
import json
import sys


def q(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(state_path, teams_path):
    S = json.load(open(state_path, encoding="utf-8"))
    teams = json.load(open(teams_path, encoding="utf-8"))
    team_of = {code: name for name, t in teams.items() for code in t["members"]}
    out = ["begin;"]

    for name in teams:
        out.append(f"insert into teams (name) values ({q(name)}) on conflict (name) do nothing;")

    for e in S["employees"]:
        team = team_of.get(e["code"])
        team_sql = f"(select id from teams where name = {q(team)})" if team else "null"
        off = e.get("off")
        out.append(
            "insert into employees (code, name, full_name, device_name, team_id, job, dept, shift_in, shift_out, off_day, exempt) values ("
            f"{q(e['code'])}, {q(e.get('name') or e['code'])}, {q(e.get('fullName'))}, {q(e.get('device'))}, {team_sql}, "
            f"{q(e.get('job'))}, {q(e.get('dept'))}, {q(e.get('in'))}, {q(e.get('out'))}, "
            f"{q(int(off)) if off not in ('', None) else 'null'}, {q(bool(e.get('exempt')))}) "
            "on conflict (code) do update set name = excluded.name, full_name = excluded.full_name, team_id = excluded.team_id, "
            "job = excluded.job, shift_in = excluded.shift_in, shift_out = excluded.shift_out, off_day = excluded.off_day, exempt = excluded.exempt;")
        out.append(
            f"insert into employee_pay (code, salary, account, pay_method) values ({q(e['code'])}, {q(e.get('salary') or 0)}, "
            f"{q(e.get('account'))}, {q(e.get('pay') or ('bank' if e.get('account') else 'cash'))}) "
            "on conflict (code) do update set salary = excluded.salary, account = excluded.account, pay_method = excluded.pay_method;")

    for name, t in teams.items():
        if t.get("manager"):
            out.append(f"update teams set manager_code = {q(t['manager'])} where name = {q(name)};")

    rows = [(code, ts) for code, lst in S["punches"].items() for ts in lst]
    for i in range(0, len(rows), 500):
        vals = ",".join(f"({q(c)}, {q(ts)})" for c, ts in rows[i:i + 500])
        out.append(f"insert into punches (code, ts) values {vals} on conflict (code, ts) do nothing;")

    for month, entries in (S.get("payroll") or {}).items():
        for code, p in entries.items():
            out.append(
                "insert into payroll (month, code, commission, ret, approved_days, late_amt, admin_ded, days_ded, reg_ded, advance, note) values ("
                f"{q(month)}, {q(code)}, {q(p.get('commission') or 0)}, {q(p.get('ret') or 0)}, {q(p.get('approvedDays'))}, "
                f"{q(p.get('lateAmt'))}, {q(p.get('adminDed') or 0)}, {q(p.get('daysDed') or 0)}, {q(p.get('regDed') or 0)}, "
                f"{q(p.get('advance') or 0)}, {q(p.get('note'))}) on conflict (month, code) do nothing;")

    for key, o in (S.get("overrides") or {}).items():
        code, day = key.split("|")
        out.append(f"insert into overrides (code, day, ded, note) values ({q(code)}, {q(day)}, {q(o.get('ded'))}, {q(o.get('note'))}) on conflict do nothing;")

    status = {"معتمد": "approved", "قيد المراجعة": "pending", "مرفوض": "rejected"}
    for p in S.get("perms") or []:
        out.append(
            "insert into requests (code, type, date_from, date_to, time_from, time_to, reason, status) values ("
            f"{q(p['code'])}, {q(p['type'])}, {q(p['from'])}, {q(p.get('to'))}, {q(p.get('tFrom'))}, {q(p.get('tTo'))}, "
            f"{q(p.get('note'))}, {q(status.get(p.get('status'), 'pending'))});")
    for m in S.get("meetings") or []:
        out.append(
            "insert into meetings (code, date, time_from, time_to, kind, client, phone, project, place, source, result, follow_up, status, note) values ("
            f"{q(m['code'])}, {q(m['date'])}, {q(m['tFrom'])}, {q(m['tTo'])}, {q(m.get('kind'))}, {q(m.get('client'))}, {q(m.get('phone'))}, "
            f"{q(m.get('project'))}, {q(m.get('place'))}, {q(m.get('source'))}, {q(m.get('result'))}, {q(m.get('follow'))}, "
            f"{q(status.get(m.get('status'), 'approved'))}, {q(m.get('note'))});")

    out.append(f"insert into settings (id, data) values (1, {q(json.dumps(S['settings'], ensure_ascii=False))}::jsonb) "
               "on conflict (id) do update set data = excluded.data;")
    out.append("commit;")
    print("\n".join(out))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
