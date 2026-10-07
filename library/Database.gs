// The Database import: rebuilds the database tab rather than copying a range.
//
// Rows whose source is being refreshed are dropped, every enabled source is
// re-read, each transaction is widened and enriched from the AI Settings
// handbook, then the tab is rewritten in one pass.
//
// Layout, in database column order:
//
//     0        source label            (settings column F)
//     1..21    the transaction         (transactionLength columns from the source)
//     22..25   CF block                (from AI Settings A3:G)
//     26..29   P&L block               (from AI Settings I3:O)
//     30..33   BS block                (from AI Settings Q3:W)
//     34..36   preserved               (preservedColumns: kept on existing rows,
//                                       blank on new ones)
//
// Those columns are the rebuild's; it reads, clears and writes nothing past them,
// so the tab's own formulas to the right survive. Every number lives in
// DATABASE_DEFAULTS_; each spreadsheet sends its own overrides.

const KEY_SEPARATOR_ = '¬';
const AI_BLOCKS_ = ['cf', 'pl', 'bs'];

const DATABASE_DEFAULTS_ = {
  databaseTab: 'General database',
  aiTab: 'AI Settings',
  // First three columns of each block form the key, the rest is the payload.
  aiRanges: { cf: 'A3:G', pl: 'I3:O', bs: 'Q3:W' },
  // databaseLength in the original: how many columns one transaction occupies.
  transactionLength: 21,
  aiBlockWidth: 4,
  // Columns after the AI blocks that existing rows keep and new rows leave blank.
  preservedColumns: 3,
  // Indexes *inside the transaction*, not the database row.
  amountIndex: 7,
  dateIndexes: { cf: 0, pl: 1, bs: 2 },
  keyIndexes: [19, 20],
  // The original filtered on database column 20, i.e. key part 0.
  requiredKeyPart: 0,
  rowHeadroom: 5,
  sourceLabelColumn: 5,
  isDatabaseColumn: 6,
  declaredLengthColumn: 9,
  statusCells: ['L2', 'L3', 'L4'],
  restoreFilter: true,
};

function databaseConfig_(overrides) {
  const config = JSON.parse(JSON.stringify(DATABASE_DEFAULTS_));
  const unknown = Object.keys(overrides || {}).filter((key) => !(key in config));
  if (unknown.length) throw new PermanentError_('Unknown database config keys: ' + unknown.sort().join(', '));
  Object.assign(config, overrides);
  if (!Array.isArray(config.statusCells) || config.statusCells.length !== 3) {
    throw new PermanentError_('statusCells needs exactly 3 cells (state, timestamp, user)');
  }
  return config;
}

// Native parseFloat on purpose: the database tab is read as display values, so an
// amount can arrive as "1,234.56", and the original's parseFloat gave 1 and kept
// the row. Truthiness drops NaN and 0 alike, as `if (parseFloat(x))` did.
function isNonzeroNumber_(value) {
  return Boolean(parseFloat(value));
}

/** An AI Settings block -> {"category¬subcategory¬sign": [aiBlockWidth values]}. */
function buildHandbook_(rows, blockWidth) {
  const handbook = {};
  for (const row of rows) {
    if (!row || !row.length || cellText_(row, 0) === '') continue;
    const key = [0, 1, 2].map((i) => String(cell_(row, i))).join(KEY_SEPARATOR_);
    // The API trims trailing empty cells; unpadded, a short row would shift every
    // later database column by one.
    const payload = row.slice(3, 3 + blockWidth);
    while (payload.length < blockWidth) payload.push('');
    handbook[key] = payload;
  }
  return handbook;
}

function readHandbooks_(client, spreadsheetId, config) {
  const handbooks = {};
  for (const block of Object.keys(config.aiRanges)) {
    const rows = client.getValues(spreadsheetId, withSheetTitle_(config.aiRanges[block], config.aiTab)) || [];
    handbooks[block] = buildHandbook_(rows, config.aiBlockWidth);
    console.info('AI Settings ' + block.toUpperCase() + ': ' + Object.keys(handbooks[block]).length + ' entries');
  }
  return handbooks;
}

/** One source transaction -> one database row. */
function buildRow_(transaction, label, handbooks, config) {
  const values = transaction.slice(0, config.transactionLength);
  if (transaction.length > config.transactionLength) {
    // Truncating keeps the AI blocks aligned; the original shifted them.
    console.warn('transaction is ' + transaction.length + ' columns wide, expected ' +
      config.transactionLength + '; extra columns ignored');
  }
  while (values.length < config.transactionLength) values.push('');

  const amount = parseFloat(cell_(values, config.amountIndex));
  const sign = amount > 0 ? '+' : '-';
  const key = [
    String(cell_(values, config.keyIndexes[0])),
    String(cell_(values, config.keyIndexes[1])),
    sign,
  ].join(KEY_SEPARATOR_);

  const row = [label].concat(values);
  for (const block of AI_BLOCKS_) {
    const entry = (handbooks[block] || {})[key];
    if (cell_(values, config.dateIndexes[block]) !== '' && entry) {
      row.push(...entry);
    } else {
      for (let i = 0; i < config.aiBlockWidth; i++) row.push('');
    }
  }
  for (let i = 0; i < config.preservedColumns; i++) row.push('');
  return row;
}

/** How many columns, from A, the rebuild owns. */
function databaseWidth_(config) {
  return 1 + config.transactionLength + AI_BLOCKS_.length * config.aiBlockWidth + config.preservedColumns;
}

/** The source label sits at database column 0, so transaction field i is at i + 1. */
function databaseIndex_(transactionIndex) {
  return 1 + transactionIndex;
}

function widest_(rows) {
  return rows.reduce((w, row) => Math.max(w, row.length), 0);
}

function padRows_(rows, width) {
  return rows.map((row) => {
    const padded = row.slice();
    while (padded.length < width) padded.push('');
    return padded;
  });
}

function runDatabaseJob_(client, job) {
  const config = job.config;
  // The database and AI Settings tabs live wherever the database rows point,
  // which is usually not the spreadsheet holding Import Settings.
  const spreadsheetId = job.databaseUrl ? spreadsheetIdFromUrl_(job.databaseUrl) : job.settingsSpreadsheetId;
  // A gid in the url beats the configured title, which is only a fallback.
  const gid = job.databaseUrl ? sheetGidFromUrl_(job.databaseUrl) : null;
  let props = client.sheetProps(spreadsheetId, gid, gid == null ? config.databaseTab : null);
  const tab = props.title;
  const sheetId = props.sheetId;
  let maxRows = (props.gridProperties || {}).rowCount || 0;
  let maxCols = (props.gridProperties || {}).columnCount || 0;
  const width = databaseWidth_(config);
  // Checked before anything is cleared: a write wider than the tab fails after
  // the clear, and leaves the database empty.
  if (width > maxCols) {
    throw new PermanentError_(tab + ' has ' + maxCols + ' columns but the rebuild needs ' + width +
      ' (A:' + indexToColumn_(width - 1) + '); check transactionLength and preservedColumns');
  }

  const handbooks = readHandbooks_(client, spreadsheetId, config);

  const existing = client.getValues(
    spreadsheetId, withSheetTitle_('A2:' + indexToColumn_(width - 1), tab), 'FORMATTED_VALUE'
  ) || [];
  const replaced = new Set(job.replacedLabels.map((label) => String(label).trim()));
  let output = existing
    .filter((row) => row.length && cellText_(row, 0) !== '' && !replaced.has(cellText_(row, 0)))
    .map((row) => row.slice(0, width));
  const keptCount = output.length;
  console.info('kept ' + keptCount + ' existing row(s) of ' + existing.length);

  for (const source of job.sources) {
    const fromId = spreadsheetIdFromUrl_(source.fromUrl);
    const [explicitTitle, plainRange] = splitSheetTitle_(source.fromRange);
    const fromProps = client.sheetProps(fromId, sheetGidFromUrl_(source.fromUrl), explicitTitle);
    const values = client.getValues(fromId, withSheetTitle_(plainRange, fromProps.title));
    if (!values) {
      // Skipping keeps the other sources alive; the original threw here.
      console.warn('[' + source.name + '] source range is empty, nothing imported');
      continue;
    }
    for (const transaction of values) output.push(buildRow_(transaction, source.label, handbooks, config));
    console.info('[' + source.name + '] ' + values.length + ' transaction(s)');
  }

  const readCount = output.length - keptCount;

  // Drop headers and zero-amount rows.
  const amountCol = databaseIndex_(config.amountIndex);
  const beforeAmount = output.length;
  output = output.filter((row) => isNonzeroNumber_(cell_(row, amountCol)));
  // The tab grows on this count, as the original did, before the next filters.
  const neededRows = output.length + config.rowHeadroom;

  // Rows with no category, or with none of the three dates, are not transactions.
  const categoryCol = databaseIndex_(config.keyIndexes[config.requiredKeyPart]);
  const dateCols = Object.values(config.dateIndexes).map(databaseIndex_);
  const beforeCategory = output.length;
  output = output.filter((row) => cellText_(row, categoryCol) !== '');
  const beforeDates = output.length;
  output = output.filter((row) => dateCols.some((c) => cellText_(row, c) !== ''));

  const dropped = (beforeAmount - beforeCategory) + ' with no non-zero amount (column ' +
    indexToColumn_(amountCol) + '), ' + (beforeCategory - beforeDates) + ' with no category (column ' +
    indexToColumn_(categoryCol) + '), ' + (beforeDates - output.length) + ' with none of the dates (columns ' +
    dateCols.map(indexToColumn_).join(', ') + ')';
  console.info('[' + job.name + '] ' + readCount + ' read, ' + keptCount + ' kept; dropped ' + dropped);
  // Writing nothing would empty the database. Every row failing the filters means
  // the indexes no longer match the sources, so refuse before touching the tab.
  if (beforeAmount && !output.length) {
    throw new PermanentError_('every row was filtered out (' + readCount + ' read, ' + keptCount +
      ' kept; dropped ' + dropped + '). Check amountIndex, keyIndexes and dateIndexes. Nothing was changed.');
  }

  if (neededRows > maxRows) {
    client.insertRowsBefore(spreadsheetId, sheetId, maxRows, neededRows - maxRows);
    props = client.sheetProps(spreadsheetId, sheetId, null);
    maxRows = (props.gridProperties || {}).rowCount || maxRows;
    maxCols = (props.gridProperties || {}).columnCount || maxCols;
  }
  // A filter left in place fights the rewrite, exactly as in the original.
  client.clearBasicFilter(spreadsheetId, sheetId);
  replaceArea_(client, spreadsheetId, grid_(sheetId, 1, maxRows, 0, width), tab, padRows_(output, width));

  if (config.restoreFilter) client.setBasicFilter(spreadsheetId, grid_(sheetId, 0, maxRows, 0, maxCols));

  console.info('[' + job.name + '] wrote ' + output.length + ' x ' + width);
  return { rows: output.length, columns: width };
}

// --------------------------------------------------------------- settings read

/** Which database tab a row feeds. A blank column D means the settings spreadsheet. */
function targetKey_(tab, line, url) {
  if (!url) return ['', null];
  try {
    return [spreadsheetIdFromUrl_(url), sheetGidFromUrl_(url)];
  } catch (exc) {
    throw new PermanentError_(tab + ' row ' + line + ' (column D): ' + exc.message);
  }
}

/** The rebuilds come first, one per database tab, then the plain copy rows. */
function readDatabaseSettings_(client, spreadsheetId, execution, config, tab) {
  const enabled = enabledRows_(client, spreadsheetId, tab, FLAG_COLUMN_.database[execution]);

  const groups = new Map();
  const others = [];
  const overLength = [];
  const otherLabels = [];

  for (const [line, row] of enabled) {
    const name = cellText_(row, COL_NAME_);
    const label = cellText_(row, config.sourceLabelColumn);
    if (!cell_(row, config.isDatabaseColumn)) {
      otherLabels.push(label);
      const job = copyJobFromRow_(row);
      requireCopyFields_(job, tab, line);
      others.push(job);
      continue;
    }
    const declared = Math.trunc(parseFloat(cell_(row, config.declaredLengthColumn)));
    if (declared > config.transactionLength) overLength.push(name + ' (row ' + line + ': ' + declared + ')');

    const url = cellText_(row, COL_TO_URL_);
    const [ss, gid] = targetKey_(tab, line, url);
    const key = ss + '|' + gid;
    if (!groups.has(key)) groups.set(key, { ss: ss, gid: gid, url: url, sources: [], labels: [] });
    const group = groups.get(key);
    group.labels.push(label);
    group.sources.push({
      name: name,
      label: label,
      fromUrl: cellText_(row, COL_FROM_URL_),
      fromRange: cellText_(row, COL_FROM_RANGE_),
    });
  }

  if (overLength.length) {
    throw new PermanentError_('Some ranges for the Database are longer than needed (needed ' +
      config.transactionLength + '). Check the length in column J: ' + overLength.join('; '));
  }

  let index = 0;
  const jobs = [];
  for (const group of groups.values()) {
    index++;
    const name = groups.size > 1
      ? config.databaseTab + ' #' + index + (group.ss ? ' (' + group.ss.slice(0, 8) + ')' : '')
      : config.databaseTab;
    jobs.push({
      kind: 'database',
      id: jobId_(['database', group.ss, group.gid]),
      name: name,
      settingsSpreadsheetId: spreadsheetId,
      databaseUrl: group.url,
      sources: group.sources,
      // Only this tab's own labels are cleared from it. The enabled copy rows'
      // labels are cleared from every database, as the original did.
      replacedLabels: group.labels.concat(otherLabels),
      config: config,
    });
  }
  console.info(tab + ': ' + groups.size + ' database tab(s), ' + others.length +
    ' copy row(s) for execution=' + execution);
  return jobs.concat(others);
}
