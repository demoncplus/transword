/* 真实端到端自测：直接调用正在运行的自建引擎，检查翻译质量 */
const http = require('http');

function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8766' + path, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    }).on('error', reject);
  });
}
const q = (t, lp) => get('/translate?text=' + encodeURIComponent(t) + '&langpair=' + encodeURIComponent(lp));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  => ' + extra : '')); }
}
const CJK = /[\u4e00-\u9fff]/;

(async () => {
  const h = await get('/health');
  check('引擎在线', h && h.ok === true, JSON.stringify(h));

  console.log('== 英译汉质量 ==');
  const enCases = [
    ['the weather is very nice today', /天气|暖|晴/],
    ['I love you', /爱/],
    ['good morning', /早上好|早安|上午好/],
    ['good night', /晚安/],
    ['good evening', /晚上好|晚安|晚上/],
    ['good afternoon', /下午好|下午/],
    ['thank you', /谢谢/],
    ['see you', /再见|回头见|再会|明天见/],
    ['how are you', /好吗|如何|近况/],
    ['Where is the train station?', /火车|车站|站在?哪|哪里/],
    ['I would like a cup of coffee, please.', /咖啡/],
    ['How much does this book cost?', /书|多少|价钱|钱/],
    ['She is my best friend.', /朋|友|她/],
    ['Please call me tomorrow morning.', /明天|明早|电话|打/],
  ];
  for (const [src, re] of enCases) {
    const r = await q(src, 'en|zh-CN');
    const out = r && r.translatedText;
    check(`英译汉 "${src}" → ${out}`, CJK.test(out || '') && re.test(out), out);
    // 注意：第一分支必须非捕获 (?:...)，否则 \1 会引用到分支一的组（未参与→空串），
    // 导致正则退化成 "^(.{1,4})"，任何字符串都被判为重复
    check(`英译汉 "${src}" 无重复退化`, !/^(?:.{1,4}[，,、]){3,}|^(.{1,4})\1{2,}/.test(out || ''), out);
  }

  console.log('== 短语精确匹配（短语表优先于神经模型）==');
  for (const [src, hit] of [['good morning', '早上好'], ['good night', '晚安'],
                            ['good evening', '晚上好'], ['good afternoon', '下午好'],
                            ['thank you', '谢谢你'], ['long time no see', '好久不见']]) {
    const r = await q(src, 'en|zh-CN');
    check(`"${src}" → 精确译文 ${hit}`, r && r.translatedText === hit && r.engine === 'glossary',
          r && `${r.translatedText} [${r.engine}]`);
  }

  console.log('== 防退化重试不得残留脚手架（回归）==');
  // 引擎在检测到重复退化时会用 "... , please." 重试；该脚手架词不能泄漏到译文里
  for (const src of ['I am very tired today', 'The weather is bad today',
                     'I want to drink water']) {
    const r = await q(src, 'en|zh-CN');
    const out = (r && r.translatedText) || '';
    check(`"${src}" 译文不残留"请/please"`, !/[,，、]?\s*(?:请|please)\s*[。.!！?？]?\s*$/i.test(out), out);
    check(`"${src}" 译文不以逗号收尾`, !/[，,、]\s*$/.test(out), out);
  }

  console.log('== 短语匹配须容忍标点（回归：normalize 曾被语言代码函数覆盖）==');
  for (const [src, hit] of [['Good morning!', '早上好'], ['thank you.', '谢谢你'],
                            ['Good Night', '晚安'], ['  good morning  ', '早上好']]) {
    const r = await q(src, 'en|zh-CN');
    check(`"${src}" 带标点/大小写仍命中短语表`, r && r.translatedText === hit && r.engine === 'glossary',
          r && `${r.translatedText} [${r.engine}]`);
  }

  console.log('== 相邻重复段须折叠（回归：3段2种曾逃过退化判定）==');
  for (const src of ['The weather is bad today', 'She is very happy',
                     'This book is interesting']) {
    const r = await q(src, 'en|zh-CN');
    const out = (r && r.translatedText) || '';
    const segs = out.split(/[\s，,、;；]+/).filter(s => s.trim());
    const uniq = new Set(segs.map(s => s.trim()));
    check(`"${src}" 译文无重复片段`, uniq.size === segs.length, out);
  }

  console.log('== 汉译英质量 ==');
  const zhCases = [
    ['你好，很高兴认识你。', /nice to meet|glad to meet|hello|hi/i],
    ['今天天气很好。', /nice|good|fine|weather/i],
    ['我喜欢学习英语。', /learn|study|english/i],
    ['请问洗手间在哪里？', /where|toilet|restroom|bathroom|washroom/i],
    ['这个多少钱？', /how much|price|cost/i],
    ['我明天要去北京。', /beijing|tomorrow|go/i],
  ];
  for (const [src, re] of zhCases) {
    const r = await q(src, 'zh-CN|en');
    const out = r && r.translatedText;
    check(`汉译英 "${src}" → ${out}`, !!out && !CJK.test(out) && re.test(out), out);
  }

  console.log('== 边界情况 ==');
  const long = await q('This translation app works offline on iPhone, Android, PC and the web, and it automatically saves every word and sentence you look up into your vocabulary notebook.', 'en|zh-CN');
  check('长句（含专有名词）→ ' + (long && long.translatedText), CJK.test((long && long.translatedText) || ''));

  const punct = await q('Hello, world! How are you?', 'en|zh-CN');
  check('标点与多句 → ' + (punct && punct.translatedText), CJK.test((punct && punct.translatedText) || ''));

  const bad = await get('/translate?text=hello&langpair=fr|de');
  check('未安装语言对返回明确错误', bad && (bad.error || bad.translatedText), JSON.stringify(bad));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e.message); process.exit(1); });
