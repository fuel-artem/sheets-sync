# sheets-sync

Python port of the Fuel Finance Apps Script import/export runner. The Settings tabs stay
exactly where they are; the copying moves from Apps Script to GitHub Actions, and the sheet
button becomes a `workflow_dispatch` call.

```
Sheet button (Apps Script)  ──POST──▶ GitHub Actions ──▶ python -m sheets_sync
                                                              ├─ reads Import/Export Settings
                                                              ├─ copies each enabled row
                                                              └─ writes J2:J4 back
```

## The three modes

| Mode | Reads | Does |
|---|---|---|
| `export` | Export Settings | copies each enabled range to its target |
| `import` | Import Settings | the same, in the other direction |
| `database` | Import Settings + AI Settings | rebuilds `General database` from every enabled source, then copies the non-database rows |

## Layout it expects

Unchanged from the Apps Script version:

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

The flag columns differ by one between the two tabs because the original scripts used
`trigger ? 5 : 6` for export and `trigger ? 6 : 7` for import. That is preserved in
`settings.FLAG_COLUMN`, and `--flag-column` overrides it if you ever align the two.

URLs must contain both the spreadsheet id and `#gid=`, exactly as before. Ranges are plain A1
(`A2:H`, `A1:C10`, `A2`); a `'Tab name'!A2:H` prefix is also accepted and wins over the gid.

The tab names themselves arrive in the dispatch as `settings_tab`, from `SETTINGS_TABS` in
the Apps Script — the only place they are written down. Blank falls back to
`settings.TAB`, so `Import Settings` / `Export Settings` still work unchanged.

Status block per tab: **J2** error, **J3** timestamp, **J4** user — except the database
variant, which uses **L2/L3/L4**, matching its Apps Script.

The database variant's cells are `status_cells` in `DatabaseConfig`, so they travel in the
dispatch payload with the rest of the layout; `DATABASE_CONFIG.status_cells` in the Apps
Script is the single place that sets them, and `--status-cells J2,J3,J4` overrides them for
any mode. Worth knowing that a database run and a plain import share the *same tab* and
write to *different columns*, so checking J2 after a database run shows the previous
import's status, not this run's.

## Setup

**1. Service account**

Create one in Google Cloud, enable the Sheets API, download the JSON key, and share every
source and target spreadsheet with the service account email (Editor on targets, Viewer is
enough on sources).

**2. Repository secrets**

Credentials only. No repository variable holds a spreadsheet id, a timezone, or anything else
that says *what* to sync — all of that arrives in the dispatch payload from Apps Script, so a
run that nobody started has nothing to act on.

| Kind | Name | Value |
|---|---|---|
| Secret | `GCP_SA_KEY` | the whole service-account JSON |
| Secret | `RETRY_DISPATCH_TOKEN` | PAT used to schedule a retry (see below); optional |
| Variable | `MAX_WAIT_MINUTES` | optional cap on how long a retry run may sleep, default 120 |

`RETRY_DISPATCH_TOKEN` is needed because events created with the built-in `GITHUB_TOKEN` do
not start new workflow runs. The same fine-grained PAT the sheet uses works here.

**3. The button**

Replace the old `Import.gs` / `Export.gs` with **one** of `apps_script/GithubTrigger.gs`
(plain import/export) or `apps_script/GithubTriggerDatabase.gs` (where "Run Import" is the
database rebuild). Never both in one project: they declare the same names, which is what
keeps the button drawings wired, and Apps Script rejects the duplicates. Set
`SUPPORT_CONTACT` at the top of the file: it is named in every alert a button can raise,
since the people clicking those buttons cannot open a private repository. Keep the
existing drawings — the entry points are called `manualImport` / `manualExport` in both.
Then set `GITHUB_TOKEN` in Script Properties: a fine-grained PAT scoped to this repo with
**Actions: read and write**. Adjust `GITHUB_OWNER`, `GITHUB_REPO`, `GIT_REF` at the top of
the file.

**4. The schedule**

Keep the Apps Script time-driven trigger, pointed at `triggerImport` / `triggerExport`. It
dispatches with `execution: trigger`, which is what selects the trigger checkbox column. The
workflow has no `cron:` on purpose — a scheduled GitHub run would need a spreadsheet id stored
on the GitHub side, which is exactly what we are avoiding.

## Running it locally

```bash
pip install -r requirements.txt
export GOOGLE_APPLICATION_CREDENTIALS=./sa.json

python -m sheets_sync --mode import --execution manual \
  --settings-spreadsheet-id 1AbC... --dry-run     # list the rows that would run

python -m sheets_sync --mode export --execution trigger \
  --settings-spreadsheet-id 1AbC... --user you@fuel.finance
```

`--settings-spreadsheet-id` is required; there is no environment default worth relying on.

Useful flags: `--no-status` (leave J2:J4 alone), `--jobs-json` (run an inline job list instead
of the tab), `--run-url-cell J5` (write the Actions run link next to the status block),
`--flag-column N`, `--settings-tab`, `--retry-window-minutes`, `--max-attempts`,
`--call-attempts`, `-v`.

Exit codes: `0` clean or retry scheduled, `1` permanent failure, `2` bad usage,
`75` transient but out of attempts.

## The database import

`database.py` rebuilds the whole tab rather than copying a range:

0. resolve where the database lives: **column D of the database rows**. The database tab
   and `AI Settings` sit in that spreadsheet, which is usually not the one holding Import
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

The layout is a `DatabaseConfig`, sent as `database_config` in the dispatch payload — the Apps
Script holds it in one object at the top of `GithubTriggerDatabase.gs`, where the original kept
`const databaseLength = 21`. Nothing about the spreadsheet lives on the GitHub side.

Details that are easy to get wrong, and are covered by tests:

- **`js_parse_float` mimics JavaScript.** The database is read as display values, so an amount
  can arrive as `1,234.56`. JS `parseFloat` returns `1` and the original kept the row; Python's
  `float()` would raise and quietly change which rows survive.
- **The "has a category" filter is on database column 20**, which is transaction field *19* —
  the first key part, not the second.
- **Short AI Settings rows are padded** to four values. The API trims trailing empty cells, and
  the original spread whatever it got, so a handbook row missing its last cell shifted every
  later database column by one.
- **Existing rows are filtered too.** A legacy row with no category or no date is purged by the
  rebuild even though nothing re-imported it — that is the original behaviour, not a bug.
- **A source wider than `transaction_length` is truncated with a warning.** The original
  trusted column J and would have shifted the AI blocks silently.
- **An empty source range is skipped**, where the original threw on `undefined.forEach` and
  lost the rest of the sources.

Database rows are grouped by the tab they feed, so one Import Settings tab can rebuild
several databases in several spreadsheets — one job each, named `General database #1 (DBONE)`
and so on when there is more than one, so the status cell can tell them apart. Each tab
clears only its own rows' labels, plus the enabled non-database rows' labels, which are
cleared from every database as the original did. Leave column F empty on copy rows unless
you mean that.

A rebuild is one unit of work for retry purposes: it either completes or is deferred whole,
and it round-trips through the retry payload so a later attempt resumes it without
re-reading the settings tab.

## Failure handling

Every exception is classified as **transient** (retry) or **permanent** (stop) in
`errors.py`. The status code alone is not enough, so the reason code in the error body wins
when it is present:

| Failure | Verdict |
|---|---|
| 500 / 502 / 503 / 504, `backendError`, `internalError` | transient |
| 429, `rateLimitExceeded`, `userRateLimitExceeded`, per-minute `quotaExceeded` | transient, honours `Retry-After` |
| 403 with `rateLimitExceeded` — a throttle wearing a 403 | transient |
| DNS, TLS, timeouts, connection resets, token-refresh transport errors | transient |
| 403 `permissionDenied` — file not shared with the service account | permanent |
| 404 — wrong gid, deleted tab | permanent |
| 400 `badRequest` — unparseable range | permanent |
| 401 / `invalid_grant` — bad or revoked key | permanent |
| 429 `dailyLimitExceeded` — resets at midnight PT | permanent, no point retrying today |

Two request limits come from the Sheets [troubleshooting guide](https://developers.google.com/workspace/sheets/api/troubleshoot-api-errors),
as ways to avoid earning a 503 in the first place: at most **one request per second per
spreadsheet** (the client paces itself), and **payloads under 2 MB** (writes are split into
row chunks of at most a million JSON characters, which stays under 2 MB even for
all-Cyrillic text). A split write is not atomic, but a write never was: the range is cleared
first either way, and a retry redoes the whole row.

Three layers of retry, each only for transient failures:

1. **Per API call** — up to 7 attempts on Google's formula, `min(2^n + up to 1s, 32s)`, capped
   by a 90s per-call budget. Six waits add up to just over a minute, which is what a 429 on
   the per-minute quota needs. If the server asks for a longer `Retry-After` than the budget
   allows, the call gives up early and lets layer 2 handle it.
2. **Per row, inside the run** — a row that still fails is *deferred*, not fatal, **and so
   is every row after it**. Rows run in settings order and a later one may read what an
   earlier one writes, so running the rest now would use stale input and nothing would
   come back to redo them. The run re-attempts the deferred rows after 30s, 2m, 5m, 10m,
   until `--retry-window-minutes` (default 10) is spent; once the blocker clears, the rows
   behind it run in the same pass. Rows that already succeeded are never touched again.
   This applies to every mode, not only the database rebuild. A *permanent* failure does
   not block what follows: it will not fix itself, so holding the run behind it would turn
   one broken row into a dead run.
3. **A later run** — anything still deferred is written to `retry.json` and the workflow
   dispatches itself again after 15m, then 45m, then 90m, up to `--max-attempts` (default 4).
   The new dispatch carries the same parameters plus only the rows that failed, so a partial
   sync resumes rather than repeating.

The status cell says whether the last run worked, so the state is readable without parsing
what follows. A clean run says only that, with no numbers: one "row" means a settings row
for a copy but the whole rebuilt tab for the database import, so a count would change
meaning by mode. Technical detail appears only when something went wrong:

| State | Cell |
|---|---|
| success | `Import successful`, `Export successful` - the database rebuild reports as an import too; the cell it lands in tells them apart |
| in progress | `In progress: import requested. This cell updates when it finishes.` - written by the sheet button, and the only place this state is used |
| failed | `Failed: Payroll: HTTP 403 (permissiondenied): caller does not have permission` |
| failed | `Failed: Payroll did not sync - Google Sheets was temporarily unavailable. Retry 2 of 4 scheduled at 08/24/2026 18:05:34, no action needed. Last error - HTTP 503 ...` |
| failed | `Failed: Google Sheets stayed unavailable after 4 attempts. Not synced: Payroll. Last error - HTTP 503 ...` |

A deferred row is a failure with a retry attached, not a third state - nothing synced, and
reporting progress while rows sit unwritten would be a lie. `In progress` therefore means
only that a run is under way: the Apps Script writes it when it dispatches, and the
workflow overwrites it with `Success` or `Failed`. A run that is both - one bad range plus
one deferred row - reports `Failed` with the retry after it, separated by ` | `.

Column 3 of the block always carries a timestamp, in both writers and on failures too, so a
stale status is never mistaken for a fresh one.

A permanent failure in one row no longer aborts the rest of the run (the Apps Script version
stopped at the first exception); the remaining rows still sync and every failure is listed in
J2 and in the run summary.

Waiting for a scheduled retry burns runner minutes, since the retry run sleeps until
`not_before`. For a multi-hour Google outage, `MAX_WAIT_MINUTES` caps each wait, and after
`--max-attempts` the sheet is told plainly rather than retrying forever.

## Behaviour parity

Same as the Apps Script, deliberately:

- an empty source range logs and skips the row instead of failing the run;
- a **bounded** source range (`A2:E100`) clears that many target rows even when fewer rows of
  data come back, so stale rows below the data are wiped;
- an **open-ended** source range (`A2:E`) clears the target down to the last row of the tab;
- the target tab is grown when the block does not fit, with rows and columns appended at
  the end (`appendDimension`). The original inserted after the last row with data, but
  finding it means reading the whole tab, which on a large tab hung until the API's
  180-second limit and came back 503. Values land the same; appended rows are unformatted;
- values only are cleared — formatting, notes and validation survive;
- writes use `USER_ENTERED`, so formulas and dates behave as they did;
- one failing row aborts the run and the exception lands in J2, as in the original `catch`.

Deliberate differences:

- **Values are written to an anchor**, sized to the data, rather than to the literal `toRange`
  string. The Sheets REST API rejects a write whose data is wider than a bounded range; this
  keeps the Apps Script `setValues(anchor)` semantics. A warning is logged if the data is
  wider than an explicit target range.
- **Jagged rows are padded** with empty strings to a rectangle. The range was just cleared, so
  the padding overwrites nothing.
- **Reads use `UNFORMATTED_VALUE`**, which is what Apps Script `getValues()` returns. If any
  copied column relies on display formatting (currency strings, custom date formats copied as
  text), switch `valueRenderOption` in `client.get_values` to `FORMATTED_VALUE`.
- **Transient failures are retried and deferred** rather than aborting the run, and a
  permanent failure in one row no longer stops the others. See *Failure handling*.
- `SpreadsheetApp.getUi().alert(e)` has no equivalent; failures surface as a non-zero exit
  code, the run summary, and the J2 cell.

## Files

```
sheets_sync/a1.py        URL + A1 parsing (replaces the FuelFinanceLibraryv2 helpers)
sheets_sync/errors.py    transient vs permanent classification
sheets_sync/retry.py     backoff policy
sheets_sync/client.py    Sheets API v4 wrapper, retries, metadata cache
sheets_sync/settings.py  reads the Settings tabs, writes J2:J4
sheets_sync/sync.py      the port of insteadImportOptional / insteadExportOptional
sheets_sync/database.py  the database rebuild + AI Settings handbook
sheets_sync/__main__.py  CLI
.github/workflows/sheets-sync.yml
apps_script/GithubTrigger.gs          the sheet button: import / export
apps_script/GithubTriggerDatabase.gs  the same, where import = the database rebuild
```

## Apps Script only: `library/`

The same sync with no GitHub Actions: an Apps Script library that talks to the Sheets REST
API through `UrlFetchApp`, not `SpreadsheetApp` — unformatted reads, sized writes and real
status codes, which the transient/permanent split depends on. Behaviour, layouts, status text
and the database rebuild are ports of the Python above.

```
library/*.gs, appsscript.json   the library (public: run, resume, plan, setValues, getValues)
library/bound/Sync.gs           the sheet button: import / export
library/bound/SyncDatabase.gs   the same, where import = the database rebuild
library/bound/appsscript.json   manifest for the spreadsheet's own project
library/test/run.js             node library/test/run.js - no network, no credentials
```

**`setValues` / `getValues`** are the same machinery for scripts that compute their own data —
REST, retries, pacing, chunked writes and tab growth, no settings tab. A location is
`{ url, range }`, as in a settings row:

```js
FuelImportLibrary.setValues({ url: URL, range: 'A2:E' }, rows);                 // one
FuelImportLibrary.setValues([locationA, locationB], [rowsA, rowsB]);             // several
const rows = FuelImportLibrary.getValues({ url: URL, range: "'Data'!A2:E" });
```

The range decides what `setValues` replaces: an anchor (`A2`) only writes; an explicit range
(`A2:E100`, `A2:E`) is cleared first, so rows left from a longer write disappear. Every
location is attempted and one error at the end carries `failures: [{ location, message,
transient }]`. `getValues` pads a bounded range back to its size — the API trims trailing
blanks — and returns dates as the text the cell shows, which native `getValues()` does not;
`getValues(location, { serialDates: true })` gives serial numbers instead.
The calling script needs the `spreadsheets` and `script.external_request` scopes.

**Setup.** Create a standalone Apps Script project from `library/`, *Deploy → New deployment
→ Library*, and copy its script id into `LIBRARY_SCRIPT_ID` in `bound/appsscript.json`. In
each spreadsheet's project paste that manifest and **one** of the two bound files (they declare
the same names). Point the time-driven triggers at `triggerImport` / `triggerExport`. The
manifest enables the Sheets advanced service only so the API is switched on for the project;
the code does not use it.

**What differs from the Python version:**

- **It runs as whoever clicked, or whoever installed the trigger.** No service account, on
  purpose: one sits outside the Workspace domain, so domain link sharing does not reach it
  and every file would need an explicit share. That person needs access to every source and
  target spreadsheet, and gets their own per-minute API quota.
- **A trigger belongs to one person.** The scheduled `triggerImport` / `triggerExport` run as
  whoever installed them, and so do the retries they schedule; a retry after a manual click
  runs as the person who clicked. If that person loses access to a file, their runs fail on
  it. If their account is suspended or deleted, Google stops their triggers without a word -
  install the schedule from an account that will outlive any one person. Changing the bound
  manifest's scopes stops existing triggers too, until their owner runs any function by hand
  once to grant the new ones.
- **Retries are triggers.** Layer 3 is a one-off time-driven trigger (15 / 45 / 90 min, 4
  attempts) calling `sheetsSyncResume` in the bound script, with its state in that project's
  script properties. It resumes only the rows left, found again by a hash of their settings
  row, so nothing is carried in a 9 KB property that can grow with the tab.
- **The execution limit.** `EXECUTION_LIMIT_MS_` in `Main.gs` is 30 minutes, what this
  Workspace account allows; Google's quota page says six for every account, so lower it if
  executions start dying. Time counts from when the *execution* started, not the call:
  `STARTED_AT` at the top of the bound script is passed as `host.startedAt`, and another
  script passes its own as `{ startedAt }` to `setValues` / `getValues` (without it, the
  library's load time). No job starts with under three minutes left and no backoff sleeps
  into the last one; what is left continues a minute later and the cell reads
  `In progress: … continuing at …`. A single job that outlasts the limit is killed by Apps
  Script outright and leaves the cell at `In progress`.
- **Permanent failures are carried** into every later attempt of the same run, so a retry
  that succeeds does not overwrite an earlier `Failed:` with `Import successful`.
- **One run per spreadsheet at a time**, under the bound project's script lock. A second
  click is refused with a toast; a retry that collides moves back a minute.
- The library hands every trigger, property and lock call to the bound script's own
  services (`host_()`): a library's own are shared by every spreadsheet that uses it.
- Before the first real run, `previewImport` / `previewExport` from the editor list the rows
  that would sync and write nothing.
