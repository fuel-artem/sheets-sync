// Transient (retry) versus permanent (stop) failures.
//
// The reason code in the body wins over the HTTP status, because the status alone
// is ambiguous: a 403 can be `permissionDenied` or a `rateLimitExceeded` throttle,
// and a 429 `dailyLimitExceeded` will not clear before midnight Pacific.

class HttpError_ extends Error {
  constructor(status, body, headers) {
    super('HTTP ' + status);
    this.name = 'HttpError';
    this.status = status;
    this.body = body || '';
    this.headers = headers || {};
  }
}

/** UrlFetchApp itself threw: DNS, timeout, connection reset, fetch quota. */
class NetworkError_ extends Error {
  constructor(message) {
    super(message);
    this.name = 'NetworkError';
  }
}

class SyncError_ extends Error {
  constructor(message, original) {
    super(message);
    this.original = original;
  }
}

class TransientError_ extends SyncError_ {
  constructor(message, original, retryAfter) {
    super(message, original);
    this.name = 'TransientError';
    // Seconds the server asked for in Retry-After, if any.
    this.retryAfter = retryAfter == null ? null : retryAfter;
  }
}

class PermanentError_ extends SyncError_ {
  constructor(message, original) {
    super(message, original);
    this.name = 'PermanentError';
  }
}

const TRANSIENT_STATUS_ = new Set([408, 409, 429, 500, 502, 503, 504]);

const TRANSIENT_REASONS_ = new Set([
  'ratelimitexceeded', 'userratelimitexceeded', 'userratelimitexceededunreg',
  'quotaexceeded', // per-minute quota; the daily one has its own reason
  'backenderror', 'internalerror', 'transienterror', 'serviceunavailable',
  'concurrentlimitexceeded', 'resourceexhausted',
]);

const PERMANENT_REASONS_ = new Set([
  'dailylimitexceeded', 'dailylimitexceededunreg', 'permissiondenied', 'forbidden',
  'notfound', 'badrequest', 'invalid', 'invalidparameter', 'invalidquery',
  'parsenotsupported', 'required', 'authenticationfailure', 'unauthorized',
  'accessnotconfigured', 'insufficientpermissions', 'insufficientfilepermissions',
  'keyinvalid', 'keyexpired', 'failedprecondition',
]);

const TRANSIENT_CANONICAL_ = new Set(['UNAVAILABLE', 'INTERNAL', 'DEADLINE_EXCEEDED', 'ABORTED', 'RESOURCE_EXHAUSTED']);
const PERMANENT_CANONICAL_ = new Set([
  'PERMISSION_DENIED', 'NOT_FOUND', 'INVALID_ARGUMENT', 'UNAUTHENTICATED',
  'FAILED_PRECONDITION', 'OUT_OF_RANGE', 'ALREADY_EXISTS',
]);

function errorBody_(err) {
  try {
    const parsed = JSON.parse(err.body || '{}');
    return parsed && typeof parsed.error === 'object' ? parsed.error : {};
  } catch (e) {
    return {};
  }
}

function errorReason_(body) {
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length && errors[0] && errors[0].reason) {
    return String(errors[0].reason).toLowerCase();
  }
  for (const detail of body.details || []) {
    if (detail && detail.reason) return String(detail.reason).toLowerCase();
  }
  return '';
}

function retryAfter_(err) {
  const key = Object.keys(err.headers).find((k) => k.toLowerCase() === 'retry-after');
  const value = key ? String(err.headers[key]).trim() : '';
  if (!value) return null;
  const seconds = Number(value);
  // An HTTP-date instead of seconds: the server wants a real pause.
  return isNaN(seconds) ? 60 : seconds;
}

/** Map anything thrown onto TransientError_ or PermanentError_. */
function classify_(exc) {
  if (exc instanceof SyncError_) return exc;

  if (exc instanceof HttpError_) {
    const body = errorBody_(exc);
    const reason = errorReason_(body);
    const canonical = String(body.status || '').toUpperCase();
    const label = 'HTTP ' + exc.status + (reason || canonical ? ' (' + (reason || canonical) + ')' : '');
    const message = label + ': ' + String(body.message || exc.body || 'no message').trim().slice(0, 300);

    if (PERMANENT_REASONS_.has(reason)) return new PermanentError_(message, exc);
    if (TRANSIENT_REASONS_.has(reason)) return new TransientError_(message, exc, retryAfter_(exc));
    if (PERMANENT_CANONICAL_.has(canonical)) return new PermanentError_(message, exc);
    if (TRANSIENT_CANONICAL_.has(canonical)) return new TransientError_(message, exc, retryAfter_(exc));
    if (TRANSIENT_STATUS_.has(exc.status)) return new TransientError_(message, exc, retryAfter_(exc));
    return new PermanentError_(message, exc);
  }

  if (exc instanceof NetworkError_) {
    // "Service invoked too many times for one day: urlfetch" will not clear today.
    if (/for one day/i.test(exc.message)) return new PermanentError_(exc.message, exc);
    return new TransientError_(exc.message, exc);
  }

  const name = (exc && exc.name) || 'Error';
  return new PermanentError_(name + ': ' + ((exc && exc.message) || String(exc)), exc);
}
