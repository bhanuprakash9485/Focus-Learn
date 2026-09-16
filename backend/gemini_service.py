"""
gemini_service.py - FocusLearn AI Learning Guide service (Google Gemini).

Generates a structured, study-ready "learning guide" for a topic using the
Gemini API. The API key is read ONLY from the GEMINI_API_KEY environment
variable (optionally sourced from a local .env file) and never leaves the
server - nothing key-related is shipped to the browser.

Usage::

    from gemini_service import generate_learning_guide
    guide = generate_learning_guide("Java Recursion", student_level="beginner")

Returned dict keys: topic_overview, learning_objectives, key_concepts,
simple_explanation, example, common_mistakes, prerequisites,
quick_check_questions (list of {"question", "answer"}), what_to_learn_next.

Requires the ``google-genai`` package (``pip install -r backend/requirements.txt``).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

# Load secrets from a local .env (backend/.env or project root .env) without
# overriding a real environment variable - an exported GEMINI_API_KEY always
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
    from google import genai
    from google.genai import types
except ImportError:  # pragma: no cover - exercised when the dependency is absent
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]

_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")

ARRAY_FIELDS = frozenset(
    {
        "learning_objectives",
        "key_concepts",
        "common_mistakes",
        "prerequisites",
        "quick_check_questions",
        "what_to_learn_next",
    }
)

GUIDE_FIELDS: tuple[str, ...] = (
    "topic_overview",
    "learning_objectives",
    "key_concepts",
    "simple_explanation",
    "example",
    "common_mistakes",
    "prerequisites",
    "quick_check_questions",
    "what_to_learn_next",
)


class GeminiConfigurationError(RuntimeError):
    """Raised when the Gemini key or package is missing/misconfigured."""


def gemini_available() -> bool:
    """Return True when the google-genai package is importable."""
    return genai is not None and types is not None


def _gemini_key() -> str:
    return (os.environ.get("GEMINI_API_KEY") or "").strip()


def _build_prompt(query: str, video_title: str, video_description: str, student_level: str) -> str:
    title = video_title.strip() or "(no video title provided)"
    description = video_description.strip() or "(no video description provided)"
    return (
        "You are a professional tutor building a personalized learning guide inside FocusLearn, "
        "a distraction-free study app for students.\n\n"
        f"TOPIC: {query}\n"
        f"LINKED VIDEO TITLE: {title}\n"
        f"LINKED VIDEO DESCRIPTION: {description}\n"
        f"STUDENT LEVEL: {student_level}\n\n"
        "Write a complete, high-quality learning guide for this topic. Return ONLY valid JSON "
        "(no markdown fences, no commentary) matching EXACTLY this schema:\n"
        "{\n"
        '  "topic_overview": string, 1-3 clear sentences on what the topic is,\n'
        '  "learning_objectives": [string], 3-6 things the student will be able to do,\n'
        '  "key_concepts": [string], 3-8 core concepts to understand,\n'
        '  "simple_explanation": string, plain-language explanation a '
        f"{student_level} student can follow,\n"
        '  "example": string, one concrete worked example tied closely to the topic,\n'
        '  "common_mistakes": [string], 3-6 typical pitfalls and how to avoid them,\n'
        '  "prerequisites": [string], 2-5 things worth knowing before starting,\n'
        '  "quick_check_questions": [{"question": string, "answer": string}], 3-5 short questions,\n'
        '  "what_to_learn_next": [string], 2-4 natural next topics\n'
        "}\n\n"
        "Rules:\n"
        "- Ground the guide in the TOPIC. Use the linked video for context only when it is relevant.\n"
        f"- Keep the tone encouraging and grade-appropriate for a {student_level} student.\n"
        "- Every array must be non-empty unless the field genuinely has nothing to list.\n"
    )


def _coerce_guide(raw: str) -> dict[Any, Any]:
    """Parse Gemini's text into the guide dict, tolerating code fences."""
    text = re.sub(r"^```(?:json)?\s*", "", (raw or "").strip())
    text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise RuntimeError("Gemini response was not valid JSON")
    data = json.loads(text[start : end + 1])
    if not isinstance(data, dict):
        raise RuntimeError("Gemini response was not a JSON object")

    guide: dict[Any, Any] = {}
    for field in GUIDE_FIELDS:
        value = data.get(field)
        guide[field] = value if value is not None else ([] if field in ARRAY_FIELDS else "")
    return guide


def generate_learning_guide(
    query: str,
    video_title: str = "",
    video_description: str = "",
    student_level: str = "beginner",
) -> dict:
    """Generate a full AI learning guide dict for *query*.

    Raises ``GeminiConfigurationError`` when GEMINI_API_KEY or the
    google-genai package is missing, and ``RuntimeError`` when the model
    call or JSON parsing fails. The key is never exposed to the client.
    """
    if not gemini_available():
        raise GeminiConfigurationError(
            "google-genai is not installed. Run: pip install -r backend/requirements.txt"
        )
    if not _gemini_key():
        raise GeminiConfigurationError(
            "GEMINI_API_KEY is not set. Add it to backend/.env (or your environment) and restart the backend."
        )

    client = genai.Client(api_key=_gemini_key())
    response = client.models.generate_content(
        model=_MODEL,
        contents=_build_prompt(
            query.strip()[:200],
            video_title[:300],
            video_description[:3000],
            student_level.strip()[:20] or "beginner",
        ),
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.6,
            max_output_tokens=4096,
        ),
    )
    return _coerce_guide(response.text or "")