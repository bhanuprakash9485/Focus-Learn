"""
playlist_service.py — FocusLearn playlist detection (backend).

For the top results of a normal YouTube video search, this module finds a
REAL YouTube playlist that actually contains the searched video and looks
like a learning sequence for the searched topic, then reports the playlist
id/title/count plus its FIRST SAFE video so the frontend can turn a single
video into a structured course.

Detection strategy (no fabricated data):

    safe video results
        ↓
    top results only (capped network budget)
        ↓
    fetch the video's channel → that channel's playlists (yt-dlp, cached)
        ↓
    rank candidate playlists by topic relevance + learning keywords
        ↓
    fetch candidate playlist contents (yt-dlp, cached, flat entries)
        ↓
    membership check — does the searched video REALLY appear in it?
        ↓
    first SAFE entry (individual SafeSearch scan) → playlist.first_video
        ↓
    attach {"id", "title", "video_count", "first_video", "videos"} or None

Every failure fails light: an unreachable/failed fetch simply means "no
playlist" and the normal video result is returned unchanged. Nothing is
ever fabricated, and playlist detection never runs on an unsafe query — the
search route blocks those before yt-dlp is called — and every playlist
entry is SafeSearch-scanned individually before it may appear in the
learning sequence (a playlist is NOT assumed safe because its title is).

Playlist metadata is cached in memory (a simple TTL map — no database), so
repeat searches of the same videos/channels/playlists do not re-fetch.
Network usage is bounded: only the top safe results are examined, only a
few candidate playlists per video have their contents fetched, and there is
a hard cap of content fetches per single search call.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor, wait

import relevance
import safesearch

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    yt_dlp = None  # type: ignore[assignment]

# ── Configuration ────────────────────────────────────────────────────────────

# How many top (safe) results get playlist detection. Keeps the network
# budget small while still covering the primary Focus Mode results.
TOP_VIDEOS = 4

# Playlist-content deliveries examined per video before giving up.
CONTENT_CANDIDATES_PER_VIDEO = 3

# Hard global cap of playlist-content fetches per single search call.
MAX_CONTENT_FETCHES_PER_SEARCH = 8

# Playlist entries captured (flat metadata only) for counting/navigation.
PLAYLIST_ITEMS_CAP = 120

# Wall-clock budget for all playlist detection in one search request.
ENRICH_TIMEOUT_SECONDS = 40.0

# In-memory TTL for playlist metadata (30 minutes).
CACHE_TTL = 30 * 60

_FLAT_OPTS: dict = {
    "quiet": True,
    "no_warnings": True,
    "extract_flat": True,
    "skip_download": True,
    "noplaylist": False,
}

# ── Caches (simple TTL maps) ────────────────────────────────────────────────

_cache_lock = threading.Lock()
# channel_id -> (expires, [(playlist_id, playlist_title), ...])
_channel_playlist_cache: dict[str, tuple[float, list[tuple[str, str]]]] = {}
# playlist_id -> (expires, [(video_id, video_title), ...])
_contents_cache: dict[str, tuple[float, list[tuple[str, str]]]] = {}


def _cache_get(store: dict, key: str):
    with _cache_lock:
        item = store.get(key)
        if not item:
            return None
        expires, value = item
        if time.monotonic() > expires:
            store.pop(key, None)
            return None
        return value


def _cache_put(store: dict, key: str, value: object) -> None:
    with _cache_lock:
        store[key] = (time.monotonic() + CACHE_TTL, value)


# ── Low-level yt-dlp fetches ────────────────────────────────────────────────

def _safe_entry_keep(entry: dict) -> bool:
    """Return True when a playlist entry may be shown as a learning video.

    Every playlist video is SafeSearch-scanned individually — a safe
    playlist is never assumed to make every video inside it safe.
    """
    kept, _ = safesearch.filter_videos([entry])
    return bool(kept)


def _channel_playlists(channel_id: str) -> list[tuple[str, str]] | None:
    """Return the channel's real playlists as [(playlist_id, title)] or None.

    Uses yt-dlp's channel → /playlists tab extractor, so the IDs and titles
    are genuine YouTube data, never guessed.
    """
    if not channel_id or not yt_dlp:
        return None
    cached = _cache_get(_channel_playlist_cache, channel_id)
    if cached is not None:
        return list(cached)

    url = f"https://www.youtube.com/channel/{channel_id}/playlists"
    try:
        opts = dict(_FLAT_OPTS)
        opts["playlist_items"] = "1-40"
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception:
        return None

    results: list[tuple[str, str]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("id")
        title = entry.get("title")
        if pid and title:
            results.append((str(pid), str(title)))
    if results:
        _cache_put(_channel_playlist_cache, channel_id, results)
    return results or None


def _fetch_playlist_contents(playlist_id: str) -> list[tuple[str, str]] | None:
    """Fetch (and cache) a playlist's flat entries as [(video_id, title)]."""
    url = f"https://www.youtube.com/playlist?list={playlist_id}"
    try:
        with yt_dlp.YoutubeDL(_FLAT_OPTS) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception:
        return None

    entries: list[tuple[str, str]] = []
    for entry in info.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        vid = entry.get("id")
        title = entry.get("title")
        if vid and title:
            entries.append((str(vid), str(title)))
        if len(entries) >= PLAYLIST_ITEMS_CAP:
            break
    if entries:
        _cache_put(_contents_cache, playlist_id, entries)
    return entries or None


# ── Relevance ───────────────────────────────────────────────────────────────

# Candidate playlists for a searched video are ranked with the SAME
# deterministic engine as the recommended playlist (relevance.py), so a
# specific topic playlist always outranks a generic catch-all such as
# "DSA-Related-Content" when the video genuinely appears in both. Membership
# is still verified (the searched video must really appear in the playlist
# entries) — relevance only decides WHICH playlist to present.


# ── Budget guard ────────────────────────────────────────────────────────────

_budget_lock = threading.Lock()


class _Budget:
    def __init__(self, maximum: int) -> None:
        self.consumed = 0
        self.maximum = maximum

    def consume(self) -> bool:
        """Reserve one network fetch. Returns False when exhausted."""
        with _budget_lock:
            if self.consumed >= self.maximum:
                return False
            self.consumed += 1
            return True


# ── Per-video detection ─────────────────────────────────────────────────────

def _detect_for_video(video: dict, query: str, budget: _Budget) -> dict | None:
    """Return the best real playlist containing *video*, or None."""
    video_id = video.get("id")
    channel_id = video.get("channel_id") or video.get("uploader_id")
    if not video_id or not channel_id:
        return None

    channels = _channel_playlists(str(channel_id))
    if not channels:
        return None

    channel_title = video.get("channel") or video.get("uploader") or ""
    candidates: list[tuple[int, str, str]] = []
    for pid, title in channels:
        # Generic/no-match playlists (e.g. "DSA-Related-Content") are only
        # offered when they are the ONLY real match — never ahead of a
        # playlist that actually matches the query.
        if not relevance.playlist_relevant(query, title, ""):
            continue
        score = relevance.score_playlist(query, title, "", channel_title)
        candidates.append((score, pid, title))
    candidates.sort(key=lambda item: item[0], reverse=True)

    for score, pid, title in candidates[:CONTENT_CANDIDATES_PER_VIDEO]:
        cached = _cache_get(_contents_cache, pid)
        if cached is not None:
            entries = list(cached)
        else:
            if not budget.consume():
                break
            entries = _fetch_playlist_contents(pid)
        if entries is None:
            continue

        entry_ids = {vid for vid, _ in entries}
        if video_id not in entry_ids:
            continue

        # Every playlist video must individually pass SafeSearch before it
        # can appear in the learning sequence.
        safe_entries = [
            (vid, entry_title)
            for (vid, entry_title) in entries
            if _safe_entry_keep({"id": vid, "title": entry_title})
        ]
        if not safe_entries:
            # Playlist exists but no safe learning video inside it — never
            # offer a learning sequence for it.
            return None

        first_video_id, first_video_title = safe_entries[0]
        return {
            "id": pid,
            "title": title,
            "video_count": len(entries),
            "channel_id": str(channel_id),
            "first_video": {"id": first_video_id, "title": first_video_title},
            "videos": [
                {"id": vid, "title": entry_title} for vid, entry_title in safe_entries
            ],
        }

    return None


# ── Public API ──────────────────────────────────────────────────────────────

def enrich_videos(
    videos: list[dict],
    query: str,
    timeout: float = ENRICH_TIMEOUT_SECONDS,
) -> list[dict]:
    """Return *videos* (never mutated) annotated with a ``playlist`` key.

    Each of the top safe results is checked against its real channel
    playlists. A video gets ``playlist`` = {"id", "title", "video_count",
    "channel_id", "first_video", "videos"} only when a genuine, relevant
    playlist that contains it is found; otherwise ``playlist`` is None.
    Detection runs in a small thread pool with a bounded network budget and
    fails open (no playlists) on any error or timeout.
    """
    if not videos or not all(isinstance(v, dict) for v in videos) or not yt_dlp:
        return list(videos)

    query_tokens = relevance.tokenize(query)
    if not query_tokens:
        return list(videos)
    top = videos[:TOP_VIDEOS]
    budget = _Budget(MAX_CONTENT_FETCHES_PER_SEARCH)

    results: list[dict | None] = [None] * len(top)
    executor = ThreadPoolExecutor(max_workers=3)
    try:
        futures = {
            executor.submit(_detect_for_video, video, query, budget): index
            for index, video in enumerate(top)
        }
        done, _ = wait(futures, timeout=timeout)
        for future in done:
            index = futures[future]
            try:
                results[index] = future.result()
            except Exception:
                results[index] = None
    finally:
        # Never block the request handler on slow stragglers — cancel what is
        # still queued and let already-running fetches finish in the background.
        executor.shutdown(wait=False, cancel_futures=True)

    out = [dict(video) for video in videos]
    for index, playlist in enumerate(results):
        if playlist:
            out[index]["playlist"] = playlist
    return out


# ── Test helpers (kept minimal — real detection always hits the network) ───

def clear_caches() -> None:
    """Drop all cached playlist metadata (used by tests)."""
    with _cache_lock:
        _channel_playlist_cache.clear()
        _contents_cache.clear()