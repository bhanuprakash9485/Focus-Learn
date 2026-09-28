"""
quiz_originality.py - FocusLearn question originality + similarity validation.

Every question FocusLearn stores is *AI-generated original*: the model writes
new wording and new scenarios from general subject knowledge. Nothing is copied
from a website, a question bank, a book, a course, an exam paper or a previous
generation run. Because absolute originality cannot be proven mathematically,
FocusLearn verifies what can be verified and states exactly that: questions are
AI-generated original and pass duplicate + near-duplicate similarity checks.

This module is that check. Before a generated question is stored it is
normalized (case, punctuation, numbering, whitespace, unicode quotes/dashes,
common answer-order noise) and compared against

    1. questions already kept for the same goal / topic,
    2. questions kept for the other difficulty tiers of the same quiz,
    3. every question previously stored for the same user,
    4. any locally shipped question bank (none today — the project has no
       bundled bank, and none is invented to satisfy a count).

Similarity is measured three independent ways and the highest score wins:

    * token Jaccard over content words (robust to word order),
    * character trigram Dice coefficient (robust to small edits),
    * difflib ratio over the normalized text (catches reworded copies).

Two questions may test the *same concept* and still be accepted - only wording
that is substantially the same is rejected. Thresholds live in this module and
can be tuned with FOCUSLEARN_QUIZ_SIMILARITY (0..1).
"""

from __future__ import annotations

import difflib
import os
import re
import unicodedata

# Similarity above which a candidate is treated as a duplicate. Tunable so the
# strictness can be adjusted without touching the generation pipeline.
DEFAULT_SIMILARITY_THRESHOLD = 0.85

# Content words shorter than this are ignored when comparing wording.
_MIN_TOKEN_LENGTH = 3

# A Jaccard overlap of two questions that share only a single content word is a
# coincidence ("stack" vs "queue" in a Data Structures bank), not a duplicate.
_MIN_SHARED_TOKENS = 2

_STOPWORDS = frozenset(
    {
        "the", "and", "for", "with", "that", "this", "these", "those", "there",
        "which", "what", "when", "where", "while", "whose", "whom", "into",
        "from", "then", "than", "your", "you", "our", "its", "his", "her",
        "they", "them", "their", "have", "has", "had", "was", "were", "are",
        "been", "being", "does", "did", "not", "but", "can", "could", "will",
        "would", "should", "shall", "may", "might", "must", "any", "all",
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
        "ten", "each", "every", "some", "such", "also", "more", "most", "less",
        "following", "below", "above", "given", "consider", "choose", "select",
        "correct", "option", "options", "answer", "answers", "question",
        "questions", "statement", "true", "false", "best", "true", "about",
        "explain", "following", "example", "e.g", "i.e", "a", "an", "of", "to",
        "in", "on", "at", "by", "for", "as", "is", "be", "do", "it", "we",
        "if", "or", "so", "up", "out", "use", "used", "using", "how", "why",
    }
)

# Leading enumeration noise: "1.", "Q3)", "Question 7 -", "Q. 12:".
_LEADING_NUMBERING = re.compile(
    r"^\s*(?:q(?:uestion)?\s*)?[\(\[]?\d{1,3}[\)\].:,\-]\s*", re.IGNORECASE
)
_WHITESPACE = re.compile(r"\s+")
_NON_WORD = re.compile(r"[^a-z0-9\s]+")
# Markdown/formatting noise a model may add around a question.
_CODE_FENCE = re.compile(r"```[a-z0-9+#\-]*", re.IGNORECASE)
_INLINE_MARKUP = re.compile(r"[*_`~]+")


def _configured_threshold() -> float:
    raw = (os.environ.get("FOCUSLEARN_QUIZ_SIMILARITY") or "").strip()
    if not raw:
        return DEFAULT_SIMILARITY_THRESHOLD
    try:
        value = float(raw)
    except ValueError:
        return DEFAULT_SIMILARITY_THRESHOLD
    return min(0.99, max(0.5, value))


SIMILARITY_THRESHOLD = _configured_threshold()


def normalize_text(text: str) -> str:
    """Canonical form of a question used for every comparison.

    Lowercases, strips accents, removes markdown/punctuation, drops leading
    question numbering and collapses whitespace. "Q2)  What is a B-Tree? " and
    "what is a b tree" therefore normalize to the same string.
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    raw = unicodedata.normalize("NFKD", raw)
    raw = "".join(ch for ch in raw if not unicodedata.combining(ch))
    raw = raw.lower()
    raw = _CODE_FENCE.sub(" ", raw)
    raw = _INLINE_MARKUP.sub(" ", raw)
    previous = None
    while previous != raw:
        previous = raw
        raw = _LEADING_NUMBERING.sub("", raw)
    raw = _NON_WORD.sub(" ", raw)
    return _WHITESPACE.sub(" ", raw).strip()


def content_tokens(text: str) -> frozenset[str]:
    """Content words of a question (stopwords and short words removed)."""
    words = re.findall(r"[a-z0-9]+", normalize_text(text))
    return frozenset(
        w for w in words if len(w) >= _MIN_TOKEN_LENGTH and w not in _STOPWORDS
    )


def trigrams(text: str) -> frozenset[str]:
    """Character trigrams of the normalized text (typo/edit tolerant)."""
    normalized = normalize_text(text)
    if len(normalized) < 3:
        return frozenset({normalized}) if normalized else frozenset()
    return frozenset(normalized[i : i + 3] for i in range(len(normalized) - 2))


def bigrams(text: str) -> frozenset[str]:
    """Character bigrams of the normalized text."""
    normalized = normalize_text(text)
    if len(normalized) < 2:
        return frozenset({normalized}) if normalized else frozenset()
    return frozenset(normalized[i : i + 2] for i in range(len(normalized) - 1))


class QuestionSignature:
    """Pre-computed comparable form of one question."""

    __slots__ = ("text", "normalized", "tokens", "trigrams", "bigrams")

    def __init__(self, text: str) -> None:
        # Coerce defensively: this is the single choke point for every caller of
        # the duplicate check, and a stray non-string must not be able to abort
        # a whole quiz generation.
        self.text = ("" if text is None else str(text)).strip()
        self.normalized = normalize_text(self.text)
        self.tokens = content_tokens(self.text)
        self.trigrams = trigrams(self.text)
        self.bigrams = bigrams(self.text)

    def __bool__(self) -> bool:
        return bool(self.normalized)

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"QuestionSignature({self.normalized[:60]!r})"


def _jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def _dice(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return 2 * len(a & b) / (len(a) + len(b))


def similarity(candidate: QuestionSignature, other: QuestionSignature) -> float:
    """Highest of the three similarity measures (0..1)."""
    if not candidate.normalized or not other.normalized:
        return 0.0
    if candidate.normalized == other.normalized:
        return 1.0
    shared = len(candidate.tokens & other.tokens)
    token_score = _jaccard(candidate.tokens, other.tokens) if shared >= _MIN_SHARED_TOKENS else 0.0
    trigram_score = _dice(candidate.trigrams, other.trigrams)
    bigram_score = _dice(candidate.bigrams, other.bigrams)
    sequence_score = difflib.SequenceMatcher(
        None, candidate.normalized, other.normalized
    ).ratio()
    return max(token_score, trigram_score, bigram_score, sequence_score)


class DuplicateVerdict:
    """Result of an originality check."""

    __slots__ = ("duplicate", "score", "match")

    def __init__(self, duplicate: bool, score: float, match: str | None) -> None:
        self.duplicate = duplicate
        self.score = score
        self.match = match

    def __bool__(self) -> bool:
        return self.duplicate

    def __repr__(self) -> str:  # pragma: no cover - debugging helper
        return f"DuplicateVerdict(duplicate={self.duplicate}, score={self.score:.2f})"


class OriginalityGuard:
    """Reject duplicate / near-duplicate questions within one generation run.

    The guard is seeded with every question that is already stored (same goal,
    all tiers, all previous runs) so a new question can never restate one the
    student has already seen.
    """

    def __init__(
        self,
        existing: list[str] | tuple[str, ...] | None = None,
        threshold: float | None = None,
    ) -> None:
        self.threshold = SIMILARITY_THRESHOLD if threshold is None else threshold
        self._seen: list[QuestionSignature] = []
        for text in existing or ():
            signature = QuestionSignature(text)
            if signature:
                self._seen.append(signature)

    def __len__(self) -> int:
        return len(self._seen)

    def check(self, text: str) -> DuplicateVerdict:
        """True when *text* duplicates something already known to the guard."""
        candidate = QuestionSignature(text)
        if not candidate.normalized:
            return DuplicateVerdict(True, 1.0, "")
        for other in self._seen:
            score = similarity(candidate, other)
            if score >= self.threshold:
                return DuplicateVerdict(True, score, other.normalized)
        return DuplicateVerdict(False, 0.0, None)

    def add(self, text: str) -> bool:
        """Register *text*. Returns False when it was rejected as a duplicate."""
        if self.check(text):
            return False
        signature = QuestionSignature(text)
        if signature:
            self._seen.append(signature)
        return True

    def accept(self, text: str) -> tuple[bool, DuplicateVerdict]:
        """Check + register in one step. The generation loop uses this."""
        verdict = self.check(text)
        if verdict.duplicate:
            return False, verdict
        self.add(text)
        return True, verdict


def find_duplicates(
    texts: list[str], threshold: float | None = None
) -> list[tuple[int, int, float]]:
    """All (i, j, score) pairs of substantively similar questions."""
    limit = SIMILARITY_THRESHOLD if threshold is None else threshold
    signatures = [QuestionSignature(t) for t in texts]
    pairs: list[tuple[int, int, float]] = []
    for i in range(len(signatures)):
        for j in range(i + 1, len(signatures)):
            score = similarity(signatures[i], signatures[j])
            if score >= limit:
                pairs.append((i, j, round(score, 3)))
    return pairs


# Domain-neutral words that appear in almost any question, so they cannot prove
# a question is on-goal on their own.
_GENERIC_TOPIC_WORDS = frozenset(
    {
        "learn", "learning", "study", "studying", "goal", "goals", "topic",
        "topics", "level", "basic", "moderate", "difficult", "advanced",
        "beginner", "intermediate", "expert", "course", "courses", "lesson",
        "practice", "concepts", "concept", "questions", "question", "example",
        "examples", "knowledge", "understanding", "fundamentals", "overview",
        "introduction", "program", "programs",
    }
)


def topic_keywords(topic: str) -> frozenset[str]:
    """Content words that mark a question as being about *topic*."""
    return frozenset(
        token
        for token in content_tokens(topic)
        if len(token) >= 3 and token not in _GENERIC_TOPIC_WORDS
    )


def matches_keywords(text: str, keywords: frozenset[str] | set[str] | list[str]) -> bool:
    """True when *text* shares at least one meaningful word with *keywords*."""
    if not keywords:
        return True
    return bool(content_tokens(text) & frozenset(keywords))


def validate_originality(
    texts: list[str], threshold: float | None = None
) -> dict:
    """Summarise originality for a finished question set.

    Used by the quiz validation layer and the test-suite: a set is original when
    it contains no duplicate / near-duplicate pair.
    """
    limit = SIMILARITY_THRESHOLD if threshold is None else threshold
    normalized = [normalize_text(t) for t in texts]
    exact = len(normalized) - len({n for n in normalized if n})
    pairs = find_duplicates(texts, limit)
    return {
        "threshold": round(limit, 3),
        "questions": len(texts),
        "exact_duplicates": exact,
        "near_duplicates": len(pairs),
        "pairs": pairs,
        "original": not exact and not pairs,
    }
