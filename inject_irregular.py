# -*- coding: utf-8 -*-
"""注入不规则动词的过去式/过去分词，释义复用原形（保持一词多义）。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DICT = os.path.join(HERE, 'dict.js')

# 常见不规则动词：原形 -> [过去式, 过去分词]
IRREGULAR = {
    'be': ['was', 'were', 'been'],
    'have': ['had', 'has'],
    'do': ['did', 'done'],
    'go': ['went', 'gone'],
    'come': ['came'],
    'make': ['made'],
    'say': ['said'],
    'see': ['saw', 'seen'],
    'take': ['took', 'taken'],
    'know': ['knew', 'known'],
    'tell': ['told'],
    'run': ['ran'],
    'sit': ['sat'],
    'stand': ['stood'],
    'pay': ['paid'],
    'meet': ['met'],
    'buy': ['bought'],
    'build': ['built'],
    'fall': ['fell', 'fallen'],
    'send': ['sent'],
    'spend': ['spent'],
    'grow': ['grew', 'grown'],
    'win': ['won'],
    'lead': ['led'],
    'write': ['wrote', 'written'],
    'speak': ['spoke', 'spoken'],
    'hear': ['heard'],
    'bring': ['brought'],
    'hold': ['held'],
    'find': ['found'],
    'leave': ['left'],
    'begin': ['began', 'begun'],
    'think': ['thought'],
    'eat': ['ate', 'eaten'],
    'drink': ['drank', 'drunk'],
    'give': ['gave', 'given'],
    'get': ['got', 'gotten'],
    'feel': ['felt'],
    'keep': ['kept'],
    'sleep': ['slept'],
    'read': ['read'],
    'put': ['put'],
    'let': ['let'],
    'set': ['set'],
    'cut': ['cut'],
    'hit': ['hit'],
    'lose': ['lost'],
    'choose': ['chose', 'chosen'],
    'drive': ['drove', 'driven'],
    'ride': ['rode', 'ridden'],
    'break': ['broke', 'broken'],
    'speak': ['spoke', 'spoken'],
    'teach': ['taught'],
    'catch': ['caught'],
    'fight': ['fought'],
    'throw': ['threw', 'thrown'],
    'wear': ['wore', 'worn'],
    'swim': ['swam', 'swum'],
    'fly': ['flew', 'flown'],
    'sing': ['sang', 'sung'],
    'ring': ['rang', 'rung'],
    'sell': ['sold'],
    'understand': ['understood'],
    'become': ['became', 'become'],
    'forget': ['forgot', 'forgotten'],
    'forgive': ['forgave', 'forgiven'],
    'hide': ['hid', 'hidden'],
    'rise': ['rose', 'risen'],
    'wake': ['woke', 'woken'],
    'blow': ['blew', 'blown'],
    'draw': ['drew', 'drawn'],
    'grow': ['grew', 'grown'],
    'shake': ['shook', 'shaken'],
    'steal': ['stole', 'stolen'],
    'swear': ['swore', 'sworn'],
    'tear': ['tore', 'torn'],
    'mean': ['meant'],
    'lend': ['lent'],
    'shoot': ['shot'],
    'shut': ['shut'],
    'stick': ['stuck'],
    'sweep': ['swept'],
    'weep': ['wept'],
    'bend': ['bent'],
    'burn': ['burnt', 'burned'],
    'dream': ['dreamt', 'dreamed'],
    'hang': ['hung'],
    'learn': ['learnt', 'learned'],
    'spell': ['spelt', 'spelled'],
    'lie': ['lay', 'lain'],
}


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


with open(DICT, encoding='utf-8') as f:
    text = f.read()

entries = dict(re.findall(r"'([^']+)'\s*:\s*'([^']*)'", text))

to_add = []
for base, forms in IRREGULAR.items():
    base_tr = entries.get(base)
    if not base_tr:
        print('  原形缺失，跳过:', base)
        continue
    for f in forms:
        if f in entries:
            continue
        # 复用原形释义（过去式/过去分词的含义就是原形）
        to_add.append((f, base_tr))

print('需注入 %d 条不规则动词形式' % len(to_add))

# 插入到 dict.js
marker = 'var OXFORD_DICT = {\n'
idx = text.index(marker) + len(marker)
lines = ["'%s':'%s',\n" % (js_quote(k), js_quote(v)) for k, v in to_add]
text = text[:idx] + ''.join(lines) + text[idx:]

with open(DICT, 'w', encoding='utf-8') as f:
    f.write(text)
print('注入完成')
