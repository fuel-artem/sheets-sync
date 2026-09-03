/**
 * Fuel Sync - import and export. The button dispatches `sheets-sync.yml`, which
 * reads the Settings tabs and writes the status block back.
 *
 * For a spreadsheet with a database tab use GithubTriggerDatabase.gs instead.
 * Never both in one project: they declare the same names.
 *
 * Script Properties: GITHUB_TOKEN, a fine-grained PAT with Actions: read and
 * write. It stays a property because this source is readable by every editor of
 * the spreadsheet and follows File > Make a copy.
 */

const GITHUB_OWNER = 'fuel-artem';
const GITHUB_REPO = 'sheets-sync';
const WORKFLOW_FILE = 'sheets-sync.yml';
const GIT_REF = 'main';

// Named in every alert: nobody who sees one can open the repository.
const SUPPORT_CONTACT = 'artemomelchenko@fuelfinance.me';

// Must match the words sheets_sync.sync writes to the same cell.
const STATUS_FAILED = 'Failed';
const STATUS_RUNNING = 'In progress';

// Both tabs keep their status block in column J: state, timestamp, user.
const STATUS_CELLS = ['J2', 'J3', 'J4'];

// The settings tabs on this spreadsheet. Sent with the dispatch, so the name
// is written down here and nowhere else.
const SETTINGS_TABS = { import: 'Import Settings', export: 'Export Settings' };

// 2026-03-10 answers the dispatch 200 with a body; 2022-11-28 answered 204 with
// none. Hence the 2xx check below rather than a literal status.
const GITHUB_API_VERSION = '2026-03-10';

// true  -> the enabled rows are read here and sent in the payload
// false -> only the spreadsheet id is sent and Python reads the tabs itself
const SEND_JOBS_INLINE = false;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addToUi();
}

/** Buttons keep their original names, so existing drawings stay wired up. */
function manualImport() {
  dispatchWorkflow_('import', 'manual');
}

function manualExport() {
  dispatchWorkflow_('export', 'manual');
}

/** Time-driven trigger entry points. The schedule lives here, not in GitHub cron. */
function triggerImport() {
  dispatchWorkflow_('import', 'trigger', true);
}

function triggerExport() {
  dispatchWorkflow_('export', 'trigger', true);
}

/** Which settings tab a mode reads. */
function settingsTab_(mode) {
  return mode === 'export' ? SETTINGS_TABS.export : SETTINGS_TABS.import;
}

/** For messages people read. */
function modeLabel_(mode) {
  return mode === 'export' ? 'Export' : 'Import';
}

/** Plain-language text for the reader; the HTTP detail goes to the log. */
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
    setSheetStatus_(mode, STATUS_FAILED + ': ' + friendly, Session.getActiveUser().getEmail());
    if (!silent) showAlert_(friendly);
    throw new Error('GITHUB_TOKEN is not set in Script Properties');
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const email = Session.getActiveUser().getEmail();

  const inputs = {
    mode: mode,
    execution: execution,
    settings_spreadsheet_id: ss.getId(),
    settings_tab: settingsTab_(mode),
    requested_by: email || 'sheet button',
    timezone: ss.getSpreadsheetTimeZone(),
    attempt: '1',
    not_before: ''
  };

  if (SEND_JOBS_INLINE) {
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
  if (code < 200 || code >= 300) {
    const friendly = friendlyError_(mode, code);
    console.error('dispatch failed: HTTP ' + code + ': ' + response.getContentText());
    setSheetStatus_(mode, STATUS_FAILED + ': ' + friendly, email);
    if (!silent) showAlert_(friendly);
    throw new Error('dispatch failed with HTTP ' + code);
  }

  try {
    const created = JSON.parse(response.getContentText() || '{}');
    if (created.workflow_run_id) {
      console.info('dispatched run ' + created.workflow_run_id);
    }
  } catch (e) {
    // 2022-11-28 sends no body.
  }

  setSheetStatus_(
    mode,
    STATUS_RUNNING + ': ' + modeLabel_(mode).toLowerCase()
      + ' requested. This cell updates when it finishes.',
    email
  );
  if (!silent) {
    ss.toast(
      modeLabel_(mode) + ' started. The result will appear in cell ' + STATUS_CELLS[0]
        + ' in a few minutes - this sheet does not update instantly.',
      'Fuel Sync',
      8
    );
  }
}

/** State, time, and who asked. The workflow overwrites all three when it finishes. */
function setSheetStatus_(mode, text, user) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(settingsTab_(mode));
  if (!sheet) return;
  sheet.getRange(STATUS_CELLS[0]).setValue(text);
  sheet.getRange(STATUS_CELLS[1]).setValue(
    Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'MM/dd/yyyy HH:mm:ss')
  );
  sheet.getRange(STATUS_CELLS[2]).setValue(user || '');
}

/**
 * Read the enabled rows, used only when SEND_JOBS_INLINE is true.
 * Column layout: A name | B from URL | C from range | D to URL | E to range | F..H flags
 */
function collectJobs_(mode, execution) {
  const tab = settingsTab_(mode);
  const flagIndex =
    mode === 'import'
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
