#!/usr/bin/env python3
import json
import os
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer

import importlib.util

spec = importlib.util.spec_from_file_location("sync", os.path.join(os.path.dirname(__file__), "deploy", "transword-sync.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

with tempfile.TemporaryDirectory() as d:
    mod.DATA_DIR = d
    server = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d/vocab" % server.server_port
    a = "a" * 36
    b = "b" * 36

    def request(method, code, value=None):
        data = None if value is None else json.dumps({"vocab": value}).encode()
        req = urllib.request.Request(base, data=data, method=method, headers={"X-Transword-Code": code, "Content-Type": "application/json"})
        with urllib.request.urlopen(req) as r:
            return json.loads(r.read())

    request("PUT", a, [{"src": "apple", "dst": "苹果"}])
    assert request("GET", a)["vocab"][0]["src"] == "apple"
    assert request("GET", b)["vocab"] == []
    assert len(os.listdir(d)) == 1
    server.shutdown()
print("sync isolation: PASS")
