/* 交付前最终验收：模拟真实用户操作，三项核心功能全量核查 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const URL_ = process.argv[2] || 'http://localhost:8765/';
const PORT = 9339;
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, seq = 0; const pending = new Map();
function send(m, p) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method: m, params: p || {} }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + m)); } }, 90000); });
}
async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) return 'EXC: ' + String((r.exceptionDetails.exception || {}).description || '').split('\n')[0];
  return r.result.value;
}
let pass = 0, fail = 0;
function check(n, c, x) { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + '  => ' + JSON.stringify(x)); } }

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-final-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, URL_], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60; i++) {
    await sleep(700);
    try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); target = l.find(t => t.type === 'page' && t.webSocketDebuggerUrl); if (target) break; } catch (_) {}
  }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(String(((m.params.exceptionDetails || {}).exception || {}).description || '').split('\n')[0]);
  };
  await send('Runtime.enable');
  await send('Page.enable');

  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await ev("document.readyState==='complete' && typeof OXFORD_DICT!=='undefined'")) break;
  }
  await ev("localStorage.clear(); location.reload(); 'ok'");
  await sleep(7000);
  for (let i = 0; i < 40; i++) {
    if (await ev("document.readyState==='complete' && typeof OXFORD_DICT!=='undefined'")) break;
    await sleep(1000);
  }
  // 注入辅助函数。reload 会清空页面上下文，所以这个动作要能重复执行。
  const injectHelper = async () => {
  await ev(`
    window.__t = async function (text, lang) {
      var g = function (id) { return document.getElementById(id); };
      var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var want = lang === 'zh2en' ? 'lang-zh2en' : 'lang-en2zh';
      var cur = document.querySelector('.lang-btn.active');
      if (!cur || cur.id !== want) g(want).click();
      await sl(400);
      g('src').value = text; g('btn-go').click();
      var last = '', stable = 0;
      for (var i = 0; i < 160; i++) {
        await sl(500);
        var out = g('result-text').textContent || '';
        if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
        last = out;
      }
      await sl(1200);
      return { text: last, note: (g('result-dict').innerHTML || '').replace(/<[^>]+>/g, ' ').trim() };
    };
    'ready'
  `);
  };
  await injectHelper();

  async function t(text, lang) {
    return JSON.parse(await ev('(async () => JSON.stringify(await window.__t(' +
      JSON.stringify(text) + ',' + JSON.stringify(lang) + ')))()'));
  }
  function vocabOf(src) {
    return ev("JSON.stringify(JSON.parse(localStorage.getItem('tw_vocab')||'[]').filter(function(x){return x.src===" + JSON.stringify(src) + ";}))")
      .then(s => JSON.parse(String(s)));
  }

  console.log('\n【① 生词本是否正常】');
  const cases = [['knowledge', 'en2zh'], ['看电影', 'zh2en'], ['早上好', 'zh2en'],
                 ['I want to drink water', 'en2zh'], ['这个多少钱？', 'zh2en'], ['fun', 'zh2en']];
  for (const [txt, lang] of cases) {
    const r = await t(txt, lang);
    const v = await vocabOf(txt);
    const ok = v.length > 0 && v[0].dst === r.text;
    check('「' + txt + '」(' + lang + ') 已入生词本: ' + r.text, ok, { shown: r.text, stored: v.map(x => x.dst) });
  }
  const badge = await ev("document.getElementById('tab-vocab').click(); (document.getElementById('vocab-count').textContent||'').trim()");
  const total = await ev("JSON.parse(localStorage.getItem('tw_vocab')||'[]').length");
  check('角标与实际条数一致 (' + badge + ' vs ' + total + ')', String(badge) === String(total), { badge, total });
  const renderCount = await ev("document.querySelectorAll('#vocab-list > *').length");
  check('生词本页签渲染出条目 (' + renderCount + ' 条)', renderCount > 0, renderCount);
  const emptyDisp = await ev("getComputedStyle(document.getElementById('vocab-empty')).display");
  check('有词时空状态提示隐藏', emptyDisp === 'none', emptyDisp);

  console.log('\n【①b 用户报「生词本还是没有添加我刚刚搜索的单词」专项】');
  // 场景 1：生词本搜索框残留过滤词时再查词，新词必须可见且可见于列表顶部
  await ev(`(async () => {
    var g = function (id) { return document.getElementById(id); };
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    g('vocab-search').value = 'zzzznomatch';
    g('tab-vocab').click(); await sl(200);
    g('tab-translate').click(); await sl(200);
    var want = 'lang-en2zh';
    var cur = document.querySelector('.lang-btn.active');
    if (!cur || cur.id !== want) { g(want).click(); await sl(350); }
    g('src').value = 'milestone'; g('btn-go').click();
    var last = '', stable = 0;
    for (var i = 0; i < 100; i++) {
      await sl(500);
      var out = g('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(1200);
    'ok';
  })()`);
  const s1 = JSON.parse(await ev(`JSON.stringify((function () {
    var g = function (id) { return document.getElementById(id); };
    g('tab-vocab').click();
    var rows = [];
    document.querySelectorAll('#vocab-list > *').forEach(function (li) {
      var a = li.querySelector('.en'); rows.push(a ? a.textContent.trim() : '');
    });
    return {
      filter: g('vocab-search').value, first: rows[0] || '', rows: rows.length,
      badge: (g('vocab-count').textContent || '').trim(),
      stored: JSON.parse(localStorage.getItem('tw_vocab') || '[]').map(function (x) { return x.src; }),
      emptyText: (g('vocab-empty').textContent || '').trim(),
      emptyDisp: getComputedStyle(g('vocab-empty')).display
    };
  })())`));
  check('刚搜的词已写入生词本', s1.stored.indexOf('milestone') >= 0, s1.stored);
  check('刚搜的词出现在生词本最上方', /^milestone/.test(s1.first), { first: s1.first, rows: s1.rows });
  check('残留过滤词被自动清除', s1.filter === '', s1.filter);
  check('不误报"生词本还是空的"', s1.emptyDisp === 'none' && !/生词本还是空的/.test(s1.emptyText), s1.emptyText);

  // 场景 2：带历史脏数据启动后，新词仍必须能存进去（原 bug：vocabKey 抛异常中断入库）
  await ev("localStorage.setItem('tw_vocab', JSON.stringify([{dst:'缺原文'},{src:'缺译文'},{src:1,dst:2,lang:'en2zh'},null,{src:'keepme',dst:'留着我',lang:'en2zh',ts:1,count:1}])); location.reload(); 'ok'");
  await sleep(7000);
  for (let i = 0; i < 40; i++) {
    if (await ev("document.readyState==='complete' && typeof TW_DEBUG!=='undefined'") === true) break;
    await sleep(1000);
  }
  await injectHelper();   // reload 清空了上下文，重新注入
  await ev(`(async () => {
    var g = function (id) { return document.getElementById(id); };
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    g('src').value = 'breakthrough'; g('btn-go').click();
    var last = '', stable = 0;
    for (var i = 0; i < 100; i++) {
      await sl(500);
      var out = g('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(1200);
    'ok';
  })()`);
  const s2 = JSON.parse(await ev(`JSON.stringify((function () {
    var after = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    return {
      after: after.map(function (x) { return x.src; }),
      badTypes: after.filter(function (x) {
        return !x || typeof x.src !== 'string' || !x.src.trim() || typeof x.dst !== 'string';
      }).length
    };
  })())`));
  check('脏数据启动时被清洗（无 null/无错误类型）', s2.badTypes === 0, s2.after);
  check('脏数据存在时新词仍能入库（原 bug 已修）', s2.after.indexOf('breakthrough') >= 0, s2.after);

  // 场景 3：重查同一个词 → 置顶、不重复、次数 +1
  // 注意：场景 2 用脏数据覆盖了存储，此时 milestone 可能不存在，
  // 所以这里先在同一场景内建立基线，再查第二次来验证"重查"行为。
  const queryOnce = async (word) => {
    await ev(`(async () => {
      var g = function (id) { return document.getElementById(id); };
      var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var cur = document.querySelector('.lang-btn.active');
      if (!cur || cur.id !== 'lang-en2zh') { g('lang-en2zh').click(); await sl(350); }
      g('tab-translate').click(); await sl(200);
      g('src').value = ${JSON.stringify(word)}; g('btn-go').click();
      var last = '', stable = 0;
      for (var i = 0; i < 100; i++) {
        await sl(500);
        var out = g('result-text').textContent || '';
        if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
        last = out;
      }
      await sl(1200);
      'ok';
    })()`);
  };
  await queryOnce('milestone');
  await queryOnce('milestone');
  const s3 = JSON.parse(await ev(`JSON.stringify((function () {
    var after = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    var idx = -1, cnt = 0;
    after.forEach(function (x, i) { if (x.src === 'milestone') { idx = i; cnt = x.count || 1; } });
    return {
      idx: idx, count: cnt,
      dup: after.filter(function (x) { return x.src === 'milestone'; }).length,
      badge: (document.getElementById('vocab-count').textContent || '').trim(),
      len: after.length
    };
  })())`));
  check('重查后该词置顶（用户能看到刚搜的）', s3.idx === 0, s3);
  check('重查不产生重复条目', s3.dup === 1, s3);
  check('重查累加查询次数', s3.count >= 2, s3);
  check('角标与实际条数仍一致', s3.badge === String(s3.len), s3);

  console.log('\n【② 英译汉是否正常】');
  for (const [txt, re] of [['fun', /[\u4e00-\u9fff]/], ['beautiful', /[\u4e00-\u9fff]/],
                           ['I am very tired today', /累|疲倦|疲惫/],
                           ['Thank you very much', /谢|感谢/]]) {
    const r = await t(txt, 'en2zh');
    check('「' + txt + '」=> ' + r.text, re.test(r.text) && !/\[[a-z]+\]/i.test(r.text), r.text);
  }

  console.log('\n【③ 汉译英是否正常】');
  for (const [txt, re] of [['你好', /hello/i], ['请问洗手间在哪里？', /where|toilet|restroom|bathroom/i],
                           ['这个多少钱？', /how much/i], ['看电影', /watch.*movie|movie|cinema/i],
                           ['备用', /stand\s*by|spare|reserve|backup|ready|auxiliary/i]]) {
    const r = await t(txt, 'zh2en');
    check('「' + txt + '」=> ' + r.text,
          re.test(r.text) && !/[\u4e00-\u9fff]/.test(r.text) && !/[\u4e00-\u9fff]\s*[A-Za-z]/.test(r.text), r.text);
  }

  console.log('\n【界面与稳定性】');
  check('无 JS 未捕获异常', errs.length === 0, errs.slice(0, 3));
  check('接口输入框已移除', (await ev("!document.getElementById('api-url')")) === true);
  check('底部版本信息已移除', (await ev("!document.getElementById('build-info')")) === true);

  await ev("document.getElementById('tab-translate').click(); 'ok'");
  await sleep(600);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('final-check.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: final-check.png');

  console.log('\n================ 结果: ' + pass + ' 通过, ' + fail + ' 失败 ================');
  ws.close(); chrome.kill(); await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
