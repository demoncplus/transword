# -*- coding: utf-8 -*-
"""诊断 dict.js 的常用词覆盖与释义质量。"""
import re

d = open('dict.js', encoding='utf-8').read()
# 提取所有词条
entries = dict(re.findall(r"'([^']+)'\s*:\s*'([^']*)'", d))

# 高频常用词清单（英语前 ~400 常用词，用于检查缺失）
TOP_WORDS = """the be to of and a in that have i it for not on with he as you do at
this but his by from they we say her she or an will my one all would there their
what so up out if about who get which go me when make can like time no just him
know take people into year your good some could them see other than then now look
only come its over think also back after use two how our work first well way even
new want because any these give day most us is are was were been has had did does
do going get got made make went came come say said see saw take took think thought
know knew find found tell told ask asked show showed try tried call called keep kept
leave left put put let let begin began help helped talk talked turn turned start started
show showed hear heard play played run ran move moved live lived believe believed
hold held bring brought happen happened write wrote sit sat stand stood lose lost
pay paid meet met include included continue continued set set learn learned change changed
lead led understand understood watch watched follow followed stop stopped create created
speak spoke read read spend spent grow grew open opened walk walked win won offer offered
remember remembered love loved consider considered appear appeared buy bought wait waited
serve served die died send sent expect expected build built stay stayed fall fell cut cut
reach reached kill killed remain remained suggest suggested raise raised pass passed
sell sold require required report reported decide decided pull pulled""".split()

missing = [w for w in TOP_WORDS if w not in entries and w != 'i']
print("高频词总数:", len(TOP_WORDS))
print("缺失的高频词:", missing if missing else "无")

# 检查释义是否"一词多义"（逗号/分号分隔的义项数）
single_sense = []
for w in ['make','get','take','run','set','play','work','light','like','right',
          'book','bank','date','spring','mean','fine','draw','stand','close','present']:
    if w in entries:
        v = entries[w]
        senses = re.split(r'[，,；;]', v)
        senses = [s for s in senses if s.strip()]
        if len(senses) <= 1:
            single_sense.append(w)
print("多义检查中只有一个义项的词:", single_sense if single_sense else "无")

# 抽查几个多义词的释义
print("\n--- 抽查多义词释义 ---")
for w in ['make','get','run','light','book','right','mean','spring']:
    print("  %-8s => %s" % (w, entries.get(w, '【缺失】')))
