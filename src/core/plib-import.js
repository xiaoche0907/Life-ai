// 提示词批量导入（0906）：选文件夹 / 搬运橙子自家老插件 → 解析成候选 → 关键词自动分组 →
// 用户在提示词库卡翻面上确认（可手动改组）→ 入库（复制语义：源文件不动，另存一份备份到文档/橙子/imports）
// 支持：txt/md（---分隔多条）、json（本软件格式/老插件{title,content}/通用嗅探）、csv、png（A1111 parameters / ComfyUI prompt）
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const importsDir = () => path.join(app.getPath('documents'), '橙子', 'imports');

// 解析器与自动分组表 1014 起抽到 plib-parse.js（纯函数），与 tools/pubtool 发布台共用同一份——
// 两边各抄一份关键词表会漂移（同名文件在软件里和云端分到不同组，之前就漂过）。
const { classify, readText, walkDir, scanFiles } = require('./plib-parse');

ipcMain.handle('plib-scan-dir', async (_e, dir) => {
  if (!dir) {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'], title: '选择存放提示词的文件夹' });
    if (ctx.assertTopmost) ctx.assertTopmost('导入文件夹对话框收场');
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    dir = r.filePaths[0];
  }
  if (!fs.existsSync(dir)) return { ok: false, error: '文件夹不存在' };
  const files = [];
  walkDir(dir, 0, files);
  const res = scanFiles(files, dir, ctx.plibLoad());
  return Object.assign({ ok: true, dir, label: path.basename(dir) }, res);
});

// ---------- 搬运橙子自家老插件：只认id含orange的UXP插件存储（第三方一律走文件夹导入，界面零关联）----------
// 0908用户裁定：只许搬「魔改版」（id=com.orange.ps.wheelchair.modNN）；其他橙子系列插件只列名字、灰掉不可点。
// 界面灰掉是表象，plib-scan-plugins 在主进程同样把关。
const MOD_ID_RE = /^com\.orange\.ps\.wheelchair\.mod\d*$/i;
function isModPlugin(id) { return MOD_ID_RE.test(String(id || '')); }
function orangePluginRoots() {
  const out = [];
  const base = path.join(app.getPath('appData'), 'Adobe', 'UXP', 'PluginsStorage', 'PHSP');
  let vers = [];
  try { vers = fs.readdirSync(base); } catch (e) { return out; }
  for (const v of vers) {
    for (const tier of ['External', 'Developer', 'Internal']) {
      const d = path.join(base, v, tier);
      let ids = [];
      try { ids = fs.readdirSync(d); } catch (e) { continue; }
      for (const id of ids) {
        if (!/orange/i.test(id) || /bridge/i.test(id)) continue;
        const pd = path.join(d, id, 'PluginData');
        if (fs.existsSync(pd)) out.push({ id, ver: v, tier, dir: pd });
      }
    }
  }
  return out;
}
// 可搬运插件清单（界面选一个再扫）：按id去重（同一插件多版本/多层目录共存），魔改版可点、其余灰掉
function pluginLabel(id) {
  const m = /mod(\d*)$/i.exec(id);
  if (isModPlugin(id)) return '橙子魔改版' + (m && m[1] ? ' mod' + m[1] : '');
  return String(id).replace(/^com\./, '');
}
ipcMain.handle('plib-list-plugins', () => {
  const roots = orangePluginRoots();
  if (!roots.length) return { ok: false, error: '没有找到橙子系列插件的数据目录' };
  const seen = new Map();
  for (const r of roots) {
    const it = seen.get(r.id) || { id: r.id, label: pluginLabel(r.id), mod: isModPlugin(r.id), vers: [] };
    if (!it.vers.includes(r.ver)) it.vers.push(r.ver);
    seen.set(r.id, it);
  }
  const list = [...seen.values()].sort((a, b) => (b.mod - a.mod) || a.id.localeCompare(b.id));   // 魔改版排前
  return { ok: true, list };
});
ipcMain.handle('plib-scan-plugins', (_e, id) => {
  // 主进程把关：只扫魔改版；传了id还要对上（别的插件即使绕过界面也扫不到）
  const roots = orangePluginRoots().filter((r) => isModPlugin(r.id) && (!id || r.id === id));
  if (!roots.length) return { ok: false, error: id && !isModPlugin(id) ? '只有魔改版插件可以搬运' : '没有找到魔改版插件的数据目录' };
  const files = [], forge = [];
  const sources = [];
  for (const r of roots) {
    const before = files.length;
    // 提示词预设：presets/*.json + 根层的json（webview_storage/user_presets等）；Forge预设单独列
    try { for (const f of fs.readdirSync(path.join(r.dir, 'presets'))) if (/\.json$/i.test(f)) files.push(path.join(r.dir, 'presets', f)); } catch (e) {}
    try { for (const f of fs.readdirSync(r.dir)) if (/\.json$/i.test(f)) files.push(path.join(r.dir, f)); } catch (e) {}
    try {
      for (const f of fs.readdirSync(path.join(r.dir, 'forge_presets'))) {
        if (!/\.json$/i.test(f)) continue;
        const fp = path.join(r.dir, 'forge_presets', f);
        try { const j = JSON.parse(readText(fp)); if (j && j.name && j.data) forge.push({ file: fp, name: j.displayName || j.name, src: r.id }); } catch (e) {}
      }
    } catch (e) {}
    sources.push({ id: r.id, ver: r.ver, tier: r.tier, files: files.length - before });
  }
  const res = scanFiles(files, null, ctx.plibLoad());
  // 同一预设在多个版本目录里重复出现（老插件多版本共存）已按正文去重
  return Object.assign({ ok: true, label: pluginLabel(roots[0].id), sources, forge }, res);
});

// ---------- 入库（复制语义）+ 备份 + 撤销 ----------
ipcMain.handle('plib-import-apply', (_e, payload) => {
  const items = (payload && Array.isArray(payload.items)) ? payload.items : [];
  if (!items.length) return { ok: false, error: '没有选中任何词条' };
  const lib = ctx.plibLoad();
  const batch = 'imp' + Date.now();
  // 去重按归一正文（空白折叠；0909：与 plib.js 补种/恢复同口径，三处一个尺子）
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const existing = new Set(lib.prompts.map((p) => norm(p.text)));
  let added = 0, skipped = 0;
  const ts = Date.now();
  for (const it of items) {
    const text = String(it.text || '').trim();
    if (!text) continue;
    const nt = norm(text);
    if (existing.has(nt) && !payload.allowDup) { skipped++; continue; }
    existing.add(nt);
    const group = lib.groups.find((g) => g.id === it.group) ? it.group : 'other';
    lib.prompts.push({ id: batch + '_' + added, name: String(it.name || '').trim().slice(0, 40) || text.slice(0, 12), text, group, fav: false, ts: ts + added, batch });
    added++;
  }
  ctx.plibSave();
  ctx.broadcast('plib-changed', lib);
  // 搬运批次记账（0907「搬回」键）：来源=插件的最近一批持久记在库里，重启后仍可整批搬回
  if (payload.source === 'plugin' && added) lib.lastCarry = batch;
  // 备份：本次导入的词条另存一份（我们的格式，可再导入），源文件夹删了也不怕
  try {
    fs.mkdirSync(importsDir(), { recursive: true });
    const f = path.join(importsDir(), new Date(ts).toISOString().slice(0, 19).replace(/[:T]/g, '-') + '_' + String(payload.label || '导入').replace(/[<>:"/\\|?*]/g, '_').slice(0, 30) + '.json');
    fs.writeFileSync(f, JSON.stringify({ groups: lib.groups, prompts: lib.prompts.filter((p) => p.batch === batch) }, null, 2));
  } catch (e) {}
  ctx.olog('📥 提示词导入：新增 ' + added + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '') + '（备份已存文档/橙子/imports）', 'ok');
  return { ok: true, added, skipped, batch };
});
ipcMain.handle('plib-import-undo', (_e, batch) => {
  if (!batch) return { ok: false };
  const lib = ctx.plibLoad();
  const n = lib.prompts.length;
  lib.prompts = lib.prompts.filter((p) => p.batch !== batch);
  const removed = n - lib.prompts.length;
  if (lib.lastCarry === batch) delete lib.lastCarry;
  ctx.plibSave();
  ctx.broadcast('plib-changed', lib);
  ctx.olog('📥 已撤销本次导入（移除 ' + removed + ' 条）');
  return { ok: true, removed };
});
// 搬回（0907用户裁定）：把最近一次从插件搬进来的东西整批移出——普通词条（按批次标记）+
// 搬运时复制来的Forge预设文件（carryForge清单，连带它们生成的F词条）。
// 橙子原有的词条/搬运时因重复被跳过的对象天然没有标记，一律不动。插件侧文件从头到尾没被碰过，无需恢复。
// 批次解析：优先记账的lastCarry；没有账（旧版代码搬的/账被清）就回退到库里最近的导入批次——
// 词条身上本来就带batch标记（impNNN），按时间戳取最新一批
function resolveCarryBatch(lib) {
  if (lib.lastCarry && lib.prompts.some((p) => p.batch === lib.lastCarry)) return lib.lastCarry;
  let best = null, bestTs = -1;
  for (const p of lib.prompts) {
    if (!p.batch || !/^imp\d+/.test(p.batch)) continue;
    const ts = Number(p.batch.slice(3)) || 0;
    if (ts > bestTs) { bestTs = ts; best = p.batch; }
  }
  return best;
}
// 搬来的Forge预设文件清单（lib.carryForge=文件名数组，lib.carryForgeBatch=归属的搬运批次）：
// 只在"搬回的正是那个批次"或"已无词条批次可搬（forge孤儿账）"时才删文件——别的批次搬回不许连坐
function carryForgeList(lib) {
  return Array.isArray(lib.carryForge) ? lib.carryForge.filter((f) => /^user_[^\\/]+\.json$/.test(f)) : [];
}
function carryForgeApplies(lib, batch) {
  const files = carryForgeList(lib);
  if (!files.length) return false;
  return !batch || !lib.carryForgeBatch || lib.carryForgeBatch === batch;
}
ipcMain.handle('plib-carry-status', () => {
  const lib = ctx.plibLoad();
  const batch = resolveCarryBatch(lib);
  const count = batch ? lib.prompts.filter((p) => p.batch === batch).length : 0;
  const forgeN = carryForgeApplies(lib, batch) ? carryForgeList(lib).length : 0;
  return { batch: (count || forgeN) ? (batch || 'forge-only') : null, count: count + forgeN };
});
ipcMain.handle('plib-carry-back', () => {
  const lib = ctx.plibLoad();
  const batch = resolveCarryBatch(lib);
  const doForge = carryForgeApplies(lib, batch);
  const forgeFiles = doForge ? carryForgeList(lib) : [];
  if (!batch && !forgeFiles.length) return { ok: false, error: '没有可搬回的批次' };
  const n = lib.prompts.length;
  if (batch) lib.prompts = lib.prompts.filter((p) => p.batch !== batch);
  let removed = n - lib.prompts.length;
  if (lib.lastCarry === batch) delete lib.lastCarry;
  // Forge预设文件：删掉搬来的那批（只按账上文件名点名删，用户自存的user_*不在账上不碰），
  // 再让forge重扫——F词条同步链会把消失文件对应的词条自然清掉
  let forgeRemoved = 0;
  if (forgeFiles.length) {
    const dir = path.join(app.getPath('documents'), '橙子', 'forge-presets');
    for (const f of forgeFiles) {
      try { const fp = path.join(dir, f); if (fs.existsSync(fp)) { fs.unlinkSync(fp); forgeRemoved++; } } catch (e) {}
    }
    delete lib.carryForge;
    delete lib.carryForgeBatch;
    // 同步清掉这批文件生成的F词条（id=forge_user_<slug>）
    const slugs = new Set(forgeFiles.map((f) => 'forge_' + f.replace(/\.json$/, '')));
    const n2 = lib.prompts.length;
    lib.prompts = lib.prompts.filter((p) => !(p.forge && slugs.has(p.id)));
    removed += n2 - lib.prompts.length;
  }
  ctx.plibSave();
  ctx.broadcast('plib-changed', lib);
  if (forgeRemoved && ctx.forgeLoadPresets) { try { ctx.forgeLoadPresets(); } catch (e) {} }
  ctx.olog('📥 搬回完成：移除词条 ' + removed + ' 条' + (forgeRemoved ? ' + Forge预设 ' + forgeRemoved + ' 个' : '') + '（库里原有内容未动，插件侧文件完好）');
  return { ok: true, removed, forgeRemoved };
});
// Forge预设搬运：复制进文档/橙子/forge-presets（user_前缀=用户预设永不被工厂清理；id改user_*防F词条清理正则误杀）
ipcMain.handle('plib-import-forge-presets', (_e, files) => {
  const dir = path.join(app.getPath('documents'), '橙子', 'forge-presets');
  fs.mkdirSync(dir, { recursive: true });
  let copied = 0, skipped = 0;
  const copiedNames = [];
  for (const fp of (files || [])) {
    try {
      const j = JSON.parse(readText(fp));
      if (!j || !j.name || !j.data) { skipped++; continue; }
      const slug = String(j.displayName || j.name).replace(/[<>:"/\\|?*\s]/g, '_').slice(0, 40);
      const fname = 'user_' + slug + '.json';
      const dst = path.join(dir, fname);
      if (fs.existsSync(dst)) { skipped++; continue; }   // 已存在=不覆盖也不记账（搬回时不动它）
      j.id = 'user_' + slug;
      delete j._isFactory;
      fs.writeFileSync(dst, JSON.stringify(j, null, 2));
      copied++;
      copiedNames.push(fname);
    } catch (e) { skipped++; }
  }
  // 搬回记账：这批复制进来的文件名（用户自存/已存在的不在账上，搬回永不误删）；
  // 归属批次=同一次导入的词条批次（lastCarry），词条0条纯Forge搬运=挂forge-only时间戳
  if (copiedNames.length) {
    const lib = ctx.plibLoad();
    lib.carryForge = [...new Set((Array.isArray(lib.carryForge) ? lib.carryForge : []).concat(copiedNames))];
    lib.carryForgeBatch = lib.lastCarry || ('forgeonly' + Date.now());
    ctx.plibSave();
  }
  if (copied && ctx.forgeLoadPresets) { try { ctx.forgeLoadPresets(); } catch (e) {} }
  ctx.olog('📥 Forge预设搬运：复制 ' + copied + ' 个' + (skipped ? '，跳过 ' + skipped + ' 个（已存在/格式不符）' : ''), 'ok');
  return { ok: true, copied, skipped };
});

ctx.plibClassify = classify;   // smoke/其他模块可复用
