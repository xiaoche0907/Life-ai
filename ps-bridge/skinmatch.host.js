// 肤色统一专用桥接：在目标蒙版组内创建「皮肤蒙版 + 原生调整层」子组。
// 蒙版写入路径已真机验证：建白蒙版 → 选中蒙版通道 → doc.paste() 灰度 → 退回组上下文。
// 真实 PS 残留风险控制：失败时 suspendHistory 回滚整个事务。
const { app, action, core, imaging, constants } = require('photoshop');
const native = require('./recolor-native');
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
  return placeInside(params);
}

async function placeInside(params) {
  const doc = (app.documents || []).find(d => d.id === params.docId);
  if (!doc) throw Error('源文档已关闭，请重新读取PS文档');
  const recipe = native.validate(params.recipe);
  const maskBytes = fromBase64(params.maskB64 || '');
  const mw = params.maskWidth, mh = params.maskHeight;
  if (!mw || !mh || maskBytes.length !== mw * mh) throw Error('皮肤蒙版数据尺寸不一致');
  let groupName = '';
  let modalResult = null;
  await core.executeAsModal(async executionContext => {
    // 目标组校验复用批量改色逻辑（穿透蒙版组）
    const target = await host.targetGroup(doc, params.layerId);
    groupName = target.name;
    const targetInfo = await host.descriptor(target.id, doc.id);
    const blend = targetInfo.mode && targetInfo.mode._value;
    if (blend && blend !== 'passThrough') throw Error('目标蒙版组必须为「穿透」混合模式，请在PS修改后重试');
    await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
    const history = await executionContext.hostControl.suspendHistory({ documentID: doc.id, name: '来福：创建肤色统一调整组' });
    let success = false, savedSelection = null;
    try {
      try { const selected = await imaging.getSelection({ documentID: doc.id }); if (selected && selected.imageData) savedSelection = selected; } catch (_) {}
      await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {});
      // 1. 创建子组（穿透）
      const group = await doc.createLayerGroup({ name: params.name || '肤色统一' });
      group.visible = false;
      await group.move(target, constants.ElementPlacement.PLACEINSIDE);
      await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _id: group.id }], to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: 'passThrough' } } }], {});
      // 2. 组白蒙版（真机验证键名）
      await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: group.id }], makeVisible: false }], {});
      await action.batchPlay([{ _obj: 'make', new: { _class: 'channel' }, at: { _ref: 'channel', _enum: 'channel', _value: 'mask' }, using: { _enum: 'userMaskEnabled', _value: 'revealAll' } }], {});
      // 3. 皮肤灰度写入蒙版：临时像素层（batchPlay建，与色卡同款）→ 复制 → 选蒙版通道 → paste → 删临时层
      await action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: '__skin_mask_tmp__' } }], {});
      const temp = doc.activeLayers[0];
      if (!temp) throw Error('PS没有返回新创建的临时层');
      const buf = new Uint8Array(mw * mh * 4);
      for (let i = 0; i < mw * mh; i++) {
        const v = maskBytes[i];
        buf[i * 4] = v; buf[i * 4 + 1] = v; buf[i * 4 + 2] = v; buf[i * 4 + 3] = 255;
      }
      const imageData = await imaging.createImageDataFromBuffer(buf, { width: mw, height: mh, components: 4, colorSpace: 'RGB', componentSize: 8, chunky: true });
      await imaging.putPixels({ documentID: doc.id, layerID: temp.id, imageData, targetBounds: { left: 0, top: 0 }, commandName: '皮肤蒙版暂存' });
      imageData.dispose();
      // 放大蒙版到文档尺寸：直接 putPixels 到目标区域会缩小不了——改用整文档尺寸蒙版
      // （maskWidth/Height 由渲染端缩放为文档像素尺寸后传入，不再需要 PS 侧缩放）
      await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: temp.id }], makeVisible: false }], {});
      await action.batchPlay([{ _obj: 'set', _target: [{ _property: 'selection' }, { _ref: 'document', _id: doc.id }], to: { _obj: 'rectangle', top: { _unit: 'pixelsUnit', _value: 0 }, left: { _unit: 'pixelsUnit', _value: 0 }, bottom: { _unit: 'pixelsUnit', _value: doc.height }, right: { _unit: 'pixelsUnit', _value: doc.width } } }], {});
      await action.batchPlay([{ _obj: 'copy', _target: [{ _ref: 'layer', _enum: 'ordinal', _value: 'targetEnum' }] }], {});
      await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'layer', _id: group.id }], makeVisible: false }], {});
      await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'channel', _enum: 'channel', _value: 'mask' }, { _ref: 'layer', _id: group.id }] }], {});
      await action.batchPlay([{ _obj: 'paste', antiGate: { _enum: 'antiGateType', _value: 'antiGateNone' } }], {});
      await action.batchPlay([{ _obj: 'delete', _target: [{ _ref: 'layer', _id: temp.id }] }], {});
      await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {});
      // 4. 原生调整层（复用批量改色的创建循环）
      const layerIds = [];
      for (const layer of recipe.layers) {
        const response = await action.batchPlay([native.descriptor(layer)], {});
        if (response.some(r => r._obj === 'error')) throw Error(response.find(r => r._obj === 'error').message || '创建原生调整层失败');
        const created = doc.activeLayers[0];
        if (!created || created.id === group.id || created.kind === constants.LayerKind.GROUP) throw Error('PS没有返回新创建的调整层');
        await created.move(group, constants.ElementPlacement.PLACEINSIDE);
        if (layer.fillOpacity !== 1) await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _id: created.id }], to: { _obj: 'layer', fillOpacity: { _unit: 'percentUnit', _value: layer.fillOpacity * 100 } } }], {});
        layerIds.push(created.id);
      }
      group.visible = true;
      success = true;
      modalResult = { groupId: group.id, layerIds };
      return modalResult;
    } finally {
      try { if (savedSelection) await imaging.putSelection({ documentID: doc.id, imageData: savedSelection.imageData, targetBounds: { left: savedSelection.sourceBounds ? savedSelection.sourceBounds.left : 0, top: savedSelection.sourceBounds ? savedSelection.sourceBounds.top : 0 }, replace: true }); }
      catch (error) { success = false; throw error; }
      finally {
        if (savedSelection) savedSelection.imageData.dispose();
        await executionContext.hostControl.resumeHistory(history, success);
      }
    }
  }, { commandName: '来福：创建肤色统一工程' });
  return { ok: true, layerId: params.layerId, groupName, groupId: modalResult && modalResult.groupId, native: true };
}
module.exports = { place };
