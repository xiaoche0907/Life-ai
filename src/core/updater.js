// 软件本体更新（1013）：从 OSS 拉版本清单 → 比对 → 卡内下载安装包 → 打开安装程序。
//
// 与「提示词同步」（plib-update.js）的区别，别混：
//   plib-update.js  更新的是**词条库**（用户的 prompt-library.json），碰不到代码
//   本文件          更新的是**软件本体**（安装包 → 用户重装），落盘的是 .exe
// 两者共用同一个 OSS Bucket，但目录不同（prompts/ vs update/）。
//
// 四条纪律（照抄 plib-update.js，那套已经真机验证过）：
//  ① 失败静默——断网/OSS 挂了就当没这回事：不弹框、不拖慢开机、不刷屏
//  ② 默认关——两个自动开关都是用户自己开；但"有新版就提示"始终生效（不依赖开关）
//  ③ 单飞闩——手动检查与开机检查不许重叠
//  ④ 绝不静默安装——下载可以自动，**安装必须用户点**（Windows 上文件占用 + 杀软都要求这一步）
//
// 线上结构（由 tools/update-publish.js 生成）：
//   update/version.json   {v, ts, version, url, size, sha256, notes:[{version,date,items:[]}]}
//   update/<安装包>.exe
// 发布顺序：**先传 exe，最后传 version.json**（客户端只读 version.json，
//   绝不能看到"指向还没上传完的安装包"的清单——plib-publish.js 同一条纪律）。
const { app, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const ctx = require('./ctx');

// ---------- 内置更新地址（与提示词同步同一个 Bucket）----------
// 刻意不让用户填（与 plib-update.js:25-28 同一条理由）：这是官方分发通道。
// 要换地址改这一行、重新打包。config.updater 里故意没有 base 字段。
const BUILTIN_BASE = 'https://api.github.com/repos/xiaoche0907/Life-ai/releases/latest';
const MANIFEST_KEY = 'update/version.json';

// 测试覆写点（与 tools/oss.js 的 OSS_ENDPOINT/OSS_PROTO 同一套约定）：
//   端到端机测时把 base 指到本地假服务器，**生产永远走上面的阿里云地址**。
//   只在显式设了环境变量时生效——正常安装/运行的用户环境里这两个变量不存在。
function baseUrl() {
  const ep = process.env.ORANGE_UPDATE_ENDPOINT;
  if (ep) {
    const proto = process.env.ORANGE_UPDATE_PROTO || 'http';
    return trimBase(proto + '://' + String(ep).replace(/^https?:\/\//, ''));
  }
  return trimBase(BUILTIN_BASE);
}

const trimBase = (b) => String(b || '').trim().replace(/\/+$/, '');
const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));
const dlog = (m) => { try { ctx.dlog(m); } catch (e) {} };

// 安装包下载目录：系统临时目录下专属文件夹（用户裁定"自动存临时目录"）
const dlDir = () => path.join(app.getPath('temp'), 'orange-update');

// ---------- 版本号比较（纯函数，tools/updater-test.js 直测）----------
// 支持 "6.0.15" / "v6.0.15" / "6.0.15-beta.2"：按点分数字段比，短的一方补 0。
// 返回 1=远端更新 / 0=相同 / -1=远端更旧 / null=解析不了
function compareVer(remote, local) {
  const norm = (s) => String(s == null ? '' : s).trim().replace(/^v/i, '').split('-')[0].split('.');
  const a = norm(remote), b = norm(local);
  if (!a.length || !b.length || !a[0] || !b[0]) return null;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = Number(a[i] || 0), y = Number(b[i] || 0);
    if (!isFinite(x) || !isFinite(y)) return null;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  const suffix = (s) => String(s).trim().replace(/^v/i, '').split('-').slice(1).join('-');
  const ra = suffix(remote), rb = suffix(local);
  if (ra === rb) return 0;
  if (!ra) return 1;
  if (!rb) return -1;
  const ap = ra.split('.'), bp = rb.split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === undefined) return -1;
    if (bp[i] === undefined) return 1;
    if (ap[i] === bp[i]) continue;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return Number(ap[i]) > Number(bp[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return ap[i] > bp[i] ? 1 : -1;
  }
  return 0;
}

// ---------- 拉清单 ----------
// 区分"连不上"与"还没有更新信息"：OSS 上清单不存在时回的是 404 + XML（实测），
// 这跟断网是两件事——混成一句"连不上更新地址"会让用户去查自己网络（冤案）。
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (r.status === 404) { const e = new Error('还没有发布更新信息'); e.notPublished = true; throw e; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchManifest() {
  const base = baseUrl();
  if (!isHttp(base)) return { ok: false, message: '未配置更新地址' };
  let txt;
  const overridden = !!process.env.ORANGE_UPDATE_ENDPOINT;
  try { txt = await fetchText(overridden ? base + '/' + MANIFEST_KEY : base, 20000); }
  catch (e) {
    if (e && e.notPublished) return { ok: false, message: '已是最新版本（云端还没有发布新版本）' };
    // AbortError=超时，其余=真连不上/HTTP 错误
    return { ok: false, message: (e && e.name === 'AbortError') ? '更新地址超时' : '连不上更新地址' };
  }
  let m;
  try { m = JSON.parse(txt); } catch (e) { return { ok: false, message: '更新清单格式不对' }; }
  if (!overridden) {
    const asset = m && Array.isArray(m.assets) && m.assets.find((a) => a.state === 'uploaded' && /\.exe$/i.test(a.name) && /life-ai/i.test(a.name));
    if (!asset || !m.tag_name || m.draft) return { ok: false, message: '最新Release尚未提供安装包' };
    m = { version: m.tag_name.replace(/^v/i, ''), url: asset.browser_download_url,
      size: asset.size, sha256: /^sha256:/i.test(asset.digest || '') ? asset.digest.slice(7) : '',
      notes: [{ version: m.tag_name, date: (m.published_at || '').slice(0, 10), items: String(m.body || '').split('\n').filter(Boolean) }] };
  }
  if (!m || typeof m !== 'object' || !m.version) return { ok: false, message: '更新清单缺版本号' };

  const url = /^https?:/i.test(m.url || '') ? m.url : (base + '/' + String(m.url || '').replace(/^\/+/, ''));
  return { ok: true, version: String(m.version), url: url, size: Number(m.size) || 0,
    sha256: typeof m.sha256 === 'string' ? m.sha256 : '', notes: Array.isArray(m.notes) ? m.notes : [] };
}

// ---------- 状态写入（只有本模块写这些字段）----------
function saveUp() {
  try { if (ctx.saveConfig) ctx.saveConfig(); } catch (e) {}
}
function setUp(patch) {
  const c = ctx.config;
  if (!c || !c.updater) return;
  Object.assign(c.updater, patch);
  saveUp();
  try { if (ctx.broadcast) ctx.broadcast('updater-vars', c.updater); } catch (e) {}
}

// ---------- 检查（纯检查，不下载）----------
const localVer = () => { try { return app.getVersion(); } catch (e) { return '0.0.0'; } };

let running = null;   // 单飞闩（照抄 plib-update.js:248 的做法）

async function check(opts) {
  const o = opts || {};
  const r = await fetchManifest();
  const now = Date.now();
  if (!r.ok) {
    // 失败静默：静默模式不写日志卡也不存 lastResult（免得用户每次开机看到一条红字）
    if (!o.silent) {
      setUp({ lastCheck: now, lastResult: r.message });
      if (ctx.olog) ctx.olog('🔄 检查更新失败：' + r.message, 'err');
    }
    return { ok: false, message: r.message };
  }
  const cmp = compareVer(r.version, localVer());
  const hasNew = cmp === 1;
  setUp({
    lastCheck: now,
    latest: r.version,
    notes: r.notes,
    lastResult: hasNew ? ('发现新版本 ' + r.version) : '已是最新版本',
    // 换版本了就把"已看过"标记清掉 → 红点会重新亮（用户上次点过的是老版本的提示）
    seen: hasNew && ctx.config.updater.seen === r.version ? r.version : (hasNew ? '' : ctx.config.updater.seen),
  });
  if (!o.silent && ctx.olog) {
    ctx.olog(hasNew ? ('🔄 发现新版本 ' + r.version + '（当前 ' + localVer() + '）') : ('🔄 已是最新版本（' + localVer() + '）'), hasNew ? 'ok' : 'info');
  }
  return { ok: true, hasNew: hasNew, version: r.version, local: localVer(), url: r.url, size: r.size, sha256: r.sha256, notes: r.notes };
}

function runCheck(opts) {
  if (running) return running;   // 单飞：正在跑就复用同一个 promise，不重叠
  running = check(opts).catch((e) => {
    dlog('[updater] 异常: ' + (e && e.message));
    return { ok: false, message: '检查失败：' + ((e && e.message) || e) };
  }).finally(() => { running = null; });
  return running;
}
ctx.updaterCheck = runCheck;

// ---------- 下载安装包（带进度，流式；项目里首个流式下载）----------
let downloading = null;

async function download(url, onProgress) {
  if (!isHttp(url)) throw new Error('下载地址无效');
  const dir = dlDir();
  fs.mkdirSync(dir, { recursive: true });
  const name = decodeURIComponent(String(url).split('/').pop().split('?')[0]) || 'setup.exe';
  const dst = path.join(dir, name);
  const part = dst + '.part';   // 先写 .part，下完再改名：中途断了不会留个假装完整的 exe
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 30 * 60 * 1000);   // 30 分钟没下完=放弃
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length')) || 0;
    // ⚠1014：这里原本是"边读边 createWriteStream 写 .part"，换成"读进内存再一次落盘"。
    //   两个 Windows 真机上会出事的点：
    //   ① rename 会因**残留文件句柄**甩 EPERM（前一次的读流没关、杀软还开着文件、
    //      上轮的坏包还没被释放）——旧写法直接失败，用户看到"下载失败"还查不出原因；
    //   ② 写流的 'error' 事件没人接（'drain' 的 res 没有 rej），磁盘满会被挂死不报。
    //   代价是安装包（80MB 上下）在内存里过一遍——项目里已有的截图链路比这重得多，
    //   而且这一步天然是串行的（单飞闩）。换来的是"要么完整落盘、要么干净失败"。
    const chunks = [];
    let got = 0, lastPct = -1, lastEmit = 0;
    if (r.body && r.body.getReader) {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        got += value.length;
        const pct = total ? Math.floor(got / total * 100) : -1;
        const now = Date.now();
        // 节流：整百分比变化 或 至少 300ms 一次，别把渲染进程刷爆
        if (pct !== lastPct || (now - lastEmit) > 300) {
          lastPct = pct; lastEmit = now;
          if (onProgress) { try { onProgress({ got, total, pct }); } catch (e) {} }
        }
      }
    } else {
      // 极端兜底：没有流式 body（老运行时）→ 一次性读，进度只能报"完成"
      const buf = Buffer.from(await r.arrayBuffer());
      chunks.push(buf); got = buf.length;
    }
    const body = Buffer.concat(chunks);

    // 落盘：先写 .part（fs.writeFileSync 自己会关句柄），再"删旧→改名"，都带重试
    fs.writeFileSync(part, body);
    renameInto(part, dst);

    if (onProgress) { try { onProgress({ got, total: total || got, pct: 100, done: true }); } catch (e) {} }
    return { file: dst, size: got };
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch (e2) {}
    throw e;
  } finally { clearTimeout(to); }
}

// 删文件也要重试：Windows 上"刚刚读完"的文件句柄不是立刻释放的
// （我们自己的 sha256 读流就常有这个瞬间），杀软/资源管理器预览同理。
// ⚠这个失败**绝不能吞**——校验失败的坏包留在文件夹里，用户下次会当它是好包手动去装。
function rmRetry(p) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(p, { force: true }); return true; } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient) return false;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200 * (i + 1)); } catch (e2) {}
    }
  }
  try { fs.rmSync(p, { force: true }); return true; } catch (e) { return false; }
}

// 改名到目标位置：Windows 上 EPERM/EBUSY 基本都是**别人还开着这个文件**
// （杀软在扫、上一轮的读句柄还没被回收、资源管理器正预览它）。
// 这不该让用户看到"下载失败"——重试几次 + 先删掉旧的目标文件，绝大多数都能过。
function renameInto(from, to) {
  for (let i = 0; i < 4; i++) {
    try {
      try { fs.rmSync(to, { force: true }); } catch (eDel) {}   // 清掉上一轮的旧包（有句柄时删不掉，继续试）
      fs.renameSync(from, to);
      return;
    } catch (e) {
      const transient = e && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES');
      if (!transient || i === 3) throw e;
      // 同步睡一小会儿：调用方是 async，这点阻塞换来的是"用户不用重点一次"
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * (i + 1)); } catch (e2) {}
    }
  }
}

// 校验 sha256（清单里给了才校验；不给就跳过——不能因为没给 hash 就拒绝更新）
function sha256File(p) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });
}

function runDownload() {
  if (downloading) return downloading;
  downloading = (async () => {
    // 已经下好且文件还在 → 直接用（别重复下 84MB）
    const c = ctx.config.updater || {};
    const chk = await runCheck({ silent: true });
    if (!chk.ok) return { ok: false, error: chk.message };
    if (!chk.hasNew) return { ok: false, error: '已经是最新版本' };
    if (c.doneVersion === chk.version && c.doneFile && fs.existsSync(c.doneFile) && c.doneFile.endsWith('.exe')) {
      if (ctx.olog) ctx.olog('🔄 安装包已就绪：' + path.basename(c.doneFile), 'ok');
      return { ok: true, file: c.doneFile, cached: true };
    }
    if (ctx.olog) ctx.olog('🔄 开始下载 ' + chk.version + (chk.size ? ('（' + Math.round(chk.size / 1048576) + 'MB）') : '') + '…');
    try {
      const r = await download(chk.url, (p) => {
        try { if (ctx.broadcast) ctx.broadcast('updater-progress', p); } catch (e) {}
      });
      if (chk.sha256) {
        const got = await sha256File(r.file);
        if (got.toLowerCase() !== chk.sha256.toLowerCase()) {
          const gone = rmRetry(r.file);
          setUp({ doneFile: '', lastResult: '安装包校验失败' });
          if (ctx.olog) ctx.olog('🔄 安装包校验失败（可能下载不完整），' + (gone ? '已删除，请重试' : '删除失败，请手动删掉该文件再重试'), 'err');
          return { ok: false, error: '安装包校验失败' + (gone ? '' : '（坏包没删掉，请在文件夹里手动删除）') };
        }
      }
      setUp({ doneFile: r.file, doneVersion: chk.version, lastResult: '已下载 ' + chk.version + '，等待安装' });
      if (ctx.olog) ctx.olog('🔄 下载完成：' + path.basename(r.file) + '（点「立即安装」开始）', 'ok');
      return { ok: true, file: r.file, size: r.size, version: chk.version };
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '下载超时' : ((e && e.message) || String(e));
      if (ctx.olog) ctx.olog('🔄 下载失败：' + msg, 'err');
      return { ok: false, error: msg };
    }
  })().finally(() => { downloading = null; });
  return downloading;
}

// ---------- 打开安装程序 ----------
// ⚠项目里首次做这件事：既有代码只用 shell.openPath 开过**文件夹**，从没开过 exe。
//   用 spawn(detached) 直接跑安装程序：安装器会弹自己的向导（perMachine → 会要 UAC），
//   然后自动 quit 让软件退出——否则旧进程占着文件，装不进去。
//
// ⚠1014 补：spawn 的失败分两种，只有一种能被 try/catch 抓到。
//   "路径非法"是同步抛的；**"文件在但起不来"（被杀软删了、下载截断、指向目录）是异步 'error' 事件**
//   ——旧写法会给用户报"已启动安装程序"然后自己退出，实际什么都没发生，
//   用户只会看到软件关了、也没装上新版。所以这里等一小会儿收 'error'，收到了就不退出。
async function runInstaller() {
  const c = ctx.config.updater || {};
  const f = c.doneFile;
  if (!f || !fs.existsSync(f)) return { ok: false, error: '安装包不在（可能已被清理），请重新下载' };
  const chk = await runCheck({ silent: true });
  if (!chk.ok) return { ok: false, error: chk.message };
  if (!chk.hasNew || c.doneVersion !== chk.version) return { ok: false, error: '安装包版本已过期，请重新下载最新版' };
  let child;
  try {
    child = spawn(f, [], { detached: true, stdio: 'ignore', windowsHide: false });
  } catch (e) {
    const msg = (e && e.message) || String(e);
    if (ctx.olog) ctx.olog('🔄 启动安装程序失败：' + msg + '（可点「打开文件夹」手动安装）', 'err');
    return { ok: false, error: msg };
  }

  // 收 1.2 秒的异步错误：真安装器这会儿已经开始解压了，不会报错
  const early = await new Promise((res) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; res(v); } };
    child.once('error', (e) => fin((e && e.message) || String(e)));
    setTimeout(() => fin(''), 1200);
  });
  if (early) {
    if (ctx.olog) ctx.olog('🔄 安装程序起不来：' + early + '（可点「打开文件夹」手动安装）', 'err');
    return { ok: false, error: early };
  }

  try { child.unref(); } catch (e) {}
  if (ctx.olog) ctx.olog('🔄 已启动安装程序。软件会退出，装完请手动重开（安装器最后会自动启动新版）', 'ok');
  // 让出 1.5 秒再退：日志/广播要先发出去，否则用户什么都看不到就没了
  setTimeout(() => { try { app.quit(); } catch (e) {} }, 1500);
  return { ok: true };
}

// ---------- IPC ----------
ipcMain.handle('updater-status', () => {
  const c = (ctx.config && ctx.config.updater) || {};
  let hasFile = false;
  try { hasFile = !!(c.doneFile && c.doneVersion === c.latest && compareVer(c.doneVersion, localVer()) === 1 && fs.existsSync(c.doneFile)); } catch (e) {}
  return {
    local: localVer(),
    autoApp: !!c.autoApp, autoPlib: !!c.autoPlib,
    lastCheck: c.lastCheck || 0, lastResult: c.lastResult || '',
    latest: c.latest || '', notes: c.notes || [], seen: c.seen || '',
    doneFile: hasFile ? c.doneFile : '', hasFile: hasFile,
    hasNew: compareVer(c.latest || '', localVer()) === 1,
    // 提示词同步的开关状态（更新卡上那个开关读它，两个来源合成一个界面真相）
    plibAuto: !!(ctx.config && ctx.config.plibUpdate && ctx.config.plibUpdate.auto),
  };
});
ipcMain.handle('updater-check', () => runCheck({ silent: false }));
ipcMain.handle('updater-download', () => runDownload());
ipcMain.handle('updater-run', () => runInstaller());
ipcMain.handle('updater-open-folder', async () => {
  try {
    const dir = dlDir();
    fs.mkdirSync(dir, { recursive: true });
    const r = await shell.openPath(dir);
    return { ok: !r, error: r || '' };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
// 用户看过新版本提示 → 记下，红点/闪烁停掉
ipcMain.handle('updater-seen', () => {
  const c = ctx.config.updater || {};
  if (c.latest) setUp({ seen: c.latest });
  return { ok: true };
});

// 提示词库自动更新：两个来源合成——更新卡的 autoPlib 或老设置里的 plibUpdate.auto，
// 任意一个开着就跑（老用户搬家后不会因为界面换地方就失效）
function plibAutoOn() {
  const c = ctx.config || {};
  return !!((c.updater && c.updater.autoPlib) || (c.plibUpdate && c.plibUpdate.auto));
}
ctx.updaterPlibAuto = plibAutoOn;

// ---------- 开机自动（默认关；延后 10 秒、不 await、全 try/catch → 用户感觉不到它）----------
app.whenReady().then(() => {
  setTimeout(async () => {
    try {
      const c = ctx.config && ctx.config.updater;
      if (!c) return;
      // ① 提示词库自动更新（原 plib-update.js 的开机检查也在跑，这里补的是"搬过来的开关"那一路）
      if (c.autoPlib && ctx.plibUpdateRun && !(ctx.config.plibUpdate && ctx.config.plibUpdate.auto)) {
        try { ctx.plibUpdateRun({ silent: true }); } catch (e) {}
      }
      // ② 软件自动更新：检查 → 有新版就自动下载（用户选定的语义）
      if (c.autoApp) {
        const chk = await runCheck({ silent: true });
        if (chk && chk.ok && chk.hasNew) {
          dlog('[updater] 开机自动更新：发现 ' + chk.version + '，开始自动下载');
          runDownload();   // 不 await：下载在后台跑，进度走广播
        }
      }
    } catch (e) { dlog('[updater] 开机检查异常: ' + ((e && e.message) || e)); }
  }, 10000);
});

module.exports = { compareVer };
