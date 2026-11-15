// Outgoing email over SMTP with no dependencies (works with Google Workspace using an app password).
// Settings: SMTP_HOST, SMTP_PORT (465 = TLS, 587 = STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM.
'use strict';
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

function cfg(env) {
  return { host: env('SMTP_HOST'), port: parseInt(env('SMTP_PORT') || '465', 10), user: env('SMTP_USER'), pass: env('SMTP_PASS'),
    from: env('MAIL_FROM') || (env('SMTP_USER') ? 'FSVP Vault <' + env('SMTP_USER') + '>' : ''), insecure: env('SMTP_INSECURE_TLS') === '1' };
}
exports.configured = function (env) { const c = cfg(env); return !!(c.host && c.user && c.pass && c.from); };

function addr(a) { const m = String(a || '').match(/<([^>]+)>/); return (m ? m[1] : String(a || '')).trim(); }
function enc(s) { return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?='; }
function b64lines(s) { return Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'); }
exports.validEmail = function (e) { return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(String(e || '').trim()); };

// Build the raw message (plain text + HTML)
function build(m, from) {
  const b = 'b' + crypto.randomBytes(12).toString('hex');
  const host = addr(from).split('@')[1] || 'fsvpvault.com';
  const h = [
    'From: ' + from,
    'To: ' + m.to.join(', '),
    m.replyTo ? 'Reply-To: ' + m.replyTo : null,
    'Subject: ' + enc(m.subject),
    'Date: ' + new Date().toUTCString().replace('GMT', '+0000'),
    'Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@' + host + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + b + '"'
  ].filter(Boolean).join('\r\n');
  const alt = '--' + b + '\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64lines(m.text) +
    '\r\n--' + b + '\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64lines(m.html || m.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')) +
    '\r\n--' + b + '--\r\n';
  if (!m.attachments || !m.attachments.length) return h + '\r\n\r\n' + alt;
  // with attachments: multipart/mixed wrapping the text/html part
  const mx = 'm' + crypto.randomBytes(12).toString('hex');
  return h.replace('multipart/alternative; boundary="' + b + '"', 'multipart/mixed; boundary="' + mx + '"') + '\r\n\r\n--' + mx + '\r\nContent-Type: multipart/alternative; boundary="' + b + '"\r\n\r\n' + alt +
    m.attachments.map(function (at) { return '--' + mx + '\r\nContent-Type: ' + (at.type || 'application/octet-stream') + '; name="' + at.name + '"\r\nContent-Disposition: attachment; filename="' + at.name + '"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + (Buffer.isBuffer(at.data) ? at.data : Buffer.from(String(at.data), 'utf8')).toString('base64').replace(/.{76}/g, '$&\r\n') + '\r\n'; }).join('') + '--' + mx + '--\r\n';
}

// Talk SMTP: read a full (possibly multi-line) reply, send a command, check the code
function session(sock) {
  let buf = '', waiting = null;
  const onData = function (d) { buf += d.toString('utf8'); pump(); };
  function pump() {
    if (!waiting) return;
    const lines = buf.split('\r\n'); // last element is partial
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) { const reply = lines.slice(0, i + 1).join('\n'); buf = lines.slice(i + 1).join('\r\n'); const w = waiting; waiting = null; w.res(reply); return; }
    }
  }
  sock.on('data', onData);
  return {
    read: function () { return new Promise(function (res, rej) { waiting = { res: res, rej: rej }; pump(); }); },
    cmd: async function (line, want) {
      if (line !== null) sock.write(line + '\r\n');
      const r = await this.read();
      if (want && !want.test(r.slice(0, 3))) throw new Error('SMTP ' + (line && /^AUTH/.test(line) ? 'AUTH' : (line || 'greeting').split(' ')[0]) + ' failed: ' + r.split('\n').pop());
      return r;
    },
    detach: function () { sock.removeListener('data', onData); }
  };
}

exports.send = async function (env, m) {
  const c = cfg(env);
  if (!exports.configured(env)) throw new Error('Email isn’t set up (SMTP settings missing)');
  const to = (Array.isArray(m.to) ? m.to : [m.to]).map(function (x) { return String(x).trim(); }).filter(exports.validEmail);
  if (!to.length) throw new Error('No valid recipient');
  const msg = Object.assign({}, m, { to: to });
  const opts = { host: c.host, port: c.port, servername: c.host, rejectUnauthorized: !c.insecure };
  let sock = await new Promise(function (res, rej) {
    const s = c.port === 465 ? tls.connect(opts, function () { res(s); }) : net.connect(c.port, c.host, function () { res(s); });
    s.setTimeout(30000, function () { s.destroy(new Error('SMTP timeout')); }); s.once('error', rej);
  });
  let S = session(sock);
  try {
    await S.cmd(null, /^220/);
    const me = 'fsvpvault.com';
    let ehlo = await S.cmd('EHLO ' + me, /^250/);
    if (c.port !== 465) {
      if (!/STARTTLS/i.test(ehlo)) throw new Error('Server does not offer STARTTLS');
      await S.cmd('STARTTLS', /^220/); S.detach();
      sock = await new Promise(function (res, rej) { const t = tls.connect(Object.assign({ socket: sock }, opts), function () { res(t); }); t.once('error', rej); });
      S = session(sock); ehlo = await S.cmd('EHLO ' + me, /^250/);
    }
    await S.cmd('AUTH PLAIN ' + Buffer.from('\0' + c.user + '\0' + c.pass).toString('base64'), /^235/);
    await S.cmd('MAIL FROM:<' + addr(c.from) + '>', /^250/);
    for (const r of to) await S.cmd('RCPT TO:<' + r + '>', /^25[01]/);
    await S.cmd('DATA', /^354/);
    const body = build(msg, c.from).replace(/\r\n\./g, '\r\n..');
    await S.cmd(body + '\r\n.', /^250/);
    await S.cmd('QUIT', null).catch(function () {});
  } finally { try { sock.end(); } catch (e) { /* closed */ } }
  return { to: to };
};

// A simple branded HTML wrapper for every email
exports.layout = function (title, paras, button) {
  const esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const html = '<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#14202B;max-width:560px">' +
    '<div style="background:#14202B;color:#fff;padding:12px 16px;font-weight:700">FSVP Vault</div><div style="padding:16px">' +
    '<h2 style="font-size:18px;margin:0 0 12px">' + esc(title) + '</h2>' +
    paras.map(function (p) { return Array.isArray(p) ? '<ul style="padding-left:20px;margin:0 0 12px">' + p.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p style="margin:0 0 12px">' + esc(p) + '</p>'; }).join('') +
    (button ? '<p style="margin:16px 0"><a href="' + esc(button[1]) + '" style="background:#0F5E4F;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block">' + esc(button[0]) + '</a></p>' : '') +
    '<p style="color:#4A5560;font-size:12px;margin-top:20px">Sent by FSVP Vault on behalf of your customer. FSVP Vault is software; it is not affiliated with FDA.</p></div></div>';
  const text = title + '\n\n' + paras.map(function (p) { return Array.isArray(p) ? p.map(function (x) { return '- ' + x; }).join('\n') : p; }).join('\n\n') + (button ? '\n\n' + button[0] + ': ' + button[1] : '') + '\n\n--\nSent by FSVP Vault on behalf of your customer.';
  return { html: html, text: text };
};
