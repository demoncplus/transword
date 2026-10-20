/* 译词通 本地 / 局域网服务器
 *
 * 监听 0.0.0.0 而不是 127.0.0.1：手机、平板要通过局域网访问，
 * 只绑回环地址时它们根本连不上（这是"手机上打不开"最常见的原因）。
 *
 * 为什么支持 HTTPS（--https）：
 *   Service Worker 只在"安全上下文"里才能注册。localhost 算安全上下文，
 *   但手机访问 http://192.168.x.x 不算 —— 浏览器直接拒绝注册，
 *   于是没有离线缓存，手机一断网连页面都打不开。
 *   用 HTTPS 后手机上离线安装、离线使用才真正可用。
 *
 * 为什么引擎走同源 /engine 代理：
 *   页面是 https:// 时，浏览器会把 fetch('http://...:8766') 当混合内容拦掉，
 *   自建翻译引擎会静默失效。改成同源 /engine 由本服务器转发，就没有混合内容问题。
 *
 * 用法：
 *   node server.js              HTTP，端口 8765（电脑用 / 手机临时用）
 *   node server.js --https      HTTP 8765 + HTTPS 8443（手机离线安装用）
 *   node server.js --https-only 只开 HTTPS 8443
 *   PORT=9000 node server.js    换端口
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8765);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const ENGINE_PORT = Number(process.env.ENGINE_PORT || 8766);

const argv = process.argv.slice(2);
const WANT_HTTPS = argv.includes('--https') || argv.includes('--https-only');
const HTTPS_ONLY = argv.includes('--https-only');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.crt': 'application/x-x509-ca-cert',
  '.pem': 'application/x-x509-ca-cert',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach(name => {
    (ifaces[name] || []).forEach(ni => {
      if (ni.family !== 'IPv4' || ni.internal) return;
      // 跳过虚拟网卡（VPN/虚拟机）里常见的地址段，优先给出真实局域网地址
      out.push({ name: name, ip: ni.address, virtual: /^(10\.66\.|169\.254\.)/.test(ni.address) });
    });
  });
  // 真实局域网地址排前面（192.168.x / 10.x 等），虚拟网卡兜底
  return out.sort((a, b) => (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
}

/* 把 /engine?text=..&langpair=.. 转发给本机的自建翻译引擎
 * 好处：页面无论 http 还是 https，都是同源请求，不会被混合内容策略拦掉 */
function proxyEngine(req, res) {
  const qs = req.url.split('?')[1] || '';
  const opts = {
    host: '127.0.0.1',
    port: ENGINE_PORT,
    path: '/translate' + (qs ? '?' + qs : ''),
    method: 'GET',
    timeout: 20000
  };
  const up = http.request(opts, upRes => {
    res.writeHead(upRes.statusCode || 502, {
      'Content-Type': upRes.headers['content-type'] || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    upRes.pipe(res);
  });
  up.on('timeout', () => { up.destroy(new Error('引擎响应超时')); });
  up.on('error', () => {
    // 引擎没启动：明确告诉前端"引擎不可用"，让它降级到离线词典
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'engine-unavailable' }));
  });
  up.end();
}

function handler(req, res) {
  let urlPath = req.url.split('?')[0];
  try { urlPath = decodeURIComponent(urlPath); } catch (_) {}

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,OPTIONS'
    });
    res.end();
    return;
  }

  // 自建引擎同源代理（必须在静态文件处理之前）
  if (urlPath === '/engine' || urlPath === '/engine/') { proxyEngine(req, res); return; }

  // 手机安装 CA 证书用：只放出 ca.crt，绝不能放出 server.key 私钥
  if (urlPath === '/ca.crt' || urlPath === '/cert/ca.crt') {
    const caFile = path.join(ROOT, 'cert', 'ca.crt');
    fs.readFile(caFile, (e, data) => {
      if (e) { res.writeHead(404); res.end('请先运行 python gen-cert.py 生成证书'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="transword-ca.crt"',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
    return;
  }
  // 私钥与服务器证书不通过 HTTP 暴露（crt 含公钥但无必要，key 泄漏等于证书彻底失效）
  if (/^\/cert\/(server\.key|server\.crt|ca\.key)$/i.test(urlPath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const file = path.join(ROOT, path.normalize(urlPath).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  // 兜底：cert 目录里除 ca.crt 外的任何文件（含 .key 私钥）都不允许下载
  const rel = path.relative(ROOT, file).replace(/\\/g, '/').toLowerCase();
  if (rel.startsWith('cert/') && rel !== 'cert/ca.crt') {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) { res.writeHead(404); res.end('Not Found'); return; }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        // 禁用 HTTP 缓存：改完刷新就生效，离线由 Service Worker 负责
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(data);
    });
  });
}

function onListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + port + ' 已被占用。请先关掉旧的服务器，或换端口：');
    console.error('  $env:PORT=9000; node server.js');
  } else {
    console.error('服务器启动失败（端口 ' + port + '）：' + err.message);
  }
  process.exit(1);
}

function printBanner(scheme, port) {
  const lan = lanAddresses();
  console.log('');
  console.log('  本机（电脑自己用）： ' + scheme + '://localhost:' + port);
  if (lan.length) {
    console.log('');
    console.log('  手机 / 平板（需和电脑连同一个 Wi-Fi）：');
    lan.forEach(a => {
      console.log('    ' + scheme + '://' + a.ip + ':' + port + '   [' + a.name + ']');
    });
  } else {
    console.log('  （没有检测到局域网地址，手机暂时无法访问）');
  }
}

const httpServer = http.createServer(handler);
httpServer.on('error', err => onListenError(err, PORT));

let httpsServer = null;
let httpsReady = false;
if (WANT_HTTPS) {
  const certDir = path.join(ROOT, 'cert');
  const crt = path.join(certDir, 'server.crt');
  const key = path.join(certDir, 'server.key');
  if (fs.existsSync(crt) && fs.existsSync(key)) {
    httpsServer = https.createServer({ cert: fs.readFileSync(crt), key: fs.readFileSync(key) }, handler);
    httpsServer.on('error', err => onListenError(err, HTTPS_PORT));
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      httpsReady = true;
      console.log('译词通已启动（HTTPS）');
      printBanner('https', HTTPS_PORT);
      console.log('');
      console.log('  手机首次使用（只需一次）：');
      console.log('    1. 手机浏览器打开 http://<上面的局域网IP>:' + PORT + '/ca.crt 下载证书');
      console.log('    2. 安卓：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书，选刚下载的文件');
      console.log('       iPhone：设置 → 已下载描述文件 → 安装；再进 设置 → 通用 → 关于本机');
      console.log('       → 证书信任设置 → 打开对该证书的完全信任');
      console.log('    3. 之后用 https://<局域网IP>:' + HTTPS_PORT + ' 打开，即可离线安装成 App');
      console.log('');
      console.log('  按 Ctrl+C 停止');
    });
  } else {
    console.error('未找到证书，请先运行：python gen-cert.py');
  }
}

if (!HTTPS_ONLY) {
  httpServer.listen(PORT, '0.0.0.0', () => {
    if (!WANT_HTTPS) {
      console.log('译词通已启动');
      printBanner('http', PORT);
      console.log('');
      console.log('  提示：手机上想离线安装成 App，需要 HTTPS 版本：');
      console.log('    1) python gen-cert.py      （生成证书，只需一次）');
      console.log('    2) node server.js --https  （同时开启 HTTPS 8443）');
      console.log('');
      console.log('  想装成 App：安卓 Chrome 菜单 → 安装应用；iPhone Safari 分享 → 添加到主屏幕。');
      console.log('');
      console.log('  按 Ctrl+C 停止');
    } else if (!httpsReady) {
      console.log('译词通 HTTP 已启动，端口 ' + PORT + '（HTTPS 见上方）');
    }
  });
}
