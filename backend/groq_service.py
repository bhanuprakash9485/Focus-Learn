"""
groq_service.py - FocusLearn AI Learning Guide service (Groq).

Generates a structured, study-ready "learning guide" for a topic using the
Groq API. The API key is read ONLY from the GROQ_API_KEY environment
variable (optionally sourced from a local .env file) and never leaves the
server - nothing key-related is shipped to the browser.

Usage::

    from groq_service import generate_learning_guide
    guide = generate_learning_guide("Java Recursion", student_level="beginner")

Returned dict keys: topic, overview, what_to_learn, key_concepts,
simple_explanation, example, common_mistakes, prerequisites, quick_check
(list of {"question", "answer"}), what_to_learn_next.

Requires the ``groq`` package (``pip install -r backend/requirements.txt``).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import quiz_originality

# Load secrets from a local .env (backend/.env or project root .env) without
# overriding a real environment variable - an exported GROQ_API_KEY always
# wins. Falls back to plain os.environ when python-dotenv is unavailable.
try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is optional
    def load_dotenv(*_args: Any, **_kwargs: Any) -> None:
        return None

_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_BASE_DIR)
load_dotenv(os.path.join(_BASE_DIR, ".env"))  # backend/.env
load_dotenv(os.path.join(_PROJECT_ROOT, ".env"))  # project root .env
load_dotenv()  # any .env in the CWD

try:
    from groq import Groq
except ImportError:  # pragma: no cover - exercised when the dependency is absent
    Groq = None  # type: ignore[assignment]

# Model is configurable via GROQ_MODEL so it can be swapped without a code
# change. Defaults to a high-quality general-purpose text model currently
# served by the Groq API.
_MODEL = os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b")

# gpt-oss is a REASONING model: on the default "medium" effort it spends a large
# number of tokens thinking before it writes anything. Writing a multiple-choice
# question is not a reasoning task, so the quiz calls ask for the cheapest effort
# level. Measured on a real 30-question run this is the difference between a
# quiz costing a few thousand tokens and one costing tens of thousands, which
# matters because Groq's free tier is capped at 200k tokens PER DAY.
_REASONING_EFFORT = (os.environ.get("GROQ_REASONING_EFFORT") or "low").strip().lower()
if _REASONING_EFFORT not in ("low", "medium", "high"):
    _REASONING_EFFORT = ""
# Flipped off automatically if the provider rejects the parameter, so a model
# that does not support reasoning_effort still works.
_REASONING_EFFORT_SUPPORTED = True

ARRAY_FIELDS = frozenset(
    {
        "what_to_learn",
        "key_concepts",
        "common_mistakes",
        "prerequisites",
        "quick_check",
        "what_to_learn_next",
    }
)

GUIDE_FIELDS: tuple[str, ...] = (
    "topic",
    "overview",
    "what_to_learn",
    "key_concepts",
    "simple_explanation",
    "example",
    "common_mistakes",
    "prerequisites",
    "quick_check",
    "what_to_learn_next",
)


class GroqConfigurationError(RuntimeError):
    """Raised when the Groq key or package is missing/misconfigured."""


class QuizRateLimitError(RuntimeError):
    """Raised when Groq returns HTTP 429 while generating a quiz.

    Generation must stop immediately (no long retry loop) and surface a
    friendly "rate limited" message instead of hanging or hammering the API.
    """


RATE_LIMIT_MESSAGE = (
    "Quiz preparation is temporarily unavailable because the AI service is "
    "rate limited. Please try again shortly."
)

# The study planner reuses the same provider, so it needs its own wording —
# telling a student "quiz preparation" while they are looking at their plan is
# confusing.
STUDY_PLAN_RATE_LIMIT_MESSAGE = (
    "The study assistant is taking a short break because the AI service is "
    "rate limited. Your existing plan is still here, so try again shortly."
)


def _is_rate_limit(exc: Exception) -> bool:
    """True when the underlying provider reported HTTP 429 (rate limit)."""
    status = getattr(exc, "status_code", None)
    if status == 429:
        return True
    name = type(exc).__name__.lower()
    code = str(getattr(exc, "code", "") or "").lower()
    message = str(getattr(exc, "message", "") or "").lower()
    return "ratelimit" in name or "rate_limit" in code or "rate limit" in message


def _chat_with_reasoning_effort(client: Groq, **kwargs: Any) -> Any:
    """Run one chat completion, applying the configured reasoning_effort.

    gpt-oss models reason first; without ``reasoning_effort`` a call can burn
    its whole token budget thinking before writing any content and take a long
    time on the free tier. Mirrors the quiz path: if the provider rejects the
    parameter, a module flag is flipped so every later call skips it (never a
    repeated-failure retry loop).
    """
    global _REASONING_EFFORT_SUPPORTED
    if _REASONING_EFFORT and _REASONING_EFFORT_SUPPORTED:
        try:
            return client.chat.completions.create(reasoning_effort=_REASONING_EFFORT, **kwargs)
        except Exception:
            _REASONING_EFFORT_SUPPORTED = False
    return client.chat.completions.create(**kwargs)


def groq_available() -> bool:
    """Return True when the groq package is importable."""
    return Groq is not None


def _groq_key() -> str:
    return (os.environ.get("GROQ_API_KEY") or "").strip()


def _build_prompt(query: str, video_title: str, video_description: str, student_level: str) -> str:
    title = video_title.strip() or "(no video title provided)"
    description = video_description.strip() or "(no video description provided)"
    level = student_level.strip() or "beginner"
    return (
        "You are a professional personal learning tutor building an AI Learning Guide "
        "inside FocusLearn, a distraction-free study app for students.\n\n"
        f"STUDENT'S EXACT SEARCH QUERY (the topic): {query}\n"
        f"SELECTED VIDEO TITLE: {title}\n"
        f"SELECTED VIDEO DESCRIPTION: {description}\n"
        f"STUDENT LEVEL: {level}\n\n"
        "Write a complete, high-quality learning guide for the EXACT topic in "
        "STUDENT'S EXACT SEARCH QUERY. Do NOT change, rename or reinterpret the topic, "
        "even if the video title or description is phrased differently. Use the video "
        "title/description for context only; never invent claims about the video's "
        "content, and if the description gives too little information, rely on general "
        "topic knowledge without pretending it came from the video.\n\n"
        "Keep language beginner-friendly by default. Be technically accurate, explain "
        "difficult concepts step-by-step, include simple and correct code examples when "
        "useful, and use real-life analogies only when they genuinely help. Keep the "
        "response easy to scan while watching a video.\n\n"
        "Return ONLY valid JSON (no markdown fences, no commentary), matching EXACTLY "
        "this schema:\n"
        "{\n"
        '  "topic": string, the exact topic as given, no editorializing,\n'
        '  "overview": string, 1-3 clear sentences on what the topic is,\n'
        '  "what_to_learn": [string], 3-6 concrete things to learn while watching,\n'
        '  "key_concepts": [string], 3-8 core concepts to understand,\n'
        '  "simple_explanation": string, plain-language explanation a '
        f"{level} student can follow,\n"
        '  "example": string, one concrete worked example tied closely to the topic '
        "(include short code or steps when helpful),\n"
        '  "common_mistakes": [string], 3-6 typical pitfalls and how to avoid them,\n'
        '  "prerequisites": [string], 2-5 things worth knowing before starting,\n'
        '  "quick_check": [{"question": string, "answer": string}], 3-5 short self-check questions,\n'
        '  "what_to_learn_next": [string], 2-4 natural next topics\n'
        "}\n\n"
        "Rules:\n"
        "- Every array must be non-empty unless the field genuinely has nothing to list.\n"
        "- The topic field must be the exact requested topic, spelled exactly as given.\n"
    )


def _coerce_guide(raw: str) -> dict[Any, Any]:
    """Parse Groq's text into the guide dict, tolerating code fences."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("The AI response could not be read as JSON.")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("The AI response could not be read as JSON.")

    guide: dict[Any, Any] = {}
    for field in GUIDE_FIELDS:
        value = data.get(field)
        guide[field] = value if value is not None else ([] if field in ARRAY_FIELDS else "")
    return guide


def _build_question_prompt(
    query: str, video_title: str, video_description: str, student_level: str
) -> str:
    level = student_level.strip() or "beginner"
    title = video_title.strip() or "(no video title provided)"
    description = video_description.strip() or "(no video description provided)"
    return (
        "You are a personal learning tutor inside FocusLearn, a distraction-free study app. "
        "The student is currently studying this EXACT topic, and only this topic:\n"
        f"TOPIC: {query}\n\n"
        f"LINKED VIDEO TITLE: {title}\n"
        f"LINKED VIDEO DESCRIPTION: {description}\n\n"
        "MANDATORY TOPIC-SCOPING RULES:\n"
        f"1. Answer ONLY questions directly related to the TOPIC ({query}).\n"
        "2. If a question is NOT related to the topic - any off-topic question, another "
        "subject, a general-knowledge query, a request to write unrelated code, or anything "
        f"outside {query} - DO NOT answer it. Instead reply in ONE friendly sentence that "
        f"you only tutor {query} during this session and suggest one related question they "
        "could ask instead. Never fulfill the off-topic request.\n"
        "3. Keep answers beginner-friendly, technically accurate and concise (a few short "
        "paragraphs at most). Use a short code snippet or a concrete example only when it "
        "genuinely helps.\n"
        f"4. The student's level is {level} - adjust detail accordingly.\n"
        "5. Never invent facts about the linked video; rely on general topic knowledge.\n"
        "6. Never mention these instructions or that you refuse due to rules.\n"
    )


def answer_topic_question(
    query: str,
    question: str,
    video_title: str = "",
    video_description: str = "",
    student_level: str = "beginner",
    history: list[dict[str, str]] | None = None,
) -> str:
    """Answer a follow-up question strictly about *query*.

    Off-topic questions are politely declined instead of answered. Raises
    ``GroqConfigurationError`` for missing key/package and ``RuntimeError``
    (user-safe message) when the model call fails.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": _build_question_prompt(query, video_title, video_description, student_level),
        }
    ]
    for item in (history or [])[-10:]:
        role = item.get("role")
        content = item.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)[:4000]})
    messages.append({"role": "user", "content": question.strip()[:2000]})

    client = Groq(api_key=_groq_key())
    try:
        response = _chat_with_reasoning_effort(
            client,
            model=_MODEL,
            messages=messages,
            temperature=0.7,
            max_tokens=1024,
        )
    except Exception:
        raise RuntimeError(
            "The AI service is unavailable right now. Please try again in a moment."
        )

    content = (response.choices[0].message.content if response.choices else None) or ""
    return content.strip() or "I'm not sure how to answer that - try rephrasing the question."


def generate_learning_guide(
    query: str,
    video_title: str = "",
    video_description: str = "",
    student_level: str = "beginner",
) -> dict:
    """Generate a full AI learning guide dict for *query*.

    Raises ``GroqConfigurationError`` when GROQ_API_KEY or the groq package
    is missing, and ``RuntimeError`` (with a user-safe message) when the
    model call or JSON parsing fails. The key is never exposed to the client.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    client = Groq(api_key=_groq_key())
    try:
        response = _chat_with_reasoning_effort(
            client,
            model=_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are a precise, encouraging personal tutor for students. "
                    "You always output valid JSON with no extra text.",
                },
                {
                    "role": "user",
                    "content": _build_prompt(
                        query.strip()[:200],
                        video_title[:300],
                        video_description[:3000],
                        student_level.strip()[:20] or "beginner",
                    ),
                },
            ],
            temperature=0.6,
            max_tokens=4096,
            response_format={"type": "json_object"},
        )
    except Exception:
        # Do not leak the underlying error or the API key — the client only
        # ever sees a friendly, generic failure message.
        raise RuntimeError(
            "The AI service is unavailable right now. Please try again in a moment."
        )

    content = (response.choices[0].message.content if response.choices else None) or ""
    return _coerce_guide(content)


# ── Adaptive performance analysis ───────────────────────────────────────────

_ANALYSIS_FIELDS = frozenset(
    {
        "score",
        "status",
        "strong_topics",
        "weak_topics",
        "revision_plan",
        "practice_recommendation",
        "retest_required",
        "recommended_next_topic",
        "message",
    }
)

_RECOMMEND_FIELDS = frozenset({"action", "next_topic", "reason"})


def _build_analysis_prompt(
    roadmap_topic: str,
    quiz_score: int,
    total_questions: int,
    questions: list[dict],
    answers: list[int],
    correct_answers: list[int],
) -> str:
    q_lines: list[str] = []
    for i, q in enumerate(questions):
        student_ans = q["options"][answers[i]] if i < len(answers) else "N/A"
        correct_ans = q["options"][correct_answers[i]] if i < len(correct_answers) else "N/A"
        is_correct = "Correct" if (i < len(answers) and i < len(correct_answers) and answers[i] == correct_answers[i]) else "Wrong"
        concept = q.get("concept", "General")
        difficulty = str(q.get("difficulty", "") or "").strip().lower()
        difficulty_tag = f" | Level: {difficulty}" if difficulty else ""
        q_lines.append(
            f"Q{i+1}: \"{q.get('prompt', '')}\" | Concept: {concept}{difficulty_tag} | "
            f"Student answer: {student_ans} | Correct: {correct_ans} | {is_correct}"
        )
    questions_block = "\n".join(q_lines)

    return (
        "You are an expert educational AI inside FocusLearn, an adaptive learning platform. "
        "Analyze the student's quiz performance and provide a structured analysis.\n\n"
        f"ROADMAP TOPIC: {roadmap_topic}\n"
        f"QUIZ SCORE: {quiz_score}/{total_questions} ({round(quiz_score / max(total_questions, 1) * 100)}%)\n\n"
        f"QUESTION-BY-QUESTION BREAKDOWN:\n{questions_block}\n\n"
        "INSTRUCTIONS:\n"
        "1. Identify which CONCEPTS (not just questions) the student is strong/weak in.\n"
        "2. Two questions testing the same concept count as ONE concept.\n"
        "3. Group weak concepts and recommend a focused revision plan.\n"
        "4. Determine if the student should pass, practice, or review.\n"
        "5. Recommend the next topic in the learning path.\n"
        "6. Weigh difficulty tiers: strong basics with weak advanced results means the "
        "fundamentals are solid but advanced problem-solving needs practice — say so.\n\n"
        "DECISION RULES:\n"
        "- score >= 80%: status='pass' — student understands, recommend next topic\n"
        "- score 60-79%: status='needs_practice' — partial understanding, identify weak concepts and recommend practice\n"
        "- score < 60%: status='review_required' — significant gaps, create revision plan\n\n"
        "Return ONLY valid JSON (no markdown fences), matching this schema:\n"
        "{\n"
        '  "score": number (the percentage score),\n'
        '  "status": "pass" | "needs_practice" | "review_required",\n'
        '  "strong_topics": [string], concepts the student clearly understands,\n'
        '  "weak_topics": [string], concepts the student struggles with,\n'
        '  "revision_plan": [{"topic": string, "reason": string, "priority": "high"|"medium"|"low"}],\n'
        '  "practice_recommendation": string, specific guidance on what to practice,\n'
        '  "retest_required": boolean, true if student should retest before moving on,\n'
        '  "recommended_next_topic": string, the next topic to learn if they pass,\n'
        '  "message": string, a brief encouraging summary of the analysis\n'
        "}\n\n"
        "Rules:\n"
        "- Analyze individual questions, NOT just the total score.\n"
        "- Never recommend reviewing ALL concepts — only the weak ones.\n"
        "- Always be encouraging and constructive.\n"
        "- The recommended_next_topic should be the logical next step in the roadmap.\n"
    )


def _coerce_analysis(raw: str) -> dict:
    """Parse Groq's text into the analysis dict, tolerating code fences."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("The AI analysis response could not be read as JSON.")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("The AI analysis response could not be read as JSON.")

    result: dict = {}
    for field in _ANALYSIS_FIELDS:
        value = data.get(field)
        if field in ("strong_topics", "weak_topics", "revision_plan"):
            result[field] = value if isinstance(value, list) else []
        elif field == "score":
            result[field] = int(value) if isinstance(value, (int, float)) else 0
        elif field == "retest_required":
            result[field] = bool(value)
        elif field == "status":
            # Fail-closed: an invalid status never counts as a pass.
            result[field] = value if value in ("pass", "needs_practice", "review_required") else "review_required"
        else:
            result[field] = str(value) if value is not None else ""
    return result


def analyze_performance(
    roadmap_topic: str,
    quiz_score: int,
    total_questions: int,
    questions: list[dict],
    answers: list[int],
    correct_answers: list[int],
) -> dict:
    """Analyze quiz performance using Groq AI.

    Raises ``GroqConfigurationError`` when GROQ_API_KEY or the groq package
    is missing, and ``RuntimeError`` (with a user-safe message) when the
    model call or JSON parsing fails.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    client = Groq(api_key=_groq_key())
    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert educational AI. Output valid JSON only.",
                },
                {
                    "role": "user",
                    "content": _build_analysis_prompt(
                        roadmap_topic[:200],
                        quiz_score,
                        total_questions,
                        questions,
                        answers,
                        correct_answers,
                    ),
                },
            ],
            temperature=0.5,
            max_tokens=2048,
            response_format={"type": "json_object"},
        )
    except Exception:
        raise RuntimeError(
            "The AI analysis service is unavailable right now. Please try again."
        )

    content = (response.choices[0].message.content if response.choices else None) or ""
    analysis = _coerce_analysis(content)

    # Deterministic enforcement of the adaptive mastery thresholds. The score
    # and status are derived from the actual attempt, never trusted from the
    # model — the model only supplies the narrative (strong/weak topics,
    # revision plan, recommendation). This guarantees the 80/60 contract
    # no matter what the model returns.
    percentage = round(100 * quiz_score / max(total_questions, 1))
    analysis["score"] = percentage
    if percentage >= 80:
        analysis["status"] = "pass"
    elif percentage >= 60:
        analysis["status"] = "needs_practice"
    else:
        analysis["status"] = "review_required"
    return analysis


def _build_recommend_prompt(
    roadmap_goal: str,
    roadmap_topics: list[dict],
    completed_topics: list[str],
    quiz_history: list[dict],
    weak_topics: list[str],
    current_topic: str,
) -> str:
    topics_desc = "\n".join(
        f"  - {t.get('name', '')} (status: {t.get('status', 'locked')}, "
        f"score: {t.get('lastScore', 'N/A')})"
        for t in roadmap_topics
    )
    history_desc = "\n".join(
        f"  - {h.get('topic', '')}: {h.get('score', 0)}%"
        for h in quiz_history
    ) if quiz_history else "  (no quiz history)"

    return (
        "You are an expert educational AI inside FocusLearn, an adaptive learning platform. "
        "Determine the most appropriate next learning activity for the student.\n\n"
        f"LEARNING GOAL: {roadmap_goal}\n\n"
        f"ROADMAP TOPICS:\n{topics_desc}\n\n"
        f"COMPLETED TOPICS: {', '.join(completed_topics) if completed_topics else 'None yet'}\n"
        f"CURRENT TOPIC: {current_topic}\n"
        f"QUIZ HISTORY:\n{history_desc}\n"
        f"WEAK AREAS: {', '.join(weak_topics) if weak_topics else 'None'}\n\n"
        "DECISION RULES:\n"
        "1. If the current topic was PASSED (score >= 80%): recommend 'continue' with the next logical topic.\n"
        "2. If the current topic has weak areas (score 60-79%): recommend 'practice' with the weakest concept.\n"
        "3. If the current topic FAILED (score < 60%): recommend 'review' with the most critical weak concept.\n"
        "4. Never skip ahead — the student must master each topic before moving on.\n"
        "5. Consider the roadmap structure — prerequisites matter.\n\n"
        "Return ONLY valid JSON (no markdown fences), matching this schema:\n"
        "{\n"
        '  "action": "continue" | "review" | "practice",\n'
        '  "next_topic": string, the specific concept/topic to focus on next,\n'
        '  "reason": string, a brief explanation of why this recommendation\n'
        "}\n\n"
        "Rules:\n"
        "- Be specific about which concept to review (e.g., 'Inheritance' not 'OOP').\n"
        "- Always be encouraging.\n"
        "- The reason should reference the student's actual performance data.\n"
    )


def _coerce_recommend(raw: str) -> dict:
    """Parse Groq's text into the recommendation dict."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("The AI recommendation response could not be read as JSON.")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("The AI recommendation response could not be read as JSON.")

    result: dict = {}
    for field in _RECOMMEND_FIELDS:
        value = data.get(field)
        if field == "action":
            result[field] = value if value in ("continue", "review", "practice") else "continue"
        else:
            result[field] = str(value) if value is not None else ""
    return result


def recommend_next_topic(
    roadmap_goal: str,
    roadmap_topics: list[dict],
    completed_topics: list[str],
    quiz_history: list[dict],
    weak_topics: list[str],
    current_topic: str,
) -> dict:
    """Recommend the next learning activity using Groq AI.

    Raises ``GroqConfigurationError`` when GROQ_API_KEY or the groq package
    is missing, and ``RuntimeError`` (with a user-safe message) when the
    model call or JSON parsing fails.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    client = Groq(api_key=_groq_key())
    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are an expert educational AI. Output valid JSON only.",
                },
                {
                    "role": "user",
                    "content": _build_recommend_prompt(
                        roadmap_goal[:200],
                        roadmap_topics,
                        completed_topics,
                        quiz_history,
                        weak_topics,
                        current_topic[:200],
                    ),
                },
            ],
            temperature=0.5,
            max_tokens=1024,
            response_format={"type": "json_object"},
        )
    except Exception:
        raise RuntimeError(
            "The AI recommendation service is unavailable right now. Please try again."
        )

    content = (response.choices[0].message.content if response.choices else None) or ""
    return _coerce_recommend(content)


# ── Dynamic AI roadmap generation ──────────────────────────────────────────

_ROADMAP_FIELDS = frozenset(
    {
        "title",
        "topic",
        "overview",
        "prerequisites",
        "phases",
        "final_goal",
        "total_estimated_minutes",
    }
)


def _build_roadmap_prompt(
    topic: str,
    level: str,
    study_time: str,
    goal: str,
    web_context: str,
) -> str:
    return (
        "You are FocusLearn's adaptive learning planner.\n\n"
        f"STUDENT TOPIC: {topic}\n"
        f"STUDENT LEVEL: {level}\n"
        f"STUDY TIME: {study_time}\n"
        f"LEARNING GOAL: {goal}\n\n"
        f"RETRIEVED INTERNET INFORMATION:\n{web_context}\n\n"
        "TASK:\n"
        "Generate a structured, personalized learning roadmap for the student's topic.\n"
        "Use the retrieved web information as supporting context — do NOT blindly copy it.\n"
        "Organize the topic from prerequisite concepts to advanced concepts.\n"
        "The roadmap must be suitable for the student's level and goal.\n\n"
        "IMPORTANT RULES:\n"
        "- The number of phases depends on the topic complexity (2-8 phases).\n"
        "- Each phase must have 2-6 topics.\n"
        "- Topics must be specific and actionable (not vague).\n"
        "- Include realistic time estimates per topic.\n"
        "- First phase should cover prerequisites if needed.\n"
        "- Last phase should include practical application or projects.\n"
        "- Every topic must have a clear description and learning objectives.\n\n"
        "Return ONLY valid JSON (no markdown fences, no commentary), matching EXACTLY this schema:\n"
        "{\n"
        '  "title": string, the roadmap title (e.g. "Java Recursion Learning Roadmap"),\n'
        '  "topic": string, the exact student topic as given,\n'
        '  "overview": string, 2-3 sentences describing what this roadmap covers,\n'
        '  "prerequisites": [string], 2-5 things the student should know before starting,\n'
        '  "phases": [\n'
        "    {\n"
        '      "id": string, unique phase id (e.g. "phase-1"),\n'
        '      "title": string, phase name (e.g. "Prerequisites", "Fundamentals"),\n'
        '      "description": string, 1-2 sentences about what this phase covers,\n'
        '      "topics": [\n'
        "        {\n"
        '          "id": string, unique topic id (e.g. "topic-1"),\n'
        '          "title": string, specific topic name,\n'
        '          "description": string, 1-2 sentences about what to learn,\n'
        '          "learning_objectives": [string], 2-4 specific things to understand,\n'
        '          "estimated_minutes": number, realistic time estimate in minutes (10-120),\n'
        '          "difficulty": "Beginner" | "Intermediate" | "Advanced",\n'
        '          "skills_gained": [string], 1-3 skills gained from this topic\n'
        "        }\n"
        "      ]\n"
        "    }\n"
        "  ],\n"
        '  "final_goal": string, what the student will be able to do after completing this roadmap,\n'
        '  "total_estimated_minutes": number, total estimated learning time\n'
        "}\n\n"
        "Rules:\n"
        "- Every array must be non-empty.\n"
        "- Topic ids must be unique across all phases.\n"
        "- estimated_minutes should be realistic (10-120 per topic).\n"
        "- The roadmap structure MUST change based on the topic — do not use a fixed template.\n"
        "- Difficulty should progress from Beginner to Advanced across phases.\n"
    )


def _coerce_roadmap(raw: str) -> dict:
    """Parse and validate Groq's roadmap JSON response."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("The AI roadmap response could not be read as JSON.")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("The AI roadmap response is not a JSON object.")

    # Validate required top-level fields
    if not data.get("title") or not isinstance(data.get("title"), str):
        data["title"] = "Learning Roadmap"
    if not data.get("topic") or not isinstance(data.get("topic"), str):
        raise RuntimeError("Roadmap is missing the topic field.")
    if not data.get("overview"):
        data["overview"] = "A structured learning path."
    if not isinstance(data.get("prerequisites"), list):
        data["prerequisites"] = []
    if not isinstance(data.get("phases"), list) or len(data["phases"]) == 0:
        raise RuntimeError("Roadmap has no learning phases.")

    # Validate and coerce phases
    clean_phases = []
    topic_counter = 0
    for phase in data["phases"]:
        if not isinstance(phase, dict):
            continue
        phase_id = phase.get("id", f"phase-{len(clean_phases) + 1}")
        phase_title = phase.get("title", f"Phase {len(clean_phases) + 1}")
        phase_desc = phase.get("description", "")
        topics = phase.get("topics")
        if not isinstance(topics, list) or len(topics) == 0:
            continue

        clean_topics = []
        for t in topics:
            if not isinstance(t, dict):
                continue
            topic_counter += 1
            topic_id = t.get("id", f"topic-{topic_counter}")
            topic_title = t.get("title", "")
            if not topic_title:
                continue
            clean_topics.append({
                "id": topic_id,
                "title": topic_title,
                "description": t.get("description", ""),
                "learning_objectives": t.get("learning_objectives", [])
                if isinstance(t.get("learning_objectives"), list) else [],
                "estimated_minutes": max(10, min(120, int(t.get("estimated_minutes", 30) or 30))),
                "difficulty": t.get("difficulty", "Beginner")
                if t.get("difficulty") in ("Beginner", "Intermediate", "Advanced") else "Beginner",
                "skills_gained": t.get("skills_gained", [])
                if isinstance(t.get("skills_gained"), list) else [],
            })

        if clean_topics:
            clean_phases.append({
                "id": phase_id,
                "title": phase_title,
                "description": phase_desc,
                "topics": clean_topics,
            })

    if not clean_phases:
        raise RuntimeError("Roadmap has no valid learning topics.")

    data["phases"] = clean_phases
    if not isinstance(data.get("total_estimated_minutes"), (int, float)):
        data["total_estimated_minutes"] = sum(
            t["estimated_minutes"]
            for p in clean_phases
            for t in p["topics"]
        )
    if not data.get("final_goal"):
        data["final_goal"] = f"Master {data['topic']}"

    return data


def create_roadmap(
    topic: str,
    level: str = "beginner",
    study_time: str = "1 hour/day",
    goal: str = "general learning",
    web_context: str = "",
) -> dict:
    """Generate a structured learning roadmap using Groq AI.

    Raises ``GroqConfigurationError`` when GROQ_API_KEY or the groq package
    is missing, and ``RuntimeError`` (with a user-safe message) when the
    model call or JSON parsing fails.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    client = Groq(api_key=_groq_key())
    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": "You are FocusLearn's adaptive learning planner. "
                    "Output valid JSON only.",
                },
                {
                    "role": "user",
                    "content": _build_roadmap_prompt(
                        topic[:200],
                        level[:20] or "beginner",
                        study_time[:50] or "1 hour/day",
                        goal[:200] or "general learning",
                        web_context[:3000],
                    ),
                },
            ],
            temperature=0.6,
            max_tokens=4096,
            response_format={"type": "json_object"},
        )
    except Exception:
        raise RuntimeError(
            "The AI roadmap service is unavailable right now. Please try again."
        )

    content = (response.choices[0].message.content if response.choices else None) or ""
    return _coerce_roadmap(content)


# ---------------------------------------------------------------------------
# Quiz generation — 10 basic + 10 moderate + 10 difficult per goal/topic
# ---------------------------------------------------------------------------

# Ordered easiest -> hardest. The quiz UI and the unlock ladder follow this
# order (basic -> moderate -> difficult/advanced).
QUIZ_DIFFICULTIES: tuple[str, ...] = ("basic", "moderate", "advanced")

# Every goal gets exactly 10 questions per difficulty tier.
QUESTIONS_PER_DIFFICULTY = 10
OPTIONS_PER_QUESTION = 4
GOAL_QUIZ_TOTAL = QUESTIONS_PER_DIFFICULTY * len(QUIZ_DIFFICULTIES)

# Retained for backwards compatibility with older callers of this module.
DEFAULT_QUIZ_SIZE = GOAL_QUIZ_TOTAL

# How many questions the model is asked for in a single call. A smaller batch
# is more reliable; missing questions are topped up with further calls.
_QUIZ_BATCH = 5

# Token ceiling for one quiz call. A 5-question batch needs roughly 1.5k; the
# rest is headroom for a reasoning model that thinks before answering.
try:
    _QUIZ_MAX_TOKENS = max(1024, int(os.environ.get("GROQ_QUIZ_MAX_TOKENS") or 3072))
except ValueError:
    _QUIZ_MAX_TOKENS = 3072

# Every stored question records where it came from. Nothing copied from an
# external source is ever stored, so this is always the AI-original marker.
SOURCE_TYPE_AI_ORIGINAL = "ai_generated_original"

# Bounded retry policy for one generation run. A 429 gets a short retry and
# one final attempt, then the run stops - no unbounded loops, ever.
_MAX_RUN_CALLS = 16
_MAX_RATE_LIMIT_RETRIES = 2
_RATE_LIMIT_BACKOFF_SECONDS = 2.0
_RUN_DEADLINE_SECONDS = 150.0
_MAX_BATCH_ATTEMPTS = 6

_DIFFICULTY_ALIASES = {
    "basic": "basic",
    "easy": "basic",
    "beginner": "basic",
    "foundation": "basic",
    "fundamental": "basic",
    "simple": "basic",
    "moderate": "moderate",
    "intermediate": "moderate",
    "medium": "moderate",
    "challenging": "moderate",
    "advanced": "advanced",
    "hard": "advanced",
    "difficult": "advanced",
    "expert": "advanced",
    "complex": "advanced",
}

# Prompt anchors per tier. They keep each tier asking for genuinely different
# cognitive work instead of "the same question, but longer".
_TIER_GUIDE: dict[str, str] = {
    "basic": (
        "BASIC questions test definitions, terminology, fundamental concepts, "
        "basic relationships, simple one-step examples and direct recognition. "
        "A beginner who just read the topic should answer them without "
        "extended reasoning. Use short, plain stems."
    ),
    "moderate": (
        "MODERATE questions require real reasoning: apply a concept to a small "
        "case, compare two approaches, interpret a short snippet or small "
        "data/example, choose the appropriate technique for a situation, or "
        "explain why a described behaviour happens. Never make these by "
        "lengthening a basic question."
    ),
    "advanced": (
        "DIFFICULT questions require multi-step reasoning and deeper "
        "understanding: trace multi-step work, analyse code or output, debug a "
        "broken scenario, reason about edge cases, weigh trade-offs between "
        "plausible designs, or diagnose why a system misbehaves. Difficulty "
        "must come from the reasoning, never from complicated wording alone."
    ),
}

# Rotating anchors so consecutive batches do not ask for the same shape again.
_TIER_ANGLES: dict[str, tuple[str, ...]] = {
    "basic": (
        "definition-and-terminology", "one-step-example", "identify-the-term",
        "single-fact-recognition", "relationship-between-two-ideas",
    ),
    "moderate": (
        "apply-concept-to-a-scenario", "compare-two-approaches",
        "choose-the-technique", "interpret-a-small-example",
        "explain-why-this-happens",
    ),
    "advanced": (
        "multi-step-reasoning", "predict-code-or-output", "debugging-reasoning",
        "edge-case-analysis", "trade-off-or-design-choice",
    ),
}

_TIER_CODE_NOTE = (
    "Where the topic is a programming topic you may include short code or "
    "output to reason about. Where it is not, use concrete realistic "
    "situations, data, systems or decisions instead of code."
)

# Generic/placeholder questions the pipeline must never store to reach a count.
_PLACEHOLDER_MARKERS = (
    "question coming soon",
    "coming soon",
    "sample question",
    "placeholder",
    "todo",
    "lorem ipsum",
    "what is x",
    "insert question",
    "add more questions",
    "n/a",
)


class GenerationBudget:
    """Bounded call/retry budget for a single quiz generation run.

    Guarantees termination: a run makes at most ``max_calls`` model calls,
    retries a rate-limited call at most ``max_rate_limit_retries`` times and
    gives up entirely once ``deadline_seconds`` have elapsed. A 429 therefore
    never turns into a multi-minute retry loop.
    """

    def __init__(
        self,
        max_calls: int = _MAX_RUN_CALLS,
        max_rate_limit_retries: int = _MAX_RATE_LIMIT_RETRIES,
        deadline_seconds: float = _RUN_DEADLINE_SECONDS,
        backoff_seconds: float = _RATE_LIMIT_BACKOFF_SECONDS,
    ) -> None:
        self.max_calls = max_calls
        self.max_rate_limit_retries = max_rate_limit_retries
        self.deadline_seconds = deadline_seconds
        self.backoff_seconds = backoff_seconds
        self.calls = 0
        self.rate_limit_hits = 0
        self.rate_limit_retries = 0
        self._started = time.monotonic()

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self._started

    @property
    def expired(self) -> bool:
        return self.elapsed >= self.deadline_seconds

    def can_call(self) -> bool:
        return self.calls < self.max_calls and not self.expired

    def record_call(self) -> None:
        self.calls += 1

    def note_rate_limit(self) -> bool:
        """Register a 429. Returns False when the budget is exhausted."""
        self.rate_limit_hits += 1
        if self.rate_limit_retries >= self.max_rate_limit_retries:
            return False
        self.rate_limit_retries += 1
        time.sleep(self.backoff_seconds)
        return True

    def summary(self) -> dict:
        return {
            "calls": self.calls,
            "rate_limit_hits": self.rate_limit_hits,
            "rate_limit_retries": self.rate_limit_retries,
            "elapsed_seconds": round(self.elapsed, 2),
            "expired": self.expired,
        }


def _looks_like_placeholder(prompt: str) -> bool:
    """True for filler questions the pipeline must never store."""
    lowered = f" {prompt.strip().lower()} "
    return any(marker in lowered for marker in _PLACEHOLDER_MARKERS)


def _target_correct_position(prompt: str, salt: str = "") -> int:
    """Deterministic option index (0-3) for the correct answer.

    Derived from the question text so a stored question keeps the same layout
    forever, while distinct questions spread across A/B/C/D instead of always
    landing on the same letter.
    """
    digest = hashlib.sha256(f"{prompt.strip()}|{salt}".encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % OPTIONS_PER_QUESTION


def _place_correct_option(question: dict, salt: str = "") -> dict:
    """Move the correct answer to a deterministic slot, keep the rest stable."""
    options = list(question["options"])
    correct_text = options[question["correctIndex"]]
    distractors = [o for i, o in enumerate(options) if i != question["correctIndex"]]
    position = _target_correct_position(question["prompt"], salt)
    reordered = distractors[:position] + [correct_text] + distractors[position:]
    question["options"] = reordered
    question["correctIndex"] = position
    return question


def validate_question(question: dict, difficulty: str) -> tuple[bool, str]:
    """Structural validation for one question. Returns (ok, reason)."""
    prompt = str(question.get("prompt") or "").strip()
    if len(prompt) < 15:
        return False, "question too short"
    if _looks_like_placeholder(prompt):
        return False, "placeholder question"
    options = question.get("options")
    if not isinstance(options, list):
        return False, "options missing"
    if len(options) != OPTIONS_PER_QUESTION:
        return False, f"expected exactly {OPTIONS_PER_QUESTION} options"
    if any(not str(o).strip() for o in options):
        return False, "empty option"
    if len({str(o).strip().lower() for o in options}) != OPTIONS_PER_QUESTION:
        return False, "duplicate options"
    correct = question.get("correctIndex")
    if not isinstance(correct, int) or not (0 <= correct < OPTIONS_PER_QUESTION):
        return False, "correct answer out of range"
    if question.get("difficulty") != difficulty:
        return False, "difficulty mismatch"
    if len(str(question.get("explanation") or "").strip()) < 10:
        return False, "explanation missing"
    return True, ""


def _build_quiz_prompt(
    topic: str,
    level: str,
    difficulty: str,
    count: int,
    focus_concepts: list[str],
    avoid_prompts: list[str],
    goal_context: str,
    angle: str,
) -> str:
    focus_block = ""
    if focus_concepts:
        focus_block = (
            "\nThe student is weak on these concepts - every question must "
            "directly test one of them:\n- "
            + "\n- ".join(focus_concepts)
            + "\n"
        )
    context_block = ""
    if goal_context:
        context_block = (
            "\nLEARNING CONTEXT (use it to keep every question on-goal, do not "
            "quote it back):\n" + goal_context[:1500] + "\n"
        )
    avoid_block = ""
    if avoid_prompts:
        avoid_block = (
            "\nALREADY WRITTEN - do not repeat or rephrase any of these "
            "questions; cover different ground instead:\n- "
            + "\n- ".join(avoid_prompts[:40])
            + "\n"
        )
    return (
        "You are FocusLearn's quiz author. You write NEW, original multiple-choice "
        "questions about the EXACT goal/topic below and nothing else.\n\n"
        f"GOAL / TOPIC: {topic}\n"
        f"STUDENT LEVEL: {level}\n"
        f"QUESTIONS TO WRITE NOW: {count}\n"
        f"DIFFICULTY TIER: {difficulty.upper()}\n"
        f"{context_block}{focus_block}{avoid_block}\n"
        f"{_TIER_GUIDE.get(difficulty, _TIER_GUIDE['basic'])}\n"
        f"Mix question shapes. This batch should emphasise: {angle}.\n"
        f"{_TIER_CODE_NOTE}\n\n"
        "ORIGINALITY RULES (mandatory):\n"
        "- Invent fresh wording and fresh scenarios. Never reproduce a question "
        "you have seen in a book, course, exam paper, question bank, tutorial "
        "website, video or an earlier AI answer.\n"
        "- Do not use one repeated sentence pattern with swapped nouns; each "
        "question should read differently from its neighbours.\n"
        "- Test different subtopics within the tier; no two questions may ask "
        "the same thing in different words.\n\n"
        "QUESTION RULES (mandatory):\n"
        f"- Exactly {OPTIONS_PER_QUESTION} options per question (A, B, C, D) and "
        "exactly ONE correct answer.\n"
        "- Every distractor must be plausible for someone who half-knows the "
        "topic - no silly or obviously wrong filler.\n"
        "- Spread the correct option across A/B/C/D; do not favour one letter.\n"
        "- 'concept' is a short subtopic label used for weak-area analysis.\n"
        "- 'explanation' must state WHY the correct answer is correct (1-2 "
        "sentences, original wording).\n"
        "- No trick wording, no ambiguity, no 'all of the above'.\n\n"
        "Return ONLY valid JSON (no markdown fences, no commentary):\n"
        '{\n'
        '  "topic": string,\n'
        '  "questions": [\n'
        "    {\n"
        '      "prompt": string,\n'
        '      "options": [string, string, string, string],\n'
        '      "correctIndex": integer (0-3),\n'
        '      "explanation": string,\n'
        '      "difficulty": "basic" | "moderate" | "advanced",\n'
        '      "concept": string\n'
        "    }\n"
        "  ]\n"
        "}\n"
    )


def _coerce_quiz_questions(raw: str, topic: str) -> list[dict]:
    """Parse a model response into question dicts (invalid rows are dropped)."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        a_start, a_end = text.find("["), text.rfind("]")
        if a_start == -1 or a_end <= a_start:
            raise ValueError("The quiz response could not be read as JSON.")
        data = json.loads(text[a_start : a_end + 1])
        raw_items = data
    else:
        data = json.loads(text[start : end + 1])
        raw_items = data.get("questions") if isinstance(data, dict) else data
    if not isinstance(raw_items, list):
        raise ValueError("The quiz response did not contain a questions list.")

    questions: list[dict] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or item.get("question") or "").strip()
        if len(prompt) < 5:
            continue
        raw_options = item.get("options")
        if not isinstance(raw_options, list):
            continue
        options = [str(o).strip() for o in raw_options if str(o).strip()]
        if len(options) < OPTIONS_PER_QUESTION:
            continue

        raw_index = item.get(
            "correctIndex",
            item.get("correct_answer", item.get("correct_index", item.get("answer"))),
        )
        try:
            correct = int(raw_index)
        except (TypeError, ValueError):
            # Some models return the correct option's text or letter instead.
            if isinstance(raw_index, str):
                letter = raw_index.strip().upper()
                if len(letter) == 1 and "A" <= letter <= "F":
                    correct = ord(letter) - ord("A")
                elif raw_index in options:
                    correct = options.index(raw_index)
                else:
                    continue
            else:
                continue
        if not (0 <= correct < len(options)):
            continue

        difficulty = _DIFFICULTY_ALIASES.get(
            str(item.get("difficulty") or "").strip().lower(), ""
        )
        if not difficulty:
            continue

        # Keep exactly 4 options, always preserving the correct answer.
        if len(options) > OPTIONS_PER_QUESTION:
            distractors = [o for i, o in enumerate(options) if i != correct]
            options = [options[correct]] + distractors[: OPTIONS_PER_QUESTION - 1]
            correct = 0

        concept = str(item.get("concept") or "").strip()[:80] or topic
        questions.append(
            {
                "prompt": prompt[:600],
                "options": [o[:300] for o in options],
                "correctIndex": correct,
                "explanation": str(item.get("explanation") or "").strip()[:600],
                "difficulty": difficulty,
                "concept": concept,
            }
        )
    return questions


def _quiz_call(
    topic: str,
    level: str,
    difficulty: str,
    count: int,
    focus_concepts: list[str],
    avoid_prompts: list[str],
    goal_context: str = "",
    angle: str = "",
    budget: GenerationBudget | None = None,
) -> list[dict]:
    """One bounded Groq call for a single difficulty tier."""
    budget = budget or GenerationBudget()
    if not budget.can_call():
        return []
    client = Groq(api_key=_groq_key())
    messages = [
        {
            "role": "system",
            "content": (
                "You are FocusLearn's quiz author. You only ever write new, "
                "original questions. Output valid JSON only, with no extra text."
            ),
        },
        {
            "role": "user",
            "content": _build_quiz_prompt(
                topic,
                level,
                difficulty,
                count,
                focus_concepts,
                avoid_prompts,
                goal_context,
                angle or _TIER_ANGLES.get(difficulty, ("",))[0],
            ),
        },
    ]

    def _create(structured: bool, with_reasoning_effort: bool = True) -> str:
        budget.record_call()
        kwargs = {
            "model": _MODEL,
            "messages": messages,
            "temperature": 0.85,
            # A 5-question batch of short stems, options and explanations fits
            # comfortably; 8192 was pure headroom that a reasoning model will
            # happily spend on thinking.
            "max_tokens": _QUIZ_MAX_TOKENS,
        }
        if structured:
            kwargs["response_format"] = {"type": "json_object"}
        if with_reasoning_effort and _REASONING_EFFORT and _REASONING_EFFORT_SUPPORTED:
            kwargs["reasoning_effort"] = _REASONING_EFFORT
        response = client.chat.completions.create(**kwargs)
        return (response.choices[0].message.content if response.choices else None) or ""

    content = ""
    try:
        content = _create(True)
    except Exception as exc:
        if _is_rate_limit(exc):
            # Bounded retry: one short pause, one more attempt, then stop.
            if not budget.note_rate_limit():
                raise QuizRateLimitError(RATE_LIMIT_MESSAGE) from exc
            if not budget.can_call():
                raise QuizRateLimitError(RATE_LIMIT_MESSAGE) from exc
            try:
                content = _create(True)
            except Exception as exc2:
                if _is_rate_limit(exc2):
                    raise QuizRateLimitError(RATE_LIMIT_MESSAGE) from exc2
                raise RuntimeError(
                    "Quiz generation is temporarily unavailable. Please try again."
                ) from exc2
        else:
            # Bounded fallbacks, cheapest reason first:
            #  1. this model may not accept reasoning_effort at all;
            #  2. strict JSON mode can fail, in which case we parse the text.
            # An empty response is NOT an error here: a reasoning model can
            # spend the whole token budget thinking, and the caller's bounded
            # loop simply asks again with a different angle.
            if not budget.can_call():
                raise RuntimeError(
                    "Quiz generation is temporarily unavailable. Please try again."
                ) from exc
            global _REASONING_EFFORT_SUPPORTED
            try:
                content = _create(True, with_reasoning_effort=False)
                _REASONING_EFFORT_SUPPORTED = False
            except Exception:
                if not budget.can_call():
                    raise RuntimeError(
                        "Quiz generation is temporarily unavailable. Please try again."
                    ) from exc
                try:
                    content = _create(False, with_reasoning_effort=False)
                except Exception as exc2:
                    raise RuntimeError(
                        "Quiz generation is temporarily unavailable. Please try again."
                    ) from exc2
    try:
        return _coerce_quiz_questions(content, topic)
    except ValueError:
        return []


def generate_quiz_tier(
    topic: str,
    difficulty: str,
    level: str = "beginner",
    count: int = QUESTIONS_PER_DIFFICULTY,
    focus_concepts: list[str] | None = None,
    avoid_prompts: list[str] | None = None,
    goal_context: str = "",
    budget: GenerationBudget | None = None,
) -> list[dict]:
    """Generate up to *count* validated, original questions for ONE tier.

    Every returned question has exactly 4 options, exactly one correct answer,
    a deterministic (shuffled) correct-answer position, an original explanation
    and has passed the duplicate / near-duplicate check against
    *avoid_prompts* (previously written or stored questions) and against the
    other questions of this batch.

    Returns fewer than *count* questions only when the bounded budget runs out
    (rate limit / model error) - the caller decides what to do with the gap and
    never stores a filler question to fill it.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    difficulty = _DIFFICULTY_ALIASES.get((difficulty or "").strip().lower(), "")
    if not difficulty:
        raise RuntimeError("Unknown quiz difficulty tier.")
    topic = (topic or "").strip()[:200]
    if not topic:
        raise RuntimeError("A topic is required to generate a quiz.")
    level = (level or "beginner").strip()[:20] or "beginner"
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = QUESTIONS_PER_DIFFICULTY
    count = max(1, min(count, 20))

    budget = budget or GenerationBudget()
    guard = quiz_originality.OriginalityGuard(existing=avoid_prompts or [])
    angles = _TIER_ANGLES.get(difficulty, ("",))
    accepted: list[dict] = []
    attempts = 0

    while len(accepted) < count and attempts < _MAX_BATCH_ATTEMPTS:
        attempts += 1
        if not budget.can_call():
            break
        need = count - len(accepted)
        batch = _quiz_call(
            topic=topic,
            level=level,
            difficulty=difficulty,
            count=min(need + 1, _QUIZ_BATCH),
            focus_concepts=focus_concepts or [],
            avoid_prompts=list(avoid_prompts or []) + [q["prompt"] for q in accepted],
            goal_context=goal_context,
            angle=angles[(attempts - 1) % len(angles)] if angles else "",
            budget=budget,
        )
        added = 0
        for question in batch:
            if question.get("difficulty") != difficulty:
                continue
            if len(accepted) >= count:
                break
            ok, _reason = validate_question(question, difficulty)
            if not ok:
                continue
            # Reject duplicates / near-duplicates; a replacement is requested
            # by the loop below instead of storing a repeat.
            if not guard.add(question["prompt"]):
                continue
            accepted.append(_place_correct_option(question, salt=difficulty))
            added += 1
        if added == 0 and not batch:
            continue
    return accepted


def _tier_counts(total: int) -> dict[str, int]:
    """Even 3-way split of *total* (30 -> 10/10/10)."""
    total = max(len(QUIZ_DIFFICULTIES), min(int(total), 60))
    basic = total // 3
    moderate = total // 3
    return {
        "basic": basic,
        "moderate": moderate,
        "advanced": total - basic - moderate,
    }


def _order_questions(collected: dict[str, list[dict]], counts: dict[str, int]) -> list[dict]:
    """Flatten tiers easiest-first with tier-scoped ids (basic-1..10, ...)."""
    ordered: list[dict] = []
    positions: dict[str, int] = {d: 0 for d in QUIZ_DIFFICULTIES}
    for difficulty in QUIZ_DIFFICULTIES:
        for question in collected.get(difficulty, [])[: counts.get(difficulty, 0)]:
            positions[difficulty] += 1
            question["id"] = f"{difficulty}-{positions[difficulty]}"
            ordered.append(question)
    return ordered


def generate_topic_quiz(
    topic: str,
    level: str = "beginner",
    total: int = DEFAULT_QUIZ_SIZE,
    focus_concepts: list[str] | None = None,
) -> dict:
    """Generate a full quiz tier by tier (10 basic / 10 moderate / 10 difficult).

    Kept for the stateless ``POST /api/ai/generate-quiz`` endpoint. Tiers are
    generated and validated independently, so a later failure never discards
    the questions already produced.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    topic = (topic or "").strip()[:200]
    if not topic:
        raise RuntimeError("A topic is required to generate a quiz.")
    try:
        total = int(total)
    except (TypeError, ValueError):
        total = DEFAULT_QUIZ_SIZE
    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]
    counts = _tier_counts(total)
    budget = GenerationBudget()
    guard = quiz_originality.OriginalityGuard()

    collected: dict[str, list[dict]] = {d: [] for d in QUIZ_DIFFICULTIES}
    for difficulty in QUIZ_DIFFICULTIES:
        produced = generate_quiz_tier(
            topic=topic,
            difficulty=difficulty,
            level=level,
            count=counts[difficulty],
            focus_concepts=focus_concepts,
            avoid_prompts=[q["prompt"] for block in collected.values() for q in block],
            budget=budget,
        )
        for question in produced:
            if guard.add(question["prompt"]):
                collected[difficulty].append(question)

    ordered = _order_questions(collected, counts)
    if len(ordered) < total:
        raise RuntimeError(
            "The AI could not produce a complete quiz with the required "
            "difficulty spread. Please try again."
        )
    return {
        "topic": topic,
        "level": level,
        "total": len(ordered),
        "source_type": SOURCE_TYPE_AI_ORIGINAL,
        "questions": ordered,
        "generation": budget.summary(),
    }


def generate_parallel_topic_quiz(
    topic: str,
    level: str = "beginner",
    total: int = DEFAULT_QUIZ_SIZE,
    focus_concepts: list[str] | None = None,
    goal_context: str = "",
) -> dict:
    """Generate the three difficulty tiers in PARALLEL and combine them.

    Three bounded workers (one per tier) run under a shared budget; each tier
    is validated and de-duplicated against the others, so the result is
    always 10 basic + 10 moderate + 10 difficult when generation succeeds.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")

    topic = (topic or "").strip()[:200]
    if not topic:
        raise RuntimeError("A topic is required to generate a quiz.")
    try:
        total = int(total)
    except (TypeError, ValueError):
        total = DEFAULT_QUIZ_SIZE
    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]
    counts = _tier_counts(total)
    budget = GenerationBudget()

    # Cross-tier duplicate guard shared by the parallel workers.
    lock = threading.Lock()
    guard = quiz_originality.OriginalityGuard()

    def worker(difficulty: str) -> list[dict]:
        produced = generate_quiz_tier(
            topic=topic,
            difficulty=difficulty,
            level=level,
            count=counts[difficulty],
            focus_concepts=focus_concepts,
            goal_context=goal_context,
            budget=budget,
        )
        kept: list[dict] = []
        for question in produced:
            with lock:
                if not guard.add(question["prompt"]):
                    continue
            kept.append(question)
        return kept

    collected: dict[str, list[dict]] = {d: [] for d in QUIZ_DIFFICULTIES}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(worker, d): d for d in QUIZ_DIFFICULTIES
        }
        for future, difficulty in futures.items():
            collected[difficulty] = future.result()

    ordered = _order_questions(collected, counts)
    if len(ordered) < total:
        raise RuntimeError(
            "The AI could not produce a complete quiz with the required "
            "difficulty spread. Please try again."
        )
    return {
        "topic": topic,
        "level": level,
        "total": len(ordered),
        "source_type": SOURCE_TYPE_AI_ORIGINAL,
        "questions": ordered,
        "generation": budget.summary(),
    }


# ---------------------------------------------------------------------------
# Adaptive study planner — orders the student's REAL work, invents nothing
# ---------------------------------------------------------------------------

# Priorities the planner may assign. Priority never changes question difficulty;
# it only decides what is shown first.
_STUDY_PRIORITIES = ("high", "medium", "low")
# A day is never planned beyond this, whatever the AI asks for.
_STUDY_MAX_DAY_MINUTES = 240
_STUDY_MAX_TASKS = 14
_STUDY_MIN_TASK_MINUTES = 5


def _build_study_plan_prompt(context: dict) -> str:
    """Render the student's real state into a planner prompt.

    The candidate list is the complete set of things the planner is allowed to
    schedule. Anything the model returns that is not in this list is discarded
    by ``_coerce_study_plan`` — the AI can order real work, it cannot invent it.
    """
    candidates = context.get("candidates") or []
    lines = []
    for c in candidates:
        prereq = ", ".join(c.get("prerequisites") or []) or "none"
        lines.append(
            f"- ref={c.get('ref')} | kind={c.get('kind')} | {c.get('minutes')} min | "
            f"step={c.get('step')} | requires=[{prereq}] | title={c.get('title')}"
        )
    attempts = context.get("quiz_attempts") or []
    attempt_text = (
        ", ".join(f"{a.get('topic')} {a.get('percentage')}%" for a in attempts[:15]) or "none yet"
    )
    completed = context.get("completed_lesson_ids") or []
    return (
        "You are FocusLearn's study planner. You decide what a student should study "
        "today and for the rest of their week.\n\n"
        f"GOAL: {context.get('goal') or 'general learning'}\n"
        f"TODAY: {context.get('today')}\n"
        f"DAILY TARGET: {context.get('daily_target_minutes')} minutes (never exceed it per day)\n"
        f"TARGET DATE: {context.get('target_date') or 'not set'}\n"
        f"MISSED SESSIONS SO FAR: {context.get('missed_count', 0)}\n"
        f"ALREADY FINISHED ({len(completed)}): {', '.join(map(str, completed[:40])) or 'none'}\n"
        f"QUIZ RESULTS (real): {attempt_text}\n"
        f"WEAK TOPICS (real missed questions): {', '.join(context.get('weak_topics') or []) or 'none'}\n\n"
        "CANDIDATE TASKS (you may ONLY use these refs, exactly as written):\n"
        + ("\n".join(lines) or "- (none)")
        + "\n\n"
        "Rules:\n"
        "1. Only return refs from the candidate list. Never invent a topic.\n"
        "2. Never schedule a task before its prerequisites are finished, unless the "
        "prerequisite is also in the same day before it.\n"
        "3. If a quiz score was under 60%, put a review or retake of that topic first.\n"
        "4. Respect the daily target: the minutes for one day must not exceed it.\n"
        "5. If everything is finished, return an empty list.\n\n"
        'Return ONLY valid JSON: {"summary": "one short sentence", "tasks": '
        '[{"ref": "...", "minutes": 15, "priority": "high", "reason": "one short '
        'sentence based on the real data above"}]}'
    )


def _coerce_study_plan(raw: str, context: dict) -> dict:
    """Parse the model's plan, keeping only tasks that map to real candidates."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return {"summary": "", "tasks": []}
    try:
        data = json.loads(text[start : end + 1])
    except ValueError:
        return {"summary": "", "tasks": []}
    if not isinstance(data, dict):
        return {"summary": "", "tasks": []}

    known = {str(c.get("ref")): c for c in (context.get("candidates") or []) if c.get("ref")}
    try:
        daily_target = int(context.get("daily_target_minutes") or 0)
    except (TypeError, ValueError):
        daily_target = 0
    cap = min(daily_target or 30, _STUDY_MAX_DAY_MINUTES)

    tasks: list[dict] = []
    used_refs: set[str] = set()
    for item in data.get("tasks") or []:
        if not isinstance(item, dict) or len(tasks) >= _STUDY_MAX_TASKS:
            continue
        ref = str(item.get("ref") or "").strip()
        # Anything outside the student's real candidate list is dropped.
        candidate = known.get(ref)
        if not candidate or ref in used_refs:
            continue
        try:
            minutes = int(item.get("minutes"))
        except (TypeError, ValueError):
            minutes = int(candidate.get("minutes") or cap)
        minutes = max(_STUDY_MIN_TASK_MINUTES, min(minutes, cap))
        priority = str(item.get("priority") or "").strip().lower()
        if priority not in _STUDY_PRIORITIES:
            priority = "medium"
        reason = str(item.get("reason") or "").strip()[:200]
        used_refs.add(ref)
        tasks.append(
            {
                "kind": str(candidate.get("kind") or "lesson"),
                "ref": ref,
                "title": str(candidate.get("title") or ref)[:120],
                "estimatedMinutes": minutes,
                "priority": priority,
                "reason": reason or "Recommended for today",
            }
        )
    summary = str(data.get("summary") or "").strip()[:240]
    return {"summary": summary, "tasks": tasks}


def build_study_plan(context: dict) -> dict:
    """Ask Groq to order the student's real remaining work.

    Raises ``GroqConfigurationError`` when the AI is not configured and
    ``QuizRateLimitError`` on a 429, so the caller can fall back to the
    deterministic planner instead of showing an empty plan.
    """
    if not groq_available():
        raise GroqConfigurationError(
            "groq is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _groq_key():
        raise GroqConfigurationError("Groq API key is not configured.")
    if not (context.get("candidates") or []):
        return {"summary": "", "tasks": []}

    client = Groq(api_key=_groq_key())
    kwargs: dict = {
        "model": _MODEL,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are FocusLearn's study planner. Use only the real data you are "
                    "given. Output valid JSON only."
                ),
            },
            {"role": "user", "content": _build_study_plan_prompt(context)},
        ],
        "temperature": 0.5,
        "max_tokens": 2048,
        "response_format": {"type": "json_object"},
    }
    if _REASONING_EFFORT and _REASONING_EFFORT_SUPPORTED:
        # Planning is a light task; do not spend the daily token budget thinking.
        kwargs["reasoning_effort"] = _REASONING_EFFORT
    try:
        response = client.chat.completions.create(**kwargs)
    except Exception as exc:
        if _is_rate_limit(exc):
            raise QuizRateLimitError(STUDY_PLAN_RATE_LIMIT_MESSAGE) from exc
        raise RuntimeError("The study assistant is unavailable right now.") from exc

    content = (response.choices[0].message.content if response.choices else None) or ""
    plan = _coerce_study_plan(content, context)
    if not plan["tasks"]:
        raise RuntimeError("The study assistant did not return a usable plan.")
    return plan
