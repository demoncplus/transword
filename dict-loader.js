/* 按需词典加载器：首屏不下载 2.9MB 完整词典，只取本次查询需要的分片。
 *
 * 约定：
 *   - 英文按首字母分片，中文按 FNV-1a 哈希 % 32 分片（与 build_chunks.js 一致）
 *   - 完整词典若已由后台缓存/旧版页面加载，则直接使用，不再发请求
 *   - 分片加载失败不伪造"未收录"：prepare() 抛错，主流程继续尝试在线翻译
 */
(function (global) {
  'use strict';
  var loading = {};
  var loaded = {};
  var ZH_BUCKETS = 32;

  function enBucket(key) {
    var c = String(key || '').charAt(0).toLowerCase();
    return /^[a-z]$/.test(c) ? c : '_';
  }
  function zhBucket(key) {
    var h = 2166136261;
    for (var i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % ZH_BUCKETS;
  }

  function script(url, lang, bucket) {
    var id = lang + '/' + bucket;
    if (loaded[id]) return Promise.resolve();
    if (loading[id]) return loading[id];
    loading[id] = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.onload = function () {
        var data = lang === 'en' ? global.TW_EN_CHUNK : global.TW_ZH_CHUNK;
        var dict = lang === 'en' ? global.OXFORD_DICT : global.CN_DICT;
        if (!data || !dict) { delete loading[id]; reject(new Error('分片格式错误: ' + id)); return; }
        Object.keys(data).forEach(function (k) { dict[k] = data[k]; });
        if (lang === 'en') global.TW_EN_CHUNK = null;
        else global.TW_ZH_CHUNK = null;
        loaded[id] = true;
        delete loading[id];
        resolve();
      };
      el.onerror = function () { delete loading[id]; reject(new Error('分片加载失败: ' + id)); };
      (document.head || document.documentElement).appendChild(el);
    });
    return loading[id];
  }

  function prepareEn(text) {
    var words = String(text || '').toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
    var buckets = {};
    words.forEach(function (w) { buckets[enBucket(w)] = true; });
    // 英文完整匹配可能是短语，首字母同样来自首词。
    if (!words.length) buckets._ = true;
    return Promise.all(Object.keys(buckets).map(function (b) {
      return script('chunks/en/' + b + '.js', 'en', b);
    }));
  }

  function prepareZh(text) {
    var buckets = {};
    var s = String(text || '').trim();
    // 中文词条最长仅 6 字，且 1–2 字（单字/双字词）是词典主体。
    // 只预载每个起点长度 1..2 的子串 + 整句分片：覆盖绝大多数单词/词组，
    // 把整句首查的分片数压到原来的一半左右；3 字以上长词组离线漏命中时
    // 由在线翻译兜底（整句本来就走在线精翻），后台完整缓存后离线也可查。
    for (var i = 0; i < s.length; i++) {
      for (var l = 1; l <= Math.min(2, s.length - i); l++) {
        buckets[zhBucket(s.substring(i, i + l))] = true;
      }
    }
    // 整句本身可能是词典长词条，单独补上它的分片
    buckets[zhBucket(s)] = true;
    return Promise.all(Object.keys(buckets).map(function (b) {
      return script('chunks/zh/' + b + '.js', 'zh', b);
    }));
  }

  function loadFull() {
    if (loading.full) return loading.full;
    loading.full = new Promise(function (resolve, reject) {
      var el = document.createElement('script');
      el.src = 'dict.js';
      el.onload = function () {
        // dict.js 中的 var OXFORD_DICT 会替换 window 属性；app.js 持有的是旧引用，
        // 所以把新完整词典合并回加载器创建的原对象，保证两种加载方式都可见。
        if (global.OXFORD_DICT) {
          Object.keys(global.OXFORD_DICT).forEach(function (k) { EN_DICT[k] = global.OXFORD_DICT[k]; });
          global.OXFORD_DICT = EN_DICT;
        }
        var second = document.createElement('script');
        second.src = 'cn-dict.js';
        second.onload = function () {
          if (global.CN_DICT) {
            Object.keys(global.CN_DICT).forEach(function (k) { ZH_DICT[k] = global.CN_DICT[k]; });
            global.CN_DICT = ZH_DICT;
          }
          loaded.full = true;
          resolve();
        };
        second.onerror = reject;
        (document.head || document.documentElement).appendChild(second);
      };
      el.onerror = reject;
      (document.head || document.documentElement).appendChild(el);
    });
    return loading.full;
  }

  // 把 JavaScript 源码注入页面（用 Blob URL，避免 eval / CSP 风险）
  function injectCode(code) {
    return new Promise(function (resolve, reject) {
      var url = null;
      try {
        url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      } catch (e) { reject(e); return; }
      var el = document.createElement('script');
      el.src = url;
      el.onload = function () { try { URL.revokeObjectURL(url); } catch (_) {} resolve(); };
      el.onerror = function () { try { URL.revokeObjectURL(url); } catch (_) {} reject(new Error('注入失败')); };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  // 预热：完整词典已由 Service Worker 缓存在 Cache Storage 里，
  // 这里直接读缓存注入内存，不发任何网络请求。
  // 预热成功后所有查询都走内存词典（毫秒级），不再逐个下载分片。
  var warmed = null;
  function warmFull() {
    if (loaded.full) return Promise.resolve(true);
    if (warmed) return warmed;
    if (!global.caches) return Promise.reject(new Error('no caches'));
    warmed = (function () {
      return global.caches.keys().then(function (keys) {
        var i = 0;
        function tryNext() {
          if (i >= keys.length) return Promise.reject(new Error('词典未缓存'));
          var name = keys[i++];
          // 缓存名带版本号（transword-vNN），不能写死，取第一个有 dict.js 的
          if (name.indexOf('transword-') !== 0) return tryNext();
          return global.caches.open(name).then(function (c) {
            return c.match('dict.js').then(function (hit) {
              if (!hit) return tryNext();
              return hit.text().then(function (t1) {
                return injectCode(t1).then(function () {
                  if (global.OXFORD_DICT) {
                    Object.keys(global.OXFORD_DICT).forEach(function (k) { EN_DICT[k] = global.OXFORD_DICT[k]; });
                    global.OXFORD_DICT = EN_DICT;
                  }
                  return c.match('cn-dict.js').then(function (h2) {
                    if (!h2) { loaded.full = true; return true; }
                    return h2.text().then(function (t2) {
                      return injectCode(t2).then(function () {
                        if (global.CN_DICT) {
                          Object.keys(global.CN_DICT).forEach(function (k) { ZH_DICT[k] = global.CN_DICT[k]; });
                          global.CN_DICT = ZH_DICT;
                        }
                        loaded.full = true;
                        return true;
                      });
                    });
                  });
                });
              });
            });
          });
        }
        return tryNext();
      });
    })();
    // 失败（比如缓存还没建好）允许下次重试
    warmed.catch(function () { warmed = null; });
    return warmed;
  }

  var EN_DICT = global.OXFORD_DICT || {};
  var ZH_DICT = global.CN_DICT || {};
  global.OXFORD_DICT = EN_DICT;
  global.CN_DICT = ZH_DICT;
  global.TW_DICT_LOADER = {
    prepare: function (text, lang) {
      if (loaded.full) return Promise.resolve();
      // 离线时优先从 Cache Storage 直读完整词典（不发请求、最快）；
      // 缓存读不到再退回 script 注入（SW 网络优先失败后会走缓存兜底）。
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return warmFull().catch(function () { return loadFull(); });
      }
      return lang === 'zh2en' && !/^[a-zA-Z][a-zA-Z0-9\s'.-]*$/.test(String(text || '').trim())
        ? prepareZh(text) : prepareEn(text);
    },
    warmFull: warmFull,
    isWarm: function () { return !!loaded.full; },
    loadFull: loadFull,
    isLoaded: function (lang, bucket) { return !!loaded[lang + '/' + bucket]; },
    enBucket: enBucket,
    zhBucket: zhBucket
  };
})(typeof window !== 'undefined' ? window : globalThis);
