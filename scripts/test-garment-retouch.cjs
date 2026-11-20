// Run with Electron: electron scripts/test-garment-retouch.cjs
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { nearestRatio, RATIO_SNAP } = require('../src/core/eff-ratio');

const handlers = {};
const width = 19, height = 16;
const mask = Buffer.alloc(width * height, 255);
mask[0] = 0;
mask[1] = 128;
const sourceImage = nativeImage.createFromBitmap(Buffer.alloc(width * height * 4, 255), { width, height });
const bounds = { left: 20, top: 30, right: 39, bottom: 46 };
let selectedModel = 'test-image';
let generationCalls = 0;
let captureEnabled = false;
let wrongRatio = false;
let placed;
let rejectPlace = true;
const ctx = {
  config: { gen: { size: '2K' } },
  resolveGen: () => ({ prov: 'mock', meta: { label: '测试渠道' }, model: selectedModel, effSize: '2K', base: 'mock', key: 'mock' }),
  psConnected: () => true, bridgeVer: () => 70, curBridgeVer: 70,
  keyIssue: () => '', humanizeErr: error => error,
  sendToPSAwait: async ({ action, params }) => {
    if (action === 'captureGarmentRetouch') {
      if (!captureEnabled) return { ok: false, error: '请先建立选区' };
      return { ok: true, result: { docId: 17, title: '测试文档', revision: 91, bounds, width, height, image: sourceImage.toJPEG(100).toString('base64'), mask: mask.toString('base64') } };
    }
    assert.equal(action, 'placeGarmentRetouch');
    if (rejectPlace) return { ok: false, error: '请切回原文档' };
    placed = params;
    return { ok: true, result: { layerId: 123 } };
  },
  generateOne: async request => {
    generationCalls++;
    assert.equal(request.model, selectedModel);
    assert.equal(request.size, request.ratio === '1:1' ? '4K' : '2K');
    assert.equal(request.rememberModel, false);
    assert.match(request.prompt, /灰度编辑蒙版/);
    const inputImage = nativeImage.createFromBuffer(Buffer.from(request.inputImage, 'base64'));
    const guidance = nativeImage.createFromBuffer(request.maskPng);
    const { width: w, height: h } = inputImage.getSize();
    assert.deepEqual(guidance.getSize(), inputImage.getSize());
    assert.equal(w / h, request.ratio === '1:1' ? 1 : 5 / 4);
    if (request.ratio !== '1:1') {
      const bytes = guidance.toBitmap();
      assert.deepEqual([...bytes.subarray(0, 8)], [0, 0, 0, 255, 128, 128, 128, 255]);
    }
    if (wrongRatio) return { ok: true, file: sourceImage };
    const generated = Buffer.alloc(w * h * 4);
    for (let i = 0; i < generated.length; i += 4) {
      generated[i + 2] = 255;
      generated[i + 3] = 255;
    }
    return { ok: true, file: nativeImage.createFromBitmap(generated, { width: w, height: h }) };
  },
};

const source = path.join(__dirname, '../src');
vm.runInNewContext(fs.readFileSync(path.join(source, 'core/garment-retouch.js'), 'utf8'), {
  require(id) {
    if (id === 'electron') return {
      ipcMain: { handle: (key, cb) => { handlers[key] = cb; } },
      nativeImage: { createFromBuffer: nativeImage.createFromBuffer, createFromBitmap: nativeImage.createFromBitmap, createFromPath: image => image },
    };
    if (id === './ctx') return ctx;
    if (id === './eff-ratio') return { nearestRatio, RATIO_SNAP };
    if (id === '../renderer/garment-retouch-prompts') return require('../src/renderer/garment-retouch-prompts');
    throw Error(id);
  },
  Buffer,
});

async function verifyHostWrite(params) {
  const hostPath = path.join(__dirname, '../ps-bridge/garment-retouch.host.js');
  const events = [];
  const original = { id: 12 };
  const layer = { id: 123 };
  const document = { id: 17, width: 200, height: 200, activeHistoryState: { id: 91 }, layers: [original], activeLayers: [original] };
  let failWrite = false;
  const photoshop = {
    app: { activeDocument: document },
    action: { batchPlay: async () => {
      document.layers.unshift(layer);
      document.activeLayers = [layer];
      return [{}];
    } },
    core: { executeAsModal: fn => fn({ hostControl: {
      suspendHistory: async ({ documentID }) => { assert.equal(documentID, 17); return 1; },
      resumeHistory: async (id, success) => { assert.equal(id, 1); events.push(success); },
    } }) },
    imaging: {
      createImageDataFromBuffer: async (bytes, options) => {
        assert.equal(options.colorSpace, 'RGB');
        assert.equal(options.components, 4);
        assert.deepEqual([...bytes.subarray(0, 12)], [255, 0, 0, 0, 255, 0, 0, 128, 255, 0, 0, 255]);
        return { dispose() { events.push('dispose'); } };
      },
      putPixels: async ({ documentID, layerID, targetBounds }) => {
        assert.equal(documentID, 17);
        assert.equal(layerID, 123);
        assert.equal(targetBounds.left, 20);
        assert.equal(targetBounds.top, 30);
        if (failWrite) throw Error('写入失败');
      },
    },
  };
  const host = { exports: {} };
  vm.runInNewContext(fs.readFileSync(hostPath, 'utf8'), {
    module: host,
    require: id => id === 'photoshop' ? photoshop : { fromBase64: text => Buffer.from(text, 'base64') },
  });
  await assert.rejects(host.exports.place({ ...params, docId: 99 }), /切回/);
  await assert.rejects(host.exports.place({ ...params, revision: 99 }), /原文档已修改/);
  assert.deepEqual(events, []);
  failWrite = true;
  await assert.rejects(host.exports.place(params), /写入失败/);
  assert.deepEqual(events, ['dispose', false]);
  document.layers = [original];
  document.activeLayers = [original];
  failWrite = false;
  assert.equal((await host.exports.place(params)).layerId, 123);
  assert.deepEqual(events, ['dispose', false, 'dispose', true]);
  console.log('通过：模拟 Photoshop 桥接拒绝错文档与过期历史，失败回滚，成功单次提交');
}

async function run() {
  const ev = { sender: {} };
  const generate = handlers['garment-retouch-generate'];
  const apply = handlers['garment-retouch-apply'];
  const request = { prompt: '修复车缝线', provider: 'mock', model: selectedModel };
  assert.equal((await apply(ev)).ok, false);
  assert.match((await generate(ev, { ...request, model: 'stale' })).error, /配置已变化/);
  assert.match((await generate(ev, { ...request, ratio: 'abc' })).error, /出图比例/);
  assert.match((await generate(ev, { ...request, size: '8K' })).error, /分辨率/);
  assert.match((await generate(ev, request)).error, /先建立选区/);
  assert.equal(generationCalls, 0);
  captureEnabled = true;
  wrongRatio = true;
  assert.match((await generate(ev, request)).error, /图片比例/);
  wrongRatio = false;
  const result = await generate(ev, request);
  assert.equal(result.ok, true, result.error);
  const preview = nativeImage.createFromDataURL(result.preview).toBitmap();
  assert.deepEqual([...preview.subarray(0, 12)], [255, 255, 255, 255, 127, 127, 255, 255, 0, 0, 255, 255]);
  assert.equal(placed, undefined);
  assert.match((await apply(ev)).error, /原文档/);
  rejectPlace = false;
  assert.equal((await apply(ev)).ok, true);
  assert.deepEqual([placed.docId, placed.revision], [17, 91]);
  assert.deepEqual(placed.bounds, bounds);
  assert.deepEqual([...Buffer.from(placed.rgba, 'base64').subarray(0, 12)], [255, 0, 0, 0, 255, 0, 0, 128, 255, 0, 0, 255]);
  assert.equal((await apply(ev)).ok, false);
  console.log('通过：模型跟随、无选区防提交、比例校验、预览、蒙版透明度与重复应用保护');
  await verifyHostWrite(placed);
  const square = await generate(ev, { ...request, ratio: '1:1', size: '4K' });
  assert.equal(square.ok, true, square.error);
  const socket = {};
  ctx.isCurrentPSSocket = () => false;
  placed = undefined;
  const panel = await ctx.garmentPanelRequest(socket, 'settings');
  assert.equal(panel.groups[0][1][0], '万能精修');
  assert.equal((await ctx.garmentPanelRequest(socket, 'generate', { group: 999, preset: 0 })).ok, false);
  assert.match((await ctx.garmentPanelRequest(socket, 'generate', { group: 0, preset: 0 })).error, /已断开/);
  assert.equal(placed, undefined);
  ctx.isCurrentPSSocket = peer => peer === socket;
  assert.deepEqual((await ctx.garmentPanelRequest(socket, 'generate', { group: 0, preset: 0 })).layerId, 123);
  assert.equal(placed.docId, 17);
  console.log('通过：Photoshop 侧栏预设校验、断线拦截和单击自动贴回');

  const win = new BrowserWindow({ show: false, width: 820, height: 660 });
  const renderer = path.join(source, 'renderer');
  const html = fs.readFileSync(path.join(renderer, 'garment-retouch.html'), 'utf8');
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(markup));
  const execute = code => win.webContents.executeJavaScript(code);
  for (const file of ['icons.js', 'garment-retouch-prompts.js']) {
    await execute(fs.readFileSync(path.join(renderer, file), 'utf8'));
  }
  await execute(`window.orange = {
    garmentRetouchSettings: async () => ({ provider: 'mock', channel: '测试渠道', model: 'test-image', modelName: '测试模型', defaultSize: '2K', sizes: ['1K', '2K', '4K'], ratios: ['Auto', '1:1'], connected: true, bridge: 70, requiredBridge: 70 }),
    garmentRetouchGenerate: async request => { window.sent = request; return (${JSON.stringify(result)}); },
    garmentRetouchApply: async () => ({ ok: true }),
    onPSStatus() {}, onProvidersChanged() {}, onGenVars() {}, showCard() {}
  }; void 0`);
  await execute(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(await execute('[document.querySelector("#ratio").value, document.querySelector("#size").value]'), ['Auto', '2K']);
  assert.equal(await execute('document.querySelector("#tools button").disabled'), false);
  assert.equal(await execute('document.querySelector("#category").length'), 16);
  assert.equal(await execute('document.querySelectorAll("#constraints input").length'), 13);
  assert.equal(await execute(`(() => {
    const search = document.querySelector('#search');
    search.value = '格纹'; search.dispatchEvent(new Event('input'));
    document.querySelector('#ratio').value = '1:1';
    document.querySelector('#size').value = '4K';
    const tool = document.querySelector('#tools button');
    if (!tool.textContent.includes('格纹')) return false;
    tool.click();
    return window.sent.prompt.includes('修复格纹') && window.sent.ratio === '1:1' && window.sent.size === '4K';
  })()`), true);
  assert.equal(await execute('document.querySelector("#apply").disabled'), false);
  await execute('document.querySelector("#before").click()');
  assert.equal(await execute('document.querySelector("#image").alt'), 'Photoshop 原始选区');
  await execute('document.querySelector("#apply").click()');
  assert.equal(await execute('document.querySelector("#apply").disabled'), true);
  const plugin = path.join(__dirname, '../ps-bridge');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.entrypoints.map(entry => entry.id), ['lifeGarmentRetouch']);
  const icons = [...manifest.icons, ...manifest.entrypoints[0].icons];
  for (const icon of icons) {
    for (const scale of icon.scale) {
      const file = icon.path.replace(/\.png$/, `@${scale}x.png`);
      assert.deepEqual(nativeImage.createFromBuffer(fs.readFileSync(path.join(plugin, file))).getSize(), { width: icon.width * scale, height: icon.height * scale });
    }
  }
  const panelScript = fs.readFileSync(path.join(plugin, 'garment-panel.js'), 'utf8');
  await win.loadFile(path.join(plugin, manifest.main));
  assert.equal(await execute('document.querySelector(".garment-heading img").naturalWidth'), 46);
  assert.match(await execute('document.getElementById("garment-status").textContent'), /框选/);
  await execute(`(() => {
    const module = { exports: {} };
    ${panelScript}
    window.sidebar = module.exports(async (method, params) => {
      if (method === 'settings') return ${JSON.stringify(panel)};
      window.sidebarRequest = params;
      return { ok: true };
    });
    window.sidebar.connected(true);
  })()`);
  assert.equal(await execute(`(() => {
    [...document.querySelectorAll('#garment-params button')].find(button => button.textContent.startsWith('分类')).click();
    [...document.querySelectorAll('#garment-options button')].find(button => button.textContent === '车缝线与针脚').click();
    document.querySelector('#garment-actions button').click();
    return window.sidebarRequest?.size === '2K' && window.sidebarRequest?.ratio === 'Auto' && window.sidebarRequest?.group === 3;
  })()`), true);
  assert.match(await execute('document.querySelector("#garment-status").textContent'), /已贴回/);
  await execute('window.sidebar.connected(false)');
  assert.match(await execute('document.getElementById("garment-model").textContent'), /未连接/);
  assert.equal(await execute('document.querySelector(".garment-heading img").naturalWidth'), 46);
  win.destroy();
  console.log('通过：Electron 卡片分类、搜索、预设选择、预览切换与确认应用');
}

app.whenReady().then(run).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
