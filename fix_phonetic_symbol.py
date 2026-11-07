# -*- coding: utf-8 -*-
"""清理音标里残留的反斜杠（把 '\\+ɜ:' 统一成 'ɜ:'），并复查所有音标。"""
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

P = r'C:\Users\Grasp By Step\Documents\deepseek-harness\default-workspace\transword\dict.js'
BS = chr(92)

with open(P, encoding='utf-8') as f:
    d = f.read()

# 任意数量的反斜杠 + ɜ: → ɜ:
pat = re.compile(re.escape(BS) + r'+ɜ:')
n = len(pat.findall(d))
print('清理反斜杠+ɜ: %d 处' % n)
if n:
    d = pat.sub('ɜ:', d)
    with open(P, 'w', encoding='utf-8') as f:
        f.write(d)
    print('已清理')

# 复查：文件里还有哪些"反斜杠+非引号"的可疑组合
left = re.findall(re.escape(BS) + r'+([^' + "'" + r'])', d)
from collections import Counter
print('剩余反斜杠后跟字符统计:', Counter(left).most_common(6))
