// 图层拆分卡（1111）：把PS当前画面交给gpt-image系模型，按元素拆成2-8张透明背景PNG图层，
// 逐张贴回PS原选区。贴回走辉光卡同款 placeImage 链（透明PNG贴入带alpha）。
// 依赖：gpt-image 系模型的 background=transparent（gen.js generateViaOpenAI 已支持）。
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const olog = (m, t) => ctx.olog(m, t);

ipcMain.handle('layersplit-run', async (_e, p) => {
  const hint = String((p && p.hint) || '').trim();
  // 元素清单：用户填的拆分要求按逗号/顿号/空格拆；不填=背景+主体两层（最稳的默认）
  const items = hint ? hint.split(/[,，、;；\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 8) : ['完整背景（保持原样，不透明）', '主体（画面中最主要的人物或物体，其余全透明）'];
  const count = items.length;
  const pctx = (p && p.pctx) || {};
  const cap = (p && p.capture) || null;
  if (!cap || !cap.image) return { ok: false, error: '没有画面输入：先在PS框选或打开文档' };

  const batchId = ctx.genBatchId();
  olog('▶ [图层拆分] 开始：' + count + ' 层【' + items.join(' / ') + '】' + (p.model ? ' · 模型 ' + p.model : ''));

  // 原图画布尺寸：所有层统一归一到这个尺寸（原位对齐的基础——模型出图尺寸不受控，贴回前强制对齐）
  let srcW = 0, srcH = 0;
  try { const im = require('electron').nativeImage.createFromBuffer(Buffer.from(cap.image, 'base64')); const sz = im.getSize(); srcW = sz.width; srcH = sz.height; } catch (e) {}
  if (!srcW || !srcH) return { ok: false, error: '输入画面解码失败' };

  // 每层一条提取提示词：指定唯一元素 + 原样提取 + 位置尺寸锁死。同名同参多请求，模型只做"抠出"不做"创作"
  const layerPrompt = (item, idx) => [
    '任务：从输入图像中原样提取【' + item + '】，输出一张透明背景PNG。共 ' + count + ' 层中的第 ' + (idx + 1) + ' 层。',
    '铁律：',
    '1. 输出图与输入原图相同的宽高比例与画布构图；',
    '2. 只保留【' + item + '】的像素，其余区域全部透明（alpha=0）；不要画出该元素以外的东西，也不要重绘、美化、补全它；',
    '3. ⚠该元素在输出图中的位置、大小、角度、透视、颜色、细节必须与原图完全一致——像从原图里抠出来的一样，禁止放大、居中、移动、重构成商品展示图；',
    '4. 只输出图像，不输出文字。',
  ].join('\n');
  const tasks = [];
  function normalizeLayer(buf, layerNo) {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return buf;
    const sz = img.getSize();
    if (sz.width === srcW && sz.height === srcH) return buf;
    // 比例一致 → 直接缩到原尺寸（贴回选区时等价）；比例偏离 → 等比缩放并提醒用户
    if (Math.abs(sz.width / sz.height - srcW / srcH) < 0.02) {
      const resized = img.resize({ width: srcW, height: srcH, quality: 'best' });
      olog('[图层拆分] 第' + layerNo + '层尺寸 ' + sz.width + 'x' + sz.height + ' → 已归一到 ' + srcW + 'x' + srcH);
      return resized.toPNG();
    }
    const scale = Math.min(srcW / sz.width, srcH / sz.height);
    const nw = Math.max(1, Math.round(sz.width * scale)), nh = Math.max(1, Math.round(sz.height * scale));
    const resized = img.resize({ width: nw, height: nh, quality: 'best' });
    olog('[图层拆分] 第' + layerNo + '层比例偏离（' + sz.width + 'x' + sz.height + '），已等比缩为 ' + nw + 'x' + nh + '——与原图比例不同，叠回可能需手动微调', 'warn');
    return resized.toPNG();
  }

  // 逐层提取：每层一次独立请求（指定唯一元素），并发跑；归一化后落盘
  const dir = ctx.genDir();
  const stamp = Date.now();
  const jobs = items.map((item, idx) => {
    const task = ctx.genTaskAdd({
      batchId,
      prompt: layerPrompt(item, idx),
      tag: '[图层拆分] ' + item,
      docId: cap.docId || null,
      selection: cap.selection || null,
      inputFile: cap.inputFile || null,
    });
    tasks.push(task);
    const { pixelSize } = require('./img-size');
    const size = pixelSize(cap.ratio || 'Auto', cap.size || 'Auto');
    return (async () => {
      const fd = new FormData();
      fd.append('model', p.model || 'gpt-image-1');
      fd.append('prompt', layerPrompt(item, idx));
      fd.append('n', '1');
      fd.append('size', size);
      fd.append('background', 'transparent');
      fd.append('output_format', 'png');
      fd.append('image[]', new Blob([Buffer.from(cap.image, 'base64')], { type: cap.mime || 'image/jpeg' }), 'input.jpg');
      const t0 = Date.now();
      const resp = await fetch((ctx.providerMeta(ctx.config.provider || 'yingce') || {}).base + '/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.cleanKey(ctx.config.providers[ctx.config.provider || 'yingce'].key) },
        body: fd, signal: AbortSignal.timeout(600000),
      });
      const j = await resp.json().catch(() => null);
      if (!resp.ok) {
        const detail = (j && j.error && (j.error.message || j.error.type)) || (j && j.message) || '';
        throw new Error('HTTP ' + resp.status + (detail ? ' — ' + String(detail).slice(0, 180) : ''));
      }
      const d = j && j.data && j.data[0];
      if (!d || !d.b64_json) throw new Error('回包没有图像数据');
      const f = path.join(dir, 'layersplit_' + stamp + '_' + (idx + 1) + 'of' + count + '.png');
      fs.writeFileSync(f, normalizeLayer(Buffer.from(d.b64_json, 'base64'), idx + 1));
      ctx.genTaskUpdate(task, { status: 'done', file: f });
      olog('[图层拆分] 「' + item + '」完成（' + Math.round((Date.now() - t0) / 1000) + '秒）');
      return { file: f, task, item };
    })().catch((e) => {
      const msg = (e && e.name === 'AbortError') ? '请求超时(600秒)' : (e.message || String(e));
      ctx.genTaskUpdate(task, { status: 'error', error: msg });
      olog('[图层拆分] 「' + item + '」失败: ' + msg, 'err');
      return null;
    });
  });
  const rs = await Promise.all(jobs);
  const oks = rs.filter(Boolean);
  if (!oks.length) return { ok: false, error: '全部图层失败' };

  // 逐层贴回（从底到顶）：placeImage 保持图层顺序置入（每层独立不加蒙版，透明PNG自带alpha）
  let placed = false;
  if (ctx.config.gen.autoReturn !== false) {
    const pr = await ctx.placeWithRetry('placeBatch', {
      paths: oks.map((r) => r.file),
      docId: cap.docId || null,
      selection: cap.selection || null,
      antiMode: 0,
      group: true,
    }, 0);
    placed = !!pr.ok;
    olog(pr.ok
      ? '✓ [图层拆分] 已置入 ' + oks.length + ' 层（已打组「来福 生成组」，可在PS里逐层编辑）'
      : '[图层拆分] 置入失败: ' + (pr.error || '') + '（图层已保留在进度卡，点图可手动贴回）', pr.ok ? 'ok' : 'err');
  } else {
    olog('⬇ [图层拆分] 自动回传已关闭：' + oks.length + ' 层已生成未置入——进度卡点图手动贴回', 'err');
  }
  return { ok: true, count: oks.length, placed };
});

