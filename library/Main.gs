// SheetsSync: the public entry points. Everything else in this library is private.
//
// A library's Script Properties and Lock are one instance shared by every
// spreadsheet that uses it. So the calling script hands over its own as `host`
// - see bound/Sync.gs - and retry state and the lock stay per spreadsheet.

const STATUS_FAILED_ = 'Failed';
const STATUS_RUNNING_ = 'In progress';

const MAX_ATTEMPTS_ = 4;
// Layer 3: minutes before attempt 2, 3, 4.
const RETRY_DELAYS_MIN_ = [15, 45, 90];
// A run cut short by the execution limit carries on after this long.
const CONTINUE_DELAY_MIN_ = 1;

// How long Apps Script lets one execution run on this account before killing it.
// Google's quota page says six minutes for every account type; this Workspace
// account runs for thirty.
const EXECUTION_LIMIT_MS_ = 30 * 60 * 1000;
// Measured from when the execution started: no new job starts with less than
// JOB_RESERVE_MS_ left, and no backoff sleeps into the last DEADLINE_MARGIN_MS_.
const JOB_RESERVE_MS_ = 3 * 60 * 1000;
const DEADLINE_MARGIN_MS_ = 60 * 1000;
// When this library was loaded - the start of the execution at the latest - for
// callers that do not say when theirs began.
const LOADED_AT_ = Date.now();
const LOCK_WAIT_MS_ = 5 * 1000;

const STATE_PREFIX_ = 'sheetsSync:';
// A property value is capped at 9 KB, and the carried errors are the only
// unbounded part of the state.
const CARRIED_ERRORS_ = 10;
const CARRIED_ERROR_LENGTH_ = 300;

/**
 * Run one sync.
 *
 * request:
 *   mode            'import' | 'export' | 'database'
 *   execution       'manual' | 'trigger' - which checkbox column picks the rows
 *   spreadsheetId   the spreadsheet holding the settings tab
 *   settingsTab     its name
 *   requestedBy     written to the status block
 *   databaseConfig  database mode only: overrides of DATABASE_DEFAULTS_
 * host: { scriptApp, properties, lock, resumeHandler, startedAt } of the calling
 * script; startedAt is when its execution began, see bound/Sync.gs.
 *
 * Returns { status, busy, results }: the text written to the status cell, whether
 * the run was refused because another one holds the lock, and one result per job.
 */
function run(request, host) {
  return start_(request, host, { request: request, attempt: 1, pending: null, errors: [] }, false);
}

/** Handler for the retry and continuation triggers that `run` schedules. */
function resume(event, host) {
  const key = STATE_PREFIX_ + event.triggerUid;
  const raw = host.properties.getProperty(key);
  host.properties.deleteProperty(key);
  const trigger = host.scriptApp.getProjectTriggers().find((t) => t.getUniqueId() === event.triggerUid);
  if (trigger) host.scriptApp.deleteTrigger(trigger);
  if (!raw) return null;
  const state = JSON.parse(raw);
  return start_(state.request, host, state, true);
}

/** The rows a run would sync, one line each. Reads the settings, writes nothing. */
function plan(request, host) {
  const req = normalizeRequest_(request);
  const client = new SheetsClient_(host.scriptApp.getOAuthToken(), clock_(host.startedAt));
  return readSettings_(client, req).map((job) => job.kind === 'database'
    ? job.name + ' <- ' + job.sources.map((s) => s.name).join(', ')
    : job.name + ': ' + job.fromRange + ' -> ' + job.toRange);
}

function modeLabel_(mode) {
  return mode === 'export' ? 'Export' : 'Import';
}

function normalizeRequest_(request) {
  const req = Object.assign({}, request);
  if (['import', 'export', 'database'].indexOf(req.mode) === -1) throw new Error('Unknown mode: ' + req.mode);
  if (['manual', 'trigger'].indexOf(req.execution) === -1) throw new Error('Unknown execution: ' + req.execution);
  if (!req.spreadsheetId) throw new Error('request.spreadsheetId is required');
  if (!req.settingsTab) throw new Error('request.settingsTab is required');
  if (req.mode === 'database') {
    req.databaseConfig = databaseConfig_(req.databaseConfig);
  } else if (req.databaseConfig) {
    throw new Error('databaseConfig only applies to mode "database"');
  }
  return req;
}

function readSettings_(client, req) {
  return req.mode === 'database'
    ? readDatabaseSettings_(client, req.spreadsheetId, req.execution, req.databaseConfig, req.settingsTab)
    : readJobs_(client, req.spreadsheetId, req.mode, req.execution, req.settingsTab);
}

/** `startedAt`: when the execution began (ms or a Date); the time already spent counts. */
function clock_(startedAt) {
  const start = startedAt == null ? LOADED_AT_ : Number(startedAt);
  return {
    now: () => Date.now(),
    sleep: (ms) => Utilities.sleep(ms),
    startCutoff: start + EXECUTION_LIMIT_MS_ - JOB_RESERVE_MS_,
    deadline: start + EXECUTION_LIMIT_MS_ - DEADLINE_MARGIN_MS_,
  };
}

function start_(request, host, state, resumed) {
  const req = normalizeRequest_(request);
  if (!host.lock.tryLock(LOCK_WAIT_MS_)) {
    if (resumed) {
      schedule_(host, state, CONTINUE_DELAY_MIN_);
      return { status: 'Another sync is running; this one moves back a minute.', busy: true };
    }
    return { status: 'Another sync is already running on this spreadsheet. Try again in a few minutes.', busy: true };
  }
  try {
    const clock = clock_(host.startedAt);
    return sync_(req, state, host, new SheetsClient_(host.scriptApp.getOAuthToken(), clock), clock);
  } finally {
    host.lock.releaseLock();
  }
}

function schedule_(host, state, delayMinutes) {
  const trigger = host.scriptApp.newTrigger(host.resumeHandler)
    .timeBased().after(delayMinutes * 60 * 1000).create();
  host.properties.setProperty(STATE_PREFIX_ + trigger.getUniqueId(), JSON.stringify(state));
  return new Date(Date.now() + delayMinutes * 60 * 1000);
}

function carriedErrors_(errors) {
  return errors.slice(0, CARRIED_ERRORS_).map((e) => e.slice(0, CARRIED_ERROR_LENGTH_));
}

function sync_(req, state, host, client, clock) {
  const tab = req.settingsTab;
  const cells = req.mode === 'database' ? req.databaseConfig.statusCells : COPY_STATUS_CELLS_;
  // Permanent failures of earlier executions of this run, so a later success
  // does not overwrite them.
  const errors = state.errors.slice();
  let timeZone = null;
  let results = [];
  let left = null;
  let leftNames = [];
  let reason = null;
  let transient = '';

  try {
    timeZone = client.timeZone(req.spreadsheetId);
    writeStatus_(client, req.spreadsheetId, tab, cells, timeZone, req.requestedBy,
      STATUS_RUNNING_ + ': ' + modeLabel_(req.mode).toLowerCase() + ' running. This cell updates when it finishes.');
    let jobs = readSettings_(client, req);
    if (state.pending) jobs = jobs.filter((job) => state.pending.indexOf(job.id) !== -1);
    const outcome = runJobs_(client, jobs, clock);
    results = outcome.results;
    left = outcome.left.map((job) => job.id);
    leftNames = outcome.left.map((job) => job.name);
    reason = outcome.reason;
    transient = outcome.transient;
    results.filter((r) => r.status === 'failed').forEach((r) => errors.push(r.name + ': ' + r.detail));
  } catch (exc) {
    // Failed before any job ran: the settings read, or the first status write.
    const error = classify_(exc);
    if (error instanceof TransientError_) {
      left = state.pending;
      leftNames = ['settings'];
      reason = 'transient';
      transient = error.message;
    } else {
      errors.push(error.message);
    }
  }

  let nextAt = null;
  if (leftNames.length) {
    const retry = reason === 'transient';
    if (!retry || state.attempt < MAX_ATTEMPTS_) {
      try {
        nextAt = schedule_(host, {
          request: state.request,
          attempt: retry ? state.attempt + 1 : state.attempt,
          pending: left,
          errors: carriedErrors_(errors),
        }, retry ? RETRY_DELAYS_MIN_[Math.min(state.attempt - 1, RETRY_DELAYS_MIN_.length - 1)] : CONTINUE_DELAY_MIN_);
      } catch (exc) {
        errors.push('Could not schedule the next run: ' + ((exc && exc.message) || exc));
      }
    }
  }

  const status = statusMessage_({
    mode: req.mode, errors: errors, leftNames: leftNames, reason: reason, transient: transient,
    nextAt: nextAt, attempt: state.attempt, timeZone: timeZone,
  });
  try {
    writeStatus_(client, req.spreadsheetId, tab, cells, timeZone || client.timeZone(req.spreadsheetId),
      req.requestedBy, status);
  } catch (exc) {
    console.error('Could not write the status block: ' + classify_(exc).message);
  }
  return { status: status, busy: false, results: results };
}
