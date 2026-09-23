/**
 * Fuel Sync - import and export. The work is done by the Fuel Sync library
 * (symbol FuelSync); this file only says what this spreadsheet looks like.
 *
 * For a spreadsheet with a database tab use FuelSyncDatabase.js instead.
 * Never both in one project: they declare the same names.
 */

// The settings tabs on this spreadsheet. The library reads nothing else.
const SETTINGS_TABS = { import: 'Import Settings', export: 'Export Settings' };

// Both tabs keep their status block in column J: state, timestamp, user.
const STATUS_CELLS = ['J2', 'J3', 'J4'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Fuel Sync')
    .addItem('Run Import', 'manualImport')
    .addItem('Run Export', 'manualExport')
    .addToUi();
}

/** Buttons keep their original names, so existing drawings stay wired up. */
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

/** A scheduled retry lands here; the library created its trigger. */
function fuelSyncResume(e) {
  FuelSync.resume(e);
}

/** Run from the editor: logs the rows an import would sync, writes nothing. */
function fuelSyncDryRun() {
  FuelSync.dryRun({
    mode: 'import',
    settingsTab: SETTINGS_TABS.import
  });
}

function sync_(mode, execution) {
  FuelSync.run({
    mode: mode,
    execution: execution,
    settingsTab: SETTINGS_TABS[mode],
    statusCells: STATUS_CELLS,
    silent: execution === 'trigger'
  });
}
