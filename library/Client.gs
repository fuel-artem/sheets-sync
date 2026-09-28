// Google Sheets API v4 over UrlFetchApp, as the signed-in user.
//
// Deliberately not SpreadsheetApp: the REST API gives unformatted reads, sized
// writes and real status codes, which the transient/permanent split depends on.

const SHEETS_API_ = 'https://sheets.googleapis.com/v4/spreadsheets/';

class SheetsClient_ {
  constructor(token, clock, fetch) {
    this.token = token;
    this.clock = clock;
    this.fetch = fetch || ((url, options) => UrlFetchApp.fetch(url, options));
    this.meta = {};
  }

  call_(method, path, query, body, description) {
    const params = Object.keys(query || {})
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
      .join('&');
    const url = SHEETS_API_ + path + (params ? '?' + params : '');
    const options = {
      method: method,
      headers: { Authorization: 'Bearer ' + this.token },
      muteHttpExceptions: true,
    };
    if (body !== undefined) {
      options.contentType = 'application/json';
      options.payload = JSON.stringify(body);
    }
    return callWithRetry_(() => {
      let response;
      try {
        response = this.fetch(url, options);
      } catch (exc) {
        throw new NetworkError_(String((exc && exc.message) || exc));
      }
      const code = response.getResponseCode();
      const text = response.getContentText();
      if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};
      throw new HttpError_(code, text, response.getHeaders());
    }, this.clock, description);
  }

  // ---------------------------------------------------------------- metadata

  metadata(spreadsheetId, refresh) {
    if (refresh || !this.meta[spreadsheetId]) {
      this.meta[spreadsheetId] = this.call_(
        'get', spreadsheetId, { fields: 'properties(title,timeZone),sheets.properties' },
        undefined, 'metadata(' + spreadsheetId + ')'
      );
    }
    return this.meta[spreadsheetId];
  }

  timeZone(spreadsheetId) {
    return this.metadata(spreadsheetId).properties.timeZone;
  }

  /** Resolve a tab by title when one is given, otherwise by gid. */
  sheetProps(spreadsheetId, gid, title, refresh) {
    const sheets = (this.metadata(spreadsheetId, refresh).sheets || []).map((s) => s.properties);
    if (title) {
      const byTitle = sheets.find((p) => p.title === title);
      if (byTitle) return byTitle;
      throw new PermanentError_("Tab '" + title + "' not found in spreadsheet " + spreadsheetId);
    }
    const byGid = sheets.find((p) => p.sheetId === gid);
    if (byGid) return byGid;
    throw new PermanentError_('Tab with gid=' + gid + ' not found in spreadsheet ' + spreadsheetId);
  }

  /** [lastRow, lastColumn] with data, 1-based; [0, 0] when empty. */
  dataExtent(spreadsheetId, sheetTitle) {
    const values = this.getValues(spreadsheetId, withSheetTitle_('A1:ZZZ', sheetTitle));
    if (!values) return [0, 0];
    return [values.length, values.reduce((w, row) => Math.max(w, row.length), 0)];
  }

  // ------------------------------------------------------------------ values

  /** FORMATTED_VALUE is the equivalent of getDisplayValues(). */
  getValues(spreadsheetId, a1, valueRenderOption) {
    const response = this.call_(
      'get', spreadsheetId + '/values/' + encodeURIComponent(a1),
      { valueRenderOption: valueRenderOption || 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' },
      undefined, 'get ' + a1
    );
    return response.values || null;
  }

  setValues(spreadsheetId, a1, values) {
    return this.call_(
      'put', spreadsheetId + '/values/' + encodeURIComponent(a1),
      { valueInputOption: 'USER_ENTERED' }, { values: values }, 'set ' + a1
    );
  }

  batchSetValues(spreadsheetId, data) {
    return this.call_(
      'post', spreadsheetId + '/values:batchUpdate', null,
      { valueInputOption: 'USER_ENTERED', data: data }, 'batch set'
    );
  }

  /** Values only: formatting, validation and notes survive. */
  clearRange(spreadsheetId, grid, sheetTitle) {
    const a1 = gridToA1_(grid, sheetTitle);
    return this.call_('post', spreadsheetId + '/values/' + encodeURIComponent(a1) + ':clear', null, {}, 'clear ' + a1);
  }

  // -------------------------------------------------------------- dimensions

  batchUpdate_(spreadsheetId, requests, description) {
    return this.call_('post', spreadsheetId + ':batchUpdate', null, { requests: requests }, description);
  }

  /** `afterPosition` is 1-based, so it is also the 0-based start of the new block. */
  insertDimension_(spreadsheetId, sheetId, dimension, afterPosition, count) {
    if (count <= 0) return;
    this.batchUpdate_(spreadsheetId, [{
      insertDimension: {
        range: { sheetId: sheetId, dimension: dimension, startIndex: afterPosition, endIndex: afterPosition + count },
        inheritFromBefore: afterPosition > 0,
      },
    }], 'insert ' + dimension);
    this.metadata(spreadsheetId, true);
  }

  insertRowsAfter(spreadsheetId, sheetId, afterRow, count) {
    this.insertDimension_(spreadsheetId, sheetId, 'ROWS', afterRow, count);
  }

  /** Like insertRowsBefore: `beforeRow` is 1-based. */
  insertRowsBefore(spreadsheetId, sheetId, beforeRow, count) {
    this.insertDimension_(spreadsheetId, sheetId, 'ROWS', Math.max(beforeRow - 1, 0), count);
  }

  insertColumnsAfter(spreadsheetId, sheetId, afterCol, count) {
    this.insertDimension_(spreadsheetId, sheetId, 'COLUMNS', afterCol, count);
  }

  // ------------------------------------------------------------ basic filter

  /** Removed so it does not fight the rewrite; false if there was none. */
  clearBasicFilter(spreadsheetId, sheetId) {
    try {
      this.batchUpdate_(spreadsheetId, [{ clearBasicFilter: { sheetId: sheetId } }], 'clear basic filter');
      return true;
    } catch (exc) {
      if (exc instanceof PermanentError_) return false;
      throw exc;
    }
  }

  setBasicFilter(spreadsheetId, grid) {
    try {
      this.batchUpdate_(spreadsheetId, [{ setBasicFilter: { filter: { range: gridToApi_(grid) } } }], 'set basic filter');
      return true;
    } catch (exc) {
      if (!(exc instanceof PermanentError_)) throw exc;
      console.warn('could not restore the basic filter: ' + exc.message);
      return false;
    }
  }
}
