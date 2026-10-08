// Port of insteadImportOptional / insteadExportOptional, which differed only in
// the tab read and the checkbox column, so both are one code path here.
//
// Three retry layers wrap it:
//
//   1. per API call, in callWithRetry_ - seconds;
//   2. per row, in runJobs_ - retried inside this execution while time allows;
//   3. per run - what is left is handed to a time-driven trigger (Main.gs).
//
// A PermanentError_ enters none of them: the row is marked failed at once.

// Layer 2: waits between in-execution passes over rows that failed transiently.
const IN_RUN_DELAYS_S_ = [30, 60, 120];

function resolve_(client, url, a1) {
  const spreadsheetId = spreadsheetIdFromUrl_(url);
  const [explicitTitle, plainRange] = splitSheetTitle_(a1);
  const props = client.sheetProps(spreadsheetId, sheetGidFromUrl_(url), explicitTitle);
  return { spreadsheetId: spreadsheetId, props: props, range: plainRange };
}

function result_(job, status, rows, columns, detail) {
  return { name: job.name, status: status, rows: rows || 0, columns: columns || 0, detail: detail || '' };
}

/**
 * Grow a tab when a height x width block at (startRow, startCol) does not fit.
 * Appended at the end rather than after the last row with data, as the original
 * did: finding that row means reading the whole tab, which on a large one is the
 * oversized request that earns a 503, and the values land the same either way.
 * Returns the tab's properties and size afterwards.
 */
function ensureFits_(client, spreadsheetId, props, startRow, startCol, height, width) {
  let maxRows = (props.gridProperties || {}).rowCount || 0;
  let maxCols = (props.gridProperties || {}).columnCount || 0;
  const availableRows = maxRows - startRow;
  const availableCols = maxCols - startCol;
  if (height > availableRows || width > availableCols) {
    if (height > availableRows) client.appendRows(spreadsheetId, props.sheetId, height - availableRows);
    if (width > availableCols) client.appendColumns(spreadsheetId, props.sheetId, width - availableCols);
    props = client.sheetProps(spreadsheetId, props.sheetId, null);
    maxRows = (props.gridProperties || {}).rowCount || maxRows;
    maxCols = (props.gridProperties || {}).columnCount || maxCols;
  }
  return { props: props, maxRows: maxRows, maxCols: maxCols };
}

function runCopyJob_(client, job) {
  // --- source
  const from = resolve_(client, job.fromUrl, job.fromRange);
  const fromGrid = parseA1_(from.range, from.props.sheetId);
  const values = client.getValues(from.spreadsheetId, withSheetTitle_(from.range, from.props.title));
  if (!values) {
    console.info('[' + job.name + '] source range is empty, skipping');
    return result_(job, 'skipped', 0, 0, 'source range empty');
  }

  // A bounded source range wins over the data size, so stale rows below the data
  // still get wiped on the target.
  const height = fromGrid.endRow != null ? fromGrid.endRow - fromGrid.startRow : values.length;
  const width = fromGrid.endCol != null ? fromGrid.endCol - fromGrid.startCol : values[0].length;

  // --- target
  const to = resolve_(client, job.toUrl, job.toRange);
  let toProps = to.props;
  const toGrid = parseA1_(to.range, toProps.sheetId);
  const startRow = toGrid.startRow;
  const startCol = toGrid.startCol;
  const fit = ensureFits_(client, to.spreadsheetId, toProps, startRow, startCol, height, width);
  toProps = fit.props;
  const maxRows = fit.maxRows;
  const maxCols = fit.maxCols;

  // An open-ended source clears to the bottom of the target tab; a bounded one
  // clears exactly as many rows as it covers.
  const clearEndRow = fromGrid.endRow == null ? maxRows : fromGrid.endRow - fromGrid.startRow + startRow;
  client.clearRange(
    to.spreadsheetId,
    grid_(toProps.sheetId, startRow, Math.min(clearEndRow, maxRows), startCol, Math.min(startCol + width, maxCols)),
    toProps.title
  );

  // --- write, anchored and sized to the data: the API rejects a write wider
  // than a bounded range, which setValues never did.
  const outWidth = widest_(values);
  if (to.range.indexOf(':') !== -1 && toGrid.endCol != null && startCol + outWidth > toGrid.endCol) {
    console.warn('[' + job.name + '] source is ' + outWidth + ' columns wide but target range ' +
      to.range + ' is narrower; writing past it');
  }
  const target = grid_(toProps.sheetId, startRow, startRow + values.length, startCol, startCol + outWidth);
  writeGrid_(client, to.spreadsheetId, target, toProps.title, padRows_(values, outWidth));

  console.info('[' + job.name + '] wrote ' + values.length + ' x ' + outWidth + ' to ' + gridToA1_(target, toProps.title));
  return result_(job, 'ok', values.length, outWidth);
}

function execute_(client, job) {
  if (job.kind === 'database') {
    const outcome = runDatabaseJob_(client, job);
    return result_(job, 'ok', outcome.rows, outcome.columns);
  }
  return runCopyJob_(client, job);
}

/**
 * One pass over the pending jobs. Returns the ones left and why they are left:
 * 'transient' when Google failed, 'time' when the execution ran out of room.
 *
 * Jobs run in settings order and a later one may read what an earlier one
 * writes - a copy row pulling from the database a rebuild just refreshed is the
 * usual case. So a transient failure defers everything after it too: running
 * them now would use stale input. A permanent failure does not block the rest;
 * it will not fix itself, so holding the run behind it only kills the run.
 */
function runPass_(client, jobs, results, clock) {
  const left = [];
  let reason = null;
  let transient = '';
  for (const job of jobs) {
    if (reason === 'transient') {
      left.push(job);
      continue;
    }
    if (reason === 'time' || clock.now() > clock.startCutoff) {
      reason = 'time';
      left.push(job);
      continue;
    }
    try {
      results.set(job, execute_(client, job));
    } catch (exc) {
      const error = classify_(exc);
      if (error instanceof TransientError_) {
        console.warn('[' + job.name + '] transient failure, will retry: ' + error.message);
        results.set(job, result_(job, 'deferred', 0, 0, error.message));
        left.push(job);
        reason = 'transient';
        transient = error.message;
      } else {
        console.error('[' + job.name + '] permanent failure: ' + error.message);
        results.set(job, result_(job, 'failed', 0, 0, error.message));
      }
    }
  }
  return { left: left, reason: reason, transient: transient };
}

/** Layer 2: repeat passes over what failed transiently while the execution has time. */
function runJobs_(client, jobs, clock) {
  const results = new Map();
  let pass = { left: jobs, reason: null, transient: '' };
  let transient = '';
  for (let round = 0; ; round++) {
    pass = runPass_(client, pass.left, results, clock);
    if (pass.transient) transient = pass.transient;
    if (!pass.left.length || pass.reason !== 'transient' || round >= IN_RUN_DELAYS_S_.length) break;
    const delay = IN_RUN_DELAYS_S_[round] * 1000;
    if (clock.now() + delay > clock.startCutoff) break;
    console.info('retrying ' + pass.left.length + ' row(s) in ' + delay / 1000 + 's');
    clock.sleep(delay);
  }
  return {
    results: jobs.filter((job) => results.has(job)).map((job) => results.get(job)),
    left: pass.left,
    reason: pass.left.length ? pass.reason : null,
    transient: transient,
  };
}

/**
 * What lands in the status cell. Detail only when something went wrong; a
 * failure a human must act on always wins the headline.
 */
function statusMessage_(outcome) {
  const parts = outcome.errors.slice();
  if (outcome.leftNames.length) {
    const names = outcome.leftNames.join(', ');
    const when = outcome.nextAt && formatTime_(outcome.nextAt, outcome.timeZone);
    if (outcome.reason === 'time' && when) {
      const note = names + ' still to sync, continuing at ' + when + '.';
      if (!parts.length) return STATUS_RUNNING_ + ': ' + note;
      parts.push(note);
    } else if (outcome.reason === 'transient' && when) {
      parts.push(names + ' did not sync - Google Sheets was temporarily unavailable. Retry ' +
        (outcome.attempt + 1) + ' of ' + MAX_ATTEMPTS_ + ' scheduled at ' + when +
        ', no action needed. Last error - ' + outcome.transient);
    } else if (outcome.reason === 'transient') {
      parts.push('Google Sheets stayed unavailable after ' + outcome.attempt + ' attempts. Not synced: ' +
        names + '. Last error - ' + outcome.transient);
    } else {
      // The next run could not be scheduled; why is already among the errors.
      parts.push('Not synced: ' + names + '.');
    }
  }
  return parts.length ? STATUS_FAILED_ + ': ' + parts.join(' | ') : modeLabel_(outcome.mode) + ' successful';
}
