"""
End-to-end test of the FocusLearn 10/10/10 quiz pipeline.

Exercises the real ``quiz_service`` orchestration and SQLite persistence against
a throwaway database, with the Groq call replaced by a deterministic stub so the
run needs no API key, no network and no waiting on a real model:

  - exactly 10 basic + 10 moderate + 10 difficult questions are stored
  - every stored record has 4 unique options, 1 correct answer, an original
    explanation, a stable id and source_type = ai_generated_original
  - background staging: tiers are persisted one at a time and a mid-run failure
    keeps the tiers that were already written
  - cache reuse: a complete, valid quiz is never regenerated
  - top-up in place: a short / failed / interrupted row is reused, never duplicated
  - duplicates and near-duplicates are rejected and replaced
  - the progressive unlock ladder is enforced server-side
  - submission scoring, per-goal isolation and migration reporting

Run:  python backend/test_quiz_generation.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

import groq_service  # noqa: E402
import quiz_originality  # noqa: E402
import quiz_service  # noqa: E402

FAILURES: list[str] = []
CHECKS = 0

_STEMS = {
    "basic": [
        "Define {topic}: which option names the core idea correctly?",
        "Which term from {topic} matches the description of a starting-point building block?",
        "State one true property of {topic} as used in practice.",
        "A beginner meets {topic} for the first time - what is true of it?",
        "Choose the statement that correctly introduces {topic}.",
        "Identify the basic building block that {topic} relies on.",
        "What does the term in {topic} stand for within this subject?",
        "Pick the simplest accurate description of {topic}.",
        "Which sentence about {topic} contains no factual error?",
        "Name the concept that {topic} formalises at an introductory level.",
        "When starting to learn {topic}, which of these facts holds?",
        "A glossary entry for {topic} would most likely say that it is used to...",
        "The introductory purpose of {topic} is best described as...",
        "A newcomer is asked why {topic} matters; which reply is right?",
        "Which of these is the everyday meaning of {topic}?",
        # Spare stems, so a refill (a repair after a broken slot) can still be
        # answered with text the student does not already have.
        "Where would {topic} first appear in a beginner's project?",
        "Which statement about {topic} would a textbook footnote make?",
        "Name the prerequisite idea that {topic} quietly assumes.",
        "A study guide lists {topic} under its fundamentals - what belongs there?",
        "Which sentence about {topic} keeps the two terms apart correctly?",
    ],
    "moderate": [
        "A team must apply {topic} to a small real case - which technique fits?",
        "Two colleagues disagree about using {topic}. Whose reasoning holds up?",
        "Given a short example involving {topic}, which conclusion follows?",
        "Compare the two common ways of handling {topic} and pick the better fit.",
        "A system built on {topic} misbehaves once - what most likely explains it?",
        "Which approach keeps {topic} understandable as the surrounding system grows?",
        "In a worked {topic} example, why does the suggested step actually matter?",
        "Which option trades off speed against clarity when applying {topic}?",
        "You must justify a decision about {topic}. Which justification is sound?",
        "A short snippet leans on {topic}. What does that snippet achieve?",
        "What would a practitioner inspect first when reasoning about {topic}?",
        "Which technique would a tutor recommend for using {topic} inside a project?",
        "Two designs use {topic}; which one handles the described load better?",
        "How should a reviewer answer a teammate's question about {topic}?",
        "A dataset arrives with the quality issue {topic} is meant to catch - what next?",
        # Spare stems, so a refill can still be answered with new text.
        "A {topic} review rejects a change - on what grounds would that be right?",
        "Which {topic} measure would expose a regression before a user does?",
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
        # Spare stems, so a refill can still be answered with new text.
        "Given a {topic} incident at scale, which mitigation actually holds?",
        "Which claim about {topic} survives a formal counter-example?",
        "Rank these {topic} designs by worst-case cost and justify the order.",
    ],
}


def check(name: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAILURES.append(f"{name}{(' -- ' + detail) if detail else ''}")
    print(f"  {status}: {name}" + (f"  -- {detail}" if detail else ""))


class StubGenerator:
    """Deterministic stand-in for ``groq_service.generate_quiz_tier``."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.extra: dict[str, list[dict]] = {}
        self.served: list[dict] = []
        self.per_call: dict[tuple[str, int], int] = {}
        self.cursor: dict[str, int] = {}
        self.fail_on: dict[str, Exception] = {}
        self.guard_seen: list[list[str]] = []

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
        focus_concepts: list | None = None,
        avoid_prompts: list | None = None,
        goal_context: str = "",
        budget=None,
    ) -> list[dict]:
        self.calls.append(
            {
                "topic": topic,
                "difficulty": difficulty,
                "count": count,
                "focus_concepts": list(focus_concepts or []),
                "avoid": list(avoid_prompts or []),
                "goal_context": goal_context,
            }
        )
        self.guard_seen.append(list(avoid_prompts or []))
        if difficulty in self.fail_on:
            raise self.fail_on[difficulty]
        sequence = self.per_call.get((difficulty, len(self.calls)), 0)
        self.per_call[(difficulty, len(self.calls))] = sequence + 1
        # Advance past everything already written for this tier, the way a real
        # model would: a refill must not restate stored questions.
        start = self.cursor.get(difficulty, 0)
        self.cursor[difficulty] = start + count
        questions = [
            _question(topic, difficulty, start + index, salt=f"{sequence}")
            for index in range(count)
        ]
        # Injected questions come first so the caller really examines them.
        result = list(self.extra.get(difficulty, [])) + questions
        self.served.extend(q for q in result if q.get("difficulty") == difficulty)
        return result


def _question(topic: str, difficulty: str, index: int, salt: str = "0") -> dict:
    stems = _STEMS.get(difficulty, _STEMS["basic"])
    prompt = stems[index % len(stems)].format(topic=topic)
    correct = f"the standard answer for {topic} case {index}{salt}"
    return {
        "prompt": prompt,
        "options": [
            correct,
            f"a plausible distractor one for {topic} case {index}{salt}",
            f"a plausible distractor two for {topic} case {index}{salt}",
            f"a plausible distractor three for {topic} case {index}{salt}",
        ],
        "correctIndex": 0,
        "explanation": (
            f"Because the definition of {topic} case {index}{salt} fixes the only "
            "outcome that holds here."
        ),
        "difficulty": difficulty,
        "concept": f"{topic} case {index}",
    }


def wait_for_settle(user_id: str, quiz_id: str, timeout: float = 20.0) -> dict:
    """Poll until the background run settles (ready or failed)."""
    deadline = time.time() + timeout
    status = {}
    while time.time() < deadline:
        status = quiz_service.get_status(user_id, quiz_id) or {}
        if status.get("state") in ("ready", "failed"):
            return status
        time.sleep(0.02)
    return status


def wait_for_idle(quiz_id: str, timeout: float = 10.0) -> None:
    """Block until no generation thread is still writing this quiz.

    ``ready`` is written just before the worker thread exits, so a test that
    edits a stored quiz the moment it reads ``ready`` can still be racing the
    thread's last writes. Tests that mutate stored rows wait here first.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not any(active == quiz_id for _key, active in quiz_service._inflight()):
            return
        time.sleep(0.02)


def fresh_db() -> str:
    handle, path = tempfile.mkstemp(prefix="focuslearn-quiz-", suffix=".db")
    os.close(handle)
    os.remove(path)
    return path


def row_count(user_id: str) -> int:
    import sqlite3

    conn = sqlite3.connect(quiz_service.DB_PATH)
    try:
        return conn.execute(
            "SELECT COUNT(*) FROM topic_quizzes WHERE user_id = ?", (user_id,)
        ).fetchone()[0]
    finally:
        conn.close()


def stored_question_rows(user_id: str, quiz_id: str) -> list:
    import sqlite3

    conn = sqlite3.connect(quiz_service.DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(
            "SELECT * FROM quiz_questions WHERE user_id = ? AND quiz_id = ? ORDER BY position",
            (user_id, quiz_id),
        ).fetchall()
    finally:
        conn.close()


GOAL = {
    "id": "goal-dsa",
    "title": "Data Structures and Algorithms",
    "description": "Master core data structures and solve algorithm problems.",
    "goalContext": "I want to crack placement interviews in six months.",
    "existingKnowledge": "I know basic C syntax.",
    "experienceLevel": "beginner",
    "roadmap": {
        "phases": [
            {"topics": [{"title": "Arrays"}, {"title": "Linked Lists"}]},
            {"topics": [{"title": "Trees"}, {"title": "Graphs"}]},
        ]
    },
}

CUSTOM_GOAL = {
    "id": "custom-rest",
    "title": "Learn REST API development",
    "description": "Build and consume REST APIs with FastAPI and Postman.",
    "goalContext": "I want a backend job, so I need REST API development skills.",
    "experienceLevel": "beginner",
}


def section(title: str) -> None:
    print(f"\n{title}")


def test_full_run_and_validation(user: str, stub: StubGenerator) -> None:
    section("[1] 10 basic + 10 moderate + 10 difficult, fully validated")
    result = quiz_service.prepare_goal_quiz(user, GOAL)
    check("prepare starts in the background", result["status"] == "generating", str(result))
    status = wait_for_settle(user, result["quiz_id"])
    quiz_id = result["quiz_id"]

    check("run finished ready", status.get("state") == "ready", str(status.get("error")))
    check("stage is complete", status.get("stage") == quiz_service.STAGE_COMPLETE)
    counts = status.get("difficulty_counts") or {}
    check("10 basic stored", counts.get("basic") == 10, str(counts))
    check("10 moderate stored", counts.get("moderate") == 10, str(counts))
    check("10 difficult stored", counts.get("advanced") == 10, str(counts))
    check("expected total is 30", status.get("expected_total") == 30)
    check("total is 30", status.get("total") == 30, str(status.get("total")))
    check(
        "every tier reports ready",
        all(tier["ready"] for tier in status.get("tiers", [])),
        str([(t["difficulty"], t["question_count"]) for t in status.get("tiers", [])]),
    )
    labels = [tier["label"] for tier in status.get("tiers", [])]
    check("tiers are labelled Basic/Moderate/Difficult", labels == ["Basic", "Moderate", "Difficult"], str(labels))

    quiz = quiz_service.get_quiz(user, quiz_id)
    check("quiz is served once ready", quiz is not None)
    questions = (quiz or {}).get("questions") or []
    check("quiz holds 30 questions", len(questions) == 30, str(len(questions)))
    check("quiz validates as complete", bool((quiz or {}).get("valid")))

    four_options = [q for q in questions if len(q.get("options") or []) == 4]
    check("every question has 4 options", len(four_options) == 30, str(30 - len(four_options)))
    unique_options = [
        q for q in questions
        if len({str(o).strip().lower() for o in q.get("options") or []}) == 4
    ]
    check("options are unique per question", len(unique_options) == 30, str(30 - len(unique_options)))
    with_explanation = [q for q in questions if len(str(q.get("explanation") or "").strip()) >= 10]
    check("every question has an explanation", len(with_explanation) == 30, str(30 - len(with_explanation)))
    single_correct = [
        q for q in questions
        if isinstance(q.get("correctIndex"), int) and 0 <= q["correctIndex"] < 4
    ]
    check("exactly one correct option index per question", len(single_correct) == 30)
    with_ids = [q for q in questions if str(q.get("id") or "").strip()]
    check("every question has a stable id", len(with_ids) == 30, str(30 - len(with_ids)))
    check(
        "question ids are unique",
        len({q["id"] for q in questions}) == 30,
    )
    marked_original = [q for q in questions if q.get("source_type") == "ai_generated_original"]
    check(
        "every question is marked AI-generated original",
        len(marked_original) == 30,
        str(30 - len(marked_original)),
    )

    records = stored_question_rows(user, quiz_id)
    check("30 normalised question records persisted", len(records) == 30, str(len(records)))
    check(
        "records keep the same ids as the JSON view",
        sorted(r["id"] for r in records) == sorted(q["id"] for q in questions),
    )
    check(
        "records cover 10/10/10",
        [sum(1 for r in records if r["difficulty"] == d) for d in quiz_service.DIFFICULTIES] == [10, 10, 10],
    )

    tier_order = [d for d, _ in _runs(records)]
    check("tiers are ordered basic -> moderate -> difficult", tier_order == sorted(tier_order, key=quiz_service.DIFFICULTIES.index), str(tier_order))

    inventory = quiz_service.quiz_inventory(user)
    mine = [i for i in inventory if i["quiz_id"] == quiz_id]
    check("inventory reports the quiz complete", bool(mine and mine[0]["complete"]), str(mine and mine[0]["problems"]))
    check("inventory reports it original", bool(mine and mine[0]["original"]))
    return quiz_id


def _runs(records: list) -> list[tuple[str, int]]:
    seen: list[str] = []
    for record in records:
        if not seen or seen[-1] != record["difficulty"]:
            seen.append(record["difficulty"])
    return [(d, 0) for d in seen]


def test_cache_and_no_duplicate_calls(user: str, stub: StubGenerator, quiz_id: str) -> None:
    section("[2] cache reuse and no duplicate quiz records")
    before = len(stub.calls)
    result = quiz_service.prepare_goal_quiz(user, GOAL)
    check("a complete quiz is returned from cache", result["status"] == "ready", str(result))
    check("the cached quiz id is reused", result["quiz_id"] == quiz_id)
    check("Groq is not called again for a cached quiz", len(stub.calls) == before, f"{before} -> {len(stub.calls)}")
    check("no second quiz row was created", row_count(user) == 1, str(row_count(user)))

    status = quiz_service.get_goal_status(user, GOAL["id"])
    check("goal status points at the quiz", status.get("quiz_id") == quiz_id)
    check("goal status is cached-ready", status.get("state") == "ready")
    check("only one goal quiz row", row_count(user) == 1)


def test_unlock_ladder(user: str, quiz_id: str) -> None:
    section("[3] progressive unlock enforced by the server")
    status = quiz_service.get_status(user, quiz_id)
    unlocked = status["unlocked"]
    check("basic is unlocked from the start", unlocked["basic"] is True)
    check("moderate starts locked", unlocked["moderate"] is False)
    check("difficult starts locked", unlocked["advanced"] is False)

    questions = quiz_service.get_quiz(user, quiz_id)["questions"]
    by_difficulty: dict[str, list[int]] = {
        d: [i for i, q in enumerate(questions) if q["difficulty"] == d]
        for d in quiz_service.DIFFICULTIES
    }
    check("the served set really is 10/10/10", {k: len(v) for k, v in by_difficulty.items()} == {"basic": 10, "moderate": 10, "advanced": 10})
    moderate_index = by_difficulty["moderate"][0]
    advanced_index = by_difficulty["advanced"][0]

    locked = False
    try:
        quiz_service.record_answer(user, quiz_id, moderate_index, 0)
    except quiz_service.QuizLockedError as exc:
        locked = "Moderate" in str(exc)
    check("answering a locked moderate question is rejected", locked)
    check("the rejected attempt was not stored", quiz_service.get_status(user, quiz_id)["attempts"]["moderate"] == 0)

    # Three basic attempts (answered wrong on purpose) unlock moderate.
    for position, index in enumerate(by_difficulty["basic"][:3]):
        wrong = (questions[index]["correctIndex"] + 1) % 4
        quiz_service.record_answer(user, quiz_id, index, wrong)
        if position < 2:
            check(
                f"moderate still locked after {position + 1} basic attempt(s)",
                quiz_service.get_status(user, quiz_id)["unlocked"]["moderate"] is False,
            )
    after = quiz_service.get_status(user, quiz_id)
    check("3 basic attempts unlock moderate", after["unlocked"]["moderate"] is True, str(after["attempts"]))
    check("wrong answers still count as attempts", after["attempts"]["basic"] == 3)
    check("difficult is still locked", after["unlocked"]["advanced"] is False)
    check("the locked requirement text is reported", any(
        tier["requirement"] and tier["requirement"]["attempts_needed"] == 3
        for tier in after["tiers"] if tier["difficulty"] == "moderate"
    ))

    quiz_service.record_answer(user, quiz_id, moderate_index, 0)
    check("moderate can be answered once unlocked", quiz_service.get_status(user, quiz_id)["attempts"]["moderate"] == 1)

    locked = False
    try:
        quiz_service.record_answer(user, quiz_id, advanced_index, 0)
    except quiz_service.QuizLockedError as exc:
        locked = "Difficult" in str(exc)
    check("answering a locked difficult question is rejected", locked)

    moderate_indices = by_difficulty["moderate"]
    for index in moderate_indices[1:3]:
        quiz_service.record_answer(user, quiz_id, index, 0)
    final = quiz_service.get_status(user, quiz_id)
    check("3 moderate attempts unlock difficult", final["unlocked"]["advanced"] is True, str(final["attempts"]))
    check("difficult can be answered once unlocked", quiz_service.record_answer(user, quiz_id, advanced_index, 0) is not None)


def test_submission(user: str, quiz_id: str) -> None:
    section("[4] submission scoring from stored answers")
    submission = quiz_service.submit_quiz(user, quiz_id)
    check("submission is produced", submission is not None)
    answered = submission["answered"]
    check("answered counts every stored attempt", answered == len(quiz_service._load_answers(quiz_id)), str(answered))
    check("score never exceeds answered", submission["score"] <= answered, str(submission))
    check("percentage is a whole number", isinstance(submission["percentage"], int))
    check(
        "per-difficulty breakdown present",
        set(submission["breakdown"]) == set(quiz_service.DIFFICULTIES),
        str(submission["breakdown"]),
    )
    check("weak concepts are reported for performance analysis", "weak_concepts" in submission)
    check("not complete until all 30 are answered", submission["completed"] is False)


def test_topup_in_place(user2: str, stub: StubGenerator) -> None:
    section("[5] top-up in place (no duplicate rows)")
    result = quiz_service.prepare_goal_quiz(user2, CUSTOM_GOAL)
    status = wait_for_settle(user2, result["quiz_id"])
    check("custom goal quiz becomes ready", status.get("state") == "ready", str(status.get("error")))
    counts = status.get("difficulty_counts") or {}
    check("custom goal gets 10/10/10", counts == {"basic": 10, "moderate": 10, "advanced": 10}, str(counts))
    contexts = [c["goal_context"] for c in stub.calls if c["goal_context"]]
    check(
        "custom goal context reaches the generator",
        any("REST API development" in c for c in contexts),
        str(contexts[:1]),
    )
    check("one quiz row for the custom goal", row_count(user2) == 1)

    # Force the same row back to a short state, as a legacy DB would be.
    import sqlite3

    wait_for_idle(result["quiz_id"])
    before_prompts = [
        r["prompt"] for r in stored_question_rows(user2, result["quiz_id"]) if r["difficulty"] == "basic"
    ]
    quiz_id = result["quiz_id"]
    stub.fail_on["advanced"] = RuntimeError("simulated outage")
    conn = sqlite3.connect(quiz_service.DB_PATH)
    conn.execute(
        "UPDATE topic_quizzes SET generation_status='failed', generation_stage='failed', "
        "error='simulated outage' WHERE id=?",
        (quiz_id,),
    )
    conn.execute("DELETE FROM quiz_questions WHERE quiz_id = ? AND difficulty = 'advanced'", (quiz_id,))
    conn.commit()
    conn.close()
    stub.fail_on.clear()

    again = quiz_service.prepare_goal_quiz(user2, CUSTOM_GOAL)
    check("a failed quiz is retried on the same row", again["quiz_id"] == quiz_id, str(again))
    status = wait_for_settle(user2, quiz_id)
    check(
        "top-up restores 10/10/10",
        status.get("difficulty_counts") == {"basic": 10, "moderate": 10, "advanced": 10},
        f"{status.get('difficulty_counts')} state={status.get('state')} stage={status.get('stage')} error={status.get('error')}",
    )
    check("still only one quiz row", row_count(user2) == 1, str(row_count(user2)))

    records = stored_question_rows(user2, quiz_id)
    check("top-up keeps the original question ids", len({r["id"] for r in records}) == 30)
    prompts = [r["prompt"] for r in records if r["difficulty"] == "basic"]
    check(
        "top-up did not regenerate the basic tier",
        prompts == before_prompts,
        f"{len(before_prompts)} -> {len(prompts)}",
    )
    return quiz_id


def test_partial_failure_keeps_tiers(user3: str, stub: StubGenerator) -> None:
    section("[6] a failed tier keeps the tiers already generated")
    stub.fail_on["advanced"] = RuntimeError("provider outage")
    result = quiz_service.prepare_quiz(user3, "Java Programming", goal_id="goal-java")
    status = wait_for_settle(user3, result["quiz_id"])
    check("run reports failed", status.get("state") == "failed", str(status.get("state")))
    check("failure message is stored", bool(status.get("error")), str(status.get("error")))
    counts = status.get("difficulty_counts") or {}
    check("basic survived the failure", counts.get("basic") == 10, str(counts))
    check("moderate survived the failure", counts.get("moderate") == 10, str(counts))
    check("difficult was not faked", counts.get("advanced") == 0, str(counts))
    check("the run is marked failed", status.get("stage") == quiz_service.STAGE_FAILED, str(status.get("stage")))
    check("no placeholder question was stored", counts.get("basic", 0) + counts.get("moderate", 0) == 20)

    stub.fail_on.clear()
    retry = quiz_service.prepare_quiz(user3, "Java Programming", goal_id="goal-java")
    check("retry reuses the same row", retry["quiz_id"] == result["quiz_id"])
    status = wait_for_settle(user3, result["quiz_id"])
    check("retry completes 10/10/10", status.get("difficulty_counts") == {"basic": 10, "moderate": 10, "advanced": 10}, str(status.get("difficulty_counts")))
    check("retry reaches ready", status.get("state") == "ready")


def test_duplicate_rejection(user4: str, stub: StubGenerator) -> None:
    section("[7] duplicates and near-duplicates are rejected")
    topic = "Database Management Systems"
    original = _question(topic, "basic", 0)
    near_copy = dict(original)
    near_copy["prompt"] = (
        "Here, " + original["prompt"].replace("Which", "which").replace(
            "correctly?", "correctly, in your own words?"
        )
    )
    score = quiz_originality.similarity(
        quiz_originality.QuestionSignature(original["prompt"]),
        quiz_originality.QuestionSignature(near_copy["prompt"]),
    )
    check("the injected pair really is a near-duplicate", score >= quiz_originality.SIMILARITY_THRESHOLD, f"score={score:.2f}")
    stub.extra["basic"] = [near_copy]

    result = quiz_service.prepare_quiz(user4, topic, goal_id="goal-dbms")
    status = wait_for_settle(user4, result["quiz_id"])
    check("run completes despite an injected duplicate", status.get("state") == "ready", str(status.get("error")))
    questions = quiz_service.get_quiz(user4, result["quiz_id"])["questions"]
    prompts = [q["prompt"] for q in questions]
    check("the repeated wording is stored once only", prompts.count(near_copy["prompt"]) == 1, str(prompts.count(near_copy["prompt"])))
    check("the second copy of the same wording is dropped", original["prompt"] not in prompts)
    check("still exactly 30 questions", len(prompts) == 30, str(len(prompts)))
    verdict = quiz_originality.validate_originality(prompts)
    check("stored set passes the originality check", verdict["original"], str(verdict))
    check(
        "the stored set really is 10/10/10",
        quiz_service.question_tier_counts(questions) == {"basic": 10, "moderate": 10, "advanced": 10},
    )
    stub.extra.clear()


def test_questions_are_original_across_goals(user: str, other: str, stub: StubGenerator) -> None:
    section("[8] originality is enforced across a user's goals")
    first = quiz_service.prepare_quiz(other, "Web Development Fundamentals", goal_id="goal-web")
    wait_for_settle(other, first["quiz_id"])
    second = quiz_service.prepare_quiz(other, "Machine Learning", goal_id="goal-ml")
    wait_for_settle(other, second["quiz_id"])
    report = quiz_originality.validate_originality(
        [q["prompt"] for q in quiz_service.get_quiz(other, second["quiz_id"])["questions"]]
    )
    check("the second goal does not restate the first", report["original"], str(report))
    passed = [c for c in stub.calls if c["topic"] == "Machine Learning"]
    check(
        "later tiers are told what is already written",
        bool(passed) and any(c["avoid"] for c in passed),
        str([len(c["avoid"]) for c in passed]),
    )
    check(
        "the first tier starts with nothing to avoid",
        bool(passed) and passed[0]["avoid"] == [],
        str(passed[0]["avoid"] if passed else None),
    )


def test_isolation(user: str, quiz_id: str) -> None:
    section("[9] users never see each other's quizzes")
    check("another user gets no status for that quiz", quiz_service.get_status("someone-else", quiz_id) is None)
    check("another user gets no quiz payload", quiz_service.get_quiz("someone-else", quiz_id) is None)
    check("another user gets no goal status", quiz_service.get_goal_status("someone-else", GOAL["id"])["state"] == "none")
    check("recording an answer for another user fails", quiz_service.record_answer("someone-else", quiz_id, 0, 0) is None)


def test_migration_report(user: str, quiz_id: str) -> None:
    section("[10] migration inspects without destroying stored quizzes")
    report = quiz_service.migrate_quizzes(user)
    check("migration ran", report["inspected"] >= 1, str(report))
    check("a complete quiz is not flagged", quiz_id not in report["flagged"], str(report))
    check("the complete quiz is still ready", quiz_service.get_status(user, quiz_id)["state"] == "ready")
    check("migrate is idempotent", quiz_service.migrate_quizzes(user)["flagged"] == report["flagged"])


def test_validation_rules() -> None:
    section("[11] validation rules")
    questions = []
    for difficulty in quiz_service.DIFFICULTIES:
        for index in range(10):
            questions.append(_question("Python Basics", difficulty, index))
    report = quiz_service.validate_quiz_set(questions, "Python Basics")
    check("a good set is complete", report["complete"], str(report["problems"]))
    check("counts are 10/10/10", report["counts"] == {"basic": 10, "moderate": 10, "advanced": 10})

    short = dict(questions[0])
    short["options"] = short["options"][:3]
    check("3 options fails validation", not quiz_service.validate_quiz_set([short] * 30, "Python Basics")["complete"])

    duplicated = list(questions)
    duplicated[5] = dict(duplicated[5], prompt=duplicated[0]["prompt"])
    report = quiz_service.validate_quiz_set(duplicated, "Python Basics")
    check("a repeated question fails validation", not report["complete"])
    check("the repeat is reported as a duplicate", report["originality"]["near_duplicates"] + report["originality"]["exact_duplicates"] >= 1, str(report["originality"]))

    check("a missing question fails validation", not quiz_service.validate_quiz_set(questions[:29], "Python Basics")["complete"])
    check("no questions fails validation", not quiz_service.validate_quiz_set([], "Python Basics")["complete"])
    check(
        "an off-goal set is rejected",
        not quiz_service.validate_quiz_set(
            [_question("Marine Biology", d, i) for d in quiz_service.DIFFICULTIES for i in range(10)],
            "Data Structures and Algorithms",
        )["complete"],
    )


def test_broken_set_is_repaired(user: str, stub: StubGenerator) -> None:
    section("[12] a stored set that fails validation is repaired, not retried forever")
    goal = dict(GOAL)
    goal["id"] = "repair-goal"
    result = quiz_service.prepare_goal_quiz(user, goal)
    status = wait_for_settle(user, result["quiz_id"])
    quiz_id = result["quiz_id"]
    check("repair fixture is ready first", status.get("state") == "ready", str(status.get("error")))

    quiz = quiz_service.get_quiz(user, quiz_id) or {}
    original = [dict(q) for q in quiz["questions"]]
    check("repair fixture holds 30 questions", len(original) == 30, str(len(original)))

    # A student has answered one question before the set turns out to be broken.
    answered_index = 4
    quiz_service.record_answer(user, quiz_id, answered_index, 0)

    wait_for_idle(quiz_id)
    broken = [dict(q) for q in original]
    # Break one question in an objective way: three options is never valid.
    broken[answered_index]["options"] = broken[answered_index]["options"][:3]
    # And repeat another one, which is a near-duplicate the guard must replace.
    broken[21]["prompt"] = broken[20]["prompt"]
    quiz_service._store_questions(quiz_id, user, quiz["topic"], broken, quiz.get("goal_id"))

    report = quiz_service.validate_quiz_set(
        quiz_service._questions_for_row(quiz_service._quiz_row(quiz_id)),
        quiz["topic"],
        enforce_relevance=False,
    )
    check("the broken set is detected as incomplete", not report["complete"], str(report["problems"]))

    # The real path for the legacy rows in the production database: migration
    # flags the set and queues it, then the student opening it is what repairs
    # it. No separate repair command has to run.
    migration = quiz_service.migrate_quizzes(user)
    check("migration flags the broken set", quiz_id in migration["flagged"], str(migration))
    check("only the broken set is flagged by that run",
          migration["flagged"] == [quiz_id], str(migration["flagged"]))
    check("the flagged set is queued, not deleted",
          quiz_service._quiz_row(quiz_id)["generation_status"] == "generating",
          str(quiz_service._quiz_row(quiz_id)["generation_status"]))
    check("the queued set still holds its questions",
          len(quiz_service._questions_for_row(quiz_service._quiz_row(quiz_id))) == 30)

    calls_before = len(stub.calls)
    again = quiz_service.prepare_goal_quiz(user, goal)
    repaired = wait_for_settle(user, quiz_id)
    check("the broken quiz is repaired to ready", repaired.get("state") == "ready", str(repaired.get("error")))
    check("repair refilled only the broken tiers", len(stub.calls) > calls_before,
          f"{calls_before} -> {len(stub.calls)}")
    check(
        "repair restores 10/10/10",
        (repaired.get("difficulty_counts") or {}) == {"basic": 10, "moderate": 10, "advanced": 10},
        str(repaired.get("difficulty_counts")),
    )

    after = [q for q in (quiz_service.get_quiz(user, quiz_id) or {}).get("questions") or []]
    check("repaired set holds 30 questions", len(after) == 30, str(len(after)))
    check("repaired set validates as complete", bool((quiz_service.get_quiz(user, quiz_id) or {}).get("valid")))

    untouched = [i for i in range(30) if i not in (answered_index, 21)]
    check(
        "the other 28 questions keep their exact text",
        all(after[i]["prompt"] == original[i]["prompt"] for i in untouched),
        str([i for i in untouched if after[i]["prompt"] != original[i]["prompt"]]),
    )
    check(
        "the question at the broken slot is replaced, not shifted away",
        after[answered_index]["prompt"] != original[answered_index]["prompt"],
        after[answered_index]["prompt"],
    )
    check("the repeated question is replaced", after[21]["prompt"] != after[20]["prompt"])
    check("no two stored questions repeat", quiz_originality.validate_originality(
        [q["prompt"] for q in after])["original"])

    # Answers are keyed by question_index, so a repair must not move them.
    answers = {a["question_index"]: a for a in quiz_service._load_answers(quiz_id)}
    check("the stored answer survives the repair", answered_index in answers, str(sorted(answers)))
    check(
        "the stored answer still points at the question it was given for",
        answers[answered_index]["difficulty"] == original[answered_index]["difficulty"]
        and answers[answered_index]["correct_index"] == original[answered_index]["correctIndex"],
        str(dict(answers[answered_index])),
    )

    # A second prepare must now be served from cache: no more repair attempts.
    cached_calls = len(stub.calls)
    cached = quiz_service.prepare_goal_quiz(user, goal)
    check("a repaired set is cached, not regenerated", cached.get("cached") is True, str(cached))
    check("the cache hit costs no generation call", len(stub.calls) == cached_calls)


def test_stored_relevance_is_not_relitigated(user: str, stub: StubGenerator) -> None:
    section("[13] stored sets are not condemned by the keyword heuristic")
    goal = dict(GOAL)
    goal["id"] = "relevance-goal"
    result = quiz_service.prepare_goal_quiz(user, goal)
    status = wait_for_settle(user, result["quiz_id"])
    quiz_id = result["quiz_id"]
    check("relevance fixture is ready", status.get("state") == "ready", str(status.get("error")))

    quiz = quiz_service.get_quiz(user, quiz_id) or {}
    legacy = [dict(q) for q in quiz["questions"]]
    # Real legacy sets are full of on-goal questions that never reuse the goal's
    # own words (a linked-list question for a "Data Structures and Algorithms"
    # goal), so the keyword heuristic sees no overlap at all.
    legacy_prompts = [
        "What does a linked list node hold besides the value it stores?",
        "Which property does a binary search tree guarantee about its children?",
        "A hash table stores a key with a chained collision - what happens next?",
        "When does depth-first search run out of vertices to visit?",
        "Why is a circular queue often implemented with a spare array slot?",
        "What does a breadth-first traversal keep in memory while it runs?",
        "Which of these describes an in-place partition step?",
        "What makes a binary heap a complete tree rather than just a balanced one?",
        "A stack is being used to evaluate an expression - what is on top?",
        "Which statement about recursion depth is true for a self-referential routine?",
        "What is the cost of merging two already-sorted runs?",
        "Which scheme builds a priority view without sorting everything?",
        "A graph has one node pointing to itself - what does that imply for a walk?",
        "What does an adjacency matrix trade away compared with an adjacency list?",
        "Which operation makes a search tree degenerate if input arrives sorted?",
        "How does a balanced split affect the depth of a search tree?",
        "What is a sentinel node for, when used in a singly linked structure?",
        "Which comparison-based sort is stable and also adaptive?",
        "What does a doubling strategy bound, when resizing a backing array?",
        "A traversal of an undirected graph must avoid re-walking - how?",
        "Which queue discipline serves requests in first-come, first-served order?",
        "What does a hash function's load factor describe?",
        "Which representation makes predecessor queries cheap?",
        "What holds for the in-order walk of a search tree?",
        "Why is a doubly linked list given a back pointer?",
        "Which pattern turns a recursive walk into an explicit stack?",
        "What does memoisation avoid when the subproblems overlap?",
        "A shortest-path run on an unweighted graph needs which relaxation rule?",
        "Which structure supports finding the minimum key fastest?",
        "What is the effect of a bad partition on a quicksort run?",
    ]
    for index, question in enumerate(legacy):
        question["prompt"] = legacy_prompts[index]
        question["options"] = [f"correct answer {index}", "wrong one", "wrong two", "wrong three"]
    wait_for_idle(quiz_id)
    quiz_service._store_questions(quiz_id, user, quiz["topic"], legacy, quiz.get("goal_id"))

    strict = quiz_service.validate_quiz_set(legacy, quiz["topic"])
    lenient = quiz_service.validate_quiz_set(
        legacy, quiz["topic"], enforce_relevance=False)
    check("the strict check still reports the keyword drift", not strict["complete"], str(strict["problems"]))
    check("the strict check measures the ratio", strict["on_topic_ratio"] < 0.25, str(strict["on_topic_ratio"]))
    check("the stored-set check accepts it", lenient["complete"], str(lenient["problems"]))
    check("the drift is still reported as a warning", "relevance_warning" in lenient, str(lenient.get("relevance_warning")))

    calls_before = len(stub.calls)
    cached = quiz_service.prepare_goal_quiz(user, goal)
    check("an on-goal legacy set is reused, not regenerated", cached.get("cached") is True, str(cached))
    check("reusing it costs no generation call", len(stub.calls) == calls_before)
    served = quiz_service.get_quiz(user, quiz_id) or {}
    check("the legacy set is still served as ready", served.get("valid") is True, str(served.get("validation")))


def test_partially_filled_tier(user: str, stub: StubGenerator) -> None:
    section("[14] a half-filled tier is filled without duplicating questions")
    goal = dict(GOAL)
    goal["id"] = "partial-goal"
    result = quiz_service.prepare_goal_quiz(user, goal)
    status = wait_for_settle(user, result["quiz_id"])
    quiz_id = result["quiz_id"]
    check("partial fixture is ready", status.get("state") == "ready", str(status.get("error")))

    quiz = quiz_service.get_quiz(user, quiz_id) or {}
    original = [dict(q) for q in quiz["questions"]]
    basic = [q for q in original if q["difficulty"] == "basic"]

    # An interrupted run leaves a tier part-filled: 4 of 10 basic questions and
    # nothing wrong with them. The refill must add exactly 6, not 6 + spares.
    wait_for_idle(quiz_id)
    partial = [dict(q) for q in original if q["difficulty"] != "basic"] + [dict(q) for q in basic[:4]]
    quiz_service._store_questions(quiz_id, user, quiz["topic"], partial, quiz.get("goal_id"))

    before = len(stub.calls)
    again = quiz_service.prepare_goal_quiz(user, goal)
    filled = wait_for_settle(user, quiz_id)
    check("a part-filled tier reaches ready", filled.get("state") == "ready", str(filled.get("error")))
    check(
        "the part-filled tier ends at exactly 10",
        (filled.get("difficulty_counts") or {}).get("basic") == 10,
        str(filled.get("difficulty_counts")),
    )
    check("the whole set ends at 10/10/10",
          (filled.get("difficulty_counts") or {})
          == {"basic": 10, "moderate": 10, "advanced": 10},
          str(filled.get("difficulty_counts")))

    stored = (quiz_service.get_quiz(user, quiz_id) or {}).get("questions") or []
    check("exactly 30 questions are stored", len(stored) == 30, str(len(stored)))
    per_tier = quiz_service.question_tier_counts(stored)
    check("no tier is over-filled", all(count == 10 for count in per_tier.values()), str(per_tier))
    check("no stored question repeats",
          quiz_originality.validate_originality([q["prompt"] for q in stored])["original"])
    stored_basic = [q["prompt"] for q in stored if q["difficulty"] == "basic"]
    check(
        "the 4 stored basic questions lead the tier, unchanged",
        stored_basic[:4] == [q["prompt"] for q in basic[:4]],
        str(stored_basic[:4]),
    )
    check("the 6 new basic questions are not copies of the stored 4",
          not set(stored_basic[4:]) & {q["prompt"] for q in basic[:4]})
    check(
        "the moderate and difficult tiers are untouched",
        all(
            next(s["prompt"] for s in stored if s["difficulty"] == d) == next(o["prompt"] for o in original if o["difficulty"] == d)
            for d in ("moderate", "advanced")
        ),
    )
    check("only the short tier was generated",
          {c["difficulty"] for c in stub.calls[before:]} == {"basic"},
          str([c["difficulty"] for c in stub.calls[before:]]))


def main() -> int:
    original_db = quiz_service.DB_PATH
    stub = StubGenerator()
    stub.install()
    try:
        quiz_service.DB_PATH = fresh_db()
        quiz_service.init_db()
        quiz_id = test_full_run_and_validation("user-1", stub)
        test_cache_and_no_duplicate_calls("user-1", stub, quiz_id)
        test_unlock_ladder("user-1", quiz_id)
        test_submission("user-1", quiz_id)
        test_topup_in_place("user-2", stub)
        test_partial_failure_keeps_tiers("user-3", stub)
        test_duplicate_rejection("user-4", stub)
        test_questions_are_original_across_goals("user-1", "user-5", stub)
        test_isolation("user-1", quiz_id)
        test_migration_report("user-1", quiz_id)
        test_validation_rules()
        test_broken_set_is_repaired("user-6", stub)
        test_stored_relevance_is_not_relitigated("user-7", stub)
        test_partially_filled_tier("user-8", stub)
    finally:
        stub.restore()
        quiz_service.DB_PATH = original_db

    print(f"\n{CHECKS - len(FAILURES)}/{CHECKS} checks passed")
    if FAILURES:
        print("\nFAILED:")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("ALL QUIZ GENERATION TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
