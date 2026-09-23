const test = require('node:test');
const assert = require('node:assert');
const { load, same } = require('./harness');

const g = load();
const SRC = 'https://docs.google.com/spreadsheets/d/SRCID/edit#gid=11';
const DST = 'https://docs.google.com/spreadsheets/d/DSTID/edit#gid=22';

function fake({ rows = 200, cols = 10, src } = {}) {
  const f = {
    calls: [], rows, cols,
    src: src === undefined ? Array.from({ length: 12 }, (_, r) => Array.from({ length: 5 }, (_, c) => `r${r}c${c}`)) : src,
    sheetProps: (ss, gid) => ({ sheetId: gid || 0, title: 'Data', gridProperties: { rowCount: f.rows, columnCount: f.cols } }),
    getValues(ss, a1) { f.calls.push(['get', a1]); return f.src; },
    dataExtent: () => [150, 5],
    insertRowsAfter(ss, sid, after, n) { f.calls.push(['insRows', after, n]); f.rows += n; },
    insertColumnsAfter(ss, sid, after, n) { f.calls.push(['insCols', after, n]); f.cols += n; },
    clearRange(ss, grid, title) { f.calls.push(['clear', g.gridToA1_(grid, title)]); },
    setValues(ss, a1, values) { f.calls.push(['set', a1, values.length, values[0].length]); }
  };
  return f;
}
const job = (from, to) => ({ kind: 'copy', name: 't', from_url: SRC, from_range: from, to_url: DST, to_range: to });

test('open-ended source clears to the bottom of the target', () => {
  const f = fake();
  const r = g.runCopyJob_(f, job('A2:E', 'A2'));
  assert.strictEqual(r.status, 'ok');
  same(f.calls.slice(1), [['clear', "'Data'!A2:E200"], ['set', "'Data'!A2:E13", 12, 5]]);
});

test('bounded source clears as many rows as it covers', () => {
  const f = fake();
  g.runCopyJob_(f, job('A2:E100', 'B3'));
  same(f.calls.slice(1), [['clear', "'Data'!B3:F101"], ['set', "'Data'!B3:F14", 12, 5]]);
});

test('target grows when the block does not fit', () => {
  const f = fake({ rows: 20, cols: 4, src: Array.from({ length: 40 }, () => [0, 1, 2, 3, 4, 5]) });
  g.runCopyJob_(f, job('A1:F40', 'A5'));
  same(f.calls.slice(1, 3), [['insRows', 150, 24], ['insCols', 5, 2]]);
  same(f.calls.at(-1), ['set', "'Data'!A5:F44", 40, 6]);
});

test('empty source is skipped', () => {
  assert.strictEqual(g.runCopyJob_(fake({ src: null }), job('A2:E', 'A2')).status, 'skipped');
});

test('jagged rows are padded to the widest', () => {
  const f = fake({ src: [[1, 2, 3], [1], [1, 2]] });
  g.runCopyJob_(f, job('A2:C', 'A2'));
  same(f.calls.at(-1), ['set', "'Data'!A2:C4", 3, 3]);
});

test('A1 helpers', () => {
  assert.strictEqual(g.indexToColumn_(26), 'AA');
  assert.strictEqual(g.columnToIndex_('AA'), 26);
  same({ ...g.parseA1_('H10:A2', 3) },
    { sheetId: 3, startRowIndex: 1, endRowIndex: 10, startColumnIndex: 0, endColumnIndex: 8 });
  same({ ...g.splitSheetTitle_("'It''s'!A2:H") }, { title: "It's", range: 'A2:H' });
  assert.strictEqual(g.withSheetTitle_('A1', "It's"), "'It''s'!A1");
  assert.strictEqual(g.sheetGidFromUrl_(SRC), 11);
  assert.strictEqual(g.spreadsheetIdFromUrl_(SRC), 'SRCID');
});

test('the settings tab name is honoured on read and write', () => {
  const ROW = [['Bank', 'https://docs.google.com/spreadsheets/d/S/edit#gid=0', 'A2:H',
    'https://docs.google.com/spreadsheets/d/D/edit#gid=1', 'A2', '', '', true, true, 21]];
  const c = () => ({ reads: [], writes: [],
    getValues(ss, a1) { this.reads.push(a1); return ROW; },
    batchSetValues(ss, data) { this.writes.push(...data.map(d => d.range)); } });
  let x = c(); g.readJobs_(x, 'SSID', 'import', 'manual');
  assert.strictEqual(x.reads[0], "'Import Settings'!A2:Z");
  x = c(); g.readJobs_(x, 'SSID', 'import', 'manual', null, 'Renamed');
  assert.strictEqual(x.reads[0], "'Renamed'!A2:Z");
  x = c(); g.readDatabaseSettings_(x, 'SSID', 'manual', g.databaseConfig_(), 'Renamed');
  assert.strictEqual(x.reads[0], "'Renamed'!A2:Z");
  x = c(); g.writeStatus_(x, 'SSID', 'import', null, 'me', 'ok', 'UTC', null, 'Renamed');
  assert.ok(x.writes.every(w => w.startsWith("'Renamed'!")), x.writes);
});

test('a row missing a field is a permanent error naming the row', () => {
  const c = { getValues: () => [['Bank', 'u', '', 'u', 'A2', '', '', true, true]] };
  assert.throws(() => g.readJobs_(c, 'SSID', 'import', 'manual'), e => e instanceof g.PermanentError && /row 2 \(Bank\) is missing: from_range/.test(e.message));
});
