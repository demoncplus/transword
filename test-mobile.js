/* 手机端真机验证：用 Chrome 的移动设备模拟（含触摸事件）真实跑一遍
 *
 * 验证目标（都是手机独有、桌面端测不出来的问题）：
 *   1. 手机尺寸下布局不溢出横滚（375 / 320 两档）
 *   2. 输入框字号 >=16px（否则 iOS 聚焦会放大整个页面）
 *   3. 真实触摸 tap 能触发翻译并写入生词本
 *   4. 局域网 IP 访问时引擎地址指向电脑而非手机自己
 *   5. 触摸目标足够大，进页面不自动弹键盘
 *
 * 用法：node test-mobile.js [页面地址] [CDP端口]
 *       node test-mobile.js http://192.168.0.254:8765/
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find(p => fs.existsSync(p)) || 'chrome.exe';
const URL_ = process.argv[2] || 'http://localhost:8765/';
const PORT = Number(process.argv[3] || 9351);

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
  const jsErrors = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-mobile-'));

  // 关键：Chrome 启动时就带上手机视口参数，模拟真实手机加载
  // TW_EXTRA_CHROME_ARGS 用于自签名 HTTPS 场景（模拟"手机已安装并信任 CA"）
  const extraArgs = (process.env.TW_EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--window-size=375,812',
    ...extraArgs,
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
    if (m.method === 'Runtime.exceptionThrown') {
      jsErrors.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  };

  await send('Runtime.enable');
  await send('Page.enable');

  // 真实安卓手机：设备参数 + 触摸模拟 + 手机 UA
  await send('Emulation.setDeviceMetricsOverride', {
    width: 375, height: 812, deviceScaleFactor: 3, mobile: true
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
  });
  await send('Page.navigate', { url: URL_ });

  await sleep(8000);
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate("document.readyState==='complete' && typeof TW_DICT_LOADER!=='undefined'");
    if (ready === true) break;
    await sleep(1000);
  }
  // 清掉历史数据，从干净状态验证
  await evaluate("localStorage.removeItem('tw_vocab'); location.reload(); 'ok'");
  await sleep(8000);
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate("document.readyState==='complete' && typeof TW_DEBUG!=='undefined'");
    if (ready === true) break;
    await sleep(1000);
  }

  console.log('== 手机端（375x812 安卓触摸模拟）==');
  console.log('  访问地址: ' + URL_);

  // 1. 布局 + 触摸目标 + 字号
  const layout = JSON.parse(await evaluate(`JSON.stringify({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    btnGoH: document.getElementById('btn-go').getBoundingClientRect().height,
    searchFont: parseFloat(getComputedStyle(document.getElementById('vocab-search')).fontSize),
    textareaFont: parseFloat(getComputedStyle(document.getElementById('src')).fontSize),
    tabH: document.getElementById('tab-vocab').getBoundingClientRect().height,
    api: (typeof TW_DEBUG!=='undefined') ? TW_DEBUG.getApiUrl() : null,
    focused: document.activeElement ? document.activeElement.id : '',
    isTouch: ('ontouchstart' in window) || navigator.maxTouchPoints > 0
  })`));
  check('已按触摸设备识别（maxTouchPoints > 0）', layout.isTouch === true, layout.isTouch);
  check('手机宽度下无横向溢出', layout.docW <= layout.winW + 1, { docW: layout.docW, winW: layout.winW });
  check('生词本搜索框字号 >=16px（iOS 聚焦不放大）', layout.searchFont >= 16, layout.searchFont);
  check('翻译输入框字号 >=16px', layout.textareaFont >= 16, layout.textareaFont);
  check('翻译按钮触摸高度 >=40px', layout.btnGoH >= 40, layout.btnGoH);
  check('页签触摸高度 >=40px', layout.tabH >= 40, layout.tabH);
  check('进页面不自动聚焦输入框（早先 autofocus 会弹键盘挡屏）',
        layout.focused !== 'src', layout.focused);

  // 2. 引擎地址跟随访问来源（手机最关键的一点）
  const origin = new URL(URL_).origin;
  check('引擎地址走同源代理（' + origin + '/engine）',
        layout.api === origin + '/engine', layout.api);
  if (!/localhost|127\.0\.0\.1/.test(new URL(URL_).hostname)) {
    check('手机上引擎不指向手机自己（无 localhost/127.0.0.1）',
          !/localhost|127\.0\.0\.1/.test(layout.api), layout.api);
  }

  // 3. 真实触摸 tap → 翻译 → 入生词本
  const tapRes = JSON.parse(await evaluate(`(async () => {
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var ta = document.getElementById('src');
    ta.value = 'mobile';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    var btn = document.getElementById('btn-go');
    var r = btn.getBoundingClientRect();
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    function fire(type) {
      var t = new Touch({ identifier: 1, target: btn, clientX: cx, clientY: cy });
      btn.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t],
        targetTouches: type === 'touchend' ? [] : [t],
        changedTouches: [t]
      }));
    }
    fire('touchstart'); await sl(80); fire('touchend'); await sl(80);
    btn.click();
    var last = '', stable = 0;
    for (var i = 0; i < 80; i++) {
      await sl(500);
      var out = document.getElementById('result-text').textContent || '';
      if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
      last = out;
    }
    await sl(800);
    var v = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
    return JSON.stringify({
      text: last,
      inVocab: v.some(function (x) { return x.src === 'mobile'; }),
      hitCount: v.length,
      badge: (document.getElementById('vocab-count').textContent || '').trim()
    });
  })()`));
  check('触摸点击能触发翻译: ' + tapRes.text, /[\u4e00-\u9fff]/.test(tapRes.text), tapRes.text);
  check('触摸查询的词已进生词本', tapRes.inVocab === true, tapRes);

  // 4. 触摸设备下按钮 :active 反馈规则存在
  const activeFeedback = await evaluate(`(function(){
    var found = false;
    for (var i = 0; i < document.styleSheets.length; i++) {
      var ss = document.styleSheets[i];
      try {
        for (var j = 0; j < ss.cssRules.length; j++) {
          var t = ss.cssRules[j].cssText || '';
          if (/:active/.test(t) && /transform|filter/.test(t)) found = true;
        }
      } catch (e) {}
    }
    return found;
  })()`);
  check('触摸设备有 :active 点击反馈（触屏没有 hover）', activeFeedback === true, activeFeedback);

  // 5. 窄屏（iPhone SE 320px）也不能溢出
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  await evaluate("document.getElementById('tab-vocab').click(); 'ok'");
  await sleep(700);
  const narrow = JSON.parse(await evaluate(`JSON.stringify({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    exportVisible: document.getElementById('btn-export').getBoundingClientRect().right <= window.innerWidth + 1,
    clearVisible: document.getElementById('btn-clear-vocab').getBoundingClientRect().right <= window.innerWidth + 1,
    searchW: document.getElementById('vocab-search').getBoundingClientRect().width
  })`));
  check('320px 窄屏（iPhone SE）无横向溢出', narrow.docW <= narrow.winW + 1,
        { docW: narrow.docW, winW: narrow.winW });
  check('窄屏上「导出」按钮没被挤出屏幕', narrow.exportVisible === true, narrow);
  check('窄屏上「清空」按钮没被挤出屏幕', narrow.clearVisible === true, narrow);
  check('窄屏上搜索框仍有可用宽度', narrow.searchW > 80, narrow.searchW);

  check('无未捕获 JS 异常', jsErrors.length === 0, jsErrors.slice(0, 3));

  // 6. 离线能力：Service Worker 只在安全上下文（HTTPS 或 localhost）注册。
  //    局域网 HTTP 访问时浏览器会拒绝注册 SW，而 server.js 又禁用了 HTTP 缓存，
  //    结果手机上完全没有离线能力——离开 Wi-Fi 连页面都打不开。
  //    这是"手机能不能离线用"的关键，必须验证。
  const offline = JSON.parse(await evaluate(`(async () => {
    var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var reg = null;
    try { if (navigator.serviceWorker) reg = await navigator.serviceWorker.getRegistration(); } catch (e) {}
    var keys = [];
    try { keys = await caches.keys(); } catch (e) {}
    return JSON.stringify({
      secure: window.isSecureContext === true,
      hasSW: !!navigator.serviceWorker,
      registered: !!reg,
      active: !!(reg && reg.active),
      cacheKeys: keys
    });
  })()`));
  const isSecureEnv = /^https:/.test(URL_) || /localhost|127\.0\.0\.1/.test(new URL(URL_).hostname);
  if (isSecureEnv) {
    check('页面处于安全上下文（离线安装的前提）', offline.secure === true, offline);
    check('Service Worker 已注册并接管', offline.registered === true && offline.active === true, offline);
    check('离线缓存已建立', Array.isArray(offline.cacheKeys) && offline.cacheKeys.length > 0, offline.cacheKeys);

    // SW 注册成功 ≠ 真断网还能用。这里真的把网络掐掉再重载页面，
    // 只有缓存真的生效才能打开，也才能继续查词（离线词典在本地）。
    await send('Network.enable');
    await send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    let reloadErr = null;
    try {
      await send('Page.reload', { ignoreCache: true });
    } catch (e) { reloadErr = e.message; }
    await sleep(6000);

    let offRes = null;
    for (let i = 0; i < 20; i++) {
      try {
        const v = await evaluate(`(function(){
          if (document.readyState !== 'complete') return '';
          if (typeof OXFORD_DICT === 'undefined') return '';
          return 'ready';
        })()`);
        if (v === 'ready') { offRes = 'ready'; break; }
      } catch (e) {
        // 断网重载期间 CDP 可能短暂失败，重试即可
        reloadErr = reloadErr || e.message;
      }
      await sleep(1000);
    }
    check('断网后页面仍能打开（离线缓存真的生效）', offRes === 'ready', { offRes, reloadErr });

    if (offRes === 'ready') {
      const offTrans = JSON.parse(await evaluate(`(async () => {
        var sl = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
        var ta = document.getElementById('src');
        ta.value = 'knowledge';
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('btn-go').click();
        var last = '', stable = 0;
        for (var i = 0; i < 60; i++) {
          await sl(500);
          var out = document.getElementById('result-text').textContent || '';
          if (out && out !== '翻译中…' && out === last) { if (++stable >= 2) break; } else { stable = 0; }
          last = out;
        }
        await sl(600);
        var v = JSON.parse(localStorage.getItem('tw_vocab') || '[]');
        return JSON.stringify({ text: last, hit: v.some(function (x) { return x.src === 'knowledge'; }) });
      })()`));
      check('断网状态下仍能查词翻译: ' + offTrans.text,
            /[\u4e00-\u9fff]/.test(offTrans.text), offTrans.text);
      check('断网查询也照常写入生词本', offTrans.hit === true, offTrans);
    }

    // 恢复网络，避免影响后续断言
    await send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
  } else {
    // 局域网 http:// 不是安全上下文，浏览器直接拒绝注册 Service Worker。
    // 这是浏览器的硬性限制，不是应用缺陷 —— 但不能假装它不存在：
    // 用户在手机上通过 http:// 打开时确实没有离线能力，必须改用 HTTPS。
    console.log('  SKIP  离线能力三项（当前为局域网 http://，浏览器不允许注册 Service Worker）');
    console.log('        手机上要离线使用请改用 HTTPS：python gen-cert.py && node server.js --https');
    check('HTTP 访问时如实报告"离线不可用"（不谎报已离线）',
          offline.secure === false && offline.registered === false, offline);
  }

  // 截图取证（手机视口）
  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  await evaluate("document.getElementById('tab-translate').click(); 'ok'");
  await sleep(900);
  try {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('mobile-result.png', Buffer.from(shot.data, 'base64'));
    console.log('  截图已保存: mobile-result.png');
  } catch (e) { console.log('  截图失败: ' + e.message); }

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  ws.close(); chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
