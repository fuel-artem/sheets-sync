/**
 * Layer 1 of the retry stack: per API call, seconds. See Sync.js for the rest.
 *
 * Only TransientError is retried. A PermanentError raises on the first
 * attempt, so a bad range never sits in a backoff loop.
 */

const DEFAULT_POLICY = {
  attempts: 5,
  baseDelay: 1,
  maxDelay: 32,
  jitter: 0.5,
  // If a single call would spend longer than this waiting, stop and let the
  // caller decide (it defers the row to a later run instead).
  budget: 90
};

/** attempt is 1-based: 1s, 2s, 4s, 8s ... plus jitter. Seconds. */
function retryDelay_(policy, attempt, retryAfter) {
  let backoff = Math.min(policy.baseDelay * Math.pow(2, attempt - 1), policy.maxDelay);
  if (retryAfter !== null && retryAfter !== undefined) backoff = Math.max(backoff, retryAfter);
  return backoff + Math.random() * policy.jitter;
}

/**
 * Run fn, retrying transient failures with exponential backoff.
 * sleep takes seconds; injected so tests do not wait.
 */
function callWithRetry_(fn, policy, description, sleep) {
  policy = policy || DEFAULT_POLICY;
  sleep = sleep || function (seconds) { Utilities.sleep(seconds * 1000); };
  let spent = 0;
  let last = null;

  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return fn();
    } catch (exc) {
      const error = classify_(exc);
      if (error instanceof PermanentError) throw error;

      last = error;
      if (attempt === policy.attempts) break;

      const delay = retryDelay_(policy, attempt, error.retryAfter);
      if (spent + delay > policy.budget) {
        console.warn((description || 'call') + ': transient failure and the per-call budget is spent (' + error + ')');
        break;
      }
      console.warn((description || 'call') + ': ' + error + ' - attempt ' + attempt + '/' + policy.attempts
        + ', waiting ' + delay.toFixed(1) + 's');
      sleep(delay);
      spent += delay;
    }
  }
  throw last;
}
