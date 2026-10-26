/* 真机浏览器 E2E：用真实 Chrome 加载页面并模拟人工操作
   用法：node e2e-browser.js [页面地址]
   验收三件事：1) 生词本  2) 英译汉  3) 汉译英
   依赖：Chrome 已安装；预览服务器(8765)与自建引擎(8766)已在运行 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const URL_ = process.argv[2] || 'http://localhost:8765/';
const PORT = 9333;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));
if (!CHROME) { console.error('未找到 Chrome/Edge'); process.exit(2); }

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  => ' + JSON.stringify(extra) : '')); }
}

let ws, seq = 0;
const pending = new Map();
function send(method, params) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('CDP 超时: ' + method)); } }, 180000);
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-e2e-'));
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    URL_
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch (_) {}
  }
  if (!target) { chrome.kill(); throw new Error('Chrome 调试端口未就绪'); }

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // 收集页面 JS 错误，任何未捕获异常都算失败
  const jsErrors = [];
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push(m.params.exceptionDetails.exception &&
                   m.params.exceptionDetails.exception.description || 'unknown');
    }
  });

  // 等页面就绪（含 Service Worker 首次接管可能触发的自动重载）
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    try {
      const ok = await evaluate("document.readyState === 'complete' && typeof TW_DICT_LOADER !== 'undefined'");
      if (ok) break;
    } catch (_) {}   // 页面正在重载时上下文会失效，忽略后重试
  }
  await sleep(4000);   // 留出 SW controllerchange 自动重载的窗口
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate("typeof TW_DICT_LOADER !== 'undefined'")) break;
    } catch (_) {}
    await sleep(1000);
  }

  console.log('== A. 页面与词典装载 ==');
  // 分片按需加载：首屏允许词典对象为空，第一次查询后才验证词条命中。
  const meta = await evaluate(`JSON.stringify({
    dict: Object.keys(OXFORD_DICT).length,
    cn: Object.keys(CN_DICT).length,
    hasLoader: typeof TW_DICT_LOADER !== 'undefined',
    hasApiInput: !!document.getElementById('api-url'),
    hasBuildInfo: !!document.getElementById('build-info'),
    hasResetBtn: !!document.getElementById('btn-reset-cache'),
    hasFlowHint: !!document.querySelector('.flow-hint'),
    api: TW_DEBUG.getApiUrl(),
    // 词典资源实际传输体量与耗时（2MB 汉英词典是新引入的重量，需监控）
    bytes: (performance.getEntriesByType('resource') || [])
             .filter(function (r) { return /cn-dict|dict\\.js/.test(r.name); })
             .reduce(function (a, r) { return a + (r.transferSize || r.encodedBodySize || 0); }, 0),
    ms: Math.round((performance.getEntriesByType('resource') || [])
             .filter(function (r) { return /cn-dict|dict\\.js/.test(r.name); })
             .reduce(function (a, r) { return Math.max(a, r.responseEnd || 0); }, 0))
  })`);
  const m = JSON.parse(meta);
  check('按需词典加载器已就绪', m.hasLoader === true, m);
  check('首屏没有加载完整词典（应为 0 条，查询后按需装载）', m.dict === 0 && m.cn === 0, m);
  console.log('  ℹ 词典传输 ' + (m.bytes / 1048576).toFixed(2) + ' MB，加载完成于 ' + m.ms + ' ms');
  // 词典体积须可控：离线 PWA 首次加载不应过重
  check('词典总体积在 4 MB 以内', m.bytes < 4 * 1048576, (m.bytes / 1048576).toFixed(2) + ' MB');
  check('词典加载在 3 秒内完成', m.ms < 3000, m.ms + ' ms');
  check('接口输入框已移除', m.hasApiInput === false);
  check('底部版本信息/清缓存按钮已移除', m.hasBuildInfo === false && m.hasResetBtn === false);
  check('翻译顺序提示保留', m.hasFlowHint === true);
  // 自建引擎地址必须跟随访问来源：电脑上 localhost、手机上局域网 IP。
  // 写死 localhost 会让手机把引擎指向手机自己，自建引擎那层静默失效。
  const pageHost = new URL(URL_).hostname;
  // 引擎地址必须跟随访问来源：走同源 /engine 代理，页面是 https 时也不会被
  // 混合内容策略拦掉；手机上更不会指向手机自己。
  check('默认引擎地址走同源代理（' + pageHost + ' -> /engine）',
        m.api === new URL(URL_).origin + '/engine', { pageHost, api: m.api });
  if (pageHost !== 'localhost' && pageHost !== '127.0.0.1') {
    check('用局域网 IP 访问时，引擎不指向手机自己', !/localhost|127\.0\.0\.1/.test(m.api), m.api);
  }

  // 清空生词本，从零开始验证
  await evaluate("localStorage.removeItem('tw_vocab'); localStorage.removeItem('tw_history'); location.reload(); 'ok'");
  await sleep(6000);
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate("document.readyState === 'complete' && typeof TW_DICT_LOADER !== 'undefined'")) break;
    } catch (_) {}
    await sleep(1000);
  }

  // 页面内翻译助手：真实点击按钮，等结果稳定
  await evaluate(`
    window.__t = async function (text, lang) {
      var g = function (id) { return document.getElementById(id); };
      var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var want = lang === 'zh2en' ? 'lang-zh2en' : 'lang-en2zh';
      var cur = document.querySelector('.lang-btn.active');
      if (!cur || cur.id !== want) g(want).click();
      await sleep(300);
      g('src').value = text;
      g('btn-go').click();
      // 等待最终态：词典立即出结果，在线源 2-8 秒后可能覆盖。
      // 只等"显示稳定 1 秒"会在覆盖点前后读到中间态，显示与生词本内容不一致（测试 race）。
      var last = '', stable = 0, final = false;
      for (var i = 0; i < 200; i++) {
        await sleep(500);
        var out = g('result-text').textContent || '';
        var note = (g('result-dict').innerHTML || '').replace(/<[^>]+>/g, ' ');
        if (/句子级翻译|逐词直译|未收录|引擎未启动/.test(note)) final = true;
        if (out && out !== '翻译中…' && out === last) {
          if (++stable >= 2 && final) break;
        } else { stable = 0; }
        last = out;
      }
      return { text: last, note: (g('result-dict').innerHTML || '').replace(/<[^>]+>/g, ' ').trim() };
    };
    'ready'
  `);

  // Node 侧助手：真实点击 + 等待结果稳定（CDP 不允许顶层 await，用 async IIFE 包起来）
  async function tr(text, lang) {
    const expr = '(async () => JSON.stringify(await window.__t(' +
      JSON.stringify(text) + ', ' + JSON.stringify(lang) + ')))()';
    return JSON.parse(await evaluate(expr));
  }

  console.log('== B. 英译汉 ==');
  const ew = await tr('fun', 'en2zh');
  check('单词 fun 出中文释义', /[\u4e00-\u9fff]/.test(ew.text), ew.text);
  const es = await tr('I am very tired today', 'en2zh');
  check('整句英译汉出正确中文', /累|疲倦|疲惫/.test(es.text), es.text);
  check('英译汉无方括号占位符', !/\[[a-z]+\]/i.test(es.text), es.text);
  const esSegs = es.text.split(/[\s，,、]+/).filter(Boolean);
  check('英译汉无重复片段', new Set(esSegs).size === esSegs.length, es.text);

  console.log('== C. 汉译英 ==');
  const zc = await tr('你好', 'zh2en');
  check('"你好" 出英文', /hello/i.test(zc.text), zc.text);
  const zs = await tr('请问洗手间在哪里？', 'zh2en');
  check('整句汉译英出可读英文', /where|toilet|restroom|bathroom|washroom/i.test(zs.text), zs.text);
  check('汉译英不含汉字', !/[\u4e00-\u9fff]/.test(zs.text), zs.text);
  check('汉译英不是拼音垃圾', !/\b(wo|ni|hao|qing|wen)\b/i.test(zs.text), zs.text);

  console.log('== C2. 汉译英模式下输入英文（回归：曾经进不了生词本）==');
  const mixed = await tr('fun', 'zh2en');
  check('输入英文得到中文而非无意义的 "Fun"', /[\u4e00-\u9fff]/.test(mixed.text), mixed.text);
  check('标注说明已按英→汉处理', /已按英→汉处理/.test(mixed.note), mixed.note);
  const vocab2 = JSON.parse(await evaluate("localStorage.getItem('tw_vocab') || '[]'"));
  const funItem = vocab2.find(v => v.src === 'fun');
  check('该词确实进了生词本', !!funItem, vocab2.map(v => v.src + '/' + v.lang));
  check('生词本条目译文为中文', !!funItem && /[\u4e00-\u9fff]/.test(funItem.dst), funItem && funItem.dst);
  check('同一词不因换方向而重复堆积', vocab2.filter(v => v.src === 'fun').length === 1,
        vocab2.map(v => v.src + '/' + v.lang));

  console.log('== C3. 汉英词典扩充效果 + 不得中英混排（用户报「备用」→「备 use」）==');
  const dictInfo = JSON.parse(await evaluate(`JSON.stringify({
    cn: Object.keys(CN_DICT || {}).length,
    en: Object.keys(OXFORD_DICT || {}).length,
    spare: (CN_DICT || {})['备用'] || null,
    movie: (CN_DICT || {})['电影'] || null
  })`));
  check('汉英词典已扩充到 5 万条以上', dictInfo.cn > 50000, dictInfo.cn);
  check('「备用」已在汉英词典中', !!dictInfo.spare, dictInfo.spare);
  check('「电影」已在汉英词典中', !!dictInfo.movie, dictInfo.movie);

  const sp = await tr('备用', 'zh2en');
  check('不含原汉字「备」', !sp.text.includes('备'), sp.text);
  check('不是中西混排残句', !/[\u4e00-\u9fff]\s*[A-Za-z]/.test(sp.text), sp.text);
  const okSpare = /stand\s*by|spare|reserve|backup|ready|auxiliary/i.test(sp.text) || sp.text === '暂无翻译';
  check('给出可用译文或明确提示', okSpare, sp.text);

  console.log('== D. 生词本自动收录 ==');
  const vocab = JSON.parse(await evaluate("localStorage.getItem('tw_vocab') || '[]'"));
  const srcs = vocab.map(v => v.src);
  check('英译汉单词已收录', srcs.includes('fun'), srcs);
  check('英译汉整句已收录', srcs.includes('I am very tired today'), srcs);
  check('汉译英已收录', srcs.includes('你好'), srcs);
  check('汉译英整句已收录', srcs.includes('请问洗手间在哪里？'), srcs);
  check('收录条目都带译文（或标记为待补）',
        vocab.every(v => (v.dst && v.dst.length > 0) || v.flag === 'pending'), vocab);
  check('英译汉条目译文为中文', (vocab.find(v => v.src === 'fun') || {}).dst &&
        /[\u4e00-\u9fff]/.test(vocab.find(v => v.src === 'fun').dst), vocab.find(v => v.src === 'fun'));
  check('汉译英条目译文为英文', (vocab.find(v => v.src === '你好') || {}).dst &&
        !/[\u4e00-\u9fff]/.test(vocab.find(v => v.src === '你好').dst), vocab.find(v => v.src === '你好'));
  check('重复查询不重复收录', new Set(srcs).size === srcs.length, srcs);

  console.log('== D2. 用户报「生词本还是没有添加我刚刚搜索的单词」回归 ==');
  // 真机里查一个词，然后切到生词本页真实检查它是否出现在最上方
  const lastWord = await evaluate(`(async () => {
    var g = function (id) { return document.getElementById(id); };
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var cur = document.querySelector('.lang-btn.active');
    if (!cur || cur.id !== 'lang-en2zh') { g('lang-en2zh').click(); await sl(350); }
    // 故意在生词本搜索框里留下过滤词，模拟"上次搜索没清空"的状态
    var vs = g('vocab-search');
    var hadFilter = false;
    if (vs) { vs.value = 'zzzznomatch'; hadFilter = true; g('tab-vocab').click(); await sl(200); g('tab-translate').click(); await sl(200); }
    g('src').value = 'noteworthy';
    g('btn-go').click();
    var last = '', stable = 0;
    for (var i = 0; i < 80; i++) {
      await sl(500);
      var out = g('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(1000);
    g('tab-vocab').click();
    await sl(400);
    var rows = [];
    document.querySelectorAll('#vocab-list > *').forEach(function (li) {
      var a = li.querySelector('.en');
      rows.push(a ? a.textContent.trim() : '');
    });
    return JSON.stringify({
      hadFilter: hadFilter,
      filterNow: g('vocab-search') ? g('vocab-search').value : '(无)',
      firstRow: rows[0] || '', rows: rows.length,
      badge: (g('vocab-count').textContent || '').trim(),
      emptyDisp: getComputedStyle(g('vocab-empty')).display,
      emptyText: (g('vocab-empty').textContent || '').trim(),
      stored: JSON.parse(localStorage.getItem('tw_vocab') || '[]').map(function (x) { return x.src; })
    });
  })()`);
  const d2 = JSON.parse(lastWord);
  const d2has = d2.stored.indexOf('noteworthy') >= 0;
  check('刚搜的词已写入本地存储', d2has, d2.stored);
  check('刚搜的词排在生词本最上方', /^noteworthy/.test(d2.firstRow), { first: d2.firstRow, rows: d2.rows });
  check('遗留的过滤词被自动清掉，不会挡住刚搜的词', d2.filterNow === '', {
    hadFilter: d2.hadFilter, filterNow: d2.filterNow
  });
  check('生词本没有误报"还是空的"', d2.emptyDisp === 'none' && !/生词本还是空的/.test(d2.emptyText),
        { emptyDisp: d2.emptyDisp, emptyText: d2.emptyText });

  // 重查同一个词：必须置顶且不产生重复，用户要能立刻看到
  const reQuery = await evaluate(`(async () => {
    var g = function (id) { return document.getElementById(id); };
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    g('tab-translate').click(); await sl(200);
    var before = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    var oldCount = 0, oldIdx = -1;
    before.forEach(function (x, i) { if (x.src === 'noteworthy') { oldCount = x.count || 1; oldIdx = i; } });
    g('src').value = 'noteworthy';
    g('btn-go').click();
    var last = '', stable = 0;
    for (var i = 0; i < 80; i++) {
      await sl(500);
      var out = g('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(1000);
    var after = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    var idx = -1, cnt = 0;
    after.forEach(function (x, i) { if (x.src === 'noteworthy') { idx = i; cnt = x.count || 1; } });
    return JSON.stringify({
      oldIdx: oldIdx, idx: idx, dup: after.filter(function (x) { return x.src === 'noteworthy'; }).length,
      countUp: cnt > oldCount, len: after.length, beforeLen: before.length
    });
  })()`);
  const rq = JSON.parse(reQuery);
  check('重查同一个词后置顶显示', rq.idx === 0, rq);
  check('重查不产生重复条目', rq.dup === 1 && rq.len === rq.beforeLen, rq);
  check('重查累加查询次数', rq.countUp === true, rq);

  // 界面上的生词本页签真的能渲染出来
  const rendered = JSON.parse(await evaluate(`(function () {
    document.getElementById('tab-vocab').click();
    var items = document.querySelectorAll('#vocab-list > *');
    // 注意：vocab-empty 用 inline style.display 切换，不是 class，须查计算样式
    var emptyDisp = getComputedStyle(document.getElementById('vocab-empty')).display;
    var live = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    return JSON.stringify({
      count: (document.getElementById('vocab-count').textContent || '').trim(),
      items: items.length,
      liveLen: live.length,
      emptyDisp: emptyDisp,
      firstText: items.length ? items[0].textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : ''
    });
  })()`));
  check('生词本页签渲染出条目', rendered.items >= 4, rendered);
  // 用实时存储长度比对，避免受后续用例新增词条影响
  check('生词本角标与实际条数一致', rendered.count === String(rendered.liveLen), rendered);
  check('渲染条数与实际收录条数一致', rendered.items === rendered.liveLen, rendered);
  check('有生词时空状态提示已隐藏', rendered.emptyDisp === 'none', rendered);
  // 不依赖用例顺序：最新一条应当就是我最后查过的那个词（D2 查的是 noteworthy）
  check('首条是最新查询的词', /noteworthy/.test(rendered.firstText), rendered.firstText);

  console.log('== E. 无 JS 异常 ==');
  check('页面无未捕获 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3));

  // 截图取证（供人工确认界面）
  await evaluate("document.getElementById('tab-translate').click(); 'ok'");
  await sleep(800);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('e2e-result.png', Buffer.from(shot.data, 'base64'));
    console.log('  截图已保存: e2e-result.png');
  } catch (e) { console.log('  截图失败: ' + e.message); }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  ws.close(); chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('E2E 崩溃:', e.message); process.exit(1); });
