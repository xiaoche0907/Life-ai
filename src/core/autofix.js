// 自动修图（0905定稿）：源文件夹批量 → 工序流水线（每道:生成N张候选→打组命名+白蒙版→盖印→下道）
// → 分层PSD落输出文件夹。修图师手工流程的引擎级复刻：
//   盖印④(最终) / 组「④…」(N层+白蒙版) / 盖印③ / … / 组「①…」 / 原图
// v1覆盖「全图」部位（检测式部位=v1.5接YuNet/人体解析）；PSD由ag-psd纯Node写出，不依赖PS。
// mock模式（测试用，零API消耗）：生成一律用本地反色代替。
const { ipcMain, dialog, nativeImage, powerSaveBlocker } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const config = ctx.config;
const olog = (m, t) => ctx.olog(m, t);
const broadcast = (c, p) => ctx.broadcast(c, p);

let running = false;
let stopFlag = false;
let stopResolve = null;   // 停止即时响应：唤醒所有卡在Promise.race里的等待，不等在途请求跑完

// ---------- 跑批收尾（0906）：防睡眠 + 全部完成后自动关机 ----------
// 防睡眠=系统级阻止休眠（屏幕照常可关，跑批不需要亮屏）；跑批期间持有，结束/停止必释放
let awakeId = null;
function awakeOn() {
  try { if (awakeId == null) awakeId = powerSaveBlocker.start('prevent-app-suspension'); } catch (e) {}
}
function awakeOff() {
  try { if (awakeId != null && powerSaveBlocker.isStarted(awakeId)) powerSaveBlocker.stop(awakeId); } catch (e) {}
  awakeId = null;
}
// 关机规矩（用户裁定）：只在"整批自然跑完"触发，手动停止/熔断不触发；60秒倒计时可取消；
// 开关不落盘（每次启动归零，防止忘关半夜关机）
const SHUT_DELAY = 60;
let shutDeadline = null;
function scheduleShutdown() {
  if (process.platform !== 'win32') { olog('🛠️ [自动修图] 自动关机仅支持Windows', 'err'); return; }
  execFile('shutdown', ['/s', '/t', String(SHUT_DELAY), '/c', '橙AIper 自动修图已全部完成，' + SHUT_DELAY + '秒后关机（可在自动修图卡取消）'], { windowsHide: true }, (e) => {
    if (e) { olog('🛠️ [自动修图] 关机指令失败: ' + (e.message || e), 'err'); return; }
    shutDeadline = Date.now() + SHUT_DELAY * 1000;
    olog('⏻ [自动修图] 全部完成，' + SHUT_DELAY + '秒后自动关机——点卡上「取消关机」可撤销', 'err');
    broadcast('autofix-shutdown', { deadline: shutDeadline });
  });
}
ipcMain.on('autofix-shutdown-cancel', () => {
  execFile('shutdown', ['/a'], { windowsHide: true }, () => {});
  shutDeadline = null;
  olog('⏻ [自动修图] 已取消自动关机', 'ok');
  broadcast('autofix-shutdown', { deadline: null });
});
ipcMain.handle('autofix-shutdown-status', () => ({ deadline: shutDeadline }));

const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
// 按预设名找 Forge 预设（0918）：自动修图的 Forge 工序用预设名当"模型"字段存。
// ctx.forgeLoadPresets 会先做工厂集同步（跟软件版本走），不自己读文件=不会拿到过期预设。
function forgePresetBy(name) {
  try {
    const list = (ctx.forgeLoadPresets && ctx.forgeLoadPresets()) || [];
    const want = String(name || '').trim();
    return list.find((p) => p.name === want || p.displayName === want) || null;
  } catch (e) { return null; }
}
function scanDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => EXTS.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(dir, f));
  } catch (e) { return []; }
}

ipcMain.handle('autofix-pick-dir', async (_e, kind) => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: kind === 'out' ? '选择成品PSD输出文件夹' : '选择原图文件夹' });
  if (ctx.assertTopmost) ctx.assertTopmost('文件夹对话框收场');   // 无父对话框会剥置顶带（坑61家族）
  if (r.canceled || !r.filePaths.length) return { ok: false };
  const dir = r.filePaths[0];
  return { ok: true, dir, count: kind === 'out' ? 0 : scanDir(dir).length };
});
ipcMain.handle('autofix-scan', (_e, dir) => ({ count: scanDir(dir || '').length }));

// BGRA(nativeImage.toBitmap) → RGBA ImageData（ag-psd口径）
function toImageData(img) {
  const sz = img.getSize();
  const b = img.toBitmap();
  const d = new Uint8ClampedArray(b.length);
  for (let i = 0; i < b.length; i += 4) {
    d[i] = b[i + 2]; d[i + 1] = b[i + 1]; d[i + 2] = b[i]; d[i + 3] = 255;   // alpha钉255：jpg链路无透明
  }
  return { width: sz.width, height: sz.height, data: d };
}
function whiteMask(w, h) {
  const d = new Uint8ClampedArray(w * h * 4);
  d.fill(255);
  return { width: w, height: h, data: d };
}
// 「跟原图」比例：把原图宽高就近吸附到API支持的比例枚举（对数空间最近邻，横竖对称）
const { nearestRatio } = require('./eff-ratio');
ctx.nearestRatio = nearestRatio;   // 生图链路「Auto=跟选区/跟原图」同用（core/eff-ratio.js）

// ---------- v2 检测式部位：识图大模型定框（用户定稿：拆pico，真人二次元一条链路） ----------
// 一图一次调用：压到1024边长发给所选对话模型（省token），按语义定义返回各部位紧贴框(0-1000归一化JSON)
// 正方形化由代码兜底（squarify）——香蕉1:1构图才不位移；模型只管语义不管几何
const PART_DEF_TEXT = {
  face: 'face(脸部)：从发际线上方一点点到下巴下方一点点，只框面部本身（不包含头发主体，不含脖子以下）',
  hair: 'hair(头发)：全部头发，长发要框到发梢（及腰长发框到腰部）',
  upper: 'upper(上半身)：从脖子中间到大腿根（胯部）',
  chest: 'chest(胸部)：从脖子中间到腰部中间（锁骨到腰，胸腔区域）',
  lower: 'lower(下半身)：从胯部到脚跟（完整的腿，不含腰腹）',
};
const REGION_PARTS = ['face', 'hair', 'upper', 'chest', 'lower'];
// 几何部位（0907）：竖构图专用，不走识图零成本——正方形边长=图宽W，top=贴顶框W×W，bottom=贴底框W×W。
// 横图/方图（W≥H）：该工序直接跳过不跑（用户裁定，不退化全图不花钱）
// 0908 镜像补横构图三件（用户要求）：正方形边长=图高H，left=贴左框H×H，center=以画面正中为中轴的H×H，right=贴右框H×H；
// 竖图/方图（H≥W）同样整道跳过。方图两组都跳（既非竖也非横）。
const GEO_PARTS = ['top', 'bottom', 'left', 'center', 'right'];
const GEO_TALL = ['top', 'bottom'], GEO_WIDE = ['left', 'center', 'right'];
function geoBox(part, W, H) {
  if (GEO_TALL.includes(part)) {
    if (W >= H) return null;   // 非竖构图：无定义，调用方跳过该工序
    const s = W & ~1;
    return { x: 0, y: part === 'top' ? 0 : Math.max(0, H - s), width: s, height: s };
  }
  if (H >= W) return null;     // 非横构图：无定义
  const s = H & ~1;
  const x = part === 'left' ? 0 : part === 'right' ? Math.max(0, W - s) : Math.max(0, Math.round((W - s) / 2)) & ~1;
  return { x, y: 0, width: s, height: s };
}
// 几何工序在这张图上有没有定义（竖构图部位要竖图，横构图部位要横图）
const geoDefined = (part, W, H) => GEO_TALL.includes(part) ? W < H : (GEO_WIDE.includes(part) ? W > H : true);

// 识图带重试（用户裁定）：失败自动再试2次（共3次），间隔1.5秒；仍失败由调用方跳过该图
async function detectRegions(img, parts, det) {
  let last = null;
  for (let att = 1; att <= 3; att++) {
    const r = await detectRegionsOnce(img, parts, det);
    if (r.ok) return r;
    last = r;
    if (ctx.dlog) ctx.dlog('[autofix] 识图第' + att + '次失败: ' + r.error);
    if (att < 3 && !stopFlag) await new Promise((res) => setTimeout(res, 1500));
  }
  return last;
}

async function detectRegionsOnce(img, parts, det) {
  // 0908 识图渠道改走对话渠道表 chatProviders（与生图渠道解耦）：det.provider 是对话渠道 id（aji/grs/cc_*）
  const wantProv = (det && det.provider) || config.chat.provider || 'grs';
  const cp = (config.chatProviders && config.chatProviders[wantProv]) || (config.chatProviders && config.chatProviders.grs) || {};
  const base = (cp.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(cp.key);
  const model = (det && det.model) || config.chat.model || '';
  if (!base || !key) return { ok: false, error: '识图渠道「' + (cp.label || wantProv) + '」未在对话设置里填 Key' };
  if (!model) return { ok: false, error: '未选择识图模型' };
  const kerr = ctx.keyIssue(key, cp.label || wantProv);
  if (kerr) return { ok: false, error: kerr };
  const sz = img.getSize();
  const scale = Math.max(sz.width, sz.height) > 1024 ? 1024 / Math.max(sz.width, sz.height) : 1;
  const small = scale < 1 ? img.resize({ width: Math.round(sz.width * scale), height: Math.round(sz.height * scale), quality: 'good' }) : img;
  const prompt = '请检测图中主要人物（真人或动漫角色均可）的以下部位，给出每个部位的紧贴边界框：\n'
    + parts.map((p) => '- ' + PART_DEF_TEXT[p]).join('\n')
    + '\n直接只输出一个JSON对象，不要任何思考过程、解释或代码块标记。格式：{"face":[ymin,xmin,ymax,xmax],...}\n'
    + '坐标为相对整张图的0-1000归一化整数（ymin=框上边,xmin=框左边,ymax=框下边,xmax=框右边）。图中不存在或完全出画的部位值为null。';
  const b64 = small.toJPEG(85).toString('base64');
  // 主通道：Gemini兼容generateContent；被拒→自动改道OpenAI风格/v1/chat/completions
  // （AJI的GPT/Claude系只认OpenAI端点，走Gemini兼容报"unknown provider for model"，0905实测）
  const g = await detFetch(base + '/v1beta/models/' + model + ':generateContent', key, {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: b64 } }] }],
    // 输出上限 8192（0908 由 2000 抬高）：思考型模型（gemini-3.x pro/high 等）的思考 token 计入输出额度，
    // 实测一个一行答案就烧 600~1900 token；2000 会被思考吃光→正文为空/JSON 截断（"识图返回不含JSON"）
    generationConfig: { temperature: 0.1, topP: 0.9, maxOutputTokens: 8192 },
  }, (data) => {
    const cand = data.candidates && data.candidates[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    // 0909：跳过 thought:true 思考段 + 剥 <think> 标签（思考型模型把思考排第一段时 JSON 解析必失败）
    const raw = parts.filter((x) => x && x.text != null && !x.thought).map((x) => x.text).join('');
    return ctx.cleanModelText ? ctx.cleanModelText(raw) : raw;
  });
  let txt = g.ok ? g.text : null;
  if (!txt) {
    const o = await detFetch(base + '/v1/chat/completions', key, {
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }] }],
      temperature: 0.1, max_tokens: 8192,
    }, (data) => {
      const raw = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return ctx.cleanModelText ? ctx.cleanModelText(raw) : raw;
    });
    if (o.ok) { txt = o.text; if (ctx.dlog) ctx.dlog('[autofix] 识图改道OpenAI端点成功(' + model + ')'); }
    else return { ok: false, error: g.error + '；改道OpenAI端点也失败: ' + o.error };
  }
  const mfence = txt.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (mfence) txt = mfence[1].trim();
  const js = txt.match(/\{[\s\S]*\}/);
  if (!js) return { ok: false, error: '识图返回不含JSON: ' + txt.slice(0, 80) };
  let j;
  try { j = JSON.parse(js[0]); } catch (e) { return { ok: false, error: '识图JSON解析失败: ' + txt.slice(0, 80) }; }
  // ⚠这里曾写成 prov（0908 渠道解耦时变量改名为 wantProv 漏改一处）：识图成功后当场 ReferenceError，
  // 整批在预检处崩掉=用户看到的"只检测不启动"。日志变量名必须与上面定义一致。
  if (ctx.dlog) ctx.dlog('[autofix] 识图(' + wantProv + '/' + model + ')返回 ' + js[0].replace(/\s+/g, '').slice(0, 240));
  const boxes = {};
  for (const p of parts) {
    const a = j[p];
    if (Array.isArray(a) && a.length === 4 && a.every((v) => typeof v === 'number')) {
      let [y1, x1, y2, x2] = a;
      if (y2 < y1) { const t = y1; y1 = y2; y2 = t; }
      if (x2 < x1) { const t = x1; x1 = x2; x2 = t; }
      const b = {
        x: Math.max(0, Math.round(x1 / 1000 * sz.width)),
        y: Math.max(0, Math.round(y1 / 1000 * sz.height)),
        w: Math.round((x2 - x1) / 1000 * sz.width),
        h: Math.round((y2 - y1) / 1000 * sz.height),
      };
      boxes[p] = (b.w >= 24 && b.h >= 24) ? b : null;   // 太小=垃圾框，当没检到
    } else boxes[p] = null;
  }
  return { ok: true, boxes };
}

// 识图专用请求器：单次POST+120秒超时，pickText从各端点响应里摘正文
// ⚠body必须经Buffer.from(str,'utf8')转成UTF-8字节再传fetch——JSON.stringify默认不转义中文，
// 裸字符串里含非ASCII字符(如"在"=22312)会被某些环境的fetch当ByteString转换抛
// "Cannot convert argument to a ByteString"（0907用户实测"识图预检失败"正是这条）
async function detFetch(url, key, body, pickText) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + key },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = '';
      try { const j = await resp.json(); detail = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch {}
      return { ok: false, error: 'HTTP ' + resp.status + (detail ? ' — ' + String(detail).slice(0, 100) : '') };
    }
    const data = await resp.json();
    const t = pickText(data);
    return t ? { ok: true, text: String(t).trim() } : { ok: false, error: '无文本回复' };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '超时(120秒)' : (e.message || String(e)) };
  } finally { clearTimeout(timer); }
}

// mock占位框（零消耗测几何链路，不花识图钱）：按典型人像位置摆的方框
function mockBoxes(parts, W, H) {
  const S = Math.min(W, H);
  const at = { face: [0.5, 0.22, 0.28], hair: [0.5, 0.28, 0.42], upper: [0.5, 0.5, 0.5], chest: [0.5, 0.4, 0.36], lower: [0.5, 0.78, 0.5] };   // [中心x比,中心y比,边长比]
  const boxes = {};
  for (const p of parts) {
    const a = at[p] || [0.5, 0.5, 0.5];
    const side = Math.round(S * a[2]);
    boxes[p] = { x: Math.round(W * a[0] - side / 2), y: Math.round(H * a[1] - side / 2), w: side, h: side };
  }
  return boxes;
}

// 简易并发池（0905提速）：worker串行取任务并发跑，单线程idx递增无竞态；stopFlag后不再取新任务
async function runPool(items, limit, worker) {
  let idx = 0;
  const n = Math.max(1, Math.min(limit, items.length));
  const ws = [];
  for (let i = 0; i < n; i++) {
    ws.push((async () => {
      while (idx < items.length && !stopFlag) {
        const it = items[idx++];
        await worker(it);
      }
    })());
  }
  await Promise.all(ws);
}

// 滑块/填空值织入最终提示词（正则逐字与gen.js applyPromptControls原典一致）：每道工序独立ctl
function applyCtl(text, ctl) {
  const pv = (ctl && ctl.params) || {}, bv = (ctl && ctl.blanks) || {};
  let out = String(text || '');
  out = out.replace(/(@param:([^"\s:]+?)"\s*:\s*)([-\d.]+)/g, (m, pre, name) =>
    (pv[name] != null && !/_(desc|label|note|range)$/.test(name)) ? (pre + (Math.round(pv[name] * 100) / 100)) : m);
  // 填空：已填(含显式清空='')用填写值；没碰过用默认；连默认都没有→空串
  out = out.replace(/【填空:([^=】]+?)(?:=([^】]*))?】/g, (m, name, def) =>
    (bv[name] != null) ? bv[name] : (def || ''));
  return out;
}

// 语义紧贴框→纯正方形裁剪框（用户定稿规则）：只扩不缩撑成正方形→外扩%→撞边整框内移→min(W,H)封顶→偶数化
function squarify(b, W, H, padPct) {
  if (!b) return null;
  let side = Math.max(b.w, b.h) * (1 + (Number(padPct) || 0) / 100);
  side = Math.min(Math.round(side), Math.min(W, H));
  const s = side & ~1;
  if (s < 64) return null;
  let x = Math.round(b.x + b.w / 2 - s / 2);
  let y = Math.round(b.y + b.h / 2 - s / 2);
  x = Math.max(0, Math.min(W - s, x));
  y = Math.max(0, Math.min(H - s, y));
  return { x, y, width: s, height: s };
}

// 把补丁贴回整幅：base整幅nativeImage + patch(裁剪区生成结果) → 新整幅nativeImage
function pasteRegion(base, patch, box) {
  const sz = base.getSize();
  const bb = Buffer.from(base.toBitmap());
  const ps = patch.getSize();
  const p2 = (ps.width === box.width && ps.height === box.height) ? patch : patch.resize({ width: box.width, height: box.height, quality: 'best' });
  const pb = p2.toBitmap();
  for (let r = 0; r < box.height; r++) {
    pb.copy(bb, ((box.y + r) * sz.width + box.x) * 4, r * box.width * 4, (r + 1) * box.width * 4);
  }
  return nativeImage.createFromBitmap(bb, { width: sz.width, height: sz.height });
}

// mock生成：反色（测试全链路零API消耗）
function mockGenerate(img) {
  const sz = img.getSize();
  const b = Buffer.from(img.toBitmap());
  for (let i = 0; i < b.length; i += 4) { b[i] = 255 - b[i]; b[i + 1] = 255 - b[i + 1]; b[i + 2] = 255 - b[i + 2]; }
  return nativeImage.createFromBitmap(b, { width: sz.width, height: sz.height });
}

ipcMain.on('autofix-stop', () => {
  stopFlag = true;
  if (stopResolve) stopResolve();   // 立即掀翻所有等待中的生成/识图（在途请求就地抛弃，计费已在发出时产生不多花）
  olog('🛠️ [自动修图] 收到停止指令，立即中断（正在装配PSD的那张会收尾保住）', 'err');
});

ipcMain.handle('autofix-run', async (_e, recipe) => {
  if (running) return { ok: false, error: '已有批次在跑' };
  // Forge 工序的提示词来自预设本身，不要求工序里填词——所以"有词"这条只约束云端工序
  const steps = (recipe && recipe.steps || []).filter((s) => s && (s.provider === 'forge' || (s.prompt || '').trim()));
  if (!steps.length) return { ok: false, error: '没有可执行的工序（云端工序需要提示词；Forge 工序需要选预设）' };
  if (!recipe.srcDir || !fs.existsSync(recipe.srcDir)) return { ok: false, error: '源文件夹无效' };
  if (!recipe.outDir) return { ok: false, error: '未设置输出文件夹' };
  const defN = Math.max(1, Math.min(3, Number(recipe.n) || 1));   // 旧配方的全局张数当默认值
  steps.forEach((s) => {
    if (s.part === 'body') s.part = 'upper';   // 旧「身体」部位迁移成上半身
    s.n = Math.max(1, Math.min(3, Number(s.n) || defN));   // 张数以词条为准
  });
  const files = scanDir(recipe.srcDir);
  if (!files.length) return { ok: false, error: '源文件夹里没有图片（支持jpg/png/webp）' };
  try { fs.mkdirSync(recipe.outDir, { recursive: true }); } catch (e) { return { ok: false, error: '输出文件夹创建失败: ' + e.message }; }

  // ---------- 预检（用户裁定：任一步没配好=整批不开跑，分文不花） ----------
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    // Forge 工序（0918）：不查云端地址/Key，改为查 Forge 地址 + 预设是否选好
    if (s.provider === 'forge') {
      if (!((config.forge && config.forge.url) || '').trim()) return { ok: false, error: '工序' + (i + 1) + ' 选了 Forge，但没配 Forge 地址（Forge 卡 → 设置）' };
      if (!(s.model || '').trim()) return { ok: false, error: '工序' + (i + 1) + ' 没选 Forge 预设（词条⚙里选）' };
      continue;
    }
    const prov = s.provider || config.provider;
    const pmeta = ctx.PROVIDERS[prov];
    const pc = config.providers[prov] || {};
    if (!pmeta) return { ok: false, error: '工序' + (i + 1) + ' 渠道无效（' + prov + '）' };
    if (!(pc.base || pmeta.base) || !pc.key) return { ok: false, error: '工序' + (i + 1) + '「' + (s.label || '') + '」的渠道「' + (pmeta.label || prov) + '」未配置地址/Key' };
    if (!(s.model || pc.model)) return { ok: false, error: '工序' + (i + 1) + ' 渠道「' + (pmeta.label || prov) + '」未选模型（词条⚙里选）' };
  }
  const needPartsAll = [...new Set(steps.map((s) => s.part).filter((p) => REGION_PARTS.includes(p)))];
  let precheck = null;
  if (needPartsAll.length && !recipe.mock) {
    olog('🛠️ [自动修图] 识图预检：拿第一张试探，不成整批不开跑…');
    const firstImg = nativeImage.createFromPath(files[0]);
    if (!firstImg.isEmpty()) {
      const dr = await detectRegions(firstImg, needPartsAll, recipe.det);
      if (!dr.ok) return { ok: false, error: '识图预检失败：' + dr.error + '（整批未开始，分文未花生成费）' };
      precheck = { file: files[0], dr };
      olog('🛠️ [自动修图] 识图预检通过 ✓', 'ok');
    }
  }

  const chain = recipe.chain !== false;   // 盖印链开关：关=每道工序都对原图独立跑（PSD无盖印层，各组为平行方案）
  running = true; stopFlag = false;
  if (recipe.keepAwake !== false) awakeOn();   // 防睡眠默认开：跑批半夜睡过去=整批白等
  let fused = false;   // 熔断标记：熔断不触发关机（出事了别把现场埋掉）
  const stopP = new Promise((r) => { stopResolve = r; });
  const raceStop = (p) => Promise.race([p, stopP.then(() => ({ ok: false, error: '已停止' }))]);
  const total = files.length;
  const perImg = steps.reduce((a, s) => a + s.n, 0);
  const reqTotal = total * perImg;
  let reqDone = 0;
  olog('🛠️ [自动修图] 开始：' + total + '张图 × 每图' + perImg + '张（' + steps.length + '道工序）= 最多' + reqTotal + '次生成' + (recipe.mock ? '（mock测试模式·零消耗）' : '') + (chain ? '' : '（盖印链关：每道独立对原图跑）'), 'ok');
  broadcast('autofix-progress', { running: true, done: 0, total, reqDone, reqTotal, msg: '开始' });

  let okCount = 0, skip = 0, fail = 0, detMiss = 0, detSkipped = 0;
  let consecFail = 0;      // 连续整图失败熔断：死渠道/坏配置别浪费整批（用户裁定：不成功则不执行）
  let pendingAssembly = null;   // 在飞的PSD装配任务（与下一张图的生成重叠，同时只1个）
  try {
    for (let fi = 0; fi < files.length; fi++) {
      if (stopFlag) break;
      const src = files[fi];
      const base = path.basename(src, path.extname(src));
      const outPsd = path.join(recipe.outDir, base + '.psd');
      if (fs.existsSync(outPsd)) { skip++; broadcast('autofix-progress', { running: true, done: fi + 1, total, msg: base + ' 已存在，跳过' }); continue; }
      broadcast('autofix-progress', { running: true, done: fi, total, msg: '处理中: ' + base });
      let tmpDir = null;   // 图层bin暂存目录（catch里也要能清）
      try {
        const srcImg = nativeImage.createFromPath(src);
        const { width: W, height: H } = srcImg.getSize();
        if (!W || !H) throw new Error('图片解码失败');
        // 图层数据边生成边落盘(spool)：主进程只保单层峰值内存；装配写出交给一次性子进程psd-writer
        // （61MP大图×多层在主进程必撞ArrayBuffer上限+跨文件碎片累积，0905实测根治法）
        tmpDir = path.join(recipe.outDir, '.aftmp-' + base);
        fs.mkdirSync(tmpDir, { recursive: true });
        let binSeq = 0;
        const spool = (imgData) => {
          const f = path.join(tmpDir, 'L' + (binSeq++) + '.bin');
          fs.writeFileSync(f, Buffer.from(imgData.data.buffer, imgData.data.byteOffset, imgData.data.byteLength));
          return { f, w: imgData.width, h: imgData.height };
        };
        let working = srcImg;     // 链式工作图（=上一道的盖印）
        let composite = srcImg;   // 平铺预览累积图（盖印链关时按图层堆叠语义合成）
        const children = [{ name: '原图', bin: spool(toImageData(srcImg)) }];

        // 识图定框：流水线里有区域工序才调用；一图一次调用拿全部所需部位框（几何不变，框全程复用）
        let boxes = {};
        const needParts = needPartsAll;
        if (needParts.length) {
          if (recipe.mock) {
            boxes = mockBoxes(needParts, W, H);
            olog('🛠️ [自动修图] ' + base + ' mock占位框（真识图请跑正式批次）');
          } else {
            broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 识图定框…' });
            const dr = (precheck && precheck.file === src) ? precheck.dr : await raceStop(detectRegions(srcImg, needParts, recipe.det));
            if (stopFlag) throw new Error('已停止');
            // 用户裁定：识图重试3次仍失败/部位缺失=跳过此图不跑（不降级全图，一分生成费不花）
            if (!dr.ok) throw new Error('识图3次均失败（' + dr.error + '），跳过此图');
            boxes = dr.boxes;
            const miss = needParts.filter((p) => !boxes[p]);
            if (miss.length) { detMiss += miss.length; throw new Error('部位未识别（' + miss.join('/') + '），跳过此图'); }
            olog('🛠️ [自动修图] ' + base + ' 识图完成 ' + needParts.map((p) => p + '✓').join(' '), 'ok');
          }
        }
        // ---------- 生成阶段（0905提速架构：并发的只有网络请求，解码/贴回/落盘严格串行保内存安全） ----------
        const PART_CN = { full: '全图', face: '脸部', hair: '头发', upper: '上半身', chest: '胸部', lower: '下半身', top: '竖构图-上区域', bottom: '竖构图-下区域', left: '横构图-左侧', center: '横构图-中间', right: '横构图-右侧', bg: '背景' };
        const stepBox = (st) => REGION_PARTS.includes(st.part) ? squarify(boxes[st.part], W, H, st.pad != null ? st.pad : 30)
          : (GEO_PARTS.includes(st.part) ? geoBox(st.part, W, H) : null);
        // 几何工序跳过判定：上/下区域在横图/方图、左/中/右区域在竖图/方图上无定义=整道工序不跑（不降级全图，一分钱不花）
        const stepSkipped = (st) => GEO_PARTS.includes(st.part) && !geoDefined(st.part, W, H);
        const skipWhy = (st) => GEO_TALL.includes(st.part) ? '（上/下区域仅竖构图）' : '（左/中/右区域仅横构图）';
        let ranSteps = 0;   // 真正执行的工序数（children永远含原图层，不能拿它判"全被跳过"）
        // 比例：区域/几何工序有框=正方形必得1:1；区域降级全图=按整幅就近吸附；全图/背景按词条选择
        const stepRatio = (st, box, tw, th) => box ? '1:1'
          : (REGION_PARTS.includes(st.part) ? nearestRatio(tw, th)
            : ((st.ratio && st.ratio !== '跟原图' && st.ratio !== 'Auto') ? st.ratio : nearestRatio(tw, th)));
        // 档位（0908去Auto）：卡面已按 1K/2K/4K 明选并清洗旧配方；这里再兜一层，异常值按2K
        const stepSize = (st) => (['1K', '2K', '4K'].includes(st.tier) ? st.tier : '2K');
        // 单次生成（并发任务体）：只收发base64/文件路径，不碰位图
        const genOnce = async (st, si, k, N, b64, ratio, tw, th, fullFrame) => {
          if (stopFlag) return null;
          broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 工序' + (si + 1) + '/' + steps.length + ' 第' + (k + 1) + '/' + N + '张生成中…' });
          // Forge 工序（0918）：整套参数来自工序选的 Forge 预设（模型/LoRA/重绘/步数/CFG/采样器/CN），
          // 输入图按原图尺寸跑，不套云端那套"分辨率档位"；每张一批（batch_size=1，候选=多次调用）。
          if (st.provider === 'forge') {
            const fp = forgePresetBy(st.model);
            if (!fp) { olog('🛠️ [自动修图] ' + base + ' 工序' + (si + 1) + '：找不到 Forge 预设「' + (st.model || '(未选)') + '」（Forge 卡 → 预设列表里重新选）', 'err'); return null; }
            const d = fp.data || {};
            const fr = await raceStop(ctx.generateOne({
              forge: {
                image: b64,
                prompt: d.positivePrompt || '',
                negPrompt: d.negativePrompt || '',
                steps: d.step, cfg: d.cfg, denoise: d.redrawAmount,
                sampler: d.selectedName, scheduler: d.selectedScheduler,
                model: d.model, lora: d.lora, loraWeight: d.loraWeight,
                cnEnabled: !!(d.controlNetModel && d.controlNetModel !== 'None'),
                cnModule: d.selectedControlNetModule, cnModel: d.controlNetModel, cnWeight: d.controlNetWeight,
                timeoutMs: 600000,
              },
            }));
            if (stopFlag) return null;
            reqDone++;
            broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 已回 ' + reqDone + '/' + reqTotal + ' 次' });
            if (!fr || !fr.ok) { olog('🛠️ [自动修图] ' + base + ' 工序' + (si + 1) + ' 第' + (k + 1) + '张失败: ' + ((fr && fr.error) || '未知'), 'err'); return null; }
            return fr.file;
          }
          if (ctx.dlog) ctx.dlog('[autofix] 发 ' + (st.provider || '全局') + '/' + (st.model || '渠道当前') + ' ratio=' + ratio + ' size=' + stepSize(st) + ' 入图' + tw + 'x' + th);
          const r = await raceStop(ctx.generateOne({
            // 滑块/填空值织入（每道工序独立）；整幅工序把画幅比例写进提示词防位移（用户裁定）
            prompt: applyCtl(st.prompt, st.ctl) + (fullFrame ? '\n\n本图画幅比例' + ratio + '，输出保持该画幅与原构图，画面内容不发生位移。' : ''),
            provider: st.provider || undefined,
            model: st.model || undefined,
            ratio, size: stepSize(st),
            inputImage: b64, inputMime: 'image/jpeg',
            refs: [], antiMode: 0, timeoutMs: 300000,
          }));
          if (stopFlag) return null;   // 停止立即生效：在途请求就地抛弃
          reqDone++;
          broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 已回 ' + reqDone + '/' + reqTotal + ' 次' });
          if (!r || !r.ok) { olog('🛠️ [自动修图] ' + base + ' 工序' + (si + 1) + ' 第' + (k + 1) + '张失败: ' + ((r && r.error) || '未知'), 'err'); return null; }
          return r.file;
        };
        // 结果解码+尺寸对齐（严格串行调用）
        const decodeOut = (f, box, ratio, si) => {
          if (!f) return null;
          let img = nativeImage.createFromPath(f);
          if (img.isEmpty()) return null;
          const osz = img.getSize();
          if (ctx.dlog) ctx.dlog('[autofix] 回 ' + osz.width + 'x' + osz.height);
          // 渠道吞比例侦测：请求了具体比例但返回明显不符→olog点名
          const [ra, rb] = ratio.split(':').map(Number);
          if (ra && rb && osz.width && osz.height && Math.abs(Math.log((osz.width / osz.height) / (ra / rb))) > 0.12) {
            olog('🛠️ [自动修图] ⚠ ' + base + ' 工序' + (si + 1) + ' 渠道未按请求比例出图（要' + ratio + '，回' + osz.width + 'x' + osz.height + '），建议换模型/渠道', 'err');
          }
          if (box) { if (osz.width !== box.width || osz.height !== box.height) img = img.resize({ width: box.width, height: box.height, quality: 'best' }); }
          else if (osz.width !== W || osz.height !== H) img = img.resize({ width: W, height: H, quality: 'best' });
          return img;
        };
        // 一道工序的图层组装（严格串行）：候选→组+composite/盖印
        const assembleStep = (st, si, box, cands) => {
          if (!cands.length) throw new Error('工序' + (si + 1) + '「' + (st.label || '') + '」全部生成失败');
          const partCn = PART_CN[st.part] || st.part || '全图';
          const gname = '①②③④⑤⑥⑦⑧'[si] + partCn + '·' + (st.label || '工序' + (si + 1));
          if (box) {
            // 区域工序：候选=带定位的补丁小图层（left/top落位），合成=补丁1贴回整幅
            children.push({
              name: gname.slice(0, 60), opened: false, mask: true,   // mask:true→子进程装配2×2白蒙版(defaultColor:255全白)
              children: cands.map((c, ci) => ({
                name: partCn + '-' + (ci + 1), hidden: ci !== 0, left: box.x, top: box.y, bin: spool(toImageData(c)), mask: true,   // 0909用户裁定：组内每层也各带白蒙版
              })).reverse(),   // PSD自下而上：候选1在最下=面板里最底、可见
            });
            composite = pasteRegion(chain ? working : composite, cands[0], box);
            if (chain) {
              working = composite;
              children.push({ name: '盖印' + '①②③④⑤⑥⑦⑧'[si], bin: spool(toImageData(working)) });
            }
          } else {
            // 整幅工序：候选1与盖印共享同一个bin文件（子进程binCache共享一份内存）
            const layers = cands.map((c, ci) => ({ name: partCn + '-' + (ci + 1), hidden: ci !== 0, bin: spool(toImageData(c)), mask: true }));   // 0909：组内每层白蒙版
            const firstBin = layers[0].bin;
            children.push({ name: gname.slice(0, 60), opened: false, mask: true, children: layers.reverse() });
            composite = cands[0];
            if (chain) {
              working = cands[0];   // 盖印=候选1，进下一道
              children.push({ name: '盖印' + '①②③④⑤⑥⑦⑧'[si], bin: firstBin });
            }
          }
          broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 工序' + (si + 1) + '/' + steps.length + ' 完成' });
          ranSteps++;
        };

        if (recipe.mock) {
          // mock零消耗即时出图，无并发必要，保持串行
          for (let si = 0; si < steps.length; si++) {
            if (stopFlag) throw new Error('已停止');
            const st = steps[si];
            if (stepSkipped(st)) { olog('🛠️ [自动修图] ' + base + ' 构图不符跳过工序' + (si + 1) + '「' + (PART_CN[st.part]) + '」' + skipWhy(st)); continue; }
            const box = stepBox(st);
            const srcBase = chain ? working : srcImg;
            const inputImg = box ? srcBase.crop(box) : srcBase;
            const cands = [];
            for (let k = 0; k < st.n; k++) { cands.push(mockGenerate(inputImg)); reqDone++; }
            assembleStep(st, si, box, cands);
          }
        } else if (chain) {
          // 盖印链开：工序必须串行（各道等上道盖印），道内多张并发（池4）
          for (let si = 0; si < steps.length; si++) {
            if (stopFlag) throw new Error('已停止');
            const st = steps[si];
            if (stepSkipped(st)) { olog('🛠️ [自动修图] ' + base + ' 构图不符跳过工序' + (si + 1) + '「' + (PART_CN[st.part]) + '」' + skipWhy(st)); continue; }
            const box = stepBox(st);
            const inputImg = box ? working.crop(box) : working;
            const tw = box ? box.width : W, th = box ? box.height : H;
            const ratio = stepRatio(st, box, tw, th);
            const b64 = inputImg.toJPEG(92).toString('base64');   // n张共用一份输入，裁剪位图即弃
            const outs = new Array(st.n).fill(null);
            await runPool(outs.map((_, k) => k), 4, async (k) => { outs[k] = await genOnce(st, si, k, st.n, b64, ratio, tw, th, !box); });
            if (stopFlag) throw new Error('已停止');
            assembleStep(st, si, box, outs.map((f) => decodeOut(f, box, ratio, si)).filter(Boolean));
          }
        } else {
          // 盖印链关：各道全对原图独立跑→整图所有(工序×张数)一池并发（提速主力：每图耗时≈最慢一张）
          const runSteps = steps.map((st, si) => ({ st, si })).filter((x) => {
            if (stepSkipped(x.st)) { olog('🛠️ [自动修图] ' + base + ' 构图不符跳过工序' + (x.si + 1) + '「' + (PART_CN[x.st.part]) + '」' + skipWhy(x.st)); return false; }
            return true;
          });
          if (!runSteps.length) throw new Error('全部工序都被构图跳过，跳过此图');
          const plans = runSteps.map(({ st, si }) => {
            const box = stepBox(st);
            const inputImg = box ? srcImg.crop(box) : srcImg;
            const tw = box ? box.width : W, th = box ? box.height : H;
            const ratio = stepRatio(st, box, tw, th);
            const b64 = inputImg.toJPEG(92).toString('base64');
            return { st, si, box, tw, th, ratio, b64, outs: new Array(st.n).fill(null) };
          });
          const tasks = [];
          plans.forEach((p) => { for (let k = 0; k < p.st.n; k++) tasks.push({ p, k }); });
          // Forge 是本机 GPU：并发只会互相抢显存（还更慢），带 Forge 工序的池压到 1 = 逐张串行
          const anyForge = plans.some((p) => p.st.provider === 'forge');
          await runPool(tasks, anyForge ? 1 : 4, async (t) => { t.p.outs[t.k] = await genOnce(t.p.st, t.p.si, t.k, t.p.st.n, t.p.b64, t.p.ratio, t.p.tw, t.p.th, !t.p.box); });
          if (stopFlag) throw new Error('已停止');
          for (const p of plans) {
            assembleStep(p.st, p.si, p.box, p.outs.map((f) => decodeOut(f, p.box, p.ratio, p.si)).filter(Boolean));
          }
        }

        // 装配写出交给一次性子进程，并与下一张图的生成重叠（同时只1个装配在飞——2-3GB级内存不许叠）
        // 平铺图：盖印链开=最后盖印bin；关=按堆叠语义累积的composite
        if (!ranSteps) throw new Error('全部工序都被构图跳过，跳过此图');
        broadcast('autofix-progress', { running: true, done: fi, total, reqDone, reqTotal, msg: base + ' · 排队装配PSD…' });
        const flatBin = chain ? children[children.length - 1].bin : spool(toImageData(composite));
        const manifest = { width: W, height: H, out: outPsd, children, flat: flatBin };
        const mf = path.join(tmpDir, 'manifest.json');
        fs.writeFileSync(mf, JSON.stringify(manifest));
        if (pendingAssembly) await pendingAssembly;   // 上一张还在装→等它落地（结果记账在它自己的任务里）
        const myTmp = tmpDir, myBase = base, myIdx = fi;
        tmpDir = null;   // 所有权移交装配任务，本文件catch不再清
        pendingAssembly = (async () => {
          try {
            await new Promise((resolve, reject) => {
              const { utilityProcess } = require('electron');
              const child = utilityProcess.fork(path.join(__dirname, 'psd-writer.js'), [mf], { stdio: 'pipe' });
              let errBuf = '';
              if (child.stderr) child.stderr.on('data', (d) => { errBuf += d; });
              child.on('exit', (code) => { code === 0 ? resolve() : reject(new Error('PSD装配失败(code' + code + '): ' + errBuf.slice(0, 400))); });
            });
            okCount++;
            consecFail = 0;
            olog('🛠️ [自动修图] ✓ ' + myBase + '.psd（' + (myIdx + 1) + '/' + total + '）', 'ok');
          } catch (e) {
            fail++;
            olog('🛠️ [自动修图] ✗ ' + myBase + ' 装配失败: ' + (e.message || e), 'err');
          } finally {
            try { fs.rmSync(myTmp, { recursive: true, force: true }); } catch (e2) {}
          }
        })();
      } catch (e) {
        const em = String(e.message || e);
        if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e2) {} }
        if (em.indexOf('跳过此图') !== -1) {
          // 识图跳图：不算失败、不进熔断，继续下一张
          detSkipped++;
          olog('🛠️ [自动修图] ⏭ ' + base + ': ' + em, 'err');
          continue;
        }
        fail++;
        consecFail++;
        olog('🛠️ [自动修图] ✗ ' + base + ': ' + em, 'err');
        if (em.indexOf('已停止') !== -1) break;
        if (consecFail >= 2) { fused = true; olog('🛠️ [自动修图] 连续' + consecFail + '张整图失败，熔断中止批次——先检查渠道/模型/Key再重跑', 'err'); break; }
      }
    }
  } finally {
    awakeOff();
    // 收尾：等最后一个在飞的装配落地（停止也保住装配中那张），再结账
    if (pendingAssembly) {
      broadcast('autofix-progress', { running: true, done: total, total, reqDone, reqTotal, msg: '最后一张装配收尾…' });
      try { await pendingAssembly; } catch (e) {}
      pendingAssembly = null;
    }
    running = false;
    stopResolve = null;
    const endMsg = '完成 ' + okCount + ' 张' + (skip ? ' · 已有跳过' + skip : '') + (fail ? ' · 失败' + fail : '') + (detSkipped ? ' · 识图不成跳过' + detSkipped + '图' : '') + (stopFlag ? ' · 手动停止' : '');
    olog('🛠️ [自动修图] 批次结束：' + endMsg, okCount ? 'ok' : 'err');
    broadcast('autofix-progress', { running: false, done: total, total, reqDone, reqTotal, msg: endMsg });
    // 自然跑完（非停止、非熔断）且用户开了关机开关 → 60秒倒计时关机
    if (recipe.shutdownAfter && !stopFlag && !fused) scheduleShutdown();
  }
  return { ok: true, done: okCount, skip, fail, detMiss, detSkipped };
});
