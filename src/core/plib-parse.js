// 提示词解析 + 自动分组（纯函数，不碰 Electron）——1014 从 plib-import.js 原样抽出。
//
// 为什么单独成文件：软件内「批量导入」和「提示词发布台」（tools/pubtool，只在开发机上跑）
// 必须用**同一份**解析器和关键词表。之前发布侧在 tools/plib-lib.js 里另抄了一份 KW，
// 已经漂移（场照两条合成一条、面部多了人像词）——同一个文件名在软件里和云端会分到不同组。
//
// ⚠ 依赖方向只能是 tools → src，绝不能反过来：tools/ 不进安装包，
//   src 里 require('../../tools/…') 在用户机器上直接找不到文件，导入功能整个崩掉。
//   smoke 有一项专门盯这条。
//
// 支持：txt/md（---分隔多条）、json（本软件格式/老插件{title,content}/通用嗅探）、csv、png（A1111 parameters / ComfyUI prompt）
const path = require('path');
const fs = require('fs');

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

module.exports = {
  GROUP_IDS, CAT_MAP, KW, classify, kwGroup,
  readText, parseTxt, parseCsv, parseJson, parsePng, parseFile,
  walkDir, nameFromFile, scanFiles,
};
