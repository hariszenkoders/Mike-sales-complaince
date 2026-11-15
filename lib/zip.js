// Minimal ZIP reader and writer with no dependencies (deflate via Node's zlib).
'use strict';
const zlib = require('zlib');

// ---- read: returns [{ name, data(Buffer) }] for every file (folders skipped) ----
exports.read = function (buf, opts) {
  opts = opts || {};
  const maxFiles = opts.maxFiles || 2000, maxTotal = opts.maxTotal || 300 * 1024 * 1024;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error('ZIP has too many files');
  const out = []; let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad ZIP directory');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loc = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + xlen + clen;
    if (/\/$/.test(name) || /(^|\/)(__MACOSX|\.DS_Store)/.test(name)) continue;
    if (flags & 1) throw new Error('Encrypted ZIP files aren’t supported');
    if (buf.readUInt32LE(loc) !== 0x04034b50) throw new Error('Bad ZIP entry');
    const start = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const raw = buf.slice(start, start + csize);
    total += usize; if (total > maxTotal) throw new Error('ZIP is too large when unpacked');
    let data;
    if (method === 0) data = raw; else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) + 1024 }); else throw new Error('Unsupported ZIP compression in ' + name);
    out.push({ name: name, data: data });
  }
  return out;
};

// ---- write: files = [{ name, data(Buffer|string) }] → Buffer ----
exports.write = function (files) {
  const parts = [], dir = []; let off = 0;
  const now = new Date(), dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)), dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate());
  files.forEach(function (f) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = zlib.crc32(data), comp = zlib.deflateRawSync(data), useComp = comp.length < data.length, body = useComp ? comp : data;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(useComp ? 8 : 0, 8); h.writeUInt16LE(dt, 10); h.writeUInt16LE(dd, 12);
    h.writeUInt32LE(crc >>> 0, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(useComp ? 8 : 0, 10); c.writeUInt16LE(dt, 12); c.writeUInt16LE(dd, 14);
    c.writeUInt32LE(crc >>> 0, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, body); dir.push(c, name); off += 30 + name.length + body.length;
  });
  const cd = Buffer.concat(dir), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat(parts.concat([cd, e]));
};
