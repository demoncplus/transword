/* 三项功能实测（走手机真正使用的 HTTPS 链路）
 *
 * 用户固定要求：每次改动后都要验证
 *   ① 生词本是否正常
 *   ② 英译汉是否正常
 *   ③ 汉译英是否正常
 *
 * 本脚本用真实浏览器 + HTTPS 访问，逐项用真实输入验证，不依赖任何内部实现。
 *
 * 用法：node verify-three.js [地址]
 *       node verify-three.js https://192.168.0.254:8443/
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p)) || 'chrome.exe';
const URL_ = process.argv[2] || 'https://localhost:8443/';
const PORT = Number(process.argv[3] || 9385);

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  => ' + JSON.stringify(extra) : '')); }
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

// 在页面里输入并等待结果稳定
async function translate(expr, text, tabs) {
  return JSON.parse(await evaluate(`(async () => {
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var ta = document.getElementById('src');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-go').click();
    var last = '', stable = 0;
    for (var i = 0; i < 100; i++) {
      await sl(400);
      var out = document.getElementById('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(700);
    var v = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    var rec = null;
    for (var k = 0; k < v.length; k++) { if (v[k] && v[k].src === ${JSON.stringify(text)}) { rec = v[k]; break; } }
    return JSON.stringify({
      text: last,
      dict: document.getElementById('result-dict').textContent || '',
      rec: rec,
      first: v[0] ? v[0].src : null,
      total: v.length
    });
  })()`));
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-three-'));
  const extra = (process.env.TW_EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio', '--window-size=414,900',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    ...extra, URL_
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
  const jsErrors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  };
  await send('Runtime.enable');
  await send('Page.enable');

  await sleep(9000);
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate("document.readyState==='complete' && typeof TW_DEBUG!=='undefined'")) break;
    } catch (_) {}
    await sleep(1000);
  }

  // 从干净状态开始
  await evaluate("localStorage.removeItem('tw_vocab'); localStorage.removeItem('tw_lang'); location.reload(); 'ok'");
  await sleep(8000);
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate("document.readyState==='complete' && typeof TW_DEBUG!=='undefined'")) break;
    } catch (_) {}
    await sleep(1000);
  }

  console.log('三项功能实测 —— ' + URL_);
  console.log('');

  // ---------- ② 英译汉 ----------
  console.log('【② 英译汉】');
  const e1 = await translate('x', 'beautiful');
  check('beautiful → ' + e1.text, /美丽|漂亮|美/.test(e1.text), e1.text);
  const e2 = await translate('x', 'I am very tired today');
  check('整句 I am very tired today → ' + e2.text,
        /我/.test(e2.text) && /累|疲倦|疲惫/.test(e2.text), e2.text);

  // ---------- ③ 汉译英 ----------
  console.log('');
  console.log('【③ 汉译英】');
  await evaluate("document.getElementById('lang-zh2en').click(); 'ok'");
  await sleep(500);
  const c1 = await translate('x', '知识');
  check('知识 → ' + c1.text,
        /knowledge/i.test(c1.text) && !/[\u4e00-\u9fff]/.test(c1.text), c1.text);
  const c2 = await translate('x', '请问洗手间在哪里？');
  check('整句 请问洗手间在哪里？ → ' + c2.text,
        /where/i.test(c2.text) && /bathroom|toilet|restroom|washroom/i.test(c2.text) &&
        !/[\u4e00-\u9fff]/.test(c2.text), c2.text);
  // 用户报过的坑：备用 → 备 use
  const c3 = await translate('x', '备用');
  check('备用 → ' + c3.text,
        !/[\u4e00-\u9fff]\s*[A-Za-z]/.test(c3.text) && !c3.text.includes('备'), c3.text);

  // ---------- ① 生词本 ----------
  console.log('');
  console.log('【① 生词本】');
  const vAll = JSON.parse(await evaluate("localStorage.getItem('tw_vocab') || '[]'"));
  const srcs = vAll.map(x => x.src);
  check('英译汉查过的词都进了生词本（beautiful / I am very tired today）',
        srcs.includes('beautiful') && srcs.includes('I am very tired today'), srcs);
  check('汉译英查过的词也都进了生词本（知识 / 备用 / 句子）',
        srcs.includes('知识') && srcs.includes('备用') && srcs.includes('请问洗手间在哪里？'),
        srcs);
  check('每条都有译文或明确标记待补',
        vAll.every(v => (v.dst && v.dst.length > 0) || v.flag === 'pending'),
        vAll.filter(v => !(v.dst && v.dst.length > 0) && v.flag !== 'pending'));
  check('汉译英条目标记为 zh2en 方向',
        vAll.some(v => v.src === '知识' && v.lang === 'zh2en'),
        vAll.filter(v => v.src === '知识'));

  // 生词本界面真实渲染
  await evaluate("document.getElementById('tab-vocab').click(); 'ok'");
  await sleep(800);
  const ui = JSON.parse(await evaluate(`JSON.stringify({
    rows: document.getElementById('vocab-list').children.length,
    emptyShown: document.getElementById('vocab-empty').style.display !== 'none',
    badge: (document.getElementById('vocab-count').textContent || '').trim(),
    total: JSON.parse(localStorage.getItem('tw_vocab') || '[]').length
  })`));
  check('生词本页面渲染出条目', ui.rows > 0 && ui.emptyShown === false, ui);
  check('生词本角标与实际条数一致', ui.badge === String(ui.total), ui);

  // 重查要把词顶到最前（用户"搜了却没看到"的坑）
  await evaluate("document.getElementById('tab-translate').click(); 'ok'");
  await sleep(400);
  const re = await translate('x', 'beautiful');
  check('重查已有词后置顶显示', re.first === 'beautiful', re.first);

  // 过滤残留不得挡住新词
  await evaluate("document.getElementById('tab-vocab').click(); document.getElementById('vocab-search').value='zzzznomatch'; document.getElementById('tab-vocab').click(); 'ok'");
  await sleep(400);
  await evaluate("document.getElementById('tab-translate').click(); 'ok'");
  await sleep(300);
  await translate('x', 'knowledge');
  const cleared = await evaluate("document.getElementById('vocab-search').value");
  check('新查询自动清掉残留过滤词', cleared === '', cleared);

  check('无未捕获 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3));

  try {
    await evaluate("document.getElementById('tab-vocab').click(); 'ok'");
    await sleep(700);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('verify-three.png', Buffer.from(shot.data, 'base64'));
    console.log('');
    console.log('截图已保存: verify-three.png');
  } catch (e) { console.log('截图失败: ' + e.message); }

  console.log('');
  console.log('======== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ========');
  ws.close(); chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
