"""Port of insteadImportOptional / insteadExportOptional.

The two Apps Script functions were identical apart from the tab they read and
the checkbox column they filter on, so both collapse into one code path here.

Three layers of retry sit around it:

  1. per API call, in ``retry.call_with_retry`` - seconds;
  2. per row, in :func:`run` - a row that fails transiently is retried a few
     times inside this run, spaced minutes apart, until ``retry_window`` runs out;
  3. per run - anything still failing is handed back as a retry request, which
     the workflow turns into a fresh dispatch tens of minutes later.

A :class:`PermanentError` never enters any of them: the row is marked failed
immediately and the run reports it.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone as dt_timezone
from typing import Any, Callable, Dict, List, Optional

from .a1 import (
    GridRange,
    parse_a1,
    sheet_gid_from_url,
    spreadsheet_id_from_url,
    split_sheet_title,
    with_sheet_title,
)
from .client import SheetsClient
from .database import DatabaseConfig, DatabaseJob, run_database_job, read_database_settings
from .errors import PermanentError, TransientError, classify
from .settings import SyncJob, read_jobs, write_status

log = logging.getLogger(__name__)

# Layer 2: waits between in-run passes over the rows that failed transiently.
IN_RUN_DELAYS = (30, 120, 300, 600)

# Layer 3: how long the workflow should wait before dispatching attempt 2, 3, 4.
DISPATCH_DELAYS = (15 * 60, 45 * 60, 90 * 60)

DEFAULT_RETRY_WINDOW = 10 * 60  # seconds spent retrying inside one run
DEFAULT_MAX_ATTEMPTS = 4


@dataclass
class JobResult:
    name: str
    status: str  # "ok" | "skipped" | "deferred" | "failed"
    rows: int = 0
    columns: int = 0
    detail: str = ""


@dataclass
class RunReport:
    mode: str
    execution: str
    attempt: int = 1
    results: List[JobResult] = field(default_factory=list)
    error: str = ""  # permanent failure text, written to J2
    deferred: List[Any] = field(default_factory=list)
    transient_detail: str = ""
    retry_request: Optional[dict] = None
    reread_settings: bool = False

    @property
    def ok(self) -> bool:
        return not self.error and not self.deferred


def _resolve(client: SheetsClient, url: str, a1: str):
    """Resolve (spreadsheet_id, sheet properties, plain A1 range) for a settings cell."""
    spreadsheet_id = spreadsheet_id_from_url(url)
    explicit_title, plain_range = split_sheet_title(a1)
    props = client.sheet_props(
        spreadsheet_id, gid=sheet_gid_from_url(url), title=explicit_title
    )
    return spreadsheet_id, props, plain_range


def run_job(client: SheetsClient, job: SyncJob) -> JobResult:
    # --- source ------------------------------------------------------------
    from_ss, from_props, from_range = _resolve(client, job.from_url, job.from_range)
    from_grid = parse_a1(from_range, from_props["sheetId"])

    values = client.get_values(from_ss, with_sheet_title(from_range, from_props["title"]))
    if not values:
        log.info("[%s] source range is empty, skipping", job.name)
        return JobResult(job.name, "skipped", detail="source range empty")

    # Size of the block to clear on the target. A bounded source range wins over
    # the actual data size, so stale rows below the data still get wiped.
    height = (
        from_grid.end_row_index - from_grid.start_row_index
        if from_grid.end_row_index is not None
        else len(values)
    )
    width = (
        from_grid.end_column_index - from_grid.start_column_index
        if from_grid.end_column_index is not None
        else len(values[0])
    )

    # --- target ------------------------------------------------------------
    to_ss, to_props, to_range = _resolve(client, job.to_url, job.to_range)
    to_grid = parse_a1(to_range, to_props["sheetId"])
    start_row = to_grid.start_row_index
    start_col = to_grid.start_column_index

    grid_props = to_props.get("gridProperties", {})
    max_rows = grid_props.get("rowCount", 0)
    max_cols = grid_props.get("columnCount", 0)

    available_rows = max_rows - start_row
    available_cols = max_cols - start_col

    # Grow the target tab if the incoming block does not fit.
    if height > available_rows or width > available_cols:
        last_row, last_col = client.data_extent(to_ss, to_props["title"])
        if height > available_rows:
            client.insert_rows_after(
                to_ss,
                to_props["sheetId"],
                last_row if last_row > 0 else max_rows,
                height - available_rows,
            )
        if width > available_cols:
            client.insert_columns_after(
                to_ss,
                to_props["sheetId"],
                last_col if last_col > 0 else max_cols,
                width - available_cols,
            )
        to_props = client.sheet_props(to_ss, gid=to_props["sheetId"])
        grid_props = to_props.get("gridProperties", {})
        max_rows = grid_props.get("rowCount", max_rows)
        max_cols = grid_props.get("columnCount", max_cols)

    # An open-ended source range clears to the bottom of the target tab;
    # a bounded one clears exactly as many rows as it covers.
    clear_end_row = (
        max_rows
        if from_grid.end_row_index is None
        else from_grid.end_row_index - from_grid.start_row_index + start_row
    )
    clear = GridRange(
        sheet_id=to_props["sheetId"],
        start_row_index=start_row,
        end_row_index=min(clear_end_row, max_rows),
        start_column_index=start_col,
        end_column_index=min(start_col + width, max_cols),
    )
    client.clear_range(to_ss, clear, to_props["title"])

    # --- write -------------------------------------------------------------
    out_width = max(len(row) for row in values)
    padded = [list(row) + [""] * (out_width - len(row)) for row in values]

    is_anchor_only = ":" not in to_range
    if (
        not is_anchor_only
        and to_grid.end_column_index is not None
        and start_col + out_width > to_grid.end_column_index
    ):
        log.warning(
            "[%s] source is %d columns wide but target range %s is narrower; writing past it",
            job.name,
            out_width,
            to_range,
        )

    write_grid = GridRange(
        sheet_id=to_props["sheetId"],
        start_row_index=start_row,
        end_row_index=start_row + len(padded),
        start_column_index=start_col,
        end_column_index=start_col + out_width,
    )
    client.set_values(to_ss, write_grid.to_a1(to_props["title"]), padded)

    log.info(
        "[%s] wrote %d x %d to %s",
        job.name,
        len(padded),
        out_width,
        write_grid.to_a1(to_props["title"]),
    )
    return JobResult(job.name, "ok", rows=len(padded), columns=out_width)


def execute(client: SheetsClient, job) -> JobResult:
    """Run one unit of work: a copy row, or the whole database rebuild."""
    if isinstance(job, DatabaseJob):
        outcome = run_database_job(client, job)
        return JobResult(job.name, "ok", outcome.rows, outcome.columns, outcome.detail)
    return run_job(client, job)


def _pass(client: SheetsClient, jobs: Dict[int, Any], results: Dict[int, JobResult]):
    """Run one pass over the pending rows; return the ones to try again."""
    still_pending: Dict[int, Any] = {}
    last_transient = ""

    for index, job in jobs.items():
        try:
            results[index] = execute(client, job)
        except Exception as exc:  # noqa: BLE001
            error = classify(exc)
            if isinstance(error, TransientError):
                last_transient = str(error)
                results[index] = JobResult(job.name, "deferred", detail=str(error))
                still_pending[index] = job
                log.warning("[%s] transient failure, will retry: %s", job.name, error)
            else:
                results[index] = JobResult(job.name, "failed", detail=str(error))
                # A broken URL or range in one row no longer blocks the others.
                log.error("[%s] permanent failure: %s", job.name, error)

    return still_pending, last_transient


def _status_message(report: RunReport, retry_at: Optional[datetime], timezone_name: str) -> str:
    """
    What lands in J2.

    A run can carry both kinds of failure at once: one row with a bad range,
    another deferred by an outage. Both are reported, the permanent error
    first, so a failure a human must fix never hides a retry that is still
    coming - nor the other way round.
    """
    parts: List[str] = []

    if report.error:
        parts.append(report.error)

    # reread_settings means the tab itself failed transiently, so there are no
    # deferred rows to name even though a retry is scheduled.
    if report.deferred or report.reread_settings:
        names = ", ".join(job.name for job in report.deferred) or "settings"
        if report.retry_request and retry_at is not None:
            from zoneinfo import ZoneInfo

            when = retry_at.astimezone(ZoneInfo(timezone_name)).strftime("%m/%d/%Y %H:%M:%S")
            parts.append(
                f"Google Sheets temporarily unavailable. Retry {report.retry_request['attempt']}"
                f" of {report.retry_request['max_attempts']} scheduled for {when}."
                f" Waiting on: {names}. Last error - {report.transient_detail}"
            )
        else:
            parts.append(
                f"Gave up after {report.attempt} attempts while Google Sheets was unavailable."
                f" Not synced: {names}. Last error - {report.transient_detail}"
            )

    return " | ".join(parts)


def run(
    client: SheetsClient,
    settings_spreadsheet_id: str,
    mode: str,
    execution: str = "manual",
    user: str = "",
    jobs: Optional[List[Any]] = None,
    flag_column: Optional[int] = None,
    database_config: Optional[DatabaseConfig] = None,
    timezone_name: str = "UTC",
    run_url: str = "",
    run_url_cell: Optional[str] = None,
    update_status: bool = True,
    attempt: int = 1,
    max_attempts: int = DEFAULT_MAX_ATTEMPTS,
    retry_window: float = DEFAULT_RETRY_WINDOW,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> RunReport:
    """Run every enabled row of one settings tab, then write the status block."""
    report = RunReport(mode=mode, execution=execution, attempt=attempt)
    pending: Dict[int, Any] = {}
    results: Dict[int, JobResult] = {}

    # Reading the settings tab can fail the same two ways as a row.
    if jobs is None:
        try:
            if mode == "database":
                jobs = read_database_settings(
                    client,
                    settings_spreadsheet_id,
                    execution,
                    database_config or DatabaseConfig(),
                    flag_column=flag_column,
                )
            else:
                jobs = read_jobs(client, settings_spreadsheet_id, mode, execution, flag_column)
        except Exception as exc:  # noqa: BLE001
            error = classify(exc)
            if isinstance(error, TransientError):
                report.transient_detail = str(error)
                report.reread_settings = True
                log.warning("Could not read the settings tab: %s", error)
            else:
                report.error = str(error)
                log.error("Could not read the settings tab: %s", error)
            jobs = []

    pending = dict(enumerate(jobs))

    if pending:
        deadline = now() + retry_window
        for round_index in range(len(IN_RUN_DELAYS) + 1):
            pending, transient_detail = _pass(client, pending, results)
            if transient_detail:
                report.transient_detail = transient_detail
            if not pending or round_index >= len(IN_RUN_DELAYS):
                break

            delay = IN_RUN_DELAYS[round_index]
            if now() + delay > deadline:
                log.warning(
                    "%d row(s) still failing and the in-run retry window is spent",
                    len(pending),
                )
                break
            log.info("retrying %d row(s) in %ds", len(pending), delay)
            sleep(delay)

    report.results = [results[i] for i in sorted(results)]
    report.deferred = [pending[i] for i in sorted(pending)]

    # Rows that failed for a reason no retry will fix become the run's error.
    failed = [r for r in report.results if r.status == "failed"]
    if failed and not report.error:
        report.error = "; ".join(f"{r.name}: {r.detail}" for r in failed)

    # Layer 3: hand what is left back to the workflow as a later dispatch.
    retry_at: Optional[datetime] = None
    if (report.deferred or report.reread_settings) and attempt < max_attempts:
        delay = DISPATCH_DELAYS[min(attempt - 1, len(DISPATCH_DELAYS) - 1)]
        retry_at = datetime.now(dt_timezone.utc) + timedelta(seconds=delay)
        report.retry_request = {
            "attempt": attempt + 1,
            "max_attempts": max_attempts,
            "delay_seconds": delay,
            "not_before": retry_at.replace(microsecond=0).isoformat(),
            "reason": report.transient_detail,
            "inputs": {
                "mode": mode,
                "execution": execution,
                # Everything the run needs comes from the original dispatch;
                # nothing is read from repository defaults.
                "settings_spreadsheet_id": settings_spreadsheet_id,
                "requested_by": user,
                "timezone": timezone_name,
                "database_config": json.dumps(database_config.to_dict())
                if (mode == "database" and database_config)
                else "",
                "attempt": str(attempt + 1),
                "not_before": retry_at.replace(microsecond=0).isoformat(),
                # Only the rows that did not make it; empty means "read the tab again".
                "jobs_json": ""
                if report.reread_settings
                else json.dumps([job.as_dict() for job in report.deferred]),
            },
        }

    if update_status:
        try:
            write_status(
                client,
                settings_spreadsheet_id,
                mode,
                datetime.now(dt_timezone.utc),
                user,
                _status_message(report, retry_at, timezone_name),
                timezone=timezone_name,
                run_url_cell=run_url_cell,
                run_url=run_url,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not write the status block: %s", classify(exc))

    return report
