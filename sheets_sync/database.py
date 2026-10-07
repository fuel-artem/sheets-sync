"""The Database import: rebuilds the database tab rather than copying a range.

Rows whose source is being refreshed are dropped, every enabled source is
re-read, each transaction is widened and enriched from the `AI Settings`
handbook, then the tab is rewritten in one pass.

Layout, in database column order:

    0        source label            (settings column F)
    1..21    the transaction         (transaction_length columns from the source)
    22..25   CF block                (from AI Settings A3:G)
    26..29   P&L block               (from AI Settings I3:O)
    30..33   BS block                (from AI Settings Q3:W)
    then     preserved_columns       (kept on existing rows, blank on new
                                      ones; none by default)

Those columns are the rebuild's; it reads, clears and writes nothing past them,
so the tab's own formulas to the right survive. Every number lives in
:class:`DatabaseConfig`; each client sends its own in the dispatch payload.
"""

from __future__ import annotations

import logging
import math
import re
from collections import OrderedDict
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional, Sequence, Tuple

from .a1 import GridRange, index_to_column, parse_a1, sheet_gid_from_url, spreadsheet_id_from_url, split_sheet_title, with_sheet_title
from .client import SheetsClient, replace_area
from .errors import PermanentError
from .settings import COL_NAME, SyncJob

log = logging.getLogger(__name__)

KEY_SEPARATOR = "\u00ac"  # the "¬" used to join the handbook key
AI_BLOCKS = ("cf", "pl", "bs")


@dataclass
class DatabaseConfig:
    """Everything the original script kept as constants at the top of the file."""

    database_tab: str = "General database"
    ai_tab: str = "AI Settings"
    # AI Settings blocks: first three columns form the key, the rest is the payload.
    ai_ranges: Dict[str, str] = field(
        default_factory=lambda: {"cf": "A3:G", "pl": "I3:O", "bs": "Q3:W"}
    )
    # databaseLength in the original: how many columns one transaction occupies.
    transaction_length: int = 21
    ai_block_width: int = 4
    # Columns after the AI blocks that existing rows keep and new rows leave blank.
    preserved_columns: int = 0
    # Indexes *inside the transaction*, not the database row.
    amount_index: int = 7
    date_indexes: Dict[str, int] = field(
        default_factory=lambda: {"cf": 0, "pl": 1, "bs": 2}
    )
    key_indexes: Tuple[int, int] = (19, 20)
    # Which key part must be present for the row to count as a transaction.
    # The original filtered on database column 20, i.e. key part 0.
    required_key_part: int = 0
    # Spare rows to keep below the data.
    row_headroom: int = 5
    # Settings columns specific to this variant.
    source_label_column: int = 5
    is_database_column: int = 6
    declared_length_column: int = 9
    # Travels in the dispatch payload; settings.STATUS_CELLS holds the
    # import/export default.
    status_cells: Tuple[str, str, str] = ("L2", "L3", "L4")
    # Restore the basic filter over the tab afterwards, as the original did.
    restore_filter: bool = True

    @classmethod
    def from_dict(cls, data: Optional[dict]) -> "DatabaseConfig":
        if not data:
            return cls()
        known = {f for f in cls().__dict__}
        unknown = set(data) - known
        if unknown:
            raise PermanentError(f"Unknown database config keys: {', '.join(sorted(unknown))}")
        merged = {**cls().__dict__, **data}
        merged["key_indexes"] = tuple(merged["key_indexes"])
        cells = tuple(merged["status_cells"])
        if len(cells) != 3:
            raise PermanentError(
                f"status_cells needs exactly 3 cells (error, timestamp, user), got {len(cells)}"
            )
        merged["status_cells"] = cells
        return cls(**merged)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["key_indexes"] = list(self.key_indexes)
        data["status_cells"] = list(self.status_cells)
        return data

    @property
    def width(self) -> int:
        """How many columns, from A, the rebuild owns."""
        return 1 + self.transaction_length + len(AI_BLOCKS) * self.ai_block_width + self.preserved_columns

    @property
    def label_offset(self) -> int:
        """Database index of transaction field 0 (the source label sits at 0)."""
        return 1


@dataclass
class DatabaseSource:
    name: str
    label: str  # written into database column A
    from_url: str
    from_range: str
    declared_length: Optional[int] = None

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class DatabaseJob:
    """One unit of work: rebuild the database tab from every enabled source."""

    settings_spreadsheet_id: str
    sources: List[DatabaseSource]
    # Labels removed from the existing database before the rebuild. Taken from
    # every enabled settings row, not only the database ones.
    replaced_labels: List[str]
    config: DatabaseConfig = field(default_factory=DatabaseConfig)
    name: str = "General database"
    # The to_url of the database rows: the database tab and AI Settings live in
    # that spreadsheet, not necessarily the one holding Import Settings. Empty
    # means they are in the settings spreadsheet.
    database_url: str = ""

    def as_dict(self) -> dict:
        return {
            "kind": "database",
            "name": self.name,
            "settings_spreadsheet_id": self.settings_spreadsheet_id,
            "sources": [s.as_dict() for s in self.sources],
            "replaced_labels": list(self.replaced_labels),
            "config": self.config.to_dict(),
            "database_url": self.database_url,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "DatabaseJob":
        return cls(
            settings_spreadsheet_id=data["settings_spreadsheet_id"],
            sources=[DatabaseSource(**s) for s in data.get("sources", [])],
            replaced_labels=list(data.get("replaced_labels", [])),
            config=DatabaseConfig.from_dict(data.get("config")),
            name=data.get("name", "General database"),
            database_url=data.get("database_url", ""),
        )


@dataclass
class DatabaseOutcome:
    rows: int
    columns: int
    detail: str = ""


# --------------------------------------------------------------------- helpers

_JS_NUMBER = re.compile(
    r"^[+-]?(?:Infinity|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)"
)


def js_parse_float(value: Any) -> float:
    """Mimic JavaScript parseFloat, including its leading-prefix behaviour.

    The database is read as display values, so an amount can arrive as
    "1,234.56". JS parseFloat gives 1 and the row survives; float() would raise
    and silently change which rows do. Do not simplify.
    """
    if isinstance(value, bool):
        return math.nan
    if isinstance(value, (int, float)):
        return float(value)
    match = _JS_NUMBER.match(str(value).strip())
    if not match:
        return math.nan
    token = match.group(0)
    if token.endswith("Infinity"):
        return -math.inf if token.startswith("-") else math.inf
    return float(token)


def is_nonzero_number(value: Any) -> bool:
    """JS truthiness of parseFloat(value): NaN and 0 are both dropped."""
    parsed = js_parse_float(value)
    return not math.isnan(parsed) and parsed != 0


def key_part(value: Any) -> str:
    """Stringify like a JS template literal: 1.0 -> "1", not "1.0"."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if value is None:
        return ""
    return str(value)


def _cell(row: Sequence[Any], index: int, default: Any = "") -> Any:
    return row[index] if index < len(row) and row[index] is not None else default


def build_handbook(rows: Sequence[Sequence[Any]], block_width: int) -> Dict[str, List[Any]]:
    """AI Settings block -> {"category¬subcategory¬sign": [4 values]}.

    The API trims trailing empty cells, so short payloads are padded to the block
    width; otherwise a row missing its last cell shifts every later database
    column by one.
    """
    handbook: Dict[str, List[Any]] = {}
    for row in rows:
        if not row or str(_cell(row, 0)).strip() == "":
            continue
        key = KEY_SEPARATOR.join(key_part(_cell(row, i)) for i in range(3))
        payload = list(row[3 : 3 + block_width])
        payload += [""] * (block_width - len(payload))
        handbook[key] = payload
    return handbook


def read_handbooks(
    client: SheetsClient, spreadsheet_id: str, config: DatabaseConfig
) -> Dict[str, Dict[str, List[Any]]]:
    handbooks = {}
    for block, a1 in config.ai_ranges.items():
        rows = client.get_values(spreadsheet_id, with_sheet_title(a1, config.ai_tab)) or []
        handbooks[block] = build_handbook(rows, config.ai_block_width)
        log.info("AI Settings %s: %d entries", block.upper(), len(handbooks[block]))
    return handbooks


def build_row(
    transaction: Sequence[Any],
    label: Any,
    handbooks: Dict[str, Dict[str, List[Any]]],
    config: DatabaseConfig,
) -> List[Any]:
    """One source transaction -> one database row."""
    values = list(transaction[: config.transaction_length])
    if len(transaction) > config.transaction_length:
        # Truncating keeps the AI blocks aligned; the original shifted them.
        log.warning(
            "transaction is %d columns wide, expected %d; extra columns ignored",
            len(transaction),
            config.transaction_length,
        )
    values += [""] * (config.transaction_length - len(values))

    amount = js_parse_float(_cell(values, config.amount_index))
    sign = "+" if (not math.isnan(amount) and amount > 0) else "-"

    key = KEY_SEPARATOR.join(
        [key_part(_cell(values, config.key_indexes[0])), key_part(_cell(values, config.key_indexes[1])), sign]
    )

    row: List[Any] = [label, *values]
    for block in AI_BLOCKS:
        date_cell = _cell(values, config.date_indexes[block])
        entry = handbooks.get(block, {}).get(key)
        if date_cell != "" and entry:
            row.extend(entry)
        else:
            row.extend([""] * config.ai_block_width)
    row.extend([""] * config.preserved_columns)
    return row


def _database_index(config: DatabaseConfig, transaction_index: int) -> int:
    return config.label_offset + transaction_index


# ------------------------------------------------------------------ the run

def run_database_job(client: SheetsClient, job: DatabaseJob) -> DatabaseOutcome:
    config = job.config
    # The database and AI Settings tabs live wherever the database rows point,
    # which is usually not the spreadsheet holding Import Settings.
    ss_id = (
        spreadsheet_id_from_url(job.database_url)
        if job.database_url
        else job.settings_spreadsheet_id
    )
    # A gid in the url beats the configured title, which is only a fallback.
    gid = sheet_gid_from_url(job.database_url) if job.database_url else None
    props = client.sheet_props(
        ss_id, gid=gid, title=None if gid is not None else config.database_tab
    )
    database_tab = props["title"]
    sheet_id = props["sheetId"]
    grid = props.get("gridProperties", {})
    max_rows = grid.get("rowCount", 0)
    max_cols = grid.get("columnCount", 0)
    width = config.width
    # Checked before anything is cleared: a write wider than the tab fails after
    # the clear, and leaves the database empty.
    if width > max_cols:
        raise PermanentError(
            f"{database_tab} has {max_cols} columns but the rebuild needs {width} "
            f"(A:{index_to_column(width - 1)}); check transaction_length and preserved_columns"
        )

    handbooks = read_handbooks(client, ss_id, config)

    # Existing transactions, as display values, minus the sources being refreshed.
    existing_raw = (
        client.get_values(
            ss_id,
            with_sheet_title(f"A2:{index_to_column(width - 1)}", database_tab),
            value_render_option="FORMATTED_VALUE",
        )
        or []
    )
    replaced = {str(label).strip() for label in job.replaced_labels}
    kept = [
        row
        for row in existing_raw
        if row and str(_cell(row, 0)).strip() != "" and str(_cell(row, 0)).strip() not in replaced
    ]
    output: List[List[Any]] = [list(row[:width]) for row in kept]
    kept_count = len(output)
    log.info("kept %d existing row(s) of %d", kept_count, len(existing_raw))

    # Re-read every database source and widen its transactions.
    for source in job.sources:
        from_ss = spreadsheet_id_from_url(source.from_url)
        explicit_title, plain_range = split_sheet_title(source.from_range)
        from_props = client.sheet_props(
            from_ss, gid=sheet_gid_from_url(source.from_url), title=explicit_title
        )
        values = client.get_values(
            from_ss, with_sheet_title(plain_range, from_props["title"])
        )
        if not values:
            # Skipping keeps the other sources alive; the original threw here.
            log.warning("[%s] source range is empty, nothing imported", source.name)
            continue
        for transaction in values:
            output.append(build_row(transaction, source.label, handbooks, config))
        log.info("[%s] %d transaction(s)", source.name, len(values))

    read_count = len(output) - kept_count

    # Drop headers and zero-amount rows.
    amount_col = _database_index(config, config.amount_index)
    before_amount = len(output)
    output = [row for row in output if is_nonzero_number(_cell(row, amount_col))]
    # The tab grows on this count, as the original did, before the next filters.
    needed_rows = len(output) + config.row_headroom

    # Rows with no category, or with none of the three dates, are not transactions.
    category_col = _database_index(config, config.key_indexes[config.required_key_part])
    date_cols = [_database_index(config, i) for i in config.date_indexes.values()]
    before_category = len(output)
    output = [row for row in output if str(_cell(row, category_col)).strip() != ""]
    before_dates = len(output)
    output = [row for row in output if any(str(_cell(row, c)).strip() != "" for c in date_cols)]

    dropped = (
        f"{before_amount - before_category} with no non-zero amount (column {index_to_column(amount_col)}), "
        f"{before_category - before_dates} with no category (column {index_to_column(category_col)}), "
        f"{before_dates - len(output)} with none of the dates "
        f"(columns {', '.join(index_to_column(c) for c in date_cols)})"
    )
    log.info("[%s] %d read, %d kept; dropped %s", job.name, read_count, kept_count, dropped)
    # Writing nothing would empty the database. Every row failing the filters means
    # the indexes no longer match the sources, so refuse before touching the tab.
    if before_amount and not output:
        raise PermanentError(
            f"every row was filtered out ({read_count} read, {kept_count} kept; dropped {dropped}). "
            "Check amount_index, key_indexes and date_indexes. Nothing was changed."
        )

    if needed_rows > max_rows:
        client.insert_rows_before(ss_id, sheet_id, max_rows, needed_rows - max_rows)
        props = client.sheet_props(ss_id, gid=sheet_id)
        grid = props.get("gridProperties", {})
        max_rows = grid.get("rowCount", max_rows)
        max_cols = grid.get("columnCount", max_cols)
    # A filter left in place fights the rewrite, exactly as in the original.
    client.clear_basic_filter(ss_id, sheet_id)

    # Rewrite the owned columns from A2 down.
    replace_area(
        client,
        ss_id,
        GridRange(sheet_id=sheet_id, start_row_index=1, end_row_index=max_rows,
                  start_column_index=0, end_column_index=width),
        database_tab,
        [list(row) + [""] * (width - len(row)) for row in output],
    )

    if config.restore_filter:
        client.set_basic_filter(
            ss_id,
            GridRange(
                sheet_id=sheet_id,
                start_row_index=0,
                end_row_index=max_rows,
                start_column_index=0,
                end_column_index=max_cols,
            ),
        )

    log.info("[%s] wrote %d x %d", job.name, len(output), width)
    return DatabaseOutcome(rows=len(output), columns=width)


# --------------------------------------------------------------- settings read

def _target_key(tab: str, line: int, url: str) -> Tuple[str, Optional[int]]:
    """Which database tab a row feeds: (spreadsheet id, gid).

    A blank column D means the tab is in the settings spreadsheet, under the
    configured title - how a single-database sheet has always behaved.
    """
    if not url:
        return ("", None)
    try:
        return (spreadsheet_id_from_url(url), sheet_gid_from_url(url))
    except ValueError as exc:
        raise PermanentError(f"{tab} row {line} (column D): {exc}") from exc


def read_database_settings(
    client: SheetsClient,
    settings_spreadsheet_id: str,
    execution: str,
    config: DatabaseConfig,
    tab: Optional[str] = None,
    flag_column: Optional[int] = None,
) -> List[Any]:
    """Read the Import Settings tab of a database-import spreadsheet.

    The rebuild comes first (if any source feeds it), then the plain copy rows.
    """
    from .settings import FLAG_COLUMN, TAB

    tab = tab or TAB["database"]
    index = FLAG_COLUMN[("database", execution)] if flag_column is None else flag_column
    rows = client.get_values(settings_spreadsheet_id, with_sheet_title("A2:Z", tab)) or []

    enabled: List[Tuple[int, Sequence[Any]]] = []
    for offset, row in enumerate(rows):
        if str(_cell(row, COL_NAME)).strip() == "":
            continue
        if not _cell(row, index):
            continue
        enabled.append((offset + 2, row))

    # One entry per distinct database tab, in first-appearance order.
    groups: "OrderedDict[Tuple[str, Optional[int]], Dict[str, Any]]" = OrderedDict()
    others: List[SyncJob] = []
    over_length: List[str] = []
    other_labels: List[str] = []

    for line, row in enabled:
        name = str(_cell(row, COL_NAME)).strip()
        if _cell(row, config.is_database_column):
            declared = _cell(row, config.declared_length_column, None)
            declared_int = int(js_parse_float(declared)) if declared not in ("", None) else None
            if declared_int is not None and not math.isnan(js_parse_float(declared)):
                if declared_int > config.transaction_length:
                    over_length.append(f"{name} (row {line}: {declared_int})")
            url = str(_cell(row, 3)).strip()
            group = groups.setdefault(
                _target_key(tab, line, url),
                {"url": url, "sources": [], "labels": []},
            )
            label = str(_cell(row, config.source_label_column)).strip()
            group["labels"].append(label)
            group["sources"].append(
                DatabaseSource(
                    name=name,
                    label=label,
                    from_url=str(_cell(row, 1)).strip(),
                    from_range=str(_cell(row, 2)).strip(),
                    declared_length=declared_int,
                )
            )
        else:
            other_labels.append(str(_cell(row, config.source_label_column)).strip())
            job = SyncJob.from_row(row)
            missing = [
                f
                for f in ("from_url", "from_range", "to_url", "to_range")
                if not getattr(job, f)
            ]
            if missing:
                raise PermanentError(
                    f"{tab} row {line} ({name}) is missing: {', '.join(missing)}"
                )
            others.append(job)

    if over_length:
        raise PermanentError(
            f"Some ranges for the Database are longer than needed "
            f"(needed {config.transaction_length}). Check the length in column J: "
            + "; ".join(over_length)
        )

    jobs: List[Any] = []
    for index, ((ss, _gid), group) in enumerate(groups.items(), start=1):
        # Only this tab's own labels are cleared from it. The enabled copy rows'
        # labels are cleared from every database, as the original did.
        name = config.database_tab
        if len(groups) > 1:
            name = f"{config.database_tab} #{index}" + (f" ({ss[:8]})" if ss else "")
        jobs.append(
            DatabaseJob(
                settings_spreadsheet_id=settings_spreadsheet_id,
                sources=group["sources"],
                replaced_labels=group["labels"] + other_labels,
                config=config,
                database_url=group["url"],
                name=name,
            )
        )
    jobs.extend(others)
    log.info(
        "%s: %d database tab(s), %d source(s), %d copy row(s) for execution=%s",
        tab,
        len(groups),
        sum(len(g["sources"]) for g in groups.values()),
        len(others),
        execution,
    )
    return jobs
