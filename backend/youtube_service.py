"""
youtube_service.py — FocusLearn YouTube search service.

Searches public YouTube videos using yt-dlp.  No YouTube Data API key
required.  Only metadata is extracted; videos are never downloaded or
stored locally.

Usage::

    from youtube_service import search_youtube_videos, ytdlp_available
    videos = search_youtube_videos("Java Recursion")

The user's exact query is used — no extra keywords are appended and
yt-dlp's / YouTube's own result ordering is preserved.

Each returned dict has the shape::

    {"id", "title", "channel", "thumbnail", "duration", "description",
     "url", "channel_id"}

- ``duration`` is in **seconds** (int) or ``None`` when unavailable.
- ``url`` is the canonical YouTube watch page URL.
- ``channel_id`` is the uploader's YouTube channel ID (used by the
  playlist detection service to look up that channel's real playlists).
"""

from __future__ import annotations

try:
    import yt_dlp
except ImportError:  # pragma: no cover — exercised when the dependency is absent
    yt_dlp = None  # type: ignore[assignment]

# ── Configuration ────────────────────────────────────────────────────────────

# Number of results fetched from YouTube per search. The first 5 are shown as
# primary Focus Mode results; every other result feeds the "More videos about
# this topic" list. A high value makes the result set effectively unlimited —
# the only real ceiling is YouTube's own (finite) pool of matches.
_RESULTS = 100

# Flat search keeps the request to a single metadata round-trip and already
# returns id, title, channel, duration, description and thumbnails for every
# hit. ``skip_download: True`` ensures no video bytes are transferred.
FLAT_SEARCH_OPTS: dict = {
    "quiet": True,
    "no_warnings": True,
    "extract_flat": True,
    "skip_download": True,
    "noplaylist": True,
}


# ── Helpers ──────────────────────────────────────────────────────────────────

def ytdlp_available() -> bool:
    """Return True when the yt-dlp package is importable."""
    return yt_dlp is not None


def _first(mapping: dict, *keys: str) -> str:
    """Return the first truthy value from *mapping* for the given *keys*."""
    for k in keys:
        v = mapping.get(k)
        if v:
            return str(v)
    return ""


def _best_thumbnail(entry: dict) -> str:
    """Pick the highest-resolution thumbnail URL, or build one from the id."""
    thumbs = entry.get("thumbnails") or []
    for thumb in reversed(thumbs):
        url = thumb.get("url") if isinstance(thumb, dict) else None
        if url:
            return url
    vid = entry.get("id")
    if vid:
        return f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
    return ""


# ── Public API ───────────────────────────────────────────────────────────────

def search_youtube_videos(
    topic: str,
    max_results: int = _RESULTS,
) -> list[dict]:
    """Search YouTube using the exact *topic* query.

    Returns up to *max_results* dicts — in the order YouTube returns them —
    with keys: ``id``, ``title``, ``channel``, ``thumbnail``, ``duration``
    (seconds or ``None``), ``description``, ``url``.

    Raises ``RuntimeError`` if yt-dlp is not installed or the search
    itself fails.

    To keep large result counts fast, only the flat-search metadata is used
    — it already contains every field above — so there are no per-video
    network calls and YouTube's ordering is preserved untouched.
    """
    if not ytdlp_available():
        raise RuntimeError("yt-dlp is not installed")

    # Search with the user's exact query — nothing is appended and YouTube's
    # own result ordering is preserved.
    query = f"ytsearch{max_results}:{topic}"

    with yt_dlp.YoutubeDL(FLAT_SEARCH_OPTS) as ydl:
        info = ydl.extract_info(query, download=False)

    entries = [
        e
        for e in (info.get("entries") or [])
        if e and e.get("id")
    ][:max_results]

    if not entries:
        return []

    videos: list[dict] = []
    for entry in entries:
        video_id = entry.get("id")
        videos.append(
            {
                "id": video_id,
                "title": entry.get("title") or "Untitled video",
                "channel": _first(entry, "channel", "uploader") or "YouTube",
                "thumbnail": _best_thumbnail(entry),
                "duration": entry.get("duration"),
                "description": entry.get("description") or "",
                "channel_id": _first(entry, "channel_id", "uploader_id"),
                "url": (
                    entry.get("webpage_url")
                    or entry.get("url")
                    or (
                        f"https://www.youtube.com/watch?v={video_id}"
                        if video_id
                        else ""
                    )
                ),
            }
        )

    return videos