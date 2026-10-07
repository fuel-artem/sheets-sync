// Runs the library in Node with the Apps Script globals stubbed: no network, no
// credentials. `node library/test/run.js` - exits non-zero on the first failure.

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILES = ['A1', 'Errors', 'Retry', 'Client', 'Settings', 'Database', 'Sync', 'Values', 'Main'];
const source = FILES.map((f) => fs.readFileSync(path.join(__dirname, '..', f + '.gs'), 'utf8')).join('\n');

const logs = [];
const context = vm.createContext({
  console: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m), log: (m) => logs.push(m) },
  Utilities: {
    DigestAlgorithm: { MD5: 'md5' },
    Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, text) => Array.from(crypto.createHash(alg).update(text, 'utf8').digest()),
    base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    formatDate: (date, tz) => tz + '|' + date.toISOString(),
    sleep: () => {},
  },
  UrlFetchApp: { fetch: () => { throw new Error('no network in tests'); } },
  ScriptApp: { getOAuthToken: () => 'TOKEN' },
});
// Classes and consts are lexical, so they are not on the global object; export them.
vm.runInContext(source + `
globalThis.lib = { HttpError_, NetworkError_, TransientError_, PermanentError_, SheetsClient_,
  DATABASE_DEFAULTS_, MAX_ATTEMPTS_, STATE_PREFIX_ };`, context);
const g = context;
const { HttpError_, NetworkError_, TransientError_, PermanentError_, SheetsClient_ } = g.lib;

// Objects made inside the vm have its prototypes, so compare their JSON form.
const plain = (x) => JSON.parse(JSON.stringify(x));
const same = (actual, expected, message) => assert.deepStrictEqual(plain(actual), plain(expected), message);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (exc) {
    console.error('FAIL ' + name + '\n' + (exc.stack || exc));
    console.error(logs.slice(-10).join('\n'));
    process.exit(1);
  }
}

function http(status, { reason, canonical, retryAfter, message } = {}) {
  const error = { code: status, message: message || 'boom' };
  if (reason) error.errors = [{ reason: reason }];
  if (canonical) error.status = canonical;
  return new HttpError_(status, JSON.stringify({ error: error }), retryAfter != null ? { 'Retry-After': String(retryAfter) } : {});
}

function clock(overrides) {
  return Object.assign({ t: 0, now() { return this.t; }, sleep(ms) { this.slept.push(ms); this.t += ms; },
    slept: [], startCutoff: 180000, deadline: 300000 }, overrides);
}

const SRC = 'https://docs.google.com/spreadsheets/d/SRCID/edit#gid=11';
const DST = 'https://docs.google.com/spreadsheets/d/DSTID/edit#gid=22';

// ------------------------------------------------------------------------ A1

test('urls', () => {
  assert.strictEqual(g.spreadsheetIdFromUrl_(SRC), 'SRCID');
  assert.strictEqual(g.spreadsheetIdFromUrl_('1WYcqXj4W6Z5lWKxc_-Y8xmct5Nc'), '1WYcqXj4W6Z5lWKxc_-Y8xmct5Nc');
  assert.throws(() => g.spreadsheetIdFromUrl_('nope'), PermanentError_);
  assert.strictEqual(g.sheetGidFromUrl_(SRC), 11);
  assert.strictEqual(g.sheetGidFromUrl_('https://docs.google.com/spreadsheets/d/X/edit'), 0);
});

test('a1', () => {
  assert.strictEqual(g.indexToColumn_(0), 'A');
  assert.strictEqual(g.indexToColumn_(26), 'AA');
  assert.strictEqual(g.indexToColumn_(41), 'AP');
  assert.strictEqual(g.columnToIndex_('AA'), 26);
  same(g.parseA1_('A2:H', 5), { sheetId: 5, startRow: 1, endRow: null, startCol: 0, endCol: 8 });
  same(g.parseA1_('B3', 5), { sheetId: 5, startRow: 2, endRow: 3, startCol: 1, endCol: 2 });
  same(g.parseA1_('H10:A2', 0), g.parseA1_('A2:H10', 0));
  assert.strictEqual(g.gridToA1_(g.parseA1_('A2:H'), "It's"), "'It''s'!A2:H");
  same(g.splitSheetTitle_("'It''s'!A1:B"), ["It's", 'A1:B']);
  same(g.splitSheetTitle_('A1:B'), [null, 'A1:B']);
  assert.throws(() => g.parseA1_('A1:B2:C3'), PermanentError_);
});

// -------------------------------------------------------------------- errors

test('classification', () => {
  const cases = [
    [http(503, { canonical: 'UNAVAILABLE' }), TransientError_],
    [http(500, { reason: 'backendError' }), TransientError_],
    [http(429, { reason: 'rateLimitExceeded' }), TransientError_],
    [http(403, { reason: 'userRateLimitExceeded' }), TransientError_],
    [http(403, { reason: 'permissionDenied' }), PermanentError_],
    [http(429, { reason: 'dailyLimitExceeded' }), PermanentError_],
    [http(404), PermanentError_],
    [http(400, { reason: 'badRequest' }), PermanentError_],
    [http(401), PermanentError_],
    [new NetworkError_('Timeout: https://sheets.googleapis.com'), TransientError_],
    [new NetworkError_('Service invoked too many times for one day: urlfetch.'), PermanentError_],
    [new TypeError('x is undefined'), PermanentError_],
  ];
  for (const [exc, kind] of cases) assert.ok(g.classify_(exc) instanceof kind, exc.message + ' ' + exc.body);
  assert.strictEqual(g.classify_(http(429, { reason: 'rateLimitExceeded', retryAfter: 7 })).retryAfter, 7);
  assert.strictEqual(g.classify_(http(403, { reason: 'permissionDenied', message: 'caller does not have permission' })).message,
    'HTTP 403 (permissiondenied): caller does not have permission');
});

test('retry honours Retry-After and stops on permanent', () => {
  const c = clock();
  let n = 0;
  const policy = { attempts: 5, baseDelay: 1, maxDelay: 32, jitter: 0, budget: 90 };
  const out = g.callWithRetry_(() => { if (++n < 3) throw http(429, { reason: 'rateLimitExceeded', retryAfter: 5 }); return 'done'; },
    c, 'call', policy);
  assert.strictEqual(out, 'done');
  same(c.slept, [5000, 5000]);

  const c2 = clock();
  assert.throws(() => g.callWithRetry_(() => { throw http(403, { reason: 'permissionDenied' }); }, c2, 'call', policy), PermanentError_);
  same(c2.slept, []);

  // No sleeping past the execution deadline, however much budget is left.
  const c3 = clock({ t: 299500 });
  assert.throws(() => g.callWithRetry_(() => { throw http(503); }, c3, 'call', policy), TransientError_);
  same(c3.slept, []);
});

// -------------------------------------------------------------------- client

test('client speaks REST and retries a 503', () => {
  const seen = [];
  const replies = [[503, '{"error":{"status":"UNAVAILABLE","message":"busy"}}'], [200, '{"values":[[1,2]]}']];
  const fetch = (url, options) => {
    seen.push([options.method, url]);
    const [code, text] = replies.shift();
    return { getResponseCode: () => code, getContentText: () => text, getHeaders: () => ({}) };
  };
  const client = new SheetsClient_('TOKEN', clock(), fetch);
  same(client.getValues('SS', "'My Tab'!A2:E"), [[1, 2]]);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[1][1], "https://sheets.googleapis.com/v4/spreadsheets/SS/values/'My%20Tab'!A2%3AE" +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING');

  const failing = new SheetsClient_('T', clock(), () => { throw new Error('DNS error: sheets.googleapis.com'); });
  assert.throws(() => failing.getValues('SS', 'A1'), TransientError_);
});

// --------------------------------------------------------------- copy a range

class CopyClient {
  constructor(rows = 200, cols = 10, src) {
    this.calls = [];
    this.rows = rows;
    this.cols = cols;
    this.src = src === undefined ? Array.from({ length: 12 }, (_, r) => Array.from({ length: 5 }, (_, c) => `r${r}c${c}`)) : src;
  }
  sheetProps(ss, gid) {
    return { sheetId: gid || 0, title: 'Data', gridProperties: { rowCount: this.rows, columnCount: this.cols } };
  }
  getValues(ss, a1) { this.calls.push(['get', ss, a1]); return this.src; }
  appendRows(ss, sid, n) { this.calls.push(['appendRows', n]); this.rows += n; }
  appendColumns(ss, sid, n) { this.calls.push(['appendCols', n]); this.cols += n; }
  clearRange(ss, grid, title) { this.calls.push(['clear', g.gridToA1_(grid, title)]); }
  setValues(ss, a1, values) { this.calls.push(['set', a1, values.length, values[0].length]); this.written = values; }
}

const copy = (name, fromRange, toRange) => g.copyJobFromRow_([name, SRC, fromRange, DST, toRange]);

test('copy: open-ended source clears to the bottom of the tab', () => {
  const c = new CopyClient();
  const r = g.runCopyJob_(c, copy('t1', 'A2:E', 'A2'));
  same([r.status, r.rows, r.columns], ['ok', 12, 5]);
  same(c.calls, [['get', 'SRCID', "'Data'!A2:E"], ['clear', "'Data'!A2:E200"], ['set', "'Data'!A2:E13", 12, 5]]);
});

test('copy: bounded source clears as many rows as it covers', () => {
  const c = new CopyClient();
  g.runCopyJob_(c, copy('t2', 'A2:E100', 'B3'));
  same(c.calls.slice(1), [['clear', "'Data'!B3:F101"], ['set', "'Data'!B3:F14", 12, 5]]);
});

test('copy: grows the target tab', () => {
  const c = new CopyClient(20, 4, Array.from({ length: 40 }, () => [0, 1, 2, 3, 4, 5]));
  g.runCopyJob_(c, copy('t3', 'A1:F40', 'A5'));
  same(c.calls.slice(1), [['appendRows', 24], ['appendCols', 2], ['clear', "'Data'!A5:F44"], ['set', "'Data'!A5:F44", 40, 6]]);
});

test('copy: empty source is skipped, jagged rows are padded', () => {
  assert.strictEqual(g.runCopyJob_(new CopyClient(200, 10, null), copy('t4', 'A2:E', 'A2')).status, 'skipped');
  const c = new CopyClient(200, 10, [[1, 2, 3], [1], [1, 2]]);
  g.runCopyJob_(c, copy('t5', 'A2:C', 'A2'));
  same(c.calls.slice(1), [['clear', "'Data'!A2:C200"], ['set', "'Data'!A2:C4", 3, 3]]);
  same(c.written, [[1, 2, 3], [1, '', ''], [1, 2, '']]);
});

// ------------------------------------------------------------------ database

const cfg = g.databaseConfig_({});
const tx = ['2026-01-31', '2026-01-31', '', 'x', 'x', 'x', 'x', -500, '', ...Array(10).fill(''), 'Ops', 'Payroll'];

test('database: parseFloat parity', () => {
  same(['1,234.56', '0', 'abc', '-5', '', '$1,234', 0, '1e3'].filter(g.isNonzeroNumber_), ['1,234.56', '-5', '1e3']);
});

test('database: handbook and row building', () => {
  const hb = {
    cf: g.buildHandbook_([['Ops', 'Payroll', '-', 'cf1', 'cf2', 'cf3', 'cf4'], ['Ops', 'Payroll', '+', 'p1', 'p2']], 4),
    pl: g.buildHandbook_([['Ops', 'Payroll', '-', 'pl1', 'pl2', 'pl3', 'pl4']], 4),
    bs: g.buildHandbook_([], 4),
  };
  same(hb.cf['Ops¬Payroll¬+'], ['p1', 'p2', '', '']);
  const row = g.buildRow_(tx, 'Bank', hb, cfg);
  assert.strictEqual(row.length, 37);
  same(row.slice(22, 26), ['cf1', 'cf2', 'cf3', 'cf4']);
  same(row.slice(26, 30), ['pl1', 'pl2', 'pl3', 'pl4']);
  same(row.slice(30, 34), ['', '', '', '']);
  const noPl = tx.slice(); noPl[1] = '';
  same(g.buildRow_(noPl, 'Bank', hb, cfg).slice(26, 30), ['', '', '', '']);
  const positive = tx.slice(); positive[7] = 500;
  same(g.buildRow_(positive, 'Bank', hb, cfg).slice(22, 26), ['p1', 'p2', '', '']);
  assert.strictEqual(g.buildRow_(['a', 'b', 'c'], 'Bank', hb, cfg).length, 37);
});

const DBSRC = 'https://docs.google.com/spreadsheets/d/SRC/edit#gid=7';
const SETTINGS = [
  // A name, B url, C range, D to URL, E to range, F label, G is DB, H trigger, I manual, J length
  ['Bank', DBSRC, 'A2:U', '', '', 'Bank', true, false, true, 21],
  ['Stripe', DBSRC, 'A2:U', '', '', 'Stripe', true, false, true, 21],
  ['Rates', DBSRC, 'A2:C', 'https://docs.google.com/spreadsheets/d/DST/edit#gid=9', 'A2', 'Rates', false, false, true, ''],
  ['Off', DBSRC, 'A2:U', '', '', 'Off', true, false, false, 21],
];

class DatabaseClient {
  constructor(settings = SETTINGS) { this.settings = settings; this.cleared = []; this.filters = []; this.inserted = []; }
  getValues(ss, a1) {
    if (ss === 'SRC') return [tx, [...tx.slice(0, 7), 0, ...tx.slice(8)], [...tx.slice(0, 19), '', '']];
    if (a1.includes('Import Settings')) return this.settings;
    if (a1.includes('AI Settings')) {
      if (a1.endsWith('A3:G')) return [['Ops', 'Payroll', '-', 'cf1', 'cf2', 'cf3', 'cf4']];
      if (a1.endsWith('I3:O')) return [['Ops', 'Payroll', '-', 'pl1', 'pl2', 'pl3', 'pl4']];
      return null;
    }
    if (a1.includes('General database')) {
      return [
        ['Bank', ...Array(36).fill('old'), 'm', 'y', '', '', ''], // replaced: dropped
        ['Legacy', '2026-01-01', '', '', 'l', 'l', 'l', 'l', '1,234.56', ...Array(11).fill(''), 'Payroll', ...Array(17).fill('')],
        ['Legacy', '2026-01-01', '', '', 'l', 'l', 'l', 'l', '1,234.56', ...Array(29).fill('')], // no category: purged
      ];
    }
    return null;
  }
  sheetProps(ss, gid, title) {
    return { sheetId: 5, title: title || (ss === 'SRC' ? 'Source' : 'General database'), gridProperties: { rowCount: 10, columnCount: 42 } };
  }
  clearBasicFilter() { this.filters.push('clear'); return true; }
  setBasicFilter() { this.filters.push('set'); return true; }
  insertRowsBefore(ss, sid, before, n) { this.inserted.push([before, n]); }
  clearRange(ss, grid, title) { this.cleared.push(g.gridToA1_(grid, title)); }
  setValues(ss, a1, values) { this.written = [a1, values]; }
}

test('database: settings read and a full rebuild', () => {
  const c = new DatabaseClient();
  const jobs = g.readDatabaseSettings_(c, 'SS', 'manual', cfg, 'Import Settings');
  same(jobs.map((j) => j.kind), ['database', 'copy']);
  same(jobs[0].sources.map((s) => s.name), ['Bank', 'Stripe']);
  same(jobs[0].replacedLabels, ['Bank', 'Stripe', 'Rates']);
  assert.strictEqual(jobs[0].name, 'General database');

  const out = g.runDatabaseJob_(c, jobs[0]);
  const [a1, rows] = c.written;
  same(out, { rows: 3, columns: 37 });
  assert.strictEqual(a1, "'General database'!A2:AK4");
  assert.strictEqual(rows[0][0], 'Legacy');
  assert.ok(rows.every((r) => r.length === 37)); // nothing past the rebuild's own columns
  same(c.filters, ['clear', 'set']);
  same(c.inserted, [[10, 1]]);
  same(c.cleared, ["'General database'!A2:AK10"]);
});

test('database: formula columns past the rebuild are never touched; a narrow tab fails first', () => {
  // A..AJ owned, AK..AM formulas: 23 transaction columns and nothing preserved.
  const layout = g.databaseConfig_({ transactionLength: 23, preservedColumns: 0 });
  const c = new DatabaseClient();
  const jobs = g.readDatabaseSettings_(c, 'SS', 'manual', layout, 'Import Settings');
  g.runDatabaseJob_(c, jobs[0]);
  same(c.cleared, ["'General database'!A2:AJ10"]);
  assert.ok(c.written[0].endsWith('!A2:AJ4'), c.written[0]);

  const narrow = new DatabaseClient();
  narrow.sheetProps = (ss, gid, title) => ({ sheetId: 5, title: title || 'General database',
    gridProperties: { rowCount: 10, columnCount: 30 } });
  assert.throws(() => g.runDatabaseJob_(narrow, jobs[0]),
    /has 30 columns but the rebuild needs 36 \(A:AJ\); check transactionLength and preservedColumns/);
  same(narrow.filters, []); // failed before the filter, the clear or the write
  same(narrow.cleared, []);
});

test('database: column J guard', () => {
  const c = new DatabaseClient([['Bank', DBSRC, 'A2:Z', '', '', 'Bank', true, false, true, 25]]);
  assert.throws(() => g.readDatabaseSettings_(c, 'SS', 'manual', cfg, 'Import Settings'),
    (e) => e instanceof PermanentError_ && /Check the length in column J: Bank \(row 2: 25\)/.test(e.message));
});

test('database: rows grouped by target spreadsheet', () => {
  const DB1 = 'https://docs.google.com/spreadsheets/d/DBONE/edit#gid=11';
  const DB2 = 'https://docs.google.com/spreadsheets/d/DBTWO/edit#gid=22';
  const c = new DatabaseClient([
    ['Bank', DBSRC, 'A2:U', DB1, '', 'Bank', true, false, true, 21],
    ['Stripe', DBSRC, 'A2:U', DB1, '', 'Stripe', true, false, true, 21],
    ['Payroll', DBSRC, 'A2:U', DB2, '', 'Payroll', true, false, true, 21],
    ['Rates', DBSRC, 'A2:C', DST, 'A2', 'Rates', false, false, true, ''],
  ]);
  const db = g.readDatabaseSettings_(c, 'SS', 'manual', cfg, 'Import Settings').filter((j) => j.kind === 'database');
  same(db.map((j) => j.sources.map((s) => s.name)), [['Bank', 'Stripe'], ['Payroll']]);
  same(db.map((j) => j.replacedLabels), [['Bank', 'Stripe', 'Rates'], ['Payroll', 'Rates']]);
  same(db.map((j) => j.name), ['General database #1 (DBONE)', 'General database #2 (DBTWO)']);
  assert.notStrictEqual(db[0].id, db[1].id);
});

test('database: config validation', () => {
  same(g.databaseConfig_({ statusCells: ['J2', 'J3', 'J4'] }).statusCells, ['J2', 'J3', 'J4']);
  assert.throws(() => g.databaseConfig_({ statCells: [] }), /Unknown database config keys: statCells/);
  assert.throws(() => g.databaseConfig_({ statusCells: ['J2'] }), PermanentError_);
});

// ----------------------------------------------------------- ordering, passes

function scripted(behaviour) {
  const ran = [];
  g.execute_ = (client, job) => {
    ran.push(job.name);
    const next = behaviour[job.name] && behaviour[job.name].shift();
    if (next) throw next;
    return g.result_(job, 'ok', 1, 1);
  };
  return ran;
}
const originalExecute = g.execute_;
const named = (...names) => names.map((n) => copy(n, 'A1', 'A1'));

test('a transient failure defers the rest of the run, a permanent one does not', () => {
  let ran = scripted({ CopyA: [http(503, { canonical: 'UNAVAILABLE' })] });
  let out = g.runJobs_(null, named('Rebuild', 'CopyA', 'CopyB', 'CopyC'), clock({ startCutoff: 0 }));
  same(ran, ['Rebuild', 'CopyA']);
  same(out.left.map((j) => j.name), ['CopyA', 'CopyB', 'CopyC']);
  assert.strictEqual(out.reason, 'transient'); // no room to sleep, so layer 3 takes it

  ran = scripted({ CopyA: [http(403, { reason: 'permissionDenied' })] });
  out = g.runJobs_(null, named('Rebuild', 'CopyA', 'CopyB', 'CopyC'), clock());
  same(ran, ['Rebuild', 'CopyA', 'CopyB', 'CopyC']);
  same(out.results.map((r) => r.status), ['ok', 'failed', 'ok', 'ok']);
  assert.strictEqual(out.left.length, 0);
});

test('blocked rows run once the blocker clears inside the execution', () => {
  const ran = scripted({ CopyA: [http(503, { canonical: 'UNAVAILABLE' })] });
  const c = clock();
  const out = g.runJobs_(null, named('Rebuild', 'CopyA', 'CopyB'), c);
  same(ran, ['Rebuild', 'CopyA', 'CopyA', 'CopyB']);
  same(c.slept, [30000]);
  assert.strictEqual(out.left.length, 0);
  assert.strictEqual(out.reason, null);
});

test('running out of execution time leaves the rest for a continuation', () => {
  scripted({});
  const c = clock({ startCutoff: 100 });
  const realExecute = g.execute_;
  g.execute_ = (client, job) => { c.t += 150; return realExecute(client, job); };
  const out = g.runJobs_(null, named('One', 'Two', 'Three'), c);
  same(out.results.map((r) => r.name), ['One']);
  same(out.left.map((j) => j.name), ['Two', 'Three']);
  assert.strictEqual(out.reason, 'time');
});

// ------------------------------------------------------- run, retry, resume

function importRows(...names) {
  return names.map((n) => [n, SRC, 'A1', DST, 'A1', '', '', true]);
}

class RunClient {
  constructor(rows, settingsFailures = []) { this.rows = rows; this.statuses = []; this.settingsFailures = settingsFailures; }
  timeZone() { return 'Europe/Kyiv'; }
  getValues() { const f = this.settingsFailures.shift(); if (f) throw f; return this.rows; }
  batchSetValues(ss, data) { this.statuses.push(data.map((d) => [d.range, d.values[0][0]])); }
  get status() { return this.statuses[this.statuses.length - 1][0][1]; }
  get cell() { return this.statuses[this.statuses.length - 1][0][0]; }
}

function fakeHost(locked = false) {
  const props = new Map();
  const triggers = [];
  let uid = 0;
  return {
    props, triggers,
    properties: {
      getProperty: (k) => (props.has(k) ? props.get(k) : null),
      setProperty: (k, v) => props.set(k, v),
      deleteProperty: (k) => props.delete(k),
    },
    lock: { tryLock: () => !locked, releaseLock: () => {} },
    resumeHandler: 'sheetsSyncResume',
    scriptApp: {
      getOAuthToken: () => 'TOKEN',
      newTrigger(handler) {
        const t = { handler, id: 'uid' + ++uid, getUniqueId() { return this.id; } };
        return { timeBased: () => ({ after: (ms) => ({ create: () => { t.after = ms; triggers.push(t); return t; } }) }) };
      },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
    },
  };
}

g.lib.RealSheetsClient_ = SheetsClient_;
let activeClient = null;
vm.runInContext('SheetsClient_ = class { constructor() { return globalThis.activeClient; } };', context);
const useClient = (client) => { context.activeClient = client; activeClient = client; return client; };

const request = { mode: 'import', execution: 'manual', spreadsheetId: 'SS', settingsTab: 'Import Settings', requestedBy: 'me@x.com' };

test('a transient failure schedules a retry that resumes only what was left', () => {
  const host = fakeHost();
  const client = useClient(new RunClient(importRows('Pre', 'CopyA', 'CopyB')));
  let ran = scripted({ CopyA: [http(503, { canonical: 'UNAVAILABLE' }), http(503, { canonical: 'UNAVAILABLE' }),
    http(503, { canonical: 'UNAVAILABLE' }), http(503, { canonical: 'UNAVAILABLE' })] });
  const first = g.run(request, host);
  assert.ok(ran.filter((n) => n === 'Pre').length === 1);
  assert.match(first.status, /^Failed: CopyA, CopyB did not sync - Google Sheets was temporarily unavailable\. Retry 2 of 4 scheduled at Europe\/Kyiv\|.*no action needed\. Last error - HTTP 503 \(UNAVAILABLE\): boom$/);
  assert.strictEqual(client.statuses[0][0][1], 'In progress: import running. This cell updates when it finishes.');
  assert.strictEqual(client.cell, "'Import Settings'!J2");
  assert.strictEqual(host.triggers.length, 1);
  assert.strictEqual(host.triggers[0].after, 15 * 60 * 1000);
  assert.strictEqual(JSON.parse(host.props.get('sheetsSync:uid1')).attempt, 2);

  ran = scripted({});
  const second = g.resume({ triggerUid: 'uid1' }, host);
  same(ran, ['CopyA', 'CopyB']); // Pre is not redone
  assert.strictEqual(second.status, 'Import successful');
  assert.strictEqual(host.triggers.length, 0);
  assert.strictEqual(host.props.size, 0);
});

test('a permanent failure survives a later successful retry', () => {
  const host = fakeHost();
  useClient(new RunClient(importRows('Bad', 'CopyA', 'CopyB')));
  scripted({ Bad: [http(403, { reason: 'permissionDenied' })], CopyA: Array(4).fill(0).map(() => http(503, { canonical: 'UNAVAILABLE' })) });
  const first = g.run(request, host);
  assert.match(first.status, /^Failed: Bad: HTTP 403 \(permissiondenied\): boom \| CopyA, CopyB did not sync/);
  scripted({});
  const second = g.resume({ triggerUid: 'uid1' }, host);
  assert.strictEqual(second.status, 'Failed: Bad: HTTP 403 (permissiondenied): boom');
});

test('giving up after the last attempt', () => {
  const host = fakeHost();
  useClient(new RunClient(importRows('CopyA')));
  scripted({ CopyA: Array(4).fill(0).map(() => http(503, { canonical: 'UNAVAILABLE' })) });
  const state = { request, attempt: g.lib.MAX_ATTEMPTS_, pending: null, errors: [] };
  host.props.set('sheetsSync:last', JSON.stringify(state));
  host.triggers.push({ id: 'last', getUniqueId() { return 'last'; } });
  const out = g.resume({ triggerUid: 'last' }, host);
  assert.match(out.status, /^Failed: Google Sheets stayed unavailable after 4 attempts\. Not synced: CopyA\. Last error/);
  assert.strictEqual(host.triggers.length, 0);
});

test('an unreadable settings tab is retried whole', () => {
  const host = fakeHost();
  const client = useClient(new RunClient(importRows('CopyA'), [http(503, { canonical: 'UNAVAILABLE' })]));
  scripted({});
  const out = g.run(request, host);
  assert.match(out.status, /^Failed: settings did not sync/);
  assert.strictEqual(JSON.parse(host.props.get('sheetsSync:uid1')).pending, null);
  assert.strictEqual(client.statuses.length, 2);
});

test('the database variant writes its own status cells and reads its own tab', () => {
  const host = fakeHost();
  const client = useClient(new RunClient([]));
  scripted({});
  const out = g.run(Object.assign({}, request, { mode: 'database', settingsTab: 'DB Settings', databaseConfig: {} }), host);
  assert.strictEqual(out.status, 'Import successful');
  assert.strictEqual(client.cell, "'DB Settings'!L2");
});

test('a second run is refused while one holds the lock; a resumed one moves back', () => {
  const host = fakeHost(true);
  const client = useClient(new RunClient(importRows('CopyA')));
  assert.strictEqual(g.run(request, host).busy, true);
  assert.strictEqual(client.statuses.length, 0);
  host.props.set('sheetsSync:x', JSON.stringify({ request, attempt: 2, pending: ['id'], errors: [] }));
  host.triggers.push({ id: 'x', getUniqueId() { return 'x'; } });
  g.resume({ triggerUid: 'x' }, host);
  assert.strictEqual(host.triggers.length, 1);
  assert.strictEqual(host.triggers[0].after, 60 * 1000);
  assert.strictEqual(JSON.parse(host.props.get('sheetsSync:uid1')).attempt, 2);
});

test('status message: continuation', () => {
  const at = new Date('2026-09-28T10:00:00Z');
  assert.strictEqual(g.statusMessage_({ mode: 'export', errors: [], leftNames: ['B'], reason: 'time', nextAt: at, attempt: 1, timeZone: 'UTC' }),
    'In progress: B still to sync, continuing at UTC|2026-09-28T10:00:00.000Z.');
  assert.match(g.statusMessage_({ mode: 'export', errors: ['A: bad'], leftNames: ['B'], reason: 'time', nextAt: at, attempt: 1, timeZone: 'UTC' }),
    /^Failed: A: bad \| B still to sync/);
  assert.strictEqual(g.statusMessage_({ mode: 'export', errors: [], leftNames: [], reason: null, attempt: 1 }), 'Export successful');
});

// ------------------------------------------------------------ API limits

test("backoff follows Google's formula and outlasts a quota minute", () => {
  const policy = vm.runInContext('RETRY_POLICY_', context);
  for (let n = 1; n <= 10; n++) {
    const d = g.retryDelay_(policy, n, null);
    assert.ok(d >= Math.min(2 ** (n - 1), 32) && d <= Math.min(2 ** (n - 1) + 1, 32), n + ': ' + d);
  }
  assert.strictEqual(g.retryDelay_(policy, 1, 40), 40);
  let waited = 0;
  for (let n = 1; n < policy.attempts; n++) waited += Math.min(2 ** (n - 1), 32);
  assert.ok(waited > 60 && waited <= policy.budget, String(waited));
});

test('at most one request per second per spreadsheet', () => {
  const c = clock();
  const ok = { getResponseCode: () => 200, getContentText: () => '{}', getHeaders: () => ({}) };
  const client = new g.lib.RealSheetsClient_('T', c, () => ok);
  client.getValues('A', 'A1');
  client.batchSetValues('A', []);
  client.getValues('B', 'A1');
  c.t += 5000;
  client.getValues('A', 'A1');
  same(c.slept, [1000]);
});

test('big writes are split under the payload limit', () => {
  const writes = [];
  const writer = { setValues: (ss, a1, values) => writes.push([a1, values.length]) };
  const row = ['x'.repeat(400000)];
  g.writeGrid_(writer, 'SS', g.grid_(0, 1, 6, 0, 1), 'Data', [row, row, row, row, row]);
  same(writes, [["'Data'!A2:A3", 2], ["'Data'!A4:A5", 2], ["'Data'!A6:A6", 1]]);
  writes.length = 0;
  g.writeGrid_(writer, 'SS', g.grid_(0, 1, 2, 0, 1), 'Data', [['x'.repeat(3000000)]]);
  same(writes, [["'Data'!A2:A2", 1]]); // one oversized row still goes, alone
});

// ------------------------------------------------- setValues / getValues

class ValuesClient extends CopyClient {
  timeZone() { return 'Europe/Kyiv'; }
  setValues(ss, a1, values) {
    if (ss === 'FLAKYID') throw http(503, { canonical: 'UNAVAILABLE' });
    super.setValues(ss, a1, values);
  }
}
const at = (range, url = DST) => ({ url: url, range: range });

test('setValues: an anchor only writes, padded and sized to the data', () => {
  const c = useClient(new ValuesClient());
  g.setValues(at('A2'), [[1, 2], [3]]);
  same(c.calls, [['set', "'Data'!A2:B3", 2, 2]]);
  same(c.written, [[1, 2], [3, '']]);
});

test('setValues: an explicit range is cleared first', () => {
  let c = useClient(new ValuesClient());
  g.setValues(at('A2:E'), [[1, 2]]);
  same(c.calls, [['clear', "'Data'!A2:E200"], ['set', "'Data'!A2:B2", 1, 2]]);
  c = useClient(new ValuesClient());
  g.setValues(at('B3:C100'), [[1, 2]]);
  same(c.calls, [['clear', "'Data'!B3:C100"], ['set', "'Data'!B3:C3", 1, 2]]);
  c = useClient(new ValuesClient());
  g.setValues(at("'Other'!A2:C"), []); // nothing to write: the range is simply emptied
  same(c.calls, [['clear', "'Data'!A2:C200"]]);
});

test('setValues: grows the tab and writes Dates as dates', () => {
  let c = useClient(new ValuesClient(20, 4));
  g.setValues(at('A5'), Array.from({ length: 40 }, () => [0, 1, 2, 3, 4, 5]));
  same(c.calls, [['appendRows', 24], ['appendCols', 2], ['set', "'Data'!A5:F44", 40, 6]]);
  c = useClient(new ValuesClient());
  g.setValues(at('A1'), [[new Date('2026-09-29T10:00:00Z'), 'x']]);
  same(c.written, [['Europe/Kyiv|2026-09-29T10:00:00.000Z', 'x']]);
});

test('setValues: a list tries every location and reports the failures', () => {
  const c = useClient(new ValuesClient());
  const flaky = 'https://docs.google.com/spreadsheets/d/FLAKYID/edit#gid=1';
  let thrown = null;
  try {
    g.setValues([at('A1'), at('A1', 'nope'), at('A1', flaky)], [[[1]], [[2]], [[3]]]);
  } catch (exc) {
    thrown = exc;
  }
  same(c.calls, [['set', "'Data'!A1:A1", 1, 1]]);
  same(thrown.failures.map((f) => [f.location, f.transient]), [['nope A1', false], [flaky + ' A1', true]]);
  assert.throws(() => g.setValues([at('A1')], [[[1]], [[2]]]), /one 2D array of values per location/);
  assert.throws(() => g.setValues(at('A1'), [1, 2]), /values must be a 2D array/);
});

test('getValues: bounded ranges are padded back, open ones end at the data', () => {
  useClient(new ValuesClient(200, 10, [[1], [2, 3]]));
  same(g.getValues(at('A1:C3')), [[1, '', ''], [2, 3, ''], ['', '', '']]);
  same(g.getValues(at('A2:C')), [[1, '', ''], [2, 3, '']]);
  same(g.getValues([at('A1:B1'), at('A1:C2')]), [[[1, '']], [[1, '', ''], [2, 3, '']]]);
  useClient(new ValuesClient(200, 10, null));
  same(g.getValues(at('A1:B2')), [['', ''], ['', '']]);
  same(g.getValues(at('A1:B')), []);
  assert.throws(() => g.getValues(at('A1', 'nope')), /getValues failed for nope A1: Cannot extract a spreadsheet id/);
});

test('getValues: serial dates on request', () => {
  const c = useClient(new ValuesClient(200, 10, [[45000]]));
  const seen = [];
  c.getValues = (ss, a1, values, dates) => { seen.push(dates); return [[45000]]; };
  g.getValues(at('A1'));
  g.getValues(at('A1'), { serialDates: true });
  same(seen, ['FORMATTED_STRING', 'SERIAL_NUMBER']);
});

test('the clock counts from when the execution started', () => {
  const now = Date.now();
  const late = g.clock_(now - 28 * 60 * 1000); // 28 of 30 minutes already gone
  assert.ok(late.startCutoff < now, 'no new job starts with 2 minutes left');
  assert.ok(Math.abs(late.deadline - (now + 60 * 1000)) < 1000, 'backoff stops a minute before the limit');
  const fresh = g.clock_(new Date(now));
  assert.ok(fresh.startCutoff - now > 26 * 60 * 1000);
  assert.ok(g.clock_().deadline <= g.clock_(now).deadline, 'the default is the library load time');
});

g.execute_ = originalExecute;
console.log(passed + ' tests passed');
