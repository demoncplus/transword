#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""译词通生词本同步服务（账号版）。

仅监听 127.0.0.1，由 Nginx 的 /transword-sync/ 反代。

- 账号：用户名 + 密码（PBKDF2-HMAC-SHA256 加盐哈希，明文绝不落盘）
- 会话：随机令牌（服务器只存 SHA-256 哈希，90 天有效，支持"保持登录"）
- 数据：SQLite（/var/lib/transword-sync/sync.db），每账号独立生词本空间
- 兼容：保留 X-Transword-Code 36 位配对码访问（旧版前端数据不丢）
- 限流：登录/注册按 IP 每分钟限速，防爆破

接口：
  POST /register {username,password} -> {ok,username,token}
  POST /login    {username,password} -> {ok,username,token}
  POST /logout   (Bearer token)      -> {ok}
  GET  /whoami   (Bearer token)      -> {ok,username}
  GET  /vocab    (Bearer token)      -> {vocab}
  PUT  /vocab    (Bearer token)      -> {ok,count}
"""
import hashlib
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("TRANSWORD_SYNC_PORT", "8787"))
DATA_DIR = os.environ.get("TRANSWORD_SYNC_DATA_DIR", "/var/lib/transword-sync")
DB_PATH = os.path.join(DATA_DIR, "sync.db")
MAX_VOCAB_BODY = 2 * 1024 * 1024
MAX_AUTH_BODY = 16 * 1024
MAX_ITEMS = 5000
TOKEN_DAYS = 90
LOCK = threading.Lock()

USER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{3,19}$")
CODE_RE = re.compile(r"^[a-f0-9]{36}$")
RATE_LIMIT = {"login": 10, "register": 5}
_hits = {}
_hits_lock = threading.Lock()


def valid_password(pw):
    """京东风格：8-20 位，必须同时包含字母和数字，可含常见符号。"""
    if not isinstance(pw, str) or not (8 <= len(pw) <= 20):
        return False
    if not re.search(r"[A-Za-z]", pw) or not re.search(r"\d", pw):
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9!@#$%^&*._~\-]+", pw))


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS users(
          username TEXT PRIMARY KEY,
          pw_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens(
          token_hash TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS vocab(
          space TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(username);
        """)


def hash_password(pw):
    salt = secrets.token_bytes(16)
    iterations = 100_000
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), salt, iterations)
    return "pbkdf2$%d$%s$%s" % (iterations, salt.hex(), dk.hex())


def verify_password(pw, stored):
    try:
        _, it, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt_hex), int(it))
        return secrets.compare_digest(dk.hex(), hash_hex)
    except Exception:
        return False


def issue_token(username):
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    expires = int(time.time()) + TOKEN_DAYS * 86400
    with LOCK, db() as conn:
        conn.execute("INSERT INTO tokens VALUES(?,?,?)", (token_hash, username, expires))
    return token


def token_user(token):
    if not token:
        return None
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with LOCK, db() as conn:
        row = conn.execute("SELECT username, expires_at FROM tokens WHERE token_hash=?", (token_hash,)).fetchone()
    if not row:
        return None
    if row[1] < int(time.time()):
        with LOCK, db() as conn:
            conn.execute("DELETE FROM tokens WHERE token_hash=?", (token_hash,))
        return None
    return row[0]


def drop_token(token):
    token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
    with LOCK, db() as conn:
        conn.execute("DELETE FROM tokens WHERE token_hash=?", (token_hash,))


def allow(kind, ip):
    now = int(time.time())
    key = (kind, ip)
    with _hits_lock:
        arr = _hits.setdefault(key, [])
        arr[:] = [t for t in arr if now - t < 60]
        if len(arr) >= RATE_LIMIT[kind]:
            return False
        arr.append(now)
        return True


def load_vocab(space):
    with LOCK, db() as conn:
        row = conn.execute("SELECT data FROM vocab WHERE space=?", (space,)).fetchone()
    if not row:
        return []
    try:
        value = json.loads(row[0])
        return value if isinstance(value, list) else []
    except ValueError:
        return []


def save_vocab(space, value):
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    with LOCK, db() as conn:
        conn.execute(
            "INSERT INTO vocab(space,data,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(space) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at",
            (space, payload, int(time.time())))


def valid_vocab(value):
    return isinstance(value, list) and len(value) <= MAX_ITEMS and all(
        isinstance(x, dict) for x in value)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Transword-Code")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")

    def _json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _client_ip(self):
        return self.headers.get("X-Real-IP") or self.client_address[0]

    def _body(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _identity(self):
        """返回 (kind, key)：kind='user' 走账号空间，'code' 走旧配对码空间。"""
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            user = token_user(auth[7:].strip())
            if user:
                return ("user", user)
            return None
        code = self.headers.get("X-Transword-Code", "")
        if CODE_RE.fullmatch(code or ""):
            digest = hashlib.sha256(code.encode("ascii")).hexdigest()
            return ("code", "code:" + digest)
        return None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/register":
            if not allow("register", self._client_ip()):
                self._json(429, {"error": "too-many-requests"})
                return
            body = self._body(MAX_AUTH_BODY)
            username = (body or {}).get("username", "")
            password = (body or {}).get("password", "")
            if not isinstance(username, str) or not USER_RE.fullmatch(username):
                self._json(400, {"error": "invalid-username"})
                return
            if not valid_password(password):
                self._json(400, {"error": "invalid-password"})
                return
            with LOCK, db() as conn:
                exists = conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone()
                if exists:
                    self._json(409, {"error": "username-taken"})
                    return
                conn.execute("INSERT INTO users VALUES(?,?,?)",
                             (username, hash_password(password), int(time.time())))
            self._json(200, {"ok": True, "username": username, "token": issue_token(username)})
            return
        if path == "/login":
            if not allow("login", self._client_ip()):
                self._json(429, {"error": "too-many-requests"})
                return
            body = self._body(MAX_AUTH_BODY)
            username = (body or {}).get("username", "")
            password = (body or {}).get("password", "")
            with LOCK, db() as conn:
                row = conn.execute("SELECT pw_hash FROM users WHERE username=?", (username,)).fetchone()
            if not row or not verify_password(password or "", row[0]):
                self._json(401, {"error": "bad-credentials"})
                return
            self._json(200, {"ok": True, "username": username, "token": issue_token(username)})
            return
        if path == "/logout":
            auth = self.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                drop_token(auth[7:].strip())
            self._json(200, {"ok": True})
            return
        self._json(404, {"error": "not-found"})

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/whoami":
            auth = self.headers.get("Authorization", "")
            user = token_user(auth[7:].strip()) if auth.startswith("Bearer ") else None
            if user:
                self._json(200, {"ok": True, "username": user})
            else:
                self._json(401, {"error": "invalid-token"})
            return
        if path == "/vocab":
            ident = self._identity()
            if not ident:
                self._json(401, {"error": "unauthorized"})
                return
            self._json(200, {"vocab": load_vocab(ident[1])})
            return
        self._json(404, {"error": "not-found"})

    def do_PUT(self):
        path = self.path.split("?", 1)[0]
        if path != "/vocab":
            self._json(404, {"error": "not-found"})
            return
        ident = self._identity()
        if not ident:
            self._json(401, {"error": "unauthorized"})
            return
        body = self._body(MAX_VOCAB_BODY)
        value = body.get("vocab") if isinstance(body, dict) else None
        if not valid_vocab(value):
            self._json(400, {"error": "vocab-array-required"})
            return
        save_vocab(ident[1], value)
        self._json(200, {"ok": True, "count": len(value)})

    def log_message(self, fmt, *args):
        print("[transword-sync] " + (fmt % args), flush=True)


if __name__ == "__main__":
    init_db()
    print("译词通生词本同步服务（账号版）: http://127.0.0.1:%d/vocab" % PORT, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
