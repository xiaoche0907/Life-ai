// 批量改色专用桥接。只读取用户文档；结果追加到明确指定的蒙版组。
const { app, action, core, imaging, constants } = require('photoshop');

function documentById(id) {
  const doc = id ? Array.from(app.documents).find(d => d.id === id) : app.activeDocument;
  if (!doc) throw Error('源文档已关闭，请重新读取PS文档');
  return doc;
}
function findGroup(layers, id) {
  for (const layer of layers) {
    if (layer.id === id && layer.kind === constants.LayerKind.GROUP) return layer;
    if (layer.layers) { const found = findGroup(layer.layers, id); if (found) return found; }
  }
  return null;
}
async function descriptor(layerId, docId) {
  const r = await action.batchPlay([{ _obj: 'get', _target: [{ _ref: 'layer', _id: layerId }, { _ref: 'document', _id: docId }] }], {});
  if (!r[0] || r[0]._obj === 'error') throw Error('无法读取图层信息');
  return r[0];
}
async function targetGroup(doc, id) {
  const group = findGroup(doc.layers, id);
  if (!group) throw Error('目标蒙版组已被删除或不是图层组，请重新读取');
  const info = await descriptor(id, doc.id);
  if (!info.hasUserMask || info.userMaskEnabled === false) throw Error('目标组没有启用的像素蒙版');
  if (info.hasVectorMask) throw Error('目标组同时有矢量蒙版，当前版本不支持自动合成，请改用仅带像素蒙版的组');
  return group;
}
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(bytes) {
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 12288) {
    let out = '';
    for (let i = start; i < Math.min(start + 12288, bytes.length); i += 3) {
      const value = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63] + (i + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=') + (i + 2 < bytes.length ? alphabet[value & 63] : '=');
    }
    chunks.push(out);
  }
  return chunks.join('');
}
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

async function inspect() {
  const doc = documentById();
  const groups = [];
  async function walk(layers, parent) {
    for (const layer of layers) {
      if (layer.kind !== constants.LayerKind.GROUP) continue;
      const name = parent ? parent + ' / ' + layer.name : layer.name;
      const info = await descriptor(layer.id, doc.id);
      if (info.hasUserMask) groups.push({ id: layer.id, name: layer.name, path: name, enabled: info.userMaskEnabled !== false && !info.hasVectorMask });
      await walk(layer.layers || [], name);
    }
  }
  await walk(doc.layers, '');
  return { ok: true, docId: doc.id, name: doc.title || doc.name || 'PS文档', width: Number(doc.width), height: Number(doc.height), groups };
}

async function read(params) {
  return core.executeAsModal(() => readInsideModal(params), { commandName: '来福：读取文档与组蒙版' });
}
async function readInsideModal(params) {
  const doc = documentById(params.docId);
  const layer = await targetGroup(doc, params.layerId);
  if (typeof imaging.getLayerMask !== 'function') throw Error('此PS版本不支持直接读取图层蒙版，请升级Photoshop');
  const width = Number(doc.width), height = Number(doc.height);
  if (width * height > 12000000) throw Error('当前本地改色限制1200万像素，请在较小的文档副本中处理');
  let pixels, mask;
  try {
    const full = { left: 0, top: 0, right: width, bottom: height };
    pixels = await imaging.getPixels({ documentID: doc.id, sourceBounds: full, componentSize: 8, colorSpace: 'RGB', colorProfile: 'sRGB IEC61966-2.1', applyAlpha: false });
    const bounds = pixels.sourceBounds || full;
    mask = await imaging.getLayerMask({ documentID: doc.id, layerID: layer.id, kind: 'user', sourceBounds: full });
    const mi = mask.imageData, pi = pixels.imageData;
    const raw = await pi.getData({ chunky: true });
    const rgba = new Uint8Array(pi.width * pi.height * 4);
    for (let n = 0; n < pi.width * pi.height; n++) {
      rgba[n * 4] = raw[n * pi.components]; rgba[n * 4 + 1] = raw[n * pi.components + 1]; rgba[n * 4 + 2] = raw[n * pi.components + 2];
      rgba[n * 4 + 3] = pi.components === 4 ? raw[n * 4 + 3] : 255;
    }
    const mr = await mi.getData({ chunky: true, fullRange: true });
    const weights = new Uint8Array(mi.width * mi.height);
    const max = mi.componentSize === 16 ? 65535 : mi.componentSize === 32 ? 1 : 255;
    let covered = 0;
    for (let n = 0; n < weights.length; n++) { weights[n] = Math.round(Math.max(0, Math.min(1, mr[n * mi.components] / max)) * 255); if (weights[n] > 0) covered++; }
    if (!covered) throw Error('所选组的蒙版确实为全黑，请选择其他组');
    const mb = mask.sourceBounds || full;
    return { ok: true, docId: doc.id, layerId: layer.id, layerName: layer.name, docWidth: width, docHeight: height,
      width: pi.width, height: pi.height, rgbaB64: toBase64(rgba), mime: 'image/png',
      selection: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      bounds: { x: mb.left, y: mb.top, width: mb.right - mb.left, height: mb.bottom - mb.top },
      maskWidth: mi.width, maskHeight: mi.height, weightB64: toBase64(weights), coveredPct: Math.round(covered / weights.length * 100) };
  } finally { if (pixels) pixels.imageData.dispose(); if (mask) mask.imageData.dispose(); }
}

async function place(params) {
  const native = require('./recolor-native');
  const doc = documentById(params.docId);
  const items = params.items || [];
  if (!items.length || items.length > 40) throw Error('SKU数量必须在1到40之间');
  for (const item of items) {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 160) throw Error('SKU名称无效');
    native.validate(item.recipe);
  }
  const results = [];
  let targetName = '';
  await core.executeAsModal(async executionContext => {
    const target = await targetGroup(doc, params.layerId);
    targetName = target.name;
    const targetInfo = await descriptor(target.id, doc.id);
    const blend = targetInfo.mode && targetInfo.mode._value;
    if (blend && blend !== 'passThrough') throw Error('目标蒙版组必须为「穿透」混合模式，才能调整组下方的原始图层；请在PS修改后重试');
    await action.batchPlay([{ _obj: 'select', _target: [{ _ref: 'document', _id: doc.id }] }], {});
    const history = await executionContext.hostControl.suspendHistory({ documentID: doc.id, name: '来福：批量创建原生调色组' });
    let success = false, savedSelection = null;
    try {
      try { const selected = await imaging.getSelection({ documentID: doc.id }); if (selected && selected.imageData) savedSelection = selected; } catch (_) {}
      await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'channel', _property: 'selection' }], to: { _enum: 'ordinal', _value: 'none' } }], {});
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const group = await doc.createLayerGroup({ name: item.name });
        group.visible = false;
        await group.move(target, constants.ElementPlacement.PLACEINSIDE);
        await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _id: group.id }], to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: 'passThrough' } } }], {});
        const layerIds = [];
        for (const layer of item.recipe.layers) {
          const response = await action.batchPlay([native.descriptor(layer)], {});
          if (response.some(r => r._obj === 'error')) throw Error(response.find(r => r._obj === 'error').message || '创建原生调整层失败');
          const created = doc.activeLayers[0];
          if (!created || created.id === group.id || created.kind === constants.LayerKind.GROUP) throw Error('PS没有返回新创建的调整层');
          await created.move(group, constants.ElementPlacement.PLACEINSIDE);
          if (layer.fillOpacity !== 1) await action.batchPlay([{ _obj: 'set', _target: [{ _ref: 'layer', _id: created.id }], to: { _obj: 'layer', fillOpacity: { _unit: 'percentUnit', _value: layer.fillOpacity * 100 } } }], {});
          layerIds.push(created.id);
        }
        results.push({ id: group.id, name: item.name, layerIds });
      }
      const first = findGroup(doc.layers, results[0].id);
      if (first) first.visible = true;
      success = true;
    } finally {
      try { if (savedSelection) await imaging.putSelection({ documentID: doc.id, imageData: savedSelection.imageData, targetBounds: { left: savedSelection.sourceBounds ? savedSelection.sourceBounds.left : 0, top: savedSelection.sourceBounds ? savedSelection.sourceBounds.top : 0 }, replace: true }); }
      catch (error) { success = false; throw error; }
      finally {
        if (savedSelection) savedSelection.imageData.dispose();
        await executionContext.hostControl.resumeHistory(history, success);
      }
    }
  }, { commandName: '来福：创建可编辑调色工程' });
  return { ok: true, count: results.length, layerId: params.layerId, layerName: targetName, groups: results, native: true };
}
module.exports = { inspect, read, place, documentById, findGroup, descriptor, targetGroup };
