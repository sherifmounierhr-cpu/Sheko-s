// A small reader for .xlsx and .csv files, enough to bring a spreadsheet's cells in
// as rows of values. An .xlsx is a zip of XML files: this finds each sheet, inflates
// it with the browser's own DecompressionStream, and reads the cells (shared strings,
// inline strings, numbers, booleans). Dates stay Excel serial numbers. No formulas
// are evaluated; their last saved value is used.

const MAX = 15 * 1024 * 1024;
const td = new TextDecoder();

async function inflate(bytes, method) {
  if (method === 0) return bytes;
  if (method !== 8) throw new Error("unsupported zip method");
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
  return new Uint8Array(out);
}

// name -> bytes for every file in the zip
async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("not a zip");
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad zip");
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true), name = td.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    files.set(name, { method, bytes: buf.subarray(start, start + size) });
  }
  return files;
}

const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
const byTag = (node, tag) => [...node.getElementsByTagName(tag)];
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/[0-9]/g, "")) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

async function readXlsx(buf) {
  const files = await unzip(buf);
  const text = async (name) => { const f = files.get(name); return f ? td.decode(await inflate(f.bytes, f.method)) : ""; };
  const shared = byTag(xml(await text("xl/sharedStrings.xml") || "<sst/>"), "si").map((si) => byTag(si, "t").map((t) => t.textContent).join(""));
  const rels = new Map(byTag(xml(await text("xl/_rels/workbook.xml.rels") || "<r/>"), "Relationship").map((r) => [r.getAttribute("Id"), r.getAttribute("Target")]));
  const sheets = byTag(xml(await text("xl/workbook.xml") || "<w/>"), "sheet").map((s) => {
    const target = rels.get(s.getAttribute("r:id")) || "";
    return { name: s.getAttribute("name") || "", path: target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "") };
  });
  const out = [];
  for (const sh of sheets) {
    const doc = xml(await text(sh.path)); if (!doc) continue;
    const rows = [];
    for (const row of byTag(doc, "row")) {
      const r = Number(row.getAttribute("r")) - 1, cells = [];
      for (const c of byTag(row, "c")) {
        const t = c.getAttribute("t"), v = byTag(c, "v")[0]?.textContent;
        let val = null;
        if (t === "s") val = shared[Number(v)] ?? null;
        else if (t === "inlineStr") val = byTag(c, "t").map((x) => x.textContent).join("");
        else if (t === "b") val = v === "1";
        else if (t === "str" || t === "e") val = v ?? null;
        else if (v != null && v !== "") val = Number(v);
        cells[colIndex(c.getAttribute("r") || "A")] = val;
      }
      rows[r >= 0 ? r : rows.length] = cells;
    }
    out.push({ name: sh.name, rows: Array.from(rows, (r) => r || []) });
  }
  return out;
}

// CSV with quotes, commas or semicolons, and an optional BOM
function readCsv(text) {
  text = text.replace(/^﻿/, "");
  const sep = (text.split("\n")[0].match(/;/g) || []).length > (text.split("\n")[0].match(/,/g) || []).length ? ";" : ",";
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return [{ name: "CSV", rows: rows.map((r) => r.map((c) => (c === "" ? null : c))) }];
}

export async function readSheets(file) {
  if (file.size > MAX) throw new Error("too big");
  const buf = new Uint8Array(await file.arrayBuffer());
  if (/\.csv$/i.test(file.name) || buf[0] !== 0x50) return readCsv(td.decode(buf));
  return readXlsx(buf);
}
