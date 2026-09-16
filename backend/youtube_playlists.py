"""
youtube_playlists.py — FocusLearn recommended-playlist selection.

Discovers ONE relevant, SAFE learning playlist for the student's EXACT
query using the YouTube Data API v3 (search.list type=playlist →
playlistItems.list paginated).

Ordering principle (important)
-----------------------------
YouTube's own search ordering is the PRIMARY ranking. There is NO custom
relevance score that can flip it — earlier revisions re-ranked candidates
and that actively destroyed YouTube relevance (e.g. "Cracking Striver's A
to Z…" beating "Strivers A2Z-DSA Course | DSA Playlist | Placements").

Selection therefore keeps candidates in the exact order search.list returns
them and only *skips* playlists that are clearly unsuitable:

    exact user query
        ↓
    search.list type=playlist maxResults=50   (YouTube relevance order)
        ↓
    drop playlists with NO query-token match in title/description
        ↓
    drop generic catch-all titles ("DSA-Related-Content"-style)
        ↓
    first surviving candidate = YouTube's best RELEVANT match
        ↓
    playlistItems.list (50/page, paginated, max 1000) — order preserved
        ↓
    SafeSearch on playlist metadata + EVERY item (filter-only, no re-order)
        ↓
    first valid SAFE item → first_video  ("Start Learning")

Variant matching (striver↔strivers, a2z↔"a to z", dsa↔"data structures")
is handled by relevance.py but is used to gate/reason, never to re-rank.

Caching: in-memory TTL map (30 min) keyed by normalised query. On by
default; bypass with ``use_cache=False`` (diagnostics) or for every
call when FOCUSLEARN_NO_CACHE=1.

Failure policy: missing key, API errors, quota, timeouts and network errors
all degrade gracefully → None (no recommendation), and the normal video
search is unaffected. Raw API payloads and keys never reach the frontend.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

import relevance
import safesearch
import youtube_api

# Load secrets exactly like the rest of the backend (backend/.env).
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

# In-memory TTL cache for the recommended playlist, keyed by query.
_CACHE_TTL = 30 * 60  # seconds
_cache_lock = threading.Lock()
_recommended_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _cache_enabled() -> bool:
    return not (os.environ.get("FOCUSLEARN_NO_CACHE") or "").strip()


def clear_cache() -> None:
    """Drop the cached recommended-playlist results (used by tests)."""
    with _cache_lock:
        _recommended_cache.clear()


def has_api_key() -> bool:
    return youtube_api.has_api_key()


# ── Selection (YouTube-order primary; filter-only) ─────────────────────────

def _is_generic_catchall(playlist: dict[str, Any]) -> bool:
    title = playlist.get("title") or ""
    return relevance.is_generic_catchall(safesearch.normalize(title))


def _select_playlist(candidates: list[dict[str, Any]], query: str) -> dict[str, Any] | None:
    """Return the first candidate in YouTube's returned order that passes the
    light relevance filter (or None when none qualifies)."""
    for playlist in candidates:
        title = playlist.get("title") or ""
        description = playlist.get("description") or ""
        if not playlist["id"] or not title:
            continue
        if not relevance.playlist_relevant(query, title, description):
            continue  # clearly unrelated to the query
        if _is_generic_catchall(playlist):
            continue  # "DSA-Related-Content"-style catch-all bin
        return playlist
    return None


# ── Per-item validation ────────────────────────────────────────────────────

_PRIVATE_TITLE_MARKERS = ("private video", "deleted video", "video unavailable")


def _item_available(item: dict[str, Any]) -> bool:
    """Skip unavailable/deleted/private items; respect platform restrictions.
    These are platform markers, not a bypass — such entries are simply never
    offered as learning content."""
    privacy = (item.get("privacy") or "").lower()
    if privacy and privacy not in ("public", "unlisted"):
        return False
    title = (item.get("title") or "").strip().lower()
    if any(marker in title for marker in _PRIVATE_TITLE_MARKERS):
        return False
    return True


# ── Response build ─────────────────────────────────────────────────────────

def _build_recommended(playlist: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Apply SafeSearch to the playlist + every item and build the response.
    Filtering only — never re-orders items (playlist order preserved)."""
    # Playlist-level safety: unsafe → no recommendation at all.
    reason = safesearch.unsafe_reason(
        playlist.get("title") or "",
        playlist.get("description") or "",
        playlist.get("channel") or "",
    )
    if reason:
        return None

    valid: list[dict[str, Any]] = []
    for item in items:
        if not _item_available(item):
            continue
        if safesearch.text_is_unsafe(item.get("title") or ""):
            continue
        valid.append(
            {
                "id": item["id"],
                "video_id": item["id"],
                "title": item["title"],
                "position": item["position"],
                "thumbnail": item.get("thumbnail") or "",
            }
        )
    if not valid:
        return None

    first = valid[0]  # first valid SAFE item, in playlist order
    thumbnails = playlist.get("thumbnails") or {}
    thumbnail = ""
    for quality in ("maxres", "standard", "high", "medium", "default"):
        thumb = thumbnails.get(quality)
        if isinstance(thumb, dict) and thumb.get("url"):
            thumbnail = thumb["url"]
            break

    return {
        "id": playlist["id"],
        "playlist_id": playlist["id"],
        "title": playlist["title"],
        "description": playlist.get("description") or "",
        "channel": playlist.get("channel") or "",
        "thumbnail": thumbnail,
        "total_videos": len(valid),  # real count of safe/usable videos
        "videos": valid,
        "first_video": {"id": first["id"], "title": first["title"]},
    }


# ── Public API ─────────────────────────────────────────────────────────────

def recommended_playlist(query: str, use_cache: bool = True) -> dict[str, Any] | None:
    """Return YouTube's best RELEVANT SAFE playlist for *query*, or None.

    * None when the key is missing, the API fails, nothing passes the light
      relevance filter, or the playlist/its videos fail SafeSearch.
    * The query forwarded to search.list is byte-for-byte the user's query.
    * ``use_cache=False`` bypasses the 30-minute cache (used by diagnostics
      to guarantee a fresh request).
    """
    if not has_api_key():
        return None
    query_tokens = relevance.tokenize(query)
    if not query_tokens:
        return None

    cache_key = safesearch.normalize(query)
    if use_cache and _cache_enabled():
        with _cache_lock:
            cached = _recommended_cache.get(cache_key)
        if cached is not None:
            expires, value = cached
            if time.monotonic() < expires:
                return json.loads(json.dumps(value))  # cheap deep copy
            with _cache_lock:
                _recommended_cache.pop(cache_key, None)

    try:
        candidates = youtube_api.search_playlists(query, max_results=50)
        if not candidates:
            return None
        selected = _select_playlist(candidates, query)
        if not selected:
            return None
        items = youtube_api.playlist_items(selected["id"])
        if not items:
            return None
        result = _build_recommended(selected, items)
    except Exception:
        result = None

    if result and use_cache and _cache_enabled():
        with _cache_lock:
            _recommended_cache[cache_key] = (
                time.monotonic() + _CACHE_TTL,
                json.loads(json.dumps(result)),
            )
    return result