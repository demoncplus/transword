# -*- coding: utf-8 -*-
"""修复 dict-enriched.js：正则解析（值可含真实换行），清理后安全重写到 dict.js。"""
import re

SRC = 'dict-enriched.js'
DST = 'dict.js'
CJK = re.compile(r'[\u4e00-\u9fff]')

text = open(SRC, encoding='utf-8').read()

# [^'\\] 可匹配真实换行：值内换行也能完整捕获，直到闭合引号
pairs = re.findall(r"'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'", text)
print('解析词条:', len(pairs))


def clean_value(v):
    v = v.replace('\r', ';;').replace('\n', ';;')
    segs = [s.strip() for s in v.split(';;')]
    out = []
    for s in segs:
        if not s:
            continue
        if s.startswith('ph:') or CJK.search(s):
            out.append(s)
        # 无中文的残段（孤立 "vt."、英文例句）丢弃
    return ';;'.join(out)


def unescape(s):
    """把文件里的转义（\\' 和 \\\\）还原成原始字符，防止二次转义。"""
    return re.sub(r'\\(.)', r'\1', s)


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


entries = []
fixed = 0
for k, v in pairs:
    k = unescape(k)
    v = unescape(v)
    if '\n' in v or '\r' in v:
        fixed += 1
    nv = clean_value(v)
    entries.append((js_quote(k), js_quote(nv) if nv else js_quote(v)))

print('修复含真实换行的值:', fixed)

head = text.split('var OXFORD_DICT = {', 1)[0] + 'var OXFORD_DICT = {\n'
body = ','.join("'%s':'%s'\n" % (k, v) for k, v in entries)
with open(DST, 'w', encoding='utf-8') as f:
    f.write(head + body + '};\n')
print('写出', DST, '词条', len(entries))
