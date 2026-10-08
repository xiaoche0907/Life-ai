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
    name: mf.name || '橙子桥接',
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
    copyDirSync(src, path.join(t.ext, STABLE_NAME));
    registerPlugin(t.info, t.token, mf, ver);
    if (li === 1) { try { removePluginEntry(LEVELS()[0].info); } catch (e) {} }
    cleanupOldVersions();
    return { ok: true, updated: true, detail: '安装成功·' + t.tag + '（重启PS后自动连接，无需手动打开面板）' };
  } catch (e) { return { ok: false, error: t.tag + ':' + (e.code || e.message) }; }
}

// 提权安装到机器级（0905坑64）：用户级PluginsInfo未证实被所有PS读取（盗版27.2实测：
// 用户级落位后增效工具菜单不出现）——机器级是唯一全球实证可信的落位。
// 仅手动点「重新安装」时弹UAC（用户有预期），开机静默安装不打扰。
// 脚本纯ASCII+可变信息走job.json+工作目录钉在C:\Users\Public（坑34/48：提权边界的GBK绞肉机）
function elevatedInstall(src, mf, ver) {
  return new Promise((resolve) => {
    try {
      const wd = 'C:\\Users\\Public\\orange-bridge-install';
      fs.mkdirSync(wd, { recursive: true });
      const jobPath = path.join(wd, 'job.json');
      const donePath = path.join(wd, 'done.txt');
      const ps1 = path.join(wd, 'el.ps1');
      try { fs.rmSync(donePath, { force: true }); } catch (e) {}
      const L0 = LEVELS()[0];
      fs.writeFileSync(jobPath, JSON.stringify({
        src, dstExt: path.join(L0.ext, STABLE_NAME), reg: path.join(L0.info, 'PS.json'),
        extBase: L0.ext, keep: STABLE_NAME, prefix: BRIDGE_ID + '_',
        entry: {
          hostMinVersion: (mf.host && mf.host.minVersion) || '23.3.0',
          name: mf.name || '橙子桥接',
          path: L0.token + '\\External\\' + STABLE_NAME,
          pluginId: BRIDGE_ID, status: 'enabled', type: 'uxp', versionString: ver,
        },
      }));
      fs.writeFileSync(ps1, [
        '$ErrorActionPreference = "Stop"',
        'try {',
        '  $job = Get-Content -Raw -Encoding UTF8 $args[0] | ConvertFrom-Json',
        '  New-Item -ItemType Directory -Force -Path $job.dstExt | Out-Null',
        '  Copy-Item -Path ($job.src + "\\*") -Destination $job.dstExt -Recurse -Force',
        '  New-Item -ItemType Directory -Force -Path (Split-Path $job.reg) | Out-Null',
        '  $j = $null',
        '  if (Test-Path $job.reg) { try { $j = Get-Content -Raw -Encoding UTF8 $job.reg | ConvertFrom-Json } catch {} }',
        '  if (-not $j) { $j = [pscustomobject]@{ plugins = @() } }',
        '  $keep = @($j.plugins | Where-Object { $_.pluginId -ne $job.entry.pluginId })',
        '  $j.plugins = $keep + $job.entry',
        '  [IO.File]::WriteAllText($job.reg, ($j | ConvertTo-Json -Depth 6))',
        '  Get-ChildItem $job.extBase -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like ($job.prefix + "*") -and $_.Name -ne $job.keep } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue',
        '  Set-Content -Path $args[1] -Value "OK"',
        '} catch { Set-Content -Path $args[1] -Value ("ERR " + $_.Exception.Message) }',
      ].join('\r\n'));
      execFile('powershell.exe', ['-NoProfile', '-Command',
        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" + ps1 + "','" + jobPath + "','" + donePath + "'"],
        { windowsHide: true, timeout: 120000 }, () => {
          let out = '';
          try { out = fs.readFileSync(donePath, 'utf8').trim(); } catch (e) {}
          if (/^OK/.test(out)) resolve({ ok: true, updated: true, detail: '安装成功·机器级(管理员)（重启PS后自动连接）' });
          else resolve({ ok: false, error: '提权安装未完成' + (out ? '：' + out.slice(0, 160) : '（UAC被拒绝或超时）') });
        });
    } catch (e) { resolve({ ok: false, error: '提权安装异常: ' + (e.message || e) }); }
  });
}

// zip打包（无第三方依赖：PowerShell Compress-Archive）→ 重命名.ccx → UPIA /install
function installBridge(opts) {
  return new Promise((resolve) => {
    (async () => {
    const src = bridgeSrcDir();
    const mf = readManifest(src);
    if (!mf) return resolve({ ok: false, error: '安装源缺失（ps-bridge/manifest.json读不到）' });
    const ver = mf.version || '1.0.0';
    // 已是最新判定：稳定目录逐文件比对；顺手重申注册表指针（老版本号条目→稳定路径的迁移期修正）
    const infos = [
      { dir: installedDirs()[0], info: 'C:\\Program Files\\Common Files\\Adobe\\UXP\\PluginsInfo\\v1', token: '$systemPlugins' },
      { dir: installedDirs()[1], info: path.join(app.getPath('appData'), 'Adobe', 'UXP', 'PluginsInfo', 'v1'), token: '$userPlugins' },
    ];
    for (const L of infos) {
      if (fs.existsSync(L.dir) && sameFiles(src, L.dir)) {
        try { registerPlugin(L.info, L.token, mf, ver); } catch (e) {}
        cleanupOldVersions();
        return resolve({ ok: true, updated: false, detail: '已是最新。若PS状态点不亮：完全退出并重启一次PS' });
      }
    }
    // 直写安装链（0905坑62/64）：机器级→(手动重装:UAC提权机器级)→用户级→UPIA
    // 机器级=唯一全球实证可信落位；用户级注册表部分PS不读（盗版27.2实测菜单不现身）
    const d0 = directInstallLevel(src, mf, ver, 0);
    if (d0.ok) return resolve(d0);
    if (opts && opts.allowElevate) {
      const de = await elevatedInstall(src, mf, ver);
      if (de.ok) return resolve(de);
      try { ctx.dlog('[bridge-install] 提权失败: ' + de.error); } catch (e) {}
    }
    const d1 = directInstallLevel(src, mf, ver, 1);
    if (d1.ok) {
      d1.detail += '。⚠若重启PS后增效工具菜单仍无「橙子桥接」：请点设置「重新安装PS插件」（会请求管理员权限装到机器级）';
      return resolve(d1);
    }
    const upia = findUPIA();
    if (!upia) return resolve({ ok: false, error: '直写安装失败（' + d0.error + ' / ' + d1.error + '）' });
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
          cleanupOldVersions(BRIDGE_ID + '_' + ver);   // UPIA装的是版本号文件夹，别把它自己清了
          resolve({ ok: true, updated: true, detail: 'UPIA安装成功（重启PS后自动连接）' });
        } else {
          resolve({ ok: false, error: 'UPIA安装失败: ' + (out.trim() || (ei && ei.message) || '未知') });
        }
      });
    });
    })().catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  });
}

// 启动自动装（静默；有动作或失败才吭声），设置卡可手动重装
app.whenReady().then(() => setTimeout(async () => {
  const r = await installBridge();
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
}, 2500));
// 手动重装=用户有预期：允许弹UAC提权装机器级（坑64）
ipcMain.handle('bridge-reinstall', () => installBridge({ allowElevate: true }));

ctx.installBridge = installBridge;
