const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const code = fs.readFileSync(path.join(__dirname, '../src/core/bridge-install.js'), 'utf8');
const source = path.join('mock', 'ps-bridge');
const machine = 'C:\\Program Files\\Common Files\\Adobe\\UXP';
const ext = path.join(machine, 'Plugins', 'External');
const stable = path.join(ext, 'com.orange.bridge_live');
const registry = path.join(machine, 'PluginsInfo', 'v1', 'PS.json');
const manifest = { id: 'com.orange.bridge', version: '1.0.77' };
const missing = () => Object.assign(Error('Missing path'), { code: 'ENOENT' });

async function scenario({ alive = false, complete = false, deny = false, queryError = false } = {}) {
  const state = { alive, complete, launches: [], timers: [], logs: [] };
  const handlers = {};
  const ctx = {
    SRC: path.join('mock', 'src'),
    comBridge: { psProcessAlive: async () => { if (queryError) throw Error('process query failed'); return state.alive; } },
    olog: message => state.logs.push(message),
    dlog() {},
  };
  const fakeFS = {
    readdirSync(file) {
      if (file === ext) return ['com.orange.bridge_live'];
      if (file === source || file === stable) return ['manifest.json', 'bridge.js', 'presets'];
      if (file === path.join(source, 'presets')) return ['marquee.tpl'];
      throw missing();
    },
    statSync(file) { return { isFile: () => !file.endsWith('presets'), isDirectory: () => file.endsWith('presets') }; },
    readFileSync(file, encoding) {
      if (file === registry) return JSON.stringify({ plugins: [{ ...manifest, pluginId: manifest.id, versionString: manifest.version, path: '$systemPlugins\\External\\com.orange.bridge_live', status: 'enabled' }] });
      if (file.startsWith(stable) && file.endsWith('marquee.tpl') && !state.complete) throw missing();
      if (file.endsWith('manifest.json')) return encoding ? JSON.stringify(manifest) : Buffer.from(JSON.stringify(manifest));
      if (file.startsWith(source) || file.startsWith(stable)) return Buffer.from('resource');
      throw missing();
    },
  };
  vm.runInNewContext(code, {
    require(id) {
      if (id === 'electron') return { app: { isPackaged: false, getPath: () => 'mock-data', whenReady: () => Promise.resolve() }, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } };
      if (id === 'path') return path;
      if (id === 'fs') return fakeFS;
      if (id === './ctx') return ctx;
      if (id === 'child_process') return { execFile(_cmd, args, _opts, cb) {
        const elevated = args.includes('-EncodedCommand');
        state.launches.push(elevated);
        if (!elevated || deny) return cb(Error('Access denied'), '', 'Access denied');
        state.complete = true;
        cb(null);
      } };
      throw Error(id);
    },
    Buffer,
    setTimeout: fn => state.timers.push(fn),
  });
  await Promise.resolve();
  return { ctx, state, reinstall: handlers['bridge-reinstall'] };
}

(async () => {
  const waiting = await scenario({ alive: true });
  await waiting.state.timers.shift()();
  assert.equal(waiting.state.launches.length, 0);
  assert.match(waiting.state.logs[0], /完全退出 Photoshop/);
  assert.match((await waiting.reinstall()).error, /再点重新安装/);
  waiting.state.alive = false;
  await waiting.state.timers.shift()();
  assert.deepEqual(waiting.state.launches, [false, true]);
  assert.equal(waiting.state.complete, true);
  assert.match(waiting.state.logs[1], /安装成功/);

  const intact = await scenario({ complete: true });
  assert.equal((await intact.ctx.installBridge()).updated, false);
  assert.equal(intact.state.launches.length, 0);
  assert.equal((await intact.reinstall()).updated, true);
  assert.deepEqual(intact.state.launches, [false, true]);

  const denied = await scenario({ deny: true });
  assert.match((await denied.ctx.installBridge()).error, /旧机器级桥接修复失败/);
  assert.deepEqual(denied.state.launches, [false, true]);
  assert.equal(denied.state.complete, false);

  const query = await scenario({ queryError: true });
  assert.match((await query.reinstall()).error, /process query failed/);
  assert.equal(query.state.launches.length, 0);
  console.log('PASS: deferred upgrade, automatic resume, same-version repair, manual reinstall, and denied elevation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
