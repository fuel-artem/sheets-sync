/**
 * Minimal Google Sheets API v4 client over a service account.
 *
 * The REST API rather than SpreadsheetApp on purpose: one values call moves a
 * whole block, where the native service is far slower on large ranges and
 * runs as whoever clicked, not as the account every sheet is shared with.
 */

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets/';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// Library Script Properties are shared by every spreadsheet that includes the
// library, so the key is set once, here, and never in a client project.
const KEY_PROPERTY = 'GCP_SA_KEY';

function base64Url_(value) {
  return Utilities.base64EncodeWebSafe(value).replace(/=+$/, '');
}

/** A cached access token for the service account in KEY_PROPERTY. */
function accessToken_(policy) {
  const raw = PropertiesService.getScriptProperties().getProperty(KEY_PROPERTY);
  if (!raw) {
    throw new PermanentError('The Fuel Sync library has no service account key (' + KEY_PROPERTY + ').');
  }
  const key = JSON.parse(raw);
  const cache = CacheService.getScriptCache();
  const cacheKey = 'token:' + key.client_email;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = base64Url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.'
    + base64Url_(JSON.stringify({
      iss: key.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600
    }));
  const assertion = unsigned + '.'
    + base64Url_(Utilities.computeRsaSha256Signature(unsigned, key.private_key));

  const body = callWithRetry_(function () {
    return fetchJson_(TOKEN_URL, {
      method: 'post',
      payload: {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: assertion
      }
    }, true);
  }, policy, 'token');

  // A token lives an hour; refreshing a little early avoids a mid-run 401.
  cache.put(cacheKey, body.access_token, Math.max(60, (body.expires_in || 3600) - 300));
  return body.access_token;
}

/**
 * One HTTP call. Non-2xx becomes HttpError, a thrown fetch becomes a network
 * failure; classify_ decides which of those are worth retrying.
 */
function fetchJson_(url, options, isTokenCall) {
  let response;
  try {
    response = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true }, options));
  } catch (e) {
    e.isFetchFailure = true;
    throw e;
  }
  const code = response.getResponseCode();
  const text = response.getContentText();
  if (code >= 200 && code < 300) return text ? JSON.parse(text) : {};

  // The token endpoint answers OAuth-style: a rejected key is permanent.
  if (isTokenCall && code >= 400 && code < 500) {
    throw new PermanentError('Service account rejected: HTTP ' + code + ': ' + text);
  }
  throw new HttpError(code, text, response.getHeaders());
}

function createClient_(policy) {
  policy = policy || DEFAULT_POLICY;
  const meta = {};

  function call(method, path, description, payload) {
    return callWithRetry_(function () {
      const options = {
        method: method,
        headers: { Authorization: 'Bearer ' + accessToken_(policy) }
      };
      if (payload !== undefined) {
        options.contentType = 'application/json';
        options.payload = JSON.stringify(payload);
      }
      return fetchJson_(SHEETS_API + path, options);
    }, policy, description);
  }

  function query(params) {
    return Object.keys(params)
      .map(function (k) { return k + '=' + encodeURIComponent(params[k]); })
      .join('&');
  }

  const client = {
    metadata: function (ssId, refresh) {
      if (refresh || !meta[ssId]) {
        meta[ssId] = call('get', ssId + '?' + query({ fields: 'properties.title,sheets.properties' }),
          'metadata(' + ssId + ')');
      }
      return meta[ssId];
    },

    /** Resolve a tab by title (preferred when given) or gid. */
    sheetProps: function (ssId, gid, title, refresh) {
      const sheets = (client.metadata(ssId, refresh).sheets || []).map(function (s) { return s.properties; });
      if (title) {
        const byTitle = sheets.filter(function (p) { return p.title === title; })[0];
        if (!byTitle) throw new PermanentError('Tab ' + JSON.stringify(title) + ' not found in spreadsheet ' + ssId);
        return byTitle;
      }
      const byGid = sheets.filter(function (p) { return p.sheetId === gid; })[0];
      if (!byGid) throw new PermanentError('Tab with gid=' + gid + ' not found in spreadsheet ' + ssId);
      return byGid;
    },

    /**
     * [lastRow, lastColumn] with data, 1-based; [0, 0] when empty. Like
     * getLastRow()/getLastColumn(): the API trims trailing empties.
     */
    dataExtent: function (ssId, title) {
      const values = client.getValues(ssId, withSheetTitle_('A1:ZZZ', title));
      if (!values) return [0, 0];
      return [values.length, Math.max.apply(null, values.map(function (r) { return r.length; }).concat([0]))];
    },

    /** FORMATTED_VALUE is the equivalent of getDisplayValues(). */
    getValues: function (ssId, a1, renderOption) {
      const resp = call('get', ssId + '/values/' + encodeURIComponent(a1) + '?' + query({
        valueRenderOption: renderOption || 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      }), 'get ' + a1);
      return resp.values || null;
    },

    setValues: function (ssId, a1, values) {
      return call('put', ssId + '/values/' + encodeURIComponent(a1) + '?valueInputOption=USER_ENTERED',
        'set ' + a1, { values: values });
    },

    batchSetValues: function (ssId, data) {
      return call('post', ssId + '/values:batchUpdate', 'batch set',
        { valueInputOption: 'USER_ENTERED', data: data });
    },

    /** Values only; formatting, validation and notes are preserved. */
    clearRange: function (ssId, grid, title) {
      const a1 = gridToA1_(grid, title);
      return call('post', ssId + '/values/' + encodeURIComponent(a1) + ':clear', 'clear ' + a1, {});
    },

    batchUpdate: function (ssId, requests, description) {
      return call('post', ssId + ':batchUpdate', description, { requests: requests });
    },

    insertDimension: function (ssId, sheetId, dimension, afterPosition, count) {
      if (count <= 0) return;
      client.batchUpdate(ssId, [{
        insertDimension: {
          range: {
            sheetId: sheetId,
            dimension: dimension,
            // afterPosition is 1-based; the 0-based start of the inserted block equals it.
            startIndex: afterPosition,
            endIndex: afterPosition + count
          },
          inheritFromBefore: afterPosition > 0
        }
      }], 'insert ' + dimension);
      client.metadata(ssId, true);
    },

    insertRowsAfter: function (ssId, sheetId, afterRow, count) {
      client.insertDimension(ssId, sheetId, 'ROWS', afterRow, count);
    },

    /** Apps Script insertRowsBefore: beforeRow is 1-based. */
    insertRowsBefore: function (ssId, sheetId, beforeRow, count) {
      client.insertDimension(ssId, sheetId, 'ROWS', Math.max(beforeRow - 1, 0), count);
    },

    insertColumnsAfter: function (ssId, sheetId, afterCol, count) {
      client.insertDimension(ssId, sheetId, 'COLUMNS', afterCol, count);
    },

    /** Remove the filter so it does not fight the rewrite. False if there was none. */
    clearBasicFilter: function (ssId, sheetId) {
      try {
        client.batchUpdate(ssId, [{ clearBasicFilter: { sheetId: sheetId } }], 'clear basic filter');
        return true;
      } catch (e) {
        if (!(e instanceof PermanentError)) throw e;
        return false;
      }
    },

    setBasicFilter: function (ssId, grid) {
      try {
        client.batchUpdate(ssId, [{ setBasicFilter: { filter: { range: gridToApi_(grid) } } }], 'set basic filter');
        return true;
      } catch (e) {
        if (!(e instanceof PermanentError)) throw e;
        console.warn('could not restore the basic filter: ' + e);
        return false;
      }
    }
  };
  return client;
}
