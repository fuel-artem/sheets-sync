/** Reading the Import/Export Settings tabs and writing the status block. */

// Fallback tab names. The client project passes its own, since they are
// spreadsheet-specific like everything else about the layout.
const TAB = {
  import: 'Import Settings',
  export: 'Export Settings',
  // The Database import reads the same tab as the plain import; the variant
  // differs in its flag columns, its extra columns, and its status cells.
  database: 'Import Settings'
};

// A name | B from URL | C from range | D to URL | E to range | F..H flags
const COL_NAME = 0, COL_FROM_URL = 1, COL_FROM_RANGE = 2, COL_TO_URL = 3, COL_TO_RANGE = 4;

// Which checkbox column decides whether a row runs. Not a typo: the original
// scripts used export trigger ? 5 : 6 and import trigger ? 6 : 7, and the
// database variant shifts both by one again.
const FLAG_COLUMN = {
  export: { trigger: 5, manual: 6 },
  import: { trigger: 6, manual: 7 },
  database: { trigger: 7, manual: 8 }
};

// Error, timestamp, user. The database variant keeps its block in L.
const STATUS_CELLS = {
  import: ['J2', 'J3', 'J4'],
  export: ['J2', 'J3', 'J4'],
  database: ['L2', 'L3', 'L4']
};

const TIME_FORMAT = 'MM/dd/yyyy HH:mm:ss';

/** row[index], or fallback when the API trimmed it or it is null. */
function cellAt_(row, index, fallback) {
  return index < row.length && row[index] !== null && row[index] !== undefined
    ? row[index] : (fallback === undefined ? '' : fallback);
}

function copyJobFromRow_(row) {
  const text = function (i) { return String(cellAt_(row, i)).trim(); };
  return {
    kind: 'copy',
    name: text(COL_NAME),
    from_url: text(COL_FROM_URL),
    from_range: text(COL_FROM_RANGE),
    to_url: text(COL_TO_URL),
    to_range: text(COL_TO_RANGE)
  };
}

function missingFields_(job) {
  return ['from_url', 'from_range', 'to_url', 'to_range'].filter(function (f) { return !job[f]; });
}

/** The enabled rows of the Import/Export Settings tab, in sheet order. */
function readJobs_(client, settingsId, mode, execution, flagColumn, tab) {
  tab = tab || TAB[mode];
  const index = flagColumn === null || flagColumn === undefined ? FLAG_COLUMN[mode][execution] : flagColumn;
  const rows = client.getValues(settingsId, withSheetTitle_('A2:Z', tab)) || [];

  const jobs = [];
  rows.forEach(function (row, offset) {
    if (String(cellAt_(row, COL_NAME)).trim() === '') return;
    // The flag column holds a checkbox, so UNFORMATTED_VALUE gives a boolean.
    if (!cellAt_(row, index)) return;
    const job = copyJobFromRow_(row);
    const missing = missingFields_(job);
    if (missing.length) {
      throw new PermanentError(tab + ' row ' + (offset + 2) + ' (' + job.name + ') is missing: ' + missing.join(', '));
    }
    jobs.push(job);
  });
  console.info(tab + ': ' + jobs.length + ' enabled row(s) for execution=' + execution);
  return jobs;
}

/** statusImportUpdate / statusExportUpdate: three cells, one call. */
function writeStatus_(client, settingsId, mode, when, user, status, timezone, statusCells, tab) {
  tab = tab || TAB[mode];
  const cells = statusCells || STATUS_CELLS[mode];
  const formatted = when ? Utilities.formatDate(when, timezone || 'UTC', TIME_FORMAT) : '';
  client.batchSetValues(settingsId, [
    { range: withSheetTitle_(cells[0], tab), values: [[String(status || '')]] },
    { range: withSheetTitle_(cells[1], tab), values: [[formatted]] },
    { range: withSheetTitle_(cells[2], tab), values: [[user || '']] }
  ]);
}
