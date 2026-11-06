// AI对话：复用生图渠道，纯文本调用generateContent
// 历史存文档目录独立文件（卸载重装不丢）——不进config，防"聊天越多config越肥"重蹈refImages撑爆webview_storage的覆辙
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const { isChatModel } = require('./model-kind');   // 0908：拉取模型只留语言模型

const config = ctx.config;

const STORE_CAP = 500;   // 落盘保留上限（显示用）
const CTX_CAP = 40;      // 每次请求带给模型的最近消息数（20轮，控token）

const chatHistPath = () => path.join(app.getPath('documents'), '橙子', 'chat-history.json');
let histCache = null;

// 聊天/识图统一请求器（0907#6/#8根治）：先走Gemini兼容端点，被拒/报错自动改道OpenAI端点。
// ⚠body必须Buffer.from(JSON.stringify(...),'utf8')——JSON.stringify默认不转义中文，
// 裸字符串含非ASCII字符(如"在"=22312)会被某些fetch当ByteString转换抛"Cannot convert argument
// to a ByteString"（0907用户实测batch修图识图预检失败正是这条）。
// 两套body格式按端点切换：Gemini=contents[{role,parts:[{text}|{inlineData}]}]；
// 思考过程剥离（0909用户裁定：只要结果，不要思考）。三种来路一起挡：
//   Gemini parts 里 thought:true 的段 / OpenAI 风格正文里的 <think>…</think>（含 <thinking>）/ 只剩收尾标签的残片
// reasoning_content 这类独立字段本来就不取。剥完为空=走"模型返回空正文"报错路径（思考烧光额度）
const { cleanModelText } = require('./llm-text');
ctx.cleanModelText = cleanModelText;   // autofix 识图同用

// OpenAI=messages[{role,content:字符串或[{type,text|image_url}]}]。contents输入统一Gemini结构。
async function callLLM({ base, key, model, contents, genCfg, image }, timeoutMs) {
  if (!base || !key) return { ok: false, error: '未配置渠道地址/Key' };
  if (!model) return { ok: false, error: '未选择模型' };
  const kerr = ctx.keyIssue(key);
  if (kerr) return { ok: false, error: kerr };   // 对话/识图共用入口：Key含中文字符在这一并拦下
  const cfg = Object.assign({ temperature: 0.9, topP: 0.95, maxOutputTokens: 8192 }, genCfg || {});
  const baseUrl = base.replace(/\/+$/, '');
  const post = async (url, bodyObj, pick) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 120000);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + key },
        body: Buffer.from(JSON.stringify(bodyObj), 'utf8'),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        let detail = '';
        try { const j = await resp.json(); detail = (j.error && (j.error.message || j.error.type)) || j.message || ''; } catch {}
        return { ok: false, status: resp.status, error: `HTTP ${resp.status}${detail ? ' — ' + String(detail).slice(0, 160) : ''}` };
      }
      const data = await resp.json();
      if (data.promptFeedback && data.promptFeedback.blockReason) return { ok: false, error: '安全过滤: ' + data.promptFeedback.blockReason };
      const txt = pick(data);
      if (typeof txt === 'string' && txt.trim()) return { ok: true, text: txt };
      // 空正文要说清楚为什么（0908）：思考型模型把输出额度烧在思考上时，网关照样 200 + 空 content，
      // 只报"未返回有效内容"用户无从下手；把 finish 原因与思考 token 数带出来
      const ch0 = data.choices && data.choices[0];
      const cand0 = data.candidates && data.candidates[0];
      const fin = (ch0 && ch0.finish_reason) || (cand0 && cand0.finishReason) || '';
      const u = data.usage || {};
      const think = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens)
        || (data.usageMetadata && data.usageMetadata.thoughtsTokenCount) || 0;
      return { ok: false, error: '模型返回空正文' + (fin ? '(finish=' + fin + ')' : '') + (think ? '，思考已耗 ' + think + ' token，输出上限 ' + cfg.maxOutputTokens : '') };
    } catch (e) {
      return { ok: false, error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) };
    } finally { clearTimeout(timer); }
  };
  const pickGemini = (data) => {
    const cand = data.candidates && data.candidates[0];
    if (cand && cand.finishReason === 'SAFETY') return '';
    const parts = (cand && cand.content && cand.content.parts) || [];
    // 跳过 thought:true 的思考段，其余文本段拼起来（原来只取 parts[0]：思考段排第一时正文被丢/思考被当回复）
    return cleanModelText(parts.filter((p) => p && p.text != null && !p.thought).map((p) => p.text).join(''));
  };
  // Gemini端点（首试）
  const g = await post(baseUrl + '/v1beta/models/' + model + ':generateContent', { contents, generationConfig: cfg }, pickGemini);
  if (g.ok) return g;
  // GPT/Claude系或Gemini被拒：改道OpenAI风格 /v1/chat/completions（坑75：AJI的GPT/Claude只认这个端点）
  const messages = [];
  for (const c of contents) {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const parts = c.parts || [];
    let content;
    if (parts.length === 1 && parts[0].text != null) content = parts[0].text;
    else {
      content = [];
      for (const p of parts) {
        if (p.inlineData && p.inlineData.data) {
          content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + (image || p.inlineData.data) } });
          if (p.text) content.push({ type: 'text', text: p.text });
        } else if (p.text != null) content.push({ type: 'text', text: p.text });
      }
    }
    messages.push({ role, content });
  }
  const pickOpenAI = (data) => {
    const c = data.choices && data.choices[0];
    const t = c && c.message && c.message.content;
    return cleanModelText(Array.isArray(t) ? t.map((x) => x.text || '').join('') : t);
  };
  const o = await post(baseUrl + '/v1/chat/completions', { model, messages, temperature: cfg.temperature, top_p: cfg.topP, max_tokens: cfg.maxOutputTokens }, pickOpenAI);
  if (o.ok) return o;
  return { ok: false, error: g.error + '；改道OpenAI端点也失败: ' + (o.error || '') };
}

// ---------- 对话渠道解析（0908 与生图彻底解耦；1013 去掉"角色专属模型"这一层）----------
// 对话只认 config.chatProviders（内置 aji/grs/momo 各自的 Key + 用户自定义 cc_*），绝不碰 config.providers（生图渠道）。
// 模型目录：内置渠道=providers.js 的 chatModels 静态表（dead 的不列）；cc_*=拉取后存进 models。
// 1013 用户裁定：**"角色专属模型"整块移除**（"多角色不管"）。原来看法 roleModels[角色] 这一层没了，
//   解析顺序简化为：功能槽位(caps) → config.chat.provider/model 兜底。
//   ⚠老配置里的 roleModels 数据由 MIGRATIONS v24 搬进 caps.chat 后清空，不会静默失效。
function chatModelList(prov) {
  const cp = config.chatProviders[prov];
  if (!cp) return [];
  const meta = ctx.PROVIDERS && ctx.PROVIDERS[prov];
  if (meta && meta.chatModels && Object.keys(meta.chatModels).length) {
    return Object.keys(meta.chatModels).map((id) => ({ id, name: meta.chatModels[id].name || id, dead: !!meta.chatModels[id].dead }));
  }
  return (cp.models || []).map((id) => ({ id, name: id, dead: false }));
}
function chatProvidersTable() {
  const out = {};
  for (const k of Object.keys(config.chatProviders)) {
    const c = config.chatProviders[k];
    const key = c.key || '';
    // keyMask：给设置面显示"已存了哪把 Key"（首3+尾4），不回传明文
    const keyMask = key ? (key.length > 10 ? key.slice(0, 3) + '••••••' + key.slice(-4) : '••••' + key.slice(-2)) : '';
    out[k] = { label: c.label || k, base: c.base || '', hasKey: !!key, keyMask, builtin: !/^cc_/.test(k), models: chatModelList(k) };
  }
  return out;
}
// 解析"某次对话调用"该用哪个渠道/模型。
//   capId = 功能槽位：'chat'=AI对话（原「默认渠道/模型」那块）/'json'=提示词卡转JSON/'ask'=半合成识图。
//           该槽位填了渠道就用它；空 = 回落到 config.chat.provider/model 兜底。
// 1013 之前这里还有一层 role（角色专属模型），用户裁定"多角色不管"后**整层移除**：
//   签名从 resolveChat(role, capId) 简化为 resolveChat(capId)，三个调用点同步改。
function resolveChat(capId) {
  // 功能槽位：填了渠道且该渠道还在 → 用它
  const cap = (capId && config.chat.caps && config.chat.caps[capId]) || null;
  if (cap && cap.provider && config.chatProviders[cap.provider]) {
    const cp0 = config.chatProviders[cap.provider];
    const list0 = chatModelList(cap.provider);
    const alive0 = list0.filter((m) => !m.dead).map((m) => m.id);
    let m0 = cap.model || '';
    // ⚠模型名不在这张表里时**保留用户填的那个**，不拿表里第一个顶替（1013 踩过）：
    //   原来这里写的是"不在表里就换成表里第一个"，结果用户明确选的 claude-opus-5（GRS 表里没有，
    //   但网关可能认）被悄悄换成 gpt-5.6-sol —— 界面显示的和实跑的对不上，而且花的是用户的钱。
    //   表里没有≠不能用（自定义网关可手填模型名）；真要报错也该由接口报，不该由我们替他决定。
    //   只有"压根没填"时才回落到 global model / 表里第一个。
    if (!m0) m0 = (config.chat.model && alive0.includes(config.chat.model)) ? config.chat.model : (alive0[0] || '');
    return { prov: cap.provider, label: cp0.label || cap.provider, base: (cp0.base || '').replace(/\/+$/, ''), key: ctx.cleanKey(cp0.key), model: m0, viaCap: capId };
  }
  // 兜底 = config.chat.provider/model（老配置一直带着这对值；界面不再单独露出它）
  let prov = config.chat.provider || 'grs';
  let model = '';
  if (!config.chatProviders[prov]) { prov = 'grs'; model = ''; }
  const cp = config.chatProviders[prov] || {};
  const list = chatModelList(prov);
  const alive = list.filter((m) => !m.dead).map((m) => m.id);
  if (!model || !alive.includes(model)) model = (config.chat.model && alive.includes(config.chat.model)) ? config.chat.model : '';
  if (!model && !list.length) model = config.chat.model || '';   // cc_* 没拉过列表也允许手填
  return { prov, label: cp.label || prov, base: (cp.base || '').replace(/\/+$/, ''), key: ctx.cleanKey(cp.key), model };
}

ctx.chatResolve = resolveChat;   // autofix 识图等直调（它们有自己的 det.provider/model 时只借 base/key）
ctx.chatProvidersTable = chatProvidersTable;
ipcMain.handle('chat-providers', () => ({ conf: chatProvidersTable(), current: config.chat.provider }));
// 自定义对话渠道拉模型：用该渠道自己的 base/key 请求 /v1/models，结果存进 chatProviders[prov].models
ipcMain.handle('chat-models-fetch', async (_e, { prov }) => {
  const cp = config.chatProviders[prov];
  if (!cp) return { ok: false, error: '渠道不存在' };
  const base = (cp.base || '').replace(/\/+$/, ''), key = ctx.cleanKey(cp.key);
  if (!base || !key) return { ok: false, error: '请先填该渠道的地址和Key' };
  const kerr = ctx.keyIssue(key, cp.label || prov);
  if (kerr) return { ok: false, error: kerr };
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
    const resp = await fetch(base + '/v1/models', { headers: { 'Authorization': 'Bearer ' + key }, signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const data = await resp.json();
    // 0908用户裁定：对话卡只列语言模型——生图/音频/视频/向量等非对话模型一律排除（黑名单判定见 model-kind.js）
    const all = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).map((s) => String(s).replace(/^models\//, ''));
    const ids = all.filter(isChatModel).sort();
    cp.models = ids;
    ctx.saveConfig();
    ctx.broadcast('chat-vars', config.chat);
    return { ok: true, models: ids, total: all.length };
  } catch (e) { return { ok: false, error: e.name === 'AbortError' ? '请求超时' : (e.message || String(e)) }; }
});
function histLoad() {
  if (histCache) return histCache;
  try { histCache = JSON.parse(fs.readFileSync(chatHistPath(), 'utf8')); }
  catch { histCache = null; }
  if (!Array.isArray(histCache)) histCache = [];
  // 一次性迁移：老版本历史存在config.chat.history里，搬进独立文件后从config清除
  if (!histCache.length && Array.isArray(config.chat.history) && config.chat.history.length) {
    histCache = config.chat.history.slice(-STORE_CAP);
    config.chat.history = [];
    ctx.saveConfig();
    histSave();
  }
  return histCache;
}
let histTimer = null;
function histSave() {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(chatHistPath()), { recursive: true });
      fs.writeFileSync(chatHistPath(), JSON.stringify(histCache, null, 2));
    } catch (e) {
      try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [chat] 历史写入失败: ' + (e && e.message) + '\n'); } catch {}
    }
  }, 300);
}

// 内置角色：src/roles/下随软件分发。
// ⚠1011 上游裁定只保留「语料」一个内置角色；Life 分支恢复旧版双角色结构：
//   b_orange「来福」人设——可见、文本随角色表下发（旧版行为）；
//   b_corpus 语料工法——保持 hidden，工法全文不进渲染进程。
//   注意（1013 起语料与角色解耦）：想让「来福」人设实际作答，
//   把「其它功能的模型 → AI对话 → 语料」挑成「来福」即可。
const BUILTIN_ROLES = [
  { id: 'b_orange', name: '来福', file: 'orange.txt' },
  { id: 'b_corpus', name: '来福语料（阉割版）', file: 'corpus-20260726.txt', hidden: true },
];
let rolesCache = null;
function loadBuiltinRoles() {
  if (rolesCache) return rolesCache;
  rolesCache = BUILTIN_ROLES.map((r) => {
    let prompt = '';
    try { prompt = fs.readFileSync(path.join(ctx.SRC, 'roles', r.file), 'utf8'); } catch (e) {}
    return { id: r.id, name: r.name, hidden: !!r.hidden, prompt };
  });
  return rolesCache;
}
// hidden角色（语料工法）的文本永不出主进程：IPC只发空串，系统提示词在chat-send时主进程内部解析。
// 可见人设角色（来福）沿用旧版行为：文本随角色表下发、界面可读可看。
// 双保险：hidden 的工法全文渲染端就算有 bug 也不会漏给页面/调试器。
ipcMain.handle('chat-builtin-roles', () => loadBuiltinRoles().map((r) => ({
  id: r.id, name: r.name, hidden: r.hidden, prompt: r.hidden ? '' : r.prompt,
})));

// ---------- 语料解析（1013：语料与模型解耦） ----------
// ⚠**"橙子语料"和"内置语料"是两个东西**，用户裁定（1013）分得很清楚，别混：
//   橙子语料 = src/roles/corpus-20260726.txt 那个**角色**（id=b_corpus）→ AI对话 / 转JSON 的默认。
//   内置语料 = **半合成卡写死的那套看图用词**（composite.html 的「你是资深影视场景美术…【角色识别】…」）
//              —— 它**不是角色、没有文件、也不该被叠加**：那套词本来就长在提示词里了，
//                再叠一份角色语料只会顶掉它/串味。所以这一档的语义是"**不叠加角色语料**"。
// pick='' / '__none__' → 不叠加角色语料（半合成的默认）
// pick=b_corpus 或角色名 → 用那个角色的语料
// 1013 第三轮：去掉"空=跟随 currentPreset"那一档（用户裁定"不要显示跟随当前角色、精确到角色名字"）。
//   老配置里的空值由 MIGRATIONS v25 一次性钉成具体角色名，此后 pick 永远是个明确的值。
// ⚠只读不写：这里绝不改 config.chat.currentPreset，否则挑语料会连带把对话里的角色换掉。
const CORPUS_NONE = '__none__';   // "不叠加角色语料" = 半合成的内置语料档
function resolveCorpus(pick) {
  const p = String(pick || '').trim();
  if (p && p !== CORPUS_NONE) {
    // 先按自定义角色名找（用户在下拉里挑的就是它），再按内置角色 id / 名字找
    const cu = (config.chat.presets || []).find((x) => x && x.name === p);
    if (cu && String(cu.prompt || '').trim()) return { text: cu.prompt, from: cu.name, id: p };
    const bi = loadBuiltinRoles().find((r) => r.id === p || r.name === p);
    if (bi && String(bi.prompt || '').trim()) return { text: bi.prompt, from: bi.name, id: bi.id };
    try { ctx.dlog('[chat] 语料 ' + p + ' 找不到（角色可能已删），本次不叠加角色语料'); } catch (e) {}
  }
  // 空 / __none__ / 指向已删角色 → 空文本 = 不叠加（半合成的老行为，也是"找不到"的兜底）
  return { text: '', from: '', id: '' };
}
ctx.resolveCorpus = resolveCorpus;

ipcMain.handle('chat-send', async (_e, { message, image }) => {
  if ((!message || !message.trim()) && !image) return { ok: false, error: '消息不能为空' };

  // 0908 对话渠道独立：按当前角色解析（角色专属模型优先，否则全局对话渠道/模型），与生图渠道零关系
  // 1013：AI对话 也有了功能槽位 caps.chat（原「默认渠道/模型」那块界面删了，槽位搬进「其它功能的模型」）——
  //   填了就用它；留空 = 走角色专属/全局兜底 = 老行为一字不差。
  const { base, key, model, label } = resolveChat('chat');
  if (!base || !key) return { ok: false, error: '请先在「对话设置」给渠道「' + label + '」填 Key' };
  if (!model) return { ok: false, error: '请先在「对话设置」选择模型' };

  // 构建对话历史（只带最近CTX_CAP条给模型，落盘历史可以更长）
  const hist = histLoad();
  const contents = [];
  // 系统提示词解析（全在主进程,hidden语料文本不经过渲染进程）：
  // 1013 改成走 resolveCorpus：语料不再钉死在 currentPreset 上——「其它功能的模型」里 AI对话 那行
  // 可以单独挑一套语料（1013 第三轮起是**具体角色名**，不再有"跟随当前角色"的隐式档）。
  const cp = config.chat.currentPreset || '';
  const sysRes = resolveCorpus((config.chat.corpus || {}).chat);
  let sys = String(sysRes.text || '').trim();
  if (sys && sysRes.id) { try { ctx.dlog('[chat] 语料=' + sysRes.from + '（' + sysRes.id + '）'); } catch {} }
  // 一次性清理：老版本曾把内置角色文本镜像进config.chat.systemPrompt（语料全文躺配置文件里），擦掉
  const bi = loadBuiltinRoles().find((r) => r.id === cp);
  if (bi && config.chat.systemPrompt) { config.chat.systemPrompt = ''; ctx.saveConfig(); }
  if (sys) {
    contents.push({ role: 'user', parts: [{ text: sys }] });
    contents.push({ role: 'model', parts: [{ text: '好的，我明白了。' }] });
  }
  for (const h of hist.slice(-CTX_CAP)) {
    contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.content }] });
  }
  // 本轮用户消息：文字+可选图片（PS选区截图）；历史里的旧图不重发（控token）
  const userParts = [];
  const msgText = (message || '').trim();
  if (msgText) userParts.push({ text: msgText });
  if (image) {
    try {
      const buf = fs.readFileSync(image);
      const ext = path.extname(image).toLowerCase();
      const mime = (ext === '.png') ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      userParts.push({ inlineData: { mimeType: mime, data: buf.toString('base64') } });
    } catch (e) {}
  }
  if (!userParts.length) return { ok: false, error: '消息不能为空' };
  contents.push({ role: 'user', parts: userParts });

  const r = await callLLM({ base, key, model, contents, image }, 120000);
  if (!r.ok) return { ok: false, error: r.error };
  const reply = r.text;
  // 保存对话历史（独立文件，debounce落盘；图片只存路径供气泡缩略图显示）
  const rts = Date.now();
  const msgId = 'm' + rts + '_' + Math.random().toString(36).slice(2, 7);
  hist.push({ role: 'user', content: msgText || '[图片]', ts: rts, img: image || undefined });
  hist.push({ role: 'assistant', content: reply, ts: rts, id: msgId });
  if (hist.length > STORE_CAP) histCache = hist.slice(-STORE_CAP);
  histSave();

  // 广播新消息到所有chat窗口（带id，发起窗口按id去重）
  ctx.broadcast('chat-message', { role: 'assistant', content: reply, ts: rts, id: msgId });
  return { ok: true, reply, ts: rts, id: msgId };
});

// 自然语→JSON提示词转换（提示词卡「转JSON」钮）：聊天渠道模型 + 当前角色语料工法，一次性调用不进聊天历史
ipcMain.handle('chat-to-json', async (_e, { text }) => {
  const t = (text || '').trim();
  if (!t) return { ok: false, error: '内容为空' };
  // 1011 定的是"转JSON 跟随当前角色"；1013 第三轮改成**语料由转JSON 那格自己指定**（具体角色名），
  //   与对话里选着谁无关。**只读，不动 currentPreset**：用户在对话里选着角色A，这里挑语料B 转JSON，
  //   对话那边仍应是A。
  const { base, key, model, label } = resolveChat('json');
  if (!base || !key) return { ok: false, error: '请先在AI对话设置里给渠道「' + label + '」填 Key' };
  if (!model) return { ok: false, error: '请先在AI对话设置里选择模型' };
  const corpusText = resolveCorpus((config.chat.corpus || {}).json).text || '';
  const contents = [];
  if (String(corpusText).trim()) {
    contents.push({ role: 'user', parts: [{ text: String(corpusText).trim() }] });
    contents.push({ role: 'model', parts: [{ text: '好的，我明白了。' }] });
  }
  contents.push({ role: 'user', parts: [{ text:
    '将下面的自然语言需求直接转换为完整JSON格式提示词。本次为一键转换：不要提问，信息不足处按推荐默认直接决定（你看着办）。只输出提示词正文（放在```代码块中），不加任何其他说明：\n\n' + t }] });
  const r = await callLLM({ base, key, model, contents, genCfg: { temperature: 0.7, topP: 0.95, maxOutputTokens: 8192 } }, 180000);
  if (!r.ok) return { ok: false, error: r.error };
  // 提取代码块正文；没有代码块就用全文
  const m = r.text.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  return { ok: true, prompt: (m ? m[1] : r.text).trim() };
});

// 通用一次性问答（半合成"IP植入物生成"等功能用）：聊天渠道模型，不进聊天历史
// 可选imageBase64（jpeg裸base64，如PS选区截图）→ 多模态构图分析
ipcMain.handle('chat-ask', async (_e, { prompt, imageBase64 }) => {
  const t = (prompt || '').trim();
  if (!t) return { ok: false, error: '内容为空' };
  // 1011：半合成IP清单生成走 caps.ask 槽位（没填=跟随默认，行为不变）
  const { base, key, model, label } = resolveChat('ask');
  if (!base || !key) return { ok: false, error: '请先在AI对话设置里给渠道「' + label + '」填 Key' };
  if (!model) return { ok: false, error: '请先在AI对话设置里选择模型' };
  const parts = [{ text: t }];
  if (imageBase64) parts.push({ inlineData: { mimeType: 'image/jpeg', data: imageBase64 } });
  // 语料（1013）：半合成识图也有自己的语料槽了。默认 '__builtin__'=内置语料 —— **与改之前等价**
  // （这条链原来靠 composite.html 里写死的提示词工作，不带系统提示词；给内置那份不会改变它的表现，
  //   因为内置语料是"提示词工法"而这里要的是"识图美术判断"，两者不冲突但也不该被用户的对话语料悄悄替换）。
  const askSys = String(resolveCorpus((config.chat.corpus || {}).ask || CORPUS_BUILTIN).text || '').trim();
  const contents = [];
  if (askSys) {
    contents.push({ role: 'user', parts: [{ text: askSys }] });
    contents.push({ role: 'model', parts: [{ text: '好的，我明白了。' }] });
  }
  contents.push({ role: 'user', parts });
  // 输出上限与对话卡同为 8192（0908 由 2048 抬高）：半合成的 IP 清单提示词长且带图，思考型模型
  // （用户自定义渠道的 gemini-3.7-flash-high 等）思考 token 计入输出额度——实测一个 30 字小问题就烧 606 个，
  // 2048 被思考吃光→正文为空→"未返回有效内容"（对话卡用 8192 所以正常，半合成独报错正是这条）
  const r = await callLLM({ base, key, model, contents, genCfg: { temperature: 0.8, topP: 0.95, maxOutputTokens: 8192 }, image: imageBase64 }, 120000);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, text: r.text.trim() };
});

ipcMain.handle('chat-clear', () => {
  histCache = [];
  // config侧的旧历史残留（迁移前清空的场景）一并清掉
  if (Array.isArray(config.chat.history) && config.chat.history.length) {
    config.chat.history = [];
    ctx.saveConfig();
  }
  histSave();
  return { ok: true };
});

ipcMain.handle('chat-get-history', () => histLoad());
