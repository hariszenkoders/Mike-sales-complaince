// Builds seed/demo.json: an invented importer and three invented suppliers.
// Every name, number and finding here is fictional sample data for demos.
const fs = require('fs');
const path = require('path');

const F = (label, exp, old) => old ? [label, exp, null, 'old'] : [label, exp];

const SUP = [
  {
    name: 'Siam Coast Canning Co., Ltd.', alias: 'Sample supplier', loc: 'Samut Sakhon, Thailand',
    ships: 24, foods: 'Coconut water (330 ml cans); coconut milk (400 ml cans)', reg: 'DEMO-10000001 (sample)',
    plan: { st: 'signed', date: 'Feb 3, 2025', review: '2028-02-03', file: 'FSVP plan, Siam Coast Canning (sample)', issues: ['Doesn’t name the scheduled process for the 400 ml coconut milk can size'] },
    slots: {
      gfsi: { st: 'ok', det: ['FSSC 22000 v6 · sample certification body · valid to Mar 2028'], files: [F('FSSC 22000 certificate (sample)', '2028-03-14')] },
      audit: { st: 'ok', det: ['Recertification audit Mar 2026: 0 major, 2 minor, both closed'], files: [F('FSSC 22000 audit report, Mar 2026 (sample)', '2027-03-12')] },
      fdareg: { st: 'ok', det: ['Registration renewed Oct 2026'], files: [F('FDA food facility registration (sample)', '2028-12-31')] },
      lacf: { st: 'warn', det: ['FCE and SID on file for 330 ml coconut water', 'No SID on file for the 400 ml coconut milk can'], files: [F('FCE and SID, coconut water 330 ml (sample)', null)] },
      haccp: { st: 'ok', det: ['Retort CCP with critical limits from the process authority letter'], files: [F('HACCP plan rev. 7 (sample)', null)] },
      process: { st: 'missing', det: ['Retort records for the last shipped lots aren’t on file'] },
      coa: { st: 'ok', det: [], files: [F('COA lot SC-2609-14 (sample)', '2028-09-01')] }
    },
    opt: { halal: { st: 'ok', det: ['Sample halal certificate'], files: [F('Halal certificate (sample)', '2027-06-30')] } },
    hz: [
      ['Coconut water, cans', 'C. botulinum (low-acid, shelf-stable)', 'Supplier: retort per filed scheduled process', 'Retort records per lot; FCE/SID on file'],
      ['Coconut milk, cans', 'C. botulinum (low-acid, shelf-stable)', 'Supplier: retort [SID NEEDED FOR 400 ML]', '[PROCESS RECORDS NEEDED]'],
      ['All products', 'Can seam defects', 'Supplier: seam teardown every 4 hours', 'Seam records reviewed annually']
    ],
    certs: 'FSSC 22000 v6 valid to Mar 2028 (sample). Halal to Jun 2027 (sample).',
    audit: 'Recertification Mar 2026: certified, 2 minor findings closed (sample).',
    rec: 'Approve with conditions: get the SID for the 400 ml coconut milk can and retort records for shipped lots.',
    verif: 'Both foods are low-acid canned foods: verify and document that each lot was made under its filed scheduled process (21 CFR 113; 1.502(b)). Other hazards: annual records review.',
    req: [['SID for coconut milk 400 ml', '2026-11-15', 'High', 'Needed before the next shipment'], ['Retort records, lots shipped Sep–Oct 2026', '2026-11-30', 'Medium', '']]
  },
  {
    name: 'Chao Phraya Fruit Products Co., Ltd.', alias: 'Sample supplier', loc: 'Ratchaburi, Thailand',
    ships: 9, foods: 'Pineapple juice, not from concentrate (1 L cartons)', reg: 'DEMO-10000002 (sample)',
    plan: { st: 'none', date: '', review: '', file: '', issues: [] },
    slots: {
      gfsi: { st: 'expired', det: ['BRCGS certificate lapsed Aug 2026; renewal audit booked (sample)'], files: [F('BRCGS certificate (sample)', '2026-08-20')] },
      haccp: { st: 'warn', det: ['Juice HACCP plan on file; the 5-log pathogen reduction isn’t validated'], files: [F('Juice HACCP plan (sample)', null)] },
      quest: { st: 'ok', det: [], files: [F('Supplier questionnaire (sample)', '2027-05-01')] }
    },
    opt: {},
    hz: [
      ['Pineapple juice', 'Vegetative pathogens (E. coli O157:H7, Salmonella)', 'Supplier: pasteurization, 5-log reduction [VALIDATION NEEDED]', 'Juice HACCP records'],
      ['Pineapple juice', 'Patulin, pesticide residues', 'Supplier: raw fruit specification and testing', 'COA per lot']
    ],
    certs: 'BRCGS lapsed Aug 2026 (sample).',
    audit: 'No current audit report on file (sample).',
    rec: 'Hold approval until the renewed BRCGS certificate and the pasteurization validation arrive.',
    verif: 'Juice is covered by 21 CFR 120. If the supplier complies with Juice HACCP, the food is exempt from FSVP (1.501) and the importer rules in 120.14 apply instead.',
    req: [['BRCGS certificate (renewal)', '2026-10-31', 'High', 'Lapsed Aug 2026'], ['Pasteurization validation study', '2026-11-30', 'High', ''], ['FDA food facility registration', '2026-12-31', 'Medium', '']]
  },
  {
    name: 'Golden Lotus Sauce Co., Ltd.', alias: 'Sample supplier', loc: 'Nonthaburi, Thailand',
    ships: 15, foods: 'Sweet chili sauce (300 ml glass bottles)', reg: 'DEMO-10000003 (sample)',
    plan: { st: 'signed', date: 'Jan 10, 2026', review: '2029-01-10', file: 'FSVP plan, Golden Lotus (sample)', issues: [] },
    slots: {
      gfsi: { st: 'ok', det: ['SQF Food Safety Code, Edition 9 · valid to Jan 2027 (sample)'], files: [F('SQF certificate (sample)', '2027-01-25')] },
      audit: { st: 'ok', det: ['SQF audit Jan 2026: score 94 (sample)'], files: [F('SQF audit report, Jan 2026 (sample)', '2027-01-20')] },
      fdareg: { st: 'ok', det: [], files: [F('FDA food facility registration (sample)', '2026-12-31')] },
      lacf: { st: 'ok', det: ['Acidified food: FCE and SID on file (21 CFR 114)'], files: [F('FCE and SID, sweet chili sauce (sample)', null)] },
      haccp: { st: 'ok', det: [], files: [F('Food safety plan rev. 3 (sample)', null)] },
      label: { st: 'ok', det: ['Label lists soy (from soy sauce)'], files: [F('Label review, sweet chili sauce (sample)', null)] }
    },
    opt: { kosher: { st: 'missing', det: [] } },
    hz: [
      ['Sweet chili sauce', 'C. botulinum (acidified food)', 'Supplier: pH ≤ 4.6 and hot fill per filed process', 'pH records per batch'],
      ['Sweet chili sauce', 'Undeclared allergen (soy)', 'Supplier: label control', 'Label review'],
      ['Sweet chili sauce', 'Glass fragments', 'Supplier: bottle inspection', 'Annual records review']
    ],
    certs: 'SQF Edition 9 valid to Jan 2027 (sample).',
    audit: 'SQF Jan 2026: score 94, no major findings (sample).',
    rec: 'Approve. Annual records review of pH and fill records.',
    verif: 'Acidified food: verify the pH and hot-fill records against the filed process (21 CFR 114). Annual records review.',
    req: []
  }
];

const mon = (risk, ia, ref, insp, reg, lacf, expo) => ({
  checked: 'Oct 20, 2026', fei: 'DEMO (sample)', risk,
  res: { ia, ref, wl: ['ok', 'No warning letters (sample result)', 'Clear'], rec: ['ok', 'No recalls (sample result)', 'Clear'], insp },
  reg, lacf, expo
});

const D = {
  company: {
    name: 'Harbor Lane Foods, Inc.', short: 'Harbor Lane', initials: 'HL', qiName: 'Jordan Rivera', qiTitle: 'Director of Quality',
    ships: 48, port: 'Oakland, CA', origin: 'All in Thailand', plan: 'Starter', country: 'Thailand', cc: 'TH', lang: 'Thai',
    reqNote: 'sample data',
    sourceNote: 'Sample workspace. Harbor Lane Foods and its suppliers are invented; every name, number and finding is fictional.'
  },
  SUP,
  ATTN: [
    { t: 'Siam Coast: no process filing for the 400 ml coconut milk can', s: 'A low-acid canned food without a SID can be refused under Import Alert 99-37', k: 'bad', to: 'supplier', sel: 0, sup: 0 },
    { t: 'Chao Phraya’s BRCGS certificate lapsed in Aug 2026', s: 'Hold approval until the renewal arrives', k: 'warn', to: 'supplier', sel: 1, sup: 1 },
    { t: 'Retort deviation at Siam Coast is still open', s: 'Corrective action opened Oct 2, 2026', k: 'warn', to: 'capa', sup: 0 }
  ],
  MON: {
    0: mon(['Medium', 'One low-acid product without a process filing (sample result)'], ['ok', 'No match on any import alert (sample result)', 'Clear'], ['ok', 'No refusals in the last 24 months (sample result)', 'None'], ['neutral', 'No FDA inspection on record (sample result)', 'None on record'], ['ok', 'Registration valid through Dec 31, 2026 (sample)'], ['warn', 'Coconut milk 400 ml: no SID on file (sample)'], ['Coconut milk, cans']),
    1: mon(['Medium', 'One refusal in 2025 for filth (sample result)'], ['ok', 'No match on any import alert (sample result)', 'Clear'], ['warn', '1 refusal: Jun 2025, filth (sample result)', '1 refusal'], ['neutral', 'No FDA inspection on record (sample result)', 'None on record'], ['warn', 'No 2026 registration certificate on file (sample)'], ['ok', 'Not a low-acid or acidified food'], []),
    2: mon(['Low', 'Nothing found (sample result)'], ['ok', 'No match on any import alert (sample result)', 'Clear'], ['ok', 'No refusals (sample result)', 'None'], ['ok', 'FDA inspection Mar 2025: NAI (sample result)', 'NAI'], ['ok', 'Registration valid through Dec 31, 2026 (sample)'], ['ok', 'FCE and SID on file (sample)'], [])
  },
  PROFILE: {
    0: { foods: [['lacf', 'Coconut water and coconut milk, cans', 'Low-acid, retorted']], sahcodha: 'C. botulinum in canned low-acid foods', buyer: '' },
    1: { foods: [['juice', 'Pineapple juice', 'Juice beverage']], sahcodha: 'Pathogens in unpasteurized juice', buyer: '' },
    2: { foods: [['af', 'Sweet chili sauce', 'Acidified']], sahcodha: 'C. botulinum in acidified foods', buyer: '' }
  },
  FR: {
    0: [['1 low-acid product with no process filing (Import Alert 99-37 exposure)', 10]],
    1: [['1 import refusal in the last 24 months', 15], ['No 2026 registration certificate', 10]],
    2: []
  },
  APPROVAL: {
    0: { st: 'cond', date: '2025-02-03', basis: 'FSVP plan; FSSC 22000 certificate and audit (sample)', cond: ['Send the SID for coconut milk 400 ml', 'Send retort records for shipped lots'], reeval: '2028-02-03', trig: '', log: [['2025-02-03', 'Approved with conditions by Jordan Rivera (QI)']] },
    1: { st: 'pending', basis: '', cond: [], reeval: '', trig: 'BRCGS certificate lapsed Aug 2026', log: [['2026-08-21', 'Certificate lapsed; approval on hold']] },
    2: { st: 'ok', date: '2026-01-10', basis: 'FSVP plan; SQF certificate and audit (sample)', cond: [], reeval: '2029-01-10', trig: '', log: [['2026-01-10', 'Approved by Jordan Rivera (QI)']] }
  },
  UPCODE: ['HLF-SIAM-4K2P', 'HLF-CHAO-8M1D', 'HLF-LOTU-2X7Q'],
  SCOPE: [
    { id: 'sd0', sup: 0, food: 'Coconut water and coconut milk, cans', a: { imp: ['Yes', 'Harbor Lane is the U.S. owner at entry (sample)'], ex: ['No', 'Not covered by an exemption'], lacf: ['Yes', 'Low-acid, retorted, shelf-stable: Part 113 applies'], mod: ['No', 'Not a very small importer'], cust: ['No', 'Sold to consumers as is'] }, out: ['ok', 'Standard FSVP + Part 113', 'For C. botulinum, verify the filed scheduled process (1.502(b)); other hazards under standard FSVP'] },
    { id: 'sd1', sup: 1, food: 'Pineapple juice', a: { imp: ['Yes', 'Harbor Lane is the U.S. owner at entry (sample)'], ex: ['Possibly', 'Juice HACCP (Part 120) exemption if the supplier complies'], lacf: ['No', 'Juice, not low-acid canned'], mod: ['No', ''], cust: ['No', ''] }, out: ['warn', 'Juice HACCP path (pending)', 'Exempt under 1.501 once the QI confirms Part 120 compliance'] },
    { id: 'sd2', sup: 2, food: 'Sweet chili sauce', a: { imp: ['Yes', 'Harbor Lane is the U.S. owner at entry (sample)'], ex: ['No', ''], lacf: ['No', 'Acidified food under Part 114, not Part 113'], mod: ['No', ''], cust: ['No', ''] }, out: ['ok', 'Standard FSVP', 'Verify pH and fill records'] }
  ],
  IMPID: [['Legal name', 'Harbor Lane Foods, Inc.'], ['Address', '100 Sample Way, Oakland, CA 94607 (fictional)'], ['FSVP contact email', '[ENTER EMAIL FOR ENTRY FILINGS]'], ['DUNS number', '[ENTER DUNS NUMBER]']],
  QIFILE: {
    name: 'Jordan Rivera', role: 'Director of Quality',
    items: [['Training', 'FSPCA FSVP course (sample)', 'ok', 'On File'], ['Résumé showing education and experience', 'Not uploaded yet', 'missing', 'Upload'], ['Language of supplier records', 'English and Thai: note who translates Thai records', 'warn', 'Upload note']],
    note: 'The FSPCA course is evidence of training. It doesn’t make someone a QI by itself: the QI needs the education, training or experience to do each activity, and must be able to read the records (21 CFR 1.503).'
  },
  VREC: [
    { id: 'vd1', sup: 0, type: 'audit', title: 'FSSC 22000 recertification audit, Mar 2026', src: 'FSSC 22000 audit report (sample)', f: [['Audit procedures', 'FSSC 22000 v6 recertification (sample)'], ['Auditor and qualification', '[AUDITOR NAME FROM REPORT]'], ['Audit dates', 'Mar 10–12, 2026'], ['Conclusions', 'Certified. 0 major, 2 minor'], ['Corrective actions for significant deficiencies', 'None significant'], ['Covers the applicable FDA rules', '[CONFIRM]']] },
    { id: 'vd2', sup: 2, type: 'review', title: 'Annual records review, pH and fill records 2026', src: 'Batch records Jan–Jun 2026 (sample)', f: [['Records reviewed', 'pH and hot-fill records, 26 batches'], ['Conclusions', 'All batches pH ≤ 4.2; fill temperature in limits'], ['Corrective actions', 'None needed']] }
  ],
  CAPA: [[0, 'Retort records review', 'Retort temperature dipped below the scheduled minimum for 4 minutes on lot SC-2609-11 (sample). No deviation record.', '2026-10-02', 'open', 'Get the process authority’s evaluation and confirm the lot was held.']],
  PLANREV: { 0: { doc: 'HACCP plan rev. 7 (sample)', st: ['y', 'y', 'y', 'q', 'y', 'q', 'y', 'q', 'n'], note: 'Coconut milk 400 ml is missing from the process section.' } },
  removed: {},
  sig: {},
  QI: 'Jordan Rivera, Director of Quality · FSPCA FSVP training (sample)',
  IMPORTER: 'Harbor Lane Foods, Inc., 100 Sample Way, Oakland, CA 94607 (fictional)'
};

fs.writeFileSync(path.join(__dirname, 'demo.json'), JSON.stringify(D, null, 1));
console.log('wrote seed/demo.json');
