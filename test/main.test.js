// The public entry points against a fake Sheets REST API, so the URLs, the
// service-account token and the retry trigger are exercised as Apps Script
// would run them.
const test = require('node:test');
const assert = require('node:assert');
const { load, same } = require('./harness');

const SRC_URL = 'https://docs.google.com/spreadsheets/d/SRCID/edit#gid=11';
const DST_URL = 'https://docs.google.com/spreadsheets/d/DSTID/edit#gid=22';

function platform({ lockFree = true, sheetsDown = false } = {}) {
  const calls = [];
  const writes = {};
  const props = { GCP_SA_KEY: JSON.stringify({ client_email: 'sync@x.iam.gserviceaccount.com', private_key: 'KEY' }) };
  const cache = {};
  let triggers = [];
  let uid = 0;

  const sheets = {
    SETTINGS: [{ properties: { sheetId: 0, title: 'Import Settings', gridProperties: { rowCount: 100, columnCount: 26 } } }],
    SRCID: [{ properties: { sheetId: 11, title: 'Source', gridProperties: { rowCount: 100, columnCount: 10 } } }],
    DSTID: [{ properties: { sheetId: 22, title: 'Target', gridProperties: { rowCount: 100, columnCount: 10 } } }]
  };
  const values = {
    "SETTINGS 'Import Settings'!A2:Z": [['Bank', SRC_URL, 'A2:C', DST_URL, 'A2', '', '', true]],
    "SRCID 'Source'!A2:C": [[1, 2, 3], [4, 5, 6]]
  };

  function respond(code, body) {
    return { getResponseCode: () => code, getContentText: () => JSON.stringify(body), getHeaders: () => ({}) };
  }

  const services = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getId: () => 'SETTINGS', getSpreadsheetTimeZone: () => 'UTC', toast() {} }),
      getUi: () => { throw new Error('no UI in a trigger'); }
    },
    Session: { getActiveUser: () => ({ getEmail: () => 'me@x.com' }) },
    LockService: { getDocumentLock: () => ({ tryLock: () => lockFree, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        getProperties: () => ({ ...props }),
        setProperties: o => Object.assign(props, o),
        deleteProperty: k => { delete props[k]; }
      })
    },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    ScriptApp: {
      newTrigger: handler => ({
        timeBased: () => ({
          after: ms => ({
            create: () => {
              const t = { handler, ms, getUniqueId: () => t.id, id: 'T' + ++uid };
              triggers.push(t);
              return t;
            }
          })
        })
      }),
      getProjectTriggers: () => triggers,
      deleteTrigger: t => { triggers = triggers.filter(x => x !== t); }
    },
    Utilities: {
      formatDate: () => '09/23/2026 12:00:00',
      sleep() {},
      base64EncodeWebSafe: v => Buffer.from(v).toString('base64url'),
      computeRsaSha256Signature: () => [1, 2, 3]
    },
    UrlFetchApp: {
      fetch(url, options) {
        calls.push([options.method, url]);
        if (url === 'https://oauth2.googleapis.com/token') {
          assert.strictEqual(options.payload.grant_type, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
          return respond(200, { access_token: 'TOKEN', expires_in: 3600 });
        }
        assert.strictEqual(options.headers.Authorization, 'Bearer TOKEN');
        if (sheetsDown) return respond(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'down' } });
        const m = url.match(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/?:]+)(.*)$/);
        const [, ss, rest] = m;
        if (rest.startsWith('?fields=')) return respond(200, { sheets: sheets[ss] });
        if (rest === '/values:batchUpdate') {
          JSON.parse(options.payload).data.forEach(d => { writes[`${ss} ${d.range}`] = d.values; });
          return respond(200, {});
        }
        const range = decodeURIComponent(rest.replace(/^\/values\//, '').replace(/[?:].*$/, ''));
        if (options.method === 'get') return respond(200, { values: values[`${ss} ${range}`] });
        if (options.method === 'put') { writes[`${ss} ${range}`] = JSON.parse(options.payload).values; return respond(200, {}); }
        if (rest.endsWith(':clear')) { writes[`${ss} clear ${range}`] = true; return respond(200, {}); }
        throw new Error('unexpected ' + options.method + ' ' + url);
      }
    }
  };
  return { services, calls, writes, props, triggers: () => triggers };
}

test('run copies the enabled row and writes the status block', () => {
  const p = platform();
  const g = load(p.services);
  g.run({ mode: 'import', execution: 'manual', settingsTab: 'Import Settings' });

  same(p.writes["DSTID 'Target'!A2:C3"], [[1, 2, 3], [4, 5, 6]]);
  assert.ok(p.writes["DSTID clear 'Target'!A2:C100"]);
  same(p.writes["SETTINGS 'Import Settings'!J2"], [['Import successful']]);
  same(p.writes["SETTINGS 'Import Settings'!J4"], [['me@x.com']]);
  // One token for the whole run, from the cache after the first call.
  assert.strictEqual(p.calls.filter(c => c[1].includes('oauth2')).length, 1);
});

test('a transient outage leaves a retry trigger that resume picks up', () => {
  const p = platform({ sheetsDown: true });
  const g = load(p.services);
  g.run({ mode: 'import', execution: 'manual', settingsTab: 'Import Settings' });

  // The settings read failed, so the whole run is retried and nothing was written.
  const [trigger] = p.triggers();
  assert.strictEqual(trigger.handler, 'fuelSyncResume');
  assert.strictEqual(trigger.ms, 15 * 60 * 1000);
  assert.ok(p.props['resume:' + trigger.id]);
});

test('resume runs the saved attempt, then removes its trigger and payload', () => {
  const p = platform({ sheetsDown: true });
  const g = load(p.services);
  g.run({ mode: 'import', execution: 'manual', settingsTab: 'Import Settings' });
  const [trigger] = p.triggers();

  const healthy = platform();
  Object.assign(p.services.UrlFetchApp, { fetch: healthy.services.UrlFetchApp.fetch });
  const report = g.resume({ triggerUid: trigger.id });

  assert.strictEqual(report.attempt, 2);
  same(healthy.writes["SETTINGS 'Import Settings'!J2"], [['Import successful']]);
  assert.strictEqual(p.triggers().length, 0);
  assert.deepStrictEqual(Object.keys(p.props).filter(k => k.startsWith('resume:')), []);
});

test('a busy spreadsheet queues the run instead of dropping it', () => {
  const p = platform({ lockFree: false });
  const g = load(p.services);
  assert.strictEqual(g.run({ mode: 'export', execution: 'trigger', silent: true }), null);
  const [trigger] = p.triggers();
  assert.strictEqual(trigger.ms, 60 * 1000);
  assert.strictEqual(p.calls.length, 0);
});

test('a large payload is split across properties and read back whole', () => {
  const p = platform();
  const g = load(p.services);
  const jobs = Array.from({ length: 200 }, (_, i) => ({ kind: 'copy', name: 'row ' + i, from_url: SRC_URL, from_range: 'A2:C', to_url: DST_URL, to_range: 'A2' }));
  g.saveResume_({ mode: 'import' }, 3, jobs, 60);
  const [trigger] = p.triggers();
  assert.ok(Object.keys(p.props).filter(k => k.startsWith('resume:' + trigger.id + ':')).length > 1);
  const back = g.takeResume_(trigger.id);
  assert.strictEqual(back.jobs.length, 200);
  assert.strictEqual(back.attempt, 3);
});
