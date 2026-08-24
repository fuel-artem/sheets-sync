# sheets-sync

Python port of three Fuel Finance Google Apps Scripts (Import, Export, Database import) that
moved ranges between spreadsheets. It now runs on GitHub Actions; the sheet button only
dispatches the workflow. `README.md` has the setup and the behaviour tables — this file is the
part that is not obvious from reading the code.

## Two rules that shaped the design

**Nothing about *what* to sync lives on the GitHub side.** No repository variable holds a
spreadsheet id, timezone, or database layout, and the workflow has no `cron:`. Every parameter
arrives in the `workflow_dispatch` payload from Apps Script, and a retry reconstructs its
inputs from the payload it received. If you are tempted to add `vars.SOMETHING` to avoid
passing a value, that is the thing this design is avoiding. Scheduling therefore stays in the
Apps Script time-driven trigger (`triggerImport` / `triggerExport` / `triggerDatabaseImport`).

**Transient and permanent failures are never treated alike.** `errors.py` classifies every
exception; only `TransientError` is retried, at three layers (per call in `retry.py`, per row
in `sync.run`, per run via the workflow re-dispatch). The reason code in the error body wins
over the HTTP status — a 403 can be a throttle (`rateLimitExceeded`, retry) or a permissions
failure (`permissionDenied`, stop), and a 429 `dailyLimitExceeded` will not clear before
midnight PT so it is permanent. Adding a status code to a retry set without checking the
reason code re-breaks this.

## Pitfalls that already bit, or nearly did

- **`js_parse_float` is deliberate.** The database tab is read as display values, so an amount
  arrives as `1,234.56`. JS `parseFloat` returns `1` and the original kept the row; Python's
  `float()` raises. Do not "simplify" it — it silently changes which rows survive.
- **The database "has a category" filter is on database column 20 = transaction field 19**,
  the first key part, not the second. Got this wrong once; `test_db.py` catches it.
- **AI Settings payloads are padded to four values.** The API trims trailing empty cells; the
  original spread whatever it got, so a short handbook row shifted every later column by one.
- **Existing database rows go through the same filters as new ones.** A legacy row with no
  category or no date is purged by a rebuild even though nothing re-imported it. That is the
  original behaviour, not a bug — do not "fix" it without asking.
- **Writes are anchored and sized to the data**, not written to the literal `toRange`. The
  REST API rejects a write wider than a bounded range, unlike Apps Script `setValues`.
- **Reads use `UNFORMATTED_VALUE`** (matching `getValues()`), except the database tab which
  uses `FORMATTED_VALUE` (matching `getDisplayValues()`).
- **Flag columns differ per mode and are not a typo**: export 5/6, import 6/7, database 7/8.
  Status cells likewise: J2:J4, except the database variant at L2:L4.

## Verifying a change without a spreadsheet

The tests stub the client, so they need no credentials and no network:

```bash
python -m compileall -q sheets_sync
python tests/test_sync.py    # copy semantics: bounded/open ranges, jagged rows, growth
python tests/test_retry.py   # classification, backoff, deferral, status text
python tests/test_db.py      # parseFloat parity, handbook, rebuild, column J guard
```

They are plain scripts with asserts, not pytest yet; converting them is worth doing early.

Against a real spreadsheet, always start with `--dry-run` (or `dry_run: true` on the
workflow): it lists the rows that would run and writes nothing.

## Open items

1. **Deploy.** The repo has one local commit and has never been pushed — see `DEPLOY.md`.
2. **Convert `tests/` to pytest.** They are assert-and-print scripts today.
3. **Unverified against production data.** No run has touched a real spreadsheet yet. The
   database clear covers `A2` to the last column; if columns 38–42 hold live formulas rather
   than values written elsewhere, that clear wipes them. Check on a copy first.
4. **Retry waits burn runner minutes** (a retry run sleeps until `not_before`). If outages
   turn out to be frequent, the alternative is a queue branch plus a sweeper cron.
