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

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

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


def _is_rate_limit(exc: Exception) -> bool:
    """True when the underlying provider reported HTTP 429 (rate limit)."""
    status = getattr(exc, "status_code", None)
    if status == 429:
        return True
    name = type(exc).__name__.lower()
    code = str(getattr(exc, "code", "") or "").lower()
    message = str(getattr(exc, "message", "") or "").lower()
    return "ratelimit" in name or "rate_limit" in code or "rate limit" in message


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
        response = client.chat.completions.create(
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
        response = client.chat.completions.create(
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
# Topic quiz generation — 30+ validated, topic-specific questions
# ---------------------------------------------------------------------------

# Ordered from easiest to hardest. The frontend relies on this order to show
# the difficulty progression (basic -> moderate -> advanced).
QUIZ_DIFFICULTIES: tuple[str, ...] = ("basic", "moderate", "advanced")

# Default number of questions per topic quiz. Kept as a single knob so the
# quiz can grow to 40/50/60 without redesigning the pipeline.
DEFAULT_QUIZ_SIZE = 30

# How many questions the model is asked for in a single call. A smaller batch
# is more reliable; missing questions are topped up with extra calls.
_QUIZ_BATCH = 10

_DIFFICULTY_ALIASES = {
    "basic": "basic",
    "easy": "basic",
    "beginner": "basic",
    "foundation": "basic",
    "fundamental": "basic",
    "moderate": "moderate",
    "intermediate": "moderate",
    "medium": "moderate",
    "advanced": "advanced",
    "hard": "advanced",
    "difficult": "advanced",
    "expert": "advanced",
}

_QUIZ_STOPWORDS = frozenset(
    {
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "of", "to", "in", "on", "at", "by", "for", "with", "about", "into",
        "from", "as", "and", "or", "not", "no", "yes", "do", "does", "did",
        "what", "which", "who", "whom", "whose", "when", "where", "why",
        "how", "this", "that", "these", "those", "it", "its", "they", "them",
        "their", "there", "here", "you", "your", "we", "our", "us", "can",
        "could", "should", "would", "will", "shall", "may", "might", "must",
        "following", "best", "correct", "answer", "statement", "true", "false",
        "than", "then", "also", "such", "most", "more", "less", "used", "use",
        "using", "given", "one", "two", "three", "all", "any", "each", "some",
    }
)


def _significant_words(text: str) -> frozenset[str]:
    """Content words of a question, used to detect duplicates."""
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return frozenset(w for w in words if len(w) >= 3 and w not in _QUIZ_STOPWORDS)


def _is_duplicate_question(key: frozenset[str], existing: list[frozenset[str]]) -> bool:
    """True when *key* repeats (or nearly repeats) a question already kept."""
    if not key:
        return True
    for other in existing:
        if key == other:
            return True
        # Ignore tiny single-word overlaps (common topic words like "array")
        # and require a high Jaccard similarity before treating as duplicate.
        if len(key) < 2 or len(other) < 2:
            continue
        shared = len(key & other)
        if shared < 2:
            continue
        union = len(key | other)
        if union and shared / union >= 0.8:
            return True
    return False


def _quiz_target_counts(total: int, focus: bool = False) -> dict[str, int]:
    """Split *total* across the three difficulties, easiest tier first.

    The default (focus=False) split is as even as possible, so the canonical
    30-question quiz is exactly 10/10/10. A focused retest weights the harder
    tiers more heavily.
    """
    total = max(6, int(total))
    if focus:
        basic = max(1, round(total * 0.2))
        advanced = max(1, round(total * 0.4))
        intermediate = max(1, total - basic - advanced)
    else:
        basic = total // 3
        intermediate = total // 3
        advanced = total - basic - intermediate
    return {"basic": basic, "intermediate": intermediate, "advanced": advanced}


def _build_quiz_prompt(
    topic: str,
    level: str,
    counts: dict[str, int],
    focus_concepts: list[str],
    existing_prompts: list[str],
) -> str:
    basic, intermediate, advanced = (
        counts.get("basic", 0),
        counts.get("intermediate", 0),
        counts.get("advanced", 0),
    )
    total = basic + intermediate + advanced
    tier_lines = []
    if basic:
        tier_lines.append(
            f"- {basic} BASIC questions: definitions, terminology, fundamental concepts, "
            "simple examples, direct recognition."
        )
    if intermediate:
        tier_lines.append(
            f"- {intermediate} MODERATE questions: applying concepts, tracing simple "
            "logic, comparing approaches, small problems."
        )
    if advanced:
        tier_lines.append(
            f"- {advanced} ADVANCED questions: multi-step reasoning, edge cases, complexity "
            "or trade-off analysis, harder scenarios."
        )
    focus_block = ""
    if focus_concepts:
        focus_block = (
            "\nThe student was flagged for these weak concepts — every question MUST "
            "directly test one of them:\n- " + "\n- ".join(focus_concepts) + "\n"
        )
    avoid_block = ""
    if existing_prompts:
        avoid_block = (
            "\nDo NOT repeat or rephrase any of these already-written questions:\n- "
            + "\n- ".join(existing_prompts[:40])
            + "\n"
        )
    return (
        "You are FocusLearn's quiz author. Write multiple-choice questions about the "
        "EXACT topic below and nothing else.\n\n"
        f"TOPIC: {topic}\n"
        f"STUDENT LEVEL: {level}\n"
        f"{focus_block}{avoid_block}\n"
        f"Write EXACTLY {total} questions with this difficulty spread:\n"
        + "\n".join(tier_lines)
        + "\n\n"
        "Quality rules:\n"
        "- Every question must be genuinely specific to the topic (no filler, no "
        "off-topic or generic study questions).\n"
        "- Each question has exactly 4 options and exactly ONE correct answer.\n"
        "- Vary which option index is correct; do not always use the same position.\n"
        "- Every question must test a different concept — no duplicates or rephrasings.\n"
        "- 'concept' must be a short subtopic label (e.g. 'Tree Traversal').\n"
        "- 'explanation' must briefly justify the correct answer.\n"
        "- Do not use trick or ambiguous questions.\n\n"
        "Return ONLY valid JSON (no markdown fences, no commentary) matching EXACTLY:\n"
        "{\n"
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
    """Parse Groq output into validated question dicts (drops invalid rows)."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        # Some models return a bare JSON array.
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
        if len(options) < 2:
            continue

        raw_index = item.get(
            "correctIndex",
            item.get("correct_answer", item.get("correct_index", item.get("answer"))),
        )
        try:
            correct = int(raw_index)
        except (TypeError, ValueError):
            # Some models return the correct option's *text* or *letter* instead of an index.
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
            # Tolerate 1-based answers (1..len).
            if 1 <= correct <= len(options):
                correct -= 1
            else:
                continue

        difficulty = _DIFFICULTY_ALIASES.get(
            str(item.get("difficulty") or "").strip().lower(), ""
        )
        if not difficulty:
            continue

        concept = str(item.get("concept") or "").strip()[:80] or topic
        explanation = str(item.get("explanation") or "").strip()
        if not explanation:
            explanation = f"The correct answer follows from the definition of {concept}."

        questions.append(
            {
                "prompt": prompt[:600],
                "options": [o[:300] for o in options[:6]],
                "correctIndex": correct,
                "explanation": explanation[:600],
                "difficulty": difficulty,
                "concept": concept,
            }
        )
    return questions


def _quiz_call(
    topic: str,
    level: str,
    counts: dict[str, int],
    focus_concepts: list[str],
    existing_prompts: list[str],
) -> list[dict]:
    """One Groq call for a batch of questions. Returns [] on a bad payload."""
    client = Groq(api_key=_groq_key())
    messages = [
        {
            "role": "system",
            "content": "You are FocusLearn's quiz author. "
            "Output valid JSON only, with no extra text.",
        },
        {
            "role": "user",
            "content": _build_quiz_prompt(topic, level, counts, focus_concepts, existing_prompts),
        },
    ]
    content = ""
    # One structured attempt. On 429 we retry exactly once after a short
    # pause (a bounded policy), then stop immediately — never loop indefinitely.
    try:
        response = client.chat.completions.create(
            model=_MODEL,
            messages=messages,
            temperature=0.6,
            max_tokens=8192,
            response_format={"type": "json_object"},
        )
        content = (response.choices[0].message.content if response.choices else None) or ""
    except Exception as exc:
        if _is_rate_limit(exc):
            time.sleep(2.0)
            try:
                response = client.chat.completions.create(
                    model=_MODEL,
                    messages=messages,
                    temperature=0.6,
                    max_tokens=8192,
                    response_format={"type": "json_object"},
                )
                content = (response.choices[0].message.content if response.choices else None) or ""
            except Exception as exc2:
                if _is_rate_limit(exc2) or _is_rate_limit(exc):
                    raise QuizRateLimitError(RATE_LIMIT_MESSAGE) from exc2
                raise RuntimeError(
                    "Quiz generation is temporarily unavailable. Please try again."
                ) from exc2
        else:
            # The model occasionally fails strict JSON validation in json_object
            # mode; retry once without it and parse the text ourselves.
            try:
                response = client.chat.completions.create(
                    model=_MODEL,
                    messages=messages,
                    temperature=0.6,
                    max_tokens=8192,
                )
                content = (response.choices[0].message.content if response.choices else None) or ""
            except Exception:
                raise RuntimeError(
                    "Quiz generation is temporarily unavailable. Please try again."
                ) from exc
    try:
        return _coerce_quiz_questions(content, topic)
    except ValueError:
        return []


def generate_topic_quiz(
    topic: str,
    level: str = "beginner",
    total: int = DEFAULT_QUIZ_SIZE,
    focus_concepts: list[str] | None = None,
) -> dict:
    """Generate and validate a topic quiz with at least *total* questions.

    The result is ordered easiest-first and guaranteed to contain the full
    requested difficulty spread (10/10/10 by default). Missing questions are
    topped up with extra Groq calls; a malformed batch is retried. Raises
    ``GroqConfigurationError`` when Groq is unconfigured and ``RuntimeError``
    when a complete, valid quiz could not be produced.
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
    level = (level or "beginner").strip()[:20] or "beginner"
    try:
        total = int(total)
    except (TypeError, ValueError):
        total = DEFAULT_QUIZ_SIZE
    total = max(6, min(total, 60))

    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]
    counts = _quiz_target_counts(total, focus=bool(focus_concepts))

    collected: list[dict] = []
    keys: list[frozenset[str]] = []

    def count_for(difficulty: str) -> int:
        return sum(1 for q in collected if q["difficulty"] == difficulty)

    def ingest(items: list[dict]) -> None:
        for q in items:
            difficulty = q["difficulty"]
            if count_for(difficulty) >= counts[difficulty]:
                continue
            key = _significant_words(q["prompt"])
            if _is_duplicate_question(key, keys):
                continue
            collected.append(q)
            keys.append(key)

    # Generate tier by tier, in small batches, so no single call has to return
    # the whole quiz (large JSON responses get truncated by the model).
    for difficulty in QUIZ_DIFFICULTIES:
        attempts = 0
        while count_for(difficulty) < counts[difficulty] and attempts < 4:
            attempts += 1
            need = counts[difficulty] - count_for(difficulty)
            batch = min(need, _QUIZ_BATCH)
            existing_prompts = [q["prompt"] for q in collected]
            before = count_for(difficulty)
            try:
                ingest(
                    _quiz_call(
                        topic,
                        level,
                        {difficulty: batch},
                        focus_concepts,
                        existing_prompts,
                    )
                )
            except GroqConfigurationError:
                raise
            except QuizRateLimitError:
                # Stop this generation run immediately - never hammer a 429.
                raise
            except RuntimeError:
                continue
            if count_for(difficulty) == before:
                # No usable questions came back for this tier; stop retrying it.
                break

    ordered: list[dict] = []
    for difficulty in QUIZ_DIFFICULTIES:
        ordered.extend(
            [q for q in collected if q["difficulty"] == difficulty][: counts[difficulty]]
        )
    if len(ordered) < total:
        raise RuntimeError(
            "The AI could not produce a complete quiz with the required difficulty "
            "spread. Please try again."
        )
    for index, question in enumerate(ordered, start=1):
        question["id"] = f"q{index}"
    return {"topic": topic, "level": level, "total": len(ordered), "questions": ordered}


def generate_parallel_topic_quiz(
    topic: str,
    level: str = "beginner",
    total: int = DEFAULT_QUIZ_SIZE,
    focus_concepts: list[str] | None = None,
) -> dict:
    """Generate a topic quiz using three CONCURRENT difficulty batches.

    Requests 10 basic / 10 moderate / 10 advanced in parallel (three Groq
    calls total, never one per question), then de-duplicates across tiers,
    tops up any tier that came back short, and returns the combined quiz
    ordered basic -> moderate -> advanced.
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
    level = (level or "beginner").strip()[:20] or "beginner"
    try:
        total = int(total)
    except (TypeError, ValueError):
        total = DEFAULT_QUIZ_SIZE
    total = max(9, min(total, 60))

    focus_concepts = [
        str(c).strip()[:80] for c in (focus_concepts or []) if str(c).strip()
    ][:12]

    # Even 3-way split (10/10/10 for the default 30).
    basic = total // 3
    moderate = total // 3
    advanced = total - basic - moderate
    counts = {"basic": basic, "moderate": moderate, "advanced": advanced}

    # Thread-safe cross-tier duplicate guard.
    lock = threading.Lock()
    global_keys: list[frozenset[str]] = []

    def prompt_counts(difficulty: str, n: int) -> dict[str, int]:
        """Map a tier name to the prompt's basic/intermediate/advanced keys."""
        base = {"basic": 0, "intermediate": 0, "advanced": 0}
        key = "intermediate" if difficulty == "moderate" else difficulty
        base[key] = n
        return base

    def worker(difficulty: str, target: int) -> list[dict]:
        items: list[dict] = []
        attempts = 0
        while len(items) < target and attempts < 4:
            attempts += 1
            need = target - len(items)
            batch_existing = [q["prompt"] for q in items]
            try:
                batch = _quiz_call(
                    topic,
                    level,
                    prompt_counts(difficulty, min(need, _QUIZ_BATCH)),
                    focus_concepts,
                    batch_existing,
                )
            except GroqConfigurationError:
                raise
            except QuizRateLimitError:
                # Stop this generation run immediately - never hammer a 429.
                raise
            except RuntimeError:
                continue
            for q in batch:
                if q["difficulty"] != difficulty:
                    continue
                key = _significant_words(q["prompt"])
                with lock:
                    if _is_duplicate_question(key, global_keys):
                        continue
                    global_keys.append(key)
                items.append(q)
        return items

    collected: dict[str, list[dict]] = {d: [] for d in QUIZ_DIFFICULTIES}
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(worker, d, counts[d]): d for d in QUIZ_DIFFICULTIES
        }
        for future, difficulty in futures.items():
            collected[difficulty] = future.result()

    # Top up any tier still short after cross-tier de-duplication.
    for difficulty in QUIZ_DIFFICULTIES:
        for _ in range(3):
            if len(collected[difficulty]) >= counts[difficulty]:
                break
            need = counts[difficulty] - len(collected[difficulty])
            existing = [q["prompt"] for block in collected.values() for q in block]
            try:
                batch = _quiz_call(
                    topic,
                    level,
                    prompt_counts(difficulty, min(need, _QUIZ_BATCH)),
                    focus_concepts,
                    existing,
                )
            except GroqConfigurationError:
                raise
            except QuizRateLimitError:
                # Stop this generation run immediately - never hammer a 429.
                raise
            except RuntimeError:
                continue
            for q in batch:
                if q["difficulty"] != difficulty:
                    continue
                key = _significant_words(q["prompt"])
                if _is_duplicate_question(key, global_keys):
                    continue
                global_keys.append(key)
                collected[difficulty].append(q)

    ordered: list[dict] = []
    for difficulty in QUIZ_DIFFICULTIES:
        ordered.extend(collected[difficulty][: counts[difficulty]])
    if len(ordered) < total:
        raise RuntimeError(
            "The AI could not produce a complete quiz with the required difficulty "
            "spread. Please try again."
        )
    # Tier-scoped ids (basic-1..10, moderate-1..10, advanced-1..10) so the
    # frontend and review screens can address questions by tier + position.
    positions: dict[str, int] = {d: 0 for d in QUIZ_DIFFICULTIES}
    for question in ordered:
        positions[question["difficulty"]] += 1
        question["id"] = f"{question['difficulty']}-{positions[question['difficulty']]}"
    return {"topic": topic, "level": level, "total": len(ordered), "questions": ordered}