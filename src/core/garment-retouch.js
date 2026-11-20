const { ipcMain, nativeImage } = require('electron');
const ctx = require('./ctx');
const { nearestRatio, RATIO_SNAP } = require('./eff-ratio');
const SIZES = ['1K', '2K', '4K'];
const { groups } = require('../renderer/garment-retouch-prompts');

const MAX_PIXELS = 8000000;
const INPUT_EDGE = 1568;
const sessions = new WeakMap();

function settings() {
  const selected = ctx.resolveGen({ size: '2K' });
  return {
    provider: selected.prov, channel: selected.meta.label, model: selected.model,
    modelName: selected.mconf?.name || selected.model, ratios: ['Auto', ...RATIO_SNAP],
    sizes: selected.mconf?.sizes?.filter(size => SIZES.includes(size)) || SIZES,
    defaultSize: selected.effSize,
    connected: ctx.psConnected(), bridge: ctx.bridgeVer(), requiredBridge: 70,
  };
}

function bitmap(image, width, height) {
  const resized = image.resize({ width, height, quality: 'best' });
  const bytes = resized.toBitmap();
  if (bytes.length !== width * height * 4) throw Error('图片尺寸转换失败');
  return bytes;
}

function png(bytes, width, height) {
  return nativeImage.createFromBitmap(bytes, { width, height }).toPNG();
}

function makeInput(source, mask, width, height, ratio) {
  const [rw, rh] = ratio.split(':').map(Number);
  const factor = Math.ceil(Math.max(width / rw, height / rh));
  const scale = Math.min(1, Math.floor(INPUT_EDGE / Math.max(rw, rh)) / factor);
  const units = Math.max(1, Math.round(factor * scale));
  const frameWidth = rw * units, frameHeight = rh * units;
  const w = Math.min(frameWidth, Math.max(1, Math.round(width * scale)));
  const h = Math.min(frameHeight, Math.max(1, Math.round(height * scale)));
  const x = Math.floor((frameWidth - w) / 2), y = Math.floor((frameHeight - h) / 2);
  const original = bitmap(source, w, h);
  const input = Buffer.alloc(frameWidth * frameHeight * 4, 255);
  const guidance = Buffer.alloc(input.length);
  const previewMask = Buffer.alloc(w * h);
  for (let row = 0; row < frameHeight; row++) {
    const sy = Math.min(h - 1, Math.max(0, row - y));
    const maskRow = Math.floor((sy + 0.5) * height / h) * width;
    for (let col = 0; col < frameWidth; col++) {
      const index = (row * frameWidth + col) * 4;
      const sx = Math.min(w - 1, Math.max(0, col - x));
      const src = sy * w + sx;
      input[index] = original[src * 4];
      input[index + 1] = original[src * 4 + 1];
      input[index + 2] = original[src * 4 + 2];
      const inside = col >= x && col < x + w && row >= y && row < y + h;
      const value = inside ? mask[maskRow + Math.floor((sx + 0.5) * width / w)] : 0;
      guidance[index] = guidance[index + 1] = guidance[index + 2] = value;
      guidance[index + 3] = 255;
      if (inside) previewMask[src] = value;
    }
  }
  if (!previewMask.some(value => value > 0)) throw Error('选区太细或过于分散，请缩小包围范围后重试');
  return {
    x, y, w, h, frameWidth, frameHeight, original, previewMask,
    inputImage: png(input, frameWidth, frameHeight).toString('base64'), maskPng: png(guidance, frameWidth, frameHeight),
  };
}

function cropResult(image, frame) {
  const { width, height } = image.getSize();
  if (image.isEmpty() || Math.max(width, height) > 8192 || width * height > 32000000) throw Error('模型返回了无法使用的图片');
  if (Math.abs(Math.log((width / height) / (frame.frameWidth / frame.frameHeight))) > 0.05) {
    throw Error('模型返回的图片比例与选区不匹配，请重试或在生图模式切换模型');
  }
  const x = Math.round(frame.x * width / frame.frameWidth);
  const y = Math.round(frame.y * height / frame.frameHeight);
  const right = Math.round((frame.x + frame.w) * width / frame.frameWidth);
  const bottom = Math.round((frame.y + frame.h) * height / frame.frameHeight);
  if (right <= x || bottom <= y) throw Error('模型返回的图片分辨率不足');
  return image.crop({ x, y, width: right - x, height: bottom - y });
}

async function send(action, params, timeout = 60000) {
  const reply = await ctx.sendToPSAwait({ action, params }, timeout);
  if (!reply?.ok || !reply.result) throw Error(reply?.error || 'Photoshop 桥接未返回结果');
  return reply.result;
}

function checkBridge() {
  if (!ctx.psConnected()) throw Error('请先打开 Photoshop 并连接来福桥接');
  if (ctx.bridgeVer() < 70) throw Error('服装精修需要新版桥接，请更新桥接后重启 Photoshop');
}

function sessionFor(sender) {
  if (!sessions.has(sender)) sessions.set(sender, { busy: false, draft: null });
  return sessions.get(sender);
}

async function generate(sender, request, includePreview = true) {
  const session = sessionFor(sender);
  if (session.busy) return { ok: false, error: '当前操作尚未完成' };
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt || prompt.length > 4000) return { ok: false, error: '请填写 1 至 4000 字的精修提示词' };
  session.busy = true;
  session.draft = null;
  try {
    const current = settings();
    if (!current.model) throw Error('请先在生图模式选择模型');
    if (request.provider !== current.provider || request.model !== current.model) {
      throw Error('生图配置已变化，请确认卡片上的模型后重新生成');
    }
    const { provider, model } = current;
    const size = request.size ?? '2K';
    const requestedRatio = request.ratio ?? 'Auto';
    if (!SIZES.includes(size) || !current.sizes.includes(size)) throw Error('当前模型不支持所选分辨率');
    if (!current.ratios.includes(requestedRatio)) throw Error('请选择支持的出图比例');
    const selected = ctx.resolveGen({ provider, model, size });
    if (!selected.base || !selected.key) throw Error('请先在生图模式配置当前渠道的地址和 Key');
    const keyError = ctx.keyIssue(selected.key, current.channel);
    if (keyError) throw Error(keyError);
    checkBridge();
    const capture = await send('captureGarmentRetouch', {});
    const { width, height, bounds, docId, revision } = capture;
    if (!Number.isInteger(docId) || !Number.isInteger(revision) || !bounds ||
        !Number.isInteger(width) || !Number.isInteger(height) || width < 8 || height < 8 || width * height > MAX_PIXELS) {
      throw Error('Photoshop 返回的选区信息无效');
    }
    const mask = Buffer.from(capture.mask || '', 'base64');
    const source = nativeImage.createFromBuffer(Buffer.from(capture.image || '', 'base64'));
    const dimensions = source.getSize();
    if (mask.length !== width * height || dimensions.width !== width || dimensions.height !== height) throw Error('选区裁图与蒙版尺寸不一致');
    const ratio = requestedRatio === 'Auto' ? nearestRatio(width, height) : requestedRatio;
    const frame = makeInput(source, mask, width, height, ratio);
    const result = await ctx.generateOne({
      provider, model, size, ratio, rememberModel: false, inputImage: frame.inputImage, inputMime: 'image/png', maskPng: frame.maskPng,
      prompt: `${prompt}\n\n第一张图是原始服装选区裁图，第二张图是与第一张对齐的灰度编辑蒙版。白色可修复、黑色需保留，灰色为羽化过渡。仅返回一张与第一张构图和比例一致的修复图，保留周围内容和画面位置，不绘制蒙版，不拼图，不加说明文字。保持商品原色、版型、比例和未经指定的设计细节。`,
    });
    if (!result?.ok) throw Error(ctx.humanizeErr(result?.error || '模型未返回结果'));
    const image = cropResult(nativeImage.createFromPath(result.file), frame);
    session.draft = { image, mask, width, height, bounds, docId, revision };
    if (!includePreview) return { ok: true };
    const fitted = bitmap(image, frame.w, frame.h);
    const preview = Buffer.from(frame.original);
    for (let pixel = 0; pixel < frame.previewMask.length; pixel++) {
      const at = pixel * 4;
      const weight = frame.previewMask[pixel] / 255;
      const alpha = fitted[at + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        preview[at + channel] = Math.round(fitted[at + channel] * weight + preview[at + channel] * (1 - weight * alpha));
      }
    }
    const url = bytes => 'data:image/png;base64,' + png(bytes, frame.w, frame.h).toString('base64');
    return { ok: true, title: capture.title, width, height, original: url(frame.original), preview: url(preview), model: current.modelName };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    session.busy = false;
  }
}

async function apply(sender) {
  const session = sessionFor(sender);
  if (session.busy || !session.draft) return { ok: false, error: '请先生成精修预览' };
  session.busy = true;
  try {
    checkBridge();
    const { image, mask, width, height, bounds, docId, revision } = session.draft;
    const rgba = bitmap(image, width, height);
    for (let pixel = 0; pixel < mask.length; pixel++) {
      const at = pixel * 4;
      const alpha = rgba[at + 3];
      const scale = alpha ? 255 / alpha : 0;
      const red = rgba[at + 2];
      rgba[at + 2] = Math.min(255, Math.round(rgba[at] * scale));
      rgba[at + 1] = Math.min(255, Math.round(rgba[at + 1] * scale));
      rgba[at] = Math.min(255, Math.round(red * scale));
      rgba[at + 3] = Math.round(alpha * mask[pixel] / 255);
    }
    const result = await send('placeGarmentRetouch', { docId, revision, bounds, width, height, rgba: rgba.toString('base64') }, 0);
    if (!Number.isInteger(result.layerId)) throw Error('Photoshop 未确认写回图层');
    session.draft = null;
    return { ok: true, layerId: result.layerId };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    session.busy = false;
  }
}

ipcMain.handle('garment-retouch-settings', settings);
ipcMain.handle('garment-retouch-generate', ({ sender }, request) => generate(sender, request));
ipcMain.handle('garment-retouch-apply', ({ sender }) => apply(sender));

ctx.garmentPanelRequest = async (socket, method, params) => {
  if (method === 'settings') return { ok: true, ...settings(), groups: groups.map(([name, items]) => [name, items.map(([label, prompt]) => prompt.includes('【问题】') ? null : label)]) };
  if (method !== 'generate') return { ok: false, error: '未知的服装精修操作' };
  const { group, preset, size, ratio } = params || {};
  const item = Number.isInteger(group) && Number.isInteger(preset) && groups[group]?.[1][preset];
  if (!item || item[1].includes('【问题】')) return { ok: false, error: '请选择有效的精修能力' };
  const { provider, model } = settings();
  const generated = await generate(socket, { provider, model, size, ratio, prompt: item[1] }, false);
  if (!generated.ok) return generated;
  if (!ctx.isCurrentPSSocket(socket)) return { ok: false, error: '生成完成，但 Photoshop 已断开连接，未贴回' };
  return apply(socket);

};
