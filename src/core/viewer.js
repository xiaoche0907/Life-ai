// 看图层（0913用户裁定）：进度卡结果图右键 → 整屏压暗+模糊 → 大图居中；滚轮切图 / 点图贴回 / 点空白关闭。
// 设计取舍（实测数据见 0913 记忆）：
//  · 模糊底图=打开瞬间 GDI 拷一张 480 宽的屏幕快照（StretchBlt 稳定 ~50ms；desktopCapturer 抖 20~480ms 不可用），
//    页面再缩到 1/4 后拉满全屏——纯位图缩放，零 CSS filter（铁律1：透明窗禁 filter/backdrop-filter）。
//  · 独立全屏 BrowserWindow，不进 cardWins（磁吸/吸附/锁定热区/挂靠都不认它）；用完藏起，空闲 30s 销毁，
//    销毁点无条件 assertTopmost（坑61：全屏置顶窗销毁会剥其他窗的置顶带）。
//  · 快照只拍光标所在那块屏，看图窗也只盖那块屏（双屏另一块保持原样，显存不翻倍）。
//  · 贴回走进度卡同一条 placeInPS 链，桥接件零改动。
const { BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage } = require('electron');
const path = require('path');
const ctx = require('./ctx');

const SNAP_W = 480;            // 快照宽（像素）；高按屏幕比例
const IDLE_DESTROY_MS = 30000; // 藏起后空闲多久销毁
let win = null;
let idleTimer = null;
let nat = null;                // koffi GDI 句柄（首次用到才加载）
const log = (m) => { try { ctx.dlog('[viewer] ' + m); } catch (e) {} };

// ---------- GDI 屏幕快照：GetDC(NULL) 整个虚拟屏 → StretchBlt 缩到 SNAP_W 宽 → 32 位 DIB 拷出 ----------
function loadGdi() {
  if (nat) return nat;
  const koffi = require('koffi');
  const u = koffi.load('user32.dll'), g = koffi.load('gdi32.dll');
  const BIH = koffi.struct('ORANGE_BIH', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  });
  koffi.struct('ORANGE_BMI', { bmiHeader: BIH, bmiColors: koffi.array('uint32', 1) });
  nat = {
    koffi,
    GetDC: u.func('void* __stdcall GetDC(void* h)'),
    ReleaseDC: u.func('int __stdcall ReleaseDC(void* h, void* dc)'),
    CreateCompatibleDC: g.func('void* __stdcall CreateCompatibleDC(void* dc)'),
    CreateDIBSection: g.func('void* __stdcall CreateDIBSection(void* dc, ORANGE_BMI* bmi, uint32 usage, _Out_ void** bits, void* hSection, uint32 off)'),
    SelectObject: g.func('void* __stdcall SelectObject(void* dc, void* obj)'),
    SetStretchBltMode: g.func('int __stdcall SetStretchBltMode(void* dc, int mode)'),
    StretchBlt: g.func('bool __stdcall StretchBlt(void* dst, int x, int y, int w, int h, void* src, int sx, int sy, int sw, int sh, uint32 rop)'),
    DeleteObject: g.func('bool __stdcall DeleteObject(void* o)'),
    DeleteDC: g.func('bool __stdcall DeleteDC(void* dc)'),
  };
  return nat;
}
// 返回 { dataUrl, ms } 或 null（拍不到=只压暗不模糊，页面自行降级）
function grabGdi(disp) {
  const n = loadGdi();
  const sf = disp.scaleFactor || 1;
  // 物理像素矩形：DIP 原点经 dipToScreenPoint 换算（混合 DPI 双屏时 bounds×scale 不成立），尺寸=DIP×scale
  const origin = screen.dipToScreenPoint ? screen.dipToScreenPoint({ x: disp.bounds.x, y: disp.bounds.y }) : { x: Math.round(disp.bounds.x * sf), y: Math.round(disp.bounds.y * sf) };
  const pw = Math.max(1, Math.round(disp.bounds.width * sf)), ph = Math.max(1, Math.round(disp.bounds.height * sf));
  const w = SNAP_W, h = Math.max(1, Math.round(SNAP_W * ph / pw));
  const t0 = Date.now();
  const sdc = n.GetDC(null);
  const mdc = n.CreateCompatibleDC(sdc);
  let hbm = null, old = null, buf = null;
  try {
    const bmi = { bmiHeader: { biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: [0] };
    const bits = [null];
    hbm = n.CreateDIBSection(sdc, bmi, 0, bits, null, 0);
    if (!hbm || !bits[0]) throw new Error('CreateDIBSection 失败');
    old = n.SelectObject(mdc, hbm);
    n.SetStretchBltMode(mdc, 3);   // COLORONCOLOR：比 HALFTONE 快 40%，后面页面还要再缩再放，质量差异看不出
    const ok = n.StretchBlt(mdc, 0, 0, w, h, sdc, origin.x, origin.y, pw, ph, 0x00CC0020);   // SRCCOPY
    if (!ok) throw new Error('StretchBlt 失败');
    buf = Buffer.from(n.koffi.decode(bits[0], n.koffi.array('uint8', w * h * 4, 'Typed')));
  } finally {
    try { if (old) n.SelectObject(mdc, old); } catch (e) {}
    try { if (hbm) n.DeleteObject(hbm); } catch (e) {}
    try { n.DeleteDC(mdc); } catch (e) {}
    try { n.ReleaseDC(null, sdc); } catch (e) {}
  }
  // DIB 是 BGRA，alpha 通道 BitBlt 不写（全 0）——直接喂 createFromBitmap 会按预乘 alpha=0 解读，JPEG 编码出全黑，先填满 255
  for (let p = 3; p < buf.length; p += 4) buf[p] = 255;
  const img = nativeImage.createFromBitmap(buf, { width: w, height: h });
  const jpg = img.toJPEG(80);
  return { dataUrl: 'data:image/jpeg;base64,' + jpg.toString('base64'), ms: Date.now() - t0, w, h, via: 'gdi' };
}
async function grabFallback(disp) {
  const t0 = Date.now();
  const sf = disp.scaleFactor || 1;
  const pw = Math.round(disp.bounds.width * sf), ph = Math.round(disp.bounds.height * sf);
  const h = Math.max(1, Math.round(SNAP_W * ph / pw));
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: SNAP_W, height: h } });
  const src = sources.find((s) => s.display_id === String(disp.id)) || sources[0];
  if (!src || !src.thumbnail || src.thumbnail.isEmpty()) return null;
  return { dataUrl: 'data:image/jpeg;base64,' + src.thumbnail.toJPEG(80).toString('base64'), ms: Date.now() - t0, w: SNAP_W, h, via: 'capturer' };
}
async function snapshot(disp) {
  try { return grabGdi(disp); } catch (e) { log('GDI 快照失败(' + (e && e.message) + ')，退回 desktopCapturer'); }
  try { return await grabFallback(disp); } catch (e) { log('desktopCapturer 也失败(' + (e && e.message) + ')，只压暗不模糊'); }
  return null;
}

// ---------- 看图序列：与进度卡一模一样的分组顺序（一批一组，组内按任务序），只取有结果文件的 ----------
function sequence() {
  const tasks = (ctx.getGenTasks && ctx.getGenTasks()) || [];
  const map = new Map();
  tasks.forEach((t) => { const k = t.batchId || t.id; if (!map.has(k)) map.set(k, []); map.get(k).push(t); });
  const out = [];
  for (const batch of map.values()) for (const t of batch) if (t.file) out.push(t);
  return out;
}
const fileUrl = (p) => (p ? 'file:///' + String(p).replace(/\\/g, '/') : null);
function itemsOf(seq, curIdx) {
  return seq.map((t, i) => {
    // 中号预览图（1600 宽）：落盘时已生成；老任务没有的只给当前±2 张现算（每张≈40ms），其余退回原图
    let mid = t.mid || null;
    if (!mid && ctx.midOf && Math.abs(i - curIdx) <= 2) { try { mid = t.mid = ctx.midOf(t.file); } catch (e) {} }
    return { id: t.id, file: fileUrl(t.file), path: t.file, mid: fileUrl(mid), status: t.status, prompt: t.prompt || '', docId: t.docId || null, selection: t.selection || null, antiMode: t.antiMode || 0 };
  });
}

// ---------- 清屏：把「被全屏窗盖住就不再重绘」的桌面立刻重画一遍 ----------
// 1007 用户复测（0915 那版修的是 z 序，日志实证它每次都跑了：收起那刻「已重申层序」＋「弹窗模式落位 15 张」
// 一毫秒不差地打出来，可用户照样"整个屏幕卡住"）→ 真凶不是层序，是**画面残留**：
// 本窗是 focusable:false 的全屏置顶窗，它一盖，Windows 判定底下所有窗被遮挡、不再给它们发重绘；
// hide() 之后系统不保证补一次 WM_PAINT/DWM 重合成，屏上留下的还是「压暗 0.58 的模糊屏 + 大图」那最后一帧
// （底下其实全是活的），点一下别处＝切活动窗强制重绘才刷掉——这正是"点屏幕其他部分才能恢复"的由来。
// 两手：①藏之前先把窗口打成全透明（分层属性一变，DWM 必须重合成这片区域，不能留着旧帧）；
//      ②藏完立刻 RedrawWindow 全桌面（RDW_UPDATENOW＝现在就重画，不留待下一拍）。
// 只在"看图层关掉"这一瞬间各打一发：不动尺寸/位置（铁律2），不加动画、不加定时器。
let u32 = null;   // koffi user32（首次用到才加载；加载失败＝清屏不发，只记一行日志，功能照旧）
function loadU32() {
  if (u32 !== null) return u32;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    u32 = { koffi, RedrawWindow: u.func('bool __stdcall RedrawWindow(void* hwnd, void* rect, void* rgn, uint32 flags)') };
  } catch (e) { u32 = false; log('清屏不可用(koffi 加载失败)：' + (e && e.message)); }
  return u32;
}
// hwnd=NULL=更新桌面窗；INVALIDATE(1)|ERASE(4)|ALLCHILDREN(0x80)|UPDATENOW(0x100)
const RDW_ALL = 0x1 | 0x4 | 0x80 | 0x100;
function redrawDesktop(why) {
  const t0 = Date.now();
  const u = loadU32();
  let ok = false;
  if (u) { try { ok = !!u.RedrawWindow(null, null, null, RDW_ALL); } catch (e) {} }
  log('清屏 × ' + (why || '') + ' ok=' + ok + ' 耗时 ' + (Date.now() - t0) + 'ms');
}

// ---------- 窗口 ----------
const sameBounds = (a, b) => a && b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
function ensureWin(disp) {
  // 换了屏（双屏在另一块屏右键）：resizable:false 的窗拒绝程序化 setBounds（坑82），直接销毁重建
  if (win && !win.isDestroyed() && !sameBounds(win.getBounds(), disp.bounds)) destroy();
  if (win && !win.isDestroyed()) return win;
  const opts = ctx.glassWinOpts({
    x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
    show: false, minimizable: false, maximizable: false, movable: false,
  });
  win = new BrowserWindow(opts);
  win._isViewer = true;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => { win._ready = true; if (win._pending) { const p = win._pending; win._pending = null; try { win.webContents.send('viewer-data', p); } catch (e) {} } });
  win.loadFile(path.join(ctx.SRC, 'renderer', 'viewer.html'));
  return win;
}
function sendData(w, payload) {
  if (w._ready) { try { w.webContents.send('viewer-data', payload); } catch (e) {} }
  else w._pending = payload;
}
function raise() {
  try { if (win && !win.isDestroyed() && win.isVisible()) win.moveTop(); } catch (e) {}
}
// 开着期间的压顶守卫：置顶重申/系统位核验会把个别卡 setAlwaysOnTop 抬到带顶（坑61 备注），
// 主路径已在 enforceZOrder/raiseCard 里回调 viewerOnTop，这里 350ms 兜底（只在可见期间跑，关了就停）
let topTimer = null;
function guardTop(on) {
  clearInterval(topTimer); topTimer = null;
  if (on) topTimer = setInterval(raise, 350);
}
function hide(why) {
  guardTop(false);
  if (!win || win.isDestroyed()) return;
  const wasVisible = !!win.isVisible();
  if (wasVisible) {
    // 1007 病灶在画面残留（见上面「清屏」段）：透明化 → 隐藏 → 恢复，最后补一发桌面重绘。
    // 透明化紧贴 hide：即便 DWM 把这一拍合并成"隐藏"最终态，至少分层属性已变更（DWM 必须重合成该区域）。
    try { win.setOpacity(0); } catch (e) {}
    try { win.hide(); } catch (e) {}
    try { win.setOpacity(1); } catch (e) {}
    // 隐藏真落地没有？hide() 抛错的话窗口还盖着屏＝"整屏卡住"的另一种可能，日志留指纹（下一轮不用瞎猜）
    let stillVisible = null;
    try { stillVisible = win.isVisible(); } catch (e) {}
    if (stillVisible) log('⚠ 隐藏未生效，窗口仍在屏上');
    redrawDesktop('收起');
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(destroy, IDLE_DESTROY_MS);
  // 0915用户实报（复测两次）："看大图点空白返回后面板卡住，点不动，点一下PS才恢复"。
  // 当时判成 hide/destroy 不对称（销毁全屏置顶窗有坑61的"连坐剥置顶"重申，隐藏却什么都不做）→ 补了下面这发重申。
  // ⚠1007 复测推翻这个判断：**这发一直在跑**（日志实证"已重申层序"＋"落位 15 张"都打了），用户照样卡
  //   → 层序不是（至少不是全部）病根，真凶是本文件顶上的「清屏」段（画面残留）。重申保留——它治的是另一类
  //   "看着在、点了没反应"，与残留是两回事，别删。挂靠模式下卡牌不进置顶带，得插回 PS 主窗正上方。
  if (wasVisible) {
    try { if (ctx.assertTopmost) ctx.assertTopmost('看图层收起'); } catch (e) {}
    try { if (ctx.fgwatchLayerFix) ctx.fgwatchLayerFix('看图层收起'); } catch (e) {}
  }
  log('收起 · ' + (why || '') + (wasVisible ? ' · 已重申层序' : ''));
}
function destroy() {
  guardTop(false);
  clearTimeout(idleTimer); idleTimer = null;
  if (!win || win.isDestroyed()) { win = null; return; }
  const wasVisible = !!win.isVisible();
  if (wasVisible) { try { win.setOpacity(0); } catch (e) {} }   // 同 hide：销毁前先全透明，DWM 必须重合成该区域
  try { win.destroy(); } catch (e) {}
  win = null;
  // 全屏尺寸置顶窗销毁=其他窗 topmost 连坐剥除（坑61）：案发现场无条件重申
  try { if (ctx.assertTopmost) ctx.assertTopmost('看图层销毁'); } catch (e) {}
  // 1007：销毁同样是把"盖住全屏的遮挡物"撤掉，桌面一样可能停在旧帧上（用户已点过别处/或本窗未曾 hide 就销毁）
  redrawDesktop('销毁');
}

async function open(taskId) {
  const seq = sequence();
  const idx = seq.findIndex((t) => t.id === taskId);
  if (idx < 0) { ctx.olog('🖼 这张还没有结果图，看不了大图', 'err'); return { ok: false, error: 'no-file' }; }
  const t0 = Date.now();
  clearTimeout(idleTimer); idleTimer = null;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  // 先拍快照再现身（看图窗自己不能进快照）；窗口若还藏着此刻不可见，顺序天然正确
  const snap = await snapshot(disp);
  const w = ensureWin(disp);
  sendData(w, { items: itemsOf(seq, idx), index: idx, snap: snap ? snap.dataUrl : null, disp: { w: disp.bounds.width, h: disp.bounds.height }, accent: (ctx.config && ctx.config.ui && ctx.config.ui.accent) || null });
  try { w.setOpacity(1); } catch (e) {}   // 兜底：上一轮若有异常路径把它留在 0，这里保证现身是实的
  try { w.showInactive(); } catch (e) {}
  raise();
  guardTop(true);
  log('打开 #' + (idx + 1) + '/' + seq.length + ' 屏=' + disp.bounds.width + 'x' + disp.bounds.height + '@' + disp.scaleFactor
    + ' 快照=' + (snap ? snap.via + ' ' + snap.w + 'x' + snap.h + ' ' + snap.ms + 'ms' : '无') + ' 总耗时 ' + (Date.now() - t0) + 'ms');
  return { ok: true, index: idx, count: seq.length, ms: Date.now() - t0 };
}

// 任务状态变化（贴回变暗/新图完成）→ 看图窗开着时同步序列（不换当前张、不重拍快照）
ctx.viewerSync = () => {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  try {
    const seq = sequence();
    win.webContents.send('viewer-items', { items: itemsOf(seq, -99) });
  } catch (e) {}
};
ctx.viewerOnTop = raise;   // 球/卡牌 moveTop、置顶重申等抬窗动作之后调一下：看图窗开着时必须压在最上

ipcMain.handle('viewer-open', (_e, taskId) => {
  // 0913修复：右键进度卡卡顿——handler 里哪怕写 open(taskId) 不 await，async 函数体到第一个 await 前是同步跑的，
  // snapshot()→grabGdi() 那 30~50ms GDI 仍卡在 IPC 回程里（实测往返 55ms）。setImmediate 让 handler 先回，GDI 下一拍再跑。
  setImmediate(() => { open(taskId).catch((e) => { try { ctx.dlog('[viewer] open异步失败 ' + (e && e.message)); } catch {} }); });
  return { ok: true, opening: true };
});
ipcMain.on('viewer-close', () => hide('页面关闭'));
ipcMain.handle('viewer-state', () => ({ exists: !!(win && !win.isDestroyed()), visible: !!(win && !win.isDestroyed() && win.isVisible()) }));
