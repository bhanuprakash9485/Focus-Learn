"""
FocusLearn WSGI adapter for Vercel.

Vercel's Python runtime hosts WSGI apps; backend/server.py is a stdlib
BaseHTTPRequestHandler. This adapter reuses the real Handler for every
/api route — routing, SafeSearch gates, auth cookies, quiz state and all
business logic stay exactly as they are. Only the transport is mapped:

    BaseHTTPRequestHandler (socket)  ->  WSGI environ (Flask)

Each request gets a Handler instance created without __init__ (no socket);
the transport methods (send_response / send_header / wfile / rfile) are
shadowed so replies are captured into a Flask Response. Session cookies
flow through Set-Cookie / the Cookie header unchanged.

Local development does NOT use this file — keep running:

    python backend/server.py      (npm run backend)

with the Vite dev proxy, as documented in .env.example.

Note on the quiz background thread: quiz_service generates quizzes in a
daemon thread while the client polls GET /api/quiz/<id>. Vercel Fluid
compute keeps instances warm across requests and the quiz row persists in
SQLite, so a later request picks up the stored state; if an instance dies
mid-generation, prepare_quiz creates a fresh row on the next call.
"""

from __future__ import annotations

import io
import json
import mimetypes
import os
import sys

# Make backend/ importable regardless of the working directory Vercel uses.
_BACKEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import auth  # noqa: E402
import goals  # noqa: E402
import quiz_service  # noqa: E402
import server as focuslearn_server  # noqa: E402
from flask import Flask, Response, request  # noqa: E402

# SQLite must live outside the read-only function bundle on Vercel; /tmp is
# the writable location there. FOCUSLEARN_DATA_DIR wins (local dev/tests).
_DB_DIR = os.environ.get("FOCUSLEARN_DATA_DIR") or os.path.join("/tmp", "focuslearn-data")
_DB_PATH = os.path.join(_DB_DIR, "focuslearn.db")
try:
    os.makedirs(_DB_DIR, exist_ok=True)
    auth.DB_PATH = _DB_PATH
    auth._conn = None
    quiz_service.DB_PATH = _DB_PATH
    auth.init_db()
    goals.init_db()
    quiz_service.init_db()
except OSError:
    # Unwritable /tmp (non-Vercel): keep the backend's own backend/data path.
    pass

app = Flask(__name__)

_HANDLER = focuslearn_server.Handler


def _dispatch(handler_method) -> Response:
    """Run the real Handler method for this request and capture the reply."""
    handler = _HANDLER.__new__(_HANDLER)

    response = Response()
    response.status_code = 200

    def send_response(status):
        response.status_code = int(status)

    def send_header(name, value):
        if name.lower() == "content-length":
            return  # Flask computes Content-Length from the body.
        response.headers[name] = value

    captured = io.BytesIO()

    # Shadow only the transport surface; every other method (routing,
    # auth, SafeSearch, cookies, JSON bodies) is the untouched Handler code.
    handler.headers = request.headers
    handler.path = request.full_path or request.path
    handler.rfile = io.BytesIO(request.get_data() or b"")
    handler.wfile = captured
    handler.send_response = send_response
    handler.send_header = send_header
    handler.end_headers = lambda: None
    handler.log_message = lambda fmt, *args: print("[focuslearn]", fmt % args)

    def send_error(code, message=None, *args):
        send_response(code)
        send_header("Content-Type", "application/json; charset=utf-8")
        captured.write(json.dumps({"error": message or str(code)}).encode())

    handler.send_error = send_error

    try:
        handler_method(handler)
    except Exception as exc:  # defensive: never leak a stack trace
        print("[focuslearn] handler error:", repr(exc))
        if captured.tell() == 0:
            response.status_code = 500
            captured.write(json.dumps({"error": "Internal server error."}).encode())

    return Response(
        captured.getvalue(),
        status=response.status_code,
        headers=dict(response.headers),
    )


@app.route("/api/health", methods=["GET"])
def health():
    return Response(json.dumps({"status": "ok"}), mimetype="application/json")


@app.route("/api/<path:rest>", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
def api_catchall(rest: str):
    """Map every /api/* request onto the corresponding Handler method."""
    method = request.method.upper()
    if method == "OPTIONS":
        response = Response(status=204)
        response.headers["Access-Control-Allow-Origin"] = request.headers.get("Origin", "*")
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Credentials"] = "true"
        return response
    handler = {
        "GET": _HANDLER.do_GET,
        "POST": _HANDLER.do_POST,
        "PUT": _HANDLER.do_PUT,
        "DELETE": _HANDLER.do_DELETE,
    }.get(method)
    if handler is None:
        return Response(json.dumps({"error": "Method not allowed"}), status=405)
    return _dispatch(handler)


@app.route("/", defaults={"rest": ""}, methods=["GET"])
@app.route("/<path:rest>", methods=["GET"])
def spa(rest: str):
    """Serve the built SPA from dist/ (Vercel rewrites route non-API paths
    here; static assets are served from the CDN by Vercel itself)."""
    dist = os.path.abspath(
        os.environ.get(
            "FOCUSLEARN_DIST",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist"),
        )
    )
    request_path = rest.lstrip("/")
    candidate = (
        os.path.abspath(os.path.join(dist, request_path))
        if request_path
        else os.path.join(dist, "index.html")
    )
    if not candidate.startswith(dist) or not os.path.isfile(candidate):
        candidate = os.path.join(dist, "index.html")
    if not os.path.isfile(candidate):
        return Response(
            json.dumps({"error": "Frontend build not found. Run `npm run build` first."}),
            status=404,
            mimetype="application/json",
        )
    ctype = mimetypes.guess_type(candidate)[0] or "application/octet-stream"
    with open(candidate, "rb") as fh:
        payload = fh.read()
    return Response(payload, status=200, content_type=ctype)
