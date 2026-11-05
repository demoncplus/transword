# -*- coding: utf-8 -*-
"""向 dict.js 补充常用词（chinese 等词典缺口词条）。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))

# 常用词缺口补充（人工校对释义，多义完整）
MISSING_WORDS = {
    'chinese': '中国的，中国人的，汉语的，中国人，中文，汉语',
    'china': '中国，瓷器',
    'chinese name': '中文名字',
    'english': '英国的，英国人的，英语的，英语，英国人',
    'japanese': '日本的，日本人的，日语的，日语，日本人',
    'french': '法国的，法国人的，法语的，法语，法国人',
    'german': '德国的，德国人的，德语的，德语，德国人',
    'korean': '韩国的，韩国人的，韩语的，韩语，韩国人',
    'spanish': '西班牙的，西班牙人的，西班牙语的，西班牙语，西班牙人',
    'russian': '俄国的，俄国人的，俄语的，俄语，俄国人',
}


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def inject(path, words):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    marker = 'var OXFORD_DICT = {\n'
    idx = text.index(marker) + len(marker)
    lines = []
    for k, v in words.items():
        # 跳过已存在的词条
        if re.search(r"'%s'\s*:" % re.escape(k), text):
            print('  已存在，跳过:', k)
            continue
        lines.append("'%s':'%s',\n" % (js_quote(k), js_quote(v)))
    text = text[:idx] + ''.join(lines) + text[idx:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('%s 注入 %d 条' % (path, len(lines)))


inject(os.path.join(HERE, 'dict.js'), MISSING_WORDS)
print('完成')
