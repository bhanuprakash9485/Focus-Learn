"""
websearch.py - FocusLearn internet information retrieval for roadmap generation.

Uses the Wikipedia REST API (no API key required) to retrieve educational
context about any topic. Falls back to DuckDuckGo instant answers when
Wikipedia has no article. Zero new dependencies — stdlib only.

Usage::

    from websearch import search_topic_context
    context = search_topic_context("Java Recursion")
    # -> [{"title": "...", "snippet": "...", "url": "..."}, ...]
"""

from __future__ import annotations

import json
import re
import urllib.request
import urllib.parse
import urllib.error
from typing import Any


def _http_get(url: str, timeout: int = 8) -> str | None:
    """GET *url* and return the response body as a string, or None on failure."""
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "FocusLearn/1.0 (educational platform)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except Exception:
        return None


def _wikipedia_summary(topic: str) -> dict[str, str] | None:
    """Fetch the Wikipedia summary for *topic* via the REST API."""
    encoded = urllib.parse.quote(topic.replace(" ", "_"))
    url = f"https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}"
    raw = _http_get(url, timeout=6)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    if data.get("type") == "disambiguation":
        # Try the first option from the disambiguation page
        return None
    title = data.get("title", "")
    extract = data.get("extract", "")
    page_url = data.get("content_urls", {}).get("desktop", {}).get("page", "")
    if not extract:
        return None
    return {"title": title, "snippet": extract[:1500], "url": page_url}


def _wikipedia_search(topic: str, limit: int = 5) -> list[dict[str, str]]:
    """Search Wikipedia for articles related to *topic*."""
    params = urllib.parse.urlencode({"q": topic, "limit": limit})
    url = f"https://en.wikipedia.org/w/api.php?action=query&list=search&{params}&format=json"
    raw = _http_get(url, timeout=6)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    results = []
    for item in data.get("query", {}).get("search", []):
        title = item.get("title", "")
        snippet = re.sub(r"<[^>]+>", "", item.get("snippet", ""))
        results.append({
            "title": title,
            "snippet": snippet[:800],
            "url": f"https://en.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
        })
    return results


def _duckduckgo_instant(topic: str) -> dict[str, str] | None:
    """Fetch DuckDuckGo instant answer for *topic*."""
    params = urllib.parse.urlencode({"q": topic, "format": "json", "no_html": 1, "skip_disambig": 1})
    url = f"https://api.duckduckgo.com/?{params}"
    raw = _http_get(url, timeout=6)
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return None
    abstract = data.get("AbstractText", "")
    heading = data.get("Heading", "")
    source_url = data.get("AbstractURL", "")
    if not abstract:
        return None
    return {"title": heading or topic, "snippet": abstract[:1500], "url": source_url}


def _duckduckgo_related(topic: str) -> list[dict[str, str]]:
    """Get related topics from DuckDuckGo."""
    params = urllib.parse.urlencode({"q": topic, "format": "json", "no_html": 1})
    url = f"https://api.duckduckgo.com/?{params}"
    raw = _http_get(url, timeout=6)
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return []
    results = []
    for item in (data.get("RelatedTopics") or [])[:5]:
        if isinstance(item, dict) and item.get("Text"):
            results.append({
                "title": item.get("Text", "")[:80],
                "snippet": item.get("Text", "")[:400],
                "url": item.get("FirstURL", ""),
            })
    return results


def search_topic_context(topic: str) -> list[dict[str, str]]:
    """Retrieve educational context about *topic* from the internet.

    Returns a list of ``{"title", "snippet", "url"}`` dicts ordered by
    relevance.  Combines Wikipedia summary + search results with DuckDuckGo
    instant answers.  Total context is capped to keep token usage reasonable.

    Never raises — all failures degrade gracefully to an empty list.
    """
    sources: list[dict[str, str]] = []

    # 1. Wikipedia summary (highest quality)
    summary = _wikipedia_summary(topic)
    if summary:
        sources.append(summary)

    # 2. DuckDuckGo instant answer
    ddg = _duckduckgo_instant(topic)
    if ddg and ddg["title"] != (summary or {}).get("title"):
        sources.append(ddg)

    # 3. Wikipedia search results (related articles)
    wiki_results = _wikipedia_search(topic, limit=3)
    for r in wiki_results:
        if r["title"] != (summary or {}).get("title"):
            sources.append(r)

    # 4. DuckDuckGo related topics
    ddg_related = _duckduckgo_related(topic)
    for r in ddg_related:
        sources.append(r)

    # Cap total context length (roughly 4000 chars max)
    total = 0
    capped: list[dict[str, str]] = []
    for s in sources:
        snippet_len = len(s.get("snippet", ""))
        if total + snippet_len > 4000:
            # Truncate the last snippet to fit
            remaining = 4000 - total
            if remaining > 100:
                s = {**s, "snippet": s["snippet"][:remaining]}
                capped.append(s)
            break
        capped.append(s)
        total += snippet_len

    return capped


def format_context_for_ai(sources: list[dict[str, str]]) -> str:
    """Format retrieved sources into a compact context block for Groq."""
    if not sources:
        return "(No internet information retrieved — rely on your training knowledge.)"

    parts = []
    for i, src in enumerate(sources, 1):
        title = src.get("title", "Unknown")
        snippet = src.get("snippet", "").strip()
        if snippet:
            parts.append(f"Source {i}: {title}\n{snippet}")

    return "\n\n".join(parts)
