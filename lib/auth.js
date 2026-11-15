// Accounts: users with roles and workspace access, scrypt passwords, TOTP 2-step codes, reset/invite tokens.
'use strict';
const crypto = require('crypto');

const ROLES = { owner: 'Owner', qi: 'Qualified individual', staff: 'Staff', viewer: 'View only' };
exports.ROLES = ROLES;
// actions only a QI (or the owner) may take: they are signatures and approvals under 21 CFR 1.502–1.510
exports.QI_ONLY = ['sign', 'approve', 'reeval', 'plan_sign', 'capa_close'];

exports.init = function (db) {
  db.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT, role TEXT NOT NULL, ws TEXT NOT NULL DEFAULT '*',
    pass TEXT, sess_v INTEGER DEFAULT 1, totp TEXT, totp_on INTEGER DEFAULT 0, token TEXT, token_exp INTEGER, env_fp TEXT, disabled INTEGER DEFAULT 0, created_at TEXT, last_login TEXT)`);
};

// ---- passwords (scrypt) ----
exports.hash = function (pw) { const salt = crypto.randomBytes(16); const h = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }); return 's1$' + salt.toString('base64') + '$' + h.toString('base64'); };
exports.verify = function (pw, stored) {
  if (!stored) { crypto.scryptSync('x', 'y', 32); return false; }
  const p = String(stored).split('$'); if (p[0] !== 's1') return false;
  const h = crypto.scryptSync(String(pw), Buffer.from(p[1], 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(p[2], 'base64'); return h.length === want.length && crypto.timingSafeEqual(h, want);
};
exports.passwordProblem = function (pw, email) {
  pw = String(pw || '');
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (/^(.)\1+$/.test(pw) || /^(password|123456|qwerty)/i.test(pw)) return 'That password is too easy to guess.';
  if (email && pw.toLowerCase().indexOf(String(email).split('@')[0].toLowerCase()) >= 0) return 'Don’t include your email name in the password.';
  return '';
};

// ---- the owner account comes from DEMO_EMAIL / DEMO_PASSWORD; changing DEMO_PASSWORD in Render resets it ----
exports.bootstrapOwner = function (db, email, password, name) {
  const fp = crypto.createHash('sha256').update('fp:' + password).digest('hex').slice(0, 16);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u) db.prepare('INSERT INTO users (email, name, role, ws, pass, env_fp, created_at) VALUES (?,?,?,?,?,?,?)').run(email, name, 'owner', '*', exports.hash(password), fp, new Date().toISOString());
  else if (u.env_fp !== fp) db.prepare('UPDATE users SET pass = ?, env_fp = ?, role = ?, disabled = 0, sess_v = sess_v + 1 WHERE id = ?').run(exports.hash(password), fp, 'owner', u.id);
};

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(s) { let bits = 0, val = 0; const out = []; for (const ch of String(s).replace(/[\s=]/g, '').toUpperCase()) { const i = B32.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(key, counter) {
  const c = Buffer.alloc(8); c.writeUInt32BE(Math.floor(counter / 0x100000000), 0); c.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(c).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0');
}
exports.newTotpSecret = function () { return b32enc(crypto.randomBytes(20)); };
exports.totpCode = function (secret, t) { return hotp(b32dec(secret), Math.floor((t || Date.now()) / 30000)); };
exports.totpCheck = function (secret, code) {
  code = String(code || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code) || !secret) return false;
  const key = b32dec(secret), now = Math.floor(Date.now() / 30000);
  for (let w = -1; w <= 1; w++) if (crypto.timingSafeEqual(Buffer.from(hotp(key, now + w)), Buffer.from(code))) return true;
  return false;
};
exports.otpauth = function (secret, email) { return 'otpauth://totp/' + encodeURIComponent('FSVP Vault:' + email) + '?secret=' + secret + '&issuer=FSVP%20Vault&digits=6&period=30'; };

// ---- one-time tokens for password reset and invitations (only a hash is stored) ----
exports.makeToken = function (db, userId, hours) {
  const t = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE users SET token = ?, token_exp = ? WHERE id = ?').run(crypto.createHash('sha256').update(t).digest('hex'), Date.now() + hours * 3600e3, userId);
  return t;
};
exports.useToken = function (db, t) {
  if (!t || t.length < 20) return null;
  const u = db.prepare('SELECT * FROM users WHERE token = ?').get(crypto.createHash('sha256').update(String(t)).digest('hex'));
  if (!u || u.disabled || !u.token_exp || u.token_exp < Date.now()) return null;
  return u;
};

exports.canWs = function (u, wsId) { return !!u && (u.ws === '*' || String(u.ws).split(',').indexOf(wsId) >= 0); };
exports.canAct = function (u, type) {
  if (!u) return 'login_required';
  if (u.role === 'viewer') return 'Your account is view only.';
  if (exports.QI_ONLY.indexOf(type) >= 0 && u.role !== 'qi' && u.role !== 'owner') return 'Only a qualified individual can sign or approve.';
  return '';
};
