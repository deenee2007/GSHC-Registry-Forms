/*
 * src/services/sheetReader.js — reads the first sheet of an Excel (.xlsx)
 * file, or a CSV file, into rows of cell values (strings, and numbers as
 * Excel keeps them, so dates arrive as Excel day numbers).
 *
 * An .xlsx file is a zip of XML parts; it is read here with Node's own
 * zlib rather than a spreadsheet library. Old .xls files are not read:
 * save them as .xlsx (or CSV) first.
 */
const zlib = require('zlib');

const MAX_UNZIPPED = 40 * 1024 * 1024; // guards against a "zip bomb"
const fail = (message) => Object.assign(new Error(message), { status: 400 });

// The parts of a zip file, by name (only those wanted).
function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw fail('This file could not be read as an Excel file. Save it as .xlsx (or CSV) and try again.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  let total = 0;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted(name)) continue;
    total += full;
    if (total > MAX_UNZIPPED) throw fail('The file is too large to read. Keep each register under about 20,000 rows.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.slice(start, start + size);
    out[name] = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED }) : null;
  }
  return out;
}

const entities = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[e.toLowerCase()]
  || String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))));
// The text of every <t> in a piece of XML (a shared string may be split into runs).
const texts = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => entities(m[1])).join('');
const colIndex = (ref) => { let n = 0; for (const ch of ref.replace(/\d+$/, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };

function readXlsx(buf) {
  const parts = unzip(buf, (n) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(n));
  const str = (n) => parts[n] ? parts[n].toString('utf8') : '';
  if (!parts['xl/workbook.xml']) throw fail('This file could not be read as an Excel file. Save it as .xlsx (or CSV) and try again.');
  // The first sheet in the workbook, through its relationship.
  const first = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(str('xl/workbook.xml'));
  const rel = first && new RegExp(`<Relationship\\b[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(str('xl/_rels/workbook.xml.rels'))
    || first && new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${first[1]}"`).exec(str('xl/_rels/workbook.xml.rels'));
  const target = rel ? 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '') : 'xl/worksheets/sheet1.xml';
  const sheet = str(target) || str('xl/worksheets/sheet1.xml');
  if (!sheet) throw fail('The Excel file has no sheet to read.');
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1]));
  const rows = [];
  for (const r of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] || '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      let value = '';
      if (type === 's') value = v ? shared[parseInt(v[1], 10)] || '' : '';
      else if (type === 'inlineStr') value = texts(body);
      else if (type === 'str' || type === 'e') value = v ? entities(v[1]) : '';
      else if (type === 'b') value = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      else value = v ? Number(v[1]) : '';
      row[ref ? colIndex(ref[1]) : row.length] = value;
    }
    rows.push(Array.from(row, x => (x === undefined ? '' : x)));
  }
  return rows;
}

// CSV, as Excel saves it: quotes, commas (or semicolons in some settings), line breaks in cells.
function readCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Rows of the file: .xlsx or .csv (judged by its content, then its name). */
function read(buffer, name) {
  if (!buffer || !buffer.length) throw fail('The file is empty.');
  if (buffer.readUInt32LE(0) === 0x04034b50) return readXlsx(buffer);
  if (buffer.readUInt32LE(0) === 0xe011cfd0) throw fail('This is an old Excel (.xls) file. In Excel, choose Save As, Excel Workbook (.xlsx), and upload that.');
  if (/\.(xlsx|xlsm)$/i.test(name || '')) throw fail('This file could not be read as an Excel file. Save it as .xlsx (or CSV) and try again.');
  return readCsv(buffer.toString('utf8'));
}

module.exports = { read, readCsv, readXlsx };
