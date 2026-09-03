"""Reading the Import/Export Settings tabs and writing the status block."""

from __future__ import annotations

import logging
from dataclasses import dataclass, asdict
from datetime import datetime
from typing import Any, List, Optional, Sequence

from zoneinfo import ZoneInfo

from .a1 import with_sheet_title
from .client import SheetsClient

log = logging.getLogger(__name__)

# Fallback tab names. The sheet sends its own in the dispatch payload, since
# they are spreadsheet-specific like everything else about the layout.
TAB = {
    "import": "Import Settings",
    "export": "Export Settings",
    # The Database import reads the same tab as the plain import; the variant
    # differs in its flag columns, its extra columns, and its status cells.
    "database": "Import Settings",
}

# Column layout of a settings row (0-based):
#   A name | B from URL | C from range | D to URL | E to range | F..H flags
COL_NAME, COL_FROM_URL, COL_FROM_RANGE, COL_TO_URL, COL_TO_RANGE = 0, 1, 2, 3, 4

# Which checkbox column decides whether a row runs.
# Mirrors: export -> trigger ? 5 : 6, import -> trigger ? 6 : 7
FLAG_COLUMN = {
    ("export", "trigger"): 5,
    ("export", "manual"): 6,
    ("import", "trigger"): 6,
    ("import", "manual"): 7,
    # The database variant shifts both by one again: H and I.
    ("database", "trigger"): 7,
    ("database", "manual"): 8,
}

# Status block: error, timestamp, user. The database variant keeps it in L.
# The Apps Script formats its own timestamp to match.
TIME_FORMAT = "%m/%d/%Y %H:%M:%S"

STATUS_CELLS = {
    "import": ("J2", "J3", "J4"),
    "export": ("J2", "J3", "J4"),
    "database": ("L2", "L3", "L4"),
}


@dataclass
class SyncJob:
    name: str
    from_url: str
    from_range: str
    to_url: str
    to_range: str

    @classmethod
    def from_row(cls, row: Sequence[Any]) -> "SyncJob":
        def cell(i: int) -> str:
            return str(row[i]).strip() if i < len(row) and row[i] is not None else ""

        return cls(
            name=cell(COL_NAME),
            from_url=cell(COL_FROM_URL),
            from_range=cell(COL_FROM_RANGE),
            to_url=cell(COL_TO_URL),
            to_range=cell(COL_TO_RANGE),
        )

    def as_dict(self) -> dict:
        return asdict(self)


def read_jobs(
    client: SheetsClient,
    settings_spreadsheet_id: str,
    mode: str,
    execution: str,
    flag_column: Optional[int] = None,
    tab: Optional[str] = None,
) -> List[SyncJob]:
    """Return the enabled rows of the Import/Export Settings tab, in sheet order."""
    tab = tab or TAB[mode]
    index = FLAG_COLUMN[(mode, execution)] if flag_column is None else flag_column

    rows = client.get_values(settings_spreadsheet_id, with_sheet_title("A2:Z", tab)) or []

    jobs: List[SyncJob] = []
    for offset, row in enumerate(rows):
        name = row[COL_NAME] if COL_NAME < len(row) else ""
        if str(name).strip() == "":
            continue
        # The flag column holds a checkbox, so UNFORMATTED_VALUE gives a bool.
        if index >= len(row) or not row[index]:
            continue
        job = SyncJob.from_row(row)
        missing = [
            field
            for field in ("from_url", "from_range", "to_url", "to_range")
            if not getattr(job, field)
        ]
        if missing:
            raise ValueError(
                f"{tab} row {offset + 2} ({job.name}) is missing: {', '.join(missing)}"
            )
        jobs.append(job)

    log.info("%s: %d enabled row(s) for execution=%s", tab, len(jobs), execution)
    return jobs


def write_status(
    client: SheetsClient,
    settings_spreadsheet_id: str,
    mode: str,
    when: Optional[datetime],
    user: str,
    status: str = "",
    timezone: str = "UTC",
    run_url_cell: Optional[str] = None,
    run_url: str = "",
    status_cells: Optional[Sequence[str]] = None,
    tab: Optional[str] = None,
) -> None:
    """Write the status block, same as statusImportUpdate/statusExportUpdate.

    ``status_cells`` overrides the per-mode default; the database variant sends
    its own in the dispatch payload.
    """
    tab = tab or TAB[mode]
    status_cell, date_cell, user_cell = tuple(status_cells or STATUS_CELLS[mode])
    formatted = ""
    if when is not None:
        formatted = when.astimezone(ZoneInfo(timezone)).strftime(TIME_FORMAT)

    data = [
        {"range": with_sheet_title(status_cell, tab), "values": [[str(status or "")]]},
        {"range": with_sheet_title(date_cell, tab), "values": [[formatted]]},
        {"range": with_sheet_title(user_cell, tab), "values": [[user or ""]]},
    ]
    if run_url_cell and run_url:
        data.append(
            {"range": with_sheet_title(run_url_cell, tab), "values": [[run_url]]}
        )

    client.batch_set_values(settings_spreadsheet_id, data)
