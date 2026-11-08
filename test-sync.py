#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""同步服务安全测试：账号注册登录、数据隔离、令牌失效、限流。"""
import importlib.util
import json
import os
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from tempfile import TemporaryDirectory

spec = importlib.util.spec_from_file_location(
    "sync", os.path.join(os.path.dirname(__file__), "deploy", "transword-sync.py"))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

passed = 0
failed = 0

# 与服务端共用的管理密钥（测试里直接取模块常量，避免写死两份）
ADMIN_KEY = mod.FEEDBACK_KEY


def check(name, cond, extra=None):
    global passed, failed
    if cond:
        passed += 1
        print("  PASS  " + name)
    else:
        failed += 1
        print("  FAIL  " + name + (("  => " + json.dumps(extra, ensure_ascii=False)) if extra is not None else ""))


def req(base, method, path, body=None, token=None, code=None, ip="1.1.1.1"):
    headers = {"Content-Type": "application/json", "X-Real-IP": ip}
    if token:
        headers["Authorization"] = "Bearer " + token
    if code:
        headers["X-Transword-Code"] = code
    data = None if body is None else json.dumps(body).encode("utf-8")
    r = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


with TemporaryDirectory(ignore_cleanup_errors=True) as d:
    mod.DATA_DIR = d
    mod.DB_PATH = os.path.join(d, "sync.db")
    mod.init_db()
    server = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % server.server_port

    print("== 账号注册与登录 ==")
    s, j = req(base, "POST", "/register", {"username": "alice", "password": "secret123"}, ip="9.9.9.9")
    check("注册 alice 成功并返回令牌", s == 200 and j.get("ok") and len(j.get("token", "")) > 20, j)
    alice_tok = j.get("token", "")
    s, j = req(base, "POST", "/register", {"username": "alice", "password": "other123"}, ip="9.9.9.8")
    check("重复用户名被拒绝(409)", s == 409 and j.get("error") == "username-taken", (s, j))
    s, j = req(base, "POST", "/register", {"username": "ab", "password": "secret123"}, ip="9.9.9.7")
    check("过短用户名被拒绝", s == 400 and j.get("error") == "invalid-username", (s, j))
    s, j = req(base, "POST", "/register", {"username": "1abc", "password": "secret123"}, ip="9.9.9.6")
    check("非字母开头的用户名被拒绝", s == 400 and j.get("error") == "invalid-username", (s, j))
    s, j = req(base, "POST", "/register", {"username": "bobby", "password": "12345"}, ip="9.9.9.5")
    check("过短密码被拒绝", s == 400 and j.get("error") == "invalid-password", (s, j))
    s, j = req(base, "POST", "/register", {"username": "bobby", "password": "12345678"}, ip="9.9.9.4")
    check("纯数字密码被拒绝", s == 400 and j.get("error") == "invalid-password", (s, j))
    s, j = req(base, "POST", "/register", {"username": "bobby", "password": "abcdefgh"}, ip="9.9.9.3")
    check("纯字母密码被拒绝", s == 400 and j.get("error") == "invalid-password", (s, j))
    s, j = req(base, "POST", "/register", {"username": "bobby", "password": "hunter22"}, ip="9.9.9.2")
    bob_tok = j.get("token", "")
    check("注册 bob 成功", s == 200 and bob_tok, (s, j))
    s, j = req(base, "POST", "/login", {"username": "alice", "password": "wrong123"}, ip="8.8.8.8")
    check("错误密码被拒绝(401)", s == 401 and j.get("error") == "bad-credentials", (s, j))
    s, j = req(base, "POST", "/login", {"username": "alice", "password": "secret123"}, ip="8.8.8.7")
    check("正确密码登录成功", s == 200 and j.get("ok") and j.get("username") == "alice", (s, j))
    s, j = req(base, "GET", "/whoami", token=alice_tok)
    check("whoami 返回 alice", s == 200 and j.get("username") == "alice", (s, j))

    print("== 生词本数据隔离 ==")
    s, j = req(base, "PUT", "/vocab", {"vocab": [{"src": "apple", "dst": "苹果", "lang": "en2zh", "ts": 1, "count": 1, "flag": ""}]}, token=alice_tok)
    check("alice 写入生词本成功", s == 200 and j.get("ok"), (s, j))
    s, j = req(base, "GET", "/vocab", token=bob_tok)
    check("bob 读不到 alice 的生词本", s == 200 and j.get("vocab") == [], (s, j))
    s, j = req(base, "PUT", "/vocab", {"vocab": [{"src": "banana", "dst": "香蕉", "lang": "en2zh", "ts": 2, "count": 1, "flag": ""}]}, token=bob_tok)
    check("bob 写入自己的生词本", s == 200, (s, j))
    s, j = req(base, "GET", "/vocab", token=alice_tok)
    check("alice 只有自己的 apple", s == 200 and len(j.get("vocab", [])) == 1 and j["vocab"][0]["src"] == "apple", (s, j))
    s, j = req(base, "GET", "/vocab")
    check("无凭据访问被拒绝(401)", s == 401, (s, j))
    s, j = req(base, "PUT", "/vocab", {"vocab": "not-a-list"}, token=alice_tok)
    check("非法数据格式被拒绝", s == 400, (s, j))

    print("== 旧 36 位配对码兼容且与账号隔离 ==")
    code_a = "a" * 36
    code_b = "b" * 36
    s, j = req(base, "PUT", "/vocab", {"vocab": [{"src": "code-a", "dst": "A"}]}, code=code_a)
    check("配对码 a 可写入", s == 200, (s, j))
    s, j = req(base, "GET", "/vocab", code=code_b)
    check("配对码 b 读不到 a 的数据", s == 200 and j.get("vocab") == [], (s, j))
    s, j = req(base, "GET", "/vocab", code="xyz")
    check("非法配对码被拒绝", s == 401, (s, j))

    print("== 登出后令牌失效 ==")
    s, j = req(base, "POST", "/logout", token=bob_tok)
    check("bob 登出成功", s == 200, (s, j))
    s, j = req(base, "GET", "/vocab", token=bob_tok)
    check("bob 旧令牌已失效(401)", s == 401, (s, j))

    print("== 登录限流 ==")
    limited = False
    for _ in range(12):
        s, _j = req(base, "POST", "/login", {"username": "nobody", "password": "bad"}, ip="7.7.7.7")
        if s == 429:
            limited = True
            break
    check("连续失败登录触发限流(429)", limited)

    print("== 用户反馈收集 ==")
    # 匿名提交（真人测试不需要注册就能提意见）
    s, j = req(base, "POST", "/feedback",
               {"rating": 5, "text": "查词很快，音标很有用", "contact": "tester@example.com"},
               ip="8.8.8.8")
    check("匿名提交反馈成功", s == 200 and j.get("ok"), (s, j))
    s, j = req(base, "POST", "/feedback", {"rating": 2, "text": "希望加发音速度调节"}, ip="8.8.8.8")
    check("可提交纯文字+评分", s == 200, (s, j))
    s, j = req(base, "POST", "/feedback", {"rating": 0, "text": ""}, ip="8.8.8.9")
    check("空反馈被拒绝(400)", s == 400, (s, j))
    # 评分越界应被夹到 0..5，而不是报错或存脏值
    s, j = req(base, "POST", "/feedback", {"rating": 99, "text": "评分越界测试"}, ip="8.8.8.10")
    check("评分越界被接受(夹取)", s == 200, (s, j))

    print("== 反馈读取权限 ==")
    s, j = req(base, "GET", "/feedback")
    check("无密钥查看反馈被拒绝(403)", s == 403, (s, j))
    s, j = req(base, "GET", "/feedback?key=wrong-key")
    check("错误密钥被拒绝(403)", s == 403, (s, j))
    s, j = req(base, "GET", "/feedback?key=" + ADMIN_KEY)
    check("正确密钥可查看反馈", s == 200 and j.get("ok"), (s, j))
    check("反馈条数正确(3 条)", j.get("total") == 3, j.get("total"))
    check("平均评分已统计", j.get("avg_rating", 0) > 0, j.get("avg_rating"))
    items = j.get("items") or []
    check("最新反馈排在最前", bool(items) and items[0].get("text") == "评分越界测试", items[0] if items else None)
    check("越界评分被夹到 5", bool(items) and items[0].get("rating") == 5, items[0] if items else None)
    check("反馈内容完整保存",
          any("查词很快" in (x.get("text") or "") for x in items), [x.get("text") for x in items])

    print("== 反馈限流 ==")
    fb_limited = False
    for _ in range(10):
        s, _j = req(base, "POST", "/feedback", {"rating": 3, "text": "刷屏测试"}, ip="9.9.9.9")
        if s == 429:
            fb_limited = True
            break
    check("连续提交反馈触发限流(429)", fb_limited)

    server.shutdown()
    server.server_close()
    import time as _t
    _t.sleep(0.3)   # Windows 上 SQLite WAL 句柄释放有延迟，清理前稍等

print("")
print("结果: %d 通过, %d 失败" % (passed, failed))
raise SystemExit(1 if failed else 0)
