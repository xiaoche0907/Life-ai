const { app, action, core, imaging, constants } = require('photoshop');
const { toBase64, fromBase64 } = require('./recolor.host');

const PROFILE = 'sRGB IEC61966-2.1';
const MAX_PIXELS = 8000000;
const MAX_EDGE = 8192;
const boundsKeys = ['left', 'top', 'right', 'bottom'];

function historyId(doc) {
  const id = doc.activeHistoryState?.id;
  if (!Number.isInteger(id)) throw Error('Photoshop 无法读取当前历史状态');
  return id;
}

async function copyRegion(region, target, bounds, components) {
  const { imageData, sourceBounds } = region;
  if (!imageData) throw Error('Photoshop 未返回选区像素');
  try {
    const { width, height } = imageData;
    if (!sourceBounds || !boundsKeys.every(key => Number.isInteger(sourceBounds[key])) ||
        imageData.componentSize !== 8 || imageData.components !== components ||
        width !== sourceBounds.right - sourceBounds.left || height !== sourceBounds.bottom - sourceBounds.top ||
        sourceBounds.left < bounds.left || sourceBounds.top < bounds.top ||
        sourceBounds.right > bounds.right || sourceBounds.bottom > bounds.bottom) {
      throw Error('Photoshop 返回的选区边界或像素格式异常');
    }
    const data = await imageData.getData({ chunky: true });
    if (data.length !== width * height * components) throw Error('Photoshop 返回的选区数据不完整');
    const stride = (bounds.right - bounds.left) * components;
    const rowSize = width * components;
    const first = (sourceBounds.top - bounds.top) * stride + (sourceBounds.left - bounds.left) * components;
    for (let row = 0; row < height; row++) {
      target.set(data.subarray(row * rowSize, (row + 1) * rowSize), first + row * stride);
    }
  } finally {
    imageData.dispose();
  }
}

async function capture(readSelection) {
  return core.executeAsModal(async () => {
    const doc = app.activeDocument;
    if (!doc) throw Error('请先在 Photoshop 打开图片');
    const selected = await readSelection();
    if (!selected) throw Error('请先在 Photoshop 用选框、套索或快速蒙版建立选区');
    const bounds = {
      left: Math.max(0, Math.floor(selected.left)), top: Math.max(0, Math.floor(selected.top)),
      right: Math.min(doc.width, Math.ceil(selected.right)), bottom: Math.min(doc.height, Math.ceil(selected.bottom)),
    };
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    if (width < 8 || height < 8) throw Error('请框选至少 8 × 8 像素的区域');
    if (width * height > MAX_PIXELS || Math.max(width, height) > MAX_EDGE) {
      throw Error('请缩小选区至 800 万像素以内，且单边不超过 8192 像素');
    }
    const revision = historyId(doc);
    const options = { documentID: doc.id, sourceBounds: bounds };
    const mask = new Uint8Array(width * height);
    await copyRegion(await imaging.getSelection(options), mask, bounds, 1);
    if (!mask.some(value => value > 0)) throw Error('选区内没有可编辑像素');
    const rgb = new Uint8Array(width * height * 3).fill(255);
    await copyRegion(await imaging.getPixels({ ...options, componentSize: 8, colorSpace: 'RGB', colorProfile: PROFILE, applyAlpha: true }), rgb, bounds, 3);
    const frame = await imaging.createImageDataFromBuffer(rgb, { width, height, components: 3, colorSpace: 'RGB', colorProfile: PROFILE });
    try {
      const image = await imaging.encodeImageData({ imageData: frame, base64: true });
      return { docId: doc.id, title: doc.title, revision, bounds, width, height, image, mask: toBase64(mask) };
    } finally {
      frame.dispose();
    }
  }, { commandName: '来福：读取服装精修选区' });
}

async function place({ docId, revision, bounds, rgba, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 ||
      width * height > MAX_PIXELS || Math.max(width, height) > MAX_EDGE ||
      typeof rgba !== 'string' || rgba.length !== Math.ceil(width * height * 4 / 3) * 4) {
    throw Error('服装精修结果尺寸异常');
  }
  const pixels = fromBase64(rgba);
  if (pixels.length !== width * height * 4) throw Error('服装精修结果数据不完整');
  return core.executeAsModal(async ({ hostControl }) => {
    const doc = app.activeDocument;
    if (!doc || doc.id !== docId) throw Error('请切回生成时的 Photoshop 文档再应用');
    if (historyId(doc) !== revision) throw Error('原文档已修改，请重新生成精修预览');
    if (!bounds || !boundsKeys.every(key => Number.isInteger(bounds[key])) || bounds.left < 0 || bounds.top < 0 ||
        bounds.right > doc.width || bounds.bottom > doc.height || bounds.right - bounds.left !== width || bounds.bottom - bounds.top !== height) {
      throw Error('原选区坐标已失效，请重新生成');
    }
    const history = await hostControl.suspendHistory({ documentID: doc.id, name: '来福：服装精修' });
    let written = false;
    try {
      const top = doc.layers[0];
      const existingIds = new Set(doc.activeLayers.map(layer => layer.id));
      const [made] = await action.batchPlay([{ _obj: 'make', _target: [{ _ref: 'layer' }], using: { _obj: 'layer', name: '服装精修' } }], {});
      const layer = doc.activeLayers[0];
      if (made?._obj === 'error' || !layer || existingIds.has(layer.id) || layer.id === top?.id) throw Error('Photoshop 创建结果图层失败');
      if (top && doc.layers[0].id !== layer.id) await layer.move(top, constants.ElementPlacement.PLACEBEFORE);
      if (doc.layers[0].id !== layer.id) throw Error('Photoshop 无法将结果置于文档顶层');
      const frame = await imaging.createImageDataFromBuffer(pixels, { width, height, components: 4, colorSpace: 'RGB', colorProfile: PROFILE });
      try {
        await imaging.putPixels({ documentID: doc.id, layerID: layer.id, imageData: frame, targetBounds: { left: bounds.left, top: bounds.top } });
      } finally {
        frame.dispose();
      }
      written = true;
      return { layerId: layer.id };
    } finally {
      await hostControl.resumeHistory(history, written);
    }
  }, { commandName: '来福：服装精修' });
}

module.exports = { capture, place };
