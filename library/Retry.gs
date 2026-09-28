// Layer 1 of the retry stack: per API call, seconds. See Sync.gs for the rest.
//
// Only TransientError_ is retried. A PermanentError_ throws on the first attempt,
// so a bad range never sits in a backoff loop.

const RETRY_POLICY_ = { attempts: 5, baseDelay: 1, maxDelay: 32, jitter: 0.5, budget: 90 };

/** Seconds before retry number `attempt` (1-based): 1, 2, 4 ... plus jitter. */
function retryDelay_(policy, attempt, retryAfter) {
  let backoff = Math.min(policy.baseDelay * Math.pow(2, attempt - 1), policy.maxDelay);
  if (retryAfter != null) backoff = Math.max(backoff, retryAfter);
  return backoff + Math.random() * policy.jitter;
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
