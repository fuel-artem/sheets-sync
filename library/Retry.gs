// Layer 1 of the retry stack: per API call, seconds. See Sync.gs for the rest.
//
// Only TransientError_ is retried. A PermanentError_ throws on the first attempt,
// so a bad range never sits in a backoff loop.

// Six waits of 1..32s add up to just over a minute, which is how long a
// per-minute quota takes to refill after a 429.
const RETRY_POLICY_ = { attempts: 7, baseDelay: 1, maxDelay: 32, jitter: 1, budget: 90 };

/** Google's formula, min(2^n + up to 1s, maximum_backoff), in seconds; attempt is 1-based. */
function retryDelay_(policy, attempt, retryAfter) {
  const backoff = Math.min(policy.baseDelay * Math.pow(2, attempt - 1) + Math.random() * policy.jitter, policy.maxDelay);
  return retryAfter != null ? Math.max(backoff, retryAfter) : backoff;
}

function callWithRetry_(fn, clock, description, policy) {
  policy = policy || RETRY_POLICY_;
  let spent = 0;
  let last = null;
  for (let attempt = 1; attempt <= policy.attempts; attempt++) {
    try {
      return fn();
    } catch (exc) {
      const error = classify_(exc);
      if (error instanceof PermanentError_) throw error;
      last = error;
      if (attempt === policy.attempts) break;
      const delay = retryDelay_(policy, attempt, error.retryAfter);
      // The run deadline caps this too: Apps Script kills an execution at six minutes.
      if (spent + delay > policy.budget || clock.now() + delay * 1000 > clock.deadline) {
        console.warn(description + ': transient failure and no time left to wait (' + error.message + ')');
        break;
      }
      console.warn(description + ': ' + error.message + ' - attempt ' + attempt + '/' + policy.attempts +
        ', waiting ' + delay.toFixed(1) + 's');
      clock.sleep(delay * 1000);
      spent += delay;
    }
  }
  throw last;
}
