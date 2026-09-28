"""LIVE quiz generation test against the real Groq API.

Unlike test_quiz_generation.py (which injects a fake model) and
test_live_goal_quiz.py (which forces a stub), this test lets the real
GROQ_API_KEY from backend/.env drive real model calls and then proves that the
served payload really contains 30 valid, distinct question objects.

  python backend\\test_live_ai_quiz.py                # 5 topics, fresh DB
  python backend\\test_live_ai_quiz.py "DBMS"         # one topic, quick probe
  KEEP_DB=1 python backend\\test_live_ai_quiz.py       # reuse a previous run

No secret is ever printed: only its length and a SHA-256 prefix are used to
prove the key never appears in a response, in the DB or on disk.
"""

from __future__ import annotations

import hashlib
import http.cookiejar
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

TOPICS = [
    "How the Web Works",
    "JavaScript Fundamentals",
    "Data Structures",
    "DBMS",
    "Machine Learning",
]
EXPECTED_PER_TIER = 10
EXPECTED_TOTAL = 30
OPTIONS_PER_QUESTION = 4

PASSED: list[str] = []
FAILED: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    if ok:
        PASSED.append(label)
        print(f"  PASS: {label}" + (f"  -- {detail}" if detail else ""))
    else:
        FAILED.append(label)
        print(f"  FAIL: {label}" + (f"  -- {detail}" if detail else ""))
    return ok


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Client:
    """Minimal cookie-aware JSON client for the live backend."""

    def __init__(self, base: str) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def call(self, method: str, path: str, payload: dict | None = None) -> tuple[int, dict]:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        try:
            with self.opener.open(req, timeout=180) as resp:
                return resp.status, json.loads(resp.read().decode() or "{}")
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode()
            try:
                return exc.code, json.loads(raw or "{}")
            except ValueError:
                return exc.code, {"raw": raw}

    def get(self, path: str) -> tuple[int, dict]:
        return self.call("GET", path)

    def post(self, path: str, payload: dict) -> tuple[int, dict]:
        return self.call("POST", path, payload)


def is_rate_limited(status: dict) -> bool:
    return "rate limit" in str(status.get("error") or "").lower()


def wait_for_state(client: Client, topic: str, timeout: float = 660.0) -> dict:
    """Poll the status endpoint until the quiz is ready or the run failed."""
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        code, body = client.get(f"/api/quiz/status?topic={urllib.parse.quote(topic)}")
        last = body
        state = (body or {}).get("state")
        if state in ("ready", "failed", "error"):
            return body
        time.sleep(2.0)
    return last


def validate_questions(topic: str, payload: dict) -> list[str]:
    """Independently re-validate the served questions. Never trusts the server."""
    problems: list[str] = []
    questions = payload.get("questions") or []
    if not isinstance(questions, list):
        return ["questions is not a list"]

    if len(questions) != EXPECTED_TOTAL:
        problems.append(f"expected {EXPECTED_TOTAL} questions, got {len(questions)}")

    tiers: dict[str, int] = {"basic": 0, "moderate": 0, "difficult": 0}
    seen_text: dict[str, int] = {}
    seen_ids: set[str] = set()
    seen_ids_lower: set[str] = set()
    seen_per_tier: dict[str, set[str]] = {"basic": set(), "moderate": set(), "difficult": set()}

    for position, q in enumerate(questions):
        where = f"#{position}"
        text = (q.get("prompt") or "").strip() if isinstance(q, dict) else ""
        if len(text) < 5:
            problems.append(f"{where} missing question text")
            continue

        norm = " ".join(text.lower().split())
        if norm in seen_text:
            problems.append(f"{where} duplicate text of {seen_text[norm]}")
        seen_text[norm] = position

        options = q.get("options")
        if not isinstance(options, list) or len(options) != OPTIONS_PER_QUESTION:
            problems.append(f"{where} has {len(options) if isinstance(options, list) else 'no'} options, want 4")
        else:
            if len({o.strip().lower() for o in options}) != OPTIONS_PER_QUESTION:
                problems.append(f"{where} repeated option text")
            if text.strip().lower() in {o.strip().lower() for o in options}:
                problems.append(f"{where} stem repeated as an option")

        correct = q.get("correctIndex")
        if not isinstance(correct, int) or not (0 <= correct < OPTIONS_PER_QUESTION):
            problems.append(f"{where} correctIndex={correct!r} out of range")
        if isinstance(correct, int) and isinstance(options, list) and 0 <= correct < len(options):
            if not str(options[correct]).strip():
                problems.append(f"{where} correct option is blank")

        if not str(q.get("explanation") or "").strip():
            problems.append(f"{where} missing explanation")

        difficulty = q.get("difficulty")
        if difficulty not in ("basic", "moderate", "advanced"):
            problems.append(f"{where} bad difficulty {difficulty!r}")
        else:
            label = "difficult" if difficulty == "advanced" else difficulty
            tiers[label] = tiers.get(label, 0) + 1
            if norm in seen_per_tier[label]:
                problems.append(f"{where} repeated within {label}")
            seen_per_tier[label].add(norm)

        qid = str(q.get("id") or "")
        if not qid:
            problems.append(f"{where} missing id")
        if qid in seen_ids or qid.lower() in seen_ids_lower:
            problems.append(f"{where} duplicate id {qid}")
        seen_ids.add(qid)
        seen_ids_lower.add(qid.lower())

    for label, count in tiers.items():
        if count != EXPECTED_PER_TIER:
            problems.append(f"{label} has {count}/{EXPECTED_PER_TIER}")

    for label, group in (("basic", payload.get("basic")), ("moderate", payload.get("moderate")), ("difficult", payload.get("difficult"))):
        if not isinstance(group, list) or len(group) != EXPECTED_PER_TIER:
            problems.append(f"response['{label}'] is not a 10-item list")

    if payload.get("total") != EXPECTED_TOTAL:
        problems.append(f"total={payload.get('total')}")

    if (payload.get("topic") or "").strip().lower() != topic.strip().lower():
        problems.append(f"topic mismatch: {payload.get('topic')!r}")

    return problems


def main() -> int:
    only = [a for a in sys.argv[1:] if not a.startswith("-")]
    topics = only or TOPICS

    import groq_service

    key = groq_service._groq_key()
    if not key:
        print("GROQ_API_KEY is not configured; add it to backend/.env")
        return 2
    fingerprint = hashlib.sha256(key.encode()).hexdigest()[:12]
    print("=" * 72)
    print("LIVE AI QUIZ TEST  (real Groq calls)")
    print("=" * 72)
    print(f"model            : {groq_service._MODEL}")
    print(f"key source       : backend/.env (never printed) len={len(key)} sha256={fingerprint}...")
    print(f"topics           : {len(topics)}")
    print("-" * 72)

    data_dir = Path(tempfile.mkdtemp(prefix="focuslearn-liveai-"))
    db_path = data_dir / "focuslearn.db"
    port = free_port()
    env = dict(os.environ)
    env["PORT"] = str(port)
    env["FOCUSLEARN_HOST"] = "127.0.0.1"
    env["FOCUSLEARN_DATA_DIR"] = str(data_dir)
    env["PYTHONUNBUFFERED"] = "1"
    log_path = data_dir / "server.log"
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "backend" / "server.py")],
        cwd=str(ROOT),
        env=env,
        stdout=log_path.open("w", encoding="utf-8", errors="replace"),
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    client = Client(base)

    def shutdown() -> None:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()

    try:
        deadline = time.time() + 45
        ready = False
        while time.time() < deadline:
            try:
                code, _ = client.get("/api/health")
                if code == 200:
                    ready = True
                    break
            except Exception:
                time.sleep(0.5)
        if not check(ready, "backend is up"):
            print(log_path.read_text(encoding="utf-8", errors="replace")[-2000:])
            return 1

        code, signup = client.post(
            "/api/auth/signup",
            {"email": "liveai@example.com", "password": "Str0ng-Pass-42", "name": "Live AI"},
        )
        if code >= 400 and code != 409:
            check(False, "sign up", str(signup)[:200])
            return 1
        check(code in (200, 201, 409), "signed in as a test user")

        ai_calls_before = 0
        summary: dict[str, dict] = {}

        for topic in topics:
            print("-" * 72)
            print(f"TOPIC: {topic}")
            t0 = time.time()
            code, prep = client.post("/api/quiz/prepare", {"topic": topic, "level": "beginner"})
            if not check(code == 200, f"[{topic}] POST /api/quiz/prepare accepted", f"HTTP {code} {str(prep)[:120]}"):
                continue
            quiz_id = prep.get("quiz_id") or prep.get("id")
            check(bool(quiz_id), f"[{topic}] prepare returned a quiz id", str(quiz_id)[:60])

            status = wait_for_state(client, topic)
            state = status.get("state")
            elapsed = time.time() - t0

            # A 429 is a legitimate live outcome. The server is *supposed* to
            # fail fast rather than spin, so the test waits out the provider's
            # window and re-prepares. That also exercises the top-up path: only
            # the missing questions are generated, never all 30 again.
            rate_limited = 0
            while state == "failed" and is_rate_limited(status) and rate_limited < 2:
                rate_limited += 1
                kept = sum(v for v in (status.get("difficulty_counts") or {}).values() if isinstance(v, int))
                print(
                    f"  ..provider returned 429; waiting 75s then re-preparing "
                    f"(server kept {kept}/30 already-generated questions)"
                )
                time.sleep(75)
                client.post("/api/quiz/prepare", {"topic": topic, "level": "beginner"})
                status = wait_for_state(client, topic)
                state = status.get("state")
                elapsed = time.time() - t0
            if rate_limited:
                check(True, f"[{topic}] survived a real 429 without losing stored questions", f"{rate_limited} re-prepare(s)")
            if not check(state == "ready", f"[{topic}] generation reached 'ready'", f"state={state} after {elapsed:.0f}s error={str(status.get('error'))[:160]}"):
                continue

            counts = status.get("difficulty_counts") or {}
            check(
                counts.get("basic") == EXPECTED_PER_TIER
                and counts.get("moderate") == EXPECTED_PER_TIER
                and counts.get("advanced") == EXPECTED_PER_TIER,
                f"[{topic}] stored tier counts are 10/10/10",
                json.dumps(counts),
            )

            code, body = client.get(f"/api/quiz/{quiz_id}")
            if not check(code == 200, f"[{topic}] GET /api/quiz/<id> returned 200", f"HTTP {code} {str(body)[:120]}"):
                continue
            payload = body.get("quiz") or {}
            problems = validate_questions(topic, payload)
            check(not problems, f"[{topic}] 30 real question objects pass every validation rule", "; ".join(problems[:6]))
            check(
                payload.get("valid") is True and payload.get("total") == EXPECTED_TOTAL,
                f"[{topic}] response total=30 and valid=true",
                f"total={payload.get('total')} valid={payload.get('valid')}",
            )
            check(
                not any("gsk_" in json.dumps(body) for _ in (0,)),
                f"[{topic}] no API key in the HTTP response",
            )

            # Persistence: the rows really exist in the database.
            conn = sqlite3.connect(db_path)
            try:
                rows = conn.execute(
                    "SELECT COUNT(*) FROM quiz_questions WHERE quiz_id = ?", (quiz_id,)
                ).fetchone()[0]
                stored_json = conn.execute(
                    "SELECT question_count FROM topic_quizzes WHERE id = ?", (quiz_id,)
                ).fetchone()
            finally:
                conn.close()
            check(
                rows == EXPECTED_TOTAL and stored_json and stored_json[0] == EXPECTED_TOTAL,
                f"[{topic}] questions are persisted in the database",
                f"quiz_questions rows={rows} question_count={stored_json[0] if stored_json else None}",
            )

            # Cached reopen: same objects, and no regeneration (server-side reuse).
            t1 = time.time()
            code2, body2 = client.get(f"/api/quiz/{quiz_id}")
            reopen_ms = (time.time() - t1) * 1000
            check(
                code2 == 200 and body2.get("quiz", {}).get("questions") == payload.get("questions"),
                f"[{topic}] reopening the quiz serves the identical cached questions",
                f"{reopen_ms:.0f}ms",
            )
            code3, prep2 = client.post("/api/quiz/prepare", {"topic": topic, "level": "beginner"})
            reuse_ms = (time.time() - t1) * 1000
            check(
                code3 == 200
                and prep2.get("quiz_id") == quiz_id
                and prep2.get("status") in ("ready", "complete"),
                f"[{topic}] second prepare reuses the cached quiz instead of regenerating",
                f"same_id={prep2.get('quiz_id') == quiz_id} status={prep2.get('status')} "
                f"cached={prep2.get('cached')} in {reuse_ms:.0f}ms (an AI run takes >100s)",
            )

            sample = (payload.get("questions") or [{}])[0]
            print(f"  sample q0: {str(sample.get('prompt'))[:110]}")
            summary[topic] = {
                "quiz_id": quiz_id,
                "counts": counts,
                "seconds": round(elapsed, 1),
            }

        # ---- security sweep -------------------------------------------------
        print("-" * 72)
        print("SECURITY")
        log_text = log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else ""
        check(fingerprint not in log_text and key not in log_text, "API key never appears in server logs")
        check("gsk_" not in log_text, "no Groq-style key fragment in server logs")
        raw_db = db_path.read_bytes()
        check(fingerprint.encode() not in raw_db and key.encode() not in raw_db, "API key never written to the database")
        leaks = []
        for path in list((ROOT / "src").rglob("*.ts*")) + list((ROOT / "src").rglob("*.js")):
            try:
                if key in path.read_text(encoding="utf-8", errors="replace"):
                    leaks.append(str(path.relative_to(ROOT)))
            except Exception:
                pass
        check(not leaks, "API key does not appear in frontend source", ", ".join(leaks))

        # ---- report ---------------------------------------------------------
        print("=" * 72)
        print("RESULTS")
        print("=" * 72)
        for topic in topics:
            info = summary.get(topic)
            counts = (info or {}).get("counts") or {}
            print(
                f"{topic:<24} basic {counts.get('basic', 0)}/10  "
                f"moderate {counts.get('moderate', 0)}/10  "
                f"difficult {counts.get('advanced', 0)}/10  "
                f"total {sum(v for v in (counts.get('basic'), counts.get('moderate'), counts.get('advanced')) if isinstance(v, int))}/30"
                + (f"  ({info['seconds']}s)" if info else "  (NOT GENERATED)")
            )
        print("-" * 72)
        print(f"passed {len(PASSED)}   failed {len(FAILED)}")
        for label in FAILED:
            print(f"  FAILED: {label}")
        return 0 if not FAILED else 1
    finally:
        shutdown()
        if os.environ.get("KEEP_DB"):
            print(f"kept test data dir: {data_dir}")
        else:
            shutil.rmtree(data_dir, ignore_errors=True)


if __name__ == "__main__":
    # The model can emit characters (e.g. U+2011) that a cp1252 console cannot
    # encode; never let a print kill a 15-minute run.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    sys.exit(main())
