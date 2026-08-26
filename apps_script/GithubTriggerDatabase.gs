/**
 * Fuel Sync - import and export, for a spreadsheet with a database tab.
 *
 * Same as GithubTrigger.gs with one difference: here "Import" means the
 * database rebuild. It reads every enabled source off the Import Settings tab,
 * enriches each transaction from the AI Settings handbook, and rewrites the
 * database tab. There is no plain-copy import on this spreadsheet - the
 * non-database rows of the settings tab are copied as part of the same run.
 *
 * Use this file or GithubTrigger.gs - never both in the same Apps Script
 * project, because they declare the same names.
 *
 * The button no longer moves any data: it asks GitHub Actions to run
 * `sheets-sync.yml`. Everything that says *where* to dispatch is a constant
 * below. The only thing left in Project Settings -> Script Properties is the
 * credential:
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

// The same words sheets_sync.sync writes, so the cell reads the same way
// whichever half of the system touched it last.
const STATUS_FAILED = 'Failed';
const STATUS_RUNNING = 'In progress';

// Pinned REST API version. The two supported versions do not answer the dispatch
// the same way: '2026-03-10' returns 200 with a body carrying workflow_run_id,
// where '2022-11-28' returned 204 with no body. Any 2xx counts as success below,
// so neither version is a trap.
const GITHUB_API_VERSION = '2026-03-10';

// true  -> the enabled rows are read here and sent in the payload
// false -> only the spreadsheet id is sent and Python reads the tabs itself
//
// The rebuild is always assembled on the Python side, since it needs the AI
// Settings handbook as well as the settings rows, so this only affects export.
const SEND_JOBS_INLINE = false;

// The database layout. This is the per-client part of the old script - the
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
  // Where this spreadsheet keeps the status block for the rebuild: state,
  // timestamp, user. Both this script and the Python side read it from here,
  // so there is one place to change if it ever moves. Note this is a different
  // column from the export block, on a different tab.
  status_cells: ['L2', 'L3', 'L4']
};

// The export tab keeps its status block in column J.
const EXPORT_STATUS_CELLS = ['J2', 'J3', 'J4'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addToUi();
}

/**
 * Buttons keep their original names, so existing drawings stay wired up.
 * On this spreadsheet the import is the database rebuild.
 */
function manualImport() {
  dispatchWorkflow_('database', 'manual');
}

function manualExport() {
  dispatchWorkflow_('export', 'manual');
}

/**
 * Entry points for the Apps Script time-driven trigger. The schedule stays here
 * rather than in GitHub cron, because a cron run would need a spreadsheet id
 * stored on the GitHub side.
 */
function triggerImport() {
  dispatchWorkflow_('database', 'trigger', true);
}

function triggerExport() {
  dispatchWorkflow_('export', 'trigger', true);
}

/**
 * For messages people read. The rebuild is an import as far as anyone reading
 * the sheet is concerned; the cell it lands in is what tells the two apart.
 */
function modeLabel_(mode) {
  return mode === 'export' ? 'Export' : 'Import';
}

/** Which status block a mode writes to. */
function statusCells_(mode) {
  return mode === 'export' ? EXPORT_STATUS_CELLS : DATABASE_CONFIG.status_cells;
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
 * @param {string} mode - 'database' (the import) or 'export'
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
    setSheetStatus_(mode, STATUS_FAILED + ': ' + friendly, Session.getActiveUser().getEmail());
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
  } else if (SEND_JOBS_INLINE) {
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
  // Not `!== 204`: that rejected every successful dispatch under 2026-03-10.
  if (code < 200 || code >= 300) {
    const friendly = friendlyError_(mode, code);
    // The reader sees the plain sentence; the detail stays in the execution log.
    console.error('dispatch failed: HTTP ' + code + ': ' + response.getContentText());
    setSheetStatus_(mode, STATUS_FAILED + ': ' + friendly, email);
    if (!silent) showAlert_(friendly);
    throw new Error('dispatch failed with HTTP ' + code);
  }

  // 2026-03-10 names the run it created; worth having in the log when tracing one.
  try {
    const created = JSON.parse(response.getContentText() || '{}');
    if (created.workflow_run_id) {
      console.info('dispatched run ' + created.workflow_run_id);
    }
  } catch (e) {
    // 2022-11-28 answers with no body. Nothing to log, nothing wrong.
  }

  setSheetStatus_(
    mode,
    STATUS_RUNNING + ': ' + modeLabel_(mode).toLowerCase()
      + ' requested. This cell updates when it finishes.',
    email
  );
  if (!silent) {
    ss.toast(
      modeLabel_(mode) + ' started. The result will appear in cell ' + statusCells_(mode)[0]
        + ' in a few minutes - this sheet does not update instantly.',
      'Fuel Sync',
      8
    );
  }
}

/**
 * Write the status block: the state anyone reading the sheet needs, the time,
 * and who asked for it. The workflow overwrites all three when it finishes.
 */
function setSheetStatus_(mode, text, user) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tab = mode === 'export' ? 'Export Settings' : 'Import Settings';
  const cells = statusCells_(mode);
  const sheet = ss.getSheetByName(tab);
  if (!sheet) return;
  sheet.getRange(cells[0]).setValue(text);
  // Always stamped, so a failure never sits under a stale time.
  sheet.getRange(cells[1]).setValue(
    Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MM/dd/yyyy HH:mm:ss')
  );
  sheet.getRange(cells[2]).setValue(user || '');
}

/**
 * Read the enabled export rows, used only when SEND_JOBS_INLINE is true. The
 * rebuild never comes through here, so only the export flag columns matter.
 * Column layout: A name | B from URL | C from range | D to URL | E to range | F..G flags
 */
function collectJobs_(mode, execution) {
  const flagIndex = execution === 'trigger' ? 5 : 6;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Export Settings');
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
