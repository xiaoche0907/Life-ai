// 打光（法线图+数学重打光）：AI只干一件事——给原图生成一次「相机空间法线图AOV」，
// 之后所有打光都是本地纯数学（relight.html里实时预览），零API费、无限次调、无AI漂移。
// 本模块负责烘焙落地：渲染端把算好的灯光层PNG发来 → 写盘 → placeImage贴回原选区(打组+白蒙版走现成链路)
// → 通用batchPlay按图层名设混合模式+不透明度（图层名=文件名，时间戳唯一，定位可靠）。
//
// 照射范围（maskMode）：'all'=全画面 / 'subject'=只照人物 / 'background'=只照背景。
// 只照人物/背景的做法：置入前在原图上跑PS原生「选择主体」(autoCutout)→选区存临时通道→
// 置入灯光层→通道载回选区(背景模式再反相)→给灯光层打revealSelection图层蒙版→删临时通道→
// 尽力还原用户原来的矩形选区。主体识别失败不阻塞：降级为无蒙版置入+日志提醒。
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const olog = (m, t) => ctx.olog(m, t);

ipcMain.handle('relight-bake', async (_e, p) => bakeLight(p));

async function bakeLight(p) {
  try {
    const dataUrl = (p && p.dataUrl) || '';
    const b64 = dataUrl.indexOf(',') !== -1 ? dataUrl.split(',')[1] : dataUrl;
    if (!b64) return { ok: false, error: '灯光层数据为空' };
    const pctx = (p && p.pctx) || {};
    const maskMode = (p && p.maskMode) || 'all';
    const dir = ctx.genDir();
    fs.mkdirSync(dir, { recursive: true });
    const base = 'relight_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const file = path.join(dir, base + '.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));

    // 1) 只照人物/背景：先在"还没盖灯光层"的画面上识别主体，把选区存进临时通道
    //    （必须赶在置入前——置入后的合成画面被灰色灯光层盖住，选择主体就废了）
    const chName = '橙子主体_' + Date.now();
    let subjectReady = false;
    if (maskMode !== 'all') {
      const sr = await ctx.sendToPSAwait({
        action: 'batchPlay',
        params: {
          commandName: '橙子打光：识别主体',
          descriptors: [
            { _obj: 'autoCutout', sampleAllLayers: true },
            { _obj: 'duplicate', _target: [{ _ref: 'channel', _property: 'selection' }], name: chName },
          ],
        },
      }, 60000);
      subjectReady = !!sr.ok;
      if (!sr.ok) olog('[打光] 主体识别失败（本层按全画面置入）: ' + (sr.error || ''), 'err');
    }

    // 2) 置入灯光层（贴回原选区+打组+组白蒙版，走现成placeBatch链路）
    const pr = await ctx.placeWithRetry('placeImage', { path: file, docId: pctx.docId || null, selection: pctx.selection || null, antiMode: 0 }, 120000);   // 0909：贴回带重试（PS 正忙瞬时失败）
    if (!pr.ok) {
      olog('[打光] 置入失败: ' + (pr.error || ''), 'err');
      return { ok: false, error: pr.error || '置入失败' };
    }

    // 3) 蒙版（如果主体通道就绪）+ 混合模式/不透明度，一次batchPlay完成
    const blend = (p && p.blend) || 'softLight';
    const opacity = (p && p.opacity != null) ? Number(p.opacity) : 100;
    const descs = [];
    if (subjectReady) {
      descs.push({ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _ref: 'channel', _name: chName } });
      if (maskMode === 'background') descs.push({ _obj: 'inverse' });
      descs.push({ _obj: 'select', _target: [{ _ref: 'layer', _name: base }], makeVisible: false });
      descs.push({ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealSelection' } });
      descs.push({ _obj: 'delete', _target: [{ _ref: 'channel', _name: chName }] });
    }
    descs.push({
      _obj: 'set',
      _target: [{ _ref: 'layer', _name: base }],
      to: {
        _obj: 'layer',
        mode: { _enum: 'blendMode', _value: blend },
        opacity: { _unit: 'percentUnit', _value: opacity },
      },
    });
    const br = await ctx.sendToPSAwait({
      action: 'batchPlay',
      params: { commandName: '橙子打光：蒙版与混合', descriptors: descs },
    }, 30000);
    if (!br.ok) olog('[打光] 已置入但蒙版/混合模式设置失败（请手动补）: ' + (br.error || ''), 'err');
    else {
      const scope = maskMode === 'subject' ? '只照人物' : maskMode === 'background' ? '只照背景' : '全画面';
      olog('✓ [打光] 灯光层已置入（' + scope + ' · ' + opacity + '%），蒙版可手动擦除微调');
    }

    // 4) 尽力还原用户原来的矩形选区（跑过选择主体才需要；失败无所谓）
    if (subjectReady && pctx.selection) {
      try {
        await ctx.sendToPSAwait({
          action: 'restoreSelection',
          params: { docId: pctx.docId || null, selection: pctx.selection },
        }, 15000);
      } catch {}
    }
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// AI灯光层批量生成：注册进生图进度卡（同一套任务对象）、日志卡每张报进度、不设超时不自动截断
ipcMain.handle('relight-ai-gen', async (_e, p) => {
  const count = Math.max(1, Math.min(4, (p && p.count) || 1));
  const pctx = (p && p.pctx) || {};
  const label = (p && p.label) ? String(p.label) : '';
  olog('▶ [打光] AI灯光层生成 ×' + count + (label ? '（' + label + '）' : ''));

  // 选区截图落盘：进度卡气泡组显示"本次输入"缩略图（与批量链同口径）
  const batchId = ctx.genBatchId();
  let inputFile = null;
  try {
    const dir = ctx.genDir();
    fs.mkdirSync(dir, { recursive: true });
    inputFile = path.join(dir, 'input_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.jpg');
    fs.writeFileSync(inputFile, Buffer.from(p.inputImage, 'base64'));
  } catch { inputFile = null; }

  let done = 0;
  const jobs = Array.from({ length: count }, () => {
    const task = ctx.genTaskAdd({
      batchId,
      prompt: p.prompt || '',   // 存完整提示词——进度卡点它植入提示词框必须拿到真件（原来只存了一行标签）
      tag: '[AI打光] ' + (label || '灯光层'),
      docId: pctx.docId || null,
      selection: pctx.selection || null,
      inputFile,
    });
    return ctx.generateOne({
      prompt: p.prompt, inputImage: p.inputImage, inputMime: p.inputMime || 'image/png',
      provider: p.provider, model: p.model, timeoutMs: 0,
      size: p.size || '2K',   // 0908：打光卡新增分辨率胶囊（1K/2K/4K，无Auto）
      ratio: ctx.effRatio ? ctx.effRatio(p.ratio, pctx.selection, false) : p.ratio,   // 打光必须有选区，不存在全图模式；Auto=跟选区（gen.js 同口径）
    }).then((r) => {
      done++;
      if (r.ok) {
        ctx.genTaskUpdate(task, { status: 'done', file: r.file });
        olog('[打光] 灯光层 ' + done + '/' + count + ' 完成');
      } else {
        ctx.genTaskUpdate(task, {
          status: /安全过滤|截断|SAFETY|RECITATION/.test(r.error || '') ? 'blocked' : 'error',
          error: r.error,
        });
        olog('[打光] 灯光层 ' + done + '/' + count + ' 失败: ' + (r.error || ''), 'err');
      }
      return r;
    }).catch((e) => {
      done++;
      ctx.genTaskUpdate(task, { status: 'error', error: e.message || String(e) });
      olog('[打光] 灯光层 ' + done + '/' + count + ' 异常: ' + (e.message || e), 'err');
      return { ok: false, error: e.message || String(e) };
    });
  });
  const rs = await Promise.all(jobs);
  const oks = rs.filter((r) => r && r.ok).map((r) => ({ file: r.file }));   // 0915：generateOne 已落盘，直接用文件（原 dataUrl=整图再编一遍 base64 的主线程浪费）
  const firstErr = (rs.find((r) => r && !r.ok) || {}).error || '';
  if (!oks.length) {
    olog('[打光] AI灯光层全部失败: ' + firstErr, 'err');
    return { ok: false, error: firstErr || '生成失败' };
  }
  olog('✓ [打光] AI灯光层生成完成 ' + oks.length + '/' + count);

  // 自动置入：跟随生图模式卡「自动回传」开关（默认开）。全部贴回+打组+组白蒙版（同生图批量置入口径）
  let placed = false;
  if (ctx.config.gen.autoReturn !== false) {
    // 复制成 relight_* 名字（PS 里图层名跟文件名走）；0915 顺手修掉这里引用不到 dir 的潜伏雷
    //（原 const dir 在上面 try 块里，这里够不着=ReferenceError 被逐张 catch 吃掉报"落盘失败"）
    const dir = ctx.genDir();
    const files = [];
    for (let i = 0; i < oks.length; i++) {
      try {
        if (!oks[i].file) continue;
        const fName = 'relight_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + (i > 0 ? '_' + i : '') + (path.extname(oks[i].file) || '.png');
        const fPath = path.join(dir, fName);
        fs.copyFileSync(oks[i].file, fPath);
        files.push(fPath);
      } catch (e) {
        olog('[打光] 落盘失败 #' + (i + 1) + ': ' + (e.message || e), 'err');
      }
    }
    if (!files.length) {
      olog('[打光] 所有灯光层落盘失败', 'err');
      return { ok: false, error: '落盘失败' };
    }

    // 批量置入（打组+组白蒙版）
    const pr = await ctx.placeWithRetry('placeBatch', {
      paths: files,
      docId: pctx.docId || null,
      selection: pctx.selection || null,
      antiMode: 0,
      group: true,
    }, 0);   // 不限时
    placed = !!pr.ok;
    if (!pr.ok) {
      olog('[打光] 批量置入失败: ' + (pr.error || ''), 'err');
    } else {
      // 置入成功后，设置混合模式+不透明度（组级别）
      const blend = p.blend || 'softLight';
      const opacity = p.opacity != null ? p.opacity : 100;
      // 找到刚建的组（组名 = 批次时间戳，桥接件 placeBatch 返回的 groupName）
      const groupName = pr.result && pr.result.groupName;
      if (groupName) {
        const br = await ctx.sendToPSAwait({
          action: 'batchPlay',
          params: {
            commandName: '橙子打光：设置混合模式',
            descriptors: [{
              _obj: 'set',
              _target: [{ _ref: 'layer', _name: groupName }],
              to: {
                _obj: 'layer',
                mode: { _enum: 'blendMode', _value: blend },
                opacity: { _unit: 'percentUnit', _value: opacity },
              },
            }],
          },
        }, 30000);
        if (!br.ok) olog('[打光] 已置入但混合模式设置失败（请手动设为柔光 ' + opacity + '%）: ' + (br.error || ''), 'err');
        else olog('✓ [打光] 灯光层已批量置入（柔光 ' + opacity + '%）×' + files.length + '——组内蒙版可手动擦除微调');
      } else {
        olog('✓ [打光] 灯光层已批量置入 ×' + files.length + '——请手动设为柔光 ' + opacity + '%');
      }
    }
  } else {
    olog('⬇ [打光] 自动回传已关闭：灯光层已生成未置入——打光卡点「置入PS」手动落地', 'err');
  }
  return { ok: true, results: oks, placed, error: oks.length < count ? firstErr : '' };
});
