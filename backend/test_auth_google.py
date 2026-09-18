"""
FocusLearn authentication tests (email/password + Google sign-in).

These run against a throwaway SQLite database in a temp directory — never the
real backend/data/focuslearn.db. The Google tokeninfo request is mocked so no
network or live credentials are needed.

Run:  python backend/test_auth_google.py
"""

from __future__ import annotations

import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import urllib.error

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

import auth  # noqa: E402
import google_auth  # noqa: E402
import server  # noqa: E402

TEST_CLIENT_ID = "test-client.apps.googleusercontent.com"

VALID_TOKENINFO = {
    "iss": "https://accounts.google.com",
    "sub": "112233445566778899000",
    "email": "student@example.com",
    "email_verified": "true",
    "name": "Test Student",
    "aud": TEST_CLIENT_ID,
}


class FakeTokenInfo:
    """Stands in for urllib.urlopen calling Google's /tokeninfo endpoint."""

    def __init__(self, payload, status=200):
        self.payload = payload
        self.status = status

    def __call__(self, url, timeout=10):
        if self.status != 200:
            raise urllib.error.HTTPError(url, self.status, "err", {}, io.BytesIO(b"bad"))
        class _Resp:
            def __init__(self, body):
                self._body = body

            def __enter__(self):
                return self

            def __exit__(self, *_a):
                return False

            def read(self):
                return self._body

        return _Resp(json.dumps(self.payload).encode("utf-8"))


class FakeGoogleHandler(server.Handler):
    """A server.Handler that never touches the network/socket layer."""

    def __init__(self):
        self.responses = []
        self._payload = {}

    def set_payload(self, payload):
        self._payload = payload

    def _read_json_body(self):
        return self._payload if isinstance(self._payload, dict) else {}

    def _json_response(self, status, data, set_cookie=None, clear_cookie=False):
        self.responses.append((status, data, set_cookie, clear_cookie))

    def log_message(self, *_a, **_k):
        pass


class AuthDBTest(unittest.TestCase):
    """Database layer: legacy migration + user/session behaviour."""

    @classmethod
    def setUpClass(cls):
        cls._saved_db = auth.DB_PATH
        cls._saved_conn = auth._conn
        cls.dir = tempfile.mkdtemp(prefix="focuslearn-auth-test-")
        auth.DB_PATH = os.path.join(cls.dir, "test.db")
        auth._conn = None
        auth.init_db()

    @classmethod
    def tearDownClass(cls):
        if auth._conn is not None:
            auth._conn.close()
        auth._conn = cls._saved_conn
        auth.DB_PATH = cls._saved_db

    def test_legacy_database_migration(self):  # TEST of pre-Google DBs
        path = os.path.join(self.dir, "legacy.db")
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE users (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                email         TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                created_at    TEXT NOT NULL
            );
            CREATE TABLE sessions (
                token      TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            INSERT INTO users VALUES
                ('usr-old', 'Old User', 'old@example.com', 'x', '2024-01-01T00:00:00+00:00');
            """
        )
        conn.commit()
        conn.close()

        saved_db, saved_conn = auth.DB_PATH, auth._conn
        auth.DB_PATH = path
        auth._conn = None
        try:
            auth.init_db()
            cols = {r[1] for r in auth._get_conn().execute("PRAGMA table_info(users)")}
            self.assertIn("google_id", cols)
            self.assertIn("auth_provider", cols)
            # Old row survives and belongs to the email provider.
            old = auth.get_user_by_email("old@example.com")
            self.assertIsNotNone(old)
            self.assertEqual(old["id"], "usr-old")
            self.assertTrue(old["has_password"])
            row = auth._get_conn().execute(
                "SELECT auth_provider FROM users WHERE id='usr-old'"
            ).fetchone()
            self.assertEqual(row["auth_provider"], "email")
        finally:
            auth._conn.close()
            auth._conn = saved_conn
            auth.DB_PATH = saved_db

    def test_email_signup_then_login(self):  # TEST 1 & 2 baseline
        user = auth.create_user("Asha Verma", "asha@example.com", "secret123")
        self.assertIsNotNone(user)
        self.assertTrue(user["has_password"])
        authed = auth.authenticate_user("ASHA@example.com", "secret123")
        self.assertIsNotNone(authed)
        self.assertEqual(authed["id"], user["id"])
        self.assertIsNone(auth.authenticate_user("asha@example.com", "wrongpass"))
        # Duplicate email is rejected.
        dup = auth.create_user("Other", "asha@example.com", "secret123")
        self.assertIsNone(dup)

    def test_session_lifecycle(self):
        user = auth.create_user("Ses User", "ses@example.com", "secret123")
        token = auth.create_session(user["id"])
        current = auth.validate_session(token)
        self.assertEqual(current["id"], user["id"])
        auth.delete_session(token)
        self.assertIsNone(auth.validate_session(token))

    def test_google_user_creation_and_password_is_locked(self):
        user = auth.create_google_user("gid-999", "Google Student", "google99@example.com")
        self.assertIsNotNone(user)
        self.assertFalse(user["has_password"])
        self.assertEqual(
            auth.get_user_by_google_id("gid-999")["id"], user["id"]
        )
        # Password login must never work for a Google-only account.
        self.assertIsNone(auth.authenticate_user("google99@example.com", "anything"))

    def test_google_email_link_preserves_password(self):  # TEST 6 safe linking
        email_account = auth.create_user("Pat Patel", "pat@example.com", "patpass1")
        # A verified Google identity with the SAME email links to the account.
        auth.link_google_to_user(email_account["id"], "gid-pat")
        linked = auth.get_user_by_google_id("gid-pat")
        self.assertEqual(linked["id"], email_account["id"])
        # Password sign-in still works after linking (nothing overwritten).
        self.assertIsNotNone(auth.authenticate_user("pat@example.com", "patpass1"))


class GoogleAuthVerifyTest(unittest.TestCase):
    """google_auth.verify_google_id_token against a mocked tokeninfo."""

    @classmethod
    def setUpClass(cls):
        cls._saved_client = google_auth.GOOGLE_CLIENT_ID
        google_auth.GOOGLE_CLIENT_ID = TEST_CLIENT_ID

    @classmethod
    def tearDownClass(cls):
        google_auth.GOOGLE_CLIENT_ID = cls._saved_client

    def setUp(self):
        self._orig_urlopen = google_auth.urllib.request.urlopen

    def tearDown(self):
        google_auth.urllib.request.urlopen = self._orig_urlopen

    def test_valid_token(self):  # TEST 3 / 5 verified identity
        google_auth.urllib.request.urlopen = FakeTokenInfo(dict(VALID_TOKENINFO))
        info = google_auth.verify_google_id_token("valid-token")
        self.assertEqual(info["google_id"], "112233445566778899000")
        self.assertEqual(info["email"], "student@example.com")
        self.assertEqual(info["name"], "Test Student")

    def test_rejects_wrong_audience(self):  # token minted for another app
        payload = dict(VALID_TOKENINFO)
        payload["aud"] = "other-app.apps.googleusercontent.com"
        google_auth.urllib.request.urlopen = FakeTokenInfo(payload)
        with self.assertRaises(google_auth.GoogleSignInError):
            google_auth.verify_google_id_token("wrong-aud-token")

    def test_rejects_unverified_email(self):
        payload = dict(VALID_TOKENINFO)
        payload["email_verified"] = "false"
        google_auth.urllib.request.urlopen = FakeTokenInfo(payload)
        with self.assertRaises(google_auth.GoogleSignInError):
            google_auth.verify_google_id_token("unverified-token")

    def test_rejects_invalid_token(self):  # TEST 8 invalid Google credential
        google_auth.urllib.request.urlopen = FakeTokenInfo({}, status=400)
        with self.assertRaises(google_auth.GoogleSignInError):
            google_auth.verify_google_id_token("expired-token")

    def test_not_configured(self):
        google_auth.GOOGLE_CLIENT_ID = ""
        with self.assertRaises(google_auth.GoogleSignInDisabled):
            google_auth.verify_google_id_token("x")
        google_auth.GOOGLE_CLIENT_ID = TEST_CLIENT_ID


class GoogleEndpointTest(unittest.TestCase):
    """server._handle_auth_google end-to-end against the test DB."""

    @classmethod
    def setUpClass(cls):
        cls._saved_db = auth.DB_PATH
        cls._saved_conn = auth._conn
        cls.dir = tempfile.mkdtemp(prefix="focuslearn-endpoint-test-")
        auth.DB_PATH = os.path.join(cls.dir, "endpoint.db")
        auth._conn = None
        auth.init_db()

    @classmethod
    def tearDownClass(cls):
        if auth._conn is not None:
            auth._conn.close()
        auth._conn = cls._saved_conn
        auth.DB_PATH = cls._saved_db

    def setUp(self):
        self._orig_urlopen = google_auth.urllib.request.urlopen
        self._saved_client = google_auth.GOOGLE_CLIENT_ID
        google_auth.GOOGLE_CLIENT_ID = TEST_CLIENT_ID

    def tearDown(self):
        google_auth.urllib.request.urlopen = self._orig_urlopen
        google_auth.GOOGLE_CLIENT_ID = self._saved_client

    def _last(self, handler):
        status, data, token, _ = handler.responses[-1]
        return status, data, token

    def test_missing_credential(self):
        handler = FakeGoogleHandler()
        handler.set_payload({})
        handler._handle_auth_google()
        status, data, _ = self._last(handler)
        self.assertEqual(status, 400)

    def test_not_configured(self):
        google_auth.GOOGLE_CLIENT_ID = ""
        handler = FakeGoogleHandler()
        handler.set_payload({"credential": "any"})
        handler._handle_auth_google()
        status, data, _ = self._last(handler)
        self.assertEqual(status, 503)

    def test_invalid_credential(self):  # TEST 8
        google_auth.urllib.request.urlopen = FakeTokenInfo({}, status=400)
        handler = FakeGoogleHandler()
        handler.set_payload({"credential": "bad-token"})
        handler._handle_auth_google()
        status, data, _ = self._last(handler)
        self.assertEqual(status, 401)

    def test_new_google_user_creates_account_and_session(self):  # TEST 5 / 3
        info = dict(VALID_TOKENINFO)
        info["email"] = "fresh@example.com"
        info["sub"] = "gid-fresh"
        google_auth.urllib.request.urlopen = FakeTokenInfo(info)

        handler = FakeGoogleHandler()
        handler.set_payload({"credential": "fresh-token"})
        handler._handle_auth_google()
        status, data, token = self._last(handler)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["user"]["email"], "fresh@example.com")
        self.assertFalse(data["user"]["has_password"])
        # A FocusLearn session cookie is minted that validates.
        self.assertTrue(token)
        current = auth.validate_session(token)
        self.assertEqual(current["email"], "fresh@example.com")

    def test_existing_google_user_logs_in_again(self):  # TEST 4
        first = None
        for _ in range(2):
            info = dict(VALID_TOKENINFO)
            info["email"] = "again@example.com"
            info["sub"] = "gid-again"
            google_auth.urllib.request.urlopen = FakeTokenInfo(info)
            handler = FakeGoogleHandler()
            handler.set_payload({"credential": "again-token"})
            handler._handle_auth_google()
            status, data, _ = self._last(handler)
            self.assertEqual(status, 200)
            first = first or data["user"]["id"]
            self.assertEqual(data["user"]["id"], first)  # same account, no duplicate

    def test_google_email_matching_existing_password_account_links(self):  # TEST 6
        existing = auth.create_user("Exist User", "exists@example.com", "existpw1")
        info = dict(VALID_TOKENINFO)
        info["email"] = "exists@example.com"
        info["sub"] = "gid-exists"
        google_auth.urllib.request.urlopen = FakeTokenInfo(info)

        handler = FakeGoogleHandler()
        handler.set_payload({"credential": "link-token"})
        handler._handle_auth_google()
        status, data, _ = self._last(handler)
        self.assertEqual(status, 200)
        # Same account, NOT a duplicate — google id attached, password intact.
        self.assertEqual(data["user"]["id"], existing["id"])
        by_gid = auth.get_user_by_google_id("gid-exists")
        self.assertEqual(by_gid["id"], existing["id"])
        self.assertIsNotNone(
            auth.authenticate_user("exists@example.com", "existpw1"),
            "linked account must still accept its original password",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)