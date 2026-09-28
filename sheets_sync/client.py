"""Minimal Google Sheets API v4 wrapper over a service account."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

from google.oauth2 import service_account
from googleapiclient.discovery import build

from .a1 import GridRange, with_sheet_title
from .errors import PermanentError, classify
from .retry import DEFAULT_POLICY, RetryPolicy, call_with_retry

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]

log = logging.getLogger(__name__)


# The Sheets troubleshooting guide asks for at most one request per second per
# spreadsheet, and payloads under 2 MB; both are ways a spreadsheet earns a 503.
MIN_INTERVAL = 1.0
# JSON characters per write. A Cyrillic character is two bytes, so this stays
# under 2 MB even when every cell is text in Ukrainian.
MAX_WRITE_CHARS = 1_000_000


def load_credentials(
    credentials_file: Optional[str] = None,
    credentials_json: Optional[str] = None,
):
    """Build service account credentials from a file path or a raw JSON string."""
    credentials_json = credentials_json or os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    credentials_file = credentials_file or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")

    if credentials_json:
        info = json.loads(credentials_json)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    if credentials_file:
        return service_account.Credentials.from_service_account_file(
            credentials_file, scopes=SCOPES
        )
    raise RuntimeError(
        "No credentials. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON."
    )


def write_grid(client, spreadsheet_id: str, grid: GridRange, sheet_title: str, values: List[List[Any]]) -> None:
    """Write `values` at `grid`'s top-left, in row chunks each under MAX_WRITE_CHARS."""
    start = 0
    while start < len(values):
        end, size = start, 0
        while end < len(values) and (end == start or size + len(json.dumps(values[end])) <= MAX_WRITE_CHARS):
            size += len(json.dumps(values[end]))
            end += 1
        chunk = GridRange(
            sheet_id=grid.sheet_id,
            start_row_index=grid.start_row_index + start,
            end_row_index=grid.start_row_index + end,
            start_column_index=grid.start_column_index,
            end_column_index=grid.end_column_index,
        )
        client.set_values(spreadsheet_id, chunk.to_a1(sheet_title), values[start:end])
        start = end


class SheetsClient:
    def __init__(self, credentials=None, policy: Optional[RetryPolicy] = None, **kwargs):
        creds = credentials or load_credentials(**kwargs)
        self.policy = policy or DEFAULT_POLICY
        try:
            self._svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
        except Exception as exc:  # discovery itself can fail transiently
            raise classify(exc) from exc
        self._meta: Dict[str, dict] = {}
        self._last_call: Dict[str, float] = {}
        self._now = time.monotonic
        self._sleep = time.sleep

    def _execute(self, spreadsheet_id: str, request, description: str):
        """Execute an API request; transient failures back off, permanent ones raise."""
        wait = self._last_call.get(spreadsheet_id, float("-inf")) + MIN_INTERVAL - self._now()
        if wait > 0:
            self._sleep(wait)
        self._last_call[spreadsheet_id] = self._now()
        return call_with_retry(request.execute, self.policy, description)

    # ---------------------------------------------------------------- metadata

    def metadata(self, spreadsheet_id: str, refresh: bool = False) -> dict:
        if refresh or spreadsheet_id not in self._meta:
            self._meta[spreadsheet_id] = self._execute(
                spreadsheet_id,
                self._svc.spreadsheets().get(
                    spreadsheetId=spreadsheet_id,
                    fields="properties.title,sheets.properties",
                ),
                f"metadata({spreadsheet_id})",
            )
        return self._meta[spreadsheet_id]

    def sheet_props(
        self,
        spreadsheet_id: str,
        gid: Optional[int] = None,
        title: Optional[str] = None,
        refresh: bool = False,
    ) -> dict:
        """Resolve a tab by title (preferred when given) or gid."""
        meta = self.metadata(spreadsheet_id, refresh=refresh)
        sheets = [s["properties"] for s in meta.get("sheets", [])]
        if title:
            for props in sheets:
                if props["title"] == title:
                    return props
            raise ValueError(f"Tab {title!r} not found in spreadsheet {spreadsheet_id}")
        for props in sheets:
            if props["sheetId"] == gid:
                return props
        raise ValueError(f"Tab with gid={gid} not found in spreadsheet {spreadsheet_id}")

    def data_extent(self, spreadsheet_id: str, sheet_title: str) -> tuple:
        """(last_row, last_column) with data, 1-based; (0, 0) when empty.

        Like getLastRow()/getLastColumn(): the API trims trailing empties when a
        whole tab is requested.
        """
        values = self.get_values(spreadsheet_id, with_sheet_title("A1:ZZZ", sheet_title))
        if not values:
            return 0, 0
        return len(values), max((len(row) for row in values), default=0)

    # ------------------------------------------------------------------ values

    def get_values(
        self,
        spreadsheet_id: str,
        a1: str,
        value_render_option: str = "UNFORMATTED_VALUE",
    ) -> Optional[List[List[Any]]]:
        """FORMATTED_VALUE is the equivalent of Apps Script getDisplayValues()."""
        resp = self._execute(
            spreadsheet_id,
            self._svc.spreadsheets()
            .values()
            .get(
                spreadsheetId=spreadsheet_id,
                range=a1,
                valueRenderOption=value_render_option,
                dateTimeRenderOption="FORMATTED_STRING",
            ),
            f"get {a1}",
        )
        return resp.get("values")

    def set_values(
        self,
        spreadsheet_id: str,
        a1: str,
        values: List[List[Any]],
        value_input_option: str = "USER_ENTERED",
    ) -> dict:
        return self._execute(
            spreadsheet_id,
            self._svc.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=a1,
                valueInputOption=value_input_option,
                body={"values": values},
            ),
            f"set {a1}",
        )

    def batch_set_values(
        self,
        spreadsheet_id: str,
        data: List[dict],
        value_input_option: str = "USER_ENTERED",
    ) -> dict:
        return self._execute(
            spreadsheet_id,
            self._svc.spreadsheets()
            .values()
            .batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={"valueInputOption": value_input_option, "data": data},
            ),
            "batch set",
        )

    def clear_range(self, spreadsheet_id: str, grid: GridRange, sheet_title: str) -> dict:
        """Clear values only (formatting, validation and notes are preserved)."""
        return self._execute(
            spreadsheet_id,
            self._svc.spreadsheets()
            .values()
            .clear(
                spreadsheetId=spreadsheet_id,
                range=grid.to_a1(sheet_title),
                body={},
            ),
            f"clear {grid.to_a1(sheet_title)}",
        )

    # -------------------------------------------------------------- dimensions

    def _insert_dimension(
        self, spreadsheet_id: str, sheet_id: int, dimension: str, after_position: int, count: int
    ) -> None:
        if count <= 0:
            return
        self._execute(
            spreadsheet_id,
            self._svc.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id,
                body={
                    "requests": [
                        {
                            "insertDimension": {
                                "range": {
                                    "sheetId": sheet_id,
                                    "dimension": dimension,
                                    # after_position is 1-based; 0-based start index
                                    # of the inserted block equals it.
                                    "startIndex": after_position,
                                    "endIndex": after_position + count,
                                },
                                "inheritFromBefore": after_position > 0,
                            }
                        }
                    ]
                },
            ),
            f"insert {dimension}",
        )
        self.metadata(spreadsheet_id, refresh=True)

    def insert_rows_after(self, spreadsheet_id: str, sheet_id: int, after_row: int, count: int):
        self._insert_dimension(spreadsheet_id, sheet_id, "ROWS", after_row, count)

    def insert_rows_before(self, spreadsheet_id: str, sheet_id: int, before_row: int, count: int):
        """Apps Script insertRowsBefore: before_row is 1-based."""
        self._insert_dimension(spreadsheet_id, sheet_id, "ROWS", max(before_row - 1, 0), count)

    def insert_columns_after(self, spreadsheet_id: str, sheet_id: int, after_col: int, count: int):
        self._insert_dimension(spreadsheet_id, sheet_id, "COLUMNS", after_col, count)

    # ------------------------------------------------------------ basic filter

    def _batch_update(self, spreadsheet_id: str, requests: List[dict], description: str):
        return self._execute(
            spreadsheet_id,
            self._svc.spreadsheets().batchUpdate(
                spreadsheetId=spreadsheet_id, body={"requests": requests}
            ),
            description,
        )

    def clear_basic_filter(self, spreadsheet_id: str, sheet_id: int) -> bool:
        """Remove the filter so it does not fight the rewrite. False if there was none."""
        try:
            self._batch_update(
                spreadsheet_id,
                [{"clearBasicFilter": {"sheetId": sheet_id}}],
                "clear basic filter",
            )
            return True
        except PermanentError as exc:
            log.debug("no basic filter to clear: %s", exc)
            return False

    def set_basic_filter(self, spreadsheet_id: str, grid: GridRange) -> bool:
        try:
            self._batch_update(
                spreadsheet_id,
                [{"setBasicFilter": {"filter": {"range": grid.to_api()}}}],
                "set basic filter",
            )
            return True
        except PermanentError as exc:
            log.warning("could not restore the basic filter: %s", exc)
            return False
