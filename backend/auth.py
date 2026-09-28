"""
FocusLearn authentication — SQLite + PBKDF2 + session management.

Password hashing: PBKDF2-HMAC-SHA256 (stdlib hashlib, 100 000 iterations).
Sessions: 128-char hex token stored in SQLite + forwarded as HttpOnly cookie.

Tables created on first call to ``init_db()``:

    users(id, name, email, password_hash, google_id, firebase_uid,
          auth_provider, created_at)
    sessions(token, user_id, created_at, expires_at)

``auth_provider`` is ``'email'`` for password accounts and ``'google'`` for
Google sign-in (both the Google Identity Services and Firebase flows).
Google-only accounts have an empty ``password_hash`` (their
``authenticate_user`` always fails) while linked accounts keep their hash so
the password remains a valid alternative sign-in method. ``google_id`` stores
a Google Identity Services subject id and ``firebase_uid`` a Firebase UID, so
the two Google flows never collide. Existing databases are migrated in place —
no rows are ever deleted or reset.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone

# FOCUSLEARN_DATA_DIR lets a deployment (or a test) put the SQLite file
# somewhere writable and isolated - Vercel needs /tmp, tests need a temp dir.
# Unset, it keeps the historical backend/data/focuslearn.db location.
_DATA_DIR = (os.environ.get("FOCUSLEARN_DATA_DIR") or "").strip()
DB_PATH = os.path.join(
    _DATA_DIR if _DATA_DIR else os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"),
    "focuslearn.db",
)
SESSION_TTL_DAYS = 30
PBKDF2_ITERATIONS = 100_000
COOKIE_NAME = "fl_session"
# Default is SameSite=Lax with Secure only when served over HTTPS
# (FOCUSLEARN_HTTPS=1). For a setup where the frontend lives on a DIFFERENT
# origin than the API, set FOCUSLEARN_COOKIE_SAMESITE=None (implies Secure).
_COOKIE_FLAGS = "HttpOnly; SameSite=Lax"
_SAMESITE = os.environ.get("FOCUSLEARN_COOKIE_SAMESITE", "Lax").strip().title()
if _SAMESITE not in ("Lax", "Strict", "None"):
    _SAMESITE = "Lax"

_conn: sqlite3.Connection | None = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        _conn = sqlite3.connect(DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute("PRAGMA foreign_keys=ON")
    return _conn


def init_db() -> None:
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            email         TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            google_id     TEXT,
            firebase_uid  TEXT,
            auth_provider TEXT NOT NULL DEFAULT 'email',
            created_at    TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token      TEXT PRIMARY KEY,
            user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    """)
    _migrate_legacy_schema(conn)
    conn.commit()


def _migrate_legacy_schema(conn: sqlite3.Connection) -> None:
    """Add Google columns to databases that predate Google sign-in.

    Only adds missing columns/indexes — existing rows are preserved and any
    pre-Google rows are marked ``auth_provider='email'``.
    """
    cols = {row[1] for row in conn.execute("PRAGMA table_info(users)")}
    if "google_id" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN google_id TEXT")
    if "firebase_uid" not in cols:
        conn.execute("ALTER TABLE users ADD COLUMN firebase_uid TEXT")
    if "auth_provider" not in cols:
        conn.execute(
            "ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'email'"
        )
    conn.execute(
        "UPDATE users SET auth_provider = 'email' "
        "WHERE auth_provider IS NULL OR auth_provider = ''"
    )
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)"
    )


# ── Password hashing ────────────────────────────────────────────────────

def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS
    )
    return f"{salt}${dk.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        salt, hexhash = stored.split("$", 1)
    except ValueError:
        return False
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), PBKDF2_ITERATIONS
    )
    return secrets.compare_digest(dk.hex(), hexhash)


# ── User CRUD ───────────────────────────────────────────────────────────

def _user_dict(row) -> dict:
    """Public user dict (never the hash). ``has_password`` tells clients
    whether password-based sign-in is available on the account."""
    return {
        "id": row["id"],
        "name": row["name"],
        "email": row["email"],
        "created_at": row["created_at"],
        "has_password": bool(row["password_hash"]),
    }


def create_user(name: str, email: str, password: str) -> dict | None:
    """Return the new user dict (no hash) or None if email is taken."""
    conn = _get_conn()
    existing = conn.execute(
        "SELECT id FROM users WHERE email = ?", (email.lower(),)
    ).fetchone()
    if existing:
        return None

    uid = f"usr-{secrets.token_hex(8)}"
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, auth_provider, created_at) "
        "VALUES (?, ?, ?, ?, 'email', ?)",
        (uid, name.strip(), email.lower(), _hash_password(password), now),
    )
    conn.commit()
    return {"id": uid, "name": name.strip(), "email": email.lower(), "created_at": now,
            "has_password": True}


def create_google_user(google_id: str, name: str, email: str) -> dict | None:
    """Create a Google-only account (no password). Returns the user dict or
    None if the email is already taken."""
    conn = _get_conn()
    existing = conn.execute(
        "SELECT id FROM users WHERE email = ?", (email.lower(),)
    ).fetchone()
    if existing:
        return None

    uid = f"usr-{secrets.token_hex(8)}"
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, google_id, "
        "auth_provider, created_at) VALUES (?, ?, ?, '', ?, 'google', ?)",
        (uid, name.strip(), email.lower(), google_id, now),
    )
    conn.commit()
    return get_user(uid)


def authenticate_user(email: str, password: str) -> dict | None:
    """Return user dict (no hash) or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, email, password_hash, created_at "
        "FROM users WHERE email = ?",
        (email.lower(),),
    ).fetchone()
    if not row or not _verify_password(password, row["password_hash"]):
        return None
    return _user_dict(row)


def get_user(user_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, email, password_hash, created_at FROM users WHERE id = ?",
        (user_id,),
    ).fetchone()
    if not row:
        return None
    return _user_dict(row)


def get_user_by_email(email: str) -> dict | None:
    """Return the user for a verified email address, or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, email, password_hash, created_at FROM users WHERE email = ?",
        (email.lower(),),
    ).fetchone()
    if not row:
        return None
    return _user_dict(row)


def get_user_by_google_id(google_id: str) -> dict | None:
    """Return the user linked to a Google account ID, or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, email, password_hash, created_at "
        "FROM users WHERE google_id = ?",
        (google_id,),
    ).fetchone()
    if not row:
        return None
    return _user_dict(row)


def link_google_to_user(user_id: str, google_id: str) -> None:
    """Attach a verified Google identity to an existing account as an
    additional sign-in method. A non-empty password hash is preserved, so
    the account's existing password continues to work."""
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET google_id = ?, auth_provider = 'google' WHERE id = ?",
        (google_id, user_id),
    )
    conn.commit()


# ── Firebase (Google) identities ────────────────────────────────────────

def create_firebase_user(firebase_uid: str, name: str, email: str) -> dict | None:
    """Create a Firebase-only account (no password). Returns the user dict or
    None if the email is already taken."""
    conn = _get_conn()
    existing = conn.execute(
        "SELECT id FROM users WHERE email = ?", (email.lower(),)
    ).fetchone()
    if existing:
        return None

    uid = f"usr-{secrets.token_hex(8)}"
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT INTO users (id, name, email, password_hash, firebase_uid, "
        "auth_provider, created_at) VALUES (?, ?, ?, '', ?, 'google', ?)",
        (uid, name.strip(), email.lower(), firebase_uid, now),
    )
    conn.commit()
    return get_user(uid)


def get_user_by_firebase_uid(firebase_uid: str) -> dict | None:
    """Return the user linked to a verified Firebase UID, or None."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, name, email, password_hash, created_at "
        "FROM users WHERE firebase_uid = ?",
        (firebase_uid,),
    ).fetchone()
    if not row:
        return None
    return _user_dict(row)


def link_firebase_to_user(user_id: str, firebase_uid: str) -> None:
    """Attach a verified Firebase identity to an existing account as an
    additional sign-in method. A non-empty password hash is preserved, so
    the account's existing password continues to work."""
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET firebase_uid = ?, auth_provider = 'google' WHERE id = ?",
        (firebase_uid, user_id),
    )
    conn.commit()


def update_user(user_id: str, *, name: str | None = None, email: str | None = None) -> dict | None:
    """Update name/email and return updated user dict, or None on conflict."""
    conn = _get_conn()
    if email is not None:
        dup = conn.execute(
            "SELECT id FROM users WHERE email = ? AND id != ?",
            (email.lower(), user_id),
        ).fetchone()
        if dup:
            return None
    existing = conn.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone()
    if not existing:
        return None
    if name is not None:
        conn.execute("UPDATE users SET name = ? WHERE id = ?", (name.strip(), user_id))
    if email is not None:
        conn.execute("UPDATE users SET email = ? WHERE id = ?", (email.lower(), user_id))
    conn.commit()
    return get_user(user_id)


# ── Sessions ────────────────────────────────────────────────────────────

def create_session(user_id: str) -> str:
    token = secrets.token_hex(32)
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=SESSION_TTL_DAYS)
    conn = _get_conn()
    conn.execute(
        "INSERT INTO sessions (token, user_id, created_at, expires_at) "
        "VALUES (?, ?, ?, ?)",
        (token, user_id, now.isoformat(), expires.isoformat()),
    )
    conn.commit()
    return token


def validate_session(token: str) -> dict | None:
    """Return user dict if the session is valid and not expired, else None."""
    if not token:
        return None
    conn = _get_conn()
    row = conn.execute(
        "SELECT s.user_id, u.name, u.email, u.created_at, u.password_hash "
        "FROM sessions s JOIN users u ON s.user_id = u.id "
        "WHERE s.token = ?",
        (token,),
    ).fetchone()
    if not row:
        return None
    try:
        expires = datetime.fromisoformat(row["created_at"]) + timedelta(days=SESSION_TTL_DAYS)
    except Exception:
        return None
    # Use expires from DB for consistency.
    row2 = conn.execute(
        "SELECT expires_at FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    if row2:
        try:
            exp = datetime.fromisoformat(row2["expires_at"])
            if datetime.now(timezone.utc) > exp:
                delete_session(token)
                return None
        except Exception:
            pass
    return {"id": row["user_id"], "name": row["name"], "email": row["email"],
            "created_at": row["created_at"],
            "has_password": bool(row["password_hash"])}


def delete_session(token: str) -> None:
    conn = _get_conn()
    conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    conn.commit()


def delete_user_sessions(user_id: str) -> None:
    conn = _get_conn()
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.commit()


def change_password(user_id: str, new_password: str) -> None:
    conn = _get_conn()
    conn.execute(
        "UPDATE users SET password_hash = ? WHERE id = ?",
        (_hash_password(new_password), user_id),
    )
    conn.commit()


def cleanup_expired_sessions() -> int:
    conn = _get_conn()
    now = datetime.now(timezone.utc).isoformat()
    cur = conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    conn.commit()
    return cur.rowcount


# ── Cookie helpers ──────────────────────────────────────────────────────

def set_session_cookie(handler, token: str) -> None:
    # SameSite=None requires the Secure flag (browser mandates); cross-origin
    # deployments must run the API over HTTPS anyway.
    secure = "Secure" if os.environ.get("FOCUSLEARN_HTTPS") or _SAMESITE == "None" else ""
    cookie_value = (
        f"{COOKIE_NAME}={token}; Path=/; Max-Age={SESSION_TTL_DAYS * 86400}; "
        f"HttpOnly; SameSite={_SAMESITE}"
    )
    if secure:
        cookie_value += "; Secure"
    handler.send_header("Set-Cookie", cookie_value)


def clear_session_cookie(handler) -> None:
    handler.send_header(
        "Set-Cookie",
        f"{COOKIE_NAME}=; Path=/; Max-Age=0; {_COOKIE_FLAGS}",
    )


def extract_session_token(handler) -> str:
    header = handler.headers.get("Cookie", "")
    for part in header.split(";"):
        kv = part.strip().split("=", 1)
        if len(kv) == 2 and kv[0].strip() == COOKIE_NAME:
            return kv[1].strip()
    return ""


def get_current_user(handler) -> dict | None:
    token = extract_session_token(handler)
    return validate_session(token)
