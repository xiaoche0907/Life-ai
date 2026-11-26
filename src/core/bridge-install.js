// PS桥接件自动安装：打成ccx后调Adobe官方UPIA安装（与商店插件同机制、同目录，正版/魔改PS通吃）
// 根因备忘：直接复制进 <PS>\Plug-ins\ 对UXP面板插件无效（那是CEP/8BF的家）；
//          UPIA只认 manifestVersion 6 + host对象写法（v5/host数组=-267拒装）
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ctx = require('./ctx');

const BRIDGE_ID = 'com.orange.bridge';
const UPIA_CANDIDATES = [
  'C:\\Program Files\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe',
  'C:\\Program Files (x86)\\Common Files\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe',
];

// 桥接件源：开发=仓库ps-bridge目录；打包=resources/ps-bridge（electron-builder的extraResources）
function bridgeSrcDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'ps-bridge')
    : path.join(ctx.SRC, '..', 'ps-bridge');
}
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { return null; }
}
function findUPIA() {
  for (const p of UPIA_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}
// 稳定文件夹名（0905坑62根治）：版本号进文件夹名=每次升级PS当新插件、面板被踢出工作区、
// 用户必须手动重开。固定文件夹=插件身份永不变=面板一次点开终身常驻，升级只换内容
const STABLE_NAME = BRIDGE_ID + '_live';
// 已装判定：稳定目录（机器级+用户级都查）逐文件比对
function installedDirs() {
  return [
    path.join('C:\\Program Files\\Common Files\\Adobe\\UXP\\Plugins\\External', STABLE_NAME),
    path.join(app.getPath('appData'), 'Adobe', 'UXP', 'Plugins', 'External', STABLE_NAME),
  ];
}
function sameFiles(srcDir, dstDir) {
  try {
    // 递归比对（0908：ps-bridge 新增 presets/ 子目录装工具预设tpl，扁平读目录会把子目录当文件读崩）
    for (const f of fs.readdirSync(srcDir)) {
      const s = path.join(srcDir, f), d = path.join(dstDir, f);
      if (fs.statSync(s).isDirectory()) { if (!sameFiles(s, d)) return false; continue; }
      if (!fs.readFileSync(s).equals(fs.readFileSync(d))) return false;
    }
    return true;
  } catch { return false; }
}

// 装新删旧：同ID多版本文件夹堆积会让PS的UXP装载器一个都不加载（实测堆到11个全灭）
// 只留稳定目录，其余（UPIA时代的版本号文件夹）best-effort删除
function cleanupOldVersions(keepAlso) {
  const bases = [
    'C:\\Program Files\\Common Files\\Adobe\\UXP\\Plugins\\External',
    path.join(app.getPath('appData'), 'Adobe', 'UXP', 'Plugins', 'External'),
  ];
  let removed = 0;
  for (const base of bases) {
    try {
      for (const name of fs.readdirSync(base)) {
        if (name.indexOf(BRIDGE_ID + '_') === 0 && name !== STABLE_NAME && name !== keepAlso) {
          try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); removed++; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  if (removed) { try { ctx.dlog('[bridge-install] 已清理旧版桥接件 ' + removed + ' 个'); } catch (e) {} }
}
// 摘除某级注册表里我们的条目（用户级安装时清机器级残留，防同id双身份被PS双载）
function removePluginEntry(infoDir) {
  const reg = path.join(infoDir, 'PS.json');
  const j = JSON.parse(fs.readFileSync(reg, 'utf8'));
  if (!Array.isArray(j.plugins)) return;
  const n = j.plugins.length;
  j.plugins = j.plugins.filter((p) => p && p.pluginId !== BRIDGE_ID);
  if (j.plugins.length !== n) fs.writeFileSync(reg, JSON.stringify(j, null, 1));
}

// ---------- 无UPIA直写安装（0904魔改PS兜底）----------
// UPIA的本质=两件事：①插件文件放进UXP External目录 ②PluginsInfo\v1\PS.json登记一笔
// （本机UPIA装出的注册表实测解剖：{plugins:[{hostMinVersion,name,path:"$systemPlugins\\External\\<id>_<ver>",
//   pluginId,status:"enabled",type:"uxp",versionString}]}）
// 魔改/绿色PS没有CC也没有UPIA，但PS的UXP运行时照读这两处——我们自己写。
// 机器级(Program Files,$systemPlugins)优先=UPIA同款最稳；无写权限自动退用户级(%APPDATA%,$userPlugins)
function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    if (fs.statSync(s).isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}
function registerPlugin(infoDir, pathToken, mf, ver) {
  const reg = path.join(infoDir, 'PS.json');
  let j = null;
  try { j = JSON.parse(fs.readFileSync(reg, 'utf8')); } catch {}
  if (!j || typeof j !== 'object') j = { plugins: [] };
  if (!Array.isArray(j.plugins)) j.plugins = [];
  j.plugins = j.plugins.filter((p) => p && p.pluginId !== BRIDGE_ID);
  j.plugins.push({
    hostMinVersion: (mf.host && mf.host.minVersion) || '25.0.0',
    name: mf.name || '来福桥接',
    path: pathToken + '\\External\\' + STABLE_NAME,   // 稳定路径=插件身份不变（坑62根治）
    pluginId: BRIDGE_ID,
    status: 'enabled',
    type: 'uxp',
    versionString: ver,
  });
  fs.mkdirSync(infoDir, { recursive: true });
  fs.writeFileSync(reg, JSON.stringify(j, null, 1));
}
const LEVELS = () => ([
  { ext: 'C:\\Program Files\\Common Files\\Adobe\\UXP\\Plugins\\External',
    info: 'C:\\Program Files\\Common Files\\Adobe\\UXP\\PluginsInfo\\v1',
    token: '$systemPlugins', tag: '机器级' },
  { ext: path.join(app.getPath('appData'), 'Adobe', 'UXP', 'Plugins', 'External'),
    info: path.join(app.getPath('appData'), 'Adobe', 'UXP', 'PluginsInfo', 'v1'),
    token: '$userPlugins', tag: '用户级' },
]);
function directInstallLevel(src, mf, ver, li) {
  const t = LEVELS()[li];
  try {
    const dst = path.join(t.ext, STABLE_NAME);
    copyDirSync(src, dst);
    if (!sameFiles(src, dst)) throw Error('复制后的桥接文件校验失败');
    registerPlugin(t.info, t.token, mf, ver);
    if (li === 1) { try { removePluginEntry(LEVELS()[0].info); } catch (e) {} }
    cleanupOldVersions();
    return { ok: true, updated: true, detail: '安装成功·' + t.tag + '（重启PS后自动连接，无需手动打开面板）' };
  } catch (e) { return { ok: false, error: t.tag + ':' + (e.code || e.message) }; }
}

function installMachine(src, userRoot, elevate) {
  const script = app.isPackaged ? path.join(process.resourcesPath, 'bridge-machine-install.ps1') : path.join(ctx.SRC, '..', 'bridge-machine-install.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, src, userRoot];
  const quote = value => "'" + value.replace(/'/g, "''") + "'";
  const launch = elevate
    ? ['-NoProfile', '-EncodedCommand', Buffer.from(
      "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList " +
      quote(args.map(arg => '"' + arg + '"').join(' ')) + '; exit $p.ExitCode', 'utf16le').toString('base64')]
    : args;
  return new Promise(resolve => {
    execFile('powershell.exe', launch, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error?.code === 2) return resolve({ ok: false, deferred: true, error: '请先保存文档并完全退出 Photoshop，来福会继续修复插件' });
      if (error) return resolve({ ok: false, error: String(stderr || '').trim() || (elevate ? '管理员安装未完成' : error.message) });
      if (!sameFiles(src, installedDirs()[0])) return resolve({ ok: false, error: '机器级桥接文件校验失败' });
      resolve({ ok: true, updated: true, detail: '安装成功·机器级（重新打开 Photoshop 后自动连接）' });
    });
  });
}

function containsBridge(level) {
  try {
    if (fs.readdirSync(level.ext).some(name => name.startsWith(BRIDGE_ID + '_'))) return true;
  } catch (e) { if (e.code !== 'ENOENT') return true; }
  try {
    const registry = JSON.parse(fs.readFileSync(path.join(level.info, 'PS.json'), 'utf8'));
    return registry.plugins?.some(entry => entry?.pluginId === BRIDGE_ID) || false;
  } catch (e) { return e.code !== 'ENOENT'; }
}

// zip打包（无第三方依赖：PowerShell Compress-Archive）→ 重命名.ccx → UPIA /install
function installBridgeOnce(opts) {
  return new Promise((resolve) => {
    (async () => {
    const src = bridgeSrcDir();
    const mf = readManifest(src);
    if (mf?.id !== BRIDGE_ID || !['bridge.js', 'presets/marquee.tpl'].every(name => {
      try { return fs.statSync(path.join(src, name)).isFile(); } catch { return false; }
    })) return resolve({ ok: false, error: '安装包内桥接文件不完整，请重新下载安装包' });
    const force = !!opts?.force;
    const ver = mf.version || '1.0.0';
    const [machine, user] = LEVELS();
    const [machineDir, userDir] = installedDirs();
    const hasMachine = containsBridge(machine);
    const hasUser = containsBridge(user);
    const hasOnlyStable = level => {
      try { return !fs.readdirSync(level.ext).some(name => name.startsWith(BRIDGE_ID + '_') && name !== STABLE_NAME); }
      catch { return false; }
    };
    if (!force) {
      const level = hasMachine && !hasUser && hasOnlyStable(machine) && sameFiles(src, machineDir) ? machine
        : !hasMachine && hasOnlyStable(user) && sameFiles(src, userDir) ? user : null;
      if (level) {
        try {
          const reg = JSON.parse(fs.readFileSync(path.join(level.info, 'PS.json'), 'utf8'));
          const entries = reg.plugins.filter(entry => entry?.pluginId === BRIDGE_ID);
          if (entries.length === 1 && entries[0].path === level.token + '\\External\\' + STABLE_NAME && entries[0].versionString === ver && entries[0].status === 'enabled') {
            return resolve({ ok: true, updated: false });
          }
        } catch (e) { ctx.dlog('[bridge-install] 需要修复插件登记: ' + e.message); }
      }
    }
    if (await ctx.comBridge?.psProcessAlive()) return resolve({ ok: false, deferred: true, error: '请先保存文档并完全退出 Photoshop，来福会继续修复插件' });
    const userRoot = path.join(app.getPath('appData'), 'Adobe', 'UXP');
    let d0 = await installMachine(src, userRoot, false);
    if (d0.ok || d0.deferred) return resolve(d0);
    if (opts?.allowElevate || hasMachine) {
      d0 = await installMachine(src, userRoot, true);
      if (d0.ok || d0.deferred) return resolve(d0);
    }
    if (hasMachine) return resolve({ ok: false, error: '旧机器级桥接修复失败：' + d0.error + '。请在设置里重新安装并允许管理员权限' });
    const d1 = directInstallLevel(src, mf, ver, 1);
    if (d1.ok) {
      d1.detail += '。若重启 Photoshop 后仍未连接，请在设置中重新安装 PS 插件';
      return resolve(d1);
    }
    const upia = findUPIA();
    if (!upia) return resolve({ ok: false, error: '重装失败（' + d0.error + ' / ' + d1.error + '）' });
    const ccx = path.join(app.getPath('temp'), 'orange-bridge.ccx');
    const zip = ccx.replace(/\.ccx$/, '.zip');
    try { fs.rmSync(ccx, { force: true }); fs.rmSync(zip, { force: true }); } catch {}
    // Compress-Archive打包目录内容到根层（ccx=改名的zip）
    const ps = 'Compress-Archive -Path "' + src + '\\*" -DestinationPath "' + zip + '" -Force; Rename-Item "' + zip + '" "' + path.basename(ccx) + '"';
    execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true }, (ez) => {
      if (ez || !fs.existsSync(ccx)) return resolve({ ok: false, error: '打包ccx失败: ' + (ez && ez.message || '未知') });
      execFile(upia, ['/install', ccx], { windowsHide: true }, (ei, stdout) => {
        const out = String(stdout || '');
        if (!ei && /Successful/i.test(out)) {
          const name = BRIDGE_ID + '_' + ver;
          const verified = LEVELS().some(level => sameFiles(src, path.join(level.ext, name)));
          if (!verified) return resolve({ ok: false, error: 'UPIA 安装后未找到完整的桥接文件' });
          cleanupOldVersions(name);
          resolve({ ok: true, updated: true, detail: 'UPIA安装成功（重启PS后自动连接）' });
        } else {
          resolve({ ok: false, error: 'UPIA安装失败: ' + (out.trim() || (ei && ei.message) || '未知') });
        }
      });
    });
    })().catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

let installing;
function installBridge(opts) {
  if (installing) return installing;
  installing = installBridgeOnce(opts).finally(() => { installing = null; });
  return installing;
}

async function autoInstall(waiting = false) {
  const r = await installBridge();
  if (r.deferred) {
    if (!waiting) ctx.olog('🔌 ' + r.error);
    setTimeout(() => autoInstall(true), 5000);
    return;
  }
  try {
    ctx.dlog('[bridge-install] ' + JSON.stringify(r));
    if (r.ok && r.updated) ctx.olog('🔌 PS插件已自动安装/更新：' + (r.detail || '重启PS后生效'));
    else if (!r.ok) ctx.olog('🔌 PS插件自动安装失败: ' + r.error + '（可在设置里重试）', 'err');
  } catch {}
  // 装好但25秒没握手且PS在跑=没重启PS/PS版本过低（坑62/63）：
  // 用COM读对方PS版本自动诊断，日志一条话把三种情况全说清
  setTimeout(async () => {
    try {
      if (r.ok && !(ctx.psConnected && ctx.psConnected())
          && ctx.comBridge && (await ctx.comBridge.psProcessAlive())) {
        let vTip = '';
        try {
          const pv = await ctx.comBridge.tryCall({ action: 'ping', params: {} }, 12000);
          const v = pv && pv.ok && pv.result && String(pv.result.version || '');
          if (v) {
            vTip = '（检测到PS版本' + v + (parseFloat(v) < 23.3 ? '——低于插件最低要求23.3，此PS只能用COM兜底通道' : '') + '）';
          }
        } catch (e) {}
        ctx.olog('🔌 插件已装好但还没连接' + vTip + '：请完全退出并重启一次PS（重启后自动连接，无需打开面板）', 'err');
      }
    } catch {}
  }, 25000);
}
app.whenReady().then(() => setTimeout(autoInstall, 2500));

ipcMain.handle('bridge-reinstall', () => {
  return installBridge({ allowElevate: true, force: true }).then(result => result.deferred
    ? { ok: false, error: '请先保存文档并完全退出 Photoshop，再点重新安装 PS 插件' }
    : result);
});

ctx.installBridge = installBridge;
