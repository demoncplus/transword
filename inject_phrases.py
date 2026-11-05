# -*- coding: utf-8 -*-
"""直接向 dict.js / cn-dict.js 注入整句短语，再重跑分片。
（因 _ecdict-sqlite-28.zip 已删，无法重跑完整构建，改为注入+重分片）"""
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))

EN_PHRASES = {
    'what time is it now': '现在几点了',
    'what day is it today': '今天星期几',
    'what is the date today': '今天几号',
    'see you next time': '下次见',
    'just a moment': '稍等一下',
    'in a minute': '马上',
    'how is the weather today': '今天天气怎么样',
    'it is raining': '下雨了',
    'it is sunny': '天气晴朗',
    'it is cold today': '今天很冷',
    'it is hot today': '今天很热',
    'it is windy': '有风',
    'i am happy': '我很开心',
    'i am sad': '我很难过',
    'i am angry': '我很生气',
    'i am worried': '我很担心',
    'i am excited': '我很兴奋',
    'i am bored': '我很无聊',
    'i am nervous': '我很紧张',
    'i am surprised': '我很惊讶',
    'i like it': '我喜欢它',
    'i love you': '我爱你',
    'i miss you': '我想你',
    'i want to go': '我想去',
    'i need help': '我需要帮助',
    'i need your help': '我需要你的帮助',
    'i have a question': '我有个问题',
    'i have to go': '我得走了',
    'i am coming': '我来了',
    'wait for me': '等等我',
    'follow me': '跟我来',
    'let me see': '让我想想',
    'i am back': '我回来了',
    'what are you doing': '你在做什么',
    'where are you going': '你去哪里',
    'when will you be back': '你什么时候回来',
    'why are you late': '你为什么迟到',
    'who are you': '你是谁',
    'what should i do': '我该怎么办',
    'what can i do for you': '我能为你做什么',
    'how do you say this in chinese': '这个用中文怎么说',
    'please tell me': '请告诉我',
    'can you show me': '你能给我看看吗',
    'could you wait a moment': '你能等一下吗',
    'please come in': '请进',
    'please sit down': '请坐',
    'open the door': '开门',
    'close the window': '关窗',
    'turn on the light': '开灯',
    'thank you so much': '非常感谢你',
    'sorry for the trouble': '抱歉添麻烦了',
    'no thank you': '不用了谢谢',
    'yes please': '好的谢谢',
}

ZH_PHRASES = {
    '现在几点了': 'What time is it now',
    '今天星期几': 'What day is it today',
    '今天天气怎么样': 'How is the weather today',
    '下雨了': 'It is raining',
    '今天很冷': 'It is cold today',
    '今天很热': 'It is hot today',
    '我很开心': 'I am happy',
    '我很难过': 'I am sad',
    '我很生气': 'I am angry',
    '我很担心': 'I am worried',
    '我很累': 'I am very tired',
    '我饿了': 'I am hungry',
    '我渴了': 'I am thirsty',
    '我喜欢': 'I like it',
    '我爱你': 'I love you',
    '我想你': 'I miss you',
    '我想去': 'I want to go',
    '我需要帮助': 'I need help',
    '我有个问题': 'I have a question',
    '我得走了': 'I have to go',
    '等等我': 'Wait for me',
    '跟我来': 'Follow me',
    '你在做什么': 'What are you doing',
    '你去哪里': 'Where are you going',
    '你是谁': 'Who are you',
    '我该怎么办': 'What should I do',
    '请告诉我': 'Please tell me',
    '请进': 'Please come in',
    '请坐': 'Please sit down',
    '开门': 'Open the door',
    '关窗': 'Close the window',
    '开灯': 'Turn on the light',
    '非常感谢': 'Thank you very much',
    '没问题': 'No problem',
}


def js_quote(s):
    return s.replace('\\', '\\\\').replace("'", "\\'")


def inject(path, var_name, phrases):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    marker = 'var %s = {\n' % var_name
    idx = text.index(marker) + len(marker)
    lines = []
    for k, v in phrases.items():
        lines.append("'%s':'%s',\n" % (js_quote(k), js_quote(v)))
    inserted = ''.join(lines)
    text = text[:idx] + inserted + text[idx:]
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    print('%s 注入 %d 条短语' % (path, len(phrases)))


inject(os.path.join(HERE, 'dict.js'), 'OXFORD_DICT', EN_PHRASES)
inject(os.path.join(HERE, 'cn-dict.js'), 'CN_DICT', ZH_PHRASES)
print('注入完成')
