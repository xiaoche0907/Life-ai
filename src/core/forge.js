// Forge（SD WebUI Forge 本地API）：连接/资源拉取/img2img/预设/词条注入
const { app, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const config = ctx.config;
const olog = (m, t) => ctx.olog(m, t);
const dlog = (m) => ctx.dlog(m);
const broadcast = (c, p) => ctx.broadcast(c, p);
const sendToPSAwait = (cmd, t) => ctx.sendToPSAwait(cmd, t);
const genDir = () => ctx.genDir();

// 预设存文档目录（卸载重装不丢）；首次从内置factory_forge_presets复制
const forgeDir = () => path.join(app.getPath('documents'), '橙子', 'forge-presets');
let forgeAbort = null;

async function forgeFetch(base, p, opt, timeoutMs) {
  const url = base.replace(/\/+$/, '') + p;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opt || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---------- 自动修图用的 Forge 通道（0918）----------
// 与 PS 那条链的区别：输入图不是 PS 选区截图，而是调用方给的 base64（自动修图在内存里跑的图），
// 输出也不贴回 PS，而是落盘返回文件路径交给自动修图装 PSD。
// 尺寸口径：**原图多大就多大跑**（用户裁定：不设"长边像素"档位，也不设内部上限）。
// 只做一件事——对齐到 8 的倍数，这是 SD 的硬要求（尺寸不是8的倍数会直接报错）。
// ⚠ 超大图（几千像素）会显著吃显存并拖慢，是用户自己的选择；真要提速应在源文件夹里先出小图。
function fitForgeWH(sw, sh) {
  return { W: Math.max(64, Math.round(sw / 8) * 8), H: Math.max(64, Math.round(sh / 8) * 8) };
}
// p: { image(base64), prompt, negPrompt, steps, cfg, denoise, sampler, scheduler, model, lora, loraWeight, cnEnabled, cnModule, cnModel, cnWeight, seed, timeoutMs }
async function forgeGenerate(p) {
  const base = ((p && p.url) || config.forge.url || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置 Forge 地址（Forge 卡 → 设置）' };
  let size;
  try { size = nativeImage.createFromBuffer(Buffer.from(p.image, 'base64')).getSize(); } catch (e) { return { ok: false, error: '输入图解码失败: ' + (e.message || e) }; }
  if (!size || !size.width) return { ok: false, error: '输入图解码失败（尺寸为空）' };
  const { W, H } = fitForgeWH(size.width, size.height);
  // LoRA 以 WebUI 语法挂在正向词尾（与 Forge 卡完全同源）
  let prompt = p.prompt || '';
  if (p.lora) prompt += ' <lora:' + p.lora + ':' + (parseFloat(p.loraWeight) || 1) + '>';
  if (p.model) {
    try {
      await forgeFetch(base, '/sdapi/v1/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sd_model_checkpoint: p.model }),
      }, 120000);
    } catch (e) { olog('[自动修图→Forge] 模型切换失败(继续用当前): ' + e.message, 'err'); }
  }
  const payload = {
    init_images: ['data:image/png;base64,' + p.image],
    prompt, negative_prompt: p.negPrompt || '',
    steps: parseInt(p.steps, 10) || 20, cfg_scale: parseFloat(p.cfg) || 7,
    denoising_strength: p.denoise != null ? parseFloat(p.denoise) : 0.35,
    width: W, height: H,
    sampler_name: p.sampler || 'Euler a',
    batch_size: 1,
    seed: (p.seed !== undefined && p.seed !== null) ? p.seed : -1,
  };
  if (p.scheduler && p.scheduler !== '' && p.scheduler !== 'Automatic' && p.scheduler !== 'automatic') payload.scheduler = p.scheduler;
  if (p.cnEnabled) {
    const cn = { enabled: true, module: p.cnModule || undefined, model: p.cnModel || undefined,
      weight: Number(p.cnWeight) || 1, guidance_start: 0, guidance_end: 1, pixel_perfect: true, control_mode: 0, resize_mode: 1 };
    payload.controlnet_units = [cn];
    payload.alwayson_scripts = { ControlNet: { args: [cn] } };
  }
  if (ctx.dlog) ctx.dlog('[autofix→forge] img2img ' + W + 'x' + H + ' steps=' + payload.steps + ' denoise=' + payload.denoising_strength + ' lora=' + (p.lora || '-'));
  const ctrl = new AbortController();
  const tmo = setTimeout(() => ctrl.abort(), Number(p.timeoutMs) > 0 ? Number(p.timeoutMs) : 600000);
  try {
    const resp = await fetch(base + '/sdapi/v1/img2img', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      // ⚠body必须UTF-8字节（0907铁律）：提示词含中文时裸字符串会被fetch当ByteString抛错
      body: Buffer.from(JSON.stringify(payload), 'utf8'), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data.images || !data.images.length) throw new Error('API未返回图片');
    let b64 = data.images[0];
    if (b64.indexOf(',') !== -1) b64 = b64.split(',')[1];
    const dir = genDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'forge_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '_0.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return { ok: true, file };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '超时/已中断' : (e.message || String(e));
    return { ok: false, error: msg };
  } finally { clearTimeout(tmo); }
}
ctx.forgeGenerate = forgeGenerate;   // 自动修图工序调用（不贴 PS，只出文件）

ipcMain.handle('forge-test', async (_e, { url }) => {
  try {
    const j = await forgeFetch(url, '/sdapi/v1/options', {}, 10000);
    return { ok: true, model: j.sd_model_checkpoint || '未知' };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// 一次拉全资源：模型/采样器/LoRA/CN预处理器/CN模型
ipcMain.handle('forge-resources', async (_e, { url }) => {
  const out = {};
  // 先刷新服务端索引：WebUI只在启动时扫盘，之后新放进models目录的文件不刷新API就查不到
  try { await forgeFetch(url, '/sdapi/v1/refresh-loras', { method: 'POST' }, 60000); } catch {}
  try { await forgeFetch(url, '/sdapi/v1/refresh-checkpoints', { method: 'POST' }, 60000); } catch {}
  const jobs = [
    ['models', '/sdapi/v1/sd-models', (j) => j.map((m) => ({ value: m.title || m.model_name, name: m.model_name || m.title }))],
    ['samplers', '/sdapi/v1/samplers', (j) => j.map((s) => s.name)],
    // loras冷启动要全盘扫metadata，量大时远超15s——放宽到60s，失败也别静默成空列表
    ['loras', '/sdapi/v1/loras', (j) => j.map((l) => l.name || l.alias).filter(Boolean), 60000],
    ['cnModules', '/controlnet/module_list', (j) => j.module_list || []],
    ['cnModels', '/controlnet/model_list', (j) => j.model_list || []],
  ];
  for (const [key, p, map, tmo] of jobs) {
    try { out[key] = map(await forgeFetch(url, p, {}, tmo || 15000)); }
    catch (e) { out[key] = []; olog('[Forge] 资源拉取失败 ' + p + ': ' + (e.message || e), 'err'); }
  }
  return out;
});

// img2img：选区截图(桥接件)→Forge→贴回PS原选区（老插件工作流完整复刻）
ipcMain.handle('forge-img2img', async (_e, p) => {
  const base = (p.url || '').replace(/\/+$/, '');
  if (!base) return { ok: false, error: '未配置Forge地址' };
  // 批处理已采好（0918）：主进程逐图循环里先采集一次塞进 window.__batchCtx，卡内链路据此跳过重复采集
  const pre = p.psCtx && p.psCtx.selection && p.psCtx.image ? p.psCtx : null;
  if (!pre) olog('[Forge] 抓取选区…');
  if (ctx.warnIfBridgeDown) ctx.warnIfBridgeDown('Forge');   // 0908：桥接没连上每次都要在日志里说
  // docId：批处理逐图跑时指定目标文档（桥接件v29+会先激活它再读选区）
  // fullIfNoSel：0918 用户裁定——Forge 不再套用"无选区跑全图"兜底：批处理里没框选区的图直接跳过
  //（在 gen.js 的 runBatchForCards 里已拦掉），单张跑时也如实报"没有选区"而不是整张重绘。
  const cap = pre ? { ok: true, result: pre }
    : await sendToPSAwait({ action: 'captureInput', params: { antiMode: 0, docId: p.docId != null ? p.docId : undefined, fullIfNoSel: false } }, 30000);
  const pctx = (cap.ok && cap.result) || {};
  try {
    fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [forge] capture: ok=' + cap.ok
      + ' err=' + (cap.error || '') + ' sel=' + !!pctx.selection + ' img=' + !!pctx.image
      + ' note=' + (pctx.note || '') + ' 预采=' + !!pre + ' 桥接版本=' + ctx.bridgeVer() + '\n');
  } catch {}
  // 失败三分法：桥接失败(未连接/超时)≠没选区≠截图失败——混成一句会把环境问题误报成操作问题
  if (!cap.ok) {
    olog('[Forge] 抓取失败: ' + (cap.error || '未知错误'), 'err');
    return { ok: false, error: cap.error || '抓取失败' };
  }
  // 0918：没有选区就是不跑（用户裁定），中文说清是哪张图的问题
  if (!pctx.selection) {
    olog('[Forge] 没有选区——请先在PS里框选要处理的区域（批处理模式只跑框选了区域的图）', 'err');
    return { ok: false, error: '没有选区（未框选区域，不执行）' };
  }
  if (!pctx.image) {
    olog('[Forge] 选区截图失败: ' + (pctx.note || '未知原因'), 'err');
    return { ok: false, error: pctx.note || '选区截图失败' };
  }
  // 分辨率计算：有选区→按选区尺寸 + 目标长边等比缩放（老插件口径"目标长边+等比缩放"）
  let W, H;
  {
    const selW = pctx.selection.right - pctx.selection.left, selH = pctx.selection.bottom - pctx.selection.top;
    const longEdge = Math.max(1, Math.max(selW, selH));
    const targetLong = parseInt(p.resolution, 10) || 768;
    const scale = targetLong / longEdge;
    W = Math.max(64, Math.round(selW * scale)); H = Math.max(64, Math.round(selH * scale));
  }

  // 可选切模型
  if (p.model) {
    try {
      olog('[Forge] 切换模型: ' + p.model);
      await forgeFetch(base, '/sdapi/v1/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sd_model_checkpoint: p.model }),
      }, 120000);
    } catch (e) { olog('[Forge] 模型切换失败(继续用当前): ' + e.message, 'err'); }
  }

  const payload = {
    init_images: ['data:image/png;base64,' + pctx.image],
    prompt: p.prompt || '', negative_prompt: p.negPrompt || '',
    steps: p.steps || 20, cfg_scale: p.cfg || 7,
    denoising_strength: p.denoise != null ? p.denoise : 0.35,
    width: W, height: H,
    sampler_name: p.sampler || 'Euler a',
    batch_size: p.batchSize || 1,
    seed: (p.seed !== undefined && p.seed !== null) ? p.seed : -1,
  };
  if (p.scheduler && p.scheduler !== '' && p.scheduler !== 'Automatic') payload.scheduler = p.scheduler;
  if (p.cnEnabled) {
    const cn = { enabled: true, module: p.cnModule || undefined, model: p.cnModel || undefined,
      weight: Number(p.cnWeight) || 1, guidance_start: 0, guidance_end: 1, pixel_perfect: true, control_mode: 0, resize_mode: 1 };
    payload.controlnet_units = [cn];
    payload.alwayson_scripts = { ControlNet: { args: [cn] } };
    olog('[Forge] ControlNet: ' + (p.cnModel || 'none') + ' weight=' + cn.weight);
  }

  olog('▶ [Forge] img2img ' + W + '×' + H + ' ×' + payload.batch_size);
  forgeAbort = new AbortController();
  // 进度轮询→广播
  const timer = setInterval(async () => {
    try {
      const pd = await forgeFetch(base, '/sdapi/v1/progress', {}, 5000);
      broadcast('forge-progress', { progress: pd.progress || 0 });
    } catch {}
  }, 1000);
  try {
    const ctrl = forgeAbort;
    const resp = await fetch(base + '/sdapi/v1/img2img', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      // ⚠body必须UTF-8字节（0907铁律，与gen/chat/autofix同源）：提示词含中文时裸字符串会被fetch当ByteString抛错
      body: Buffer.from(JSON.stringify(payload), 'utf8'), signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data.images || !data.images.length) throw new Error('API未返回图片');
    // 落盘 → 桥接件placeBatch贴回原选区（打组/蒙版走现成链路）
    const dir = genDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < data.images.length; i++) {
      let b64 = data.images[i];
      if (b64.indexOf(',') !== -1) b64 = b64.split(',')[1];
      const f = path.join(dir, 'forge_' + Date.now() + '_' + i + '.png');
      fs.writeFileSync(f, Buffer.from(b64, 'base64'));
      files.push(f);
    }
    const pr = await ctx.placeWithRetry('placeBatch', { paths: files, docId: pctx.docId || null, selection: pctx.selection || null, antiMode: 0, group: true }, 180000);   // 0909：贴回带重试（PS 正忙瞬时失败）
    olog(pr.ok ? '✓ [Forge] 完成，贴回 ' + files.length + ' 张' : '[Forge] 贴回失败: ' + (pr.error || '') + '（图已落盘：' + dir + '）', pr.ok ? 'ok' : 'err');
    return { ok: true, count: files.length };
  } catch (e) {
    const msg = e.name === 'AbortError' ? '已中断' : (e.message || String(e));
    olog('[Forge] ' + msg, 'err');
    return { ok: false, error: msg };
  } finally {
    clearInterval(timer);
    forgeAbort = null;
    broadcast('forge-progress', { progress: 1, done: true });
  }
});
ipcMain.on('forge-interrupt', async (_e, { url }) => {
  try { if (forgeAbort) forgeAbort.abort(); } catch {}
  try { await forgeFetch(url, '/sdapi/v1/interrupt', { method: 'POST' }, 5000); } catch {}
});

// Forge预设：文档目录一预设一json；工厂集缺哪个补哪个；同步进提示词库F分组
// 2026-08-29：旧工厂集(ff_*/og_*)全部下架（用户裁定）；同日晚间内置4个橙CG修脸Forge预设（用户裁定）
// 白名单=内置工厂文件名，不在名单且非user_*的json在两处目录一律清除（用户自存的user_*.json永不动）
// ⚠️内置预设id不得以ff_/og_开头——下方F词条清理正则会把它们的词条连收藏一起周期性清掉
const FACTORY_KEEP = [
  '001_cg_face_g2_mid.json',
  '002_cg_face_g2_full.json',
  '003_cg_face_g1_mid.json',
  '004_cg_face_g1_full.json',
  // 0905内置扩编（桌面橙CG修脸成品包收编；id已按铁律去ff_前缀改ocg_*）
  '005_natural_face_x1.json',
  '006_hair_layers.json',
  '007_chest_boost.json',
  '008_cg_face_g3_mid.json',
  '009_cg_face_g3_full.json',
];
function purgeLegacyFactory(dir, isDocs) {
  // 0907修（用户实测惨案）：旧写法"不在白名单且非user_就删"会把用户拖进文件夹的预设当垃圾清掉——
  // 拖入→点刷新→文件被物理删除，重启也回不来。清理只许点名已知旧工厂前缀(ff_/og_)，
  // 用户的文件永远不是清理对象（哪怕名字随意、格式不对也留着不动）。
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      if (FACTORY_KEEP.includes(f)) continue;
      if (/^(ff|og)_/i.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    }
  } catch {}
}
function forgeLoadPresets() {
  const dir = forgeDir();
  fs.mkdirSync(dir, { recursive: true });
  const factory = path.join(ctx.SRC, 'factory_forge_presets');
  purgeLegacyFactory(factory, false);   // 源目录里的老乱码文件一并清
  purgeLegacyFactory(dir, true);
  // 工厂集同步：内置版无条件覆盖下发（工厂预设跟随软件版本；用户改动只存在user_*文件里不受影响）
  try {
    for (const f of fs.readdirSync(factory)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(factory, f), path.join(dir, f));
    }
  } catch {}
  const out = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j && j.name && j.data) { j._fileName = f; out.push(j); }
    } catch {}
  }
  // 同步进提示词库「F」分组：F词条=整预设入口（presetName映射回预设），内容跟随预设文件刷新
  try {
    const lib = ctx.plibLoad();
    if (!lib.groups.find((g) => g.id === 'forge')) lib.groups.push({ id: 'forge', name: 'Forge', icon: 'forgeF' });
    // 已下架工厂预设(ff_*/og_*)对应的F词条连文带名清掉（里面还存着下架预设的原文）
    lib.prompts = lib.prompts.filter((p) => !(p.group === 'forge' && /^forge_(ff|og)_/.test(p.id || '')));
    let added = 0;
    for (const fp of out) {
      const pid = 'forge_' + (fp.id || fp.name);
      const existing = lib.prompts.find((x) => x.id === pid);
      if (existing) {
        existing.text = (fp.data && fp.data.positivePrompt) || '';
        existing.presetName = fp.name;
        existing.name = fp.displayName || fp.name;   // 预设改名要跟着刷（否则F词条永远显示旧名）
        existing.forge = true;
      } else {
        lib.prompts.push({
          id: pid, name: fp.displayName || fp.name,
          text: (fp.data && fp.data.positivePrompt) || '',
          group: 'forge', fav: false, forge: true, presetName: fp.name, ts: Date.now() + added,
        });
        added++;
      }
    }
    ctx.plibSave();
    broadcast('plib-changed', lib);
  } catch {}
  return out;
}
// F词条填入Forge正向框：主进程直达注入（不走广播——广播会与"自动弹卡"的窗口加载竞态丢值）
async function doForgeFillPos(text) {
  const w = ctx.openCard('forge');   // 没开则建窗，开着则show+focus
  if (!w) { dlog('[fill] openCard返回空'); return { ok: false, error: '无法打开Forge卡' }; }
  ctx.broadcastOpenStates();
  // 重试探测__setForgePos就绪（新窗加载/脚本求值需要时间），最多2秒
  let ready = false;
  for (let i = 0; i < 10; i++) {
    try { ready = await w.webContents.executeJavaScript('!!window.__setForgePos'); } catch (e) { dlog('[fill] 探测异常#' + i + ': ' + (e.message || e)); }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) {
    dlog('[fill] 2秒内__setForgePos未就绪(疑forge.html脚本报错)');
    olog('[提示词库→Forge] 填入失败：Forge卡脚本未就绪', 'err');
    return { ok: false, error: 'Forge卡脚本未就绪' };
  }
  try {
    await w.webContents.executeJavaScript('window.__setForgePos(' + JSON.stringify(String(text || '')) + ')');
    dlog('[fill] 注入成功 len=' + String(text || '').length);
    olog('[提示词库→Forge] 已填入正向提示词');
    return { ok: true };
  } catch (e) {
    dlog('[fill] 注入异常: ' + (e.message || e));
    olog('[提示词库→Forge] 注入异常: ' + (e.message || e), 'err');
    return { ok: false, error: e.message || String(e) };
  }
}
ipcMain.handle('forge-fill-pos', (_e, text) => { dlog('[fill] 收到IPC len=' + String(text || '').length); return doForgeFillPos(text); });

// F词条=整预设应用：让Forge卡按预设名应用全部参数（模型/采样器/步数/重绘/反向词/CN…）
// 预设找不到或脚本异常时退回"只填正向提示词"
async function doForgeApply(presetName, fallbackText) {
  const w = ctx.openCard('forge');
  if (!w) return { ok: false, error: '无法打开Forge卡' };
  ctx.broadcastOpenStates();
  let res = 'notready';
  for (let i = 0; i < 12; i++) {
    try {
      res = await w.webContents.executeJavaScript(
        'window.__applyForgePreset ? window.__applyForgePreset(' + JSON.stringify(String(presetName || '')) + ') : "notready"');
    } catch (e) { res = 'err:' + (e.message || e); }
    if (res === true || res === false) break;   // true=已整套应用 false=脚本就绪但预设没找到
    await new Promise((r) => setTimeout(r, 250));
  }
  if (res === true) {
    dlog('[fill] 整预设应用成功: ' + presetName);
    olog('[提示词库→Forge] 已应用整套预设「' + presetName + '」');
    return { ok: true, mode: 'preset' };
  }
  dlog('[fill] 整预设应用失败(' + res + ') 退回只填正向词');
  return doForgeFillPos(fallbackText);
}
ipcMain.handle('forge-apply-preset', (_e, { name, text }) => { dlog('[fill] IPC applyPreset: ' + name); return doForgeApply(name, text); });

ipcMain.handle('forge-presets', () => forgeLoadPresets());
ipcMain.handle('forge-preset-save', (_e, preset) => {
  try {
    const dir = forgeDir();
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(preset.name || 'preset').replace(/[<>:"/\\|?*]/g, '_').slice(0, 50);
    fs.writeFileSync(path.join(dir, 'user_' + safe + '.json'), JSON.stringify(preset, null, 2));
    return { ok: true, presets: forgeLoadPresets() };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});
ipcMain.handle('forge-open-folder', () => {
  const dir = forgeDir();
  fs.mkdirSync(dir, { recursive: true });
  return require('electron').shell.openPath(dir);
});

// （有道翻译功能已于2026-08-28整体移除——泄露的第三方key不再使用）

ctx.doForgeFillPos = doForgeFillPos;
ctx.forgeLoadPresets = forgeLoadPresets;   // 提示词搬运复制完Forge预设后刷新F词条
