"""
relevance.py — lightweight relevance helpers for FocusLearn search.

IMPORTANT (ordering principle): YouTube's own search ordering is the PRIMARY
ranking for both videos and playlists. These helpers are ONLY used for
FILTERING (eliminating clearly unrelated / generic catch-all results) and
for diagnostics. They are NEVER used to re-order YouTube's results — earlier
custom re-ranking actively destroyed YouTube relevance and is gone.

What lives here:
  * tokenize / variant matching / query-aliases  (striver↔strivers, a2z↔"a to z",
                                                 dsa↔"data structures (and) algorithms")
  * playlist_relevant()  — gate: at least one meaningful query token in the
                           title/description. Used to drop unrelated playlists.
  * is_generic_catchall()— drop "DSA-Related-Content"-style catch-all titles.
  * score_* / rerank_videos — KEPT ONLY for the diagnostic report (to show a
                           numeric explanation). NOT used by the live pipeline.
"""

from __future__ import annotations

import re
from typing import Any

from safesearch import normalize  # lower, accent-free, space-folded copy

# ── Token helpers ──────────────────────────────────────────────────────────

_FOUR_OR_MORE = re.compile(r"[a-z0-9]{4,}")
_SMALL_WORD = ("a", "an", "the", "is", "of", "to", "in", "on", "for", "with",
               "and", "vs", "using", "from", "by", "sheet", "series", "new")


def tokenize(text: str) -> set[str]:
    """Normalised whitespace tokens of length >= 2 (for matching)."""
    return {w for w in normalize(text).split() if len(w) >= 2}


def _singular_variants(word: str) -> set[str]:
    """The exact token plus its likely singular/plural form."""
    out = {word}
    if len(word) > 3 and word.endswith("s"):
        out.add(word[:-1])          # strivers → striver
    elif len(word) > 2 and not word.endswith("s"):
        out.add(word + "s")         # striver → strivers
    return out


# Query-token → synonym phrases. Matched against a *normalised* text string,
# so "data structures and algorithms" can satisfy a query token "dsa".
_QUERY_ALIASES: dict[str, tuple[str, ...]] = {
    "dsa": ("data structures and algorithms", "data structures", "data structure"),
    "a2z": ("a to z", "atoz"),
}


def _match_query_in_text(norm_text: str, query_tokens: set[str]) -> tuple[set[str], set[str]]:
    """Return (covered, exact) query tokens included in *norm_text*.

    covered — query token matched exactly, via singular/plural variant, or
              via a query alias phrase (e.g. dsa ↔ "data structures").
    exact   — subset of covered that matched literally as a token.
    """
    text_tokens = {w for w in norm_text.split() if len(w) >= 2}
    covered: set[str] = set()
    exact: set[str] = set()
    for q in query_tokens:
        if q in text_tokens:
            covered.add(q)
            exact.add(q)
            continue
        if any(variant in text_tokens for variant in _singular_variants(q) if variant != q):
            covered.add(q)
            continue
        if any(alias in norm_text for alias in _QUERY_ALIASES.get(q, ())):
            covered.add(q)
    return covered, exact


# ── Concept + structural signals (normalised-substring based) ─────────────

_A2Z_TITLE_RE = re.compile(r"\ba z\b")  # "A-Z" normalises to "a z"


def _has_a2z(norm: str) -> bool:
    return "a2z" in norm or "atoz" in norm or " a to z " in f" {norm} " or bool(_A2Z_TITLE_RE.search(norm))


def _has_dsa(norm: str) -> bool:
    return "dsa" in norm or "data structures" in norm


def _has_algorithm(norm: str) -> bool:
    return "algorithm" in norm


# Structural meta-words (title). These BOOST but never gate — a playlist must
# first match a query token (see ``playlist_relevant``).
_STRUCTURAL_KEYWORDS: tuple[tuple[str, int], ...] = (
    ("course", 15),
    ("playlist", 15),
    ("placem", 10),       # placements / placement
    ("interview", 6),
    ("crash", 6),
    ("bootcamp", 5),
    ("tutorial", 5),
    ("series", 5),
    ("learn", 4),
    ("complete", 4),
    ("full", 4),
    ("beginner", 4),
    ("basics", 4),
    ("basic", 4),
    ("lecture", 4),
    ("training", 4),
    ("master", 4),
    ("explained", 3),
)

# Generic catch-all markers — a playlist like "DSA-Related-Content" must not
# outrank a specific one. These subtract points but do NOT block a playlist
# that is the only real match for a video (membership stays truthful).
_GENERIC_MARKERS: tuple[tuple[str, int], ...] = (
    ("related", 10),
    ("content", 8),
    ("stuff", 8),
    ("misc", 8),
    ("random", 6),
    ("collection", 6),
    ("archive", 6),
    ("videos", 6),
    ("video", 5),
)

# How strong a playlist must be before it is offered as the recommended
# course for a search. Keeps weak/partial matches out of the banner.
MIN_RECOMMENDED_SCORE = 60


# ── Playlist scoring ──────────────────────────────────────────────────────

def _structural_sum(norm: str) -> int:
    return sum(weight for keyword, weight in _STRUCTURAL_KEYWORDS if keyword in norm)


def _generic_sum(norm: str) -> int:
    return sum(weight for marker, weight in _GENERIC_MARKERS if marker in norm)


def playlist_relevant(query: str, title: str, description: str = "") -> bool:
    """True when at least one query token (exact, variant or alias) appears
    in the playlist title or description."""
    query_tokens = tokenize(query)
    if not query_tokens:
        return False
    nt = normalize(title)
    nd = normalize(description)
    covered_title, _ = _match_query_in_text(nt, query_tokens)
    if covered_title:
        return True
    covered_desc, _ = _match_query_in_text(nd, query_tokens)
    return bool(covered_desc)


# ── Generic catch-all titles ────────────────────────────────────────────────

# Markers that scream "dump/topic bin" rather than a structured learning
# sequence. A title containing any of these AND none of the specificity
# markers below is treated as a generic catch-all and skipped.
GENERIC_MARKERS: tuple[str, ...] = (
    "related", "content", "stuff", "misc", "miscellaneous", "random",
    "collection", "archive",
)
# Markers that show the playlist is actually structured around a topic.
SPECIFIC_MARKERS: tuple[str, ...] = (
    "course", "playlist", "placem", "tutorial", "interview", "full",
    "complete", "learn", "learning", "training", "crash", "bootcamp",
    "master", "beginner", "beginners", "basics", "basic", "series",
    "sheet", "projects", "explained", "syllabus", "curriculum",
    "lecture", "guide",
)


def is_generic_catchall(normalized_title: str) -> bool:
    """True when the normalised title is a generic catch-all bin, e.g.
    "DSA-Related-Content": generic markers present, no topic-specificity
    markers at all."""
    generic_hits = sum(1 for m in GENERIC_MARKERS if m in normalized_title)
    if not generic_hits:
        return False
    specific_hits = sum(1 for s in SPECIFIC_MARKERS if s in normalized_title)
    return specific_hits == 0


def score_playlist(query: str, title: str, description: str = "", channel: str = "") -> int:
    """Deterministic relevance of one playlist for *query* (0..N).

    Specific-topic playlists outrank generic ones because the heavy weight
    comes from *matching the query tokens* (+70 all-covered, +30/+22 per
    token), not from generic learning words.
    """
    query_tokens = tokenize(query)
    if not query_tokens:
        return 0
    nt = normalize(title)
    nd = normalize(description)
    nq = normalize(query)

    score = 0

    # Exact query phrase in the title — the single strongest signal.
    if nt == nq:
        score += 100
    elif nq and nq in nt:
        score += 60

    covered_title, exact_title = _match_query_in_text(nt, query_tokens)
    if len(covered_title) == len(query_tokens):
        score += 70  # all important query words present
    score += len(exact_title) * 30
    score += (len(covered_title) - len(exact_title)) * 22

    # Named-series (A2Z) + DSA concept boost — only ever helps playlists that
    # already matched the query (gate above).
    if _has_a2z(nt):
        score += 40
    if _has_a2z(nd):
        score += 15
    if _has_dsa(nt):
        score += 20
    if _has_dsa(nd):
        score += 10
    if _has_algorithm(nt):
        score += 8
    if _has_algorithm(nd):
        score += 4

    score += _structural_sum(nt)

    # Topic multiplicity: a title that names the topic more than once is
    # unambiguously about it (e.g. "…DSA Course | DSA Playlist | Placements"
    # names DSA twice) and breaks ties vs a one-off mention of the same query
    # words. Dynamic for any topic — not query-specific.
    for query_token in query_tokens:
        extra = max(0, nt.count(query_token) - 1)
        score += min(extra, 3) * 10

    # Description relevance (query tokens), capped.
    covered_desc, exact_desc = _match_query_in_text(nd, query_tokens)
    score += min(20, len(exact_desc) * 8 + (len(covered_desc) - len(exact_desc)) * 5)

    # Channel relevance (query tokens), capped.
    covered_channel, exact_channel = _match_query_in_text(normalize(channel), query_tokens)
    score += min(20, len(exact_channel) * 6 + (len(covered_channel) - len(exact_channel)) * 4)

    # Generic catch-all suppression (title).
    score -= _generic_sum(nt)

    return max(score, 0)


def choose_best_playlist(
    candidates: list[dict[str, Any]],
    query: str,
    min_score: int = MIN_RECOMMENDED_SCORE,
) -> dict[str, Any] | None:
    """Return the highest-scoring relevant playlist, or None when none is
    sufficiently relevant. Ties resolve on source order (deterministic)."""
    best: dict[str, Any] | None = None
    best_score = -1
    for playlist in candidates:
        title = playlist.get("title") or ""
        description = playlist.get("description") or ""
        channel = playlist.get("channel") or ""
        if not playlist_relevant(query, title, description):
            continue
        score = score_playlist(query, title, description, channel)
        if score < min_score:
            continue
        if score > best_score:
            best = playlist
            best_score = score
    return best


# ── Video result scoring / re-ranking (requirement 12) ───────────────────

_VIDEO_STRUCTURAL: tuple[tuple[str, int], ...] = (
    ("course", 10),
    ("playlist", 8),
    ("tutorial", 6),
    ("explained", 5),
    ("complete", 4),
    ("full", 4),
    ("part", 3),
    ("episode", 3),
)


def score_video(query: str, title: str, channel: str = "", description: str = "") -> int:
    """Deterministic topical relevance of one video result."""
    query_tokens = tokenize(query)
    if not query_tokens:
        return 0
    nt = normalize(title)
    nd = normalize(description)
    nc = normalize(channel)
    nq = normalize(query)

    score = 0
    if nt == nq:
        score += 80
    elif nq and nq in nt:
        score += 50

    covered_title, exact_title = _match_query_in_text(nt, query_tokens)
    if len(covered_title) == len(query_tokens) and len(query_tokens) > 1:
        score += 50
    score += len(exact_title) * 30
    score += (len(covered_title) - len(exact_title)) * 20
    if covered_title:
        score += sum(w for kw, w in _VIDEO_STRUCTURAL if kw in nt)

    covered_channel, _ = _match_query_in_text(nc, query_tokens)
    score += len(covered_channel) * 10

    covered_desc, exact_desc = _match_query_in_text(nd, query_tokens)
    score += min(10, len(exact_desc) * 8 + (len(covered_desc) - len(exact_desc)) * 4)

    return max(score, 0)


def rerank_videos(videos: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """Stable sort of safe video results by topical relevance.

    Never adds or removes results (SafeSearch has already filtered them) —
    only ordering changes; ties keep YouTube's original order.
    """
    if len(videos) < 2 or not tokenize(query):
        return videos
    scored = list(enumerate(videos))
    scored.sort(key=lambda item: (-score_video(query, item[1].get("title") or "",
                                                item[1].get("channel") or item[1].get("uploader") or "",
                                                item[1].get("description") or ""),
                                  item[0]))
    return [video for _, video in scored]