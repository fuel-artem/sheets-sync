import sys; sys.path.insert(0, __file__.rsplit('/',2)[0])
from sheets_sync.sync import run_job
from sheets_sync.settings import SyncJob

class Fake:
    def __init__(self, rows=200, cols=10, src=None):
        self.calls=[]; self.rows=rows; self.cols=cols
        self.src = src or [[f"r{r}c{c}" for c in range(5)] for r in range(12)]
    def sheet_props(self, ss, gid=None, title=None, refresh=False):
        return {"sheetId": gid or 0, "title": "Data",
                "gridProperties": {"rowCount": self.rows, "columnCount": self.cols}}
    def get_values(self, ss, a1):
        self.calls.append(("get", ss, a1)); return self.src
    def append_rows(self, ss, sid, n): self.calls.append(("appendRows", n)); self.rows += n
    def append_columns(self, ss, sid, n): self.calls.append(("appendCols", n)); self.cols += n
    def clear_range(self, ss, grid, title): self.calls.append(("clear", grid.to_a1(title)))
    def set_values(self, ss, a1, values): self.calls.append(("set", a1, len(values), len(values[0])))

SRC="https://docs.google.com/spreadsheets/d/SRCID/edit#gid=11"
DST="https://docs.google.com/spreadsheets/d/DSTID/edit#gid=22"

print("-- open-ended source, fits")
f=Fake(); print(run_job(f, SyncJob("t1",SRC,"A2:E",DST,"A2")), *f.calls, sep="\n  ")

print("-- bounded source A2:E100 (clears 99 rows even with 12 rows of data)")
f=Fake(); print(run_job(f, SyncJob("t2",SRC,"A2:E100",DST,"B3")), *f.calls, sep="\n  ")

print("-- needs more rows/cols")
f=Fake(rows=20, cols=4, src=[[c for c in range(6)] for _ in range(40)])
print(run_job(f, SyncJob("t3",SRC,"A1:F40",DST,"A5")), *f.calls, sep="\n  ")

print("-- empty source")
f=Fake(src=None); f.src=None; print(run_job(f, SyncJob("t4",SRC,"A2:E",DST,"A2")))

print("-- jagged source")
f=Fake(src=[[1,2,3],[1],[1,2]]); print(run_job(f, SyncJob("t5",SRC,"A2:C",DST,"A2")), *f.calls, sep="\n  ")

print()
print("== the settings tab name comes from the dispatch ==")
import sheets_sync.sync as _S
from sheets_sync.settings import read_jobs, write_status, TAB
from sheets_sync.database import read_database_settings, DatabaseConfig
ROW=[["Bank","https://docs.google.com/spreadsheets/d/S/edit#gid=0","A2:H",
      "https://docs.google.com/spreadsheets/d/D/edit#gid=1","A2","","",True,True,21]]
class TabClient:
    policy=None
    def __init__(self): self.reads=[]; self.writes=[]
    def get_values(self, ss, a1, **k): self.reads.append(a1); return ROW
    def batch_set_values(self, ss, data): self.writes += [d["range"] for d in data]

# Blank falls back to the built-in name, so an old dispatch keeps working.
c=TabClient(); read_jobs(c,"SSID","import","manual")
assert c.reads[0]=="'Import Settings'!A2:Z", c.reads[0]
c=TabClient(); read_jobs(c,"SSID","import","manual",None,tab="Renamed")
assert c.reads[0]=="'Renamed'!A2:Z", c.reads[0]
c=TabClient(); read_database_settings(c,"SSID","manual",DatabaseConfig(),tab="Renamed")
assert c.reads[0]=="'Renamed'!A2:Z", c.reads[0]
c=TabClient(); write_status(c,"SSID","import",None,"me","ok",tab="Renamed")
assert all(w.startswith("'Renamed'!") for w in c.writes), c.writes
print("  read/write both honour it; blank falls back to", repr(TAB["import"]))
print("PASS settings tab")

print()
print("== big writes are split under the payload limit ==")
from sheets_sync.a1 import GridRange as _Grid
from sheets_sync import client as _client_mod
class _Writer:
    def __init__(self): self.writes = []
    def set_values(self, ss, a1, values): self.writes.append((a1, len(values)))
w = _Writer()
row = ["x" * 400_000]
_client_mod.write_grid(w, "SS", _Grid(0, 1, 6, 0, 1), "Data", [row] * 5)
assert w.writes == [("'Data'!A2:A3", 2), ("'Data'!A4:A5", 2), ("'Data'!A6:A6", 1)], w.writes
w = _Writer(); _client_mod.write_grid(w, "SS", _Grid(0, 1, 2, 0, 1), "Data", [["x" * 3_000_000]])
assert w.writes == [("'Data'!A2:A2", 1)], w.writes  # one oversized row still goes, alone
print("  ", w.writes)
print("PASS chunking")
