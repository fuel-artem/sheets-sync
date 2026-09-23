/**
 * Port of insteadImportOptional / insteadExportOptional, which differed only in
 * the tab read and the checkbox column, so both are one code path here.
 *
 * Three retry layers wrap it:
 *
 *   1. per API call, in callWithRetry_ - seconds;
 *   2. per row, in run_ - retried inside this execution while its time budget
 *      lasts, then deferred;
 *   3. per run - what is left is handed to a one-off trigger, minutes later.
 *
 * A PermanentError enters none of them: the row is marked failed at once.
 *
 * Apps Script stops an execution at six minutes, so the budget also bounds how
 * many rows one execution starts. Rows left when it runs out are continued by
 * a trigger a minute later, on the same attempt.
 */

// Layer 2: waits between in-run passes over the rows that failed transiently,
// cut short by the execution's budget.
const IN_RUN_DELAYS = [30, 120, 300, 600];

// Layer 3: how long to wait before attempt 2, 3, 4.
const RETRY_DELAYS = [15 * 60, 45 * 60, 90 * 60];
const CONTINUE_DELAY = 60;
const DEFAULT_MAX_ATTEMPTS = 4;

// No new row starts after this; the remaining minutes are for the row in flight.
const RUN_BUDGET_MS = 4 * 60 * 1000;

// Must match the words the client stub shows, which reads the same cell.
const STATUS_FAILED = 'Failed';
const STATUS_RUNNING = 'In progress';
const MODE_LABEL = { import: 'Import', export: 'Export', database: 'Import' };

/** spreadsheet id, sheet properties and plain A1 range for a settings cell. */
function resolve_(client, url, a1) {
  const ssId = spreadsheetIdFromUrl_(url);
  const split = splitSheetTitle_(a1);
  return { ssId: ssId, props: client.sheetProps(ssId, sheetGidFromUrl_(url), split.title), range: split.range };
}

function runCopyJob_(client, job) {
  // --- source -------------------------------------------------------------
  const from = resolve_(client, job.from_url, job.from_range);
  const fromGrid = parseA1_(from.range, from.props.sheetId);
  const values = client.getValues(from.ssId, withSheetTitle_(from.range, from.props.title));
  if (!values) {
    console.info('[' + job.name + '] source range is empty, skipping');
    return { name: job.name, status: 'skipped', rows: 0, columns: 0, detail: 'source range empty' };
  }

  // Size of the block to clear on the target. A bounded source range wins over
  // the actual data size, so stale rows below the data still get wiped.
  const height = fromGrid.endRowIndex !== null ? fromGrid.endRowIndex - fromGrid.startRowIndex : values.length;
  const width = fromGrid.endColumnIndex !== null ? fromGrid.endColumnIndex - fromGrid.startColumnIndex : values[0].length;

  // --- target -------------------------------------------------------------
  const to = resolve_(client, job.to_url, job.to_range);
  let toProps = to.props;
  const toGrid = parseA1_(to.range, toProps.sheetId);
  const startRow = toGrid.startRowIndex;
  const startCol = toGrid.startColumnIndex;

  let maxRows = (toProps.gridProperties || {}).rowCount || 0;
  let maxCols = (toProps.gridProperties || {}).columnCount || 0;
  const availableRows = maxRows - startRow;
  const availableCols = maxCols - startCol;

  // Grow the target tab if the incoming block does not fit.
  if (height > availableRows || width > availableCols) {
    const extent = client.dataExtent(to.ssId, toProps.title);
    if (height > availableRows) {
      client.insertRowsAfter(to.ssId, toProps.sheetId, extent[0] > 0 ? extent[0] : maxRows, height - availableRows);
    }
    if (width > availableCols) {
      client.insertColumnsAfter(to.ssId, toProps.sheetId, extent[1] > 0 ? extent[1] : maxCols, width - availableCols);
    }
    toProps = client.sheetProps(to.ssId, toProps.sheetId, null);
    maxRows = (toProps.gridProperties || {}).rowCount || maxRows;
    maxCols = (toProps.gridProperties || {}).columnCount || maxCols;
  }

  // An open-ended source range clears to the bottom of the target tab;
  // a bounded one clears exactly as many rows as it covers.
  const clearEndRow = fromGrid.endRowIndex === null
    ? maxRows
    : fromGrid.endRowIndex - fromGrid.startRowIndex + startRow;
  client.clearRange(to.ssId, gridRange_(
    toProps.sheetId, startRow, Math.min(clearEndRow, maxRows), startCol, Math.min(startCol + width, maxCols)
  ), toProps.title);

  // --- write --------------------------------------------------------------
  const outWidth = values.reduce(function (w, row) { return Math.max(w, row.length); }, 0);
  const padded = values.map(function (row) { return row.concat(blanks_(outWidth - row.length)); });

  if (to.range.indexOf(':') >= 0 && toGrid.endColumnIndex !== null && startCol + outWidth > toGrid.endColumnIndex) {
    console.warn('[' + job.name + '] source is ' + outWidth + ' columns wide but target range '
      + to.range + ' is narrower; writing past it');
  }

  const target = gridToA1_(gridRange_(toProps.sheetId, startRow, startRow + padded.length, startCol, startCol + outWidth), toProps.title);
  client.setValues(to.ssId, target, padded);
  console.info('[' + job.name + '] wrote ' + padded.length + ' x ' + outWidth + ' to ' + target);
  return { name: job.name, status: 'ok', rows: padded.length, columns: outWidth, detail: '' };
}

/** One unit of work: a copy row, or a whole database rebuild. */
function executeJob_(client, job) {
  if (job.kind === 'database') {
    const outcome = runDatabaseJob_(client, job);
    return { name: job.name, status: 'ok', rows: outcome.rows, columns: outcome.columns, detail: '' };
  }
  return runCopyJob_(client, job);
}

/**
 * One pass over the pending rows; returns the ones to try again.
 *
 * Rows run in settings order and a later row may read what an earlier one
 * writes - a copy row pulling from the database the rebuild just refreshed is
 * the usual case. So a transient failure defers the rest of the run as well as
 * the row that hit it: running them now would use stale input, and nothing
 * would come back to redo them once the retry succeeds. Running out of time
 * defers the rest for the same reason.
 *
 * A permanent failure does not: it will not fix itself on a retry, so blocking
 * everything behind it only turns one broken row into a dead run.
 */
function runPass_(client, pending, results, state) {
  const execute = state.execute || executeJob_;
  const stillPending = [];
  let blockedBy = '';
  // Only the last pass decides whether what is left costs an attempt.
  state.transient = false;

  pending.forEach(function (item) {
    const job = item.job;
    // At least one row runs per execution, so a continuation always progresses.
    if (!blockedBy && state.started > 0 && state.now() > state.deadline) {
      blockedBy = 'the time limit';
      state.timedOut = true;
    }
    if (blockedBy) {
      results[item.index] = { name: job.name, status: 'deferred', rows: 0, columns: 0, detail: 'waiting for ' + blockedBy };
      stillPending.push(item);
      return;
    }
    state.started += 1;
    try {
      results[item.index] = execute(client, job);
    } catch (exc) {
      const error = classify_(exc);
      if (error instanceof TransientError) {
        state.transientDetail = String(error);
        state.transient = true;
        results[item.index] = { name: job.name, status: 'deferred', rows: 0, columns: 0, detail: String(error) };
        stillPending.push(item);
        blockedBy = job.name;
        console.warn('[' + job.name + '] transient failure, will retry: ' + error);
      } else {
        results[item.index] = { name: job.name, status: 'failed', rows: 0, columns: 0, detail: String(error) };
        console.error('[' + job.name + '] permanent failure: ' + error);
      }
    }
  });
  return stillPending;
}

/** What lands in the status cell. Detail only when something went wrong. */
function statusMessage_(report, timezone) {
  const names = report.deferred.map(function (j) { return j.name; }).join(', ') || 'settings';
  const retry = report.retryRequest && report.retryScheduled ? report.retryRequest : null;
  const gaveUp = (report.deferred.length > 0 || report.rereadSettings) && !retry;

  if (!report.error && !retry && !gaveUp) return (MODE_LABEL[report.mode] || 'Sync') + ' successful';

  const when = retry ? Utilities.formatDate(retry.notBefore, timezone || 'UTC', TIME_FORMAT) : '';
  if (!report.error && retry && retry.continuation) {
    return STATUS_RUNNING + ': ' + names + ' continue at ' + when
      + ' - one run can only take a few minutes, no action needed.';
  }

  const details = [];
  if (report.error) details.push(report.error);
  if (retry && retry.continuation) {
    details.push(names + ' continue at ' + when + ', no action needed.');
  } else if (retry) {
    details.push(names + ' did not sync - Google Sheets was temporarily unavailable. Retry '
      + retry.attempt + ' of ' + retry.maxAttempts + ' scheduled at ' + when
      + ', no action needed. Last error - ' + report.transientDetail);
  } else if (gaveUp && report.outOfTime) {
    details.push('The run ran out of time and could not schedule its continuation. Not synced: ' + names);
  } else if (gaveUp) {
    details.push('Google Sheets stayed unavailable after ' + report.attempt + ' attempts. Not synced: '
      + names + '. Last error - ' + report.transientDetail);
  }
  return STATUS_FAILED + ': ' + details.join(' | ');
}

/**
 * Run every enabled row of one settings tab, then write the status block.
 *
 * opts: settingsId, mode, execution, user, timezone, settingsTab, statusCells,
 * databaseConfig, flagColumn, jobs (null = read the tab), attempt, maxAttempts,
 * schedule(request) -> bool, and for tests: now, sleep, execute.
 */
function run_(client, opts) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || function (seconds) { Utilities.sleep(seconds * 1000); };
  const attempt = opts.attempt || 1;
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const report = {
    mode: opts.mode,
    attempt: attempt,
    results: [],
    error: '',
    deferred: [],
    transientDetail: '',
    rereadSettings: false,
    retryRequest: null,
    retryScheduled: false,
    outOfTime: false
  };
  const state = {
    now: now,
    deadline: now() + (opts.budgetMs === undefined ? RUN_BUDGET_MS : opts.budgetMs),
    started: 0,
    timedOut: false,
    transient: false,
    transientDetail: '',
    execute: opts.execute
  };

  // Reading the settings tab can fail the same two ways as a row.
  let jobs = opts.jobs;
  if (!jobs) {
    try {
      jobs = opts.mode === 'database'
        ? readDatabaseSettings_(client, opts.settingsId, opts.execution, opts.databaseConfig, opts.settingsTab, opts.flagColumn)
        : readJobs_(client, opts.settingsId, opts.mode, opts.execution, opts.flagColumn, opts.settingsTab);
    } catch (exc) {
      const error = classify_(exc);
      if (error instanceof TransientError) {
        report.transientDetail = String(error);
        report.rereadSettings = true;
        state.transient = true;
      } else {
        report.error = String(error);
      }
      console.warn('Could not read the settings tab: ' + error);
      jobs = [];
    }
  }

  const results = {};
  let pending = jobs.map(function (job, index) { return { index: index, job: job }; });
  for (let round = 0; pending.length && round <= IN_RUN_DELAYS.length; round++) {
    pending = runPass_(client, pending, results, state);
    if (!pending.length || state.timedOut || round >= IN_RUN_DELAYS.length) break;
    const delay = IN_RUN_DELAYS[round];
    if (now() + delay * 1000 > state.deadline) {
      console.warn(pending.length + ' row(s) still failing and this run has no time left to wait');
      break;
    }
    console.info('retrying ' + pending.length + ' row(s) in ' + delay + 's');
    sleep(delay);
  }
  if (state.transientDetail) report.transientDetail = state.transientDetail;

  report.results = Object.keys(results).map(Number).sort(function (a, b) { return a - b; })
    .map(function (i) { return results[i]; });
  report.deferred = pending.map(function (item) { return item.job; });

  // Rows that failed for a reason no retry will fix become the run's error.
  const failed = report.results.filter(function (r) { return r.status === 'failed'; });
  if (failed.length && !report.error) {
    report.error = failed.map(function (r) { return r.name + ': ' + r.detail; }).join('; ');
  }

  // Layer 3: a transient failure costs an attempt; running out of time does not.
  if (report.deferred.length || report.rereadSettings) {
    const continuation = !state.transient;
    report.outOfTime = continuation;
    if (continuation || attempt < maxAttempts) {
      const delay = continuation ? CONTINUE_DELAY : RETRY_DELAYS[Math.min(attempt - 1, RETRY_DELAYS.length - 1)];
      report.retryRequest = {
        attempt: continuation ? attempt : attempt + 1,
        maxAttempts: maxAttempts,
        continuation: continuation,
        delaySeconds: delay,
        notBefore: new Date(now() + delay * 1000),
        reason: report.transientDetail,
        // Only the rows that did not make it; null means "read the tab again".
        jobs: report.rereadSettings ? null : report.deferred
      };
      report.retryScheduled = opts.schedule ? opts.schedule(report.retryRequest) : false;
    }
  }

  try {
    writeStatus_(
      client, opts.settingsId, opts.mode, new Date(now()), opts.user,
      statusMessage_(report, opts.timezone), opts.timezone,
      // An explicit override wins; the database variant takes its cells from its config.
      opts.statusCells || (opts.mode === 'database' && opts.databaseConfig ? opts.databaseConfig.status_cells : null),
      opts.settingsTab
    );
  } catch (exc) {
    console.warn('Could not write the status block: ' + classify_(exc));
  }
  return report;
}
