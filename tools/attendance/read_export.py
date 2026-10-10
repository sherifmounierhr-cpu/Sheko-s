"""Read the attendance export of the fingerprint device (legacy BIFF2 .xls or CSV).

Returns rows of (code, name, time) where time is the device's own text,
e.g. "2026-09-01 11:11 AM".
"""
import csv
import struct


def _read_biff(path):
    data = open(path, "rb").read()
    if data[:4] == b"\xd0\xcf\x11\xe0":
        raise ValueError("Newer Excel format: open it in Excel and save as CSV first.")
    rows, i = {}, 0
    while i + 4 <= len(data):
        rtype, length = struct.unpack("<HH", data[i:i + 4])
        body = data[i + 4:i + 4 + length]
        i += 4 + length
        if rtype == 0x0004:  # BIFF2 LABEL
            r, c = struct.unpack("<HH", body[:4])
            n = body[7]
            rows.setdefault(r, {})[c] = body[8:8 + n].decode("utf-8", "replace")
        elif rtype == 0x0204:  # BIFF3+ LABEL
            r, c, _, n = struct.unpack("<HHHH", body[:8])
            rows.setdefault(r, {})[c] = body[8:8 + n].decode("utf-8", "replace")
    return [[rows[r].get(c, "") for c in range(3)] for r in sorted(rows)]


def read_export(path):
    if path.lower().endswith(".xls"):
        table = _read_biff(path)
    else:
        with open(path, newline="", encoding="utf-8-sig") as f:
            table = list(csv.reader(f))
    return [(r[0].strip(), r[1].strip(), r[2].strip()) for r in table
            if len(r) >= 3 and r[0].strip().isdigit()]
