# -*- coding: utf-8 -*-
"""译词通 自建翻译引擎 API
基于 Argos Translate（完全离线的开源神经机器翻译），无需任何 API 密钥。

启动:  python translate-api.py
接口:  GET /translate?text=hello&langpair=en|zh-CN
       GET /health
返回:  {"translatedText": "你好"}   （与 MyMemory 协议兼容，可直接填入译词通的"自建翻译接口"）
"""
import json
import os
import re
import sys
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler

# 必须在 import argostranslate 之前设置：
# 模型包打包了 stanza 断句，它要联网下载分词模型（raw.githubusercontent 在部分地区不可达）。
# 强制使用 MiniSBD 纯本地断句，保证引擎完全离线可用。
os.environ.setdefault('ARGOS_CHUNK_TYPE', 'MINISBD')

import argostranslate.translate

PORT = 8766
HERE = os.path.dirname(os.path.abspath(__file__))

# 常用短语表（由 build_dict.py 从 ECDICT 生成 + 人工校对）。
# 神经模型对 2~4 个词的短句容易重复退化（如 good morning → 早,早,早,早），
# 因此短语采用精确匹配优先。
GLOSSARY_EN_ZH = {}
_glossary_path = os.path.join(HERE, 'glossary.json')
if os.path.exists(_glossary_path):
    with open(_glossary_path, encoding='utf-8') as f:
        GLOSSARY_EN_ZH = json.load(f)


def norm_text(text):
    """短语匹配用归一化：小写、去首尾标点、压缩空格"""
    t = (text or '').strip().lower()
    t = re.sub(r'^[\s\'"“”‘’「」【】(\[]+', '', t)
    t = re.sub(r'[\s\'"“”‘’「」【】)\]\.,!?;:。，！？；：、]+$', '', t)
    t = re.sub(r'\s+', ' ', t)
    return t


def collapse_repeats(text):
    """折叠相邻重复片段。
    模型常吐出 "今天天气糟透了 天气很糟 天气很糟" 这类重复段，
    这里只删掉紧邻的完全相同片段，不做语义改写，安全。"""
    if not text:
        return text
    for _ in range(3):   # 反复折叠，直到稳定
        chunks = re.split(r'(\s+|[，,、;；]+)', text)
        segs = [c for c in chunks if c.strip()]
        keep, out = [], []
        for c in chunks:
            if not c.strip():
                out.append(c)
                continue
            norm = c.strip()
            if keep and keep[-1] == norm:
                continue          # 紧邻重复 → 丢弃
            keep.append(norm)
            out.append(c)
        new = ''.join(out).strip()
        new = re.sub(r'^[\s，,、;；]+', '', new)
        new = re.sub(r'[\s，,、;；]+$', '', new)
        if new == text:
            break
        text = new
    return text


def is_degenerate(text):
    """检测神经模型的重复退化输出，如 "早,早,早,早" / "the the the"。
    判定：单个片段（按标点/空白切分）连续重复，或整体重复同一片段。"""
    if not text:
        return True
    parts = [p.strip() for p in re.split(r'[,，、;；\s]+', text) if p.strip()]
    if len(parts) >= 3 and len(set(parts)) == 1:
        return True
    if len(parts) >= 4 and len(set(parts)) <= 2:
        return True
    # 短输出（≤4 段）里只要有一个片段出现 ≥2 次，即为重复退化。
    # 补这条是因为 "今天天气糟透了 天气很糟 天气很糟"（3段2种）能同时逃过上面两条。
    if 3 <= len(parts) <= 4:
        counts = {}
        for p in parts:
            counts[p] = counts.get(p, 0) + 1
        if max(counts.values()) >= 2 and all(len(p) >= 2 for p, c in counts.items() if c >= 2):
            return True
    # 整串重复同一小片段（无分隔符的情况）
    if len(text) >= 6:
        for size in range(1, 5):
            unit = text[:size]
            if unit.strip() and len(text) >= size * 3 and text == unit * (len(text) // size):
                return True
    return False


def strip_scaffold(text):
    """清掉防退化重试注入的 ", please." 痕迹。
    例："我今天很累,请。" -> "我今天很累。"；"谢谢, 请" -> "谢谢"。
    仅去除句尾的"请/please"，不碰句中的正常"请"（如"请问火车站在哪"）。"""
    if not text:
        return text
    t = text.strip()
    # 尾部：可选的标点 + 请/please + 可选标点，且"请"前面必须是标点或空白分隔
    t = re.sub(r'[，,、;；]?\s*(?:请|please)\s*[。.!！?？]*\s*$', '', t, flags=re.I)
    # 清掉因删除而变成孤立的尾部逗号，并补回句号
    t = re.sub(r'[，,、;；\s]+$', '', t)
    t = t.strip()
    if t and t[-1] not in '。！？.!?':
        t += '。'
    return t


def norm_lang(code):
    """应用传入 zh-CN / zh / en 等，映射到 Argos 语言代码"""
    code = (code or '').lower().split('-')[0]
    if code == 'zh':
        return 'zh'
    return code


def do_translate(text, langpair):
    try:
        src, tgt = [norm_lang(c) for c in langpair.split('|')]
    except ValueError:
        return None, 'bad langpair, expected like en|zh-CN'

    # 1) 英译中：先查常用短语表（准确、瞬时）
    if src == 'en' and tgt == 'zh':
        hit = GLOSSARY_EN_ZH.get(norm_text(text))
        if hit:
            return hit, None, 'glossary'

    # 2) 神经模型翻译
    try:
        tr = argostranslate.translate.get_translation_from_codes(src, tgt)
    except Exception:
        tr = None
    if tr is None:
        return None, 'language pair not installed: %s|%s' % (src, tgt), None

    out = tr.translate(text)
    engine = 'argos-translate'

    # 3) 退化输出兜底：换一种断句重试，仍degenerate 则退回短语表/原样
    if is_degenerate(out):
        retry = tr.translate(text.rstrip('.!?。！？') + ', please.')
        if not is_degenerate(retry):
            out, engine = retry, 'argos-translate(retry)'
            # 重试时注入的 ", please." 会残留在译文里（如 "我今天很累,请。"）。
            # 只有当用户原文本身不含 please/请 时，才把该痕迹判为脚手架并清除。
            if src == 'en' and tgt == 'zh' and not re.search(r'\bplease\b|请', text, re.I):
                out = strip_scaffold(out)
        elif src == 'en':
            hit = GLOSSARY_EN_ZH.get(norm_text(text))
            if hit:
                out, engine = hit, 'glossary'

    # 4) 相邻重复段折叠（模型偶尔在非退化判定边界吐出重复片段）
    out = collapse_repeats(out)
    return out, None, engine


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == '/health':
            langs = argostranslate.translate.get_installed_languages()
            installed = [l.code for l in langs]
            # translations_to 里混有 IdentityTranslation（lang->lang 自身映射），需过滤
            pairs = sorted({'%s->%s' % (t.from_lang.code, t.to_lang.code)
                            for l in langs for t in l.translations_to
                            if t.from_lang.code != t.to_lang.code})
            self._json({'ok': True, 'engine': 'argos-translate',
                        'languages': installed, 'pairs': pairs})
            return
        if u.path not in ('/translate', '/'):
            self._json({'error': 'not found'}, 404)
            return
        qs = urllib.parse.parse_qs(u.query)
        text = (qs.get('text') or [''])[0]
        langpair = (qs.get('langpair') or ['en|zh-CN'])[0]
        if not text:
            self._json({'error': 'missing text'}, 400)
            return
        out, err, engine = do_translate(text, langpair)
        if err:
            self._json({'error': err}, 501)
            return
        self._json({'translatedText': out, 'engine': engine})

    def log_message(self, fmt, *args):
        sys.stderr.write('[translate-api] %s\n' % (fmt % args))


if __name__ == '__main__':
    print('译词通自建翻译引擎: http://localhost:%d/translate' % PORT)
    print('健康检查: http://localhost:%d/health' % PORT)
    HTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
