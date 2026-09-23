// Loads src/*.js into one context, the way Apps Script concatenates a
// project's files, with the platform services stubbed.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function formatDate(date, timeZone, pattern) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(p => { parts[p.type] = p.value; });
  return pattern.replace('MM', parts.month).replace('dd', parts.day).replace('yyyy', parts.year)
    .replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second);
}

function load(services = {}) {
  const context = vm.createContext({
    console: { info() {}, warn() {}, error() {}, log() {} },
    Utilities: { formatDate, sleep() {} },
    ...services
  });
  const dir = path.join(__dirname, '..', 'src');
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), context, { filename: file });
  }
  return new Proxy({}, { get: (_, name) => vm.runInContext(String(name), context) });
}

// Values made inside the context have its own Array and Object, so compare as data.
function same(actual, expected) {
  require('node:assert').deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected);
}

module.exports = { load, same };
