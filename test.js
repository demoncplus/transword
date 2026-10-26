/* 译词通 端到端自测：用 DOM 桩在 Node 中真实运行 app.js */
const fs = require('fs');
const vm = require('vm');

// ---------- DOM 桩 ----------
function makeEl(id) {
  const e = {
    id, value: '', textContent: '', placeholder: '',
    style: {}, children: [], _classes: new Set(), _ev: {}, onclick: null,
    addEventListener(t, f) { e._ev[t] = f; },
    focus() {},
    appendChild(c) { e.children.push(c); return c; }
  };
  // 真实浏览器里 innerHTML='' 会清空子节点，桩必须一致，
  // 否则 renderVocab() 每次重建列表时旧节点会残留，子节点数永远只增不减。
  let _html = '';
  Object.defineProperty(e, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); if (!_html) e.children.length = 0; }
  });
  e.classList = {
    add: c => e._classes.add(c),
    remove: c => e._classes.delete(c),
    contains: c => e._classes.has(c),
    toggle: (c, f) => {
      if (f === undefined) { e._classes.has(c) ? e._classes.delete(c) : e._classes.add(c); }
      else { f ? e._classes.add(c) : e._classes.delete(c); }
    }
  };
  return e;
}

const IDS = ['src','result','result-src','result-text','result-dict','saved-tip',
  'history-block','history-list','vocab-list','vocab-empty','vocab-count','vocab-search',
  'btn-go','btn-clear','btn-speak','btn-clear-vocab','btn-export',
  'tab-translate','tab-vocab','page-translate','page-vocab','lang-en2zh','lang-zh2en'];
const elements = {};
IDS.forEach(id => elements[id] = makeEl(id));

global.document = {
  getElementById: id => elements[id] || (elements[id] = makeEl(id)),
  createElement: () => makeEl()
};

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
Object.defineProperty(globalThis, 'navigator', { value: { onLine: true }, configurable: true });
global.window = globalThis;
global.confirm = () => true;
// app.js 会按访问来源推断自建引擎地址（手机场景），桩里要能改这个值
global.location = {
  protocol: 'http:',
  hostname: 'localhost',
  host: 'localhost:8765',
  href: 'http://localhost:8765/index.html',
  origin: 'http://localhost:8765'
};

// ---------- 加载应用 ----------
// 默认仍加载完整词典，保证所有旧翻译用例对两种加载方式都有效；
// 第 13 节另起分片模式，验证页面不再首屏下载完整词典。
vm.runInThisContext(fs.readFileSync('dict.js', 'utf8'), { filename: 'dict.js' });
vm.runInThisContext(fs.readFileSync('cn-dict.js', 'utf8'), { filename: 'cn-dict.js' });
global.window.TW_DICT_LOADER = null;

// app.js 是 IIFE，只在加载时读一次 localStorage。
// 要验证"带着已有生词本启动"的行为（脏数据清洗、重查置顶），
// 必须能重新跑一遍初始化，这里把它包成可重复调用的 boot()。
const APP_SRC = fs.readFileSync('app.js', 'utf8');
const APP_URL = '<app>';
let appExports = {};
function boot() {
  // 复位 DOM 桩的状态，模拟一次全新页面加载
  IDS.forEach(id => {
    elements[id].value = '';
    elements[id].textContent = '';
    elements[id].innerHTML = '';
    elements[id]._classes.clear();
    elements[id]._ev = {};
    elements[id].onclick = null;
    elements[id].children.length = 0;
  });
  const module = { exports: {} };
  const fn = new Function('module', 'exports', 'window', 'document', 'localStorage',
    'navigator', 'fetch', 'setTimeout', 'clearTimeout', 'location', APP_SRC);
  fn(module, module.exports, globalThis, global.document, global.localStorage,
    global.navigator, global.fetch || (() => Promise.reject(new Error('no fetch'))),
    setTimeout, clearTimeout, global.location);
  appExports = module.exports;
  return appExports;
}
boot();

// ---------- 断言 ----------
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  => ' + JSON.stringify(extra) : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function click(id) { const e = elements[id]; if (!e.onclick) throw new Error('no onclick: ' + id); e.onclick(); }

(async () => {
  console.log('== 0. 界面精简与默认引擎 ==');
  const html = fs.readFileSync('index.html', 'utf8');
  check('已移除自建接口输入框', !/id="api-url"/.test(html));
  check('已移除底部版本信息/清缓存按钮',
        !/id="build-info"/.test(html) && !/id="btn-reset-cache"/.test(html));
  check('默认翻译顺序提示仍在', /自建引擎/.test(html));
  // 用"连不上的地址"模拟自建引擎未启动：用例1-6走免费接口/离线词典路径，
  // 结果不依赖本机 8766 引擎是否在跑
  store['tw_api'] = 'http://127.0.0.1:18768/translate';

  console.log('== 1. 英译汉：离线立即出结果 ==');
  elements.src.value = 'the weather is very nice today';
  click('btn-go');
  const immediate = elements['result-text'].textContent;
  check('点击后立即有离线结果', immediate.length > 0 && immediate !== '翻译中…', immediate);
  check('提示正在尝试翻译源', /正在尝试更准确的翻译源/.test(elements['result-dict'].innerHTML));

  console.log('== 2. 英译汉：联网精翻覆盖 ==');
  // MyMemory 偶发慢：固定 sleep 5 秒会在网络抖动时误报失败。
  // 改为轮询等待在线结果（最多 20 秒），既稳定又不掩盖真实超时。
  for (let w = 0; w < 40 && !/免费接口.*句子级翻译/.test(elements['result-dict'].innerHTML); w++) {
    await sleep(500);
  }
  const online = elements['result-text'].textContent;
  check('联网翻译结果含"天气"', /天气/.test(online), online);
  check('标注免费接口精翻', /免费接口.*句子级翻译/.test(elements['result-dict'].innerHTML), elements['result-dict'].innerHTML);
  let vocab = JSON.parse(store['tw_vocab'] || '[]');
  check('生词本已自动收录', vocab.length === 1 && vocab[0].src === 'the weather is very nice today', vocab);
  check('查询次数只计1次（精翻不重复计数）', vocab[0] && vocab[0].count === 1, vocab[0] && vocab[0].count);
  check('收录的是联网精翻译文', vocab[0] && /天气/.test(vocab[0].dst), vocab[0] && vocab[0].dst);
  check('历史记录已更新', JSON.parse(store['tw_history'] || '[]').length === 1);

  console.log('== 3. 汉译英：精确词典 ==');
  click('lang-zh2en');
  check('切换后输入框提示中文', /中文/.test(elements.src.placeholder), elements.src.placeholder);
  elements.src.value = '你好';
  click('btn-go');
  await sleep(3000);
  const zh2en = elements['result-text'].textContent;
  check('"你好"翻译含hello', /hello/i.test(zh2en), zh2en);
  vocab = JSON.parse(store['tw_vocab'] || '[]');
  check('汉译英也进生词本', vocab.length === 2, vocab.length);

  console.log('== 4. 离线兜底：断网时用词典 ==');
  click('lang-en2zh');
  navigator.onLine = false;
  elements.src.value = 'beautiful';
  click('btn-go');
  await sleep(1500);
  const offline = elements['result-text'].textContent;
  check('断网仍有离线词典结果', /漂亮|美丽|美好/.test(offline), offline);
  check('标注离线兜底', /离线词典翻译（自建\/免费接口均不可用/.test(elements['result-dict'].innerHTML), elements['result-dict'].innerHTML);

  console.log('== 4b. 汉译英模式下输入英文 → 自动走英汉词典 ==');
  click('lang-zh2en');
  elements.src.value = 'beautiful';
  click('btn-go');
  await sleep(1500);
  const asciiInZhMode = elements['result-text'].textContent;
  check('不出现逐字母垃圾', !/^b\s*e\s*a/.test(asciiInZhMode), asciiInZhMode);
  check('给出词典中文释义', /漂亮|美丽/.test(asciiInZhMode), asciiInZhMode);
  // 回归：曾经这里只查了输出，漏了入库，导致用户报"汉译英输入英文没进生词本"
  check('4b-入库：自动按英→汉收录生词本',
        JSON.parse(store['tw_vocab'] || '[]').some(x => x.src === 'beautiful' && x.lang === 'en2zh'),
        JSON.parse(store['tw_vocab'] || '[]').map(x => x.src + '/' + x.lang));

  console.log('== 4c. 离线短语：精选短语词典整条命中 ==');
  click('lang-en2zh');
  navigator.onLine = false;
  for (const [phrase, re] of [
    ['good morning', /早上好|早安|上午好/],
    ['good night', /晚安/],
    ['thank you', /谢谢/],
    ['how are you', /好吗|如何|近况/]
  ]) {
    elements.src.value = phrase;
    click('btn-go');
    await sleep(800);
    const r = elements['result-text'].textContent;
    check(`离线 "${phrase}" 译为地道短语`, re.test(r), r);
    check(`离线 "${phrase}" 非逐词拼接`, !/的.{0,6}(早晨|夜晚|晚上)\b|好的.{0,4}早/.test(r), r);
  }

  console.log('== 5. 防串台：连续翻译，旧响应不覆盖新结果 ==');
  click('lang-en2zh');
  navigator.onLine = true;
  elements.src.value = 'good morning';
  click('btn-go');
  elements.src.value = 'i love you';
  click('btn-go');
  await sleep(5000);
  check('显示的是最后一次查询', elements['result-src'].textContent === 'i love you', elements['result-src'].textContent);
  check('结果是 i love you 的翻译', /爱/.test(elements['result-text'].textContent), elements['result-text'].textContent);
  check('不是垃圾拼音数据', !/wo hen mei/i.test(elements['result-text'].textContent), elements['result-text'].textContent);

  console.log('== 6. 界面状态 ==');
  check('生词本角标=8（weather/你好/beautiful/4个离线短语/i love you）', elements['vocab-count'].textContent === 8, elements['vocab-count'].textContent);
  check('结果区可见', !elements['result'].classList.contains('hidden'));
  check('已保存提示可见', !elements['saved-tip'].classList.contains('hidden'));

  console.log('== 7. 自建接口优先（模拟自建翻译引擎）==');
  const http = require('http');
  const mock = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ translatedText: '自建引擎：今天是个好日子' }));
  });
  await new Promise(r => mock.listen(18767, '127.0.0.1', r));
  store['tw_api'] = 'http://127.0.0.1:18767/translate';
  elements.src.value = 'see you tomorrow';
  click('btn-go');
  await sleep(2500);
  check('自建接口结果优先', elements['result-text'].textContent === '自建引擎：今天是个好日子', elements['result-text'].textContent);
  check('标注自建接口', /🏠 自建接口/.test(elements['result-dict'].innerHTML), elements['result-dict'].innerHTML);

  console.log('== 8. 自建接口挂了 → 自动回退免费接口 ==');
  store['tw_api'] = 'http://127.0.0.1:18768/translate'; // 无服务，连接立即失败
  elements.src.value = 'have a nice day';
  click('btn-go');
  await sleep(5000);
  const fbNote = elements['result-dict'].innerHTML;
  check('回退到免费接口', /免费接口/.test(fbNote), fbNote);
  check('免费接口给出中文译文', /[\u4e00-\u9fff]/.test(elements['result-text'].textContent), elements['result-text'].textContent);
  mock.close();

  console.log('== 9. 自建+免费全不可用 → 离线词典兜底 ==');
  store['tw_api'] = 'http://127.0.0.1:18769/translate';
  navigator.onLine = false;
  elements.src.value = 'good luck';
  click('btn-go');
  await sleep(2000);
  check('标注全部接口不可用', /自建\/免费接口均不可用/.test(elements['result-dict'].innerHTML), elements['result-dict'].innerHTML);
  check('离线词典给出中文', /[\u4e00-\u9fff]/.test(elements['result-text'].textContent), elements['result-text'].textContent);
  navigator.onLine = true;
  delete store['tw_api'];

  console.log('== 10. 核心功能强制回归（每次改动必过）==');
  delete store['tw_api'];
  click('lang-en2zh');
  navigator.onLine = true;

  // —— 10.1 生词本：清空后从零验证"查询即收录、可搜索、可导出" ——
  click('tab-vocab');
  click('btn-clear-vocab');
  delete store['tw_vocab'];
  store['tw_vocab'] = '[]';
  click('tab-translate');
  elements.src.value = 'knowledge';
  click('btn-go');
  await sleep(3000);
  let v = JSON.parse(store['tw_vocab'] || '[]');
  const kn = v.find(x => x.src === 'knowledge');
  check('10.1a 查询后自动进生词本', !!kn, v.map(x => x.src));
  check('10.1b 收录了中文译文', !!kn && /[\u4e00-\u9fff]/.test(kn.dst), kn && kn.dst);
  check('10.1c 生词本角标同步', elements['vocab-count'].textContent >= 1, elements['vocab-count'].textContent);

  // 重复查询同一词：只累加次数，不新增条目
  const before = v.length;
  elements.src.value = 'knowledge';
  click('btn-go');
  await sleep(2500);
  v = JSON.parse(store['tw_vocab'] || '[]');
  const kn2 = v.find(x => x.src === 'knowledge');
  check('10.1d 重复查询不重复收录', v.length === before, { before, after: v.length });
  check('10.1e 重复查询次数累加', kn2 && kn2.count >= 2, kn2 && kn2.count);

  // —— 10.2 英译汉：完整句子必须出正确中文 ——
  elements.src.value = 'I am very tired today';
  click('btn-go');
  await sleep(6000);
  const e2z = elements['result-text'].textContent;
  check('10.2a 英译汉返回中文', /[\u4e00-\u9fff]/.test(e2z), e2z);
  check('10.2b 英译汉语义正确（累/疲倦）', /累|疲倦|疲惫|疲劳/.test(e2z), e2z);
  check('10.2c 英译汉无占位符残留', !/\[[a-z]+\]/i.test(e2z), e2z);

  // —— 10.3 汉译英：中文必须出可读英文，且不能是拼音/乱码 ——
  click('lang-zh2en');
  elements.src.value = '我今天很累';
  click('btn-go');
  await sleep(6000);
  const z2e = elements['result-text'].textContent;
  check('10.3a 汉译英返回英文', /[a-zA-Z]{2,}/.test(z2e), z2e);
  check('10.3b 汉译英不含汉字', !/[\u4e00-\u9fff]/.test(z2e), z2e);
  check('10.3c 汉译英不是拼音垃圾', !/\b(wo|jin|tian|hen|lei)\b/i.test(z2e), z2e);

  // —— 10.4 汉译英的结果同样要进生词本 ——
  v = JSON.parse(store['tw_vocab'] || '[]');
  const zt = v.find(x => x.src === '我今天很累');
  check('10.4 汉译英也自动收录生词本', !!zt, v.map(x => x.src));
  check('10.4b 汉译英收录的是英文译文', !!zt && !/[\u4e00-\u9fff]/.test(zt.dst), zt && zt.dst);

  // —— 10.5 空配置不应跳过自建引擎（本轮修掉的真实 bug）——
  store['tw_api'] = '';
  check('10.5a 空配置回落到自建引擎', window.TW_DEBUG.getApiUrl() === window.TW_DEBUG.DEFAULT_API,
        window.TW_DEBUG.getApiUrl());
  store['tw_api'] = '   ';
  check('10.5b 纯空格同样回落', window.TW_DEBUG.getApiUrl() === window.TW_DEBUG.DEFAULT_API,
        window.TW_DEBUG.getApiUrl());
  store['tw_api'] = 'http://127.0.0.1:18767/translate';
  check('10.5c 自定义地址仍然生效', window.TW_DEBUG.getApiUrl() === 'http://127.0.0.1:18767/translate',
        window.TW_DEBUG.getApiUrl());
  delete store['tw_api'];

  // —— 10.6 同一词在不同方向下都要能收录（用户报"汉译英 fun 没进生词本"）——
  delete store['tw_api'];
  store['tw_vocab'] = '[]';
  navigator.onLine = true;

  // 先在英译汉查 fun
  click('lang-en2zh');
  elements.src.value = 'fun';
  click('btn-go');
  await sleep(3000);
  let vv = JSON.parse(store['tw_vocab'] || '[]');
  check('10.6a 英译汉 fun 已收录', vv.some(x => x.src === 'fun' && x.lang === 'en2zh'),
        vv.map(x => x.src + '/' + x.lang));
  const afterEn = vv.length;

  // 再切到汉译英查同一个 fun：必须仍被收录，且译文要是中文（不能是 "Fun"）
  click('lang-zh2en');
  elements.src.value = 'fun';
  click('btn-go');
  await sleep(3000);
  vv = JSON.parse(store['tw_vocab'] || '[]');
  const funItem = vv.find(x => x.src === 'fun');
  check('10.6b 汉译英模式输入 fun 仍进生词本', !!funItem, vv.map(x => x.src + '/' + x.lang));
  check('10.6c 译文是中文而非无意义的 "Fun"',
        !!funItem && /[\u4e00-\u9fff]/.test(funItem.dst), funItem && funItem.dst);
  check('10.6d 标注说明已按英→汉处理',
        /已按英→汉处理/.test(elements['result-dict'].innerHTML), elements['result-dict'].innerHTML);
  check('10.6e 同词同向不重复收录', vv.filter(x => x.src === 'fun').length === 1, vv.map(x => x.src));

  // 真正的中文词在汉译英下必须新增条目（不能被英文键吞掉）
  elements.src.value = '你好';
  click('btn-go');
  await sleep(3000);
  vv = JSON.parse(store['tw_vocab'] || '[]');
  check('10.6f 中文词正常新增条目', vv.some(x => x.src === '你好' && x.lang === 'zh2en'),
        vv.map(x => x.src + '/' + x.lang));

  // —— 10.7 离线未收录的词不得输出中英混杂垃圾（用户报「备用」→「备 use」）——
  // 注意：汉英词典已从 813 条扩到 6 万条，「备用」现在离线就能给出词条译文，
  // 所以这里改用真正冷僻的输入来验证"未收录"路径。
  store['tw_vocab'] = '[]';
  navigator.onLine = false;                      // 免费接口不可用
  store['tw_api'] = 'http://127.0.0.1:1/translate'; // 自建引擎不可用（死端口）
  click('lang-zh2en');
  elements.src.value = '龘靐齉爩';
  click('btn-go');
  await sleep(2500);
  const bad = elements['result-text'].textContent;
  // 真 bug 是「备 use」这种中西混排残句；纯中文提示语不算问题
  check('10.7a 不把原汉字混进英文（无「备 use」）', !/[\u4e00-\u9fff]\s*[A-Za-z]/.test(bad), bad);
  check('10.7a2 不含原字', !/龘|靐|齉|爩/.test(bad), bad);
  check('10.7b 两条路都不可用时如实显示「暂无翻译」', /暂无翻译/.test(bad), bad);
  check('10.7c 明确提示引擎未启动', /引擎未启动|translate-api\.py/.test(elements['result-dict'].innerHTML),
        elements['result-dict'].innerHTML);
  const vv7 = JSON.parse(store['tw_vocab'] || '[]');
  // 用户要求"所有主动搜索过的单词、句子自动放进生词本"，
  // 所以未收录的词也必须收录，只是标为 pending（暂未查到译文），不得伪造译文。
  const rec7 = vv7.find(x => x.src === '龘靐齉爩');
  check('10.7d 未收录的词也记入生词本（用户要求搜过的都收录）', !!rec7, vv7.map(x => x.src));
  check('10.7d2 但标记为待补译文，不伪造译文', !!rec7 && rec7.flag === 'pending' && !rec7.dst,
        rec7);

  // 离线能完整翻译的中文词，仍应正常出结果并入库
  elements.src.value = '你好';
  click('btn-go');
  await sleep(2000);
  check('10.7e 离线可完整翻译时仍正常出英文',
        /hello/i.test(elements['result-text'].textContent), elements['result-text'].textContent);

  // 引擎可用时必须给出正确完整译文，且译文里不能有汉字
  navigator.onLine = true;
  delete store['tw_api'];
  let engineUp = false;
  try {
    const h = await fetch('http://localhost:8766/health');
    engineUp = h.ok;
  } catch (e) { engineUp = false; }
  elements.src.value = '备用';
  click('btn-go');
  await sleep(6000);
  const fixed = elements['result-text'].textContent;
  check('10.7f 修复后「备用」不再输出中文混排', !/[\u4e00-\u9fff]\s*[A-Za-z]/.test(fixed), fixed);
  check('10.7f2 不再出现原字「备」', !fixed.includes('备'), fixed);
  if (engineUp) {
    check('10.7g 引擎可用时给出正确译文 Stand by',
          /stand\s*by/i.test(fixed), fixed);
    const vv7b = JSON.parse(store['tw_vocab'] || '[]');
    const item = vv7b.find(x => x.src === '备用');
    check('10.7h 引擎译文正常收录生词本', !!item && !/[\u4e00-\u9fff]/.test(item.dst),
          item && item.dst);
  } else {
    console.log('  SKIP  10.7g/h（自建引擎未启动）');
  }

  // —— 10.8 汉英词典扩充后（813 → 6 万条），离线整句不得冒充准确译文 ——
  store['tw_vocab'] = '[]';
  store['tw_api'] = 'http://127.0.0.1:1/translate';   // 引擎不可用
  navigator.onLine = false;                            // 免费接口不可用
  click('lang-zh2en');

  check('10.8a 汉英词典已扩充到 5 万条以上',
        Object.keys(globalThis.CN_DICT || {}).length > 50000,
        Object.keys(globalThis.CN_DICT || {}).length);
  check('10.8b 用户报的词「备用」已收录', !!globalThis.CN_DICT['备用'], globalThis.CN_DICT['备用']);
  check('10.8c 常见词「电影」已收录', !!globalThis.CN_DICT['电影'], globalThis.CN_DICT['电影']);

  // 整句逐词直译：词序不可靠，必须标注"仅供参考"，不能当正式译文
  elements.src.value = '请问洗手间在哪里？';
  click('btn-go');
  await sleep(2500);
  check('10.8d 整句离线直译标注为"逐词直译/仅供参考"',
        /逐词直译|仅供参考/.test(elements['result-dict'].innerHTML),
        elements['result-dict'].innerHTML);
  check('10.8e 整句直译不带汉字', !/[\u4e00-\u9fff]/.test(elements['result-text'].textContent),
        elements['result-text'].textContent);
  check('10.8f 整句直译不含多候选分号', !/;/.test(elements['result-text'].textContent),
        elements['result-text'].textContent);
  const vv8 = JSON.parse(store['tw_vocab'] || '[]');
  // 同上：逐词直译也收录，但必须带 literal 标记，界面标注"仅供参考"
  const rec8 = vv8.find(x => x.src === '请问洗手间在哪里？');
  check('10.8g 整句直译也收录进生词本（用户要求搜过的都收录）', !!rec8, vv8.map(x => x.src));
  check('10.8g2 但标记为逐词直译，不与正式译文混淆', !!rec8 && rec8.flag === 'literal', rec8);

  // 单词/词条级查询离线仍应直接给出结果
  elements.src.value = '备用';
  click('btn-go');
  await sleep(2500);
  check('10.8h 单词离线仍直接出结果', /ready|spare|auxiliary/i.test(elements['result-text'].textContent),
        elements['result-text'].textContent);
  const vv8b = JSON.parse(store['tw_vocab'] || '[]');
  check('10.8i 单词离线结果正常入库', vv8b.some(x => x.src === '备用'),
        vv8b.map(x => x.src + '=>' + x.dst));

  delete store['tw_api'];
  navigator.onLine = true;

  // ===== 10.9 用户报「生词本还是没有添加我刚刚搜索的单词」的回归覆盖 =====
  console.log('\n== 10.9 生词本收录可靠性（用户报"搜了却没添加"）==');

  // 10.9a/b 重新查询已存在的词，必须出现在列表最上方。
  // 原来只更新不移动，被重查的词仍埋在底部，用户在顶部看不到 → 以为没添加。
  store['tw_vocab'] = JSON.stringify([
    { src: 'aaa', dst: '甲', lang: 'en2zh', ts: 1000, count: 1 },
    { src: 'bbb', dst: '乙', lang: 'en2zh', ts: 2000, count: 1 },
    { src: 'ccc', dst: '丙', lang: 'en2zh', ts: 3000, count: 1 }
  ]);
  await boot();
  elements.src.value = 'aaa';
  click('btn-go');
  await sleep(2000);
  const v9 = JSON.parse(store['tw_vocab'] || '[]');
  check('10.9a 重查已有词后该词排在最前（用户能看到刚搜的）', v9[0] && v9[0].src === 'aaa',
        v9.map(x => x.src));
  check('10.9b 重查不产生重复条目', v9.filter(x => x.src === 'aaa').length === 1,
        v9.map(x => x.src));
  check('10.9c 查询次数累加', v9[0] && v9[0].count === 2, v9[0]);

  // 10.9d/e 历史脏数据（缺字段/类型错误/元素为 null）不得让生词本瘫痪。
  // 原 bug：vocabKey 里 src.toLowerCase() 抛异常，且发生在 save() 之前，
  // 导致此后每一次 addToVocab 都中断，任何新词都存不进去。
  store['tw_vocab'] = JSON.stringify([
    { dst: '没有原文' }, { src: '缺译文' }, { src: 123, dst: 456, lang: 'en2zh' },
    null, { src: 'okone', dst: '好的', lang: 'en2zh', ts: 1, count: 1 }
  ]);
  await boot();
  const vAfterLoad = JSON.parse(store['tw_vocab'] || '[]');
  check('10.9d 脏数据在启动时被清洗（无 null、字段均为字符串）',
        vAfterLoad.length > 0 && vAfterLoad.every(x => x && typeof x.src === 'string' && x.src.trim() &&
          typeof x.dst === 'string' && typeof x.ts === 'number'),
        vAfterLoad);
  elements.src.value = 'knowledge';
  click('btn-go');
  await sleep(2000);
  const v9b = JSON.parse(store['tw_vocab'] || '[]');
  check('10.9e 脏数据存在时新词仍能正常入库', v9b.some(x => x.src === 'knowledge'),
        v9b.map(x => x.src + '=>' + x.dst));

  // 10.9f/g 搜索框残留过滤词时，不得谎报"生词本还是空的"
  store['tw_vocab'] = JSON.stringify([
    { src: 'apple', dst: '苹果', lang: 'en2zh', ts: 1, count: 1 },
    { src: 'grape', dst: '葡萄', lang: 'en2zh', ts: 2, count: 1 }
  ]);
  await boot();
  elements['vocab-search'].value = 'zzzznomatch';
  click('tab-vocab');
  await sleep(300);
  check('10.9f 过滤无结果时不谎报"生词本还是空的"',
        !/生词本还是空的/.test(elements['vocab-empty'].textContent),
        elements['vocab-empty'].textContent);
  check('10.9g 且提示是被过滤，并给出实际条数',
        /2/.test(elements['vocab-empty'].textContent) && /搜索框/.test(elements['vocab-empty'].textContent),
        elements['vocab-empty'].textContent);
  elements['vocab-search'].value = '';
  click('tab-vocab');
  await sleep(300);
  // 断言"恢复显示"而不是精确条数：前面用例发起的异步查询可能在重新 boot() 之后
  // 才返回，旧实例的 addToVocab 会再补进一条（用户确实搜过，补进来是正确行为）。
  check('10.9h 清空搜索框后条目恢复显示',
        elements['vocab-list'].children.length >= 2 &&
        elements['vocab-empty'].style.display === 'none',
        { rows: elements['vocab-list'].children.length, empty: elements['vocab-empty'].style.display });

  // 10.9i 刚搜的词必须一定能看到：残留过滤词要自动清掉
  // （否则搜索框里的旧过滤条件会把新词挡掉，用户以为没添加成功）
  elements['vocab-search'].value = 'zzzznomatch';
  click('tab-vocab');
  await sleep(200);
  elements.src.value = 'knowledge';
  click('btn-go');
  await sleep(2000);
  check('10.9i 新查询自动清掉残留过滤词', elements['vocab-search'].value === '',
        elements['vocab-search'].value);
  click('tab-vocab');
  await sleep(300);
  check('10.9j 刚搜的词在生词本中可见',
        elements['vocab-list'].children.length >= 3 &&
        elements['vocab-empty'].style.display === 'none',
        { rows: elements['vocab-list'].children.length, empty: elements['vocab-empty'].style.display });

  // ===== 11. 手机 / 安卓 / 平板访问（局域网场景）=====
  console.log('\n== 11. 手机访问：引擎地址必须跟随访问来源 ==');
  // 原 bug 1：DEFAULT_API 写死 http://localhost:8766，手机上 localhost 指手机自己，
  //          自建引擎这一层静默失效，用户查句子只会得到离线直译，找不到原因。
  // 原 bug 2：页面走 HTTPS 后（手机离线安装需要），fetch http://...:8766 会被
  //          浏览器当混合内容拦掉，引擎同样静默失效。
  // 现在的策略：只要是通过服务器打开（http 或 https），一律走同源 /engine 代理。
  delete store['tw_api'];

  global.location = {
    protocol: 'http:', hostname: 'localhost', host: 'localhost:8765',
    href: 'http://localhost:8765/index.html', origin: 'http://localhost:8765'
  };
  boot();
  check('11a 电脑上打开 → 引擎走同源代理 /engine',
        window.TW_DEBUG.getApiUrl() === 'http://localhost:8765/engine',
        window.TW_DEBUG.getApiUrl());

  global.location = {
    protocol: 'http:', hostname: '192.168.0.254', host: '192.168.0.254:8765',
    href: 'http://192.168.0.254:8765/index.html', origin: 'http://192.168.0.254:8765'
  };
  boot();
  check('11b 手机上用局域网 IP 打开 → 引擎也指向同一台电脑',
        window.TW_DEBUG.getApiUrl() === 'http://192.168.0.254:8765/engine',
        window.TW_DEBUG.getApiUrl());
  check('11c 手机上不再指向手机自己（无 localhost/127.0.0.1）',
        !/localhost|127\.0\.0\.1/.test(window.TW_DEBUG.getApiUrl()),
        window.TW_DEBUG.getApiUrl());

  // HTTPS：手机离线安装必须用 HTTPS，此时绝不能出现 http:// 的引擎地址
  global.location = {
    protocol: 'https:', hostname: '192.168.0.254', host: '192.168.0.254:8443',
    href: 'https://192.168.0.254:8443/index.html', origin: 'https://192.168.0.254:8443'
  };
  boot();
  const httpsApi = window.TW_DEBUG.getApiUrl();
  check('11c2 HTTPS 下引擎用 https 同源地址（避免混合内容被拦）',
        httpsApi === 'https://192.168.0.254:8443/engine', httpsApi);
  check('11c3 HTTPS 下引擎地址不含 http://（混合内容会被浏览器拦掉）',
        !/^http:\/\//.test(httpsApi), httpsApi);

  // 自定义地址优先级仍要高于自动推断
  store['tw_api'] = 'http://10.0.0.9:9999/translate';
  boot();
  check('11d 手动配置的引擎地址优先于自动推断',
        window.TW_DEBUG.getApiUrl() === 'http://10.0.0.9:9999/translate',
        window.TW_DEBUG.getApiUrl());
  delete store['tw_api'];

  // file:// 直接打开（没有服务器可代理）时必须兜底直连本机引擎
  global.location = {
    protocol: 'file:', hostname: '', host: '',
    href: 'file:///C:/app/index.html', origin: 'null'
  };
  boot();
  check('11e file:// 直接打开时兜底直连本机引擎',
        window.TW_DEBUG.getApiUrl() === 'http://localhost:8766/translate',
        window.TW_DEBUG.getApiUrl());
  global.location = {
    protocol: 'http:', hostname: 'localhost', host: 'localhost:8765',
    href: 'http://localhost:8765/index.html', origin: 'http://localhost:8765'
  };
  boot();

  // server.js 必须绑定所有网卡，否则手机连不上（只绑 127.0.0.1 是"手机打不开"的首因）
  const serverSrc = fs.readFileSync('server.js', 'utf8');
  check('11f 服务器绑定 0.0.0.0（手机才能连上）', /listen\([^)]*'0\.0\.0\.0'/.test(serverSrc),
        (serverSrc.match(/\.listen\([^)]*\)/) || [''])[0]);
  check('11g 服务器启动时打印手机可访问地址', /手机/.test(serverSrc) && /networkInterfaces/.test(serverSrc));

  // —— 11h 整句查询不得重复计数 ——
  // 真实 bug：整句（如「请问洗手间在哪里？」）离线只能逐词直译，会先以 pending 收录一次，
  // 引擎返回好译文后又调一次 addToVocab，且传了 countIt=incomplete（true）→ 又计一次。
  // 结果用户查一次却显示"查询 2 次"。
  // 原来第 2 节的"不重复计数"断言只覆盖"离线就完整"的路径，所以漏掉了这个分支。
  console.log('\n== 11h. 整句查询只计一次（引擎补译文不得重复计数）==');
  store['tw_vocab'] = '[]';
  store['tw_api'] = 'http://engine.test/translate';   // 指向会被拦下的假地址，由桩 fetch 接管
  navigator.onLine = true;
  // 模拟自建引擎：整句返回正式译文（模拟 server.js 的 /engine 同源代理）
  global.fetch = url => {
    const s = String(url);
    if (/engine\.test/.test(s)) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ translatedText: "Where's the bathroom?" }))
      });
    }
    return Promise.reject(new Error('no network'));
  };
  boot();
  click('lang-zh2en');
  elements.src.value = '请问洗手间在哪里？';
  click('btn-go');
  await sleep(3000);
  const vCount = JSON.parse(store['tw_vocab'] || '[]');
  const recCount = vCount.find(x => x.src === '请问洗手间在哪里？');
  check('11h 查一次就是 1 次（整句不再重复计数）',
        !!recCount && recCount.count === 1, recCount);
  check('11h2 且最终收录的是引擎正式译文，不是 pending',
        !!recCount && /bathroom/i.test(recCount.dst) && recCount.flag === '',
        recCount);

  // 复位，避免影响后续小节
  delete store['tw_api'];
  delete global.fetch;
  store['tw_vocab'] = '[]';
  boot();

  console.log('\n== 12. 手机端界面适配 ==');
  const css = fs.readFileSync('style.css', 'utf8');
  const htmlSrc = fs.readFileSync('index.html', 'utf8');

  // iOS Safari：输入框字号 <16px 会在聚焦时自动放大整个页面
  const inputSizes = [...css.matchAll(/(textarea|\.vocab-toolbar input)[^{}]*\{[^}]*font-size:\s*(\d+(?:\.\d+)?)px/gs)]
    .map(m => parseFloat(m[2]));
  check('12a 输入框字号 >=16px（否则 iOS 聚焦时页面会被放大）',
        inputSizes.length > 0 && inputSizes.every(s => s >= 16), inputSizes);

  check('12b 输入框不用 autofocus（否则手机一进页面就弹键盘挡屏）',
        !/id="src"[^>]*autofocus/.test(htmlSrc) && !/<textarea[^>]*autofocus/.test(htmlSrc));

  check('12c 触摸设备有 :active 点击反馈（触屏没有 hover）',
        /button:active|\.chip:active/.test(css) && /@media \(hover: hover\)/.test(css));

  check('12d 手机上加粗触摸目标（pointer: coarse）', /@media \(pointer: coarse\)/.test(css));

  check('12e 工具栏输入框允许收缩（窄屏不挤掉导出/清空按钮）',
        /\.vocab-toolbar input[^{}]*\{[^}]*min-width:\s*0/s.test(css));

  check('12f 保留刘海屏安全区适配', /safe-area-inset/.test(css));
  check('12g 保留 viewport-fit=cover（无此项安全区适配无效）', /viewport-fit=cover/.test(htmlSrc));
  check('12h 有主题色（安卓地址栏/状态栏着色）', /theme-color/.test(htmlSrc));
  check('12i 有 apple-touch-icon（iOS 添加到主屏的图标）', /apple-touch-icon/.test(htmlSrc));
  // 安卓/iOS 装成 App 需要 manifest
  const mf = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  check('12j manifest 可安装（standalone + 图标 + start_url）',
        mf.display === 'standalone' && Array.isArray(mf.icons) && mf.icons.length >= 2 && !!mf.start_url,
        { display: mf.display, icons: mf.icons.length, start_url: mf.start_url });
  check('12k 不依赖 hover 才能操作（触屏可完成全部操作）', !/\.\.\.:hover[^{]*\{[^}]*display:\s*(block|flex)/.test(css));

  console.log('\n== 13. 按需词典分片：词条内容不丢失 ==');
  // 分片构建必须保留完整词典的每一条、每一个字，不能只是"大约一样"。
  const chunkIndex = JSON.parse(fs.readFileSync('chunks/index.json', 'utf8'));
  const chunkSandbox = {};
  vm.createContext(chunkSandbox);
  vm.runInContext(fs.readFileSync('dict.js', 'utf8'), chunkSandbox);
  vm.runInContext(fs.readFileSync('cn-dict.js', 'utf8'), chunkSandbox);
  const mergedEn = {}, mergedZh = {};
  Object.values(chunkIndex.chunks).forEach(meta => {
    const code = fs.readFileSync(meta.url, 'utf8');
    const m = code.match(/g\.(TW_(?:EN|ZH)_CHUNK)=(\{[\s\S]*\});\}\)\(this\);/);
    if (!m) throw new Error('无法解析分片 ' + meta.url);
    const data = JSON.parse(m[2]);
    Object.assign(m[1] === 'TW_EN_CHUNK' ? mergedEn : mergedZh, data);
  });
  check('13a 英文分片数量与完整词典一致',
        Object.keys(mergedEn).length === Object.keys(chunkSandbox.OXFORD_DICT).length,
        Object.keys(mergedEn).length);
  check('13b 中文分片数量与完整词典一致',
        Object.keys(mergedZh).length === Object.keys(chunkSandbox.CN_DICT).length,
        Object.keys(mergedZh).length);
  check('13c 英文分片词条内容逐字一致',
        Object.keys(chunkSandbox.OXFORD_DICT).every(k => mergedEn[k] === chunkSandbox.OXFORD_DICT[k]));
  check('13d 中文分片词条内容逐字一致',
        Object.keys(chunkSandbox.CN_DICT).every(k => mergedZh[k] === chunkSandbox.CN_DICT[k]));
  check('13e 首屏不再同步下载完整词典',
        !/<script src="dict\.js/.test(htmlSrc) && !/<script src="cn-dict\.js/.test(htmlSrc) &&
        /<script src="dict-loader\.js/.test(htmlSrc));
  check('13f Service Worker 首屏也不预下载完整词典',
        !/ASSETS[\s\S]*?'\.\/dict\.js'/.test(fs.readFileSync('sw.js', 'utf8').split('self.addEventListener')[0]));
  check('13g 页面空闲后仍后台准备完整离线词典',
        /prepare-offline/.test(fs.readFileSync('app.js', 'utf8')) &&
        /dict\.js/.test(fs.readFileSync('sw.js', 'utf8')) &&
        /cn-dict\.js/.test(fs.readFileSync('sw.js', 'utf8')));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
