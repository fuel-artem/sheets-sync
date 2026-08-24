import sys, json, math; sys.path.insert(0, __file__.rsplit('/',2)[0])
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
        if "General Database" in a1:   # existing rows, display values
            return [["Bank"]+["old"]*36+["m","y","","",""],   # replaced -> dropped
                    ["Legacy","2026-01-01","","", *["l"]*4, "1,234.56", *[""]*11, "Payroll", *[""]*17],
                    ["Legacy","2026-01-01","","", *["l"]*4, "1,234.56", *[""]*29]]  # no category -> purged
        return []
    def sheet_props(self, ss, gid=None, title=None, refresh=False):
        return {"sheetId": 5, "title": title or ("Source" if ss == "SRC" else "General Database"),
                "gridProperties":{"rowCount":10,"columnCount":42}}
    def clear_basic_filter(self, ss, sid): self.filters.append("clear"); return True
    def set_basic_filter(self, ss, grid): self.filters.append("set"); return True
    def insert_rows_before(self, ss, sid, before, n): self.inserted.append((before,n))
    def clear_range(self, ss, grid, title): self.cleared.append(grid.to_a1(title))
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
