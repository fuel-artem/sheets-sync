const test = require('node:test');
const assert = require('node:assert');
const { load, same } = require('./harness');

const g = load();
const cfg = g.databaseConfig_();
const SRC = 'https://docs.google.com/spreadsheets/d/SRC/edit#gid=7';
// 21 columns: dates at 0,1,2; amount at 7; key at 19,20.
const tx = ['2026-01-31', '2026-01-31', '', 'x', 'x', 'x', 'x', -500, '', ...Array(10).fill(''), 'Ops', 'Payroll'];

test('parseFloat parity decides which rows survive', () => {
  same(['1,234.56', '0', 'abc', '-5', '', '$1,234', '1e3', true].filter(g.isNonzeroNumber_),
    ['1,234.56', '-5', '1e3']);
});

const hb = {
  cf: g.buildHandbook_([['Ops', 'Payroll', '-', 'cf1', 'cf2', 'cf3', 'cf4'], ['Ops', 'Payroll', '+', 'p1', 'p2']], 4),
  pl: g.buildHandbook_([['Ops', 'Payroll', '-', 'pl1', 'pl2', 'pl3', 'pl4']], 4),
  bs: g.buildHandbook_([], 4)
};

test('short AI Settings rows are padded to the block width', () => {
  same([...hb.cf['Ops¬Payroll¬+']], ['p1', 'p2', '', '']);
});

test('a transaction becomes a 37-column row with its AI blocks', () => {
  const row = g.buildRow_(tx, 'Bank', hb, cfg);
  assert.strictEqual(row.length, 37);
  assert.strictEqual(row[0], 'Bank');
  same(row.slice(22, 26), ['cf1', 'cf2', 'cf3', 'cf4']);
  same(row.slice(26, 30), ['pl1', 'pl2', 'pl3', 'pl4']);
  same(row.slice(30, 34), ['', '', '', '']);

  const noPl = [...tx]; noPl[1] = '';
  same(g.buildRow_(noPl, 'Bank', hb, cfg).slice(26, 30), ['', '', '', '']);
  const positive = [...tx]; positive[7] = 500;
  same(g.buildRow_(positive, 'Bank', hb, cfg).slice(22, 26), ['p1', 'p2', '', '']);
  assert.strictEqual(g.buildRow_(['a', 'b', 'c'], 'Bank', hb, cfg).length, 37);
});

const SETTINGS = [
  // A name, B url, C range, D toURL, E toRange, F label, G isDB, H trig, I man, J len
  ['Bank', SRC, 'A2:U', '', '', 'Bank', true, false, true, 21],
  ['Stripe', SRC, 'A2:U', '', '', 'Stripe', true, false, true, 21],
  ['Rates', SRC, 'A2:C', 'https://docs.google.com/spreadsheets/d/DST/edit#gid=9', 'A2', 'Rates', false, false, true, ''],
  ['Off', SRC, 'A2:U', '', '', 'Off', true, false, false, 21]
];

function client() {
  const c = {
    written: null, cleared: [], filters: [], inserted: [],
    getValues(ss, a1) {
      if (ss === 'SRC') return [tx, [...tx.slice(0, 7), 0, ...tx.slice(8)], [...tx.slice(0, 19), '', '']];
      if (a1.includes('Import Settings')) return SETTINGS;
      if (a1.includes('AI Settings')) {
        if (a1.endsWith('A3:G')) return [['Ops', 'Payroll', '-', 'cf1', 'cf2', 'cf3', 'cf4']];
        if (a1.endsWith('I3:O')) return [['Ops', 'Payroll', '-', 'pl1', 'pl2', 'pl3', 'pl4']];
        return [];
      }
      if (a1.includes('General database')) {
        return [
          ['Bank', ...Array(36).fill('old'), 'm', 'y', '', '', ''], // replaced -> dropped
          ['Legacy', '2026-01-01', '', '', 'l', 'l', 'l', 'l', '1,234.56', ...Array(11).fill(''), 'Payroll', ...Array(17).fill('')],
          ['Legacy', '2026-01-01', '', '', 'l', 'l', 'l', 'l', '1,234.56', ...Array(29).fill('')] // no category -> purged
        ];
      }
      return [];
    },
    sheetProps: (ss, gid, title) => ({
      sheetId: 5,
      title: title || (ss === 'SRC' ? 'Source' : 'General database'),
      gridProperties: { rowCount: 10, columnCount: 42 }
    }),
    clearBasicFilter() { c.filters.push('clear'); return true; },
    setBasicFilter() { c.filters.push('set'); return true; },
    insertRowsBefore(ss, sid, before, n) { c.inserted.push([before, n]); },
    clearRange(ss, grid, title) { c.cleared.push(g.gridToA1_(grid, title)); },
    setValues(ss, a1, values) { c.written = [a1, values]; }
  };
  return c;
}

test('settings read and full rebuild', () => {
  const c = client();
  const jobs = g.readDatabaseSettings_(c, 'SS', 'manual', cfg);
  same(jobs.map(j => j.kind), ['database', 'copy']);
  same(jobs[0].sources.map(s => s.name), ['Bank', 'Stripe']);
  same([...jobs[0].replaced_labels], ['Bank', 'Stripe', 'Rates']);

  const out = g.runDatabaseJob_(c, jobs[0]);
  const [a1, rows] = c.written;
  same({ ...out }, { rows: 3, columns: 42 }); // kept rows carry keep_columns + trailing_blanks
  assert.strictEqual(a1, "'General database'!A2:AP4");
  same(c.filters, ['clear', 'set']);
  same(c.cleared, ["'General database'!A2:AP10"]);
  assert.strictEqual(rows[0][0], 'Legacy'); // kept, month/year blanked
  assert.strictEqual(rows.length, 3); // Legacy + one good transaction per source

  // The rebuild survives a round trip through the retry payload.
  const back = JSON.parse(JSON.stringify(jobs[0]));
  same(back.sources.map(s => s.label), ['Bank', 'Stripe']);
  assert.strictEqual(back.config.transaction_length, 21);
});

test('a declared length above transaction_length stops the run', () => {
  const c = { getValues: () => [['Bank', SRC, 'A2:Z', '', '', 'Bank', true, false, true, 25]] };
  assert.throws(() => g.readDatabaseSettings_(c, 'SS', 'manual', cfg),
    /longer than needed \(needed 21\).*Bank \(row 2: 25\)/);
});

test('config: unknown keys refused, status cells default to L', () => {
  assert.throws(() => g.databaseConfig_({ nope: 1 }), /Unknown database config keys: nope/);
  same([...g.databaseConfig_().status_cells], ['L2', 'L3', 'L4']);
  same([...g.databaseConfig_({ status_cells: ['J2', 'J3', 'J4'] }).status_cells], ['J2', 'J3', 'J4']);
  assert.throws(() => g.databaseConfig_({ status_cells: ['J2'] }), /exactly 3 cells/);
});

test('status cells come from the config that was passed in', () => {
  const cases = [[g.databaseConfig_(), 'L2'], [g.databaseConfig_({ status_cells: ['J2', 'J3', 'J4'] }), 'J2']];
  for (const [config, cell] of cases) {
    const cells = {};
    const c = {
      sheetProps: (ss, gid, title) => { throw new g.PermanentError(`Tab "${title}" not found in spreadsheet SSID`); },
      batchSetValues: (ss, data) => data.forEach(d => { cells[d.range] = d.values[0][0]; })
    };
    const job = {
      kind: 'database', name: 'General database', settings_spreadsheet_id: 'SSID', config, database_url: '',
      sources: [{ name: 'Bank', label: 'Bank', from_url: SRC, from_range: 'A2:U' }], replaced_labels: ['Bank']
    };
    g.run_(c, { settingsId: 'SSID', mode: 'database', jobs: [job], user: 'me', databaseConfig: config, timezone: 'UTC' });
    assert.match(cells[`'Import Settings'!${cell}`], /not found/);
  }
});

test('database rows are grouped by target spreadsheet', () => {
  const DB1 = 'https://docs.google.com/spreadsheets/d/DBONE/edit#gid=11';
  const DB2 = 'https://docs.google.com/spreadsheets/d/DBTWO/edit#gid=22';
  const MULTI = [
    ['Bank', SRC, 'A2:U', DB1, '', 'Bank', true, false, true, 21],
    ['Stripe', SRC, 'A2:U', DB1, '', 'Stripe', true, false, true, 21],
    ['Payroll', SRC, 'A2:U', DB2, '', 'Payroll', true, false, true, 21],
    ['Rates', SRC, 'A2:C', 'https://docs.google.com/spreadsheets/d/DST/edit#gid=9', 'A2', 'Rates', false, false, true, '']
  ];
  const db = g.readDatabaseSettings_({ getValues: () => MULTI }, 'SSID', 'manual', cfg).filter(j => j.kind === 'database');
  assert.strictEqual(db.length, 2);
  same(db[0].sources.map(s => s.name), ['Bank', 'Stripe']);
  same(db[1].sources.map(s => s.name), ['Payroll']);
  same([...db[0].replaced_labels], ['Bank', 'Stripe', 'Rates']);
  same([...db[1].replaced_labels], ['Payroll', 'Rates']);
  assert.notStrictEqual(db[0].name, db[1].name);

  const single = g.readDatabaseSettings_(client(), 'SSID', 'manual', cfg).filter(j => j.kind === 'database');
  assert.strictEqual(single.length, 1);
  assert.strictEqual(single[0].name, 'General database');
});
