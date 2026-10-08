// AI生图链路：武装机制/单张生成(Gemini兼容)/批量并发/任务中心/缓存管理
const { ipcMain, dialog, nativeImage, app } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const { batchDocGate } = require('./batch-doc-gate');   // 批处理逐图判定（纯函数，smoke 直测）

const config = ctx.config;
const olog = (m, t) => ctx.olog(m, t);
const broadcast = (c, p) => ctx.broadcast(c, p);
const saveConfig = () => ctx.saveConfig();
const genDir = () => ctx.genDir();
const sendToPSAwait = (cmd, t) => ctx.sendToPSAwait(cmd, t);
// 并发唯一文件名（0905审计采纳）：Date.now同毫秒撞名会覆盖已计费结果，加随机尾巴根绝
const uniq = () => Date.now() + '_' + Math.random().toString(36).slice(2, 8);

// 带 CDP 调试口启动（smoke / 机测脚本）才开放的钩子全挂这个开关下；安装包永远 false
// ⚠ ipcMain.handle 同名注册第二次直接抛错=整个软件启动失败（0916 实证），一个通道只许注册一处
const TEST_MODE = process.argv.some((a) => String(a).startsWith('--remote-debugging-port'));

// ---------- 武装机制：最后被调节的跑图模块=当前武装，整卡边缘发光，总控生成跑它 ----------
// armedId: 'prompt-box'/'ai-gen'/'composite'/'relight'/'fx'（有跑图能力的模块）
let armedId = 'prompt-box';   // 默认=提示词卡（普通生图流）
const ARMED_LABELS = { 'prompt-box': '提示词', 'ai-gen': '生图模式', 'composite': '半合成', 'relight': '打光', 'fx': '特效', 'forge': 'Forge', 'comfy': 'ComfyUI' };
function broadcastArmed() {
  broadcast('armed', { id: armedId, label: ARMED_LABELS[armedId] || armedId });
}
// 武装统一入口：被 state.js set-config 拦截层调用，也供各卡显式调用（存量 arm-module 通道依然生效）
function armModule(id) {
  if (!ARMED_LABELS[id]) return;
  const changed = armedId !== id;
  armedId = id;
  broadcastArmed();   // 同id也重播，保证光环可靠出现
  if (changed) olog('◈ 武装切换 → ' + ARMED_LABELS[id]);
}
ctx.armModule = armModule;   // 挂到 ctx 上，供 state.js 调用

ipcMain.on('arm-module', (e, id) => armModule(id));
ipcMain.handle('get-armed', () => ({ id: armedId, label: ARMED_LABELS[armedId] || armedId }));

// 批处理前置：桥接件版本检查（listDocs/captureInput docId需v29+）+ 列出PS全部打开的文档
async function listDocsForBatch() {
  if (ctx.bridgeVer() > 0 && ctx.bridgeVer() < 29) {
    olog('[批处理] 需要桥接件v29+（当前v' + ctx.bridgeVer() + '）——请重启一次PS完成更新', 'err');
    return { ok: false, error: '桥接件旧版' };
  }
  // 报错说真话（0904冤案）：此前listDocs调用失败（PS未连接/弹窗模态/超时）一律
  // 报成"没有打开的文档"——用户开着50张图被告知没文档。模态是暂时的自动重试，其余如实报
  let ld = null;
  for (let i = 0; i < 3; i++) {
    ld = await sendToPSAwait({ action: 'listDocs', params: {} }, 15000);
    if (ld.ok || !/modal/i.test(ld.error || '')) break;
    olog('[批处理] PS正被弹窗/对话框占用，1秒后重试…');
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (!ld.ok) {
    try { ctx.dlog('[batch] listDocs失败 err=' + (ld.error || '')); } catch {}
    olog('[批处理] 读取文档列表失败：' + (ld.error || '桥接无响应') + '（PS未连接、或有弹窗没关）', 'err');
    return { ok: false, error: ld.error || 'listDocs失败' };
  }
  const docs = (ld.result && ld.result.docs) || [];
  try { ctx.dlog('[batch] listDocs ok docs=' + docs.length); } catch {}
  if (!docs.length) {
    olog('[批处理] PS里没有打开的文档', 'err');
    return { ok: false, error: '无文档' };
  }
  return { ok: true, docs };
}

// ---------- 通用批处理：跑遍PS里每张打开的图（Forge / ComfyUI / 未来任何"卡内自己出图"的模块） ----------
// 卡内跑图函数 __fireXxx(docId, psCtx) 原样调用，逐图传 docId 让桥接先激活目标文档再读选区。
// 批处理自己先采集一次（激活文档→读选区→截图），把结果**直接喂给卡内链路**（psCtx 参数），
// 卡内不再重复采集：一次批跑每张图只付一次截图开销。
// 无选区的图**不跑**（0918 用户裁定）：跳过并中文报错，不再套用"无选区跑全图"的兜底——
// 批处理场景下那张图可能压根没框，跑全图会整张重绘，代价是真金白银。
async function runBatchForCards(modId, label, fireExpr, opts) {
  const w = ctx.cardWins[modId];
  if (!(w && !w.isDestroyed())) return { ok: false, error: label + '卡未打开' };
  const bd = await listDocsForBatch();
  if (!bd.ok) return bd;
  olog('📚 批处理开始（' + label + '）：共' + bd.docs.length + '张图 —— 跑批期间请勿操作PS', 'ok');
  let okDocs = 0, skip = 0;
  // 选区明确 = 用户框了区域；fullIfNoSel 关掉，没选区就如实返回 null（下面跳过并报是哪张）
  const capParams = Object.assign({ antiMode: 0, fullIfNoSel: false }, (opts && opts.capParams) || {});
  for (let i = 0; i < bd.docs.length; i++) {
    if (config.gen.batchAll !== '1') { olog('📚 批处理开关已关闭，第' + i + '张后停止'); break; }
    const d = bd.docs[i];
    const probe = await sendToPSAwait({ action: 'captureInput', params: Object.assign({}, capParams, { docId: Number(d.id) }) }, 30000).catch(() => null);
    const pc = (probe && probe.ok && probe.result) || null;
    const gate = batchDocGate(probe);
    if (!gate.run) {
      skip++;
      olog('📚 跳过「' + d.name + '」：' + gate.why + '——批处理只跑框选了区域的图，没有选区不执行', 'err');
      continue;
    }
    olog('📚 批处理 ' + (i + 1) + '/' + bd.docs.length + '：' + d.name);
    try {
      // 采集结果先塞进卡窗口的全局变量，卡内链路取它跳过重复采集（不参与下面的字符串拼接）
      await w.webContents.executeJavaScript('window.__batchCtx = ' + JSON.stringify(pc) + '; 1');
      const r = await w.webContents.executeJavaScript(fireExpr(Number(d.id)));
      if (r && r.ok) okDocs++;
      else if (r && r.error) olog('📚 「' + d.name + '」失败：' + r.error, 'err');
    } catch (e) {
      olog('📚 「' + d.name + '」异常：' + ((e && e.message) || e), 'err');
    } finally {
      try { await w.webContents.executeJavaScript('window.__batchCtx = null; 1'); } catch {}
    }
    // 等卡内running复位（成功路径380ms后才落）——立刻连发会被误判成"点停止"
    await new Promise((res) => setTimeout(res, (opts && opts.gap) || 700));
  }
  const tail = skip ? '，跳过' + skip + '张（无选区）' : '';
  olog('📚 批处理完成（' + label + '）：' + okDocs + '/' + bd.docs.length + ' 张图处理成功' + tail, okDocs ? 'ok' : 'err');
  return { ok: true, docs: bd.docs.length, okDocs, skipped: skip };
}

// 卡内跑图键触发批处理（0918 用户裁定：批处理不再只有生成卡能点火）——
// Forge/ComfyUI 卡上的播放键在开关打开时走这里，先自动武装该卡再跑全批次；
// 开关关着时返回 {batch:false}，调用方照旧跑单张。
ipcMain.handle('batch-fire', async (_e, { modId, count }) => {
  if (config.gen.batchAll !== '1') return { ok: true, batch: false };
  if (!ARMED_LABELS[modId]) return { ok: false, error: '未知模块' };
  if (armedId !== modId) { armedId = modId; broadcastArmed(); olog('◈ 武装切换 → ' + ARMED_LABELS[modId] + '（卡内跑图）'); }
  if (modId === 'forge') return runBatchForCards('forge', 'Forge', (id) => 'window.__fireForge && window.__fireForge(' + id + ')');
  if (modId === 'comfy') return runBatchForCards('comfy', 'ComfyUI', (id) => 'window.__fireComfy && window.__fireComfy(' + id + ', ' + (Number(count) || 1) + ')');
  return { ok: false, error: '该模块暂不支持批处理' };
});

// 总控生成：向武装模块的窗口收取生成负载（提示词+参数），拿到后走统一批量链路
ipcMain.handle('fire-armed', async (_e, { count }) => {
  olog('▶ 生成 · 来源[' + (ARMED_LABELS[armedId] || armedId) + ']');
  const w = ctx.cardWins[armedId];
  // Forge走自己的生成链路（SD本地API），不走Gemini批量
  if (armedId === 'forge') {
    if (!(w && !w.isDestroyed())) return { ok: false, error: 'Forge卡未打开' };
    if (config.gen.batchAll === '1') return runBatchForCards('forge', 'Forge', (id) => 'window.__fireForge && window.__fireForge(' + id + ')');
    try { await w.webContents.executeJavaScript('window.__fireForge && window.__fireForge()'); return { ok: true }; } catch {}
    return { ok: false, error: 'Forge卡未打开' };
  }
  // ComfyUI 与 Forge 同一套：卡内 __fireComfy(docId) 跑自己的链路；批处理逐文档传 docId
  if (armedId === 'comfy') {
    if (!(w && !w.isDestroyed())) return { ok: false, error: 'ComfyUI 卡未打开' };
    if (config.gen.batchAll === '1') return runBatchForCards('comfy', 'ComfyUI', (id) => 'window.__fireComfy && window.__fireComfy(' + id + ', ' + Number(count) + ')');
    try { const r = await w.webContents.executeJavaScript('window.__fireComfy && window.__fireComfy(null, ' + Number(count) + ')'); return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'ComfyUI 执行失败' }; } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  // 打光走自己的链路（AI灯光层→柔光置入），不走通用批量贴回
  if (armedId === 'relight') {
    if (!(w && !w.isDestroyed())) return { ok: false, error: '打光卡未打开' };
    try {
      const r = await w.webContents.executeJavaScript('window.__fireRelight && window.__fireRelight()');
      return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '打光执行失败' };
    } catch (e) { return { ok: false, error: e.message || String(e) }; }
  }
  // 找武装模块的窗口；提示词卡/未开窗的模块=直接用config.gen里的提示词跑普通流
  let payload = null;
  if (armedId !== 'prompt-box' && w && !w.isDestroyed()) {
    try {
      payload = await Promise.race([
        w.webContents.executeJavaScript('window.__getGenPayload ? window.__getGenPayload() : null'),
        new Promise((r) => setTimeout(() => r(null), 3000)),
      ]);
    } catch {}
  }
  if (!payload) {
    // 普通生图流：提示词卡内容 + AI生图卡参数
    const g = config.gen || {};
    if (!(g.prompt || '').trim()) return { ok: false, error: '提示词为空' };
    payload = {
      prompt: g.prompt, ratio: g.ratio || 'Auto', size: g.size || 'Auto',
      antiMode: g.antiMode || 0, chartOn: !!g.chartOn, refs: g.refs || [],
    };
  }
  if (!(payload.prompt || '').trim()) return { ok: false, error: '该模块提示词为空' };

  // ---------- 批处理模式（控制台开关）：跑遍PS里每张打开的图 ----------
  // 并发版：先逐张采集（PS只能一张张激活），然后全部请求同时进队并发跑图，最后逐张贴回各自原图；
  // 各图有选区跑选区、无选区跑全图（noSelFull链路）；中途关掉开关=未发起的不再发，已完成的照常贴回
  if (config.gen.batchAll === '1') {
    const bd = await listDocsForBatch();
    if (!bd.ok) return bd;
    return runBatchAllDocs(Object.assign({}, payload), count, bd.docs);
  }

  return runBatch(payload, count);
});

// ---------- AI生图（Gemini兼容 generateContent，三渠道） ----------
// 渠道解析：地址/Key/模型/有效分辨率/请求模型名(AJI加-1k后缀)/单张价格
function resolveGen(p) {
  const PROVIDERS = ctx.PROVIDERS;
  const prov = (p && p.provider) || config.provider || 'momo';
  // cus_* 自定义渠道走 providerMeta 合成的 meta（Gemini兼容/动态模型）；内置渠道原样
  const meta = (ctx.providerMeta && ctx.providerMeta(prov)) || PROVIDERS[prov] || PROVIDERS.momo;
  const pc = config.providers[prov] || {};
  const base = (pc.base || meta.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);   // 空格/换行/零宽=粘贴垃圾，静默清；中文字符留给keyIssue报人话
  const model = (p && p.model) || pc.model || '';
  const mconf = meta.models && meta.models[model];
  let effSize = (p && p.size) || 'Auto';
  if (mconf && (effSize === 'Auto' || !mconf.sizes.includes(effSize))) effSize = mconf.def;
  let requestModel = model;
  if (mconf && mconf.suffix && model.indexOf('gemini') === -1 && effSize && effSize !== 'Auto') {
    requestModel = model + '-' + effSize.toLowerCase();   // AJI规则：模型名带分辨率后缀
  }
  const cost = (mconf && mconf.prices && mconf.prices[effSize] != null) ? mconf.prices[effSize] : null;
  return { prov, meta, pc, base, key, model, mconf, effSize, requestModel, cost };
}

async function generateOne(p) {
  // Forge 本地通道（0918）：自动修图的工序渠道选 Forge 时走这里——不走云端渠道解析，
  // 参数整套来自工序选的 Forge 预设（模型/LoRA/重绘/步数/CFG/采样器/CN），输入图是按原图尺寸跑的。
  if (p && p.forge) {
    if (!ctx.forgeGenerate) return { ok: false, error: 'Forge 通道未就绪（forge.js 未加载）' };
    return ctx.forgeGenerate(Object.assign({ url: config.forge && config.forge.url }, p.forge));
  }
  const rv = resolveGen(p);
  if (!rv.base || !rv.key) return { ok: false, error: '请先配置「' + rv.meta.label + '」渠道的地址和Key' };
  const kerr = ctx.keyIssue(rv.key, rv.meta.label);
  if (kerr) return { ok: false, error: kerr };   // Key含中文字符：发请求前就拦，不让fetch抛ByteString天书
  if (!rv.model) return { ok: false, error: '请先选择模型' };
  // 0909：按模型表 api 字段分流——'grs'=GRS 自家异步接口，'openai'=OpenAI 图片接口；缺省=Gemini generateContent
  const api = rv.mconf && rv.mconf.api;
  if (api === 'grs') return generateViaGrs(p, rv);
  if (api === 'openai') return generateViaOpenAI(p, rv);
  return generateViaGemini(p, rv);
}

// 把结果落盘（三条路共用）：buf → genDir/gen_*.ext；顺手记住当前模型
// 0915：dataUrl 改按需（wantDataUrl）——整张结果图再编一遍 base64（4K≈几十ms 主线程同步）只有
// 页面直调 ai-generate 预览（打光卡法线/深度）才用；批量链/打光主进程链只用 file，白编=生图期间主线程卡顿帮凶
function saveResult(rv, buf, mime, wantDataUrl) {
  const ext = /jpe?g/i.test(mime || '') ? 'jpg' : 'png';
  const dir = genDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'gen_' + uniq() + '.' + ext);
  fs.writeFileSync(file, buf);
  config.providers[rv.prov].model = rv.model;
  saveConfig();
  const out = { ok: true, file };
  if (wantDataUrl) out.dataUrl = 'data:' + (mime || 'image/png') + ';base64,' + buf.toString('base64');
  return out;
}
// 下载网关回的图片 URL（GRS/AJI 的 OpenAI 格式回 url）
async function fetchImage(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error('下载结果图失败 HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get('content-type') || '';
  const mime = /jpe?g/i.test(ct) ? 'image/jpeg' : (/png/i.test(ct) ? 'image/png' : (buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png'));
  return { buf, mime };
}
// 参考图列表 → [{buf,mime}]（三条路共用，最多 12 张，坏文件跳过）
function readRefs(p) {
  const out = [];
  if (!Array.isArray(p.refs)) return out;
  for (const fp of p.refs.slice(0, 12)) {
    try {
      const buf = fs.readFileSync(fp);
      const ext2 = path.extname(fp).toLowerCase();
      out.push({ buf, mime: (ext2 === '.jpg' || ext2 === '.jpeg') ? 'image/jpeg' : (ext2 === '.webp' ? 'image/webp' : 'image/png') });
    } catch {}
  }
  return out;
}
const tmoOf = (p) => {
  // 优先读参数显式传的；否则读配置里的 genTimeout（秒）；最后兜底 600 秒
  if (p && p.timeoutMs != null) return Number(p.timeoutMs);
  const sec = (config.gen && config.gen.genTimeout != null) ? Number(config.gen.genTimeout) : 600;
  return Math.max(30, Math.min(3600, sec)) * 1000;
};
const errText = (e, tmoMs) => (e && e.name === 'AbortError') ? '请求超时(' + Math.round(tmoMs / 1000) + '秒)' : ((e && e.message) || String(e));

// ---- 路①：GRS 自家接口 POST /v1/api/generate（replyType:async）→ GET /v1/api/result?id= 轮询（官方文档 qmy27nhsd9.apifox.cn）----
// 参数：gpt-image 系 aspectRatio 要像素 "WxH"（gpt-image-2 也认 "16:9"）；nano-banana 系 aspectRatio 比例 + imageSize 档位。
// 状态：running / succeeded / failed / violation；结果 results[0].url。
async function generateViaGrs(p, rv) {
  const { pixelSize, normRatio } = require('./img-size');
  const isGpt = /^gpt-image/i.test(rv.model);
  const body = { model: rv.model, prompt: p.prompt, images: [], replyType: 'async' };
  if (isGpt) body.aspectRatio = pixelSize(p.ratio, rv.effSize);
  else { body.aspectRatio = normRatio(p.ratio); if (rv.effSize && rv.effSize !== 'Auto') body.imageSize = rv.effSize; }
  if (p.inputImage) body.images.push('data:' + (p.inputMime || 'image/jpeg') + ';base64,' + p.inputImage);
  for (const r of readRefs(p)) body.images.push('data:' + r.mime + ';base64,' + r.buf.toString('base64'));
  const tmoMs = tmoOf(p);
  const ctrl = new AbortController();
  const timer = tmoMs > 0 ? setTimeout(() => ctrl.abort(), tmoMs) : null;
  const H = { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + rv.key };
  try {
    const resp = await fetch(rv.base + '/v1/api/generate', { method: 'POST', headers: H, body: Buffer.from(JSON.stringify(body), 'utf8'), signal: ctrl.signal });
    let j = null; try { j = await resp.json(); } catch {}
    if (!resp.ok || !j || !j.id) return { ok: false, error: 'HTTP ' + resp.status + ((j && j.error) ? ' — ' + String(j.error).slice(0, 180) : '') };
    let st = j;
    let polls = 0, stall = 0;
    while (st.status === 'running' || !st.status) {
      await new Promise((r) => setTimeout(r, 2500));
      // 单次轮询自己限时 20s（网关偶发挂住一次别把整张图拖死）；连续 5 次异常才放弃
      const pc = new AbortController();
      const onAbort = () => pc.abort();
      ctrl.signal.addEventListener('abort', onAbort, { once: true });
      const pt = setTimeout(() => pc.abort(), 20000);
      try {
        const q = await fetch(rv.base + '/v1/api/result?id=' + encodeURIComponent(j.id), { headers: H, signal: pc.signal });
        st = await q.json(); stall = 0;
      } catch (e) {
        if (ctrl.signal.aborted) throw e;
        st = { status: 'running' };
        if (++stall >= 5) return { ok: false, error: '查询生成结果连续失败（任务 ' + j.id + '）' };
      } finally { clearTimeout(pt); ctrl.signal.removeEventListener('abort', onAbort); }
      if (++polls === 24) olog('⏳ GRS 任务 ' + rv.model + ' 已等 1 分钟仍在生成（' + (st.progress != null ? st.progress + '%' : '渠道未报进度') + '）…');
    }
    if (st.status === 'violation') return { ok: false, error: '安全过滤: 渠道判定违规（' + (st.error || '') + '），建议修改提示词' };
    if (st.status !== 'succeeded') return { ok: false, error: '生成失败: ' + (st.error || st.status || '未知') };
    const url = st.results && st.results[0] && st.results[0].url;
    if (!url) return { ok: false, error: '未返回图片' };
    const { buf, mime } = await fetchImage(url, ctrl.signal);
    return saveResult(rv, buf, mime, p.wantDataUrl);
  } catch (e) {
    return { ok: false, error: errText(e, tmoMs) };
  } finally { clearTimeout(timer); }
}

// ---- 路②：OpenAI 图片接口（AJI gpt-image 系；supported_endpoint_types 只有 openai）----
// 无输入图：POST /v1/images/generations（JSON）；有输入图/参考图：POST /v1/images/edits（multipart，image[] 多张）。
// size="WxH"（或 auto）；回包 data[0].b64_json（AJI generations 带）或 data[0].url（edits 只回 url）。真机四组 200。
async function generateViaOpenAI(p, rv) {
  const { pixelSize } = require('./img-size');
  const size = pixelSize(p.ratio, rv.effSize);
  const imgs = [];
  if (p.inputImage) imgs.push({ buf: Buffer.from(p.inputImage, 'base64'), mime: p.inputMime || 'image/jpeg' });
  imgs.push(...readRefs(p));
  const tmoMs = tmoOf(p);
  const ctrl = new AbortController();
  const timer = tmoMs > 0 ? setTimeout(() => ctrl.abort(), tmoMs) : null;
  try {
    let resp;
    if (!imgs.length) {
      resp = await fetch(rv.base + '/v1/images/generations', {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + rv.key },
        body: Buffer.from(JSON.stringify({ model: rv.model, prompt: p.prompt, n: 1, size }), 'utf8'), signal: ctrl.signal,
      });
    } else {
      const fd = new FormData();
      fd.append('model', rv.model);
      fd.append('prompt', p.prompt);
      fd.append('n', '1');
      fd.append('size', size);
      imgs.forEach((im, i) => fd.append('image[]', new Blob([im.buf], { type: im.mime }), 'img' + i + (im.mime === 'image/png' ? '.png' : '.jpg')));
      resp = await fetch(rv.base + '/v1/images/edits', { method: 'POST', headers: { 'Authorization': 'Bearer ' + rv.key }, body: fd, signal: ctrl.signal });
    }
    let j = null; try { j = await resp.json(); } catch {}
    if (!resp.ok) {
      const detail = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
      return { ok: false, error: 'HTTP ' + resp.status + (detail ? ' — ' + String(detail).slice(0, 180) : '') };
    }
    const d = j && j.data && j.data[0];
    if (!d) return { ok: false, error: '未返回图片' };
    if (d.b64_json) { const buf = Buffer.from(d.b64_json, 'base64'); return saveResult(rv, buf, buf[0] === 0xff ? 'image/jpeg' : 'image/png', p.wantDataUrl); }
    if (d.url) { const { buf, mime } = await fetchImage(d.url, ctrl.signal); return saveResult(rv, buf, mime, p.wantDataUrl); }
    return { ok: false, error: '未返回图片' };
  } catch (e) {
    return { ok: false, error: errText(e, tmoMs) };
  } finally { clearTimeout(timer); }
}

// ---- 路③：Gemini 兼容 generateContent（老路，三渠道通用）----
async function generateViaGemini(p, rv) {
  const model = rv.model;
  const base = rv.base, key = rv.key;

  const generationConfig = { responseModalities: ['IMAGE', 'TEXT'], temperature: 0.8, topP: 0.95, maxOutputTokens: 8192 };
  const imageConfig = {};
  if (rv.effSize && rv.effSize !== 'Auto') imageConfig.imageSize = rv.effSize;
  if (p.ratio && p.ratio !== 'Auto') imageConfig.aspectRatio = p.ratio;
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;

  // parts结构（老插件同款）：文字 → 选区输入图(img2img) → 参考图
  const parts = [{ text: p.prompt }];
  if (p.inputImage) {
    parts.push({ inlineData: { mimeType: p.inputMime || 'image/jpeg', data: p.inputImage } });
  }
  if (Array.isArray(p.refs)) {
    for (const fp of p.refs.slice(0, 12)) {
      try {
        const buf = fs.readFileSync(fp);
        const ext2 = path.extname(fp).toLowerCase();
        const mime2 = (ext2 === '.jpg' || ext2 === '.jpeg') ? 'image/jpeg' : (ext2 === '.webp' ? 'image/webp' : 'image/png');
        parts.push({ inlineData: { mimeType: mime2, data: buf.toString('base64') } });
      } catch {}
    }
  }
  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig,
  };

  const ctrl = new AbortController();
  // timeoutMs=0 表示不设超时（打光等长任务用）；未传则走 tmoOf（读 config.gen.genTimeout，默认600秒）
  // ⚠0919 修：原来这里硬编码 180000，导致生图卡设置了 3600 秒，走 Gemini 兼容接口的渠道仍 180 秒被截断
  const tmoMs = tmoOf(p);
  const timer = tmoMs > 0 ? setTimeout(() => ctrl.abort(), tmoMs) : null;
  try {
    const resp = await fetch(`${base}/v1beta/models/${rv.requestModel}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + key },
      // ⚠body必须UTF-8字节：JSON.stringify不转义中文，裸字符串含非ASCII(如"动"=21160)会被某些fetch
      // 当ByteString转换抛"Cannot convert argument to a ByteString"（0907与chat/autofix同源，批量生成粒子图易中）。
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try {
        const j = await resp.json();
        detail = (j.error && (j.error.message || j.error.type)) || j.message || '';
      } catch {}
      return { ok: false, error: `HTTP ${resp.status}${detail ? ' — ' + String(detail).slice(0, 180) : ''}` };
    }
    const data = await resp.json();

    if (data.promptFeedback && data.promptFeedback.blockReason) {
      return { ok: false, error: '安全过滤(输入): ' + data.promptFeedback.blockReason + '，建议修改提示词' };
    }
    const cand = data.candidates && data.candidates[0];
    if (cand && cand.finishReason === 'SAFETY') {
      return { ok: false, error: '安全过滤(输出): 生成被中断，建议修改提示词' };
    }
    const part = cand && cand.content && cand.content.parts && cand.content.parts.find((x) => x.inlineData);
    if (!part) {
      const txtPart = cand && cand.content && cand.content.parts && cand.content.parts.find((x) => x.text);
      const txt = txtPart ? txtPart.text : '';
      return { ok: false, error: '未返回图片' + (txt ? '；模型回复: ' + txt.slice(0, 150) : '') };
    }

    const b64 = part.inlineData.data;
    const mime = part.inlineData.mimeType || 'image/png';
    return saveResult(rv, Buffer.from(b64, 'base64'), mime, p.wantDataUrl);
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时(' + Math.round(tmoMs / 1000) + '秒)' : (e.message || String(e)) };
  } finally {
    clearTimeout(timer);
  }
}
ipcMain.handle('ai-generate', (_e, p) => generateOne(Object.assign({ wantDataUrl: true }, p)));   // 页面直调要 dataUrl 预览（打光卡法线/深度）
ctx.generateOne = generateOne;   // 打光等模块从主进程直调（带olog与自定义超时）

// ---------- 生图任务中心：全局注册表，进度卡实时订阅 ----------
// status: running(生成中) done(待入PS) placed(已入PS) deleted(已删除) blocked(被截断) error(失败)
const genTasks = [];
let genSeq = 0;
let batchSeq = 0;   // 一次提交=一批=进度卡里一个气泡组
// ---- 缩略图（0908 用户裁定：进度卡只显示 256px 小图）----
// 进度卡以前直接拿 2K/4K 原图当 <img src>，渲染进程把整张解码后缓存（一张 4K=64MB），跑几批就几百 MB
// 记录条数不设上限（0909用户裁定：取消"只留最近 20 条"，回图张数无限）；记录只在用户于进度卡点 ✕ 时移除
const THUMB_W = 256;
function thumbOf(file) {
  if (!file) return null;
  try {
    const out = file.replace(/\.[a-z0-9]+$/i, '') + '.thumb.jpg';
    if (fs.existsSync(out)) return out;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const sz = img.getSize();
    const w = Math.min(THUMB_W, sz.width);
    const small = sz.width > w ? img.resize({ width: w, quality: 'good' }) : img;
    fs.writeFileSync(out, small.toJPEG(82));
    return out;
  } catch (e) { return null; }
}
function unlinkQuiet(f) { if (!f) return; try { fs.unlinkSync(f); } catch (e) {} }
// 中号预览（0913 看图层）：1600 宽 JPEG，滚轮切图看它（解码 8ms）而不是原图（4K 解码 26ms+囤整张位图）；贴回仍用原图
const MID_W = 1600;
function midOf(file) {
  if (!file) return null;
  try {
    const out = file.replace(/\.[a-z0-9]+$/i, '') + '.mid.jpg';
    if (fs.existsSync(out)) return out;
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return null;
    const sz = img.getSize();
    const w = Math.min(MID_W, sz.width);
    const small = sz.width > w ? img.resize({ width: w, quality: 'good' }) : img;
    fs.writeFileSync(out, small.toJPEG(85));
    return out;
  } catch (e) { return null; }
}
// 结果图落盘后一次解码出两档预览（缩略 256 + 中号 1600），别各解一遍
function previewsOf(file) {
  if (!file) return { thumb: null, mid: null };
  const thumbOut = file.replace(/\.[a-z0-9]+$/i, '') + '.thumb.jpg';
  const midOut = file.replace(/\.[a-z0-9]+$/i, '') + '.mid.jpg';
  try {
    if (fs.existsSync(thumbOut) && fs.existsSync(midOut)) return { thumb: thumbOut, mid: midOut };
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return { thumb: null, mid: null };
    const sz = img.getSize();
    if (!fs.existsSync(thumbOut)) { const w = Math.min(THUMB_W, sz.width); fs.writeFileSync(thumbOut, (sz.width > w ? img.resize({ width: w, quality: 'good' }) : img).toJPEG(82)); }
    if (!fs.existsSync(midOut)) { const w = Math.min(MID_W, sz.width); fs.writeFileSync(midOut, (sz.width > w ? img.resize({ width: w, quality: 'good' }) : img).toJPEG(85)); }
    return { thumb: thumbOut, mid: midOut };
  } catch (e) { return { thumb: fs.existsSync(thumbOut) ? thumbOut : null, mid: fs.existsSync(midOut) ? midOut : null }; }
}
// 0915合并风暴：任务列表几百条（实机258条、提示词动辄几千字），每次状态变化全量序列化广播到12个窗口
// +看图层同步+落盘调度，贴回/批量完成的瞬间连发好几轮=主线程洪峰（用户实报"看图层退回去面板卡住"）。
// 120ms 尾沿合并：一轮洪峰只广播一次；单发时也只延迟一帧级别，进度卡无感。
let bcTimer = null;
function broadcastTasks() {
  if (bcTimer) return;
  bcTimer = setTimeout(() => {
    bcTimer = null;
    broadcast('gen-tasks', genTasks);
    try { if (ctx.viewerSync) ctx.viewerSync(); } catch (e) {}   // 看图层开着时同步序列/贴回状态（0913）
    scheduleTasksSave();
  }, 120);
}

// ---------- 进度持久化（0913用户裁定：重启不丢）----------
// 索引文件放缓存夹里、名字用 gen_ 前缀：与图片同生同死——清缓存（只删已知前缀）会把索引一并清掉，
// 改缓存夹位置时索引跟着搬（tasksFileMoveTo）。不进 config（参考图撑爆 webview_storage 的教训）。
const TASKS_FILE = 'gen_tasks.json';
const tasksPath = () => path.join(genDir(), TASKS_FILE);
let tasksSaveTimer = null;
function scheduleTasksSave() {
  clearTimeout(tasksSaveTimer);
  tasksSaveTimer = setTimeout(writeTasksNow, 600);
}
function writeTasksNow() {
  clearTimeout(tasksSaveTimer); tasksSaveTimer = null;
  try {
    const dir = genDir();
    fs.mkdirSync(dir, { recursive: true });
    // running 不落盘为 running：重启后没人接着跑，读回时一律标 error（见 loadTasks）
    const body = JSON.stringify({ v: 1, seq: genSeq, batchSeq, tasks: genTasks });
    const p = tasksPath(), tmp = p + '.tmp';
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, p);
  } catch (e) { try { ctx.dlog('[tasks] 写盘失败 ' + (e && e.message)); } catch {} }
}
// 开机回读 + 对账：文件被删（清缓存/自动清理/用户手删）的记录剔除；重启瞬间还在 running 的一律标失败（否则永远转圈）
function loadTasks() {
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(tasksPath(), 'utf8')); } catch (e) { return; }
  if (!saved || !Array.isArray(saved.tasks)) return;
  let kept = 0, dropped = 0, orphanRun = 0;
  for (const t of saved.tasks) {
    if (!t || !t.id) continue;
    if (t.status === 'running') { t.status = 'error'; t.error = '上次退出时未完成'; orphanRun++; }
    if (t.file && !fs.existsSync(t.file)) { dropped++; continue; }   // 结果图没了=记录作废
    if (t.thumb && !fs.existsSync(t.thumb)) t.thumb = null;           // 缩略图没了退回原图（进度卡自会用 file）
    if (t.mid && !fs.existsSync(t.mid)) t.mid = null;
    if (t.inputThumb && !fs.existsSync(t.inputThumb)) t.inputThumb = null;
    if (t.inputFile && !fs.existsSync(t.inputFile)) t.inputFile = null;
    if (!t.file && t.status !== 'error' && t.status !== 'blocked') { dropped++; continue; }   // 没图也不是失败记录=垃圾
    genTasks.push(t);
    kept++;
  }
  // 序号接着上次走，避免新任务 id 撞老记录（进度卡按 id 对账）
  genSeq = Math.max(genSeq, Number(saved.seq) || 0);
  batchSeq = Math.max(batchSeq, Number(saved.batchSeq) || 0);
  try { ctx.dlog('[tasks] 回读 ' + kept + ' 条' + (dropped ? '，剔除 ' + dropped + ' 条（文件已不在）' : '') + (orphanRun ? '，' + orphanRun + ' 条上次未完成已标失败' : '')); } catch {}
  if (dropped || orphanRun) scheduleTasksSave();
}
// 改缓存夹：索引跟着搬（留在旧夹=下次启动读不到，等于全丢）
ctx.tasksFileMoveTo = (newDir) => {
  try {
    writeTasksNow();
    const src = tasksPath();
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(newDir, { recursive: true });
    fs.copyFileSync(src, path.join(newDir, TASKS_FILE));
    try { fs.unlinkSync(src); } catch {}
  } catch (e) { try { ctx.dlog('[tasks] 搬索引失败 ' + (e && e.message)); } catch {} }
};

// ---------- 定期清理（0918用户裁定：天数手输，到期全删——不再区分是否已贴回）----------
// 判据=文件修改时间（不看索引）：没索引的孤儿图（老版本跑的）一样管得到。只删已知前缀（CACHE_OWN），用户放进去的东西不碰。
// ⚠0918 起不再豁免"已贴回PS"的那张：用户要的是"所有图片不管有没有贴回"。
//   贴回只影响 PS 里的图层，缓存图本身到期即删；进度卡上那张已贴回的缩略图会随之变空，属预期。
//   天数由用户在生图卡设置页手输（0=永不，1-365），不再是 7/14/30 三档。
function autoCleanDays() {
  const d = Number(config.gen && config.gen.autoCleanDays) || 0;
  if (!d) return 0;
  return Math.max(1, Math.min(365, Math.floor(d)));
}
function runAutoClean(why) {
  const days = autoCleanDays();
  if (!days) return { ok: true, days: 0, deleted: 0 };
  const dir = genDir();
  const cutoff = Date.now() - days * 86400000;
  let deleted = 0, bytes = 0;
  const gone = new Set();
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!CACHE_OWN.test(f) || f === TASKS_FILE) continue;
      const p = path.join(dir, f);
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory() || st.mtimeMs > cutoff) continue;
      try { fs.unlinkSync(p); deleted++; bytes += st.size; gone.add(p.toLowerCase()); } catch {}
    }
  } catch (e) { return { ok: false, error: e && e.message }; }
  // 索引同步：结果图被删的记录剔除；输入图被删的记录只清输入字段
  if (gone.size) {
    for (let i = genTasks.length - 1; i >= 0; i--) {
      const t = genTasks[i];
      if (t.file && gone.has(String(t.file).toLowerCase())) { genTasks.splice(i, 1); continue; }
      if (t.thumb && gone.has(String(t.thumb).toLowerCase())) t.thumb = null;
      if (t.mid && gone.has(String(t.mid).toLowerCase())) t.mid = null;
      if (t.inputFile && gone.has(String(t.inputFile).toLowerCase())) t.inputFile = null;
      if (t.inputThumb && gone.has(String(t.inputThumb).toLowerCase())) t.inputThumb = null;
    }
    broadcastTasks();
  }
  const mb = (bytes / 1048576).toFixed(1);
  try { ctx.dlog('[tasks] 自动清理(' + why + ') ' + days + '天：删 ' + deleted + ' 个 ' + mb + 'MB（含已贴回）'); } catch {}
  if (deleted) olog('🧹 自动清理：删除 ' + days + ' 天前的缓存图 ' + deleted + ' 个（' + mb + ' MB）');
  return { ok: true, days, deleted, spared: 0, bytes };
}
ipcMain.handle('auto-clean-now', () => runAutoClean('手动'));
// 开机：先回读索引再清理（清理要看索引里谁贴过）；之后每天跑一次；退出前把防抖中的索引落盘
app.whenReady().then(() => {
  setTimeout(() => {
    try { loadTasks(); } catch (e) {}
    try { runAutoClean('开机'); } catch (e) {}
    broadcastTasks();
    setInterval(() => { try { runAutoClean('每日'); } catch (e) {} }, 86400000);
  }, 1500);   // 让 loadConfig 先跑完（cacheDir 决定索引在哪）
});
app.on('before-quit', () => { try { writeTasksNow(); } catch (e) {} });
ctx.flushTasks = writeTasksNow;   // 关机路径（index.js shutdownNow）同步落盘
ipcMain.handle('get-gen-tasks', () => genTasks);
ctx.getGenTasks = () => genTasks;   // 看图层按进度卡同一套分组顺序取序列
ctx.midOf = midOf;
// smoke 直测用：带 CDP 口启动时才开放——往任务中心塞一条"已完成"的任务（file=现成图片），看图层链路不花 API 费就能机测
if (TEST_MODE) {
  ipcMain.handle('viewer-test-seed', (_e, p) => {
    const file = p && p.file;
    if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    const pv = previewsOf(file);
    const t = ctx.genTaskAdd({ batchId: (p && p.batchId) || null, status: (p && p.status) || 'done', file, thumb: pv.thumb, mid: pv.mid, prompt: (p && p.prompt) || 'smoke', hasInput: false });
    return { ok: true, id: t.id, mid: pv.mid, thumb: pv.thumb };
  });
  // 持久化/清理机测钩子：flush=立刻落盘 · reload=落盘→清内存→按文件回读（模拟重启） · clean=按当前档位清一次 · path=索引路径
  ipcMain.handle('tasks-test', (_e, op) => {
    if (op === 'flush') { writeTasksNow(); return { ok: true, path: tasksPath() }; }
    if (op === 'reload') { writeTasksNow(); genTasks.length = 0; loadTasks(); broadcastTasks(); return { ok: true, count: genTasks.length, ids: genTasks.map((t) => t.id) }; }
    if (op === 'clean') return runAutoClean('机测');
    if (op === 'path') return { ok: true, path: tasksPath(), dir: genDir() };
    return { ok: false, error: '未知 op' };
  });
  // 任务中心直操钩子（提前贴回机测等）：塞任务 / 改字段 / 清掉
  ipcMain.handle('test-inject-tasks', (_e, tasks) => { genTasks.push(...tasks); broadcastTasks(); return tasks.map((t) => t.id); });
  ipcMain.handle('test-update-task', (_e, { id, updates }) => { const t = genTasks.find((x) => x.id === id); if (t) Object.assign(t, updates); broadcastTasks(); return !!t; });
  ipcMain.handle('test-remove-tasks', (_e, ids) => {
    for (const id of ids) { const i = genTasks.findIndex((x) => x.id === id); if (i >= 0) genTasks.splice(i, 1); }
    broadcastTasks();
    return true;
  });
}
// 供其他模块（打光等）把自己的生成注册进进度卡：同一套任务对象/广播机制
ctx.genBatchId = () => 'b' + (++batchSeq);
ctx.genTaskAdd = (fields) => {
  const t = Object.assign({
    id: 'g' + (++genSeq), batchId: null, status: 'running',
    prompt: '', file: null, thumb: null, error: null, docId: null, selection: null,
    inputFile: null, inputThumb: null, antiMode: 0, hasInput: true, ts: Date.now(),
  }, fields || {});
  if (t.inputFile && !t.inputThumb) t.inputThumb = thumbOf(t.inputFile);
  genTasks.unshift(t);
  broadcastTasks();
  return t;
};
ctx.genTaskUpdate = (t, patch) => {
  Object.assign(t, patch);
  if (patch && patch.file) { const pv = previewsOf(patch.file); t.thumb = pv.thumb; t.mid = pv.mid; }
  broadcastTasks();
};

ipcMain.on('task-action', (_e, { id, action }) => {
  const t = genTasks.find((x) => x.id === id);
  if (!t) return;
  if (action === 'placed' || action === 'deleted') { t.status = action; broadcastTasks(); }
  else if (action === 'restore') { t.status = 'done'; broadcastTasks(); }
  else if (action === 'remove') {
    const i = genTasks.indexOf(t);
    if (i >= 0) genTasks.splice(i, 1);
    t.noPlace = true;   // 0909用户裁定：删掉进度条目=这张完成后不再自动贴回（请求照跑不管，无需担心计费）
    broadcastTasks();
  }
  else if (action === 'remove-batch') {
    // 整批移除（气泡组的✕）；还在跑的批次=整批完成后不再自动贴回（0909用户裁定）
    let running = 0;
    for (let i = genTasks.length - 1; i >= 0; i--) {
      if (genTasks[i].batchId && genTasks[i].batchId === t.batchId) {
        if (genTasks[i].status === 'running') running++;
        genTasks[i].noPlace = true;
        genTasks.splice(i, 1);
      }
    }
    if (running) olog('🗑 已删除进行中的批次（' + running + ' 张还在跑）：本批完成后不再自动贴回PS', 'info');
    broadcastTasks();
  }
});

// 正则控件渲染（滑块卡的值织回提示词）：@param值改写为已调值；【填空:名=默认】替换为填写内容
// 模板本体(config.gen.prompt)永不改动——只在发起生成这一刻合成最终文本
function applyPromptControls(text) {
  const ctl = (config.gen && config.gen.ctl) || {};
  const pv = ctl.params || {}, bv = ctl.blanks || {};
  let out = String(text || '');
  out = out.replace(/(@param:([^"\s:]+?)"\s*:\s*)([-\d.]+)/g, (m, pre, name) =>
    (pv[name] != null && !/_(desc|label|note|range)$/.test(name)) ? (pre + (Math.round(pv[name] * 100) / 100)) : m);
  // 填空：已填(含显式清空='')用填写值；没碰过用默认；连默认都没有→空串
  out = out.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (m, name, def) =>
    (bv[name] != null) ? bv[name] : (def || ''));
  return out;
}

// 比例裁决（规则与注释见 core/eff-ratio.js，纯函数、smoke 直测）
const { effRatio } = require('./eff-ratio');
ctx.effRatio = effRatio;   // 打光等直调 generateOne 的模块同用
// 渠道吞比例侦测：要了具体比例却回来明显不符→日志卡点名（autofix 同款口径，对数差>0.12≈12%）
function ratioWarn(file, ratio, tag) {
  try {
    const [ra, rb] = String(ratio || '').split(':').map(Number);
    if (!(ra > 0 && rb > 0)) return;
    const sz = nativeImage.createFromPath(file).getSize();
    if (sz.width && sz.height && Math.abs(Math.log((sz.width / sz.height) / (ra / rb))) > 0.12) {
      olog('⚠ ' + (tag || '') + '渠道未按请求比例出图（要' + ratio + '，回' + sz.width + 'x' + sz.height + '）——贴回会被拉伸变形，建议换模型/渠道', 'err');
    }
  } catch {}
}

// 批量生成：并发池4，最多100张；每张的状态实时广播给进度卡
// 贴回带重试（0909"跑完图不回图"排查）：PS 正忙（模态对话框开着/用户正在自由变换/另一条命令占着 executeAsModal）时
// 贴回会被拒，这是瞬时状态；原来一次失败就放弃，只在日志留一行，用户体感=没回图。改成失败 2.5s 后再试，最多 3 次；
// 连接类错误（PS 没开/断开）与"原文档已关闭"这种确定性错误不重试。所有能生图的模块（生图/批处理/Forge/打光）共用。
async function placeWithRetry(action, params, timeoutMs) {
  let pr = null;
  for (let k = 1; k <= 3; k++) {
    pr = await sendToPSAwait({ action, params }, timeoutMs);
    if (pr.ok) return pr;
    if (/未连接|未启动|已断开|已关闭|找不到/.test(pr.error || '')) return pr;
    if (k < 3) {
      olog('⬇ 回图失败（第' + k + '次）：' + (pr.error || '') + ' · 2.5秒后重试（PS 有对话框开着/正在变换会导致此错，请先关掉）', 'err');
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  return pr;
}
ctx.placeWithRetry = placeWithRetry;

async function runBatch(params, count, forceDocId) {
  const total = Math.max(1, Math.min(100, Number(count) || 1));
  params.prompt = applyPromptControls(params.prompt);   // 滑块/填空值织入最终提示词

  // 发起时抓取PS上下文（老插件核心工作流）：
  // 有选区→选区内容作为输入图(img2img)；记住文档ID+选区坐标，回传时精确回到原处
  let psCtx = null;
  const antiMode = Number(params.antiMode) || 0;

  // 色卡校准（魔改版流程）：跑图前贴卡→提示词加保护语→回图后测偏校正遮卡
  const CHART_PROMPT = '\n(注意:图像最底部有一条彩色校准色卡条,它是色彩测量工具。请在输出图像中严格原样保留这条色卡:每个色块的颜色、位置、边界都不得修改、模糊、移除或美化)';
  const chartOn = !!params.chartOn;
  if (chartOn) {
    const st = await sendToPSAwait({ action: 'chartStamp', params: {} }, 60000);
    if (st.ok) {
      params.prompt = (params.prompt || '') + CHART_PROMPT;
      olog('[色卡] 已贴卡并附加保护提示词');
    } else {
      olog('[色卡] 贴卡失败(' + (st.error || '') + ')，本批按普通模式跑', 'err');
    }
  }
  if (antiMode > 0) olog('[抗截断] 模式' + antiMode + '（' + (antiMode === 1 ? '翻转' : antiMode === 2 ? '色相' : '色相+翻转') + '）已启用');

  // 旧版插件拦头喊话：每次点生成都提醒（连接时那条容易淹在日志里）——旧版会缺新功能（如v28的自动回传打组）
  if (ctx.bridgeVer() > 0 && ctx.curBridgeVer && ctx.bridgeVer() < ctx.curBridgeVer) {
    olog('⚠️ PS里的橙子插件是旧版(v' + ctx.bridgeVer() + '→v' + ctx.curBridgeVer + ')，本批按旧行为执行——重启一次PS完成更新', 'err');
  }
  if (ctx.warnIfBridgeDown) ctx.warnIfBridgeDown('生图');   // 0908：桥接没连上每批都要在日志里说
  let capErr = '';
  try {
    // fullIfNoSel：设置里"无选区默认跑全图"开着→桥接件无选区时按整幅画布捕获（桥接件v25+支持）
    // 桥接 v57+ 会回 fullMode=true 标记"这张是无选区跑的全图"，比例据此锁成原图比例（0911 用户裁定的防蠢设计；v56 此处有作用域错误已废）
    // docId：批处理逐图跑时指定目标文档（桥接件v29+会先激活它再读选区）
    const cap = await sendToPSAwait({ action: 'captureInput', params: { antiMode, fullIfNoSel: !!config.gen.noSelFull, docId: forceDocId || undefined } }, 30000);
    if (cap.ok && cap.result) psCtx = cap.result;
    else capErr = cap.error || '采集无返回';
    try {
      fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [batch] capture: ok=' + cap.ok
        + ' err=' + (cap.error || '') + ' sel=' + !!(cap.result && cap.result.selection)
        + ' img=' + !!(cap.result && cap.result.image)
        + ' note=' + ((cap.result && cap.result.note) || '') + ' 桥接版本=' + ctx.bridgeVer() + '\n');
    } catch {}
  } catch (e) { capErr = (e && e.message) || String(e); }
  // 采集命令本身失败（桥接抛错/超时/未连接）≠没有选区：把真实错误说出来（0912 用户实报：v56 桥接每次抛
  // "fullMode is not defined"，这里原来一律打"插件还是旧版，请重启PS"，用户重启了也没用、根本不知道错在哪）
  if (!psCtx && capErr) {
    const stale = ctx.bridgeVer() > 0 && ctx.curBridgeVer && ctx.bridgeVer() < ctx.curBridgeVer;
    olog('[中止] 读取选区失败：' + capErr + (stale ? '（PS里的插件是旧版 v' + ctx.bridgeVer() + '，请完全退出并重启一次PS）' : ''), 'err');
    return { ok: false, error: '读取选区失败：' + capErr, done: 0, fail: 0, total };
  }
  if (psCtx && psCtx.selection && !psCtx.image) {
    olog('[中止] 检测到选区但截图失败' + (psCtx.note ? '：' + psCtx.note : ''), 'err');
    return { ok: false, error: '选区截图失败', done: 0, fail: 0, total };
  }
  // 无选区=不跑图（生成链路以选区img2img为核心，纯文生图容易误触浪费扣费）；
  // 设置开了"无选区默认跑全图"时由桥接件转成全图选区，走不到这里——走到=PS里还跑着不认 fullIfNoSel 的老版插件
  if (!psCtx || !psCtx.selection) {
    if (config.gen.noSelFull) olog('[中止] 无选区且全图捕获未生效——PS里的橙子插件是旧版（v' + ctx.bridgeVer() + '，需 v25+），请完全退出并重启一次PS完成更新', 'err');
    else olog('[中止] 没有选区——请先在PS里框选生成区域（设置里可开启"无选区默认跑全图"）', 'err');
    return { ok: false, error: '没有选区', done: 0, fail: 0, total };
  }
  if (psCtx && psCtx.image) {
    params.inputImage = psCtx.image;
    params.inputMime = psCtx.mime || 'image/jpeg';
    // 选区截图落盘，主面板气泡组显示"本次输入"缩略图
    try {
      const dir = genDir();
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'input_' + uniq() + '.jpg');
      fs.writeFileSync(f, Buffer.from(psCtx.image, 'base64'));
      psCtx.inputFile = f;
      psCtx.inputThumb = thumbOf(f);
    } catch {}
  }

  let done = 0, fail = 0;
  const batchId = 'b' + (++batchSeq);
  const batchTasks = [];
  const rvb = resolveGen(params);
  // 比例：有选区→显式比例照用户选的、Auto 跟选区；无选区跑全图→一律跟原图（防蠢设计，0911）
  const ratioIn = params.ratio || 'Auto';
  const isFull = !!(psCtx && psCtx.selection && psCtx.fullMode);
  params.ratio = effRatio(params.ratio, psCtx && psCtx.selection, isFull);
  const ratioNote = ratioIn === params.ratio ? params.ratio
    : ratioIn + '→' + params.ratio + (isFull ? '(无选区·跟原图)' : '(跟选区)');
  olog('▶ 批次开始 [' + rvb.meta.label + ' / ' + (rvb.mconf ? rvb.mconf.name : rvb.model) + ' / ' + rvb.effSize + '] ×' + total
    + (isFull ? ' · 无选区跑全图' : psCtx && psCtx.selection ? ' · 带选区输入' : ' · 纯文生图') + ' · 比例 ' + ratioNote);
  if (isFull && ratioIn !== 'Auto' && ratioIn !== params.ratio) {
    olog('📐 无选区跑全图：比例按原图 ' + params.ratio + '（卡上选的 ' + ratioIn + ' 本次不生效——比例与画布不符会把出图拉伸变形）');
  }
  // 任务先全部登记再开跑（0908用户反馈：跑19张球气泡开局显示0/4慢慢涨到19）——之前是worker取一张才建一张任务，
  // 并发4=开局只有4条，进度卡/球气泡按批次任务数算总数所以总数跟着涨。全部先建=开局就是0/19，19个转圈占位一起亮。
  const queue = [];
  for (let i = 0; i < total; i++) {
    const task = {
      id: 'g' + (++genSeq),
      batchId,
      status: 'running',
      prompt: params.prompt,
      file: null, error: null,
      docId: psCtx ? psCtx.docId : null,
      selection: psCtx ? psCtx.selection : null,
      inputFile: psCtx ? (psCtx.inputFile || null) : null,
      inputThumb: psCtx ? (psCtx.inputThumb || null) : null,
      antiMode,
      hasInput: !!(psCtx && psCtx.image),
      ts: Date.now(),
    };
    genTasks.unshift(task);
    batchTasks.push(task);
    queue.push(task);
  }
  broadcastTasks();
  const worker = async () => {
    while (queue.length) {
      const task = queue.shift();
      const r = await generateOne(params);
      if (r.ok) {
        task.status = 'done'; task.file = r.file; { const pv = previewsOf(r.file); task.thumb = pv.thumb; task.mid = pv.mid; } done++;
        olog('✓ 第' + (done + fail) + '张完成 (' + done + '/' + total + ')');
        ratioWarn(r.file, params.ratio, '');
      } else {
        task.status = /安全过滤|截断|SAFETY|RECITATION/.test(r.error || '') ? 'blocked' : 'error';
        task.error = ctx.humanizeErr(r.error);   // 进度卡显示人话报错
        fail++;
        olog('✗ ' + (task.status === 'blocked' ? '截断' : '失败') + ': ' + (r.error || '').slice(0, 120), 'err');
      }
      broadcastTasks();
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, total) }, worker));

  // 魔改版逻辑：所有请求结束后"统一回图"——整批一次贴回，整批打一个组
  // 自动回传失败(如PS正忙)不丢结果，任务保持"待入PS"状态等手动点图
  // noPlace=用户在进度卡删掉了这批/这张（0909裁定：删=不贴回）
  // holdPlace=用户点过这批的「提前贴回」（0916）：好的那几张已经贴过了，后完成的留在进度卡等手点，不自动贴
  const held = batchTasks.some((t) => t.holdPlace);
  const doneTasks = batchTasks.filter((t) => t.status === 'done' && t.file && !t.noPlace && !t.holdPlace);
  if (batchTasks.some((t) => t.noPlace) && !doneTasks.length && !held) olog('🗑 本批已被删除，跳过自动贴回', 'info');
  if (held) {
    const left = batchTasks.filter((t) => t.status === 'done' && t.file && t.holdPlace).length;
    olog('⏩ 本批已提前贴回过' + (left ? '：后完成的 ' + left + ' 张留在进度卡，点图可手动贴回' : '，无需再自动贴回'));
  }
  // 自动回传关着时原来一声不吭（0909"跑完图不传回"排查：生图模式卡右上角回传按钮被误关=最常见原因之一）
  if (config.gen.autoReturn === false && doneTasks.length) olog('⬇ 自动回传已关闭：本批 ' + doneTasks.length + ' 张已生成未贴回——进度卡点图可手动贴回；生图模式卡右上角「回传」按钮可重新打开', 'err');
  let placedOk = false;
  if (config.gen.autoReturn !== false && doneTasks.length) {
    placingBatches.add(batchId);   // 贴回期间拒绝同批「提前贴回」（否则同一批贴两遍）
    let pr;
    try {
      pr = await placeWithRetry('placeBatch', {
        paths: doneTasks.map((t) => t.file),
        docId: psCtx ? psCtx.docId : null,
        selection: psCtx ? psCtx.selection : null,
        antiMode,
        group: true,   // 自动回传整批=打组；进度卡手动单张贴回不带此参=免打组
      }, 0);   // 0905:回传不限时
    } finally { placingBatches.delete(batchId); }
    if (pr.ok) {
      doneTasks.forEach((t) => { t.status = 'placed'; });
      broadcastTasks();
      placedOk = true;
    }
    const note = pr.result && pr.result.note;
    olog((pr.ok ? '⬇ 统一回图 ' + doneTasks.length + '张 完成' : '⬇ 统一回图失败: ' + (pr.error || '') + '（图已保留在进度卡，点图可手动贴回）') + (note ? ' · ' + note : ''), pr.ok ? 'ok' : 'err');
  }
  // 色卡结算：测量色卡偏差→生成校正→遮卡（带发起文档id：贴回后PS已切回用户正看的文档，结算得自己找回贴卡那张）
  // 提前贴回过的批次也要结算：色卡是跑图前贴在文档上的，图已经进 PS 了，不结算就一直留着
  if (chartOn && (placedOk || held)) {
    await new Promise((r) => setTimeout(r, 700));
    const fin = await sendToPSAwait({ action: 'chartFinish', params: { docId: psCtx ? psCtx.docId : null } }, 120000);
    olog(fin.ok ? '[色卡] 结算完成：已测偏并生成校正层' : '[色卡] 结算失败: ' + (fin.error || ''), fin.ok ? 'ok' : 'err');
  }

  // 计费（魔改版口径：按请求次数计）；0915起不再显示扣费金额——报错未出图时部分渠道不扣钱，
  // 显示"已扣费"会冤枉渠道。广播保留：生图卡靠它响铃+自动刷新官网余额（余额才是唯一真账）
  let costTotal = null;
  if (rvb.cost != null) {
    costTotal = Math.round(rvb.cost * total * 100) / 100;
  }
  broadcast('billing', { provider: rvb.prov, cost: costTotal, currency: rvb.meta.currency });

  return { ok: true, done, fail, total };
}
ipcMain.handle('ai-generate-batch', (_e, { params, count }) => runBatch(params, count));

// ---------- 提前贴回（0916用户裁定） ----------
// 场景：一批跑 4 张，第 4 张卡住了，前 3 张早好了——用户不想干等。进度卡这批行上点橙子 logo：
//   ①已生成好还没贴的，现在就整批打组贴回 PS（与自动回传同一条链、同样打组）
//   ②这批**还在跑的**完成后不再自动贴回，留在进度卡里等用户手点（图不丢，随时可贴）
// 与「✕ 删除批次」的区别：图留着还能手贴；与「自动回传」总开关的区别：只管这一批。
// 机制：给整批立 holdPlace 旗（runBatch/runBatchAllDocs 收尾的自动贴回见旗跳过），再贴已好的。
// placingBatches：正在贴回中的批次——自动回传与提前贴回互斥，同一批绝不贴两遍。
// 批次键与进度卡 groupBatches 同口径（batchId，没有的用任务 id）。
const placingBatches = new Set();
async function earlyPlace(key, dry) {
  const tasks = genTasks.filter((t) => (t.batchId || t.id) === key);
  if (!tasks.length) { olog('⏩ 提前贴回：这批任务已不在进度卡里', 'err'); return { ok: false, error: '这批任务已不在进度卡里' }; }
  if (placingBatches.has(key)) { olog('⏩ 这批正在贴回中，稍等再点', 'err'); return { ok: false, error: '这批正在贴回中' }; }
  const ready = tasks.filter((t) => t.status === 'done' && t.file && !t.noPlace);
  if (!ready.length) { olog('⏩ 提前贴回：这批还没有生成好的图', 'err'); return { ok: false, error: '这批还没有生成好的图' }; }
  const running = tasks.filter((t) => t.status === 'running').length;
  // 先立旗再贴：立旗是同步的，跑图收尾的自动贴回不管什么时候到，看到旗就让开
  tasks.forEach((t) => { t.holdPlace = true; });
  broadcastTasks();
  if (dry) return { ok: true, dry: true, placed: 0, ready: ready.length, running, paths: ready.map((t) => t.file) };
  placingBatches.add(key);
  try {
    // 按文档分组贴（批处理一批横跨多个文档；单文档就是一组）
    const byDoc = new Map();
    for (const t of ready) { const k = String(t.docId || ''); if (!byDoc.has(k)) byDoc.set(k, []); byDoc.get(k).push(t); }
    let placed = 0, lastErr = '', notes = [];
    for (const g of byDoc.values()) {
      const pr = await placeWithRetry('placeBatch', { paths: g.map((t) => t.file), docId: g[0].docId || null, selection: g[0].selection || null, antiMode: g[0].antiMode || 0, group: true }, 0);
      if (pr.ok) { g.forEach((t) => { t.status = 'placed'; }); placed += g.length; broadcastTasks(); }
      else lastErr = pr.error || '';
      const note = pr.result && pr.result.note;
      if (note) { notes.push(note); try { ctx.dlog('[early-place] ' + note); } catch (e) {} }
    }
    const tail = (running ? ' · 本批剩余 ' + running + ' 张完成后不再自动贴回，进度卡点图可手动贴' : '') + (notes.length ? ' · ' + notes.join(' / ') : '');
    if (placed === ready.length) olog('⏩ 提前贴回 ' + placed + ' 张 完成' + tail, 'ok');
    else olog('⏩ 提前贴回：' + placed + '/' + ready.length + ' 张贴回，失败：' + lastErr + '（没贴上的仍在进度卡，点图可手动贴回）' + tail, 'err');
    return { ok: placed > 0, error: placed > 0 ? undefined : lastErr, placed, ready: ready.length, running };
  } finally { placingBatches.delete(key); }
}
ipcMain.handle('early-place', (_e, p) => earlyPlace(p && p.batchId, !!(p && p.dry && TEST_MODE)));

// 批处理并发版（云端渠道）：先逐张采集（PS只能一张张激活，但采集是秒级），
// 然后全部请求同时进队并发跑图（省时的关键——云端接口一张张排队纯浪费），
// 最后逐张贴回（PS端修改必须串行）。中途关开关=不再发起新请求，已完成的照常贴回。
async function runBatchAllDocs(params, count, docs) {
  const perDoc = Math.max(1, Math.min(100, Number(count) || 1));
  params.prompt = applyPromptControls(params.prompt);   // 滑块/填空值织入最终提示词
  const antiMode = Number(params.antiMode) || 0;
  olog('📚 批处理开始：共' + docs.length + '张图 —— 先逐张采集，再全部同时进队跑图；期间请勿操作PS', 'ok');
  if (ctx.warnIfBridgeDown) ctx.warnIfBridgeDown('批处理');   // 0908：桥接没连上每批都要在日志里说
  if (params.chartOn) olog('[色卡] 批处理模式暂不支持色卡校准，本批按普通模式跑', 'err');
  if (antiMode > 0) olog('[抗截断] 模式' + antiMode + '（' + (antiMode === 1 ? '翻转' : antiMode === 2 ? '色相' : '色相+翻转') + '）已启用');

  // ---- 阶段1：逐张采集输入（激活文档→读选区→截图） ----
  const jobs = [];
  for (let i = 0; i < docs.length; i++) {
    if (config.gen.batchAll !== '1') { olog('📚 批处理开关已关闭，停止采集'); break; }
    const d = docs[i];
    const cap = await sendToPSAwait({ action: 'captureInput', params: { antiMode, fullIfNoSel: !!config.gen.noSelFull, docId: d.id } }, 30000).catch(() => ({ ok: false, error: '采集异常' }));
    const psCtx = (cap && cap.ok && cap.result) || null;
    if (!psCtx || !psCtx.selection || !psCtx.image) {
      const why = !psCtx ? (cap.error || '采集失败')
        : (!psCtx.selection ? '没有选区（设置里可开"无选区默认跑全图"）' : ('截图失败' + (psCtx.note ? '：' + psCtx.note : '')));
      olog('📚 跳过「' + d.name + '」：' + why, 'err');
      continue;
    }
    // 选区截图落盘，进度卡显示"本次输入"缩略图
    try {
      const dir = genDir(); fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, 'input_' + uniq() + '_' + d.id + '.jpg');
      fs.writeFileSync(f, Buffer.from(psCtx.image, 'base64'));
      psCtx.inputFile = f;
      psCtx.inputThumb = thumbOf(f);
    } catch {}
    const full = !!(psCtx.selection && psCtx.fullMode);
    const rr = effRatio(params.ratio, psCtx.selection, full);   // 每张图各自的选区/画布→各自吸附（无选区那张跟它自己的原图）
    jobs.push({ doc: d, psCtx, tasks: [], params: Object.assign({}, params, { inputImage: psCtx.image, inputMime: psCtx.mime || 'image/jpeg', ratio: rr }) });
    olog('📚 采集 ' + (i + 1) + '/' + docs.length + '：' + d.name + ' ✓' + (rr !== (params.ratio || 'Auto') ? ' · 比例' + (params.ratio || 'Auto') + '→' + rr + (full ? '(无选区·跟原图)' : '') : ''));
  }
  if (!jobs.length) { olog('[批处理] 没有可跑的图（全部跳过）', 'err'); return { ok: false, error: '无可跑文档' }; }

  // ---- 阶段2：全部同时进队并发生成（并发池10） ----
  const rvb = resolveGen(params);
  const entries = [];
  for (const j of jobs) for (let k = 0; k < perDoc; k++) entries.push(j);
  const totalReq = entries.length;
  const batchId = 'b' + (++batchSeq);
  olog('▶ 📚 并发批次 [' + rvb.meta.label + ' / ' + (rvb.mconf ? rvb.mconf.name : rvb.model) + ' / ' + rvb.effSize + '] '
    + jobs.length + '张图 × 每张' + perDoc + ' = ' + totalReq + '个请求进队');
  let done = 0, fail = 0, cancelled = 0, idx = 0;
  // 同 runBatch：全部请求先登记成任务（开局球气泡就是 0/总数），worker 只领任务不建任务；taskOf[k] 与 entries[k] 一一对应
  const taskOf = entries.map((j) => {
    const task = {
      id: 'g' + (++genSeq), batchId, status: 'running',
      prompt: j.params.prompt, file: null, error: null,
      docId: j.psCtx.docId, selection: j.psCtx.selection,
      inputFile: j.psCtx.inputFile || null, inputThumb: j.psCtx.inputThumb || null, antiMode, hasInput: true, ts: Date.now(),
    };
    j.tasks.push(task);
    genTasks.unshift(task);
    return task;
  });
  broadcastTasks();
  const worker = async () => {
    while (idx < entries.length) {
      const k = idx++;
      const j = entries[k];
      const task = taskOf[k];
      if (config.gen.batchAll !== '1') {
        // 开关已关：不再发起，把预登记的占位任务撤掉（否则球气泡永远转不完）
        cancelled++;
        const gi = genTasks.indexOf(task); if (gi >= 0) genTasks.splice(gi, 1);
        const ji = j.tasks.indexOf(task); if (ji >= 0) j.tasks.splice(ji, 1);
        broadcastTasks();
        continue;
      }
      const r = await generateOne(j.params);
      if (r.ok) {
        task.status = 'done'; task.file = r.file; { const pv = previewsOf(r.file); task.thumb = pv.thumb; task.mid = pv.mid; } done++;
        olog('✓ [' + j.doc.name + '] 完成（总进度 ' + (done + fail) + '/' + totalReq + '）');
        ratioWarn(r.file, j.params.ratio, '[' + j.doc.name + '] ');
      } else {
        task.status = /安全过滤|截断|SAFETY|RECITATION/.test(r.error || '') ? 'blocked' : 'error';
        task.error = ctx.humanizeErr(r.error); fail++;   // 进度卡显示人话报错
        olog('✗ [' + j.doc.name + '] ' + (task.status === 'blocked' ? '截断' : '失败') + ': ' + (r.error || '').slice(0, 120), 'err');
      }
      broadcastTasks();
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, totalReq) }, worker));
  if (cancelled) olog('📚 批处理开关已关闭：' + cancelled + '个请求未发起');

  // ---- 阶段3：逐文档贴回（PS端必须串行；自动回传失败不丢结果，进度卡可手动贴） ----
  let okDocs = 0;
  if (config.gen.autoReturn === false) olog('⬇ 自动回传已关闭：本批图已生成未贴回——进度卡点图可手动贴回；生图模式卡右上角「回传」按钮可重新打开', 'err');
  placingBatches.add(batchId);   // 贴回期间拒绝同批「提前贴回」
  try {
    for (const j of jobs) {
      // noPlace=进度卡里删了=不贴回（0909）；holdPlace=点过「提前贴回」=后完成的留着手点（0916）
      const dts = j.tasks.filter((t) => t.status === 'done' && t.file && !t.noPlace && !t.holdPlace);
      if (config.gen.autoReturn === false || !dts.length) continue;
      const pr = await placeWithRetry('placeBatch', { paths: dts.map((t) => t.file), docId: j.psCtx.docId, selection: j.psCtx.selection, antiMode, group: true }, 0);   // 0905:回传不限时
      if (pr.ok) { dts.forEach((t) => { t.status = 'placed'; }); okDocs++; broadcastTasks(); }
      const note = pr.result && pr.result.note;
      if (note) { try { ctx.dlog('[place] ' + j.doc.name + ' ' + note); } catch (e) {} }   // 0905：note落盘（智能对象冤案=note只进内存没人看见）
      olog((pr.ok ? '⬇ [' + j.doc.name + '] 回图 ' + dts.length + '张 完成' : '⬇ [' + j.doc.name + '] 回图失败: ' + (pr.error || '') + '（图已保留在进度卡，点图可手动贴回）') + (note ? ' · ' + note : ''), pr.ok ? 'ok' : 'err');
    }
  } finally { placingBatches.delete(batchId); }
  olog('📚 批处理完成：' + okDocs + '/' + jobs.length + ' 张图已回贴，生成 ' + done + ' 成 ' + fail + ' 败', okDocs ? 'ok' : 'err');

  // 计费口径不变：按实际发出的请求次数计（开关关掉未发起的不算）
  const billed = totalReq - cancelled;
  let costTotal = null;
  if (rvb.cost != null && billed > 0) {
    costTotal = Math.round(rvb.cost * billed * 100) / 100;   // 0915：金额只进广播不进日志（理由同上）
  }
  broadcast('billing', { provider: rvb.prov, cost: costTotal, currency: rvb.meta.currency });
  return { ok: true, docs: jobs.length, okDocs, done, fail };
}

// 缓存文件夹管理
ipcMain.handle('cache-info', () => genDir());
// 0911 用户要求：设置卡里自定义缓存文件夹（生图结果与进度卡共用 genDir）。选中后 set-config 写 cacheDir，genDir() 即时切换；
// 已有的任务记录仍指向旧路径文件（不搬迁，进度卡照常能贴回旧图）
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: '选择生图缓存文件夹' });
  if (ctx.assertTopmost) ctx.assertTopmost('文件夹对话框收场');   // 无父对话框会剥置顶带（坑61家族）
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const p = r.filePaths[0];
  try { fs.mkdirSync(p, { recursive: true }); fs.accessSync(p, fs.constants.W_OK); } catch (e) { return { ok: false, error: '文件夹不可写: ' + (e.message || e) }; }
  return { ok: true, path: p };
});
ipcMain.handle('open-cache', () => {
  const dir = genDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return require('electron').shell.openPath(dir);
});
// 清除缓存图片：删除缓存目录里橙子自己写的文件，并清空任务列表（缩略图随文件失效）
// ⚠0911 缓存夹可自选后，"目录里全删"就会删掉用户自己的东西（选了桌面=桌面清空）——只删已知前缀（坑91），子目录/别的文件一律不碰
const CACHE_OWN = /^(gen|input|ref|forge|comfy)_/i;
ipcMain.handle('clear-cache', () => {
  const dir = genDir();
  let count = 0, kept = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (!CACHE_OWN.test(f) || fs.statSync(p).isDirectory()) { kept++; continue; }
        fs.unlinkSync(p); count++;
      } catch {}
    }
  } catch {}
  genTasks.length = 0;
  broadcastTasks();
  config.gen.refs = [];   // 缓存文件已删，参考图引用同步清空（参考图卡经gen-vars刷新）
  saveConfig();
  broadcast('gen-vars', config.gen);
  olog('🧹 已清除缓存图片 ' + count + ' 个' + (kept ? '（文件夹里另 ' + kept + ' 项不是橙子写的，原样保留）' : ''));
  return { ok: true, count };
});

// 选择参考图（系统文件对话框）
ipcMain.handle('pick-images', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// 通用文件选择器（ComfyUI 参考图等）
ipcMain.handle('pick-files', async (_e, opts) => {
  const { multi, filters } = opts || {};
  const r = await dialog.showOpenDialog({
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

// 读取图片缩略图（ComfyUI 参考图预览）
ipcMain.handle('read-image-thumb', async (_e, { path, size }) => {
  const s = Number(size) || 120;
  const img = nativeImage.createFromPath(path);
  if (img.isEmpty()) return null;
  const { width, height } = img.getSize();
  const scale = Math.min(s / width, s / height, 1);
  const thumb = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale) });
  return thumb.toDataURL();
});

// 抓取PS选区作为参考图（替代文件对话框）
ipcMain.handle('capture-ref', async () => {
  const cap = await sendToPSAwait({ action: 'captureInput', params: {} }, 25000);
  if (!cap.ok) return { ok: false, error: cap.error };
  const res = cap.result || {};
  if (!res.image) return { ok: false, error: (res.note || '未检测到选区——请先在PS里框选') };
  try {
    const dir = genDir();
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'ref_' + uniq() + '.jpg');
    fs.writeFileSync(f, Buffer.from(res.image, 'base64'));
    return { ok: true, file: f };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

ctx.runBatch = runBatch;
ctx.resolveGen = resolveGen;
ctx.getArmedId = () => armedId;   // 关卡回收要避开武装中的卡（总控生成向隐藏窗收负载）
// 融合卡「翻页即武装」：翻到有跑图能力的页自动武装（所见即所跑）；无能力的页不动武装
ctx.tryArm = (id) => {
  if (!ARMED_LABELS[id] || armedId === id) return;
  armedId = id;
  broadcastArmed();
  olog('◈ 武装切换 → ' + ARMED_LABELS[id] + '（融合翻页）');
};
