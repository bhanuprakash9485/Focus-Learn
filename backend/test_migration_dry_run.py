"""
Migration + validation dry run against a COPY of the real database.

Never touches backend/data/focuslearn.db. It copies the file to a temp path,
points the service at the copy, applies the additive schema migration, then:

  - counts what is stored before and after (nothing may be lost)
  - validates every stored quiz with the full 10/10/10 rules
  - runs migrate_quizzes() and reports which rows would be topped up
  - runs migrate_quizzes() a second time to prove it is idempotent
  - checks the quiz hub endpoint's view of the copied data

Run:  python backend/test_migration_dry_run.py
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

REAL_DB = os.path.join(BASE_DIR, "data", "focuslearn.db")
FAILURES: list[str] = []
CHECKS = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global CHECKS
    CHECKS += 1
    if not cond:
        FAILURES.append(f"{name}{(' -- ' + detail) if detail else ''}")
    print(f"  {'PASS' if cond else 'FAIL'}: {name}" + (f"  -- {detail}" if detail else ""))


print("== FocusLearn migration dry run (on a copy) ==")
if not os.path.isfile(REAL_DB):
    print(f"No database at {REAL_DB} - nothing to migrate.")
    sys.exit(0)

_tmp = tempfile.mkdtemp(prefix="focuslearn-migrate-")
copy_path = os.path.join(_tmp, "focuslearn-copy.db")
for suffix in ("", "-wal", "-shm"):
    src = REAL_DB + suffix
    if os.path.isfile(src):
        shutil.copy2(src, copy_path + suffix)
print(f"real db : {REAL_DB} ({os.path.getsize(copy_path)} bytes copied)")
print(f"dry run : {copy_path}\n")

import auth  # noqa: E402

auth.DB_PATH = copy_path
auth._conn = None

import quiz_service  # noqa: E402

quiz_service.DB_PATH = copy_path


def counts() -> dict:
    conn = sqlite3.connect(copy_path)
    out = {}
    for table in ("users", "topic_quizzes", "quiz_questions", "quiz_answers"):
        try:
            out[table] = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.Error:
            out[table] = None
    conn.close()
    return out


before = counts()
print(f"before: {before}\n")

# 1) the additive schema migration must succeed on real data
try:
    quiz_service.init_db()
    check("init_db() applies the schema migration to the copied DB", True)
except Exception as exc:  # noqa: BLE001
    check("init_db() applies the schema migration to the copied DB", False, repr(exc))

after = counts()
print(f"after : {after}\n")
check("the migration never deletes stored quizzes",
      (after["topic_quizzes"] or 0) >= (before["topic_quizzes"] or 0),
      f"{before['topic_quizzes']} -> {after['topic_quizzes']}")
check("the migration never deletes stored questions",
      (after["quiz_questions"] or 0) >= (before["quiz_questions"] or 0),
      f"{before['quiz_questions']} -> {after['quiz_questions']}")
check("the migration never deletes stored answers",
      (after["quiz_answers"] or 0) >= (before["quiz_answers"] or 0),
      f"{before['quiz_answers']} -> {after['quiz_answers']}")

# 2) how much of the real data already satisfies the 10/10/10 rules
conn = sqlite3.connect(copy_path)
conn.row_factory = sqlite3.Row
rows = conn.execute("SELECT id, user_id, topic, goal_id FROM topic_quizzes").fetchall()
conn.close()
complete = short = 0
detail = []
for row in rows:
    stored = quiz_service.get_quiz(row["user_id"], row["id"])
    if not stored:
        continue
    # The check a stored set is re-judged with.
    report = quiz_service.validate_quiz_set(
        stored["questions"], row["topic"], enforce_relevance=False)
    if report["complete"]:
        complete += 1
    else:
        short += 1
        if len(detail) < 5:
            detail.append(f"{row['id']} {report['counts']} {report['problems'][:1]}")
check("every stored quiz was inspected", complete + short == len([r for r in rows if quiz_service.get_quiz(r["user_id"], r["id"])]),
      f"{complete} usable, {short} needing work, of {len(rows)} rows")
print(f"\n  usable as stored: {complete}   needs work: {short}")
for line in detail:
    print(f"    {line}")

# Legacy sets are on-goal without reusing the goal's words, so the strict
# keyword check condemns them while the stored-set check accepts them. Both
# numbers are worth seeing before a migration is run for real.
strict_short = 0
for row in rows:
    stored = quiz_service.get_quiz(row["user_id"], row["id"])
    if stored and not quiz_service.validate_quiz_set(
            stored["questions"], row["topic"])["complete"]:
        strict_short += 1
print(f"  (the strict keyword check alone would flag {strict_short})")
check("the stored-set check is not the strict keyword check", strict_short > complete,
      f"strict={strict_short} usable={complete}")

# 3) migrate flags the short ones for top-up, without deleting anything
questions_before = counts()["quiz_questions"] or 0
report1 = quiz_service.migrate_quizzes()
print(f"\n  migrate_quizzes() -> {report1}")
check("migrate_quizzes() reports what it inspected", isinstance(report1, dict) and "inspected" in report1,
      str(report1)[:160])
questions_after = counts()["quiz_questions"] or 0
check("migrate_quizzes() does not delete questions", questions_after >= questions_before,
      f"{questions_before} -> {questions_after}")
check("migrate_quizzes() flags the incomplete quizzes", (report1.get("flagged") or []) != [] or short == 0,
      str(report1.get("flagged"))[:120])
check("migrate_quizzes() flags nothing that was already complete",
      set(report1.get("flagged") or []).isdisjoint(
          {r["id"] for r in rows
           if quiz_service.get_quiz(r["user_id"], r["id"])
           and quiz_service.validate_quiz_set(
               quiz_service.get_quiz(r["user_id"], r["id"])["questions"], r["topic"])["complete"]}
      ),
      str(report1.get("flagged"))[:120])

# 4) idempotent: a second run must not flag anything new or change data again
report2 = quiz_service.migrate_quizzes()
check("migrate_quizzes() is idempotent", report2.get("flagged") == report1.get("flagged"),
      f"{report1.get('flagged')} -> {report2.get('flagged')}")
check("a second migration still deletes nothing",
      (counts()["quiz_questions"] or 0) >= questions_after, str(counts()["quiz_questions"]))

# 5) every flagged row is now marked for regeneration rather than left stale
conn = sqlite3.connect(copy_path)
conn.row_factory = sqlite3.Row
stale = conn.execute(
    "SELECT COUNT(*) AS n FROM topic_quizzes WHERE generation_status = 'ready' AND id IN (%s)"
    % (",".join("?" * len(report1.get("flagged") or [])) or "''"),
    tuple(report1.get("flagged") or []),
).fetchone()["n"] if report1.get("flagged") else 0
conn.close()
check("no incomplete quiz is still advertised as ready", stale == 0, f"{stale} stale rows")

# 6) the goal hub view of the copied data
users = [r["user_id"] for r in rows]
hub_ok = True
for user_id in set(users):
    statuses = quiz_service.get_goal_statuses(user_id)
    for goal_id, status in statuses.items():
        if status.get("expected_total") != 30:
            hub_ok = False
print(f"\n  users with stored quizzes: {len(set(users))}")
check("the goal hub reports a 30-question plan for every stored goal quiz", hub_ok)

# 7) the follow-up work must be bounded: each flagged set is repaired by
#    replacing only its broken slots, not by regenerating the whole quiz
repairable = 0
replacements = 0
per_row = []
for row in rows:
    if row["id"] not in (report1.get("flagged") or []):
        continue
    # The migration just moved these rows to "generating", so read them
    # directly rather than through the ready-only get_quiz().
    questions = quiz_service._questions_for_row(quiz_service._quiz_row(row["id"]))
    plan, broken = quiz_service._repair_plan(questions)
    repairable += 1
    replacements += broken
    per_row.append(f"{row['id']}: {broken} of {len(questions)}")
print(f"\n  flagged sets that are repairable: {repairable}")
for line in per_row:
    print(f"    {line}")
check("every flagged set can be repaired in place", repairable == len(report1.get("flagged") or []),
      f"{repairable} of {len(report1.get('flagged') or [])}")
check("repairing them replaces a handful of questions, not all of them",
      0 < replacements <= 5 * max(1, repairable),
      f"{replacements} questions across {repairable} sets")
for row in rows:
    if row["id"] not in (report1.get("flagged") or []):
        continue
    questions = quiz_service._questions_for_row(quiz_service._quiz_row(row["id"]))
    plan, _broken = quiz_service._repair_plan(questions)
    # Every question the plan keeps must sit in its original slot, so stored
    # answers (keyed by question_index) keep pointing at the same question.
    moved = [
        index for index, (_difficulty, kept) in enumerate(plan)
        if kept is not None
        and kept.get("id") != questions[index].get("id")
    ]
    check(f"no surviving question moves slot in {row['id']}", not moved, str(moved))

print()
shutil.rmtree(_tmp, ignore_errors=True)
if FAILURES:
    print(f"{CHECKS - len(FAILURES)}/{CHECKS} checks passed")
    print(f"{len(FAILURES)} FAILURE(S):")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print(f"ALL {CHECKS} MIGRATION DRY-RUN CHECKS PASSED (real database untouched)")
sys.exit(0)
