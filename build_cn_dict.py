# -*- coding: utf-8 -*-
"""从 ECDICT 反向索引重建汉英词典 cn-dict.js

背景：原 cn-dict.js 只有 813 条，用户查「备用」时离线汉译英命中不了，
输出中英混杂的「备 use」。本脚本把 ECDICT 的英文释义反转成
「中文义项 → 英文单词」索引，把汉英词典扩充到数万条。

质量策略：
  1. 只取常用英文词（有词频/BNC/牛津/柯林斯标记的），避免生僻词污染
  2. 义项去词性标签、去领域标签；只保留纯中文、长度 1-6 的义项
  3. 义项多义时按"常用度"排序，取前 N 个候选，用 ; 连接
  4. 后缀归一：ECDICT 释义常写「备用的」而用户输入「备用」，
     故为「X的/X地/X得」形态生成去掉后缀的变体键
  5. 短词优先、去除脏义项（含括号/见/同/缩写/俚/俗等）

运行: python build_cn_dict.py
输出: cn-dict.js  → 全局 CN_DICT（app.js 无需改动）
"""
import os
import re
import sqlite3
import zipfile
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
ZIP = os.path.join(HERE, '_ecdict-sqlite-28.zip')
DB = os.path.join(HERE, '_ecdict.db')
OUT = os.path.join(HERE, 'cn-dict.js')
MANUAL = os.path.join(HERE, '_cn-dict-manual.bak.js')   # 原人工精选词条（优先保留）

MAX_ENTRIES = 60000      # 控制文件体积（约 1.5-2 MB，离线 PWA 可接受）
MAX_CANDIDATES = 3       # 每个中文键最多保留几个英文候选
MAX_WORD_LEN = 20        # 候选英文词长度上限


def load_manual():
    """读出原人工词条，构建时优先级最高（人工校对优于机器反查）"""
    path = MANUAL if os.path.exists(MANUAL) else OUT
    if not os.path.exists(path):
        return {}
    text = open(path, encoding='utf-8').read()
    m = re.search(r'var\s+CN_DICT\s*=\s*\{([\s\S]*)\};', text)
    if not m:
        return {}
    out = {}
    for k, v in re.findall(r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"', m.group(1)):
        out[k.replace('\\"', '"')] = v.replace('\\"', '"')
    return out

# 解压数据库（首次运行）
if not os.path.exists(DB):
    if not os.path.exists(ZIP):
        raise SystemExit('缺少 _ecdict-sqlite-28.zip，无法构建')
    print('extracting sqlite...')
    with zipfile.ZipFile(ZIP) as z:
        for n in z.namelist():
            if n.lower().endswith('.db'):
                with z.open(n) as src, open(DB, 'wb') as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
                break
        else:
            raise SystemExit('no .db inside zip')

conn = sqlite3.connect(DB)
cur = conn.cursor()

POS_RE = re.compile(r'(?<![A-Za-z])'
                    r'(?:n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|num|int|interj|art|aux|abbr|pl)\.\s*')
TAG_RE = re.compile(r'\[[^\]]{0,8}\]')
SPLIT_RE = re.compile(r'[，,、;；/|]+')
CJK_RE = re.compile(r'[\u4e00-\u9fff]')
ASCII_RE = re.compile(r'[A-Za-z]')
# 脏义项：释义说明、参见、缩略语、口语/俚语标记、省略号等
DIRTY_RE = re.compile(r'[（()）]|见|同|缩写|略|俚|俗|古|废|＝|=|…|\.\.\.|^某|^之')
EN_WORD_RE = re.compile(r"[a-zA-Z][a-zA-Z' -]*")

TAG_BONUS = {'zk': 30, 'gk': 25, 'cet4': 18, 'cet6': 14,
             'ky': 10, 'toefl': 8, 'ielts': 8, 'gre': 4}


def score(c):
    """候选英文词的常用度得分，越高越可能是一般的对应词"""
    s = 0
    if c['ox']:
        s += 100
    s += c['co'] * 18
    if c['frq']:
        s += max(0.0, 60 - c['frq'] / 100.0)
    if c['bnc']:
        s += max(0.0, 40 - c['bnc'] / 100.0)
    for t in c['tag']:
        s += TAG_BONUS.get(t, 0)
    s += max(0, 12 - len(c['w']))          # 短词更可能是基础词
    s -= c['w'].count(' ') * 3             # 轻微抑制多词短语
    return s


print('扫描 ECDICT 常用词...')
cur.execute("""SELECT word, translation, frq, collins, oxford, tag, bnc
               FROM stardict
               WHERE translation IS NOT NULL AND translation != ''
                 AND (frq > 0 OR bnc > 0 OR oxford = 1
                      OR (collins IS NOT NULL AND collins > 0))""")

idx = collections.defaultdict(list)
scanned = 0
for word, trans, frq, collins, oxford, tag, bnc in cur.fetchall():
    scanned += 1
    if not word or len(word) > MAX_WORD_LEN or not EN_WORD_RE.fullmatch(word):
        continue
    cleaned = TAG_RE.sub('', POS_RE.sub('', trans or ''))
    for sense in SPLIT_RE.split(cleaned):
        sense = re.sub(r'\s+', '', sense.strip())
        if not sense or len(sense) > 6:
            continue
        if not CJK_RE.search(sense) or ASCII_RE.search(sense) or DIRTY_RE.search(sense):
            continue
        idx[sense].append({
            'w': word, 'frq': frq or 0, 'bnc': bnc or 0,
            'co': collins or 0, 'ox': oxford or 0,
            'tag': (tag or '').split(),
        })

print('  扫描 %d 个英文词，得到 %d 个中文键' % (scanned, len(idx)))

# 后缀归一：为「…的/地/得」义项补一个去掉后缀的变体键。
# 例：ECDICT 有「备用的」→ 用户输入「备用」也应命中。
variant_added = 0
for key in list(idx.keys()):
    if len(key) >= 3 and key[-1] in '的地得':
        base = key[:-1]
        if base not in idx and len(base) >= 2:
            idx[base] = list(idx[key])
            variant_added += 1
print('  后缀归一新增变体键: %d' % variant_added)

print('挑选前 %d 个高质量中文键...' % MAX_ENTRIES)
ranked = sorted(idx.items(), key=lambda kv: -max(score(c) for c in kv[1]))
ranked = ranked[:MAX_ENTRIES]

entries = {}
for key, cands in ranked:
    # 同一英文词去重后按得分排序
    best = sorted({c['w']: c for c in cands}.values(), key=score, reverse=True)
    words = []
    for c in best:
        if c['w'] not in words:
            words.append(c['w'])
        if len(words) >= MAX_CANDIDATES:
            break
    if words:
        entries[key] = ';'.join(words)

# 人工词条覆盖机器结果（人工校对更准，如「我」→I 而非机器反查的 me）
manual = load_manual()
overridden = 0
for k, v in manual.items():
    if entries.get(k) != v:
        if k in entries:
            overridden += 1
    entries[k] = v
print('  人工词条 %d 条已并入（覆盖机器结果 %d 条）' % (len(manual), overridden))

print('  最终条目: %d' % len(entries))

# 抽查
probe = ['备用', '电影', '知识', '学习', '洗手间', '手机', '电脑', '翻译', '词典',
         '你好', '早上好', '谢谢', '美丽', '乐趣', '我', '你', '是', '有', '看', '吃']
print('\n--- 抽查 ---')
for p in probe:
    print('  %-6s => %s' % (p, entries.get(p, '【仍缺失】')))

with open(OUT, 'w', encoding='utf-8') as f:
    f.write('// 汉英词典（由 build_cn_dict.py 从 ECDICT 反向索引生成，请勿手改）\n')
    f.write('// 条目数: %d\n' % len(entries))
    f.write('var CN_DICT = ')
    f.write('{\n')
    items = list(entries.items())
    for i, (k, v) in enumerate(items):
        kk = k.replace('\\', '\\\\').replace('"', '\\"')
        vv = v.replace('\\', '\\\\').replace('"', '\\"')
        f.write('"%s":"%s"' % (kk, vv))
        f.write(',\n' if i + 1 < len(items) else '\n')
    f.write('};\n')

size = os.path.getsize(OUT)
print('\n已写出 %s  (%.2f MB)' % (OUT, size / 1048576.0))
conn.close()
