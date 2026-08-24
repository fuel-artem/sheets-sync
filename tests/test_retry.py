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
S.run_job=orig
