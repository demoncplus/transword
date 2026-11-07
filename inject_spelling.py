# -*- coding: utf-8 -*-
"""补齐英式/美式拼写变体：显式词表，避免 -ise→-ize 之类的规则误伤（wise≠wize）。

只补「对应词条已存在、本身缺失」的变体，释义/音标直接复用（拼写变体读音相同）。
"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DICT = os.path.join(HERE, 'dict.js')

# (目标词, 来源词) —— 目标缺失时用来源的释义补齐
PAIRS = [
    # -re / -er
    ('center', 'centre'), ('meter', 'metre'), ('liter', 'litre'), ('theater', 'theatre'),
    ('fiber', 'fibre'), ('caliber', 'calibre'), ('somber', 'sombre'), ('specter', 'spectre'),
    ('maneuver', 'manoeuvre'), ('luster', 'lustre'),
    # -ce / -se
    ('defense', 'defence'), ('offense', 'offence'), ('pretense', 'pretence'),
    ('license', 'licence'),
    # -ize / -ise
    ('organize', 'organise'), ('realize', 'realise'), ('analyze', 'analyse'),
    ('recognize', 'recognise'), ('apologize', 'apologise'), ('authorize', 'authorise'),
    ('criticize', 'criticise'), ('emphasize', 'emphasise'), ('memorize', 'memorise'),
    ('normalize', 'normalise'), ('optimize', 'optimise'), ('summarize', 'summarise'),
    ('specialize', 'specialise'), ('standardize', 'standardise'), ('symbolize', 'symbolise'),
    ('utilize', 'utilise'), ('civilize', 'civilise'), ('modernize', 'modernise'),
    ('popularize', 'popularise'), ('industrialize', 'industrialise'),
    # -or / -our
    ('honor', 'honour'), ('labor', 'labour'), ('neighbor', 'neighbour'),
    ('behavior', 'behaviour'), ('humor', 'humour'), ('rumor', 'rumour'),
    ('flavor', 'flavour'), ('armor', 'armour'), ('endeavor', 'endeavour'),
    ('harbor', 'harbour'), ('vapor', 'vapour'), ('odor', 'odour'),
    ('vigor', 'vigour'), ('savor', 'savour'), ('tumor', 'tumour'),
    ('valor', 'valour'), ('splendor', 'splendour'), ('rigor', 'rigour'),
    # -og / -ogue
    ('catalog', 'catalogue'), ('dialog', 'dialogue'), ('analog', 'analogue'),
    # 其他常见
    ('traveler', 'traveller'), ('canceled', 'cancelled'), ('modeling', 'modelling'),
    ('jewelry', 'jewellery'), ('gray', 'grey'),
    ('plow', 'plough'), ('skeptical', 'sceptical'), ('program', 'programme'),
    ('aluminum', 'aluminium'),
]


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


with open(DICT, encoding='utf-8') as f:
    text = f.read()
entries = dict(re.findall(r"'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'", text))

to_add = []
skipped = []
for target, source in PAIRS:
    target = target.strip()
    if target in entries:
        continue
    if source not in entries:
        skipped.append('%s<-%s(来源缺失)' % (target, source))
        continue
    to_add.append((target, entries[source]))

print('补齐 %d 条拼写变体' % len(to_add))
if skipped:
    print('  跳过:', ', '.join(skipped[:8]))

if to_add:
    marker = 'var OXFORD_DICT = {\n'
    idx = text.index(marker) + len(marker)
    lines = ["'%s':'%s',\n" % (js_quote(k), js_quote(v)) for k, v in to_add]
    text = text[:idx] + ''.join(lines) + text[idx:]
    with open(DICT, 'w', encoding='utf-8') as f:
        f.write(text)
    print('已写回 dict.js')
