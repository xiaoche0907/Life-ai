// 比例调整专用桥接：形变图作为原蒙版组内新像素图层（原图层保留）。
// putPixels 路径已在真机验证（colorcal 色卡 + diag5c 128px）。
const { app, action, core, imaging, constants } = require('photoshop');
const host = require('./recolor.host');

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fromBase64(text) {
  const result = new Uint8Array(text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0));
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    const value = (alphabet.indexOf(text[i]) << 18) | (alphabet.indexOf(text[i + 1]) << 12) | (Math.max(0, alphabet.indexOf(text[i + 2])) << 6) | Math.max(0, alphabet.indexOf(text[i + 3]));
    if (at < result.length) result[at++] = (value >>> 16) & 255;
    if (at < result.length) result[at++] = (value >>> 8) & 255;
    if (at < result.length) result[at++] = value & 255;
  }
  return result;
}

async function place(params) {
  const doc = (app.documents || []).find(d => d.id === params.docId);
  if (!doc) throw Error('源文档已关闭，请重新读取PS文档');
  const raw = fromBase64(params.rgbaB64 || '');
  const w = params.width, h = params.height;
  if (!w || !h || raw.length !== w * h * 4) throw Error('形变图数据尺寸不一致');
  let layerName = '';
  await core.executeAsModal(async executionContext => {
    const target = await host.targetGroup(doc, params.layerId);
    layerName = target.name;
    await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
    const history = await executionContext.hostControl.suspendHistory({ documentID: doc.id, name: '来福：比例调整形变层' });
    let success = false, savedSelection = null;
    try {
      try { const selected = await imaging.getSelection({ documentID: doc.id }); if (selected && selected.imageData) savedSelection = selected; } catch (_) {}
      await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {});
      // 建像素层（batchPlay，真机验证路径）
      await action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: params.name || '比例调整' } }], {});
      const layer = doc.activeLayers[0];
      if (!layer) throw Error('PS没有返回新创建的图层');
      // 写入形变像素（RGBA → putPixels；PS位图是BGR序，主进程未转换，这里转换）
      const buf = new Uint8Array(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        buf[i * 4] = raw[i * 4 + 2];     // R ← B
        buf[i * 4 + 1] = raw[i * 4 + 1]; // G
        buf[i * 4 + 2] = raw[i * 4];     // B ← R
        buf[i * 4 + 3] = 255;
      }
      const img = await imaging.createImageDataFromBuffer(buf, { width: w, height: h, components: 4, colorSpace: 'RGB', componentSize: 8, chunky: true });
      await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: img, targetBounds: { left: 0, top: 0 }, commandName: '比例形变写入' });
      img.dispose();
      // 移入目标组内置顶
      await layer.move(target, constants.ElementPlacement.PLACEINSIDE);
      // 目标组内置顶（移动到组内最上）
      try { await action.batchPlay([{ _obj: 'move', _target: [{ _ref: 'layer', _id: layer.id }], to: { _ref: 'layer', _enum: 'ordinal', _value: 'front' } }], {}); } catch (eM) {}
      success = true;
      return { layerId: layer.id, layerName: layer.name, groupName: target.name };
    } finally {
      try { if (savedSelection) await imaging.putSelection({ documentID: doc.id, imageData: savedSelection.imageData, targetBounds: { left: savedSelection.sourceBounds ? savedSelection.sourceBounds.left : 0, top: savedSelection.sourceBounds ? savedSelection.sourceBounds.top : 0 }, replace: true }); }
      catch (error) { success = false; throw error; }
      finally {
        if (savedSelection) savedSelection.imageData.dispose();
        await executionContext.hostControl.resumeHistory(history, success);
      }
    }
  }, { commandName: '来福：创建比例调整层' });
  return { ok: true, layerId: params.layerId, groupName: layerName, layerName: params.name || '比例调整', native: true };
}

module.exports = { place };
