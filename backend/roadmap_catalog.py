"""
FocusLearn roadmap.sh catalog sync (metadata only).

Discovers the public roadmap.sh catalog strictly for discovery/navigation:

- Slugs come from the public GitHub *directory listing* of the
  developer-roadmap repository (``roadmaps/``). A directory listing is
  metadata — we never download roadmap text, images or node content.
- Official titles and grouping come from roadmap.sh's own listings page
  (``https://roadmap.sh/roadmaps``) — again metadata only.
- Every source URL is constructed from a validated slug as
  ``https://roadmap.sh/<slug>``; no arbitrary external URL is ever stored.

We do NOT store, mirror or republish complete roadmap.sh roadmaps,
step-by-step content, per-node descriptions, or any roadmap.sh images.
Descriptions and aliases below are original FocusLearn wording used purely
to make local search/filtering usable.

Endpoints (see server.py):

    GET  /api/roadmaps/catalog   — cached catalog (auto-refresh when stale)
    POST /api/roadmaps/refresh   — force a refresh of the cache
"""

from __future__ import annotations

import json
import os
import re
import threading
import urllib.request
from datetime import datetime, timedelta, timezone

ROADMAPS_LISTING_URL = "https://roadmap.sh/roadmaps"
GITHUB_LISTING_URL = (
    "https://api.github.com/repos/kamranahmedse/developer-roadmap/contents/roadmaps"
)
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CACHE_FILE = os.path.join(DATA_DIR, "roadmap_catalog.json")

# Refresh at most once per day; catalog data changes rarely.
REFRESH_TTL_SECONDS = 24 * 60 * 60
# Hard network timeouts so a hung upstream never blocks the API.
FETCH_TIMEOUT = 20
_USER_AGENT = "Mozilla/5.0 (FocusLearn; roadmap catalog sync - metadata only)"

_VALID_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,60}$")
_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

# Footer / navigation links seen on the roadmap.sh listings page that are not
# roadmaps. Used only when the authoritative GitHub slug set is unavailable.
_NAV_LINKS = {
    "roadmaps", "guides", "about", "terms", "privacy", "signup", "login", "ai",
    "discord", "contribute", "aws-best-practices", "api-security-best-practices",
    "backend-performance-best-practices", "frontend-performance-best-practices",
    "code-review-best-practices",
}

# Sections of the roadmap.sh listings page we treat as roadmap catalog
# entries. "Best Practices" is excluded — those links are navigation/footer
# entries, not roadmap.sh roadmaps.
_ROADMAP_SECTIONS = {
    "role based roadmaps": "role-based",
    "skill based roadmaps": "skill-based",
    "absolute beginners": "beginner",
    "new roadmaps": "new",
}

# Original FocusLearn wording for card descriptions (never copied from
# roadmap.sh). group = the UI-facing facet used for the filter chips.
def _description_for(category: str, title: str) -> str:
    if category == "role-based":
        return f"Official roadmap.sh role path — the skills and technologies used by a {title}."
    if category == "skill-based":
        return f"Official roadmap.sh skill path — a structured learning sequence for {title}."
    return f"Official roadmap.sh path — an entry plan into {title}."


def _group_for(slug: str, category: str) -> str:
    """Map a slug/category to a UI filter facet. Derived keyword rules only."""
    s = slug.lower()
    # Long keywords: substring match is safe. Short ("ml") must match exactly
    # so it can never collide with slugs like "html"/"xml".
    ai_ml = (
        "ai-", "ml-ops", "mlops", "machine-learning", "data-scientist",
        "data-analyst", "data-engineer", "prompt-engineering", "bi-analyst",
        "power-bi", "claude-code", "vibe-coding", "openclaw",
    )
    ai_ml_exact = {"ml"}
    web = (
        "frontend", "backend", "full-stack", "react", "vue", "angular",
        "javascript", "typescript", "nodejs", "nextjs", "html", "css",
        "api-design", "django", "laravel", "aspnet-core", "spring-boot",
        "wordpress",
    )
    languages_long = (
        "python", "cpp", "golang", "rust", "ruby", "scala", "kotlin",
        "swift", "shell-bash", "php", "java",
    )
    languages_exact = {"python", "java", "cpp", "c", "golang", "rust", "ruby",
                       "scala", "kotlin", "swift", "php", "r", "r-programming"}
    devops = (
        "devops", "devsecops", "docker", "kubernetes", "aws", "terraform",
        "linux", "cloudflare", "git-github",
    )
    databases = {"sql", "mongodb", "redis", "postgresql-dba", "elasticsearch"}
    comp_sci = {"computer-science", "datastructures-and-algorithms", "system-design", "leetcode"}
    mobile = {"android", "ios", "react-native", "flutter"}
    # Checked before "web" so Design System / Design Architecture are not
    # absorbed by the broad "web-dev" keywords.
    design = {"design-system", "ux-design", "product-design", "software-design-architecture"}
    security = {"cyber-security", "api-security"}
    if any(k in s for k in ai_ml) or s in ai_ml_exact:
        return "ai-ml"
    if s in design:
        return "design"
    if any(k in s for k in web):
        return "web-dev"
    if any(k in s for k in languages_long) or s in languages_exact:
        return "languages"
    if any(k in s for k in devops):
        return "devops"
    if s in databases:
        return "databases"
    if s in comp_sci:
        return "computer-science"
    if s in mobile:
        return "mobile"
    if s in security:
        return "security"
    return "other"


def _aliases_for(slug: str) -> list[str]:
    """Small alias table (original words) to make local search friendlier."""
    table = {
        "frontend": ["frontend developer", "web frontend", "ui"],
        "backend": ["backend developer", "server"],
        "full-stack": ["fullstack", "web developer"],
        "datastructures-and-algorithms": ["data structures", "algorithms", "dsa", "interview prep"],
        "android": ["mobile", "app developer"],
        "ios": ["mobile", "app developer", "swift"],
        "react": ["frontend", "web", "ui"],
        "vue": ["frontend", "web"],
        "angular": ["frontend", "web"],
        "javascript": ["frontend", "js", "web"],
        "typescript": ["frontend", "ts", "web"],
        "nodejs": ["node.js", "node", "backend", "backend-engineer"],
        "nextjs": ["next.js", "frontend", "web"],
        "python": ["py", "coding"],
        "python-data-analysis": ["data", "pandas", "numpy"],
        "java": ["coding", "jvm"],
        "golang": ["go", "backend"],
        "rust": ["systems"],
        "cyber-security": ["security", "infosec", "hacking"],
        "machine-learning": ["ml", "ai", "data"],
        "ai-engineer": ["ml", "ai", "data"],
        "ai-data-scientist": ["ml", "ai", "data science"],
        "data-engineer": ["data", "etl", "big data"],
        "data-analyst": ["data", "analytics"],
        "bi-analyst": ["business intelligence", "data", "analytics"],
        "power-bi": ["data", "analytics", "bi"],
        "devops": ["site reliability", "sre", "infra"],
        "git-github": ["version control", "git"],
        "sql": ["database", "query"],
        "mongodb": ["database", "nosql"],
        "redis": ["cache", "database"],
        "postgresql-dba": ["database", "postgres", "dba"],
        "elasticsearch": ["search", "database"],
        "machine-learning-operations": ["mlops", "deploy"],
        "mlops": ["deploy", "model deployment"],
        "kubernetes": ["k8s", "containers"],
        "docker": ["containers"],
        "aws": ["cloud"],
        "terraform": ["iac", "infrastructure as code"],
        "linux": ["bash", "unix", "cli"],
        "shell-bash": ["bash", "terminal", "cli"],
        "spring-boot": ["java", "backend", "backend-engineer"],
        "flutter": ["mobile", "dart", "app"],
        "react-native": ["mobile", "app", "react"],
        "kotlin": ["mobile", "android"],
        "swift-ui": ["ios", "mobile", "apple"],
        "qa": ["testing", "quality assurance"],
        "game-developer": ["gaming", "gamedev"],
        "server-side-game-developer": ["gaming", "backend"],
        "blockchain": ["web3", "crypto"],
        "product-manager": ["pm"],
        "engineering-manager": ["em", "leadership"],
        "technical-writer": ["docs", "documentation"],
        "ux-design": ["ui", "design", "user experience"],
        "product-design": ["ui", "design"],
        "design-system": ["ui", "design"],
        "prompt-engineering": ["ai", "llm", "chatgpt"],
        "ai-agents": ["ai", "llm", "agents"],
        "claude-code": ["ai", "llm", "anthropic", "coding"],
        "vibe-coding": ["ai", "coding", "ai-assisted"],
        "openclaw": ["ai", "open source", "assistant"],
        "computer-science": ["cs", "foundations"],
        "system-design": ["architecture", "scalability"],
        "leetcode": ["dsa", "interview", "competitive programming"],
        "api-design": ["backend", "rest", "web"],
    }
    return table.get(slug, [])


# --------------------------------------------------------------------------
# Fetching (metadata only)
# --------------------------------------------------------------------------

def _fetch_github_slugs() -> set[str] | None:
    """Authoritative slug set from the public GitHub directory listing."""
    try:
        req = urllib.request.Request(
            GITHUB_LISTING_URL,
            headers={"User-Agent": _USER_AGENT, "Accept": "application/vnd.github+json"},
        )
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        slugs: set[str] = set()
        if isinstance(payload, list):
            for item in payload:
                name = (item or {}).get("name")
                if isinstance(name, str) and _VALID_SLUG_RE.match(name):
                    slugs.add(name)
        return slugs or None
    except Exception:
        return None


def _fetch_listing() -> list[tuple[str, str, str]] | None:
    """(section_key, slug, title) triplets from the roadmap.sh listings page.

    Only titles + slugs are extracted — metadata for navigation only.
    """
    try:
        req = urllib.request.Request(ROADMAPS_LISTING_URL, headers={"User-Agent": _USER_AGENT})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            html = resp.read().decode("utf-8", "ignore")
    except Exception:
        return None

    headings = [
        (m.start(), _WHITESPACE_RE.sub(" ", _HTML_TAG_RE.sub("", m.group(1))).strip().lower())
        for m in re.finditer(r"<h2[^>]*>(.*?)</h2>", html, re.S)
    ]
    anchor_re = re.compile(r'<a[^>]*href="/([a-z0-9][a-z0-9-]*)"[^>]*>(.*?)</a>', re.S)
    entries: list[tuple[str, str, str]] = []
    for i, (pos, heading) in enumerate(headings):
        section_key = _ROADMAP_SECTIONS.get(heading)
        if section_key is None:
            continue
        end = headings[i + 1][0] if i + 1 < len(headings) else len(html)
        for m in anchor_re.finditer(html, pos, end):
            slug = m.group(1)
            title = _WHITESPACE_RE.sub(" ", _HTML_TAG_RE.sub("", m.group(2))).strip()
            title = title.replace("&amp;", "&").replace("&#x27;", "'")
            if not slug or not title:
                continue
            entries.append((section_key, slug, title))
    return entries or None


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------

def _fallback_title(slug: str) -> str:
    """Reader-friendly title from the slug (fallback when the listing is down)."""
    known = {
        "cpp": "C++", "golang": "Go", "nodejs": "Node.js", "nextjs": "Next.js",
        "c": "C", "r": "R", "r-programming": "R Programming",
        "datastructures-and-algorithms": "Data Structures & Algorithms",
        "git-github": "Git and GitHub", "shell-bash": "Shell / Bash",
        "swift-ui": "Swift & Swift UI", "postgresql-dba": "PostgreSQL",
        "aspnet-core": "ASP.NET Core", "python-data-analysis": "Python for Data Analysis",
        "react-native": "React Native", "ai-data-scientist": "AI and Data Scientist",
        "software-design-architecture": "Design Architecture",
    }
    if slug in known:
        return known[slug]
    title = slug.replace("-", " ").title()
    return _WHITESPACE_RE.sub(" ", title)


def _category_for(section_key: str, slug: str) -> str:
    if section_key == "role-based":
        return "role-based"
    if section_key == "skill-based":
        return "skill-based"
    if section_key == "beginner":
        return "skill-based" if slug.startswith("git-github") else "role-based"
    return "skill-based"


def _build_entry(slug: str, title: str, section_key: str, synced_at: str) -> dict:
    category = _category_for(section_key, slug)
    group = _group_for(slug, category)
    return {
        "id": slug,
        "title": title or _fallback_title(slug),
        "category": category,
        "group": group,
        "source": "roadmap.sh",
        "sourceUrl": f"https://roadmap.sh/{slug}",
        "description": _description_for(category, title or _fallback_title(slug)),
        "icon": group,
        "keywords": _aliases_for(slug),
        "isNew": section_key == "new",
        "lastChecked": synced_at,
    }


def _normalise(
    entries: list[tuple[str, str, str]],
    github_slugs: set[str] | None,
    synced_at: str,
) -> list[dict]:
    """Dedupe by slug, prefer role/skill sections, drop non-roadmap links.

    Metadata only — titles/slugs/categories; never roadmap.sh content.
    """
    # Pairing priority: specific role/skill labels win over "beginner" and
    # "new" when the same roadmap appears in several sections.
    priority = {"role-based": 3, "skill-based": 3, "beginner": 2, "new": 1}

    best: dict[str, tuple[int, dict]] = {}
    is_new: dict[str, bool] = {}

    for section_key, slug, title in entries:
        if not _VALID_SLUG_RE.match(slug):
            continue
        if github_slugs is not None and slug not in github_slugs:
            continue
        if github_slugs is None and slug in _NAV_LINKS:
            continue
        is_new[slug] = is_new.get(slug, False) or section_key == "new"
        rank = priority.get(section_key, 0)
        prev_rank, prev = best.get(slug, (0, None))
        if prev is None or rank > prev_rank:
            best[slug] = (rank, _build_entry(slug, title, section_key, synced_at))

    result = []
    for slug, (_, entry) in best.items():
        entry["isNew"] = is_new.get(slug, False)
        result.append(entry)
    return sorted(result, key=lambda e: e["title"].lower())


# --------------------------------------------------------------------------
# Cache + sync
# --------------------------------------------------------------------------

_lock = threading.Lock()
_in_memory: dict | None = None


def _cache_payload(catalog: list[dict], status: str, synced_at: str, last_success: str | None) -> dict:
    return {
        "source": "roadmap.sh",
        "syncedAt": synced_at,
        "status": status,
        "lastSuccess": last_success,
        "catalog": catalog,
    }


def _load_cache() -> dict | None:
    try:
        with open(CACHE_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("catalog"), list):
            return data
    except Exception:
        pass
    return None


def _write_cache(payload: dict) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, CACHE_FILE)
    except Exception:
        pass


def _sync() -> dict | None:
    """Fetch + normalise the catalog. Returns cache payload or None."""
    synced_at = datetime.now(timezone.utc).isoformat()
    github_slugs = _fetch_github_slugs()
    entries = _fetch_listing()
    if github_slugs is None and entries is None:
        return None
    if entries is None:
        # Listing down but slugs available: build minimal entries from slugs.
        entries = [
            ("skill-based" if github_slugs else "skill-based", slug, _fallback_title(slug))
            for slug in sorted(github_slugs)
        ]
    catalog = _normalise(entries, github_slugs, synced_at)
    if not catalog:
        return None
    return _cache_payload(catalog, "ok", synced_at, synced_at)


def _is_fresh(payload: dict | None) -> bool:
    if not payload:
        return False
    try:
        synced = datetime.fromisoformat(payload.get("syncedAt") or "")
        return datetime.now(timezone.utc) - synced < timedelta(seconds=REFRESH_TTL_SECONDS)
    except Exception:
        return False


def _api_frame(payload: dict | None, stale: bool) -> dict:
    """Shape a cache payload into the public API response."""
    if payload is None:
        return {
            "ok": False,
            "error": "The roadmap.sh catalog is unavailable and there is no cached catalog yet.",
            "source": "roadmap.sh",
            "generatedAt": None,
            "stale": False,
            "sync": {"status": "error", "lastAttempt": _now_iso(), "lastSuccess": None, "nextRefresh": None},
            "catalog": [],
        }
    now = datetime.now(timezone.utc)
    last_success = payload.get("lastSuccess")
    next_refresh = None
    if last_success:
        try:
            next_refresh = (datetime.fromisoformat(last_success) + timedelta(seconds=REFRESH_TTL_SECONDS)).isoformat()
        except Exception:
            next_refresh = None
    items = payload.get("catalog") or []
    for item in items:
        item["lastChecked"] = item.get("lastChecked") or payload.get("syncedAt")
    return {
        "ok": True,
        "source": payload.get("source") or "roadmap.sh",
        "generatedAt": payload.get("syncedAt"),
        "stale": stale,
        "sync": {
            "status": payload.get("status") or ("stale" if stale else "ok"),
            "lastAttempt": _now_iso(),
            "lastSuccess": last_success,
            "nextRefresh": next_refresh,
        },
        "catalog": items,
    }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_catalog(force_refresh: bool = False) -> dict:
    """Public API: returns the catalog response dict (never throws)."""
    global _in_memory
    with _lock:
        payload = _in_memory or _load_cache()
        fresh = _is_fresh(payload)
        if force_refresh or (payload is not None and not fresh):
            new_payload = _sync()
            if new_payload is not None:
                payload = new_payload
                _in_memory = new_payload
                _write_cache(new_payload)
            elif payload is None:
                # Nothing cached anywhere and sync failed.
                return _api_frame(None, False)
            # else: keep stale payload (falls through with stale=True)
        elif payload is None:
            new_payload = _sync()
            if new_payload is not None:
                payload = new_payload
                _in_memory = new_payload
                _write_cache(new_payload)
            else:
                return _api_frame(None, False)

        stale = not _is_fresh(payload)
        frame = _api_frame(payload, stale)
        if stale:
            frame["sync"]["notice"] = (
                "Roadmap catalog temporarily unavailable. Showing the last available catalog."
            )
        if force_refresh and stale and payload is not None:
            frame["ok"] = True
        return frame