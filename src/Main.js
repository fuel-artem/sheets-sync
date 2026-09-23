/**
 * Fuel Sync library: the public entry points. Everything else ends in an
 * underscore, which keeps it out of the including project's reach.
 *
 * A spreadsheet includes the library and keeps a small stub (templates/) that
 * says what this spreadsheet looks like - its settings tab names, status cells
 * and database layout - and passes it in. Nothing about any one spreadsheet
 * lives here.
 */

// The stub's function a retry trigger calls. ScriptApp acts on the including
// project, so the trigger has to name a function that project declares.
const RESUME_HANDLER = 'fuelSyncResume';

// Retry payloads wait in the library's Script Properties, which every including
// project shares; the trigger uid keeps them apart.
const RESUME_PREFIX = 'resume:';
const PROPERTY_CHUNK = 8000; // a property value holds 9 KB
const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

const LOCK_WAIT_MS = 10 * 1000;

/**
 * Run an import, export or database rebuild on the spreadsheet this is called from.
 *
 * @param {Object} options
 * @param {string} options.mode - 'import', 'export' or 'database'
 * @param {string} options.execution - 'manual' or 'trigger': which checkbox column selects the rows
 * @param {string} [options.settingsTab] - the settings tab; blank uses Import/Export Settings
 * @param {string[]} [options.statusCells] - error, timestamp and user cells
 * @param {Object} [options.databaseConfig] - the database layout; see defaultDatabaseConfig_
 * @param {boolean} [options.silent] - no toasts or alerts (for time-driven triggers)
 * @return {Object} the run report
 */
function run(options) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const context = {
    settingsId: ss.getId(),
    mode: options.mode,
    execution: options.execution || 'manual',
    settingsTab: options.settingsTab || '',
    statusCells: options.statusCells || null,
    databaseConfig: options.mode === 'database' ? (options.databaseConfig || {}) : null,
    user: Session.getActiveUser().getEmail() || (options.execution === 'trigger' ? 'schedule' : 'sheet button'),
    timezone: ss.getSpreadsheetTimeZone(),
    silent: !!options.silent
  };
  return runContext_(context, 1, null, true);
}

/** Time-driven trigger handler for a scheduled retry; the stub forwards its event here. */
function resume(e) {
  const uid = e && e.triggerUid;
  const saved = uid ? takeResume_(uid) : null;
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getUniqueId() === uid; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  if (!saved) {
    console.warn('no saved retry for trigger ' + uid);
    return null;
  }
  saved.context.silent = true;
  return runContext_(saved.context, saved.attempt, saved.jobs, false);
}

/** The rows a run would sync, without writing anything. */
function dryRun(options) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const client = createClient_();
  const jobs = options.mode === 'database'
    ? readDatabaseSettings_(client, ss.getId(), options.execution || 'manual',
      databaseConfig_(options.databaseConfig), options.settingsTab)
    : readJobs_(client, ss.getId(), options.mode, options.execution || 'manual', null, options.settingsTab);
  jobs.forEach(function (job) { console.log(JSON.stringify(job)); });
  return jobs;
}

function statusCellsFor_(context, databaseConfig) {
  return context.statusCells || (databaseConfig ? databaseConfig.status_cells : STATUS_CELLS[context.mode]);
}

function runContext_(context, attempt, jobs, fresh) {
  // One run per spreadsheet at a time. A busy one is queued behind a minute's
  // wait rather than dropped, as the old workflow's concurrency group did.
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    saveResume_(context, attempt, jobs, CONTINUE_DELAY);
    notify_(context, 'Another sync is running on this spreadsheet. This one starts when it finishes.');
    return null;
  }
  try {
    const client = createClient_();
    const databaseConfig = context.mode === 'database' ? databaseConfig_(context.databaseConfig) : null;

    if (fresh) {
      // Best-effort, like the final write: an outage here is the run's to report.
      try {
        writeStatus_(client, context.settingsId, context.mode, new Date(), context.user,
          STATUS_RUNNING + ': ' + MODE_LABEL[context.mode].toLowerCase() + ' requested. This cell updates when it finishes.',
          context.timezone, statusCellsFor_(context, databaseConfig), context.settingsTab);
      } catch (e) {
        console.warn('Could not write the status block: ' + classify_(e));
      }
      notify_(context, MODE_LABEL[context.mode] + ' started. The result will appear in cell '
        + statusCellsFor_(context, databaseConfig)[0] + ' when it finishes.', true);
    }

    const report = run_(client, {
      settingsId: context.settingsId,
      mode: context.mode,
      execution: context.execution,
      user: context.user,
      timezone: context.timezone,
      settingsTab: context.settingsTab,
      statusCells: context.statusCells,
      databaseConfig: databaseConfig,
      jobs: jobs,
      attempt: attempt,
      schedule: function (request) {
        try {
          saveResume_(context, request.attempt, request.jobs, request.delaySeconds);
          return true;
        } catch (e) {
          console.error('could not schedule the retry: ' + e);
          return false;
        }
      }
    });

    report.results.forEach(function (r) {
      console.info(r.status + ' ' + r.name + ' ' + r.rows + 'x' + r.columns + ' ' + r.detail);
    });
    notify_(context, statusMessage_(report, context.timezone));
    return report;
  } finally {
    lock.releaseLock();
  }
}

/** Toasts and alerts are best-effort: a trigger has no UI to show them in. */
function notify_(context, message, toast) {
  if (context.silent) return;
  try {
    if (toast) {
      SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Fuel Sync', 8);
    } else {
      const ui = SpreadsheetApp.getUi();
      ui.alert('Fuel Sync', message, ui.ButtonSet.OK);
    }
  } catch (e) {
    console.warn('could not show a message: ' + e);
  }
}

/** Save what a retry needs, then create the one-off trigger that runs it. */
function saveResume_(context, attempt, jobs, delaySeconds) {
  const trigger = ScriptApp.newTrigger(RESUME_HANDLER).timeBased().after(delaySeconds * 1000).create();
  try {
    const store = PropertiesService.getScriptProperties();
    pruneResumes_(store);
    const text = JSON.stringify({ savedAt: Date.now(), context: context, attempt: attempt, jobs: jobs });
    const updates = {};
    const count = Math.ceil(text.length / PROPERTY_CHUNK);
    updates[RESUME_PREFIX + trigger.getUniqueId()] = JSON.stringify({ savedAt: Date.now(), chunks: count });
    for (let i = 0; i < count; i++) {
      updates[RESUME_PREFIX + trigger.getUniqueId() + ':' + i] = text.slice(i * PROPERTY_CHUNK, (i + 1) * PROPERTY_CHUNK);
    }
    store.setProperties(updates);
  } catch (e) {
    ScriptApp.deleteTrigger(trigger);
    throw e;
  }
}

function takeResume_(uid) {
  const store = PropertiesService.getScriptProperties();
  const head = store.getProperty(RESUME_PREFIX + uid);
  if (!head) return null;
  const chunks = JSON.parse(head).chunks;
  let text = '';
  for (let i = 0; i < chunks; i++) text += store.getProperty(RESUME_PREFIX + uid + ':' + i) || '';
  deleteResume_(store, uid, chunks);
  return JSON.parse(text);
}

function deleteResume_(store, uid, chunks) {
  store.deleteProperty(RESUME_PREFIX + uid);
  for (let i = 0; i < chunks; i++) store.deleteProperty(RESUME_PREFIX + uid + ':' + i);
}

/** A payload whose trigger was deleted by hand would otherwise sit here for good. */
function pruneResumes_(store) {
  const all = store.getProperties();
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(RESUME_PREFIX) !== 0 || key.slice(RESUME_PREFIX.length).indexOf(':') >= 0) return;
    const head = JSON.parse(all[key]);
    if (Date.now() - head.savedAt > RESUME_TTL_MS) deleteResume_(store, key.slice(RESUME_PREFIX.length), head.chunks);
  });
}
