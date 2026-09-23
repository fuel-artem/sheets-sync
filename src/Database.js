/**
 * The Database import: rebuilds the database tab rather than copying a range.
 *
 * Rows whose source is being refreshed are dropped, every enabled source is
 * re-read, each transaction is widened and enriched from the `AI Settings`
 * handbook, then the tab is rewritten in one pass.
 *
 * Layout, in database column order:
 *
 *   0        source label            (settings column F)
 *   1..21    the transaction         (transaction_length columns from the source)
 *   22..25   CF block                (from AI Settings A3:G)
 *   26..29   P&L block               (from AI Settings I3:O)
 *   30..33   BS block                (from AI Settings Q3:W)
 *   34..36   month / year / spare    (blanked, they are filled elsewhere)
 *
 * Every one of those numbers lives in the database config; each client project
 * passes its own.
 */

const KEY_SEPARATOR = '¬'; // the "¬" used to join the handbook key

// Database index of transaction field 0: the source label sits at 0.
const LABEL_OFFSET = 1;

/** Everything the original script kept as constants at the top of the file. */
function defaultDatabaseConfig_() {
  return {
    database_tab: 'General database',
    ai_tab: 'AI Settings',
    // AI Settings blocks: first three columns form the key, the rest is the payload.
    ai_ranges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' },
    // databaseLength in the original: how many columns one transaction occupies.
    transaction_length: 21,
    ai_block_width: 4,
    // An existing row keeps this many columns; the rest are blanked so the
    // month/year formulas are not carried over.
    keep_columns: 37,
    trailing_blanks: 5,
    // Columns appended to a freshly built row (month, year, spare).
    trailing_new: 3,
    // Indexes *inside the transaction*, not the database row.
    amount_index: 7,
    date_indexes: { cf: 0, pl: 1, bs: 2 },
    key_indexes: [19, 20],
    // Which key part must be present for the row to count as a transaction.
    // The original filtered on database column 20, i.e. key part 0.
    required_key_part: 0,
    // Spare rows to keep below the data.
    row_headroom: 5,
    // Settings columns specific to this variant.
    source_label_column: 5,
    is_database_column: 6,
    declared_length_column: 9,
    status_cells: ['L2', 'L3', 'L4'],
    // Restore the basic filter over the tab afterwards, as the original did.
    restore_filter: true
  };
}

function databaseConfig_(overrides) {
  const config = defaultDatabaseConfig_();
  if (!overrides) return config;
  const unknown = Object.keys(overrides).filter(function (k) { return !(k in config); });
  if (unknown.length) throw new PermanentError('Unknown database config keys: ' + unknown.sort().join(', '));
  Object.assign(config, overrides);
  if (config.status_cells.length !== 3) {
    throw new PermanentError('status_cells needs exactly 3 cells (error, timestamp, user), got '
      + config.status_cells.length);
  }
  return config;
}

/**
 * JS truthiness of parseFloat(value): NaN and 0 are both dropped. The database
 * is read as display values, so "1,234.56" parses as 1 and the row survives,
 * exactly as in the original. Do not replace parseFloat with Number.
 */
function isNonzeroNumber_(value) {
  return !!parseFloat(value);
}

/** Stringify like the original template literal. */
function keyPart_(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * AI Settings block -> {"category¬subcategory¬sign": [4 values]}.
 *
 * The API trims trailing empty cells, so short payloads are padded to the
 * block width; otherwise a row missing its last cell shifts every later
 * database column by one.
 */
function buildHandbook_(rows, blockWidth) {
  const handbook = {};
  rows.forEach(function (row) {
    if (!row || !row.length || String(cellAt_(row, 0)).trim() === '') return;
    const key = [0, 1, 2].map(function (i) { return keyPart_(cellAt_(row, i)); }).join(KEY_SEPARATOR);
    const payload = row.slice(3, 3 + blockWidth);
    while (payload.length < blockWidth) payload.push('');
    handbook[key] = payload;
  });
  return handbook;
}

function readHandbooks_(client, ssId, config) {
  const handbooks = {};
  Object.keys(config.ai_ranges).forEach(function (block) {
    const rows = client.getValues(ssId, withSheetTitle_(config.ai_ranges[block], config.ai_tab)) || [];
    handbooks[block] = buildHandbook_(rows, config.ai_block_width);
    console.info('AI Settings ' + block.toUpperCase() + ': ' + Object.keys(handbooks[block]).length + ' entries');
  });
  return handbooks;
}

function blanks_(count) {
  return new Array(Math.max(count, 0)).fill('');
}

/** One source transaction -> one database row. */
function buildRow_(transaction, label, handbooks, config) {
  const values = transaction.slice(0, config.transaction_length);
  if (transaction.length > config.transaction_length) {
    // Truncating keeps the AI blocks aligned; the original shifted them.
    console.warn('transaction is ' + transaction.length + ' columns wide, expected '
      + config.transaction_length + '; extra columns ignored');
  }
  while (values.length < config.transaction_length) values.push('');

  const amount = parseFloat(cellAt_(values, config.amount_index));
  const sign = !isNaN(amount) && amount > 0 ? '+' : '-';
  const key = [
    keyPart_(cellAt_(values, config.key_indexes[0])),
    keyPart_(cellAt_(values, config.key_indexes[1])),
    sign
  ].join(KEY_SEPARATOR);

  let row = [label].concat(values);
  ['cf', 'pl', 'bs'].forEach(function (block) {
    const entry = (handbooks[block] || {})[key];
    if (cellAt_(values, config.date_indexes[block]) !== '' && entry) {
      row = row.concat(entry);
    } else {
      row = row.concat(blanks_(config.ai_block_width));
    }
  });
  return row.concat(blanks_(config.trailing_new));
}

function runDatabaseJob_(client, job) {
  const config = job.config;
  // The database and AI Settings tabs live wherever the database rows point,
  // which is usually not the spreadsheet holding Import Settings.
  const ssId = job.database_url ? spreadsheetIdFromUrl_(job.database_url) : job.settings_spreadsheet_id;
  // A gid in the url beats the configured title, which is only a fallback.
  const gid = job.database_url ? sheetGidFromUrl_(job.database_url) : null;
  let props = client.sheetProps(ssId, gid, gid !== null ? null : config.database_tab);
  const databaseTab = props.title;
  const sheetId = props.sheetId;
  let maxRows = (props.gridProperties || {}).rowCount || 0;
  let maxCols = (props.gridProperties || {}).columnCount || 0;
  const lastColumn = indexToColumn_(maxCols - 1);

  const handbooks = readHandbooks_(client, ssId, config);

  // A filter left in place fights the rewrite, exactly as in the original.
  client.clearBasicFilter(ssId, sheetId);

  // Existing transactions, as display values, minus the sources being refreshed.
  const existing = client.getValues(ssId, withSheetTitle_('A2:' + lastColumn, databaseTab), 'FORMATTED_VALUE') || [];
  const replaced = job.replaced_labels.map(function (l) { return String(l).trim(); });
  const kept = existing.filter(function (row) {
    const label = row.length ? String(cellAt_(row, 0)).trim() : '';
    return label !== '' && replaced.indexOf(label) < 0;
  });
  // Blank the month/year columns so their formulas are not carried over.
  let output = kept.map(function (row) {
    return row.slice(0, config.keep_columns).concat(blanks_(config.trailing_blanks));
  });
  console.info('kept ' + output.length + ' existing row(s) of ' + existing.length);

  // Re-read every database source and widen its transactions.
  job.sources.forEach(function (source) {
    const fromId = spreadsheetIdFromUrl_(source.from_url);
    const split = splitSheetTitle_(source.from_range);
    const fromProps = client.sheetProps(fromId, sheetGidFromUrl_(source.from_url), split.title);
    const values = client.getValues(fromId, withSheetTitle_(split.range, fromProps.title));
    if (!values) {
      // Skipping keeps the other sources alive; the original threw here.
      console.warn('[' + source.name + '] source range is empty, nothing imported');
      return;
    }
    values.forEach(function (tx) { output.push(buildRow_(tx, source.label, handbooks, config)); });
    console.info('[' + source.name + '] ' + values.length + ' transaction(s)');
  });

  // Drop headers and zero-amount rows.
  const amountCol = LABEL_OFFSET + config.amount_index;
  output = output.filter(function (row) { return isNonzeroNumber_(cellAt_(row, amountCol)); });

  // Grow the tab before writing, as the original did (using the pre-filter count).
  if (output.length + config.row_headroom > maxRows) {
    client.insertRowsBefore(ssId, sheetId, maxRows, output.length + config.row_headroom - maxRows);
    props = client.sheetProps(ssId, sheetId, null);
    maxRows = (props.gridProperties || {}).rowCount || maxRows;
    maxCols = (props.gridProperties || {}).columnCount || maxCols;
  }

  // Rows with no category, or with none of the three dates, are not transactions.
  const categoryCol = LABEL_OFFSET + config.key_indexes[config.required_key_part];
  const dateCols = Object.keys(config.date_indexes).map(function (b) { return LABEL_OFFSET + config.date_indexes[b]; });
  output = output.filter(function (row) { return String(cellAt_(row, categoryCol)).trim() !== ''; });
  output = output.filter(function (row) {
    return dateCols.some(function (c) { return String(cellAt_(row, c)).trim() !== ''; });
  });

  // Rewrite the tab from A2 down.
  client.clearRange(ssId, gridRange_(sheetId, 1, maxRows, 0, maxCols), databaseTab);

  const width = output.reduce(function (w, row) { return Math.max(w, row.length); }, 0);
  if (output.length) {
    const padded = output.map(function (row) { return row.concat(blanks_(width - row.length)); });
    client.setValues(ssId, gridToA1_(gridRange_(sheetId, 1, 1 + padded.length, 0, width), databaseTab), padded);
  }

  if (config.restore_filter) {
    client.setBasicFilter(ssId, gridRange_(sheetId, 0, maxRows, 0, maxCols));
  }

  console.info('[' + job.name + '] wrote ' + output.length + ' x ' + width);
  return { rows: output.length, columns: width };
}

/** Which database tab a row feeds: "spreadsheetId|gid", or "" for the settings spreadsheet. */
function targetKey_(tab, line, url) {
  if (!url) return '';
  try {
    return spreadsheetIdFromUrl_(url) + '|' + sheetGidFromUrl_(url);
  } catch (e) {
    throw new PermanentError(tab + ' row ' + line + ' (column D): ' + e.message);
  }
}

/**
 * The Import Settings tab of a database-import spreadsheet. The rebuilds come
 * first, one per distinct database tab, then the plain copy rows.
 */
function readDatabaseSettings_(client, settingsId, execution, config, tab, flagColumn) {
  tab = tab || TAB.database;
  const index = flagColumn === null || flagColumn === undefined ? FLAG_COLUMN.database[execution] : flagColumn;
  const rows = client.getValues(settingsId, withSheetTitle_('A2:Z', tab)) || [];

  const groups = [];
  const byKey = {};
  const others = [];
  const overLength = [];
  const otherLabels = [];

  rows.forEach(function (row, offset) {
    const line = offset + 2;
    const name = String(cellAt_(row, COL_NAME)).trim();
    if (name === '' || !cellAt_(row, index)) return;
    const label = String(cellAt_(row, config.source_label_column)).trim();

    if (cellAt_(row, config.is_database_column)) {
      const declared = parseFloat(cellAt_(row, config.declared_length_column, null));
      const declaredInt = isNaN(declared) ? null : Math.trunc(declared);
      if (declaredInt !== null && declaredInt > config.transaction_length) {
        overLength.push(name + ' (row ' + line + ': ' + declaredInt + ')');
      }
      const url = String(cellAt_(row, COL_TO_URL)).trim();
      const key = targetKey_(tab, line, url);
      if (!byKey[key]) {
        byKey[key] = { key: key, url: url, sources: [], labels: [] };
        groups.push(byKey[key]);
      }
      byKey[key].labels.push(label);
      byKey[key].sources.push({
        name: name,
        label: label,
        from_url: String(cellAt_(row, COL_FROM_URL)).trim(),
        from_range: String(cellAt_(row, COL_FROM_RANGE)).trim(),
        declared_length: declaredInt
      });
    } else {
      otherLabels.push(label);
      const job = copyJobFromRow_(row);
      const missing = missingFields_(job);
      if (missing.length) {
        throw new PermanentError(tab + ' row ' + line + ' (' + name + ') is missing: ' + missing.join(', '));
      }
      others.push(job);
    }
  });

  if (overLength.length) {
    throw new PermanentError('Some ranges for the Database are longer than needed (needed '
      + config.transaction_length + '). Check the length in column J: ' + overLength.join('; '));
  }

  const jobs = groups.map(function (group, i) {
    let name = config.database_tab;
    if (groups.length > 1) {
      const ss = group.key.split('|')[0];
      name = config.database_tab + ' #' + (i + 1) + (ss ? ' (' + ss.slice(0, 8) + ')' : '');
    }
    return {
      kind: 'database',
      name: name,
      settings_spreadsheet_id: settingsId,
      sources: group.sources,
      // Only this tab's own labels are cleared from it. The enabled copy rows'
      // labels are cleared from every database, as the original did.
      replaced_labels: group.labels.concat(otherLabels),
      config: config,
      database_url: group.url
    };
  });
  console.info(tab + ': ' + groups.length + ' database tab(s), '
    + groups.reduce(function (n, g) { return n + g.sources.length; }, 0) + ' source(s), '
    + others.length + ' copy row(s) for execution=' + execution);
  return jobs.concat(others);
}
