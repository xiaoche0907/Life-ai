// node scripts/test-garment-retouch.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ratio = require('../src/core/eff-ratio');
const prompts = require('../src/renderer/garment-retouch-prompts');

const source = path.join(__dirname, '../src/core');
const handlers = new Map();
const cards = [], commands = [], tasks = [], requests = [];
const selection = { left: 5, top: 10, right: 305, bottom: 410 };
let capture = { docId: 17, selection, image: 'selected-image' };
let placement = { ok: true, result: { placed: 1 } };
let bridge = 77;
const config = { gen: { noSelFull: true, antiMode: 1, refs: ['user-reference.png'] } };
const ctx = {
  config, psConnected: () => true, bridgeVer: () => bridge, curBridgeVer: 77,
  settleChartIfOn: async () => {}, humanizeErr: error => error,
  showCard: id => cards.push(id), resolveGen: () => ({ prov: 'current', model: 'image-model', meta: { label: '测试渠道' }, effSize: '2K' }),
};
const gen = fs.readFileSync(path.join(source, 'gen.js'), 'utf8');
const start = gen.indexOf('async function runBatch(');
const end = gen.indexOf("ipcMain.handle('ai-generate-batch'", start);
assert.ok(start >= 0 && end > start);
ctx.runBatch = vm.runInNewContext(gen.slice(start, end) + '\nrunBatch', {
  ctx, config, olog() {}, applyPromptControls: text => text, broadcast() {}, ratioWarn() {},
  fs: { appendFileSync() {}, mkdirSync() {}, writeFileSync() {} }, path, Buffer,
  uniq: () => 'test', genDir: () => '.', thumbOf: () => 'input-thumb',
  batchSeq: 0, genSeq: 0, genTasks: tasks, placingBatches: new Set(), broadcastTasks() {},
  resolveGen: ctx.resolveGen, effRatio: ratio.effRatio, previewsOf: () => ({ thumb: 'thumb', mid: 'mid' }),
  generateOne: async params => { requests.push(params); assert.equal(tasks[0].status, 'running'); return { ok: true, file: 'result.png' }; },
  sendToPSAwait: async command => { commands.push(command); return { ok: true, result: capture }; },
  placeWithRetry: async (action, params) => { commands.push({ action, params }); return placement; },
});
vm.runInNewContext(fs.readFileSync(path.join(source, 'garment-retouch.js'), 'utf8'), {
  require(id) {
    if (id === 'electron') return { ipcMain: { handle: (name, fn) => handlers.set(name, fn) } };
    if (id === './ctx') return ctx;
    if (id === './eff-ratio') return ratio;
    if (id === '../renderer/garment-retouch-prompts') return prompts;
    throw Error(id);
  },
});

async function run() {
  const socket = {};
  const click = () => ctx.garmentPanelRequest(socket, 'generate', { group: 0, preset: 0 });
  const result = await click();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pending, false);
  assert.equal(cards[0], 'progress');
  assert.deepEqual(commands.map(command => command.action), ['captureInput', 'placeBatch']);
  assert.equal(commands[0].params.fullIfNoSel, false);
  assert.equal(commands[1].params.group, true);
  assert.equal(commands[1].params.selection, selection);
  assert.equal(requests[0].inputImage, 'selected-image');
  assert.equal(requests[0].maskPng, undefined);
  assert.equal(requests[0].refs, config.gen.refs);
  assert.equal(requests[0].prompt, prompts.groups[0][1][0][1]);
  assert.equal(tasks[0].status, 'placed');
  assert.equal(tasks[0].docId, 17);
  assert.equal(tasks[0].file, 'result.png');
  assert.equal(tasks[0].thumb, 'thumb');
  const desktop = () => handlers.get('garment-retouch-generate')({ sender: {} }, { provider: 'current', model: 'image-model', prompt: '修复缝线' });
  config.gen.autoReturn = false;
  assert.equal((await desktop()).pending, true);
  assert.equal(tasks[0].status, 'done');
  assert.equal(commands.filter(command => command.action === 'placeBatch').length, 1);
  config.gen.autoReturn = true;
  placement = { ok: true, result: { placed: 0, note: '没有创建图层' } };
  assert.match((await click()).note, /没有创建图层/);
  assert.equal(tasks[0].status, 'done');
  bridge = 75;
  assert.match((await click()).error, /生成进度/);
  capture = { docId: 17 };
  const previous = requests.length;
  assert.match((await click()).error, /没有选区/);
  assert.equal(requests.length, previous);
  assert.equal(handlers.has('garment-retouch-apply'), false);
  console.log('通过：侧栏与桌面卡均复用正常生图的选区、进度、自动分组贴回和待贴回状态');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
