# Deploying

The repo is committed locally but has never been pushed. Everything below runs on your
machine, with your credentials.

## 1. Create the repo and push

```bash
# already done: the repo lives at github.com/fuel-artem/sheets-sync (private)
gh repo create fuel-artem/sheets-sync --private --source=. --push

# or, without gh
git remote add origin git@github.com:fuel-artem/sheets-sync.git
git push -u origin main
```

`workflow_dispatch` only appears once the workflow file is on the default branch, so push to
`main` first.

## 2. Secrets

Settings → Secrets and variables → Actions:

| Kind | Name | Value |
|---|---|---|
| Secret | `GCP_SA_KEY` | the whole service-account JSON |
| Secret | `RETRY_DISPATCH_TOKEN` | fine-grained PAT, this repo, **Actions: read and write** |
| Variable | `MAX_WAIT_MINUTES` | optional, caps how long a retry run sleeps (default 120) |

`RETRY_DISPATCH_TOKEN` is separate from the built-in `GITHUB_TOKEN` because events created
with the built-in token do not start new workflow runs — without it, a deferred sync never
gets its retry.

No variable holds a spreadsheet id. That is deliberate; see `CLAUDE.md`.

## 3. Google access

Share every source and target spreadsheet with the service account email — Editor on targets,
Viewer is enough on sources. This is the usual cause of a first-run `permissionDenied`.

## 4. The sheet

Copy `apps_script/GithubTrigger.gs` into the spreadsheet's Apps Script project, replacing the
old `Import.gs` / `Export.gs`. The entry points are still named `manualImport`,
`manualExport`, so existing button drawings stay wired; `manualDatabaseImport` is new.

At the top of the file set `GITHUB_OWNER`, `GITHUB_REPO`, `GIT_REF`, and — for a
database-import spreadsheet — the `DATABASE_CONFIG` object, which is where the old
`const databaseLength = 21` now lives.

Then Project Settings → Script Properties → `GITHUB_TOKEN`: a fine-grained PAT with
**Actions: read and write** on the repo.

Finally, delete the old Apps Script time-driven triggers and point new ones at
`triggerImport` / `triggerExport` / `triggerDatabaseImport` so the schedule and the button
take the same path.

## 5. First run, safely

Run it from the Actions tab, not the sheet, with **`dry_run: true`** and a real
`settings_spreadsheet_id`. It lists the rows it would sync and writes nothing — no clear, no
status block. Read the run summary, then repeat with `dry_run: false` on a **copy** of the
spreadsheet before pointing it at the live one.

For the database mode in particular, confirm on that copy that columns 38–42 of
`General database` come back the way you expect: the rebuild clears from `A2` to the last
column, matching the original script.
