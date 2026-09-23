/**
 * Transient (retry) versus permanent (stop) failures.
 *
 * The reason code in the body wins over the HTTP status, because the status
 * alone is ambiguous: a 403 can be `permissionDenied` or a `rateLimitExceeded`
 * throttle, and a 429 `dailyLimitExceeded` will not clear before midnight PT.
 */

class SyncError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
  toString() {
    return this.message;
  }
}

/** The server was busy, throttling, or unreachable. Worth retrying. */
class TransientError extends SyncError {
  constructor(message, retryAfter) {
    super(message);
    // Seconds requested by the server via Retry-After, if any.
    this.retryAfter = retryAfter === undefined ? null : retryAfter;
  }
}

/** Bad range, missing tab, no access, exhausted daily quota. Retrying will not help. */
class PermanentError extends SyncError {}

/** A non-2xx response, thrown by the client and classified here. */
class HttpError extends Error {
  constructor(status, body, headers) {
    super('HTTP ' + status);
    this.status = status;
    this.body = body || '';
    this.headers = headers || {};
  }
}

// Statuses that mean "the other side had a bad moment".
const TRANSIENT_STATUS = [408, 409, 429, 500, 502, 503, 504];

const TRANSIENT_REASONS = [
  'ratelimitexceeded',
  'userratelimitexceeded',
  'userratelimitexceededunreg',
  'quotaexceeded', // per-minute quota; the daily one has its own reason
  'backenderror',
  'internalerror',
  'transienterror',
  'serviceunavailable',
  'concurrentlimitexceeded',
  'resourceexhausted'
];

const PERMANENT_REASONS = [
  'dailylimitexceeded', // resets at midnight PT, far outside any retry window
  'dailylimitexceededunreg',
  'permissiondenied',
  'forbidden',
  'notfound',
  'badrequest',
  'invalid',
  'invalidparameter',
  'invalidquery',
  'parsenotsupported',
  'required',
  'authenticationfailure',
  'unauthorized',
  'accessnotconfigured',
  'insufficientpermissions',
  'insufficientfilepermissions',
  'keyinvalid',
  'keyexpired',
  'failedprecondition'
];

const TRANSIENT_CANONICAL = ['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'ABORTED', 'RESOURCE_EXHAUSTED'];
const PERMANENT_CANONICAL = [
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'UNAUTHENTICATED',
  'FAILED_PRECONDITION',
  'OUT_OF_RANGE',
  'ALREADY_EXISTS'
];

function errorBody_(err) {
  try {
    const parsed = JSON.parse(err.body || '{}');
    return parsed && typeof parsed.error === 'object' && parsed.error ? parsed.error : {};
  } catch (e) {
    return {};
  }
}

function errorReason_(body) {
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length && errors[0] && typeof errors[0] === 'object') {
    return String(errors[0].reason || '').toLowerCase();
  }
  for (const detail of body.details || []) {
    if (detail && detail.reason) return String(detail.reason).toLowerCase();
  }
  return '';
}

function retryAfter_(err) {
  const headers = err.headers || {};
  const value = headers['Retry-After'] || headers['retry-after'];
  if (!value) return null;
  const seconds = Number(value);
  // An HTTP-date form; treat it as "the server wants a real pause".
  return isNaN(seconds) ? 60 : seconds;
}

/** Map anything thrown onto TransientError or PermanentError. */
function classify_(exc) {
  if (exc instanceof SyncError) return exc;

  if (exc instanceof HttpError) {
    const body = errorBody_(exc);
    const reason = errorReason_(body);
    const canonical = String(body.status || '').toUpperCase();
    const label = 'HTTP ' + exc.status + (reason || canonical ? ' (' + (reason || canonical) + ')' : '');
    const message = label + ': ' + String(body.message || exc.body || '').trim();

    if (PERMANENT_REASONS.indexOf(reason) >= 0) return new PermanentError(message);
    if (TRANSIENT_REASONS.indexOf(reason) >= 0) return new TransientError(message, retryAfter_(exc));
    if (PERMANENT_CANONICAL.indexOf(canonical) >= 0) return new PermanentError(message);
    if (TRANSIENT_CANONICAL.indexOf(canonical) >= 0) return new TransientError(message, retryAfter_(exc));
    if (TRANSIENT_STATUS.indexOf(exc.status) >= 0) return new TransientError(message, retryAfter_(exc));
    return new PermanentError(message);
  }

  const text = String((exc && exc.message) || exc);
  // UrlFetchApp's own daily quota is per user and resets with the day.
  if (/too many times for one day/i.test(text)) return new PermanentError(text);
  // Everything else UrlFetchApp throws is the network layer: DNS, TLS,
  // timeouts, resets, "Address unavailable".
  if (exc && exc.isFetchFailure) return new TransientError(text);
  return new PermanentError((exc && exc.name ? exc.name + ': ' : '') + text);
}

function isTransient_(exc) {
  return classify_(exc) instanceof TransientError;
}
