"""CLI entrypoint: python -m sheets_sync --mode import --execution manual

Every parameter that identifies *what* to sync arrives on the command line or in
the environment set from the workflow inputs, which in turn come from the Apps
Script dispatch. There is no repository-level default spreadsheet: a run with no
settings_spreadsheet_id is an error, not a run against some other file.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import List, Optional

from .client import SheetsClient
from .database import DatabaseConfig, DatabaseJob
from .errors import PermanentError, TransientError, classify
from .retry import RetryPolicy
from .settings import SyncJob
from .sync import DEFAULT_MAX_ATTEMPTS, DEFAULT_RETRY_WINDOW, run

EXIT_OK = 0
EXIT_PERMANENT = 1
EXIT_BAD_USAGE = 2
EXIT_GAVE_UP = 75  # EX_TEMPFAIL: still transient, but no attempts left


def _parse_inline_jobs(raw: Optional[str]) -> Optional[List[Any]]:
    """Accept a JSON job list from the sheet, or from a retry dispatch.

    A database rebuild round-trips through here too, so a retry resumes it
    without re-reading the settings tab.
    """
    if not raw or not raw.strip():
        return None
    payload = json.loads(raw)
    if isinstance(payload, dict):
        payload = payload.get("jobs", [])
    if not payload:
        return None

    jobs: List[Any] = []
    for item in payload:
        if item.get("kind") == "database":
            jobs.append(DatabaseJob.from_dict(item))
            continue
        jobs.append(
            SyncJob(
                name=str(item.get("name", "")),
                from_url=str(item["from_url"]),
                from_range=str(item["from_range"]),
                to_url=str(item["to_url"]),
                to_range=str(item["to_range"]),
            )
        )
    return jobs


def _load_database_config(raw: str) -> DatabaseConfig:
    """Inline JSON, or @path to a file. Empty means the documented defaults."""
    raw = (raw or "").strip()
    if not raw:
        return DatabaseConfig()
    if raw.startswith("@"):
        with open(raw[1:], encoding="utf-8") as fh:
            return DatabaseConfig.from_dict(json.load(fh))
    return DatabaseConfig.from_dict(json.loads(raw))


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="sheets_sync", description="Sheets import/export runner")
    p.add_argument("--mode", choices=["import", "export", "database"], required=True)
    p.add_argument(
        "--execution",
        choices=["manual", "trigger"],
        default=os.environ.get("EXECUTION", "manual"),
        help="Which checkbox column selects the rows to run",
    )
    p.add_argument(
        "--settings-spreadsheet-id",
        default=os.environ.get("SETTINGS_SPREADSHEET_ID", ""),
        help="Spreadsheet holding the Import/Export Settings tabs (required)",
    )
    p.add_argument("--user", default=os.environ.get("REQUESTED_BY", ""))
    p.add_argument("--credentials-file", default=None)
    p.add_argument(
        "--flag-column",
        type=int,
        default=None,
        help="Override the 0-based checkbox column (default: export 5/6, import 6/7)",
    )
    p.add_argument(
        "--timezone",
        default=os.environ.get("TIMEZONE", "") or "UTC",
        help="Timezone for the J3 timestamp; sent by the sheet",
    )
    p.add_argument(
        "--jobs-json",
        default=os.environ.get("JOBS_JSON", ""),
        help="Optional inline job list; skips reading the settings tab",
    )
    p.add_argument(
        "--database-config",
        default=os.environ.get("DATABASE_CONFIG", ""),
        help="JSON (or @file) overriding the database layout: transaction_length, "
        "keep_columns, ai_ranges, ... Sent by the sheet, since each copy differs.",
    )
    p.add_argument("--run-url", default=os.environ.get("RUN_URL", ""))
    p.add_argument(
        "--run-url-cell",
        default=os.environ.get("RUN_URL_CELL", ""),
        help="Optional cell (e.g. J5) to receive the Actions run link",
    )

    retry = p.add_argument_group("retry")
    retry.add_argument(
        "--attempt",
        type=int,
        default=int(os.environ.get("ATTEMPT", "1") or 1),
        help="Which attempt this run is; incremented by each scheduled retry",
    )
    retry.add_argument(
        "--max-attempts",
        type=int,
        default=int(os.environ.get("MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS)),
    )
    retry.add_argument(
        "--retry-window-minutes",
        type=float,
        default=float(os.environ.get("RETRY_WINDOW_MINUTES", DEFAULT_RETRY_WINDOW / 60)),
        help="How long this run keeps retrying transiently failing rows before deferring",
    )
    retry.add_argument(
        "--call-attempts",
        type=int,
        default=int(os.environ.get("CALL_ATTEMPTS", "5")),
        help="Backoff attempts per individual API call",
    )
    retry.add_argument(
        "--retry-file",
        default=os.environ.get("RETRY_FILE", ""),
        help="Where to write the retry request when rows are deferred",
    )

    p.add_argument(
        "--status-cells",
        default="",
        help="Override the status block cells, e.g. J2,J3,J4 (error, timestamp, user)",
    )
    p.add_argument("--no-status", action="store_true", help="Do not write the status block")
    p.add_argument("--dry-run", action="store_true", help="List the rows that would run")
    p.add_argument("--verbose", "-v", action="store_true")
    return p


def _github_output(**values) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            fh.write(f"{key}={value}\n")


def _write_summary(mode: str, execution: str, report) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(f"### {mode} ({execution}) - attempt {report.attempt}\n\n")
        fh.write("| row | status | size | detail |\n|---|---|---|---|\n")
        for result in report.results:
            fh.write(
                f"| {result.name} | {result.status} | {result.rows}x{result.columns} "
                f"| {result.detail} |\n"
            )
        if report.error:
            fh.write(f"\n**Permanent failure:** `{report.error}`\n")
        if report.retry_request:
            fh.write(
                f"\n**Retry {report.retry_request['attempt']} of "
                f"{report.retry_request['max_attempts']}** scheduled for "
                f"`{report.retry_request['not_before']}` - "
                f"{report.retry_request['reason']}\n"
            )
        elif report.deferred:
            fh.write("\n**Gave up** while Google Sheets was unavailable.\n")


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    if not args.settings_spreadsheet_id:
        print(
            "Missing --settings-spreadsheet-id. It must come from the dispatch that "
            "started this run; there is no default.",
            file=sys.stderr,
        )
        return EXIT_BAD_USAGE

    status_cells = None
    if args.status_cells:
        status_cells = [c.strip() for c in args.status_cells.split(",") if c.strip()]
        if len(status_cells) != 3:
            print(
                "--status-cells needs exactly 3 cells: error,timestamp,user",
                file=sys.stderr,
            )
            return EXIT_BAD_USAGE

    policy = RetryPolicy(attempts=args.call_attempts)

    try:
        database_config = _load_database_config(args.database_config)
        client = SheetsClient(credentials_file=args.credentials_file, policy=policy)
        jobs = _parse_inline_jobs(args.jobs_json)
    except (TransientError, PermanentError) as exc:
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_GAVE_UP if isinstance(exc, TransientError) else EXIT_PERMANENT
    except Exception as exc:  # noqa: BLE001 - bad jobs_json, bad key file
        print(classify(exc), file=sys.stderr)
        return EXIT_BAD_USAGE

    if args.dry_run:
        from .database import read_database_settings
        from .settings import read_jobs

        if jobs is None:
            jobs = (
                read_database_settings(
                    client,
                    args.settings_spreadsheet_id,
                    args.execution,
                    database_config,
                    flag_column=args.flag_column,
                )
                if args.mode == "database"
                else read_jobs(
                    client,
                    args.settings_spreadsheet_id,
                    args.mode,
                    args.execution,
                    args.flag_column,
                )
            )
        for job in jobs:
            print(json.dumps(job.as_dict()))
        return EXIT_OK

    report = run(
        client,
        args.settings_spreadsheet_id,
        mode=args.mode,
        execution=args.execution,
        user=args.user,
        jobs=jobs,
        flag_column=args.flag_column,
        database_config=database_config,
        timezone_name=args.timezone,
        run_url=args.run_url,
        run_url_cell=args.run_url_cell or None,
        update_status=not args.no_status,
        attempt=args.attempt,
        max_attempts=args.max_attempts,
        retry_window=args.retry_window_minutes * 60,
        status_cells=status_cells,
    )

    for result in report.results:
        print(f"{result.status:<9} {result.name} {result.rows}x{result.columns} {result.detail}")

    _write_summary(args.mode, args.execution, report)

    if report.retry_request:
        if args.retry_file:
            with open(args.retry_file, "w", encoding="utf-8") as fh:
                json.dump(report.retry_request, fh)
        _github_output(
            retry="true",
            not_before=report.retry_request["not_before"],
            attempt=report.retry_request["attempt"],
        )
        print(
            f"Deferred {len(report.deferred)} row(s); retry "
            f"{report.retry_request['attempt']}/{report.retry_request['max_attempts']} "
            f"at {report.retry_request['not_before']}",
            file=sys.stderr,
        )
        # A scheduled retry is not a failed run.
        return EXIT_PERMANENT if report.error else EXIT_OK

    _github_output(retry="false")

    if report.error:
        print(report.error, file=sys.stderr)
        return EXIT_PERMANENT
    if report.deferred:
        print("Out of retry attempts; rows left unsynced.", file=sys.stderr)
        return EXIT_GAVE_UP
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
