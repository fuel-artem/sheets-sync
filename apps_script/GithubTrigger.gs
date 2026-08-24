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
  database_tab: 'General Database',
  ai_tab: 'AI Settings',
  ai_ranges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' }
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addItem('Run Database Import', 'manualDatabaseImport')
    .addSeparator()
    .addItem('Open Actions log', 'openActionsLog')
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
 * Database import: rebuilds General Database from every enabled source and
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
    const msg = 'GITHUB_TOKEN is not set in Script Properties.';
    if (!silent) SpreadsheetApp.getUi().alert(msg);
    throw new Error(msg);
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
    const message = 'GitHub returned ' + code + ': ' + response.getContentText();
    setQueuedStatus_(mode, message, email);
    if (!silent) SpreadsheetApp.getUi().alert(message);
    throw new Error(message);
  }

  setQueuedStatus_(mode, '', email, true);
  if (!silent) {
    ss.toast(mode + ' queued on GitHub Actions', 'Fuel Sync', 5);
  }
}

/**
 * Clear the previous error and mark the run as queued.
 * The workflow overwrites J2:J4 when it finishes.
 */
function setQueuedStatus_(mode, error, user, queued) {
  const tab = mode === 'export' ? 'Export Settings' : 'Import Settings';
  // The database variant keeps its status block in column L.
  const column = mode === 'database' ? 'L' : 'J';
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sheet) return;
  sheet.getRange(column + '2').setValue(error || '');
  sheet.getRange(column + '3').setValue(queued ? 'queued ' + new Date().toISOString() : '');
  sheet.getRange(column + '4').setValue(user || '');
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

function openActionsLog() {
  const owner = GITHUB_OWNER;
  const repo = GITHUB_REPO;
  const url =
    'https://github.com/' + owner + '/' + repo + '/actions/workflows/' + WORKFLOW_FILE;
  const html = HtmlService.createHtmlOutput(
    '<a href="' + url + '" target="_blank">Open the sheets-sync runs</a>'
  ).setWidth(320).setHeight(60);
  SpreadsheetApp.getUi().showModalDialog(html, 'GitHub Actions');
}
