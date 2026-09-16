"""
youtube_api.py — single shared YouTube Data API v3 client for FocusLearn.

This module is the ONLY place that talks to the YouTube Data API:
  * search_videos      — search.list type=video    (primary video search)
  * search_playlists   — search.list type=playlist (playlist discovery)
  * playlist_items     — playlistItems.list (paginated, up to 1000 videos)
  * video_durations    — videos.list contentDetails (for duration display)

Design rules
------------
* The student's query is forwarded BYTE-FOR-BYTE to ``q``. Nothing is
  appended, rewritten, translated or summarised. No AI sees or rewrites it.
* YouTube's own result ordering is PRESERVED. Callers keep the returned
  list order; this module never sorts by relevance.
* No restrictive parameters that YouTube does not require. Calls use only
  ``part``, ``type``, ``q`` and ``maxResults`` (+ ``key``). No
  ``regionCode``/``safeSearch``/``relevanceLanguage``/``order`` unless a
  caller explicitly needs them.
* No request is ever returned raw to a browser and the API key is never
  exposed outside this module (backend/.env only).
* Failures return None / [] — callers degrade gracefully.
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

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

_SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems"
_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"

_REQUEST_TIMEOUT = 8  # seconds

# playlistItems.list returns at most 50 items per page.
PLAYLIST_ITEMS_MAX_RESULTS = 50
# Hard cap on how many playlist videos we will ever fetch/return.
MAX_PLAYLIST_VIDEOS = 1000
# pages = ceil(1000 / 50) — keeps API quota and latency bounded.
MAX_PLAYLIST_PAGES = 20

# Resolution preference for thumbnails (search/videos snippets).
_THUMB_QUALITY = ("maxres", "standard", "high", "medium", "default")

_DURATION_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def _youtube_key() -> str:
    return (os.environ.get("YOUTUBE_API_KEY") or "").strip()


def has_api_key() -> bool:
    """Boolean existence check only — never exposes the key value."""
    return bool(_youtube_key())


def _get_json(url: str, params: dict[str, Any]) -> dict[str, Any] | None:
    """GET *url* with *params* + key. Returns parsed JSON or None on ANY
    error. Never raises and never exposes raw payloads or the key."""
    key = _youtube_key()
    if not key:
        return None
    params = dict(params)
    params["key"] = key
    full_url = url + "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(full_url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=_REQUEST_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None


def _best_thumbnail(thumbnails: Any) -> str:
    if not isinstance(thumbnails, dict):
        return ""
    for quality in _THUMB_QUALITY:
        thumb = thumbnails.get(quality)
        if isinstance(thumb, dict) and thumb.get("url"):
            return thumb["url"]
    return ""


def _iso_duration_to_seconds(duration: Any) -> int | None:
    """Convert an ISO-8601 duration (e.g. PT1H2M3S) to seconds."""
    if not isinstance(duration, str):
        return None
    match = _DURATION_RE.match(duration)
    if not match:
        return None
    hours = int(match.group(1) or 0)
    minutes = int(match.group(2) or 0)
    seconds = int(match.group(3) or 0)
    return hours * 3600 + minutes * 60 + seconds


# ── Video search (PRIMARY for the YouTube results page) ───────────────────

def search_videos(query: str, max_results: int = 50) -> list[dict[str, Any]] | None:
    """search.list type=video for the EXACT *query*.

    Returns the videos in YouTube's own relevance order (max_results ≤ 50 —
    the Data API hard ceiling). ``duration`` is None here; enrich with
    ``video_durations`` if the caller wants it.
    """
    data = _get_json(
        _SEARCH_URL,
        {"part": "snippet", "type": "video", "q": query, "maxResults": max_results},
    )
    if not data:
        return None
    videos: list[dict[str, Any]] = []
    for item in data.get("items") or []:
        snippet = item.get("snippet") or {}
        video_id = (item.get("id") or {}).get("videoId")
        if not video_id:
            continue
        title = snippet.get("title") or ""
        if not title:
            continue
        videos.append(
            {
                "id": video_id,
                "title": title,
                "channel": snippet.get("channelTitle") or "",
                "channel_id": snippet.get("channelId") or "",
                "thumbnail": _best_thumbnail(snippet.get("thumbnails")),
                "duration": None,
                "description": snippet.get("description") or "",
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }
        )
    return videos


def video_durations(video_ids: list[str]) -> dict[str, int]:
    """videos.list contentDetails → {video_id: seconds}. Never raises."""
    if not has_api_key() or not video_ids:
        return {}
    chunks = [video_ids[i : i + 50] for i in range(0, len(video_ids), 50)]
    result: dict[str, int] = {}
    for chunk in chunks:
        data = _get_json(_VIDEOS_URL, {"part": "contentDetails", "id": ",".join(chunk)})
        if not data:
            continue
        for item in data.get("items") or []:
            vid = item.get("id")
            seconds = _iso_duration_to_seconds((item.get("contentDetails") or {}).get("duration"))
            if vid and seconds is not None:
                result[vid] = seconds
    return result


# ── Playlist search (discovery — candidates kept in YouTube order) ─────────

def search_playlists(query: str, max_results: int = 50) -> list[dict[str, Any]] | None:
    """search.list type=playlist for the EXACT *query*, in YouTube's own
    relevance order (candidates are NOT re-ranked by us)."""
    data = _get_json(
        _SEARCH_URL,
        {"part": "snippet", "type": "playlist", "q": query, "maxResults": max_results},
    )
    if not data:
        return None
    playlists: list[dict[str, Any]] = []
    for item in data.get("items") or []:
        snippet = item.get("snippet") or {}
        playlist_id = (item.get("id") or {}).get("playlistId")
        if not playlist_id:
            continue  # never guess a playlist id — it must come from the API
        title = snippet.get("title") or ""
        if not title:
            continue
        playlists.append(
            {
                "id": playlist_id,
                "title": title,
                "description": snippet.get("description") or "",
                "channel": snippet.get("channelTitle") or "",
                "thumbnails": snippet.get("thumbnails") or {},
            }
        )
    return playlists


# ── Playlist items (paginated, order-preserving) ──────────────────────────

def _parse_playlist_item(raw: dict[str, Any]) -> dict[str, Any] | None:
    """Parse one playlistItems.list entry. Never guesses a video id."""
    snippet = raw.get("snippet") or {}
    content = raw.get("contentDetails") or {}
    status = raw.get("status") or {}
    video_id = content.get("videoId") or snippet.get("resourceId", {}).get("videoId")
    if not video_id:
        return None
    try:
        position = int(snippet.get("position"))
    except (TypeError, ValueError):
        position = 0
    return {
        "id": video_id,
        "title": snippet.get("title") or "",
        "position": position,
        "privacy": status.get("privacyStatus") or "",
        "thumbnail": _best_thumbnail(snippet.get("thumbnails")),
    }


def playlist_items(
    playlist_id: str,
    max_pages: int = MAX_PLAYLIST_PAGES,
    video_cap: int = MAX_PLAYLIST_VIDEOS,
) -> list[dict[str, Any]] | None:
    """Fetch up to *video_cap* playlist items, paginated by nextPageToken.

    playlistItems.list returns 50 items per request; follows pages until the
    playlist ends, an API error/limit occurs, or the cap is reached. Order
    is preserved via ``snippet.position``. Never raises.
    """
    collected: list[dict[str, Any]] = []
    page_token: str | None = None
    for _ in range(max_pages):
        params: dict[str, Any] = {
            "part": "snippet,contentDetails,status",
            "playlistId": playlist_id,
            "maxResults": PLAYLIST_ITEMS_MAX_RESULTS,
        }
        if page_token:
            params["pageToken"] = page_token
        data = _get_json(_PLAYLIST_ITEMS_URL, params)
        if not data:
            break  # quota / network failure → keep what we have
        page_items = data.get("items") or []
        for raw in page_items:
            item = _parse_playlist_item(raw)
            if item:
                collected.append(item)
        if not page_items or len(collected) >= video_cap:
            break
        page_token = data.get("nextPageToken")
        if not page_token:
            break  # playlist ended
    if not collected:
        return None
    collected.sort(key=lambda it: it["position"])
    return collected[:video_cap]