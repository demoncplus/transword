#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""译词通极简同步服务。

仅监听 127.0.0.1，由 Nginx 的 /transword-sync/ 反代。
数据保存在 /var/lib/transword-sync/vocab.json，不进入 Git。
"""
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("TRANSWORD_SYNC_PORT", "8787"))
KEY = os.environ.get("TRANSWORD_SYNC_KEY", "")
DATA = os.environ.get("TRANSWORD_SYNC_DATA", "/var/lib/transword-sync/vocab.json")
MAX_BYTES = 2 * 1024 * 1024
LOCK = threading.Lock()


def load_data():
    try:
        with open(DATA, encoding="utf-8") as f:
            value = json.load(f)
        return value if isinstance(value, list) else []
    except (OSError, ValueError):
        return []


def save_data(value):
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, DATA)


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, body):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Transword-Key")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, OPTIONS")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self):
        supplied = self.headers.get("X-Transword-Key", "") or self.path.split("key=", 1)[-1].split("&", 1)[0]
        return bool(KEY) and supplied == KEY

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        if self.path.split("?", 1)[0] != "/vocab" or not self.authorized():
            self.send_json(404 if self.path.split("?", 1)[0] != "/vocab" else 403, {"error": "forbidden"})
            return
        with LOCK:
            value = load_data()
        self.send_json(200, {"vocab": value})

    def do_PUT(self):
        if self.path.split("?", 1)[0] != "/vocab" or not self.authorized():
            self.send_json(404 if self.path.split("?", 1)[0] != "/vocab" else 403, {"error": "forbidden"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BYTES:
                self.send_json(413, {"error": "payload-too-large"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            value = payload.get("vocab") if isinstance(payload, dict) else None
            if not isinstance(value, list):
                self.send_json(400, {"error": "vocab-array-required"})
                return
            with LOCK:
                save_data(value)
            self.send_json(200, {"ok": True, "count": len(value)})
        except (ValueError, OSError):
            self.send_json(400, {"error": "invalid-json"})

    def log_message(self, fmt, *args):
        print("[transword-sync] " + (fmt % args), flush=True)


if __name__ == "__main__":
    print("译词通生词本同步服务: http://127.0.0.1:%d/vocab" % PORT, flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
