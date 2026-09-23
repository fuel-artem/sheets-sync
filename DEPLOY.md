# Deploying

## 1. The library project (once)

```bash
npm install
npx clasp login
npx clasp create --type standalone --title "Fuel Sync" --rootDir src
npm run deploy     # pushes src/ and cuts version 1
```

`clasp create` writes `.clasp.json` (git-ignored; `.clasp.json.example` shows its shape).
Keep the project in the Fuel account, not a personal one: including projects need at least
view access to it, so share it with whoever maintains the client spreadsheets.

Then in the library project: **Project Settings → Script Properties → `GCP_SA_KEY`**, the whole
service-account JSON. Library Script Properties are shared by every including project, so this
is the only place the key is set. The Sheets API must be enabled on the key's Cloud project.

Copy the **Script ID** from Project Settings; each spreadsheet needs it.

## 2. Google access

Share every source and target spreadsheet with the service account email — Editor on targets,
Viewer is enough on sources — and Editor on each settings spreadsheet, since the status block
is written through the API too. This is the usual cause of a first-run `permissionDenied`.

## 3. Each spreadsheet

In the spreadsheet's Apps Script project:

1. Delete the old `Import.gs` / `Export.gs`, or `GithubTrigger.gs` / `GithubTriggerDatabase.gs`.
2. Add **one** stub: `templates/FuelSync.js`, or `templates/FuelSyncDatabase.js` for a
   spreadsheet whose import is the database rebuild. Set the tab names and, for the database
   stub, `DATABASE_CONFIG` at the top.
3. Add the library: **Libraries → +**, the Script ID, identifier `FuelSync`, the latest version.
   Or merge `dependencies` and `oauthScopes` from `templates/appsscript.json` into the
   project's manifest.
4. Remove `GITHUB_TOKEN` from Script Properties; nothing reads it any more.
5. Run `manualImport` once from the editor to grant the permissions.

Existing button drawings keep working: the stubs keep `manualImport` / `manualExport`.
Existing time-driven triggers keep working if they point at `triggerImport` / `triggerExport`.

## 4. First run, safely

From the editor, run `fuelSyncDryRun`. It logs the rows an import would sync and writes
nothing. Then run the real thing on a **copy** of the spreadsheet before the live one.

For the database mode in particular, confirm on that copy that columns 38–42 of
`General database` come back the way you expect: the rebuild clears from `A2` to the last
column, matching the original script. **The rebuild has never completed against a real
spreadsheet.**

## Releasing a change

`npm test`, then `npm run deploy`. Including projects stay on the version they chose until it
is bumped in their Libraries panel, so a new version reaches no spreadsheet by itself.
