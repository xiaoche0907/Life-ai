// 提示词库：存用户文档目录（卸载重装软件也不丢）
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const plibPath = () => path.join(app.getPath('documents'), '橙子', 'prompt-library.json');
let plibCache = null;

// 文本归一（0909 重复词条冤案）：空白折叠后比对——"同一条提示词"以正文为准，不看 id
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const isFactoryId = (id) => /^factory_/.test(String(id || ''));

// 内置工厂词条：src/factory_prompts/*.json 跟随软件版本下发；
// 按json里group字段归入语义分组（缺省/未知组→其他），不再单开「内置」分组（用户裁定：默认分组=12语义组）
// 兼容两种格式：{name,text}（本软件）与 {title,content}（老预设导出格式）
// ⚠0909 用户实锤"搜索里同一条出现两次"：删掉工厂词条→搬运把同一正文以新 id 搬回来→「恢复系统提示词」按 id 找不到又补种一份。
//   补种/恢复都只认 id 是根因。修=补种前先看库里有没有**非工厂**词条正文相同（搬来的副本），有就当它已在，不再补种；
//   同时把已中招的库清一遍（搬运副本与工厂词条同文本→去副本，保留 id 稳定的工厂那条）。
//   工厂词条之间本来就有三对同文本不同名（大胸/大胸抹油 等），那是设计，不在此列。
function seedFactoryPrompts(lib) {
  try {
    const dir = path.join(ctx.SRC, 'factory_prompts');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const name = j.name || j.title;
        const text = j.text || j.content;
        if (!name || !text) continue;
        const grp = (j.group && lib.groups.find((g) => g.id === j.group)) ? j.group : 'other';
        const pid = 'factory_' + (j.id || name);
        // 回收站墓碑（0904）：用户删过的工厂词条不再复活；设置卡「恢复系统提示词」清墓碑后照常补种
        if ((lib.trash || []).some((t) => t.id === pid)) continue;
        const ex = lib.prompts.find((x) => x.id === pid);
        if (ex) { ex.name = name; ex.text = text; ex.group = grp; continue; }
        // 同正文的非工厂词条已在（搬运/手建的副本）=内容已存在，不补种（0909）
        const nt = normText(text);
        if (lib.prompts.some((x) => !isFactoryId(x.id) && normText(x.text) === nt)) continue;
        lib.prompts.push({ id: pid, name, text, group: grp, fav: false, ts: Date.now() });
      } catch (e) {
        try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [plib] 工厂词条解析失败 ' + f + ': ' + (e && e.message) + '\n'); } catch {}
      }
    }
    // 已中招的库一次性清理（0909）：搬运来的副本（带 batch）与某条工厂词条正文相同 → 去副本
    const facTexts = new Set(lib.prompts.filter((p) => isFactoryId(p.id)).map((p) => normText(p.text)));
    const before = lib.prompts.length;
    lib.prompts = lib.prompts.filter((p) => !(p.batch && !isFactoryId(p.id) && facTexts.has(normText(p.text))));
    const removed = before - lib.prompts.length;
    if (removed) { try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [plib] 清理与内置词条同文本的搬运副本 ' + removed + ' 条\n'); } catch {} }
    // 老库遗留的「内置」分组：词条已归语义组，空壳清掉
    const fac = lib.groups.find((g) => g.id === 'factory');
    if (fac && !lib.prompts.some((p) => p.group === 'factory')) {
      lib.groups = lib.groups.filter((g) => g.id !== 'factory');
    }
  } catch (e) {}
}

// 内置默认分组（logo版提示词库）：一次性种入，此后用户可自由改名/换图标/删除
// icon为PLIB_ICONS的key（渲染端解析，缺省回退tag图标）；Forge组用专属F标
const DEF_GROUPS = [
  ['hair', '头发'], ['face', '面部'], ['body', '全身'], ['upper', '上半身'], ['lower', '下半身'],
  ['cloth', '服饰'], ['prop', '道具'], ['scene', '场照'], ['bg', '背景'], ['gfx', '特效'], ['other', '其他'],
  ['forge', 'Forge'],
];
function seedDefaultGroups(lib) {
  // F→Forge更名（老库一次性），不吃seed标志
  const fg = lib.groups.find((g) => g.id === 'forge');
  if (fg && fg.name === 'F') { fg.name = 'Forge'; if (!fg.icon) fg.icon = 'forgeF'; plibSave(); }
  if (lib.defGroupsV1) return;
  // 默认分组插到最前（老分组/内置组靠后），网格里第一眼看到的是语义分组
  const add = [];
  for (const [id, name] of DEF_GROUPS) {
    if (!lib.groups.find((g) => g.id === id)) add.push({ id, name, icon: id === 'forge' ? 'forgeF' : id });
  }
  lib.groups = add.concat(lib.groups);
  // 老「默认」组若还是空的就撤掉——被11个语义分组取代；有内容则保留不动
  const dg = lib.groups.find((g) => g.id === 'default');
  if (dg && !lib.prompts.some((p) => p.group === 'default')) {
    lib.groups = lib.groups.filter((g) => g.id !== 'default');
  }
  lib.defGroupsV1 = true;
  plibSave();
}

function plibLoad() {
  if (plibCache) return plibCache;
  const p = plibPath();
  let raw = null;
  try { raw = fs.readFileSync(p, 'utf8'); } catch {}
  if (raw != null) {
    try { plibCache = JSON.parse(raw); }
    catch (e) {
      // 损坏隔离（0905审计采纳）：坏文件改名保留而不是当空库覆盖——用户词条还有救
      plibCache = null;
      try {
        const q = p + '.corrupt-' + Date.now();
        fs.renameSync(p, q);
        setTimeout(() => { try { ctx.olog('⚠️ 提示词库文件损坏，已隔离保留为 ' + path.basename(q) + '（未被覆盖，可修复找回）', 'err'); } catch {} }, 3000);
      } catch (e2) {}
    }
  }
  if (!plibCache || !Array.isArray(plibCache.groups) || !Array.isArray(plibCache.prompts)) {
    plibCache = { groups: [], prompts: [], defGroupsV1: false };
  }
  seedDefaultGroups(plibCache);
  seedFactoryPrompts(plibCache);
  return plibCache;
}
let plibTimer = null;
// 原子保存（0905审计采纳）：tmp+rename，写一半断电/崩溃不毁库（与config同款纪律）
function plibWriteNow() {
  if (!plibCache) return;
  const p = plibPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p + '.tmp', JSON.stringify(plibCache, null, 2));
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [plib] 写入失败: ' + (e && e.message) + '\n'); } catch {}
  }
}
function plibSave() {
  clearTimeout(plibTimer);
  plibTimer = setTimeout(plibWriteNow, 300);
}
// 退出前把防抖等待中的保存立刻落盘（0905审计采纳：最后300ms的改动不再丢）
app.on('before-quit', () => { clearTimeout(plibTimer); plibWriteNow(); });
ipcMain.handle('plib-get', () => plibLoad());
ipcMain.handle('plib-set', (_e, lib) => {
  if (lib && Array.isArray(lib.groups) && Array.isArray(lib.prompts)) {
    plibCache = lib;
    plibSave();
    ctx.broadcast('plib-changed', plibCache);   // 多开卡片时同步
  }
  return plibCache;
});
// 导入：json=整库合并（按id去重，新的覆盖旧的）；txt=作为一条新提示词进当前分组
ipcMain.handle('plib-import', async (_e, groupId) => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '提示词文件', extensions: ['json', 'txt'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, error: '已取消' };
  const lib = plibLoad();
  let added = 0;
  for (const fp of r.filePaths) {
    try {
      const raw = fs.readFileSync(fp, 'utf8');
      if (fp.toLowerCase().endsWith('.json')) {
        const j = JSON.parse(raw);
        for (const g of (j.groups || [])) {
          if (!lib.groups.find((x) => x.id === g.id) && g.id !== 'fav') lib.groups.push({ id: g.id, name: g.name || g.id });
        }
        for (const p of (j.prompts || [])) {
          if (!p || !p.text) continue;
          const i = lib.prompts.findIndex((x) => x.id === p.id);
          if (i >= 0) lib.prompts[i] = p; else lib.prompts.push(p);
          added++;
        }
      } else {
        lib.prompts.push({
          id: 'p' + Date.now() + '_' + added,
          name: path.basename(fp, path.extname(fp)).slice(0, 20),
          text: raw.trim(), group: groupId || 'other', fav: false, ts: Date.now(),
        });
        added++;
      }
    } catch (e) {
      return { ok: false, error: path.basename(fp) + ' 解析失败: ' + (e && e.message) };
    }
  }
  plibSave();
  ctx.broadcast('plib-changed', lib);
  return { ok: true, added };
});

// 导出：整库（分组+词条）存json，与导入格式互通（0904用户裁定）
ipcMain.handle('plib-export', async () => {
  const lib = plibLoad();
  const r = await dialog.showSaveDialog({
    defaultPath: path.join(app.getPath('desktop'), '橙子提示词库_' + new Date().toISOString().slice(0, 10) + '.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, error: '已取消' };
  try {
    fs.writeFileSync(r.filePath, JSON.stringify({ groups: lib.groups, prompts: lib.prompts }, null, 2));
    return { ok: true, file: r.filePath };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// 恢复系统提示词（0904用户裁定，设置卡入口）：回收站整体放回（按id去重），
// 墓碑随之解除，工厂词条立即补种（含软件升级新增的）
// 0909：回收站里那条的正文若已在库里（删掉后又被搬运/手建回来了）——是内置词条就以内置 id 为准：放回内置那条、
//   去掉同正文的副本（自动修图配方等按 promptId 引用，内置 id 稳定）；不是内置的就跳过不放回。放回=同一条出现两次的根
ipcMain.handle('plib-restore-trash', () => {
  const lib = plibLoad();
  const back = lib.trash || [];
  let skipped = 0, dropped = 0;
  for (const p of back) {
    if (lib.prompts.find((x) => x.id === p.id)) continue;
    const nt = normText(p.text);
    const dupIdx = nt ? lib.prompts.filter((x) => normText(x.text) === nt) : [];
    if (dupIdx.length) {
      if (!isFactoryId(p.id)) { skipped++; continue; }
      lib.prompts = lib.prompts.filter((x) => normText(x.text) !== nt);   // 内置为准：副本让位
      dropped += dupIdx.length;
    }
    const q = Object.assign({}, p);
    delete q.delTs;
    if (!lib.groups.find((g) => g.id === q.group)) q.group = 'other';
    lib.prompts.push(q);
  }
  const n = back.length;
  lib.trash = [];
  seedFactoryPrompts(lib);
  plibSave();
  ctx.broadcast('plib-changed', lib);
  if (dropped) { try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [plib] 恢复内置词条时去掉同文本副本 ' + dropped + ' 条\n'); } catch {} }
  return { ok: true, restored: n - skipped, skipped };
});

ctx.plibLoad = plibLoad;
ctx.plibSave = plibSave;
ctx.flushPlib = plibWriteNow;   // 系统关机路径手动同步落盘
