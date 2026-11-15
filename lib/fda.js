// Live FDA checks: import alerts (accessdata.fda.gov pages) and recalls (openFDA food enforcement API).
// Node 22 built-in fetch. Import alert pages are cached on disk for 24 hours.
'use strict';
const fs = require('fs');
const path = require('path');

const IA_BASE = 'https://www.accessdata.fda.gov/cms_ia/';
const CC = { vietnam: 'VN', thailand: 'TH', china: 'CN', mexico: 'MX', india: 'IN', philippines: 'PH', indonesia: 'ID', malaysia: 'MY',
  taiwan: 'TW', korea: 'KR', 'south korea': 'KR', japan: 'JP', peru: 'PE', chile: 'CL', brazil: 'BR', colombia: 'CO', ecuador: 'EC',
  guatemala: 'GT', 'costa rica': 'CR', italy: 'IT', spain: 'ES', greece: 'GR', turkey: 'TR', canada: 'CA', 'sri lanka': 'LK', bangladesh: 'BD', pakistan: 'PK' };
const SUFFIX = /\b(co|company|ltd|limited|jsc|joint|stock|corp|corporation|inc|incorporated|llc|pte|plc|sa|s\.a|de|cv|gmbh|the|group|holdings?|trading|import|export|imp|exp|mtv|tnhh)\b/g;

function norm(s) { return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim(); }

// Names to search for: the legal name, the alias, and any extra names saved on the supplier
function searchTerms(s) {
  const raw = [s.name];
  // the alias field is free text, so only use it when it names a trading name
  const al = String(s.alias || '').match(/^(?:ships as|also known as|aka|a\.k\.a\.|trades as|dba|d\/b\/a)\s+(.+)$/i);
  if (al) raw.push(al[1]);
  (s.fdaNames || []).forEach(function (n) { raw.push(n); });
  const out = [];
  raw.forEach(function (r) { r = String(r).replace(/\(.*?\)/g, ' '); const n = norm(r); if (n.length >= 4 && out.indexOf(n) < 0) out.push(n); });
  return out;
}
function countryOf(s, fallback) {
  const loc = String(s.loc || '').toLowerCase();
  for (const k in CC) if (loc.indexOf(k) >= 0) return { name: k.replace(/\b\w/g, function (c) { return c.toUpperCase(); }), cc: CC[k] };
  return fallback;
}
function nameMatches(firm, terms) {
  const f = norm(firm); if (f.length < 4) return false;
  return terms.some(function (t) { return f.indexOf(t) >= 0 || (t.indexOf(f) >= 0 && f.length >= 6); });
}

async function get(url, ms, headers) {
  const ctl = new AbortController(); const t = setTimeout(function () { ctl.abort(); }, ms || 60000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (compatible; FSVPVault/0.1; +https://fsvpvault.com)' }, headers || {}) });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}

function cacheDir(dataDir) { const d = path.join(dataDir, 'cache'); fs.mkdirSync(d, { recursive: true }); return d; }
async function cached(dataDir, key, url) {
  const f = path.join(cacheDir(dataDir), key.replace(/[^a-z0-9_.-]/gi, '_'));
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs < 24 * 3600e3) return fs.readFileSync(f, 'utf8'); } catch (e) { /* not cached */ }
  const r = await get(url, 90000);
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ' for ' + url);
  fs.writeFileSync(f, r.text);
  return r.text;
}
function strip(h) { return h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim(); }

// List the import alerts that name firms from one country
async function alertsForCountry(dataDir, cc) {
  const html = await cached(dataDir, 'country_' + cc + '.html', IA_BASE + 'country_' + cc + '.html');
  const out = []; const re = /<tr[^>]*>([\s\S]*?)<\/tr>/gi; let m;
  while ((m = re.exec(html))) {
    const cells = m[1].split(/<\/t[dh]>/i).map(strip);
    const link = m[1].match(/href="(importalert_\d+\.html)"/i);
    if (link && /^\d{2}-\d{2,3}$/.test(cells[0] || '')) out.push({ num: cells[0], published: cells[2] || '', name: (cells[3] || '').replace(/^"|"$/g, ''), url: IA_BASE + link[1] });
  }
  return out;
}

// Firms on one alert page, tagged red / yellow / green by the section they sit in
function firmsOnAlert(html) {
  const marks = [];
  [['red', /a\.k\.a\.\s*Red List/gi], ['yellow', /a\.k\.a\.\s*Yellow List/gi], ['green', /a\.k\.a\.\s*Green List/gi]].forEach(function (x) {
    let m; while ((m = x[1].exec(html))) marks.push([m.index, x[0]]);
  });
  marks.sort(function (a, b) { return a[0] - b[0]; });
  const firms = []; const re = /<div class="div-info">([\s\S]*?)<\/div>\s*<\/div>/gi; let m;
  while ((m = re.exec(html))) {
    const nm = m[1].match(/<div class="div-name floatleft">([\s\S]*?)<\/div>/i);
    const dt = m[1].match(/Date Published\s*:\s*([0-9/]+)/i);
    const addr = m[1].match(/<div class="clear">([\s\S]*?)$/i);
    let list = 'red'; for (const k of marks) if (k[0] < m.index) list = k[1];
    if (nm) firms.push({ name: strip(nm[1]), published: dt ? dt[1] : '', address: addr ? strip(addr[1]) : '', list: list });
  }
  return firms;
}

async function checkImportAlerts(dataDir, s, country) {
  const terms = searchTerms(s);
  const alerts = await alertsForCountry(dataDir, country.cc);
  const hits = []; const errors = [];
  let i = 0;
  async function worker() {
    while (i < alerts.length) {
      const a = alerts[i++];
      try {
        const html = await cached(dataDir, 'ia_' + a.url.split('/').pop(), a.url);
        firmsOnAlert(html).forEach(function (f) {
          if (f.address.toUpperCase().indexOf(country.name.toUpperCase()) >= 0 && nameMatches(f.name, terms))
            hits.push({ alert: a.num, alertName: a.name, url: a.url, firm: f.name, list: f.list, published: f.published, address: f.address });
        });
      } catch (e) { errors.push(a.num + ': ' + e.message); }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { terms: terms, alerts: alerts.length, hits: hits, errors: errors, country: country.name, countryUrl: IA_BASE + 'country_' + country.cc + '.html' };
}

async function checkRecalls(s, apiKey) {
  const terms = searchTerms(s);
  if (!terms.length) return { terms: terms, hits: [], total: 0 };
  // FDA text often writes "&" where we normalise to "and"; drop it from the phrase so both forms match
  const q = terms.map(function (t) { const w = t.replace(/ and /g, ' '); return 'recalling_firm:"' + w + '" product_description:"' + w + '"'; }).join(' ');
  const url = 'https://api.fda.gov/food/enforcement.json?limit=100&sort=report_date:desc&search=' + encodeURIComponent(q) + (apiKey ? '&api_key=' + encodeURIComponent(apiKey) : '');
  const r = await get(url, 30000);
  if (r.status === 404) return { terms: terms, hits: [], total: 0 };
  if (r.status !== 200) throw new Error('openFDA HTTP ' + r.status);
  const j = JSON.parse(r.text);
  // openFDA matches loosely on words, so keep only records where the name really appears
  const hits = (j.results || []).filter(function (x) { return nameMatches(x.recalling_firm, terms) || terms.some(function (t) { return norm(x.product_description).indexOf(t) >= 0; }); })
    .map(function (x) { return { number: x.recall_number, firm: x.recalling_firm, country: x.country, date: x.report_date, cls: x.classification, status: x.status, product: String(x.product_description).slice(0, 160), reason: String(x.reason_for_recall).slice(0, 200) }; });
  return { terms: terms, hits: hits, total: hits.length };
}

// FDA warning letters: the same search the fda.gov warning letter page runs
const WL_PATH = '/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters';
async function searchWarningLetters(term) {
  const qs = new URLSearchParams({ search_api_fulltext: '"' + term + '"', draw: '1', start: '0', length: '50', _drupal_ajax: '1', _wrapper_format: 'drupal_ajax',
    pager_element: '0', view_args: '', view_display_id: 'warning_letter_solr_block', view_name: 'warning_letter_solr_index', view_path: WL_PATH,
    view_base_path: WL_PATH.slice(1) + '/datatables-data', view_dom_id: 'fsvpvault' });
  const r = await get('https://www.fda.gov/datatables/views/ajax?' + qs.toString(), 30000, { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' });
  if (r.status !== 200) throw new Error('fda.gov warning letters HTTP ' + r.status);
  const j = JSON.parse(r.text);
  return (j.data || []).map(function (row) {
    const link = String(row[2] || '').match(/href="([^"]+)"/);
    return { posted: strip(row[0] || ''), issued: strip(row[1] || ''), company: strip(row[2] || ''), office: strip(row[3] || ''), subject: strip(row[4] || ''),
      excerpt: strip(row[7] || ''), url: link ? 'https://www.fda.gov' + link[1] : '' };
  });
}
async function checkWarningLetters(s, importerName) {
  const terms = searchTerms(s);
  const imp = importerName ? searchTerms({ name: importerName }) : [];
  const seen = {}; const sup = []; const you = [];
  for (const t of terms.concat(imp)) {
    const rows = await searchWarningLetters(t);
    rows.forEach(function (x) {
      if (seen[x.url]) return;
      // keep letters addressed to the firm, or that name it in the letter text
      const hit = nameMatches(x.company, [t]) || norm(x.excerpt).indexOf(t) >= 0;
      if (!hit) return;
      seen[x.url] = 1; (imp.indexOf(t) >= 0 ? you : sup).push(x);
    });
  }
  return { terms: terms, importerTerms: imp, hits: sup, importerHits: you };
}

// FDA Data Dashboard API (refusals, inspections, compliance actions). Needs FDA_DD_USER and FDA_DD_KEY.
// Filters are exact-match, so we pull the supplier's whole country for recent years (cached a day) and match names locally.
const DD = 'https://api-datadashboard.fda.gov/v1/';
async function ddPost(endpoint, body, cred) {
  const ctl = new AbortController(); const t = setTimeout(function () { ctl.abort(); }, 90000);
  try {
    const r = await fetch(DD + endpoint, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', 'Authorization-User': cred.user, 'Authorization-Key': cred.key }, body: JSON.stringify(body) });
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* not json */ }
    if (r.status !== 200 || !j) throw new Error('Data Dashboard ' + endpoint + ' HTTP ' + r.status + (j && j.message ? ': ' + j.message : ''));
    if (Array.isArray(j)) { const m = j.find(function (x) { return x && x.message; }); if (m && !/success/i.test(m.message)) throw new Error('Data Dashboard ' + endpoint + ': ' + m.message); }
    return Array.isArray(j.result) ? j.result : [];
  } finally { clearTimeout(t); }
}
async function ddCountry(dataDir, endpoint, cc, dateCol, years, columns, cred) {
  const f = path.join(cacheDir(dataDir), 'dd_' + endpoint + '_' + cc + '.json');
  try { const st = fs.statSync(f); if (Date.now() - st.mtimeMs < 24 * 3600e3) return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* not cached */ }
  const from = new Date(Date.now() - years * 365.25 * 86400e3).toISOString().slice(0, 10);
  const filters = { CountryCode: [cc] }; filters[dateCol + 'From'] = [from];
  let all = [];
  for (let page = 0; page < 6; page++) {
    const rows = await ddPost(endpoint, { start: page * 5000 + 1, rows: 5000, sort: dateCol, sortorder: 'DESC', returntotalcount: false, filters: filters, columns: columns }, cred);
    all = all.concat(rows); if (rows.length < 5000) break;
  }
  fs.writeFileSync(f, JSON.stringify(all));
  return all;
}
async function checkDataDashboard(dataDir, s, country, fei, cred) {
  const terms = searchTerms(s);
  const rawRef = await ddCountry(dataDir, 'import_refusals', country.cc, 'RefusalDate', 3, ['FEINumber', 'FirmName', 'City', 'CountryName', 'ProductCode', 'ProductCodeDescription', 'RefusalDate', 'ShipmentID', 'RefusalCharges', 'DistrictCode'], cred);
  const rawInsp = await ddCountry(dataDir, 'inspections_classifications', country.cc, 'InspectionEndDate', 6, ['FEINumber', 'LegalName', 'City', 'InspectionID', 'InspectionEndDate', 'Classification', 'ClassificationCode', 'ProjectArea', 'ProductType', 'PostedCitations'], cred);
  const rawCa = await ddCountry(dataDir, 'compliance_actions', country.cc, 'ActionTakenDate', 6, ['FEINumber', 'LegalName', 'City', 'ActionType', 'ActionTakenDate', 'ProductType', 'Center'], cred);
  // FEI numbers: the one on file, plus any FEI whose records match the supplier's name; then match every dataset by FEI or name
  const feiSet = {}; if (fei) feiSet[String(fei)] = 1;
  rawRef.concat(rawInsp, rawCa).forEach(function (r) { if (r.FEINumber && nameMatches(r.FirmName || r.LegalName, terms)) feiSet[String(r.FEINumber)] = 1; });
  const mine = function (r) { return (r.FEINumber && feiSet[String(r.FEINumber)]) || nameMatches(r.FirmName || r.LegalName, terms); };
  const ref = rawRef.filter(mine), insp = rawInsp.filter(mine), ca = rawCa.filter(mine);
  let cit = [];
  const ids = insp.filter(function (x) { return x.PostedCitations && !/^no$/i.test(String(x.PostedCitations).trim()); }).map(function (x) { return String(x.InspectionID); });
  if (ids.length) cit = await ddPost('inspections_citations', { start: 1, rows: 500, sort: 'InspectionEndDate', sortorder: 'DESC', filters: { InspectionID: ids.slice(0, 20) }, columns: ['InspectionID', 'InspectionEndDate', 'ActCFRNumber', 'ShortDescription'] }, cred);
  const feis = {}; ref.concat(insp, ca).forEach(function (x) { if (x.FEINumber) feis[x.FEINumber] = (feis[x.FEINumber] || 0) + 1; });
  return { refusals: ref, inspections: insp, citations: cit, actions: ca, feis: Object.keys(feis) };
}
exports.ddTest = async function (cred) {
  const r = await ddPost('import_refusals', { start: 1, rows: 1, sort: 'RefusalDate', sortorder: 'DESC', returntotalcount: true, filters: { CountryCode: ['TH'] }, columns: ['FirmName', 'RefusalDate'] }, cred);
  return r.length ? 'ok, latest Thailand refusal ' + r[0].RefusalDate : 'ok, no rows';
};

function hx(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function ymd(d) { d = String(d || ''); return d.length === 8 ? d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6) : d; }

// Run both checks for one supplier and write the results into the workspace's monitor record
// Fetch everything for one supplier, keep the raw hits, then build the readable results with summarize()
exports.checkSupplier = async function (D, i, opts) {
  const s = D.SUP[i];
  const fallback = { name: (D.company && D.company.country) || 'Vietnam', cc: (D.company && D.company.cc) || 'VN' };
  const country = countryOf(s, fallback);
  const now = new Date();
  D.MON = D.MON || {};
  const M = D.MON[i] || (D.MON[i] = { checked: '', fei: '', risk: ['Not rated', 'Not checked yet'], res: {}, reg: ['neutral', 'From the documents on file'], lacf: ['neutral', 'From the documents on file'], expo: [] });
  M.res = M.res || {};
  const before = M.live ? matchKeys(M) : null;
  const live = { at: now.toISOString(), country: country.name };
  try { live.ia = await checkImportAlerts(opts.dataDir, s, country); } catch (e) { live.iaError = e.message; }
  try { live.rec = await checkRecalls(s, opts.openfdaKey); } catch (e) { live.recError = e.message; }
  try { live.wl = await checkWarningLetters(s, D.company && D.company.name); } catch (e) { live.wlError = e.message; }
  if (opts.dd && opts.dd.user && opts.dd.key) {
    try {
      const dd = await checkDataDashboard(opts.dataDir, s, country, /^\d{7,10}$/.test(String(M.fei || '')) ? M.fei : '', opts.dd);
      live.dd = { refusals: dd.refusals, inspections: dd.inspections, citations: dd.citations, actions: dd.actions, feis: dd.feis };
      if (!/^\d{7,10}$/.test(String(M.fei || '')) && dd.feis.length === 1) M.fei = dd.feis[0];
    } catch (e) { live.ddError = e.message; }
  }
  // keep the previous result for any source that failed this time
  if (M.live) ['ia', 'rec', 'wl', 'dd'].forEach(function (k) { if (live[k + 'Error'] && M.live[k]) live[k] = M.live[k]; });
  M.checked = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
  M.live = live;
  exports.summarize(D, i);
  const after = matchKeys(M);
  const fresh = before ? Object.keys(after).filter(function (k) { return !before[k]; }).map(function (k) { return after[k]; }) : [];
  const ok = !live.iaError && !live.recError && !live.wlError && !live.ddError;
  return { ok: ok, fresh: fresh, msg: ok ? 'FDA check done' + (live.dd ? ': import alerts, recalls, warning letters, refusals and inspections updated' : ': import alerts, recalls and warning letters updated') + (fresh.length ? '. ' + fresh.length + ' new finding(s)' : '') : 'FDA check finished with errors: ' + [live.iaError, live.recError, live.wlError, live.ddError].filter(Boolean).join('; ') };
};

// every finding that hasn't been marked "Not this supplier", keyed so it can be compared between checks
function matchKeys(M) { const o = {}; Object.keys(M.matches || {}).forEach(function (row) { (M.matches[row] || []).forEach(function (m) { if (m.v !== 'not') o[m.k] = m.label; }); }); return o; }

// Build the readable monitor rows from the raw hits, leaving out findings the QI marked "Not this supplier"
exports.summarize = function (D, i) {
  const M = D.MON[i]; if (!M || !M.live) return;
  const L = M.live, V = M.verdicts || {}, s = D.SUP[i];
  const keep = function (k) { return V[k] !== 'not'; };
  M.matches = {};
  const add = function (row, k, label) { (M.matches[row] = M.matches[row] || []).push({ k: k, label: label, v: V[k] || '' }); };
  const dropped = function (row) { return (M.matches[row] || []).filter(function (m) { return m.v === 'not'; }).length; };
  const note = function (row) { const n = dropped(row); return n ? ' (' + n + ' match' + (n === 1 ? '' : 'es') + ' marked not this supplier)' : ''; };

  if (L.ia) {
    const ia = L.ia; const hits = ia.hits.filter(function (h) { const k = 'ia:' + h.alert + ':' + String(h.firm).toLowerCase().trim() + '|' + norm(h.address).slice(0, 60); add('ia', k, 'Import Alert ' + h.alert + ', ' + h.list + ' list: “' + h.firm + '”, ' + h.address); return keep(k); });
    const red = hits.filter(function (h) { return h.list === 'red'; }), yel = hits.filter(function (h) { return h.list === 'yellow'; }), grn = hits.filter(function (h) { return h.list === 'green'; });
    const desc = function (h) { return 'Import Alert ' + h.alert + ' (' + h.list + ' list' + (h.published ? ', since ' + h.published : '') + '): listed as “' + hx(h.firm) + '”'; };
    if (red.length) M.res.ia = ['bad', red.map(desc).join('; ') + '. Shipments can be detained without examination. Confirm it’s the same facility by address: ' + hx(red[0].address) + note('ia'), red.length + ' red list'];
    else if (yel.length) M.res.ia = ['warn', yel.map(desc).join('; ') + note('ia'), 'Yellow list'];
    else if (grn.length) M.res.ia = ['ok', grn.map(desc).join('; ') + '. Green list means the firm is exempt from detention under that alert.' + note('ia'), 'Green list only'];
    else M.res.ia = ['ok', 'No match. Searched the red, yellow and green lists of all ' + ia.alerts + ' import alerts that list ' + hx(ia.country || L.country) + ' firms for: ' + ia.terms.map(hx).join(', ') + note('ia') + (ia.errors && ia.errors.length ? '. ' + ia.errors.length + ' alert page(s) couldn’t be read; run again later' : ''), 'Clear'];
    M.res.ia.push('live');
  }
  if (L.rec) {
    const hits = L.rec.hits.filter(function (h) { const k = 'rec:' + h.number; add('rec', k, h.cls + ' recall ' + h.number + ', ' + ymd(h.date) + ': ' + h.firm + ' · ' + h.product); return keep(k); });
    if (hits.length) {
      const top = hits.slice(0, 3).map(function (h) { return h.cls + ' recall ' + h.number + ' (' + ymd(h.date) + ', ' + h.status + '): ' + hx(h.firm + ' · ' + h.reason); }).join('; ');
      M.res.rec = [hits.some(function (h) { return h.cls === 'Class I'; }) ? 'bad' : 'warn', hits.length + ' FDA food recall record(s) naming this firm. ' + top + note('rec'), hits.length + ' recall' + (hits.length === 1 ? '' : 's'), 'live'];
    } else M.res.rec = ['ok', 'No FDA food recalls (openFDA enforcement reports, 2012 to date) naming: ' + L.rec.terms.map(hx).join(', ') + note('rec'), 'Clear', 'live'];
  }
  if (L.wl) {
    const wl = L.wl;
    const one = function (x) { return hx(x.issued + ': ' + x.company + ' (' + x.subject.replace(/\s*\/\s*/g, ', ') + ')') + (x.url ? ' <a href="' + hx(x.url) + '" target="_blank" rel="noopener">letter</a>' : ''); };
    const hits = wl.hits.filter(function (x) { const k = 'wl:' + x.url; add('wl', k, 'Warning letter ' + x.issued + ': ' + x.company + ' (' + x.subject + ')'); return keep(k); });
    const you = (wl.importerHits || []).filter(function (x) { const k = 'wly:' + x.url; add('wl', k, 'Letter naming ' + (D.company && D.company.name) + ', ' + x.issued + ': ' + x.company); return keep(k); });
    const youTxt = wl.importerTerms && wl.importerTerms.length ? (you.length ? ' Letters naming ' + hx(D.company.name) + ': ' + you.map(one).join('; ') + '.' : ' None naming ' + hx(D.company.name) + '.') : '';
    if (hits.length) M.res.wl = ['bad', hits.length + ' warning letter(s): ' + hits.slice(0, 3).map(one).join('; ') + '.' + youTxt + note('wl'), hits.length + ' letter' + (hits.length === 1 ? '' : 's'), 'live'];
    else M.res.wl = [you.length ? 'warn' : 'ok', 'No FDA warning letters to or naming: ' + wl.terms.map(hx).join(', ') + '.' + youTxt + note('wl'), you.length ? 'Letter to you' : 'Clear', 'live'];
  }
  if (L.dd && Array.isArray(L.dd.refusals)) {
    const dd = L.dd;
    const feiOk = function (r) { return keep('fei:' + r.FEINumber); };
    const feis = {}; dd.refusals.concat(dd.inspections, dd.actions).forEach(function (r) { if (r.FEINumber && !feis[r.FEINumber]) feis[r.FEINumber] = r.FirmName || r.LegalName; });
    Object.keys(feis).forEach(function (f) { add('ref', 'fei:' + f, 'FEI ' + f + ': “' + feis[f] + '” (refusals, inspections and actions under this FEI)'); });
    const byDate = function (k) { return function (a, b) { return String(b[k]).localeCompare(String(a[k])); }; };
    const r = dd.refusals.filter(feiOk).sort(byDate('RefusalDate'));
    if (r.length) M.res.ref = ['bad', r.length + ' refusal(s) in the last 3 years. ' + r.slice(0, 4).map(function (x) { return hx(x.RefusalDate + ' · FEI ' + x.FEINumber + ' · ' + x.ProductCode + ' (' + String(x.ProductCodeDescription || '').trim() + ') · charges ' + (x.RefusalCharges || 'not listed') + ' · ' + (x.DistrictCode || '')); }).join('; ') + (r.length > 4 ? '; and ' + (r.length - 4) + ' more' : '') + '. Charge numbers are FDA refusal charge codes.' + note('ref'), r.length + ' refusal' + (r.length === 1 ? '' : 's'), 'live'];
    else M.res.ref = ['ok', 'No import refusals in the last 3 years for this firm (FDA Data Dashboard, matched by ' + (M.fei ? 'FEI ' + hx(M.fei) + ' and ' : '') + 'name).' + note('ref'), 'None', 'live'];
    const ins = dd.inspections.filter(feiOk).sort(byDate('InspectionEndDate')), acts = dd.actions.filter(feiOk);
    const actTxt = acts.length ? '. Compliance actions: ' + acts.slice(0, 3).map(function (a) { return hx(a.ActionTakenDate + ' ' + a.ActionType); }).join('; ') : '';
    if (ins.length) {
      const worst = ins.some(function (x) { return /OAI/i.test(x.ClassificationCode || x.Classification); }) ? 'bad' : (ins.some(function (x) { return /VAI/i.test(x.ClassificationCode || x.Classification); }) ? 'warn' : 'ok');
      const cits = (dd.citations || []).map(function (c) { return hx(c.ActCFRNumber + ' ' + (c.ShortDescription || '')); });
      M.res.insp = [worst, ins.slice(0, 3).map(function (x) { return hx(x.InspectionEndDate + ': ' + (x.ClassificationCode || x.Classification) + ' (' + (x.ProjectArea || x.ProductType || '') + ')'); }).join('; ') + (cits.length ? '. Citations: ' + cits.slice(0, 5).join('; ') : '') + actTxt, String(ins[0].ClassificationCode || ins[0].Classification || 'Inspected'), 'live'];
    } else M.res.insp = [acts.length ? 'bad' : 'neutral', 'No FDA inspections of this firm in the last 6 years' + actTxt + ' (FDA Data Dashboard).', acts.length ? 'Action on file' : 'None on record', 'live'];
  }
};
exports._test = { norm: norm, searchTerms: searchTerms, firmsOnAlert: firmsOnAlert, nameMatches: nameMatches, countryOf: countryOf };
