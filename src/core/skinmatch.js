/* 肤色统一主进程（P0）：皮肤区域读取、Lab 匹配任务、原生调整层写回。
   渲染进程完成分割与匹配（skinmatch-core.js），主进程只做：任务落盘 + PS 写回转发。
   蒙版来源：PS 已选蒙版组（与批量改色同款），皮肤分割在其范围内进行。 */
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const olog = (m, t) => ctx.olog(m, t);
const nativeRecipePath = process.resourcesPath && path.join(process.resourcesPath, 'ps-bridge', 'recolor-native.js');
const nativeRecipe = require(nativeRecipePath && fs.existsSync(nativeRecipePath) ? nativeRecipePath : path.resolve(__dirname, '../../ps-bridge/recolor-native.js'));

// 参考图读取（本地文件，复用 recolor 的 readImageBytes 也可以；这里独立命名避免耦合）
ipcMain.handle('skinmatch-read-image', async (_e, p) => {
  try {
    if (typeof p !== 'string' || !p || p.length > 600) return { ok: false, error: '路径无效' };
    const buf = fs.readFileSync(p);
    if (buf.length > 20 * 1024 * 1024) return { ok: false, error: '参考图超过20MB' };
    return { ok: true, base64: buf.toString('base64'), size: buf.length };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// 文档扫描（复用桥接的 inspectRecolorDocument）
ipcMain.handle('skinmatch-inspect-document', async () => {
  try {
    const r = await ctx.sendToPSAwait({ action: 'inspectRecolorDocument', params: {} }, 30000);
    return r && r.ok ? r.result : { ok: false, error: (r && r.error) || 'PS插件未连接' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 读取蒙版组（复用 readMaskGroup；返回文档像素+蒙版权重）
ipcMain.handle('skinmatch-read-mask', async (_e, p) => {
  try {
    if (!p || !Number.isInteger(p.docId) || !Number.isInteger(p.layerId)) return { ok: false, error: '请先读取PS文档并选择目标蒙版组' };
    const r = await ctx.sendToPSAwait({ action: 'readMaskGroup', params: { docId: p.docId, layerId: p.layerId } }, 60000);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'PS插件未连接，请更新桥接插件并重启PS' };
    const result = r.result || {};
    if (!result.ok) return result;
    // 与批量改色同款：PS返回BGR序RGBA位图 → nativeImage转PNG给卡片解码
    const { nativeImage } = require('electron');
    const raw = Buffer.from(result.rgbaB64 || '', 'base64');
    if (raw.length !== result.width * result.height * 4) return { ok: false, error: 'PS返回的像素数据长度异常' };
    for (let i = 0; i < raw.length; i += 4) { const red = raw[i]; raw[i] = raw[i + 2]; raw[i + 2] = red; }
    const image = nativeImage.createFromBitmap(raw, { width: result.width, height: result.height });
    const { rgbaB64, ...meta } = result;
    return { ...meta, image: image.toPNG().toString('base64') };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// 灰度字节 → PNG（无依赖：手写最小PNG编码器，灰度8位）
function grayToPng(gray, w, h) {
  const zlib = require('zlib');
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = gray[y * w + x];
  }
  const idat = zlib.deflateSync(raw);
  const crcTable = grayToPng._crc || (grayToPng._crc = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
    return t;
  })());
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let crc = 0xFFFFFFFF;
    for (const b of td) crc = crcTable[(crc ^ b) & 0xFF] ^ (crc >>> 8);
    crc = (crc ^ 0xFFFFFFFF) >>> 0;
    const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc);
    return Buffer.concat([len, td, crcB]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 比例调整写回：形变图作为原组内新像素图层（putPixels已验证路径）
ipcMain.handle('proportion-place', async (_e, p) => {
  try {
    if (!p || !Number.isInteger(p.docId) || !Number.isInteger(p.layerId)) return { ok: false, error: '参数缺失' };
    if (typeof p.rgbaB64 !== 'string' || !Number.isInteger(p.width) || !Number.isInteger(p.height)) return { ok: false, error: '形变图数据缺失' };
    const raw = Buffer.from(p.rgbaB64, 'base64');
    if (raw.length !== p.width * p.height * 4) return { ok: false, error: '形变图数据长度异常' };
    if (p.width * p.height > 12000000) return { ok: false, error: '图像超过1200万像素限制' };
    if (typeof ctx.bridgeVer === 'function' && ctx.bridgeVer() < 69) return { ok: false, error: '需要PS桥接v69，请更新桥接插件并重启PS' };
    const response = await ctx.sendToPSAwait({ action: 'placeProportionLayer', params: {
      docId: p.docId, layerId: p.layerId, name: (p.name || '比例调整').slice(0, 120),
      rgbaB64: p.rgbaB64, width: p.width, height: p.height,
    } }, 120000);
    const result = response && response.ok ? response.result : { ok: false, error: (response && response.error) || 'PS未完成形变图层创建' };
    olog(result.ok ? '✓ [比例调整] 已创建形变图层（原图层保留）' : '[比例调整] 失败：' + result.error, result.ok ? 'ok' : 'err');
    return result;
  } catch (e) { return { ok: false, error: e.message || String(e) };
  }
});

// 白底净化写回：净化结果作为原组内新像素图层
ipcMain.handle('whitebg-place', async (_e, p) => {
  try {
    if (!p || !Number.isInteger(p.docId) || !Number.isInteger(p.layerId)) return { ok: false, error: '参数缺失' };
    if (typeof p.rgbaB64 !== 'string' || !Number.isInteger(p.width) || !Number.isInteger(p.height)) return { ok: false, error: '净化图数据缺失' };
    const raw = Buffer.from(p.rgbaB64, 'base64');
    if (raw.length !== p.width * p.height * 4) return { ok: false, error: '净化图数据长度异常' };
    if (p.width * p.height > 12000000) return { ok: false, error: '图像超过1200万像素限制' };
    if (typeof ctx.bridgeVer === 'function' && ctx.bridgeVer() < 69) return { ok: false, error: '需要PS桥接v69，请更新桥接插件并重启PS' };
    const response = await ctx.sendToPSAwait({ action: 'placeWhiteBgLayer', params: {
      docId: p.docId, layerId: p.layerId, name: (p.name || '白底净化').slice(0, 120),
      rgbaB64: p.rgbaB64, width: p.width, height: p.height,
    } }, 120000);
    const result = response && response.ok ? response.result : { ok: false, error: (response && response.error) || 'PS未完成白底净化图层创建' };
    olog(result.ok ? '✓ [白底净化] 已创建净化图层（原组保留）' : '[白底净化] 失败：' + result.error, result.ok ? 'ok' : 'err');
    return result;
  } catch (e) { return { ok: false, error: e.message || String(e) };
  }
});

const jobs = new Map();
ipcMain.handle('skinmatch-save', async (_e, p) => {
  try {
    const item = p && p.item, cap = p && p.capture;
    if (!item || typeof item.name !== 'string' || !item.name.trim()) throw Error('结果名称无效');
    if (!item.recipe) throw Error('原生配方缺失');
    nativeRecipe.validate(item.recipe);
    if (!cap || !Number.isInteger(cap.docId) || !Number.isInteger(cap.layerId)) throw Error('请先选择源文档和目标蒙版组');
    if (!item.maskB64 || typeof item.maskB64 !== 'string' || item.maskB64.length < 16) throw Error('皮肤蒙版数据缺失');
    if (item.maskB64.length > 48 * 1024 * 1024) throw Error('皮肤蒙版数据过大');
    const maskLen = Buffer.from(item.maskB64, 'base64').length;
    if (!Number.isInteger(item.maskWidth) || !Number.isInteger(item.maskHeight) || item.maskWidth < 1 || item.maskHeight < 1 || item.maskWidth * item.maskHeight > 36 * 1024 * 1024) throw Error('皮肤蒙版尺寸无效');
    if (maskLen !== item.maskWidth * item.maskHeight) throw Error('皮肤蒙版数据尺寸与声明的宽高不一致');
    const jobId = require('crypto').randomUUID();
    const job = JSON.parse(JSON.stringify({ version: 1, jobId, algorithm: 'skinmatch-native-v1', createdAt: new Date().toISOString(), source: cap, item }));
    const recipeFile = path.join(ctx.genDir(), 'skinmatch_' + jobId + '_recipe.json');
    fs.writeFileSync(recipeFile, JSON.stringify(job, null, 2), { flag: 'wx' });
    jobs.set(jobId, job);
    if (jobs.size > 20) jobs.delete(jobs.keys().next().value);
    olog('✓ [肤色统一] 已保存皮肤匹配配方与蒙版，准备创建可编辑调整层');
    return { ok: true, jobId, recipeFile };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 写回：创建「肤色统一」子组（皮肤蒙版 + 原生调整层）
ipcMain.handle('skinmatch-place', async (_e, p) => {
  const job = p && jobs.get(p.jobId);
  if (!job) return { ok: false, error: '肤色统一任务已失效，请重新生成' };
  if (job.result) return job.result;
  if (job.running) return { ok: false, error: '此任务正在PS创建，请勿重复提交' };
  if (typeof ctx.bridgeVer === 'function' && ctx.bridgeVer() < 68) return { ok: false, error: '肤色统一需要PS桥接v68，请更新桥接插件并重启PS' };
  job.running = true;
  try {
    const response = await ctx.sendToPSAwait({ action: 'placeSkinMatchLayers', params: {
      docId: job.source.docId, layerId: job.source.layerId,
      name: job.item.name, recipe: job.item.recipe, maskB64: job.item.maskB64,
      maskWidth: job.item.maskWidth, maskHeight: job.item.maskHeight,
    } }, 120000);
    const result = response && response.ok ? response.result : { ok: false, error: (response && response.error) || 'PS未完成肤色统一调整层创建' };
    // UXP下灰度粘贴进蒙版不生效（真机验证）：成功建组后由主进程经COM写蒙版灰度
    if (result.ok) {
      try {
        const os = require('os');
        const pngPath = path.join(os.tmpdir(), 'laifu_skinmask_' + Date.now() + '.png');
        const maskRaw = Buffer.from(job.item.maskB64, 'base64');
        const png = grayToPng(maskRaw, job.item.maskWidth, job.item.maskHeight);
        fs.writeFileSync(pngPath, png);
        const wlm = await ctx.comBridge.tryCall({ action: 'writeLayerMask', params: {
          docId: job.source.docId, layerId: result.groupId || job.source.layerId, pngPath,
        } }, 90000);
        try { fs.rmSync(pngPath, { force: true }); } catch (e) {}
        if (!wlm.ok) {
          result.ok = false;
          result.error = '调整子组已创建，但皮肤蒙版写入失败：' + (wlm.error || 'COM通道不可用') + '。可删除该子组重试';
        }
      } catch (eM) {
        result.ok = false;
        result.error = '调整子组已创建，但皮肤蒙版写入异常：' + eM.message;
      }
    }
    olog(result.ok ? '✓ [肤色统一] 已创建可编辑皮肤调整子组（皮肤蒙版+原生曲线）' : '[肤色统一] ' + result.error, result.ok ? 'ok' : 'err');
    if (result.ok) job.result = result;
    return result;
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
  finally { job.running = false; }
});
