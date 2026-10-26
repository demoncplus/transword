/* 从完整词典生成按需分片；不改动任何词条内容。
 * 运行：node build_chunks.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const ROOT = __dirname;
const OUT = path.join(ROOT, 'chunks');
const ZH_BUCKETS = 32;

function load(file, variable) {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), sandbox, { filename: file });
  if (!sandbox[variable]) throw new Error('无法读取 ' + file);
  return sandbox[variable];
}
function zhBucket(key) {
  // 同步稳定哈希：与 dict-loader.js 的 FNV-1a 完全一致，不需要庞大的键索引
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % ZH_BUCKETS;
}
function enBucket(key) {
  const c = key.charAt(0).toLowerCase();
  return /^[a-z]$/.test(c) ? c : '_';
}

const en = load('dict.js', 'OXFORD_DICT');
const zh = load('cn-dict.js', 'CN_DICT');
const groups = { en: {}, zh: {} };
Object.entries(en).forEach(([k, v]) => {
  const b = enBucket(k); (groups.en[b] ||= {})[k] = v;
});
Object.entries(zh).forEach(([k, v]) => {
  const b = String(zhBucket(k)); (groups.zh[b] ||= {})[k] = v;
});
fs.mkdirSync(path.join(OUT, 'en'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'zh'), { recursive: true });
const index = { version: 1, zhBuckets: ZH_BUCKETS, chunks: {} };

for (const lang of ['en', 'zh']) {
  for (const [bucket, entries] of Object.entries(groups[lang]).sort()) {
    const variable = lang === 'en' ? 'TW_EN_CHUNK' : 'TW_ZH_CHUNK';
    const payload = `(function(g){g.${variable}=${JSON.stringify(entries)};})(this);\n`;
    const rel = `chunks/${lang}/${bucket}.js`;
    fs.writeFileSync(path.join(ROOT, rel), payload);
    index.chunks[`${lang}/${bucket}`] = {
      url: rel, entries: Object.keys(entries).length, bytes: Buffer.byteLength(payload)
    };
  }
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2) + '\n');
const sizes = lang => Object.values(groups[lang]).map(x => Buffer.byteLength(JSON.stringify(x)));
console.log(`英汉：${Object.keys(en).length} 条 / ${Object.keys(groups.en).length} 片`);
console.log(`汉英：${Object.keys(zh).length} 条 / ${Object.keys(groups.zh).length} 片`);
console.log(`平均英文分片 ${(sizes('en').reduce((a,b)=>a+b,0)/sizes('en').length/1024).toFixed(1)} KB`);
console.log(`平均中文分片 ${(sizes('zh').reduce((a,b)=>a+b,0)/sizes('zh').length/1024).toFixed(1)} KB`);
