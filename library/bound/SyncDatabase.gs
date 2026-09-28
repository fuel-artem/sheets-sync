/**
 * Fuel Sync for a spreadsheet with a database tab, run in Apps Script by the
 * SheetsSync library. Same as Sync.gs, except "Import" is the database rebuild -
 * the non-database settings rows are copied by the same run.
 *
 * Never in the same project as Sync.gs: they declare the same names.
 */

const SETTINGS_TABS = { database: 'Import Settings', export: 'Export Settings' };

// The database layout. Omit a key to keep the library default.
const DATABASE_CONFIG = {
  transactionLength: 21,
  keepColumns: 37,
  trailingBlanks: 5,
  trailingNew: 3,
  databaseTab: 'General database',
  aiTab: 'AI Settings',
  aiRanges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' },
  // Status block for the rebuild: state, timestamp, user.
  statusCells: ['L2', 'L3', 'L4'],
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addToUi();
}

/** Original names, so existing drawings stay wired. Import = the rebuild. */
function manualImport() {
  sync_('database', 'manual');
}

function manualExport() {
  sync_('export', 'manual');
}

/** Time-driven trigger entry points. */
function triggerImport() {
  sync_('database', 'trigger');
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
  preview_('database');
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
  const request = {
    mode: mode,
    execution: execution,
    spreadsheetId: SpreadsheetApp.getActive().getId(),
    settingsTab: SETTINGS_TABS[mode],
    requestedBy: Session.getActiveUser().getEmail() || (execution === 'trigger' ? 'schedule' : ''),
  };
  if (mode === 'database') request.databaseConfig = DATABASE_CONFIG;
  return request;
}

/** A library's own triggers, properties and locks are shared by every caller. */
function host_() {
  return {
    scriptApp: ScriptApp,
    properties: PropertiesService.getScriptProperties(),
    lock: LockService.getScriptLock(),
    resumeHandler: 'sheetsSyncResume',
  };
}
