// ComfyUI 卡（0916，feature/comfy）：工作流库切换 + 快捷参数 + 选区喂图 → 跑图 → 结果打组贴回 PS
//
// 路线=免装节点：只用 ComfyUI 自带的 HTTP/WS 接口（/system_stats /upload/image /prompt /ws /history /view /interrupt），
// ComfyUI 端什么都不用装；工作流文件必须是「Save (API Format)」导出的 JSON（节点 id → {class_type, inputs, _meta}）。
// 与 Forge 卡同一条骨架：captureInput 抓选区 → 调本地 API → 落盘 genDir → placeBatch 打组贴回 → 进度卡登记（genTaskAdd）。
//
// 工作流里怎么"接线"（不改用户的图，全靠识别）：
//   输入图：LoadImage 节点。多个时优先标题含「橙子/输入/input/ps」的那个，否则第一个。
//          千问 2.1 的参考图收在 TextEncodeQwenImage21 的 autogrow「images.image_N」（最多 16 张），
//          所以 Edit 系的反向查找要把 images.image_* 也算入口（见 srcLoad 的调用处）。
//   快捷参数：CLIPTextEncode 的 text（正/负按标题或 KSampler 的 positive/negative 连线判定）、KSampler(Advanced) 的
//            seed/steps/cfg/denoise/sampler_name/scheduler。用户改过的值存 config.comfy.params[工作流名]，切回时还原。
//   处理分辨率：ImageScaleToTotalPixels 的 megapixels（把图缩到多少个百万像素再处理）。
//   出图分辨率：ResolutionSelector 的 aspect_ratio + megapixels → 算 width/height 喂尺寸节点。

//   输出图：/history 里所有带 images 的节点（SaveImage/PreviewImage 都算），type=temp 的也取。
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const config = ctx.config;
const olog = (m, t) => ctx.olog(m, t);
const dlog = (m) => ctx.dlog(m);
const broadcast = (c, p) => ctx.broadcast(c, p);
const sendToPSAwait = (cmd, t) => ctx.sendToPSAwait(cmd, t);
const genDir = () => ctx.genDir();
const TEST_MODE = process.argv.some((a) => String(a).startsWith('--remote-debugging-port'));

const wfDir = () => path.join(app.getPath('documents'), '橙子', 'comfy-workflows');
const baseOf = (url) => String(url || config.comfy.url || '').trim().replace(/\/+$/, '');
const CLIENT_ID = 'orange-' + Math.random().toString(36).slice(2, 10);
let abortCtl = null;      // 当前批次的中断闸
let curPromptId = null;   // ComfyUI 正在跑的 prompt_id（中断时用）

async function cfetch(base, p, opt, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(base + p, Object.assign({ signal: ctrl.signal }, opt || {}));
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = (j.error && (j.error.message || j.error)) || j.message || ''; if (j.node_errors) detail += ' ' + Object.values(j.node_errors).map((n) => (n.errors || []).map((e) => e.message).join('；')).join('；'); } catch {}
      throw new Error('HTTP ' + r.status + (detail ? ' — ' + String(detail).slice(0, 200) : ''));
    }
    return r;
  } finally { clearTimeout(t); }
}
const cjson = async (base, p, opt, tmo) => (await cfetch(base, p, opt, tmo)).json();

// ---------- 连接 ----------
// 连不上必须留痕：以前只在卡的状态行显一句，翻日志啥也没有，用户没法自查（0916 用户反馈）
let lastTestErr = '';
ipcMain.handle('comfy-test', async (_e, { url }) => {
  const base = baseOf(url);
  if (!base) { olog('[ComfyUI] 未配置地址——点右上角齿轮填 ComfyUI 地址', 'err'); return { ok: false, error: '未配置 ComfyUI 地址' }; }
  try {
    // ComfyUI 空闲一阵后第一次 /system_stats 要查显卡状态，真机实测能超 3 秒——8 秒会误判成"连不上"
    const j = await cjson(base, '/system_stats', {}, 20000);
    const dev = (j.devices && j.devices[0]) || {};
    lastTestErr = '';
    return { ok: true, version: (j.system && j.system.comfyui_version) || '', device: dev.name || '', vramFree: dev.vram_free || 0 };
  } catch (e) {
    const msg = e.message || String(e);
    // 同一句（失败自动重试、开机自动连都会重复触发）只写一次，别把日志刷满
    if (msg !== lastTestErr) { lastTestErr = msg; olog('[ComfyUI] 连不上 ' + base + '：' + msg, 'err'); }
    return { ok: false, error: msg };
  }
});

// ---------- 工作流库 ----------
function isApiWorkflow(j) {
  // API 格式=顶层是 {节点id: {class_type, inputs}}；UI 格式有 nodes/links 数组
  if (!j || typeof j !== 'object' || Array.isArray(j)) return false;
  if (Array.isArray(j.nodes) && Array.isArray(j.links)) return false;
  const vals = Object.values(j);
  return vals.length > 0 && vals.every((n) => n && typeof n === 'object' && typeof n.class_type === 'string' && n.inputs && typeof n.inputs === 'object');
}
function isUiWorkflow(j) {
  // UI 格式=顶层有 nodes 和 links 数组
  return j && typeof j === 'object' && Array.isArray(j.nodes) && Array.isArray(j.links);
}
// UI 格式转 API 格式：把 links 数组解析成每个节点 inputs 里的连线引用
function convertUiToApi(ui) {
  const api = {};
  const nodes = ui.nodes || [];
  const links = ui.links || [];
  // 先建所有节点的基础结构
  for (const n of nodes) {
    if (!n || typeof n.id !== 'number' || typeof n.type !== 'string') continue;
    const id = String(n.id);
    const inputs = {};
    // 把节点自己的 widgets_values 填进 inputs（标量参数）
    if (n.widgets_values && Array.isArray(n.widgets_values) && n.inputs) {
      let widgetIdx = 0;
      for (const inp of n.inputs) {
        // 只有没连线的输入槽才用 widget 值（link 为 null）
        if (inp.link == null && widgetIdx < n.widgets_values.length) {
          inputs[inp.name] = n.widgets_values[widgetIdx];
          widgetIdx++;
        }
      }
    }
    api[id] = { class_type: n.type, inputs, _meta: { title: n.title || '' } };
  }
  // 再解析 links 填连线引用：link = [link_id, origin_id, origin_slot, target_id, target_slot, type]
  for (const lk of links) {
    if (!Array.isArray(lk) || lk.length < 5) continue;
    const [, originId, originSlot, targetId, targetSlot] = lk;
    const target = api[String(targetId)];
    if (!target) continue;
    // 找目标节点的输入槽名字
    const targetNode = nodes.find((n) => n.id === targetId);
    if (!targetNode || !targetNode.inputs || !targetNode.inputs[targetSlot]) continue;
    const slotName = targetNode.inputs[targetSlot].name;
    // 连线引用格式：[origin_id, origin_slot]
    target.inputs[slotName] = [String(originId), originSlot];
  }
  return api;
}
function readWorkflow(name) {
  const f = path.join(wfDir(), String(name || '').replace(/[\\/]/g, ''));
  if (!f.endsWith('.json') || !fs.existsSync(f)) return { ok: false, error: '工作流文件不存在：' + name };
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return { ok: false, error: '工作流 JSON 读不出来：' + (e.message || e) }; }
  // 自动转换 UI 格式 → API 格式
  if (isUiWorkflow(j)) {
    try { j = convertUiToApi(j); } catch (e) { return { ok: false, error: 'UI 格式转换失败：' + (e.message || e) }; }
  }
  if (!isApiWorkflow(j)) return { ok: false, error: '无法识别的工作流格式（既不是 API 也不是 UI 格式）' };
  return { ok: true, wf: j, file: f };
}
const titleOf = (n) => String((n._meta && n._meta.title) || '');
// 处理分辨率档位（0916 用户要）：值喂给 ImageScaleToTotalPixels.megapixels，=处理前把图缩到多少百万像素。
// 图生图的输出尺寸=选区构图比例 × 这个像素数，所以它控制的是"处理精度"不是"出图分辨率"（卡上标签照实说）
const MEGAPIXEL_TIERS = [
  { mp: 1, label: '1MP' },
  { mp: 1.5, label: '1.5MP' },
  { mp: 2, label: '2MP' },
  { mp: 3, label: '3MP' },
];
// 解析：找输入节点/文本节点/采样器 → 卡上要露的快捷参数清单
function analyze(wf) {
  const ids = Object.keys(wf);
  const byClass = (re) => ids.filter((id) => re.test(wf[id].class_type));
  const loads = byClass(/^LoadImage$/);
  // 选区喂哪个 LoadImage：①标题带 橙子/输入/input/ps ②Edit 工作流里接到 TextEncodeQwenImageEdit* 的 image/image1 那个（=主图）③第一个
  // 顺着 image 连线往上找到 LoadImage（中间常隔着 ImageScale*/ImageResize* 这类只改尺寸的节点，最多穿 4 层）
  const srcLoad = (ref) => {
    for (let hop = 0; hop < 4 && Array.isArray(ref); hop++) {
      const id = String(ref[0]); const n = wf[id]; if (!n) return null;
      if (loads.includes(id)) return id;
      if (!/^Image(Scale|Resize|Crop|Pad)/.test(n.class_type)) return null;
      ref = n.inputs.image;
    }
    return null;
  };
  // 从 Edit 系节点上找"主图"LoadImage：老族字段是 image / image1..3，2.1 族是 autogrow 的 images.image_1..16
  const refOfTextNode = (n) => {
    const inp = n.inputs || {};
    if (Array.isArray(inp.image)) return inp.image;
    if (Array.isArray(inp.image1)) return inp.image1;
    for (let i = 1; i <= 16; i++) if (Array.isArray(inp['images.image_' + i])) return inp['images.image_' + i];
    return null;
  };
  const editMain = (() => {
    for (const id of byClass(/^TextEncodeQwenImage(Edit|21)/)) { const hit = srcLoad(refOfTextNode(wf[id])); if (hit) return hit; }
    return null;
  })();
  const pick = loads.find((id) => /橙子|输入|input|ps\b|photoshop/i.test(titleOf(wf[id]))) || editMain || loads[0] || null;
  // 正/负判定：谁接到 KSampler 的 positive/negative 就是谁；连不上的按标题猜；都猜不到按出现顺序
  // ⚠ 同一个节点可能同时接正负两个槽（千问 2.1 的 TextEncodeQwenImage21 就是正负同源）——那种情况两个角色并存，
  //   不能只留最后一个，否则卡上会把正向显示成反向
  const samplers = byClass(/^KSampler(Advanced)?$/);
  const role = {};
  const addRole = (nid, r) => {
    if (nid == null) return;
    const cur = role[nid];
    role[nid] = !cur ? r : (cur === r ? r : 'both');
  };
  for (const sid of samplers) {
    const inp = wf[sid].inputs;
    if (Array.isArray(inp.positive)) addRole(inp.positive[0], 'pos');
    if (Array.isArray(inp.negative)) addRole(inp.negative[0], 'neg');
  }
  // 文本节点三族：CLIPTextEncode 的字段叫 text；Qwen-Image-Edit 系（TextEncodeQwenImageEdit / EditPlus）叫 prompt；
  // 千问 2.1 的 TextEncodeQwenImage21 有 prompt + negative_prompt 两个字段，正负同源一个节点出（正的连续读）
  const textKeyOf = (n) => (/^CLIPTextEncode/.test(n.class_type) && typeof n.inputs.text === 'string') ? 'text'
    : (/^TextEncodeQwenImageEdit/.test(n.class_type) && typeof n.inputs.prompt === 'string') ? 'prompt'
    : (/^TextEncodeQwenImage21$/.test(n.class_type) && typeof n.inputs.prompt === 'string') ? 'prompt' : null;
  const texts = ids.filter((id) => textKeyOf(wf[id])).map((id) => {
    const t = titleOf(wf[id]);
    let r = role[id] || (/neg|反向|负面|负向/i.test(t) ? 'neg' : /pos|正向|正面/i.test(t) ? 'pos' : '');
    const rl = r === 'pos' ? '正向提示词' : r === 'neg' ? '反向提示词' : (r === 'both' ? '提示词（正负同源）' : '文本 #' + id);
    return { id, class: wf[id].class_type, role: r, label: t || rl, value: wf[id].inputs[textKeyOf(wf[id])] };
  });
  // 2.1 同源节点：正负两个 prompt 字段都喂进去，卡上按「正向/反向」两行分开改（键 t:<id>:neg）
  for (const t of texts) {
    const n = wf[t.id];
    if (/^TextEncodeQwenImage21$/.test(n.class_type) && typeof n.inputs.negative_prompt === 'string') {
      t.hasNeg = true;
      t.negValue = n.inputs.negative_prompt;
    }
  }
  const samp = samplers.map((id) => {
    const inp = wf[id].inputs;
    const num = (k) => (typeof inp[k] === 'number' ? inp[k] : null);
    const str = (k) => (typeof inp[k] === 'string' ? inp[k] : null);
    return { id, label: titleOf(wf[id]) || ('采样器 #' + id), seed: num('seed') != null ? num('seed') : num('noise_seed'), seedKey: typeof inp.seed === 'number' ? 'seed' : (typeof inp.noise_seed === 'number' ? 'noise_seed' : null),
      steps: num('steps'), cfg: num('cfg'), denoise: num('denoise'), sampler: str('sampler_name'), scheduler: str('scheduler') };
  });
  const outs = byClass(/^(SaveImage|PreviewImage|Image Save|SaveImageWebsocket)/).length;
  // 处理分辨率：工作流里所有 ImageScaleToTotalPixels。值已经是用户的档位就照实显，不然按最接近的档（1MP/1.5/2/3）
  const upscales = ids.filter((id) => /^ImageScaleToTotalPixels$/.test(wf[id].class_type)).map((id) => {
    const mp = typeof wf[id].inputs.megapixels === 'number' ? wf[id].inputs.megapixels : 1;
    const near = MEGAPIXEL_TIERS.reduce((a, b) => (Math.abs(b.mp - mp) < Math.abs(a.mp - mp) ? b : a));
    return { id, label: titleOf(wf[id]) || ('缩放 #' + id), megapixels: mp, tier: near.label };
  });
  // 出图分辨率（千问 2.1）：ResolutionSelector 算 width/height 喂 EmptyLatentImage，再经 ComfySwitchNode 二选一。
  // switch 关着=用参考图自身的尺寸（Edit 工作流的默认，构图最稳）；开着=用选的比例+像素数。
  // 所以卡上露一行「出图尺寸」：「跟参考图」+ 各比例档；选比例时把 switch 打开、把参考图的 resolution 让开（设 0）。
  const sizeNodes = ids.filter((id) => /^ResolutionSelector$/.test(wf[id].class_type)).map((id) => {
    const inp = wf[id].inputs;
    const ar = typeof inp.aspect_ratio === 'string' ? inp.aspect_ratio : '';
    const mp = typeof inp.megapixels === 'number' ? inp.megapixels : 1;
    // 找吃它 width/height 的尺寸节点（EmptyLatentImage / EmptySD3LatentImage / LatentUpscale 等）
    const consumer = ids.find((k) => {
      const n = wf[k];
      if (!/^Empty.*Latent|^Latent/.test(n.class_type)) return false;
      return (Array.isArray(n.inputs.width) && n.inputs.width[0] === id) || (Array.isArray(n.inputs.height) && n.inputs.height[0] === id);
    }) || null;
    return { id, label: titleOf(wf[id]) || ('出图尺寸 #' + id), aspect_ratio: ar, megapixels: mp, consumer };
  });
  // 尺寸开关：ComfySwitchNode（class_type 是前缀，实际是 ComfySwitchNode）的 switch 输入
  const switches = ids.filter((id) => /^ComfySwitchNode$/.test(wf[id].class_type)).map((id) => ({
    id, label: titleOf(wf[id]) || ('尺寸开关 #' + id), value: wf[id].inputs.switch === true,
  }));
  // 模型节点：UNETLoader / CLIPLoader / VAELoader 的 *_name 字段（写死 int8/bf16 两套）
  const models = { unet: null, clip: null, vae: null };
  for (const id of byClass(/^UNETLoader$/)) {
    const name = typeof wf[id].inputs.unet_name === 'string' ? wf[id].inputs.unet_name : '';
    models.unet = { id, label: titleOf(wf[id]) || ('扩散模型 #' + id), value: name };
  }
  for (const id of byClass(/^CLIPLoader$/)) {
    const name = typeof wf[id].inputs.clip_name === 'string' ? wf[id].inputs.clip_name : '';
    models.clip = { id, label: titleOf(wf[id]) || ('文本编码 #' + id), value: name };
  }
  for (const id of byClass(/^VAELoader$/)) {
    const name = typeof wf[id].inputs.vae_name === 'string' ? wf[id].inputs.vae_name : '';
    models.vae = { id, label: titleOf(wf[id]) || ('VAE #' + id), value: name };
  }
  // 参考图：千问 2.1 的 TextEncodeQwenImage21 把参考图收在平铺键 images.image_1..N
  // 返回节点 id + 已暴露的槽位数，渲染端据此决定要不要画参考图区（不靠模型名匹配）
  let refs = null;
  for (const t of texts) {
    if (t.class !== 'TextEncodeQwenImage21') continue;
    const inp = (wf[t.id] && wf[t.id].inputs) || {};
    let slots = 0;
    for (let i = 1; i <= 16; i++) if (Array.isArray(inp['images.image_' + i])) slots = i;
    refs = { id: t.id, slots, max: 5 };
    break;
  }
  return { input: pick, inputs: loads.length, texts, samplers: samp, outputs: outs, nodes: ids.length, upscales, sizes: sizeNodes, switches, models, refs };
}
function listWorkflows() {
  const dir = wfDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const r = readWorkflow(f);
    if (!r.ok) { out.push({ name: f, bad: r.error }); continue; }
    const a = analyze(r.wf);
    out.push({ name: f, nodes: a.nodes, hasInput: !!a.input, texts: a.texts.length, samplers: a.samplers.length, outputs: a.outputs });
  }
  return out;
}
ipcMain.handle('comfy-workflows', () => ({ ok: true, dir: wfDir(), list: listWorkflows(), current: config.comfy.current || '' }));
ipcMain.handle('comfy-open-folder', () => { const d = wfDir(); fs.mkdirSync(d, { recursive: true }); return require('electron').shell.openPath(d); });
// 切到某个工作流：解析出快捷参数，叠上用户上次改过的值（config.comfy.params[name]）
ipcMain.handle('comfy-load', (_e, { name }) => {
  const r = readWorkflow(name);
  if (!r.ok) return r;
  const a = analyze(r.wf);
  const saved = (config.comfy.params && config.comfy.params[name]) || {};
  for (const t of a.texts) {
    if (saved['t:' + t.id] != null) t.value = saved['t:' + t.id];
    if (t.hasNeg && saved['t:' + t.id + ':neg'] != null) t.negValue = saved['t:' + t.id + ':neg'];
  }
  for (const s of a.samplers) for (const k of ['seed', 'steps', 'cfg', 'denoise', 'sampler', 'scheduler']) if (saved['s:' + s.id + ':' + k] != null) s[k] = saved['s:' + s.id + ':' + k];
  for (const u of a.upscales) { const v = saved['m:' + u.id]; if (v != null) { const t = MEGAPIXEL_TIERS.find((x) => x.label === v); if (t) { u.tier = t.label; u.megapixels = t.mp; } } }
  for (const sz of (a.sizes || [])) {
    if (saved['z:' + sz.id] != null) sz.aspect_ratio = saved['z:' + sz.id];
    if (saved['z:' + sz.id + ':mp'] != null) sz.megapixels = Number(saved['z:' + sz.id + ':mp']) || sz.megapixels;
  }
  // 模型选择：unet_name / clip_name（VAE 只有一个，不用选）
  if (a.models.unet && saved['unet:' + a.models.unet.id] != null) a.models.unet.value = saved['unet:' + a.models.unet.id];
  if (a.models.clip && saved['clip:' + a.models.clip.id] != null) a.models.clip.value = saved['clip:' + a.models.clip.id];
  config.comfy.current = name;
  ctx.saveConfig();
  return { ok: true, name, schema: a, saved, seedRandom: saved.seedRandom !== false };
});
// 记住用户在卡上改的值（按工作流名分开存；工作流文件本身永不改写）
ipcMain.handle('comfy-save-params', (_e, { name, params }) => {
  if (!name) return { ok: false };
  config.comfy.params = config.comfy.params || {};
  config.comfy.params[name] = Object.assign({}, config.comfy.params[name] || {}, params || {});
  ctx.saveConfig();
  return { ok: true };
});

// ---------- 跑图 ----------
// 把卡上的参数织进工作流副本（原文件不动）
function applyParams(wf, name, edits, seedMode) {
  const out = JSON.parse(JSON.stringify(wf));
  const e = edits || {};
  for (const id of Object.keys(out)) {
    const n = out[id];
    if (e['t:' + id] != null) {
      if (/^CLIPTextEncode/.test(n.class_type) && typeof n.inputs.text === 'string') n.inputs.text = String(e['t:' + id]);
      else if (/^TextEncodeQwenImageEdit/.test(n.class_type) && typeof n.inputs.prompt === 'string') n.inputs.prompt = String(e['t:' + id]);
      else if (/^TextEncodeQwenImage21$/.test(n.class_type) && typeof n.inputs.prompt === 'string') n.inputs.prompt = String(e['t:' + id]);
    }
    if (e['t:' + id + ':neg'] != null && /^TextEncodeQwenImage21$/.test(n.class_type) && typeof n.inputs.negative_prompt === 'string') {
      n.inputs.negative_prompt = String(e['t:' + id + ':neg']);
    }
    if (/^KSampler(Advanced)?$/.test(n.class_type)) {
      const g = (k) => e['s:' + id + ':' + k];
      if (g('steps') != null) n.inputs.steps = Number(g('steps'));
      if (g('cfg') != null) n.inputs.cfg = Number(g('cfg'));
      if (g('denoise') != null && typeof n.inputs.denoise === 'number') n.inputs.denoise = Number(g('denoise'));
      if (g('sampler') != null && typeof n.inputs.sampler_name === 'string') n.inputs.sampler_name = String(g('sampler'));
      if (g('scheduler') != null && typeof n.inputs.scheduler === 'string') n.inputs.scheduler = String(g('scheduler'));
      const sk = typeof n.inputs.seed === 'number' ? 'seed' : (typeof n.inputs.noise_seed === 'number' ? 'noise_seed' : null);
      if (sk) {
        if (seedMode === 'random') n.inputs[sk] = Math.floor(Math.random() * 2 ** 48);
        else if (g('seed') != null) n.inputs[sk] = Number(g('seed'));
      }
    }
    // 处理分辨率档位：m:<节点id> 存的是档位标签（'1MP'/'1.5MP'…），查回数值再写进 megapixels
    if (/^ImageScaleToTotalPixels$/.test(n.class_type) && e['m:' + id] != null) {
      const t = MEGAPIXEL_TIERS.find((x) => x.label === String(e['m:' + id]));
      if (t && typeof n.inputs.megapixels === 'number') n.inputs.megapixels = t.mp;
    }
    // 出图尺寸：z:<id> 存比例字符串（'' = 跟参考图）。选了比例 → 写 aspect_ratio，并把同工作流的
    // ComfySwitchNode.switch 打开、参考图的 resolution 设 0（让参考图别被二次缩放，尺寸完全由比例决定）。
    if (/^ResolutionSelector$/.test(n.class_type) && e['z:' + id] != null) {
      const want = String(e['z:' + id]);
      if (want && n.inputs.aspect_ratio !== undefined) n.inputs.aspect_ratio = want;
      if (e['z:' + id + ':mp'] != null && typeof n.inputs.megapixels === 'number') n.inputs.megapixels = Number(e['z:' + id + ':mp']) || n.inputs.megapixels;
    }
    // 模型切换：unet:<id> / clip:<id> 存模型文件名（写死 int8/bf16 两套）
    if (/^UNETLoader$/.test(n.class_type) && e['unet:' + id] != null && typeof n.inputs.unet_name === 'string') {
      n.inputs.unet_name = String(e['unet:' + id]);
    }
    if (/^CLIPLoader$/.test(n.class_type) && e['clip:' + id] != null && typeof n.inputs.clip_name === 'string') {
      n.inputs.clip_name = String(e['clip:' + id]);
    }
  }
  // 选了具体比例 → 尺寸不再跟参考图：打开开关（switch=true 走 EmptyLatentImage 那路），
  // 同时把参考图的 resolution 归零（0 = 每张参考图保持自身尺寸，只对齐 32），免得它再插一手缩放
  const sizeIds = Object.keys(out).filter((k) => /^ResolutionSelector$/.test(out[k].class_type));
  const picked = sizeIds.find((k) => e['z:' + k] != null);
  if (picked != null) {
    const want = String(e['z:' + picked]);
    for (const k of Object.keys(out)) {
      if (/^ComfySwitchNode$/.test(out[k].class_type) && typeof out[k].inputs.switch === 'boolean') out[k].inputs.switch = !!want;
    }
    for (const k of Object.keys(out)) {
      if (/^TextEncodeQwenImage21$/.test(out[k].class_type) && typeof out[k].inputs.resolution === 'number') out[k].inputs.resolution = want ? 0 : 1024;
    }
  }
  return out;
}
// 上传选区图到 ComfyUI 的 input 目录（multipart；Node 18+ 原生 FormData/Blob）
async function uploadInput(base, b64, mime) {
  const fd = new FormData();
  const ext = /png/i.test(mime || '') ? 'png' : 'jpg';
  const fname = 'orange_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.' + ext;
  fd.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime || 'image/jpeg' }), fname);
  fd.append('overwrite', 'true');
  const j = await cjson(base, '/upload/image', { method: 'POST', body: fd }, 60000);
  return (j.subfolder ? j.subfolder + '/' : '') + (j.name || fname);
}
// 批量上传参考图到 ComfyUI（千问 2.1 用）：本地路径 → 逐个上传 → 返回 ComfyUI 文件名数组
// 上传失败的那一格返回 null（不是抛错）——一张图挂掉不该废掉整次生成，其余槽位照常。
async function uploadRefImages(base, paths) {
  const fs = require('fs');
  const uploaded = [];
  for (const p of paths) {
    if (!p || !fs.existsSync(p)) { uploaded.push(null); continue; }
    try {
      const buf = fs.readFileSync(p);
      const b64 = buf.toString('base64');
      const mime = /\.png$/i.test(p) ? 'image/png' : 'image/jpeg';
      uploaded.push(await uploadInput(base, b64, mime));
    } catch (e) {
      dlog('[comfy] 参考图上传失败 path=' + p + ' err=' + (e && e.message));
      uploaded.push(null);
    }
  }
  return uploaded;
}
// 把参考图织进 TextEncodeQwenImage21 的 images.image_N 槽位。
// ⚠ 槽位只认「图片连线」，塞字符串文件名 ComfyUI 必崩：
//     AttributeError: 'str' object has no attribute 'movedim'（nodes_qwen.py:154 `image[:1].movedim(-1,1)`）
//   所以每张参考图临时新建一个 LoadImage 节点、槽位改成指向它的连线。
// 空槽位一律删键——工作流出厂时 5 个槽全硬接同一张图，留着会重复吃同一张（0916 用户实证）。
function weaveRefs(wf, textNodeId, refNames) {
  let nextId = 9001;
  while (wf[String(nextId)]) nextId++;   // 避开用户自己的节点号，从 9001 起找第一个空位
  const slots = [];
  for (let j = 0; j < refNames.length; j++) {
    const key = 'images.image_' + (j + 1);
    if (refNames[j]) {
      const id = String(nextId++);
      wf[id] = { class_type: 'LoadImage', inputs: { image: refNames[j], upload: 'image' } };
      wf[textNodeId].inputs[key] = [id, 0];
      slots.push(j + 1);
    } else {
      delete wf[textNodeId].inputs[key];
    }
  }
  return slots;
}
// 提交并等它跑完：WebSocket 看进度（executing null=结束；execution_error=失败），断了就退回轮询 /history
function waitPrompt(base, promptId, signal, onProgress) {
  return new Promise((resolve, reject) => {
    let done = false, ws = null, poll = null;
    const finish = (err) => {
      if (done) return; done = true;
      try { if (ws) ws.close(); } catch {}
      clearInterval(poll);
      err ? reject(err) : resolve();
    };
    const checkHistory = async () => {
      try {
        const h = await cjson(base, '/history/' + promptId, {}, 8000);
        const it = h[promptId];
        if (!it) return;
        const st = it.status || {};
        if (st.status_str === 'error') return finish(new Error(errText(st) || 'ComfyUI 执行出错'));
        if (it.outputs || st.completed) finish();
      } catch {}
    };
    try {
      const WebSocket = require('ws');
      ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws?clientId=' + CLIENT_ID);
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }   // 二进制帧=预览图，跳过
        const d = m.data || {};
        if (d.prompt_id && d.prompt_id !== promptId) return;
        if (m.type === 'progress' && d.max) onProgress(d.value / d.max);
        else if (m.type === 'executing' && d.node === null) finish();
        else if (m.type === 'execution_error') finish(new Error((d.exception_message || '执行出错') + (d.node_type ? '（节点 ' + d.node_type + '）' : '')));
        else if (m.type === 'execution_interrupted') finish(new Error('已中断'));
      });
      ws.on('error', () => {});   // 连不上就靠轮询
    } catch {}
    poll = setInterval(checkHistory, 1500);
    if (signal) signal.addEventListener('abort', () => finish(new Error('已中断')), { once: true });
  });
}
const errText = (st) => { try { const m = (st.messages || []).find((x) => x[0] === 'execution_error'); return m && m[1] && (m[1].exception_message || ''); } catch { return ''; } };
// 取结果：/history 的 outputs 里所有 images → /view 下载落盘
async function fetchOutputs(base, promptId, tag) {
  const h = await cjson(base, '/history/' + promptId, {}, 15000);
  const it = h[promptId] || {};
  const imgs = [];
  for (const nid of Object.keys(it.outputs || {})) for (const im of (it.outputs[nid].images || [])) if (im.filename) imgs.push(im);
  if (!imgs.length) throw new Error('工作流跑完了但没有输出图片——检查是否有 SaveImage/PreviewImage 节点');
  const dir = genDir(); fs.mkdirSync(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    const q = '/view?filename=' + encodeURIComponent(im.filename) + '&subfolder=' + encodeURIComponent(im.subfolder || '') + '&type=' + encodeURIComponent(im.type || 'output');
    const r = await cfetch(base, q, {}, 60000);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = (path.extname(im.filename) || '.png').toLowerCase();
    const f = path.join(dir, 'comfy_' + tag + '_' + i + ext);
    fs.writeFileSync(f, buf);
    files.push(f);
  }
  return files;
}

// 主链：抓选区 → 上传 → N 次提交（每次换 seed）→ 收图 → 进度卡 → 打组贴回
// p: { url, name, edits, seedMode:'random'|'fixed', count, docId, test:{inputFile, noPlace} }
async function runComfy(p) {
  const base = baseOf(p.url);
  if (!base) return { ok: false, error: '未配置 ComfyUI 地址' };
  const rw = readWorkflow(p.name);
  if (!rw.ok) { olog('[ComfyUI] ' + rw.error, 'err'); return rw; }
  const a = analyze(rw.wf);
  if (!a.input) { olog('[ComfyUI] 工作流里没有 LoadImage 节点，选区图没处喂——加一个 LoadImage 并接到你的图里', 'err'); return { ok: false, error: '工作流没有 LoadImage 节点' }; }
  const count = Math.max(1, Math.min(20, Number(p.count) || 1));
  const test = TEST_MODE && p.test;

  // 抓选区（机测：直接给文件）
  let pctx, b64, mime;
  if (test && test.inputFile) {
    b64 = fs.readFileSync(test.inputFile).toString('base64'); mime = 'image/png';
    pctx = { docId: null, selection: { left: 0, top: 0, right: 64, bottom: 64 }, image: b64 };
  } else {
    // 批处理已采好（0918）：主进程逐图循环里采集一次后经 __batchCtx 传来，这里不再重复采集
    const pre = p.psCtx && p.psCtx.selection && p.psCtx.image ? p.psCtx : null;
    if (!pre) olog('[ComfyUI] 抓取选区…');
    if (ctx.warnIfBridgeDown) ctx.warnIfBridgeDown('ComfyUI');
    // fullIfNoSel：0918 用户裁定——没有选区就是不跑（批处理里由 gen.js 拦掉；单张跑时如实报错，不整张重绘）
    const cap = pre ? { ok: true, result: pre }
      : await sendToPSAwait({ action: 'captureInput', params: { antiMode: 0, docId: p.docId != null ? p.docId : undefined, fullIfNoSel: false } }, 30000);
    pctx = (cap.ok && cap.result) || {};
    dlog('[comfy] capture ok=' + cap.ok + ' err=' + (cap.error || '') + ' sel=' + !!pctx.selection + ' img=' + !!pctx.image + ' note=' + (pctx.note || '') + ' 预采=' + !!pre);
    if (!cap.ok) { olog('[ComfyUI] 抓取失败: ' + (cap.error || '未知错误'), 'err'); return { ok: false, error: cap.error || '抓取失败' }; }
    if (!pctx.selection) { olog('[ComfyUI] 没有选区——请先在PS里框选要处理的区域（批处理模式只跑框选了区域的图）', 'err'); return { ok: false, error: '没有选区（未框选区域，不执行）' }; }
    if (!pctx.image) { olog('[ComfyUI] 选区截图失败: ' + (pctx.note || '未知原因'), 'err'); return { ok: false, error: pctx.note || '选区截图失败' }; }
    b64 = pctx.image; mime = pctx.mime || 'image/jpeg';
  }
  // 输入图落盘（进度卡"本次输入"缩略图）
  let inputFile = null;
  try { const dir = genDir(); fs.mkdirSync(dir, { recursive: true }); inputFile = path.join(dir, 'input_' + Date.now() + '_comfy.jpg'); fs.writeFileSync(inputFile, Buffer.from(b64, 'base64')); } catch { inputFile = null; }

  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  const batchId = ctx.genBatchId();
  const posText = (a.texts.find((t) => t.role === 'pos') || a.texts[0] || {});
  const promptShown = (p.edits && p.edits['t:' + posText.id]) != null ? p.edits['t:' + posText.id] : (posText.value || '');
  const tasks = Array.from({ length: count }, () => ctx.genTaskAdd({ batchId, prompt: promptShown, tag: '[ComfyUI] ' + p.name.replace(/\.json$/i, ''), docId: pctx.docId || null, selection: pctx.selection || null, inputFile }));
  olog('▶ [ComfyUI] ' + p.name + ' ×' + count + (p.seedMode === 'random' ? ' · 随机种子' : '') + ' · 节点 ' + a.nodes);
  // 处理分辨率落到日志（0916）：图生图的输出尺寸=构图比例×像素数，报出来用户才能自己对照，
  // 不用猜"我选了 2MP 到底跑了多大"。构图比例取选区宽高，没选区就按 1:1 报
  if (a.upscales.length) {
    const sel = pctx.selection;
    const aw = sel ? Math.max(1, Math.round(sel.right - sel.left)) : 1;
    const ah = sel ? Math.max(1, Math.round(sel.bottom - sel.top)) : 1;
    for (const u of a.upscales) {
      const total = u.megapixels * 1e6;
      const scale = Math.sqrt(total / (aw * ah));
      olog('[ComfyUI] 处理分辨率 ' + u.tier + ' → 约 ' + Math.round(aw * scale) + '×' + Math.round(ah * scale) + '（节点 #' + u.id + '，构图比例取自选区）');
    }
  }
  const files = [];
  let fail = 0;
  try {
    const uploaded = await uploadInput(base, b64, mime);
    dlog('[comfy] uploaded=' + uploaded);
    // 批量上传参考图（千问 2.1）：检测到 edits 里有 'refs:N'（N=1~5）就上传
    // 'ps:' 前缀 = 用户是在槽位上抓的 PS 选区（渲染端已落盘），剥掉前缀取真实文件
    const refPaths = [];
    for (let j = 1; j <= 5; j++) {
      const v = (p.edits && p.edits['refs:' + j]) || null;
      refPaths.push(v ? String(v).replace(/^ps:/, '') : null);
    }
    const refUploaded = refPaths.some(Boolean) ? await uploadRefImages(base, refPaths) : [];
    if (refUploaded.length) dlog('[comfy] refs uploaded=' + JSON.stringify(refUploaded));
    for (let i = 0; i < count; i++) {
      if (signal.aborted) break;
      const task = tasks[i];
      try {
        const wf = applyParams(rw.wf, p.name, p.edits, p.seedMode);
        wf[a.input].inputs.image = uploaded;
        // 织入参考图到 TextEncodeQwenImage21（千问 2.1 专用）：槽位只能连连线，见 weaveRefs 注释
        const qw = a.texts.find((t) => t.class === 'TextEncodeQwenImage21');
        if (qw && wf[qw.id] && wf[qw.id].inputs) {
          const slots = weaveRefs(wf, qw.id, refUploaded.length ? refUploaded : []);
          if (slots.length) dlog('[comfy] refs 织入槽位 ' + slots.join(',') + '（节点 #' + qw.id + '）');
        }
        const sub = await cjson(base, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ prompt: wf, client_id: CLIENT_ID }), 'utf8') }, 30000);
        if (!sub.prompt_id) throw new Error('ComfyUI 没有返回 prompt_id' + (sub.error ? '：' + JSON.stringify(sub.error).slice(0, 160) : ''));
        curPromptId = sub.prompt_id;
        broadcast('comfy-progress', { i, count, progress: 0 });
        await waitPrompt(base, sub.prompt_id, signal, (pr) => broadcast('comfy-progress', { i, count, progress: pr }));
        const outs = await fetchOutputs(base, sub.prompt_id, Date.now() + '_' + i);
        ctx.genTaskUpdate(task, { status: 'done', file: outs[0] });
        for (let k = 1; k < outs.length; k++) ctx.genTaskAdd({ batchId, status: 'done', file: outs[k], prompt: promptShown, tag: task.tag, docId: task.docId, selection: task.selection, inputFile });
        files.push(...outs);
        olog('✓ [ComfyUI] 第 ' + (i + 1) + '/' + count + ' 张完成' + (outs.length > 1 ? '（出 ' + outs.length + ' 图）' : ''));
      } catch (e) {
        fail++;
        const msg = e.message || String(e);
        ctx.genTaskUpdate(task, { status: 'error', error: ctx.humanizeErr(msg) });
        olog('✗ [ComfyUI] 第 ' + (i + 1) + ' 张失败: ' + msg, 'err');
        if (/已中断/.test(msg)) break;
      }
    }
    // 没跑到的占位撤掉（中断/提前失败）
    for (const t of tasks) if (t.status === 'running') ctx.genTaskUpdate(t, { status: 'error', error: '已中断' });
    if (!files.length) return { ok: false, error: '没有产出图片' };
    if (test && test.noPlace) return { ok: true, count: files.length, fail, files, batchId };
    const pr = await ctx.placeWithRetry('placeBatch', { paths: files, docId: pctx.docId || null, selection: pctx.selection || null, antiMode: 0, group: true }, 180000);
    if (pr.ok) { for (const t of tasks) if (t.status === 'done') t.status = 'placed'; ctx.genTaskUpdate(tasks[0], {}); }
    olog(pr.ok ? '✓ [ComfyUI] 完成，贴回 ' + files.length + ' 张' + (fail ? '（' + fail + ' 张失败）' : '') : '[ComfyUI] 贴回失败: ' + (pr.error || '') + '（图已保留在进度卡，点图可手动贴回）', pr.ok ? 'ok' : 'err');
    return { ok: true, count: files.length, fail, batchId };
  } catch (e) {
    const msg = e.message || String(e);
    for (const t of tasks) if (t.status === 'running') ctx.genTaskUpdate(t, { status: 'error', error: ctx.humanizeErr(msg) });
    olog('[ComfyUI] ' + msg, 'err');
    return { ok: false, error: msg };
  } finally {
    abortCtl = null; curPromptId = null;
    broadcast('comfy-progress', { done: true });
  }
}
ipcMain.handle('comfy-run', (_e, p) => runComfy(p || {}));
ipcMain.on('comfy-interrupt', async (_e, { url }) => {
  try { if (abortCtl) abortCtl.abort(); } catch {}
  const base = baseOf(url);
  try { if (base) await cfetch(base, '/interrupt', { method: 'POST' }, 5000); } catch {}
  try { if (base && curPromptId) await cfetch(base, '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delete: [curPromptId] }) }, 5000); } catch {}
});

ctx.comfyAnalyze = analyze;   // smoke 直测解析器
