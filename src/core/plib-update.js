// 提示词远程更新（1012）：把「官方要下发的词条」放在 OSS 上，用户端拉下来并进自己的库。
//
// 三条纪律：
//  ① 只增不覆盖用户改过的——按条三方比对（本地文本 vs 底账 vs 线上），改过的一律跳过，绝不抹掉用户的活
//  ② 回收站墓碑不复活——用户删过的，更新不会让它回来（与工厂词条同一套规矩）
//  ③ 失败静默——断网/OSS 挂了就当没这回事，一声不响用手上那份，不许弹框、不许拖慢开机
//
// 线上结构（由 tools/plib-publish.js 生成）：
//   prompts/manifest.json     清单：{v, ts, items:[{key,name,group,fav,hash,category}]}
//   prompts/<key>.json        单条内容：{name, group, fav, text}
//
// 底账（本地）：文档\橙子\plib-sync.json —— 记「官方原版长什么样」和「用户库收下的是哪个版本」。
//   三方比对用它：库里文本 == 收下时的版本 → 用户没碰过 → 可覆盖；
//                库里文本 != 收下时的版本 → 用户改过   → 跳过。
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ctx = require('./ctx');

const DIR = () => path.join(app.getPath('documents'), '橙子');
const syncPath = () => path.join(DIR(), 'plib-sync.json');
const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

// ---------- 内置更新地址（1012 用户裁定）----------
// 刻意**不让用户填**：这是官方分发通道，不是用户可配置项——暴露给用户只会带来
// "手抖改错地址→更新永远失败"和"被引导指向别人的库"两种麻烦。要换地址改这一行、重新打包。
// config.plibUpdate.base 只在开发/排查时用（设置里没有入口），留空就走这里。
const BUILTIN_BASE = 'https://chengzi-prompt.oss-cn-hongkong.aliyuncs.com';

// ---------- 底账读写（坏文件当空账，绝不连累用户的词条）----------
let syncCache = null;
function syncLoad() {
  if (syncCache) return syncCache;
  try { syncCache = JSON.parse(fs.readFileSync(syncPath(), 'utf8')); } catch { syncCache = null; }
  if (!syncCache || typeof syncCache !== 'object' || !syncCache.items || typeof syncCache.items !== 'object') {
    syncCache = { items: {} };
  } else {
    // 用户可能手改过库内外的东西：脏条目直接剔掉，别让一条烂数据废掉整次更新
    const clean = {};
    for (const [k, v] of Object.entries(syncCache.items)) {
      if (v && typeof v === 'object' && typeof v.text === 'string' && typeof v.hash === 'string') clean[k] = v;
    }
    syncCache.items = clean;
  }
  return syncCache;
}
function syncSave() {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    fs.writeFileSync(syncPath() + '.tmp', JSON.stringify(syncCache, null, 2));
    fs.renameSync(syncPath() + '.tmp', syncPath());
  } catch (e) {
    try { ctx.dlog('[plib-update] 底账写入失败: ' + (e && e.message)); } catch {}
  }
}

// 公开词条用固定前缀，和工厂词条（factory_）一样有稳定身份；用户自建的词条不带此前缀
const pubId = (key) => 'pub_' + String(key).replace(/[^a-zA-Z0-9_-]/g, '');
const isPubId = (id) => /^pub_/.test(String(id || ''));

// ---------- 拉取 ----------
const trimBase = (b) => String(b || '').trim().replace(/\/+$/, '');
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

// ---------- 合并（纯函数，smoke 可直测）----------
// remote: { key,name,group,fav,hash,category,text }
// 返回 { added, updated, skipped, removed } + 就地改好的 lib
function mergeInto(lib, remoteList, sync, now) {
  const res = { added: 0, updated: 0, skipped: 0, removed: 0 };
  for (const r of remoteList) {
    const pid = pubId(r.key);
    if (!r.text || !String(r.text).trim()) continue;
    const rHash = sha1(r.text);

    // ① 回收站墓碑：用户删过的，更新不许让它复活（与工厂词条同规矩）
    if ((lib.trash || []).some((t) => t.id === pid)) { res.skipped++; continue; }

    const groups = new Set(lib.groups.map((g) => g.id));
    const wantGroup = groups.has(r.group) ? r.group : 'other';
    const idx = lib.prompts.findIndex((x) => x.id === pid || x.id === r.key);
    let placedId;
    if (idx < 0) {
      // 判定"是全新"还是"用户删过但墓碑在 trash 里被清掉了"：正文撞车就不重复塞
      const nt = String(r.text).replace(/\s+/g, ' ').trim();
      const dup = lib.prompts.find((x) => !isPubId(x.id) && String(x.text || '').replace(/\s+/g, ' ').trim() === nt);
      if (dup) placedId = dup.id;   // 同正文已在库里（自己手建/搬运来的）→ 不重复放
      else { lib.prompts.push({ id: pid, name: r.name, text: r.text, group: wantGroup, fav: !!r.fav, ts: now }); placedId = pid; res.added++; }
    } else {
      const cur = lib.prompts[idx];
      placedId = cur.id;
      const base = sync.items[pid];
      // ② 三方比对：底账 hash == 当前文本 hash → 用户没碰过 → 可覆盖
      //             底账 hash != 当前文本 hash → 用户改过     → 跳过（他的活最高优先级）
      //             没有底账（老版本收的/第一次接上）→ 只认"线上和库里一不一样"
      const curHash = sha1(cur.text);
      const userEdited = base ? (curHash !== base.hash) : (curHash !== rHash);
      const stale = !base || base.remoteHash !== rHash;
      if (userEdited) {
        if (stale) res.skipped++;   // 线上有新版但他改过 → 跳过，不覆盖
      } else if (stale && curHash !== rHash) {
        cur.name = r.name; cur.text = r.text; cur.fav = !!r.fav;
        if (groups.has(r.group)) cur.group = r.group;
        res.updated++;
      }
    }
    // 无论新增/更新/跳过，都把"线上版本 + 库里当前版本"记进底账，供下次比对
    const cur = lib.prompts.find((x) => x.id === placedId);
    if (cur) sync.items[placedId] = { key: r.key, remoteHash: rHash, hash: sha1(cur.text), name: r.name, ts: now };
  }
  return res;
}

// 线上删掉的条目：只从底账里摘掉，**用户库里的词条一律不动**（人家收下了就是人家的）
function pruneBaseline(remoteList, sync) {
  const live = new Set(remoteList.map((r) => pubId(r.key)));
  let n = 0;
  for (const k of Object.keys(sync.items)) if (!live.has(k)) { delete sync.items[k]; n++; }
  return n;
}

// 拉清单 + 逐条补齐正文。用户的同步页要"先看有什么、再勾选"，所以这一步单独拆出来。
// 返回 { ok, message, items:[{key,name,group,fav,hash,text}] }
async function fetchRemote(base) {
  let man;
  try {
    const txt = await fetchText(base + '/prompts/manifest.json', 15000);
    man = JSON.parse(txt);
  } catch (e) {
    try { ctx.dlog('[plib-update] 清单拉取失败: ' + (e && e.message)); } catch {}
    return { ok: false, message: '连不上更新地址', items: [] };
  }
  const raw = Array.isArray(man && man.items) ? man.items : [];
  if (!raw.length) return { ok: true, message: '云端还没有词条', items: [] };

  const items = [];
  for (const it of raw) {
    if (!it || !it.key) continue;
    let text = it.text;   // 清单里带了正文就不用再拉一次（小库省请求）
    if (!text) {
      try { const j = JSON.parse(await fetchText(base + '/prompts/' + encodeURIComponent(it.key) + '.json', 15000)); text = j.text; }
      catch (e) { continue; }   // 单条拉不到就跳过这条，不影响其余
    }
    items.push({ key: it.key, name: it.name || it.key, group: it.group || 'other', fav: !!it.fav, hash: it.hash || sha1(text), text });
  }
  return { ok: true, message: '', items };
}

// 同步页要显示的「有哪些、各是什么状态」：不进库，只比对
// state: has=云端有、你库里没有(新) / chg=两边内容不一样(可更新) / same=一模一样 / mine=你改过(同步也不会动它)
// 纯函数（不碰 ctx），机测直调
function classifyRemote(items, lib, sync) {
  return items.map((r) => {
    const pid = pubId(r.key);
    const cur = (lib.prompts || []).find((x) => x.id === pid || x.id === r.key);
    let state = 'has';
    if (cur) {
      const curHash = sha1(cur.text);
      const rHash = r.hash || sha1(r.text);
      if (curHash === rHash) state = 'same';
      else {
        const base = (sync.items || {})[pid];
        // 没有底账时按"改过"算（与 mergeInto 同口径：宁可不动，也不抹掉用户可能的手改）
        const userEdited = base ? (curHash !== base.hash) : true;
        state = userEdited ? 'mine' : 'chg';
      }
    }
    return { key: r.key, name: r.name, group: r.group, state };
  });
}
function buildList(items) {
  return classifyRemote(items, ctx.plibLoad(), syncLoad());
}

// ---------- 应用（用户勾了哪几条就只同步哪几条）----------
// keys 为空/不传 = 全部（开机自动检查走这条，行为与之前一致）
async function applyItems(o) {
  const opt = o || {};
  const cfg = ctx.config || {};
  const pc = (cfg.plibUpdate) || {};
  const base = trimBase(BUILTIN_BASE || pc.base);
  const out = { ok: false, added: 0, updated: 0, skipped: 0, message: '' };
  if (!isHttp(base)) { out.message = '更新地址无效'; return out; }

  const fr = await fetchRemote(base);
  if (!fr.ok) { out.message = fr.message; return out; }
  if (!fr.items.length) { out.ok = true; out.message = '云端还没有词条'; return out; }

  const want = Array.isArray(opt.keys) && opt.keys.length ? new Set(opt.keys) : null;
  const picked = want ? fr.items.filter((x) => want.has(x.key)) : fr.items;
  if (!picked.length) { out.ok = true; out.message = '没勾选任何词条'; return out; }

  const lib = ctx.plibLoad();
  const sync = syncLoad();
  const now = Date.now();
  const r = mergeInto(lib, picked, sync, now);
  pruneBaseline(fr.items, sync);   // 只按"云端全量"摘底账，不能因为这次没勾就把别的条目忘掉

  if (r.added || r.updated) {
    ctx.plibSave();
    if (ctx.broadcast) ctx.broadcast('plib-changed', lib);
  }
  syncSave();

  const parts = [];
  if (r.added) parts.push('新增 ' + r.added + ' 条');
  if (r.updated) parts.push('更新 ' + r.updated + ' 条');
  if (r.skipped) parts.push('跳过 ' + r.skipped + ' 条');
  out.ok = true;
  out.added = r.added; out.updated = r.updated; out.skipped = r.skipped;
  out.message = parts.length ? '完成：' + parts.join('、') : '已是最新';

  // 生图日志（用户要求：同步动作要在日志里看得见）——只在真动手（用户点了同步）时记，
  // 开机自动检查那次静默，免得日志被刷。
  if (!opt.silent && ctx.olog) {
    const names = picked.filter((x) => {
      const pid = pubId(x.key);
      const cur = lib.prompts.find((y) => y.id === pid || y.id === x.key);
      return cur && sha1(cur.text) === x.hash;   // 这次真进/更新成功的
    }).map((x) => x.name);
    if (r.added || r.updated || r.skipped) {
      const head = '☁ 提示词同步：' + parts.join('、');
      const detail = names.length ? '（' + names.slice(0, 8).join('、') + (names.length > 8 ? ' 等' + names.length + '条' : '') + '）' : '';
      ctx.olog(head + detail, 'info');
    }
  }

  pc.lastCheck = now;
  const c = ctx.config && ctx.config.plibUpdate;
  if (c) { c.lastCheck = now; c.lastResult = out.message; }
  if (ctx.saveConfig) ctx.saveConfig();
  return out;
}


// 单飞：手动和开机自动同时来，只跑一次
let running = null;
function run(opts) {
  if (running) return running;
  running = applyItems(opts).catch((e) => {
    try { ctx.dlog('[plib-update] 异常: ' + (e && e.message)); } catch {}
    return { ok: false, message: '更新失败：' + ((e && e.message) || e) };
  }).finally(() => { running = null; });
  return running;
}

// 同步页第一步：看看云端有什么（不写库）
ipcMain.handle('plib-update-preview', async () => {
  const base = trimBase(BUILTIN_BASE);
  if (!isHttp(base)) return { ok: false, message: '更新地址无效', items: [] };
  const fr = await fetchRemote(base);
  if (!fr.ok) return { ok: false, message: fr.message, items: [] };
  return { ok: true, message: fr.message, items: buildList(fr.items) };
});
// 同步页第二步：只同步勾选的（keys 不传 = 全部）
ipcMain.handle('plib-update-apply', (_e, keys) => run({ silent: false, keys: Array.isArray(keys) ? keys : null }));
// 设置卡那个「立即检查更新」钮：不弹勾选，一次全同步（keys 不传=全部），并写生图日志
ipcMain.handle('plib-update-check', () => run({ silent: false }));
ipcMain.handle('plib-update-status', () => {
  const c = (ctx.config && ctx.config.plibUpdate) || {};
  return { base: trimBase(BUILTIN_BASE), auto: !!c.auto, lastCheck: c.lastCheck || 0, lastResult: c.lastResult || '' };
});

// 开机自动（默认关）：延后 8 秒、不 await、不阻塞启动——用户感觉不到它的存在
app.whenReady().then(() => {
  setTimeout(() => {
    try {
      const c = ctx.config && ctx.config.plibUpdate;
      if (!c || !c.auto) return;
      if (!isHttp(BUILTIN_BASE)) return;
      run({ silent: true });
    } catch {}
  }, 8000);
});

ctx.plibUpdateRun = run;
ctx.plibUpdateMerge = mergeInto;   // 给测试用
ctx.plibUpdateSha1 = sha1;

// 纯函数导出（tools/plib-update-test.js 直测合并规矩，不经过 Electron）
module.exports = { mergeInto, sha1, pruneBaseline, pubId, isPubId, classifyRemote };
