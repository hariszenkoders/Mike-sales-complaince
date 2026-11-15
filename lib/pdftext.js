// Best-effort text extraction from text-based PDFs, with no dependencies.
// Handles compressed streams, object streams and ToUnicode font maps. Scanned (image-only) PDFs return ''.
'use strict';
const zlib = require('zlib');

function a85(b) {
  let t = b.toString('latin1').replace(/\s+/g, ''); if (t.startsWith('<~')) t = t.slice(2); const e = t.indexOf('~>'); if (e >= 0) t = t.slice(0, e);
  const out = []; let grp = [];
  for (const ch of t) {
    if (ch === 'z' && !grp.length) { out.push(0, 0, 0, 0); continue; }
    grp.push(ch.charCodeAt(0) - 33);
    if (grp.length === 5) { let v = 0; for (const d of grp) v = v * 85 + d; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); grp = []; }
  }
  if (grp.length) { const n = grp.length; while (grp.length < 5) grp.push(84); let v = 0; for (const d of grp) v = v * 85 + d; const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; for (let i = 0; i < n - 1; i++) out.push(bytes[i]); }
  return Buffer.from(out);
}
function inflate(b) {
  try { return zlib.inflateSync(b); } catch (e) { /* try raw */ }
  try { return zlib.inflateRawSync(b); } catch (e) { /* try skipping header */ }
  try { return zlib.inflateRawSync(b.slice(2)); } catch (e) { return null; }
}

// All objects: number → { dict (string), stream (Buffer|null) }
function objects(buf) {
  const s = buf.toString('latin1'), objs = {};
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(s))) {
    const num = +m[1], start = re.lastIndex;
    const end = s.indexOf('endobj', start); if (end < 0) break;
    let body = s.slice(start, end), stream = null;
    const si = body.search(/\bstream\r?\n/);
    if (si >= 0) {
      const dict = body.slice(0, si);
      let ds = start + si + body.slice(si).match(/^stream\r?\n/)[0].length;
      const lm = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let de = lm ? ds + (+lm[1]) : s.lastIndexOf('endstream', end);
      if (de > end || de < ds) de = s.lastIndexOf('endstream', end);
      let raw = buf.slice(ds, de);
      const fm = dict.match(/\/Filter\s*(\[[^\]]*\]|\/\w+)/);
      const filters = fm ? (fm[1].match(/\/\w+/g) || []) : [];
      for (const f of filters) {
        if (!raw) break;
        if (f === '/FlateDecode' || f === '/Fl') raw = inflate(raw);
        else if (f === '/ASCII85Decode' || f === '/A85') raw = a85(raw);
        else if (f === '/ASCIIHexDecode' || f === '/AHx') raw = Buffer.from(hexToBytes(raw.toString('latin1').replace(/>.*$/s, '')));
        else raw = null; // DCT images, LZW and others: not text
      }
      body = dict; stream = raw;
    }
    objs[num] = { dict: body, stream: stream };
    re.lastIndex = end + 6;
  }
  // objects packed inside object streams (PDF 1.5+)
  Object.keys(objs).forEach(function (k) {
    const o = objs[k]; if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) return;
    const n = +(o.dict.match(/\/N\s+(\d+)/) || [])[1], first = +(o.dict.match(/\/First\s+(\d+)/) || [])[1];
    const t = o.stream.toString('latin1'), hdr = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const on = hdr[2 * i], a = first + hdr[2 * i + 1], b = i + 1 < n ? first + hdr[2 * i + 3] : t.length;
      if (!objs[on]) objs[on] = { dict: t.slice(a, b), stream: null };
    }
  });
  return objs;
}

function hexToBytes(h) { h = h.replace(/[^0-9a-f]/gi, ''); if (h.length % 2) h += '0'; const out = []; for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2), 16)); return out; }
function cmap(t) {
  const map = {}; let width = 1;
  const cp = function (hex) { const b = hexToBytes(hex); let s = ''; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]); return s; };
  let m;
  const ch = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((m = ch.exec(t))) { const r = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g; let x; while ((x = r.exec(m[1]))) { map[parseInt(x[1], 16)] = cp(x[2]); width = Math.max(width, x[1].length / 2); } }
  const rg = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((m = rg.exec(t))) {
    const r = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g; let x;
    while ((x = r.exec(m[1]))) {
      const lo = parseInt(x[1], 16), hi = parseInt(x[2], 16); width = Math.max(width, x[1].length / 2);
      if (x[4] !== undefined) { const base = cp(x[4]); for (let c = lo; c <= hi && c - lo < 5000; c++) map[c] = base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo)); }
      else { const arr = x[5].match(/<[0-9a-fA-F]*>/g) || []; arr.forEach(function (a, j) { map[lo + j] = cp(a.slice(1, -1)); }); }
    }
  }
  return { map: map, width: width };
}

function readString(t, i) { // literal string starting at '(' → [bytes, nextIndex]
  const out = []; let depth = 1; i++;
  while (i < t.length && depth > 0) {
    const c = t[i];
    if (c === '\\') { const n = t[i + 1];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (esc[n] !== undefined) { out.push(esc[n]); i += 2; }
      else if (/[0-7]/.test(n)) { const o = t.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0]; out.push(parseInt(o, 8) & 255); i += 1 + o.length; }
      else if (n === '\r' || n === '\n') { i += 2; if (n === '\r' && t[i] === '\n') i++; }
      else { i += 2; }
      continue; }
    if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) { i++; break; } }
    out.push(c.charCodeAt(0) & 255); i++;
  }
  return [out, i];
}
function decode(bytes, font) {
  if (font && font.width === 2) { let s = ''; for (let i = 0; i + 1 < bytes.length; i += 2) { const c = (bytes[i] << 8) | bytes[i + 1]; s += font.map[c] !== undefined ? font.map[c] : ''; } return s; }
  let s = ''; for (const b of bytes) s += font && font.map[b] !== undefined ? font.map[b] : (b >= 32 && b < 127 ? String.fromCharCode(b) : (b >= 160 ? String.fromCharCode(b) : (b === 9 ? ' ' : ''))); return s;
}

// Walk a content stream and return its text, with line breaks where the text moves down
function contentText(t, fonts) {
  let out = '', font = null, i = 0; const stack = [];
  while (i < t.length) {
    const c = t[i];
    if (c === '(') { const r = readString(t, i); stack.push({ s: r[0] }); i = r[1]; continue; }
    if (c === '<' && t[i + 1] !== '<') { const e = t.indexOf('>', i); stack.push({ s: hexToBytes(t.slice(i + 1, e)) }); i = e + 1; continue; }
    if (c === '[') { stack.push('['); i++; continue; }
    if (c === ']') { const arr = []; while (stack.length && stack[stack.length - 1] !== '[') arr.unshift(stack.pop()); stack.pop(); stack.push({ arr: arr }); i++; continue; }
    if (c === '%') { const e = t.indexOf('\n', i); i = e < 0 ? t.length : e; continue; }
    if (/\s/.test(c)) { i++; continue; }
    const m = /^(\/[^\s\/\[\]()<>{}%]+|[-+]?\d*\.?\d+|[A-Za-z'"*]+[0-9]?|<<|>>|\{|\})/.exec(t.slice(i, i + 64));
    if (!m) { i++; continue; }
    const tok = m[1]; i += tok.length;
    if (/^[-+]?\d*\.?\d+$/.test(tok)) { stack.push(+tok); continue; }
    if (tok[0] === '/') { stack.push(tok); continue; }
    switch (tok) {
      case 'Tf': { const name = stack[stack.length - 2]; font = typeof name === 'string' ? fonts[name.slice(1)] || null : null; break; }
      case 'Tj': case "'": case '"': { const v = stack[stack.length - 1]; if (tok !== 'Tj') out += '\n'; if (v && v.s) out += decode(v.s, font); break; }
      case 'TJ': { const v = stack[stack.length - 1]; if (v && v.arr) v.arr.forEach(function (x) { if (x && x.s) out += decode(x.s, font); else if (typeof x === 'number' && x < -180) out += ' '; }); break; }
      case 'Td': case 'TD': { const ty = stack[stack.length - 1]; out += (typeof ty === 'number' && Math.abs(ty) > 0.5) ? '\n' : ' '; break; }
      case 'T*': out += '\n'; break;
      case 'Tm': out += '\n'; break;
      case 'ET': out += '\n'; break;
      case 'BI': { const e = t.indexOf('EI', i); i = e < 0 ? t.length : e + 2; break; }
    }
    if (!/^(Tf|Tj|TJ|Td|TD|Tm|T\*|ET|BT|'|")$/.test(tok) && !/^[A-Za-z]/.test(tok)) continue;
    stack.length = 0;
  }
  return out;
}

module.exports = function pdfText(buf, maxChars) {
  if (!Buffer.isBuffer(buf) || buf.slice(0, 1024).toString('latin1').indexOf('%PDF') < 0) return '';
  const objs = objects(buf);
  // font resource name → ToUnicode map
  const tu = {}, fonts = {};
  Object.keys(objs).forEach(function (k) {
    const d = objs[k].dict; const m = d.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (m && objs[m[1]] && objs[m[1]].stream) tu[k] = cmap(objs[m[1]].stream.toString('latin1'));
  });
  Object.keys(objs).forEach(function (k) {
    const d = objs[k].dict; const fm = d.match(/\/Font\s*<<([\s\S]*?)>>/); let fd = fm ? fm[1] : null;
    if (!fd) { const fr = d.match(/\/Font\s+(\d+)\s+\d+\s+R/); if (fr && objs[fr[1]]) fd = objs[fr[1]].dict; }
    if (!fd) return;
    const r = /\/([^\s\/<>\[\]]+)\s+(\d+)\s+\d+\s+R/g; let x;
    while ((x = r.exec(fd))) if (tu[x[2]] && !fonts[x[1]]) fonts[x[1]] = tu[x[2]];
  });
  let text = '';
  Object.keys(objs).forEach(function (k) {
    const o = objs[k]; if (!o.stream || /\/(Subtype\s*\/Image|Type\s*\/(ObjStm|XRef|Metadata)|Length1|FontFile)/.test(o.dict)) return;
    const t = o.stream.toString('latin1');
    if (!/\b(BT|Tj|TJ)\b/.test(t) || /begincmap/.test(t)) return;
    text += contentText(t, fonts) + '\n';
    if (text.length > (maxChars || 200000)) return;
  });
  return text.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};
