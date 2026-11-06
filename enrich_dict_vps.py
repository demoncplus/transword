# -*- coding: utf-8 -*-
"""在 VPS 上运行：用 ECDICT 给 dict.js 富化音标+词性结构。
输出格式：值 = "ph:音标;;n.义项1;;v.义项2"（无 ;; 的保持原样，完全向后兼容）。
"""
import re
import sqlite3
import sys
import zipfile

DICT_IN = sys.argv[1]      # 本地传上来的 dict.js
DICT_OUT = sys.argv[2]     # 富化后的 dict.js
DB_ZIP = '/tmp/ecdict.zip'

POS_LINE = re.compile(r'^[a-z]{1,5}\.')
CJK = re.compile(r'[\u4e00-\u9fff]')

# ---------- 读入当前词典（保持顺序） ----------
text = open(DICT_IN, encoding='utf-8').read()
pairs = re.findall(r"'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'", text)
print('当前词条数:', len(pairs))

# ---------- 解压并扫描 ECDICT ----------
with zipfile.ZipFile(DB_ZIP) as z:
    names = [n for n in z.namelist() if n.lower().endswith('.db')]
    assert names, 'zip 里没有 .db'
    with z.open(names[0]) as src, open('/tmp/stardict.db', 'wb') as dst:
        while True:
            chunk = src.read(1 << 20)
            if not chunk:
                break
            dst.write(chunk)
print('db 解压完成')

need = set()
for k, _ in pairs:
    kk = k.replace("\\'", "'")
    need.add(kk.lower())

have = {}
conn = sqlite3.connect('/tmp/stardict.db')
cur = conn.cursor()
cur.execute('SELECT word, translation, phonetic FROM stardict')
scanned = 0
for word, trans, ph in cur:
    scanned += 1
    lw = (word or '').lower()
    if lw in need and lw not in have:
        have[lw] = (trans or '', ph or '')
    if scanned % 500000 == 0:
        print('  扫描 %dM 行' % (scanned // 1000000))
conn.close()
print('ECDICT 命中 %d / %d' % (len(have), len(need)))


def clean_translation(raw):
    """拆行、保留词性行、截断控制体积。"""
    # 同时清掉真实换行/回车（ECDICT 数据混杂两种分隔），防止写坏 JS 字符串
    raw = (raw or '').replace('\r', '\\n').replace('\n', '\\n')
    lines = []
    for ln in (raw or '').split('\\n'):
        ln = ln.replace('\\r', '').strip()
        if not ln or not CJK.search(ln):
            continue
        if not POS_LINE.match(ln):
            continue          # 只要带词性标签的行（保证结构一致）
        if len(ln) > 60:
            ln = ln[:60]
        lines.append(ln)
        if len(lines) >= 5:
            break
    return lines


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


out_lines = []
enriched = 0
for k, v in pairs:
    kk = k.replace("\\'", "'")
    hit = have.get(kk.lower())
    if hit:
        trans, ph = hit
        parts = clean_translation(trans)
        ph = ph.strip().strip('/').replace('\n', '').replace('\r', '')
        if parts and ph:
            val = 'ph:%s;;%s' % (ph, ';;'.join(parts))
            if val != v:
                enriched += 1
            out_lines.append((k, js_quote(val)))
            continue
    out_lines.append((k, v))   # 保持原值

# ---------- 写出（保留头部注释） ----------
head = text.split('var OXFORD_DICT = {', 1)[0] + 'var OXFORD_DICT = {\n'
body = ','.join("'%s':'%s'\n" % (k, v) for k, v in out_lines)
with open(DICT_OUT, 'w', encoding='utf-8') as f:
    f.write(head + body + '};\n')
print('富化 %d 条 -> %s' % (enriched, DICT_OUT))
