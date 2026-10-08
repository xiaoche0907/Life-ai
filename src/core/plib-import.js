// 提示词批量导入（0906）：选文件夹 / 搬运橙子自家老插件 → 解析成候选 → 关键词自动分组 →
// 用户在提示词库卡翻面上确认（可手动改组）→ 入库（复制语义：源文件不动，另存一份备份到文档/橙子/imports）
// 支持：txt/md（---分隔多条）、json（本软件格式/老插件{title,content}/通用嗅探）、csv、png（A1111 parameters / ComfyUI prompt）
const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const importsDir = () => path.join(app.getPath('documents'), '橙子', 'imports');
const GROUP_IDS = ['hair', 'face', 'body', 'upper', 'lower', 'cloth', 'prop', 'scene', 'bg', 'gfx', 'other'];

// ---------- 自动分组：类别提示（老插件的category/文件名前缀）优先，其次名字关键词，最后正文开头 ----------
const CAT_MAP = [
  [/^(脸部|面部|face|head)$/i, 'face'], [/^(毛发|头发|hair)$/i, 'hair'], [/^(全身|身材|fullbody|body|figure)$/i, 'body'],
  [/^(身体|上半身|手部|手臂|肩颈|胸部|torso|upper|arm|hand|chest)$/i, 'upper'], [/^(腿部|脚部|下半身|臀部|leg|legs|lower|foot|hip)$/i, 'lower'],
  [/^(服装|服饰|衣服|cloth|clothes|costume|outfit)$/i, 'cloth'], [/^(道具|prop|props)$/i, 'prop'], [/^(场照|场景|scene)$/i, 'scene'],
  [/^(背景|bg|background)$/i, 'bg'], [/^(灯光特效|特效|灯光|光效|gfx|effect|effects|light|vfx)$/i, 'gfx'],
];
// 名字关键词表（顺序即优先级；丝袜按用户裁定归下半身；0907扩词：搬运实测分类不准）
// 0910用户裁定：清场/场照/凳/梯/毯/路人 一律场照（放最前，别被"脚印/地面"之类抢到下半身）；精修/毛孔/睫毛/眉毛 归面部
const KW = [
  ['scene', /清场|场照|路人|凳|梯|毯/],
  ['lower', /丝袜|腿|脚|臀|裤|袜|鞋|靴|膝|踝|骨盆|美腿|thigh|leg|stocking|foot|hip|pantyhose|shoe|boot|knee|ankle/i],
  ['hair', /头发|发型|毛发|发丝|发梢|发色|刘海|辫|马尾|卷发|直发|hair|bangs|ponytail|braid/i],
  ['face', /脸|面部|五官|皮肤|磨皮|修容|精修|妆|眼|唇|鼻|眉|瞳|下颌|下巴|额头|颧骨|睫毛|腮红|嘴|牙|痘|斑|皱纹|毛孔|肤质|美白|表情|face|skin|makeup|eye|lip|blush|eyelash|teeth|wrinkle|pore|freckle/i],
  ['gfx', /特效|灯光|打光|光影|光效|光晕|辉光|光斑|火花|火|雷|电|水花|烟|雾|风|粒子|魔法|气场|尘埃|effect|light|fire|smoke|particle|vfx|glow|neon|flare|aura|magic|spark/i],
  ['bg', /背景|环境|天空|街道|城市|森林|室内|室外|夜景|虚化|景深|background|environment|\bbg\b|sky|street|city|forest|indoor|outdoor|bokeh/i],
  ['scene', /场照|场景|机位|构图|分镜|视角|镜头|全景|特写|姿势|摆姿|pose|scene|camera|shot|angle|composition|lens|close-?up/i],
  ['prop', /道具|武器|饰品|首饰|项链|耳环|手办|模型|帽|包|眼镜|剑|枪|盾|prop|weapon|accessor|jewelry|necklace|earring|figure/i],
  ['cloth', /服|衣|裙|装|泳装|内衣|和服|旗袍|洛丽塔|制服|领口|袖|cloth|dress|costume|outfit|wear|uniform|kimono|swimsuit|lingerie|lolita|\bjk\b/i],
  ['upper', /上半身|手臂|手部|肩|颈|锁骨|胸|背部|腹|肚|手|torso|upper|arm|hand|shoulder|chest|collarbone|belly/i],
  ['body', /全身|身材|体型|身形|比例|曲线|肌肉|瘦身|丰胸|瘦腰|身体|瘦|fullbody|body|figure|slim|muscle|curve|proportion/i],
];
function classify(name, catHint, text) {
  const hint = String(catHint || '').trim();
  if (hint) {
    for (const [re, g] of CAT_MAP) if (re.test(hint)) return { group: g, sure: true };
    const k = kwGroup(hint); if (k) return { group: k, sure: true };
  }
  const k1 = kwGroup(name); if (k1) return { group: k1, sure: true };
  const k2 = kwGroup(String(text || '').slice(0, 240)); if (k2) return { group: k2, sure: false };
  return { group: 'other', sure: false };
}
function kwGroup(s) {
  if (!s) return null;
  for (const [g, re] of KW) if (re.test(s)) return g;
  return null;
}

// ---------- 文本读取：utf8优先，乱码多就按gbk（中文Windows的记事本txt）----------
function readText(fp) {
  const buf = fs.readFileSync(fp);
  let s = buf.toString('utf8');
  const bad = (s.match(/�/g) || []).length;
  if (bad > 2 && bad > s.length / 200) {
    try { s = new TextDecoder('gbk').decode(buf); } catch (e) {}
  }
  return s.replace(/^﻿/, '');
}

// ---------- 各格式解析 → [{name, text, cat}] ----------
function parseTxt(fp) {
  const raw = readText(fp);
  const base = path.basename(fp, path.extname(fp));
  const blocks = raw.split(/\r?\n\s*(?:-{3,}|={3,}|\*{3,})\s*\r?\n/).map((b) => b.trim()).filter(Boolean);
  if (!blocks.length) return [];
  if (blocks.length === 1) return [{ name: base, text: blocks[0] }];
  return blocks.map((b, i) => ({ name: base + ' #' + (i + 1), text: b }));
}
function parseCsv(fp) {
  const lines = readText(fp).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const c = l.indexOf(',');
    if (c < 0) { out.push({ name: path.basename(fp, '.csv') + ' #' + (i + 1), text: l }); continue; }
    const name = l.slice(0, c).trim().replace(/^"|"$/g, ''), text = l.slice(c + 1).trim().replace(/^"|"$/g, '');
    if (i === 0 && /^(name|title|名称|名字)$/i.test(name)) continue;   // 表头
    if (text) out.push({ name: name || (path.basename(fp, '.csv') + ' #' + (i + 1)), text });
  }
  return out;
}
// json 通用嗅探：递归找像词条的对象；字符串值若本身是JSON数组（webview_storage.json那种）再解一层
function pickText(o) {
  return o.content || o.text || o.prompt || o.positivePrompt || o.positive || (o.data && (o.data.positivePrompt || o.data.prompt)) || '';
}
function pickName(o) { return o.title || o.name || o.displayName || o.label || ''; }
function parseJson(fp) {
  let j;
  try { j = JSON.parse(readText(fp)); } catch (e) { return []; }
  const out = [];
  const seen = new Set();
  const push = (name, text, cat) => {
    text = String(text || '').trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    out.push({ name: String(name || '').trim(), text, cat });
  };
  const walk = (v, depth, keyHint) => {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') {
      // 字符串里套JSON（localStorage镜像）：只对像预设/提示词的键解；历史/统计类即使名字带prompt也跳
      // （0907实锤：prompt_history被当词条捞出来=一排"webview_storage"垃圾行）
      if (/preset|prompt|提示/i.test(keyHint || '') && !/history|latency|stats|balance|log/i.test(keyHint || '') && /^\s*[\[{]/.test(v)) {
        try { walk(JSON.parse(v), depth + 1, keyHint); } catch (e) {}
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const it of v) {
        // 裸字符串数组只在预设类键下收，且要像提示词（有点长度；历史输入那种短句不收）
        if (typeof it === 'string') { if (/preset|提示/i.test(keyHint || '') && it.trim().length > 20) push('', it, keyHint); }
        else walk(it, depth + 1, keyHint);
      }
      return;
    }
    if (typeof v === 'object') {
      if (Array.isArray(v.prompts)) { for (const p of v.prompts) if (p && p.text) push(p.name, p.text, p.group); return; }   // 本软件导出格式
      const t = pickText(v);
      if (typeof t === 'string' && t.trim()) { push(pickName(v), t, v.category || v.group || v.subCategory || keyHint); return; }
      for (const k of Object.keys(v)) {
        // 明显不是词条的键整支跳过（0907扩黑名单：聊天/历史/计费/统计/UI状态）
        if (/refImages|image|thumb|history|balance|api|token|latency|sound|theme|ui_|chat|session|spend|fee|scale|collapse|price|channel|stats|_pos|log/i.test(k)) continue;
        walk(v[k], depth + 1, k);
      }
    }
  };
  walk(j, 0, path.basename(fp, '.json'));
  return out;
}
// PNG：A1111 的 tEXt "parameters"（正向=Negative prompt:之前），ComfyUI 的 tEXt "prompt"（取CLIPTextEncode里最长的一段）
function parsePng(fp) {
  let b;
  try { b = fs.readFileSync(fp); } catch (e) { return []; }
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47) return [];
  const texts = {};
  let p = 8;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8);
    if (type === 'IDAT' || type === 'IEND') break;
    if (type === 'tEXt' || type === 'iTXt') {
      const d = b.slice(p + 8, p + 8 + len);
      const z = d.indexOf(0);
      if (z > 0) {
        const key = d.toString('latin1', 0, z);
        let val;
        if (type === 'tEXt') val = d.toString('utf8', z + 1);
        else { let q = z + 1; q += 2; const l1 = d.indexOf(0, q); const l2 = d.indexOf(0, l1 + 1); val = d.toString('utf8', l2 + 1); }
        texts[key] = val;
      }
    }
    p += 12 + len;
  }
  const base = path.basename(fp, path.extname(fp));
  if (texts.parameters) {
    const pos = texts.parameters.split(/\nNegative prompt:|\nSteps:/)[0].trim();
    if (pos) return [{ name: base, text: pos, cat: '' }];
  }
  if (texts.prompt) {
    try {
      const j = JSON.parse(texts.prompt);
      let best = '';
      for (const k of Object.keys(j)) {
        const n = j[k];
        if (n && /CLIPTextEncode/i.test(n.class_type || '') && n.inputs && typeof n.inputs.text === 'string' && n.inputs.text.length > best.length) best = n.inputs.text;
      }
      if (best) return [{ name: base, text: best.trim(), cat: '' }];
    } catch (e) {}
  }
  return [];
}
function parseFile(fp) {
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.txt' || ext === '.md') return parseTxt(fp);
  if (ext === '.json') return parseJson(fp);
  if (ext === '.csv') return parseCsv(fp);
  if (ext === '.png') return parsePng(fp);
  return null;   // 不认识的格式
}

// ---------- 扫描文件夹 → 候选列表 ----------
const SKIP_DIRS = /^(node_modules|image_cache|\.git|sounds|cache|thumbs?)$/i;
// 文档类但暂不解析的格式也收进来（parseFile返回null→计入"不认识的格式"，让用户知道有东西被跳过）
function walkDir(dir, depth, acc) {
  if (depth > 4 || acc.length > 5000) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walkDir(fp, depth + 1, acc); }
    else if (/\.(txt|md|json|csv|png|docx?|rtf|ya?ml|xml|jpe?g|webp)$/i.test(e.name)) acc.push(fp);
  }
}
// 老插件预设文件名 NNN_类别_名称.json → 类别当分组提示、名称当词条名
function nameFromFile(fp) {
  const base = path.basename(fp, path.extname(fp));
  const m = base.match(/^\d+_([^_]+)_(.+)$/);
  return m ? { cat: m[1], name: m[2] } : { cat: '', name: base };
}
function scanFiles(files, root, lib) {
  const items = [];
  const existing = new Set((lib.prompts || []).map((p) => String(p.text || '').trim()));
  const seen = new Set();
  let unknown = 0;
  for (const fp of files) {
    let parsed;
    try { parsed = parseFile(fp); } catch (e) { parsed = []; }
    if (parsed === null) { unknown++; continue; }
    const fn = nameFromFile(fp);
    for (const it of parsed) {
      const text = String(it.text || '').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      // 命名兜底：单条文件用文件名（"丝袜质感增强.txt"）；多条文件用各自内容前12字——
      // 一个json捞出N条全叫文件名=一排"webview_storage"（0907实锤）
      const fallback = parsed.length === 1 ? fn.name : text.slice(0, 12);
      const name = (it.name || fallback || '未命名').slice(0, 40);
      const cls = classify(name, it.cat || fn.cat, text);
      items.push({
        key: 'c' + items.length, src: root ? path.relative(root, fp) : fp,
        name, text, group: cls.group, sure: cls.sure, dup: existing.has(text),
      });
    }
  }
  return { items, unknown, files: files.length };
}
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
