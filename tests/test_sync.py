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
    def data_extent(self, ss, title): return (150, 5)
    def insert_rows_after(self, ss, sid, after, n): self.calls.append(("insRows", after, n)); self.rows += n
    def insert_columns_after(self, ss, sid, after, n): self.calls.append(("insCols", after, n)); self.cols += n
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
