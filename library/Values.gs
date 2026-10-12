// setValues / getValues for scripts that compute their own data: the same REST
// calls, retries, pacing, chunked writes and tab growth as a sync, without a
// settings tab. They run as the user, so the calling script's manifest needs
// the spreadsheets and script.external_request scopes.
//
// A location is { url, range }, as in a settings row: `url` is a spreadsheet
// URL (its #gid picks the tab, else the first) or a bare id, and `range` is A1,
// optionally 'Tab name'!A1, which wins over the gid.

/**
 * Write values, like Range.setValues(), to one location or to a list of them.
 *
 *   setValues({ url, range }, [[1, 2], [3, 4]])
 *   setValues([locationA, locationB], [valuesA, valuesB])
 *
 * The range decides what is replaced. An anchor cell ('A2') only writes. An
 * explicit range ('A2:E100', 'A2:E') is cleared first, down to its last row or to
 * the bottom of the tab, so rows left over from a longer write disappear, as in a
 * sync. Values are written from the top-left and sized to the data; jagged rows
 * are padded, Dates are written as dates, and the tab grows if the data does not fit.
 *
 * Every location is attempted. If any fail, one error is thrown at the end, with
 * `failures`: [{ location, message, transient }], `transient` meaning a later
 * retry may succeed.
 *
 * options.startedAt: when the calling execution began (Date.now() at the top of
 * the script), so retries stop waiting before Apps Script's limit, not a fixed
 * time after this call.
 */
function setValues(locations, values, options) {
  const many = Array.isArray(locations);
  const targets = many ? locations : [locations];
  const blocks = many ? values : [values];
  if (!Array.isArray(blocks) || blocks.length !== targets.length) {
    throw new Error('setValues needs one 2D array of values per location');
  }
  const client = new SheetsClient_(ScriptApp.getOAuthToken(), clock_(options && options.startedAt));
  const failures = [];
  targets.forEach((target, i) => {
    try {
      writeValues_(client, target, blocks[i]);
    } catch (exc) {
      const error = classify_(exc);
      failures.push({ location: describeLocation_(target), message: error.message, transient: error instanceof TransientError_ });
    }
  });
  if (failures.length) {
    const error = new Error('setValues failed for ' + failures.map((f) => f.location + ': ' + f.message).join('; '));
    error.failures = failures;
    throw error;
  }
}

/**
 * Read values, like Range.getValues(), from one location or a list of them;
 * returns a 2D array, or a list of them in the same order.
 *
 * Unformatted, as getValues() is, except that dates come back as the text the
 * cell shows - or, with { serialDates: true }, as serial numbers (days since
 * 1899-12-30), which survive any display format. The API trims trailing empty
 * cells, so a bounded dimension is padded back to the range's size with ''; an
 * open one ('A2:E') ends at the last row with data. Rows are always rectangular.
 * options.startedAt works as in setValues.
 */
function getValues(locations, options) {
  const dates = options && options.serialDates ? 'SERIAL_NUMBER' : 'FORMATTED_STRING';
  const many = Array.isArray(locations);
  const client = new SheetsClient_(ScriptApp.getOAuthToken(), clock_(options && options.startedAt));
  const out = (many ? locations : [locations]).map((source) => {
    try {
      return readValues_(client, source, dates);
    } catch (exc) {
      throw new Error('getValues failed for ' + describeLocation_(source) + ': ' + classify_(exc).message);
    }
  });
  return many ? out : out[0];
}

function describeLocation_(location) {
  return location && typeof location === 'object'
    ? String(location.url) + ' ' + String(location.range)
    : JSON.stringify(location);
}

function checkLocation_(location) {
  if (!location || typeof location !== 'object' || !location.url || !location.range) {
    throw new PermanentError_('a location is { url, range }, got ' + JSON.stringify(location));
  }
}

/** A Date as text USER_ENTERED reads as a date-time in any locale. */
function cellForWrite_(value, timeZone) {
  // Not instanceof: a Date made by the calling script may come from another realm.
  return Object.prototype.toString.call(value) === '[object Date]' ? Utilities.formatDate(value, timeZone, 'yyyy-MM-dd HH:mm:ss') : value;
}

function writeValues_(client, location, values) {
  checkLocation_(location);
  if (!Array.isArray(values) || values.some((row) => !Array.isArray(row))) {
    throw new PermanentError_('values must be a 2D array');
  }
  const to = resolve_(client, location.url, location.range);
  const grid = parseA1_(to.range, to.props.sheetId);
  const width = widest_(values);
  const fit = ensureFits_(client, to.spreadsheetId, to.props, grid.startRow, grid.startCol, values.length, width);

  if (to.range.indexOf(':') !== -1) {
    const endRow = grid.endRow != null ? grid.endRow : fit.maxRows;
    const endCol = grid.endCol != null ? grid.endCol : grid.startCol + width;
    client.clearRange(to.spreadsheetId,
      grid_(fit.props.sheetId, grid.startRow, Math.min(endRow, fit.maxRows), grid.startCol, Math.min(endCol, fit.maxCols)),
      fit.props.title);
  }
  if (!values.length || !width) return;

  const timeZone = values.some((row) => row.some((v) => Object.prototype.toString.call(v) === '[object Date]')) ? client.timeZone(to.spreadsheetId) : null;
  const rows = padRows_(values, width).map((row) => (timeZone ? row.map((v) => cellForWrite_(v, timeZone)) : row));
  const target = grid_(fit.props.sheetId, grid.startRow, grid.startRow + rows.length, grid.startCol, grid.startCol + width);
  writeGrid_(client, to.spreadsheetId, target, fit.props.title, rows);
}

function readValues_(client, location, dateTimeRenderOption) {
  checkLocation_(location);
  const from = resolve_(client, location.url, location.range);
  const grid = parseA1_(from.range, from.props.sheetId);
  const values = client.getValues(
    from.spreadsheetId, withSheetTitle_(from.range, from.props.title), 'UNFORMATTED_VALUE', dateTimeRenderOption
  ) || [];
  const height = grid.endRow != null ? grid.endRow - grid.startRow : values.length;
  const width = grid.endCol != null ? grid.endCol - grid.startCol : widest_(values);
  const rows = values.slice(0, height);
  while (rows.length < height) rows.push([]);
  return padRows_(rows, width);
}
