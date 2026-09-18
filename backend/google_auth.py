"""
google_auth.py - FocusLearn server-side Google sign-in verification.

The browser obtains a Google ID token (JWT) via Google Identity Services
and posts it to ``POST /api/auth/google``. This module verifies that token
with Google's official ``tokeninfo`` endpoint
(``https://oauth2.googleapis.com/tokeninfo``) server-side and returns the
verified identity claims. Nothing from the browser is trusted without this
verification - a client-supplied name or email is never used on its own.

Only the Google Client ID is required. The chosen flow (GIS ID token) does
not use a Client Secret, so none is read or stored here.

Usage::

    from google_auth import verify_google_id_token
    info = verify_google_id_token(id_token)   # raises GoogleSignInError

Returns: {"google_id", "email", "name"} for verified tokens.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

# Load secrets from a local .env (backend/.env or project root .env) without
# overriding a real environment variable - an exported GOOGLE_CLIENT_ID
# always wins. Falls back to plain os.environ when python-dotenv is absent.
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

# Google OAuth client ID. Public identifier (not a secret) - the Client
# Secret is not required by the Google Identity Services ID-token flow.
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()

_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"
_VALID_ISSUERS = frozenset({"https://accounts.google.com", "accounts.google.com"})
_MAX_ID_TOKEN_LENGTH = 8192


class GoogleSignInError(Exception):
    """Google sign-in could not be completed or verified safely."""


class GoogleSignInDisabled(GoogleSignInError):
    """GOOGLE_CLIENT_ID is not configured on the server."""


def google_configured() -> bool:
    return bool(GOOGLE_CLIENT_ID)


def verify_google_id_token(id_token: str) -> dict:
    """Verify a Google ID token with Google's tokeninfo endpoint.

    Returns {"google_id", "email", "name"} when the token is valid and its
    audience matches this application's Client ID. Raises
    GoogleSignInDisabled when the server is not configured, and
    GoogleSignInError for invalid/expired tokens or a transient Google
    failure. The raw token is never logged.
    """
    if not GOOGLE_CLIENT_ID:
        raise GoogleSignInDisabled("Google sign-in is not configured.")
    if not id_token or len(id_token) > _MAX_ID_TOKEN_LENGTH:
        raise GoogleSignInError("Invalid Google credential.")

    url = f"{_TOKENINFO_URL}?{urllib.parse.urlencode({'id_token': id_token})}"
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            info = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # 400 = malformed/expired/tampered token.
        if exc.code == 400:
            raise GoogleSignInError("Invalid Google credential.") from exc
        raise GoogleSignInError(
            "Google's verification service is temporarily unavailable."
        ) from exc
    except (urllib.error.URLError, TimeoutError, OSError):
        raise GoogleSignInError(
            "Google's verification service is temporarily unavailable."
        )

    # Bind the token to THIS application and reject anything else.
    if info.get("aud") != GOOGLE_CLIENT_ID:
        raise GoogleSignInError("Invalid Google credential.")
    if info.get("iss") not in _VALID_ISSUERS:
        raise GoogleSignInError("Invalid Google credential.")
    if str(info.get("email_verified", "")).lower() not in ("true", "1"):
        raise GoogleSignInError("Invalid Google credential.")

    google_id = info.get("sub")
    email = info.get("email")
    if not google_id or not email:
        raise GoogleSignInError("Invalid Google credential.")

    return {
        "google_id": google_id,
        "email": str(email).strip().lower(),
        "name": str(info.get("name") or "").strip(),
    }