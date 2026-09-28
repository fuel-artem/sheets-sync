// A1 notation and URL helpers. Grid ranges follow the Sheets API: 0-based,
// end-exclusive, and null where the notation is open-ended (A2:H).

const SPREADSHEET_ID_RE_ = /\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/;
const GID_RE_ = /[#&?]gid=([0-9]+)/;
const CELL_RE_ = /^\$?([A-Za-z]+)?\$?([0-9]+)?$/;

function spreadsheetIdFromUrl_(url) {
  const text = String(url || '').trim();
  const match = SPREADSHEET_ID_RE_.exec(text);
  if (match) return match[1];
  // A bare id pasted into the settings sheet.
  if (/^[a-zA-Z0-9\-_]{20,}$/.test(text)) return text;
  throw new PermanentError_('Cannot extract a spreadsheet id from: ' + JSON.stringify(text));
}

/** Defaults to 0, the first tab, like Apps Script. */
function sheetGidFromUrl_(url) {
  const match = GID_RE_.exec(String(url || ''));
  return match ? Number(match[1]) : 0;
}

function columnToIndex_(letters) {
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function indexToColumn_(index) {
  let letters = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return letters;
}

function grid_(sheetId, startRow, endRow, startCol, endCol) {
  return { sheetId: sheetId, startRow: startRow, endRow: endRow, startCol: startCol, endCol: endCol };
}

function gridToApi_(grid) {
  const out = { startRowIndex: grid.startRow, startColumnIndex: grid.startCol };
  if (grid.sheetId != null) out.sheetId = grid.sheetId;
  if (grid.endRow != null) out.endRowIndex = grid.endRow;
  if (grid.endCol != null) out.endColumnIndex = grid.endCol;
  return out;
}

function gridToA1_(grid, sheetTitle) {
  const start = indexToColumn_(grid.startCol) + (grid.startRow + 1);
  const endCol = grid.endCol != null ? indexToColumn_(grid.endCol - 1) : '';
  const endRow = grid.endRow != null ? String(grid.endRow) : '';
  return withSheetTitle_(endCol || endRow ? start + ':' + endCol + endRow : start, sheetTitle);
}

/** "'My Tab'!A2:H" -> ['My Tab', 'A2:H']; the title is optional. */
function splitSheetTitle_(a1) {
  const text = String(a1 || '').trim();
  const bang = text.indexOf('!');
  if (bang === -1) return [null, text];
  let title = text.slice(0, bang).trim();
  if (title.length >= 2 && title[0] === "'" && title[title.length - 1] === "'") {
    title = title.slice(1, -1).replace(/''/g, "'");
  }
  return [title || null, text.slice(bang + 1).trim()];
}

function withSheetTitle_(range, sheetTitle) {
  return sheetTitle ? "'" + sheetTitle.replace(/'/g, "''") + "'!" + range : range;
}

/** 'A2' -> [0, 1]; 'A' -> [0, null]; '2' -> [null, 1]. */
function parseCell_(cell) {
  const match = CELL_RE_.exec(cell.trim());
  if (!match || (match[1] === undefined && match[2] === undefined)) {
    throw new PermanentError_('Invalid A1 cell reference: ' + JSON.stringify(cell));
  }
  return [
    match[1] !== undefined ? columnToIndex_(match[1]) : null,
    match[2] !== undefined ? Number(match[2]) - 1 : null,
  ];
}

/** Plain A1 notation, no sheet title. */
function parseA1_(a1, sheetId) {
  const text = String(a1 || '').trim();
  if (!text) throw new PermanentError_('Empty A1 notation');
  const parts = text.split(':');
  if (parts.length > 2) throw new PermanentError_('Invalid A1 notation: ' + JSON.stringify(a1));
  if (parts.length === 1) {
    const [col, row] = parseCell_(parts[0]);
    return grid_(sheetId, row ?? 0, row != null ? row + 1 : null, col ?? 0, col != null ? col + 1 : null);
  }
  let [c1, r1] = parseCell_(parts[0]);
  let [c2, r2] = parseCell_(parts[1]);
  // Reversed references such as H10:A2.
  if (c1 != null && c2 != null && c2 < c1) [c1, c2] = [c2, c1];
  if (r1 != null && r2 != null && r2 < r1) [r1, r2] = [r2, r1];
  return grid_(sheetId, r1 ?? 0, r2 != null ? r2 + 1 : null, c1 ?? 0, c2 != null ? c2 + 1 : null);
}
