// 来福桥接件：连接来福软件的本地WS，收到命令 -> batchPlay执行 -> 回执
// manifest里 host.data.loadEvent="startup" = PS开机就加载本插件（Adobe第一方插件同款字段，
// 实测第三方manifest v6也认，PS2026冷启动14秒握手）；没有它UXP只在面板被打开时才跑JS
const photoshop = require('photoshop');
const { app, core, action } = photoshop;

const WS_URL = 'ws://127.0.0.1:40125';
const statusEl = document.getElementById('status');
let ws = null;
let retryTimer = null;

function setStatus(connected) {
  statusEl.textContent = connected ? '● 已连接来福软件' : '● 未连接来福软件（自动重连中…）';
  statusEl.className = connected ? 'on' : 'off';
}

// ---------- 选区读取（两条路：DOM API优先，batchPlay后备；数值兼容裸数字/{_value}两种格式） ----------
const uv = (x) => (x && x._value !== undefined) ? x._value : x;

function readSelectionDOM() {
  try {
    const b = app.activeDocument.selection && app.activeDocument.selection.bounds;
    if (b && typeof b.left === 'number') {
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
  } catch (e) {}
  return null;
}

async function readSelectionBP() {
  try {
    const r = await action.batchPlay([{
      _obj: 'get',
      _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
    }], {});
    const s = r && r[0] && r[0].selection;
    if (s && s.left !== undefined) {   // 注意不能用 if(s.top)——top=0是合法值
      const sel = { left: uv(s.left), top: uv(s.top), right: uv(s.right), bottom: uv(s.bottom) };
      if ([sel.left, sel.top, sel.right, sel.bottom].every((n) => typeof n === 'number' && !isNaN(n))) return sel;
    }
  } catch (e) {}
  return null;
}

async function readSelection() {
  return readSelectionDOM() || (await readSelectionBP());
}

// ---------- 贴回对位（老插件 placeImageToSpecificDoc 同款序列；0908 真机 PS27 七组用例收敛到零残差） ----------
// 每轮：读 boundsNoEffects → transform 百分比（锚左上，宽高各自缩放到选区尺寸）→ 读 bounds → move 取整位移。
// PS 对百分比缩放会留 ±1~3px 取整残差，一轮后 |残差|≥1px 就再来一轮（读 bounds 重算），最多 3 轮。
// ⚠比例与选区不符的图会被拉伸填满（老插件同款）——比例该在生图请求端保证（软件端 Auto=跟选区）。
async function fitLayerToSel(layer, sel, notes) {
  const T = [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }];
  const sw = sel.right - sel.left, sh = sel.bottom - sel.top;
  if (!(sw > 0 && sh > 0)) return;
  await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: layer.id }], makeVisible: false }], {});
  const readB = async (prop) => {
    try {
      const r = await action.batchPlay([{ _obj: 'get', _target: [{ _property: prop }, ...T] }], {});
      const b = r && r[0] && r[0][prop];
      if (b && b.left !== undefined) {
        const o = { left: uv(b.left), top: uv(b.top), right: uv(b.right), bottom: uv(b.bottom) };
        if ([o.left, o.top, o.right, o.bottom].every((n) => typeof n === 'number' && !isNaN(n))) return o;
      }
    } catch (e) {}
    const d = layer.bounds;
    return { left: d.left, top: d.top, right: d.right, bottom: d.bottom };
  };
  const resid = (b) => ({ dx: sel.left - b.left, dy: sel.top - b.top, dw: sw - (b.right - b.left), dh: sh - (b.bottom - b.top) });
  const bad = (r) => Math.abs(r.dx) >= 1 || Math.abs(r.dy) >= 1 || Math.abs(r.dw) >= 1 || Math.abs(r.dh) >= 1;
  let b = await readB('boundsNoEffects');
  let r = resid(b);
  for (let pass = 0; pass < 3 && bad(r); pass++) {
    const lw = b.right - b.left, lh = b.bottom - b.top;
    if (!(lw > 0 && lh > 0)) break;
    const kx = sw / lw * 100, ky = sh / lh * 100;
    if (Math.abs(kx - 100) > 0.01 || Math.abs(ky - 100) > 0.01) {
      await action.batchPlay([{
        _obj: 'transform', _target: T,
        freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSCorner0' },
        width: { _unit: 'percentUnit', _value: kx },
        height: { _unit: 'percentUnit', _value: ky },
        interfaceIconFrameDimmed: { _enum: 'interpolationType', _value: 'bicubicAutomatic' },
      }], {});
    }
    b = await readB('bounds');
    const mx = sel.left - b.left, my = sel.top - b.top;
    if (Math.abs(mx) > 0.5 || Math.abs(my) > 0.5) {
      await action.batchPlay([{
        _obj: 'move', _target: T,
        to: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: Math.round(mx) }, vertical: { _unit: 'pixelsUnit', _value: Math.round(my) } },
      }], {});
      b = await readB('bounds');
    }
    r = resid(b);
  }
  if (bad(r)) notes.push('对位残差 dx=' + Math.round(r.dx) + ' dy=' + Math.round(r.dy) + ' dw=' + Math.round(r.dw) + ' dh=' + Math.round(r.dh));
}

// ---------- 命令执行器：后续所有模块（校色/特效/放大）都注册到这里 ----------
const handlers = {
  // demo命令：新建图层
  async createLayer(params) {
    if (!app.activeDocument) throw new Error('没有打开的文档');
    let layerName = null;
    await core.executeAsModal(async () => {
      const layer = await app.activeDocument.createLayer({ name: params.name || '来福图层' });
      layerName = layer.name;
    }, { commandName: '来福：新建图层' });
    return { layerName };
  },

  // 读取生成上下文：当前文档ID + 选区坐标 + 选区内容截图(base64, img2img输入)
  // 无选区时只返回文档ID（纯文生图）
  // 列出PS当前打开的全部文档（批处理用）
  async listDocs() {
    return { docs: app.documents.map((d) => ({ id: d.id, name: d.title || ('文档' + d.id) })) };
  },

  // 自动对齐：选中图层(上=返图)与其下一层(下=原图)跑PS官方「自动对齐图层」内容引擎；
  // 下层锁定=对齐参考基准（PS规则：锁定层不动,其余向它对齐）,只有上层被位移/缩放/透视校正
  async alignLayers() {
    let msg = '';
    await core.executeAsModal(async () => {
      const doc = app.activeDocument;
      if (!doc) throw new Error('没有打开的文档');
      const tops = [];
      for (const l of doc.layers) tops.push(l);
      if (tops.length < 2) throw new Error('至少需要两个图层（上=返图，下=原图）');
      // 选中层可能在组里（生成贴回默认打组）——一路上溯到它所属的顶层条目
      let cur = (doc.activeLayers && doc.activeLayers.length) ? doc.activeLayers[0] : null;
      let upper = null;
      while (cur) {
        for (const t of tops) { if (t.id === cur.id) { upper = t; break; } }
        if (upper) break;
        const p = cur.parent;
        cur = (p && p !== doc && typeof p.id === 'number') ? p : null;
      }
      if (!upper) upper = tops[0];
      let idx = -1;
      for (let i = 0; i < tops.length; i++) { if (tops[i].id === upper.id) { idx = i; break; } }
      const lower = (idx >= 0 && idx + 1 < tops.length) ? tops[idx + 1] : null;
      if (!lower) throw new Error('选中的已是最底层——请选中上面的返图图层再点对齐');
      const uid = upper.id, lid = lower.id;
      if (typeof uid !== 'number' || typeof lid !== 'number') {
        throw new Error('图层id读取异常（上=' + upper.name + '/' + uid + ' 下=' + lower.name + '/' + lid + '）');
      }
      // 锁定走applyLocking真通道——DOM的allLocked赋值在代理对象上静默无效（假成功），
      // 锁没锁上=对齐自由发挥连下层一起挪（下层是组时表现为"全动了"）
      const prevLock = !!lower.allLocked;
      const lockLower = (on) => action.batchPlay([
        { _obj: 'select', _target: [{ _ref: 'layer', _id: lid }], makeVisible: false },
        { _obj: 'applyLocking', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], layerLocking: on ? { _obj: 'layerLocking', protectAll: true } : { _obj: 'layerLocking', protectNone: true } },
      ], {});
      await lockLower(true);
      try {
        await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: uid }], makeVisible: false }], {});
        await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: lid }], selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' }, makeVisible: false }], {});
        await action.batchPlay([{
          _obj: 'align',
          _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }],
          using: { _enum: 'alignDistributeSelector', _value: 'ADSContent' },
          apply: { _enum: 'projection', _value: 'auto' },
        }], {});
      } finally {
        if (!prevLock) { try { await lockLower(false); } catch (e) {} }
      }
      try { await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: uid }], makeVisible: false }], {}); } catch (e) {}
      msg = '已把「' + upper.name + '」对齐到「' + lower.name + '」';
    }, { commandName: '来福：自动对齐' });
    return { msg };
  },

  // 读PS界面明暗档位（「跟随PS」主题用）：四档灰度枚举，只读不改
  async getUIPrefs() {
    const r = await action.batchPlay([{
      _obj: 'get',
      _target: [{ _property: 'interfacePrefs' }, { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }],
    }], {});
    const ip = r && r[0] && r[0].interfacePrefs;
    let lvl = ip && ip.kuiBrightnessLevel;
    if (lvl && lvl._value) lvl = lvl._value;
    return { brightness: String(lvl || '') };
  },

  async captureInput(params) {
    if (!app.activeDocument && !(params && params.docId)) throw new Error('没有打开的文档');
    // 用户点生成那一刻看着的文档=采集目标（命令已串行化，此刻没有我们自己的模态在切文档）
    let doc = app.activeDocument;
    let sel = null;
    let image = null;
    let note = '';
    // ⚠必须声明在 executeAsModal 回调外面：v56 把它写在回调里、return 却在外面引用 → 每次 captureInput 都抛
    //   "fullMode is not defined"，有没有选区都采不到（0912 用户实报"识别不到选区、重启也没用"，v5.18.39~42 全中招）
    let fullMode = false;
    await core.executeAsModal(async () => {
      // 批处理：先激活指定文档再读它的选区。v54：切换失败改成报错——原来只记 note 继续在当前文档上采集，
      // 返回的 docId 也是当前文档的 → 两张图的任务都记成同一个文档，回图全贴进一张图（批处理错位根因之一）
      if (params && params.docId) {
        await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: params.docId }] }], {});
        doc = app.activeDocument;
        if (!doc || doc.id !== params.docId) throw new Error('切换到文档 ' + params.docId + ' 失败（当前=' + (doc ? doc.id : '无') + '）');
      } else if (doc && app.activeDocument && app.activeDocument.id !== doc.id) {
        // 选区/像素都从"当前文档"读，必须与 doc 同一张
        await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
      }
      if (!doc) { note = note || '没有打开的文档'; return; }
      sel = await readSelection();
      // 全图比例兜底（0911 用户裁定）：没框选区就按**整幅画布的比例**跑（防蠢设计）——
      // 原来只把选区当全图、比例仍走 Auto（交给渠道自定），横版画布常被网关出成竖版或者反过来，
      // 贴回端是"非等比拉伸填满全图"，回来就是变形。这里直接带上整幅画布的宽高，软件端按它吸附到受支持比例。
      if (!sel) {
        note = '未检测到选区';
        // fullMode 回给软件端：这张是"没框选区、按整幅画布跑"的图 → 软件端把比例锁成原图比例（不受卡上比例影响）
        if (params && params.fullIfNoSel) {
          sel = { left: 0, top: 0, right: Math.round(doc.width), bottom: Math.round(doc.height) };
          fullMode = true;
          note = '无选区，按全图输入';
        }
      }

      if (sel) {
        const imaging = require('photoshop').imaging;
        const sw = sel.right - sel.left, sh = sel.bottom - sel.top;
        // 长边压到多少：默认 1568（控制云端生图的请求体积，老插件同思路）。
        // 0916 用户报"镜头色散清晰度很低"——辉光是**纯本地处理、根本不发网络**，这个上限对它纯属白丢画质
        //（实测辉光/色散层都是 1568×882，贴回 6000×4000 的 RAW 被拉 3.8 倍）。所以开成可传参：
        // 调用方给 params.maxEdge（辉光传大值），不给就还是 1568，生图那条链一点不受影响。
        const cap = (params && Number(params.maxEdge) > 0) ? Number(params.maxEdge) : 1568;
        const scale = Math.min(1, cap / Math.max(sw, sh));
        const opts = {
          documentID: doc.id,
          sourceBounds: { left: sel.left, top: sel.top, right: sel.right, bottom: sel.bottom },
          applyAlpha: true,
        };
        if (scale < 1) opts.targetSize = { width: Math.round(sw * scale), height: Math.round(sh * scale) };
        // 16/32位文档必须转8位取像素——JPEG只吃8位（Only 8 bit image data can be encoded as jpeg）；
        // 个别PS版本不认componentSize选项→去掉重试（校色模块同款兜底）
        opts.componentSize = 8;
        try {
          let px;
          try { px = await imaging.getPixels(opts); }
          catch (e8) { delete opts.componentSize; px = await imaging.getPixels(opts); }
          const antiMode = (params && params.antiMode) || 0;
          if (antiMode > 0) {
            // 抗截断三模式：1=纯上下翻转 2=纯色相反转180° 3=色相+翻转；回图时反向还原
            // 变换失败不丢图：自动降级为原图直发（note记录原因）
            try {
              const doFlip = (antiMode === 1 || antiMode === 3);
              const doHue = (antiMode === 2 || antiMode === 3);
              const src = px.imageData;
              const w = src.width, h = src.height, comp = src.components;
              const buf = await src.getData({});
              if (doHue) {
                const cl = (v) => v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
                for (let i = 0; i < w * h; i++) {
                  const o = i * comp;
                  const r = buf[o], g = buf[o + 1], b = buf[o + 2];
                  buf[o]     = cl(-0.574 * r + 1.430 * g + 0.144 * b);   // hueRotate(180)标准色彩矩阵
                  buf[o + 1] = cl(0.426 * r + 0.430 * g + 0.144 * b);
                  buf[o + 2] = cl(0.426 * r + 1.430 * g - 0.856 * b);
                }
              }
              if (doFlip) {
                const rowBytes = w * comp;
                const tmp = new Uint8Array(rowBytes);
                for (let y = 0; y < (h >> 1); y++) {
                  const a = y * rowBytes, b2 = (h - 1 - y) * rowBytes;
                  tmp.set(buf.subarray(a, a + rowBytes));
                  buf.copyWithin(a, b2, b2 + rowBytes);
                  buf.set(tmp, b2);
                }
              }
              const nd = await imaging.createImageDataFromBuffer(buf, {
                width: w, height: h, components: comp, componentSize: 8,
                colorSpace: src.colorSpace || 'RGB',
              });
              image = await imaging.encodeImageData({ imageData: nd, base64: true });
              try { nd.dispose(); } catch (e) {}
            } catch (eT) {
              note = '抗截断变换失败(已降级原图直发): ' + (eT.message || eT);
              image = await imaging.encodeImageData({ imageData: px.imageData, base64: true });
            }
          } else {
            image = await imaging.encodeImageData({ imageData: px.imageData, base64: true });
          }
          try { px.imageData.dispose(); } catch (e) {}
        } catch (e) {
          note = '截取选区像素失败: ' + (e.message || e);
        }
      }
    }, { commandName: '来福：读取选区' });
    return { docId: doc ? doc.id : null, selection: sel, fullMode, image, mime: 'image/jpeg', note };
  },

  // 复原选区：在原文档里重建当初生成时的矩形选区
  async restoreSelection(params) {
    await core.executeAsModal(async () => {
      if (params.docId) {
        const targetDoc = app.documents.find((d) => d.id === params.docId);
        if (targetDoc) {
          await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: params.docId }] }], {});
        }
      }
      if (!app.activeDocument) throw new Error('没有打开的文档');
      const s = params.selection;
      if (!s) throw new Error('该任务没有记录选区');
      await action.batchPlay([{
        _obj: 'set',
        _target: [{ _ref: 'channel', _property: 'selection' }],
        to: {
          _obj: 'rectangle',
          top: { _unit: 'pixelsUnit', _value: s.top },
          left: { _unit: 'pixelsUnit', _value: s.left },
          bottom: { _unit: 'pixelsUnit', _value: s.bottom },
          right: { _unit: 'pixelsUnit', _value: s.right },
        },
      }], {});
    }, { commandName: '来福：复原选区' });
    return {};
  },

  // 批量回图（魔改版逻辑移植）：整批依次贴入原文档原选区（间隔60ms）。
  // params.group=true（自动回传整批）→ 打进"来福 生成组"（标红/移顶/组上白蒙版/展开）；
  // 不带group（进度卡手动单张贴回）→ 免打组，每张图层独立+各自白蒙版（用户裁定）
  async placeBatch(params) {
    const notes = [];
    const lfs = require('uxp').storage.localFileSystem;
    const layerIds = [];
    // 用户此刻正看着的文档：贴完切回去（v54）。原来贴完就停在目标文档——用户在 B 图上框选时 A 图跑完把 PS 切到 A，
    // 用户没察觉继续点生成 = 采到 A 的选区/像素，"A 的图跑到 B、B 的跑到 A"就是这么串的
    const origId = app.activeDocument ? app.activeDocument.id : null;
    await core.executeAsModal(async () => {
      // 切到目标文档（发起时记录的docId）。⚠找不到（用户已把原图关了/换了文档）时原来悄悄落到"当前文档"——
      // 图就贴进另一张图的同坐标处=用户看到的"没放在原先框选的地方"（0909）。自动回传（group）改成明确报错、任务留在进度卡；
      // 进度卡手动点图（不带group）=用户明知故贴，允许落当前文档但 note 说明
      if (params.docId) {
        const targetDoc = app.documents.find((d) => d.id === params.docId);
        if (targetDoc) {
          await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: params.docId }] }], {});
          if (!app.activeDocument || app.activeDocument.id !== params.docId) throw new Error('切换到文档 ' + params.docId + ' 失败，未贴回（图已保留在进度卡）');
        } else if (params.group) {
          throw new Error('发起生成时的文档已关闭或找不到（id=' + params.docId + '），未贴回——重新打开原图后在进度卡点图手动贴回');
        } else {
          notes.push('原文档已关闭，已按原选区坐标贴到当前文档');
        }
      }
      if (!app.activeDocument) throw new Error('没有打开的文档');

      let sel = params.selection || null;
      if (!sel) sel = await readSelection();

      for (const p of (params.paths || [])) {
        try {
          const entry = await lfs.getEntryWithUrl('file:' + p.replace(/\\/g, '/'));
          const token = lfs.createSessionToken(entry);
          // 退出编组上下文再置入
          try {
            await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'front' }], makeVisible: false }], {});
          } catch (e) {}
          // 老插件同款守卫：记下置入前的活动图层id——placeEvent 在部分PS版本会静默失败且不新建图层，
          // 不校验的话后面的缩放/位移会直接打在用户原图层上（毁伤性拉伸）
          let prevId = null;
          try { prevId = app.activeDocument.activeLayers[0].id; } catch (e) {}
          let placeErr = '';
          try {
            await action.batchPlay([{
              _obj: 'placeEvent',
              null: { _path: token, _kind: 'local' },
              freeTransformCenterState: { _enum: 'quadCenterState', _value: 'QCSAverage' },
              offset: { _obj: 'offset', horizontal: { _unit: 'pixelsUnit', _value: 0 }, vertical: { _unit: 'pixelsUnit', _value: 0 } },
              _options: { dialogOptions: 'dontDisplay' },
            }], {});
          } catch (ePlace) { placeErr = ePlace.message || String(ePlace); }
          let layer = app.activeDocument.activeLayers[0];
          if (!layer || layer.id === prevId) {
            // 降级（老插件同款）：临时打开该文件→把图层复制进目标文档→关临时文档→切回目标文档
            const targetId = app.activeDocument.id;
            const tmpDoc = await app.open(entry);
            await action.batchPlay([{ _obj: 'duplicate', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], to: { _ref: 'document', _id: targetId } }], {});
            await tmpDoc.closeWithoutSaving();
            await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: targetId }] }], {});
            await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'front' }], makeVisible: false }], {});
            layer = app.activeDocument.activeLayers[0];
            if (!layer || layer.id === prevId) throw new Error('置入失败：placeEvent 与临时文档法均未新建图层（' + (placeErr || '无返回信息') + '）');
            notes.push('placeEvent未新建图层(' + (placeErr || '静默') + ')，已走临时文档复制法');
          }
          if (sel && layer) {
            try { await fitLayerToSel(layer, sel, notes); }
            catch (eFit) {
              // 描述符路径被拒（个别版本不认 transform 字段）→ 退回老的两步 DOM 法，至少不比以前差
              notes.push('transform对位失败，退回两步法: ' + (eFit.message || eFit));
              try {
                const b = layer.bounds;
                const lw = b.right - b.left, lh = b.bottom - b.top;
                const sw = sel.right - sel.left, sh = sel.bottom - sel.top;
                if (lw > 0 && lh > 0 && sw > 0 && sh > 0) {
                  await layer.scale(sw / lw * 100, sh / lh * 100);
                  const b2 = layer.bounds;
                  const dx = sel.left - b2.left, dy = sel.top - b2.top;
                  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) await layer.translate(dx, dy);
                }
              } catch (e2) { notes.push('两步法也失败: ' + (e2.message || e2)); }
            }
          }
          if (layer) {
            // 贴回图层一律转成「内嵌式智能对象」（=右键「转换为智能对象」那个操作）。
            // ⚠0916 用户实报：双击贴回的图打开的是 Camera Raw 滤镜而不是新窗口。根因=placeEvent 置入的是
            //   **文件外链式**智能对象（内容指向硬盘那个 jpg），PS 对 JPEG 的默认处理交给 Camera Raw 时双击就进 ACR。
            //   原来这段转换被关在 `params.antiMode > 0` 分支里，抗截断默认关着 → 正常贴回从来不转换 → 病根回来。
            //   现在栅格化+newPlacedLayer **无条件执行**：内容以 PSB 内嵌进文档，双击永远开新窗口，与 ACR 无关。
            // 抗截断还原（1=翻转 2=色相 3=色相+翻转）仍只在 antiMode>0 时做变换；0905修的两条不变：
            //   层id直选防targetEnum漂移；转智能对象无论前面成败都执行+重试一次（漏转=栅格层双击打不开，实测冤案）
            const lid = layer.id;
            const selById = async () => {
              await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: lid }], makeVisible: false }], {});
            };
            try {
              await selById();
              await action.batchPlay([{ _obj: 'rasterizeLayer', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
              if (params.antiMode === 1 || params.antiMode === 3) {
                await action.batchPlay([{ _obj: 'flip', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], axis: { _enum: 'orientation', _value: 'vertical' } }], {});
              }
              if (params.antiMode === 2 || params.antiMode === 3) {
                await action.batchPlay([{ _obj: 'hueSaturation', adjustment: [{ _obj: 'hueSatAdjustmentV2', hue: 180, saturation: 0, lightness: 0 }], colorize: false }], {});
              }
            } catch (e) { notes.push('栅格化' + (params.antiMode > 0 ? '/抗截断还原' : '') + '失败: ' + (e.message || e)); }
            let soOk = false;
            for (let tryN = 0; tryN < 2 && !soOk; tryN++) {
              try {
                await selById();
                await action.batchPlay([{ _obj: 'newPlacedLayer' }], {});
                soOk = true;
              } catch (e2) {
                if (tryN) notes.push('转成智能对象失败(该层双击将打不开): ' + (e2.message || e2));
                else await new Promise((r) => setTimeout(r, 120));
              }
            }
            const al = app.activeDocument.activeLayers[0];
            layerIds.push(al ? al.id : layer.id);
          }
        } catch (e) {
          notes.push('贴图失败: ' + (e.message || e));
        }
        await new Promise((r) => setTimeout(r, 60));
      }

      // 每张置入图层各自加白蒙版（0908用户裁定：自动回传打组也要每图一蒙版，不是只给组一个）
      // 先逐层加，再打组；打完组在组上也加一张（0908第16轮用户裁定：图层与文件夹两级都要白蒙版）
      for (const id of layerIds) {
        try {
          await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: id }], makeVisible: false }], {});
          await action.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }], {});
        } catch (e) {
          notes.push('加蒙版失败: ' + (e.message || e));
        }
      }
      if (layerIds.length && params.group) {
        // 自动回传整批：打组（老插件createGroupAndMask移植：组名用顶层name参数，坑12）
        try {
          const targets = layerIds.map((id) => ({ _ref: 'layer', _id: id }));
          await action.batchPlay([{ _obj: 'select', _target: targets, selectionModifier: { _enum: 'selectionModifierType', _value: 'replaceSelection' }, makeVisible: false }], {});
          // 组名：顶层 name 在 PS27/UXP 下不生效（0908 真机读回"组 1"），using.layerSection.name 生效；两种都带兼容老版本
          await action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layerSection' }], from: { _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }, using: { _obj: 'layerSection', name: '来福 生成组' }, name: '来福 生成组' }], {});
          await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'layer', color: { _enum: 'color', _value: 'red' } } }], {});
          await action.batchPlay([{ _obj: 'move', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], to: { _ref: 'layer', _enum: 'ordinal', _value: 'front' } }], {});
          await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], makeVisible: false }], {});
          // 组上白蒙版（第16轮）：与组内每层的蒙版并存
          try {
            await action.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }], {});
          } catch (eGm) { notes.push('组蒙版失败: ' + (eGm.message || eGm)); }
          await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }], to: { _obj: 'layer', layerSectionExpanded: true } }], {});
        } catch (e) {
          notes.push('打组失败: ' + (e.message || e));
        }
      }
      // 自动回传（group）贴完切回用户发起时正看着的文档（v54）；进度卡手动点图=用户想看结果，停在目标文档；原文档已关则不切
      if (params.group && origId && params.docId && origId !== params.docId && app.documents.find((d) => d.id === origId)) {
        try { await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: origId }] }], {}); }
        catch (e) { notes.push('切回原文档失败: ' + (e.message || e)); }
      }
    }, { commandName: '来福：批量回图' });
    return { placed: layerIds.length, note: notes.join(' | ') };
  },

  // 单张置入=单元素批量（点进度卡的图重贴时用，同样是 图片+蒙版 免打组）
  async placeImage(params) {
    return handlers.placeBatch({ paths: [params.path], docId: params.docId, selection: params.selection, antiMode: params.antiMode || 0 });
  },

  // 导入选框工具预设（老插件同款机制，跨PS版本稳定）：插件内 presets/marquee.tpl 里预存
  // "来福预设_<比例>"16个固定比例工具预设，set toolPreset append:true 追加进PS（不覆盖用户已有）。
  // ⚠桌面版此前从未移植这一步（只有"选用手录预设"），所以用户全走描述符直设=各版PS表现不一(1:0.001)。
  // 幂等：重复导入只是同名预设再追加一份，PS按名select取第一份，无害；软件端每次连桥接只调一次。
  async importMarqueePresets() {
    const lfs = require('uxp').storage.localFileSystem;
    let tplFile = null;
    try {
      const pluginFolder = await lfs.getPluginFolder();
      const dir = await pluginFolder.getEntry('presets');
      tplFile = await dir.getEntry('marquee.tpl');
    } catch (e) { return { ok: false, error: '插件内未找到 presets/marquee.tpl: ' + (e.message || e) }; }
    const token = await lfs.createSessionToken(tplFile);
    let result = null;
    await core.executeAsModal(async () => {
      result = await action.batchPlay([{
        _obj: 'set',
        _target: [
          { _property: 'toolPreset', _ref: 'property' },
          { _enum: 'ordinal', _ref: 'application', _value: 'targetEnum' },
        ],
        append: true,
        to: { _kind: 'local', _path: token },
      }], { synchronousExecution: true });
    }, { commandName: '来福：导入选框工具预设' });
    const err = Array.isArray(result) && result.find((x) => x && x._obj === 'error');
    if (err) return { ok: false, error: err.message || '导入失败' };
    return { ok: true, imported: true };
  },

  // 比例联动PS矩形选框工具：
  // 1) 激活选框工具 → 2) 按名选工具预设（先"来福预设_<比例>"=tpl自带，再"来福选框_<比例>"=用户手录）
  // 3) 都没有才走描述符直设（自发现键名→set→读回验证；无单位比例值优先）→ 4) 保底直接画该比例选区
  // 每步结果进diag随结果返回（软件端落glass日志），失败也不抛错不阻塞生成
  async syncMarqueeAspect(params) {
    const aspect = params && params.aspect;
    if (!aspect) throw new Error('比例为空');
    // tpl 内预设名用老插件前缀；2.35:1 的 tpl 等价名是 21:9 之外没有，落到直设/保底
    const presetNames = ['来福预设_' + aspect, '来福选框_' + aspect, '来福预设_' + aspect, '来福选框_' + aspect];
    const diag = { readKeys: null, tried: [], verified: false };

    await core.executeAsModal(async () => {
      const run = (cmds) => action.batchPlay(cmds, { synchronousExecution: true });
      const APP_TGT = [{ _property: 'currentToolOptions' }, { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }];
      const readOpts = () => {
        try {
          const r = run([{ _obj: 'get', _target: APP_TGT }]);
          const d = Array.isArray(r) ? r[0] : null;
          return (d && (d.currentToolOptions || d)) || {};
        } catch (e) { return {}; }
      };

      // 1) 激活矩形选框工具（不激活时 select toolPreset 报"命令'选择'当前不可用"，老插件实证）
      run([{ _obj: 'select', _target: [{ _ref: 'marqueeRectTool' }] }]);

      // 2) 工具预设优先（PS原生机制，跨版本稳定）：tpl自带名 → 用户手录名
      if (aspect !== 'Auto') {
        for (const presetName of presetNames) {
          try {
            const pr = run([{ _obj: 'select', _target: [{ _name: presetName, _ref: 'toolPreset' }] }]);
            const err = Array.isArray(pr) && pr.find((x) => x && x._obj === 'error');
            if (!err) { diag.verified = 'preset:' + presetName; return; }
            diag.tried.push('preset缺:' + presetName);
          } catch (e) { diag.tried.push('preset抛:' + presetName); }
        }
      }

      // 3) 读真实工具选项 → 自发现键名（样式枚举键/宽高键）
      const opts = readOpts();
      const dump = {};
      for (const k in opts) {
        const v = opts[k];
        if (v && typeof v === 'object' && v._enum) dump[k] = v._enum + ':' + v._value;
        else if (typeof v === 'number') dump[k] = v;
        else if (v && typeof v === 'object' && v._unit) dump[k] = v._unit + ':' + v._value;
      }
      diag.readKeys = dump;
      let styleKey = null, styleEnum = 'marqueeStyle';
      for (const k in opts) {
        const v = opts[k];
        if (v && typeof v === 'object' && v._enum
            && /style|constrain|marquee|geometr/i.test(k + ' ' + v._enum + ' ' + String(v._value))) {
          styleKey = k; styleEnum = v._enum; break;
        }
      }
      let widthKey = null, heightKey = null;
      for (const k in opts) {
        if (!widthKey && /width/i.test(k)) widthKey = k;
        if (!heightKey && /height/i.test(k)) heightKey = k;
      }

      const ratioWH = (a) => {
        if (a === '2.35:1') return [47, 20];   // 2.35整数等价47:20
        const m = String(a).split(':').map(Number);
        return (m.length === 2 && m[0] > 0 && m[1] > 0) ? [m[0], m[1]] : [1, 1];
      };
      const [aw, ah] = ratioWH(aspect);
      const mirror = (sample, n) => (sample && typeof sample === 'object' && sample._unit)
        ? { _unit: sample._unit, _value: n } : n;

      // 4) 实测定稿(诊断得知)：样式键=selectionEnum整数(0=正常选框)；宽高键在样式开启前不出现在描述符里
      //    流程：设selectionEnum→读回验证→样式开启后再读(宽高键现形)→逐族尝试宽高键
      // 写入双路径：application属性路径 + 工具类直接目标（UXP里brush族实证后者才生效）
      const SET_TGTS = [APP_TGT, [{ _ref: 'marqueeRectTool' }]];
      const setAndRead = (patch, label, tgtIdx) => {
        try { run([{ _obj: 'set', _target: SET_TGTS[tgtIdx || 0], to: Object.assign({ _obj: 'currentToolOptions' }, patch) }]); }
        catch (e) { diag.tried.push(label + ':throw'); return null; }
        return readOpts();
      };
      const fullDump = (o) => {
        const d = {};
        for (const k in o) {
          const v = o[k];
          if (v == null) d[k] = String(v);
          else if (typeof v !== 'object') d[k] = typeof v === 'number' ? v : String(v);
          else if (v._unit) d[k] = v._unit + ':' + v._value;
          else if (v._enum) d[k] = v._enum + ':' + v._value;
          else d[k] = fullDump(v);   // 嵌套对象展开（$MrqI这种套娃就是靠这个现形的）
        }
        return d;
      };

      if (aspect === 'Auto') {
        // Auto=恢复正常选框。先试预设（tpl自带"来福预设_Auto"→用户手录"来福选框_Auto"）
        for (const pn of ['来福预设_Auto', '来福选框_Auto', '来福预设_Auto', '来福选框_Auto']) {
          try {
            const pr = run([{ _obj: 'select', _target: [{ _name: pn, _ref: 'toolPreset' }] }]);
            const err = Array.isArray(pr) && pr.find((x) => x && x._obj === 'error');
            if (!err) { diag.verified = 'preset:' + pn; break; }
          } catch (e) {}
        }
        if (!diag.verified) {
          // 直写selectionEnum=0：⚠两条路径都强制写、不因读回"已是0"早退——
          // application路径的读回不可信(报0但真实工具没动),工具直连(t1)才是真生效路径
          for (const t of [1, 0]) {
            const back = setAndRead({ selectionEnum: 0 }, 'auto0@t' + t, t);
            diag.tried.push('t' + t + ':selectionEnum=0→' + (back ? back.selectionEnum : '?'));
          }
          diag.verified = 'selectionEnum:0-forced';
        }
      } else {
        // 约束比例：selectionEnum先试1再试2 × 双写入路径（PS选框样式下拉=正常/固定比例/固定大小）
        styleLoop:
        for (let t = 0; t < SET_TGTS.length; t++) {
          for (const sv of [1, 2]) {
            const back = setAndRead({ selectionEnum: sv }, 'style' + sv + '@t' + t, t);
            diag.tried.push('t' + t + ':selectionEnum=' + sv + '→' + (back ? back.selectionEnum : '?'));
            if (!back || back.selectionEnum !== sv) continue;
            // 样式已开启：重读描述符，宽高键此时应已现形
            diag.afterStyle = fullDump(back);
            let wk = null, hk = null;
            for (const k in back) {
              if (/F$|feather/i.test(k)) continue;   // $MrqF=羽化，排除
              if (!wk && /width|W$|Wdth/i.test(k)) wk = k;
              if (!hk && /height|H$|Hght/i.test(k)) hk = k;
            }
            const families = [];
            const deffered = [];   // 带单位的克隆/直设字段：放最后兜底（PS比例字段要无单位，见下）
            // 实测定稿：宽高住在$MrqI嵌套对象里——克隆原对象、只换宽高字段整体写回（首选）
            const inner = back.$MrqI;
            if (inner && typeof inner === 'object' && !inner._unit && !inner._enum) {
              const clone = {};
              for (const k in inner) clone[k] = inner[k];
              let iwk = null, ihk = null;
              for (const k in inner) {
                if (/F$|feather/i.test(k)) continue;
                if (!iwk && /width|W$|Wdth/i.test(k)) iwk = k;
                if (!ihk && /height|H$|Hght/i.test(k)) ihk = k;
              }
              if (!iwk || !ihk) {   // 模式认不出就取前两个数值字段当宽高
                const nums = Object.keys(inner).filter((k) => typeof inner[k] === 'number' || (inner[k] && inner[k]._unit));
                if (nums.length >= 2) { iwk = nums[0]; ihk = nums[1]; }
              }
              if (iwk && ihk) {
                clone[iwk] = mirror(inner[iwk], aw);
                clone[ihk] = mirror(inner[ihk], ah);
                // 带单位的放最后兜底（$MrqI克隆自原描述符，可能保留pixelsUnit）
                deffered.push({ $MrqI: clone });
                diag.mrqiKeys = iwk + '/' + ihk;
              }
            }
            if (wk && hk) deffered.push({ [wk]: mirror(back[wk], aw), [hk]: mirror(back[hk], ah) });
            // ⚠无单位比例值必须优先于带单位的：PS"固定比例"选框的宽高字段是无单位比例值(分子/分母)，
            // 若喂带pixelsUnit的值被PS当像素解读→比例错乱(实测1:0.001/1:0.0001)。$MrqW/$MrqH与width/height都是纯数字。
            families.push({ $MrqW: aw, $MrqH: ah });
            families.push({ width: aw, height: ah });
            families.push(...deffered);
            for (const fam of families) {
              const b2 = setAndRead(fam, 'wh:' + Object.keys(fam).join('/'), t);
              if (!b2) continue;
              diag.tried.push('wh(' + Object.keys(fam).join('/') + ')→' + JSON.stringify(fullDump(b2)).slice(0, 300));
              const kk = Object.keys(fam)[0];
              let rv = b2[kk];
              // $MrqI套娃：验证要钻进去比里面的宽字段
              if (kk === '$MrqI' && rv && typeof rv === 'object' && diag.mrqiKeys) {
                rv = rv[diag.mrqiKeys.split('/')[0]];
              }
              const rvNum = (rv && typeof rv === 'object') ? rv._value : rv;
              if (rvNum === aw) { diag.verified = 'selectionEnum:' + sv + '+' + kk + '@t' + t; break; }
            }
            if (!diag.verified) diag.verified = 'style-only:' + sv + '@t' + t;
            break styleLoop;
          }
        }
        // 保底硬招：工具约束写不进去→直接在文档中央生成该比例的选区（用户可移动/变换后直接跑图）
        if (!diag.verified && app.activeDocument) {
          try {
            const doc = app.activeDocument;
            const dw = Number(doc.width), dh = Number(doc.height);
            let sw = dw * 0.7, sh = sw * ah / aw;
            if (sh > dh * 0.7) { sh = dh * 0.7; sw = sh * aw / ah; }
            const L = Math.round((dw - sw) / 2), T = Math.round((dh - sh) / 2);
            run([{
              _obj: 'set',
              _target: [{ _property: 'selection' }, { _ref: 'document', _enum: 'ordinal', _value: 'targetEnum' }],
              to: {
                _obj: 'rectangle',
                top: { _unit: 'pixelsUnit', _value: T },
                left: { _unit: 'pixelsUnit', _value: L },
                bottom: { _unit: 'pixelsUnit', _value: T + Math.round(sh) },
                right: { _unit: 'pixelsUnit', _value: L + Math.round(sw) },
              },
            }]);
            diag.verified = 'fallback-selection';
          } catch (e) { diag.tried.push('fallbackSel:' + (e.message || 'throw')); }
        }
      }
    }, { commandName: '同步选框比例 ' + aspect });

    return {
      synced: aspect,
      note: diag.verified ? ('联动生效(' + diag.verified + ')') : '直设未生效(见diag)',
      diag,
    };
  },

  // 通用batchPlay通道：软件端可直接下发descriptor数组（迁移老模块时用）
  async batchPlay(params) {
    let result = null;
    await core.executeAsModal(async () => {
      result = await action.batchPlay(params.descriptors, {});
    }, { commandName: params.commandName || '来福：批处理' });
    return { result };
  },

  // 开机自装选框预设的状态（软件端握手时若还是pending，稍后主动来问；推送在PS开机阶段丢过）
  async presetImportState() { return { state: presetImportState }; },
};

// ---------- 老插件host模块加载（校色三工具原样移植） ----------
let hostRegistry = {};
let hostLoadErr = '';
try {
  const HostShim = require('./host-api.js');
  require('./colorcal.host.js');
  hostRegistry = HostShim._registry;
} catch (e) {
  hostLoadErr = e.message || String(e);
  console.error('校色host模块加载失败:', e);
}
// 老模块的ctx.sendToPanel → 推流消息(无id)发回软件端
const hostCtx = {
  sendToPanel(channel, data) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ push: channel, data }));
  },
};

// 文档级命令串行队列（v54）：软件端多个批次并发（用户连点 A/B/C 三张图生成），采集/贴回在这里会交错——
// captureInput 在进模态前读 activeDocument、placeBatch 在模态里切文档，两条链交错 = 采到别人的文档/贴进别人的文档。
// 只读命令（listDocs/ping/getUIPrefs/presetImportState）不排队，其余全部一个接一个跑。
const SERIAL_SKIP = new Set(['listDocs', 'getUIPrefs', 'presetImportState', 'importMarqueePresets', 'syncMarqueeAspect']);
let serialChain = Promise.resolve();
// 单个命令最长占链 10 分钟（v55）：某条命令在 PS 里卡死（弹着对话框不回）时不至于把后面所有命令永远堵住；
// 10 分钟远大于最大批量贴回耗时，正常命令不会被提前放行
function runSerial(fn) {
  const p = serialChain.then(fn, fn);
  const guard = new Promise((res) => setTimeout(res, 600000));
  serialChain = Promise.race([p, guard]).then(() => {}, () => {});
  return p;
}

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const { id, action: act, params } = msg;
  const reply = { id, ok: false };
  try {
    const fn = handlers[act];
    let job;
    if (fn) {
      job = async () => { reply.result = await fn(params || {}); };
    } else if (hostRegistry[act]) {
      job = async () => { await hostRegistry[act](params || {}, hostCtx); reply.result = {}; };   // 结果细节走push通道
    } else {
      throw new Error('未知命令: ' + act);
    }
    if (SERIAL_SKIP.has(act)) await job(); else await runSerial(job);
    reply.ok = true;
  } catch (e) {
    reply.error = e.message || String(e);
  }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(reply));
}

// ---------- 连接管理：断线自动重连 ----------
function connect() {
  try { ws = new WebSocket(WS_URL); } catch { scheduleRetry(); return; }

  ws.onopen = () => {
    setStatus(true);
    // 版本握手：软件端据此判断桥接件是否为旧版（提醒Reload）
    try {
      ws.send(JSON.stringify({
        hello: true, version: 59,
        presetImport: presetImportState,
        colorcal: Object.keys(hostRegistry).join(','),
        hostErr: hostLoadErr || undefined,
      }));
    } catch (e) {}
  };
  ws.onmessage = (e) => handleMessage(e.data);
  ws.onclose = () => { setStatus(false); scheduleRetry(); };
  ws.onerror = () => { /* onclose会跟着触发 */ };
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 3000);
}

// ---------- 开机自装选框工具预设（0908用户裁定"装上就有"，不再等切比例）----------
// loadEvent=startup 让本插件随PS开机加载 → 这里查一眼PS现有工具预设里有没有"来福预设_Auto"，
// 没有才导入 presets/marquee.tpl（有=跳过，杜绝每次开机追加一份重复）。老插件和软件端的"切比例时导"仍保留作兜底。
// PS刚开机时executeAsModal可能还不可用 → 失败按 4s/15s/40s 三次重试；结果记在 presetImportState，握手时带给软件端。
let presetImportState = 'pending';
async function hasOrangePresets() {
  const r = await action.batchPlay([{
    _obj: 'get',
    _target: [{ _property: 'presetManager' }, { _ref: 'application', _enum: 'ordinal', _value: 'targetEnum' }],
  }], { synchronousExecution: true });
  const pm = r && r[0] && r[0].presetManager;
  if (!Array.isArray(pm)) throw new Error('presetManager 不可读');
  return pm.some((k) => k && Array.isArray(k.name) && k.name.indexOf('来福预设_Auto') !== -1);
}
async function ensureMarqueePresets(attempt) {
  try {
    if (await hasOrangePresets()) presetImportState = 'exists';   // ⚠不能提前return：终态同样要通知软件端（实证漏发）
    else {
      const r = await handlers.importMarqueePresets();
      presetImportState = r.ok ? 'imported' : ('err:' + (r.error || ''));
    }
  } catch (e) {
    presetImportState = 'err:' + (e.message || e);
  }
  if (presetImportState.indexOf('err:') === 0 && attempt < 2) {
    setTimeout(() => ensureMarqueePresets(attempt + 1), [15000, 40000][attempt]);
    return;
  }
  // 终态通知软件端（连着才发；没连上则握手时随hello带过去）
  try { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ presetImport: presetImportState })); } catch (e) {}
}
setTimeout(() => ensureMarqueePresets(0), 4000);

setStatus(false);
connect();
