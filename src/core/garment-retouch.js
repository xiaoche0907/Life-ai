const { ipcMain } = require('electron');
const ctx = require('./ctx');
const { RATIO_SNAP } = require('./eff-ratio');
const { groups } = require('../renderer/garment-retouch-prompts');

const SIZES = ['1K', '2K', '4K'];
const REQUIRED_BRIDGE = 71;
const running = new WeakSet();

function settings() {
  const selected = ctx.resolveGen({ size: '2K' });
  return {
    provider: selected.prov, channel: selected.meta.label, model: selected.model,
    modelName: selected.mconf?.name || selected.model, ratios: ['Auto', ...RATIO_SNAP],
    sizes: selected.mconf?.sizes?.filter(size => SIZES.includes(size)) || SIZES,
    defaultSize: selected.effSize,
    connected: ctx.psConnected(), bridge: ctx.bridgeVer(), requiredBridge: REQUIRED_BRIDGE,
  };
}

async function generate(sender, request) {
  if (running.has(sender)) return { ok: false, error: '当前精修任务尚未完成' };
  const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
  if (!prompt || prompt.length > 4000) return { ok: false, error: '请填写 1 至 4000 字的精修提示词' };
  running.add(sender);
  try {
    const current = settings();
    if (!current.connected || current.bridge < REQUIRED_BRIDGE) throw Error('请连接 Photoshop，更新桥接后重启 Photoshop');
    if (!current.model) throw Error('请先在生图模式选择模型');
    if (request.provider !== current.provider || request.model !== current.model) throw Error('生图配置已变化，请重新选择精修能力');
    const size = request.size ?? '2K';
    const ratio = request.ratio ?? 'Auto';
    if (!current.sizes.includes(size)) throw Error('当前模型不支持所选分辨率');
    if (!current.ratios.includes(ratio)) throw Error('请选择支持的出图比例');
    const gen = ctx.config.gen || {};
    ctx.showCard('progress');
    const result = await ctx.runBatch({
      provider: current.provider, model: current.model, size, ratio, prompt,
      antiMode: Number(gen.antiMode) || 0, chartOn: !!gen.chartOn, refs: gen.refs || [],
    }, 1, undefined, { requireSelection: true });
    if (!result.ok || !result.done) throw Error(result.error || '生成失败，请查看生成进度');
    return { ok: true, pending: !result.placed, note: result.placed ? '' : (result.placeError ? `${result.placeError}。结果已保留在生成进度。` : '已生成，可在生成进度手动贴回。') };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  } finally {
    running.delete(sender);
  }
}

ipcMain.handle('garment-retouch-settings', settings);
ipcMain.handle('garment-retouch-generate', ({ sender }, request) => generate(sender, request));

ctx.garmentPanelRequest = async (socket, method, params) => {
  if (method === 'settings') return { ok: true, ...settings(), groups: groups.map(([name, items]) => [name, items.map(([label, prompt]) => prompt.includes('【问题】') ? null : label)]) };
  if (method !== 'generate') return { ok: false, error: '未知的服装精修操作' };
  const { group, preset, size, ratio } = params || {};
  const item = Number.isInteger(group) && Number.isInteger(preset) && groups[group]?.[1][preset];
  if (!item || item[1].includes('【问题】')) return { ok: false, error: '请选择有效的精修能力' };
  const { provider, model } = settings();
  const result = await generate(socket, { provider, model, size, ratio, prompt: item[1] });
  if (result.pending && ctx.bridgeVer() < 77) return { ok: false, error: result.note };
  return result;
};
