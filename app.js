/* 译词通 - 离线英汉互译 + 自动生词本
 * 纯前端，无需网络，数据存在 localStorage
 * 使用牛津英汉词典核心词汇
 */

(function () {
  'use strict';

  var LS_VOCAB = 'tw_vocab';
  var LS_HISTORY = 'tw_history';
  var LS_LANG = 'tw_lang'; // 当前翻译方向
  var LS_API = 'tw_api';   // 自建翻译接口地址
  var LS_TOKEN = 'tw_sync_token';   // 登录令牌（90 天有效，实现"保持登录"）
  var LS_USER = 'tw_sync_user';
  var REMOTE_ENGINE = 'https://107-175-122-81.sslip.io/transword-engine/translate';
  var SYNC_BASE = 'https://107-175-122-81.sslip.io/transword-sync';
  var syncTimer = null, syncBusy = false;

  // 词典数据：完整版在本地/后台离线缓存中可用；公网首访按需加载分片。
  var DICT = (typeof OXFORD_DICT !== 'undefined') ? OXFORD_DICT : {};
  var CN_DICT = (typeof window.CN_DICT !== 'undefined') ? window.CN_DICT : {};
  var dictLoader = (typeof window.TW_DICT_LOADER !== 'undefined') ? window.TW_DICT_LOADER : null;

  // 当前翻译方向: 'en2zh' 或 'zh2en'
  var currentLang = localStorage.getItem(LS_LANG) || 'en2zh';

  // ========== 英译汉 ==========
  function translateEn2Zh(text) {
    var lower = text.toLowerCase().trim();
    if (!lower) return null;
    
    // 先尝试完整匹配（返回完整释义，多义词保留所有意思）
    if (DICT[lower]) {
      return { text: DICT[lower], exact: true };
    }
    // 句子逐词翻译
    return { text: translateSentenceEn2Zh(lower), exact: false };
  }

  // 富词条格式："ph:音标;;n. 义项;;v. 义项"（ECDICT 富化）。
  // 旧格式（无 ;;）整体即释义，完全兼容。
  function parseRichEntry(entry) {
    var s = String(entry == null ? '' : entry);
    var segs = s.split(';;');
    var ph = '';
    var parts = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i].trim();
      if (i === 0 && seg.indexOf('ph:') === 0) { ph = seg.slice(3).trim(); continue; }
      if (seg) parts.push(seg);
    }
    if (!ph && parts.length <= 1) return { ph: '', parts: s ? [s] : [] };
    return { ph: ph, parts: parts };
  }
  function stripPos(s) {
    return String(s).replace(/^[a-z]{1,5}\.\s*/, '').trim();
  }
  // 句子逐词模式下每个词只取最常用的第一个义项，保证输出可读；
  // 完整多义只在"查单词"时展示（translateEn2Zh 的精确匹配分支）。
  function firstSense(entry) {
    var rich = parseRichEntry(entry);
    return stripPos(rich.parts[0] || '').split(/[，,；;]/)[0].trim();
  }
  // 冠词在逐词对照里是噪音（the→"那"），句子模式直接跳过
  var ARTICLES = { the: 1, a: 1, an: 1 };

  function translateSentenceEn2Zh(text) {
    var words = text.replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '';

    var results = [];
    var i = 0;
    while (i < words.length) {
      // 冠词去噪（the→"那"），必须在短语匹配之前跳过
      if (ARTICLES[words[i]] && !DICT[words.slice(i, i + 2).join(' ')] && !DICT[words.slice(i, i + 3).join(' ')]) {
        // 冠词后面没有紧跟的短语词条（如 "the united states"）时才跳过
        var hasPhrase = false;
        for (var pl = 3; pl >= 2; pl--) {
          if (i + pl <= words.length && DICT[words.slice(i, i + pl).join(' ')]) { hasPhrase = true; break; }
        }
        if (!hasPhrase) { i++; continue; }
      }
      // 优先匹配2-3词短语（短语动词：get up / turn off / look for…）
      var found = false;
      for (var len = 3; len >= 1; len--) {
        if (i + len > words.length) continue;
        var phrase = words.slice(i, i + len).join(' ');
        if (DICT[phrase]) {
          var ps = firstSense(DICT[phrase]);
          if (ps) results.push(ps);
          i += len;
          found = true;
          break;
        }
      }
      if (!found) {
        var w = words[i];
        var trans = DICT[w];
        // 词形还原
        if (!trans) {
          if (w.endsWith('ies')) trans = DICT[w.slice(0, -3) + 'y'];
          else if (w.endsWith('ied')) trans = DICT[w.slice(0, -3) + 'y'];
          else if (w.endsWith('es')) trans = DICT[w.slice(0, -2)] || DICT[w.slice(0, -1)];
          else if (w.endsWith('s') && w.length > 3) trans = DICT[w.slice(0, -1)];
          else if (w.endsWith('ed') && w.length > 4) {
            trans = DICT[w.slice(0, -2)] || DICT[w.slice(0, -1)];
            if (!trans) trans = DICT[w.slice(0, -2) + 'e'];
          }
          else if (w.endsWith('ing') && w.length > 5) {
            trans = DICT[w.slice(0, -3)];
            if (!trans) trans = DICT[w.slice(0, -3) + 'e'];
            if (!trans) trans = DICT[w.slice(0, -4)];
          }
          else if (w.endsWith('er') && w.length > 4) trans = DICT[w.slice(0, -2)];
          else if (w.endsWith('est') && w.length > 5) trans = DICT[w.slice(0, -3)];
          else if (w.endsWith('ly') && w.length > 4) trans = DICT[w.slice(0, -2)];
        }
        if (trans) {
          var ws = firstSense(trans);
          if (ws) results.push(ws);
        } else {
          results.push('[' + w + ']');
        }
        i++;
      }
    }
    return results.join('；');
  }

  // ========== 汉译英 ==========
  function translateZh2En(text) {
    text = text.trim();
    if (!text) return null;

    // 防御：汉译英模式下输入了英文 → 走英译词典，避免逐字母输出垃圾
    if (/^[a-zA-Z][a-zA-Z0-9\s'.-]*$/.test(text)) {
      return translateEn2Zh(text);
    }

    // 先尝试完整匹配（返回完整候选，如"ready;spare;auxiliary"保留所有意思）
    if (CN_DICT[text]) {
      return { text: CN_DICT[text], exact: true, missing: 0 };
    }
    // 逐词匹配；缺字时结果不完整，命中多词时只是逐字直译（词序不可靠）
    var r = translateSentenceZh2En(text);
    return { text: r.text, exact: false, missing: r.missing, hits: r.hits };
  }

  function translateSentenceZh2En(text) {
    var results = [];
    var i = 0;
    var len = text.length;
    var missing = 0;
    var hits = 0;

    while (i < len) {
      // 跳过标点、空格
      if (/[\s，。？！；：""''（）【】《》、,\.\?!;:()]/.test(text[i])) {
        i++;
        continue;
      }

      // 优先匹配长词（最长8个字，最短1个字）
      var found = false;
      for (var l = Math.min(8, len - i); l >= 1; l--) {
        var phrase = text.substring(i, i + l);
        if (CN_DICT[phrase]) {
          // 多候选（如 "lav;restroom"）在句中只取首个，避免出现分号
          results.push(String(CN_DICT[phrase]).split(';')[0]);
          i += l;
          found = true;
          hits++;
          break;
        }
      }
      if (!found) {
        // 未收录：跳过，绝不把原汉字塞进英文输出。
        // 曾经这里 push(text[i])，导致「备用」→「备 use」这种中英混杂垃圾。
        missing++;
        i++;
      }
    }
    return { text: results.join(' '), missing: missing, hits: hits };
  }

  // ========== 主翻译函数（离线词典）==========
  function translateAs(text, lang) {
    if (lang === 'zh2en') {
      return translateZh2En(text);
    }
    return translateEn2Zh(text);
  }

  // 判断"汉译英模式下输入了纯英文"：此时实际要做的是英译汉。
  // 不这么做的话，引擎会按 zh-CN|en 翻英文，产出 "Fun" 这种无意义结果。
  function looksEnglish(text) {
    return /^[a-zA-Z][a-zA-Z0-9\s'.,!?\-]*$/.test(text);
  }

  // ========== 翻译源链：自建接口 → 免费接口(MyMemory) → 离线词典 ==========
  // 自建引擎 translate-api.py（Argos 离线神经翻译）监听 8766。
  //
  // 关键：这里不能用写死的 localhost。手机上打开页面时，"localhost"指的是
  // 手机自己，而不是运行引擎的电脑——自建引擎这一层会静默失效，
  // 用户只会看到画面"卡在免费接口"或者迟迟没反应却找不到原因。
  // 所以页面通过服务器打开时一律走同源 /engine（server.js 转发到 8766）：
  //   电脑 http://localhost:8765 或手机 http://192.168.0.254:8765，引擎都走 /engine；
  //   手机不会把 localhost 解析成手机自己；
  //   HTTPS 下（手机离线安装需要）也不会因为 http:// 而被当混合内容拦掉。
  // 只有 file:// 直接打开、没有服务器可代理时，才直连本机 8766。
  var API_PORT = 8766;
  // 线上运行位置：'vps'（部署在 107-175-122-81.sslip.io，同源）/'github'（GitHub Pages，跨域）/''
  function onlineHost() {
    try {
      var h = (location && location.hostname) || '';
      if (/sslip\.io$/.test(h)) return 'vps';
      if (/demoncplus\.github\.io$/.test(h)) return 'github';
      return '';
    } catch (e) { return ''; }
  }
  function sameOriginEngine() {
    try {
      if (typeof location === 'undefined') return '';
      // file:// 没有同源服务器可代理，返回空表示"不可用"
      if (!location.protocol || location.protocol === 'file:') return '';
      if (!location.host) return '';
      return location.origin + '/engine';
    } catch (e) { return ''; }
  }
  function defaultApiUrl() {
    // VPS 线上版：页面/引擎/同步同源，走 /transword-engine/ 反代（无跨域、最快）
    if (onlineHost() === 'vps') return location.origin + '/transword-engine/translate';
    // GitHub Pages 备份入口：跨域直连 VPS 引擎
    if (onlineHost() === 'github') return REMOTE_ENGINE;
    var same = sameOriginEngine();
    if (same) return same;
    return 'http://localhost:' + API_PORT + '/translate';
  }
  function getApiUrl() {
    try {
      var v = localStorage.getItem(LS_API);
      // 空字符串/纯空格一律视为"未配置"，必须回落到自建引擎，
      // 否则输入框被清空后会把空值存下来，导致每次都跳过自建引擎直接降级到免费接口。
      if (v === null || !v.trim()) return defaultApiUrl();
      return v.trim();
    }
    catch (e) { return defaultApiUrl(); }
  }

  // 调试/自测钩子：暴露接口地址解析（test.js 用它回归"空配置不应跳过自建引擎"）
  if (typeof window !== 'undefined') {
    window.TW_DEBUG = {
      getApiUrl: getApiUrl,
      defaultApiUrl: defaultApiUrl,
      sameOriginEngine: sameOriginEngine,
      API_PORT: API_PORT,
      get DEFAULT_API() { return defaultApiUrl(); }   // 保持旧名字可用（跟随当前来源）
    };
  }

  // 译文语言脚本校验（目标中文则必须含汉字，目标英文则必须不含汉字）
  function scriptValid(t, wantCjk) {
    if (!t || typeof t !== 'string') return false;
    if (/^MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID/i.test(t)) return false;
    var hasCjk = /[\u4e00-\u9fff]/.test(t);
    if (wantCjk) {
      if (!hasCjk) return false;
      // 拒绝中英混杂垃圾（如引擎把 chinese 错译成"中国语Name"）：
      // 目标中文不应含连续 3 个及以上的英文字母（保留 iPhone 这类专名由短串通过）
      if (/[a-zA-Z]{3,}/.test(t)) return false;
      return true;
    }
    return !hasCjk;
  }

  // 自建接口：GET {endpoint}?text=..&langpair=en|zh-CN
  // 返回 JSON {translatedText|translation|text} 或纯文本译文（协议与 MyMemory 兼容）
  function customTranslate(endpoint, text, langpair) {
    return new Promise(function (resolve) {
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
      var sep = endpoint.indexOf('?') >= 0 ? '&' : '?';
      var url = endpoint + sep + 'text=' + encodeURIComponent(text) +
        '&langpair=' + encodeURIComponent(langpair);
      fetch(url, ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) {
          // 必须先看状态码：引擎没启动时同源代理会返回 503，
          // 路由不对会返回 404 "Not Found"。这些错误页是纯文本，
          // 若不过滤会被当成"纯文本译文"直接显示给用户（就是用户看到的垃圾输出）。
          if (!r.ok) return null;
          return r.text();
        })
        .then(function (body) {
          clearTimeout(timer);
          if (body === null) { resolve(null); return; }
          var wantCjk = /\|zh/.test(langpair);
          var out = '';
          try {
            var j = JSON.parse(body);
            out = (j && (j.translatedText || j.translation || j.text || j.result)) || '';
          } catch (e) {
            out = body; // 纯文本响应
          }
          out = (out || '').trim();
          // 兜底：即便状态码是 200，明显是错误页/空响应的也不要
          if (/^(not found|bad request|internal server error|service unavailable)$/i.test(out)) {
            resolve(null);
            return;
          }
          resolve(scriptValid(out, wantCjk) ? out : null);
        })
        .catch(function () {
          clearTimeout(timer);
          resolve(null);
        });
    });
  }

  // 从 MyMemory 返回数据中挑选目标语言正确、质量最高的译文
  // 注意：responseData.translatedText 可能是垃圾记忆数据（如 "i love you"->"wo hen mei"），必须校验
  function pickResult(data, langpair) {
    if (!data) return null;
    var wantCjk = /\|zh/.test(langpair); // 目标语言是否为中文
    function valid(t) { return scriptValid(t, wantCjk); }
    var cands = [];
    if (data.responseData && valid(data.responseData.translatedText)) {
      cands.push({ t: data.responseData.translatedText, m: 1 }); // 顶层候选优先级最高
    }
    if (data.matches && data.matches.length) {
      data.matches.forEach(function (x) {
        if (x && valid(x.translation)) cands.push({ t: x.translation, m: x.match || 0 });
      });
    }
    if (!cands.length) return null;
    cands.sort(function (a, b) { return b.m - a.m; });
    var best = cands[0].t.trim();
    return best || null;
  }

  function onlineTranslate(text, langpair) {
    return new Promise(function (resolve) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) { resolve(null); return; }
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 8000);
      var url = 'https://api.mymemory.translated.net/get?q=' +
        encodeURIComponent(text) + '&langpair=' + langpair;
      fetch(url, ctrl ? { signal: ctrl.signal } : {})
        .then(function (r) { return r.json(); })
        .then(function (data) {
          clearTimeout(timer);
          resolve(pickResult(data, langpair));
        })
        .catch(function () {
          clearTimeout(timer);
          resolve(null); // 网络失败/超时
        });
    });
  }

  // ========== 存储 ==========
  function load(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) || def; }
    catch (e) { return def; }
  }
  function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  // 清洗生词本数据。
  // 历史版本可能留下残缺条目（缺 src / dst 是数字或 null / 整个元素是 null）。
  // 这些脏数据会让 vocabKey() 里的 src.toLowerCase() 抛异常，
  // 而异常发生在去重循环中、save() 之前 —— 结果是此后每一次 addToVocab 都半路中断，
  // 用户再搜任何词都进不了生词本，表现为"生词本还是没有添加我刚刚搜索的单词"。
  function sanitizeVocab(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [];
    raw.forEach(function (it) {
      if (!it || typeof it !== 'object') return;
      var src = (typeof it.src === 'string') ? it.src : (it.src == null ? '' : String(it.src));
      if (!src.trim()) return;                        // 没有原文的条目没有意义，丢弃
      var dst = (typeof it.dst === 'string') ? it.dst : (it.dst == null ? '' : String(it.dst));
      var lang = (it.lang === 'zh2en') ? 'zh2en' : 'en2zh';
      var ts = (typeof it.ts === 'number' && isFinite(it.ts)) ? it.ts : Date.now();
      var count = (typeof it.count === 'number' && it.count > 0) ? Math.floor(it.count) : 1;
      // flag: '' 正常译文 | 'literal' 逐词直译（仅供参考）| 'pending' 暂未收录译文
      var flag = (it.flag === 'literal' || it.flag === 'pending') ? it.flag : '';
      out.push({ src: src, dst: dst, lang: lang, ts: ts, count: count, flag: flag, deleted: !!it.deleted });
    });
    return out;
  }

  var rawVocab = load(LS_VOCAB, []);
  var vocab = sanitizeVocab(rawVocab);
  // 清洗后发现与磁盘不一致（说明确实存在脏数据）→ 立即回写一份干净数据
  if (Array.isArray(rawVocab) && vocab.length !== rawVocab.length) {
    save(LS_VOCAB, vocab);
  }
  var history = load(LS_HISTORY, []);

  // ========== DOM ==========
  var $ = function (id) { return document.getElementById(id); };
  var srcEl = $('src'), resultEl = $('result'), resultSrc = $('result-src'),
      resultText = $('result-text'), resultDict = $('result-dict'),
      savedTip = $('saved-tip');

  var lastQuery = '';

  // ========== 语言切换 ==========
  function setLang(lang, focusInput) {
    currentLang = lang;
    localStorage.setItem(LS_LANG, lang);

    $('lang-en2zh').classList.toggle('active', lang === 'en2zh');
    $('lang-zh2en').classList.toggle('active', lang === 'zh2en');

    if (lang === 'en2zh') {
      srcEl.placeholder = '输入英文单词或句子，回车翻译…';
    } else {
      srcEl.placeholder = '输入中文词语或句子，回车翻译…';
    }

    // 清空当前输入和结果
    srcEl.value = '';
    resultEl.classList.add('hidden');
    // 只在用户主动切换语言时聚焦输入框。
    // 页面刚打开时不能聚焦：手机上会立刻弹出键盘挡住半屏，
    // 用户还没看清界面就被键盘顶开（桌面端无感，所以以前没暴露）。
    if (focusInput) srcEl.focus();
  }

  var reqSeq = 0; // 翻译请求序号，防止旧响应覆盖新结果

  function doTranslate() {
    var text = srcEl.value.trim();
    if (!text) return;
    lastQuery = text;
    var mySeq = ++reqSeq;

    // 汉译英模式下输入纯英文时，实际方向是"英译汉"（否则引擎会把 fun 翻成 Fun）
    var effLang = (currentLang === 'zh2en' && looksEnglish(text)) ? 'en2zh' : currentLang;
    var flipped = effLang !== currentLang;

    resultEl.classList.remove('hidden');
    resultSrc.textContent = text;
    resultText.textContent = '翻译中…';
    resultDict.innerHTML = '';
    savedTip.classList.add('hidden');

    // 句子并行加速：整句/长短语不等词典分片下载，立刻发起引擎请求，
    // 分片加载和引擎请求并行，句子总耗时省 1~2 秒（单词不预发，走词典秒回）。
    var isEntryShaped = effLang === 'en2zh'
      ? /^[a-zA-Z][a-zA-Z'-]*$/.test(text.trim())
      : /^[\u4e00-\u9fff]{1,6}$/.test(text.trim());
    var enginePromise = null;
    if (!isEntryShaped && navigator.onLine !== false) {
      var lp0 = effLang === 'zh2en' ? 'zh-CN|en' : 'en|zh-CN';
      var api0 = getApiUrl();
      if (api0) enginePromise = customTranslate(api0, text, lp0);
    }

    // 公网首访只下载当前查询涉及的词典分片，而不是首屏下载全部 2.9MB。
    // 完整词典由 Service Worker 在后台缓存；下载完成后断网也可用。
    // 本地已带完整词典时保持同步返回；公网分片模式才需要等待加载。
    if (!dictLoader) {
      translateLoaded(text, mySeq, effLang, flipped, enginePromise);
      return;
    }
    var ready = dictLoader.prepare(text, effLang);
    // 慢网下某个分片可能长时间挂起：8 秒超时后直接走在线翻译链兜底，
    // 不把结果卡死在"翻译中…"（后台仍会继续下载分片，下一次查询受益）。
    var timedOut = false;
    var timeoutId = setTimeout(function () {
      timedOut = true;
      if (mySeq === reqSeq) {
        resultText.textContent = '词典加载较慢';
        resultDict.innerHTML = '<div style="color:#888;font-size:13px;">⚡ 离线词典分片加载较慢，正在请求在线翻译…</div>';
        translateOnlineOnly(text, mySeq, effLang, flipped);
      }
    }, 8000);
    Promise.resolve(ready).then(function () {
      clearTimeout(timeoutId);
      if (timedOut || mySeq !== reqSeq) return;
      translateLoaded(text, mySeq, effLang, flipped, enginePromise);
    }).catch(function () {
      clearTimeout(timeoutId);
      if (mySeq !== reqSeq) return;
      // 分片网络失败不能当成"词典未收录"，否则会显示误导性的逐词残句。
      resultText.textContent = '词典加载失败';
      resultDict.innerHTML = '<div style="color:#c8891a;font-size:13px;">' +
        '词典分片暂时无法下载，正在尝试在线翻译；联网后重查即可使用离线词典。</div>';
      translateOnlineOnly(text, mySeq, effLang, flipped);
    });
  }

  function translateOnlineOnly(text, mySeq, effLang, flipped) {
    var langpair = effLang === 'zh2en' ? 'zh-CN|en' : 'en|zh-CN';
    var api = getApiUrl();
    var chain = api ? customTranslate(api, text, langpair) : Promise.resolve(null);
    chain.then(function (r) {
      return r ? { text: r, source: '🏠 自建接口' } : onlineTranslate(text, langpair).then(function (x) {
        return x ? { text: x, source: '🌐 免费接口（MyMemory）' } : null;
      });
    }).then(function (best) {
      if (mySeq !== reqSeq) return;
      if (best) {
        resultText.textContent = best.text;
        resultDict.innerHTML = '<div style="color:#2ba84a;font-size:13px;">' + best.source + ' · 句子级翻译</div>';
        addToVocab(text, best.text, true, effLang);
        savedTip.classList.remove('hidden');
      } else {
        resultText.textContent = '暂无翻译';
        addToVocab(text, '', true, effLang, 'pending');
      }
    });
  }

  function translateLoaded(text, mySeq, effLang, flipped, enginePromise) {

    // 第一步：离线词典，立即出结果
    var res = translateAs(text, effLang);
    if (!res) {
      resultText.textContent = '请输入内容';
      return;
    }

    // 离线结果可靠吗？
    //   - 汉译英有汉字没收录 → 残句（如「备用」→「use」）不是译文
    //   - 汉译英/英译汉整句 → 逐词拼接词序必然错乱，不能当正式译文
    // 这些不能作为正式译文展示（否则用户会先看到一段错误内容再被覆盖），
    // 但**仍要记进生词本**（用户要求"搜过的都自动收录"），只是打标记。
    var trimmed = text.trim();
    var isDictEntry = effLang === 'en2zh'
      ? /^[a-z][a-z'-]*$/.test(trimmed.toLowerCase())
      : /^[\u4e00-\u9fff]{1,6}$/.test(trimmed);
    var wordByWord = effLang === 'zh2en' && !res.exact && (res.hits || 0) > 1;
    // 英译汉整句：非精确命中即逐词拼接，同样不算正式译文
    var sentenceLevel = !isDictEntry && !res.exact;
    var incomplete = !!res.missing || !res.text || wordByWord || sentenceLevel;

    if (incomplete) {
      resultText.textContent = '翻译中…';
      resultDict.innerHTML = '<div style="color:#888;font-size:13px;">⚡ ' +
        (sentenceLevel ? '正在翻译整句…'
          : wordByWord ? '离线词典仅能逐词直译，正在请求引擎…'
          : '离线词典未收录，正在请求引擎…') + '</div>';
      savedTip.classList.add('hidden');
      // 先以"待补译文"状态收录，保证搜索过的词一定进生词本；
      // 稍后引擎若返回好译文，下面的分支会把它升级为正式译文。
      addToVocab(text, '', true, effLang, 'pending');
    } else {
      var offlineText = res.text;
      resultText.innerHTML = renderRich(offlineText);
      resultDict.innerHTML = '<div style="color:#888;font-size:13px;">⚡ 离线词典（正在尝试更准确的翻译源…）</div>';
      addToVocab(text, offlineText, true, effLang);
      savedTip.classList.remove('hidden');
    }
    addHistory(text);

    // 单词/词条精确命中时，离线词典已给出完整多义，直接返回，不再请求引擎。
    // 避免"先显示完整释义、再被引擎覆盖成单义"的跳变，同时保留多义词的全部意思。
    // 短语和整句仍走引擎精翻。
    if (res.exact && !incomplete && isDictEntry) {
      resultDict.innerHTML = '<div style="color:#888;font-size:13px;">⚡ 离线词典' +
        (flipped ? '（检测到输入为英文，已按英→汉处理）' : '') + '</div>';
      return;
    }

    // 第二步：三级翻译链 自建接口 → 免费接口，成功则覆盖为更准确的句子翻译
    // enginePromise：句子在分片加载时已并行发起的引擎请求（省 1~2 秒）
    var langpair = effLang === 'zh2en' ? 'zh-CN|en' : 'en|zh-CN';
    var api = getApiUrl();

    var chain = enginePromise
      ? enginePromise.then(function (r) {
          return r ? { text: r, source: '🏠 自建接口' } : null;
        })
      : (api
          ? customTranslate(api, text, langpair).then(function (r) {
              return r ? { text: r, source: '🏠 自建接口' } : null;
            })
          : Promise.resolve(null));

    chain.then(function (hit) {
      if (hit) return hit;
      return onlineTranslate(text, langpair).then(function (r) {
        return r ? { text: r, source: '🌐 免费接口（MyMemory）' } : null;
      });
    }).then(function (best) {
      if (mySeq !== reqSeq) return; // 已有新的翻译请求，丢弃旧响应
      if (best) {
        resultText.textContent = best.text;
        resultDict.innerHTML = '<div style="color:#2ba84a;font-size:13px;">' +
          best.source + ' · 句子级翻译' +
          (flipped ? '（检测到输入为英文，已按英→汉处理）' : '') + '</div>';
        // 这里必须传 countIt=false：本次查询在第一步（离线词典阶段）已经计过数了。
        // 原来传的是 incomplete，导致"整句"这类需要引擎的输入被计两次
        //（先以 pending 收录 +1，引擎返回后又 +1），用户查一次却显示"查询 2 次"。
        addToVocab(text, best.text, false, effLang); // 覆盖待补/直译状态为正式译文
        savedTip.classList.remove('hidden');
      } else if (incomplete) {
        if (res.text && !res.missing) {
          // 词典逐字直译：词序靠不住，但词义有用 → 标成"逐词直译参考"而非译文
          resultText.textContent = res.text;
          resultDict.innerHTML = '<div style="color:#c8891a;font-size:13px;">' +
            '⚡ 离线逐词直译（词序可能不准，仅供参考）。<br>' +
            '如需准确句子翻译，请运行 translate-api.py 启动引擎。</div>';
          addToVocab(text, res.text, false, effLang, 'literal'); // 收录但标注为参考
          savedTip.classList.add('hidden');
        } else {
          // 残句/无结果绝不能当译文，如实告知；但仍然收录进生词本（用户要求搜过的都记录）
          resultText.textContent = '暂无翻译';
          resultDict.innerHTML = '<div style="color:#e05252;font-size:13px;">' +
            '离线词典未收录该词，且翻译引擎未启动。<br>' +
            '请运行 translate-api.py 后重试（已启动引擎时可断网使用）。<br>' +
            '<span style="color:#888;">该词已记入生词本，待引擎可用时重查即可补上译文。</span></div>';
          addToVocab(text, '', false, effLang, 'pending');
          savedTip.classList.add('hidden');
        }
      } else {
        resultDict.innerHTML = '<div style="color:#888;font-size:13px;">⚡ 离线词典翻译（' +
          (api ? '自建/免费接口' : '免费接口') + '均不可用时的兜底结果）</div>';
      }
    });
  }

  // 生词本去重键：必须带语言方向。
  // 只用 src 做键时，先查英译汉 fun、再查汉译英 fun 会被当成同一个词，
  // 后者只更新不新增（角标不变、看不到新条目），用户会以为"没添加成功"。
  function vocabKey(src, lang) {
    return lang + '|' + String(src == null ? '' : src).toLowerCase();
  }

  // ========== 生词本账号同步（登录后跨设备自动合并） ==========
  function syncToken() {
    try { return localStorage.getItem(LS_TOKEN) || ''; } catch (e) { return ''; }
  }
  function setSyncUser(name, token) {
    try {
      if (name && token) {
        localStorage.setItem(LS_USER, name);
        localStorage.setItem(LS_TOKEN, token);
      } else {
        localStorage.removeItem(LS_USER);
        localStorage.removeItem(LS_TOKEN);
      }
    } catch (e) {}
    renderSyncBox();
  }
  function renderSyncBox() {
    var login = $('sync-login'), info = $('sync-info'), hint = $('sync-hint');
    if (!login || !info) return;
    var name = '';
    try { name = localStorage.getItem(LS_USER) || ''; } catch (e) {}
    if (name && syncToken()) {
      login.classList.add('hidden');
      info.classList.remove('hidden');
      if (hint) hint.classList.add('hidden');
      $('sync-user-label').textContent = '已登录：' + name;
    } else {
      login.classList.remove('hidden');
      info.classList.add('hidden');
      if (hint) hint.classList.remove('hidden');
    }
  }
  function syncBaseUrl() {
    // VPS 线上版同源；GitHub Pages 备份入口跨域直连
    return onlineHost() === 'vps' ? (location.origin + '/transword-sync') : SYNC_BASE;
  }
  function syncApi(path, method, body, withAuth) {
    var opts = { method: method || 'GET', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    var token = syncToken();
    if (withAuth !== false && token) opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(syncBaseUrl() + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) {
          var err = new Error((j && j.error) || ('http-' + r.status));
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }
  function syncErrText(e, action) {
    var map = {
      'bad-credentials': '用户名或密码错误',
      'username-taken': '这个用户名已被注册',
      'invalid-username': '用户名需 4-20 位，字母开头，可含数字下划线',
      'invalid-password': '密码需 8-20 位，且同时包含字母和数字',
      'too-many-requests': '尝试太频繁，请一分钟后再试'
    };
    return map[e && e.message] || (action + '失败，请稍后再试');
  }
  function vocabMerge(a, b) {
    var map = {};
    (sanitizeVocab(a).concat(sanitizeVocab(b))).forEach(function (x) {
      var k = vocabKey(x.src, x.lang), old = map[k];
      if (!old) { map[k] = x; return; }
      // ts 更新的一方胜出（deleted 作为版本属性随 ts 传播）
      if ((x.ts || 0) > (old.ts || 0)) {
        map[k] = x;
        return;
      }
      // old 更新或相同：保留 old，但合并字段（删除标记传播 + 译文提升）
      if (x.deleted) old.deleted = true;
      if (!old.deleted) {
        if ((x.dst && (!old.dst || x.flag === '' || old.flag === 'pending')) ||
            (x.flag === '' && old.flag !== '')) old.dst = x.dst;
        if (x.flag === '' || (old.flag !== '' && x.flag !== 'pending')) old.flag = x.flag;
      }
      old.count = Math.max(old.count || 1, x.count || 1);
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); });
  }
  function isOnlinePage() {
    return onlineHost() === 'vps' || onlineHost() === 'github';
  }
  function syncSetStatus(text, kind) {
    var el = $('sync-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'sync-status' + (kind ? ' ' + kind : '');
    el.classList.remove('hidden');
  }
  function syncVocab(reason) {
    if (!isOnlinePage() || syncBusy || !navigator.onLine) return;
    if (!syncToken()) return; // 未登录不请求远程同步
    syncBusy = true;
    syncSetStatus('生词本同步中…', 'loading');
    syncApi('/vocab').then(function (remote) {
      var merged = vocabMerge(vocab, (remote && remote.vocab) || []);
      vocab = merged; save(LS_VOCAB, vocab); renderVocab();
      return syncApi('/vocab', 'PUT', { vocab: merged });
    }).then(function () {
      var name = '';
      try { name = localStorage.getItem(LS_USER) || ''; } catch (e) {}
      syncSetStatus('✓ 生词本已同步' + (name ? '（' + name + '）' : ''), 'ready');
    }).catch(function (e) {
      if (e && e.status === 401) {
        setSyncUser(null, null);
        syncSetStatus('登录已过期，请重新登录', 'warn');
      } else {
        syncSetStatus('生词本同步稍后自动重试', 'warn');
      }
    }).then(function () { syncBusy = false; });
  }
  function scheduleSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncVocab('change'); }, 1200);
  }

  // 断网期间本地改了生词本，联网后自动补同步（用户要求"联网自动更新内容"）
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', function () {
      if (isOnlinePage() && syncToken()) syncVocab('online');
    });
  }

  function addToVocab(src, dst, countIt, lang, flag) {
    lang = lang || currentLang;
    dst = String(dst == null ? '' : dst);
    flag = (flag === 'literal' || flag === 'pending') ? flag : '';
    // 生词本搜索框里可能残留着过滤词，那样刚搜的词会被过滤掉、看着像"没添加成功"。
    // 既然用户刚刚主动查了这个词，就让它一定能被看到：清掉残留的过滤条件。
    var searchEl = $('vocab-search');
    if (searchEl && (searchEl.value || '').trim()) searchEl.value = '';
    var key = vocabKey(src, lang);
    for (var i = 0; i < vocab.length; i++) {
      if (vocabKey(vocab[i].src, vocab[i].lang || 'en2zh') === key) {
        // 再次查询同一个词：更新译文并把该条移到最前面。
        // 原来只更新不移动，被重查的词仍埋在列表底部，用户在顶部看不到，
        // 会以为"刚刚搜索的单词没有添加进生词本"。
        var item = vocab[i];
        var old = String(item.dst == null ? '' : item.dst);
        // 好译文不能被空译文或更差的结果覆盖
        var prevRank = item.flag === 'pending' ? 0 : (item.flag === 'literal' ? 1 : 2);
        var newRank = flag === 'pending' ? 0 : (flag === 'literal' ? 1 : 2);
        if (dst && newRank >= prevRank) { item.dst = dst; item.flag = flag; }
        else if (!old && dst) { item.dst = dst; item.flag = flag; }
        item.ts = Date.now();
        item.lang = lang;
        item.deleted = false;  // 重新查询复活（清除之前的删除标记）
        if (countIt !== false) item.count = (item.count || 1) + 1;
        vocab.splice(i, 1);
        vocab.unshift(item);
        save(LS_VOCAB, vocab);
        renderVocab();
        scheduleSync();
        return;
      }
    }
    vocab.unshift({ src: src, dst: dst, lang: lang, ts: Date.now(), count: 1, flag: flag });
    save(LS_VOCAB, vocab);
    renderVocab();
    scheduleSync();
  }

  function renderVocab() {
    var list = $('vocab-list');
    var q = ($('vocab-search').value || '').trim().toLowerCase();
    list.innerHTML = '';
    var shown = 0;

    vocab.forEach(function (item, idx) {
      // 跳过已删除（tombstone）条目：它们只用于同步传播删除，不显示
      if (item.deleted) return;
      // 防御式取值：万一还有漏网的脏数据，也不能让整页渲染崩掉
      var src = String(item.src == null ? '' : item.src);
      var dst = String(item.dst == null ? '' : item.dst);
      if (q && src.toLowerCase().indexOf(q) < 0 && dst.toLowerCase().indexOf(q) < 0) return;
      shown++;
      var li = document.createElement('li');
      var left = document.createElement('div');
      var d = new Date(item.ts);
      var langLabel = item.lang === 'zh2en' ? '汉→英' : '英→汉';
      // 不可靠结果如实标注，避免和正式译文混在一起
      var dstHtml;
      if (item.flag === 'pending') {
        dstHtml = '<span style="color:#e05252;">（暂未查到译文，引擎可用后重查即可补上）</span>';
      } else if (item.flag === 'literal') {
        dstHtml = escapeHtml(vocabDstText(dst)) + ' <span style="color:#c8891a;font-size:12px;">［逐词直译·仅供参考］</span>';
      } else {
        dstHtml = escapeHtml(vocabDstText(dst));
      }
      left.innerHTML =
        '<div class="en">' + escapeHtml(src) + ' <span style="color:#888;font-size:12px;">[' + langLabel + ']</span></div>' +
        '<div class="zh">' + dstHtml + '</div>' +
        '<div class="meta">' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
        ' · 查询 ' + (item.count || 1) + ' 次</div>';

      var ops = document.createElement('div');
      ops.className = 'ops';
      var speakBtn = document.createElement('button');
      speakBtn.textContent = '🔊';
      speakBtn.onclick = function () { 
        var textToSpeak = item.lang === 'zh2en' ? dst : src;
        speak(textToSpeak, item.lang === 'zh2en' ? 'en-US' : 'zh-CN');
      };
      var delBtn = document.createElement('button');
      delBtn.textContent = '删除';
      delBtn.className = 'danger';
      delBtn.onclick = function () {
        // 标记删除（tombstone）而非真正移除，让"删除"能通过同步传播到其他设备
        item.deleted = true;
        item.ts = Date.now();
        save(LS_VOCAB, vocab);
        renderVocab();
        scheduleSync();
      };
      ops.appendChild(speakBtn);
      ops.appendChild(delBtn);

      li.appendChild(left);
      li.appendChild(ops);
      list.appendChild(li);
    });

    // 空状态要区分两种情况：
    //   生词本真的为空 vs 只是被搜索框过滤掉了
    // 原来一律显示"生词本还是空的，去翻译点什么吧～"，
    // 搜索框里残留过滤词时，刚搜的词明明已入库却看到"还是空的"，用户会以为没添加成功。
    var activeCount = vocab.filter(function (v) { return !v.deleted; }).length;
    var emptyEl = $('vocab-empty');
    if (shown) {
      emptyEl.style.display = 'none';
    } else if (q && activeCount) {
      emptyEl.textContent = '生词本里有 ' + activeCount + ' 个词，但没有匹配「' + q + '」的（清空上方搜索框可看全部）';
      emptyEl.style.display = 'block';
    } else {
      emptyEl.textContent = '生词本还是空的，去翻译点什么吧～';
      emptyEl.style.display = 'block';
    }
    $('vocab-count').textContent = activeCount;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function addHistory(text) {
    var key = text.toLowerCase();
    history = history.filter(function (h) { return h.toLowerCase() !== key; });
    history.unshift(text);
    if (history.length > 12) history.length = 12;
    save(LS_HISTORY, history);
    renderHistory();
  }

  function renderHistory() {
    var box = $('history-block'), list = $('history-list');
    if (!history.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    list.innerHTML = '';
    history.forEach(function (h) {
      var b = document.createElement('button');
      b.className = 'chip';
      b.textContent = h.length > 30 ? h.slice(0, 30) + '…' : h;
      b.onclick = function () { srcEl.value = h; doTranslate(); };
      list.appendChild(b);
    });
  }

  function speak(text, lang) {
    if (!('speechSynthesis' in window)) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = lang || (currentLang === 'zh2en' ? 'en-US' : 'zh-CN');
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 词典词条富渲染：音标行 + 每个词性一行（对照有道/百度词典的展示方式）
  function renderRich(entry) {
    var rich = parseRichEntry(entry);
    if (!rich.ph && rich.parts.length === 1) return escapeHtml(rich.parts[0]);
    var html = '';
    if (rich.ph) html += '<div class="phonetic">/' + escapeHtml(rich.ph) + '/</div>';
    rich.parts.forEach(function (p) {
      var m = p.match(/^([a-z]{1,5}\.)\s*(.*)$/);
      if (m) html += '<div class="sense"><span class="pos">' + escapeHtml(m[1]) + '</span>' + escapeHtml(m[2]) + '</div>';
      else html += '<div class="sense">' + escapeHtml(p) + '</div>';
    });
    return html;
  }
  // 生词本/导出用的纯文本形式：去音标、去词性标签，分号连接
  function vocabDstText(dst) {
    var rich = parseRichEntry(dst);
    return rich.parts.map(stripPos).join('；');
  }

  // ========== 事件 ==========
  $('btn-go').onclick = doTranslate;
  $('btn-clear').onclick = function () { srcEl.value = ''; resultEl.classList.add('hidden'); srcEl.focus(); };
  $('btn-copy').onclick = function () {
    // 对照成熟翻译站：一键复制译文
    var text = resultText.textContent || '';
    if (!text || text === '翻译中…') return;
    var done = function () {
      var btn = $('btn-copy'), old = btn.textContent;
      btn.textContent = '✓';
      setTimeout(function () { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
      document.body.removeChild(ta);
    }
  };
  $('btn-speak').onclick = function () {
    var textToSpeak = currentLang === 'zh2en' ? resultText.textContent : lastQuery;
    speak(textToSpeak, currentLang === 'zh2en' ? 'en-US' : 'zh-CN');
  };
  srcEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doTranslate(); }
  });

  // 输入停顿自动翻译（对照成熟翻译站：免点按钮）。
  // 空输入不触发；打字中途的每次变更重置计时，800ms 停顿才查。
  var autoTranslateTimer = null;
  srcEl.addEventListener('input', function () {
    clearTimeout(autoTranslateTimer);
    var val = srcEl.value.trim();
    if (!val) return;
    autoTranslateTimer = setTimeout(function () {
      // 只在翻译页可见时触发，避免切到生词本后仍查询
      if ($('page-translate').classList.contains('active') && srcEl.value.trim() === val) {
        doTranslate();
      }
    }, 800);
  });

  // 用户主动点语言按钮 → 聚焦输入框，方便直接打字
  $('lang-en2zh').onclick = function () { setLang('en2zh', true); };
  $('lang-zh2en').onclick = function () { setLang('zh2en', true); };

  $('tab-translate').onclick = function () { switchTab('translate'); };
  $('tab-vocab').onclick = function () { switchTab('vocab'); };
  function switchTab(name) {
    $('tab-translate').classList.toggle('active', name === 'translate');
    $('tab-vocab').classList.toggle('active', name === 'vocab');
    $('page-translate').classList.toggle('active', name === 'translate');
    $('page-vocab').classList.toggle('active', name === 'vocab');
    if (name === 'vocab') renderVocab();
  }

  $('vocab-search').addEventListener('input', renderVocab);

  $('btn-clear-vocab').onclick = function () {
    var active = vocab.filter(function (v) { return !v.deleted; });
    if (!active.length) return;
    if (confirm('确定清空整个生词本吗？此操作不可恢复。')) {
      // 全部标记删除（tombstone），让"清空"能同步到其他设备
      var now = Date.now();
      vocab.forEach(function (v) { v.deleted = true; v.ts = now; });
      save(LS_VOCAB, vocab);
      renderVocab();
      scheduleSync();
    }
  };

  $('btn-export').onclick = function () {
    var active = vocab.filter(function (v) { return !v.deleted; });
    if (!active.length) { alert('生词本为空'); return; }
    var lines = ['原文\t译文\t方向\t查询次数\t时间\t备注'];
    active.forEach(function (v) {
      var dir = v.lang === 'zh2en' ? '汉→英' : '英→汉';
      var dst = vocabDstText(v.dst).replace(/[\t\r\n]+/g, ' ');
      // 备注列如实反映可靠性，避免导出的表格里把"逐词直译"当成准确译文
      var note = v.flag === 'pending' ? '暂未查到译文'
               : (v.flag === 'literal' ? '逐词直译·仅供参考' : '');
      lines.push([String(v.src).replace(/\t/g, ' '), dst, dir, v.count || 1,
        new Date(v.ts).toLocaleString(), note].join('\t'));
    });
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = '生词本.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  function validateUsername(u) {
    if (!u) return '请输入用户名';
    if (!/^[A-Za-z][A-Za-z0-9_]{3,19}$/.test(u)) return '用户名需 4-20 位，字母开头，可含数字下划线';
    return '';
  }
  function validatePassword(p) {
    if (!p) return '请输入密码';
    if (p.length < 8 || p.length > 20) return '密码需 8-20 位';
    if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) return '密码需同时包含字母和数字';
    return '';
  }
  function showFieldErr(inputId, errId, msg) {
    var input = $(inputId), err = $(errId);
    if (input) input.classList.toggle('invalid', !!msg);
    if (err) err.textContent = msg || '';
  }
  function clearSyncErrors() {
    showFieldErr('sync-user', 'sync-user-err', '');
    showFieldErr('sync-pass', 'sync-pass-err', '');
  }
  function doLogin(username, password) {
    syncApi('/login', 'POST', { username: username, password: password }, false)
      .then(function (j) {
        setSyncUser(j.username, j.token);
        $('sync-pass').value = '';
        clearSyncErrors();
        syncVocab('login');
      })
      .catch(function (e) {
        if (e && e.message === 'bad-credentials') {
          showFieldErr('sync-pass', 'sync-pass-err', '用户名或密码错误');
        } else {
          showFieldErr('sync-user', 'sync-user-err', syncErrText(e, '登录'));
        }
      });
  }
  function doRegister(username, password) {
    syncApi('/register', 'POST', { username: username, password: password }, false)
      .then(function (j) {
        setSyncUser(j.username, j.token);
        $('sync-pass').value = '';
        clearSyncErrors();
        syncVocab('register');
      })
      .catch(function (e) {
        if (e && e.message === 'username-taken') {
          showFieldErr('sync-user', 'sync-user-err', '这个用户名已被注册');
        } else if (e && e.message === 'invalid-username') {
          showFieldErr('sync-user', 'sync-user-err', '用户名需 4-20 位，字母开头，可含数字下划线');
        } else if (e && e.message === 'invalid-password') {
          showFieldErr('sync-pass', 'sync-pass-err', '密码需 8-20 位，且同时包含字母和数字');
        } else {
          showFieldErr('sync-user', 'sync-user-err', syncErrText(e, '注册'));
        }
      });
  }
  function submitSync(action) {
    var u = ($('sync-user').value || '').trim();
    var p = $('sync-pass').value || '';
    var ue = validateUsername(u), pe = validatePassword(p);
    showFieldErr('sync-user', 'sync-user-err', ue);
    showFieldErr('sync-pass', 'sync-pass-err', pe);
    if (ue || pe) return;
    if (action === 'login') doLogin(u, p); else doRegister(u, p);
  }

  $('btn-sync-login').onclick = function () { submitSync('login'); };
  $('btn-sync-register').onclick = function () { submitSync('register'); };
  $('btn-sync-logout').onclick = function () {
    // 先通知服务器废弃令牌，再本地清除；即使服务器调用失败也照常退出。
    syncApi('/logout', 'POST').catch(function () {}).then(function () {
      setSyncUser(null, null);
      syncSetStatus('已退出登录，生词本保存在本机', 'warn');
    });
  };

  // 实时校验：输入时即时提示/清除错误
  $('sync-user').addEventListener('input', function () {
    var u = ($('sync-user').value || '').trim();
    showFieldErr('sync-user', 'sync-user-err', u ? validateUsername(u) : '');
  });
  $('sync-pass').addEventListener('input', function () {
    var p = $('sync-pass').value || '';
    showFieldErr('sync-pass', 'sync-pass-err', p ? validatePassword(p) : '');
  });
  // 密码框按回车直接登录
  $('sync-pass').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); submitSync('login'); }
  });
  // 密码可见切换
  $('btn-toggle-pass').onclick = function () {
    var inp = $('sync-pass');
    inp.type = (inp.type === 'password') ? 'text' : 'password';
  };

  renderSyncBox();
  // 打开页面时若已登录：校验令牌有效后拉取远端生词本；无效则清除登录态。
  if (isOnlinePage()) {
    if (syncToken()) {
      syncApi('/whoami').then(function (j) {
        if (j && j.username) { setSyncUser(j.username, syncToken()); syncVocab('boot'); }
      }).catch(function (e) {
        if (e && e.status === 401) setSyncUser(null, null);
      });
    }
  }

  // ========== PWA ==========
  var offlineStatusEl = $('offline-status');
  function setOfflineStatus(text, kind) {
    if (!offlineStatusEl) return;
    offlineStatusEl.textContent = text;
    offlineStatusEl.className = 'offline-status' + (kind ? ' ' + kind : '');
    offlineStatusEl.classList.remove('hidden');
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(function () {
      // 先保证首屏和第一次查询快；30 秒后再让 SW 后台缓存完整词典。
      setTimeout(function () {
        if (navigator.onLine === false) return;
        setOfflineStatus('离线词典准备中…', 'loading');
        fetch('prepare-offline').then(function (r) {
          return r.json().then(function (j) {
            if (j && j.ok) setOfflineStatus('✓ 离线词典已就绪（可断网使用）', 'ready');
            else setOfflineStatus('离线词典稍后自动重试', 'warn');
          });
        }).catch(function () {
          setOfflineStatus('离线词典稍后自动重试', 'warn');
        });
      }, 30000);
      // 断网重开：直接读已缓存的完整词典，不要求曾逐个下载过所有分片。
      if (!dictLoader || !window.caches) return;
      caches.open('transword-v32').then(function (c) { return c.match('dict.js'); })
        .then(function (hit) {
          if (hit) {
            if (navigator.onLine === false) return dictLoader.loadFull();
            setOfflineStatus('✓ 离线词典已就绪（可断网使用）', 'ready');
          }
        })
        .catch(function () {});
    }).catch(function () {});
    // 新版 sw.js 激活后自动重载一次，避免页面继续跑旧资源。
    // 但不能打断用户正在进行的翻译：首次访问时 SW 激活常发生在第一次查词期间，
    // 无脑 reload 会把刚出的结果清掉（线上 verify 实测触发）。
    // 规则：有翻译在途或用户已输入 → 等翻译结束再重载；否则立即重载。
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (window.__swReloaded) return;
      window.__swReloaded = true;
      var tryReload = function () {
        var busy = reqSeq > 0 && !resultEl.classList.contains('hidden') &&
                   (resultText.textContent === '翻译中…' || srcEl.value.trim() !== '');
        if (busy) { setTimeout(tryReload, 1000); return; }
        location.reload();
      };
      setTimeout(tryReload, 500);
    });
  }

  // 初始化
  setLang(currentLang);
  renderHistory();
  renderVocab();
})();
