"""
firebase_auth.py - FocusLearn server-side Firebase ID token verification.

The browser signs in with Firebase Authentication (Google provider) and posts
the resulting Firebase ID token to ``POST /api/auth/firebase``. This module
verifies that token server-side against Google's published public keys before
the backend trusts any of its claims. A client-supplied name/email/uid is
never used on its own.

Verification uses the official ``google.oauth2.id_token.verify_firebase_token``
helper (part of the ``google-auth`` library). It checks the RS256 signature
against Google's rotating public certificates and validates the issuer
(``https://securetoken.google.com/<projectId>``), audience (the project id),
expiry and issued-at time. Only the PUBLIC Firebase project id is required —
there is no service-account key and no Client Secret involved in this flow.

Usage::

    from firebase_auth import verify_firebase_id_token
    info = verify_firebase_id_token(id_token)   # raises FirebaseAuthError

Returns: {"firebase_uid", "email", "name", "picture", "email_verified"}.
"""

from __future__ import annotations

import os
from typing import Any

# Load secrets/config from a local .env (backend/.env or project root .env)
# without overriding a real environment variable. Falls back to plain
# os.environ when python-dotenv is absent.
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

# The Firebase project id is a PUBLIC identifier (it appears in the web
# config). It is the expected token audience/issuer; it is not a secret.
FIREBASE_PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "").strip()

# Optional: default to the project baked into the web config if the operator
# only set it in the root .env.
if not FIREBASE_PROJECT_ID:
    FIREBASE_PROJECT_ID = os.environ.get("VITE_FIREBASE_PROJECT_ID", "").strip()

try:  # google-auth is an official Google library (also a google-genai dep).
    from google.auth.transport import requests as _google_requests
    from google.oauth2 import id_token as _google_id_token

    _GOOGLE_AUTH_AVAILABLE = True
except ImportError:  # pragma: no cover - dependency not installed
    _GOOGLE_AUTH_AVAILABLE = False

_MAX_ID_TOKEN_LENGTH = 8192


class FirebaseAuthError(Exception):
    """Firebase sign-in could not be completed or verified safely."""


class FirebaseAuthDisabled(FirebaseAuthError):
    """The server is not configured to verify Firebase tokens."""


def firebase_configured() -> bool:
    return bool(FIREBASE_PROJECT_ID) and _GOOGLE_AUTH_AVAILABLE


def verify_firebase_id_token(id_token: str) -> dict:
    """Verify a Firebase ID token using Google's official verifier.

    Returns {"firebase_uid", "email", "name", "picture", "email_verified"}
    for a valid token. Raises FirebaseAuthDisabled when the server is not
    configured and FirebaseAuthError for invalid/expired tokens or a
    transient failure. The raw token is never logged.
    """
    if not FIREBASE_PROJECT_ID:
        raise FirebaseAuthDisabled("Firebase sign-in is not configured.")
    if not _GOOGLE_AUTH_AVAILABLE:
        raise FirebaseAuthDisabled(
            "Firebase token verification requires the google-auth package."
        )
    if not id_token or len(id_token) > _MAX_ID_TOKEN_LENGTH:
        raise FirebaseAuthError("Invalid Firebase credential.")

    try:
        claims = _google_id_token.verify_firebase_token(
            id_token,
            _google_requests.Request(),
            audience=FIREBASE_PROJECT_ID,
        )
    except ValueError as exc:
        # Signature/issuer/audience/expiry failure.
        raise FirebaseAuthError("Invalid Firebase credential.") from exc
    except Exception as exc:  # network / Google key endpoint failure
        raise FirebaseAuthError(
            "Firebase's verification service is temporarily unavailable."
        ) from exc

    # verify_firebase_token already validated signature, iss, aud and times.
    # `sub`/`user_id` carry the stable Firebase UID.
    firebase_uid = claims.get("sub") or claims.get("user_id")
    email = claims.get("email")
    if not firebase_uid or not email:
        raise FirebaseAuthError("Invalid Firebase credential.")

    return {
        "firebase_uid": str(firebase_uid),
        "email": str(email).strip().lower(),
        "name": str(claims.get("name") or "").strip(),
        "picture": str(claims.get("picture") or "").strip(),
        "email_verified": bool(claims.get("email_verified", False)),
    }
