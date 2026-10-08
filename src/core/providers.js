// 渠道与模型价格表（魔改版MODEL_CONFIG移植）+ 余额/模型列表查询
const { ipcMain } = require('electron');
const ctx = require('./ctx');
const { isImageModel } = require('./model-kind');   // 0908：拉取模型只留生图模型

const config = ctx.config;

const PROVIDERS = {
  momo: { label: 'momo', base: 'https://api.momoapi.icu', currency: '¥', dynamicModels: true, models: {} },
  aji: {
    // 0909 新增 gpt-image 三款（AJI /v1/models 实列 gpt-image-2 / -2.5-flare / -2.5-sunburst，supported_endpoint_types 只有 openai）：
    // 走 OpenAI 图片接口（api:'openai'：/v1/images/generations 文生图、/v1/images/edits 多部件传图），不走 generateContent。
    // 价格=AJI /api/pricing 每次 ¥0.07（分辨率同价）。真机：sunburst 1024²/2048x1152、flare 1536x1024、edits 双图 全 200。
    label: 'AJI', base: 'https://ai.ajiai.top', currency: '¥', models: {
      'Banana-pro-A': { name: '香蕉ProA经济', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.06, '2K': 0.08, '4K': 0.10 }, def: '2K', suffix: true },
      'Banana-pro-D': { name: '香蕉ProD', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.1, '2K': 0.1, '4K': 0.1 }, def: '2K', suffix: true },
      'AJbanana3': { name: '香蕉Pro', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.15, '2K': 0.16, '4K': 0.18 }, def: '2K', suffix: true },
      'AJbanana2': { name: '香蕉2', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.1, '2K': 0.1, '4K': 0.1 }, def: '2K', suffix: true },
      // 1007：AJI 上新 banana 2.1（gemini-nano-banana-2.1）。AJI 侧模型名就叫 banana-2.1，带分辨率后缀
      // （banana-2.1-1k/-2k/-4k，各分辨率同价 ¥0.08）；裸名 banana-2.1 在 /api/pricing 里是 ratio 计费（37.5），不用它。
      // 另有同价同物的别名 gemini-nano-banana-2.1（无后缀），不重复上架。
      'banana-2.1': { name: '香蕉2.1', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.08, '2K': 0.08, '4K': 0.08 }, def: '2K', suffix: true },
      'gemini-2.5-flash-image': { name: '香蕉1', sizes: ['1K'], prices: { '1K': 0.04 }, def: '1K', suffix: false },
      // 1007 对表 AJI /api/pricing：sunburst 0.07→0.10、flare 0.07→0.09（官网已调价，渠道能力不变）
      'gpt-image-2.5-sunburst': { name: 'gpt-image-2.5-sunburst', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.10, '2K': 0.10, '4K': 0.10 }, def: '1K', suffix: false, api: 'openai' },
      'gpt-image-2.5-flare': { name: 'gpt-image-2.5-flare', sizes: ['1K', '2K', '4K'], prices: { '1K': 0.09, '2K': 0.09, '4K': 0.09 }, def: '1K', suffix: false, api: 'openai' },
      'gpt-image-2': { name: 'gpt-image-2', sizes: ['1K'], prices: { '1K': 0.07 }, def: '1K', suffix: false, api: 'openai' },
    },
    chatModels: {
      // 0908早：AJI 分组下 GPT/Claude 曾全部 503 → 标过 dead。0908晚用户要求放开+实测 /v1/models 已重新列出这 9 个，dead 摘掉；
      // 若再下架，加回 dead:true 即可（对话设置里标灰不可选、不自动挑中）。自动修图识图不受此影响（它只列 gemini）。
      'gpt-6-astra': { name: 'GPT-6 Astra', price: 0.04 },
      'gpt-5.5': { name: 'GPT-5.5', price: 0.02 },
      'gpt-5.5-plus': { name: 'GPT-5.5 Plus', price: 0.025 },
      'gpt-5.6-luna': { name: 'GPT-5.6 Luna', price: 0.03 },
      'gpt-5.6-sol': { name: 'GPT-5.6 Sol', price: 0.03 },
      'gpt-5.6-terra': { name: 'GPT-5.6 Terra', price: 0.03 },
      'claude-fable-5': { name: 'Claude Fable 5', price: 0.05 },
      'claude-opus-4-8': { name: 'Claude Opus 4.8', price: 0.04 },
      'claude-opus-5': { name: 'Claude Opus 5', price: 0.05 },
    },
  },
  grs: {
    // 0909 按 GRS 官网模型页（grsai.com/dashboard/models，29 个模型）整表重写。计费单位=积分（余额接口同单位），
    // 官网口径 ¥ = 积分/20000，cny 字段=每张参考人民币；同一模型各分辨率同价（官网标注）。
    // ⚠0909 用户实锤"新增的全都无法生图"：GRS 的 gpt-image 系与 nano-banana-2-lite/-cl 系**不走 Gemini generateContent**
    //   （gpt-image 直接 HTTP 400；nano-banana-2-lite 有时回文字不回图），官方文档（qmy27nhsd9.apifox.cn）只给 /v1/api/generate
    //   （replyType:'async' + /v1/api/result 轮询，图片回 URL）。表里 api:'grs' 的模型走这条；老 nano-banana-pro/2/fast 仍走
    //   generateContent（真机稳定），其余同样切 grs 接口。真机：sunburst 2048x1152 / gpt-image-2.5 "16:9" / nano-banana-fast 传图 全 succeeded。
    // 官网已不列 nano-banana / nano-banana-pro-vt（网关仍认，老用户选着照跑，只是不显示价格）。
    label: 'GRS', base: 'https://grsai.dakka.com.cn', currency: '积分', models: {
      // 1007 上新 nano-banana-2.1（官网原文「gemini-nano-banana-2.1，支持分辨率：1K、2K、4K。所有分辨率价格一致」），
      // 1200 积分/¥0.06，与 nano-banana-2 同价同档。api:'grs' 走 GRS 自家异步接口（0909 教训：GRS 新模型走
      // Gemini generateContent 易"回文字不回图"；真机出图才算数，若不通改回缺省即可）。
      'nano-banana-2.1': { name: 'nano-banana-2.1', sizes: ['1K', '2K', '4K'], prices: { '1K': 1200, '2K': 1200, '4K': 1200 }, cny: 0.06, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-2': { name: 'nano-banana-2', sizes: ['1K', '2K', '4K'], prices: { '1K': 1200, '2K': 1200, '4K': 1200 }, cny: 0.06, def: '1K', suffix: false },
      'nano-banana-2-lite': { name: 'nano-banana-2-lite', sizes: ['1K'], prices: { '1K': 440 }, cny: 0.022, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-fast': { name: 'nano-banana-fast', sizes: ['1K'], prices: { '1K': 440 }, cny: 0.022, def: '1K', suffix: false },
      'nano-banana-pro': { name: 'nano-banana-pro', sizes: ['1K', '2K', '4K'], prices: { '1K': 1800, '2K': 1800, '4K': 1800 }, cny: 0.09, def: '1K', suffix: false },
      'gpt-image-2': { name: 'gpt-image-2', sizes: ['1K'], prices: { '1K': 600 }, cny: 0.03, def: '1K', suffix: false, api: 'grs' },
      'gpt-image-2-vip': { name: 'gpt-image-2-vip', sizes: ['1K', '2K', '4K'], prices: { '1K': 2000, '2K': 2000, '4K': 2000 }, cny: 0.1, def: '1K', suffix: false, api: 'grs' },
      'gpt-image-2.5': { name: 'gpt-image-2.5', sizes: ['1K'], prices: { '1K': 600 }, cny: 0.03, def: '1K', suffix: false, api: 'grs' },
      // 1007 对表 GRS 官网模型页：sunburst 3000→2400 积分(¥0.15→¥0.12)、flare 3000→2000 积分(¥0.15→¥0.10)。
      // 官网这两个当前标"维护中，模型正在修复"——只是显示价改了，等恢复后照跑；用户若选它报错，先看日志卡原文。
      'gpt-image-2.5-sunburst': { name: 'gpt-image-2.5-sunburst', sizes: ['1K', '2K', '4K'], prices: { '1K': 2400, '2K': 2400, '4K': 2400 }, cny: 0.12, def: '1K', suffix: false, api: 'grs' },
      'gpt-image-2.5-flare': { name: 'gpt-image-2.5-flare', sizes: ['1K', '2K', '4K'], prices: { '1K': 2000, '2K': 2000, '4K': 2000 }, cny: 0.1, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-2-cl': { name: 'nano-banana-2-cl', sizes: ['1K'], prices: { '1K': 6000 }, cny: 0.3, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-2-2k-cl': { name: 'nano-banana-2-2k-cl', sizes: ['2K'], prices: { '2K': 9000 }, cny: 0.45, def: '2K', suffix: false, api: 'grs' },
      'nano-banana-2-4k-cl': { name: 'nano-banana-2-4k-cl', sizes: ['4K'], prices: { '4K': 13000 }, cny: 0.65, def: '4K', suffix: false, api: 'grs' },
      'nano-banana-pro-cl': { name: 'nano-banana-pro-cl', sizes: ['1K'], prices: { '1K': 10000 }, cny: 0.5, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-pro-vip': { name: 'nano-banana-pro-vip', sizes: ['1K', '2K'], prices: { '1K': 10000, '2K': 10000 }, cny: 0.5, def: '1K', suffix: false, api: 'grs' },
      'nano-banana-pro-4k-vip': { name: 'nano-banana-pro-4k-vip', sizes: ['4K'], prices: { '4K': 18000 }, cny: 0.9, def: '4K', suffix: false, api: 'grs' },
    },
    // 语言模型（同页 14 个，0909 真机各发一条：gemini 系走 generateContent 200；gpt 系 generateContent 报"not found"→
    // 自动改道 /v1/chat/completions 200，callLLM 本来就是这个顺序）。price=官网输出价 ¥/百万 token（仅参考，界面不展示）
    chatModels: {
      'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', price: 3.5 },
      'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', price: 3.5 },
      'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', price: 10 },
      'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash Lite', price: 2.5 },
      'gemini-3.1-pro': { name: 'Gemini 3.1 Pro', price: 7 },
      'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash Lite', price: 1.5 },
      'gemini-3-pro': { name: 'Gemini 3 Pro', price: 7 },
      'gemini-3-flash': { name: 'Gemini 3 Flash', price: 3 },
      'gemini-2.5-pro': { name: 'Gemini 2.5 Pro', price: 6.25 },
      'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', price: 2 },
      'gpt-6-astra': { name: 'GPT-6 Astra', price: 20 },
      'gpt-5.6-terra': { name: 'GPT-5.6 Terra', price: 5.2 },
      'gpt-5.6-sol': { name: 'GPT-5.6 Sol', price: 13 },
      'gpt-5.5': { name: 'GPT-5.5', price: 13.5 },
    },
  },
  custom: { label: '自定义', base: '', currency: '', dynamicModels: true, models: {} },
};

// 用户自定义渠道（cus_ 前缀，state.js set-config 里创建）：Gemini兼容中转，行为=内置custom（动态拉模型）
// meta 按需合成，label 取配置里的名字，这样余额/模型/生成三条链都不用为每个自定义渠道单独写分支
function metaOf(prov) {
  if (PROVIDERS[prov]) return PROVIDERS[prov];
  if (/^cus_/.test(prov) && config.providers[prov]) {
    return { label: config.providers[prov].label || prov, base: '', currency: '', dynamicModels: true, models: {}, custom: true };
  }
  return null;
}
// 给UI的完整表：内置四个 + 全部 cus_*（隐藏与否由 conf[k].hidden 决定，UI自己过滤）
function metaTable() {
  const out = Object.assign({}, PROVIDERS);
  for (const k of Object.keys(config.providers)) if (/^cus_/.test(k)) out[k] = metaOf(k);
  return out;
}

// 查余额：全部直查官网（魔改版同款接口）
// AJI: GET /api/usage/token → total_available/500000 = 美元
// GRS: POST /client/openapi/getAPIKeyCredits → credits 积分
ipcMain.handle('ai-balance', async () => {
  const prov = config.provider || 'aji';
  const pc = config.providers[prov] || {};
  const meta = metaOf(prov) || {};
  const base = (pc.base || meta.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);
  if (!base || !key) return { ok: false, error: '未配置地址/Key' };
  const kerr = ctx.keyIssue(key, meta.label || prov);
  if (kerr) return { ok: false, error: kerr };
  try {
    if (prov === 'aji') {
      const resp = await fetch(base + '/api/usage/token', {
        headers: { 'Authorization': 'Bearer ' + key },
      });
      if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
      const j = await resp.json();
      if (j && j.data && j.data.total_available !== undefined) {
        return { ok: true, usd: j.data.total_available / 500000, currency: '$' };
      }
      return { ok: false, error: '无法解析额度数据' };
    }
    if (prov === 'grs') {
      const resp = await fetch(base + '/client/openapi/getAPIKeyCredits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
      const j = await resp.json();
      if (j.code === 0 && j.data) return { ok: true, credits: j.data.credits, currency: '积分' };
      return { ok: false, error: j.msg || '积分查询异常' };
    }
    // momo / custom / cus_*（Gemini兼容中转）：不知道对方有没有余额接口，试一次 /api/usage/token，没有就报"不支持"而不是假0
    const resp = await fetch(base + '/api/usage/token/', {
      headers: { 'Authorization': 'Bearer ' + key },
    });
    if (!resp.ok) return { ok: false, error: '该渠道不提供余额接口(HTTP ' + resp.status + ')' };
    const j = await resp.json();
    const d = j.data || j;
    return { ok: true, cny: d.balance_cny, usd: d.balance_usd, unlimited: !!d.unlimited_quota };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('ai-models', async () => {
  // 动态渠道（自定义/momo/cus_*）拉取模型列表
  const prov = config.provider;
  const meta = metaOf(prov);
  if (!meta || !meta.dynamicModels) return { ok: false, error: '该渠道模型为内置列表' };
  const pc = config.providers[prov];
  const base = (pc.base || '').replace(/\/+$/, '');
  const key = ctx.cleanKey(pc.key);
  if (!base || !key) return { ok: false, error: '请先填写该渠道的地址和Key' };
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

// 渠道信息：给UI渲染渠道/模型/价格（meta 含 cus_* 自定义渠道；隐藏与否看 conf[k].hidden）
ipcMain.handle('get-providers', () => ({
  current: config.provider,
  meta: metaTable(),
  conf: config.providers,
}));

ctx.PROVIDERS = PROVIDERS;
ctx.providerMeta = metaOf;   // gen.js resolveGen 用：cus_* 也能解析出 base/key/动态模型
