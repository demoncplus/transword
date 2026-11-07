# -*- coding: utf-8 -*-
"""补齐汉英词典缺失的常用中文词 + 修正质量不佳的词条。"""
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
CN = os.path.join(HERE, 'cn-dict.js')
EN = os.path.join(HERE, 'dict.js')

# 缺失的常用中文词（人工校对英文）
ZH_NEW = {
    '睡觉': 'sleep;go to bed',
    '喝水': 'drink water',
    '上班': 'go to work',
    '出差': 'go on a business trip',
    '迟到': 'be late',
    '早退': 'leave early',
    '合同': 'contract',
    '微信': 'WeChat',
    '鼠标': 'mouse',
    '账号': 'account',
    '下载': 'download',
    '上传': 'upload',
    '点击': 'click',
    '缓存': 'cache',
    '硬盘': 'hard disk',
    '充电': 'charge',
    '摄像头': 'camera',
    '微波炉': 'microwave oven',
    '热水器': 'water heater',
    '洗发水': 'shampoo',
    '牙膏': 'toothpaste',
    '被子': 'quilt',
    '手套': 'gloves',
    '行李箱': 'suitcase',
    '签证': 'visa',
    '机票': 'plane ticket',
    '登机牌': 'boarding pass',
    '退房': 'check out',
    '点餐': 'order food',
    '结账': 'pay the bill',
    '辣': 'spicy',
    '咸': 'salty',
    '甜': 'sweet',
    '苦': 'bitter',
    '咳嗽': 'cough',
    '头疼': 'headache',
    '打针': 'get an injection',
    '体检': 'physical examination',
    '羽毛球': 'badminton',
    '健身': 'work out',
    '爬山': 'go hiking',
    '春节': 'Spring Festival',
    '中秋': 'Mid-Autumn Festival',
    '国庆': 'National Day',
    '生词本': 'vocabulary book',
    '尺子': 'ruler',
    '课桌': 'desk',
    # 顺手补的常见词
    '洗澡': 'take a shower',
    '刷牙': 'brush teeth',
    '做饭': 'cook',
    '洗碗': 'wash dishes',
    '扫地': 'sweep the floor',
    '遛狗': 'walk the dog',
    '加班费': 'overtime pay',
    '工资单': 'payroll',
    '会议室': 'meeting room',
    '电梯': 'elevator',
    '行李箱密码': 'suitcase code',
    '插座': 'socket',
    '充电宝': 'power bank',
    '截图': 'screenshot',
    '打印机': 'printer',
    '耳机': 'headphones',
    '空调': 'air conditioner',
    '洗衣机': 'washing machine',
    '冰箱': 'refrigerator',
}

# 质量不佳需修正的词条
ZH_FIX = {
    '洗手间': 'bathroom;restroom;toilet',
    '厕所': 'toilet;bathroom',
}

# 英汉词典补充
EN_NEW = {
    'catalogue': "ph:'kætәlɒg;;n. 目录, 目录册, 大学概况手册;;vt. 编目",
    'aluminum': "ph:ә'lju:minәm;;n. 铝",
    'sleep': "ph:sli:p;;n. 睡眠, 睡觉, 冬眠;;vi. 睡眠, 睡觉;;vt. 睡",
}


def js_quote(s, q="'"):
    s = s.replace('\\', '\\\\')
    return s.replace(q, '\\' + q)


def patch(path, new_items, fix_items, pattern, marker, quote):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    existing = dict(re.findall(pattern, text))
    added = []
    for k, v in new_items.items():
        if k not in existing:
            added.append((k, v))
    # 修正已有词条（用正则精确替换该键的值）
    fixed = 0
    for k, v in fix_items.items():
        if k in existing:
            old_pat = quote + re.escape(js_quote(k, quote)) + quote + r'\s*:\s*' + quote + r'((?:[^' + quote + r'\\]|\\.)*)' + quote
            new_s = quote + js_quote(k, quote) + quote + ':' + quote + js_quote(v, quote) + quote
            text2, n = re.subn(old_pat, new_s, text, count=1)
            if n:
                text = text2
                fixed += 1
    if added:
        idx = text.index(marker) + len(marker)
        lines = ["%s%s%s:%s%s%s,\n" % (quote, js_quote(k, quote), quote, quote, js_quote(v, quote), quote)
                 for k, v in added]
        text = text[:idx] + ''.join(lines) + text[idx:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('%s: 新增 %d 条, 修正 %d 条' % (os.path.basename(path), len(added), fixed))


patch(CN, ZH_NEW, ZH_FIX,
      r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"',
      'var CN_DICT = {\n', '"')
patch(EN, EN_NEW, {},
      r"'((?:[^'\\]|\\.)*)'\s*:\s*'((?:[^'\\]|\\.)*)'",
      'var OXFORD_DICT = {\n', "'")
print('完成')
