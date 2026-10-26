/* 验证 HTTPS 服务与手机离线能力
 *
 * 关键点：局域网 HTTP 不是安全上下文 → Service Worker 无法注册 → 手机没有离线能力。
 * 本脚本用 CA 证书做真实信任校验，确认 HTTPS 通路可用。
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const CA = path.join(__dirname, 'cert', 'ca.crt');
const ca = fs.readFileSync(CA);
let pass = 0, fail = 0;
function check(n, c, e) {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e !== undefined ? '  => ' + JSON.stringify(e) : '')); }
}

function get(url, opts) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, Object.assign({ timeout: 25000 }, opts || {}), r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: d }));
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

(async () => {
  console.log('== HTTPS 服务与手机离线能力 ==');

  // 1. 证书链验证：用生成的 CA 校验服务器证书，确认手机安装 CA 后能建立信任
  const verify = await new Promise(resolve => {
    const sock = tls.connect({
      host: '127.0.0.1', port: 8443, ca: [ca], servername: 'localhost',
      rejectUnauthorized: true
    }, () => {
      const cert = sock.getPeerCertificate();
      const ok = sock.authorized;
      const san = (cert.subjectaltname || '');
      const reason = sock.authorizationError;
      sock.end();
      resolve({ ok, reason, san, subject: cert.subject && cert.subject.CN });
    });
    sock.on('error', e => resolve({ ok: false, reason: e.message, san: '' }));
    setTimeout(() => { try { sock.destroy(); } catch (_) {} resolve({ ok: false, reason: '超时', san: '' }); }, 15000);
  });
  check('服务器证书能被生成的 CA 校验通过（手机装 CA 后即可信）', verify.ok === true, verify);
  check('证书包含局域网 IP（否则手机访问会报名称不匹配）',
        /192\.168\.0\.254/.test(verify.san), verify.san);

  // 2. HTTPS 能正常提供页面与全部离线资源
  const files = ['index.html', 'app.js', 'style.css', 'dict.js', 'cn-dict.js', 'sw.js', 'manifest.json'];
  const results = {};
  for (const f of files) {
    try {
      const r = await get('https://localhost:8443/' + f, { ca: [ca] });
      results[f] = r.status;
    } catch (e) { results[f] = 'ERR:' + e.message; }
  }
  const allOk = Object.values(results).every(v => v === 200);
  check('HTTPS 下全部离线资源可获取', allOk, results);

  // 3. HTTPS 下引擎同源代理可用（页面 https 时不会触发混合内容拦截）
  try {
    const r = await get('https://localhost:8443/engine?text=fun&langpair=en|zh-CN', { ca: [ca] });
    const j = JSON.parse(r.body);
    check('HTTPS 下同源 /engine 代理可用（避免混合内容）',
          r.status === 200 && /[\u4e00-\u9fff]/.test(j.translatedText || ''), r.body);
  } catch (e) { check('HTTPS 下同源 /engine 代理可用（避免混合内容）', false, e.message); }

  // 4. sw.js 必须真的带离线缓存逻辑，否则手机上装了也离线不了
  const sw = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  check('sw.js 有 install 阶段预缓存',
        /addEventListener\(\s*['"]install['"]/.test(sw) && /addAll\s*\(/.test(sw));
  check('sw.js 的 install 预缓存真正被 waitUntil 等待（否则可能来不及缓存就结束）',
        /e\.waitUntil\([\s\S]{0,200}caches\.open/.test(sw));
  check('sw.js 有 fetch 拦截并回退缓存', /addEventListener\(\s*['"]fetch['"]/.test(sw));
  check('sw.js 保留完整词典的后台离线缓存（首屏不强制下载）', /dict\.js/.test(sw) && /cn-dict\.js/.test(sw));
  check('sw.js 首屏预缓存包含页面与按需加载器', /index\.html/.test(sw) && /app\.js/.test(sw) && /style\.css/.test(sw) && /dict-loader\.js/.test(sw));

  // 5. 默认地址必须是同源 /engine 或本机直连，不能指向 localhost:8766 的绝对 http
  const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  check('app.js 优先使用同源 /engine（HTTPS 下才不会被混合内容拦）',
        /location\.origin\s*\+\s*['"]\/engine['"]/.test(app), '未找到同源代理逻辑');
  check('app.js SSL 页面不再硬编码 http:// 引擎地址', !/return\s+['"]http:\/\/localhost:['"]\s*\+\s*API_PORT/.test(app) ||
        /file:/.test(app));

  console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('崩溃:', e.message); process.exit(1); });
