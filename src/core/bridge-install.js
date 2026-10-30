// PS bridge updates run only after Photoshop exits; the shared installer owns replacement/rollback.
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ctx = require('./ctx');

const BRIDGE_ID = 'com.orange.bridge';
const STABLE_NAME = BRIDGE_ID + '_live';
let pendingOptions = null;
let watchTimer = null;
let activeInstall = null;
let installState = { ok: true, status: 'idle', detail: '等待检查 PS 插件' };

function bridgeSrcDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'ps-bridge') : path.join(ctx.SRC, '..', 'ps-bridge');
}
function installerPath() {
  return app.isPackaged ? path.join(process.resourcesPath, 'bridge-machine-install.ps1')
    : path.join(ctx.SRC, '..', 'bridge-machine-install.ps1');
}
function levels() {
  return [
    { root: 'C:\\Program Files\\Common Files\\Adobe\\UXP', token: '$systemPlugins' },
    { root: path.join(app.getPath('appData'), 'Adobe', 'UXP'), token: '$userPlugins' },
  ];
}
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function sameFiles(src, dst) {
  try {
    const names = fs.readdirSync(src);
    if (names.length !== fs.readdirSync(dst).length) return false;
    return names.every((name) => {
      const s = path.join(src, name), d = path.join(dst, name);
      return fs.statSync(s).isDirectory() ? sameFiles(s, d) : fs.readFileSync(s).equals(fs.readFileSync(d));
    });
  } catch { return false; }
}
function isCurrent(src, manifest) {
  let copies = 0, entries = 0, valid = false;
  try {
    for (const level of levels()) {
      const ext = path.join(level.root, 'Plugins', 'External');
      if (fs.existsSync(ext)) {
        for (const dir of fs.readdirSync(ext, { withFileTypes: true })) {
          if (!dir.isDirectory()) continue;
          const dest = path.join(ext, dir.name);
          let owned = dir.name === STABLE_NAME || /^com\.orange\.bridge_\d+(\.\d+)*$/.test(dir.name);
          try { owned = readJSON(path.join(dest, 'manifest.json')).id === BRIDGE_ID; } catch {}
          if (owned) {
            copies++;
            if (dir.name !== STABLE_NAME || !sameFiles(src, dest)) return false;
          }
        }
      }
      const reg = path.join(level.root, 'PluginsInfo', 'v1', 'PS.json');
      if (!fs.existsSync(reg)) continue;
      const data = readJSON(reg);
      if (!Array.isArray(data.plugins)) return false;
      for (const entry of data.plugins.filter((p) => p && p.pluginId === BRIDGE_ID)) {
        entries++;
        valid = entry.versionString === manifest.version && entry.status === 'enabled'
          && entry.path === level.token + '\\External\\' + STABLE_NAME
          && sameFiles(src, path.join(ext, STABLE_NAME));
      }
    }
    return copies === 1 && entries === 1 && valid;
  } catch { return false; }
}
function setState(result) {
  installState = result;
  try { ctx.broadcast('bridge-install-status', result); } catch {}
  return result;
}
function psRunning() {
  return new Promise((resolve, reject) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq Photoshop.exe', '/FO', 'CSV', '/NH'],
      { windowsHide: true, timeout: 10000 }, (error, stdout) => {
        if (error) return reject(new Error('无法确认 Photoshop 是否退出：' + error.message));
        resolve(/"Photoshop\.exe"/i.test(String(stdout)));
      });
  });
}
function stopWatch() {
  if (watchTimer) clearTimeout(watchTimer);
  watchTimer = null;
}
function queueInstall(opts) {
  pendingOptions = { allowElevate: !!((pendingOptions && pendingOptions.allowElevate) || opts.allowElevate), force: !!((pendingOptions && pendingOptions.force) || opts.force) };
  if (!watchTimer) {
    watchTimer = setTimeout(async () => {
      watchTimer = null;
      if (!pendingOptions) return;
      const result = await installBridge(pendingOptions);
      if (result.status !== 'waiting') {
        try { ctx.olog('🔌 ' + (result.detail || result.error), result.ok ? 'ok' : 'err'); } catch {}
      }
    }, 2000);
    if (watchTimer.unref) watchTimer.unref();
  }
  return setState({ ok: true, updated: false, pending: true, status: 'waiting',
    detail: '已安排清理旧版并安装新版。请保存作品并完全退出 PS，保持来福运行；退出后会自动替换，完成后再打开 PS。' });
}
function runInstaller(elevated) {
  return new Promise((resolve) => {
    const wd = fs.mkdtempSync(path.join(app.getPath('temp'), 'life-bridge-'));
    const resultPath = path.join(wd, 'result.json');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installerPath(),
      '-Src', bridgeSrcDir(), '-UserData', app.getPath('appData'), '-ResultPath', resultPath];
    let commandArgs = args;
    if (elevated) {
      // Encode the launcher to preserve Unicode paths across the elevation boundary.
      const quote = (s) => "'" + s.replace(/'/g, "''") + "'";
      const argumentsText = args.map((s) => '"' + s + '"').join(' ');
      const script = '$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '
        + quote(argumentsText) + '; exit $p.ExitCode';
      commandArgs = ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
    }
    execFile('powershell.exe', commandArgs, { windowsHide: true, timeout: 120000 }, (error) => {
      let result;
      try { result = readJSON(resultPath); }
      catch { result = { ok: false, error: elevated ? '管理员安装未完成（授权被取消或超时）' : '安装器执行失败：' + (error ? error.message : '未返回结果') }; }
      try { fs.rmSync(wd, { recursive: true, force: true }); } catch {}
      resolve(result);
    });
  });
}
async function performInstall(opts) {
  try {
    const src = bridgeSrcDir();
    const manifest = readJSON(path.join(src, 'manifest.json'));
    if (manifest.id !== BRIDGE_ID) throw new Error('桥接安装源 ID 不匹配');
    if (!opts.force && isCurrent(src, manifest)) {
      pendingOptions = null;
      stopWatch();
      return setState({ ok: true, updated: false, status: 'current', detail: '插件文件及登记已是最新，无旧版本残留。' });
    }
    if (await psRunning()) return queueInstall(opts);
    pendingOptions = null;
    stopWatch();
    setState({ ok: true, status: 'installing', detail: '正在清理旧版并替换 PS 插件…' });
    let result = await runInstaller(false);
    if (!result.ok && result.error === 'PS_RUNNING') return queueInstall(opts);
    if (!result.ok && opts.allowElevate) {
      if (await psRunning()) return queueInstall(opts);
      result = await runInstaller(true);
    }
    if (!result.ok && result.error === 'PS_RUNNING') return queueInstall(opts);
    if (!result.ok) {
      const needsAdmin = result.code === 'PERMISSION_DENIED'
        || /access.*denied|unauthorized|访问.*拒绝|拒绝.*访问|NO_WRITABLE_INSTALL_LOCATION/i.test(result.error || '');
      try { ctx.dlog('[bridge-install] ' + JSON.stringify(result)); } catch {}
      if (needsAdmin) return setState({ ok: false, needsAdmin: true, status: 'needs-admin',
        error: '旧版桥接位于系统插件目录，需要管理员权限才能替换。请打开设置 → PS插件，点击“授权清理并安装新版”，在系统提示中选择“是”。' });
      return setState({ ok: false, status: 'error', error: '旧版本替换失败：' + result.error + '。请在设置 → PS插件中重试。' });
    }
    if (!isCurrent(src, manifest)) throw new Error('安装后的文件或登记校验未通过，请重新安装');
    const warnings = result.warnings || [];
    return setState({ ...result, status: 'installed', detail: '已安装桥接 ' + manifest.version
      + '，清理/替换旧目录 ' + result.removed + ' 个。现在可以打开 PS。'
      + (warnings.length ? '部分备份未删除：' + warnings.join('；') : '') });
  } catch (error) {
    pendingOptions = null;
    stopWatch();
    return setState({ ok: false, status: 'error', error: error.message || String(error) });
  }
}
function installBridge(opts = {}) {
  // Serialize startup, manual repair and exit-watcher requests.
  if (activeInstall) return activeInstall.then(() => installBridge(opts));
  activeInstall = performInstall(opts).finally(() => { activeInstall = null; });
  return activeInstall;
}
app.whenReady().then(() => setTimeout(async () => {
  const result = await installBridge();
  try {
    ctx.dlog('[bridge-install] ' + JSON.stringify(result));
    if (result.pending || result.updated || !result.ok) ctx.olog('🔌 ' + (result.detail || result.error), result.ok ? 'info' : 'err');
  } catch {}
}, 2500));
app.on('before-quit', stopWatch);
ipcMain.handle('bridge-reinstall', () => installBridge({ allowElevate: true, force: true }));
ipcMain.handle('bridge-install-status', () => installState);
ctx.installBridge = installBridge;
