"""
quiz_service.py - FocusLearn topic quiz persistence + orchestration.

Owns the server-authoritative state for per-topic quizzes:

- Topic quizzes are generated in a BACKGROUND daemon thread so learning
  content always opens instantly; the quiz becomes READY when the parallel
  generation (basic / moderate / advanced batches) is validated and combined.
- A READY quiz for a user+topic is cached and reused - Groq is never called
  again just because a topic is reopened.
- Submitted answers are the ONLY thing that counts as an attempt, and they
  drive the progressive difficulty unlock (all server-side):
      moderate unlocked  ->  basic attempts   >= 3
      advanced unlocked  ->  basic attempts   >= 3 AND moderate attempts >= 3
- Wrong answers still count as attempts; correctness only feeds performance
  analysis, never the unlock.

Storage extends the existing SQLite DB (``auth.DB_PATH``) with two tables.
All rows are scoped by ``user_id`` so users never see each other's data.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import threading
from datetime import datetime, timezone

import groq_service

DIFFICULTIES: tuple[str, ...] = ("basic", "moderate", "advanced")

# Attempts required to unlock the next difficulty tier.
BASIC_UNLOCK_THRESHOLD = 3
MODERATE_UNLOCK_THRESHOLD = 3

DB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "focuslearn.db"
)

# In-flight generation threads: (user_id, topic) -> quiz_id. Prevents two
# requests from generating the same quiz twice.
_generating: dict[tuple, str] = {}
_generating_lock = threading.Lock()


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create quiz tables (idempotent). Call after auth.init_db()."""
    conn = _connect()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS topic_quizzes (
            id                TEXT PRIMARY KEY,
            user_id           TEXT NOT NULL,
            topic             TEXT NOT NULL,
            lesson_id         TEXT NOT NULL,
            level             TEXT NOT NULL DEFAULT 'beginner',
            goal_id           TEXT,
            roadmap_id        TEXT,
            generation_status TEXT NOT NULL DEFAULT 'generating',
            question_count    INTEGER NOT NULL DEFAULT 0,
            duration_seconds  INTEGER,
            questions_json    TEXT,
            submission_json   TEXT,
            retest_of         TEXT,
            focus_concepts    TEXT,
            error             TEXT,
            created_at        TEXT NOT NULL,
            updated_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_topic_quizzes_user_topic
            ON topic_quizzes(user_id, topic);
        CREATE INDEX IF NOT EXISTS idx_topic_quizzes_user_lesson
            ON topic_quizzes(user_id, lesson_id);

        CREATE TABLE IF NOT EXISTS quiz_answers (
            quiz_id        TEXT NOT NULL REFERENCES topic_quizzes(id) ON DELETE CASCADE,
            question_index INTEGER NOT NULL,
            difficulty     TEXT NOT NULL,
            selected_index INTEGER NOT NULL,
            correct_index  INTEGER NOT NULL,
            is_correct     INTEGER NOT NULL,
            answered_at    TEXT NOT NULL,
            PRIMARY KEY (quiz_id, question_index)
        );
        """
    )
    conn.commit()
    conn.close()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(topic: str) -> str:
    """Mirrors the frontend topicQuizLessonId slug (topic-<slug>)."""
    slug = re.sub(r"[^a-z0-9\s]", " ", topic.lower())
    slug = re.sub(r"\s+", " ", slug).strip().replace(" ", "-")
    return slug


def lesson_id_for_topic(topic: str) -> str:
    return f"topic-{_slug(topic)}"


def _unlock_state(answers: list[sqlite3.Row]) -> dict:
    attempts = {d: 0 for d in DIFFICULTIES}
    for row in answers:
        attempts[row["difficulty"]] = attempts.get(row["difficulty"], 0) + 1
    moderate_unlocked = attempts["basic"] >= BASIC_UNLOCK_THRESHOLD
    advanced_unlocked = (
        attempts["basic"] >= BASIC_UNLOCK_THRESHOLD
        and attempts["moderate"] >= MODERATE_UNLOCK_THRESHOLD
    )
    return {
        "attempts": attempts,
        "unlocked": {
            "basic": True,
            "moderate": moderate_unlocked,
            "advanced": advanced_unlocked,
        },
    }


def _status_payload(row) -> dict:
    questions = _load_questions(row)
    answers = _load_answers(row["id"])
    unlock = _unlock_state(answers)
    total = row["question_count"] or (len(questions) if questions else 0)
    difficulty_counts = {d: 0 for d in DIFFICULTIES}
    for q in questions:
        difficulty_counts[q.get("difficulty", "")] = (
            difficulty_counts.get(q.get("difficulty", ""), 0)
        )
    try:
        focus_concepts = json.loads(row["focus_concepts"]) if row["focus_concepts"] else []
    except (TypeError, ValueError):
        focus_concepts = []
    return {
        "quiz_id": row["id"],
        "topic": row["topic"],
        "lesson_id": row["lesson_id"],
        "state": row["generation_status"],
        "error": row["error"],
        "total": total,
        "question_count": row["question_count"],
        "retest_of": row["retest_of"],
        "focus_concepts": focus_concepts,
        "completed": len(answers) >= total > 0,
        "attempts": unlock["attempts"],
        "unlocked": unlock["unlocked"],
        "difficulty_counts": difficulty_counts,
        "answers": [
            {
                "index": a["question_index"],
                "difficulty": a["difficulty"],
                "selected_index": a["selected_index"],
                "correct_index": a["correct_index"],
                "is_correct": a["is_correct"],
                "answered_at": a["answered_at"],
            }
            for a in answers
        ],
    }


def _load_questions(row) -> list[dict]:
    if not row or not row["questions_json"]:
        return []
    try:
        return json.loads(row["questions_json"])
    except (TypeError, ValueError):
        return []


def _load_answers(quiz_id: str) -> list[sqlite3.Row]:
    conn = _connect()
    rows = conn.execute(
        "SELECT question_index, difficulty, selected_index, correct_index, "
        "is_correct, answered_at FROM quiz_answers WHERE quiz_id = ? "
        "ORDER BY question_index",
        (quiz_id,),
    ).fetchall()
    conn.close()
    return rows


# ── Generation (background) ─────────────────────────────────────────────

def _run_generation(
    key: tuple,
    quiz_id: str,
    topic: str,
    level: str,
    focus_concepts: list[str],
) -> None:
    """Generate + validate + save a quiz, then mark it READY or FAILED."""
    try:
        quiz = groq_service.generate_parallel_topic_quiz(
            topic=topic,
            level=level,
            total=30,
            focus_concepts=focus_concepts,
        )
        questions = quiz.get("questions", [])
        # Normalize before persisting (server-authoritative validation).
        normalized: list[dict] = []
        counts: dict[str, int] = {d: 0 for d in DIFFICULTIES}
        for index, q in enumerate(questions, start=1):
            difficulty = q.get("difficulty")
            if difficulty not in DIFFICULTIES:
                continue
            prompt = str(q.get("prompt", "")).strip()[:600]
            options = [str(o) for o in q.get("options", []) if str(o)]
            explanation = str(q.get("explanation", "")).strip()[:600]
            try:
                correct = int(q.get("correctIndex"))
            except (TypeError, ValueError):
                continue
            if len(prompt) < 5 or len(options) < 2 or not explanation:
                continue
            if not (0 <= correct < len(options)):
                continue
            counts[difficulty] += 1
            normalized.append(
                {
                    "id": f"{difficulty}-{counts[difficulty]}",
                    "prompt": prompt,
                    "options": [o[:300] for o in options[:6]],
                    "correctIndex": correct,
                    "explanation": explanation,
                    "difficulty": difficulty,
                    "concept": str(q.get("concept", "") or "").strip()[:80] or topic,
                }
            )
        if counts != {d: 10 for d in DIFFICULTIES}:
            raise RuntimeError(
                "The generated quiz did not contain exactly 10 basic, 10 moderate "
                "and 10 advanced questions. Quiz preparation failed."
            )
        conn = _connect()
        conn.execute(
            "UPDATE topic_quizzes SET generation_status = 'ready', "
            "questions_json = ?, question_count = ?, error = NULL, updated_at = ? "
            "WHERE id = ?",
            (
                json.dumps(normalized),
                len(normalized),
                _now(),
                quiz_id,
            ),
        )
        conn.commit()
        conn.close()
    except groq_service.GroqConfigurationError:
        _mark_failed(quiz_id, "AI quiz generation is not configured on the server.")
    except groq_service.QuizRateLimitError:
        # Fail fast with a friendly message instead of a long/hanging retry.
        _mark_failed(quiz_id, groq_service.RATE_LIMIT_MESSAGE)
    except Exception as exc:  # noqa: BLE001 - any failure -> FAILED, never crash
        _mark_failed(quiz_id, str(exc) or "Quiz preparation failed.")
    finally:
        with _generating_lock:
            _generating.pop(key, None)


def _mark_failed(quiz_id: str, message: str) -> None:
    conn = _connect()
    conn.execute(
        "UPDATE topic_quizzes SET generation_status = 'failed', error = ?, "
        "updated_at = ? WHERE id = ?",
        (message[:400], _now(), quiz_id),
    )
    conn.commit()
    conn.close()


def _is_generating(key: tuple) -> str | None:
    with _generating_lock:
        return _generating.get(key)


def _start_generation(
    key: tuple,
    quiz_id: str,
    topic: str,
    level: str,
    focus_concepts: list[str],
) -> None:
    with _generating_lock:
        _generating[key] = quiz_id
    threading.Thread(
        target=_run_generation,
        args=(key, quiz_id, topic, level, focus_concepts),
        daemon=True,
    ).start()


# ── Public API ──────────────────────────────────────────────────────────

def prepare_quiz(
    user_id: str,
    topic: str,
    level: str = "beginner",
    goal_id: str | None = None,
    roadmap_id: str | None = None,
    focus_concepts: list[str] | None = None,
    retest_of: str | None = None,
) -> dict:
    """Idempotent: returns an existing READY quiz without re-generating.

    Returns ``{"quiz_id", "status"}`` where status is ``ready`` (cached and
    immediately usable) or ``generating`` (background thread running).
    """
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("A topic is required to prepare a quiz.")
    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]
    level = (level or "beginner").strip()[:20] or "beginner"
    slug = _slug(topic)
    lesson_id = f"topic-{slug}"

    conn = _connect()
    now = _now()

    if retest_of:
        # Reuse an identical in-progress/ready retest if one exists. The
        # retest is identified by its parent quiz — the weak concepts it was
        # focused on are already stored on that retest row, so callers only
        # need to pass the parent quiz id (no concepts required).
        key = (user_id, topic, "retest", retest_of)
        active = _is_generating(key)
        if active:
            conn.close()
            return {"quiz_id": active, "status": "generating"}
        existing = conn.execute(
            "SELECT id, generation_status FROM topic_quizzes "
            "WHERE user_id = ? AND topic = ? AND retest_of = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, topic, retest_of),
        ).fetchone()
        if existing and existing["generation_status"] == "ready":
            conn.close()
            return {"quiz_id": existing["id"], "status": "ready"}
    else:
        # Primary quiz cache: reuse the latest validated quiz for this topic.
        existing = conn.execute(
            "SELECT id, generation_status FROM topic_quizzes "
            "WHERE user_id = ? AND topic = ? AND retest_of IS NULL "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, topic),
        ).fetchone()
        if existing:
            if existing["generation_status"] == "ready":
                conn.close()
                return {"quiz_id": existing["id"], "status": "ready"}
            if existing["generation_status"] == "generating":
                key = (user_id, topic)
                active = _is_generating(key)
                if active:
                    conn.close()
                    return {"quiz_id": existing["id"], "status": "generating"}

    quiz_id = f"qz-{secrets.token_hex(6)}"
    conn.execute(
        "INSERT INTO topic_quizzes "
        "(id, user_id, topic, lesson_id, level, goal_id, roadmap_id, "
        " generation_status, retest_of, focus_concepts, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?)",
        (
            quiz_id,
            user_id,
            topic,
            lesson_id,
            level,
            goal_id,
            roadmap_id,
            retest_of,
            json.dumps(focus_concepts) if focus_concepts else None,
            now,
            now,
        ),
    )
    conn.commit()
    conn.close()

    # Only one generation at a time per user+topic.
    if retest_of:
        key = (user_id, topic, "retest", retest_of)
    else:
        key = (user_id, topic)
    if _is_generating(key):
        return {"quiz_id": quiz_id, "status": "generating"}
    _start_generation(key, quiz_id, topic, level, focus_concepts)
    return {"quiz_id": quiz_id, "status": "generating"}


def get_status(user_id: str, quiz_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    conn.close()
    return _status_payload(row) if row else None


def get_status_for_topic(user_id: str, topic: str) -> dict:
    topic = (topic or "").strip()
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
        "AND retest_of IS NULL ORDER BY created_at DESC",
        (user_id, topic),
    ).fetchall()
    retest_row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
        "AND retest_of IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        (user_id, topic),
    ).fetchone()
    conn.close()

    # Prefer a settled row (ready/failed); fall back to the active in-flight
    # generation and skip orphaned 'generating' rows left by interrupted runs.
    active_key = _is_generating((user_id, topic))
    row = next(
        (r for r in rows if r["generation_status"] in ("ready", "failed")),
        None,
    ) or next(
        (r for r in rows if r["generation_status"] == "generating" and r["id"] == active_key),
        None,
    )

    if not row:
        return {
            "state": "none",
            "quiz_id": None,
            "topic": topic,
            "lesson_id": lesson_id_for_topic(topic),
            "retest_ready": bool(retest_row and retest_row["generation_status"] == "ready"),
        }
    payload = _status_payload(row)
    payload["retest_ready"] = bool(retest_row and retest_row["generation_status"] == "ready")
    return payload


def get_quiz(user_id: str, quiz_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    conn.close()
    if not row or row["generation_status"] != "ready":
        return None
    questions = _load_questions(row)
    return {
        "id": row["id"],
        "topic": row["topic"],
        "lesson_id": row["lesson_id"],
        "level": row["level"],
        "retest_of": row["retest_of"],
        "focus_concepts": (
            json.loads(row["focus_concepts"]) if row["focus_concepts"] else []
        ),
        "total": len(questions),
        "questions": questions,
    }


def record_answer(
    user_id: str, quiz_id: str, question_index: int, selected_index: int
) -> dict | None:
    """Upsert one submitted answer. Returns updated state + feedback."""
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    if not row or row["generation_status"] != "ready":
        conn.close()
        return None
    questions = _load_questions(row)
    if not (0 <= question_index < len(questions)):
        conn.close()
        raise IndexError("Question index out of range.")
    question = questions[question_index]
    options = question["options"]
    if not (0 <= selected_index < len(options)):
        conn.close()
        raise IndexError("Selected answer out of range.")

    is_correct = 1 if selected_index == question["correctIndex"] else 0
    answered_at = _now()
    conn.execute(
        "INSERT INTO quiz_answers "
        "(quiz_id, question_index, difficulty, selected_index, correct_index, "
        " is_correct, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(quiz_id, question_index) DO UPDATE SET "
        " selected_index = excluded.selected_index, correct_index = excluded.correct_index, "
        " is_correct = excluded.is_correct, answered_at = excluded.answered_at",
        (
            quiz_id,
            question_index,
            question["difficulty"],
            selected_index,
            question["correctIndex"],
            is_correct,
            answered_at,
        ),
    )
    conn.commit()
    conn.close()

    status = _status_payload(row)  # reads fresh answers from DB
    return {
        "index": question_index,
        "difficulty": question["difficulty"],
        "selected_index": selected_index,
        "correct_index": question["correctIndex"],
        "is_correct": bool(is_correct),
        "explanation": question.get("explanation", ""),
        "concept": question.get("concept", ""),
        "attempts": status["attempts"],
        "unlocked": status["unlocked"],
        "completed": status["completed"],
    }


def submit_quiz(user_id: str, quiz_id: str) -> dict | None:
    """Authoritative scoring from stored answers. Returns submission result."""
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    if not row or row["generation_status"] != "ready":
        conn.close()
        return None
    questions = _load_questions(row)
    answers = _load_answers(quiz_id)
    total = len(questions)
    index_of = {a["question_index"]: a for a in answers}

    breakdown = {d: {"correct": 0, "total": 0} for d in DIFFICULTIES}
    weak_concepts: list[str] = []
    strong_concepts: list[str] = []
    correct = 0

    for idx, q in enumerate(questions):
        difficulty = q.get("difficulty")
        if difficulty not in breakdown:
            continue
        breakdown[difficulty]["total"] += 1
        ans = index_of.get(idx)
        if ans and ans["is_correct"]:
            correct += 1
            breakdown[difficulty]["correct"] += 1
            concept = q.get("concept", "")
            if concept and concept not in strong_concepts:
                strong_concepts.append(concept)
        elif ans:
            concept = q.get("concept", "")
            if concept and concept not in weak_concepts:
                weak_concepts.append(concept)

    answered = len(answers)
    percentage = round((correct / total) * 100) if total else 0
    submission = {
        "score": correct,
        "total": total,
        "answered": answered,
        "percentage": percentage,
        "breakdown": breakdown,
        "weak_concepts": weak_concepts,
        "strong_concepts": strong_concepts,
        "completed": answered >= total,
    }
    conn.execute(
        "UPDATE topic_quizzes SET submission_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(submission), _now(), quiz_id),
    )
    conn.commit()
    conn.close()
    return submission