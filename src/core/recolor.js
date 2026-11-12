// 批量改色卡（1113）：PS当前选区=蒙版，本地上传参考图=SKU，
// 移植「衣色 v0.23」mode1 算法（recolor-core.js，REA取证移植）在渲染进程计算，
// 主进程只做：落盘 PNG → placeBatch 打组贴回 PS（顶层生效，点眼睛切 SKU）。
// 零 AI 调用、零网络；不修改任何 PSD 文件。
const { ipcMain } = require('electron');
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
async function readMask(maxEdge) {
  const r = await ctx.sendToPSAwait({ action: 'readMaskGroup', params: { maxEdge: maxEdge || 2400 } }, 60000);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'PS 未连接或读取蒙版失败' };
  return r.result || {};
}
// 渲染结果落盘（渲染进程已算好 PNG bytes，主进程只写文件）
ipcMain.handle('recolor-save', async (_e, p) => {
  const batchId = ctx.genBatchId();
  const skus = (p && p.skus) || [];
  const cap = (p && p.capture) || null;
  if (!skus.length) return { ok: false, error: '没有可保存的SKU结果' };
  const dir = ctx.genDir();
  const stamp = Date.now();
  const files = [];
  for (const s of skus) {
    if (!s || !s.png) continue;
    const safe = String(s.name || 'SKU').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 40) || 'SKU';
    const f = path.join(dir, 'recolor_' + stamp + '_' + safe + '.png');
    fs.writeFileSync(f, Buffer.from(s.png, 'base64'));
    files.push({ file: f, name: safe });
  }
  if (!files.length) return { ok: false, error: 'SKU图像数据无效' };
  // recipes.json：参数与来源可追溯（PRD 8：记录输入、参数、算法版本）
  const recipe = {
    version: 1,
    algorithm: 'yise-v0.23-mode1-port (soft-midtone-color-separated + fill75)',
    createdAt: new Date().toISOString(),
    source: { selection: cap && cap.selection || null, docId: cap && cap.docId || null, width: cap && cap.width || null, height: cap && cap.height || null },
    skus: files.map((f, i) => ({ name: f.name, file: f.file, params: skus[i] ? skus[i].params : null })),
  };
  const rf = path.join(dir, 'recolor_' + stamp + '_recipes.json');
  fs.writeFileSync(rf, JSON.stringify(recipe, null, 2));
  olog('✓ [批量改色] ' + files.length + ' 个SKU已落盘（含recipes.json）');
  return { ok: true, files, recipeFile: rf };
});


// 读取PS选中图层的蒙版权重（批量改色卡「读取蒙版组」钮）
ipcMain.handle('recolor-read-mask', async (_e, p) => {
  try { return await readMask(p && p.maxEdge); }
  catch (e) { return { ok: false, error: e.message || String(e) }; }
});
// 机测直调（真机验证脚本用）
ctx.recolorReadMask = readMask;
// 贴回 PS：placeBatch 打组「来福 批量改色组」
ipcMain.handle('recolor-place', async (_e, p) => {
  const files = (p && p.files) || [];
  const cap = (p && p.capture) || null;
  if (!files.length) return { ok: false, error: '没有可贴回的图层' };
  const pr = await ctx.placeWithRetry('placeBatch', {
    paths: files.map((f) => f.file),
    docId: cap && cap.docId || null,
    selection: cap && cap.selection || null,
    antiMode: 0,
    group: true,
  }, 0);
  olog(pr.ok
    ? '✓ [批量改色] 已置入 ' + files.length + ' 层（已打组「来福 批量改色组」，点眼睛对比SKU）'
    : '[批量改色] 置入失败: ' + (pr.error || ''), pr.ok ? 'ok' : 'err');
  return pr;
});
