// FSVP Vault working demo server.
// No third-party packages: Node 22.13+ built-ins only (http, crypto, fs, node:sqlite).
// Run: node server.js   (see README.md for environment variables)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const actions = require('./lib/actions');
const fda = require('./lib/fda');
const mail = require('./lib/mail');
const certread = require('./lib/certread');
const zip = require('./lib/zip');
const auth = require('./lib/auth');

const ROOT = __dirname;
// Settings are read in capitals, with a lowercase fallback in case a host form lowercases the name
function env(k) { return process.env[k] !== undefined ? process.env[k] : process.env[k.toLowerCase()]; }
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const PORT = parseInt(process.env.PORT || '3000', 10);
const DEMO_EMAIL = (env('DEMO_EMAIL') || 'demo@fsvpvault.com').trim().toLowerCase();
const DEMO_PASSWORD = env('DEMO_PASSWORD') || 'change-me-now';
const DEMO_NAME = env('DEMO_NAME') || 'Demo user';
const SECRET = env('SESSION_SECRET') || crypto.randomBytes(32).toString('hex');
const MAX_UPLOAD = 15 * 1024 * 1024;
const INLINE_OK = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;
// what suppliers may send through the public upload page
const SUPPLIER_EXT = /\.(pdf|png|jpe?g|gif|webp|heic|docx?|xlsx?|csv|txt)$/i;
const SUPPLIER_DOCS = [['gfsi', 'Food safety certificate (FSSC 22000, BRCGS, SQF, IFS)'], ['audit', 'Audit report'], ['fdareg', 'FDA food facility registration'], ['lacf', 'Low-acid or acidified process filing (FCE / SID)'], ['haccp', 'HACCP or food safety plan'], ['process', 'Process records (retort, UHT, filling logs)'], ['coa', 'Certificate of analysis (COA)'], ['quest', 'Supplier questionnaire'], ['label', 'Product label or allergen statement'], ['halal', 'Halal certificate (optional)'], ['kosher', 'Kosher certificate (optional)'], ['organic', 'Organic certificate (optional)'], ['nongmo', 'Non-GMO certificate (optional)']];
const OPT_DOCS = ['halal', 'kosher', 'organic', 'nongmo'];
const codeTries = new Map();
function findCode(code) {
  code = String(code || '').replace(/\s+/g, '').toUpperCase(); if (code.length < 6) return null;
  for (const w of db.prepare('SELECT id FROM workspaces').all()) {
    const ws = getWs(w.id); const U = ws.data.UPCODE || [];
    for (let i = 0; i < U.length; i++) if (U[i] && String(U[i]).toUpperCase() === code && !(ws.data.removed || {})[i]) return { ws: ws, i: i };
  }
  return null;
}
function codeLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const t = codeTries.get(ip) || { n: 0, at: Date.now() };
  if (Date.now() - t.at > 15 * 60e3) { t.n = 0; t.at = Date.now(); }
  t.n++; codeTries.set(ip, t); return t.n > 20;
}
if (!env('DEMO_PASSWORD')) console.warn('WARNING: DEMO_PASSWORD not set; using the default. Set it before going live.');
if (!env('SESSION_SECRET')) console.warn('WARNING: SESSION_SECRET not set; logins reset on every restart.');

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'fsvpvault.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0, data TEXT NOT NULL, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, at TEXT, user TEXT, type TEXT, target TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS mail (id INTEGER PRIMARY KEY AUTOINCREMENT, ws TEXT, at TEXT, kind TEXT, to_addr TEXT, subject TEXT, status TEXT, error TEXT);
  CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, ws TEXT, owner TEXT, name TEXT, mime TEXT, size INTEGER, path TEXT, expiry TEXT, uploaded_at TEXT, uploaded_by TEXT);
`);

// ---- seed workspaces that don't exist yet ----
// Seeds live in ./seed (fictional demo) or in DATA_DIR/seeds (private workspaces copied onto the server's disk,
// so customer data never has to be committed to the code repository).
function seedPath(id) {
  if (!/^[a-z0-9-]+$/.test(id || '')) return null;
  const a = [path.join(DATA_DIR, 'seeds', id + '.json'), path.join(ROOT, 'seed', id + '.json')];
  for (const f of a) if (fs.existsSync(f)) return f;
  return null;
}
function seed() {
  const ids = new Set(['demo']);
  for (const dir of [path.join(ROOT, 'seed'), path.join(DATA_DIR, 'seeds')]) {
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^[a-z0-9-]+\.json$/.test(f)) ids.add(f.replace(/\.json$/, ''));
  }
  let sort = 0;
  for (const id of ids) {
    sort++;
    if (db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) continue;
    const p = seedPath(id); if (!p) continue;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data.company) continue;
    db.prepare('INSERT INTO workspaces (id, name, sort, data, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, data.company.name, id === 'demo' ? 0 : sort, JSON.stringify(data), new Date().toISOString());
    console.log('Seeded workspace', id);
  }
}
seed();
auth.init(db);
auth.bootstrapOwner(db, DEMO_EMAIL, DEMO_PASSWORD, DEMO_NAME);

// Check one supplier on a copy of the data, then write back only its monitor record,
// so edits made while the (slow) check runs aren't overwritten
async function checkAndMerge(wsId, k) {
  const copy = JSON.parse(JSON.stringify(getWs(wsId).data));
  const r = await fda.checkSupplier(copy, k, { dataDir: DATA_DIR, openfdaKey: env('OPENFDA_API_KEY'), dd: { user: env('FDA_DD_USER'), key: env('FDA_DD_KEY') } });
  const fresh = getWs(wsId);
  fresh.data.MON = fresh.data.MON || {};
  const keepV = (fresh.data.MON[k] || {}).verdicts; // verdicts made while the check ran win
  fresh.data.MON[k] = copy.MON[k];
  if (keepV) { fresh.data.MON[k].verdicts = keepV; fda.summarize(fresh.data, k); }
  if (r.fresh && r.fresh.length) {
    const S = fresh.data.SUP[k];
    fresh.data.ATTN = fresh.data.ATTN || [];
    fresh.data.ATTN.unshift({ id: 'fda' + Date.now().toString(36) + k, t: 'New FDA finding for ' + S.name.split(' (')[0], s: r.fresh.slice(0, 3).join('; ') + '. Confirm whether it is this supplier on the supplier page.', k: 'bad', to: 'supplier', sel: k, sup: k, at: new Date().toISOString().slice(0, 10) });
  }
  saveWs(wsId, fresh.data);
  if (r.fresh && r.fresh.length) notifyFindings(wsId, k, r.fresh);
  const L = copy.MON[k].live || {};
  console.log('FDA check', wsId, k, (L.ia ? 'alerts=' + L.ia.alerts + ' hits=' + L.ia.hits.length : 'alerts error: ' + L.iaError), (L.rec ? 'recalls=' + L.rec.hits.length : 'recalls error: ' + L.recError), (L.wl ? 'letters=' + L.wl.hits.length : 'letters error: ' + L.wlError), (L.dd ? 'refusals=' + L.dd.refusals.length + ' inspections=' + L.dd.inspections.length : (L.ddError ? 'dashboard error: ' + L.ddError : 'dashboard off')), r.fresh && r.fresh.length ? 'NEW=' + r.fresh.length : '');
  return r.msg;
}
// ---------------- backups ----------------
function makeBackup() {
  const tmp = path.join(DATA_DIR, 'backup-' + Date.now() + '.db');
  db.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
  const files = [{ name: 'fsvpvault.db', data: fs.readFileSync(tmp) }]; fs.unlinkSync(tmp);
  const walk = function (dir, pre) { if (!fs.existsSync(dir)) return; fs.readdirSync(dir).forEach(function (n) { const f = path.join(dir, n); if (fs.statSync(f).isDirectory()) walk(f, pre + n + '/'); else files.push({ name: pre + n, data: fs.readFileSync(f) }); }); };
  walk(path.join(DATA_DIR, 'uploads'), 'uploads/'); walk(path.join(DATA_DIR, 'seeds'), 'seeds/');
  files.push({ name: 'README.txt', data: 'FSVP Vault backup ' + new Date().toISOString() + '\r\nRestore: stop the service, put fsvpvault.db, uploads/ and seeds/ into the DATA_DIR folder, start it again.\r\n' });
  return { buf: zip.write(files), count: files.length };
}
// weekly: email the owner a copy of every workspace's data (records only; files stay on the disk and in Render's snapshots)
async function weeklyBackupMail() {
  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner' AND disabled = 0 ORDER BY id LIMIT 1").get(); if (!owner || !mail.configured(env)) return;
  const st = db.prepare("SELECT at FROM mail WHERE kind = 'backup' AND status = 'sent' ORDER BY id DESC LIMIT 1").get();
  if (st && Date.now() - Date.parse(st.at) < 6.5 * 86400e3) return;
  const data = {}; db.prepare('SELECT id, data FROM workspaces').all().forEach(function (w) { data[w.id] = JSON.parse(w.data); });
  const z = zip.write([{ name: 'workspaces-' + new Date().toISOString().slice(0, 10) + '.json', data: JSON.stringify(data) }]);
  const id = db.prepare('INSERT INTO mail (ws, at, kind, to_addr, subject, status, error) VALUES (?,?,?,?,?,?,?)').run('system', new Date().toISOString(), 'backup', owner.email, 'FSVP Vault weekly backup', 'sending', '').lastInsertRowid;
  const body = mail.layout('Weekly backup', ['Attached is a copy of every workspace’s records (suppliers, approvals, plans fields, shipments, history settings). Uploaded files aren’t included; download a full backup from Account in the portal.', 'Keep this email; it contains your customers’ supplier information.']);
  try { await mail.send(env, { to: [owner.email], subject: 'FSVP Vault weekly backup', text: body.text, html: body.html, attachments: [{ name: 'fsvpvault-records-' + new Date().toISOString().slice(0, 10) + '.zip', data: z, type: 'application/zip' }] }); db.prepare('UPDATE mail SET status = ? WHERE id = ?').run('sent', id); }
  catch (e) { db.prepare('UPDATE mail SET status = ?, error = ? WHERE id = ?').run('failed', String(e.message).slice(0, 300), id); }
}
if (process.env.AUTO_MAIL !== 'off') setInterval(function () { weeklyBackupMail().catch(function (e) { console.error('backup mail', e); }); }, 6 * 3600e3);

// ---------------- FDA records package ----------------
function csv(rows) { return rows.map(function (r) { return r.map(function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\r\n') + '\r\n'; }
function safe(n) { return String(n || 'file').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, ''); }
function hesc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function buildPackage(ws, body) {
  const D = ws.data, files = [], index = [], months = Math.max(1, Math.min(60, parseInt(body.months, 10) || 24));
  const since = new Date(Date.now() - months * 30.44 * 86400e3).toISOString().slice(0, 10);
  const sups = D.SUP.map(function (x, i) { return i; }).filter(function (i) { return body.sup === 'all' || body.sup === undefined || String(body.sup) === String(i); });
  const used = {}; const put = function (name, data, what) { let n = name, k = 1; while (used[n]) n = name.replace(/(\.[^.]+)?$/, '-' + (++k) + '$1'); used[n] = 1; files.push({ name: n, data: data }); index.push([n, what || '']); };
  const fileBuf = function (id) { const r = db.prepare('SELECT path, name FROM files WHERE id = ? AND ws = ?').get(id, ws.id); if (!r) return null; try { return { buf: fs.readFileSync(path.join(DATA_DIR, 'uploads', r.path)), name: r.name }; } catch (e) { return null; } };
  (body.plans || []).forEach(function (pl) { put('1-plans/' + safe(pl.name) + '.html', String(pl.html || ''), 'FSVP plan as generated today'); });
  (body.extra || []).forEach(function (x) { put('2-program/' + safe(x.name) + '.html', String(x.html || ''), x.what || ''); });
  // QI qualifications
  ((D.QIFILE || {}).items || []).forEach(function (it) { if (it[4]) { const f = fileBuf(it[4]); if (f) put('2-program/qualified-individual/' + safe(f.name), f.buf, 'QI: ' + it[0]); } });
  // approvals, documents, verification records per supplier
  const appr = [['Supplier', 'Status', 'Date', 'Basis', 'Conditions', 'Next reevaluation', 'History']];
  sups.forEach(function (i) {
    const S = D.SUP[i], A = (D.APPROVAL || {})[i] || {}, dir = '3-suppliers/' + safe(S.name) + '/';
    appr.push([S.name, A.st || '', A.date || '', A.basis || '', (A.cond || []).join('; '), A.reeval || '', (A.log || []).map(function (l) { return l[0] + ' ' + l[1]; }).join(' | ')]);
    [['slots', S.slots || {}], ['opt', S.opt || {}]].forEach(function (g) { Object.keys(g[1]).forEach(function (k) { (g[1][k].files || []).forEach(function (f) {
      if (!f[4] || f[3] === 'rejected' || f[3] === 'pending') return; const b = fileBuf(f[4]); if (!b) return;
      put(dir + 'documents/' + k + '/' + safe(b.name), b.buf, S.name + ': ' + f[0] + (f[1] ? ' (valid to ' + f[1] + ')' : '') + (f[3] === 'old' ? ' [superseded]' : '')); }); }); });
    const V = (D.VREC || []).filter(function (r) { return r.sup === i; });
    if (V.length) put(dir + 'verification-records.html', '<!doctype html><meta charset="utf-8"><title>Verification records</title><body style="font-family:sans-serif"><h1>Verification records: ' + hesc(S.name) + '</h1>' + V.map(function (r) { return '<h2>' + hesc(r.title) + '</h2><p>Type: ' + hesc(r.type) + ' · Source: ' + hesc(r.src) + '</p><table border="1" cellpadding="6" style="border-collapse:collapse">' + r.f.map(function (x) { return '<tr><th align="left">' + hesc(x[0]) + '</th><td>' + hesc(x[1]) + '</td></tr>'; }).join('') + '</table>'; }).join('') + '</body>', S.name + ': audits, testing and records reviews (21 CFR 1.506(e))');
    V.forEach(function (r) { (r.files || []).forEach(function (f) { const b = fileBuf(f[1]); if (b) put(dir + 'verification-files/' + safe(b.name), b.buf, S.name + ': ' + r.title); }); });
    const M = (D.MON || {})[i];
    if (M && M.res) put(dir + 'fda-compliance-check.csv', csv([['Check', 'Result', 'Summary', 'Checked']].concat(Object.keys(M.res).map(function (k) { return [k, M.res[k][2] || '', String(M.res[k][1] || '').replace(/<[^>]+>/g, ''), M.checked || '']; }))), S.name + ': FDA monitor results');
  });
  put('4-records/supplier-approvals.csv', csv(appr), 'Supplier evaluation and approval (21 CFR 1.505)');
  const capa = [['Supplier', 'Source', 'Finding', 'Opened', 'Status', 'Next step / root cause', 'Closure evidence']];
  (D.CAPA || []).forEach(function (x) { if (sups.indexOf(x[0]) < 0 || (x[3] && x[3] < since)) return; capa.push([(D.SUP[x[0]] || {}).name, x[1], x[2], x[3], x[4], x[5], x[6] || '']); });
  put('4-records/corrective-actions.csv', csv(capa), 'Complaints and corrective actions (21 CFR 1.508)');
  const ship = [['Date', 'Supplier', 'Product', 'Lot', 'Entry', 'Quantity', 'PO', 'COA', 'Process records']];
  (D.SHIP || []).forEach(function (x) {
    if (sups.indexOf(x.sup) < 0 || (x.date && x.date < since)) return; const F = x.files || {};
    ship.push([x.date, (D.SUP[x.sup] || {}).name, x.product, x.lot, x.entry, x.qty, x.po, (F.coa || []).map(function (f) { return f[0]; }).join('; '), (F.process || []).map(function (f) { return f[0]; }).join('; ')]);
    ['coa', 'process', 'other'].forEach(function (k) { (F[k] || []).forEach(function (f) { const b = fileBuf(f[1]); if (b) put('5-shipments/' + safe(x.date + ' ' + (x.lot || x.entry || x.id)) + '/' + k + '-' + safe(b.name), b.buf, 'Lot record: ' + (x.product || '') + ' ' + (x.lot || '')); }); });
  });
  put('4-records/shipments.csv', csv(ship), 'Shipments and lot records');
  const ev = db.prepare('SELECT at, user, type, target, detail FROM events WHERE ws = ? AND at >= ? ORDER BY id').all(ws.id, since);
  put('4-records/history.csv', csv([['When (UTC)', 'Who', 'Action', 'Target', 'Details']].concat(ev.map(function (e) { return [e.at, e.user, e.type, e.target, e.detail]; }))), 'Every change made in FSVP Vault');
  const supNames = sups.map(function (i) { return D.SUP[i].name; });
  const idx = '<!doctype html><meta charset="utf-8"><title>FSVP records</title><body style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:900px;margin:24px auto;padding:0 16px">' +
    '<h1>FSVP records: ' + hesc(D.company.name) + '</h1><p>Prepared ' + new Date().toISOString().slice(0, 10) + ' under 21 CFR 1.510(b). Records cover ' + hesc(supNames.join(', ')) + '; shipments, corrective actions and history from ' + since + '. English translations of foreign-language records can be provided on request.</p>' +
    '<p>Importer: ' + hesc(D.IMPORTER || D.company.name) + '<br>Qualified individual: ' + hesc(D.QI || D.company.qiName || '') + '</p>' +
    '<table border="1" cellpadding="6" style="border-collapse:collapse;width:100%"><tr><th align="left">File</th><th align="left">What it is</th></tr>' + index.map(function (r) { return '<tr><td>' + hesc(r[0]) + '</td><td>' + hesc(r[1]) + '</td></tr>'; }).join('') + '</table></body>';
  files.unshift({ name: '0-INDEX.html', data: idx });
  return { buf: zip.write(files), count: files.length, name: 'FSVP-records-' + safe(D.company.short || D.company.name).replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0, 10) };
}

// ---------------- email ----------------
const PUBLIC_URL = (env('PUBLIC_URL') || 'https://fsvpvault.com').replace(/\/$/, '');
function emailsOf(v) { return String(v || '').split(/[\s,;]+/).filter(mail.validEmail); }
function importerReplyTo(D) { const r = (D.IMPID || []).find(function (x) { return /email/i.test(x[0]); }); return r && mail.validEmail(r[1]) ? r[1] : (env('MAIL_REPLY_TO') || ''); }
// Records every email in the mail table; sends in the background. Returns a short status for the toast.
function sendMail(wsId, kind, to, subject, title, paras, button, replyTo) {
  to = emailsOf(Array.isArray(to) ? to.join(',') : to);
  if (!to.length) return { sent: false, why: 'no_address' };
  const at = new Date().toISOString();
  if (!mail.configured(env)) { db.prepare('INSERT INTO mail (ws, at, kind, to_addr, subject, status, error) VALUES (?,?,?,?,?,?,?)').run(wsId, at, kind, to.join(', '), subject, 'not sent', 'Email isn’t set up yet'); return { sent: false, why: 'not_setup' }; }
  const id = db.prepare('INSERT INTO mail (ws, at, kind, to_addr, subject, status, error) VALUES (?,?,?,?,?,?,?)').run(wsId, at, kind, to.join(', '), subject, 'sending', '').lastInsertRowid;
  const body = mail.layout(title, paras, button);
  mail.send(env, { to: to, subject: subject, text: body.text, html: body.html, replyTo: replyTo || undefined })
    .then(function () { db.prepare('UPDATE mail SET status = ? WHERE id = ?').run('sent', id); },
          function (e) { console.error('mail', kind, e.message); db.prepare('UPDATE mail SET status = ?, error = ? WHERE id = ?').run('failed', String(e.message).slice(0, 300), id); });
  return { sent: true, to: to };
}
function mailNote(r, what) {
  if (r.sent) return what + ' emailed to ' + r.to.join(', ');
  if (r.why === 'no_address') return what + ' saved. Add the supplier’s email address (supplier page → Contact) to send it.';
  return what + ' saved. Email isn’t set up yet, so it wasn’t sent.';
}
function supplierRequestMail(ws, i, docs, kind) {
  const D = ws.data, S = D.SUP[i], CO = D.company.name, code = (D.UPCODE || [])[i];
  return sendMail(ws.id, kind, S.contacts, (kind === 'reminder' ? 'Reminder: ' : '') + 'Documents requested by ' + CO,
    'Documents requested by ' + CO,
    ['Hello ' + S.name.split(' (')[0] + ',', CO + ' needs the following food safety documents for its U.S. FDA Foreign Supplier Verification Program (FSVP) records:', docs,
     'Use the button below to send them; your upload code is ' + code + '. No account is needed.', 'Questions? Reply to this email.'],
    ['Send documents', PUBLIC_URL + '/upload?code=' + encodeURIComponent(code)], importerReplyTo(D));
}
function notifyFindings(wsId, k, fresh) {
  const ws = getWs(wsId), A = ws.data.alerts || {};
  if (!A.email || (A.freq && A.freq !== 'Immediately')) return;
  const S = ws.data.SUP[k];
  sendMail(wsId, 'fda_alert', A.email, 'New FDA finding: ' + S.name.split(' (')[0], 'New FDA finding for ' + S.name,
    ['The weekly FDA check found something new for this supplier:', fresh, 'Open the supplier page to confirm whether it is the same facility, and to record any action.'],
    ['Open FSVP Vault', PUBLIC_URL + '/app?ws=' + encodeURIComponent(wsId)]);
}
// Once a day: reminders to suppliers with open requests or documents expiring soon, and FDA alert digests
async function dailyMail() {
  const today = new Date().toISOString().slice(0, 10);
  for (const w of db.prepare('SELECT id FROM workspaces').all()) {
    const ws = getWs(w.id), D = ws.data; D.mailState = D.mailState || {};
    if (D.mailState.day === today) continue;
    const R = D.reqSettings || { before: 60, every: 7 }, auto = D.reqSettings && D.reqSettings.auto !== false;
    if (auto) D.SUP.forEach(function (S, i) {
      if ((D.removed || {})[i] || !emailsOf(S.contacts).length) return;
      const last = (D.mailState.sup || {})[i];
      if (last && (Date.parse(today) - Date.parse(last)) / 86400e3 < R.every) return;
      const docs = (S.req || []).map(function (q) { return q[0] + (q[1] ? ' (due ' + q[1] + ')' : ''); });
      [S.slots || {}].forEach(function (g) { Object.keys(g).forEach(function (k) { (g[k].files || []).forEach(function (f) { if (f[1] && !f[3] && (Date.parse(f[1]) - Date.now()) / 86400e3 < R.before && Date.parse(f[1]) > Date.now() - 30 * 86400e3) docs.push('Renewal of ' + f[0] + ' (expires ' + f[1] + ')'); }); }); });
      if (!docs.length) return;
      const r = supplierRequestMail(ws, i, docs.slice(0, 15), 'reminder');
      if (r.sent) { D.mailState.sup = D.mailState.sup || {}; D.mailState.sup[i] = today; logEvent(ws.id, 'system', 'auto_reminder', 'sup' + i, { docs: docs.length }); }
    });
    const A = D.alerts || {};
    if (A.email && (A.freq === 'Daily' || (A.freq === 'Weekly' && new Date().getUTCDay() === 1) || !A.freq)) {
      const since = D.mailState.digest || '0';
      const items = (D.ATTN || []).filter(function (a) { return a.at && a.at > since && /^fda/.test(a.id || ''); });
      if (items.length) sendMail(ws.id, 'fda_digest', A.email, 'FDA monitor: ' + items.length + ' new finding(s)', 'New FDA findings', [items.map(function (a) { return a.t + ': ' + a.s; })], ['Open FSVP Vault', PUBLIC_URL + '/app?ws=' + encodeURIComponent(ws.id)]);
      D.mailState.digest = today;
    }
    D.mailState.day = today;
    const fresh = getWs(ws.id); fresh.data.mailState = D.mailState; saveWs(ws.id, fresh.data);
  }
}
if (process.env.AUTO_MAIL !== 'off') { setTimeout(function () { dailyMail().catch(function (e) { console.error('daily mail', e); }); }, 90e3); setInterval(function () { dailyMail().catch(function (e) { console.error('daily mail', e); }); }, 3 * 3600e3); }
// ---- weekly automatic FDA checks (runs every 6 hours, re-checks suppliers last checked over 7 days ago) ----
async function autoCheck() {
  for (const w of db.prepare('SELECT id FROM workspaces').all()) {
    const ws = getWs(w.id); if (!ws) continue;
    let changed = false;
    for (let k = 0; k < ws.data.SUP.length; k++) {
      if ((ws.data.removed || {})[k]) continue;
      const M = (ws.data.MON || {})[k]; const last = M && M.live && Date.parse(M.live.at);
      if (last && Date.now() - last < 7 * 86400e3) continue;
      try { await checkAndMerge(ws.id, k); changed = true; } catch (e) { console.error('auto check', w.id, k, e.message); }
    }
    if (changed) logEvent(ws.id, 'system', 'monitor_auto', 'monitor', {});
  }
}
if (env('FDA_DD_USER') && env('FDA_DD_KEY')) fda.ddTest({ user: env('FDA_DD_USER'), key: env('FDA_DD_KEY') }).then(function (m) { console.log('FDA Data Dashboard connection:', m); }, function (e) { console.error('FDA Data Dashboard connection failed:', e.message); });
else console.log('FDA Data Dashboard: FDA_DD_USER / FDA_DD_KEY not set');
if (process.env.AUTO_CHECK !== 'off') { setTimeout(function () { autoCheck().catch(function (e) { console.error(e); }); }, 60e3); setInterval(function () { autoCheck().catch(function (e) { console.error(e); }); }, 6 * 3600e3); }

// ---- helpers ----
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  }, headers || {}));
  res.end(body);
}
function json(res, code, obj) { send(res, code, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); }
function redirect(res, to, headers) { send(res, 302, '', Object.assign({ Location: to }, headers || {})); }
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(function (p) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isHttps(req) { return (req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https'; }
function cookie(req, name, value, maxAge) {
  return name + '=' + encodeURIComponent(value) + '; Path=/; HttpOnly; SameSite=Lax' + (isHttps(req) ? '; Secure' : '') + (maxAge !== undefined ? '; Max-Age=' + maxAge : '');
}
function sign(v) { return crypto.createHmac('sha256', SECRET).update(v).digest('base64url'); }
function makeSession(u, extra) { const v = Buffer.from(JSON.stringify(Object.assign({ u: u.id, v: u.sess_v, t: Date.now() }, extra || {}))).toString('base64url'); return v + '.' + sign(v); }
function readSession(req) {
  const c = parseCookies(req).fv_session; if (!c) return null;
  const i = c.lastIndexOf('.'); if (i < 0) return null;
  const v = c.slice(0, i), s = c.slice(i + 1);
  const a = Buffer.from(sign(v)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(v, 'base64url').toString()); if (Date.now() - o.t > 7 * 864e5) return null; return o; } catch (e) { return null; }
}
// the signed-in user (or null): the cookie must match the user's current session version
function currentUser(req) {
  const o = readSession(req); if (!o || !o.u || o.pending) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(o.u);
  return u && !u.disabled && u.sess_v === o.v ? u : null;
}
function pendingUser(req) { // passed the password, still needs the 2-step code
  const c = parseCookies(req).fv_2fa; if (!c) return null; const i = c.lastIndexOf('.'); if (i < 0) return null;
  const v = c.slice(0, i), sg = c.slice(i + 1), a = Buffer.from(sign(v)), b = Buffer.from(sg); if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(v, 'base64url').toString()); if (Date.now() - o.t > 10 * 60e3) return null; const u = db.prepare('SELECT * FROM users WHERE id = ?').get(o.u); return u && !u.disabled && u.sess_v === o.v ? u : null; } catch (e) { return null; }
}
function authPage(title, body) { return page('public/auth.html').replace(/\{\{TITLE\}\}/g, title).replace('{{BODY}}', function () { return body; }); }
function hx(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ipOf(req) { return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function limited(key, max, mins) { const t = loginTries.get(key) || { n: 0, at: Date.now() }; if (Date.now() - t.at > mins * 60e3) { t.n = 0; t.at = Date.now(); } t.n++; loginTries.set(key, t); return t.n > max; }
function myWsList(u) { return wsList().filter(function (w) { return auth.canWs(u, w.id); }); }
function safeEq(a, b) { const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest(); return crypto.timingSafeEqual(x, y); }
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    const chunks = []; let n = 0;
    req.on('data', function (c) { n += c.length; if (n > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
function getWs(id) {
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  return row ? { id: row.id, name: row.name, data: JSON.parse(row.data) } : null;
}
function wsList() { return db.prepare('SELECT id, name FROM workspaces ORDER BY sort, name').all().map(function (r) { return { id: r.id, name: r.name }; }); }
function saveWs(id, data) { db.prepare('UPDATE workspaces SET data = ?, name = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), data.company.name, new Date().toISOString(), id); }
function logEvent(ws, user, type, target, detail) {
  db.prepare('INSERT INTO events (ws, at, user, type, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(ws, new Date().toISOString(), user, type, target || '', JSON.stringify(detail || {}));
}
function currentWs(req, url) {
  const list = wsList(); const want = url.searchParams.get('ws') || parseCookies(req).fv_ws;
  return list.find(function (w) { return w.id === want; }) ? want : (list[0] && list[0].id);
}
function page(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
const loginTries = new Map();

// ---- server ----
const server = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const sess = currentUser(req);
  try {
    if (p === '/' && req.method === 'GET') return send(res, 200, page('public/index.html'));
    if (p === '/health') return json(res, 200, { ok: true });
    if (p.indexOf('/assets/') === 0 && req.method === 'GET') {
      const f = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
      if (f.indexOf(path.join(ROOT, 'public')) !== 0 || !fs.existsSync(f)) return send(res, 404, 'Not found');
      const ext = path.extname(f); const types = { '.svg': 'image/svg+xml', '.png': 'image/png', '.css': 'text/css', '.ico': 'image/x-icon' };
      return send(res, 200, fs.readFileSync(f), { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    }
    // ---- public supplier upload page (no login; the upload code identifies the supplier) ----
    if (p === '/upload' && req.method === 'GET') return send(res, 200, page('public/upload.html'));
    if (p === '/upload/lookup' && req.method === 'POST') {
      if (codeLimited(req)) return json(res, 429, { error: 'too_many' });
      const body = JSON.parse(await readBody(req, 2000));
      const hit = findCode(body.code); if (!hit) return json(res, 404, { error: 'bad_code' });
      const s = hit.ws.data.SUP[hit.i];
      const asked = (s.req || []).map(function (q) { return q[0]; }).slice(0, 15);
      const feedback = [];
      [s.slots || {}, s.opt || {}].forEach(function (g) { Object.keys(g).forEach(function (k) { (g[k].files || []).forEach(function (f) { const m = f[5]; if (m && m.from !== undefined && m.at && Date.now() - Date.parse(m.at) < 120 * 86400e3) feedback.push({ title: f[0], at: m.at, status: m.review || 'pending', reason: m.review === 'rejected' ? (m.reason || '') : '' }); }); }); });
      feedback.sort(function (a, b) { return b.at.localeCompare(a.at); });
      return json(res, 200, { ok: true, supplier: s.name, customer: hit.ws.data.company.name, docs: SUPPLIER_DOCS.concat([['other', 'Other document']]), requested: asked, feedback: feedback.slice(0, 20) });
    }
    if (p === '/upload/send' && req.method === 'POST') {
      if (codeLimited(req)) return json(res, 429, { error: 'too_many' });
      const body = JSON.parse(await readBody(req, Math.ceil(MAX_UPLOAD * 1.4) + 10000));
      const hit = findCode(body.code); if (!hit) return json(res, 404, { error: 'bad_code' });
      const name = String(body.name || 'file').slice(0, 200);
      if (!SUPPLIER_EXT.test(name)) return json(res, 400, { error: 'bad_type' });
      const buf = Buffer.from(String(body.b64 || ''), 'base64');
      if (!buf.length) return json(res, 400, { error: 'empty_file' });
      if (buf.length > MAX_UPLOAD) return json(res, 400, { error: 'too_large' });
      const slot = /^[a-z]+$/.test(body.slot || '') ? body.slot : 'other';
      const expiry = /^\d{4}-\d{2}-\d{2}$/.test(body.expiry || '') ? body.expiry : null;
      const title = String(body.title || name).replace(/[<>]/g, '').slice(0, 160);
      const from = String(body.from || '').replace(/[<>]/g, '').slice(0, 160);
      const id = crypto.randomBytes(12).toString('hex');
      const ws = getWs(hit.ws.id); // fresh copy
      const dir = path.join(DATA_DIR, 'uploads', ws.id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id), buf);
      const target = (OPT_DOCS.indexOf(slot) >= 0 ? 'opt:' : 'slot:') + hit.i + ':' + slot;
      db.prepare('INSERT INTO files (id, ws, owner, name, mime, size, path, expiry, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, ws.id, target, name, String(body.mime || 'application/octet-stream').slice(0, 100), buf.length, path.join(ws.id, id), expiry, new Date().toISOString(), 'supplier: ' + from);
      const meta = { from: from, note: String(body.note || '').replace(/[<>]/g, '').slice(0, 300), at: new Date().toISOString().slice(0, 10), review: 'pending', doc: slot };
      let expiry2 = expiry;
      try { meta.read = certread.read(buf, name, body.mime, hit.ws.data.SUP[hit.i], expiry); if (!expiry2 && !body.noExpiry && meta.read.expiry && !meta.read.guessed) expiry2 = meta.read.expiry; } catch (e) { console.error('certread', e.message); }
      const out = actions.run(ws.data, 'file_add', { target: target, label: title, fileId: id, expiry: expiry2, pending: true, meta: meta }, { user: 'supplier', now: new Date() });
      if (out.error) return json(res, 400, { error: out.error });
      const S = ws.data.SUP[hit.i];
      ws.data.ATTN = ws.data.ATTN || [];
      ws.data.ATTN.unshift({ id: 'up' + id.slice(0, 8), fid: id, at: meta.at, t: 'Review document from ' + S.name.split(' (')[0] + ': ' + title, s: 'Sent ' + new Date().toISOString().slice(0, 10) + (from ? ' by ' + from : '') + (body.note ? '. Note: ' + String(body.note).replace(/[<>]/g, '').slice(0, 300) : '') + '. Accept or reject it on the supplier page.', k: 'warn', to: 'supplier', sel: hit.i, sup: hit.i });
      saveWs(ws.id, ws.data);
      logEvent(ws.id, 'supplier:' + from, 'supplier_upload', target, { name: name, size: buf.length, expiry: expiry, note: String(body.note || '').slice(0, 300) });
      return json(res, 200, { ok: true, title: title });
    }
    if (p === '/login' && req.method === 'GET') {
      if (sess) return redirect(res, '/app');
      return send(res, 200, page('public/login.html').replace('{{ERROR}}', url.searchParams.get('e') ? '<p class="err">That email and password don’t match.</p>' : ''));
    }
    if (p === '/login' && req.method === 'POST') {
      const ip = ipOf(req);
      const f = new URLSearchParams(await readBody(req, 10000));
      const email = (f.get('email') || '').trim().toLowerCase();
      if (limited('ip:' + ip, 20, 15) || limited('em:' + email, 8, 15)) return send(res, 429, authPage('Too many attempts', '<p>Too many sign-in attempts. Wait 15 minutes and try again.</p>'));
      const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      const ok = auth.verify(f.get('password') || '', u && !u.disabled ? u.pass : null);
      if (!ok) return redirect(res, '/login?e=1');
      loginTries.delete('em:' + email);
      if (u.totp_on) {
        const v = Buffer.from(JSON.stringify({ u: u.id, v: u.sess_v, t: Date.now() })).toString('base64url');
        return redirect(res, '/login/code', { 'Set-Cookie': cookie(req, 'fv_2fa', v + '.' + sign(v), 600) });
      }
      db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
      return redirect(res, '/app', { 'Set-Cookie': cookie(req, 'fv_session', makeSession(u), 7 * 86400) });
    }
    if (p === '/login/code') {
      const u = pendingUser(req); if (!u) return redirect(res, '/login');
      let err = '';
      if (req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req, 2000));
        if (limited('2fa:' + u.id, 8, 15)) err = 'Too many tries. Wait 15 minutes.';
        else if (auth.totpCheck(u.totp, f.get('code'))) {
          loginTries.delete('2fa:' + u.id); db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(new Date().toISOString(), u.id);
          res.setHeader('Set-Cookie', [cookie(req, 'fv_2fa', '', 0), cookie(req, 'fv_session', makeSession(u), 7 * 86400)]);
          return redirect(res, '/app');
        } else err = 'That code didn’t work. Use the current 6-digit code from your authenticator app.';
      }
      return send(res, 200, authPage('Enter your code', (err ? '<p class="err">' + err + '</p>' : '') + '<p>Open your authenticator app and enter the 6-digit code for FSVP Vault.</p><form method="post"><label for="code">Code<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" required autofocus></label><button type="submit">Continue</button></form><p class="small"><a href="/login">Back to sign in</a></p>'));
    }
    if (p === '/forgot') {
      if (req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req, 2000)); const email = (f.get('email') || '').trim().toLowerCase();
        if (!limited('fg:' + ipOf(req), 5, 30)) {
          const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
          if (u && !u.disabled) { const t = auth.makeToken(db, u.id, 1); sendMail('system', 'reset', u.email, 'Reset your FSVP Vault password', 'Reset your password', ['Someone asked to reset the password for ' + u.email + '. If it was you, use the button below within one hour.', 'If it wasn’t you, ignore this email; your password stays the same.'], ['Choose a new password', PUBLIC_URL + '/reset?t=' + t]); }
        }
        return send(res, 200, authPage('Check your email', '<p class="ok">If an account exists for that address, we’ve sent a link to reset the password. It works for one hour.</p>' + (mail.configured(env) ? '' : '<p class="small">Email isn’t set up on this server yet, so ask the account owner to reset it in Render.</p>') + '<p class="small"><a href="/login">Back to sign in</a></p>'));
      }
      return send(res, 200, authPage('Reset your password', '<form method="post"><label for="email">Email<input id="email" name="email" type="email" autocomplete="username" required></label><button type="submit">Send reset link</button></form><p class="small"><a href="/login">Back to sign in</a></p>'));
    }
    if (p === '/reset') {
      const t = url.searchParams.get('t') || ''; const u = auth.useToken(db, t);
      if (!u) return send(res, 400, authPage('Link expired', '<p>This link has expired or was already used. <a href="/forgot">Ask for a new one</a>.</p>'));
      let err = '';
      if (req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req, 4000)); const pw = f.get('password') || '';
        err = auth.passwordProblem(pw, u.email) || (pw !== f.get('password2') ? 'The two passwords don’t match.' : '');
        if (!err) {
          db.prepare('UPDATE users SET pass = ?, token = NULL, token_exp = NULL, sess_v = sess_v + 1, env_fp = CASE WHEN role = \'owner\' THEN env_fp ELSE NULL END WHERE id = ?').run(auth.hash(pw), u.id);
          logEvent('system', u.email, 'password_set', 'user' + u.id, {});
          return send(res, 200, authPage('Password saved', '<p class="ok">Your password is set.</p><p><a href="/login">Sign in</a></p>'));
        }
      }
      return send(res, 200, authPage(u.pass ? 'Choose a new password' : 'Set up your account', (err ? '<p class="err">' + err + '</p>' : '') + '<p>Account: ' + hx(u.email) + '</p><form method="post" action="/reset?t=' + encodeURIComponent(t) + '"><label for="pw">New password (12+ characters)<input id="pw" name="password" type="password" autocomplete="new-password" minlength="12" required></label><label for="pw2">Repeat it<input id="pw2" name="password2" type="password" autocomplete="new-password" minlength="12" required></label><button type="submit">Save password</button></form>'));
    }
    if ((p === '/privacy' || p === '/terms') && req.method === 'GET') return send(res, 200, page('public' + p + '.html'));
    if (p === '/logout') return redirect(res, '/', { 'Set-Cookie': cookie(req, 'fv_session', '', 0) });
    const U = sess;

    // everything below needs a login
    if (!sess) return p.indexOf('/api/') === 0 ? json(res, 401, { error: 'login_required' }) : redirect(res, '/login');
    if (req.method === 'POST' && p.indexOf('/api/') === 0 && U.role === 'viewer' && p.indexOf('/api/account') !== 0) return json(res, 403, { error: 'Your account is view only.' });
    if (req.method === 'POST' && p.indexOf('/api/') === 0 && String(req.headers['content-type'] || '').indexOf('application/json') !== 0) return json(res, 415, { error: 'json_only' });

    if (p === '/app' && req.method === 'GET') {
      const mine = myWsList(U); if (!mine.length) return send(res, 403, authPage('No workspace', '<p>Your account doesn’t have access to any workspace yet. Ask the account owner.</p><p><a href="/logout">Sign out</a></p>'));
      const want = url.searchParams.get('ws') || parseCookies(req).fv_ws; const id = mine.some(function (w) { return w.id === want; }) ? want : mine[0].id; const ws = getWs(id);
      const boot = '<script>window.__DATA=' + JSON.stringify(ws.data).replace(/</g, '\\u003c') + ';window.__WS=' + JSON.stringify(id) + ';window.__WSLIST=' + JSON.stringify(mine).replace(/</g, '\\u003c') + ';window.__USER=' + JSON.stringify({ email: U.email, name: (U.name || U.email), role: U.role, totp: !!U.totp_on }).replace(/</g, '\\u003c') + ';</script>';
      const html = page('app/portal.html').replace('<!--BOOT-->', function () { return boot; });
      return send(res, 200, html, { 'Set-Cookie': cookie(req, 'fv_ws', id, 30 * 86400), 'Cache-Control': 'no-store' });
    }
    if (p === '/api/action' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 200000));
      const ws = auth.canWs(U, body.ws) ? getWs(body.ws) : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      const ctx = { user: (U.name || U.email), email: U.email, now: new Date() };
      const deny = auth.canAct(U, body.type); if (deny) return json(res, 403, { error: deny });
      let out;
      if (body.type === 'monitor_run' || body.type === 'monitor_all') {
        // live FDA checks: import alert pages and openFDA recalls
        const list = body.type === 'monitor_all' ? ws.data.SUP.map(function (x, k) { return k; }).filter(function (k) { return !(ws.data.removed || {})[k]; }) : [parseInt((body.p || {}).sup, 10)];
        if (list.some(function (k) { return !ws.data.SUP[k]; })) return json(res, 400, { error: 'bad_supplier' });
        const msgs = [];
        for (const k of list) msgs.push(await checkAndMerge(ws.id, k));
        Object.assign(ws, getWs(ws.id));
        out = { target: 'monitor', msg: list.length === 1 ? msgs[0] : 'Checked ' + list.length + ' suppliers against FDA import alerts and recalls' };
      } else {
        if (body.type === 'plan_sign' && body.p && body.p.html) {
          const id = crypto.randomBytes(12).toString('hex'), dir = path.join(DATA_DIR, 'uploads', ws.id), html = Buffer.from(String(body.p.html).slice(0, 3000000), 'utf8');
          fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id), html);
          const S = ws.data.SUP[+body.p.sup] || {};
          db.prepare('INSERT INTO files (id, ws, owner, name, mime, size, path, expiry, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ws.id, 'plan:' + body.p.sup, 'FSVP plan - ' + String(S.name || '').replace(/[^\w .,-]/g, '') + ' - signed ' + new Date().toISOString().slice(0, 10) + '.html', 'text/html', html.length, path.join(ws.id, id), null, new Date().toISOString(), U.email);
          body.p.fileId = id; delete body.p.html;
        }
        out = actions.run(ws.data, body.type, body.p || {}, ctx);
      }
      if (out.error) return json(res, 400, { error: out.error });
      const P = body.p || {};
      if (body.type === 'request') out.msg = mailNote(supplierRequestMail(ws, +P.sup, [String(P.doc || 'Documents')], 'request'), 'Request');
      if (body.type === 'remind_all') { const S = ws.data.SUP[+P.sup]; out.msg = (S.req || []).length ? mailNote(supplierRequestMail(ws, +P.sup, S.req.map(function (q) { return q[0] + (q[1] ? ' (due ' + q[1] + ')' : ''); }), 'reminder'), 'Reminder') : 'No open requests for this supplier'; }
      if (body.type === 'file_review' && !P.ok && out.sup >= 0) { const S = ws.data.SUP[out.sup]; const r = sendMail(ws.id, 'rejected', S.contacts, 'Document not accepted by ' + ws.data.company.name, 'A document you sent was not accepted', ['Hello ' + S.name.split(' (')[0] + ',', ws.data.company.name + ' reviewed a document you sent and could not accept it.', 'Reason: ' + String(P.reason || 'Not given'), 'Please send a corrected file using the button below.'], ['Send a corrected file', PUBLIC_URL + '/upload?code=' + encodeURIComponent(ws.data.UPCODE[out.sup])], importerReplyTo(ws.data)); out.msg += r.sent ? ' Emailed to ' + r.to.join(', ') + '.' : ''; }
      if (body.type === 'support') { const r = sendMail(ws.id, 'support', env('SUPPORT_TO') || 'hello@fsvpvault.com', 'Support message from ' + ws.data.company.name, 'Support message', [String(P.msg || ''), 'From: ' + (U.name || U.email) + ' (' + U.email + '), workspace ' + ws.id], null, U.email); out.msg = r.sent ? 'Message sent to support. We\u2019ll reply by email.' : 'Message saved. Email isn\u2019t set up yet, so it wasn\u2019t sent.'; }
      saveWs(ws.id, ws.data);
      logEvent(ws.id, U.email, body.type, out.target, body.p);
      return json(res, 200, { ok: true, data: ws.data, msg: out.msg || '' });
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, Math.ceil(MAX_UPLOAD * 1.4) + 10000));
      const ws = auth.canWs(U, body.ws) ? getWs(body.ws) : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      const buf = Buffer.from(String(body.b64 || ''), 'base64');
      if (!buf.length) return json(res, 400, { error: 'empty_file' });
      if (buf.length > MAX_UPLOAD) return json(res, 400, { error: 'too_large' });
      const id = crypto.randomBytes(12).toString('hex');
      const dir = path.join(DATA_DIR, 'uploads', ws.id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id), buf);
      const name = String(body.name || 'file').slice(0, 200);
      db.prepare('INSERT INTO files (id, ws, owner, name, mime, size, path, expiry, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, ws.id, String(body.target || ''), name, String(body.mime || 'application/octet-stream').slice(0, 100), buf.length, path.join(ws.id, id), body.expiry || null, new Date().toISOString(), U.email);
      // read the certificate: dates, standard, certification body, name and address checks
      const tm = String(body.target || '').match(/^(slot|opt):(\d+):/);
      let read = null; try { read = certread.read(buf, name, body.mime, tm ? ws.data.SUP[+tm[2]] : null, body.expiry || null); } catch (e) { console.error('certread', e.message); }
      let expiry = /^\d{4}-\d{2}-\d{2}$/.test(body.expiry || '') ? body.expiry : null;
      if (!expiry && !body.noExpiry && read && read.expiry && !read.guessed) expiry = read.expiry;
      if (!expiry && !body.noExpiry && read && !read.none && !read.expiry) { read.warn = (read.warn || []).concat(['No expiry date found in the file. Add it if the document expires.']); }
      const out = actions.run(ws.data, 'file_add', { target: body.target, sup: body.sup, slot: body.slot, label: body.label || name, fileId: id, expiry: expiry, meta: read ? { read: read } : undefined }, { user: (U.name || U.email), now: new Date() });
      if (out.error) return json(res, 400, { error: out.error });
      if (expiry !== (body.expiry || null)) db.prepare('UPDATE files SET expiry = ? WHERE id = ?').run(expiry, id);
      saveWs(ws.id, ws.data);
      logEvent(ws.id, U.email, 'upload', body.target, { name: name, size: buf.length, expiry: expiry, read: read && { standard: read.standard, body: read.body, expiry: read.expiry } });
      const said = read && read.expiry && !body.expiry && !read.guessed ? '. Expiry read from the file: ' + read.expiry : (read && read.warn && read.warn.length ? '. Check the notes under the file' : '');
      return json(res, 200, { ok: true, data: ws.data, msg: 'Saved ' + name + said });
    }
    const fm = p.match(/^\/api\/file\/([a-f0-9]{24})$/);
    if (fm && req.method === 'GET') {
      const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fm[1]); if (!f || !auth.canWs(U, f.ws)) return send(res, 404, 'Not found');
      const inl = INLINE_OK.test(f.mime) || (f.mime === 'text/html' && /^plan:/.test(f.owner || ''));
      return send(res, 200, fs.readFileSync(path.join(DATA_DIR, 'uploads', f.path)), { 'Content-Type': inl ? f.mime + (f.mime === 'text/html' ? '; charset=utf-8' : '') : 'application/octet-stream', 'Content-Disposition': (inl ? 'inline' : 'attachment') + '; filename="' + f.name.replace(/[^\w .()-]/g, '_') + '"', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    }
    // ---- FDA records package: one ZIP with an index, the plans, the records and every file ----
    if (p === '/api/package' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 20 * 1024 * 1024));
      const ws = auth.canWs(U, body.ws) ? getWs(body.ws) : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      const out = buildPackage(ws, body);
      const id = crypto.randomBytes(12).toString('hex'); const dir = path.join(DATA_DIR, 'packages'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ws.id + '__' + id + '.zip'), out.buf);
      setTimeout(function () { try { fs.unlinkSync(path.join(dir, ws.id + '__' + id + '.zip')); } catch (e) { /* gone */ } }, 3600e3);
      logEvent(ws.id, U.email, 'package', 'records', { files: out.count, sup: body.sup, months: body.months });
      return json(res, 200, { ok: true, url: '/api/package/' + id, files: out.count, size: out.buf.length, name: out.name });
    }
    const pm = p.match(/^\/api\/package\/([a-f0-9]{24})$/);
    if (pm && req.method === 'GET') {
      const pf = (fs.existsSync(path.join(DATA_DIR, 'packages')) ? fs.readdirSync(path.join(DATA_DIR, 'packages')) : []).find(function (n) { return n.endsWith('__' + pm[1] + '.zip'); });
      if (!pf || !auth.canWs(U, pf.split('__')[0])) return send(res, 404, 'This package link has expired. Generate it again.');
      const f = path.join(DATA_DIR, 'packages', pf);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + (url.searchParams.get('n') || 'FSVP-records').replace(/[^\w.-]/g, '_') + '.zip"', 'Cache-Control': 'private, no-store' });
      return fs.createReadStream(f).pipe(res);
    }
    if (p === '/api/export/expiry' && req.method === 'GET') {
      const ws = auth.canWs(U, url.searchParams.get('ws') || '') ? getWs(url.searchParams.get('ws') || '') : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      const rows = [['Supplier', 'Document', 'Expires', 'Days left', 'Status', 'Supplier contact']];
      ws.data.SUP.forEach(function (S, i) { if ((ws.data.removed || {})[i]) return; [S.slots || {}, S.opt || {}].forEach(function (g) { Object.keys(g).forEach(function (k) { (g[k].files || []).forEach(function (f) {
        if (!f[1] || f[3]) return; const d = Math.round((Date.parse(f[1]) - Date.now()) / 86400e3);
        rows.push([S.name, f[0], f[1], d, d < 0 ? 'Expired' : (d <= 90 ? 'Expiring within 90 days' : 'Current'), S.contacts || '']); }); }); }); });
      rows.splice(1, rows.length, ...rows.slice(1).sort(function (a, b) { return String(a[2]).localeCompare(String(b[2])); }));
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="document-expiry-' + new Date().toISOString().slice(0, 10) + '.csv"', 'Cache-Control': 'private, no-store' });
      return res.end('\ufeff' + csv(rows));
    }
    if (p === '/api/import-docs' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 56 * 1024 * 1024));
      const ws = auth.canWs(U, body.ws) ? getWs(body.ws) : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      let entries; try { entries = zip.read(Buffer.from(String(body.b64 || ''), 'base64'), { maxFiles: 500, maxTotal: 250 * 1024 * 1024 }); } catch (e) { return json(res, 400, { error: e.message }); }
      const TYPE = [[/fce|\bsid\b|scheduled process|2541|process filing/i, 'lacf'], [/retort|uht|process record|batch record|fill(ing)? log|ph log/i, 'process'], [/\bcoa\b|certificate of analysis|analysis report|test report|lab report/i, 'coa'],
        [/fda.?reg|food facility registration|\bffr\b/i, 'fdareg'], [/haccp|food safety plan|fsp\b|hazard analysis/i, 'haccp'], [/audit|report/i, 'audit'], [/fssc|brc|sqf|\bifs\b|iso.?22000|certificate|cert\b/i, 'gfsi'],
        [/questionnaire/i, 'quest'], [/label|allergen/i, 'label'], [/halal/i, 'halal'], [/kosher/i, 'kosher'], [/organic/i, 'organic'], [/gmo/i, 'nongmo']];
      const OPT = ['halal', 'kosher', 'organic', 'nongmo'], OKEXT = /\.(pdf|png|jpe?g|gif|webp|heic|docx?|xlsx?|csv|txt)$/i;
      const placed = [], skipped = [];
      const fresh = getWs(ws.id);
      entries.forEach(function (e) {
        const parts = e.name.split('/'), base = parts[parts.length - 1];
        if (!OKEXT.test(base)) { skipped.push([e.name, 'file type not accepted']); return; }
        let i = -1; for (let k = 0; k < parts.length - 1 && i < 0; k++) i = actions.matchSupplier(fresh.data, parts[k]);
        if (i < 0) i = actions.matchSupplier(fresh.data, base.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
        if (i < 0) { skipped.push([e.name, 'no matching supplier (put each supplier’s files in a folder named after it)']); return; }
        if (e.data.length > MAX_UPLOAD) { skipped.push([e.name, 'larger than 15 MB']); return; }
        const t = TYPE.find(function (x) { return x[0].test(e.name); }); const slot = t ? t[1] : 'other';
        const id = crypto.randomBytes(12).toString('hex'), dir = path.join(DATA_DIR, 'uploads', ws.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, id), e.data);
        const mime = /\.pdf$/i.test(base) ? 'application/pdf' : (/\.(png|gif|webp)$/i.test(base) ? 'image/' + base.split('.').pop().toLowerCase() : (/\.jpe?g$/i.test(base) ? 'image/jpeg' : 'application/octet-stream'));
        let read = null; try { read = certread.read(e.data, base, mime, fresh.data.SUP[i], null); } catch (x) { /* unreadable */ }
        const expiry = read && read.expiry && !read.guessed ? read.expiry : null;
        const target = (OPT.indexOf(slot) >= 0 ? 'opt:' : 'slot:') + i + ':' + slot;
        db.prepare('INSERT INTO files (id, ws, owner, name, mime, size, path, expiry, uploaded_at, uploaded_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ws.id, target, base, mime, e.data.length, path.join(ws.id, id), expiry, new Date().toISOString(), U.email);
        actions.run(fresh.data, 'file_add', { target: target, label: base.replace(/\.[^.]+$/, ''), fileId: id, expiry: expiry, meta: read ? { read: read } : undefined }, { user: (U.name || U.email), now: new Date() });
        placed.push([e.name, fresh.data.SUP[i].name, slot, expiry]);
      });
      saveWs(ws.id, fresh.data);
      logEvent(ws.id, U.email, 'import_docs', 'documents', { placed: placed.length, skipped: skipped.length });
      return json(res, 200, { ok: true, data: fresh.data, placed: placed, skipped: skipped, msg: placed.length + ' document(s) filed' + (skipped.length ? ', ' + skipped.length + ' not filed' : '') });
    }
    // ---- account and team ----
    if (p === '/api/account' && req.method === 'GET') {
      const me = { id: U.id, email: U.email, name: U.name, role: U.role, roleName: auth.ROLES[U.role], totp: !!U.totp_on };
      if (U.role !== 'owner') return json(res, 200, { me: me });
      const users = db.prepare('SELECT id, email, name, role, ws, totp_on, disabled, last_login, pass IS NOT NULL AS active FROM users ORDER BY id').all();
      return json(res, 200, { me: me, users: users, roles: auth.ROLES, workspaces: wsList(), mail: mail.configured(env) });
    }
    if (p === '/api/account' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 4000));
      if (b.op === 'name') { db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name || '').replace(/[<>]/g, '').slice(0, 120), U.id); return json(res, 200, { ok: true, msg: 'Name saved. It appears on signatures and history.' }); }
      if (b.op === 'password') {
        if (limited('pw:' + U.id, 8, 15)) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
        if (!auth.verify(b.old || '', U.pass)) return json(res, 400, { error: 'Your current password isn’t right.' });
        const prob = auth.passwordProblem(b.new, U.email); if (prob) return json(res, 400, { error: prob });
        db.prepare('UPDATE users SET pass = ?, sess_v = sess_v + 1 WHERE id = ?').run(auth.hash(b.new), U.id);
        const u2 = db.prepare('SELECT * FROM users WHERE id = ?').get(U.id); logEvent('system', U.email, 'password_changed', 'user' + U.id, {});
        res.setHeader('Set-Cookie', cookie(req, 'fv_session', makeSession(u2), 7 * 86400));
        return json(res, 200, { ok: true, msg: 'Password changed. Other devices are signed out.' + (U.role === 'owner' ? ' Note: changing DEMO_PASSWORD in Render later will reset it again.' : '') });
      }
      if (b.op === 'totp_start') { const sec = auth.newTotpSecret(); db.prepare('UPDATE users SET totp = ?, totp_on = 0 WHERE id = ?').run(sec, U.id); return json(res, 200, { ok: true, secret: sec, uri: auth.otpauth(sec, U.email) }); }
      if (b.op === 'totp_confirm' || b.op === 'totp_off') {
        if (limited('2fa:' + U.id, 8, 15)) return json(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(U.id);
        if (!auth.totpCheck(u.totp, b.code)) return json(res, 400, { error: 'That code didn’t work. Check the time on your phone and use the current code.' });
        db.prepare('UPDATE users SET totp_on = ?' + (b.op === 'totp_off' ? ', totp = NULL' : '') + ' WHERE id = ?').run(b.op === 'totp_confirm' ? 1 : 0, U.id);
        logEvent('system', U.email, b.op === 'totp_confirm' ? '2fa_on' : '2fa_off', 'user' + U.id, {});
        return json(res, 200, { ok: true, msg: b.op === 'totp_confirm' ? '2-step sign-in is on. You’ll enter a code from your app each time you sign in.' : '2-step sign-in is off.' });
      }
      return json(res, 400, { error: 'unknown' });
    }
    if (p === '/api/users' && req.method === 'POST') {
      if (U.role !== 'owner') return json(res, 403, { error: 'Only the account owner can manage the team.' });
      const b = JSON.parse(await readBody(req, 4000));
      const wsv = b.ws === '*' || !Array.isArray(b.ws) ? '*' : b.ws.filter(function (x) { return /^[a-z0-9-]+$/.test(x); }).join(',');
      const role = auth.ROLES[b.role] && b.role !== 'owner' ? b.role : 'staff';
      const inviteMail = function (u, t) { return sendMail('system', 'invite', u.email, U.name + ' invited you to FSVP Vault', 'You’re invited to FSVP Vault', [(U.name || U.email) + ' added you to FSVP Vault as ' + auth.ROLES[u.role] + '.', 'Use the button below to set your password. The link works for 3 days.'], ['Set up my account', PUBLIC_URL + '/reset?t=' + t]); };
      if (b.op === 'invite') {
        const email = String(b.email || '').trim().toLowerCase(); if (!mail.validEmail(email)) return json(res, 400, { error: 'Enter a valid email address.' });
        if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return json(res, 400, { error: 'That person already has an account.' });
        const id = db.prepare('INSERT INTO users (email, name, role, ws, created_at) VALUES (?,?,?,?,?)').run(email, String(b.name || '').replace(/[<>]/g, '').slice(0, 120), role, wsv, new Date().toISOString()).lastInsertRowid;
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id), t = auth.makeToken(db, id, 72), r = inviteMail(u, t);
        logEvent('system', U.email, 'user_invited', 'user' + id, { email: email, role: role, ws: wsv });
        return json(res, 200, { ok: true, msg: r.sent ? 'Invitation emailed to ' + email : 'Account created. Email isn’t set up, so send them this link yourself (works for 3 days).', link: r.sent ? '' : PUBLIC_URL + '/reset?t=' + t });
      }
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+b.id); if (!u) return json(res, 404, { error: 'No such user' });
      if (u.role === 'owner') return json(res, 400, { error: 'The owner account is set in Render (DEMO_EMAIL and DEMO_PASSWORD).' });
      if (b.op === 'update') {
        db.prepare('UPDATE users SET role = ?, ws = ?, disabled = ?, sess_v = sess_v + 1 WHERE id = ?').run(role, wsv, b.disabled ? 1 : 0, u.id);
        logEvent('system', U.email, 'user_updated', 'user' + u.id, { role: role, ws: wsv, disabled: !!b.disabled });
        return json(res, 200, { ok: true, msg: b.disabled ? 'Access removed for ' + u.email : 'Saved ' + u.email });
      }
      if (b.op === 'link') { const t = auth.makeToken(db, u.id, 72), r = inviteMail(u, t); return json(res, 200, { ok: true, msg: r.sent ? 'New link emailed to ' + u.email : 'Send them this link (works for 3 days).', link: r.sent ? '' : PUBLIC_URL + '/reset?t=' + t }); }
      if (b.op === 'reset2fa') { db.prepare('UPDATE users SET totp = NULL, totp_on = 0, sess_v = sess_v + 1 WHERE id = ?').run(u.id); logEvent('system', U.email, '2fa_reset', 'user' + u.id, {}); return json(res, 200, { ok: true, msg: '2-step sign-in turned off for ' + u.email }); }
      return json(res, 400, { error: 'unknown' });
    }
    // ---- backup: database copy, uploaded files and private seeds in one ZIP (owner only) ----
    if (p === '/api/backup' && req.method === 'GET') {
      if (U.role !== 'owner') return send(res, 403, 'Only the account owner can download backups.');
      const out = makeBackup();
      logEvent('system', U.email, 'backup', '', { files: out.count, size: out.buf.length });
      return send(res, 200, out.buf, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="fsvpvault-backup-' + new Date().toISOString().slice(0, 10) + '.zip"', 'Cache-Control': 'private, no-store' });
    }
    if (p === '/api/mail' && req.method === 'GET') {
      if (!auth.canWs(U, url.searchParams.get('ws') || '')) return json(res, 404, { error: 'no_workspace' });
      const rows = db.prepare('SELECT at, kind, to_addr, subject, status, error FROM mail WHERE ws = ? ORDER BY id DESC LIMIT 100').all(url.searchParams.get('ws') || '');
      return json(res, 200, { configured: mail.configured(env), mail: rows });
    }
    if (p === '/api/mail/test' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req, 2000)); const ws = auth.canWs(U, body.ws) ? getWs(body.ws) : null; if (!ws) return json(res, 404, { error: 'no_workspace' });
      if (!mail.configured(env)) return json(res, 400, { error: 'Email isn’t set up yet: add the SMTP settings in Render' });
      try { await mail.send(env, Object.assign({ to: [U.email], subject: 'FSVP Vault test email' }, mail.layout('Email is working', ['This test was sent from fsvpvault.com. Supplier requests, reminders and FDA alerts will be sent the same way.']))); }
      catch (e) { return json(res, 400, { error: e.message }); }
      return json(res, 200, { ok: true, msg: 'Test email sent to ' + U.email });
    }
    if (p === '/api/events' && req.method === 'GET') {
      if (!auth.canWs(U, url.searchParams.get('ws') || '')) return json(res, 404, { error: 'no_workspace' });
      const supQ = url.searchParams.get('sup');
      let rows = db.prepare('SELECT at, user, type, target, detail FROM events WHERE ws = ? ORDER BY id DESC LIMIT ' + (supQ !== null ? 3000 : 200)).all(url.searchParams.get('ws') || '');
      if (supQ !== null && /^\d+$/.test(supQ)) {
        const re = new RegExp('^(sup|monitor|plan)' + supQ + '$|^(slot|opt):' + supQ + ':');
        rows = rows.filter(function (e) { if (re.test(e.target || '')) return true; try { const d = JSON.parse(e.detail || '{}'); return String(d.sup) === supQ; } catch (x) { return false; } }).slice(0, 200);
      }
      return json(res, 200, { events: rows });
    }
    if (p === '/api/import' && req.method === 'POST') {
      if (U.role !== 'owner') return json(res, 403, { error: 'Only the account owner can import workspaces.' });
      // load a private workspace file (kept out of the code repository) onto this server's disk
      const body = JSON.parse(await readBody(req, 3 * 1024 * 1024));
      const id = String(body.id || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
      const data = body.data;
      if (!id || id === 'demo' || !data || !data.company || !data.company.name || !Array.isArray(data.SUP)) return json(res, 400, { error: 'not_a_workspace_file' });
      fs.mkdirSync(path.join(DATA_DIR, 'seeds'), { recursive: true });
      fs.writeFileSync(path.join(DATA_DIR, 'seeds', id + '.json'), JSON.stringify(data));
      if (db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(id)) saveWs(id, data);
      else db.prepare('INSERT INTO workspaces (id, name, sort, data, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, data.company.name, 10, JSON.stringify(data), new Date().toISOString());
      logEvent(id, U.email, 'import', '', { name: data.company.name });
      return json(res, 200, { ok: true, id: id });
    }
    if (p === '/api/reset' && req.method === 'POST') {
      if (U.role !== 'owner') return json(res, 403, { error: 'Only the account owner can reset a workspace.' });
      // demo only: put a workspace back to its seed data
      const body = JSON.parse(await readBody(req, 1000));
      const file = seedPath(body.ws);
      if (!file) return json(res, 404, { error: 'no_seed' });
      saveWs(body.ws, JSON.parse(fs.readFileSync(file, 'utf8')));
      logEvent(body.ws, U.email, 'reset', '', {});
      return json(res, 200, { ok: true });
    }
    return send(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    return json(res, err.message === 'too_large' ? 413 : 500, { error: err.message === 'too_large' ? 'too_large' : 'server_error' });
  }
});
server.listen(PORT, function () { console.log('FSVP Vault demo on http://localhost:' + PORT); });
