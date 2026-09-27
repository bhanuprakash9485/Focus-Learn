"""
Live end-to-end test of the FocusLearn backend over real HTTP.

Boots an in-process ThreadingHTTPServer (like ``python backend/server.py``)
on an ephemeral loopback port with a throwaway SQLite database, then drives
the real auth endpoints with actual cookie handling:

  - email/password signup -> session cookie -> /api/auth/me
  - logout clears the cookie
  - login -> session persists across requests
  - wrong password / duplicate email / missing credentials
  - POST /api/auth/google (missing/bogus credential -> safe controlled errors)

No production data is touched and no Google credentials are required.

Run:  python backend/test_live_server.py
"""

from __future__ import annotations

import http.client
import json
import os
import re
import socket
import sys
import tempfile
import threading
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE_DIR)

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    status = "PASS" if cond else "FAIL"
    if not cond:
        FAILURES.append(name)
    print(f"  {status}: {name}" + (f"  -- {detail}" if detail else ""))


def claim_free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# Point auth at a throwaway DB BEFORE server is imported.
_auth = None
port = claim_free_port()
os.environ["PORT"] = str(port)
os.environ["FOCUSLEARN_HOST"] = "127.0.0.1"

_tmp = tempfile.mkdtemp(prefix="focuslearn-live-")
_db_path = os.path.join(_tmp, "live.db")
_conn = None

import auth  # noqa: E402

auth.DB_PATH = _db_path
auth._conn = None

import google_auth  # noqa: E402
import server  # noqa: E402

auth.init_db()

httpd = server.ThreadingHTTPServer(("127.0.0.1", port), server.Handler)
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()
time.sleep(0.2)

BASE = f"http://127.0.0.1:{port}"

_cookie: str | None = None


def req(method: str, path: str, body=None, use_cookie: bool = True):
    global _cookie
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if use_cookie and _cookie:
        # Send a real cookie pair — extract_session_token matches the
        # "fl_session=<token>" name, not a bare token.
        headers["Cookie"] = f"fl_session={_cookie}"
    conn.request(method, path, body=data, headers=headers)
    resp = conn.getresponse()
    raw = resp.read().decode("utf-8", "replace")
    headers_out = dict((k.lower(), v) for k, v in resp.getheaders())
    conn.close()
    return resp.status, headers_out, raw


def take_cookie(headers: dict) -> str | None:
    sc = headers.get("set-cookie", "")
    m = re.search(r"fl_session=([^;]+);", sc)
    return m.group(1) if m else None


EMAIL = f"liveuser{int(time.time())}@example.com"
PASSWORD = "livedemo1"

print("== FocusLearn live backend test ==")
print(f"server on {BASE}, temp DB {_db_path}, user {EMAIL}\n")

# 1) health
status, _, body = req("GET", "/api/health")
check("GET /api/health", status == 200 and json.loads(body).get("status") == "ok", f"http {status}")

# 2) email/password signup -> session cookie
status, hdrs, body = req("POST", "/api/auth/signup", {"name": "Live Tester", "email": EMAIL, "password": PASSWORD})
check("signup 201", status == 201, f"http {status}")
_cookie = take_cookie(hdrs)
check("signup sets HttpOnly session cookie", status == 201 and _cookie is not None,
      f"Set-Cookie: {hdrs.get('set-cookie','')[:80]}")
check("session cookie is HttpOnly + SameSite=Lax", "HttpOnly" in hdrs.get("set-cookie", "") and "SameSite=Lax" in hdrs.get("set-cookie", ""),
      hdrs.get("set-cookie", "")[:120])
data = json.loads(body)
check("signup returns user with hasPassword=true", data.get("ok") and data["user"]["has_password"] is True)

# 3) /api/auth/me with the cookie -> authenticated
status, _, body = req("GET", "/api/auth/me")
check("me after signup", status == 200 and json.loads(body)["user"]["email"] == EMAIL, f"http {status}")

# duplicate signup rejected
status, _, body = req("POST", "/api/auth/signup", {"name": "Dup", "email": EMAIL, "password": "otherpw"})
check("duplicate signup 409", status == 409, f"http {status}")

# 4) logout clears the cookie; me then 401
status, _, _ = req("POST", "/api/auth/logout")
check("logout 200", status == 200)
_cookie = None
status, _, _ = req("GET", "/api/auth/me")
check("me after logout 401", status == 401, f"http {status}")

# 5) login -> new session; persists across requests (refresh safety)
status, hdrs, _ = req("POST", "/api/auth/login", {"email": EMAIL, "password": PASSWORD})
_cookie = take_cookie(hdrs)
check("login 200", status == 200)
status, _, body = req("GET", "/api/auth/me")
check("me after re-login 200", status == 200 and json.loads(body)["user"]["email"] == EMAIL, f"http {status}")
status, _, body = req("GET", "/api/auth/me")  # second call, same cookie
check("session persists across requests", status == 200 and json.loads(body)["user"]["email"] == EMAIL)

# wrong password -> 401 safe message, no password echoed
status, _, body = req("POST", "/api/auth/login", {"email": EMAIL, "password": "wrongpass"})
check("wrong password 401", status == 401, f"http {status}")
check("safe login error text", "Incorrect email or password." in json.loads(body).get("error", ""))
check("no raw password leakage", PASSWORD not in body and EMAIL.split("@")[0] not in json.loads(body).get("error", ""))

# malformed signup -> 400
status, _, _ = req("POST", "/api/auth/signup", {"name": "", "email": "bad", "password": "x"})
check("invalid signup 400", status == 400, f"http {status}")

# 6) Google endpoint behaviors.
# Missing credential -> 400 when Google sign-in is configured, 503 when it
# is not (the configuration gate runs before the credential check).
status, _, body = req("POST", "/api/auth/google", {})
check("google missing credential 400/503", status in (400, 503), f"http {status}")
# Bogus credential -> either 503 (not configured) or 401 (rejected). Must be
# a controlled safe message, never a raw stack/token echo.
status, _, body = req("POST", "/api/auth/google", {"credential": "bogus-diag-token"})
check("google bogus credential rejected safely",
      status in (401, 503) and "error" in json.loads(body),
      f"http {status} -> {json.loads(body).get('error','')[:60]}")
check("google error never echoes the token",
      "bogus-diag-token" not in body and "Traceback" not in body)
if status == 503:
    check("google not-configured message is clear",
          "not configured" in json.loads(body).get("error", "").lower())

# 7) Emails are lowercased on signup.
upper = req("POST", "/api/auth/login", {"email": EMAIL.upper(), "password": PASSWORD})
check("login works with uppercase email", upper[0] == 200, f"http {upper[0]}")

print()
httpd.shutdown()
httpd.server_close()

if FAILURES:
    print(f"\n{len(FAILURES)} FAILURE(S): {', '.join(FAILURES)}")
    sys.exit(1)
print("ALL LIVE TESTS PASSED")
sys.exit(0)