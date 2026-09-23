# Fuel Sync

An Apps Script library that runs the Fuel Finance Import, Export and Database-import syncs
between spreadsheets. Each spreadsheet includes the library and keeps a small stub that
describes its own layout; the library reads the Settings tabs, copies the ranges through the
Sheets REST API as a service account, and writes the status block back.

```
Sheet button / time trigger ──▶ stub (templates/) ──▶ FuelSync.run(options)
                                                        ├─ reads Import/Export Settings
                                                        ├─ copies each enabled row  (Sheets API v4, service account)
                                                        ├─ writes J2:J4 (L2:L4 for the rebuild)
                                                        └─ on a transient failure: a one-off trigger ──▶ fuelSyncResume
```

The copying goes through the REST API with a service-account token, not `SpreadsheetApp`:
one values call moves a whole block where the native service is far slower on large
ranges, and every sheet is shared with the one account rather than with whoever clicked.

## The three modes

| Mode | Reads | Does |
|---|---|---|
| `export` | Export Settings | copies each enabled range to its target |
| `import` | Import Settings | the same, in the other direction |
| `database` | Import Settings + AI Settings | rebuilds `General database` from every enabled source, then copies the non-database rows |

## Layout it expects

Unchanged from the original scripts:

| Col | A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|---|
| Export Settings | name | from URL | from range | to URL | to range | trigger ☑ | manual ☑ | – |
| Import Settings | name | from URL | from range | to URL | to range | – | trigger ☑ | manual ☑ |

The database variant of the Import Settings tab carries three more columns and shifts the
flags again:

| Col | A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|---|
| | name | from URL | from range | to URL | to range | source label | database? ☑ | trigger ☑ | manual ☑ | range length |

Column F is the label written into database column A and matched against it when clearing;
column G decides whether a row feeds the database or is an ordinary copy; column J declares
how many columns the source transaction has, and a value above `transaction_length` stops the
run, as in the original.

The flag columns differ by one between the tabs because the original scripts used
`trigger ? 5 : 6` for export and `trigger ? 6 : 7` for import; `FLAG_COLUMN` in
`src/Settings.js` preserves that.

URLs must contain both the spreadsheet id and `#gid=`, exactly as before. Ranges are plain A1
(`A2:H`, `A1:C10`, `A2`); a `'Tab name'!A2:H` prefix is also accepted and wins over the gid.

Status block: **J2** state, **J3** timestamp, **J4** user — except the database rebuild, which
uses `DATABASE_CONFIG.status_cells`, default **L2/L3/L4**. A rebuild and a plain import share
the same tab and write to different columns, so J2 after a rebuild shows the previous import.

## What lives where

**The library** holds the code and, in its Script Properties, `GCP_SA_KEY` — the whole
service-account JSON. Library Script Properties are shared by every including project, so the
key is set once and rotated once, and no client project ever holds it.

**The stub** in each spreadsheet holds everything about that spreadsheet: the settings tab
names, the status cells, and for a database spreadsheet the `DATABASE_CONFIG` layout. Nothing
about any one spreadsheet lives in the library. There are two stubs and a spreadsheet gets
exactly one:

| Spreadsheet | Stub | What "Run Import" does |
|---|---|---|
| no database tab | `templates/FuelSync.js` | copies the enabled Import Settings rows |
| has one | `templates/FuelSyncDatabase.js` | rebuilds the database tab, then copies the non-database rows |

They declare the same names on purpose, so existing button drawings (`manualImport`,
`manualExport`) and time triggers (`triggerImport`, `triggerExport`) keep working either way —
which also means pasting both into one project fails on duplicate declarations. Each stub also
declares `fuelSyncResume`, the function a scheduled retry calls.

`DEPLOY.md` has the setup.

## The database import

`src/Database.js` rebuilds the whole tab rather than copying a range:

0. resolve where the database lives: **column D of the database rows**. The database tab and
   `AI Settings` sit in that spreadsheet, which is usually not the one holding Import
   Settings. A `#gid=` in the url picks the tab and beats `database_tab`, which is only a
   fallback for a blank column D (meaning "in the settings spreadsheet");
1. read the CF / P&L / BS handbooks from `AI Settings` (`A3:G`, `I3:O`, `Q3:W`), keyed on
   `category ¬ subcategory ¬ sign`;
2. drop the basic filter, read `General database` as **display values**, and keep only rows
   whose source label is not being refreshed — the label list covers every enabled settings
   row, database or not;
3. blank columns 38–42 of those survivors so the month/year formulas are not carried over;
4. re-read each database source, pad or truncate each transaction to `transaction_length`,
   take the sign from the amount, look up the three blocks and append them — a block stays
   empty unless its own date cell is filled;
5. drop rows whose amount is not a non-zero number, grow the tab if needed, drop rows with no
   category or with none of the three dates;
6. clear from A2, write the result, restore the filter.

Details that are easy to get wrong, and are covered by tests:

- **Amounts go through `parseFloat`, not `Number`.** The database is read as display values,
  so an amount can arrive as `1,234.56`; `parseFloat` returns `1` and the original kept the
  row. `Number` would give `NaN` and quietly change which rows survive.
- **The "has a category" filter is on database column 20**, which is transaction field *19* —
  the first key part, not the second.
- **Short AI Settings rows are padded** to four values. The API trims trailing empty cells, so
  a handbook row missing its last cell would otherwise shift every later database column.
- **Existing rows are filtered too.** A legacy row with no category or no date is purged by the
  rebuild even though nothing re-imported it — that is the original behaviour, not a bug.
- **A source wider than `transaction_length` is truncated with a warning**, where the original
  shifted the AI blocks silently.
- **An empty source range is skipped**, where the original threw and lost the other sources.

Database rows are grouped by the tab they feed, so one Import Settings tab can rebuild several
databases — one job each, named `General database #1 (DBONE)` and so on when there is more
than one. Each tab clears only its own rows' labels, plus the enabled non-database rows'
labels, which are cleared from every database as the original did.

## Failure handling

Every exception is classified as **transient** (retry) or **permanent** (stop) in
`src/Errors.js`. The reason code in the error body wins over the status:

| Failure | Verdict |
|---|---|
| 500 / 502 / 503 / 504, `backendError`, `internalError` | transient |
| 429, `rateLimitExceeded`, `userRateLimitExceeded`, per-minute `quotaExceeded` | transient, honours `Retry-After` |
| 403 with `rateLimitExceeded` — a throttle wearing a 403 | transient |
| a thrown `UrlFetchApp.fetch`: DNS, TLS, timeouts, "Address unavailable" | transient |
| 403 `permissionDenied` — file not shared with the service account | permanent |
| 404 — wrong gid, deleted tab | permanent |
| 400 `badRequest` — unparseable range | permanent |
| 401, or the token endpoint rejecting the key | permanent |
| 429 `dailyLimitExceeded`, or UrlFetchApp's own daily quota | permanent, no point retrying today |

Three layers of retry, each only for transient failures:

1. **Per API call** — 5 attempts, 1s → 32s with jitter, capped by a 90s per-call budget.
2. **Per row, inside the execution** — a row that still fails is *deferred*, **and so is every
   row after it**: rows run in settings order and a later one may read what an earlier one
   writes. The deferred rows are tried again after 30s, then 2m, while the execution's time
   budget lasts. A *permanent* failure does not block what follows.
3. **A later execution** — what is still deferred is saved and a one-off trigger runs it after
   15m, then 45m, then 90m, up to 4 attempts. It carries only the rows that did not make it.

Apps Script stops an execution at six minutes, so no new row starts after four. Rows left over
are continued by a trigger a minute later, on the same attempt; every execution starts at
least one row, so a continuation always progresses. A single row that alone takes more than
six minutes cannot be split and fails with Apps Script's own timeout.

One sync runs per spreadsheet at a time. A run that finds another in progress is queued a
minute later rather than dropped.

| State | Cell |
|---|---|
| success | `Import successful`, `Export successful` — the rebuild reports as an import |
| in progress | `In progress: import requested. This cell updates when it finishes.` |
| continuing | `In progress: Payroll, Rates continue at 09/23/2026 12:05:00 - one run can only take a few minutes, no action needed.` |
| failed | `Failed: Payroll: HTTP 403 (permissiondenied): caller does not have permission` |
| failed | `Failed: Payroll did not sync - Google Sheets was temporarily unavailable. Retry 2 of 4 scheduled at 09/23/2026 12:20:00, no action needed. Last error - HTTP 503 ...` |
| failed | `Failed: Google Sheets stayed unavailable after 4 attempts. Not synced: Payroll. Last error - HTTP 503 ...` |

A run that is both — one bad range plus one deferred row — reports `Failed` with the retry
after it, separated by ` | `. A manual run also shows the final state in an alert.

## Behaviour parity

Same as the original scripts, deliberately:

- an empty source range logs and skips the row;
- a **bounded** source range (`A2:E100`) clears that many target rows even when fewer rows of
  data come back, so stale rows below the data are wiped;
- an **open-ended** source range (`A2:E`) clears the target down to the last row of the tab;
- the target tab is grown when the block does not fit, after the last row/column with data;
- values only are cleared — formatting, notes and validation survive;
- writes use `USER_ENTERED`, so formulas and dates behave as they did;
- reads use `UNFORMATTED_VALUE` (what `getValues()` returns), except the database tab, which
  uses `FORMATTED_VALUE` (what `getDisplayValues()` returns).

Deliberate differences:

- **Values are written to an anchor**, sized to the data, rather than to the literal `toRange`.
  The REST API rejects a write wider than a bounded range.
- **Jagged rows are padded** to a rectangle; the range was just cleared, so this overwrites
  nothing.
- **A permanent failure in one row no longer stops the others**, and transient ones are retried.

## Development

```bash
npm install
npm test          # node:test against src/, with the Apps Script services stubbed
npm run push      # clasp push src/ to the library project
npm run deploy    # push and cut a new library version
```

```
src/A1.js         URL + A1 parsing
src/Errors.js     transient vs permanent classification
src/Retry.js      per-call backoff
src/Client.js     service-account token + Sheets API v4 over UrlFetchApp
src/Settings.js   reads the Settings tabs, writes the status block
src/Database.js   the database rebuild + AI Settings handbook
src/Sync.js       the copy, the run loop, the status text
src/Main.js       public entry points: run, resume, dryRun; the retry triggers
templates/        what goes into each spreadsheet's own project
```
