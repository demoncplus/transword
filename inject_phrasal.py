# -*- coding: utf-8 -*-
"""注入高频短语动词/常用搭配到 dict.js（已存在的词条自动跳过）。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
DICT = os.path.join(HERE, 'dict.js')

PHRASES = {
    'get up': '起床',
    'give up': '放弃',
    'look for': '寻找',
    'look up': '查阅；抬头看',
    'look after': '照顾',
    'look at': '看',
    'listen to': '听',
    'laugh at': '嘲笑',
    'wait for': '等待',
    'ask for': '要求；请求',
    'pay for': '付款',
    'turn on': '打开',
    'turn off': '关闭',
    'turn up': '出现；调大',
    'turn down': '调小；拒绝',
    'turn around': '转身',
    'pick up': '捡起；接（人）',
    'put on': '穿上',
    'put down': '放下',
    'put away': '收好',
    'take off': '脱下；起飞',
    'take away': '拿走',
    'try on': '试穿',
    'come back': '回来',
    'come in': '进来',
    'come out': '出来；出版',
    'come up': '走近；发生',
    'go on': '继续',
    'go out': '外出',
    'find out': '查明',
    'point out': '指出',
    'set up': '建立；安装',
    'wake up': '醒来',
    'stand up': '起立',
    'sit down': '坐下',
    'grow up': '长大',
    'give back': '归还',
    'write down': '写下',
    'work out': '解决；算出',
    'hang up': '挂断电话',
    'fill in': '填写',
    'hand in': '上交',
    'give away': '赠送；泄露',
    'throw away': '扔掉',
    'run out': '用完',
    'run away': '逃跑',
    'catch up': '赶上',
    'keep up': '保持',
    'clean up': '打扫干净',
    'use up': '用完',
    'pay back': '偿还',
    'call back': '回电话',
    'good at': '擅长',
    'afraid of': '害怕',
    'full of': '充满',
    'instead of': '代替',
    'at once': '立刻',
    'right now': '现在',
    'just now': '刚才',
    'no longer': '不再',
    'as well': '也',
    'even if': '即使',
    'so that': '以便',
}


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


with open(DICT, encoding='utf-8') as f:
    text = f.read()

to_add = []
for k, v in PHRASES.items():
    if re.search(r"'%s'\s*:" % re.escape(k), text):
        print('  已存在，跳过:', k)
        continue
    to_add.append((k, v))

marker = 'var OXFORD_DICT = {\n'
idx = text.index(marker) + len(marker)
lines = ["'%s':'%s',\n" % (js_quote(k), js_quote(v)) for k, v in to_add]
text = text[:idx] + ''.join(lines) + text[idx:]

with open(DICT, 'w', encoding='utf-8') as f:
    f.write(text)
print('注入 %d 条短语动词/搭配' % len(to_add))
