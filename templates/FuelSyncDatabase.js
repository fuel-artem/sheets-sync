/**
 * Fuel Sync for a spreadsheet with a database tab. Same as FuelSync.js, except
 * "Import" is the database rebuild - the non-database settings rows are copied
 * by the same run, so there is no plain-copy import here.
 *
 * Never in the same project as FuelSync.js: they declare the same names.
 */

// The database layout. Omit a key to keep the library's default.
const DATABASE_CONFIG = {
  transaction_length: 21,
  keep_columns: 37,
  trailing_blanks: 5,
  trailing_new: 3,
  database_tab: 'General database',
  ai_tab: 'AI Settings',
  ai_ranges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' },
  // Status block for the rebuild: state, timestamp, user.
  status_cells: ['L2', 'L3', 'L4']
};

// The export tab keeps its status block in column J.
const EXPORT_STATUS_CELLS = ['J2', 'J3', 'J4'];

// The rebuild reads the import tab.
const SETTINGS_TABS = { database: 'Import Settings', export: 'Export Settings' };

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

/** A scheduled retry lands here; the library created its trigger. */
function fuelSyncResume(e) {
  FuelSync.resume(e);
}

/** Run from the editor: logs the rows an import would sync, writes nothing. */
function fuelSyncDryRun() {
  FuelSync.dryRun({
    mode: 'database',
    settingsTab: SETTINGS_TABS.database,
    databaseConfig: DATABASE_CONFIG
  });
}

function sync_(mode, execution) {
  FuelSync.run({
    mode: mode,
    execution: execution,
    settingsTab: SETTINGS_TABS[mode],
    statusCells: mode === 'export' ? EXPORT_STATUS_CELLS : null,
    databaseConfig: mode === 'database' ? DATABASE_CONFIG : null,
    silent: execution === 'trigger'
  });
}
