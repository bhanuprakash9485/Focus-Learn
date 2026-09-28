"""
FocusLearn Python backend server.

Serves the YouTube search endpoint backed by yt-dlp and, when the
frontend has been built, also serves the FocusLearn web app itself
(SPA fallback to index.html).

    GET  /api/youtube/search?q=<topic>
    POST /api/ai/learning-guide
    POST /api/ai/ask

Install::

    pip install -r backend/requirements.txt

Run::

    python backend/server.py

Then visit http://localhost:8787 (built frontend) or, in development,
run the Vite dev server which proxies ``/api`` to this port (8787).

Environment variables:
    PORT                 — port to bind (default 8787); FOCUSLEARN_PORT is
                           kept as a backward-compatible alias
    FOCUSLEARN_HOST      — host to bind (default 0.0.0.0)
    FOCUSLEARN_DIST      — path to the built frontend (default ../dist)
    CORS_ALLOWED_ORIGINS — comma-separated list of allowed browser origins
                           for credentialed /api calls. Set this to your
                           deployed frontend URL(s) in production. When
                           unset, the request Origin is reflected (the
                           local-development behaviour).
    FOCUSLEARN_HTTPS     — set to any value (e.g. 1) when serving over
                           HTTPS so session cookies get the Secure flag
    GROQ_API_KEY         — Groq API key (backend only), read from
                           backend/.env so it never reaches the browser
    GROQ_MODEL           — Groq model name (default openai/gpt-oss-120b)

Public routes (served on ``PORT``):
    GET  /api/health               — lightweight health check
    GET  /api/youtube/search
    POST /api/ai/learning-guide
    POST /api/ai/ask
"""

from __future__ import annotations

import json
import mimetypes
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import auth
import firebase_auth
import goals
import google_auth
import roadmap_catalog
import safesearch
import youtube_api
import youtube_playlists
import relevance
import websearch
import quiz_service
from youtube_service import search_youtube_videos, ytdlp_available
from groq_service import (
    answer_topic_question,
    analyze_performance,
    recommend_next_topic,
    create_roadmap,
    generate_topic_quiz,
    build_study_plan,
    groq_available,
    generate_learning_guide,
    GroqConfigurationError,
    QuizRateLimitError,
    RATE_LIMIT_MESSAGE,
    STUDY_PLAN_RATE_LIMIT_MESSAGE,
)

# Bind 0.0.0.0 so the API is reachable from the deployed frontend, the
# host machine, and (when desired) other pods/VMs on the network.
HOST = os.environ.get("FOCUSLEARN_HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", os.environ.get("FOCUSLEARN_PORT", "8787")))
DIST_DIR = os.environ.get(
    "FOCUSLEARN_DIST",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist"),
)

# Comma-separated allow-list of browser origins permitted to make
# credentialed /api calls. Empty by default = reflect the request Origin
# (local development). In production set this to your frontend URL(s).
ALLOWED_ORIGINS = {
    o.strip()
    for o in os.environ.get("CORS_ALLOWED_ORIGINS", "").split(",")
    if o.strip()
}


class Handler(BaseHTTPRequestHandler):
    server_version = "FocusLearnAPI/0.1"
    sys_version = ""

    # ── Response helpers ────────────────────────────────────────────

    def _cors_origin(self) -> str:
        """Allowed credential-bearing Origin for this request.

        When ``CORS_ALLOWED_ORIGINS`` is configured, only origins on that
        allow-list are echoed back (production). When it is not set, the
        request Origin is reflected so local development keeps working.
        """
        origin = self.headers.get("Origin", "")
        if not origin:
            return "*" if not ALLOWED_ORIGINS else ""
        if not origin.startswith("http"):
            return "" if ALLOWED_ORIGINS else "*"
        if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
            return ""
        return origin

    def _json_response(self, status: int, data: dict, set_cookie=None, clear_cookie=False) -> None:
        body = json.dumps(data).encode("utf-8")
        self._drain_request_body()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Credentials", "true")
        if set_cookie:
            auth.set_session_cookie(self, set_cookie)
        if clear_cookie:
            auth.clear_session_cookie(self)
        self.end_headers()
        self._write_body(body)

    def _write_body(self, body: bytes) -> None:
        """Send the response body, tolerating a client that already hung up.

        A browser closing a tab or a client aborting mid-request is ordinary
        traffic, not a server fault: without this the thread prints a
        connection traceback for a response nobody is waiting for.
        """
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError, OSError):
            self.close_connection = True

    def _json_response_no_cookie(self, status: int, data: dict) -> None:
        """JSON response that never sets/clears cookies."""
        body = json.dumps(data).encode("utf-8")
        self._drain_request_body()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()
        self._write_body(body)

    def _serve_static_file(self, fullpath: str) -> None:
        try:
            with open(fullpath, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(fullpath)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.end_headers()
        self.wfile.write(body)

    # ── HTTP verbs ──────────────────────────────────────────────────

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", self._cors_origin())
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.end_headers()

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/api/auth/signup":
            return self._handle_auth_signup()
        if path == "/api/auth/login":
            return self._handle_auth_login()
        if path == "/api/auth/google":
            return self._handle_auth_google()
        if path == "/api/auth/firebase":
            return self._handle_auth_firebase()
        if path == "/api/auth/logout":
            return self._handle_auth_logout()
        if path == "/api/auth/change-password":
            return self._handle_auth_change_password()

        if path == "/api/ai/learning-guide":
            return self._handle_learning_guide()

        if path == "/api/ai/ask":
            return self._handle_topic_question()

        if path == "/api/ai/analyze-performance":
            return self._handle_analyze_performance()

        if path == "/api/ai/recommend-next-topic":
            return self._handle_recommend_next_topic()

        if path == "/api/ai/create-roadmap":
            return self._handle_create_roadmap()

        if path == "/api/ai/generate-quiz":
            return self._handle_generate_quiz()

        if path == "/api/quiz/prepare":
            return self._handle_quiz_prepare()
        if path.startswith("/api/quiz/goal/"):
            # /api/quiz/goal/<goalId>/prepare
            parts = path.split("/")
            if len(parts) == 6 and parts[3] == "goal" and parts[4]:
                if parts[5] == "prepare":
                    return self._handle_quiz_goal_prepare(parts[4])
                return self._json_response(404, {"error": "Not found"})
            return self._json_response(404, {"error": "Not found"})
        if path.startswith("/api/quiz/"):
            parts = path.split("/")
            # /api/quiz/<id>/answer | /api/quiz/<id>/submit
            if len(parts) == 5 and parts[3]:
                quiz_id = parts[3]
                if parts[4] == "answer":
                    return self._handle_quiz_answer(quiz_id)
                if parts[4] == "submit":
                    return self._handle_quiz_submit(quiz_id)
            return self._json_response(404, {"error": "Not found"})

        if path == "/api/roadmaps/refresh":
            return self._handle_roadmaps_refresh()

        if path == "/api/study-plan/plan":
            return self._handle_study_plan()

        if path == "/api/goals":
            return self._handle_goals_create()
        if path.startswith("/api/goals/"):
            goal_id, action = self._goal_path_parts(path)
            if not goal_id:
                return self._json_response(404, {"ok": False, "error": "Not found"})
            return self._handle_goals_action(goal_id, action)

        if path.startswith("/api/"):
            return self._json_response(404, {"error": "Not found"})

        self.send_error(404)

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path == "/api/auth/profile":
            return self._handle_auth_profile()

        if path.startswith("/api/goals/"):
            goal_id, action = self._goal_path_parts(path)
            if not goal_id:
                return self._json_response(404, {"ok": False, "error": "Not found"})
            if action in ("set-primary", "primary"):
                return self._handle_goals_action(goal_id, action)
            return self._handle_goals_update(goal_id)

        if path.startswith("/api/"):
            return self._json_response(404, {"error": "Not found"})

        self.send_error(404)

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        if path.startswith("/api/goals/"):
            goal_id, _ = self._goal_path_parts(path)
            if not goal_id:
                return self._json_response(404, {"ok": False, "error": "Not found"})
            return self._handle_goals_delete(goal_id)

        if path.startswith("/api/"):
            return self._json_response(404, {"error": "Not found"})

        self.send_error(404)

    # ── Authentication ──────────────────────────────────────────────

    def _drain_request_body(self) -> None:
        """Consume any request body that a handler chose not to read.

        A handler that answers early (401/403/404/422) leaves the client's
        payload in the socket buffer. Writing the response and closing then
        resets the connection, which the client sees as a network error instead
        of the status we just sent. Draining first keeps every early error a
        clean, readable response.

        A body that a handler already consumed is never read again - the socket
        has nothing left to give and a second read would block.
        """
        if getattr(self, "_body_consumed", False):
            return
        if self.command not in ("POST", "PUT", "PATCH"):
            return
        try:
            remaining = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return
        if remaining <= 0:
            return
        self._body_consumed = True
        try:
            self.rfile.read(remaining)
        except OSError:
            pass

    def _read_json_body(self) -> dict:
        """Read + decode a JSON body. Returns {} on any problem."""
        self._body_consumed = True
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return {}
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _valid_email(email: str) -> bool:
        import re
        return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))

    def _handle_auth_signup(self) -> None:
        """POST /api/auth/signup — create an account and start a session.

        Body: {name, email, password}
        """
        payload = self._read_json_body()
        name = str(payload.get("name") or "").strip()
        email = str(payload.get("email") or "").strip()
        password = str(payload.get("password") or "")

        if not name:
            return self._json_response(400, {"ok": False, "error": "Please enter your name."})
        if not self._valid_email(email):
            return self._json_response(400, {"ok": False, "error": "Please enter a valid email."})
        if len(password) < 6:
            return self._json_response(
                400, {"ok": False, "error": "Password must be at least 6 characters."}
            )

        user = auth.create_user(name, email, password)
        if user is None:
            return self._json_response(
                409, {"ok": False, "error": "An account with this email already exists."}
            )

        token = auth.create_session(user["id"])
        self.log_message("  [auth] signup ok: %s (%s)", user["email"], user["id"])
        return self._json_response(201, {"ok": True, "user": user}, set_cookie=token)

    def _handle_auth_login(self) -> None:
        """POST /api/auth/login — authenticate and start a session.

        Body: {email, password}
        """
        payload = self._read_json_body()
        email = str(payload.get("email") or "").strip()
        password = str(payload.get("password") or "")

        if not email or not password:
            return self._json_response(400, {"ok": False, "error": "Email and password are required."})

        user = auth.authenticate_user(email, password)
        if user is None:
            # Same message for unknown email / wrong password.
            return self._json_response(401, {"ok": False, "error": "Incorrect email or password."})

        token = auth.create_session(user["id"])
        self.log_message("  [auth] login ok: %s (%s)", user["email"], user["id"])
        return self._json_response(200, {"ok": True, "user": user}, set_cookie=token)

    def _handle_auth_google(self) -> None:
        """POST /api/auth/google — verify a Google ID token, then log in or
        create/link the FocusLearn account and start the same session.

        Body: {credential}  — the ID token from Google Identity Services.

        The token is verified server-side against Google's tokeninfo
        endpoint; the name/email sent from the browser are never trusted
        directly. Google-only accounts get an empty password hash (password
        login is rejected for them); an account whose email already exists
        is safely LINKED — the Google identity is attached as an extra sign-in
        method while the existing password and data are left untouched.
        """
        if not google_auth.google_configured():
            return self._json_response(
                503, {"ok": False, "error": "Google sign-in is not configured yet."}
            )

        payload = self._read_json_body()
        credential = str(payload.get("credential") or "")
        if not credential:
            return self._json_response(
                400, {"ok": False, "error": "Missing Google credential."}
            )

        try:
            info = google_auth.verify_google_id_token(credential)
        except google_auth.GoogleSignInDisabled:
            return self._json_response(
                503, {"ok": False, "error": "Google sign-in is not configured yet."}
            )
        except google_auth.GoogleSignInError:
            self.log_message("  [auth] google verification rejected")
            return self._json_response(
                401, {"ok": False, "error": "Google could not verify this sign-in."}
            )

        google_id = info["google_id"]
        email = info["email"]
        name = info["name"] or email.split("@")[0]

        user = auth.get_user_by_google_id(google_id)
        if user is None:
            existing = auth.get_user_by_email(email)
            if existing is not None:
                # Safe account linking: the verified Google email matches an
                # existing account. Attach the Google identity as an extra
                # sign-in method — nothing is overwritten, the password and
                # all account data stay intact.
                auth.link_google_to_user(existing["id"], google_id)
                user = auth.get_user(existing["id"])
            else:
                user = auth.create_google_user(google_id, name, email)
                if user is None:
                    # Race: an account with this email appeared mid-request.
                    # Refuse rather than overwrite anything.
                    return self._json_response(
                        409,
                        {
                            "ok": False,
                            "error": (
                                "An account with this email already exists. "
                                "Please log in with email and password instead."
                            ),
                        },
                    )

        token = auth.create_session(user["id"])
        self.log_message("  [auth] google login ok: %s (%s)", user["email"], user["id"])
        return self._json_response(200, {"ok": True, "user": user}, set_cookie=token)

    def _handle_auth_firebase(self) -> None:
        """POST /api/auth/firebase — verify a Firebase ID token, then log in
        or create/link the FocusLearn account and start the same session.

        Body: {idToken}  — the Firebase ID token from the Firebase Web SDK.

        The token is verified server-side with the official Firebase/Google
        verifier (signature, issuer, audience, expiry); the name/email sent
        from the browser are never trusted directly. Firebase-only accounts
        get an empty password hash (password login is rejected for them); an
        account whose email already exists is safely LINKED — the Firebase
        identity is attached as an extra sign-in method while the existing
        password and all account data are left untouched.
        """
        if not firebase_auth.firebase_configured():
            return self._json_response(
                503, {"ok": False, "error": "Firebase sign-in is not configured yet."}
            )

        payload = self._read_json_body()
        id_token = str(payload.get("idToken") or payload.get("id_token") or "")
        if not id_token:
            return self._json_response(
                400, {"ok": False, "error": "Missing Firebase ID token."}
            )

        try:
            info = firebase_auth.verify_firebase_id_token(id_token)
        except firebase_auth.FirebaseAuthDisabled:
            return self._json_response(
                503, {"ok": False, "error": "Firebase sign-in is not configured yet."}
            )
        except firebase_auth.FirebaseAuthError:
            self.log_message("  [auth] firebase verification rejected")
            return self._json_response(
                401, {"ok": False, "error": "Firebase could not verify this sign-in."}
            )

        firebase_uid = info["firebase_uid"]
        email = info["email"]
        name = info["name"] or email.split("@")[0]

        user = auth.get_user_by_firebase_uid(firebase_uid)
        if user is None:
            existing = auth.get_user_by_email(email)
            if existing is not None:
                # Safe account linking: the verified Firebase email matches an
                # existing account. Attach the Firebase identity as an extra
                # sign-in method — nothing is overwritten, the password and
                # all account data stay intact.
                auth.link_firebase_to_user(existing["id"], firebase_uid)
                user = auth.get_user(existing["id"])
            else:
                user = auth.create_firebase_user(firebase_uid, name, email)
                if user is None:
                    # Race: an account with this email appeared mid-request.
                    # Refuse rather than overwrite anything.
                    return self._json_response(
                        409,
                        {
                            "ok": False,
                            "error": (
                                "An account with this email already exists. "
                                "Please log in with email and password instead."
                            ),
                        },
                    )

        token = auth.create_session(user["id"])
        self.log_message("  [auth] firebase login ok: %s (%s)", user["email"], user["id"])
        return self._json_response(200, {"ok": True, "user": user}, set_cookie=token)

    def _handle_auth_logout(self) -> None:
        """POST /api/auth/logout — invalidate the current session."""
        token = auth.extract_session_token(self)
        if token:
            auth.delete_session(token)
        self.log_message("  [auth] logout")
        return self._json_response(200, {"ok": True, "message": "Logged out successfully."}, clear_cookie=True)

    def _handle_auth_profile(self) -> None:
        """PUT /api/auth/profile — update name/email for the current user.

        Body: {name?, email?}
        """
        user = auth.get_current_user(self)
        if user is None:
            return self._json_response(401, {"ok": False, "error": "Not authenticated."})

        payload = self._read_json_body()
        name = str(payload.get("name") or "").strip()
        email = str(payload.get("email") or "").strip()

        if not name and not email:
            return self._json_response(400, {"ok": False, "error": "Nothing to update."})
        if email and not self._valid_email(email):
            return self._json_response(400, {"ok": False, "error": "Please enter a valid email."})

        updated = auth.update_user(
            user["id"],
            name=name or None,
            email=email or None,
        )
        if updated is None:
            return self._json_response(409, {"ok": False, "error": "That email is already in use."})
        self.log_message("  [auth] profile updated: %s", user["email"])
        return self._json_response(200, {"ok": True, "user": updated})

    def _handle_auth_change_password(self) -> None:
        """POST /api/auth/change-password — update the current user's password."""
        user = auth.get_current_user(self)
        if user is None:
            return self._json_response(401, {"ok": False, "error": "Not authenticated."})

        payload = self._read_json_body()
        current = str(payload.get("current_password") or "")
        new_password = str(payload.get("new_password") or "")

        if len(new_password) < 6:
            return self._json_response(400, {"ok": False, "error": "New password must be at least 6 characters."})

        # Re-auth with current password before allowing a change.
        if not auth.authenticate_user(user["email"], current):
            return self._json_response(401, {"ok": False, "error": "Current password is incorrect."})

        # Replace the hash (create via update is not needed — hash is internal).
        auth.change_password(user["id"], new_password)
        auth.delete_user_sessions(user["id"])
        new_token = auth.create_session(user["id"])
        self.log_message("  [auth] password changed: %s", user["email"])
        return self._json_response(200, {"ok": True, "message": "Password updated."}, set_cookie=new_token)

    def _handle_auth_me(self) -> None:
        """GET /api/auth/me — return the authenticated user."""
        user = auth.get_current_user(self)
        if user is None:
            return self._json_response(401, {"ok": False, "error": "Not authenticated."})
        return self._json_response(200, {"ok": True, "user": user})

    def _handle_learning_guide(self) -> None:
        """POST /api/ai/learning-guide — generate an AI Learning Guide.

        Body: {"query", "video_title", "video_description", "student_level"}
        Returns: {"guide": {topic, overview, what_to_learn, ...}}
        """
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return self._json_response(400, {"error": "Invalid JSON body"})

        if not isinstance(payload, dict):
            return self._json_response(400, {"error": "JSON body must be an object"})

        query = str(payload.get("query") or "").strip()
        if not query:
            return self._json_response(400, {"error": "Missing required field: query"})

        # SafeSearch: never let filtered/unsafe content reach the AI.
        video_title = str(payload.get("video_title") or "")
        video_description = str(payload.get("video_description") or "")
        guard_reason = safesearch.unsafe_reason(query, video_title, video_description)
        if guard_reason:
            self.log_message("SafeSearch blocked AI context for %r (%s)", query, guard_reason)
            return self._json_response(
                422,
                {
                    "error": "This content isn't available on FocusLearn.",
                    "guide": None,
                },
            )

        if not groq_available():
            return self._json_response(
                503,
                {
                    "error": (
                        "groq is not installed. "
                        "Run: pip install -r backend/requirements.txt"
                    ),
                },
            )

        try:
            guide = generate_learning_guide(
                query=query[:200],
                video_title=video_title[:300],
                video_description=video_description[:3000],
                student_level=str(payload.get("student_level") or "beginner")[:20],
            )
        except GroqConfigurationError as exc:
            return self._json_response(503, {"error": str(exc)})
        except Exception as exc:
            self.log_message("Learning guide generation failed for %r", query)
            return self._json_response(502, {"error": str(exc)})

        return self._json_response(200, {"guide": guide})

    def _handle_topic_question(self) -> None:
        """POST /api/ai/ask — answer a question strictly about the current topic.

        Body: {"query", "question", "video_title", "video_description",
               "student_level", "history": [{"role", "content"}, ...]}
        Returns: {"answer": "..."} — off-topic questions are politely declined.
        """
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return self._json_response(400, {"error": "Invalid JSON body"})

        if not isinstance(payload, dict):
            return self._json_response(400, {"error": "JSON body must be an object"})

        query = str(payload.get("query") or "").strip()
        question = str(payload.get("question") or "").strip()
        if not query:
            return self._json_response(400, {"error": "Missing required field: query"})
        if not question:
            return self._json_response(400, {"error": "Missing required field: question"})

        # SafeSearch: never let filtered/unsafe content reach the AI.
        guard_reason = safesearch.unsafe_reason(
            query,
            question,
            str(payload.get("video_title") or ""),
            str(payload.get("video_description") or ""),
        )
        if guard_reason:
            self.log_message("SafeSearch blocked AI question for %r (%s)", query, guard_reason)
            return self._json_response(
                422,
                {"error": "This content isn't available on FocusLearn."},
            )

        if not groq_available():
            return self._json_response(
                503,
                {
                    "error": (
                        "groq is not installed. "
                        "Run: pip install -r backend/requirements.txt"
                    ),
                },
            )

        try:
            answer = answer_topic_question(
                query=query[:200],
                question=question[:2000],
                video_title=str(payload.get("video_title") or "")[:300],
                video_description=str(payload.get("video_description") or "")[:3000],
                student_level=str(payload.get("student_level") or "beginner")[:20],
                history=payload.get("history")
                if isinstance(payload.get("history"), list)
                else None,
            )
        except GroqConfigurationError as exc:
            return self._json_response(503, {"error": str(exc)})
        except Exception as exc:
            self.log_message("Topic question failed for %r", query)
            return self._json_response(502, {"error": str(exc)})

        return self._json_response(200, {"answer": answer})

    def _handle_analyze_performance(self) -> None:
        """POST /api/ai/analyze-performance — AI analysis of quiz performance.

        Body: {"roadmap_topic", "quiz_score", "total_questions",
               "questions": [{"prompt", "options", "correctIndex", "concept"}],
               "answers": [int], "correct_answers": [int]}
        Returns: {"analysis": {...}}
        """
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return self._json_response(400, {"error": "Invalid JSON body"})

        if not isinstance(payload, dict):
            return self._json_response(400, {"error": "JSON body must be an object"})

        roadmap_topic = str(payload.get("roadmap_topic") or "").strip()
        if not roadmap_topic:
            return self._json_response(400, {"error": "Missing required field: roadmap_topic"})

        quiz_score = int(payload.get("quiz_score") or 0)
        total_questions = int(payload.get("total_questions") or 0)
        questions = payload.get("questions") if isinstance(payload.get("questions"), list) else []
        answers = payload.get("answers") if isinstance(payload.get("answers"), list) else []
        correct_answers = payload.get("correct_answers") if isinstance(payload.get("correct_answers"), list) else []

        # SafeSearch: never let filtered/unsafe content reach the AI.
        guard_reason = safesearch.unsafe_reason(roadmap_topic)
        if guard_reason:
            self.log_message("SafeSearch blocked AI analysis for %r (%s)", roadmap_topic, guard_reason)
            return self._json_response(422, {"error": "This content isn't available on FocusLearn."})

        if not groq_available():
            return self._json_response(503, {"error": "groq is not installed. Run: pip install -r backend/requirements.txt"})

        self.log_message("  Analyzing performance for %r (%d/%d)", roadmap_topic, quiz_score, total_questions)
        try:
            analysis = analyze_performance(
                roadmap_topic=roadmap_topic[:200],
                quiz_score=quiz_score,
                total_questions=max(total_questions, 1),
                questions=questions[:60],
                answers=[int(a) for a in answers[:60]],
                correct_answers=[int(a) for a in correct_answers[:60]],
            )
        except GroqConfigurationError as exc:
            return self._json_response(503, {"error": str(exc)})
        except Exception as exc:
            self.log_message("Performance analysis failed for %r", roadmap_topic)
            return self._json_response(502, {"error": str(exc)})

        self.log_message("  Analysis result: status=%s weak=%s", analysis.get("status"), analysis.get("weak_topics"))
        return self._json_response(200, {"analysis": analysis})

    def _handle_recommend_next_topic(self) -> None:
        """POST /api/ai/recommend-next-topic — AI recommendation for next activity.

        Body: {"roadmap_goal", "roadmap_topics", "completed_topics",
               "quiz_history", "weak_topics", "current_topic"}
        Returns: {"recommendation": {...}}
        """
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return self._json_response(400, {"error": "Invalid JSON body"})

        if not isinstance(payload, dict):
            return self._json_response(400, {"error": "JSON body must be an object"})

        roadmap_goal = str(payload.get("roadmap_goal") or "").strip()
        if not roadmap_goal:
            return self._json_response(400, {"error": "Missing required field: roadmap_goal"})

        current_topic = str(payload.get("current_topic") or "").strip()
        if not current_topic:
            return self._json_response(400, {"error": "Missing required field: current_topic"})

        roadmap_topics = payload.get("roadmap_topics") if isinstance(payload.get("roadmap_topics"), list) else []
        completed_topics = payload.get("completed_topics") if isinstance(payload.get("completed_topics"), list) else []
        quiz_history = payload.get("quiz_history") if isinstance(payload.get("quiz_history"), list) else []
        weak_topics = payload.get("weak_topics") if isinstance(payload.get("weak_topics"), list) else []

        guard_reason = safesearch.unsafe_reason(roadmap_goal, current_topic)
        if guard_reason:
            self.log_message("SafeSearch blocked AI recommendation for %r (%s)", roadmap_goal, guard_reason)
            return self._json_response(422, {"error": "This content isn't available on FocusLearn."})

        if not groq_available():
            return self._json_response(503, {"error": "groq is not installed. Run: pip install -r backend/requirements.txt"})

        self.log_message("  Recommending next topic for %r (current: %s)", roadmap_goal, current_topic)
        try:
            recommendation = recommend_next_topic(
                roadmap_goal=roadmap_goal[:200],
                roadmap_topics=roadmap_topics[:30],
                completed_topics=[str(t) for t in completed_topics[:30]],
                quiz_history=[dict(h) for h in quiz_history[:20]],
                weak_topics=[str(t) for t in weak_topics[:20]],
                current_topic=current_topic[:200],
            )
        except GroqConfigurationError as exc:
            return self._json_response(503, {"error": str(exc)})
        except Exception as exc:
            self.log_message("Recommendation failed for %r", roadmap_goal)
            return self._json_response(502, {"error": str(exc)})

        self.log_message("  Recommendation: action=%s next=%s", recommendation.get("action"), recommendation.get("next_topic"))
        return self._json_response(200, {"recommendation": recommendation})

    def _handle_create_roadmap(self) -> None:
        """POST /api/ai/create-roadmap — generate an AI learning roadmap.

        Body: {"topic", "level?", "study_time?", "goal?"}
        Returns: {"roadmap": {...}} — structured roadmap JSON.
        """
        try:
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._body_consumed = True
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            return self._json_response(400, {"error": "Invalid JSON body"})

        if not isinstance(payload, dict):
            return self._json_response(400, {"error": "JSON body must be an object"})

        topic = str(payload.get("topic") or "").strip()
        if not topic:
            return self._json_response(400, {"error": "Missing required field: topic"})

        level = str(payload.get("level") or "beginner").strip()[:20] or "beginner"
        study_time = str(payload.get("study_time") or "1 hour/day").strip()[:50] or "1 hour/day"
        goal = str(payload.get("goal") or "general learning").strip()[:200] or "general learning"

        # SafeSearch gate
        guard_reason = safesearch.unsafe_reason(topic)
        if guard_reason:
            self.log_message("SafeSearch blocked roadmap creation for %r (%s)", topic, guard_reason)
            return self._json_response(422, {"error": "This content isn't available on FocusLearn."})

        if not groq_available():
            return self._json_response(503, {"error": "groq is not installed. Run: pip install -r backend/requirements.txt"})

        # Step 1: Retrieve internet context about the topic
        self.log_message("  Creating roadmap for %r (level=%s, goal=%s)", topic, level, goal)
        web_context = ""
        try:
            sources = websearch.search_topic_context(topic)
            web_context = websearch.format_context_for_ai(sources)
            self.log_message("  Retrieved %d internet sources (%d chars)", len(sources), len(web_context))
        except Exception as exc:
            self.log_message("  Web search failed (proceeding without): %r", exc)
            web_context = "(No internet information available — rely on your training knowledge.)"

        # Step 2: Generate roadmap via Groq
        try:
            roadmap = create_roadmap(
                topic=topic[:200],
                level=level,
                study_time=study_time,
                goal=goal,
                web_context=web_context[:3000],
            )
        except GroqConfigurationError as exc:
            return self._json_response(503, {"error": str(exc)})
        except Exception as exc:
            self.log_message("Roadmap creation failed for %r", topic)
            return self._json_response(502, {"error": str(exc)})

        phase_count = len(roadmap.get("phases", []))
        topic_count = sum(len(p.get("topics", [])) for p in roadmap.get("phases", []))
        self.log_message("  Roadmap generated: %d phases, %d topics", phase_count, topic_count)
        return self._json_response(200, {"roadmap": roadmap})

    def _handle_generate_quiz(self) -> None:
        """POST /api/ai/generate-quiz — generate a validated topic quiz.

        Body: {"topic", "level?", "count?", "concepts"?}
        Returns: {"quiz": {"topic", "level", "total", "questions": [...]}}
        with at least `count` (default 30) questions ordered basic ->
        intermediate -> advanced. Never returns a short/invalid quiz.
        """
        payload = self._read_json_body()
        if not isinstance(payload, dict):
            payload = {}

        topic = str(payload.get("topic") or "").strip()
        if not topic:
            return self._json_response(400, {"error": "Missing required field: topic"})

        level = str(payload.get("level") or "beginner").strip()[:20] or "beginner"
        try:
            count = int(payload.get("count") or 30)
        except (TypeError, ValueError):
            count = 30
        count = max(6, min(count, 60))

        raw_concepts = payload.get("concepts")
        concepts: list[str] = []
        if isinstance(raw_concepts, list):
            concepts = [str(c).strip()[:80] for c in raw_concepts if str(c).strip()][:12]

        # SafeSearch gate (topic + any retest concepts)
        for text in [topic] + concepts:
            guard_reason = safesearch.unsafe_reason(text)
            if guard_reason:
                self.log_message("SafeSearch blocked quiz generation for %r (%s)", text, guard_reason)
                return self._json_response(422, {"error": "This content isn't available on FocusLearn."})

        if not groq_available():
            return self._json_response(
                503,
                {"error": "AI quiz generation is not configured on the server."},
            )

        self.log_message(
            "  Generating quiz for %r (level=%s, count=%d, focus=%d)",
            topic,
            level,
            count,
            len(concepts),
        )
        try:
            quiz = generate_topic_quiz(
                topic=topic[:200],
                level=level,
                total=count,
                focus_concepts=concepts,
            )
        except GroqConfigurationError:
            return self._json_response(
                503,
                {"error": "AI quiz generation is not configured on the server."},
            )
        except QuizRateLimitError:
            return self._json_response(503, {"error": RATE_LIMIT_MESSAGE})
        except Exception:
            self.log_message("Quiz generation failed for %r", topic)
            return self._json_response(
                502,
                {"error": "Quiz generation is temporarily unavailable. Please try again."},
            )

        by_difficulty: dict[str, int] = {}
        for q in quiz.get("questions", []):
            by_difficulty[q.get("difficulty", "?")] = by_difficulty.get(q.get("difficulty", "?"), 0) + 1
        self.log_message(
            "  Quiz generated: %d questions %s",
            len(quiz.get("questions", [])),
            by_difficulty,
        )
        return self._json_response(200, {"quiz": quiz})

    def _goal_for_quiz(self, goal_id: str, user_id: str) -> dict | None:
        """The goal a goal-quiz is built from.

        A user's own (or custom) goal comes from the database. A goal that only
        exists in the public catalogue is built from the definition the client
        sends, so every selectable goal can have a quiz.
        """
        goal_id = str(goal_id or "").strip()[:80]
        if not goal_id:
            return None
        goal = goals.get_goal(user_id, goal_id)
        if goal:
            return goal
        payload = self._read_json_body() or {}
        title = str(payload.get("title") or "").strip()[:200]
        if not title:
            return None
        return {
            "id": goal_id,
            "title": title,
            "description": str(payload.get("description") or "")[:2000],
            "goalContext": str(payload.get("goalContext") or "")[:2000],
            "existingKnowledge": str(payload.get("existingKnowledge") or "")[:1000],
            "experienceLevel": str(payload.get("experienceLevel") or "beginner")[:20],
            "roadmap": payload.get("roadmap") if isinstance(payload.get("roadmap"), dict) else None,
        }

    def _handle_quiz_goal_prepare(self, goal_id: str) -> None:
        """POST /api/quiz/goal/:goalId/prepare — background 10/10/10 goal quiz.

        Returns immediately. Idempotent: a complete, validated quiz for this goal
        is returned as-is and Groq is never called again for it.
        """
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        goal = self._goal_for_quiz(goal_id, user["id"])
        if not goal:
            return self._json_response(400, {"error": "Missing required field: title"})
        guard_reason = safesearch.unsafe_reason(str(goal.get("title") or ""))
        if guard_reason:
            self.log_message("SafeSearch blocked goal quiz prep for %r (%s)", goal_id, guard_reason)
            return self._json_response(422, {"error": "This content isn't available on FocusLearn."})
        try:
            result = quiz_service.prepare_goal_quiz(user["id"], goal)
        except ValueError as exc:
            return self._json_response(400, {"error": str(exc)})
        self.log_message(
            "  Goal quiz prep for %r (user=%s): %s %s",
            goal.get("title"),
            user["id"],
            result["status"],
            result.get("quiz_id", ""),
        )
        return self._json_response(200, {**result, "goal_id": goal["id"]})

    def _handle_quiz_goal_status(self, goal_id: str) -> None:
        """GET /api/quiz/goal/:goalId — authoritative state of the goal quiz."""
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        return self._json_response(
            200, quiz_service.get_goal_status(user["id"], str(goal_id)[:80])
        )

    def _handle_quiz_goal_statuses(self) -> None:
        """GET /api/quiz/goals — every stored goal quiz in one response."""
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        return self._json_response(200, {"goals": quiz_service.get_goal_statuses(user["id"])})

    def _handle_quiz_prepare(self) -> None:
        """POST /api/quiz/prepare — start background quiz generation.

        Returns immediately. Never blocks the learning page. Idempotent: an
        existing READY quiz is returned as-is (no extra Groq call).
        Body: {topic, level?, goal?, roadmap?, quiz_id? (retest), concepts?}
        """
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        payload = self._read_json_body()
        topic = str(payload.get("topic") or "").strip()
        if not topic:
            return self._json_response(400, {"error": "Missing required field: topic"})
        topics = str(payload.get("topic") or "").strip()[-200:]
        level = str(payload.get("level") or "beginner").strip()[:20] or "beginner"
        goal_id = str(payload.get("goal") or "").strip()[:80] or None
        roadmap_id = str(payload.get("roadmap") or "").strip()[:80] or None

        raw_concepts = payload.get("concepts")
        concepts: list[str] = []
        if isinstance(raw_concepts, list):
            concepts = [str(c).strip()[:80] for c in raw_concepts if str(c).strip()][:12]
        retest_of = str(payload.get("quiz_id") or payload.get("retest_of") or "").strip()[:80] or None

        # SafeSearch gate (topic + any retest concepts)
        for text in [topics] + concepts:
            guard_reason = safesearch.unsafe_reason(text)
            if guard_reason:
                self.log_message("SafeSearch blocked quiz prep for %r (%s)", text, guard_reason)
                return self._json_response(422, {"error": "This content isn't available on FocusLearn."})

        try:
            result = quiz_service.prepare_quiz(
                user_id=user["id"],
                topic=topics,
                level=level,
                goal_id=goal_id,
                roadmap_id=roadmap_id,
                focus_concepts=concepts,
                retest_of=retest_of,
                # This endpoint is always the topic quiz. ``goal`` only tells
                # the generator which goal a topic belongs to; a goal's own
                # 10/10/10 quiz has its own endpoint and scope.
                scope="topic",
            )
        except ValueError as exc:
            return self._json_response(400, {"error": str(exc)})

        self.log_message(
            "  Quiz prep for %r (user=%s): %s %s",
            topics,
            user["id"],
            result["status"],
            result.get("quiz_id", ""),
        )
        return self._json_response(200, result)

    def _handle_quiz_status(self) -> None:
        """GET /api/quiz/status?topic=... — authoritative quiz state."""
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)
        topic = params.get("topic", [""])[0].strip()
        if not topic:
            return self._json_response(400, {"error": "Missing required field: topic"})
        return self._json_response(200, quiz_service.get_status_for_topic(user["id"], topic[:200]))

    def _handle_quiz_get(self, quiz_id: str) -> None:
        """GET /api/quiz/:id — the validated quiz once it is ready."""
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        quiz = quiz_service.get_quiz(user["id"], quiz_id)
        if quiz is None:
            status = quiz_service.get_status(user["id"], quiz_id)
            if status and status["state"] == "generating":
                return self._json_response(409, {"error": "Quiz is still being prepared."})
            if status and status["state"] == "failed":
                # Surface the real failure (e.g. AI rate limited) so the quiz
                # page shows a clear message instead of a bare "not found".
                message = (
                    status.get("error")
                    or "Quiz preparation failed. Please try again shortly."
                )
                return self._json_response(422, {"error": message})
            return self._json_response(404, {"error": "Quiz not found."})
        return self._json_response(200, {"quiz": quiz})

    def _handle_quiz_answer(self, quiz_id: str) -> None:
        """POST /api/quiz/:id/answer — record one submitted answer.

        The backend is the authority for attempt counts and unlock state.
        Correctness is recomputed server-side from the stored correct answer.
        """
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        payload = self._read_json_body()
        try:
            index = int(payload.get("index"))
            selected = int(payload.get("selected_index"))
        except (TypeError, ValueError):
            return self._json_response(400, {"error": "index and selected_index are required."})
        try:
            result = quiz_service.record_answer(
                user["id"], quiz_id, index, selected
            )
        except IndexError:
            return self._json_response(400, {"error": "Question or answer index out of range."})
        except quiz_service.QuizLockedError as exc:
            return self._json_response(403, {"error": str(exc)})
        if result is None:
            status = quiz_service.get_status(user["id"], quiz_id)
            if status and status["state"] == "generating":
                return self._json_response(409, {"error": "Quiz is still being prepared."})
            return self._json_response(404, {"error": "Quiz not found."})
        return self._json_response(200, result)

    def _handle_quiz_submit(self, quiz_id: str) -> None:
        """POST /api/quiz/:id/submit — authoritative scoring of a quiz."""
        user = self._require_user()
        if not user:
            return self._json_response(401, {"error": "Authentication required."})
        result = quiz_service.submit_quiz(user["id"], quiz_id)
        if result is None:
            status = quiz_service.get_status(user["id"], quiz_id)
            if status and status["state"] == "generating":
                return self._json_response(409, {"error": "Quiz is still being prepared."})
            return self._json_response(404, {"error": "Quiz not found."})
        return self._json_response(200, {"submission": result})

    def _handle_roadmaps_catalog(self) -> None:
        """GET /api/roadmaps/catalog — metadata-only roadmap.sh catalog.

        Serves the cached catalog; refreshes in-band only when the cache is
        stale (TTL 24h). When roadmap.sh is unreachable, returns the last
        known catalog with ``stale: true`` and a notice instead of failing.
        """
        return self._json_response(200, roadmap_catalog.get_catalog(force_refresh=False))

    def _handle_roadmaps_refresh(self) -> None:
        """POST /api/roadmaps/refresh — force a fresh catalog sync."""
        return self._json_response(200, roadmap_catalog.get_catalog(force_refresh=True))

    # ── Study plan (authenticated, per-user) ─────────────────────

    def _handle_study_plan(self) -> None:
        """POST /api/study-plan/plan — AI assist for the adaptive Study Plan.

        Body: {"mode": "today" | "week", "goal", "dailyTargetMinutes",
               "candidates": [...], "quizAttempts": [...], "weakTopics": [...],
               "completedLessonIds": [...], "missedCount", "targetDate"}

        The candidate list is built by the client from the student's REAL
        roadmap/quizzes, so the AI can only *order* work that genuinely exists.
        Every returned ref is validated against that list server-side, and the
        response is a PREVIEW: the client decides whether to apply it.

        Returns: {"ok": true, "summary", "tasks": [...], "ai": true}
        """
        user = self._require_user()
        if user is None:
            return

        payload = self._read_json_body()
        if not isinstance(payload, dict):
            payload = {}

        mode = str(payload.get("mode") or "today").strip().lower()
        if mode not in ("today", "week"):
            return self._json_response(400, {"ok": False, "error": "Invalid mode."})

        goal = str(payload.get("goal") or "").strip()[:200]
        guard_reason = safesearch.unsafe_reason(goal) if goal else None
        if guard_reason:
            self.log_message("SafeSearch blocked study planning (%s)", guard_reason)
            return self._json_response(
                422, {"ok": False, "error": "This content isn't available on FocusLearn."}
            )

        # Whitelist the client's candidate fields — no pass-through blobs.
        candidates: list[dict] = []
        for raw in (payload.get("candidates") or [])[:60]:
            if not isinstance(raw, dict):
                continue
            ref = str(raw.get("ref") or "").strip()[:120]
            if not ref:
                continue
            try:
                minutes = int(raw.get("minutes") or 0)
            except (TypeError, ValueError):
                minutes = 0
            candidates.append(
                {
                    "ref": ref,
                    "kind": str(raw.get("kind") or "lesson"),
                    "title": str(raw.get("title") or ref)[:120],
                    "minutes": max(5, min(minutes, 240)),
                    "step": raw.get("step"),
                    "prerequisites": [str(p)[:80] for p in (raw.get("prerequisites") or [])][:6],
                }
            )
        if not candidates:
            return self._json_response(
                400, {"ok": False, "error": "There is nothing left to plan yet."}
            )

        try:
            daily_target = int(payload.get("dailyTargetMinutes") or 30)
        except (TypeError, ValueError):
            daily_target = 30

        context = {
            "mode": mode,
            "goal": goal,
            "today": str(payload.get("today") or "")[:20],
            "daily_target_minutes": max(10, min(daily_target, 240)),
            "target_date": str(payload.get("targetDate") or "")[:20],
            "missed_count": int(payload.get("missedCount") or 0),
            "candidates": candidates,
            "quiz_attempts": [
                {
                    "topic": str(a.get("topic") or "")[:80],
                    "percentage": a.get("percentage") or 0,
                }
                for a in (payload.get("quizAttempts") or [])[:20]
                if isinstance(a, dict)
            ],
            "weak_topics": [str(t)[:80] for t in (payload.get("weakTopics") or [])[:20]],
            "completed_lesson_ids": [
                str(t)[:80] for t in (payload.get("completedLessonIds") or [])[:80]
            ],
        }

        self.log_message(
            "  [study-plan] %s plan for %s (%d candidates)",
            mode,
            user["email"],
            len(candidates),
        )
        try:
            plan = build_study_plan(context)
        except QuizRateLimitError as exc:
            return self._json_response(
                503, {"ok": False, "error": str(exc) or STUDY_PLAN_RATE_LIMIT_MESSAGE}
            )
        except GroqConfigurationError:
            return self._json_response(
                503, {"ok": False, "error": "The study assistant is not configured on the server."}
            )
        except Exception:
            self.log_message("Study plan generation failed")
            return self._json_response(
                502,
                {"ok": False, "error": "The study assistant is unavailable right now."},
            )

        return self._json_response(
            200, {"ok": True, "ai": True, "summary": plan["summary"], "tasks": plan["tasks"]}
        )

    # ── Goals (authenticated, per-user) ───────────────────────────

    # Status transitions exposed as POST /api/goals/<id>/<action>.
    _GOAL_ACTIONS = {
        "pause": "paused",
        "resume": "active",
        "complete": "completed",
        "archive": "archived",
        "restore": "active",
    }

    def _require_user(self) -> dict | None:
        """Return the authenticated user or send 401 and return None."""
        user = auth.get_current_user(self)
        if user is None:
            self._json_response(401, {"ok": False, "error": "Not authenticated."})
            return None
        return user

    @staticmethod
    def _goal_path_parts(path: str) -> tuple[str | None, str | None]:
        """Split ``/api/goals/<id>[/<action>]`` into (id, action)."""
        parts = [p for p in path.split("/") if p]
        if len(parts) < 3 or parts[0] != "api" or parts[1] != "goals":
            return None, None
        goal_id = urllib.parse.unquote(parts[2]) or None
        action = urllib.parse.unquote(parts[3]) if len(parts) > 3 else None
        return goal_id, action

    def _handle_goals_list(self) -> None:
        """GET /api/goals — every goal that belongs to the current user."""
        user = self._require_user()
        if user is None:
            return
        return self._json_response(
            200, {"ok": True, "goals": goals.list_goals(user["id"])}
        )

    def _handle_goals_get(self, goal_id: str) -> None:
        """GET /api/goals/<id> — one goal (ownership enforced)."""
        user = self._require_user()
        if user is None:
            return
        goal = goals.get_goal(user["id"], goal_id)
        if goal is None:
            return self._json_response(404, {"ok": False, "error": "Goal not found."})
        return self._json_response(200, {"ok": True, "goal": goal})

    def _handle_goals_create(self) -> None:
        """POST /api/goals — create a goal (optionally with its AI roadmap)."""
        user = self._require_user()
        if user is None:
            return
        payload = self._read_json_body()
        if not str(payload.get("title") or "").strip():
            return self._json_response(
                400, {"ok": False, "error": "Please give your goal a title."}
            )
        goal = goals.create_goal(user["id"], payload)
        self.log_message("  [goals] created %s for %s", goal["id"], user["email"])
        return self._json_response(201, {"ok": True, "goal": goal})

    def _handle_goals_update(self, goal_id: str) -> None:
        """PUT /api/goals/<id> — edit fields and/or replace the roadmap."""
        user = self._require_user()
        if user is None:
            return
        payload = self._read_json_body()
        goal = goals.update_goal(user["id"], goal_id, payload)
        if goal is None:
            return self._json_response(404, {"ok": False, "error": "Goal not found."})
        return self._json_response(200, {"ok": True, "goal": goal})

    def _handle_goals_delete(self, goal_id: str) -> None:
        """DELETE /api/goals/<id> — permanently delete a goal."""
        user = self._require_user()
        if user is None:
            return
        if not goals.delete_goal(user["id"], goal_id):
            return self._json_response(404, {"ok": False, "error": "Goal not found."})
        self.log_message("  [goals] deleted %s for %s", goal_id, user["email"])
        return self._json_response(200, {"ok": True})

    def _handle_goals_action(self, goal_id: str, action: str | None) -> None:
        """POST /api/goals/<id>/<action> — pause/resume/archive/restore/complete/primary."""
        user = self._require_user()
        if user is None:
            return
        if action in ("set-primary", "primary"):
            goal = goals.set_primary(user["id"], goal_id)
        else:
            status = self._GOAL_ACTIONS.get(str(action))
            if status is None:
                return self._json_response(404, {"ok": False, "error": "Not found"})
            goal = goals.set_status(user["id"], goal_id, status)
        if goal is None:
            return self._json_response(404, {"ok": False, "error": "Goal not found."})
        return self._json_response(200, {"ok": True, "goal": goal})

    # ── YouTube search diagnostics ────────────────────────────────

    def _diagnose_youtube(self, query: str) -> dict:
        """Trace the full playlist-discovery pipeline for one query. Shows:
        the EXACT query sent to YouTube, the raw Data API order (proving no
        custom re-ranking flips it), the light filter result, the chosen
        playlist, and — for diagnostics only — the element scores. The
        scoring functions are displayed but never used to order results."""
        report: dict = {"query": query}
        if not youtube_api.has_api_key():
            report["provider"] = "not configured"
            report["message"] = "YOUTUBE_API_KEY is not set — Data API disabled."
            return report
        report["provider"] = "youtube_data_api"
        query_tokens = relevance.tokenize(query)
        report["query_tokens"] = sorted(query_tokens)

        cached = youtube_playlists.recommended_playlist(query, use_cache=False)
        if cached:
            report["recommended"] = {
                "id": cached.get("id"),
                "title": cached.get("title"),
                "channel": cached.get("channel"),
                "total_videos": cached.get("total_videos"),
                "first_video": cached.get("first_video"),
            }

        candidates = youtube_api.search_playlists(query, max_results=50) or []
        raw = []
        for index, candidate in enumerate(candidates[:10]):
            title = candidate.get("title") or ""
            generic = relevance.is_generic_catchall(safesearch.normalize(title))
            gate = relevance.playlist_relevant(query, title, candidate.get("description") or "")
            raw.append(
                {
                    "position": index,
                    "id": candidate.get("id"),
                    "title": title,
                    "channel": candidate.get("channel"),
                    "relevance_gate": bool(gate),
                    "generic_catchall": bool(generic),
                    "score": relevance.score_playlist(
                        query,
                        title,
                        candidate.get("description") or "",
                        candidate.get("channel") or "",
                    ),
                }
            )
        report["candidates_raw_order"] = raw

        filtered = []
        selected = None
        if candidates:
            selected_id = cached.get("id") if cached else None
            for index, candidate in enumerate(candidates[:10]):
                title = candidate.get("title") or ""
                gate = relevance.playlist_relevant(
                    query, title, candidate.get("description") or ""
                )
                generic = relevance.is_generic_catchall(safesearch.normalize(title))
                kept = bool(gate) and not generic
                filtered.append(
                    {
                        "position": index,
                        "title": title,
                        "kept_after_filter": kept,
                        "is_selected": bool(candidate.get("id") == selected_id),
                    }
                )
        report["candidates_after_filter"] = filtered
        report["note"] = (
            "Selection keeps YouTube order and only filters; score_playlist "
            "is reported for diagnostics and never used to order results."
        )
        return report

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"

        # ── API route: health check ──────────────────────────────────
        if path == "/api/health":
            return self._json_response(200, {"status": "ok"})

        # ── API route: YouTube search ───────────────────────────────
        if path == "/api/youtube/search":
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", params.get("topic", [""]))[0].strip()
            if not q:
                return self._json_response(
                    400,
                    {"error": "Missing q query parameter", "videos": []},
                )
            # SafeSearch: block clearly-inappropriate queries BEFORE they are
            # ever sent anywhere. The student's exact query string is not
            # modified — only a normalised copy is analysed.
            query_safe, reason = safesearch.is_query_safe(q)
            normalized = safesearch.normalize(q)
            self.log_message("USER QUERY: %s", q)
            self.log_message("  Normalized Query: %s", normalized)
            if not query_safe:
                self.log_message("  Query Safety: BLOCKED")
                self.log_message("  Safety Reason: %s", reason)
                return self._json_response(200, safesearch.blocked_response(q))
            self.log_message("  Query Safety: SAFE")
            try:
                # ── YouTube search (PRIMARY: Data API; yt-dlp fallback) ──
                # One provider is used per request. YouTube Data API search.list
                # (type=video) is the primary source when YOUTUBE_API_KEY is
                # configured; yt-dlp is only a fallback when the Data API is
                # unavailable. They are NEVER mixed in one result set.
                provider = "youtube_data_api"
                if youtube_api.has_api_key():
                    videos = youtube_api.search_videos(q) or []
                    if not videos:
                        provider = "yt-dlp (Data API empty/failed)"
                        videos = search_youtube_videos(q) or []
                else:
                    provider = "yt-dlp (no YOUTUBE_API_KEY)"
                    videos = search_youtube_videos(q) or []

                self.log_message("QUERY SENT TO YOUTUBE: %s", q)
                self.log_message("SEARCH PROVIDER: %s", provider)
                self.log_message("  RAW VIDEO RESULTS: %d", len(videos))
                for index, video in enumerate(videos[:5]):
                    self.log_message("    #%d %s", index, (video.get("title") or "")[:90])

                before_count = len(videos)
                # SafeSearch: per-result filtering — removes unsafe results.
                # Filter-only: safe results keep YouTube's exact order. There
                # is intentionally NO custom re-ranking here.
                safe_videos, removed = safesearch.filter_videos(videos)
                self.log_message("  RESULTS AFTER SAFETY FILTER: %d (removed %d)", len(safe_videos), removed)
                response = safesearch.safe_response(q, safe_videos, before_count)

                # Optional duration enrichment (videos.list) — never re-orders.
                if youtube_api.has_api_key() and safe_videos:
                    durations = youtube_api.video_durations([v["id"] for v in safe_videos])
                    if durations:
                        for video in safe_videos:
                            if video.get("id") in durations:
                                video["duration"] = durations[video["id"]]

                # ── YouTube Data API playlist discovery ──────────────────
                # search.list type=playlist (YouTube order, filter-only) →
                # playlistItems.list paginated (max 1000). Cached 30 min.
                recommended = None
                if safe_videos:
                    try:
                        if not youtube_playlists.has_api_key():
                            self.log_message("  Recommended playlist unavailable: API key missing")
                        else:
                            recommended = youtube_playlists.recommended_playlist(q)
                            if recommended is None:
                                self.log_message("  Recommended playlist: none passed the relevance gate")
                    except Exception as exc:
                        self.log_message("  Recommended playlist discovery failed: %r", exc)
                        recommended = None
                response["recommended_playlist"] = recommended
                if recommended:
                    self.log_message(
                        "  Recommended Playlist: %s (%d safe videos)",
                        recommended.get("id"),
                        recommended.get("total_videos"),
                    )

                self.log_message(
                    "FINAL RESULTS SENT TO FRONTEND: %d videos (YouTube order preserved)",
                    len(safe_videos),
                )
                return self._json_response(200, response)
            except Exception as exc:
                self.log_message("YouTube search failed for %r: %r", q, exc)
                return self._json_response(
                    503,
                    {"error": f"YouTube search failed: {exc}", "videos": []},
                )

        # ── API route: YouTube search diagnostics ───────────────────
        if path == "/api/youtube/diagnose":
            params = urllib.parse.parse_qs(parsed.query)
            q = params.get("q", params.get("topic", [""]))[0].strip()
            if not q:
                return self._json_response(400, {"error": "Missing q query parameter"})
            try:
                report = self._diagnose_youtube(q)
            except Exception as exc:
                report = {"query": q, "error": str(exc)}
            return self._json_response(200, report)

        # ── API route: authentication ──────────────────────────────
        if path == "/api/auth/me":
            return self._handle_auth_me()

        # ── API routes: goals (authenticated) ──────────────────────
        if path == "/api/goals":
            return self._handle_goals_list()
        if path.startswith("/api/goals/"):
            goal_id, _ = self._goal_path_parts(path)
            if not goal_id:
                return self._json_response(404, {"ok": False, "error": "Not found"})
            return self._handle_goals_get(goal_id)

        # ── API route: roadmap.sh metadata catalog ──────────────────
        if path == "/api/roadmaps/catalog":
            return self._handle_roadmaps_catalog()

        # ── API routes: topic quizzes (authenticated) ─────────────
        if path == "/api/quiz/status":
            return self._handle_quiz_status()
        if path == "/api/quiz/goals":
            return self._handle_quiz_goal_statuses()
        if path.startswith("/api/quiz/goal/"):
            goal_id = path[len("/api/quiz/goal/"):].strip()
            if goal_id and "/" not in goal_id:
                return self._handle_quiz_goal_status(goal_id)
            return self._json_response(404, {"error": "Not found"})
        if path.startswith("/api/quiz/") and "/" not in path[len("/api/quiz/"):]:
            quiz_id = path[len("/api/quiz/"):].strip()
            if quiz_id:
                return self._handle_quiz_get(quiz_id)

        if path == "/api/roadmaps/refresh":
            return self._handle_roadmaps_refresh()

        # A GET on the planner path is not a route; keep the JSON 404 shape.
        if path.startswith("/api/"):
            return self._json_response(404, {"error": "Not found", "videos": []})

        # ── Static frontend (SPA fallback) ──────────────────────────
        dist = os.path.abspath(DIST_DIR)
        if os.path.isdir(dist):
            request_path = path.lstrip("/")
            candidate = (
                os.path.abspath(os.path.join(dist, request_path))
                if request_path
                else dist
            )
            if candidate.startswith(dist) and os.path.isdir(candidate):
                candidate = os.path.join(candidate, "index.html")
            if candidate.startswith(dist) and os.path.isfile(candidate):
                return self._serve_static_file(candidate)
            index = os.path.join(dist, "index.html")
            if os.path.isfile(index):
                return self._serve_static_file(index)

        self.send_error(404)


def main() -> None:
    auth.init_db()
    goals.init_db()
    quiz_service.init_db()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FocusLearn backend listening on http://{HOST}:{PORT}")
    print("  Health check:      GET  /api/health")
    print("  Authentication:   POST /api/auth/signup | login | logout")
    print("                    POST /api/auth/google | /api/auth/firebase")
    print("                    GET  /api/auth/me | PUT /api/auth/profile")
    print("  YouTube search:    GET /api/youtube/search?q=<topic>")
    print("  AI learning guide: POST /api/ai/learning-guide")
    print("  AI topic Q&A:      POST /api/ai/ask")
    print("  AI create roadmap: POST /api/ai/create-roadmap")
    print("  AI generate quiz:  POST /api/ai/generate-quiz")
    print("  Quiz prep:         POST /api/quiz/prepare (background)")
    print("  Quiz status:       GET  /api/quiz/status?topic=<topic>")
    print("  Goal quiz prep:    POST /api/quiz/goal/<goalId>/prepare (background)")
    print("  Goal quiz status:  GET  /api/quiz/goal/<goalId>")
    print("  Goal quizzes:      GET  /api/quiz/goals (all stored goal quizzes)")
    print("  Quiz:              GET  /api/quiz/<id>")
    print("  Quiz answer:       POST /api/quiz/<id>/answer")
    print("  Quiz submit:       POST /api/quiz/<id>/submit")
    print("  AI analyze perf:   POST /api/ai/analyze-performance")
    print("  AI recommend:      POST /api/ai/recommend-next-topic")
    print("  Roadmap catalog:   GET  /api/roadmaps/catalog (metadata only)")
    print("                     POST /api/roadmaps/refresh")
    print("                     POST /api/study-plan/plan")
    print("  Goals:             GET|POST /api/goals")
    print("                     GET|PUT|DELETE /api/goals/<id>")
    print("                     POST /api/goals/<id>/{pause,resume,complete,archive,restore,set-primary}")
    dist = os.path.abspath(DIST_DIR)
    if os.path.isdir(dist):
        print(f"  Frontend (built): {dist}")
    else:
        print("  Frontend: build with `npm run build` to serve it here")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()