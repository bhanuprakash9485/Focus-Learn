"""
Live end-to-end test of the goal quiz API over real HTTP.

Boots the real in-process ThreadingHTTPServer on an ephemeral loopback port
with a throwaway SQLite database and a stubbed generator (no Groq call, no
credentials, no production data), then drives the documented endpoints the way
the React app does:

  POST /api/quiz/goal/<goalId>/prepare   background 10/10/10 generation
  GET  /api/quiz/goal/<goalId>           authoritative status + stage
  GET  /api/quiz/goals                   every stored goal quiz in one call
  GET  /api/quiz/<id>                    the validated 30-question quiz
  POST /api/quiz/<id>/answer             one answer, server-side unlock
  POST /api/quiz/<id>/submit             authoritative scoring

It also proves the boundaries: authentication, unlock enforcement (403),
per-user isolation, and that ordinary topic quizzes are unaffected.

Run:  python backend/test_live_goal_quiz.py
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

FAILURES: list[str] = []
CHECKS = 0

_STEMS = {
    "basic": [
        "In {topic}, which option names the core idea correctly?",
        "Which term from {topic} matches a starting-point building block?",
        "State one true property of {topic} as used in practice.",
        "A beginner meets {topic} for the first time - what is true of it?",
        "Choose the statement that correctly introduces {topic}.",
        "Identify the basic building block that {topic} relies on.",
        "What does the central term in {topic} stand for?",
        "Pick the simplest accurate description of {topic}.",
        "Which sentence about {topic} contains no factual error?",
        "Name the concept that {topic} formalises at an introductory level.",
        "When starting to learn {topic}, which of these facts holds?",
        "A glossary entry for {topic} would most likely say it is used to...",
        "The introductory purpose of {topic} is best described as...",
        "A newcomer asks why {topic} matters; which reply is right?",
        "Which of these is the everyday meaning of {topic}?",
    ],
    "moderate": [
        "A team must apply {topic} to a small real case - which technique fits?",
        "Two colleagues disagree about using {topic}. Whose reasoning holds up?",
        "Given a short example involving {topic}, which conclusion follows?",
        "Compare the two common ways of handling {topic} and pick the better fit.",
        "A system built on {topic} misbehaves once - what most likely explains it?",
        "Which approach keeps {topic} understandable as the system grows?",
        "In a worked {topic} example, why does the suggested step actually matter?",
        "Which option trades off speed against clarity when applying {topic}?",
        "You must justify a decision about {topic}. Which justification is sound?",
        "A short snippet leans on {topic}. What does that snippet achieve?",
        "What would a practitioner inspect first when reasoning about {topic}?",
        "Which technique would a tutor recommend for using {topic} in a project?",
        "Two designs use {topic}; which one handles the described load better?",
        "How should a reviewer answer a teammate's question about {topic}?",
        "A dataset arrives with the quality issue {topic} catches - what next?",
    ],
    "advanced": [
        "Trace the multi-step {topic} process and locate the step that breaks.",
        "Given this {topic} snippet, predict the output and name the fault.",
        "Two designs using {topic} look equivalent; which edge case separates them?",
        "A production incident involves {topic}. What is the root cause?",
        "Which analysis of {topic} survives an adversarial workload?",
        "Reason about this {topic} trade-off and pick the defensible choice.",
        "Debug the {topic} behaviour below: which invariant is violated?",
        "Under which condition does this {topic} approach stop being correct?",
        "A subtle {topic} optimisation is proposed. Evaluate it rigorously.",
        "Which {topic} failure mode is hardest to detect, and why?",
        "Prove or refute the stated property of {topic} using the given case.",
        "Compare advanced {topic} strategies on a case that mixes constraints.",
        "Where does this {topic} reasoning silently assume something untrue?",
        "Which refactor preserves the guarantees that {topic} depends on?",
        "A scheduler using {topic} degrades under contention. Diagnose and rank causes.",
    ],
}


def check(name: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAILURES.append(f"{name}{(' -- ' + detail) if detail else ''}")
    print(f"  {status}: {name}" + (f"  -- {detail}" if detail else ""))


def _question(topic: str, difficulty: str, index: int, salt: str = "0") -> dict:
    stems = _STEMS.get(difficulty, _STEMS["basic"])
    prompt = stems[index % len(stems)].format(topic=topic)
    return {
        "prompt": prompt,
        "options": [
            f"the standard answer for {topic} case {index}{salt}",
            f"a plausible distractor one for {topic} case {index}{salt}",
            f"a plausible distractor two for {topic} case {index}{salt}",
            f"a plausible distractor three for {topic} case {index}{salt}",
        ],
        "correctIndex": index % 4,
        "explanation": (
            f"Because the definition of {topic} case {index}{salt} fixes the only "
            "outcome that holds here."
        ),
        "difficulty": difficulty,
        "concept": f"{topic} case {index}",
    }


def claim_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


port = claim_free_port()
os.environ["PORT"] = str(port)
os.environ["FOCUSLEARN_HOST"] = "127.0.0.1"

_tmp = tempfile.mkdtemp(prefix="focuslearn-goalquiz-")
_db_path = os.path.join(_tmp, "goal_quiz.db")

import auth  # noqa: E402
import goals  # noqa: E402
import groq_service  # noqa: E402
import quiz_service  # noqa: E402

auth.DB_PATH = _db_path
auth._conn = None
quiz_service.DB_PATH = _db_path
if hasattr(quiz_service, "DB_PATH"):
    quiz_service.DB_PATH = _db_path

import google_auth  # noqa: E402,F401
import server  # noqa: E402


class StubGenerator:
    """Deterministic stand-in for ``groq_service.generate_quiz_tier``."""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    def install(self) -> None:
        self._original = groq_service.generate_quiz_tier
        groq_service.generate_quiz_tier = self  # type: ignore[assignment]

    def restore(self) -> None:
        groq_service.generate_quiz_tier = self._original  # type: ignore[assignment]

    def __call__(
        self,
        topic: str,
        difficulty: str,
        level: str = "beginner",
        count: int = quiz_service.QUESTIONS_PER_DIFFICULTY,
        focus_concepts=None,
        avoid_prompts=None,
        goal_context: str = "",
        budget=None,
    ) -> list[dict]:
        self.calls.append({"topic": topic, "difficulty": difficulty, "count": count})
        # A real model call is not instant. The small pause lets the test
        # observe each tier landing, which is what the app shows the student.
        time.sleep(0.6)
        return [_question(topic, difficulty, i) for i in range(count)]

auth.init_db()
goals.DB_PATH = _db_path
if hasattr(goals, "DB_PATH"):
    goals.DB_PATH = _db_path
goals.init_db()
quiz_service.init_db()

stub = StubGenerator()
stub.install()

httpd = server.ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()
time.sleep(0.2)

BASE = f"http://127.0.0.1:{port}"

_cookie: str | None = None


def req(method: str, path: str, body=None, use_cookie: bool = True):
    global _cookie
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    headers = {"Connection": "close"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if use_cookie and _cookie:
        headers["Cookie"] = f"fl_session={_cookie}"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", "replace")
    out = dict((k.lower(), v) for k, v in resp.getheaders())
    conn.close()
    return resp.status, out, raw


def take_cookie(headers: dict) -> str | None:
    m = re.search(r"fl_session=([^;]+);", headers.get("set-cookie", ""))
    return m.group(1) if m else None


def jbody(raw: str):
    try:
        return json.loads(raw)
    except ValueError:
        return {}


def wait_ready(goal_id: str, timeout_s: float = 30.0) -> tuple[dict, list[dict]]:
    """Poll the status endpoint like the app does, recording the stages seen."""
    end = time.time() + timeout_s
    stages: list[dict] = []
    last = {}
    while time.time() < end:
        status, _, raw = req("GET", f"/api/quiz/goal/{goal_id}")
        if status == 200:
            last = jbody(raw)
            stage = last.get("stage")
            if stage and (not stages or stages[-1]["stage"] != stage):
                stages.append({"stage": stage, "state": last.get("state")})
            if last.get("state") in ("ready", "failed"):
                return last, stages
        time.sleep(0.15)
    return last, stages


EMAIL = f"goalquiz{int(time.time())}@example.com"
PASSWORD = "goaldemo1"

print("== FocusLearn goal quiz live API test ==")
print(f"server on {BASE}, temp DB {_db_path}, user {EMAIL}\n")

# 1) unauthenticated access is refused everywhere
status, _, _ = req("POST", f"/api/quiz/goal/web-dev/prepare", {"title": "Web Development Fundamentals"}, use_cookie=False)
check("prepare without a session is 401", status == 401, f"http {status}")
status, _, _ = req("GET", "/api/quiz/goal/web-dev", use_cookie=False)
check("goal status without a session is 401", status == 401, f"http {status}")
status, _, _ = req("GET", "/api/quiz/goals", use_cookie=False)
check("goal statuses without a session is 401", status == 401, f"http {status}")

# 2) sign up
status, hdrs, body = req("POST", "/api/auth/signup", {"name": "Goal Tester", "email": EMAIL, "password": PASSWORD})
check("signup 201", status == 201, f"http {status}")
_cookie = take_cookie(hdrs)
check("session cookie issued", bool(_cookie))

# 3) status before anything exists
status, _, raw = req("GET", "/api/quiz/goal/web-dev")
data = jbody(raw)
check("GET goal status 200 before prepare", status == 200, f"http {status}")
check("unknown goal reports state=none", data.get("state") == "none", json.dumps(data)[:120])
check("unknown goal has no quiz id", data.get("quiz_id") in (None, ""), json.dumps(data)[:120])
check("unknown goal still declares the 30-question plan",
      data.get("expected_total") == 30, json.dumps(data)[:160])

status, _, raw = req("GET", "/api/quiz/goals")
check("GET /api/quiz/goals 200 when empty", status == 200 and jbody(raw).get("goals") == {},
      f"http {status} {raw[:80]}")

# 4) prepare a catalog goal whose definition the client sends
status, _, raw = req("POST", "/api/quiz/goal/web-dev/prepare", {
    "title": "Web Development Fundamentals",
    "description": "Build modern web applications with HTML, CSS and JavaScript.",
    "goalContext": "I want a job-ready foundation in modern front-end development.",
    "experienceLevel": "beginner",
})
prep = jbody(raw)
check("prepare returns 200", status == 200, f"http {status} {raw[:120]}")
check("prepare returns a quiz id", bool(prep.get("quiz_id")), json.dumps(prep)[:120])
check("prepare reports a background state", prep.get("status") in ("generating", "ready"),
      json.dumps(prep)[:120])
check("prepare echoes the goal id", prep.get("goal_id") == "web-dev", json.dumps(prep)[:120])

goal_status, stages = wait_ready("web-dev")
check("goal quiz reaches ready", goal_status.get("state") == "ready", json.dumps(goal_status)[:200])
check("goal quiz stores 30 questions", goal_status.get("total") == 30, json.dumps(goal_status)[:200])
check("goal quiz expects 30 questions", goal_status.get("expected_total") == 30, json.dumps(goal_status)[:200])
check("goal quiz lesson id is the goal's own",
      goal_status.get("lesson_id") == "goal-quiz-web-dev", str(goal_status.get("lesson_id")))
check("goal status counts 10 per tier",
      goal_status.get("difficulty_counts") == {"basic": 10, "moderate": 10, "advanced": 10},
      json.dumps(goal_status.get("difficulty_counts")))
check("goal status reports stage complete", goal_status.get("stage") == "complete",
      str(goal_status.get("stage")))
seen_stages = [s["stage"] for s in stages]
check("tier progress is observable while generating",
      "basic_ready" in seen_stages and "moderate_ready" in seen_stages, " -> ".join(seen_stages))
check("generation called the model once per tier",
      [c["difficulty"] for c in stub.calls] == ["basic", "moderate", "advanced"],
      str([c["difficulty"] for c in stub.calls]))
check("only the first tier is unlocked at the start",
      goal_status.get("unlocked") == {"basic": True, "moderate": False, "advanced": False},
      json.dumps(goal_status.get("unlocked")))
check("tiers carry the Basic/Moderate/Difficult labels",
      [t["label"] for t in goal_status.get("tiers", [])] == ["Basic", "Moderate", "Difficult"],
      str([t.get("label") for t in goal_status.get("tiers", [])]))
check("the difficult tier states its unlock requirement",
      (goal_status.get("tiers") or [{}, {}, {}])[2]["requirement"]["text"].lower().find("moderate") >= 0,
      json.dumps((goal_status.get("tiers") or [{}])[2].get("requirement")))

quiz_id = goal_status.get("quiz_id") or prep.get("quiz_id")

# 5) the stored quiz itself
status, _, raw = req("GET", f"/api/quiz/{quiz_id}")
quiz = jbody(raw).get("quiz") or {}
check("GET /api/quiz/<id> 200", status == 200, f"http {status}")
questions = quiz.get("questions") or []
check("quiz has 30 questions", len(questions) == 30, str(len(questions)))
check(
    "tiers are stored in order 10 basic / 10 moderate / 10 advanced",
    [d for d in ("basic", "moderate", "advanced") for _ in range(10)] == [q.get("difficulty") for q in questions],
    str([q.get("difficulty") for q in questions[:3]]) + "...",
)
check("every question has 4 distinct options",
      all(len(q.get("options") or []) == 4 and len(set(q["options"])) == 4 for q in questions))
check("every question has a valid answer index",
      all(isinstance(q.get("correctIndex"), int) and 0 <= q["correctIndex"] < 4 for q in questions))
check("every question has an explanation and a concept",
      all(q.get("explanation") and q.get("concept") for q in questions))
check("every question has a stable id", all(q.get("id") for q in questions))
check("question ids are unique", len({q["id"] for q in questions}) == 30)
check("the quiz is marked as AI-original", quiz.get("source_type") == "ai_generated_original",
      str(quiz.get("source_type")))
check("no duplicate prompts in the stored quiz",
      len({q["prompt"].strip().lower() for q in questions}) == 30)

# 6) the bulk hub endpoint
status, _, raw = req("GET", "/api/quiz/goals")
bulk = jbody(raw).get("goals") or {}
check("GET /api/quiz/goals lists the stored goal quiz", status == 200 and "web-dev" in bulk,
      f"http {status} {str(list(bulk))[:80]}")
check("bulk status matches the single status",
      (bulk.get("web-dev") or {}).get("total") == 30, json.dumps(bulk.get("web-dev") or {})[:120])
status, _, raw = req("GET", "/api/quiz/qz-does-not-exist")
check("a bogus quiz id is 404, not a server error", status == 404, f"http {status}")

# 7) prepare again is idempotent - no second row, no second model run
status, _, raw = req("POST", "/api/quiz/goal/web-dev/prepare", {"title": "Web Development Fundamentals"})
again = jbody(raw)
check("repeat prepare returns the same quiz id", again.get("quiz_id") == quiz_id, json.dumps(again)[:120])
check("repeat prepare makes no new model call", len(stub.calls) == 3, str(len(stub.calls)))
status, _, raw = req("GET", "/api/quiz/goals")
check("repeat prepare creates no duplicate record", len(jbody(raw).get("goals") or {}) == 1,
      str(list((jbody(raw).get("goals") or {}))))

# 8) unlock enforcement, exactly as the server computes it
moderate_q = next(i for i, q in enumerate(questions) if q["difficulty"] == "moderate")
status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": moderate_q, "selected_index": 0})
check("answering a locked moderate question is 403", status == 403, f"http {status} {raw[:100]}")
check("locked 403 explains the requirement", "3" in jbody(raw).get("error", ""), jbody(raw).get("error", ""))

# 3 basic answers (deliberately wrong ones - wrong answers still count)
for i in [q for q in range(30) if questions[q]["difficulty"] == "basic"][:3]:
    wrong = (questions[i]["correctIndex"] + 1) % 4
    status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": i, "selected_index": wrong})
    fb = jbody(raw)
    check(f"basic answer {i + 1} recorded", status == 200 and fb.get("is_correct") is False,
          f"http {status} {raw[:100]}")
check("3 basic attempts unlock moderate", jbody(raw).get("unlocked", {}).get("moderate") is True,
      json.dumps(jbody(raw).get("unlocked")))

# a 4th basic answer: still nothing new unlocks
status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": 3, "selected_index": 0})
check("a 4th basic answer still unlocks nothing new", jbody(raw).get("unlocked", {}).get("advanced") is False,
      json.dumps(jbody(raw).get("unlocked")))
check("4 basic attempts are counted", jbody(raw).get("attempts", {}).get("basic") == 4,
      json.dumps(jbody(raw).get("attempts")))

# answering the same question twice must not double-count the attempt
status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": 3, "selected_index": 1})
check("re-answering does not inflate the attempt count",
      jbody(raw).get("attempts", {}).get("basic") == 4, json.dumps(jbody(raw).get("attempts")))

# 3 moderate answers
mod_idx = [i for i, q in enumerate(questions) if q["difficulty"] == "moderate"]
for i in mod_idx[:3]:
    status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": i, "selected_index": 0})
check("3 moderate attempts unlock difficult", jbody(raw).get("unlocked", {}).get("advanced") is True,
      json.dumps(jbody(raw).get("unlocked")))

# 9) out-of-range input is rejected
status, _, _ = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": 99, "selected_index": 0})
check("out-of-range question index is 400", status == 400, f"http {status}")
status, _, _ = req("POST", f"/api/quiz/{quiz_id}/answer", {"index": 0, "selected_index": 7})
check("out-of-range option index is 400", status == 400, f"http {status}")
status, _, _ = req("POST", f"/api/quiz/{quiz_id}/answer", {})
check("missing answer fields is 400", status == 400, f"http {status}")

# 10) a partial attempt is not a completed quiz
status, _, raw = req("GET", f"/api/quiz/goal/web-dev")
partial = jbody(raw)
check("a partly answered quiz is not marked completed", partial.get("completed") is False,
      json.dumps(partial)[:160])
check("a partly answered quiz still reports its answers", len(partial.get("answers") or []) == 7,
      str(len(partial.get("answers") or [])))

# 11) finish the quiz, tracking what the server should score
expected_correct: dict[int, bool] = {}


def answer(index: int, correct: bool) -> dict:
    q = questions[index]
    wrong_option = (q["correctIndex"] + 1) % 4
    selected = q["correctIndex"] if correct else wrong_option
    status, _, raw = req("POST", f"/api/quiz/{quiz_id}/answer",
                         {"index": index, "selected_index": selected})
    expected_correct[index] = correct
    return {"status": status, "body": jbody(raw)}


for i in range(30):
    if i < 4 or i in mod_idx[:3]:
        continue  # already answered above
    answer(i, i in mod_idx[3:])  # only the remaining moderate ones are right
check("all 30 questions accepted", len(expected_correct) == 23, str(len(expected_correct)))

# re-check the four basic answers recorded above
for i in range(4):
    expected_correct[i] = False
for i in mod_idx[:3]:
    expected_correct[i] = questions[i]["correctIndex"] == 0

status, _, raw = req("POST", f"/api/quiz/{quiz_id}/submit")
sub = jbody(raw).get("submission") or {}
expected_score = sum(1 for v in expected_correct.values() if v)
check("submit 200", status == 200, f"http {status} {raw[:120]}")
check("submit scores every question", sub.get("total") == 30, json.dumps(sub)[:160])
check("submit score matches the answers the server graded",
      sub.get("score") == expected_score, f"score {sub.get('score')} expected {expected_score}")
check("submit counts every submitted answer", sub.get("answered") == 30, str(sub.get("answered")))
check("submit percentage is consistent",
      sub.get("percentage") == round(sub.get("score", 0) / max(sub.get("total", 1), 1) * 100),
      json.dumps({k: sub.get(k) for k in ("score", "total", "percentage")}))
check("submit breaks the score down by tier",
      set((sub.get("breakdown") or {}).keys()) == {"basic", "moderate", "advanced"},
      json.dumps(sub.get("breakdown")))
check("difficult tier was scored", (sub.get("breakdown") or {}).get("advanced", {}).get("total") == 10,
      json.dumps((sub.get("breakdown") or {}).get("advanced")))
check("submit reports weak concepts", isinstance(sub.get("weak_concepts"), list), str(type(sub.get("weak_concepts"))))

status, _, raw = req("GET", f"/api/quiz/goal/web-dev")
done = jbody(raw)
check("status marks the quiz completed", done.get("completed") is True, json.dumps(done)[:160])
check("completed quiz keeps 30 stored answers", len(done.get("answers") or []) == 30,
      str(len(done.get("answers") or [])))
check("completion does not unlock anything extra", done.get("unlocked") == {"basic": True, "moderate": True, "advanced": True},
      json.dumps(done.get("unlocked")))

# 11) a second user's quiz is invisible to the first user (and vice versa)
other_cookie = _cookie
status, hdrs, raw = req("POST", "/api/auth/signup",
                        {"name": "Other", "email": f"other{int(time.time())}@example.com", "password": PASSWORD})
_cookie = take_cookie(hdrs)
check("second user signs up", status == 201, f"http {status}")
status, _, raw = req("GET", f"/api/quiz/{quiz_id}")
check("another user cannot read the quiz", status == 404, f"http {status}")
status, _, raw = req("GET", "/api/quiz/goals")
check("another user sees none of the first user's goal quizzes", jbody(raw).get("goals") == {},
      json.dumps(jbody(raw))[:120])
status, _, raw = req("GET", "/api/quiz/goal/web-dev")
check("another user sees their own empty goal status", jbody(raw).get("state") == "none",
      json.dumps(jbody(raw))[:120])
_cookie = other_cookie

# 12) a topic quiz is still a topic quiz, even when a goal is named
status, _, raw = req("POST", "/api/quiz/prepare", {"topic": "HTTP Caching", "level": "beginner", "goal": "web-dev"})
topic_prep = jbody(raw)
check("topic prepare 200", status == 200, f"http {status} {raw[:120]}")
topic_quiz_id = topic_prep.get("quiz_id")
deadline = time.time() + 30
topic_status = {}
while time.time() < deadline:
    s, _, r = req("GET", f"/api/quiz/status?topic=HTTP%20Caching")
    topic_status = jbody(r)
    if topic_status.get("state") in ("ready", "failed"):
        break
    time.sleep(0.15)
check("topic quiz reaches ready", topic_status.get("state") == "ready", json.dumps(topic_status)[:200])
check("naming a goal does not move the topic quiz into goal scope",
      topic_status.get("quiz_id") == topic_quiz_id, json.dumps(topic_status)[:160])
check("topic status still serves 30 questions", topic_status.get("total") == 30,
      json.dumps(topic_status)[:160])
status, _, raw = req("GET", "/api/quiz/goals")
check("the topic quiz is not listed as a goal quiz",
      topic_quiz_id not in [v.get("quiz_id") for v in (jbody(raw).get("goals") or {}).values()],
      str([v.get("quiz_id") for v in (jbody(raw).get("goals") or {}).values()]))

# 13) a goal with no title (unknown id, no body) is a clean 400
status, _, raw = req("POST", "/api/quiz/goal/never-heard-of-it/prepare", {})
check("unknown goal without a title is 400", status == 400, f"http {status} {raw[:100]}")

# 14) an unsafe goal title is refused before any generation
status, _, raw = req("POST", "/api/quiz/goal/blocked-goal/prepare", {"title": "how to kill a person"})
check("unsafe goal title is 422", status == 422, f"http {status} {raw[:100]}")

# 15) the API still matches the TypeScript types the app compiles against.
#     These types are hand written, so `tsc` cannot notice a renamed field;
#     this section parses them and checks a live response really carries every
#     non-optional property the UI reads.
TS_TYPES = os.path.join(BASE_DIR, "..", "src", "types", "index.ts")


def required_fields(interface: str) -> list[str]:
    """Non-optional property names of a TS interface, nested types ignored."""
    if not os.path.isfile(TS_TYPES):
        return []
    with open(TS_TYPES, "r", encoding="utf-8") as handle:
        lines = handle.read().splitlines()
    names: list[str] = []
    inside = False
    depth = 0
    for line in lines:
        if not inside:
            if re.match(rf"export interface {re.escape(interface)}\b", line):
                inside = True
                depth = line.count("{") - line.count("}")
            continue
        depth += line.count("{") - line.count("}")
        if depth <= 0 and "}" in line:
            break
        if depth == 1:
            match = re.match(r"\s{2}(\w+)(\??):", line)
            if match and not match.group(2):
                names.append(match.group(1))
    return names


# Prove the parser itself works, so a broken parser cannot report an empty
# field list as a passing contract.
check("the TypeScript contract parser reads src/types/index.ts",
      os.path.isfile(TS_TYPES), TS_TYPES)
check("the parser finds the fields of a known interface",
      "quiz_id" in required_fields("GoalQuizPrepareResult")
      and "status" in required_fields("GoalQuizPrepareResult"),
      str(required_fields("GoalQuizPrepareResult")))
check("the parser skips optional fields",
      "expected_total" not in required_fields("TopicQuizStatus")
      and "total" in required_fields("TopicQuizStatus"),
      str(required_fields("TopicQuizStatus")))


def contract(label: str, interface: str, payload) -> None:
    wanted = required_fields(interface)
    if not wanted:
        check(f"{label} matches {interface}", False,
              f"{interface} not found in src/types/index.ts")
        return
    if not isinstance(payload, dict):
        check(f"{label} is a JSON object", False, type(payload).__name__)
        return
    missing = [name for name in wanted if name not in payload]
    check(f"{label} carries every field {interface} promises", not missing,
          f"missing {missing}" if missing else f"{len(wanted)} fields")


status, _, raw = req("GET", f"/api/quiz/goal/web-dev")
contract("GET /api/quiz/goal/<id>", "GoalQuizStatus", jbody(raw))
status, _, raw = req("GET", "/api/quiz/goals")
hub = jbody(raw).get("goals") or {}
check("the hub still has the goal quiz", "web-dev" in hub, str(list(hub)))
if "web-dev" in hub:
    contract("GET /api/quiz/goals entry", "GoalQuizStatus", hub["web-dev"])
    tiers = hub["web-dev"].get("tiers") or []
    check("the hub reports three tiers", len(tiers) == 3, str(len(tiers)))
    for tier in tiers:
        contract("a tier of the goal status", "GoalQuizTier", tier)

status, _, raw = req("GET", f"/api/quiz/status?topic=HTTP%20Caching")
contract("GET /api/quiz/status", "TopicQuizStatus", jbody(raw))
status, _, raw = req("POST", f"/api/quiz/goal/another-goal/prepare",
                     {"title": "Contract Fixture Goal"})
contract("POST /api/quiz/goal/<id>/prepare", "GoalQuizPrepareResult", jbody(raw))

status, _, raw = req("GET", f"/api/quiz/{quiz_id}")
quiz_payload = (jbody(raw) or {}).get("quiz") or {}
check("GET /api/quiz/<id> serves the quiz envelope", bool(quiz_payload), json.dumps(jbody(raw))[:120])
contract("the served quiz", "Quiz", quiz_payload)
quiz_questions = quiz_payload.get("questions") or []
check("the served goal quiz still has questions", bool(quiz_questions), str(len(quiz_questions)))
if quiz_questions:
    contract("a served question record", "QuizQuestion", quiz_questions[0])

# Answering the not-yet-touched topic quiz gives a real feedback payload.
status, _, raw = req("GET", f"/api/quiz/{topic_quiz_id}")
topic_quiz = (jbody(raw) or {}).get("quiz") or {}
topic_questions = topic_quiz.get("questions") or []
check("the topic quiz served questions for the answer check", bool(topic_questions), str(len(topic_questions)))
if topic_questions:
    first = topic_questions[0]
    status, _, raw = req("POST", f"/api/quiz/{topic_quiz_id}/answer",
                         {"index": 0, "selected_index": first["correctIndex"]})
    check("answering the topic quiz is accepted", status == 200, f"http {status} {raw[:100]}")
    contract("POST /api/quiz/<id>/answer", "AnswerFeedback", jbody(raw))

print()
stub.restore()
httpd.shutdown()
httpd.server_close()

if FAILURES:
    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} checks passed")
    print(f"{len(FAILURES)} FAILURE(S):")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print(f"ALL {CHECKS} LIVE GOAL QUIZ CHECKS PASSED")
sys.exit(0)
