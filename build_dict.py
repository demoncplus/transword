# -*- coding: utf-8 -*-
"""从 ECDICT SQLite 重建译词通的离线词典 dict.js 和引擎短语表 glossary.json

策略（自动按分数筛短语会选出 "action centre 机械设计通用计算机" 这类技术搭配，
所以短语改用人工精选清单）：
  1. 按词频(bnc+frq)取高频单词 20000 条
  2. 牛津核心词 + 柯林斯 3 星以上词 3938 条（补词频字段缺失的常用词）
  3. 基础语法词/最高频实词强制保底（need / food / school 等）
  4. 精选常用短语 193 条（问候/礼貌/日常套话），译文优先人工校对版
  5. 释义统一去词性标签、去领域标签、义项去重、截断到 70 字
输出:
  dict.js      → 全局 OXFORD_DICT（变量名不变，app.js 无需改）
  glossary.json→ 自建引擎(translate-api.py)的短语精确匹配表

运行: python build_dict.py   （缺 _ecdict.db 时会自动从 zip 解压）
"""
import os
import re
import sqlite3
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ZIP = os.path.join(HERE, '_ecdict-sqlite-28.zip')
DB = os.path.join(HERE, '_ecdict.db')
OUT = os.path.join(HERE, 'dict.js')

WORD_LIMIT = 20000
PHRASE_LIMIT = 5000

# 解压数据库
if not os.path.exists(DB):
    print('extracting sqlite...')
    with zipfile.ZipFile(ZIP) as z:
        for n in z.namelist():
            if n.lower().endswith('.db'):
                print('  ', n, z.getinfo(n).file_size, 'bytes')
                with z.open(n) as src, open(DB, 'wb') as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
                break
        else:
            raise SystemExit('no .db inside zip')

conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
print('tables:', tables)
cur.execute('PRAGMA table_info(stardict)')
cols = [r[1] for r in cur.fetchall()]
print('columns:', cols)

def clean(s):
    """去掉换行/制表符，压缩空格"""
    if not s:
        return ''
    s = s.replace('\t', ' ').replace('\r', ' ').replace('\n', ' ')
    s = re.sub(r'\s+', ' ', s).strip()
    return s

POS_RE = re.compile(r'(?<![A-Za-z])(?:n|v|vt|vi|a|adj|ad|adv|prep|conj|pron|num|int|interj|art|aux|abbr|pl)\.\s*')
TAG_RE = re.compile(r'\[[^\]]{0,8}\]')

def app_format(translation, limit=70):
    """把 ECDICT 原始释义整理成适合界面显示的简洁中文：
    不同词性的义项用换行分隔，先转成逗号；去掉词性标签(n./vt./a.)和领域标签([计][医])；
    义项去重后截断长度。"""
    s = (translation or '').replace('\r', '\n')
    s = re.sub(r'\n+', ';', s)          # 词性分组边界
    s = POS_RE.sub('', s)               # 去掉 n. / vt. / a. 等
    s = TAG_RE.sub('', s)               # 去掉 [计] [医] 等领域标签
    parts = [clean(p) for p in re.split(r'[;；,，]', s)]
    out = []
    for p in parts:
        if not p or not re.search(r'[\u4e00-\u9fff]', p):
            continue
        if p in out:
            continue
        out.append(p)
        if len('，'.join(out)) >= limit:
            break
    if not out:
        return clean(translation)[:limit]
    res = '，'.join(out)
    if len(res) > limit:
        res = res[:limit].rstrip('，;；, ')
    return res

def pick(limit, phrase):
    sql = ('SELECT word, translation, definition, pos, COALESCE(bnc,0)+COALESCE(frq,0) AS freq '
           'FROM stardict WHERE translation IS NOT NULL AND translation != \'\' ')
    if phrase:
        sql += "AND word LIKE '% %' "
    else:
        sql += "AND word NOT LIKE '% %' "
    sql += 'ORDER BY freq DESC LIMIT ?'
    cur.execute(sql, (limit,))
    return cur.fetchall()

TAG_WEIGHT = {'zk': 100000, 'gk': 50000, 'cet4': 20000, 'cet6': 10000,
              'ky': 8000, 'toefl': 5000, 'ielts': 4000, 'gre': 3000}

def single_word_score():
    """单个词的常用度打分：考试大纲标记(中考/高考/四级…) > 柯林斯星级 > 牛津核心词 > 词频。
    用 tag 是因为 'are' 这类词词频字段为 0、星级也缺失，但它是高考必考词，
    单靠 collins/freq 会把 'how are you' 这类常用短语判成生僻。"""
    cur.execute('''SELECT lower(word), tag, COALESCE(collins,0) AS collins,
                          COALESCE(oxford,0) AS oxford,
                          COALESCE(bnc,0) + COALESCE(frq,0) AS freq
                   FROM stardict
                   WHERE word NOT LIKE '% %'
                     AND translation IS NOT NULL AND translation != '' ''')
    out = {}
    for w, tag, collins, oxford, freq in cur.fetchall():
        if not w:
            continue
        s = (sum(TAG_WEIGHT.get(t, 0) for t in (tag or '').split())
             + collins * 1000 + oxford * 500 + freq)
        if s > 0:
            out[w] = s
    return out

def pick_phrases(token_score, limit):
    """短语：组成词都必须是常用词，且不超过 4 个词、26 字符。
    排序用组成词打分的「最小值」（保证每个词都常用），并优先收录更短的固定表达，
    避免长短语（含 the/a/of/you 等高打分虚词）把 good morning 这类短问候语挤掉。"""
    cur.execute('''SELECT word, translation, definition, pos,
                          COALESCE(bnc,0)+COALESCE(frq,0) AS freq
                   FROM stardict
                   WHERE word LIKE '% %'
                     AND translation IS NOT NULL AND translation != ''
                     AND length(word) <= 26''')
    scored = []
    for row in cur.fetchall():
        w = clean(row[0]).lower()
        toks = w.split()
        if not (2 <= len(toks) <= 4):
            continue
        if not all(re.match(r'^[a-z\']+$', t) for t in toks):
            continue
        scores = [token_score.get(t) for t in toks]
        if any(s is None for s in scores):
            continue
        # 最低词分做主轴，越短越优先；再按最高词分微调
        min_s, max_s = min(scores), max(scores)
        scored.append(((min_s, -len(toks), max_s), row))
    scored.sort(key=lambda x: x[0], reverse=True)
    print('phrase candidates: %d, taking top %d' % (len(scored), limit))
    return [row for _, row in scored[:limit]]

def pick_oxford():
    """牛津核心词 + 柯林斯高频星标词（词频字段缺失时的可靠补充）"""
    cur.execute('''SELECT word, translation, definition, pos,
                          COALESCE(bnc,0)+COALESCE(frq,0) AS freq
                   FROM stardict
                   WHERE translation IS NOT NULL AND translation != ''
                     AND word NOT LIKE '% %'
                     AND (oxford = 1 OR collins >= 3)
                   ORDER BY collins DESC, freq DESC''')
    return cur.fetchall()

entries = {}
glossary = {}
def add(rows, tag, require_tokens=None):
    added = 0
    for word, translation, definition, pos, freq in rows:
        word = clean(word).lower()
        if not word or not re.match(r"^[a-z0-9][a-z0-9 '\\-]*$", word):
            continue
        if word in entries:
            continue
        # 短语必须是常用词组成，滤掉化学/专业长短语（如 1-amino-2-naphthol-4-sulfonic acid）
        if require_tokens is not None:
            toks = word.split()
            if not all(t in require_tokens for t in toks):
                continue
        tr = app_format(translation)
        if not tr:
            continue
        entries[word] = tr
        # 短语同时收进引擎短语表（短、准确的固定表达，优先于神经翻译）
        if ' ' in word and 2 <= len(word.split()) <= 4 and len(tr) <= 30:
            glossary[word] = tr
        added += 1
    print('%s: +%d (total %d)' % (tag, added, len(entries)))

# 基础词强制保底（词频字段可能缺失的纯语法词和最高频实词）
BASIC = ['i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
         'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours',
         'the', 'a', 'an', 'this', 'that', 'these', 'those', 'what', 'who', 'which',
         'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being', 'do', 'does', 'did',
         'have', 'has', 'had', 'will', 'would', 'shall', 'should', 'can', 'could',
         'may', 'might', 'must', 'not', 'no', 'yes', 'and', 'or', 'but', 'if', 'then',
         'so', 'because', 'as', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from',
         'by', 'about', 'into', 'over', 'after', 'before', 'between', 'under', 'up',
         'down', 'out', 'off', 'again', 'there', 'here', 'when', 'where', 'why', 'how',
         'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
         'than', 'too', 'very', 'just', 'also', 'only', 'even', 'well', 'back', 'get',
         'go', 'come', 'make', 'take', 'see', 'know', 'think', 'look', 'want', 'give',
         'find', 'tell', 'ask', 'work', 'seem', 'feel', 'try', 'leave', 'call', 'good',
         'new', 'first', 'last', 'long', 'great', 'little', 'own', 'old', 'right',
         'big', 'high', 'different', 'small', 'large', 'next', 'early', 'young',
         'important', 'public', 'bad', 'same', 'able', 'love', 'like', 'time',
         'day', 'people', 'way', 'year', 'man', 'woman', 'child', 'world', 'life',
         'hand', 'part', 'place', 'case', 'week', 'company', 'system', 'program',
         'question', 'government', 'number', 'night', 'home', 'water', 'room',
         'mother', 'father', 'money', 'story', 'fact', 'month', 'lot',
         'study', 'book', 'eye', 'job', 'word', 'business', 'issue', 'side', 'kind',
         'head', 'house', 'service', 'friend', 'power', 'hour', 'game',
         'line', 'end', 'member', 'law', 'car', 'city', 'community', 'name', 'president',
         'team', 'minute', 'idea', 'body', 'information', 'parent', 'face',
         'others', 'level', 'office', 'door', 'health', 'person', 'art', 'war', 'history',
         'party', 'result', 'change', 'morning', 'reason', 'research', 'girl', 'guy',
         'moment', 'air', 'teacher', 'force', 'education', 'today', 'tomorrow',
         'yesterday', 'afternoon', 'evening', 'please', 'thanks', 'thank',
         'hello', 'sorry', 'welcome', 'congratulations', 'goodbye',
         # 词频字段为 0 但极其常用的词（首轮重建时遗漏）
         'need', 'food', 'school', 'luck', 'beautiful', 'happy', 'sad', 'angry', 'tired',
         'hungry', 'thirsty', 'cold', 'hot', 'warm', 'cool', 'nice', 'fine', 'sure',
         'ready', 'busy', 'free', 'easy', 'hard', 'difficult', 'simple', 'quick', 'slow',
         'early', 'late', 'dear', 'kind', 'polite', 'friendly', 'clever', 'smart',
         'funny', 'interesting', 'boring', 'delicious', 'tasty', 'expensive', 'cheap',
         'eat', 'drink', 'sleep', 'wake', 'walk', 'run', 'jump', 'sit', 'stand', 'open',
         'close', 'start', 'stop', 'wait', 'help', 'play', 'sing', 'dance', 'read',
         'write', 'speak', 'listen', 'hear', 'watch', 'learn', 'teach', 'buy', 'sell',
         'pay', 'cost', 'spend', 'save', 'lose', 'win', 'send', 'receive', 'bring',
         'carry', 'put', 'keep', 'hold', 'turn', 'move', 'live', 'die', 'grow', 'build',
         'break', 'fix', 'clean', 'wash', 'cook', 'drive', 'ride', 'fly', 'swim',
         'travel', 'visit', 'meet', 'follow', 'remember', 'forget', 'understand',
         'believe', 'hope', 'wish', 'enjoy', 'hate', 'prefer', 'choose', 'decide',
         'answer', 'explain', 'describe', 'discuss', 'agree', 'disagree', 'apologize',
         'apple', 'banana', 'orange', 'bread', 'rice', 'meat', 'fish', 'egg', 'milk',
         'tea', 'coffee', 'juice', 'sugar', 'salt', 'vegetable', 'fruit', 'breakfast',
         'lunch', 'dinner', 'meal', 'weekend', 'holiday', 'vacation', 'birthday',
         'family', 'son', 'daughter', 'brother', 'sister', 'grandfather', 'grandmother',
         'uncle', 'aunt', 'cousin', 'husband', 'wife', 'boy', 'girl', 'baby', 'kid',
         'student', 'doctor', 'nurse', 'driver', 'farmer', 'worker', 'engineer',
         'police', 'soldier', 'singer', 'actor', 'artist', 'writer', 'scientist',
         'bag', 'box', 'bottle', 'cup', 'plate', 'bowl', 'knife', 'spoon', 'fork',
         'chair', 'table', 'bed', 'window', 'wall', 'floor', 'street', 'road', 'park',
         'shop', 'store', 'market', 'hospital', 'hotel', 'restaurant', 'station',
         'airport', 'library', 'museum', 'bank', 'post', 'church', 'farm', 'village',
         'country', 'nation', 'sea', 'ocean', 'river', 'lake', 'mountain', 'hill',
         'tree', 'flower', 'grass', 'leaf', 'sky', 'sun', 'moon', 'star', 'cloud',
         'rain', 'snow', 'wind', 'fire', 'earth', 'stone', 'sand', 'forest', 'animal',
         'dog', 'cat', 'bird', 'horse', 'cow', 'pig', 'sheep', 'chicken', 'duck',
         'rabbit', 'tiger', 'lion', 'monkey', 'elephant', 'bear', 'mouse', 'snake',
         'color', 'red', 'blue', 'green', 'yellow', 'black', 'white', 'brown', 'pink',
         'purple', 'gray', 'one', 'two', 'three', 'four', 'five', 'six', 'seven',
         'eight', 'nine', 'ten', 'hundred', 'thousand', 'million', 'billion',
         'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
         'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
         'september', 'october', 'november', 'december', 'spring', 'summer', 'autumn',
         'winter', 'hour', 'second', 'dollar', 'yuan', 'money', 'price', 'gift',
         'phone', 'computer', 'internet', 'email', 'message', 'letter', 'news',
         'paper', 'pen', 'pencil', 'picture', 'photo', 'music', 'song', 'movie',
         'film', 'game', 'sport', 'football', 'basketball', 'tennis', 'swimming',
         'health', 'medicine', 'hospital', 'doctor', 'head', 'hair', 'eye', 'ear',
         'nose', 'mouth', 'tooth', 'tongue', 'neck', 'shoulder', 'arm', 'finger',
         'leg', 'foot', 'heart', 'blood', 'skin', 'bone']

# ==================== 精选常用短语 ====================
# 按分数自动筛选短语只会选出 "action centre 机械设计通用计算机" 这类技术搭配，
# 因此短语改用人工精选清单（问候/礼貌/日常套话），译文从 ECDICT 自动取，
# 自动结果不理想的用 MANUAL_PHRASES 覆盖。
CURATED_PHRASES = [
    # 问候
    'good morning', 'good afternoon', 'good evening', 'good night', 'hello there',
    'how are you', 'how are you doing', 'how is it going', 'how do you do',
    "what's up", 'long time no see', 'nice to meet you', 'nice to see you',
    'glad to meet you', 'pleased to meet you', 'how have you been',
    # 告别
    'good bye', 'goodbye', 'see you', 'see you tomorrow', 'see you later',
    'see you soon', 'take care', 'have a nice day', 'have a good day',
    'have a good time', 'have a nice weekend', 'good luck', 'all the best',
    'keep in touch', 'take it easy', 'sleep well', 'sweet dreams',
    # 礼貌用语
    'thank you', 'thanks a lot', 'thank you very much', 'many thanks',
    'you are welcome', "you're welcome", 'my pleasure', 'not at all',
    'excuse me', 'i am sorry', "i'm sorry", 'sorry to bother you',
    'never mind', 'it does not matter', 'no problem', 'no worries',
    'please wait a moment', 'after you', 'go ahead', 'help yourself',
    'nice to help you', 'i appreciate it', 'congratulations',
    # 日常表达
    'of course', 'i see', 'i agree', 'i think so', 'i hope so', 'i am not sure',
    'that is right', 'that is all right', "that's all right", 'it depends',
    'by the way', 'in fact', 'as usual', 'at least', 'at first', 'at last',
    'for example', 'in general', 'in short', 'in other words', 'on purpose',
    'so far', 'not yet', 'right away', 'once again', 'as soon as possible',
    'more or less', 'a little', 'a lot of', 'lots of', 'plenty of',
    'come on', 'hold on', 'hurry up', 'calm down', 'cheer up', 'well done',
    'good job', 'good idea', 'good point', 'no idea', 'i have no idea',
    'it is my pleasure', 'be careful', 'watch out', 'look out', 'take your time',
    'make yourself at home', 'enjoy yourself', 'good for you', 'so what',
    # 请求与询问
    'may i help you', 'can i help you', 'could you help me', 'would you please',
    'what is your name', 'what is your phone number', 'where are you from',
    'how old are you', 'how much is it', 'how much does it cost',
    'what time is it', 'what do you mean', 'what happened', 'what is wrong',
    'what is the matter', 'why not', 'how about you', 'do you understand',
    'could you repeat that', 'could you speak slowly', 'say it again',
    'i do not understand', "i don't understand", 'i do not know',
    "i don't know", 'i do not speak english', 'do you speak chinese',
    'please speak slowly', 'what does this mean',
    # 出行与生活
    'excuse me where is the toilet', 'where is the toilet', 'where is the bathroom',
    'where is the train station', 'where is the bus stop', 'where is the airport',
    'how can i get there', 'how far is it', 'take me to this address',
    'turn left', 'turn right', 'go straight', 'traffic light', 'bus stop',
    'train station', 'subway station', 'taxi please', 'one way ticket',
    'round trip ticket', 'boarding pass', 'check in', 'check out',
    'i am lost', 'i am hungry', 'i am thirsty', 'i am tired', 'i am busy',
    'i am fine', 'i am ok', 'i am ready', 'i am late', 'i am sorry to hear that',
    # 餐饮购物
    'may i have the menu', 'i would like to order', 'the bill please',
    'how much', 'too expensive', 'can you make it cheaper', 'i will take it',
    'just looking', 'try it on', 'credit card', 'cash only', 'keep the change',
    'enjoy your meal', 'help yourself to', 'good appetite',
    # 工作学习
    'good luck with your exam', 'study hard', 'well done indeed',
    'keep up the good work', 'as you like', 'it is up to you',
    'in my opinion', 'i agree with you', 'i disagree', 'that makes sense',
]

# 自动取 ECDICT 译文不理想时的覆盖（保证问候语绝对正确）
MANUAL_PHRASES = {
    'good morning': '早上好',
    'good afternoon': '下午好',
    'good evening': '晚上好',
    'good night': '晚安',
    'hello there': '你好呀',
    'how are you': '你好吗',
    'how are you doing': '你最近怎么样',
    'how is it going': '最近怎么样',
    'how do you do': '你好',
    "what's up": '怎么了；最近怎样',
    'long time no see': '好久不见',
    'nice to meet you': '很高兴认识你',
    'nice to see you': '很高兴见到你',
    'glad to meet you': '很高兴见到你',
    'pleased to meet you': '很高兴认识你',
    'how have you been': '你最近好吗',
    'good bye': '再见',
    'goodbye': '再见',
    'see you': '再见',
    'see you tomorrow': '明天见',
    'see you later': '回头见',
    'see you soon': '一会儿见',
    'take care': '保重',
    'have a nice day': '祝你今天愉快',
    'have a good day': '祝你今天过得愉快',
    'have a good time': '玩得开心',
    'have a nice weekend': '周末愉快',
    'good luck': '祝你好运',
    'all the best': '万事如意',
    'keep in touch': '保持联系',
    'take it easy': '别紧张；放轻松',
    'sleep well': '睡个好觉',
    'sweet dreams': '好梦',
    'thank you': '谢谢你',
    'thanks a lot': '非常感谢',
    'thank you very much': '非常感谢你',
    'many thanks': '多谢',
    'you are welcome': '不客气',
    "you're welcome": '不客气',
    'my pleasure': '我很乐意',
    'not at all': '不用谢；一点也不',
    'excuse me': '打扰一下；对不起',
    'i am sorry': '对不起',
    "i'm sorry": '对不起',
    'sorry to bother you': '抱歉打扰你',
    'never mind': '没关系；别在意',
    'it does not matter': '没关系',
    'no problem': '没问题',
    'no worries': '别担心',
    'please wait a moment': '请稍等',
    'after you': '您先请',
    'go ahead': '请继续；你请便',
    'help yourself': '请随意（取用）',
    'nice to help you': '很高兴能帮到你',
    'i appreciate it': '我很感激',
    'congratulations': '恭喜',
    'of course': '当然',
    'i see': '我明白了',
    'i agree': '我同意',
    'i think so': '我也这么认为',
    'i hope so': '希望如此',
    'i am not sure': '我不确定',
    'that is right': '说得对',
    'that is all right': '没关系',
    "that's all right": '没关系',
    'it depends': '看情况',
    'by the way': '顺便说一句',
    'in fact': '事实上',
    'as usual': '像往常一样',
    'at least': '至少',
    'at first': '起初',
    'at last': '最后；终于',
    'for example': '例如',
    'in general': '一般来说',
    'in short': '简而言之',
    'in other words': '换句话说',
    'on purpose': '故意地',
    'so far': '到目前为止',
    'not yet': '还没有',
    'right away': '立刻',
    'once again': '再一次',
    'as soon as possible': '尽快',
    'more or less': '差不多；大约',
    'a little': '一点点',
    'a lot of': '很多',
    'lots of': '很多',
    'plenty of': '大量的',
    'come on': '来吧；加油',
    'hold on': '等一下',
    'hurry up': '快点',
    'calm down': '冷静下来',
    'cheer up': '振作起来',
    'well done': '做得好',
    'good job': '干得好',
    'good idea': '好主意',
    'good point': '说得好；有道理',
    'no idea': '不知道',
    'i have no idea': '我不知道',
    'it is my pleasure': '这是我的荣幸',
    'be careful': '小心',
    'watch out': '当心',
    'look out': '当心',
    'take your time': '慢慢来；不着急',
    'make yourself at home': '别客气，就像在自己家一样',
    'enjoy yourself': '玩得开心',
    'good for you': '你真棒；为你高兴',
    'so what': '那又怎样',
    'may i help you': '需要我帮忙吗',
    'can i help you': '我能帮你吗',
    'could you help me': '你能帮我一下吗',
    'would you please': '请你…好吗',
    'what is your name': '你叫什么名字',
    'what is your phone number': '你的电话号码是多少',
    'where are you from': '你来自哪里',
    'how old are you': '你多大了',
    'how much is it': '多少钱',
    'how much does it cost': '这个多少钱',
    'what time is it': '现在几点了',
    'what do you mean': '你是什么意思',
    'what happened': '发生什么事了',
    'what is wrong': '怎么了',
    'what is the matter': '出什么事了',
    'why not': '为什么不呢',
    'how about you': '你呢',
    'do you understand': '你明白吗',
    'could you repeat that': '你能再说一遍吗',
    'could you speak slowly': '你能说慢一点吗',
    'say it again': '再说一遍',
    'i do not understand': '我不明白',
    "i don't understand": '我不明白',
    'i do not know': '我不知道',
    "i don't know": '我不知道',
    'i do not speak english': '我不会说英语',
    'do you speak chinese': '你会说中文吗',
    'please speak slowly': '请说慢一点',
    'what does this mean': '这是什么意思',
    'excuse me where is the toilet': '请问洗手间在哪里',
    'where is the toilet': '洗手间在哪里',
    'where is the bathroom': '洗手间在哪里',
    'where is the train station': '火车站在哪里',
    'where is the bus stop': '公交车站在哪里',
    'where is the airport': '机场在哪里',
    'how can i get there': '我怎么去那里',
    'how far is it': '有多远',
    'take me to this address': '请带我去这个地址',
    'turn left': '向左转',
    'turn right': '向右转',
    'go straight': '直走',
    'traffic light': '红绿灯',
    'bus stop': '公交车站',
    'train station': '火车站',
    'subway station': '地铁站',
    'taxi please': '请叫出租车',
    'one way ticket': '单程票',
    'round trip ticket': '往返票',
    'boarding pass': '登机牌',
    'check in': '办理入住；办理登机',
    'check out': '结账退房',
    'i am lost': '我迷路了',
    'i am hungry': '我饿了',
    'i am thirsty': '我渴了',
    'i am tired': '我累了',
    'i am busy': '我很忙',
    'i am fine': '我很好',
    'i am ok': '我没事',
    'i am ready': '我准备好了',
    'i am late': '我迟到了',
    'i am sorry to hear that': '听到这个消息我很难过',
    'may i have the menu': '请给我菜单',
    'i would like to order': '我想点餐',
    'the bill please': '请结账',
    'how much': '多少钱',
    'too expensive': '太贵了',
    'can you make it cheaper': '能便宜一点吗',
    'i will take it': '我买了',
    'just looking': '只是看看',
    'try it on': '试穿一下',
    'credit card': '信用卡',
    'cash only': '只收现金',
    'keep the change': '不用找零',
    'enjoy your meal': '请慢用',
    'help yourself to': '请随意取用',
    'good appetite': '好胃口；请多吃点',
    'good luck with your exam': '祝你考试顺利',
    'study hard': '努力学习',
    'well done indeed': '确实干得漂亮',
    'keep up the good work': '继续好好干',
    'as you like': '随你喜欢',
    'it is up to you': '由你决定',
    'in my opinion': '在我看来',
    'i agree with you': '我同意你的看法',
    'i disagree': '我不同意',
    'that makes sense': '有道理',
}

# 常用词集合（供 add 的 require_tokens 使用）
common_words = None

# 单词（不含短语，避免专业搭配噪音）
add(pick(WORD_LIMIT, False), 'words')
add(pick_oxford(), 'oxford+collins core')

cur.execute("SELECT word, translation, definition, pos, 999999 FROM stardict WHERE lower(word) IN (%s)"
            % ','.join('?' * len(BASIC)), [w for w in BASIC])
add(cur.fetchall(), 'basic-words')

# 精选短语：人工译文优先，否则从 ECDICT 取（只取第一个义项）
missing_phrases = []
for p in CURATED_PHRASES:
    key = clean(p).lower()
    tr = MANUAL_PHRASES.get(key)
    if not tr:
        cur.execute('SELECT translation FROM stardict WHERE lower(word)=?', (key,))
        r = cur.fetchone()
        if r and r[0]:
            first = re.split(r'[;；,，\n]', clean(r[0]))[0].strip()
            tr = first if first and re.search(r'[\u4e00-\u9fff]', first) else None
    if not tr:
        missing_phrases.append(key)
        continue
    entries[key] = tr
    glossary[key] = tr
print('curated phrases: +%d (缺失 %d: %s)' % (len(CURATED_PHRASES) - len(missing_phrases),
                                              len(missing_phrases), ', '.join(missing_phrases) or '无'))

conn.close()

# 输出 dict.js
print('writing', OUT, '...')
with open(OUT, 'w', encoding='utf-8') as f:
    f.write('/* 离线英汉词典 — 由 ECDICT(开源, 340万词条) 按词频筛选重建 */\n')
    f.write('/* 词条数: %d */\n' % len(entries))
    f.write('var OXFORD_DICT = {\n')
    items = sorted(entries.items())
    for i, (w, tr) in enumerate(items):
        js_w = w.replace('\\', '\\\\').replace("'", "\\'")
        js_t = tr.replace('\\', '\\\\').replace("'", "\\'")
        f.write("'%s':'%s'%s\n" % (js_w, js_t, ',' if i < len(items) - 1 else ''))
    f.write('};\n')
size = os.path.getsize(OUT)
print('done: %d entries, %.1f KB' % (len(entries), size / 1024))

# 输出引擎短语表 glossary.json（自建引擎优先精确匹配，避免短词组被神经模型翻错）
import json
GLOSS = os.path.join(HERE, 'glossary.json')
with open(GLOSS, 'w', encoding='utf-8') as f:
    json.dump(glossary, f, ensure_ascii=False, separators=(',', ':'))
print('glossary: %d phrases, %.1f KB' % (len(glossary), os.path.getsize(GLOSS) / 1024))
