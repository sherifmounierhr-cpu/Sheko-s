"""Send new punches from the office fingerprint device to the portal.

Runs on an office Windows PC (Task Scheduler, every 5 minutes and at logon).
It reads the ZKTeco device over the network (TCP 4370, through pyzk), keeps
only punches newer than the last ones it sent, and hands them to Neon as the
`hr_device` login, which can do nothing else (neon/009_device.sql).

It only reads the device: it never clears logs or changes settings.
Settings come from config.ini next to this file (see config.example.ini).
"""
import configparser
import datetime as dt
import json
import logging
import logging.handlers
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
STATE = HERE / "state.json"
MARGIN = dt.timedelta(minutes=30)   # overlap with the last run; the database skips duplicates
BATCH = 500

log = logging.getLogger("sync")


def setup_logging():
    h = logging.handlers.RotatingFileHandler(HERE / "sync.log", maxBytes=500_000, backupCount=3, encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(h)
    log.addHandler(logging.StreamHandler(sys.stdout))
    log.setLevel(logging.INFO)


def load_config():
    cfg = configparser.ConfigParser()
    if not cfg.read(HERE / "config.ini", encoding="utf-8"):
        raise SystemExit("config.ini مش موجود. انسخ config.example.ini باسم config.ini واملاه.")
    d, p = cfg["device"], cfg["portal"]
    return {
        "ip": d.get("ip"), "port": d.getint("port", 4370), "comm_key": d.getint("comm_key", 0),
        "serial": d.get("serial"), "timeout": d.getint("timeout", 15), "udp": d.getboolean("udp", False),
        "url": p.get("connection"),
    }


def load_state():
    try:
        s = json.loads(STATE.read_text(encoding="utf-8"))
        return dt.datetime.fromisoformat(s["last"]) if s.get("last") else None
    except (OSError, ValueError, KeyError):
        return None


def save_state(last):
    STATE.write_text(json.dumps({"last": last.isoformat(sep=" ")}), encoding="utf-8")


def read_device(c):
    """All attendance records on the device as (code, datetime)."""
    from zk import ZK  # pyzk
    zk = ZK(c["ip"], port=c["port"], timeout=c["timeout"], password=c["comm_key"], force_udp=c["udp"], ommit_ping=True)
    conn = zk.connect()
    try:
        return [(str(a.user_id).strip(), a.timestamp) for a in conn.get_attendance()]
    finally:
        conn.disconnect()


def connect_db(url):
    import psycopg
    return psycopg.connect(url, autocommit=True, connect_timeout=20)


def run(c, read=read_device, db_connect=connect_db):
    last = load_state()
    db = db_connect(c["url"])
    try:
        try:
            records = read(c)
        except Exception as e:  # device off, wrong IP, network down
            msg = f"مش قادر أوصل لجهاز البصمة على {c['ip']}: {e}"
            log.error(msg)
            db.execute("select hr_device_ping(%s, %s)", (c["serial"], msg[:300]))
            return 0
        # always resend today and yesterday too, in case the device clock was moved;
        # the database skips what it already has
        floor = dt.datetime.combine(dt.date.today() - dt.timedelta(days=1), dt.time())
        since = min(last - MARGIN, floor) if last else None
        rows = sorted((code, ts) for code, ts in records if code and (since is None or ts >= since))
        sent = 0
        for i in range(0, len(rows), BATCH):
            chunk = [[code, ts.strftime("%Y-%m-%d %H:%M:%S")] for code, ts in rows[i:i + BATCH]]
            sent += db.execute("select hr_device_punches(%s, %s::jsonb)", (c["serial"], json.dumps(chunk))).fetchone()[0]
        if not rows:
            db.execute("select hr_device_ping(%s, null)", (c["serial"],))
        newest = max((ts for _, ts in records), default=last)
        if newest and (last is None or newest > last):
            save_state(newest)
        log.info("device: %d punches, sent %d, new %d", len(records), len(rows), sent)
        return sent
    finally:
        db.close()


if __name__ == "__main__":
    setup_logging()
    try:
        run(load_config())
    except SystemExit:
        raise
    except Exception:
        log.exception("حصلت مشكلة")
        sys.exit(1)
