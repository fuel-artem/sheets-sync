"""Transient (retry) versus permanent (stop) failures.

The reason code in the body wins over the HTTP status, because the status alone
is ambiguous: a 403 can be `permissionDenied` or a `rateLimitExceeded` throttle,
and a 429 `dailyLimitExceeded` will not clear before midnight Pacific.
"""

from __future__ import annotations

import json
import socket
import ssl
from typing import Any, Optional

from googleapiclient.errors import HttpError

try:  # pragma: no cover - import shape depends on the installed google-auth
    from google.auth.exceptions import RefreshError, TransportError
except ImportError:  # pragma: no cover
    class RefreshError(Exception):
        pass

    class TransportError(Exception):
        pass

try:  # pragma: no cover
    from httplib2 import ServerNotFoundError
except ImportError:  # pragma: no cover
    class ServerNotFoundError(Exception):
        pass


class SyncError(Exception):
    """Base class; carries the original exception for logging."""

    def __init__(self, message: str, original: Optional[BaseException] = None):
        super().__init__(message)
        self.original = original


class TransientError(SyncError):
    """The server was busy, throttling, or unreachable. Worth retrying."""

    def __init__(
        self,
        message: str,
        original: Optional[BaseException] = None,
        retry_after: Optional[float] = None,
    ):
        super().__init__(message, original)
        # Seconds requested by the server via the Retry-After header, if any.
        self.retry_after = retry_after


class PermanentError(SyncError):
    """Bad range, missing tab, no access, exhausted daily quota. Retrying will not help."""


# Statuses that mean "the other side had a bad moment".
TRANSIENT_STATUS = {408, 409, 429, 500, 502, 503, 504}

# Reason codes returned in the error body. Lowercased for comparison.
TRANSIENT_REASONS = {
    "ratelimitexceeded",
    "userratelimitexceeded",
    "userratelimitexceededunreg",
    "quotaexceeded",  # per-minute quota; the daily one has its own reason
    "backenderror",
    "internalerror",
    "transienterror",
    "serviceunavailable",
    "concurrentlimitexceeded",
    "resourceexhausted",
}

PERMANENT_REASONS = {
    "dailylimitexceeded",  # resets at midnight PT, far outside any retry window
    "dailylimitexceededunreg",
    "permissiondenied",
    "forbidden",
    "notfound",
    "badrequest",
    "invalid",
    "invalidparameter",
    "invalidquery",
    "parsenotsupported",
    "required",
    "authenticationfailure",
    "unauthorized",
    "accessnotconfigured",
    "insufficientpermissions",
    "insufficientfilepermissions",
    "keyinvalid",
    "keyexpired",
    "failedprecondition",
}

# The newer canonical status strings (error.status in the JSON body).
TRANSIENT_CANONICAL = {"UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED", "ABORTED", "RESOURCE_EXHAUSTED"}
PERMANENT_CANONICAL = {
    "PERMISSION_DENIED",
    "NOT_FOUND",
    "INVALID_ARGUMENT",
    "UNAUTHENTICATED",
    "FAILED_PRECONDITION",
    "OUT_OF_RANGE",
    "ALREADY_EXISTS",
}


def _body(err: HttpError) -> dict:
    try:
        content = err.content.decode("utf-8") if isinstance(err.content, bytes) else err.content
        parsed = json.loads(content or "{}")
        return parsed.get("error", {}) if isinstance(parsed, dict) else {}
    except (ValueError, AttributeError):
        return {}


def _reason(error_body: dict) -> str:
    errors = error_body.get("errors") or []
    if errors and isinstance(errors, list) and isinstance(errors[0], dict):
        return str(errors[0].get("reason", "")).lower()
    details = error_body.get("details") or []
    for detail in details:
        if isinstance(detail, dict) and detail.get("reason"):
            return str(detail["reason"]).lower()
    return ""


def _retry_after(err: HttpError) -> Optional[float]:
    header = getattr(err, "resp", None)
    if header is None:
        return None
    value = header.get("retry-after") or header.get("Retry-After")
    if not value:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        # An HTTP-date form; treat it as "the server wants a real pause".
        return 60.0


def _message(err: HttpError, body: dict, status: Any, reason: str) -> str:
    detail = body.get("message") or getattr(err, "_get_reason", lambda: "")() or str(err)
    detail = str(detail).strip()
    label = f"HTTP {status}"
    if reason:
        label += f" ({reason})"
    return f"{label}: {detail}"


def classify(exc: BaseException) -> SyncError:
    """Map any exception onto TransientError or PermanentError."""
    if isinstance(exc, SyncError):
        return exc

    if isinstance(exc, HttpError):
        status = getattr(getattr(exc, "resp", None), "status", None)
        body = _body(exc)
        reason = _reason(body)
        canonical = str(body.get("status", "")).upper()
        message = _message(exc, body, status, reason or canonical)

        if reason in PERMANENT_REASONS:
            return PermanentError(message, exc)
        if reason in TRANSIENT_REASONS:
            return TransientError(message, exc, _retry_after(exc))
        if canonical in PERMANENT_CANONICAL:
            return PermanentError(message, exc)
        if canonical in TRANSIENT_CANONICAL:
            return TransientError(message, exc, _retry_after(exc))
        if status in TRANSIENT_STATUS:
            return TransientError(message, exc, _retry_after(exc))
        return PermanentError(message, exc)

    # Credentials: a transport hiccup while refreshing is worth retrying,
    # a rejected key is not.
    if isinstance(exc, RefreshError):
        text = str(exc).lower()
        if any(token in text for token in ("invalid_grant", "unauthorized_client", "invalid_client")):
            return PermanentError(f"Service account rejected: {exc}", exc)
        return TransientError(f"Token refresh failed: {exc}", exc)

    # Network layer: DNS, TLS, timeouts, resets.
    if isinstance(
        exc,
        (
            TransportError,
            ServerNotFoundError,
            socket.timeout,
            TimeoutError,
            ConnectionError,
            ssl.SSLError,
            BrokenPipeError,
            OSError,
        ),
    ):
        return TransientError(f"{type(exc).__name__}: {exc}", exc)

    return PermanentError(f"{type(exc).__name__}: {exc}", exc)


def is_transient(exc: BaseException) -> bool:
    return isinstance(classify(exc), TransientError)
