"""
quiz_service.py - FocusLearn quiz persistence + orchestration (10/10/10 per goal).

Server-authoritative state for every goal/topic quiz:

- Structure contract: every quiz holds EXACTLY 10 basic + 10 moderate + 10
  difficult (difficult == the "Difficult" tier the UI shows) = 30 validated
  question records, each with 4 options, exactly 1 correct answer and an
  original explanation. A set is only ``COMPLETE`` when validation passes.
- Generation runs in a BACKGROUND daemon thread and tier by tier: each tier is
  validated and persisted as soon as it is ready, so a later failure never
  discards questions already produced. Stages:
  ``preparing -> basic_ready -> moderate_ready -> difficult_ready -> complete``
  (or ``failed``), reported to clients as ``state`` + ``stage``.
- A validated quiz for a user+goal/topic is cached and reused - Groq is never
  called again just because a quiz is reopened, and a reopened quiz always
  presents the same questions.
- Submitted answers are the ONLY thing that counts as an attempt, and they
  drive the progressive difficulty unlock (all server-side):
      moderate unlocked  ->  basic attempts   >= 3
      difficult unlocked ->  basic attempts   >= 3 AND moderate attempts >= 3
  Wrong answers still count as attempts; correctness only feeds performance
  analysis, never the unlock.
- Originality: every candidate question is normalised and checked against the
  questions already stored for this user/goal/topic (all tiers, all previous
  runs) by ``quiz_originality``. Duplicates and near-duplicates are rejected
  and replaced; concept-level overlap alone is accepted. Nothing copied from
  an external source is ever requested or stored - questions are authored by
  the model from general subject knowledge and stored with
  ``source_type = 'ai_generated_original'``.
- Rate limits: generation runs under a bounded budget (few calls, short
  retries, hard deadline). On HTTP 429 the run stops immediately and the
  stored questions are reused - there is never a long retry loop and never a
  placeholder question.

Storage extends the existing SQLite DB (``auth.DB_PATH``) with three tables:
``topic_quizzes`` (one row per quiz), ``quiz_questions`` (one row per question
record) and ``quiz_answers`` (one row per submitted answer). All rows are
scoped by ``user_id`` so users never see each other's data.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import traceback
import uuid
from datetime import datetime, timezone

import groq_service
import quiz_originality
import curated_dsa
import curated_webdev

# Difficulty tiers, easiest first. "advanced" is stored/served as the
# Difficult tier; the name is kept for backwards compatibility with existing
# rows, answers and clients.
DIFFICULTIES: tuple[str, ...] = groq_service.QUIZ_DIFFICULTIES
QUESTIONS_PER_DIFFICULTY = groq_service.QUESTIONS_PER_DIFFICULTY
OPTIONS_PER_QUESTION = groq_service.OPTIONS_PER_QUESTION
QUIZ_TOTAL = groq_service.GOAL_QUIZ_TOTAL
SOURCE_TYPE_AI_ORIGINAL = groq_service.SOURCE_TYPE_AI_ORIGINAL
SOURCE_TYPE_MANUAL = "manually_supplied"

DIFFICULTY_LABEL = {"basic": "Basic", "moderate": "Moderate", "advanced": "Difficult"}

# Attempts required to unlock the next difficulty tier.
BASIC_UNLOCK_THRESHOLD = 3
MODERATE_UNLOCK_THRESHOLD = 3

# Extra questions requested per tier so a question rejected as duplicate or as
# off-goal can be replaced inside the same bounded run.
_REPLACEMENT_SPARES = 2

# Budget for one background 10/10/10 run. groq_service's default budget is sized
# for a SINGLE tier, but a full quiz is three tiers back to back, so that default
# expires part-way through the third one and the run ends with a short Difficult
# tier (3/10, 5/10) instead of an error. Sizing it for the whole job costs nothing
# in responsiveness: generation happens in a background thread, the prepare
# request has already returned, and the status endpoint reports the stage while
# this runs. Still bounded - it can never loop forever.
_BACKGROUND_MAX_RUN_CALLS = 24  # 3 tiers x up to 6 batch attempts, with headroom
_BACKGROUND_DEADLINE_SECONDS = 420.0

# Generation stages reported alongside the coarse state.
STAGE_PREPARING = "preparing"
STAGE_BASIC_READY = "basic_ready"
STAGE_MODERATE_READY = "moderate_ready"
STAGE_DIFFICULT_READY = "difficult_ready"
STAGE_COMPLETE = "complete"
STAGE_FAILED = "failed"

# Question schema version, bumped when the stored shape changes.
SCHEMA_VERSION = 2


class QuizLockedError(RuntimeError):
    """A question from a locked difficulty tier was submitted."""


def _lock_message(difficulty: str, unlock: dict) -> str:
    label = DIFFICULTY_LABEL.get(difficulty, difficulty)
    if difficulty == "moderate":
        done = min(unlock["attempts"]["basic"], BASIC_UNLOCK_THRESHOLD)
        return (
            f"{label} unlocks after {BASIC_UNLOCK_THRESHOLD} Basic attempts "
            f"({done}/{BASIC_UNLOCK_THRESHOLD} done)."
        )
    done = min(unlock["attempts"]["moderate"], MODERATE_UNLOCK_THRESHOLD)
    return (
        f"{label} unlocks after {MODERATE_UNLOCK_THRESHOLD} Moderate attempts "
        f"({done}/{MODERATE_UNLOCK_THRESHOLD} done)."
    )

# FOCUSLEARN_DATA_DIR lets a deployment (or a test) put the SQLite file
# somewhere writable and isolated - Vercel needs /tmp, tests need a temp dir.
# Unset, it keeps the historical backend/data/focuslearn.db location, which is
# the same file auth.DB_PATH uses.
_DATA_DIR = (os.environ.get("FOCUSLEARN_DATA_DIR") or "").strip()
DB_PATH = os.path.join(
    _DATA_DIR if _DATA_DIR else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"),
    "focuslearn.db",
)

# In-flight generation threads: (user_id, scope_key) -> quiz_id. Prevents two
# requests from generating the same quiz twice.
_generating: dict[tuple, str] = {}
_generating_lock = threading.Lock()

# Columns added after the first release; added in place for existing databases.
_ADDED_QUIZ_COLUMNS = (
    ("source_type", "TEXT"),
    ("generation_stage", "TEXT"),
    ("schema_version", "INTEGER"),
    ("scope", "TEXT"),
    ("validated_at", "TEXT"),
    ("goal_context", "TEXT"),
)


def _connect() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    """Create quiz tables and add new columns (idempotent)."""
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
        CREATE TABLE IF NOT EXISTS quiz_questions (
            id            TEXT PRIMARY KEY,
            quiz_id       TEXT NOT NULL REFERENCES topic_quizzes(id) ON DELETE CASCADE,
            user_id       TEXT NOT NULL,
            goal_id       TEXT,
            topic_id      TEXT,
            topic         TEXT NOT NULL,
            difficulty    TEXT NOT NULL,
            position      INTEGER NOT NULL,
            tier_position INTEGER NOT NULL,
            prompt        TEXT NOT NULL,
            options_json  TEXT NOT NULL,
            correct_index INTEGER NOT NULL,
            explanation   TEXT NOT NULL,
            concept       TEXT,
            fingerprint   TEXT NOT NULL,
            source_type   TEXT NOT NULL DEFAULT 'ai_generated_original',
            created_at    TEXT NOT NULL,
            UNIQUE (quiz_id, position)
        );
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
    _add_missing_columns(
        conn,
        "topic_quizzes",
        _ADDED_QUIZ_COLUMNS,
        defaults={"scope": "topic", "generation_stage": STAGE_PREPARING, "schema_version": SCHEMA_VERSION},
    )
    _add_missing_columns(conn, "quiz_answers", (("question_id", "TEXT"),))
    _add_missing_columns(
        conn,
        "topic_quizzes",
        (("originality_json", "TEXT"),),
    )
    conn.executescript(
        """
        CREATE INDEX IF NOT EXISTS idx_topic_quizzes_user_topic
            ON topic_quizzes(user_id, topic);
        CREATE INDEX IF NOT EXISTS idx_topic_quizzes_user_lesson
            ON topic_quizzes(user_id, lesson_id);
        CREATE INDEX IF NOT EXISTS idx_topic_quizzes_user_goal
            ON topic_quizzes(user_id, goal_id);
        CREATE INDEX IF NOT EXISTS idx_quiz_questions_quiz
            ON quiz_questions(quiz_id, position);
        CREATE INDEX IF NOT EXISTS idx_quiz_questions_user
            ON quiz_questions(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_quiz_questions_goal
            ON quiz_questions(goal_id, difficulty);
        CREATE INDEX IF NOT EXISTS idx_quiz_questions_fingerprint
            ON quiz_questions(fingerprint);
        """
    )
    conn.commit()
    conn.close()


def _add_missing_columns(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[tuple[str, str], ...],
    defaults: dict[str, object] | None = None,
) -> None:
    """Additive, in-place migration: existing rows and databases keep working."""
    existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
    defaults = defaults or {}
    for name, column_type in columns:
        if name in existing:
            continue
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {column_type}")
        default = defaults.get(name)
        if default is not None:
            conn.execute(f"UPDATE {table} SET {name} = ?", (default,))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(topic: str) -> str:
    """Mirrors the frontend topicQuizLessonId slug (topic-<slug>)."""
    slug = re.sub(r"[^a-z0-9\s]", " ", (topic or "").lower())
    return re.sub(r"\s+", " ", slug).strip().replace(" ", "-")


def lesson_id_for_topic(topic: str) -> str:
    return f"topic-{_slug(topic)}"


def lesson_id_for_goal(goal_id: str) -> str:
    """The attempt lesson id of a goal's own quiz.

    A goal quiz is a different record from the topic quizzes inside that goal,
    and a goal title often equals one of its topic names ("Web Development").
    Giving the goal quiz its own id keeps the two scores apart in attempts and
    performance analysis. Mirrors the frontend goalQuizLessonId().
    """
    return f"goal-quiz-{_slug(goal_id) or 'goal'}"


def new_question_id() -> str:
    return f"q-{uuid.uuid4().hex[:12]}"


# ── Goal context ───────────────────────────────────────────────────────────

def goal_quiz_context(goal: dict) -> str:
    """Learning context used to keep generated questions on-goal.

    Built from the goal itself: title, description, the student's own wording
    (goal context / existing knowledge), the experience level and the roadmap
    topics. Custom goals therefore produce questions about the custom goal.
    """
    if not goal:
        return ""
    lines: list[str] = []
    title = str(goal.get("title") or "").strip()
    if title:
        lines.append(f"GOAL TITLE: {title}")
    description = str(goal.get("description") or "").strip()
    if description:
        lines.append(f"GOAL DESCRIPTION: {description}")
    context = str(goal.get("goalContext") or "").strip()
    if context:
        lines.append(f"STUDENT'S OWN GOAL: {context}")
    knowledge = str(goal.get("existingKnowledge") or "").strip()
    if knowledge:
        lines.append(f"STUDENT ALREADY KNOWS: {knowledge}")
    level = str(goal.get("experienceLevel") or "").strip()
    if level:
        lines.append(f"EXPERIENCE LEVEL: {level}")

    topics: list[str] = []
    roadmap = goal.get("roadmap")
    if isinstance(roadmap, dict):
        for phase in roadmap.get("phases") or []:
            if not isinstance(phase, dict):
                continue
            for topic in phase.get("topics") or []:
                if isinstance(topic, dict):
                    name = str(topic.get("title") or "").strip()
                    if name:
                        topics.append(name)
                elif isinstance(topic, str):
                    topics.append(topic.strip())
    if topics:
        lines.append("ROADMAP TOPICS (spread coverage across them): " + ", ".join(topics[:40]))
    return "\n".join(lines)[:2000]


# ── Validation ─────────────────────────────────────────────────────────────

def _normalize_question(raw: dict, difficulty: str, position: int, topic: str) -> dict | None:
    """Coerce one stored/parsed question into the canonical question shape."""
    prompt = str(raw.get("prompt") or raw.get("question") or "").strip()[:600]
    options = [str(o).strip()[:300] for o in (raw.get("options") or []) if str(o).strip()]
    explanation = str(raw.get("explanation") or "").strip()[:600]
    if len(prompt) < 15 or len(options) != OPTIONS_PER_QUESTION or len(explanation) < 10:
        return None
    try:
        correct = int(raw.get("correctIndex"))
    except (TypeError, ValueError):
        return None
    if not (0 <= correct < OPTIONS_PER_QUESTION):
        return None
    if difficulty not in DIFFICULTIES:
        return None
    return {
        "prompt": prompt,
        "options": options,
        "correctIndex": correct,
        "explanation": explanation,
        "difficulty": difficulty,
        "concept": str(raw.get("concept") or "").strip()[:80] or topic,
    }


def _topic_keywords(topic: str, extra: list[str] | None = None) -> frozenset[str]:
    """Meaningful words that keep a question on-goal (empty = no gate)."""
    keywords = set(quiz_originality.topic_keywords(topic or ""))
    for item in extra or []:
        keywords |= set(quiz_originality.topic_keywords(str(item)))
    return frozenset(k for k in keywords if len(k) >= 3)


def question_tier_counts(questions: list[dict]) -> dict[str, int]:
    counts = {d: 0 for d in DIFFICULTIES}
    for question in questions:
        difficulty = question.get("difficulty")
        if difficulty in counts:
            counts[difficulty] += 1
    return counts


def validate_quiz_set(
    questions: list[dict],
    topic: str = "",
    topic_tokens: list[str] | None = None,
    enforce_relevance: bool = True,
    enforce_originality: bool = True,
) -> dict:
    """Full validation of a stored question set.

    A set is COMPLETE only when: 10/10/10 questions, every question non-empty,
    exactly 4 options each, exactly one correct option, no duplicate question
    ids, no duplicate/near-duplicate wording, every difficulty matches its
    tier, and the set is on-topic.

    ``enforce_relevance`` is turned off when re-checking a set that is already
    stored. Whether a question is on-goal is decided when it is written (new
    questions are filtered per question and a set is only stored once it
    passes), so re-judging stored questions with a keyword heuristic can only
    condemn sets that were already accepted - and there is no way to "fix"
    relevance without throwing away questions a student has already answered.
    The ratio is still measured and reported either way.

    ``enforce_originality`` is turned off ONLY for the hand-supplied curated DSA
    set. Those questions are authoritative curriculum text (not model-authored)
    and deliberately reuse shared MCQ wording templates (e.g. "Which data
    structure ...?", "What is the worst-case time complexity of ...?"), which
    the passed-but-never-reviewed near-duplicate heuristic flags even though
    every question asks something different. Originality is still measured and
    reported for the curated set; it is just not treated as a hard failure.
    """
    report: dict = {
        "counts": {d: 0 for d in DIFFICULTIES},
        "problems": [],
        "originality": None,
        "on_topic_ratio": 1.0,
        "complete": False,
    }
    if not isinstance(questions, list):
        report["problems"].append("questions missing")
        return report

    seen_ids: set[str] = set()
    prompts: list[str] = []
    for index, question in enumerate(questions):
        difficulty = question.get("difficulty")
        if difficulty not in DIFFICULTIES:
            report["problems"].append(f"question {index}: unknown difficulty")
            continue
        report["counts"][difficulty] += 1
        prompt = str(question.get("prompt") or "").strip()
        if len(prompt) < 15:
            report["problems"].append(f"question {index}: empty question text")
        explanation = str(question.get("explanation") or "").strip()
        if not explanation:
            report["problems"].append(f"question {index}: missing explanation")
        options = question.get("options") or []
        if len(options) != OPTIONS_PER_QUESTION:
            report["problems"].append(
                f"question {index}: {len(options)} options (expected {OPTIONS_PER_QUESTION})"
            )
        elif any(not str(o).strip() for o in options):
            report["problems"].append(f"question {index}: empty option")
        correct = question.get("correctIndex")
        if not isinstance(correct, int) or not (0 <= correct < len(options or [])):
            report["problems"].append(f"question {index}: no single correct option")
        question_id = str(question.get("id") or "")
        if question_id:
            if question_id in seen_ids:
                report["problems"].append(f"question {index}: duplicate question id")
            seen_ids.add(question_id)
        prompts.append(prompt)

    for difficulty, count in report["counts"].items():
        if count != QUESTIONS_PER_DIFFICULTY:
            report["problems"].append(
                f"{difficulty}: {count}/{QUESTIONS_PER_DIFFICULTY} questions"
            )

    originality = quiz_originality.validate_originality(prompts)
    report["originality"] = originality
    if not originality["original"] and enforce_originality:
        report["problems"].append(
            f"duplicate/near-duplicate questions: {originality['exact_duplicates']} exact, "
            f"{originality['near_duplicates']} near-duplicate"
        )

    keywords = (
        frozenset(t for t in topic_tokens if len(t) >= 3)
        if topic_tokens is not None
        else _topic_keywords(topic)
    )
    if keywords:
        on_topic = sum(
            1
            for prompt in prompts
            if quiz_originality.matches_keywords(prompt, keywords)
        )
        ratio = on_topic / len(prompts) if prompts else 0.0
        report["on_topic_ratio"] = round(ratio, 3)
        # A question can be about the goal without reusing the goal's own words
        # (an "endpoint" question for a "REST API" goal), so only a clearly
        # drifted set fails the run.
        if ratio < 0.25:
            message = f"only {round(ratio * 100)}% of questions match the goal"
            if enforce_relevance:
                report["problems"].append(message)
            else:
                report["relevance_warning"] = message

    report["complete"] = not report["problems"]
    return report


# ── Reading state ──────────────────────────────────────────────────────────

def _load_questions(row) -> list[dict]:
    if not row or not row["questions_json"]:
        return []
    try:
        return json.loads(row["questions_json"])
    except (TypeError, ValueError):
        return []


def _load_stored_questions(quiz_id: str) -> list[dict]:
    """Question records for a quiz, ordered basic -> moderate -> difficult."""
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position",
        (quiz_id,),
    ).fetchall()
    conn.close()
    questions: list[dict] = []
    for row in rows:
        try:
            options = json.loads(row["options_json"])
        except (TypeError, ValueError):
            options = []
        questions.append(
            {
                "id": row["id"],
                "prompt": row["prompt"],
                "options": options,
                "correctIndex": row["correct_index"],
                "explanation": row["explanation"],
                "difficulty": row["difficulty"],
                "concept": row["concept"] or "",
                "source_type": row["source_type"],
            }
        )
    return questions


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


def _unlock_state(answers: list[sqlite3.Row]) -> dict:
    """Attempt counts + unlock ladder. Attempts, not correct answers, unlock."""
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


def _tier_payload(
    difficulty: str,
    questions: list[dict],
    answers: list[sqlite3.Row],
    unlock: dict,
) -> dict:
    tier_questions = [q for q in questions if q.get("difficulty") == difficulty]
    indices = {i for i, q in enumerate(questions) if q.get("difficulty") == difficulty}
    attempted = [a for a in answers if a["question_index"] in indices]
    correct = sum(1 for a in attempted if a["is_correct"])
    label = DIFFICULTY_LABEL[difficulty]
    if difficulty == "basic":
        requirement = None
    elif difficulty == "moderate":
        requirement = {
            "text": f"Unlock after {BASIC_UNLOCK_THRESHOLD} Basic attempts",
            "attempts_needed": BASIC_UNLOCK_THRESHOLD,
            "attempts_done": min(unlock["attempts"]["basic"], BASIC_UNLOCK_THRESHOLD),
        }
    else:
        requirement = {
            "text": f"Unlock after {MODERATE_UNLOCK_THRESHOLD} Moderate attempts",
            "attempts_needed": MODERATE_UNLOCK_THRESHOLD,
            "attempts_done": min(unlock["attempts"]["moderate"], MODERATE_UNLOCK_THRESHOLD),
        }
    return {
        "difficulty": difficulty,
        "label": label,
        "question_count": len(tier_questions),
        "expected_count": QUESTIONS_PER_DIFFICULTY,
        "ready": len(tier_questions) >= QUESTIONS_PER_DIFFICULTY,
        "attempts": len(attempted),
        "correct": correct,
        "unlocked": unlock["unlocked"][difficulty],
        "requirement": requirement,
    }


def _retest_ready(row) -> bool:
    """True when a ready retest quiz exists for this primary quiz.

    Goal quizzes report ``False``: the goal's 10/10/10 is the canonical
    assessment and is not retaken, so no retest row is ever created for it.
    The field is still reported so every status payload has the same shape.
    """
    if not row or row["retest_of"]:
        return False
    conn = _connect()
    ready = conn.execute(
        "SELECT 1 FROM topic_quizzes WHERE user_id = ? AND retest_of = ? "
        "AND generation_status = 'ready' LIMIT 1",
        (row["user_id"], row["id"]),
    ).fetchone()
    conn.close()
    return ready is not None


def _status_payload(row) -> dict:
    questions = _questions_for_row(row)
    answers = _load_answers(row["id"])
    unlock = _unlock_state(answers)
    total = row["question_count"] or len(questions)
    counts = question_tier_counts(questions)
    try:
        focus_concepts = json.loads(row["focus_concepts"]) if row["focus_concepts"] else []
    except (TypeError, ValueError):
        focus_concepts = []
    stage = row["generation_stage"] or (
        STAGE_COMPLETE if row["generation_status"] == "ready" else row["generation_status"]
    )
    return {
        "quiz_id": row["id"],
        "topic": row["topic"],
        "lesson_id": row["lesson_id"],
        "goal_id": row["goal_id"],
        "scope": row["scope"] or "topic",
        "state": row["generation_status"],
        "stage": stage,
        "error": row["error"],
        "total": total,
        "question_count": row["question_count"],
        "expected_total": QUIZ_TOTAL,
        "retest_of": row["retest_of"],
        "retest_ready": _retest_ready(row),
        "focus_concepts": focus_concepts,
        "source_type": row["source_type"] or SOURCE_TYPE_AI_ORIGINAL,
        "completed": len(answers) >= total > 0,
        "attempts": unlock["attempts"],
        "unlocked": unlock["unlocked"],
        "difficulty_counts": counts,
        "tiers": [
            _tier_payload(difficulty, questions, answers, unlock)
            for difficulty in DIFFICULTIES
        ],
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


def _store_questions(
    quiz_id: str,
    user_id: str,
    topic: str,
    questions: list[dict],
    goal_id: str | None = None,
    source_type: str = SOURCE_TYPE_AI_ORIGINAL,
) -> list[dict]:
    """Persist question records (idempotent per position) + the JSON view.

    Every question gets a stable id the FIRST time it is stored; the id is
    written back into the passed dicts (and into ``questions_json``) so later
    top-ups keep the same identity and previously submitted answers stay bound
    to the same question.
    """
    conn = _connect()
    now = _now()
    conn.execute("DELETE FROM quiz_questions WHERE quiz_id = ?", (quiz_id,))
    tier_positions = {d: 0 for d in DIFFICULTIES}
    for position, question in enumerate(questions):
        difficulty = question.get("difficulty", "basic")
        tier_positions[difficulty] = tier_positions.get(difficulty, 0) + 1
        question_id = str(question.get("id") or "").strip() or new_question_id()
        question["id"] = question_id
        question.setdefault("source_type", source_type)
        conn.execute(
            "INSERT OR REPLACE INTO quiz_questions "
            "(id, quiz_id, user_id, goal_id, topic_id, topic, difficulty, position, "
            " tier_position, prompt, options_json, correct_index, explanation, concept, "
            " fingerprint, source_type, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                question_id,
                quiz_id,
                user_id,
                goal_id,
                lesson_id_for_topic(topic),
                topic,
                difficulty,
                position,
                tier_positions[difficulty],
                question["prompt"],
                json.dumps(question["options"]),
                int(question["correctIndex"]),
                question["explanation"],
                question.get("concept") or "",
                quiz_originality.normalize_text(question["prompt"]),
                source_type,
                now,
            ),
        )
    conn.execute(
        "UPDATE topic_quizzes SET questions_json = ?, question_count = ?, "
        "source_type = ?, schema_version = ?, updated_at = ? WHERE id = ?",
        (
            json.dumps(questions),
            len(questions),
            source_type,
            SCHEMA_VERSION,
            now,
            quiz_id,
        ),
    )
    conn.commit()
    conn.close()
    return questions


def _questions_for_row(row) -> list[dict]:
    """Questions of a quiz, always carrying their stable ids.

    The normalised ``quiz_questions`` records are authoritative once they exist:
    they carry the stable id and are what ``validate``/``record_answer`` agree
    on. ``questions_json`` is the view used for rows written before the
    normalised table (or before a tier was stored).
    """
    if row is None:
        return []
    stored = _load_stored_questions(row["id"])
    if stored:
        return stored
    return _load_questions(row)


def _stored_prompts_for_user(user_id: str, exclude_quiz_id: str | None = None) -> list[str]:
    """Prompts previously stored for this user (all goals, all tiers)."""
    conn = _connect()
    rows = conn.execute(
        "SELECT prompt FROM quiz_questions WHERE user_id = ? "
        "AND (quiz_id IS NOT ? OR ? IS NULL) ORDER BY created_at DESC LIMIT 400",
        (user_id, exclude_quiz_id, exclude_quiz_id),
    ).fetchall()
    conn.close()
    return [row["prompt"] for row in rows]


# ── Generation (background, tier by tier) ──────────────────────────────────

def _stage_for_counts(counts: dict[str, int]) -> str:
    """Progress stage derived from how many tiers are fully generated."""
    if counts["basic"] < QUESTIONS_PER_DIFFICULTY:
        return STAGE_PREPARING
    if counts["moderate"] < QUESTIONS_PER_DIFFICULTY:
        return STAGE_BASIC_READY
    if counts["advanced"] < QUESTIONS_PER_DIFFICULTY:
        return STAGE_MODERATE_READY
    return STAGE_COMPLETE


def _set_stage(quiz_id: str, stage: str, error: str | None = None) -> None:
    state = "ready" if stage == STAGE_COMPLETE else "generating"
    conn = _connect()
    conn.execute(
        "UPDATE topic_quizzes SET generation_status = ?, generation_stage = ?, "
        "error = ?, validated_at = ?, updated_at = ? WHERE id = ?",
        (state, stage, error, _now() if stage == STAGE_COMPLETE else None, _now(), quiz_id),
    )
    conn.commit()
    conn.close()


def _mark_failed(quiz_id: str, message: str) -> None:
    """Fail the run but keep every question that was already stored."""
    conn = _connect()
    conn.execute(
        "UPDATE topic_quizzes SET generation_status = 'failed', generation_stage = ?, "
        "error = ?, updated_at = ? WHERE id = ?",
        (STAGE_FAILED, message[:400], _now(), quiz_id),
    )
    conn.commit()
    conn.close()


def _repair_plan(questions: list[dict]) -> tuple[list[tuple[str, dict | None]], int]:
    """Decide which stored questions survive, keeping their original slots.

    A stored question survives when it is objectively well formed (real text,
    an explanation, four non-empty options, exactly one correct index) and does
    not repeat another surviving question; its slot is otherwise left empty for
    a replacement. Because survivors stay in their original slots, answers
    already stored against ``question_index`` keep pointing at the same
    question when a replacement is generated.

    Without this, a set that is 10/10/10 but fails validation could never be
    repaired: the next prepare would compute "0 questions missing", store
    nothing, fail the same check, and retry the same doomed run forever.
    """
    plan: list[tuple[str, dict | None]] = []
    kept_by_tier = {d: 0 for d in DIFFICULTIES}
    seen_ids: set[str] = set()
    prompts: list[str] = []
    for question in questions:
        difficulty = question.get("difficulty")
        if difficulty not in DIFFICULTIES:
            continue
        if kept_by_tier[difficulty] >= QUESTIONS_PER_DIFFICULTY:
            # A tier longer than 10 is over capacity; the extra is replaced.
            plan.append((difficulty, None))
            continue
        prompt = str(question.get("prompt") or "").strip()
        options = question.get("options") or []
        correct = question.get("correctIndex")
        question_id = str(question.get("id") or "").strip()
        keep = True
        if len(prompt) < 15:
            keep = False
        elif not str(question.get("explanation") or "").strip():
            keep = False
        elif len(options) != OPTIONS_PER_QUESTION or any(
            not str(option).strip() for option in options
        ):
            keep = False
        elif not isinstance(correct, int) or not (0 <= correct < len(options)):
            keep = False
        elif question_id and question_id in seen_ids:
            keep = False
        elif not quiz_originality.validate_originality(prompts + [prompt])["original"]:
            keep = False
        if keep:
            kept_by_tier[difficulty] += 1
            if question_id:
                seen_ids.add(question_id)
            prompts.append(prompt)
            plan.append((difficulty, question))
        else:
            plan.append((difficulty, None))
    return plan, sum(1 for _difficulty, slot in plan if slot is None)


def _assemble_plan(
    plan: list[tuple[str, dict | None]], pools: dict[str, list[dict]]
) -> list[dict]:
    """Build the ordered set: survivors in place, replacements in their slots.

    This is a pure view of ``plan`` plus ``pools`` - it consumes nothing - so
    the caller can call it after every tier and keep accumulating the set
    instead of only ever seeing the newest tier.
    """
    ordered: list[dict] = []
    used = {d: 0 for d in DIFFICULTIES}
    in_plan = {difficulty for difficulty, _question in plan}
    for index, (difficulty, question) in enumerate(plan):
        pool = pools.get(difficulty) or []
        if question is not None:
            ordered.append(question)
        elif used[difficulty] < len(pool):
            ordered.append(pool[used[difficulty]])
            used[difficulty] += 1
        if index + 1 == len(plan) or plan[index + 1][0] != difficulty:
            # A tier that was short gains its extra questions at the end, so
            # nothing already stored has to move.
            ordered.extend(pool[used[difficulty]:])
    for difficulty in DIFFICULTIES:
        # A tier with nothing stored is not in the plan at all, so its
        # questions are emitted here, in tier order.
        if difficulty in in_plan:
            continue
        pool = pools.get(difficulty) or []
        ordered.extend(pool[used[difficulty]:])
    return ordered


def _run_generation(
    key: tuple,
    quiz_id: str,
    topic: str,
    level: str,
    focus_concepts: list[str],
    goal_context: str,
) -> None:
    """Generate, validate and persist each tier independently.

    Tier order is basic -> moderate -> difficult. Every tier is saved as soon
    as it passes validation, so a failure in a later tier keeps the earlier
    questions (stage reports how far the run got) and the next attempt only
    tops up what is missing.
    """
    try:
        row = _quiz_row(quiz_id)
        existing = _questions_for_row(row)
        stored = [q for q in existing if q.get("difficulty") in DIFFICULTIES]
        # Keep whatever is still valid and refill only the broken slots.
        plan, _broken = _repair_plan(stored)
        questions = [q for _difficulty, q in plan if q is not None]
        pools: dict[str, list[dict]] = {d: [] for d in DIFFICULTIES}
        counts = question_tier_counts(questions)
        _set_stage(quiz_id, _stage_for_counts(counts))

        budget = groq_service.GenerationBudget(
            max_calls=_BACKGROUND_MAX_RUN_CALLS,
            deadline_seconds=_BACKGROUND_DEADLINE_SECONDS,
        )
        # Never restate anything the student already keeps, for this goal or for
        # any other goal of theirs. The dropped questions are deliberately left
        # out: they are the ones being replaced, so they must not block their
        # own replacement.
        guard = quiz_originality.OriginalityGuard(
            existing=[q["prompt"] for q in questions]
            + _stored_prompts_for_user(row["user_id"], exclude_quiz_id=quiz_id)
        )
        keywords = _topic_keywords(topic, focus_concepts)

        for difficulty in DIFFICULTIES:
            needed = QUESTIONS_PER_DIFFICULTY - counts[difficulty]
            if needed > 0:
                produced = groq_service.generate_quiz_tier(
                    topic=topic,
                    difficulty=difficulty,
                    level=level,
                    # Ask for a couple of spares so a question rejected as a
                    # duplicate or as off-goal can be replaced in the same run.
                    count=needed + _REPLACEMENT_SPARES,
                    focus_concepts=focus_concepts,
                    # The contract is a list of prompt STRINGS, not question
                    # dicts: groq_service feeds this straight into the
                    # originality guard and the "do not repeat these" block of
                    # the prompt. Passing dicts here used to crash every top-up
                    # run with "'dict' object has no attribute 'strip'".
                    avoid_prompts=[q["prompt"] for q in questions]
                    + [q["prompt"] for d in DIFFICULTIES for q in pools[d]],
                    goal_context=goal_context,
                    budget=budget,
                )
                on_goal: list[dict] = []
                off_goal: list[dict] = []
                for question in produced:
                    normalized = _normalize_question(
                        question,
                        difficulty,
                        # Number sequentially across tiers so no two stored
                        # questions end up with the same generated option text.
                        len(questions) + sum(len(pools[d]) for d in DIFFICULTIES),
                        topic,
                    )
                    if normalized is None:
                        continue
                    if keywords and not quiz_originality.matches_keywords(
                        normalized["prompt"], keywords
                    ):
                        off_goal.append(normalized)
                        continue
                    on_goal.append(normalized)
                # Off-goal questions are only used when on-goal ones cannot
                # fill the tier; a drifted batch is never stored in preference
                # to an on-goal one.
                for normalized in on_goal + off_goal:
                    if counts[difficulty] >= QUESTIONS_PER_DIFFICULTY:
                        break
                    if not guard.add(normalized["prompt"]):
                        # Duplicate / near-duplicate -> a replacement is
                        # requested instead of storing a repeat.
                        continue
                    counts[difficulty] += 1
                    pools[difficulty].append(normalized)

            # Order tiers for stable positions, then persist immediately so a
            # later failure cannot lose this tier.
            questions = _assemble_plan(plan, pools)
            _store_questions(quiz_id, row["user_id"], topic, questions, row["goal_id"])
            _set_stage(quiz_id, _stage_for_counts(counts))

        report = validate_quiz_set(questions, topic, enforce_relevance=False)
        _record_validation(quiz_id, report)
        if not report["complete"]:
            raise RuntimeError(_failure_message(counts))
        _set_stage(quiz_id, STAGE_COMPLETE)
    except groq_service.GroqConfigurationError:
        _mark_failed(quiz_id, "AI quiz generation is not configured on the server.")
    except groq_service.QuizRateLimitError:
        # Fail fast with a friendly message instead of a long/hanging retry.
        _mark_failed(quiz_id, groq_service.RATE_LIMIT_MESSAGE)
    except Exception as exc:  # noqa: BLE001 - any failure -> FAILED, never crash
        # The user only ever sees the message; the stack goes to the server log so
        # an unexpected model response shape can actually be diagnosed.
        print(
            f"[quiz_service] generation failed for quiz {quiz_id}: {exc!r}",
            file=sys.stderr,
        )
        traceback.print_exc()
        _mark_failed(quiz_id, str(exc) or "Quiz preparation failed.")
    finally:
        with _generating_lock:
            _generating.pop(key, None)


def _failure_message(counts: dict[str, int]) -> str:
    parts = [
        f"{DIFFICULTY_LABEL[d]}: {counts[d]}/{QUESTIONS_PER_DIFFICULTY}"
        for d in DIFFICULTIES
        if counts[d] < QUESTIONS_PER_DIFFICULTY
    ]
    return (
        "Quiz preparation could not finish "
        f"({', '.join(parts)}). The AI service is busy right now — please try "
        "again shortly. Questions already prepared are kept."
    )


def _record_validation(quiz_id: str, report: dict) -> None:
    conn = _connect()
    conn.execute(
        "UPDATE topic_quizzes SET originality_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(report.get("originality") or {}), _now(), quiz_id),
    )
    conn.commit()
    conn.close()


def _quiz_row(quiz_id: str):
    conn = _connect()
    row = conn.execute("SELECT * FROM topic_quizzes WHERE id = ?", (quiz_id,)).fetchone()
    conn.close()
    return row


def _is_generating(key: tuple) -> str | None:
    with _generating_lock:
        return _generating.get(key)


def _inflight() -> list[tuple]:
    with _generating_lock:
        return list(_generating.items())


def _start_generation(
    key: tuple,
    quiz_id: str,
    topic: str,
    level: str,
    focus_concepts: list[str],
    goal_context: str,
) -> None:
    with _generating_lock:
        _generating[key] = quiz_id
    threading.Thread(
        target=_run_generation,
        args=(key, quiz_id, topic, level, focus_concepts, goal_context),
        daemon=True,
    ).start()


# ── Public API ─────────────────────────────────────────────────────────────

def _generation_key(
    user_id: str,
    scope: str,
    goal_id: str | None,
    topic: str,
    retest_of: str | None,
) -> tuple:
    """Identity of a generation run. Scope/goal aware so a goal quiz and a
    topic quiz with the same title never share (or cancel out) a run."""
    return (user_id, scope, goal_id or "", topic if scope == "topic" else "", retest_of or "")


def _find_primary_row(
    conn: sqlite3.Connection,
    user_id: str,
    topic: str,
    scope: str,
    goal_id: str | None,
    retest_of: str | None,
):
    """The one row this request maps to: retests by parent, goal quizzes by
    goal id, topic quizzes by topic. Never creates a second row for the same
    goal/topic.

    The scope decides which identity is used, not the mere presence of a goal
    id: a topic quiz that merely belongs to a goal (its lessons are named in
    the goal) must still get its own topic-scoped row instead of resolving to
    the goal's own 10/10/10 quiz.
    """
    if retest_of:
        return conn.execute(
            "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
            "AND retest_of = ? ORDER BY created_at DESC LIMIT 1",
            (user_id, topic, retest_of),
        ).fetchone()
    if scope == "goal" and goal_id:
        return conn.execute(
            "SELECT * FROM topic_quizzes WHERE user_id = ? AND goal_id = ? "
            "AND retest_of IS NULL AND COALESCE(scope, 'topic') = 'goal' "
            "ORDER BY created_at DESC LIMIT 1",
            (user_id, goal_id),
        ).fetchone()
    return conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
        "AND retest_of IS NULL AND COALESCE(scope, 'topic') = 'topic' "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id, topic),
    ).fetchone()


_CURATED_PROVIDERS = (curated_dsa, curated_webdev)


def _curated_provider(topic: str):
    """The curated set provider for a quiz topic, or None for AI-authored.

    Every curated set is a module exposing ``TOPIC_ALIASES`` (normalised topic
    names), ``build_questions()`` (the exact 10/10/10 set) and
    ``SOURCE_TYPE_MANUAL`` (the storage tag, always ``'manually_supplied'``).
    """
    key = quiz_originality.normalize_text(topic or "")
    if not key:
        return None
    for provider in _CURATED_PROVIDERS:
        if key in provider.TOPIC_ALIASES:
            return provider
    return None


def _seed_curated_quiz(
    provider,
    user_id: str,
    topic: str,
    quiz_id: str,
    goal_id: str | None,
) -> dict:
    """Persist a curated question set on a row and mark it ready.

    Reuses the exact same storage/validation machinery as the AI pipeline, so
    answers, per-question ids, fingerprints and validation records all behave
    identically. ``_store_questions`` deletes any questions already on the row
    first, so an old AI-built set is replaced in place and never duplicated.
    """
    questions = provider.build_questions()
    _store_questions(
        quiz_id,
        user_id,
        topic,
        questions,
        goal_id,
        source_type=provider.SOURCE_TYPE_MANUAL,
    )
    report = validate_quiz_set(
        questions, topic, enforce_relevance=False, enforce_originality=False
    )
    _record_validation(quiz_id, report)
    if not report["complete"]:
        _mark_failed(quiz_id, "Curated quiz data failed validation.")
        return {"quiz_id": quiz_id, "status": "failed", "cached": False}
    _set_stage(quiz_id, STAGE_COMPLETE)
    return {"quiz_id": quiz_id, "status": "ready", "cached": False}


def _prepare_curated_quiz(
    provider,
    user_id: str,
    topic: str,
    level: str,
    goal_id: str | None,
    roadmap_id: str | None,
    focus_concepts: list[str] | None,
    retest_of: str | None,
    goal_context: str,
    scope: str,
    lesson_id: str,
) -> dict:
    """Idempotent prepare for a curated set (goal OR topic scope).

    Mirrors ``prepare_quiz``: the SAME row is reused for a user+goal/topic, a
    validated curated set is cached, an in-flight run is joined (never raced),
    and any stale AI-built set is replaced in place. No Groq call is ever made.
    """
    scope = (scope or ("goal" if goal_id else "topic")).strip()[:10]
    slug = _slug(topic)
    lesson_id = (
        lesson_id
        or (
            lesson_id_for_goal(goal_id)
            if scope == "goal" and goal_id
            else f"topic-{slug}"
        )
    ).strip()[:120]
    key = _generation_key(user_id, scope, goal_id, topic, retest_of)

    conn = _connect()
    now = _now()
    existing = _find_primary_row(conn, user_id, topic, scope, goal_id, retest_of)
    active = _is_generating(key)
    if existing:
        quiz_id = existing["id"]
        if existing["generation_status"] == "ready" and not retest_of:
            curated = existing["source_type"] == SOURCE_TYPE_MANUAL
            if curated and validate_quiz_set(
                _questions_for_row(existing), topic, enforce_relevance=False,
                enforce_originality=False,
            )["complete"]:
                # Cached and valid: never regenerated.
                conn.close()
                return {"quiz_id": quiz_id, "status": "ready", "cached": True}
            if active == quiz_id and existing["generation_status"] == "generating":
                # A real run is in flight; join it instead of racing it.
                conn.close()
                return {"quiz_id": quiz_id, "status": "generating", "cached": True}
        conn.execute(
            "UPDATE topic_quizzes SET generation_status = 'generating', "
            "generation_stage = ?, error = NULL, goal_id = COALESCE(?, goal_id), "
            "roadmap_id = COALESCE(?, roadmap_id), updated_at = ? WHERE id = ?",
            (STAGE_PREPARING, goal_id, roadmap_id, now, quiz_id),
        )
        conn.commit()
        conn.close()
        result = _seed_curated_quiz(provider, user_id, topic, quiz_id, goal_id)
        if result["status"] == "failed":
            return result
        return {"quiz_id": quiz_id, "status": "ready", "cached": True}

    if active:
        # A run for this exact goal/topic is already in flight; join it instead
        # of writing a second quiz row.
        conn.close()
        return {"quiz_id": active, "status": "generating"}

    quiz_id = f"qz-{secrets.token_hex(6)}"
    conn.execute(
        "INSERT INTO topic_quizzes "
        "(id, user_id, topic, lesson_id, level, goal_id, roadmap_id, "
        " generation_status, generation_stage, schema_version, scope, source_type, "
        " retest_of, focus_concepts, goal_context, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            quiz_id,
            user_id,
            topic,
            lesson_id,
            level,
            goal_id,
            roadmap_id,
            STAGE_PREPARING,
            SCHEMA_VERSION,
            scope,
            provider.SOURCE_TYPE_MANUAL,
            retest_of,
            json.dumps(focus_concepts) if focus_concepts else None,
            goal_context[:2000] or None,
            now,
            now,
        ),
    )
    conn.commit()
    conn.close()
    return _seed_curated_quiz(provider, user_id, topic, quiz_id, goal_id)


def prepare_quiz(
    user_id: str,
    topic: str,
    level: str = "beginner",
    goal_id: str | None = None,
    roadmap_id: str | None = None,
    focus_concepts: list[str] | None = None,
    retest_of: str | None = None,
    goal_context: str = "",
    scope: str = "",
    lesson_id: str = "",
) -> dict:
    """Idempotent: returns an existing complete quiz without re-generating.

    Returns ``{"quiz_id", "status"}`` where status is ``ready`` (cached and
    immediately usable) or ``generating`` (background thread running). Legacy,
    short, failed or interrupted sets are topped up in place - the SAME row is
    reused, so no duplicate quiz records are ever created for a goal/topic.
    """
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("A topic is required to prepare a quiz.")
    if provider := _curated_provider(topic):
        return _prepare_curated_quiz(
            provider=provider,
            user_id=user_id,
            topic=topic,
            level=(level or "beginner").strip()[:20] or "beginner",
            goal_id=(goal_id or "").strip()[:80] or None,
            roadmap_id=roadmap_id,
            focus_concepts=[
                str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
            ][:12],
            retest_of=(retest_of or "").strip()[:80] or None,
            goal_context=goal_context,
            scope=scope,
            lesson_id=lesson_id,
        )
    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]
    level = (level or "beginner").strip()[:20] or "beginner"
    goal_id = (goal_id or "").strip()[:80] or None
    retest_of = (retest_of or "").strip()[:80] or None
    scope = (scope or ("goal" if goal_id else "topic")).strip()[:10]
    slug = _slug(topic)
    # A goal quiz is tracked under its own id so a goal never shares a score
    # with a topic quiz that happens to have the same name.
    lesson_id = (lesson_id or (lesson_id_for_goal(goal_id) if scope == "goal" and goal_id
                               else f"topic-{slug}")).strip()[:120]
    key = _generation_key(user_id, scope, goal_id, topic, retest_of)

    conn = _connect()
    now = _now()
    existing = _find_primary_row(conn, user_id, topic, scope, goal_id, retest_of)
    active = _is_generating(key)
    if existing:
        if existing["generation_status"] == "ready" and not retest_of:
            questions = _questions_for_row(existing)
            if validate_quiz_set(questions, topic, enforce_relevance=False)["complete"]:
                # Cached and valid: Groq is never called again for this goal.
                conn.close()
                return {"quiz_id": existing["id"], "status": "ready", "cached": True}
        if active and active == existing["id"] and existing["generation_status"] == "generating":
            # A run for this row really is in flight. The row state is checked
            # too: a thread deregisters just after writing its terminal state,
            # and that window must restart the run instead of reporting a
            # generation that nothing is doing.
            conn.close()
            return {"quiz_id": existing["id"], "status": "generating", "cached": True}
        # Reuse this row: legacy/short, previously failed, or an orphan left
        # 'generating' by an interrupted run. Same record, topped up in place.
        quiz_id = existing["id"]
        counts = question_tier_counts(_questions_for_row(existing))
        conn.execute(
            "UPDATE topic_quizzes SET generation_status = 'generating', "
            "generation_stage = ?, error = NULL, goal_id = COALESCE(?, goal_id), "
            "updated_at = ? WHERE id = ?",
            (_stage_for_counts(counts), goal_id, now, quiz_id),
        )
        conn.commit()
        conn.close()
        _start_generation(key, quiz_id, topic, level, focus_concepts, goal_context)
        return {"quiz_id": quiz_id, "status": "generating", "cached": True}

    if active:
        # A run for this exact goal/topic is already in flight; join it instead
        # of writing a second quiz row.
        conn.close()
        return {"quiz_id": active, "status": "generating"}

    quiz_id = f"qz-{secrets.token_hex(6)}"
    conn.execute(
        "INSERT INTO topic_quizzes "
        "(id, user_id, topic, lesson_id, level, goal_id, roadmap_id, "
        " generation_status, generation_stage, schema_version, scope, source_type, "
        " retest_of, focus_concepts, goal_context, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'generating', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            quiz_id,
            user_id,
            topic,
            lesson_id,
            level,
            goal_id,
            roadmap_id,
            STAGE_PREPARING,
            SCHEMA_VERSION,
            scope,
            SOURCE_TYPE_AI_ORIGINAL,
            retest_of,
            json.dumps(focus_concepts) if focus_concepts else None,
            goal_context[:2000] or None,
            now,
            now,
        ),
    )
    conn.commit()
    conn.close()

    _start_generation(key, quiz_id, topic, level, focus_concepts, goal_context)
    return {"quiz_id": quiz_id, "status": "generating", "cached": False}


def prepare_goal_quiz(user_id: str, goal: dict) -> dict:
    """Prepare (or reuse) the 10/10/10 quiz for a goal the user owns.

    Works for every goal, including custom goals: the topic is the goal title
    and the generation context carries the goal description, the student's own
    wording, the experience level and the roadmap topics. The goal's own row is
    always reused, including when a previous run failed or was interrupted.
    """
    if not goal:
        raise ValueError("A goal is required to prepare a quiz.")
    goal_id = str(goal.get("id") or "").strip()
    title = str(goal.get("title") or "").strip()
    if not goal_id or not title:
        raise ValueError("This goal has no title to build a quiz from.")

    return prepare_quiz(
        user_id=user_id,
        topic=title,
        level=str(goal.get("experienceLevel") or "beginner")[:20] or "beginner",
        goal_id=goal_id,
        goal_context=goal_quiz_context(goal),
        scope="goal",
        lesson_id=lesson_id_for_goal(goal_id),
    )


def get_status(user_id: str, quiz_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    conn.close()
    return _status_payload(row) if row else None


def get_status_for_topic(user_id: str, topic: str) -> dict:
    """Status of the user's TOPIC quiz. Goal quizzes are excluded so a goal that
    shares a title with a lesson never shadows the topic quiz."""
    topic = (topic or "").strip()
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
        "AND retest_of IS NULL AND COALESCE(scope, 'topic') = 'topic' "
        "ORDER BY created_at DESC",
        (user_id, topic),
    ).fetchall()
    retest_row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND topic = ? "
        "AND retest_of IS NOT NULL AND COALESCE(scope, 'topic') = 'topic' "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id, topic),
    ).fetchone()
    conn.close()

    # Prefer a settled row (ready/failed); fall back to the active in-flight
    # generation and skip orphaned 'generating' rows left by interrupted runs.
    active_quiz_ids = {
        quiz_id for (_user, _scope, _goal, _topic, _retest), quiz_id in _inflight()
    }
    row = next(
        (r for r in rows if r["generation_status"] in ("ready", "failed")),
        None,
    ) or next(
        (
            r
            for r in rows
            if r["generation_status"] == "generating" and r["id"] in active_quiz_ids
        ),
        None,
    )

    if not row:
        return {
            "state": "none",
            "stage": None,
            "quiz_id": None,
            "topic": topic,
            "lesson_id": lesson_id_for_topic(topic),
            "goal_id": None,
            "retest_ready": bool(retest_row and retest_row["generation_status"] == "ready"),
        }
    return _status_payload(row)


def get_goal_status(user_id: str, goal_id: str) -> dict:
    """Status of a goal's own 10/10/10 quiz (empty payload when none yet)."""
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND goal_id = ? "
        "AND retest_of IS NULL AND COALESCE(scope, 'topic') = 'goal' "
        "ORDER BY created_at DESC LIMIT 1",
        (user_id, goal_id),
    ).fetchone()
    conn.close()
    if not row:
        return {
            "state": "none",
            "stage": None,
            "quiz_id": None,
            "goal_id": goal_id,
            "topic": None,
            "lesson_id": None,
            "total": 0,
            "question_count": 0,
            "expected_total": QUIZ_TOTAL,
            "attempts": {d: 0 for d in DIFFICULTIES},
            "unlocked": {"basic": True, "moderate": False, "advanced": False},
            "difficulty_counts": {d: 0 for d in DIFFICULTIES},
            "tiers": [
                _tier_payload(d, [], [], _unlock_state([])) for d in DIFFICULTIES
            ],
            "answers": [],
            "retest_ready": False,
        }
    return _status_payload(row)


def get_goal_statuses(user_id: str) -> dict[str, dict]:
    """Every goal quiz this user has stored, keyed by goal id.

    One request powers the quiz hub, so listing goals never turns into a burst
    of per-goal status calls.
    """
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? AND goal_id IS NOT NULL "
        "AND retest_of IS NULL AND COALESCE(scope, 'topic') = 'goal' "
        "ORDER BY created_at ASC",
        (user_id,),
    ).fetchall()
    conn.close()
    statuses: dict[str, dict] = {}
    for row in rows:
        goal_id = str(row["goal_id"])
        payload = _status_payload(row)
        # A newer row for the same goal wins; the last one wins here.
        statuses[goal_id] = payload
    return statuses


def get_quiz(user_id: str, quiz_id: str) -> dict | None:
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    conn.close()
    if not row or row["generation_status"] != "ready":
        return None
    questions = _questions_for_row(row)
    try:
        focus_concepts = json.loads(row["focus_concepts"]) if row["focus_concepts"] else []
    except (TypeError, ValueError):
        focus_concepts = []
    report = validate_quiz_set(
        questions,
        row["topic"],
        enforce_relevance=False,
        # Curated sets are authoritative hand-supplied questions: their shared
        # MCQ wording templates are accepted, only AI sets undergo the guard.
        enforce_originality=row["source_type"] != SOURCE_TYPE_MANUAL,
    )
    # The same real question objects, also grouped by tier, so a client can read
    # basic/moderate/difficult directly instead of re-bucketing ``questions``.
    # ``difficult`` is the learner-facing name for the internal ``advanced`` tier.
    by_tier: dict[str, list[dict]] = {difficulty: [] for difficulty in DIFFICULTIES}
    for question in questions:
        by_tier.setdefault(question.get("difficulty") or "basic", []).append(question)
    return {
        "id": row["id"],
        "topic": row["topic"],
        "lesson_id": row["lesson_id"],
        "level": row["level"],
        "goal_id": row["goal_id"],
        "scope": row["scope"] or "topic",
        "retest_of": row["retest_of"],
        "focus_concepts": focus_concepts,
        "source_type": row["source_type"] or SOURCE_TYPE_AI_ORIGINAL,
        "total": len(questions),
        "expected_total": QUIZ_TOTAL,
        "difficulty_counts": question_tier_counts(questions),
        "valid": report["complete"],
        "basic": by_tier.get("basic", []),
        "moderate": by_tier.get("moderate", []),
        "difficult": by_tier.get("advanced", []),
        "questions": questions,
    }


def record_answer(
    user_id: str,
    quiz_id: str,
    question_index: int,
    selected_index: int,
    question_id: str | None = None,
) -> dict | None:
    """Upsert one submitted answer. Returns updated state + feedback.

    ``question_index`` is the question's position in the served set (what the
    client sends as ``index``). A question can also be addressed by its stable
    ``question_id`` instead, so attempt tracking survives a later top-up of the
    question set.
    """
    conn = _connect()
    row = conn.execute(
        "SELECT * FROM topic_quizzes WHERE id = ? AND user_id = ?",
        (quiz_id, user_id),
    ).fetchone()
    if not row or row["generation_status"] != "ready":
        conn.close()
        return None
    questions = _questions_for_row(row)
    if not questions:
        conn.close()
        return None

    # The unlock ladder is enforced here, on the server: a locked tier cannot be
    # answered even if the client asks for it. Attempts, not correct answers,
    # drive the unlock.
    unlock = _unlock_state(_load_answers(quiz_id))

    if question_id:
        question_index = next(
            (i for i, q in enumerate(questions) if q.get("id") == question_id),
            None,
        )
        if question_index is None:
            conn.close()
            raise IndexError("Unknown question id.")
    if question_index is None:
        conn.close()
        raise IndexError("A question index or id is required.")
    try:
        question_index = int(question_index)
    except (TypeError, ValueError):
        conn.close()
        raise IndexError("A question index or id is required.") from None
    if not (0 <= question_index < len(questions)):
        conn.close()
        raise IndexError("Question index out of range.")
    question = questions[question_index]
    difficulty = question.get("difficulty", "basic")
    if not unlock["unlocked"].get(difficulty, False):
        conn.close()
        raise QuizLockedError(_lock_message(difficulty, unlock))
    options = question["options"]
    try:
        selected_index = int(selected_index)
    except (TypeError, ValueError):
        conn.close()
        raise IndexError("Selected answer out of range.") from None
    if not (0 <= selected_index < len(options)):
        conn.close()
        raise IndexError("Selected answer out of range.")

    is_correct = 1 if selected_index == question["correctIndex"] else 0
    conn.execute(
        "INSERT INTO quiz_answers "
        "(quiz_id, question_index, difficulty, selected_index, correct_index, "
        " is_correct, answered_at, question_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(quiz_id, question_index) DO UPDATE SET "
        " selected_index = excluded.selected_index, correct_index = excluded.correct_index, "
        " is_correct = excluded.is_correct, answered_at = excluded.answered_at, "
        " question_id = excluded.question_id",
        (
            quiz_id,
            question_index,
            difficulty,
            selected_index,
            question["correctIndex"],
            is_correct,
            _now(),
            question.get("id"),
        ),
    )
    conn.commit()
    conn.close()

    status = _status_payload(row)  # reads fresh answers from DB
    return {
        "index": question_index,
        "question_id": question.get("id"),
        "difficulty": difficulty,
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
    conn.close()
    if not row or row["generation_status"] != "ready":
        return None
    questions = _questions_for_row(row)
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
    conn = _connect()
    conn.execute(
        "UPDATE topic_quizzes SET submission_json = ?, updated_at = ? WHERE id = ?",
        (json.dumps(submission), _now(), quiz_id),
    )
    conn.commit()
    conn.close()
    return submission


# ── Versioning / migration ─────────────────────────────────────────────────

def quiz_inventory(user_id: str) -> list[dict]:
    """Every stored quiz with its validation report (verification helper)."""
    conn = _connect()
    rows = conn.execute(
        "SELECT * FROM topic_quizzes WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,),
    ).fetchall()
    conn.close()
    inventory: list[dict] = []
    for row in rows:
        questions = _questions_for_row(row)
        report = validate_quiz_set(
            questions,
            row["topic"],
            enforce_relevance=False,
            enforce_originality=row["source_type"] != SOURCE_TYPE_MANUAL,
        )
        inventory.append(
            {
                "quiz_id": row["id"],
                "topic": row["topic"],
                "goal_id": row["goal_id"],
                "scope": row["scope"] or "topic",
                "state": row["generation_status"],
                "stage": row["generation_stage"],
                "counts": report["counts"],
                "total": len(questions),
                "complete": report["complete"],
                "original": bool(report["originality"] and report["originality"]["original"]),
                "problems": report["problems"],
            }
        )
    return inventory


def needs_top_up(user_id: str, quiz_id: str) -> bool:
    """True when a stored quiz is not a complete, original 10/10/10 set."""
    status = get_status(user_id, quiz_id)
    if status is None:
        return False
    return not all(tier["ready"] for tier in status["tiers"])


def migrate_quizzes(user_id: str | None = None) -> dict:
    """Inspect stored quizzes and queue the ones that need work.

    Nothing is deleted. A set is flagged when it is short *or* when it is
    10/10/10 but still fails validation (a repeated question, a question with
    three options); a flagged row is moved back to ``generating`` and the
    student opening it is what repairs it - the next prepare keeps every
    question that still validates, replaces only the broken slots, and leaves
    the surviving questions in their original positions so already stored
    answers stay bound to the same question.

    A set that is complete and well formed is never touched, and relevance is
    not re-judged here: whether a question is on-goal was decided when it was
    written. Safe to call repeatedly (idempotent).
    """
    conn = _connect()
    if user_id:
        rows = conn.execute(
            "SELECT id, user_id, topic FROM topic_quizzes WHERE user_id = ?",
            (user_id,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, user_id, topic FROM topic_quizzes").fetchall()
    conn.close()

    inspected = 0
    flagged: list[str] = []
    for row in rows:
        quiz_row = _quiz_row(row["id"])
        questions = _questions_for_row(quiz_row)
        if not questions:
            continue
        inspected += 1
        report = validate_quiz_set(
            questions,
            row["topic"],
            enforce_relevance=False,
            enforce_originality=quiz_row["source_type"] != SOURCE_TYPE_MANUAL,
        )
        if report["complete"]:
            continue
        counts = question_tier_counts(questions)
        stored = _load_stored_questions(row["id"])
        if not stored:
            # Legacy rows have no per-question records yet; import what is
            # stored so top-up generation can build on it (and give every
            # question a stable id).
            ordered = sorted(
                questions,
                key=lambda q: DIFFICULTIES.index(q.get("difficulty", "basic")),
            )
            _store_questions(
                row["id"], row["user_id"], row["topic"], ordered, quiz_row["goal_id"]
            )
        conn = _connect()
        conn.execute(
            "UPDATE topic_quizzes SET generation_status = 'generating', "
            "generation_stage = ?, error = NULL, updated_at = ? WHERE id = ?",
            (_stage_for_counts(counts), _now(), row["id"]),
        )
        conn.commit()
        conn.close()
        flagged.append(row["id"])
    return {"inspected": inspected, "flagged": flagged, "count": len(flagged)}
