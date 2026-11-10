// 渠道与模型价格表（魔改版MODEL_CONFIG移植）+ 余额/模型列表查询
const { ipcMain } = require('electron');
const ctx = require('./ctx');
const { isImageModel } = require('./model-kind');   // 0908：拉取模型只留生图模型

const config = ctx.config;

const PROVIDERS = {
  // 1107 用户裁定：生图渠道只留「影策 / 万有引力」两家，全部 /v1 站标准（OpenAI 兼容）。
  // 地址内置写死（用户只填 Key，卡片上不给地址框——防手抖改坏拉不到模型）。
  // dynamicModels=true：模型靠"拉取模型"从 /v1/models 拿，不写死表（中转站模型经常上新/下架）。
  // 生成/改图统一走 OpenAI 图片接口（/v1/images/generations、/v1/images/edits），见 gen.js。
  yingce: { label: '影策', base: 'https://api.yingce.tv', currency: '¥', dynamicModels: true, openai: true, models: {} },
  wanyin: { label: '万有引力', base: 'https://lxmone.xyz', currency: '¥', dynamicModels: true, openai: true, models: {} },
};

// 1108 恢复：生图自定义渠道（cus_*，用户裁定精简时误伤了「自定义能力」）。地址/Key/label 存
// config.providers[cus_xxx]，meta 运行时合成（openai+dynamicModels，走 /v1/images 与拉模型同一套规矩）。
function metaOf(prov) {
  if (PROVIDERS[prov]) return PROVIDERS[prov];
  if (/^cus_[a-z0-9]{3,16}$/.test(prov || '')) {
    const pc = config.providers[prov] || {};
    return { label: pc.label || prov, base: pc.base || '', currency: '¥', dynamicModels: true, openai: true, models: {}, custom: true };
  }
}
// 给UI的完整表：内置两家 + 运行时合成的 cus_* 自定义渠道
function metaTable() {
  const t = Object.assign({}, PROVIDERS);
  for (const k of Object.keys(config.providers || {})) {
    if (/^cus_[a-z0-9]{3,16}$/.test(k) && !t[k]) t[k] = metaOf(k);
  }
  return t;
}

// 查余额：1107 渠道精简后只剩影策/万有引力（/v1 站）。
// 标准站没有统一余额接口：先试 one-api 系惯用的 /api/user/self（sub_type 站点常见，需系统Key，多半 401/403），
// 不行再试 /dashboard/billing/credit_grants（OpenAI 老 style）。都不通就老实报"不支持"，不造假数据。
ipcMain.handle('ai-balance', async () => {
  const prov = config.provider || 'yingce';
  const pc = config.providers[prov] || {};
  const meta = metaOf(prov) || {};
  const base = (meta.base || pc.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);
  if (!base || !key) return { ok: false, error: '未配置Key' };
  const kerr = ctx.keyIssue(key, meta.label || prov);
  if (kerr) return { ok: false, error: kerr };
  try {
    // one-api / new-api 系：GET /v1/dashboard/billing/subscription + /usage（多数中转站兼容）
    let resp = await fetch(base + '/v1/dashboard/billing/subscription', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (resp.ok) {
      const sub = await resp.json().catch(() => null);
      const hard = sub && (sub.system_hard_limit_usd ?? sub.hard_limit_usd);
      let used = null;
      const u = await fetch(base + '/v1/dashboard/billing/usage', {
        headers: { 'Authorization': 'Bearer ' + key },
      }).then((r) => (r.ok ? r.json().catch(() => null) : null));
      if (u && u.total_usage != null) used = u.total_usage / 100;   // OpenAI 口径：美分→美元
      if (hard != null) {
        const remain = used != null ? (hard - used) : hard;
        return { ok: true, usd: remain, currency: '$' };
      }
    }
    return { ok: false, error: '该渠道不提供余额查询接口' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ai-models', async () => {
  // 动态渠道（影策/万有引力）拉取模型列表
  const prov = config.provider;
  const meta = metaOf(prov);
  if (!meta || !meta.dynamicModels) return { ok: false, error: '该渠道模型为内置列表' };
  const pc = config.providers[prov];
  const base = (meta.base || pc.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);
  if (!base || !key) return { ok: false, error: '请先填写该渠道的Key' };
  const kerr = ctx.keyIssue(key, (meta && meta.label) || prov);
  if (kerr) return { ok: false, error: kerr };
  try {
    const resp = await fetch(base + '/v1/models', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const data = await resp.json();
    // 0908用户裁定"绝对不允许"：生图卡只列生图模型（白名单判定见 model-kind.js），语言等其他模型一律不入
    const all = (data.data || []).map((m) => m.id).filter(Boolean);
    const ids = all.filter(isImageModel).sort();
    pc.models = ids;
    if (pc.model && !ids.includes(pc.model)) pc.model = '';   // 选中的不是生图模型=清空，别带着错模型去跑
    ctx.saveConfig();
    return { ok: true, models: ids, total: all.length };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// 按渠道名拉模型（给影策/万有引力两张渠道卡各自用；老接口 ai-models 只认"当前渠道"）
// 只读：拉回来过滤出生图模型后写进 config.providers[prov].models
ipcMain.handle('ai-models-for', async (_e, prov) => {
  const meta = metaOf(prov);
  if (!meta) return { ok: false, error: '渠道不存在' };
  const pc = config.providers[prov];
  if (!pc) return { ok: false, error: '渠道不存在' };
  // 内置渠道的地址：以 providers.js 里写死的为准（用户改不了，防手抖改坏）
  const base = (meta.base || pc.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);
  if (!base || !key) return { ok: false, error: '请先填该渠道的 Key' };
  const kerr = ctx.keyIssue(key, meta.label || prov);
  if (kerr) return { ok: false, error: kerr };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const resp = await fetch(base + '/v1/models', { headers: { Authorization: 'Bearer ' + key }, signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const data = await resp.json();
    const all = (data.data || data.models || []).map((m) => (typeof m === 'string' ? m : (m.id || m.name))).filter(Boolean).map(String);
    const ids = all.filter(isImageModel).sort();
    pc.models = ids;
    if (pc.model && !ids.includes(pc.model)) pc.model = '';
    ctx.saveConfig();
    if (ctx.broadcast) ctx.broadcast('providers-changed', {});
    return { ok: true, models: ids, total: all.length };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) };
  }
});

// 渠道信息：给UI渲染渠道/模型/价格（只有内置影策/万有引力）
ipcMain.handle('get-providers', () => ({
  current: config.provider,
  meta: metaTable(),
  conf: config.providers,
}));

ctx.PROVIDERS = PROVIDERS;
ctx.providerMeta = metaOf;   // gen.js resolveGen 用：解析出 base/key/动态模型
