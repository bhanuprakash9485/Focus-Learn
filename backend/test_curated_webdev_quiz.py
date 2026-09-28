"""End-to-end verification of the curated Web Development question set (manual, offline)."""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile

CHECKS = 0


def check(label: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        raise AssertionError(f"FAIL: {label} {detail}")
    print(f"  PASS: {label}" + (f"  -- {detail}" if detail else ""))


def main() -> int:
    import quiz_service

    original_db = quiz_service.DB_PATH
    handle, path = tempfile.mkstemp(prefix="focuslearn-webdev-", suffix=".db")
    os.close(handle)
    os.remove(path)
    quiz_service.DB_PATH = path
    quiz_service.init_db()

    user_id = "user-webdev-1"

    def goal(topic: str) -> dict:
        return {"id": "goal-" + str(abs(hash(topic)) % 1000000), "title": topic, "experienceLevel": "beginner"}

    try:
        g = goal("Web Development")
        print("== prepare (goal scope) ==")
        result = quiz_service.prepare_goal_quiz(user_id, g)
        check("prepare completes instantly (no generation thread)", result["status"] == "ready", result)
        quiz_id = result["quiz_id"]

        inventory = quiz_service.quiz_inventory(user_id)
        check("exactly one quiz row for the user", len(inventory) == 1, len(inventory))
        check("row is ready", inventory[0]["state"] == "ready")
        check("row is complete (authoritative set)", inventory[0]["complete"] is True)
        check("counts are 10/10/10", inventory[0]["counts"] == {"basic": 10, "moderate": 10, "advanced": 10}, inventory[0]["counts"])
        check("no duplicate quiz rows", len([r for r in inventory if r["quiz_id"] == quiz_id]) == 1)

        conn = sqlite3.connect(quiz_service.DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute("SELECT * FROM topic_quizzes WHERE id = ?", (quiz_id,)).fetchone()
            qrows = conn.execute(
                "SELECT * FROM quiz_questions WHERE quiz_id = ? ORDER BY position", (quiz_id,)
            ).fetchall()
            answers = conn.execute(
                "SELECT COUNT(*) AS c FROM quiz_answers WHERE quiz_id = ?", (quiz_id,)
            ).fetchone()
        finally:
            conn.close()
        check("generation_status is ready", row["generation_status"] == "ready")
        check("source_type is manual", row["source_type"] == "manually_supplied", row["source_type"])
        check("question_count is 30", row["question_count"] == 30, row["question_count"])
        check("30 question records stored", len(qrows) == 30, len(qrows))
        check("positions are sequential 0..29", [r["position"] for r in qrows] == list(range(0, 30)))
        check("tier_position is 1..10 per tier",
              sorted(r["tier_position"] for r in qrows[:10]) == list(range(1, 11))
              and sorted(r["tier_position"] for r in qrows[10:20]) == list(range(1, 11))
              and sorted(r["tier_position"] for r in qrows[20:30]) == list(range(1, 11)))
        check("answers table empty for fresh quiz", answers["c"] == 0, answers["c"])

        per_q = []
        conn = sqlite3.connect(quiz_service.DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            per_q = conn.execute(
                "SELECT prompt, options_json, correct_index, difficulty, fingerprint, source_type "
                "FROM quiz_questions WHERE quiz_id = ? ORDER BY position", (quiz_id,)
            ).fetchall()
        finally:
            conn.close()
        import json as _json
        for r in per_q:
            opts = _json.loads(r["options_json"])
            assert len(opts) == 4, r["prompt"]
            assert 0 <= r["correct_index"] < 4, r["prompt"]
            assert r["fingerprint"], r["prompt"]
        check("all 30 stored records carry 4 options / one correct / fingerprint",
              all(len(_json.loads(r["options_json"])) == 4 and 0 <= r["correct_index"] < 4 and r["fingerprint"]
                  for r in per_q))
        check("black-box stored set matches the curated data 1:1",
              [r["prompt"] for r in per_q] == _curated_prompts())
        check("per-record source_type is manual",
              all(r["source_type"] == "manually_supplied" for r in per_q))

        print("== exact question text / answers (against the supplied list) ==")
        _check_exact_answers(per_q)

        print("== idempotency / caching ==")
        again = quiz_service.prepare_goal_quiz(user_id, g)
        check("second prepare returns the same quiz id", again["quiz_id"] == quiz_id, again)
        check("second prepare is cached ready", again["status"] == "ready" and again.get("cached") is True, again)
        inventory = quiz_service.quiz_inventory(user_id)
        check("still exactly one row (no duplicate quiz)",
              len(inventory) == 1 and inventory[0]["quiz_id"] == quiz_id)

        print("== get_quiz payload ==")
        quiz = quiz_service.get_quiz(user_id, quiz_id)
        check("get_quiz returns the set", quiz is not None and quiz["total"] == 30)
        check("valid is true", quiz["valid"] is True)
        check("difficulty buckets 10/10/10",
              len(quiz["basic"]) == 10 and len(quiz["moderate"]) == 10 and len(quiz["difficult"]) == 10,
              [len(quiz["basic"]), len(quiz["moderate"]), len(quiz["difficult"])])
        check("difficult tier == stored advanced",
              all(q["difficulty"] == "advanced" for q in quiz["difficult"]))

        print("== progressive unlock ==")
        status0 = quiz_service.get_status(user_id, quiz_id)
        tiers0 = {t["difficulty"]: t for t in status0["tiers"]}
        check("starts locked beyond basic",
              tiers0["moderate"]["unlocked"] is False and tiers0["advanced"]["unlocked"] is False,
              (tiers0["moderate"]["unlocked"], tiers0["advanced"]["unlocked"]))
        for index in range(0, 3):  # first three basic questions
            q = quiz["basic"][index]
            r = quiz_service.record_answer(user_id, quiz_id, q["index"] if "index" in q else None, 0, question_id=q["id"])
            assert r is not None, "answer rejected"
        status1 = quiz_service.get_status(user_id, quiz_id)
        tiers1 = {t["difficulty"]: t for t in status1["tiers"]}
        check("moderate unlocks after 3 basic attempts", tiers1["moderate"]["unlocked"] is True, tiers1["moderate"]["unlocked"])
        for index in range(0, 3):  # first three moderate questions
            q = quiz["moderate"][index]
            r = quiz_service.record_answer(user_id, quiz_id, None, 1, question_id=q["id"])
            assert r is not None, "answer rejected"
        status2 = quiz_service.get_status(user_id, quiz_id)
        tiers2 = {t["difficulty"]: t for t in status2["tiers"]}
        check("difficult unlocks after basic>=3 AND moderate>=3",
              tiers2["advanced"]["unlocked"] is True, tiers2["advanced"]["unlocked"])

        print("== submission / scoring ==")
        sub = quiz_service.submit_quiz(user_id, quiz_id)
        check("submission returns feedback", sub is not None and "score" in sub, {k: sub.get(k) for k in ("score", "total", "correct", "answered")})
        quiz_after = quiz_service.get_quiz(user_id, quiz_id)
        check("questions persist across refresh", quiz_after is not None and quiz_after["total"] == 30)
        check("answers persist on the refresh", quiz_after["questions"] and quiz_after["questions"][0]["id"] == quiz["questions"][0]["id"])

        print("== non-WebDev goal still uses AI pipeline (offline guard) ==")
        other = quiz_service.prepare_goal_quiz(user_id, goal("React Fundamentals"))
        check("non-WebDev prepare falls through to generating", other["status"] == "generating", other)
        check("non-WebDev row is created separately",
              len(quiz_service.quiz_inventory(user_id)) == 2, len(quiz_service.quiz_inventory(user_id)))

        print("== topic scope for the Web Development catalog title ==")
        topic_result = quiz_service.prepare_quiz(
            user_id=user_id, topic="Web Development", scope="topic"
        )
        check("topic-scope Web Development prepare is ready", topic_result["status"] == "ready", topic_result)
        check("topic-scope row is separate from the goal row",
              len(quiz_service.quiz_inventory(user_id)) == 3, len(quiz_service.quiz_inventory(user_id)))
        tquiz = quiz_service.get_quiz(user_id, topic_result["quiz_id"])
        check("topic-scope quiz valid with 30 questions", tquiz is not None and tquiz["total"] == 30 and tquiz["valid"])

        print("== an existing AI-built Web Development goal quiz is replaced in place ==")
        stale_goal = {"id": "goal-stale-webdev", "title": "web development", "experienceLevel": "beginner"}
        now = quiz_service._now()
        conn = sqlite3.connect(quiz_service.DB_PATH)
        conn.execute(
            "INSERT INTO topic_quizzes "
            "(id, user_id, topic, lesson_id, level, goal_id, roadmap_id, generation_status, "
            " generation_stage, schema_version, scope, source_type, retest_of, focus_concepts, "
            " goal_context, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, NULL, 'ready', 'complete', ?, 'goal', "
            "'ai_generated_original', NULL, NULL, NULL, ?, ?)",
            ("qz-stale-webdev", user_id, "web development", "lesson-stale", "beginner", stale_goal["id"],
             quiz_service.SCHEMA_VERSION, now, now),
        )
        conn.execute(
            "INSERT INTO quiz_questions (id, quiz_id, user_id, goal_id, topic_id, topic, difficulty, "
            " position, tier_position, prompt, options_json, correct_index, explanation, concept, "
            " fingerprint, source_type, created_at) "
            "VALUES ('sq-1', 'qz-stale-webdev', ?, NULL, 'lesson-stale', 'web development', 'basic', 0, 1, "
            "'A legacy AI question about Ruby on Rails?', '[\"Ruby\",\"PHP\",\"Java\",\"Go\"]', 0, "
            "'A legacy AI explanation.', '', 'legacy fingerprint', 'ai_generated_original', ?)",
            (user_id, now),
        )
        conn.commit()
        conn.close()
        replaced = quiz_service.prepare_goal_quiz(user_id, stale_goal)
        check("stale AI row is reused (same id, no duplicate)", replaced["quiz_id"] == "qz-stale-webdev", replaced)
        stale_quiz = quiz_service.get_quiz(user_id, "qz-stale-webdev")
        check("stale AI row replaced in place with curated set",
              stale_quiz is not None and stale_quiz["total"] == 30 and stale_quiz["valid"], "ready 30 valid")
        check("the legacy question is gone from the set",
              all(q["prompt"] != "A legacy AI question about Ruby on Rails?" for q in stale_quiz["questions"]))
        rows = [r for r in quiz_service.quiz_inventory(user_id) if r["quiz_id"] == "qz-stale-webdev"]
        check("exactly one row for that goal quiz, now curated",
              len(rows) == 1 and rows[0]["complete"] is True and rows[0]["counts"]["basic"] == 10)
    finally:
        quiz_service.DB_PATH = original_db
        try:
            os.remove(path)
        except OSError:
            pass

    print(f"\n{CHECKS}/{CHECKS} curated Web Development checks passed")
    return 0


def _curated_data() -> list[tuple]:
    import curated_webdev

    return curated_webdev._QUESTIONS


def _curated_prompts() -> list[str]:
    import curated_webdev

    return [q["prompt"] for q in curated_webdev.build_questions()]


def _check_exact_answers(per_q: list) -> None:
    """Verify the stored question/answer text is byte-for-byte the supplied list."""
    for r, (tier, prompt, options, correct) in zip(per_q, _curated_data()):
        opts = __import__("json").loads(r["options_json"])
        incl_tier = r["difficulty"]
        check(
            f"Q stored exactly: {prompt}",
            r["prompt"] == prompt and opts == options and opts[r["correct_index"]] == correct,
            (opts, incl_tier),
        )


if __name__ == "__main__":
    raise SystemExit(main())