// Read what matters from an uploaded certificate or report: standard, certification body, dates, scope,
// and whether the supplier's name and address appear on it.
'use strict';
const pdfText = require('./pdftext');
const zip = require('./zip');

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const STANDARDS = [[/FSSC\s*22000(\s*(version|v\.?)\s*\d+(\.\d+)?)?/i, 'FSSC 22000'], [/BRC\s*GS|BRCGS|BRC Global Standard/i, 'BRCGS'], [/\bSQF\b/i, 'SQF'], [/\bIFS\s+Food\b/i, 'IFS Food'],
  [/ISO\s*22000/i, 'ISO 22000'], [/\bHACCP\b/i, 'HACCP'], [/\bhalal\b/i, 'Halal'], [/\bkosher\b/i, 'Kosher'], [/\borganic\b/i, 'Organic'], [/\bGMP\b|good manufacturing practice/i, 'GMP'], [/ISO\s*9001/i, 'ISO 9001']];
const BODIES = ['SGS', 'Bureau Veritas', 'Intertek', 'TÜV SÜD', 'TÜV Rheinland', 'TÜV NORD', 'TUV', 'DNV', 'LRQA', "Lloyd's Register", 'NSF', 'Eurofins', 'Control Union', 'Kiwa', 'BSI', 'Mérieux', 'SAI Global', 'Perry Johnson', 'NQA', 'QIMA', 'Quacert', 'Vinacert', 'Global Food Safety Resources', 'Food Safety Management', 'AIB International', 'Mérieux NutriSciences', 'URS', 'ACM', 'Certification Europe', 'IFANCA', 'Orthodox Union', 'OU Kosher', 'JAKIM', 'MUI'];
const EXPIRY_KW = /(valid\s*(until|till|to|through|thru)|expir\w*|expiry|expiration|due\s*date|certificate\s*valid|valid\s*period|valid\s*from[^\n]{0,40}?\bto\b|re-?certification\s*due|next\s*audit\s*due)/i;
const ISSUE_KW = /(date\s*of\s*issue|issue\s*date|issued(\s*on)?|date\s*of\s*certification|certification\s*date|certificate\s*date|audit\s*date|date\s*of\s*audit)/i;

// Find every date in a piece of text → [{ iso, index, ambiguous }]
function dates(t) {
  const out = []; let m;
  const push = function (y, mo, d, idx, amb) { y = +y; if (y < 100) y += 2000; mo = +mo; d = +d; if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return; out.push({ iso: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), index: idx, ambiguous: !!amb }); };
  const iso = /\b(\d{4})[-./](\d{1,2})[-./](\d{1,2})\b/g; while ((m = iso.exec(t))) push(m[1], m[2], m[3], m.index);
  const num = /\b(\d{1,2})[-./](\d{1,2})[-./](\d{2,4})\b/g;
  while ((m = num.exec(t))) { const a = +m[1], b = +m[2]; if (a > 12) push(m[3], b, a, m.index); else if (b > 12) push(m[3], a, b, m.index); else push(m[3], b, a, m.index, a !== b); } // day-first unless impossible
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+(?:of\s+)?([A-Za-z]{3,9})\.?[\s\-,]+(\d{4})\b/g; while ((m = dmy.exec(t))) { const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) push(m[3], mo, m[1], m.index); }
  const mdy = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g; while ((m = mdy.exec(t))) { const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] || MONTHS[m[1].toLowerCase().slice(0, 3)]; if (mo) push(m[3], mo, m[2], m.index); }
  return out.sort(function (a, b) { return a.index - b.index; });
}
// The date that follows a keyword most closely (same line or the next)
function dateAfter(t, kw, all) {
  let best = null; const re = new RegExp(kw.source, 'gi'); let m;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    const d = all.find(function (x) { return x.index >= end && x.index - end < 120 && t.slice(end, x.index).split('\n').length <= 3; });
    if (d && (!best || d.index - end < best.dist)) best = { d: d, dist: d.index - end };
  }
  return best && best.d;
}
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(co|company|ltd|limited|jsc|joint|stock|corp|corporation|inc|llc|pte|plc|the|group|trading|import|export|mtv|tnhh)\b/g, ' ').replace(/\s+/g, ' ').trim(); }

exports.text = function (buf, name, mime) {
  name = String(name || '').toLowerCase();
  if (/pdf/.test(mime || '') || /\.pdf$/.test(name)) return pdfText(buf);
  if (/\.docx$/.test(name)) { try { const doc = zip.read(buf).find(function (f) { return f.name === 'word/document.xml'; }); return doc ? doc.data.toString('utf8').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : ''; } catch (e) { return ''; } }
  if (/\.(txt|csv)$/.test(name)) return buf.toString('utf8');
  return null; // images and other formats: can't read here
};

// supplier = { name, alias, loc }; enteredExpiry = what the person typed (or null)
exports.read = function (buf, name, mime, supplier, enteredExpiry) {
  const t0 = exports.text(buf, name, mime);
  if (t0 === null) return { none: true, kind: 'image' };
  const t = String(t0 || '').slice(0, 60000);
  if (t.replace(/\s/g, '').length < 30) return { none: true };
  const r = { warn: [] };
  for (const s of STANDARDS) { const m = t.match(s[0]); if (m) { r.standard = s[1] === 'FSSC 22000' ? m[0].replace(/\s+/g, ' ').replace(/\s*(version|v\.?)\s*/i, ' v').trim() : s[1]; break; } }
  const low = t.toLowerCase();
  for (const b of BODIES) if (low.indexOf(b.toLowerCase()) >= 0) { r.body = b; break; }
  const all = dates(t);
  const ex = dateAfter(t, EXPIRY_KW, all), is = dateAfter(t, ISSUE_KW, all);
  if (ex) { r.expiry = ex.iso; if (ex.ambiguous) r.warn.push('Expiry read as ' + ex.iso + ' (day first). Check the month and day.'); }
  else { const fut = all.filter(function (d) { return Date.parse(d.iso) > Date.now() - 365 * 86400e3; }).sort(function (a, b) { return b.iso.localeCompare(a.iso); })[0]; if (fut && all.length > 1) { r.expiry = fut.iso; r.guessed = true; r.warn.push('No “valid until” label found; ' + fut.iso + ' is the latest date in the file. Check it.'); } }
  if (is) r.issued = is.iso;
  const sm = t.match(/\bscope\b[^:\n]*[:\n]\s*([^\n]{8,220})/i); if (sm) r.scope = sm[1].trim().replace(/\s+/g, ' ').slice(0, 200);
  const nt = norm(t);
  if (supplier) {
    const names = [supplier.name].concat(supplier.fdaNames || []); const al = String(supplier.alias || '').match(/^(?:ships as|aka|also known as|trades as|dba)\s+(.+)$/i); if (al) names.push(al[1]);
    const found = names.some(function (n) { const k = norm(String(n).replace(/\(.*?\)/g, ' ')); return k.length >= 4 && (nt.indexOf(k) >= 0 || k.split(' ').filter(function (w) { return w.length > 2; }).every(function (w) { return nt.indexOf(w) >= 0; })); });
    if (!found) r.warn.push('The supplier’s name (' + supplier.name + ') wasn’t found in this file. Check it’s issued to this supplier.');
    const words = norm(supplier.loc).split(' ').filter(function (w) { return w.length >= 3 && !/^(vietnam|thailand|china|mexico|india|province|district|city|industrial|zone|road|street|ward|commune|park|formerly|and|lot|km|hcmc|town|village|area)$/.test(w); });
    if (words.length && !words.some(function (w) { return nt.indexOf(w) >= 0; })) r.warn.push('The facility address on file (' + supplier.loc + ') wasn’t found in this file. Check the certificate covers this site.');
  }
  if (r.expiry && Date.parse(r.expiry) < Date.now()) r.warn.push('This document expired on ' + r.expiry + '.');
  if (enteredExpiry && r.expiry && enteredExpiry !== r.expiry && !r.guessed) r.warn.push('The expiry entered (' + enteredExpiry + ') differs from the file (' + r.expiry + ').');
  if (!r.warn.length) delete r.warn;
  return r;
};
exports._dates = dates;
