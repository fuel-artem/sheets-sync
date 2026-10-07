import sys, json, math; sys.path.insert(0, __file__.rsplit('/',2)[0])
from sheets_sync.errors import PermanentError
from sheets_sync.database import (js_parse_float, is_nonzero_number, build_handbook,
    build_row, DatabaseConfig, DatabaseJob, DatabaseSource, run_database_job, read_database_settings)

print("== JS parseFloat parity ==")
for v,want in [("1,234.56",1.0),("$1,234",math.nan),("  12.5 ",12.5),("-3",-3.0),("abc",math.nan),(0,0.0),("0",0.0),("1e3",1000.0)]:
    got=js_parse_float(v)
    ok = (math.isnan(got) and math.isnan(want)) or got==want
    print(f"{'PASS' if ok else 'FAIL'} parseFloat({v!r}) = {got}")
    assert ok
print("kept rows:", [v for v in ["1,234.56","0","abc","-5",""] if is_nonzero_number(v)])

cfg = DatabaseConfig()
print("\n== handbook + row building ==")
hb = {
 "cf": build_handbook([["Ops","Payroll","-","cf1","cf2","cf3","cf4"], ["Ops","Payroll","+","p1","p2"]], 4),
 "pl": build_handbook([["Ops","Payroll","-","pl1","pl2","pl3","pl4"]], 4),
 "bs": build_handbook([], 4),
}
print("short AI row padded:", hb["cf"]["Ops\u00acPayroll\u00ac+"])
# transaction: 21 cols, dates at 0,1,2; amount at 7; key at 19,20
tx = ["2026-01-31","2026-01-31","", "x","x","x","x", -500, "", *[""]*10, "Ops","Payroll"]
row = build_row(tx, "Bank", hb, cfg)
print("len:", len(row), "| label:", row[0], "| CF:", row[22:26], "| PL:", row[26:30], "| BS:", row[30:34], "| tail:", row[34:])
assert len(row)==37 and row[22:26]==["cf1","cf2","cf3","cf4"] and row[30:34]==["","","",""]
tx2 = list(tx); tx2[2]=""; tx2[1]=""   # only CF date -> PL block blanked
print("PL blanked when no PL date:", build_row(tx2,"Bank",hb,cfg)[26:30])
tx3 = list(tx); tx3[7]=500             # positive amount -> "+" key -> padded CF entry
print("positive sign picks + entry:", build_row(tx3,"Bank",hb,cfg)[22:26])
print("short transaction padded:", len(build_row(["a","b","c"],"Bank",hb,cfg)))

print("\n== settings read + full rebuild ==")
SRC="https://docs.google.com/spreadsheets/d/SRC/edit#gid=7"
SETTINGS = [
  # A name, B url, C range, D toURL, E toRange, F label, G isDB, H trig, I man, J len
  ["Bank",SRC,"A2:U","","","Bank",True,False,True,21],
  ["Stripe",SRC,"A2:U","","","Stripe",True,False,True,21],
  ["Rates",SRC,"A2:C","https://docs.google.com/spreadsheets/d/DST/edit#gid=9","A2","Rates",False,False,True,""],
  ["Off",SRC,"A2:U","","","Off",True,False,False,21],
]
class Client:
    def __init__(self): self.written=None; self.cleared=[]; self.filters=[]; self.inserted=[]
    policy=None
    def get_values(self, ss, a1, value_render_option="UNFORMATTED_VALUE"):
        if ss == "SRC": return [tx, [*tx[:7], 0, *tx[8:]], [*tx[:19],"",""]]
        if "Import Settings" in a1: return SETTINGS
        if "AI Settings" in a1:
            if a1.endswith("A3:G"): return [["Ops","Payroll","-","cf1","cf2","cf3","cf4"]]
            if a1.endswith("I3:O"): return [["Ops","Payroll","-","pl1","pl2","pl3","pl4"]]
            return []
        if "General database" in a1:   # existing rows, display values
            return [["Bank"]+["old"]*36+["m","y","","",""],   # replaced -> dropped
                    ["Legacy","2026-01-01","","", *["l"]*4, "1,234.56", *[""]*11, "Payroll", *[""]*17],
                    ["Legacy","2026-01-01","","", *["l"]*4, "1,234.56", *[""]*29]]  # no category -> purged
        return []
    def sheet_props(self, ss, gid=None, title=None, refresh=False):
        return {"sheetId": 5, "title": title or ("Source" if ss == "SRC" else "General database"),
                "gridProperties":{"rowCount":10,"columnCount":42}}
    def clear_basic_filter(self, ss, sid): self.filters.append("clear"); return True
    def set_basic_filter(self, ss, grid): self.filters.append("set"); return True
    def insert_rows_before(self, ss, sid, before, n): self.inserted.append((before,n))
    def clear_ranges(self, ss, grids, title): self.cleared.extend(g.to_a1(title) for g in grids)
    def set_values(self, ss, a1, values): self.written=(a1, values)
    def batch_set_values(self, ss, data): self.status={d["range"].split("!")[-1]: d["values"][0][0] for d in data}

c=Client()
jobs = read_database_settings(c, "SS", "manual", cfg)
print("jobs:", [type(j).__name__ for j in jobs])
print("db sources:", [s.name for s in jobs[0].sources], "| labels cleared:", jobs[0].replaced_labels)
print("copy row:", jobs[1].name, jobs[1].to_range)

out = run_database_job(c, jobs[0])
a1, rows = c.written
print("outcome:", out, "| range:", a1)
print("filters:", c.filters, "| inserted:", c.inserted, "| cleared:", c.cleared)
for r in rows: print("  ", r[:2], "...", r[22:30], len(r))
assert rows[0][0]=="Legacy"            # kept, month/year blanked
assert len(rows)==3, len(rows)          # Legacy + one good tx per source

print("\n== round trip through the retry payload ==")
d = jobs[0].as_dict()
back = DatabaseJob.from_dict(json.loads(json.dumps(d)))
print("sources survive:", [s.label for s in back.sources], "| transaction_length:", back.config.transaction_length)

print("\n== column J guard ==")
BAD=[["Bank",SRC,"A2:Z","","","Bank",True,False,True,25]]
c2=Client(); c2.get_values=lambda ss,a1,value_render_option="UNFORMATTED_VALUE": BAD if "Import Settings" in a1 else []
try: read_database_settings(c2,"SS","manual",cfg)
except Exception as e: print(type(e).__name__, "->", e)

print()
print("== status cells travel in the config ==")
from sheets_sync.settings import STATUS_CELLS
import sheets_sync.sync as _S
cfg_j = DatabaseConfig.from_dict({"database_tab":"General database","status_cells":["J2","J3","J4"]})
assert cfg_j.status_cells == ("J2","J3","J4")
assert DatabaseConfig().status_cells == ("L2","L3","L4"), "default must stay L"
assert STATUS_CELLS["database"] == ("L2","L3","L4"), "per-mode default unchanged"

class StatusClient:
    policy=None
    def __init__(self): self.cells={}
    def sheet_props(self, ss, gid=None, title=None):
        raise ValueError("Tab %r not found in spreadsheet SSID" % title)
    def batch_set_values(self, ss, data):
        for d in data: self.cells[d["range"]]=d["values"][0][0]

for cfg, expect in ((DatabaseConfig(), "L2"), (cfg_j, "J2")):
    job=DatabaseJob(settings_spreadsheet_id="SSID",
                    sources=[DatabaseSource("Bank","Bank","https://x/d/SRC/edit#gid=0","A2:U",21)],
                    replaced_labels=["Bank"], config=cfg)
    c=StatusClient()
    rep=_S.run(c,"SSID","database",jobs=[job],user="me@x.com",database_config=cfg,
               attempt=1,retry_window=0,sleep=lambda s: None)
    key="'Import Settings'!"+expect
    assert key in c.cells, "expected the error in %s, got %s" % (expect, list(c.cells))
    assert "not found" in c.cells[key]
    print("  %s -> %s" % (expect, c.cells[key][:58]))
print("PASS status cells honoured")

print()
print("== database rows grouped by target spreadsheet ==")
DB1="https://docs.google.com/spreadsheets/d/DBONE/edit#gid=11"
DB2="https://docs.google.com/spreadsheets/d/DBTWO/edit#gid=22"
MULTI=[
 ["Bank",SRC,"A2:U",DB1,"","Bank",True,False,True,21],
 ["Stripe",SRC,"A2:U",DB1,"","Stripe",True,False,True,21],
 ["Payroll",SRC,"A2:U",DB2,"","Payroll",True,False,True,21],
 ["Rates",SRC,"A2:C","https://docs.google.com/spreadsheets/d/DST/edit#gid=9","A2","Rates",False,False,True,""],
]
class MultiClient:
    policy=None
    def get_values(self, ss, a1, **k): return MULTI
dbjobs=[j for j in read_database_settings(MultiClient(),"SSID","manual",DatabaseConfig())
        if isinstance(j, DatabaseJob)]
assert len(dbjobs)==2, [j.name for j in dbjobs]
assert [s.name for s in dbjobs[0].sources]==["Bank","Stripe"], dbjobs[0].sources
assert [s.name for s in dbjobs[1].sources]==["Payroll"], dbjobs[1].sources
assert "DBONE" in dbjobs[0].database_url and "DBTWO" in dbjobs[1].database_url
# A tab only clears its own labels, plus the enabled copy rows as before.
assert dbjobs[0].replaced_labels==["Bank","Stripe","Rates"], dbjobs[0].replaced_labels
assert dbjobs[1].replaced_labels==["Payroll","Rates"], dbjobs[1].replaced_labels
assert dbjobs[0].name!=dbjobs[1].name, "jobs must be distinguishable in the status cell"
for j in dbjobs:
    rt=DatabaseJob.from_dict(j.as_dict())
    assert rt.database_url==j.database_url and rt.replaced_labels==j.replaced_labels
print("  %s <- %s" % (dbjobs[0].name, [s.name for s in dbjobs[0].sources]))
print("  %s <- %s" % (dbjobs[1].name, [s.name for s in dbjobs[1].sources]))

# One target keeps the plain name and no suffix.
single=[j for j in read_database_settings(Client(),"SSID","manual",DatabaseConfig())
        if isinstance(j, DatabaseJob)]
assert len(single)==1 and single[0].name=="General database", [j.name for j in single]
print("  single target ->", single[0].name, "| url:", repr(single[0].database_url))
print("PASS grouping")

print()
print("== formula columns past the rebuild are never touched; a narrow tab fails first ==")
layout = DatabaseConfig(transaction_length=23, preserved_columns=0)   # A..AJ owned, AK.. formulas
c = Client()
job = read_database_settings(c, "SS", "manual", layout)[0]
run_database_job(c, job)
assert c.cleared == ["'General database'!A5:AJ10"], c.cleared  # only below the rows written
assert c.written[0].endswith("!A2:AJ4"), c.written[0]
narrow = Client()
narrow.sheet_props = lambda ss, gid=None, title=None, refresh=False: {
    "sheetId": 5, "title": title or "General database", "gridProperties": {"rowCount": 10, "columnCount": 30}}
try:
    run_database_job(narrow, job)
    raise AssertionError("a 30-column tab should be refused")
except PermanentError as e:
    assert "has 30 columns but the rebuild needs 36 (A:AJ)" in str(e), e
assert narrow.filters == [] and narrow.cleared == [] and narrow.written is None
print("  owned A:AJ; a 30-column tab is refused before the filter, the clear or the write")
print("PASS layout")

print()
print("== a rebuild that filters out every row is refused before touching the tab ==")
c = Client()
job = read_database_settings(c, "SS", "manual", DatabaseConfig(key_indexes=(21, 22)))[0]
try:
    run_database_job(c, job)
    raise AssertionError("should be refused")
except PermanentError as e:
    assert "every row was filtered out (6 read, 2 kept; dropped 2 with no non-zero amount (column I), " \
           "6 with no category (column W), 0 with none of the dates (columns B, C, D))" in str(e), e
assert c.filters == [] and c.cleared == [] and c.inserted == [] and c.written is None
print("  refused, nothing touched")
print("PASS refuse")
