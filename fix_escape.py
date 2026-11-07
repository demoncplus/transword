# -*- coding: utf-8 -*-
"""修复 dict.js 中二次转义的音标（三反斜杠+引号 → 一反斜杠+引号）。

根因：inject_spelling.py 从源词条读取时，值里已含 反斜杠+引号 的转义文本，
又整体 js_quote 转义了一次，导致运行时的音标多出一个反斜杠（如 /\\'sentә/）。
"""
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

P = r'C:\Users\Grasp By Step\Documents\deepseek-harness\default-workspace\transword\dict.js'
BS = chr(92)              # 反斜杠
QUOTE = "'"

BAD = BS * 3 + QUOTE      # 三反斜杠 + 引号（文件里过度的转义）
GOOD = BS + QUOTE         # 一反斜杠 + 引号（正确的转义）

with open(P, encoding='utf-8') as f:
    d = f.read()

n = d.count(BAD)
print('发现二次转义 %d 处' % n)
if n:
    d = d.replace(BAD, GOOD)
    with open(P, 'w', encoding='utf-8') as f:
        f.write(d)
    print('已修复并写回')
else:
    print('无需修复')
