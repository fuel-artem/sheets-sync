// Reading the Import/Export Settings tabs and writing the status block.

// A name | B from URL | C from range | D to URL | E to range | F.. flags
const COL_NAME_ = 0;
const COL_FROM_URL_ = 1;
const COL_FROM_RANGE_ = 2;
const COL_TO_URL_ = 3;
const COL_TO_RANGE_ = 4;

// Which checkbox column picks the rows. Differs per mode on purpose, as in the
// original scripts: export trigger ? 5 : 6, import 6 : 7, database 7 : 8.
const FLAG_COLUMN_ = {
  export: { trigger: 5, manual: 6 },
  import: { trigger: 6, manual: 7 },
  database: { trigger: 7, manual: 8 },
};

// State, timestamp, user. The database variant takes its own from its config.
const COPY_STATUS_CELLS_ = ['J2', 'J3', 'J4'];
const TIME_FORMAT_ = 'MM/dd/yyyy HH:mm:ss';

function cell_(row, index, fallback) {
  return index < row.length && row[index] != null ? row[index] : (fallback === undefined ? '' : fallback);
}

function cellText_(row, index) {
  return String(cell_(row, index)).trim();
}

/** Short and stable across re-reads, so a retry can name its rows in a property. */
function jobId_(parts) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(parts), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(digest);
}

function copyJobFromRow_(row) {
  const job = {
    kind: 'copy',
    name: cellText_(row, COL_NAME_),
    fromUrl: cellText_(row, COL_FROM_URL_),
    fromRange: cellText_(row, COL_FROM_RANGE_),
    toUrl: cellText_(row, COL_TO_URL_),
    toRange: cellText_(row, COL_TO_RANGE_),
  };
  job.id = jobId_([job.name, job.fromUrl, job.fromRange, job.toUrl, job.toRange]);
  return job;
}

function requireCopyFields_(job, tab, line) {
  const missing = [['fromUrl', 'from URL'], ['fromRange', 'from range'], ['toUrl', 'to URL'], ['toRange', 'to range']]
    .filter(([key]) => !job[key])
    .map(([, label]) => label);
  if (missing.length) {
    throw new PermanentError_(tab + ' row ' + line + ' (' + job.name + ') is missing: ' + missing.join(', '));
  }
}

/** The enabled rows of a settings tab, with their sheet line numbers, in order. */
function enabledRows_(client, spreadsheetId, tab, flagColumn) {
  const rows = client.getValues(spreadsheetId, withSheetTitle_('A2:Z', tab)) || [];
  const enabled = [];
  rows.forEach((row, offset) => {
    // The flag column holds a checkbox, so an unformatted read gives a bool.
    if (cellText_(row, COL_NAME_) && cell_(row, flagColumn)) enabled.push([offset + 2, row]);
  });
  return enabled;
}

function readJobs_(client, spreadsheetId, mode, execution, tab) {
  const jobs = enabledRows_(client, spreadsheetId, tab, FLAG_COLUMN_[mode][execution]).map(([line, row]) => {
    const job = copyJobFromRow_(row);
    requireCopyFields_(job, tab, line);
    return job;
  });
  console.info(tab + ': ' + jobs.length + ' enabled row(s) for execution=' + execution);
  return jobs;
}

function formatTime_(date, timeZone) {
  return timeZone ? Utilities.formatDate(date, timeZone, TIME_FORMAT_) : date.toISOString();
}

function writeStatus_(client, spreadsheetId, tab, cells, timeZone, user, text) {
  client.batchSetValues(spreadsheetId, [
    { range: withSheetTitle_(cells[0], tab), values: [[text]] },
    { range: withSheetTitle_(cells[1], tab), values: [[formatTime_(new Date(), timeZone)]] },
    { range: withSheetTitle_(cells[2], tab), values: [[user || '']] },
  ]);
}
