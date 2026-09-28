"""Tests for the Study Plan AI endpoint's validation layer.

These are deliberately offline: the planner prompt is rendered and the model's
JSON is coerced against a candidate list, so we can prove the AI cannot invent a
topic, cannot exceed the daily target, and cannot return a malformed plan —
without spending a single token.
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import groq_service  # noqa: E402

CONTEXT = {
    "mode": "today",
    "goal": "Pass the Python certification",
    "today": "2026-09-28",
    "daily_target_minutes": 30,
    "target_date": "2026-11-30",
    "missed_count": 2,
    "candidates": [
        {
            "ref": "review:lists",
            "kind": "review",
            "title": "Review: Lists",
            "minutes": 15,
            "step": "Weak areas",
            "prerequisites": [],
        },
        {
            "ref": "lesson-python-lists",
            "kind": "lesson",
            "title": "Python Lists",
            "minutes": 20,
            "step": "Basics",
            "prerequisites": [],
        },
        {
            "ref": "quiz:python-lists",
            "kind": "quiz",
            "title": "Python Lists quiz",
            "minutes": 10,
            "step": "Basics",
            "prerequisites": ["lesson-python-lists"],
        },
    ],
    "quiz_attempts": [{"topic": "Python Lists", "percentage": 42}],
    "weak_topics": ["Lists"],
    "completed_lesson_ids": [],
}


class TestStudyPlanPrompt(unittest.TestCase):
    def test_prompt_lists_every_candidate_with_its_dependencies(self):
        prompt = groq_service._build_study_plan_prompt(CONTEXT)
        for c in CONTEXT["candidates"]:
            self.assertIn(c["ref"], prompt)
        self.assertIn("lesson-python-lists", prompt)
        self.assertIn("42%", prompt, "real quiz score must reach the model")
        self.assertIn("Lists", prompt, "real weak topic must reach the model")

    def test_prompt_survives_missing_optional_data(self):
        empty = dict(CONTEXT, quiz_attempts=[], weak_topics=[], completed_lesson_ids=[])
        self.assertIn("CANDIDATE TASKS", groq_service._build_study_plan_prompt(empty))
        self.assertIn("none yet", groq_service._build_study_plan_prompt(empty))

    def test_prompt_contains_no_secret(self):
        prompt = groq_service._build_study_plan_prompt(CONTEXT)
        self.assertNotIn("gsk_", prompt)
        self.assertNotIn(os.environ.get("GROQ_API_KEY") or "@@none@@", prompt)


class TestStudyPlanCoercion(unittest.TestCase):
    def test_valid_plan_is_accepted(self):
        raw = json.dumps(
            {
                "summary": "You are behind on Lists.",
                "tasks": [
                    {
                        "ref": "review:lists",
                        "minutes": 15,
                        "priority": "high",
                        "reason": "Last score was 42%.",
                    }
                ],
            }
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(plan["summary"], "You are behind on Lists.")
        self.assertEqual(len(plan["tasks"]), 1)
        task = plan["tasks"][0]
        self.assertEqual(task["ref"], "review:lists")
        self.assertEqual(task["kind"], "review")
        self.assertEqual(task["title"], "Review: Lists")
        self.assertEqual(task["priority"], "high")
        self.assertEqual(task["estimatedMinutes"], 15)

    def test_invented_topics_are_discarded(self):
        raw = json.dumps(
            {
                "summary": "",
                "tasks": [
                    {"ref": "lesson-python-asyncio", "minutes": 20, "priority": "high"},
                    {"ref": "review:lists", "minutes": 15, "priority": "high"},
                ],
            }
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        refs = [t["ref"] for t in plan["tasks"]]
        self.assertEqual(refs, ["review:lists"], f"AI invented work: {refs}")

    def test_title_comes_from_the_candidate_not_the_model(self):
        raw = json.dumps(
            {
                "summary": "",
                "tasks": [
                    {"ref": "lesson-python-lists", "title": "Certified Kubernetes Expert", "minutes": 10}
                ],
            }
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(plan["tasks"][0]["title"], "Python Lists")

    def test_minutes_cannot_exceed_the_daily_target(self):
        raw = json.dumps(
            {
                "summary": "",
                "tasks": [{"ref": "lesson-python-lists", "minutes": 9999, "priority": "high"}],
            }
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(plan["tasks"][0]["estimatedMinutes"], 30)

    def test_absurd_minutes_are_floored_to_a_usable_block(self):
        raw = json.dumps(
            {"summary": "", "tasks": [{"ref": "lesson-python-lists", "minutes": 0}]}
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertGreaterEqual(plan["tasks"][0]["estimatedMinutes"], 5)

    def test_unknown_priority_falls_back_to_medium(self):
        raw = json.dumps(
            {"summary": "", "tasks": [{"ref": "review:lists", "minutes": 15, "priority": "URGENT!!"}]}
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(plan["tasks"][0]["priority"], "medium")

    def test_duplicate_refs_are_collapsed(self):
        raw = json.dumps(
            {
                "summary": "",
                "tasks": [
                    {"ref": "review:lists", "minutes": 15},
                    {"ref": "review:lists", "minutes": 10},
                ],
            }
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(len(plan["tasks"]), 1)

    def test_json_fences_and_surrounding_text_are_tolerated(self):
        raw = "Sure! Here is your plan:\n```json\n" + json.dumps(
            {"summary": "ok", "tasks": [{"ref": "review:lists", "minutes": 15}]}
        ) + "\n```\nHope that helps!"
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(len(plan["tasks"]), 1)

    def test_garbage_returns_no_tasks_instead_of_crashing(self):
        for raw in ["", "not json at all", "{broken", "[]", "null", '{"tasks": "nope"}']:
            plan = groq_service._coerce_study_plan(raw, CONTEXT)
            self.assertEqual(plan["tasks"], [], f"unexpected tasks from {raw!r}")

    def test_task_count_is_bounded(self):
        many = {
            "summary": "",
            "tasks": [{"ref": "review:lists", "minutes": 5} for _ in range(50)],
        }
        plan = groq_service._coerce_study_plan(json.dumps(many), CONTEXT)
        self.assertLessEqual(len(plan["tasks"]), groq_service._STUDY_MAX_TASKS)

    def test_summary_is_length_limited(self):
        raw = json.dumps({"summary": "x" * 5000, "tasks": [{"ref": "review:lists", "minutes": 15}]})
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertLessEqual(len(plan["summary"]), 240)

    def test_reason_is_length_limited(self):
        raw = json.dumps(
            {"summary": "", "tasks": [{"ref": "review:lists", "minutes": 15, "reason": "y" * 5000}]}
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertLessEqual(len(plan["tasks"][0]["reason"]), 200)

    def test_non_string_fields_do_not_crash(self):
        raw = json.dumps(
            {"summary": 123, "tasks": [{"ref": None, "minutes": "abc", "reason": {"a": 1}}]}
        )
        plan = groq_service._coerce_study_plan(raw, CONTEXT)
        self.assertEqual(plan["tasks"], [])

    def test_no_candidates_yields_no_tasks(self):
        raw = json.dumps({"summary": "x", "tasks": [{"ref": "anything", "minutes": 10}]})
        plan = groq_service._coerce_study_plan(raw, dict(CONTEXT, candidates=[]))
        self.assertEqual(plan["tasks"], [])


class TestBuildStudyPlanGuards(unittest.TestCase):
    def test_empty_candidate_list_never_calls_the_model(self):
        # No key is set here, so reaching the client would raise; returning
        # early is what keeps the endpoint cheap and always available.
        self.assertEqual(groq_service.build_study_plan(dict(CONTEXT, candidates=[])), {"summary": "", "tasks": []})

    def test_missing_key_raises_configuration_error(self):
        old = os.environ.get("GROQ_API_KEY")
        os.environ.pop("GROQ_API_KEY", None)
        try:
            with self.assertRaises(groq_service.GroqConfigurationError):
                groq_service.build_study_plan(CONTEXT)
        finally:
            if old is not None:
                os.environ["GROQ_API_KEY"] = old

    def test_rate_limit_error_is_a_runtime_error_the_server_can_map(self):
        self.assertTrue(issubclass(groq_service.QuizRateLimitError, RuntimeError))
        self.assertTrue(issubclass(groq_service.GroqConfigurationError, RuntimeError))


if __name__ == "__main__":
    unittest.main(verbosity=2)
