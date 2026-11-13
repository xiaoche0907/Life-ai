// 批量改色卡（1113）：PS当前选区=蒙版，本地上传参考图=SKU，
// 移植「衣色 v0.23」mode1 算法（recolor-core.js，REA取证移植）在渲染进程计算，
// 主进程只做：落盘 PNG → placeBatch 打组贴回 PS（顶层生效，点眼睛切 SKU）。
// 零 AI 调用、零网络；不修改任何 PSD 文件。
const { ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const olog = (m, t) => ctx.olog(m, t);

// 渲染进程读参考图字节（无 fs）；只读不写，路径来自本机文件选择器
const { dialog } = require('electron');
ipcMain.handle('recolor-read-image', async (_e, p) => {
  try {
    if (typeof p !== 'string' || !p || p.length > 600) return { ok: false, error: '路径无效' };
    const buf = fs.readFileSync(p);
    return { ok: true, base64: buf.toString('base64'), size: buf.length };
  } catch (e) { return { ok: false, error: e.message || String(e) }; }
});

// 直读PS选中图层的图层蒙版=调色权重（1114用户需求：用户在PS里选好蒙版组，不再画选区）。
// PS侧新通道 readMaskGroup：hasUserMask→load蒙版为选区→getSelection灰度。
async function readMask(options) {
  const p = options || {};
  if (!Number.isInteger(p.docId) || !Number.isInteger(p.layerId)) return { ok: false, error: '请先读取PS文档并选择目标蒙版组' };
  const r = await ctx.sendToPSAwait({ action: 'readMaskGroup', params: { docId: p.docId, layerId: p.layerId } }, 60000);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'PS插件未连接，请更新桥接插件并重启PS' };
  const result = r.result || {};
  if (!result.ok) return result;
  const raw = Buffer.from(result.rgbaB64 || '', 'base64');
  if (raw.length !== result.width * result.height * 4) return { ok: false, error: 'PS返回的像素数据长度异常' };
  for (let i = 0; i < raw.length; i += 4) { const red = raw[i]; raw[i] = raw[i + 2]; raw[i + 2] = red; }
  const image = nativeImage.createFromBitmap(raw, { width: result.width, height: result.height });
  const { rgbaB64, ...meta } = result;
  return { ...meta, image: image.toPNG().toString('base64') };
}
ipcMain.handle('recolor-inspect-document', async () => {
  try {
    const r = await ctx.sendToPSAwait({ action: 'inspectRecolorDocument', params: {} }, 30000);
    return r && r.ok ? r.result : { ok: false, error: (r && r.error) || 'PS插件未连接' };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 调色输出是原生配方；PNG仅用于前端预览，不参与PS写回。
const nativeRecipePath = process.resourcesPath && path.join(process.resourcesPath, 'ps-bridge', 'recolor-native.js');
const nativeRecipe = require(nativeRecipePath && fs.existsSync(nativeRecipePath) ? nativeRecipePath : path.resolve(__dirname, '../../ps-bridge/recolor-native.js'));
const nativeJobs = new Map();
ipcMain.handle('recolor-save', async (_e, p) => {
  try {
    const skus = p && p.skus, cap = p && p.capture;
    if (!Array.isArray(skus) || !skus.length || skus.length > 40) throw Error('SKU数量必须在1到40之间');
    if (!cap || !Number.isInteger(cap.docId) || !Number.isInteger(cap.layerId)) throw Error('请先选择源文档和目标蒙版组');
    for (const sku of skus) { if (!sku || typeof sku.name !== 'string' || !sku.name.trim() || sku.name.length > 160) throw Error('SKU名称无效'); nativeRecipe.validate(sku.recipe); }
    const jobId = require('crypto').randomUUID();
    const job = JSON.parse(JSON.stringify({ version: 2, jobId, algorithm: 'colorlab-native-v1', createdAt: new Date().toISOString(), source: cap, skus }));
    const recipeFile = path.join(ctx.genDir(), 'recolor_' + jobId + '_recipes.json');
    fs.writeFileSync(recipeFile, JSON.stringify(job, null, 2), { flag: 'wx' });
    nativeJobs.set(jobId, job);
    if (nativeJobs.size > 20) nativeJobs.delete(nativeJobs.keys().next().value);
    olog('✓ [批量改色] 已保存 ' + skus.length + ' 个SKU原生调色配方，准备创建可编辑调整层');
    return { ok: true, jobId, count: skus.length, recipeFile };
  } catch (e) { return { ok: false, error: e.message }; }
});


// 读取PS选中图层的蒙版权重（批量改色卡「读取蒙版组」钮）
ipcMain.handle('recolor-read-mask', async (_e, p) => {
  try { return await readMask(p); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
// 机测直调（真机验证脚本用）
ctx.recolorReadMask = readMask;
// 仅按已保存的任务快照写入目标组，不再读取PNG或创建像素层。
ipcMain.handle('recolor-place', async (_e, p) => {
  const job = p && nativeJobs.get(p.jobId);
  if (!job) return { ok: false, error: '原生调色任务已失效，请重新生成' };
  if (job.result) return job.result;
  if (job.running) return { ok: false, error: '此任务正在PS创建，请勿重复提交' };
  if (typeof ctx.bridgeVer === 'function' && ctx.bridgeVer() < 68) return { ok: false, error: '原生调色组需要PS桥接v68，请更新桥接插件并重启PS（旧版只能贴图片）' };
  job.running = true;
  try {
    const response = await ctx.sendToPSAwait({ action: 'placeRecolorLayers', params: { docId: job.source.docId, layerId: job.source.layerId, items: job.skus.map(sku => ({ name: sku.name, recipe: sku.recipe })) } }, 120000);
    const result = response && response.ok ? response.result : { ok: false, error: (response && response.error) || 'PS未完成原生调整层创建' };
    olog(result.ok ? '✓ [批量改色] 已创建 ' + result.count + ' 个原生可编辑SKU子组（首组显示，其余隐藏）' : '[批量改色] 创建失败：' + result.error, result.ok ? 'ok' : 'err');
    if (result.ok) job.result = result;
    return result;
  } catch (e) { return { ok: false, error: e.message }; }
  finally { job.running = false; }
});
