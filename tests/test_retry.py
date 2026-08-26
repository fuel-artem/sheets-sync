import sys, json; sys.path.insert(0, __file__.rsplit('/',2)[0])
from googleapiclient.errors import HttpError
from sheets_sync.errors import classify, TransientError, PermanentError
from sheets_sync.retry import RetryPolicy, call_with_retry
from sheets_sync.sync import run
from sheets_sync.settings import SyncJob

class Resp(dict):
    def __init__(self, status, headers=None):
        super().__init__(headers or {}); self.status=status; self.reason=str(status)

def http(status, reason=None, canonical=None, msg="boom", retry_after=None):
    body={"error":{"code":status,"message":msg}}
    if reason: body["error"]["errors"]=[{"reason":reason,"message":msg}]
    if canonical: body["error"]["status"]=canonical
    headers={"retry-after":str(retry_after)} if retry_after else {}
    return HttpError(Resp(status, headers), json.dumps(body).encode())

cases=[
 (http(503, canonical="UNAVAILABLE", msg="The service is currently unavailable."), "transient"),
 (http(500, reason="backendError"), "transient"),
 (http(429, reason="rateLimitExceeded", retry_after=42), "transient"),
 (http(403, reason="userRateLimitExceeded"), "transient"),   # throttle wearing a 403
 (http(403, reason="permissionDenied", msg="caller does not have permission"), "permanent"),
 (http(429, reason="dailyLimitExceeded"), "permanent"),      # will not clear today
 (http(404, msg="Requested entity was not found."), "permanent"),
 (http(400, reason="badRequest", msg="Unable to parse range: A2:ZZ"), "permanent"),
 (http(401, msg="Invalid Credentials"), "permanent"),
 (ConnectionResetError("reset by peer"), "transient"),
 (TimeoutError("read timed out"), "transient"),
 (ValueError("bad url"), "permanent"),
]
print("== classification ==")
for exc, want in cases:
    got = "transient" if isinstance(classify(exc), TransientError) else "permanent"
    label = classify(exc)
    print(f"{'PASS' if got==want else 'FAIL':4} {want:9} {str(label)[:66]}")
    assert got==want

print("\n== retry-after honoured, permanent raises immediately ==")
slept=[]
calls={"n":0}
def flaky():
    calls["n"]+=1
    if calls["n"]<3: raise http(429, reason="rateLimitExceeded", retry_after=5)
    return "done"
print(call_with_retry(flaky, RetryPolicy(attempts=5, jitter=0), sleep=slept.append), slept, calls)
slept.clear()
def broken(): raise http(403, reason="permissionDenied")
try: call_with_retry(broken, RetryPolicy(attempts=5), sleep=slept.append)
except PermanentError as e: print("stopped after", len(slept), "sleeps ->", str(e)[:50])

print("\n== run-level deferral ==")
class Client:
    policy=None
    def __init__(self, fail_rows, kind): self.fail_rows=fail_rows; self.kind=kind; self.status=None; self.n=0
    def batch_set_values(self, ss, data):
        self.status={d["range"].split("!")[-1]: d["values"][0][0] for d in data}
    def _fail(self): raise (http(503, canonical="UNAVAILABLE") if self.kind=="transient" else http(403, reason="permissionDenied"))

import sheets_sync.sync as S
orig=S.run_job
def fake_run_job(client, job):
    if job.name in client.fail_rows: client._fail()
    return S.JobResult(job.name,"ok",10,5)
S.run_job=fake_run_job

jobs=[SyncJob("A","u","A1","u","A1"), SyncJob("B","u","A1","u","A1")]
c=Client({"B"},"transient")
rep=run(c,"SSID","import",jobs=jobs,user="me@x.com",attempt=1,retry_window=60,sleep=lambda s: None, timezone_name="Europe/Kyiv")
print([ (r.name,r.status) for r in rep.results ])
print("retry:", json.dumps(rep.retry_request["inputs"], indent=None)[:200])
print("J2:", c.status["J2"][:150])

c=Client({"B"},"permanent")
rep=run(c,"SSID","import",jobs=jobs,attempt=1,sleep=lambda s: None)
print([ (r.name,r.status) for r in rep.results ], "| retry_request:", rep.retry_request)
print("J2:", c.status["J2"][:90])

c=Client({"B"},"transient")
rep=run(c,"SSID","import",jobs=jobs,attempt=4,max_attempts=4,retry_window=0,sleep=lambda s: None)
print("last attempt -> retry_request:", rep.retry_request)
print("J2:", c.status["J2"][:120])

print()
print("== mixed: one row permanently broken, one deferred ==")
def mixed_run_job(client, job):
    if job.name=="A": raise http(403, reason="permissionDenied")
    if job.name=="B": raise http(503, canonical="UNAVAILABLE")
    return S.JobResult(job.name,"ok",10,5)
S.run_job=mixed_run_job
c=Client(set(),"transient")
rep=run(c,"SSID","import",jobs=jobs,user="me@x.com",attempt=1,retry_window=0,
        sleep=lambda s: None, timezone_name="Europe/Kyiv")
print([ (r.name,r.status) for r in rep.results ])
print("retry scheduled:", rep.retry_request is not None)
msg=c.status["J2"]
assert "permissiondenied" in msg.lower(), "permanent failure missing from J2"
assert "Retry 2 of 4" in msg, "deferral note missing from J2"
assert msg.startswith("Failed:"), "a permanent failure must headline as Failed: " + msg
print("PASS both reported")
print("J2:", msg)

print()
print("== settings tab itself deferred ==")
print()
print("== the headline states ==")
def ok_run_job(client, job): return S.JobResult(job.name,"ok",10,5)
S.run_job=ok_run_job
c=Client(set(),"transient")
run(c,"SSID","import",jobs=jobs,user="me@x.com",retry_window=0,sleep=lambda s: None)
assert c.status["J2"] == "Import successful", c.status["J2"]
print("  success     ->", c.status["J2"])

c=Client(set(),"transient")
run(c,"SSID","import",jobs=[],user="me@x.com",retry_window=0,sleep=lambda s: None)
assert c.status["J2"] == "Import successful", c.status["J2"]
print("  no rows     ->", c.status["J2"])

def skip_run_job(client, job):
    return S.JobResult(job.name,"ok",10,5) if job.name=="A" else S.JobResult(job.name,"skipped",0,0)
S.run_job=skip_run_job
c=Client(set(),"transient")
run(c,"SSID","import",jobs=jobs,user="me@x.com",retry_window=0,sleep=lambda s: None)
assert c.status["J2"] == "Import successful", c.status["J2"]
print("  skipped     ->", c.status["J2"])

S.run_job=fake_run_job
c=Client({"B"},"transient")
run(c,"SSID","import",jobs=jobs,user="me@x.com",attempt=1,retry_window=0,
    sleep=lambda s: None, timezone_name="Europe/Kyiv")
assert c.status["J2"].startswith("Failed:"), c.status["J2"]
assert "scheduled at" in c.status["J2"], c.status["J2"]
print("  retry due   ->", c.status["J2"][:76])

c=Client({"B"},"transient")
run(c,"SSID","import",jobs=jobs,user="me@x.com",attempt=4,max_attempts=4,
    retry_window=0,sleep=lambda s: None, timezone_name="Europe/Kyiv")
assert c.status["J2"].startswith("Failed:"), c.status["J2"]
print("  gave up     ->", c.status["J2"][:72])
for m,expect in (("import","Import successful"),("export","Export successful"),
                 ("database","Import successful")):
    S.run_job=ok_run_job
    c=Client(set(),"transient")
    run(c,"SSID",m,jobs=jobs,user="me@x.com",retry_window=0,sleep=lambda s: None)
    cell="L2" if m=="database" else "J2"
    assert c.status[cell]==expect, (m, c.status[cell])
    print("  %-8s -> %s" % (m, c.status[cell]))
print("PASS all states")

S.run_job=orig
class Boom(Client):
    def get_values(self, *a, **k): raise http(503, canonical="UNAVAILABLE")
c=Boom(set(),"transient")
rep=run(c,"SSID","import",attempt=1,retry_window=0,sleep=lambda s: None,
        timezone_name="Europe/Kyiv")
msg=c.status["J2"]
assert "settings did not sync" in msg, "settings deferral not reported: " + repr(msg)
assert msg.startswith("Failed:"), msg
print("PASS ->", msg[:110])

S.run_job=orig

print()
print("== a transient failure defers the rest of the run ==")
chain=[SyncJob(n,"u","A1","u","A1") for n in ("Rebuild","CopyA","CopyB","CopyC")]
class Trace(Client):
    def __init__(self,*a):
        Client.__init__(self,set(),"transient"); self.ran=[]

def make_(fail_on, kind):
    def f(client, job):
        client.ran.append(job.name)
        if job.name==fail_on:
            raise http(503, canonical="UNAVAILABLE") if kind=="transient" else http(403, reason="permissionDenied")
        return S.JobResult(job.name,"ok",10,5)
    return f

S.run_job=make_("CopyA","transient")
c=Trace()
rep=run(c,"SSID","import",jobs=chain,user="me@x.com",attempt=1,retry_window=0,
        sleep=lambda s: None, timezone_name="Europe/Kyiv")
assert c.ran==["Rebuild","CopyA"], c.ran  # CopyB/CopyC never ran on stale input
assert [r.status for r in rep.results]==["ok","deferred","deferred","deferred"], rep.results
carried=[j["name"] for j in json.loads(rep.retry_request["inputs"]["jobs_json"])]
assert carried==["CopyA","CopyB","CopyC"], carried  # and Rebuild is not redone
print("  ran:", c.ran, "-> retry carries:", carried)

print("a permanent failure does not block the rest")
S.run_job=make_("CopyA","permanent")
c=Trace()
rep=run(c,"SSID","import",jobs=chain,user="me@x.com",attempt=1,retry_window=0,
        sleep=lambda s: None, timezone_name="Europe/Kyiv")
assert c.ran==["Rebuild","CopyA","CopyB","CopyC"], c.ran
assert [r.status for r in rep.results]==["ok","failed","ok","ok"], rep.results
assert rep.retry_request is None
print("  ran:", c.ran)

print("blocked rows run once the blocker clears, in the same run")
tries={"n":0}
def flaky_(client, job):
    client.ran.append(job.name)
    if job.name=="CopyA":
        tries["n"]+=1
        if tries["n"]==1: raise http(503, canonical="UNAVAILABLE")
    return S.JobResult(job.name,"ok",10,5)
S.run_job=flaky_
c=Trace()
rep=run(c,"SSID","import",jobs=chain[:3],user="me@x.com",attempt=1,retry_window=600,
        sleep=lambda s: None, timezone_name="Europe/Kyiv")
assert c.ran==["Rebuild","CopyA","CopyA","CopyB"], c.ran  # Rebuild not re-run
assert rep.retry_request is None and c.status["J2"]=="Import successful", c.status["J2"]
print("  ran:", c.ran, "->", c.status["J2"])
print("PASS ordering")
S.run_job=orig
