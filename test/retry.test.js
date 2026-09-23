const test = require('node:test');
const assert = require('node:assert');
const { load, same } = require('./harness');

const g = load();

function http(status, { reason, canonical, msg = 'boom', retryAfter } = {}) {
  const error = { code: status, message: msg };
  if (reason) error.errors = [{ reason, message: msg }];
  if (canonical) error.status = canonical;
  return new g.HttpError(status, JSON.stringify({ error }), retryAfter ? { 'Retry-After': String(retryAfter) } : {});
}
const network = message => Object.assign(new Error(message), { isFetchFailure: true });

test('classification: the reason code wins over the status', () => {
  const cases = [
    [http(503, { canonical: 'UNAVAILABLE' }), 'transient'],
    [http(500, { reason: 'backendError' }), 'transient'],
    [http(429, { reason: 'rateLimitExceeded', retryAfter: 42 }), 'transient'],
    [http(403, { reason: 'userRateLimitExceeded' }), 'transient'], // a throttle wearing a 403
    [http(403, { reason: 'permissionDenied' }), 'permanent'],
    [http(429, { reason: 'dailyLimitExceeded' }), 'permanent'], // will not clear today
    [http(404, { msg: 'Requested entity was not found.' }), 'permanent'],
    [http(400, { reason: 'badRequest', msg: 'Unable to parse range: A2:ZZ' }), 'permanent'],
    [http(401, { msg: 'Invalid Credentials' }), 'permanent'],
    [network('Address unavailable: https://sheets.googleapis.com'), 'transient'],
    [network('Service invoked too many times for one day: urlfetch.'), 'permanent'],
    [new Error('bad url'), 'permanent']
  ];
  for (const [exc, want] of cases) {
    assert.strictEqual(g.isTransient_(exc) ? 'transient' : 'permanent', want, String(g.classify_(exc)));
  }
  assert.strictEqual(g.classify_(http(429, { reason: 'rateLimitExceeded', retryAfter: 42 })).retryAfter, 42);
});

test('Retry-After is honoured and a permanent failure raises at once', () => {
  const slept = [];
  let calls = 0;
  const flaky = () => {
    calls += 1;
    if (calls < 3) throw http(429, { reason: 'rateLimitExceeded', retryAfter: 5 });
    return 'done';
  };
  const policy = { ...g.DEFAULT_POLICY, jitter: 0 };
  assert.strictEqual(g.callWithRetry_(flaky, policy, 'flaky', s => slept.push(s)), 'done');
  same(slept, [5, 5]);

  slept.length = 0;
  assert.throws(() => g.callWithRetry_(() => { throw http(403, { reason: 'permissionDenied' }); }, policy, 'x', s => slept.push(s)),
    e => e instanceof g.PermanentError);
  assert.strictEqual(slept.length, 0);
});

// --- run_ ----------------------------------------------------------------

const job = name => ({ kind: 'copy', name, from_url: 'u', from_range: 'A1', to_url: 'u', to_range: 'A1' });
const ok = j => ({ name: j.name, status: 'ok', rows: 10, columns: 5, detail: '' });

function statusClient() {
  const c = { status: {}, batchSetValues: (ss, data) => data.forEach(d => { c.status[d.range.split('!').pop()] = d.values[0][0]; }) };
  return c;
}

function runWith(execute, opts = {}) {
  const c = statusClient();
  const scheduled = [];
  const ran = [];
  const report = g.run_(c, {
    settingsId: 'SSID', mode: 'import', execution: 'manual', user: 'me@x.com', timezone: 'Europe/Kyiv',
    jobs: [job('A'), job('B')], sleep() {}, now: () => 0,
    execute: (client, j) => { ran.push(j.name); return execute(j); },
    schedule: request => { scheduled.push(request); return true; },
    ...opts
  });
  return { report, cell: c.status.J2, scheduled, ran };
}

test('a transient failure is deferred to attempt 2', () => {
  const { report, cell, scheduled } = runWith(j => { if (j.name === 'B') throw http(503, { canonical: 'UNAVAILABLE' }); return ok(j); },
    { budgetMs: 0 });
  same(report.results.map(r => [r.name, r.status]), [['A', 'ok'], ['B', 'deferred']]);
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].attempt, 2);
  assert.strictEqual(scheduled[0].delaySeconds, 15 * 60);
  same(scheduled[0].jobs.map(j => j.name), ['B']);
  assert.match(cell, /^Failed: B did not sync - .* Retry 2 of 4 scheduled at .*, no action needed/);
});

test('a permanent failure schedules nothing', () => {
  const { report, cell, scheduled } = runWith(j => { if (j.name === 'B') throw http(403, { reason: 'permissionDenied' }); return ok(j); });
  same(report.results.map(r => [r.name, r.status]), [['A', 'ok'], ['B', 'failed']]);
  assert.strictEqual(scheduled.length, 0);
  assert.match(cell, /^Failed: B: HTTP 403 \(permissiondenied\)/);
});

test('the last attempt gives up', () => {
  const { report, cell, scheduled } = runWith(j => { if (j.name === 'B') throw http(503, { canonical: 'UNAVAILABLE' }); return ok(j); },
    { attempt: 4, maxAttempts: 4, budgetMs: 0 });
  assert.strictEqual(report.retryRequest, null);
  assert.strictEqual(scheduled.length, 0);
  assert.match(cell, /^Failed: Google Sheets stayed unavailable after 4 attempts. Not synced: B/);
});

test('a retry that cannot be scheduled reads as given up', () => {
  const { cell } = runWith(j => { if (j.name === 'B') throw http(503, { canonical: 'UNAVAILABLE' }); return ok(j); },
    { budgetMs: 0, schedule: () => false });
  assert.match(cell, /^Failed: Google Sheets stayed unavailable after 1 attempts/);
});

test('one row broken and one deferred are both reported', () => {
  const { cell, scheduled } = runWith(j => {
    if (j.name === 'A') throw http(403, { reason: 'permissionDenied' });
    throw http(503, { canonical: 'UNAVAILABLE' });
  }, { budgetMs: 0 });
  assert.strictEqual(scheduled.length, 1);
  assert.match(cell, /^Failed: A: HTTP 403 .*permission.* \| B did not sync .* Retry 2 of 4/i);
});

test('the headline states', () => {
  assert.strictEqual(runWith(ok).cell, 'Import successful');
  assert.strictEqual(runWith(ok, { jobs: [] }).cell, 'Import successful');
  assert.strictEqual(runWith(j => (j.name === 'A' ? ok(j) : { ...ok(j), status: 'skipped' })).cell, 'Import successful');
  assert.strictEqual(runWith(ok, { mode: 'export' }).cell, 'Export successful');
  const c = statusClient();
  g.run_(c, { settingsId: 'SSID', mode: 'database', jobs: [job('A')], execute: ok, databaseConfig: g.databaseConfig_() });
  assert.strictEqual(c.status.L2, 'Import successful');
});

test('a settings tab that cannot be read is retried as a whole', () => {
  const c = statusClient();
  c.getValues = () => { throw http(503, { canonical: 'UNAVAILABLE' }); };
  const scheduled = [];
  g.run_(c, { settingsId: 'SSID', mode: 'import', execution: 'manual', timezone: 'UTC', schedule: r => { scheduled.push(r); return true; } });
  assert.strictEqual(scheduled[0].jobs, null);
  assert.match(c.status.J2, /^Failed: settings did not sync/);
});

const chain = ['Rebuild', 'CopyA', 'CopyB', 'CopyC'].map(job);

test('a transient failure defers the rest of the run', () => {
  const { report, ran, scheduled } = runWith(j => { if (j.name === 'CopyA') throw http(503, { canonical: 'UNAVAILABLE' }); return ok(j); },
    { jobs: chain, budgetMs: 0 });
  same(ran, ['Rebuild', 'CopyA']); // CopyB/CopyC never ran on stale input
  same(report.results.map(r => r.status), ['ok', 'deferred', 'deferred', 'deferred']);
  same(scheduled[0].jobs.map(j => j.name), ['CopyA', 'CopyB', 'CopyC']); // and Rebuild is not redone
});

test('a permanent failure does not block the rest', () => {
  const { report, ran } = runWith(j => { if (j.name === 'CopyA') throw http(403, { reason: 'permissionDenied' }); return ok(j); },
    { jobs: chain });
  same(ran, ['Rebuild', 'CopyA', 'CopyB', 'CopyC']);
  same(report.results.map(r => r.status), ['ok', 'failed', 'ok', 'ok']);
  assert.strictEqual(report.retryRequest, null);
});

test('blocked rows run once the blocker clears, in the same run', () => {
  let tries = 0;
  const { report, ran, cell } = runWith(j => {
    if (j.name === 'CopyA' && ++tries === 1) throw http(503, { canonical: 'UNAVAILABLE' });
    return ok(j);
  }, { jobs: chain.slice(0, 3) });
  same(ran, ['Rebuild', 'CopyA', 'CopyA', 'CopyB']);
  assert.strictEqual(report.retryRequest, null);
  assert.strictEqual(cell, 'Import successful');
});

test('running out of time continues on the same attempt', () => {
  let clock = 0;
  const { ran, scheduled, cell } = runWith(j => { clock += 3 * 60 * 1000; return ok(j); },
    { jobs: chain, now: () => clock, attempt: 2 });
  same(ran, ['Rebuild', 'CopyA']);
  assert.strictEqual(scheduled[0].continuation, true);
  assert.strictEqual(scheduled[0].attempt, 2);
  assert.strictEqual(scheduled[0].delaySeconds, 60);
  same(scheduled[0].jobs.map(j => j.name), ['CopyB', 'CopyC']);
  assert.match(cell, /^In progress: CopyB, CopyC continue at /);
});

test('a continuation always starts at least one row', () => {
  const { ran } = runWith(ok, { jobs: chain, now: () => 0, budgetMs: -1 });
  same(ran, ['Rebuild']);
});
