"""Layer 1 of the retry stack: per API call, seconds. See `sync` for the rest.

Only :class:`TransientError` is retried. A :class:`PermanentError` raises on the
first attempt, so a bad range never sits in a backoff loop.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Callable, Optional, TypeVar

from .errors import PermanentError, TransientError, classify

log = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class RetryPolicy:
    attempts: int = 5
    base_delay: float = 1.0
    max_delay: float = 32.0
    jitter: float = 0.5
    # If a single call would spend longer than this waiting, stop and let the
    # caller decide (it will defer the row to a later run instead).
    budget: float = 90.0

    def delay_for(self, attempt: int, retry_after: Optional[float] = None) -> float:
        """attempt is 1-based: 1s, 2s, 4s, 8s ... plus jitter."""
        backoff = min(self.base_delay * (2 ** (attempt - 1)), self.max_delay)
        if retry_after is not None:
            backoff = max(backoff, retry_after)
        return backoff + random.uniform(0, self.jitter)


DEFAULT_POLICY = RetryPolicy()


def call_with_retry(
    fn: Callable[[], T],
    policy: RetryPolicy = DEFAULT_POLICY,
    description: str = "",
    sleep: Callable[[float], None] = time.sleep,
) -> T:
    """Run ``fn``, retrying transient failures with exponential backoff."""
    spent = 0.0
    last: Optional[TransientError] = None

    for attempt in range(1, policy.attempts + 1):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - classify decides what it was
            error = classify(exc)
            if isinstance(error, PermanentError):
                raise error from exc

            last = error
            if attempt == policy.attempts:
                break

            delay = policy.delay_for(attempt, error.retry_after)
            if spent + delay > policy.budget:
                log.warning(
                    "%s: transient failure and the per-call budget is spent (%s)",
                    description or "call",
                    error,
                )
                break

            log.warning(
                "%s: %s - attempt %d/%d, waiting %.1fs",
                description or "call",
                error,
                attempt,
                policy.attempts,
                delay,
            )
            sleep(delay)
            spent += delay

    assert last is not None
    raise last
