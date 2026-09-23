# Fuel Sync

Apps Script library port of three Fuel Finance Apps Scripts (Import, Export, Database import)
that moved ranges between spreadsheets. It ran on GitHub Actions for a while; that path and
its Python are gone. `README.md` has the behaviour tables, `DEPLOY.md` the setup — this file
is the part that is not obvious from reading the code.

## Rules that shaped the design

**Service account and the REST API, never `SpreadsheetApp` for the data.** `SpreadsheetApp`
is far slower on large ranges and runs as whoever clicked. It is used only for the container's
id, timezone, toasts and alerts. Do not "simplify" a read or write onto it.

**Nothing about one spreadsheet lives in the library.** Tab names, status cells and the
database layout come from the stub in `templates/`, passed to `FuelSync.run`, and a retry
carries them in its saved payload. The library's Script Properties hold only the key and
pending retries.

**Library scoping decides where state goes.** Script Properties, Cache and Lock are shared by
every including project (hence retry payloads keyed by trigger uid; and the document lock may
serialise all spreadsheets rather than one - harmless, a busy run is queued a minute, but
unverified); `ScriptApp` and
`getActive*` act on the including project (hence a retry trigger calls `fuelSyncResume`, which the
stub must declare). Public API = top-level functions without a trailing `_`; everything else
must keep the underscore.

**Transient and permanent failures are never treated alike.** `Errors.js` classifies every
exception; only `TransientError` is retried, at three layers (per call, per row within the
execution, per run via a one-off trigger). The reason code in the body wins over the HTTP
status — a 403 can be a throttle or a permissions failure, and a 429 `dailyLimitExceeded`
will not clear before midnight PT. Adding a status to a retry set without checking the reason
code re-breaks this.

**The six-minute limit.** No new row starts after `RUN_BUDGET_MS`; the rest continue by
trigger on the same attempt. Time-outs do not cost an attempt, transient failures do — only
the last pass decides which.

## Pitfalls that already bit, or nearly did

- **`parseFloat` is deliberate** for amounts read as display values: `1,234.56` → `1`, the row
  survives. `Number` gives NaN and silently changes which rows survive.
- **The database "has a category" filter is on database column 20 = transaction field 19**,
  the first key part, not the second.
- **AI Settings payloads are padded to four values.** The API trims trailing empty cells.
- **Existing database rows go through the same filters as new ones.** A legacy row with no
  category or no date is purged. Original behaviour — do not "fix" it without asking.
- **Writes are anchored and sized to the data**, not to the literal `toRange`.
- **Flag columns differ per mode and are not a typo**: export 5/6, import 6/7, database 7/8.
  Status cells: J2:J4, except the database variant at `status_cells`, default L2:L4.
- **Status writes are best-effort**, the "In progress" one included: an outage there must not
  abort the run before it can schedule its retry. A test caught exactly that.

## Verifying a change

```bash
npm test
```

`test/harness.js` loads `src/*.js` into one context as Apps Script does and stubs the
services; `main.test.js` drives `run` / `resume` through a fake Sheets REST API. Values made
inside the context have their own `Array`, so compare with `same()`, not `deepStrictEqual`.

Against a real spreadsheet, start with `FuelSync.dryRun(...)`, which writes nothing.

## Open items

1. **Never run in Apps Script.** The tests stub every service. The first real run should be a
   dry run, then a copy of a spreadsheet.
2. **The rebuild has never completed** against a real spreadsheet. The clear covers `A2` to the
   last column; if columns 38–42 hold live formulas, that clear wipes them. Check on a copy.
