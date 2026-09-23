/**
 * A1 notation and URL helpers.
 *
 * Grid ranges follow the Sheets API convention: 0-based, end-exclusive, and
 * null when the notation is open-ended (e.g. A2:H).
 */

function spreadsheetIdFromUrl_(url) {
  url = String(url || '').trim();
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
  if (match) return match[1];
  // A bare id pasted into the settings sheet is accepted too.
  if (/^[a-zA-Z0-9\-_]{20,}$/.test(url)) return url;
  throw new PermanentError('Cannot extract a spreadsheet id from: ' + JSON.stringify(url));
}

/** Defaults to 0, like the original Apps Script. */
function sheetGidFromUrl_(url) {
  const match = String(url || '').match(/[#&?]gid=([0-9]+)/);
  return match ? Number(match[1]) : 0;
}

/** 'A' -> 0, 'H' -> 7, 'AA' -> 26. */
function columnToIndex_(letters) {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** 0 -> 'A', 7 -> 'H', 26 -> 'AA'. */
function indexToColumn_(index) {
  if (index < 0) throw new PermanentError('column index must be >= 0');
  let letters = '';
  index += 1;
  while (index) {
    const rem = (index - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    index = Math.floor((index - 1) / 26);
  }
  return letters;
}

function withSheetTitle_(range, title) {
  if (!title) return range;
  return "'" + title.replace(/'/g, "''") + "'!" + range;
}

/** "'My Tab'!A2:H" -> {title: 'My Tab', range: 'A2:H'}. The title is optional. */
function splitSheetTitle_(a1) {
  a1 = String(a1 || '').trim();
  const bang = a1.indexOf('!');
  if (bang < 0) return { title: null, range: a1 };
  let title = a1.slice(0, bang).trim();
  if (title.length >= 2 && title[0] === "'" && title[title.length - 1] === "'") {
    title = title.slice(1, -1).replace(/''/g, "'");
  }
  return { title: title || null, range: a1.slice(bang + 1).trim() };
}

/** 'A2' -> {col: 0, row: 1}; 'A' -> {col: 0, row: null}; '2' -> {col: null, row: 1}. */
function parseCell_(cell) {
  const match = cell.trim().match(/^\$?([A-Za-z]+)?\$?([0-9]+)?$/);
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new PermanentError('Invalid A1 cell reference: ' + JSON.stringify(cell));
  }
  return {
    col: match[1] !== undefined ? columnToIndex_(match[1]) : null,
    row: match[2] !== undefined ? Number(match[2]) - 1 : null
  };
}

function gridRange_(sheetId, startRow, endRow, startCol, endCol) {
  return {
    sheetId: sheetId,
    startRowIndex: startRow,
    endRowIndex: endRow,
    startColumnIndex: startCol,
    endColumnIndex: endCol
  };
}

/** Plain A1 notation (no sheet title) -> grid range. */
function parseA1_(a1, sheetId) {
  const range = String(a1 || '').trim();
  if (!range) throw new PermanentError('Empty A1 notation');
  const parts = range.split(':');
  if (parts.length === 1) {
    const cell = parseCell_(parts[0]);
    return gridRange_(
      sheetId,
      cell.row || 0,
      cell.row !== null ? cell.row + 1 : null,
      cell.col || 0,
      cell.col !== null ? cell.col + 1 : null
    );
  }
  if (parts.length !== 2) throw new PermanentError('Invalid A1 notation: ' + JSON.stringify(a1));

  let a = parseCell_(parts[0]);
  let b = parseCell_(parts[1]);
  let c1 = a.col, r1 = a.row, c2 = b.col, r2 = b.row;
  // Reversed references such as H10:A2 are normalised.
  if (c1 !== null && c2 !== null && c2 < c1) [c1, c2] = [c2, c1];
  if (r1 !== null && r2 !== null && r2 < r1) [r1, r2] = [r2, r1];
  return gridRange_(
    sheetId,
    r1 || 0,
    r2 !== null ? r2 + 1 : null,
    c1 || 0,
    c2 !== null ? c2 + 1 : null
  );
}

function gridToA1_(grid, title) {
  const start = indexToColumn_(grid.startColumnIndex) + (grid.startRowIndex + 1);
  const endCol = grid.endColumnIndex !== null && grid.endColumnIndex !== undefined
    ? indexToColumn_(grid.endColumnIndex - 1) : '';
  const endRow = grid.endRowIndex !== null && grid.endRowIndex !== undefined
    ? String(grid.endRowIndex) : '';
  return withSheetTitle_(endCol || endRow ? start + ':' + endCol + endRow : start, title);
}

/** The API form: open ends are omitted rather than null. */
function gridToApi_(grid) {
  const out = {};
  if (grid.sheetId !== null && grid.sheetId !== undefined) out.sheetId = grid.sheetId;
  out.startRowIndex = grid.startRowIndex;
  out.startColumnIndex = grid.startColumnIndex;
  if (grid.endRowIndex !== null && grid.endRowIndex !== undefined) out.endRowIndex = grid.endRowIndex;
  if (grid.endColumnIndex !== null && grid.endColumnIndex !== undefined) out.endColumnIndex = grid.endColumnIndex;
  return out;
}
