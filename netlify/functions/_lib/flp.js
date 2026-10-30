// netlify/functions/_lib/flp.js
//
// FLP360-Downline-Export für JARVIS. Dominik lädt in FLP360 unter Downline
// die Excel-Datei herunter (Download, "0 CC ausblenden" aus) und schickt sie
// dem Bot. Hier wird die .xlsx ohne npm-Paket gelesen (ist nur ein ZIP mit
// XML-Dateien), Telefon und E-Mail werden weggelassen und der Rest in
// Supabase (flp_exports) gespeichert. Das Tool "flp_partner" in agent.js
// liest immer den neuesten Export.
//
// Ein genaues Bestelldatum steht nicht im Export, nur die persönlichen CC
// der letzten 4 Monate und die Jahressummen. "Letzte Bestellung" ist darum
// der letzte Monat mit persönlichem CC.

const zlib = require('zlib');
const { pgrest } = require('./supabase');

// ---------- .xlsx lesen ----------

// Liest alle Dateien aus einem ZIP über das zentrale Verzeichnis am Ende
function unzip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Das ist keine gültige Excel-Datei (.xlsx).');
  const count = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const raw = buffer.subarray(start, start + compSize);
    files[name] = method === 8 ? zlib.inflateRawSync(raw) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function textRuns(xml) {
  return decodeXml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Erstes Tabellenblatt als Array von Zeilen (Array von Strings)
function readSheet(buffer) {
  const files = unzip(buffer);
  const shared = files['xl/sharedStrings.xml']
    ? [...files['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]))
    : [];
  const sheetName = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort()[0];
  if (!sheetName) throw new Error('In der Excel-Datei ist kein Tabellenblatt.');
  const xml = files[sheetName].toString('utf8');
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of rowMatch[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const [, col, attrs, inner = ''] = c;
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = '';
      if (/t="s"/.test(attrs) && v) value = shared[Number(v[1])] || '';
      else if (/t="inlineStr"/.test(attrs)) value = textRuns(inner);
      else if (v) value = decodeXml(v[1]);
      row[colIndex(col)] = value;
    }
    rows.push(Array.from(row, (x) => (x === undefined ? '' : x)));
  }
  return rows;
}

// ---------- FLP-Export verstehen ----------

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const MONTH_NAMES = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
// Kontaktdaten kommen nie in die Datenbank und nie zu JARVIS
const PRIVATE_COLUMNS = /PHONE|MOBILE|EMAIL|E-MAIL|MAIL|ADDRESS|ADRESSE|STREET|STRASSE|TELEFON/i;

const num = (s) => {
  const n = parseFloat(String(s || '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
};
const monthLabel = (key) => `${MONTH_NAMES[Number(key.slice(5)) - 1]} ${key.slice(0, 4)}`;

function parseExport(buffer) {
  const rows = readSheet(buffer);
  const header = (rows[0] || []).map((h) => String(h).trim().toUpperCase());
  const find = (name) => header.indexOf(name);
  const iName = find('NAME');
  const iTitle = find('TITLE');
  if (iName < 0 || iTitle < 0) {
    throw new Error('Das sieht nicht wie der FLP360-Downline-Export aus (Spalten NAME und TITLE fehlen).');
  }
  // "PERSONAL CC - OCT - 2026" -> Monat 2026-10
  const personalCols = [];
  header.forEach((h, i) => {
    const m = h.match(/^PERSONAL CC - ([A-Z]{3}) - (\d{4})$/);
    if (m && MONTHS[m[1]]) personalCols.push({ i, key: `${m[2]}-${String(MONTHS[m[1]]).padStart(2, '0')}` });
  });
  if (!personalCols.length) throw new Error('Im Export fehlen die Spalten "PERSONAL CC - Monat".');
  personalCols.sort((a, b) => (a.key < b.key ? 1 : -1)); // neuester Monat zuerst
  const ytd = {};
  header.forEach((h, i) => {
    const m = h.match(/^TOTAL ACTIVE CC YTD - (\d{4})$/);
    if (m) ytd[m[1]] = i;
  });
  const optional = (name) => { const i = find(name); return i >= 0 && !PRIVATE_COLUMNS.test(name) ? i : -1; };
  const iId = optional('FBO ID');
  const iGen = optional('GENERATION');
  const iCountry = optional('COUNTRY');
  const iSponsor = optional('SPONSOR DATE');

  const partners = [];
  for (const row of rows.slice(1)) {
    const name = String(row[iName] || '').trim();
    if (!name) continue;
    const cc = {};
    for (const { i, key } of personalCols) cc[key] = num(row[i]);
    const ytdCc = {};
    for (const [year, i] of Object.entries(ytd)) ytdCc[year] = num(row[i]);
    partners.push({
      id: iId >= 0 ? String(row[iId]) : null,
      name: name.replace(/\S+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase()),
      titel: String(row[iTitle] || '').trim(),
      generation: iGen >= 0 ? Math.round(num(row[iGen])) : null,
      land: iCountry >= 0 ? String(row[iCountry] || '') : null,
      sponsor_datum: iSponsor >= 0 ? String(row[iSponsor] || '') : null,
      cc,
      ytd: ytdCc,
    });
  }
  return { months: personalCols.map((c) => c.key), partners };
}

// ---------- Speichern & Abfragen ----------

async function saveExport(fileName, parsed) {
  const rows = await pgrest('flp_exports', {
    method: 'POST',
    prefer: 'return=representation',
    body: [{ filename: fileName || null, months: parsed.months, partners: parsed.partners }],
  });
  return rows[0];
}

async function latestExport() {
  const rows = await pgrest('flp_exports', { query: 'order=id.desc&limit=1&select=created_at,months,partners' });
  return rows[0] || null;
}

const isFpc = (p) => /preferred customer/i.test(p.titel);

// Letzter Monat mit persönlichem CC. Davor nur Jahressummen (Gruppen-CC),
// das ist ungenauer und wird so gekennzeichnet.
function lastOrder(p, months) {
  for (const key of months) {
    if ((p.cc[key] || 0) > 0) return { sort: key, text: monthLabel(key), cc: p.cc[key] };
  }
  const oldest = months[months.length - 1];
  const year = oldest.slice(0, 4);
  if ((p.ytd[year] || 0) > 0) return { sort: `${year}-00`, text: `früher in ${year} (vor ${monthLabel(oldest)})`, cc: null };
  const prev = String(Number(year) - 1);
  if ((p.ytd[prev] || 0) > 0) return { sort: `${prev}-00`, text: `${prev}`, cc: null };
  return { sort: '0000', text: `keine Bestellung ${prev} oder ${year}`, cc: null };
}

function summarize(exp) {
  const months = exp.months;
  const current = months[0];
  const fbo = exp.partners.filter((p) => !isFpc(p));
  const fpc = exp.partners.filter(isFpc);
  const inactive = (list) => list.filter((p) => !(p.cc[current] > 0)).length;
  return {
    monate: months.map(monthLabel),
    partner: exp.partners.length,
    fbo: fbo.length,
    fpc: fpc.length,
    fbo_ohne_cc_aktueller_monat: inactive(fbo),
    fpc_ohne_cc_aktueller_monat: inactive(fpc),
  };
}

// Für das JARVIS-Tool: gefilterte und sortierte Liste
async function partnerList({ typ, nur_inaktive, monate_ohne_cc }) {
  const exp = await latestExport();
  if (!exp) return { fehler: 'Noch kein FLP-Export gespeichert. Dominik muss mir zuerst die Excel-Datei aus FLP360 (Downline, Download) schicken.' };
  const months = exp.months;
  const n = Math.min(Math.max(monate_ohne_cc || 1, 1), months.length);
  const window = months.slice(0, n);
  let list = exp.partners;
  if (typ === 'fbo') list = list.filter((p) => !isFpc(p));
  if (typ === 'fpc') list = list.filter(isFpc);
  if (nur_inaktive) list = list.filter((p) => window.every((m) => !(p.cc[m] > 0)));
  const rows = list
    .map((p) => ({ p, last: lastOrder(p, months) }))
    .sort((a, b) => (a.last.sort === b.last.sort ? a.p.name.localeCompare(b.p.name) : a.last.sort < b.last.sort ? 1 : -1))
    // Eine Zeile pro Person statt JSON-Objekten, spart bei 300 Partnern viele Tokens
    .map(({ p, last }) => {
      const typ = isFpc(p) ? 'FPC' : 'FBO';
      const cc = last.cc != null ? ` (${last.cc} CC)` : '';
      return { typ, letzte: last.text, name: p.name, zeile: `${p.name} | ${typ} | ${p.titel} | ${p.land || '-'} | Gen ${p.generation ?? '-'} | dabei seit ${p.sponsor_datum || '-'} | letzte Bestellung: ${last.text}${cc}` };
    });
  return {
    export_vom: String(exp.created_at).slice(0, 10),
    monate_im_export: months.map(monthLabel),
    filter: nur_inaktive
      ? `kein persönliches CC in: ${window.map(monthLabel).join(', ')}`
      : 'alle',
    hinweis: 'Sortiert nach letzter Bestellung, die jüngste zuerst. "Letzte Bestellung" ist der letzte Monat mit persönlichem CC. Angaben wie "früher in 2026" oder ein Jahr kommen aus der Jahressumme (Gruppen-CC) und sind nur ungefähr. Ist der aktuelle Monat erst ein paar Tage alt, haben viele noch nicht bestellt.',
    anzahl: rows.length,
    anzahl_fbo: rows.filter((r) => r.typ === 'FBO').length,
    anzahl_fpc: rows.filter((r) => r.typ === 'FPC').length,
    spalten: 'Name | FBO/FPC | Titel | Land | Generation | dabei seit | letzte Bestellung',
    partner: rows.map((r) => r.zeile),
    _rows: rows,
  };
}

// PDF-Text (Format von pdf.js): pro Typ ein Kapitel, darin nach letzter
// Bestellung gruppiert, in der Reihenfolge von partnerList
function pdfText(result) {
  const [y, m, d] = result.export_vom.split('-');
  const parts = [`Stand: FLP-Export vom ${d}.${m}.${y}, Monate ${result.monate_im_export.join(', ')}. Filter: ${result.filter}.`, ''];
  for (const typ of ['FBO', 'FPC']) {
    const rows = result._rows.filter((r) => r.typ === typ);
    if (!rows.length) continue;
    parts.push(`# ${typ === 'FBO' ? 'Geschäftspartner (FBO)' : 'Preferred Customer (FPC)'}: ${rows.length}`);
    let group = null;
    for (const r of rows) {
      if (r.letzte !== group) {
        group = r.letzte;
        parts.push('', `## Letzte Bestellung: ${group} (${rows.filter((x) => x.letzte === group).length})`);
      }
      parts.push(`- ${r.zeile.split(' | ').filter((_, i) => i !== 1 && i !== 6).join(' | ')}`);
    }
    parts.push('');
  }
  parts.push('Letzte Bestellung = letzter Monat mit persönlichem CC. Ältere Angaben stammen aus der Jahressumme (Gruppen-CC) und sind nur ungefähr.');
  return parts.join('\n');
}

module.exports = { readSheet, parseExport, saveExport, latestExport, summarize, partnerList, pdfText, PRIVATE_COLUMNS };
