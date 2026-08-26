/**
 * Replacement for manualImport / manualExport.
 *
 * The button no longer moves any data: it asks GitHub Actions to run
 * `sheets-sync.yml`, which reads the same Import/Export Settings tabs and
 * writes the status block back into J2:J4.
 *
 * Everything that says *where* to dispatch is a constant below. The only thing
 * left in Project Settings -> Script Properties is the credential:
 *   GITHUB_TOKEN  fine-grained PAT with "Actions: read and write" on the repo
 *
 * It stays a property rather than a constant because Apps Script source is
 * readable by every editor of this spreadsheet, travels with File > Make a copy,
 * and is retained in the project's version history. A Script Property is none of
 * those things. Inline it only if you accept that.
 */

const GITHUB_OWNER = 'fuel-artem';
const GITHUB_REPO = 'sheets-sync';
const WORKFLOW_FILE = 'sheets-sync.yml';
const GIT_REF = 'main';

// Shown in the alerts people see when a sync cannot start. Nobody reading
// them can open the repository, so the message has to name a human.
const SUPPORT_CONTACT = 'artemomelchenko@fuelfinance.me';

// Pinned REST API version. GitHub currently supports '2026-03-10' and the older
// '2022-11-28'. Only the dispatch POST is called and it answers 204 with no body,
// so there is no response shape a version bump could break.
const GITHUB_API_VERSION = '2026-03-10';

// true  -> the enabled rows are read here and sent in the payload
// false -> only the spreadsheet id is sent and Python reads the tabs itself
const SEND_JOBS_INLINE = false;

// Database import layout. This is the per-client part of the old script - the
// `databaseLength` constant and the column layout around it. It travels with the
// dispatch, so nothing about this spreadsheet is stored on the GitHub side.
// Omit a key to keep the documented default.
const DATABASE_CONFIG = {
  transaction_length: 21,
  keep_columns: 37,
  trailing_blanks: 5,
  trailing_new: 3,
  database_tab: 'General database',
  ai_tab: 'AI Settings',
  ai_ranges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' },
  // Where this spreadsheet keeps the database status block: error, timestamp,
  // user. Both this script and the Python side read it from here, so there is
  // one place to change if it ever moves.
  status_cells: ['L2', 'L3', 'L4']
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addItem('Run Database Import', 'manualDatabaseImport')
    .addToUi();
}

/** Buttons keep their original names, so existing drawings stay wired up. */
function manualImport() {
  dispatchWorkflow_('import', 'manual');
}

function manualExport() {
  dispatchWorkflow_('export', 'manual');
}

/**
 * Database import: rebuilds General database from every enabled source and
 * enriches each transaction from the AI Settings handbook. Status lands in
 * L2:L4 rather than J2:J4, as in the original script.
 */
function manualDatabaseImport() {
  dispatchWorkflow_('database', 'manual');
}

function triggerDatabaseImport() {
  dispatchWorkflow_('database', 'trigger', true);
}

/**
 * Entry points for the Apps Script time-driven trigger. The schedule stays here
 * rather than in GitHub cron, because a cron run would need a spreadsheet id
 * stored on the GitHub side.
 */
function triggerImport() {
  dispatchWorkflow_('import', 'trigger', true);
}

function triggerExport() {
  dispatchWorkflow_('export', 'trigger', true);
}

/** 'database' -> 'Database import', for messages people read. */
function modeLabel_(mode) {
  if (mode === 'export') return 'Export';
  if (mode === 'database') return 'Database import';
  return 'Import';
}

/**
 * Turn an HTTP failure into something a non-technical reader can act on.
 * The technical detail goes to the execution log, not to the screen.
 */
function friendlyError_(mode, code) {
  const what = modeLabel_(mode).toLowerCase();
  if (code === 401 || code === 403) {
    return 'The ' + what + ' could not start because this spreadsheet no longer has'
      + ' permission to run it. The access key has most likely expired.'
      + ' Please contact ' + SUPPORT_CONTACT + '.';
  }
  if (code === 404) {
    return 'The ' + what + ' could not start because the automation was not found.'
      + ' It may have been moved or renamed. Please contact ' + SUPPORT_CONTACT + '.';
  }
  if (code === 422) {
    return 'The ' + what + ' could not start because of a setup problem in the'
      + ' automation. Nothing was changed. Please contact ' + SUPPORT_CONTACT + '.';
  }
  if (code === 429) {
    return 'The ' + what + ' was asked for too many times in a row.'
      + ' Please wait a minute and try again.';
  }
  if (code >= 500) {
    return 'The service that runs the ' + what + ' is temporarily unavailable.'
      + ' Please try again in a few minutes.';
  }
  return 'The ' + what + ' could not start (error ' + code + ').'
    + ' Nothing was changed. Please contact ' + SUPPORT_CONTACT + '.';
}

/** Alerts are best-effort: a missing UI context must not hide the real error. */
function showAlert_(message) {
  try {
    const ui = SpreadsheetApp.getUi();
    ui.alert('Fuel Sync', message, ui.ButtonSet.OK);
  } catch (e) {
    console.warn('could not show alert: ' + e);
  }
}

/**
 * Send a workflow_dispatch request to GitHub.
 *
 * @param {string} mode - 'import' or 'export'
 * @param {string} execution - 'manual' or 'trigger' (which checkbox column to use)
 * @param {boolean} [silent=false] - no UI alerts (for time-driven triggers)
 */
function dispatchWorkflow_(mode, execution, silent) {
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');

  if (!token) {
    const friendly = modeLabel_(mode) + ' is not set up on this spreadsheet yet,'
      + ' so nothing was run. Please contact ' + SUPPORT_CONTACT + '.';
    setQueuedStatus_(mode, friendly, Session.getActiveUser().getEmail());
    if (!silent) showAlert_(friendly);
    throw new Error('GITHUB_TOKEN is not set in Script Properties');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const email = Session.getActiveUser().getEmail();

  // Everything the run needs travels in this payload. GitHub holds no default
  // spreadsheet id, so a run that is not started from here has nothing to act on.
  const inputs = {
    mode: mode,
    execution: execution,
    settings_spreadsheet_id: ss.getId(),
    requested_by: email || 'sheet button',
    timezone: ss.getSpreadsheetTimeZone(),
    attempt: '1',
    not_before: ''
  };

  if (mode === 'database') {
    inputs.database_config = JSON.stringify(DATABASE_CONFIG);
  }

  if (SEND_JOBS_INLINE && mode !== 'database') {
    // The database rebuild is assembled on the Python side, since it needs the
    // AI Settings handbook as well as the settings rows.
    inputs.jobs_json = JSON.stringify(collectJobs_(mode, execution));
  }

  const url =
    'https://api.github.com/repos/' + owner + '/' + repo +
    '/actions/workflows/' + WORKFLOW_FILE + '/dispatches';

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION
    },
    payload: JSON.stringify({ ref: GIT_REF, inputs: inputs })
  });

  const code = response.getResponseCode();
  if (code !== 204) {
    const friendly = friendlyError_(mode, code);
    // The reader sees the plain sentence; the detail stays in the execution log.
    console.error('dispatch failed: HTTP ' + code + ': ' + response.getContentText());
    setQueuedStatus_(mode, friendly, email);
    if (!silent) showAlert_(friendly);
    throw new Error('dispatch failed with HTTP ' + code);
  }

  setQueuedStatus_(mode, '', email, true);
  if (!silent) {
    const cell = mode === 'database' ? DATABASE_CONFIG.status_cells[0] : 'J2';
    ss.toast(
      modeLabel_(mode) + ' started. The result will appear in cell ' + cell
        + ' in a few minutes - this sheet does not update instantly.',
      'Fuel Sync',
      8
    );
  }
}

/**
 * Clear the previous error and mark the run as queued.
 * The workflow overwrites J2:J4 when it finishes.
 */
function setQueuedStatus_(mode, error, user, queued) {
  const tab = mode === 'export' ? 'Export Settings' : 'Import Settings';
  // The database variant keeps its own block; DATABASE_CONFIG is the one place
  // that says where, and the same value is sent to Python in the payload.
  const cells = mode === 'database'
    ? DATABASE_CONFIG.status_cells
    : ['J2', 'J3', 'J4'];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sheet) return;
  sheet.getRange(cells[0]).setValue(error || '');
  sheet.getRange(cells[1]).setValue(queued ? 'queued ' + new Date().toISOString() : '');
  sheet.getRange(cells[2]).setValue(user || '');
}

/**
 * Read the enabled rows, used only when SEND_JOBS_INLINE is true.
 * Column layout: A name | B from URL | C from range | D to URL | E to range | F..H flags
 */
function collectJobs_(mode, execution) {
  const tab = mode === 'export' ? 'Export Settings' : 'Import Settings';
  const flagIndex =
    mode === 'database'
      ? (execution === 'trigger' ? 7 : 8)
      : mode === 'import'
      ? (execution === 'trigger' ? 6 : 7)
      : (execution === 'trigger' ? 5 : 6);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  const rows = sheet
    .getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn())
    .getValues()
    .filter(function (r) {
      return r[0] !== '' && r[flagIndex] === true;
    });

  return rows.map(function (r) {
    return {
      name: String(r[0]),
      from_url: String(r[1]),
      from_range: String(r[2]),
      to_url: String(r[3]),
      to_range: String(r[4])
    };
  });
}
