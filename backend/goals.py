"""
FocusLearn goals — SQLite-backed multi-goal management.

Every goal belongs to exactly one authenticated user. The table is created
additively on first call to ``init_db()`` so existing databases (which only
have the auth tables) keep working; no rows are ever migrated or deleted.

    goals(
        id, user_id, title, description, goal_type, priority, status,
        experience_level, daily_minutes, target_date,
        estimated_completion_date, is_primary, goal_context,
        existing_knowledge, roadmap_json, created_at, updated_at, completed_at
    )

The AI-generated roadmap is stored as a JSON blob on the goal row
(``roadmap_json``). Progress is never stored — it is derived on the client
from real quiz attempts so it always reflects the latest performance.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone

import auth

_get_conn = auth._get_conn

STATUSES = ("active", "paused", "completed", "archived")
PRIORITIES = ("low", "medium", "high")
EXPERIENCE_LEVELS = ("beginner", "intermediate", "advanced")

# Fields a client may set directly (roadmap handled separately).
_EDITABLE = (
    "title",
    "description",
    "goal_type",
    "priority",
    "experience_level",
    "daily_minutes",
    "target_date",
    "goal_context",
    "existing_knowledge",
)


def init_db() -> None:
    """Create the goals table + index if they do not exist yet."""
    conn = _get_conn()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS goals (
            id                        TEXT PRIMARY KEY,
            user_id                   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title                     TEXT NOT NULL,
            description               TEXT NOT NULL DEFAULT '',
            goal_type                 TEXT NOT NULL DEFAULT 'custom',
            priority                  TEXT NOT NULL DEFAULT 'medium',
            status                    TEXT NOT NULL DEFAULT 'active',
            experience_level          TEXT NOT NULL DEFAULT 'beginner',
            daily_minutes             INTEGER NOT NULL DEFAULT 30,
            target_date               TEXT,
            estimated_completion_date TEXT,
            is_primary                INTEGER NOT NULL DEFAULT 0,
            goal_context              TEXT NOT NULL DEFAULT '',
            existing_knowledge        TEXT NOT NULL DEFAULT '',
            roadmap_json              TEXT,
            created_at                TEXT NOT NULL,
            updated_at                TEXT NOT NULL,
            completed_at              TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_goals_user ON goals(user_id);
        """
    )
    conn.commit()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_str(value: object, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


def _clean_int(value: object, fallback: int, low: int, high: int) -> int:
    try:
        num = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, num))


def _clean_enum(value: object, allowed: tuple[str, ...], fallback: str) -> str:
    text = _clean_str(value, 40).lower()
    return text if text in allowed else fallback


def _clean_roadmap(value: object) -> str | None:
    """Serialize a roadmap dict for storage (``None`` clears it)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        return None
    return json.dumps(value)


def _goal_dict(row) -> dict:
    """Public goal shape returned to clients (camelCase for the SPA)."""
    roadmap = None
    raw = row["roadmap_json"]
    if raw:
        try:
            parsed = json.loads(raw)
            roadmap = parsed if isinstance(parsed, dict) else None
        except (TypeError, ValueError):
            roadmap = None
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "goalType": row["goal_type"],
        "priority": row["priority"],
        "status": row["status"],
        "experienceLevel": row["experience_level"],
        "dailyMinutes": row["daily_minutes"],
        "targetDate": row["target_date"],
        "estimatedCompletionDate": row["estimated_completion_date"],
        "isPrimary": bool(row["is_primary"]),
        "goalContext": row["goal_context"],
        "existingKnowledge": row["existing_knowledge"],
        "roadmap": roadmap,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "completedAt": row["completed_at"],
    }


def list_goals(user_id: str) -> list[dict]:
    """All goals for a user, newest first (primary goal sorts first)."""
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM goals WHERE user_id = ? "
        "ORDER BY is_primary DESC, created_at DESC",
        (user_id,),
    ).fetchall()
    return [_goal_dict(r) for r in rows]


def get_goal(user_id: str, goal_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT * FROM goals WHERE id = ? AND user_id = ?",
        (goal_id, user_id),
    ).fetchone()
    return _goal_dict(row) if row else None


def _clear_primary(conn, user_id: str, except_id: str | None = None) -> None:
    if except_id:
        conn.execute(
            "UPDATE goals SET is_primary = 0 WHERE user_id = ? AND id != ?",
            (user_id, except_id),
        )
    else:
        conn.execute("UPDATE goals SET is_primary = 0 WHERE user_id = ?", (user_id,))


def create_goal(user_id: str, payload: dict) -> dict:
    """Insert a new goal. Assumes ``title`` was validated by the caller."""
    conn = _get_conn()
    goal_id = f"goal-{secrets.token_hex(8)}"
    now = _now()
    is_primary = 1 if payload.get("isPrimary") else 0
    if not is_primary:
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM goals WHERE user_id = ?", (user_id,)
        ).fetchone()["c"]
        if count == 0:
            is_primary = 1
    if is_primary:
        _clear_primary(conn, user_id)

    conn.execute(
        "INSERT INTO goals (id, user_id, title, description, goal_type, priority, "
        "status, experience_level, daily_minutes, target_date, "
        "estimated_completion_date, is_primary, goal_context, existing_knowledge, "
        "roadmap_json, created_at, updated_at, completed_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        (
            goal_id,
            user_id,
            _clean_str(payload.get("title"), 200),
            _clean_str(payload.get("description"), 2000),
            _clean_str(payload.get("goalType"), 40).lower() or "custom",
            _clean_enum(payload.get("priority"), PRIORITIES, "medium"),
            _clean_enum(payload.get("status"), STATUSES, "active"),
            _clean_enum(payload.get("experienceLevel"), EXPERIENCE_LEVELS, "beginner"),
            _clean_int(payload.get("dailyMinutes"), 30, 1, 1440),
            _clean_str(payload.get("targetDate"), 20) or None,
            _clean_str(payload.get("estimatedCompletionDate"), 20) or None,
            is_primary,
            _clean_str(payload.get("goalContext"), 2000),
            _clean_str(payload.get("existingKnowledge"), 2000),
            _clean_roadmap(payload.get("roadmap")),
            now,
            now,
        ),
    )
    conn.commit()
    return get_goal(user_id, goal_id)  # type: ignore[return-value]


def update_goal(user_id: str, goal_id: str, patch: dict) -> dict | None:
    """Apply an editable-field patch. Returns the updated goal or None."""
    existing = get_goal(user_id, goal_id)
    if existing is None:
        return None

    conn = _get_conn()
    sets: list[str] = []
    values: list[object] = []

    for field in _EDITABLE:
        if field not in patch:
            continue
        value = patch[field]
        if field == "daily_minutes":
            value = _clean_int(value, existing["dailyMinutes"], 1, 1440)
        elif field == "priority":
            value = _clean_enum(value, PRIORITIES, existing["priority"])
        elif field == "experience_level":
            value = _clean_enum(value, EXPERIENCE_LEVELS, existing["experienceLevel"])
        elif field in ("target_date", "estimated_completion_date"):
            value = _clean_str(value, 20) or None
        else:
            value = _clean_str(value, 2000 if field != "title" else 200)
        sets.append(f"{field} = ?")
        values.append(value)

    if "roadmap" in patch:
        sets.append("roadmap_json = ?")
        values.append(_clean_roadmap(patch.get("roadmap")))

    if not sets:
        return existing

    sets.append("updated_at = ?")
    values.append(_now())
    values.extend([goal_id, user_id])
    conn.execute(
        f"UPDATE goals SET {', '.join(sets)} WHERE id = ? AND user_id = ?",
        tuple(values),
    )
    conn.commit()
    return get_goal(user_id, goal_id)


def set_status(user_id: str, goal_id: str, status: str) -> dict | None:
    """Transition a goal's status (pause/resume/archive/restore/complete)."""
    if status not in STATUSES:
        return None
    if get_goal(user_id, goal_id) is None:
        return None
    conn = _get_conn()
    completed_at = _now() if status == "completed" else None
    conn.execute(
        "UPDATE goals SET status = ?, completed_at = ?, updated_at = ? "
        "WHERE id = ? AND user_id = ?",
        (status, completed_at, _now(), goal_id, user_id),
    )
    conn.commit()
    return get_goal(user_id, goal_id)


def set_primary(user_id: str, goal_id: str) -> dict | None:
    """Mark one goal as the user's primary goal (all others cleared)."""
    if get_goal(user_id, goal_id) is None:
        return None
    conn = _get_conn()
    _clear_primary(conn, user_id)
    conn.execute(
        "UPDATE goals SET is_primary = 1, updated_at = ? WHERE id = ? AND user_id = ?",
        (_now(), goal_id, user_id),
    )
    conn.commit()
    return get_goal(user_id, goal_id)


def delete_goal(user_id: str, goal_id: str) -> bool:
    """Permanently delete a goal. Returns False when it does not exist."""
    if get_goal(user_id, goal_id) is None:
        return False
    conn = _get_conn()
    conn.execute("DELETE FROM goals WHERE id = ? AND user_id = ?", (goal_id, user_id))
    conn.commit()
    return True
