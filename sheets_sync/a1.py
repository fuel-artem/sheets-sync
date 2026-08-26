"""A1 notation and URL helpers.

GridRange indices follow the Sheets API convention: 0-based, end-exclusive,
and ``None`` when the notation is open-ended (e.g. ``A2:H``).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional, Tuple

_SPREADSHEET_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9\-_]+)")
_GID_RE = re.compile(r"[#&?]gid=([0-9]+)")
_CELL_RE = re.compile(r"^\$?([A-Za-z]+)?\$?([0-9]+)?$")


def spreadsheet_id_from_url(url: str) -> str:
    """Extract the spreadsheet id from a full Sheets URL (or return it as-is)."""
    url = (url or "").strip()
    m = _SPREADSHEET_ID_RE.search(url)
    if m:
        return m.group(1)
    # Allow a bare id to be pasted into the settings sheet.
    if re.fullmatch(r"[a-zA-Z0-9\-_]{20,}", url):
        return url
    raise ValueError(f"Cannot extract a spreadsheet id from: {url!r}")


def sheet_gid_from_url(url: str) -> int:
    """Extract the tab gid from a full Sheets URL. Defaults to 0, like Apps Script."""
    m = _GID_RE.search(url or "")
    return int(m.group(1)) if m else 0


def column_to_index(letters: str) -> int:
    """'A' -> 0, 'H' -> 7, 'AA' -> 26."""
    idx = 0
    for ch in letters.upper():
        idx = idx * 26 + (ord(ch) - ord("A") + 1)
    return idx - 1


def index_to_column(index: int) -> str:
    """0 -> 'A', 7 -> 'H', 26 -> 'AA'."""
    if index < 0:
        raise ValueError("column index must be >= 0")
    letters = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


@dataclass
class GridRange:
    """Mirror of the Sheets API GridRange (end indices exclusive, None = open)."""

    sheet_id: Optional[int] = None
    start_row_index: int = 0
    end_row_index: Optional[int] = None
    start_column_index: int = 0
    end_column_index: Optional[int] = None

    def to_api(self) -> dict:
        out = {}
        if self.sheet_id is not None:
            out["sheetId"] = self.sheet_id
        out["startRowIndex"] = self.start_row_index
        out["startColumnIndex"] = self.start_column_index
        if self.end_row_index is not None:
            out["endRowIndex"] = self.end_row_index
        if self.end_column_index is not None:
            out["endColumnIndex"] = self.end_column_index
        return out

    def to_a1(self, sheet_title: Optional[str] = None) -> str:
        start = f"{index_to_column(self.start_column_index)}{self.start_row_index + 1}"
        end_col = (
            index_to_column(self.end_column_index - 1)
            if self.end_column_index is not None
            else ""
        )
        end_row = str(self.end_row_index) if self.end_row_index is not None else ""
        rng = f"{start}:{end_col}{end_row}" if (end_col or end_row) else start
        return with_sheet_title(rng, sheet_title)


def split_sheet_title(a1: str) -> Tuple[Optional[str], str]:
    """Split ``'My Tab'!A2:H`` into ("My Tab", "A2:H"). Title is optional."""
    a1 = (a1 or "").strip()
    if "!" not in a1:
        return None, a1
    title, rng = a1.split("!", 1)
    title = title.strip()
    if len(title) >= 2 and title[0] == "'" and title[-1] == "'":
        title = title[1:-1].replace("''", "'")
    return (title or None), rng.strip()


def with_sheet_title(a1_range: str, sheet_title: Optional[str]) -> str:
    if not sheet_title:
        return a1_range
    escaped = sheet_title.replace("'", "''")
    return f"'{escaped}'!{a1_range}"


def _parse_cell(cell: str) -> Tuple[Optional[int], Optional[int]]:
    """'A2' -> (0, 1); 'A' -> (0, None); '2' -> (None, 1)."""
    m = _CELL_RE.match(cell.strip())
    if not m or (m.group(1) is None and m.group(2) is None):
        raise ValueError(f"Invalid A1 cell reference: {cell!r}")
    col = column_to_index(m.group(1)) if m.group(1) else None
    row = int(m.group(2)) - 1 if m.group(2) else None
    return col, row


def parse_a1(a1: str, sheet_id: Optional[int] = None) -> GridRange:
    """Parse plain A1 notation (no sheet title) into a GridRange."""
    rng = (a1 or "").strip()
    if not rng:
        raise ValueError("Empty A1 notation")

    parts = rng.split(":")
    if len(parts) == 1:
        col, row = _parse_cell(parts[0])
        return GridRange(
            sheet_id=sheet_id,
            start_row_index=row or 0,
            end_row_index=(row + 1) if row is not None else None,
            start_column_index=col or 0,
            end_column_index=(col + 1) if col is not None else None,
        )
    if len(parts) != 2:
        raise ValueError(f"Invalid A1 notation: {a1!r}")

    c1, r1 = _parse_cell(parts[0])
    c2, r2 = _parse_cell(parts[1])

    # Normalise reversed references such as H10:A2.
    if c1 is not None and c2 is not None and c2 < c1:
        c1, c2 = c2, c1
    if r1 is not None and r2 is not None and r2 < r1:
        r1, r2 = r2, r1

    return GridRange(
        sheet_id=sheet_id,
        start_row_index=r1 or 0,
        end_row_index=(r2 + 1) if r2 is not None else None,
        start_column_index=c1 or 0,
        end_column_index=(c2 + 1) if c2 is not None else None,
    )
