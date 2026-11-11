const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = path.resolve(__dirname, '../src');
const source = fs.readFileSync(path.join(src, 'core/plib.js'), 'utf8');
const files = fs.readdirSync(path.join(src, 'factory_prompts')).filter((name) => /^xc-.*\.json$/.test(name));
assert.equal(files.length, 9);
const ids = new Set();
for (const file of files) {
  const prompt = JSON.parse(fs.readFileSync(path.join(src, 'factory_prompts', file), 'utf8'));
  assert.match(prompt.id, /^xc_/);
  assert(!ids.has(prompt.id));
  ids.add(prompt.id);
  assert(['cloth', 'scene'].includes(prompt.group));
  assert(prompt.name && prompt.text.includes('图1') && prompt.text.includes('图2'));
  assert(!/\$\{|\{\{/.test(prompt.text), '不能遗留运行时变量');
}

// 在内存中模拟用户库，调用真实plib-get，不读写用户的个人词库。
function load(saved) {
  const handlers = {};
  const fileSystem = Object.create(fs);
  fileSystem.readFileSync = (file, ...args) => {
    if (path.basename(file) === 'prompt-library.json') {
      if (!saved) throw Object.assign(new Error('不存在'), { code: 'ENOENT' });
      return JSON.stringify(saved);
    }
    return fs.readFileSync(file, ...args);
  };
  const context = {
    require: (name) => {
      if (name === 'electron') return { app: { getPath: () => '/virtual-documents', on() {} }, ipcMain: { handle: (id, handler) => { handlers[id] = handler; } }, dialog: {} };
      if (name === 'fs') return fileSystem;
      if (name === './ctx') return { SRC: src };
      return require(name);
    },
    setTimeout: () => 0, clearTimeout() {}, Date,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return JSON.parse(JSON.stringify(handlers['plib-get']()));
}

const first = load();
const added = first.prompts.filter((p) => p.id.startsWith('factory_xc_'));
assert.equal(added.length, 9);
assert.equal(added.filter((p) => p.group === 'cloth').length, 6);
assert.equal(added.filter((p) => p.group === 'scene').length, 3);
for (const p of added) assert(first.groups.some((g) => g.id === p.group));
const second = load(first);
assert.equal(second.prompts.length, first.prompts.length);
const deleted = added[0];
second.prompts = second.prompts.filter((p) => p.id !== deleted.id);
second.trash = [deleted];
const third = load(second);
assert(!third.prompts.some((p) => p.id === deleted.id));
console.log('通过：9个词条真实加载、6服饰/3场照、稳定ID、重复加载去重、回收站删除保护');
