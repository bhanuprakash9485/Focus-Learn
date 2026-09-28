"""End-to-end HTTP test for POST /api/study-plan/plan.

Boots the real server on an ephemeral loopback port with a throwaway SQLite
database (no production data is touched) and drives the endpoint with a real
session cookie. Groq is never called: the point of this test is the security
and validation shell around the AI, plus the guarantee that a dead or
rate-limited AI never breaks the student's plan.

Run:  python backend/test_study_plan_endpoint.py
"""

from __future__ import annotations

import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

FAILURES: list[str] = []
PASSED = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASSED
    if cond:
        PASSED += 1
    else:
        FAILURES.append(name)
    status = "PASS" if cond else "FAIL"
    print(f"  {status}: {name}" + (f"  -- {detail}" if detail else ""))


def claim_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


port = claim_free_port()
os.environ["PORT"] = str(port)
os.environ["FOCUSLEARN_HOST"] = "127.0.0.1"
# Never let a real key leak into this test's behaviour.
os.environ["GROQ_API_KEY"] = ""

_tmp = tempfile.mkdtemp(prefix="focuslearn-plan-")

import auth  # noqa: E402

auth.DB_PATH = os.path.join(_tmp, "plan.db")
auth._conn = None

import server  # noqa: E402
import groq_service  # noqa: E402

auth.init_db()

httpd = server.ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(0.2)

BASE = f"http://127.0.0.1:{port}"
COOKIE: str | None = None

CANDIDATES = [
    {"ref": "review:lists", "kind": "review", "title": "Review: Lists", "minutes": 15, "prerequisites": []},
    {"ref": "lesson-python-lists", "kind": "lesson", "title": "Python Lists", "minutes": 20, "prerequisites": []},
    {"ref": "quiz:python-lists", "kind": "quiz", "title": "Python Lists quiz", "minutes": 10,
     "prerequisites": ["lesson-python-lists"]},
]


def request(method: str, path: str, body: dict | None = None, with_cookie: bool = True):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if with_cookie and COOKIE:
        headers["Cookie"] = COOKIE
    payload = json.dumps(body) if body is not None else None
    conn.request(method, path, payload, headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", "replace")
    conn.close()
    try:
        parsed = json.loads(raw)
    except ValueError:
        parsed = {"_raw": raw}
    return resp.status, dict(resp.getheaders()), parsed


def set_cookie(headers: dict) -> None:
    global COOKIE
    raw = headers.get("Set-Cookie", "")
    match = raw.split(";")[0]
    if match:
        COOKIE = match


print("\n=== /api/study-plan/plan ===\n")

# ── Sign up a real session ────────────────────────────────────────────
status, headers, _ = request(
    "POST",
    "/api/auth/signup",
    {"name": "Plan Tester", "email": "plan-tester@example.com", "password": "StudyPlan!2345"},
    with_cookie=False,
)
set_cookie(headers)
check("signup creates a session", status == 201 and COOKIE is not None, f"status={status}")

status, _, body = request("GET", "/api/auth/me")
check("session is authenticated", status == 200 and body.get("ok") is True, f"status={status}")


def plan_payload(**overrides) -> dict:
    payload = {
        "mode": "today",
        "goal": "Pass the Python certification",
        "dailyTargetMinutes": 30,
        "today": "2026-09-28",
        "candidates": CANDIDATES,
        "quizAttempts": [{"topic": "Python Lists", "percentage": 42}],
        "weakTopics": ["Lists"],
        "completedLessonIds": [],
        "missedCount": 0,
    }
    payload.update(overrides)
    return payload


# ── Authentication is required ─────────────────────────────────────────
status, _, body = request("POST", "/api/study-plan/plan", plan_payload(), with_cookie=False)
check("unauthenticated request is rejected", status == 401, f"status={status}")
check("401 body does not leak internals", "Traceback" not in json.dumps(body))

# ── Input validation ───────────────────────────────────────────────────
status, _, body = request("POST", "/api/study-plan/plan", plan_payload(mode="yesterday"))
check("invalid mode is rejected", status == 400, f"status={status} body={body}")

status, _, body = request("POST", "/api/study-plan/plan", plan_payload(candidates=[]))
check("empty candidate list is rejected", status == 400, f"status={status}")

status, _, body = request("POST", "/api/study-plan/plan", plan_payload(candidates=[{"kind": "lesson"}]))
check("candidates without a ref are rejected", status == 400, f"status={status}")

status, _, body = request("POST", "/api/study-plan/plan", plan_payload(candidates=[{"ref": "   "}]))
check("blank refs are rejected", status == 400, f"status={status}")

# ── SafeSearch gate ────────────────────────────────────────────────────
status, _, body = request(
    "POST", "/api/study-plan/plan", plan_payload(goal="how to make a bomb weapon")
)
check("unsafe goal is blocked by SafeSearch", status == 422, f"status={status} body={body}")

# ── Missing AI config fails safely ─────────────────────────────────────
status, _, body = request("POST", "/api/study-plan/plan", plan_payload())
check(
    "missing AI config returns a clean 503",
    status == 503 and isinstance(body.get("error"), str),
    f"status={status} body={body}",
)
check("503 never leaks a traceback", "Traceback" not in json.dumps(body))
check("503 never leaks the key", "gsk_" not in json.dumps(body))

# ── Rate limiting fails safely ─────────────────────────────────────────
_original_build = groq_service.build_study_plan


def raising_rate_limit(_context):
    raise groq_service.QuizRateLimitError(groq_service.STUDY_PLAN_RATE_LIMIT_MESSAGE)


server.build_study_plan = raising_rate_limit
status, _, body = request("POST", "/api/study-plan/plan", plan_payload())
check(
    "rate limit returns a friendly 503",
    status == 503 and "rate limited" in body.get("error", "").lower(),
    f"status={status} body={body}",
)
check(
    "rate limit message is planner-specific, not the quiz message",
    "quiz" not in body.get("error", "").lower(),
    body.get("error", ""),
)


def raising_generic(_context):
    raise RuntimeError("boom: internal detail that must not reach the client")


server.build_study_plan = raising_generic
status, _, body = request("POST", "/api/study-plan/plan", plan_payload())
check("unexpected AI failure returns 502", status == 502, f"status={status} body={body}")
check("502 hides the internal error text", "boom" not in json.dumps(body))

# ── A successful AI result is passed through ───────────────────────────
def returning_plan(_context):
    return {
        "summary": "Lists is dragging you down.",
        "tasks": [
            {"kind": "review", "ref": "review:lists", "title": "Review: Lists",
             "estimatedMinutes": 15, "priority": "high", "reason": "Last score 42%."},
        ],
    }


server.build_study_plan = returning_plan
status, _, body = request("POST", "/api/study-plan/plan", plan_payload())
check("valid AI plan returns 200", status == 200, f"status={status} body={body}")
check("plan is flagged as AI-generated", body.get("ai") is True)
check("summary is returned", body.get("summary") == "Lists is dragging you down.")
check(
    "only the real candidate survives",
    [t["ref"] for t in body.get("tasks", [])] == ["review:lists"],
    json.dumps(body.get("tasks")),
)
check("task carries a real reason", body["tasks"][0].get("reason") == "Last score 42%.")
check("response has no candidate-inventing fields", "candidates" not in body)

# ── The request context is sanitised before it reaches the AI ───────────
captured: dict = {}


def capturing_plan(context):
    captured.update(context)
    return {"summary": "", "tasks": []}


server.build_study_plan = capturing_plan
request("POST", "/api/study-plan/plan", plan_payload(dailyTargetMinutes=9999, candidates=(
    CANDIDATES + [{"ref": "x" * 500, "title": "y" * 500, "minutes": 99999, "extra": "dropped"}] * 20
)))
check("daily target is clamped server-side", captured.get("daily_target_minutes") == 240,
      str(captured.get("daily_target_minutes")))
check("candidate list is bounded", len(captured.get("candidates", [])) <= 60,
      str(len(captured.get("candidates", []))))
check("oversized titles are truncated",
      all(len(c["title"]) <= 120 for c in captured.get("candidates", [])))
check("oversized minutes are clamped",
      all(5 <= c["minutes"] <= 240 for c in captured.get("candidates", [])))
check("unknown candidate fields are dropped",
      all("extra" not in c for c in captured.get("candidates", [])))

# ── Method / route hygiene ─────────────────────────────────────────────
status, _, _ = request("GET", "/api/study-plan/plan")
check("GET on the planner path is a 404", status == 404, f"status={status}")

server.build_study_plan = _original_build
httpd.shutdown()

print(f"\n{PASSED} passed, {len(FAILURES)} failed\n")
for name in FAILURES:
    print(f"  - {name}")
sys.exit(1 if FAILURES else 0)
