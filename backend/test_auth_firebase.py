"""
FocusLearn authentication tests — Firebase Google sign-in.

These run against a throwaway SQLite database in a temp directory — never the
real backend/data/focuslearn.db. Firebase token verification is mocked so no
network, Firebase project or service-account key is needed.

Run:  python backend/test_auth_firebase.py
"""

from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import unittest

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

import auth  # noqa: E402
import firebase_auth  # noqa: E402
import server  # noqa: E402

TEST_PROJECT_ID = "focuslearn-test"

VALID_CLAIMS = {
    "iss": f"https://securetoken.google.com/{TEST_PROJECT_ID}",
    "aud": TEST_PROJECT_ID,
    "sub": "firebase-uid-abc123",
    "user_id": "firebase-uid-abc123",
    "email": "student@example.com",
    "email_verified": True,
    "name": "Test Student",
    "picture": "https://example.com/p.png",
}


class FakeFirebaseHandler(server.Handler):
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


class FirebaseDBTest(unittest.TestCase):
    """Database layer: migration + Firebase user/linking behaviour."""

    @classmethod
    def setUpClass(cls):
        cls._saved_db = auth.DB_PATH
        cls._saved_conn = auth._conn
        cls.dir = tempfile.mkdtemp(prefix="focuslearn-firebase-db-")
        auth.DB_PATH = os.path.join(cls.dir, "test.db")
        auth._conn = None
        auth.init_db()

    @classmethod
    def tearDownClass(cls):
        if auth._conn is not None:
            auth._conn.close()
        auth._conn = cls._saved_conn
        auth.DB_PATH = cls._saved_db

    def test_legacy_database_gets_firebase_uid(self):
        path = os.path.join(self.dir, "legacy.db")
        conn = sqlite3.connect(path)
        conn.executescript(
            """
            CREATE TABLE users (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                email         TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                google_id     TEXT,
                auth_provider TEXT NOT NULL DEFAULT 'email',
                created_at    TEXT NOT NULL
            );
            CREATE TABLE sessions (
                token      TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );
            INSERT INTO users
                (id, name, email, password_hash, google_id, auth_provider, created_at)
            VALUES
                ('usr-old', 'Old User', 'old@example.com', 'x', NULL, 'email',
                 '2024-01-01T00:00:00+00:00');
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
            self.assertIn("firebase_uid", cols)
            old = auth.get_user_by_email("old@example.com")
            self.assertIsNotNone(old)
            self.assertEqual(old["id"], "usr-old")
        finally:
            auth._conn.close()
            auth._conn = saved_conn
            auth.DB_PATH = saved_db

    def test_firebase_user_creation_and_password_is_locked(self):
        user = auth.create_firebase_user("uid-new", "New Student", "fbnew@example.com")
        self.assertIsNotNone(user)
        self.assertFalse(user["has_password"])
        self.assertEqual(auth.get_user_by_firebase_uid("uid-new")["id"], user["id"])
        # Password login must never work for a Firebase-only account.
        self.assertIsNone(auth.authenticate_user("fbnew@example.com", "anything"))

    def test_firebase_email_link_preserves_password(self):
        account = auth.create_user("Pat Patel", "patfb@example.com", "patpass1")
        auth.link_firebase_to_user(account["id"], "uid-pat")
        linked = auth.get_user_by_firebase_uid("uid-pat")
        self.assertEqual(linked["id"], account["id"])
        self.assertIsNotNone(auth.authenticate_user("patfb@example.com", "patpass1"))

    def test_duplicate_email_is_rejected(self):
        auth.create_user("Dup User", "dupfb@example.com", "secret123")
        self.assertIsNone(
            auth.create_firebase_user("uid-dup", "Other", "dupfb@example.com")
        )


class FirebaseVerifyTest(unittest.TestCase):
    """firebase_auth.verify_firebase_id_token with a mocked verifier."""

    @classmethod
    def setUpClass(cls):
        cls._saved_project = firebase_auth.FIREBASE_PROJECT_ID

    @classmethod
    def tearDownClass(cls):
        firebase_auth.FIREBASE_PROJECT_ID = cls._saved_project

    def setUp(self):
        firebase_auth.FIREBASE_PROJECT_ID = TEST_PROJECT_ID
        if not firebase_auth._GOOGLE_AUTH_AVAILABLE:
            self.skipTest("google-auth is not installed")
        self._orig = firebase_auth._google_id_token.verify_firebase_token

    def tearDown(self):
        firebase_auth._google_id_token.verify_firebase_token = self._orig

    def _patch(self, fn):
        firebase_auth._google_id_token.verify_firebase_token = fn

    def test_valid_token_returns_verified_identity(self):
        self._patch(lambda *a, **k: dict(VALID_CLAIMS))
        info = firebase_auth.verify_firebase_id_token("valid-token")
        self.assertEqual(info["firebase_uid"], "firebase-uid-abc123")
        self.assertEqual(info["email"], "student@example.com")
        self.assertEqual(info["name"], "Test Student")
        self.assertTrue(info["email_verified"])

    def test_invalid_token_raises(self):
        def boom(*_a, **_k):
            raise ValueError("bad token")

        self._patch(boom)
        with self.assertRaises(firebase_auth.FirebaseAuthError):
            firebase_auth.verify_firebase_id_token("bad-token")

    def test_transient_failure_raises(self):
        def boom(*_a, **_k):
            raise ConnectionError("network down")

        self._patch(boom)
        with self.assertRaises(firebase_auth.FirebaseAuthError):
            firebase_auth.verify_firebase_id_token("some-token")

    def test_audience_is_the_configured_project(self):
        seen = {}

        def capture(_token, _request, audience=None, **_k):
            seen["audience"] = audience
            return dict(VALID_CLAIMS)

        self._patch(capture)
        firebase_auth.verify_firebase_id_token("valid-token")
        self.assertEqual(seen["audience"], TEST_PROJECT_ID)

    def test_missing_email_raises(self):
        claims = dict(VALID_CLAIMS)
        claims.pop("email")
        self._patch(lambda *a, **k: claims)
        with self.assertRaises(firebase_auth.FirebaseAuthError):
            firebase_auth.verify_firebase_id_token("no-email-token")

    def test_not_configured(self):
        firebase_auth.FIREBASE_PROJECT_ID = ""
        with self.assertRaises(firebase_auth.FirebaseAuthDisabled):
            firebase_auth.verify_firebase_id_token("x")


class FirebaseEndpointTest(unittest.TestCase):
    """server._handle_auth_firebase end-to-end against the test DB."""

    @classmethod
    def setUpClass(cls):
        cls._saved_db = auth.DB_PATH
        cls._saved_conn = auth._conn
        cls.dir = tempfile.mkdtemp(prefix="focuslearn-firebase-endpoint-")
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
        self._saved_project = firebase_auth.FIREBASE_PROJECT_ID
        firebase_auth.FIREBASE_PROJECT_ID = TEST_PROJECT_ID

    def tearDown(self):
        firebase_auth.FIREBASE_PROJECT_ID = self._saved_project

    def _last(self, handler):
        status, data, token, _ = handler.responses[-1]
        return status, data, token

    def test_missing_token(self):
        handler = FakeFirebaseHandler()
        handler.set_payload({})
        handler._handle_auth_firebase()
        status, _data, _ = self._last(handler)
        self.assertEqual(status, 400)

    def test_not_configured(self):
        firebase_auth.FIREBASE_PROJECT_ID = ""
        handler = FakeFirebaseHandler()
        handler.set_payload({"idToken": "any"})
        handler._handle_auth_firebase()
        status, _data, _ = self._last(handler)
        self.assertEqual(status, 503)

    def test_invalid_token(self):
        def boom(*_a, **_k):
            raise firebase_auth.FirebaseAuthError("bad")

        saved = firebase_auth.verify_firebase_id_token
        firebase_auth.verify_firebase_id_token = boom
        try:
            handler = FakeFirebaseHandler()
            handler.set_payload({"idToken": "bad-token"})
            handler._handle_auth_firebase()
        finally:
            firebase_auth.verify_firebase_id_token = saved
        status, _data, _ = self._last(handler)
        self.assertEqual(status, 401)

    def test_new_firebase_user_creates_account_and_session(self):
        info = {
            "firebase_uid": "uid-fresh",
            "email": "freshfb@example.com",
            "name": "Fresh Student",
            "picture": "",
            "email_verified": True,
        }
        saved = firebase_auth.verify_firebase_id_token
        firebase_auth.verify_firebase_id_token = lambda *_a, **_k: info
        try:
            handler = FakeFirebaseHandler()
            handler.set_payload({"idToken": "fresh-token"})
            handler._handle_auth_firebase()
        finally:
            firebase_auth.verify_firebase_id_token = saved

        status, data, token = self._last(handler)
        self.assertEqual(status, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["user"]["email"], "freshfb@example.com")
        self.assertFalse(data["user"]["has_password"])
        self.assertTrue(token)
        current = auth.validate_session(token)
        self.assertEqual(current["email"], "freshfb@example.com")

    def test_existing_firebase_user_logs_in_again(self):
        info = {
            "firebase_uid": "uid-again",
            "email": "againfb@example.com",
            "name": "Again Student",
            "picture": "",
            "email_verified": True,
        }
        saved = firebase_auth.verify_firebase_id_token
        firebase_auth.verify_firebase_id_token = lambda *_a, **_k: info
        first = None
        try:
            for _ in range(2):
                handler = FakeFirebaseHandler()
                handler.set_payload({"idToken": "again-token"})
                handler._handle_auth_firebase()
                status, data, _ = self._last(handler)
                self.assertEqual(status, 200)
                first = first or data["user"]["id"]
                self.assertEqual(data["user"]["id"], first)
        finally:
            firebase_auth.verify_firebase_id_token = saved

    def test_email_matching_password_account_links(self):
        existing = auth.create_user("Exist User", "existsfb@example.com", "existpw1")
        info = {
            "firebase_uid": "uid-exists",
            "email": "existsfb@example.com",
            "name": "Exist User",
            "picture": "",
            "email_verified": True,
        }
        saved = firebase_auth.verify_firebase_id_token
        firebase_auth.verify_firebase_id_token = lambda *_a, **_k: info
        try:
            handler = FakeFirebaseHandler()
            handler.set_payload({"idToken": "link-token"})
            handler._handle_auth_firebase()
        finally:
            firebase_auth.verify_firebase_id_token = saved

        status, data, _ = self._last(handler)
        self.assertEqual(status, 200)
        self.assertEqual(data["user"]["id"], existing["id"])
        by_uid = auth.get_user_by_firebase_uid("uid-exists")
        self.assertEqual(by_uid["id"], existing["id"])
        self.assertIsNotNone(
            auth.authenticate_user("existsfb@example.com", "existpw1"),
            "linked account must still accept its original password",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
