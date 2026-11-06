# -*- coding: utf-8 -*-
"""为高频词生成规则变化形式（-ed/-ing/-s/-es）并注入 dict.js，释义复用原形。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DICT = os.path.join(HERE, 'dict.js')

with open(DICT, encoding='utf-8') as f:
    text = f.read()
entries = dict(re.findall(r"'([^']+)'\s*:\s*'([^']*)'", text))

# 高频动词/形容词/名词（其变化形式需要收录）
BASES = """ask show try call talk start live believe happen include continue
change watch follow stop create walk offer love consider appear wait serve die
stay reach kill remain suggest raise require report decide use study play open
close clean wash brush count dance smile point laugh shout whisper reply accept
add admit affect afford agree allow announce answer apologize appear apply
appreciate argue arrive avoid become behave belong boil borrow breathe burn
carry chase check claim collect compare complete connect contain copy cost
count cover cross cry damage destroy develop discover discuss divide double
dress drill drop dry earn employ encourage enter escape examine excite exercise
exist expect explain express extend fail fill fit fix float flow fold force
form gain gather gaze greet guess handle hang happen hate heal heat hire
hug hunt imagine improve introduce invent invite join jump kick kiss knock
land last lift light listen lock look lose maintain manage mark marry measure
mention mind miss mix move name need notice observe obtain occur offer order
organize own paint pass perform pick plan plant please pour practice pray
prefer prepare press prevent print produce promise protect provide publish
pull punish push qualify question race rain realize receive recognize reduce
refer reflect refuse regard regret relate relax release rely remember remove
repair repeat replace reply report rescue rest return review ride ring risk
roll rub rule rush save scare score scream search seize select separate shake
share shave shine shop shout sigh sign sin sink skate ski slap slip smell smile
smoke snatch sneeze sort sound spill spin spoil spread squeeze stain stamp stare
steer step stir stretch strike stumble suck suffer supply support suppose surprise
survive swallow swear sweat sweep swim swing tackle taste tear telephone tend
test thank thaw think throw tick tie tighten tip tire touch tour tow track trade
train transfer transform transport travel treat tremble trick trip trust tuck tug
tumble turn twist type undo unite unlock unpack untie update urge use vanish vary
verify visit vote waken wander waste wave weed weep wet whip whisper widen wink
wipe wish wonder work worry wrap wreck yell zip zoom""".split()

def variants(base):
    out = []
    # -ed / -ing 规则拼接
    if base.endswith('e'):
        out.append(base + 'd')            # love -> loved
        out.append(base[:-1] + 'ing')     # love -> loving
    elif len(base) >= 3 and base[-1] not in 'aeiouwxy' and base[-2] in 'aeiou' and base[-3] not in 'aeiou':
        out.append(base + base[-1] + 'ed')    # stop -> stopped
        out.append(base + base[-1] + 'ing')   # stop -> stopping
    else:
        out.append(base + 'ed')
        if base.endswith('y') and len(base) >= 3 and base[-2] not in 'aeiou':
            out.append(base[:-1] + 'ied')     # cry -> cried
        else:
            out.append(base + 'ing')
    # 复数/第三人称
    if base.endswith(('s', 'x', 'z', 'ch', 'sh')):
        out.append(base + 'es')
    elif base.endswith('y') and len(base) >= 3 and base[-2] not in 'aeiou':
        out.append(base[:-1] + 'ies')
    else:
        out.append(base + 's')
    return out

to_add = []
seen = set()
for base in BASES:
    tr = entries.get(base)
    if not tr:
        continue
    for v in variants(base):
        if v in entries or v in seen or v == base:
            continue
        seen.add(v)
        to_add.append((v, tr))

print('需注入 %d 条规则变化形式' % len(to_add))

marker = 'var OXFORD_DICT = {\n'
idx = text.index(marker) + len(marker)
lines = ["'%s':'%s',\n" % (k.replace('\\','\\\\').replace("'","\\'"), v.replace('\\','\\\\').replace("'","\\'")) for k, v in to_add]
text = text[:idx] + ''.join(lines) + text[idx:]

with open(DICT, 'w', encoding='utf-8') as f:
    f.write(text)
print('注入完成')
