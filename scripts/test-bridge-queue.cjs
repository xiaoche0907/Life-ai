const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const file = path.join(__dirname, '../src/core/bridge-install.js');
const code = fs.readFileSync(file, 'utf8');
async function scenario({ alive = true, current = false, processError = false, installerError = false, permissionDenied = false } = {}) {
  const state = { alive, current, installs: 0, scheduled: [], broadcasts: [] };
  const handlers = {};
  const manifest = { id: 'com.orange.bridge', version: '1.0.59' };
  const ext = path.join('C:\\Program Files\\Common Files\\Adobe\\UXP', 'Plugins', 'External');
  const stable = path.join(ext, 'com.orange.bridge_live');
  const reg = path.join('C:\\Program Files\\Common Files\\Adobe\\UXP', 'PluginsInfo', 'v1', 'PS.json');
  const fakeFS = {
    existsSync: (p) => state.current && (p === ext || p === reg),
    readFileSync: (p) => {
      if (p === reg) return JSON.stringify({ plugins: [{ pluginId: manifest.id, versionString: manifest.version, status: 'enabled', path: '$systemPlugins\\External\\com.orange.bridge_live' }] });
      if (p.endsWith('result.json')) return JSON.stringify(permissionDenied ? { ok: false, error: 'Access denied', code: 'PERMISSION_DENIED' } : installerError ? { ok: false, error: 'DENIED' } : { ok: true, updated: true, removed: 2 });
      if (p.endsWith('manifest.json')) return JSON.stringify(manifest);
      throw Error('Unexpected read: ' + p);
    },
    readdirSync: (p, opts) => p === ext && opts ? [{ name: 'com.orange.bridge_live', isDirectory: () => true }] : [],
    mkdtempSync: () => 'mock-job', rmSync: () => {},
  };
  const context = {
    require: (id) => {
      if (id === 'electron') return { app: { isPackaged: false, getPath: () => 'mock-data', whenReady: () => new Promise(() => {}), on: () => {} }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
      if (id === 'path') return path;
      if (id === 'fs') return fakeFS;
      if (id === './ctx') return { SRC: 'mock-src', broadcast: (...args) => state.broadcasts.push(args), olog: () => {} };
      if (id === 'child_process') return { execFile: (cmd, args, opts, cb) => {
        if (cmd === 'tasklist.exe') return cb(processError ? Error('timeout') : null, state.alive ? '"Photoshop.exe","123"' : '');
        state.installs++;
        if (!installerError) state.current = true;
        cb(null);
      } };
      throw Error(id);
    },
    setTimeout: (fn) => { const timer = { fn, unref() {} }; state.scheduled.push(timer); return timer; },
    clearTimeout: () => {}, Buffer, console,
  };
  vm.runInNewContext(code, context, { filename: file });
  return { state, handlers, stable };
}
(async () => {
  const queued = await scenario();
  const first = await queued.handlers['bridge-reinstall']();
  assert.equal(first.status, 'waiting');
  assert.equal(queued.state.installs, 0);
  queued.state.alive = false;
  await queued.state.scheduled.shift().fn();
  assert.equal(queued.state.installs, 1);
  assert.equal(queued.handlers['bridge-install-status']().status, 'installed');
  const error = await scenario({ alive: false, processError: true });
  assert.equal((await error.handlers['bridge-reinstall']()).ok, false);
  assert.equal(error.state.installs, 0);
  const force = await scenario({ alive: false, current: true });
  assert.equal((await force.handlers['bridge-reinstall']()).updated, true);
  assert.equal(force.state.installs, 1);
  const failed = await scenario({ alive: false, installerError: true });
  assert.equal((await failed.handlers['bridge-reinstall']()).status, 'error');
  const denied = await scenario({ alive: false, permissionDenied: true });
  const deniedResult = await denied.handlers['bridge-reinstall']();
  assert.equal(deniedResult.status, 'needs-admin');
  assert.equal(deniedResult.needsAdmin, true);
  console.log('PASS: waiting without writes, automatic resume, process-query failure, forced repair, installer failure, administrator guidance.');
})().catch((error) => { console.error(error); process.exitCode = 1; });
