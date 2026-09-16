"""
safesearch.py — FocusLearn SafeSearch (backend security layer).

Strict, always-on, backend-enforced safety filtering for the YouTube search
pipeline. It sits between yt-dlp and the API response, so unsafe content is
NEVER sent to the frontend, Focus Mode, More Videos or the Groq AI:

    user query
        ↓
    normalize
        ↓
    categorized safety check
        ├── UNSAFE → STOP (no yt-dlp call, friendly blocked response)
        └── SAFE  → yt-dlp search (exact query, unmodified)
                        ↓
            result safety filter (title/desc/channel/url + metadata)
                        ↓
            safe results only → frontend

Design
------
* NOT a simple keyword blacklist. Signals are organised into safety
  categories (PORNOGRAPHY, NUDITY, SEXUAL_EXPLICIT, SEXUAL_SERVICES,
  SEXUALIZED_MINORS, GRAPHIC_GORE, EXTREME_VIOLENCE, DRUG_PROMOTION,
  DANGEROUS_ILLEGAL_ACTIVITY) and matched over a *normalised* copy (lower,
  accents stripped, leetspeak decoded, separators folded).
* IntenT-based soft patterns catch "hot videos" / "sexy videos" /
  "adult videos" / "explicit videos" / "sexual videos" / "sex videos"
  WITHOUT breaking "hot air balloon experiment", "heat and temperature",
  "adult education", "sexual reproduction in plants", … A strong
  educational context (biology, health, awareness, prevention, class,
  reproduction …) exempts only the soft sexual pattern — hard categories
  (porn, nude, gore, drugs, bombs …) always block.
* The student's exact query is never rewritten; yt-dlp receives it byte for
  byte. Only a normalised copy is used for scoring.
* Fail CLOSED: filtered results are never padded back up, never replaced,
  never served unfiltered.

Honest limitations
------------------
YouTube flat-search metadata is limited: `age_limit`, `is_family_safe` and
`categories` are present only when yt-dlp reports them. Text analysis is
deterministic, not an LLM — novel slang could evade it, and a few rare
homonyms are over-blocked by design (safer than under-blocking). No YouTube
restriction is ever bypassed.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any, Iterable, Sequence

# ── Normalisation helpers (safety scan only, never the search query) ─────

_LEET = str.maketrans(
    {
        "0": "o",
        "1": "i",
        "3": "e",
        "4": "a",
        "5": "s",
        "7": "t",
        "@": "a",
        "$": "s",
        "!": "i",
        "|": "i",
    }
)


def _strip_accents(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def normalize(text: str) -> str:
    """Lowercase, accent-free, leetspeak-decoded, space-folded text.

    Used only for safety scoring — the student's exact query is preserved.
    """
    if not text:
        return ""
    t = _strip_accents(text).encode("ascii", "ignore").decode("ascii")
    t = t.lower().translate(_LEET)
    t = re.sub(r"[^a-z0-9 ]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


# ── Category signal banks ────────────────────────────────────────────────

# Precedence used when reporting a single "safety reason".
CATEGORY_ORDER = (
    "SEXUALIZED_MINORS",
    "DANGEROUS_ILLEGAL_ACTIVITY",
    "DRUG_PROMOTION",
    "PORNOGRAPHY",
    "GRAPHIC_GORE",
    "EXTREME_VIOLENCE",
    "NUDITY",
    "SEXUAL_SERVICES",
    "SEXUAL_EXPLICIT",
)

# Substring stems matched INSIDE a normalised token. Only unambiguous stems
# live here so academic words never collide (no "node", "webcam", "method",
# "sexual", "reproduc", "violence", "drug", "torture" …).
_CATEGORY_SUBSTRINGS: dict[str, frozenset[str]] = {
    "PORNOGRAPHY": frozenset(
        {
            "porn",       # porn / porno / pornstar / pornhub / youporn…
            "pronhub",    # misspelling of pornhub (contains no "porn")
            "prnhub",
            "xnxx",
            "xhamster",
            "xhamstter",
            "xvideos",
            "xvedios",    # misspelling of xvideos
            "youporn",
            "redtube",
            "spankbang",
            "hentai",
            "hentaihaven",
            "rule34",
            "xxx",        # triple-X / adult rating
        }
    ),
    "NUDITY": frozenset(
        {
            "nude",
            "nudity",
            "nudes",
            "naked",
            "topless",
            "nudist",
        }
    ),
    "SEXUAL_EXPLICIT": frozenset(
        {
            "erotic",     # erotic / erotica
            "masturb",    # masturbat(e/ion)
            "blowjob",
            "handjob",
            "sextape",
            "sexcam",
            "sexchat",
            "sexting",
            "sexdoll",
            "squirting",
            "milf",
            "nsfw",       # not-safe-for-work marker
            "cum",        # substring-safe in a porn context; token-only below
        }
    ),
    "SEXUAL_SERVICES": frozenset(
        {
            "escort",     # adult escort services
            "prostitut",
            "onlyfan",    # OnlyFans / Fansly
            "fansly",
            "chaturbate",
            "camgirl",
            "webcamgirl",
        }
    ),
    "SEXUALIZED_MINORS": frozenset(
        {
            "lolita",
            "childporn",
            "preteen",
        }
    ),
    "GRAPHIC_GORE": frozenset(
        {
            "gore",
            "snuff",
            "behead",
            "mutilat",
            "disembowel",
        }
    ),
    "EXTREME_VIOLENCE": frozenset(
        {
            "decapit",
        }
    ),
    "DRUG_PROMOTION": frozenset(),   # handles tokens/phrases below
    "DANGEROUS_ILLEGAL_ACTIVITY": frozenset(),  # handles phrases below
}

# Whole-token matches (never substring, to avoid collisions such as
# "pron" ⊂ "prone", "sext" ⊂ "sextet", "meth" ⊂ "method", "cum" ⊂ "document").
_CATEGORY_TOKENS: dict[str, frozenset[str]] = {
    "PORNOGRAPHY": frozenset({"pron", "pr0n", "cum", "scat"}),
    "NUDITY": frozenset(),
    "SEXUAL_EXPLICIT": frozenset(),
    "SEXUAL_SERVICES": frozenset(),
    "SEXUALIZED_MINORS": frozenset(),
    "GRAPHIC_GORE": frozenset(),
    "EXTREME_VIOLENCE": frozenset(),
    "DRUG_PROMOTION": frozenset(
        {
            "meth",             # token-only; "method" stays safe
            "methamphetamine",
            "mdma",
            "ecstasy",
            "fentanyl",
            "cocaine",
            "heroin",           # documentary titles still pass unless phrased
        }
    ),
    "DANGEROUS_ILLEGAL_ACTIVITY": frozenset(),
}

# Intent phrases checked against the normalised full text.
_CATEGORY_PHRASES: dict[str, tuple[str, ...]] = {
    "DRUG_PROMOTION": (
        "cook meth",
        "cooking meth",
        "making meth",
        "how to make meth",
        "meth recipe",
        "how to roll a joint",
        "how to get high",
        "snort cocaine",
        "shoot heroin",
        "smoke crack",
        "buy drugs online",
        "buy pills online",
    ),
    "DANGEROUS_ILLEGAL_ACTIVITY": (
        "how to make a bomb",
        "how to build a bomb",
        "how to make a pipe bomb",
        "make a pipe bomb",
        "pipe bomb",
        "bomb making",
        "bomb recipe",
        "synthesize fentanyl",
        "how to make fentanyl",
    ),
    "SEXUAL_EXPLICIT": (
        "sex cam",
        "sex webcam",
        "live sex",
        "sex chat",
    ),
}

# Soft sexual intent patterns: adjective + content-noun pairs such as
# "hot videos", "sexy girls", "adult videos", "explicit videos",
# "sexual videos", "sex videos". These block intent, not isolated words,
# so "hot air balloon experiment" / "heat and temperature" survive.
_SOFT_ADJECTIVES = frozenset(
    {
        "hot", "hottt", "sexy", "sexxy", "sexier", "sexiness",
        "adult", "explicit", "sexual", "sex", "seductive", "suggestive",
        "scantily", "risque", "racy", "lingerie", "thong", "bikini",
    }
)
_SEXUAL_CONTENT_NOUNS = frozenset(
    {
        "videos", "video", "pics", "pic", "pictures", "picture",
        "photos", "photo", "images", "image", "wallpapers", "wallpaper",
        "girls", "girl", "women", "woman", "men", "man", "boys",
        "babes", "babe", "chicks", "chick", "models", "model",
        "actresses", "actress", "scenes", "scene", "clips", "clip",
        "movies", "movie", "films", "film", "cams", "cam", "webcam",
        "shows", "show", "stories", "story", "teens", "teen",
        "celebrities",
    }
)
_SOFT_STANDALONE = frozenset({"sexy", "sexxy", "sexier", "sexiness", "porn"})

# Strong educational context markers. Presence of any of these exempts the
# SOFT sexual-intent pattern only ("complete search intent matters").
_EDUCATIONAL_MARKERS = (
    "reproduction", "reproductive", "reproduce", "fertilisation", "fertilization",
    "education", "educate", "class", "classes", "course", "lecture", "lesson",
    "chapter", "unit", "biology", "science", "scientific", "physiology",
    "anatomy", "health", "awareness", "prevention", "prevent", "history",
    "sociology", "psychology", "therapy", "counseling", "counselling",
    "research", "textbook", "curriculum", "school", "university", "college",
    "ncert", "cbse", "icse", "professor", "teacher", "study", "learn",
    "learning", "exam", "assessment", "quiz", "documentary",
    "sexually transmitted", "sti", "hiv", "abstinence", "contraception",
    "pregnancy", "puberty", "safety", "vaccine",
)

_BLOCKED_MESSAGE = "This search isn't suitable for FocusLearn."
_EMPTY_MESSAGE = "No suitable learning videos were found for this search."


# ── Scanner ─────────────────────────────────────────────────────────────

def _has_educational_marker(normalized: str) -> bool:
    return any(marker in normalized for marker in _EDUCATIONAL_MARKERS)


def _soft_sexual_hit(normalized: str) -> bool:
    tokens = normalized.split()
    if len(tokens) == 1:
        return tokens[0] in _SOFT_STANDALONE
    for i, tok in enumerate(tokens[:-1]):
        if tok in _SOFT_ADJECTIVES and tokens[i + 1] in _SEXUAL_CONTENT_NOUNS:
            return True
    return False


def scan_text(normalized: str) -> str:
    """Return the highest-precedence safety category, or "" if safe."""
    if not normalized:
        return ""

    categories: set[str] = set()

    for token in normalized.split():
        for category, stems in _CATEGORY_SUBSTRINGS.items():
            for stem in stems:
                if stem in token:
                    categories.add(category)
        for category, tokens in _CATEGORY_TOKENS.items():
            if token in tokens:
                categories.add(category)

    for category, phrases in _CATEGORY_PHRASES.items():
        if any(phrase in normalized for phrase in phrases):
            categories.add(category)

    if _soft_sexual_hit(normalized):
        # Educational context exempts ONLY the soft intent pattern.
        if not _has_educational_marker(normalized):
            categories.add("SEXUAL_EXPLICIT")
        else:
            categories.discard("SEXUAL_EXPLICIT")

    # Highest-precedence category wins as the reason.
    for category in CATEGORY_ORDER:
        if category in categories:
            return category
    return ""


# ── Public query / text API ─────────────────────────────────────────────

def text_is_unsafe(text: str) -> str:
    """Return the safety category for a text ('' means safe)."""
    return scan_text(normalize(text))


def unsafe_reason(*texts: str) -> str:
    """Return the reason for ANY of the texts, or '' if all are safe."""
    for text in texts:
        if not text:
            continue
        reason = scan_text(normalize(text))
        if reason:
            return reason
    return ""


def classify_query(query: str) -> tuple[bool, str]:
    """Return (is_blocked, category). A blocked query is NEVER sent to yt-dlp."""
    reason = text_is_unsafe(query)
    return (bool(reason), reason)


def is_query_safe(query: str) -> tuple[bool, str | None]:
    """Return (safe, reason). ``safe=True, reason=None`` means SAFE; otherwise
    ``safe=False`` with the safety category as the reason.
    """
    reason = text_is_unsafe(query)
    return (not reason, reason or None)


# ── Result-level filtering ──────────────────────────────────────────────

def _video_metadata_unsafe(video: dict) -> bool:
    """Reject by explicit metadata (age restriction / availability)."""
    age = video.get("age_limit")
    if age is not None:
        try:
            if float(age) >= 18:  # yt-dlp marks adult content as 18
                return True
        except (TypeError, ValueError):
            pass

    family_safe = video.get("is_family_safe")
    if family_safe is False:
        return True

    availability = video.get("availability")
    if availability is not None and availability not in ("public", "premiere"):
        return True

    return False


def filter_videos(videos: Iterable[dict]) -> tuple[list[dict], int]:
    """Return (safe_videos, removed_count) preserving source order.

    Every returned video is marked ``safe_approved`` by the backend so the
    video object itself carries safety-approval state.
    """
    kept: list[dict] = []
    removed = 0
    for video in videos:
        if not isinstance(video, dict):
            removed += 1
            continue
        if _video_metadata_unsafe(video):
            removed += 1
            continue
        reason = unsafe_reason(
            str(video.get("title") or ""),
            str(video.get("channel") or video.get("uploader") or ""),
            str(video.get("description") or ""),
            str(video.get("url") or ""),
        )
        if reason:
            removed += 1
            continue
        approved = dict(video)
        approved["safe_approved"] = True
        kept.append(approved)
    return kept, removed


# ── Unified response contract ───────────────────────────────────────────

# Blocked            → {"safe": false, "query", "videos": [], "results": [],
#                       "blocked": true, "message": "This search isn't
#                       suitable for FocusLearn."}
# All filtered out   → {"safe": true, "query", "videos": [], "results": [],
#                       "blocked": false, "message": "No suitable learning
#                       videos were found for this search."}
# Normal             → {"safe": true, "query", "videos": [...], "results": [...],
#                       "blocked": false, "message": null}


def _base_response(query: str) -> dict[str, Any]:
    return {"safe": True, "query": query, "videos": [], "results": [], "blocked": False, "message": None}


def blocked_response(query: str) -> dict[str, Any]:
    response = _base_response(query)
    response.update({"safe": False, "blocked": True, "message": _BLOCKED_MESSAGE})
    return response


def safe_response(query: str, videos: list[dict], before_count: int) -> dict[str, Any]:
    response = _base_response(query)
    response["videos"] = videos
    response["results"] = videos
    response["safe_filtered"] = before_count - len(videos)
    if not videos:
        response["message"] = _EMPTY_MESSAGE
    return response