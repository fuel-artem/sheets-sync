/**
 * Fuel Sync - import and export, run in Apps Script by the SheetsSync library.
 *
 * For a spreadsheet with a database tab use SyncDatabase.gs instead. Never both
 * in one project: they declare the same names.
 */

const SETTINGS_TABS = { import: 'Import Settings', export: 'Export Settings' };

// Top-level code runs when an execution starts, so this is its start time.
const STARTED_AT = Date.now();

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addToUi();
}

/** Original names, so existing drawings stay wired. */
function manualImport() {
  sync_('import', 'manual');
}

function manualExport() {
  sync_('export', 'manual');
}

/** Time-driven trigger entry points. */
function triggerImport() {
  sync_('import', 'trigger');
}

function triggerExport() {
  sync_('export', 'trigger');
}

/** Retries and continuations land here; host_ names it for the library. */
function sheetsSyncResume(event) {
  SheetsSync.resume(event, host_());
}

/** Run from the editor before the first real sync: lists the rows, writes nothing. */
function previewImport() {
  preview_('import');
}

function previewExport() {
  preview_('export');
}

function sync_(mode, execution) {
  const outcome = SheetsSync.run(request_(mode, execution), host_());
  if (execution === 'manual') SpreadsheetApp.getActive().toast(outcome.status, 'Fuel Sync', 10);
}

function preview_(mode) {
  const lines = SheetsSync.plan(request_(mode, 'manual'), host_());
  SpreadsheetApp.getUi().alert(lines.length ? lines.join('\n') : 'No rows are enabled.');
}

function request_(mode, execution) {
  return {
    mode: mode,
    execution: execution,
    spreadsheetId: SpreadsheetApp.getActive().getId(),
    settingsTab: SETTINGS_TABS[mode],
    requestedBy: Session.getActiveUser().getEmail() || (execution === 'trigger' ? 'schedule' : ''),
  };
}

/** A library's own properties and lock are shared by every spreadsheet that uses it. */
function host_() {
  return {
    scriptApp: ScriptApp,
    properties: PropertiesService.getScriptProperties(),
    lock: LockService.getScriptLock(),
    resumeHandler: 'sheetsSyncResume',
    startedAt: STARTED_AT,
  };
}
