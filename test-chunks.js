/* 按需词典真实浏览器测试：首屏体积、分片命中、重复查询缓存、离线完整词典。
 * 用法：node test-chunks.js [地址] [CDP端口]
 * 自签名 HTTPS：TW_EXTRA_CHROME_ARGS=--ignore-certificate-errors
 */
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const URL_ = process.argv[2] || 'http://localhost:8765/';
const PORT = Number(process.argv[3] || 9411);
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, seq = 0, pass = 0, fail = 0;
const pending = new Map();
function check(n, c, x) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + ' => ' + JSON.stringify(x)); } }
function send(method, params) {
  const id = ++seq; ws.send(JSON.stringify({ id, method, params: params || {} }));
  return new Promise((res, rej) => { pending.set(id, { res, rej }); setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 120000); });
}
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
}
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-chunks-'));
  const extra = (process.env.TW_EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, ...extra, URL_], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(800);
    try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); target = l.find(x => x.type === 'page' && x.webSocketDebuggerUrl); } catch (_) {}
  }
  if (!target) throw new Error('Chrome 未就绪');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text);
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  for (let i = 0; i < 40; i++) { try { if (await ev("document.readyState==='complete' && typeof TW_DICT_LOADER!=='undefined'")) break; } catch (_) {} await sleep(500); }

  const initial = JSON.parse(await ev(`JSON.stringify({
    resources: performance.getEntriesByType('resource').map(function(r){return r.name;}),
    bytes: performance.getEntriesByType('resource').reduce(function(a,r){return a+(r.transferSize||r.encodedBodySize||0);},0),
    en: Object.keys(OXFORD_DICT).length, zh: Object.keys(CN_DICT).length
  })`));
  check('首屏不下载 dict.js / cn-dict.js', !initial.resources.some(x => /\/(dict|cn-dict)\.js/.test(x)), initial.resources);
  check('首屏词典为空（按需而非预先全量）', initial.en === 0 && initial.zh === 0, initial);
  check('首屏资源总量小于 200KB', initial.bytes < 200 * 1024, initial.bytes);

  async function query(text, lang) {
    return JSON.parse(await ev(`(async function(){
      var sl=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
      var want=${JSON.stringify(lang)}==='zh2en'?'lang-zh2en':'lang-en2zh';
      document.getElementById(want).click(); await sl(100);
      var ta=document.getElementById('src'); ta.value=${JSON.stringify(text)}; document.getElementById('btn-go').click();
      var last='',stable=0;
      for(var i=0;i<100;i++){
        await sl(300); var out=document.getElementById('result-text').textContent||'';
        if(out && out!=='翻译中…' && out===last){if(++stable>=2)break;}else stable=0; last=out;
      }
      await sl(300);
      var v=JSON.parse(localStorage.getItem('tw_vocab')||'[]');
      return JSON.stringify({text:last,en:Object.keys(OXFORD_DICT).length,zh:Object.keys(CN_DICT).length,
        hit:v.some(function(x){return x.src===${JSON.stringify(text)};}),
        chunks:performance.getEntriesByType('resource').filter(function(r){return /chunks\\//.test(r.name);}).map(function(r){return r.name;})});
    })()`));
  }
  const en = await query('beautiful', 'en2zh');
  check('英文分片查询正确：' + en.text, /美丽|漂亮/.test(en.text), en);
  check('只装载英文相关分片', en.en > 0 && en.en < 5000 && en.zh === 0, en);  // en/b.js 单片 <3000 条
  check('英文查询写入生词本', en.hit, en);
  const before = en.chunks.length;
  const again = await query('beautiful', 'en2zh');
  check('重复查询复用已下载分片', again.chunks.length === before, { before, after: again.chunks.length });
  // 中文查询在英文查询之后进行：新增的分片必须全是 zh/*（不能把英文整本拉下来）
  const zh = await query('知识', 'zh2en');
  check('中文分片查询正确：' + zh.text, /knowledge/i.test(zh.text) && !/[\u4e00-\u9fff]/.test(zh.text), zh);
  check('中文查询只新增中文分片（不拉取整本英文词典）',
        zh.chunks.length > before &&
        zh.chunks.slice(before).every(u => /chunks\/zh\//.test(u)) &&
        zh.zh > 0 && zh.zh < 20000,   // 远小于 60180 全量；单次查询只涉及少数分片
        { enCount: before, zhChunks: zh.chunks, zh: zh.zh });
  // 同一个中文词再查一遍：必须复用已下载分片，不产生新请求
  const zhAgain = await query('知识', 'zh2en');
  check('中文重复查询复用已下载分片', zhAgain.chunks.length === zh.chunks.length, zhAgain.chunks);
  check('中文查询写入生词本', zh.hit, zh);
  // 中文长整句首查：分片数必须受控（远小于 32 个全部分片），否则退化为全量下载
  const longZh = await query('请问洗手间在哪里？', 'zh2en');
  const longChunks = longZh.chunks.filter(u => /chunks\/zh\//.test(u)).length;
  check('中文长整句首查分片数受控（<32 全部分片）', longChunks < 32, { longChunks, text: longZh.text });
  check('中文长整句首查不拉取整本中文词典', longZh.zh < 40000, { zh: longZh.zh });

  // 让 SW 后台准备完整词典，再真正断网重载。
  await send('Page.navigate', { url: new URL('prepare-offline', URL_).href });
  await sleep(4000);
  await send('Page.navigate', { url: URL_ });
  await sleep(5000);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  try { await send('Page.reload', { ignoreCache: true }); } catch (_) {}
  await sleep(5000);
  const offline = await query('knowledge', 'en2zh');
  check('断网重开后完整词典可查询：' + offline.text, /知识/.test(offline.text), offline);
  check('断网时完整词典已恢复（>20000 条）', offline.en > 20000, offline.en);
  check('无未捕获 JS 异常', errors.length === 0, errors);

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  ws.close(); chrome.kill();
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
