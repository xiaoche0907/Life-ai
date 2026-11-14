// 肤色统一 IPC/写回链路回归：模拟 ctx 与 PS 宿主，验证任务绑定、蒙版尺寸校验、重复提交保护
const path = require('path');
const Module = require('module');

// ---- 模拟 electron ----
const handlers = new Map();
const fakeIpcMain = { handle: (n, fn) => handlers.set(n, fn) };
const origLoad = Module._load;
const fs = require('fs');
const genDir = path.join(__dirname, 'tmp-skinmatch-gen');
fs.mkdirSync(genDir, { recursive: true });
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { ipcMain: fakeIpcMain, dialog: {}, nativeImage: { createFromBitmap: () => ({ toPNG: () => Buffer.from('fakepng') }) } };
  return origLoad.apply(this, arguments);
};

// ---- 模拟 ctx ----
let psCalls = [];
let comPng = null;
const jobsStore = new Map();
const fakeCtx = {
  olog: () => {},
  genDir: () => path.join(__dirname, 'tmp-skinmatch-gen'),
  sendToPSAwait: async (msg) => {
    psCalls.push(msg);
    if (msg.action === 'inspectRecolorDocument') return { ok: true, result: { ok: true, docId: 1, name: 'test.psd', width: 800, height: 1000, groups: [{ id: 7, name: '模特组', path: '模特组', enabled: true }] } };
    if (msg.action === 'readMaskGroup') { const W=8,H=8; return { ok: true, result: { ok: true, docId: 1, layerId: 7, layerName: '模特组', width: W, height: H, maskWidth: W, maskHeight: H, weightB64: Buffer.alloc(W * H, 255).toString('base64'), bounds: { x: 0, y: 0, width: W, height: H }, rgbaB64: Buffer.alloc(W * H * 4, 255).toString('base64'), coveredPct: 100 } }; }
    if (msg.action === 'placeSkinMatchLayers') return { ok: true, result: { ok: true, groupName: '模特组', layerIds: [11, 12] } };
    return { ok: false, error: '未知命令: ' + msg.action };
  },
  bridgeVer: () => 69,
  comBridge: { tryCall: async (cmd) => {
    if (cmd.action === 'writeLayerMask') {
      psCalls.push(cmd);
      try { comPng = require('fs').readFileSync(cmd.params.pngPath); } catch (e) { comPng = null; }
      return { ok: true, result: { detail: 'OK mock' } };
    }
    return { ok: false, error: '未知COM命令: ' + cmd.action };
  } },
};

const ctxPath = require.resolve('../src/core/ctx.js');
require.cache[ctxPath] = { id: ctxPath, filename: ctxPath, loaded: true, exports: fakeCtx };

require('../src/core/skinmatch.js');

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '：' + e.message); }
}
function assert(cond, msg) { if (!cond) throw Error(msg); }

const native = require('../ps-bridge/recolor-native.js');
const goodRecipe = { version: 1, mode: 'mode1', algorithm: 'skinmatch-native-v1', layers: [
  { name: '肤色明度—曲线', kind: 'curves', blend: 'luminosity', opacity: 1, fillOpacity: 1, channels: [[{ input: 0, output: 0 }, { input: 255, output: 255 }]] },
  { name: '肤色颜色—RGB曲线', kind: 'curves', blend: 'color', opacity: 1, fillOpacity: 1, channels: [[{ input: 0, output: 0 }, { input: 255, output: 255 }], [{ input: 0, output: 10 }, { input: 255, output: 255 }], [{ input: 0, output: 0 }, { input: 255, output: 255 }], [{ input: 0, output: 5 }, { input: 255, output: 255 }]] },
] };

(async () => {
  await check('文档扫描转发', async () => {
    const r = await handlers.get('skinmatch-inspect-document')();
    assert(r.ok && r.docId === 1 && r.groups.length === 1, '扫描结果异常');
  });

  await check('蒙版读取转发', async () => {
    const r = await handlers.get('skinmatch-read-mask')({}, { docId: 1, layerId: 7 });
    assert(r.ok && r.layerName === '模特组', '蒙版读取异常');
    assert(r.weightB64.length > 0, '蒙版权重缺失');
  });

  await check('落盘：合法任务', async () => {
    const r = await handlers.get('skinmatch-save')({}, { item: { name: '肤色统一·测试', recipe: goodRecipe, maskB64: Buffer.alloc(100, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    assert(r.ok && r.jobId, '合法任务被拒绝: ' + (r.error || ''));
    jobsStore.set(r.jobId, r.jobId);
  });

  await check('落盘：拒绝无效配方', async () => {
    const bad = JSON.parse(JSON.stringify(goodRecipe)); bad.layers[0].channels = [];
    const r = await handlers.get('skinmatch-save')({}, { item: { name: 'x', recipe: bad, maskB64: Buffer.alloc(100, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    assert(!r.ok, '无效配方未被拒绝');
  });

  await check('落盘：拒绝蒙版尺寸不一致', async () => {
    const r = await handlers.get('skinmatch-save')({}, { item: { name: 'x', recipe: goodRecipe, maskB64: Buffer.alloc(50, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    assert(!r.ok, '蒙版尺寸校验未生效');
  });

  await check('写回：任务绑定文档与组，无像素回传', async () => {
    psCalls.length = 0;
    const save = await handlers.get('skinmatch-save')({}, { item: { name: '肤色统一·绑定', recipe: goodRecipe, maskB64: Buffer.alloc(100, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    assert(save.ok, '落盘失败');
    const r = await handlers.get('skinmatch-place')({}, { jobId: save.jobId });
    assert(r.ok && r.groupName === '模特组', '写回失败: ' + (r.error || ''));
    const uxpCall = psCalls.find(c => c.action === 'placeSkinMatchLayers');
    const comCall = psCalls.find(c => c.action === 'writeLayerMask');
    assert(uxpCall && comCall, '未走 placeSkinMatchLayers 或 writeLayerMask（共 ' + psCalls.length + ' 调用: ' + psCalls.map(c => c.action).join(',') + '）');
    const params = uxpCall.params;
    assert(params.docId === 1 && params.layerId === 7, '任务未绑定源文档与组');
    assert(typeof params.maskB64 === 'string' && params.maskWidth === 10 && params.maskHeight === 10, '蒙版参数缺失');
    assert(!('rgbaB64' in params) && !('image' in params), '写回不应包含成品像素');
    assert(comCall.params.docId === 1 && comCall.params.layerId && comCall.params.pngPath, 'COM蒙版写入参数缺失');
    assert(comPng && comPng.length > 8 && comPng[0] === 0x89 && comPng[1] === 0x50, 'COM蒙版PNG无效');
    // PNG尺寸：IHDR在字节16-23，宽=10高=10
    const w = comPng.readUInt32BE(16), h = comPng.readUInt32BE(20);
    assert(w === 10 && h === 10, 'PNG尺寸不符: ' + w + 'x' + h);
    assert(native.validate(params.recipe), '写回配方应通过原生校验');
  });

  await check('写回：重复提交保护', async () => {
    const save = await handlers.get('skinmatch-save')({}, { item: { name: '肤色统一·重复', recipe: goodRecipe, maskB64: Buffer.alloc(100, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    const first = await handlers.get('skinmatch-place')({}, { jobId: save.jobId });
    assert(first.ok, '首次写回失败');
    const again = await handlers.get('skinmatch-place')({}, { jobId: save.jobId });
    assert(again.ok && again.groupName === first.groupName, '成功任务缓存未生效');
  });

  await check('写回：未知任务拒绝', async () => {
    const r = await handlers.get('skinmatch-place')({}, { jobId: 'no-such-job' });
    assert(!r.ok && /已失效/.test(r.error), '未知任务未被拒绝');
  });

  await check('写回：旧桥接明确拦截', async () => {
    fakeCtx.bridgeVer = () => 67;
    const save = await handlers.get('skinmatch-save')({}, { item: { name: '肤色统一·旧桥', recipe: goodRecipe, maskB64: Buffer.alloc(100, 128).toString('base64'), maskWidth: 10, maskHeight: 10 }, capture: { docId: 1, layerId: 7 } });
    const r = await handlers.get('skinmatch-place')({}, { jobId: save.jobId });
    assert(!r.ok && /v68|v69|桥接/.test(r.error), '旧桥接未拦截: ' + (r.error || ''));
    fakeCtx.bridgeVer = () => 69;
  });

  process.exit(failures ? 1 : 0);
})();
