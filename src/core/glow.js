// 辉光卡主进程（0912 新起炉灶，不碰现有模块）：单一 IPC 通道 'glow'，op 分派。
//   capture   ：读 PS 当前画面（有选区=选区像素，无选区=整幅画布），走桥接现成 captureInput（fullIfNoSel），桥接零改动
//   bake      ：渲染端算好的「黑底辉光层」PNG 落盘 → placeImage 贴回原选区（现成链路，带重试）→ 一条 batchPlay 改名+混合模式+不透明度
//   presets   ：出厂 4 套（引擎里）+ 用户预设（文档\橙子\glow-presets\*.json）
//   preset-save / preset-delete / open-folder
const { ipcMain, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const GE = require('../renderer/glow-engine.js');

const olog = (m, t) => ctx.olog(m, t);
const dlog = (m) => { try { ctx.dlog('[glow] ' + m); } catch (e) {} };
const presetDir = () => path.join(app.getPath('documents'), '橙子', 'glow-presets');
const LAYER_NAME = '橙子辉光';
// 0916 起色散不再单独成层（渲染端 merge() 焊进辉光层），这个名字只留作历史注记：老版本贴过叫这个的层
const b64Of = (dataUrl) => { const s = String(dataUrl || ''); return s.indexOf(',') !== -1 ? s.split(',')[1] : s; };

// 按名定位刚置入的层（图层名=文件名，置入链路约定）→ 一条 batchPlay 设混合/不透明度 + 改名。
// ⚠真机实证（0912）：name + mode + opacity 写在同一条 set 里 PS 只吃 name（坑 204 同族"同条只吃一个"）→ 拆两条：先混合+不透明度（此时还叫 base，唯一），再改名
// 先试"文档id 里的该层"双层引用，个别版本不认再退回纯按名
async function setPlacedLayer(base, docId, name, blend, opacity) {
  const mk = (tgt) => [
    { _obj: 'set', _target: tgt, to: { _obj: 'layer', mode: { _enum: 'blendMode', _value: blend }, opacity: { _unit: 'percentUnit', _value: opacity } } },
    { _obj: 'set', _target: tgt, to: { _obj: 'layer', name } },
  ];
  const targets = [];
  if (docId) targets.push([{ _ref: 'layer', _name: base }, { _ref: 'document', _id: docId }]);
  targets.push([{ _ref: 'layer', _name: base }]);
  let br = null;
  for (const tgt of targets) {
    br = await ctx.sendToPSAwait({ action: 'batchPlay', params: { commandName: '橙子辉光：混合与命名', descriptors: mk(tgt) } }, 30000);
    if (br && br.ok) return br;
    dlog('set layer ' + name + ' 失败(' + tgt.length + '级引用): ' + (br && br.error));
  }
  return br;
}

function listPresets() {
  const out = GE.FACTORY_PRESETS.map((p) => ({ id: p.id, name: p.name, factory: true, params: Object.assign({}, p.params) }));
  const dir = presetDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (!j || !j.name || !j.params) continue;
        out.push({ id: 'u_' + f.replace(/\.json$/, ''), name: String(j.name).slice(0, 40), factory: false, file: f, params: GE.normParams(j.params) });
      } catch (e) { dlog('预设解析失败 ' + f + ': ' + (e && e.message)); }
    }
  } catch (e) { dlog('预设夹不可读: ' + (e && e.message)); }
  return out;
}
const safeName = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);

// 辉光是纯本地处理、不发网络，采集不该受 1568 那个"控请求体积"的上限（0916 用户报色散清晰度低，
// 实测辉光层全是 1568×882，贴回 6000×4000 的 RAW 被拉 3.8 倍）。给足长边，原图多大采多大。
const CAPTURE_MAX_EDGE = 6000;
async function capture() {
  const r = await ctx.sendToPSAwait({ action: 'captureInput', params: { antiMode: 0, fullIfNoSel: true, maxEdge: CAPTURE_MAX_EDGE } }, 60000);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'PS 未连接' };
  const res = r.result || {};
  if (!res.image) return { ok: false, error: res.note || '没有读到画面（PS 里有打开的文档吗？）' };
  dlog('capture doc=' + res.docId + ' sel=' + JSON.stringify(res.selection) + ' full=' + !!res.fullMode + ' maxEdge=' + CAPTURE_MAX_EDGE + (res.note ? ' note=' + res.note : ''));
  return { ok: true, docId: res.docId || null, selection: res.selection || null, fullMode: !!res.fullMode, image: res.image, mime: res.mime || 'image/jpeg', note: res.note || '' };
}

async function bake(p) {
  const b64 = b64Of(p && p.dataUrl);
  if (!b64) return { ok: false, error: '辉光层数据为空' };
  const pctx = (p && p.pctx) || {};
  if (!pctx.selection) return { ok: false, error: '没有画面上下文，先点「读取画面」' };
  const params = GE.normParams(p && p.params);
  const dir = ctx.genDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const placeOpts = (file) => ({ path: file, docId: pctx.docId || null, selection: pctx.selection, antiMode: 0 });

  // 0916 用户裁定：色散开着时只给**一个**图层。渲染端已用 glow-engine 的 merge() 把辉光焊进色散图，
  // 这里只贴那一层。合并层是"完整画面"（不再是黑底），所以必须按正常/100% 贴——
  // 仍按用户选的混合模式贴会把画面又叠一遍。lensMerged 由渲染端置位。
  const lensMerged = !!(p && p.lensMerged);

  // 辉光层：未合并=黑底 + 用户选的混合模式/不透明度；已合并=完整画面 + 正常/100%
  const base = 'glow_' + stamp;
  const file = path.join(dir, base + '.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  const pr = await ctx.placeWithRetry('placeImage', placeOpts(file), 120000);
  if (!pr || !pr.ok) {
    olog('[辉光] 置入失败: ' + ((pr && pr.error) || ''), 'err');
    return { ok: false, error: (pr && pr.error) || '置入失败' };
  }
  const blend = lensMerged ? 'normal' : params.blend;
  const opacity = lensMerged ? 100 : params.opacity;
  const br = await setPlacedLayer(base, pctx.docId, LAYER_NAME, blend, opacity);
  const modeTxt = lensMerged ? '正常' : (params.blend === 'linearDodge' ? '线性减淡' : params.blend === 'lighten' ? '变亮' : '滤色');
  if (!br || !br.ok) {
    olog('[辉光] 已置入但混合模式/命名设置失败（请手动改成' + modeTxt + '）: ' + ((br && br.error) || ''), 'err');
    return { ok: true, file, layer: base, warn: '混合模式未设置' };
  }
  olog('✓ [辉光] 已置入「' + LAYER_NAME + '」（' + modeTxt + ' · ' + opacity + '%'
    + (pctx.fullMode ? ' · 全图' : ' · 选区') + (lensMerged ? ' · 色散已合并进本层' : '') + ')');
  return { ok: true, file, layer: LAYER_NAME };
}

function presetSave(p) {
  const name = safeName(p && p.name);
  if (!name) return { ok: false, error: '预设名为空' };
  const dir = presetDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name + '.json');
  fs.writeFileSync(file, JSON.stringify({ name, params: GE.normParams(p && p.params) }, null, 2), 'utf8');
  dlog('preset saved ' + file);
  return { ok: true, id: 'u_' + name, presets: listPresets() };
}
function presetDelete(id) {
  const hit = listPresets().find((x) => x.id === id);
  if (!hit) return { ok: false, error: '预设不存在' };
  if (hit.factory) return { ok: false, error: '出厂预设不能删' };
  try { fs.unlinkSync(path.join(presetDir(), hit.file)); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, presets: listPresets() };
}

ipcMain.handle('glow', async (_e, msg) => {
  const op = msg && msg.op, payload = msg && msg.payload;
  try {
    switch (op) {
      case 'capture': return await capture();
      case 'bake': return await bake(payload);
      case 'presets': return { ok: true, presets: listPresets() };
      case 'preset-save': return presetSave(payload);
      case 'preset-delete': return presetDelete(payload && payload.id);
      case 'open-folder': { const d = presetDir(); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); return { ok: true }; }
      default: return { ok: false, error: '未知操作 ' + op };
    }
  } catch (e) {
    dlog(op + ' 异常: ' + (e && e.stack || e));
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// 机测直调（smoke / 真机脚本）
ctx.glowCapture = capture;
ctx.glowBake = bake;
ctx.glowPresets = listPresets;
