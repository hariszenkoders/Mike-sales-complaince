// Every change a user can make in the portal. Each handler edits the workspace data in place.
// Returns { target, msg } or { error }. The server saves the data and writes an audit event.
'use strict';
const fda = require('./fda');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function iso(d) { return d.toISOString().slice(0, 10); }
function fmt(isoStr) { const a = isoStr.split('-'); return MONTHS[+a[1] - 1] + ' ' + (+a[2]) + ', ' + a[0]; }
function stamp(d) { return fmt(iso(d)) + ', ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ' UTC'; }
function addYears(isoStr, n) { const a = isoStr.split('-'); return (+a[0] + n) + '-' + a[1] + '-' + a[2]; }
function str(v, max) { return String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max || 500); }
function toIso(v) {
  v = String(v || '').trim(); let m;
  if ((m = v.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  if ((m = v.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2000; let mo = +m[1], d = +m[2]; if (mo > 12) { const t = mo; mo = d; d = t; } return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'); } // US style month first
  const t = Date.parse(v); return isNaN(t) ? '' : new Date(t).toISOString().slice(0, 10);
}
function parseCsv(t) {
  const rows = []; let row = [], cell = '', q = false;
  const sep = (t.split('\n')[0].match(/;/g) || []).length > (t.split('\n')[0].match(/,/g) || []).length ? ';' : (t.split('\n')[0].indexOf('\t') >= 0 ? '\t' : ',');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === sep) { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(0, 5000);
}
function nm(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\b(co|company|ltd|limited|jsc|joint|stock|corp|inc|llc|pte|the|trading)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function matchSupplier(D, name) {
  const n = nm(name); if (!n) return -1;
  for (let i = 0; i < D.SUP.length; i++) { const cands = [D.SUP[i].name].concat(D.SUP[i].fdaNames || [], [String(D.SUP[i].alias || '').replace(/^(ships as|aka|dba)\s+/i, '')]);
    if (cands.some(function (c) { const k = nm(c); return k.length >= 3 && (n.indexOf(k) >= 0 || k.indexOf(n) >= 0); })) return i; }
  return -1;
}
function shipFields(sh, p, D) {
  if (p.date !== undefined) sh.date = toIso(p.date);
  ['entry', 'product', 'lot', 'qty', 'po', 'bl', 'note'].forEach(function (k) { if (p[k] !== undefined) sh[k] = str(p[k], 200); });
  if (p.sup !== undefined && p.sup !== '' && p.sup !== null) sh.sup = parseInt(p.sup, 10);
  else if (p.supName !== undefined) { sh.sup = matchSupplier(D, p.supName); sh.supName = str(p.supName, 160); }
  if (!(sh.sup >= 0 && D.SUP[sh.sup])) sh.sup = -1;
  return sh;
}
function lines(v) { return String(v || '').split(/\r?\n/).map(function (x) { return str(x, 600); }).filter(Boolean); }
function supOk(D, i) { return Number.isInteger(i) && i >= 0 && i < D.SUP.length; }

const TYPE_LABEL = { lacf: 'Low-acid, shelf-stable', aseptic: 'Low-acid, aseptic', af: 'Acidified', juice: 'Juice beverage', carb: 'Carbonated', other: 'Other packaged food' };

function defaultHazards(foods, types) {
  const hz = [];
  if (types.indexOf('lacf') >= 0 || types.indexOf('aseptic') >= 0) hz.push([foods, 'C. botulinum (low-acid, shelf-stable)', 'Supplier: scheduled process under 21 CFR 113 [CRITICAL LIMITS NEEDED]', '[FCE/SID AND PROCESS RECORDS NEEDED]']);
  if (types.indexOf('af') >= 0) hz.push([foods, 'C. botulinum (acidified food)', 'Supplier: pH control under 21 CFR 114 [EQUILIBRIUM pH NEEDED]', '[FCE/SID AND pH RECORDS NEEDED]']);
  if (types.indexOf('juice') >= 0) hz.push([foods, 'Vegetative pathogens (E. coli O157:H7, Salmonella)', 'Supplier: Juice HACCP 5-log reduction [VALIDATION NEEDED]', '[JUICE HACCP PLAN NEEDED]']);
  hz.push(['All products', 'Foreign matter (glass, metal)', 'Supplier: filtration and inspection [CONFIRM]', '[AUDIT REPORT]']);
  if (types.indexOf('other') >= 0 && hz.length === 1) hz.unshift([foods, '[HAZARDS TO BE IDENTIFIED]', '[CONTROL AND WHO APPLIES IT]', '[EVIDENCE]']);
  return hz;
}

const H = {
  sign: function (D, p, c) {
    const id = str(p.id, 40); if (!id) return { error: 'no_id' };
    D.sig = D.sig || {}; D.sig[id] = { by: c.user + ' (QI)', at: stamp(c.now) };
    return { target: id, msg: 'Signed' };
  },
  remove: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    D.removed = D.removed || {};
    D.removed[p.sup] = { date: str(p.date, 10) || iso(c.now), reason: str(p.reason, 120) || 'Removed', note: str(p.note, 600), stopPO: p.stopPO !== false };
    const A = D.APPROVAL[p.sup]; if (A) { A.st = 'removed'; A.log.push([iso(c.now), 'Removed: ' + (str(p.reason, 120) || 'no reason given')]); }
    return { target: 'sup' + p.sup, msg: 'Supplier removed. Records kept.' };
  },
  reinstate: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    delete D.removed[p.sup];
    const A = D.APPROVAL[p.sup]; if (A) { A.st = 'pending'; A.log.push([iso(c.now), 'Reinstated; needs a new approval decision']); }
    return { target: 'sup' + p.sup, msg: 'Supplier reinstated' };
  },
  approve: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const A = D.APPROVAL[p.sup] || (D.APPROVAL[p.sup] = { st: 'pending', basis: '', cond: [], trig: '', log: [] });
    const mode = ['ok', 'cond', 'no'].indexOf(p.mode) >= 0 ? p.mode : 'ok';
    A.st = mode; A.date = iso(c.now); A.reeval = mode === 'no' ? '' : addYears(iso(c.now), 3);
    if (p.basis) A.basis = str(p.basis, 400);
    A.cond = mode === 'cond' ? lines(p.conditions) : [];
    if (mode !== 'no') A.trig = '';
    A.log.push([iso(c.now), (mode === 'ok' ? 'Approved' : mode === 'cond' ? 'Approved with conditions' : 'Not approved') + ' by ' + c.user + ' (QI)' + (p.note ? ': ' + str(p.note, 300) : '')]);
    return { target: 'sup' + p.sup, msg: 'Approval recorded' };
  },
  reeval: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const A = D.APPROVAL[p.sup]; if (!A) return { error: 'no_approval' };
    A.log.push([iso(c.now), 'Reevaluation by ' + c.user + ' (QI): ' + (str(p.conclusion, 600) || 'no change')]);
    A.trig = ''; if (A.st === 'ok' || A.st === 'cond') A.reeval = addYears(iso(c.now), 3);
    return { target: 'sup' + p.sup, msg: 'Reevaluation recorded' };
  },
  request: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const s = D.SUP[p.sup]; s.sent = s.sent || {};
    const doc = str(p.doc, 160) || 'Documents';
    s.sent[doc] = iso(c.now);
    return { target: 'sup' + p.sup, msg: 'Request saved for ' + doc };
  },
  remind_all: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const s = D.SUP[p.sup]; s.sent = s.sent || {};
    (s.req || []).forEach(function (q) { s.sent[q[0]] = iso(c.now); });
    return { target: 'sup' + p.sup, msg: 'Reminder saved' };
  },
  req_settings: function (D, p) {
    D.reqSettings = { before: Math.max(7, Math.min(180, parseInt(p.before, 10) || 60)), every: Math.max(1, Math.min(30, parseInt(p.every, 10) || 7)), auto: p.auto !== 'off' };
    return { target: 'settings', msg: 'Request timing saved' };
  },
  alerts: function (D, p) {
    D.alerts = { email: str(p.email, 120), freq: str(p.freq, 40) || 'Daily' };
    return { target: 'settings', msg: 'Alert settings saved' };
  },
  supplier_contact: function (D, p) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const list = String(p.emails || '').split(/[\s,;]+/).filter(function (e) { return /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(e); }).slice(0, 5);
    D.SUP[p.sup].contacts = list.join(', '); D.SUP[p.sup].contactName = str(p.name, 120);
    return { target: 'sup' + p.sup, msg: list.length ? 'Supplier contact saved' : 'Contact cleared (no valid email address)' };
  },
  fda_names: function (D, p) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    D.SUP[p.sup].fdaNames = String(p.names || '').split(/\n|;/).map(function (x) { return x.trim().slice(0, 120); }).filter(Boolean).slice(0, 10);
    return { target: 'sup' + p.sup, msg: 'Search names saved. Run the check again to use them.' };
  },
  monitor_run: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    D.SUP[p.sup].checkQueued = iso(c.now);
    return { target: 'sup' + p.sup, msg: 'Check queued. Live FDA connections are added in the last build step.' };
  },
  profile: function (D, p) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const types = (p.types || []).filter(function (t) { return TYPE_LABEL[t]; });
    const foods = str(p.foods, 300) || D.SUP[p.sup].foods;
    D.PROFILE[p.sup] = D.PROFILE[p.sup] || { foods: [], sahcodha: '', buyer: '' };
    D.PROFILE[p.sup].foods = types.map(function (t) { return [t, foods, TYPE_LABEL[t]]; });
    D.PROFILE[p.sup].sahcodha = str(p.sahcodha, 200);
    D.SUP[p.sup].foods = foods;
    return { target: 'sup' + p.sup, msg: 'Foods updated. Required documents recalculated.' };
  },
  supplier_add: function (D, p, c) {
    const name = str(p.name, 160); if (!name) return { error: 'name_required' };
    const types = (p.types || []).filter(function (t) { return TYPE_LABEL[t]; }); if (!types.length) types.push('other');
    const foods = str(p.foods, 300) || '[FOODS]';
    const i = D.SUP.length;
    D.SUP.push({ name: name, alias: str(p.alias, 120), loc: str(p.loc, 200) || '[ADDRESS]', ships: 0, foods: foods, reg: str(p.reg, 60) || '[FDA REGISTRATION NUMBER]',
      plan: null, slots: {}, opt: {}, hz: defaultHazards(foods, types), certs: '', audit: '', rec: '', verif: '', req: [] });
    D.PROFILE[i] = { foods: types.map(function (t) { return [t, foods, TYPE_LABEL[t]]; }), sahcodha: (types.indexOf('lacf') >= 0 || types.indexOf('aseptic') >= 0 || types.indexOf('af') >= 0) ? 'C. botulinum in low-acid or acidified food' : '', buyer: '' };
    D.APPROVAL[i] = { st: 'pending', basis: 'New supplier, added ' + fmt(iso(c.now)), cond: [], trig: '', log: [[iso(c.now), 'Supplier added by ' + c.user]] };
    D.UPCODE[i] = 'FV-' + name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    D.FR[i] = [];
    const low = types.indexOf('lacf') >= 0 || types.indexOf('aseptic') >= 0;
    D.SCOPE.push({ id: 'sc' + i + 'n' + Date.now().toString(36), sup: i, food: foods,
      a: { imp: ['Unknown', 'Confirm you’re the owner or consignee at entry'], ex: [types.indexOf('juice') >= 0 ? 'Possibly' : 'No', types.indexOf('juice') >= 0 ? 'Juice may be exempt if the supplier complies with Part 120' : ''], lacf: [low ? 'Yes' : 'No', low ? 'Verify the supplier’s Part 113 compliance' : ''], mod: ['No', ''], cust: ['No', ''] },
      out: [types.indexOf('juice') >= 0 ? 'warn' : 'ok', low ? 'Standard FSVP + Part 113' : (types.indexOf('juice') >= 0 ? 'Juice HACCP path (pending)' : 'Standard FSVP'), 'Draft from the food types you entered. Review each answer.'] });
    return { target: 'sup' + i, msg: 'Supplier added', newSup: i };
  },
  identity: function (D, p) {
    const map = { 'Legal name': p.name, 'Address': p.address, 'FSVP contact email': p.email, 'DUNS number': p.duns };
    D.IMPID.forEach(function (r) { if (map[r[0]] !== undefined && str(map[r[0]], 200)) r[1] = str(map[r[0]], 200); });
    if (str(p.name, 200)) { D.company.name = str(p.name, 200); D.company.short = str(p.name, 200).replace(/,?\s+(LLC|Inc\.?|Corp\.?|Co\.?|Ltd\.?)$/i, ''); }
    D.IMPORTER = D.company.name + (str(p.address, 200) ? ', ' + str(p.address, 200) : '');
    return { target: 'identity', msg: 'Importer profile saved' };
  },
  qi: function (D, p) {
    if (str(p.name, 120)) { D.QIFILE.name = str(p.name, 120); D.company.qiName = str(p.name, 120); D.company.initials = str(p.name, 120).split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase(); }
    if (str(p.role, 120)) { D.QIFILE.role = str(p.role, 120); D.company.qiTitle = str(p.role, 120); }
    D.QI = D.QIFILE.name + ', ' + D.QIFILE.role;
    return { target: 'qi', msg: 'QI details saved' };
  },
  qi_item: function (D, p) {
    const it = D.QIFILE.items[parseInt(p.idx, 10)]; if (!it) return { error: 'bad_item' };
    it[1] = str(p.text, 400) || it[1]; it[2] = 'ok'; it[3] = 'On File';
    return { target: 'qi', msg: 'Saved' };
  },
  qi_add: function (D, p) {
    if (!str(p.name, 120)) return { error: 'name_required' };
    D.QIS = D.QIS || []; D.QIS.push({ name: str(p.name, 120), role: str(p.role, 120) });
    return { target: 'qi', msg: 'QI added. Add their training and résumé next.' };
  },
  proc_edit: function (D, p, c) {
    const id = str(p.id, 10); D.procEdits = D.procEdits || {};
    const body = lines(p.body); if (!body.length) return { error: 'empty' };
    D.procEdits[id] = body; D.procVer = D.procVer || {}; D.procVer[id] = (D.procVer[id] || []).concat([[iso(c.now), 'Edited by ' + c.user]]);
    if (D.sig) delete D.sig[id];
    return { target: id, msg: 'Procedure updated. Sign it again to adopt this version.' };
  },
  scope_edit: function (D, p, c) {
    const sc = D.SCOPE.find(function (x) { return x.id === p.id; }); if (!sc) return { error: 'no_scope' };
    ['imp', 'ex', 'lacf', 'mod', 'cust'].forEach(function (k) { if (p[k]) sc.a[k] = [str(p[k], 20), str(p[k + 'Note'], 400)]; });
    if (p.out) { const o = { std: ['ok', 'Standard FSVP'], lacf: ['ok', 'Standard FSVP + Part 113'], juice: ['warn', 'Juice HACCP path (pending)'], exempt: ['neutral', 'Exempt from FSVP'], mod: ['ok', 'Modified requirements'], na: ['neutral', 'Not the FSVP importer'] }[p.out];
      if (o) sc.out = [o[0], o[1], str(p.outNote, 400) || sc.out[2]]; }
    if (D.sig) delete D.sig[sc.id];
    sc.ver = (sc.ver || []).concat([[iso(c.now), 'Answers edited by ' + c.user]]);
    return { target: sc.id, msg: 'Scoping saved. Sign it again to confirm.' };
  },
  vrec_add: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const req = { audit: ['Audit procedures', 'Auditor and qualification', 'Audit dates', 'Conclusions', 'Corrective actions for significant deficiencies', 'Covers the applicable FDA rules'],
      test: ['Food and lot number', 'Number of samples', 'Tests and analytical method', 'Test and report dates', 'Results', 'Laboratory and accreditation', 'Corrective actions'],
      review: ['Records reviewed', 'Review date', 'Conclusions', 'Corrective actions'] }[p.type];
    if (!req) return { error: 'bad_type' };
    const id = 'v' + Date.now().toString(36);
    D.VREC.push({ id: id, sup: p.sup, type: p.type, title: str(p.title, 160) || 'New record', src: str(p.src, 200) || 'Entered by ' + c.user, f: req.map(function (k) { return [k, '[' + k.toUpperCase() + ']']; }) });
    return { target: id, msg: 'Record added. Fill in the fields, then sign.', newRec: id };
  },
  vrec_edit: function (D, p, c) {
    const r = D.VREC.find(function (x) { return x.id === p.id; }); if (!r) return { error: 'no_record' };
    r.f.forEach(function (f, k) { if (p['f' + k] !== undefined) f[1] = str(p['f' + k], 1000) || f[1]; });
    r.ver = (r.ver || []).concat([[iso(c.now), 'Fields edited by ' + c.user]]);
    if (D.sig) delete D.sig[r.id];
    return { target: r.id, msg: 'Saved. Sign again to confirm this version.' };
  },
  capa_add: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    D.CAPA.push([p.sup, str(p.src, 120) || 'Logged by ' + c.user, str(p.finding, 600) || '[WHAT HAPPENED]', iso(c.now), 'open', str(p.next, 400) || '[NEXT STEP]']);
    return { target: 'capa', msg: 'Corrective action opened' };
  },
  capa_close: function (D, p, c) {
    const x = D.CAPA[parseInt(p.idx, 10)]; if (!x) return { error: 'no_capa' };
    x[4] = 'closed'; x[5] = 'Closed ' + fmt(iso(c.now)) + ' by ' + c.user + ' (QI). Root cause: ' + (str(p.root, 300) || 'not given') + '. Evidence: ' + (str(p.evidence, 400) || 'not given');
    return { target: 'capa', msg: 'Corrective action closed' };
  },
  planrev: function (D, p) {
    const k = String(p.sup); D.PLANREV[k] = D.PLANREV[k] || { doc: '[PLAN NAME AND DATE]', st: [], note: '' };
    const R = D.PLANREV[k];
    if (p.doc) R.doc = str(p.doc, 160);
    if (p.note !== undefined) R.note = str(p.note, 400);
    if (Array.isArray(p.st)) R.st = p.st.map(function (v) { return ['y', 'n', 'q'].indexOf(v) >= 0 ? v : 'q'; });
    return { target: 'sup' + p.sup, msg: 'Plan review saved' };
  },
  fda_verdict: function (D, p) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const M = (D.MON || {})[p.sup]; if (!M || !M.live) return { error: 'not_checked' };
    const key = String(p.key || '').slice(0, 400); if (!key) return { error: 'no_key' };
    M.verdicts = M.verdicts || {};
    if (p.v === 'same' || p.v === 'not') M.verdicts[key] = p.v; else delete M.verdicts[key];
    fda.summarize(D, p.sup);
    return { target: 'monitor' + p.sup, msg: p.v === 'not' ? 'Marked not this supplier. It won\u2019t be flagged again.' : (p.v === 'same' ? 'Confirmed as this supplier' : 'Cleared') };
  },
  file_review: function (D, p, c) {
    const id = String(p.fileId || ''); let hit = null, supI = -1;
    (D.SUP || []).forEach(function (s, i) { [s.slots || {}, s.opt || {}].forEach(function (g) { Object.keys(g).forEach(function (k) { (g[k].files || []).forEach(function (f) { if (f[4] === id) { hit = f; supI = i; } }); }); }); });
    if (!hit) return { error: 'no_file' };
    const meta = hit[5] || (hit[5] = {});
    if (p.ok) { hit[3] = ''; meta.review = 'accepted'; }
    else { hit[3] = 'rejected'; meta.review = 'rejected'; meta.reason = str(p.reason, 400) || 'Not accepted'; }
    meta.reviewedBy = c.user; meta.reviewedAt = iso(c.now);
    D.ATTN = (D.ATTN || []).filter(function (a) { return a.fid !== id; });
    return { target: 'file:' + id, msg: p.ok ? 'Document accepted' : 'Document rejected. The supplier sees the reason next time they use their code.', sup: supI };
  },
  // ---- shipments (entries and lots) ----
  ship_add: function (D, p, c) {
    D.SHIP = D.SHIP || [];
    const sh = shipFields({ id: 'sh' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), files: {} }, p, D);
    if (!sh.date) return { error: 'Add the arrival or entry date' };
    D.SHIP.unshift(sh);
    return { target: 'ship:' + sh.id, msg: 'Shipment added' };
  },
  ship_edit: function (D, p) {
    const sh = (D.SHIP || []).find(function (x) { return x.id === p.id; }); if (!sh) return { error: 'no_shipment' };
    shipFields(sh, p, D); return { target: 'ship:' + sh.id, msg: 'Shipment saved' };
  },
  ship_delete: function (D, p) {
    const n = (D.SHIP || []).length; D.SHIP = (D.SHIP || []).filter(function (x) { return x.id !== p.id; });
    return n === D.SHIP.length ? { error: 'no_shipment' } : { target: 'ship:' + p.id, msg: 'Shipment deleted' };
  },
  ship_import: function (D, p) {
    const rows = parseCsv(String(p.csv || '').slice(0, 2000000));
    if (rows.length < 2) return { error: 'The file has no rows. Save the spreadsheet as CSV and try again.' };
    const head = rows[0].map(function (h) { return String(h).toLowerCase().trim(); });
    const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
    const C = { date: col(/arriv|entry date|date of entry|eta|ship date|date/), entry: col(/entry\s*(no|num|#)|entry$|^entry/), sup: col(/supplier|shipper|manufacturer|exporter|vendor|seller|consignor/),
      product: col(/product|description|item|commodity|goods/), lot: col(/lot|batch|production code|code date/), qty: col(/qty|quantity|cases|cartons|units/), po: col(/\bpo\b|purchase order|p\.o\./), bl: col(/\bb\/?l\b|bill of lading|container/) };
    if (C.date < 0 && C.entry < 0) return { error: 'Couldn’t find a date or entry number column. The first row should be column names.' };
    D.SHIP = D.SHIP || [];
    const seen = {}; D.SHIP.forEach(function (x) { seen[(x.entry || '') + '|' + (x.lot || '') + '|' + (x.product || '')] = 1; });
    let added = 0, unmatched = 0, dup = 0;
    rows.slice(1).forEach(function (r) {
      if (!r.some(function (x) { return String(x).trim(); })) return;
      const g = function (k) { return C[k] >= 0 ? String(r[C[k]] || '').trim() : ''; };
      const q = { date: toIso(g('date')), entry: g('entry'), supName: g('sup'), product: g('product'), lot: g('lot'), qty: g('qty'), po: g('po'), bl: g('bl') };
      const key = q.entry + '|' + q.lot + '|' + q.product; if (seen[key]) { dup++; return; } seen[key] = 1;
      const sh = shipFields({ id: 'sh' + Date.now().toString(36) + (added + 1000).toString(36), files: {} }, q, D);
      if (sh.sup < 0) unmatched++;
      D.SHIP.push(sh); added++;
    });
    D.SHIP.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return { target: 'ships', msg: added + ' shipment(s) imported' + (dup ? ', ' + dup + ' duplicate(s) skipped' : '') + (unmatched ? '. ' + unmatched + ' couldn’t be matched to a supplier; pick the supplier on each' : '') };
  },
  todo_done: function (D, p, c) {
    const key = String(p.key || '').slice(0, 300); if (!key) return { error: 'no_key' };
    D.done = D.done || {};
    if (p.undo) delete D.done[key]; else D.done[key] = { at: iso(c.now), by: c.user, label: str(p.label, 200) };
    // keep the list small: drop entries older than a year
    Object.keys(D.done).forEach(function (k) { if (D.done[k].at < addYears(iso(c.now), -1)) delete D.done[k]; });
    return { target: 'todo', msg: p.undo ? 'Moved back to the list' : 'Marked done' };
  },
  supplier_import: function (D, p, c) {
    const rows = parseCsv(String(p.csv || '').slice(0, 1000000));
    if (rows.length < 2) return { error: 'The file has no rows. Save the spreadsheet as CSV and try again.' };
    const head = rows[0].map(function (h) { return String(h).toLowerCase().trim(); });
    const col = function (re) { return head.findIndex(function (h) { return re.test(h); }); };
    const C = { name: col(/supplier|company|name|manufacturer|vendor/), alias: col(/alias|trade name|brand|also known/), loc: col(/address|location|country|city/), foods: col(/food|product/), type: col(/type|category|process/),
      email: col(/e-?mail|contact/), reg: col(/registration|ffr|fda reg/), fei: col(/\bfei\b/) };
    if (C.name < 0) return { error: 'Couldn’t find a supplier name column. The first row should be column names, such as Supplier, Address, Foods, Food type, Email.' };
    const TYPES = [[/low.?acid|lacf|retort|canned/i, 'lacf'], [/asept|uht|tetra/i, 'aseptic'], [/acidified|pickl|salsa|sauce/i, 'af'], [/juice/i, 'juice'], [/carbonat|soda|sparkling/i, 'carb']];
    let added = 0, skipped = 0;
    rows.slice(1).forEach(function (r) {
      const g = function (k) { return C[k] >= 0 ? String(r[C[k]] || '').trim() : ''; };
      const name = g('name'); if (!name) return;
      if (matchSupplier(D, name) >= 0) { skipped++; return; }
      const tt = g('type') + ' ' + g('foods'); const types = TYPES.filter(function (x) { return x[0].test(tt); }).map(function (x) { return x[1]; });
      const out = exports.run(D, 'supplier_add', { name: name, alias: g('alias'), loc: g('loc'), foods: g('foods'), reg: g('reg'), types: types }, c);
      if (out.error) return;
      const i = out.newSup;
      if (g('email')) exports.run(D, 'supplier_contact', { sup: i, emails: g('email') }, c);
      if (/^\d{7,10}$/.test(g('fei'))) { D.MON = D.MON || {}; D.MON[i] = D.MON[i] || { checked: '', fei: g('fei'), risk: ['Not rated', 'Not checked yet'], res: {}, reg: ['neutral', 'From the documents on file'], lacf: ['neutral', 'From the documents on file'], expo: [] }; D.MON[i].fei = g('fei'); }
      added++;
    });
    return { target: 'suppliers', msg: added + ' supplier(s) added' + (skipped ? ', ' + skipped + ' already in the list' : '') + '. Check each one’s food types and scoping answers.' };
  },
  plan_field: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const key = String(p.key || '').slice(0, 300); if (!key) return { error: 'no_field' };
    D.planFields = D.planFields || {}; const F = D.planFields[p.sup] || (D.planFields[p.sup] = {});
    const v = str(p.value, 2000);
    if (v) F[key] = v; else delete F[key];
    return { target: 'plan' + p.sup, msg: v ? 'Saved to the plan' : 'Field cleared' };
  },
  plan_sign: function (D, p, c) {
    if (!supOk(D, p.sup)) return { error: 'bad_supplier' };
    const s = D.SUP[p.sup]; const v = ((s.planVersions || []).length) + 1;
    s.planVersions = (s.planVersions || []).concat([[iso(c.now), 'Version ' + v + ' generated and signed by ' + c.user + ' (QI)']]);
    s.plan = { st: 'signed', date: fmt(iso(c.now)), review: addYears(iso(c.now), 3), file: 'FSVP plan v' + v + ', generated in FSVP Vault', issues: [] };
    s.planSigned = (s.planSigned || []).concat([{ at: iso(c.now), by: c.user, version: v, fileId: p.fileId || null, fields: JSON.parse(JSON.stringify((D.planFields || {})[p.sup] || {})) }]);
    return { target: 'sup' + p.sup, msg: 'Plan version ' + v + ' signed and saved' };
  },
  order: function (D, p, c) {
    D.orders = (D.orders || []).concat([{ at: iso(c.now), svc: str(p.svc, 40), sup: str(p.supName, 160), note: str(p.note, 600) }]);
    return { target: 'orders', msg: 'Request received. Nothing is charged in the demo.' };
  },
  support: function (D, p, c) {
    D.support = (D.support || []).concat([{ at: iso(c.now), msg: str(p.msg, 1000) }]);
    return { target: 'support', msg: 'Message saved' };
  },
  broker_sent: function (D, p, c) {
    D.brokerSent = { at: iso(c.now), to: str(p.to, 200) };
    return { target: 'broker', msg: 'Marked as sent to ' + (str(p.to, 200) || 'your broker') + '.' };
  },
  file_add: function (D, p, c) {
    const t = String(p.target || '');
    const tuple = [str(p.label, 200), p.expiry && /^\d{4}-\d{2}-\d{2}$/.test(p.expiry) ? p.expiry : null, p.expiry ? null : addYears(iso(c.now), 2), p.pending ? 'pending' : '', p.fileId];
    if (p.meta) tuple[5] = p.meta;
    let m;
    if ((m = t.match(/^slot:(\d+):([a-z]+)$/))) {
      const i = +m[1]; if (!supOk(D, i)) return { error: 'bad_supplier' };
      const sl = D.SUP[i].slots[m[2]] || (D.SUP[i].slots[m[2]] = { st: 'ok', det: [], files: [] });
      sl.files = sl.files || []; sl.files.unshift(tuple); return { target: t };
    }
    if ((m = t.match(/^opt:(\d+):([a-z]+)$/))) {
      const i = +m[1]; if (!supOk(D, i)) return { error: 'bad_supplier' };
      const sl = D.SUP[i].opt[m[2]] || (D.SUP[i].opt[m[2]] = { st: 'ok', det: [], files: [] });
      sl.files = sl.files || []; sl.files.unshift(tuple); return { target: t };
    }
    if ((m = t.match(/^qi:(\d+)$/))) {
      const it = D.QIFILE.items[+m[1]]; if (!it) return { error: 'bad_item' };
      it[1] = str(p.label, 200); it[2] = 'ok'; it[3] = 'On File'; it[4] = p.fileId; return { target: t };
    }
    if ((m = t.match(/^ship:([\w]+):(coa|process|other)$/))) {
      const sh = (D.SHIP || []).find(function (x) { return x.id === m[1]; }); if (!sh) return { error: 'no_shipment' };
      sh.files = sh.files || {}; sh.files[m[2]] = (sh.files[m[2]] || []).concat([[str(p.label, 200), p.fileId, iso(c.now)]]);
      return { target: t };
    }
    if ((m = t.match(/^vrec:([\w]+)$/))) {
      const r = D.VREC.find(function (x) { return x.id === m[1]; }); if (!r) return { error: 'no_record' };
      r.files = (r.files || []).concat([[str(p.label, 200), p.fileId]]); return { target: t };
    }
    return { error: 'bad_target' };
  }
};

exports.matchSupplier = function (D, n) { return matchSupplier(D, n); };
exports.run = function (D, type, p, ctx) {
  const h = H[type]; if (!h) return { error: 'unknown_action' };
  if (p.sup !== undefined) p.sup = parseInt(p.sup, 10);
  return h(D, p, ctx);
};
