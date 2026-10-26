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

  var EN_DICT = global.OXFORD_DICT || {};
  var ZH_DICT = global.CN_DICT || {};
  global.OXFORD_DICT = EN_DICT;
  global.CN_DICT = ZH_DICT;
  global.TW_DICT_LOADER = {
    prepare: function (text, lang) {
      if (loaded.full) return Promise.resolve();
      return lang === 'zh2en' && !/^[a-zA-Z][a-zA-Z0-9\s'.-]*$/.test(String(text || '').trim())
        ? prepareZh(text) : prepareEn(text);
    },
    loadFull: loadFull,
    isLoaded: function (lang, bucket) { return !!loaded[lang + '/' + bucket]; },
    enBucket: enBucket,
    zhBucket: zhBucket
  };
})(typeof window !== 'undefined' ? window : globalThis);
