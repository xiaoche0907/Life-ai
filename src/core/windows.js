// 窗口体系：悬浮球/主面板/功能卡片 + 磁吸拖动/缩放引擎/锁定穿透 + 收纳释放动画 + 快速布局
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

const config = ctx.config;
const MODULES = ctx.MODULES;
const modById = ctx.modById;
const saveConfig = () => ctx.saveConfig();
const olog = (m, t) => ctx.olog(m, t);

const BALL_WIN = 96;               // 球的逻辑尺寸（配置里ballPos沿用96窗口时代的左上角坐标口径）
// 球窗口常驻大画布：球始终居中，菜单/水波在同一窗口里纯CSS展开——
// 开合菜单绝不resize窗口（透明窗改尺寸的重绘帧=球残影闪跳，实测无解，索性不改）
const BALL_WW = 560, BALL_WH = 460;
const HUB_W = 420, HUB_H = 480;    // 主面板基准尺寸（4列网格）

let ballWin = null;
let hubWin = null;
const cardWins = {};               // id -> BrowserWindow

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// 拦截Chromium内置缩放（Ctrl+-/Ctrl+=/Ctrl+0/Ctrl+滚轮）：它和我们的zoom引擎是两套系统，
// 且file://全同源——用户在输入框旁按Ctrl+-会把所有卡的文字一起缩小并被会话记住，"调不回去"
function guardZoomKeys(win) {
  win.webContents.on('before-input-event', (e, input) => {
    if (!input.control && !input.meta) return;
    const k = String(input.key || '').toLowerCase();
    if (k === '-' || k === '=' || k === '+' || k === '0' || k === 'add' || k === 'subtract' || k === 'numpadadd' || k === 'numpadsubtract') e.preventDefault();
  });
  win.webContents.on('zoom-changed', (e) => { try { e.preventDefault(); } catch {} });
}

// ---------- 屏幕适配：坐标夹取 + 显示器变化找回（Beta反馈P0第1条） ----------
// 保存的窗口坐标可能来自更高分辨率/已拔掉的副屏，恢复前必须夹进当前有效工作区，
// 否则核心入口(小球)会整个初始化到屏幕外、永远点不到
function clampToWork(x, y, w, h) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
  w = Number.isFinite(w) && w > 0 ? w : 1;
  h = Number.isFinite(h) && h > 0 ? h : 1;
  let wa;
  try {
    wa = screen.getDisplayMatching({ x: x | 0, y: y | 0, width: w | 0, height: h | 0 }).workArea;
  } catch { return [x | 0, y | 0]; }
  // 窗口比工作区还大时对齐左上（允许右/下溢出，至少标题栏可抓）
  const nx = Math.min(Math.max(x, wa.x), wa.x + Math.max(0, wa.width - Math.min(w, wa.width)));
  const ny = Math.min(Math.max(y, wa.y), wa.y + Math.max(0, wa.height - Math.min(h, wa.height)));
  return [nx | 0, ny | 0];
}

// 显示器拓扑/分辨率/DPI变化后：逐窗校验，跑出屏幕外的拉回来并写回config
function recoverAllWindows() {
  const fix = (w, save) => {
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    const [nx, ny] = clampToWork(b.x, b.y, b.width, b.height);
    if (nx !== b.x || ny !== b.y) {
      try { w.setPosition(nx, ny); } catch {}
      save(nx, ny);
    }
  };
  // 球按球心夹取（窗口是560×460大画布，按整窗夹会把球心逼离屏幕边缘280px）
  if (ballWin && !ballWin.isDestroyed()) {
    const b = ballWin.getBounds();
    let cx0 = b.x + b.width / 2, cy0 = b.y + b.height / 2;
    try {
      const wa = screen.getDisplayMatching(b).workArea;
      const nx0 = Math.min(Math.max(cx0, wa.x + 20), wa.x + wa.width - 20);
      const ny0 = Math.min(Math.max(cy0, wa.y + 20), wa.y + wa.height - 20);
      if (nx0 !== cx0 || ny0 !== cy0) {
        try { ballWin.setPosition((nx0 - BALL_WW / 2) | 0, (ny0 - BALL_WH / 2) | 0); } catch {}
        config.ballPos = [(nx0 - BALL_WIN / 2) | 0, (ny0 - BALL_WIN / 2) | 0];
      }
    } catch {}
  }
  fix(hubWin, (x, y) => { config.hubPos = [x, y]; });
  for (const id in cardWins) {
    fix(cardWins[id], (x, y) => { config.cards[id] = Object.assign(config.cards[id] || {}, { x, y }); });
  }
  saveConfig();
}
let displayDebounce = null;
app.whenReady().then(() => {
  const onChange = () => {
    clearTimeout(displayDebounce);
    displayDebounce = setTimeout(recoverAllWindows, 600);
  };
  screen.on('display-removed', onChange);
  screen.on('display-added', onChange);
  screen.on('display-metrics-changed', onChange);
});

// ---------- 通用透明窗口参数 ----------
// focusable:false=调色板窗口模式：点按钮/滑块/翻页都不抢PS焦点(PS快捷键不断)；
// 点进输入框时由want-focus临时开聚焦打字，离开输入框即释放
function glassWinOpts(extra) {
  return Object.assign({
    frame: false, transparent: true, backgroundColor: '#00000000', alwaysOnTop: true,
    resizable: false, skipTaskbar: true, hasShadow: false, focusable: false,
    webPreferences: {
      preload: path.join(ctx.SRC, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  }, extra);
}

// 输入框临时聚焦：进入=可聚焦并拿焦点(打字)，离开=恢复不可聚焦(焦点还给PS侧)
// ⚠幂等守卫：同态请求不再重设——setFocusable重复重设会引发blur/refocus连锁，
// 连锁再触发focusin再发IPC=焦点风暴（全屏闪烁+电脑假死，搜索框实测翻车）
let wfCount = 0, wfWindowStart = 0;
ipcMain.on('want-focus', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  on = !!on;
  // 风暴探测：单秒超40次=有循环，落日志并本秒熔断（不再碰focusable，斩断连锁）
  const now = Date.now();
  if (now - wfWindowStart > 1000) { wfWindowStart = now; wfCount = 0; }
  if (++wfCount > 40) {
    if (wfCount === 41) { try { ctx.dlog('[wf-storm] want-focus风暴！来源=' + (e.sender.getURL() || '').split('/').pop() + ' 已熔断'); } catch {} }
    return;
  }
  if (w._wantFocusOn === on) {
    if (on && !w.isFocused()) { try { w.focus(); } catch {} }
    return;
  }
  w._wantFocusOn = on;
  // 0911 用户实报：反复点输入框再点PS浮动面板，卡牌压在面板上（setFocusable(false)不主动失焦，卡牌仍是前台）。
  // 修法：输入框失焦时（on=false）立刻把前台主动交还给PS主窗，不等轮询发现（挂靠模式下层序由Windows维护，
  // 但前台归属仍需显式控制）——SetForegroundWindow(PS主窗)让卡牌立刻沉到面板之下，暴露窗口压到最短。
  if (!on && ctx.returnForeground) ctx.returnForeground();
  // ⚠Electron 的 setFocusable(false) 在 Windows 上内部会 Deactivate() = SetForegroundWindow(z 序里下一个可见窗)。
  // 卡牌全是置顶窗，"下一个"往往是橙子自己的另一张卡 → 用户刚点去 PS/浏览器，150ms 后前台被抢回橙子
  // （0909 实锤：日志里每次切走 100ms 后"前台=electron"弹回、卡牌重新压回浏览器；随后 ai-gen 失守=就是这个连锁）。
  // 修法：记下释放前的前台窗，释放后若前台落到自己身上就立刻还回去（此刻我们是前台，有权归还）。
  const nat = (!on && ctx.win32) ? ctx.win32() : null;
  let prevFg = null;
  try { if (nat) prevFg = nat.GetForegroundWindow(); } catch (e) {}
  try {
    w.setFocusable(on);
    if (on) w.focus();
    w.setSkipTaskbar(true);   // setFocusable会悄悄重置skipTaskbar→任务栏蹦出Electron原子图标（0906用户实测），每次压回
  } catch (err) {}
  if (nat && prevFg) {
    try {
      const nowFg = nat.GetForegroundWindow();
      const nowPid = ctx.win32PidOf(nowFg), prevPid = ctx.win32PidOf(prevFg);
      if (nowPid === process.pid && prevPid && prevPid !== process.pid && String(nowFg) !== String(prevFg)) {
        nat.SetForegroundWindow(prevFg);
        try { ctx.dlog('[wf] 释放焦点时前台被抢回自己，已还给 pid=' + prevPid); } catch (e) {}
      }
    } catch (e) {}
  }
  // 聚焦抬升后按铁序压回（0908 用户裁定 球>控制台>卡牌）：focus() 会把这张卡抬到置顶带最上、压住控制台，
  // 80ms 后控制台与球重新压顶。之前只抬球=点一下输入框控制台就沉到卡牌底下
  if (on) setTimeout(() => enforceZOrder(), 80);
  // focus()/setFocusable() 的激活语义必然把这张卡抬到 PS 浮动面板之上（拦不住，是 Windows 的激活行为）——
  // 聚焦和释放**两头**都立刻把层序压回主窗正上方，不等 fgwatch 下一拍（0911 用户实报"输入框和 PS 浮窗来回点，
  // 提示词卡卡在图层面板上边"）。z 序与键盘焦点无关：压到面板之下仍然照常打字。
  try { if (ctx.fgwatchLayerFix) ctx.fgwatchLayerFix(on ? '输入框聚焦' : '输入框释放'); } catch (e) {}
});

// ---------- 开机编排：小橙子先亮，其余窗口静默加载，齐了从球心绽放飞位 ----------
// bootDeferring期间创建的窗口一律show:false；每个窗口did-finish-load向球报进度（波纹+描边进度环）
let bootDeferring = false;
let bootExpected = 0, bootLoaded = 0;
function bootTrack(win) {
  if (!bootDeferring || !win) return;
  bootExpected++;
  win.webContents.once('did-finish-load', () => {
    bootLoaded++;
    // 只在编排期上报——兜底超时开演后，迟到的加载完成不能再发进度
    // （球端收到会把已熄灭的波纹/描边复活且再无人熄灭，实测"加载好了还在闪"）
    if (!bootDeferring) return;
    try {
      if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('boot-progress', { done: bootLoaded, total: bootExpected });
    } catch {}
  });
}
ctx.beginBootChoreo = () => {
  bootDeferring = true; bootExpected = 0; bootLoaded = 0;
  // 球窗口本就是常驻大画布，水波有地方扩散，无需扩窗（改bounds=残影，禁）
  if (ballWin && !ballWin.isDestroyed()) ballWin._bootFx = true;
};
function endBootFx() {
  try {
    if (ballWin && !ballWin.isDestroyed()) {
      ballWin.webContents.send('boot-progress', { finished: true });
      ballWin._bootFx = false;
    }
  } catch {}
}
ctx.finishBootChoreo = () => {
  const t0 = Date.now();
  const waiter = setInterval(() => {
    // 等全部加载完；4秒兜底超时（个别卡加载卡住不能拖垮整场亮相）
    if (bootLoaded < bootExpected && Date.now() - t0 < 4000) return;
    clearInterval(waiter);
    try {
      // 环收满（但不熄灭——波纹和描边要陪跑到卡牌落位）
      if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('boot-progress', { done: bootExpected || 1, total: bootExpected || 1 });
    } catch {}
    // 亮相名单：控制台(开着的) + open的卡（融合叠只亮当前页）
    // ⚠落位坐标一律现算现取（getBounds），不能提前缓存——开机绽放走的也是releaseAll，
    //   若此期间用户手快点开过菜单/动过窗，缓存坐标就是历史值=卡牌飞到旧位"不复位"
    const items = [];
    if (hubWin && !hubWin.isDestroyed() && config.hubOpen) {
      const b = hubWin.getBounds();
      items.push({ id: '__hub', win: hubWin, x: b.x, y: b.y });
    }
    for (const id in cardWins) {
      const w = cardWins[id];
      if (!w || w.isDestroyed()) continue;
      if (!(config.cards[id] && config.cards[id].open)) continue;   // 堆牌成员全部可见，一起绽放
      const b = w.getBounds();
      items.push({ id, win: w, x: b.x, y: b.y });
    }
    bootDeferring = false;
    if (!items.length) { setTimeout(endBootFx, 400); return; }
    // 稍候片刻让进度环收满，再从球心绽放（复用收纳/释放的飞行动画）；
    // 波纹+描边陪跑整段飞行，卡牌落位后再熄灭复原球窗
    setTimeout(() => {
      // ⚠开机绽放不能覆盖用户状态：这280ms里用户可能已左键球收纳过（gatherState非空）
      //   或有动画在跑——此时放弃绽放直接显示到位，绝不制造两份gatherState打架
      if (gatherState || gatherAnim || gatherPhase) {
        for (const it of items) {
          try { if (!it.win.isDestroyed() && !it.win.isVisible()) it.win.showInactive(); } catch {}
        }
        deckRestackAll();
        broadcastOpenStates();
        return;
      }
      gatherState = { items };
      releaseAll();
    }, 280);
    setTimeout(endBootFx, 280 + 240 + 160);   // 绽放延时 + 飞行240ms + 落定缓冲
  }, 100);
};

// ---------- 悬浮球 ----------
// config.ballPos存的是96时代的窗口左上角（兼容老配置）；实际窗口=以球心为中心的560×460大画布
function ballCenterFromLegacy(pos, wa) {
  const [rx, ry] = pos || [wa.x + wa.width - 130, wa.y + 120];
  const [bx, by] = clampToWork(rx, ry, BALL_WIN, BALL_WIN);
  return [bx + BALL_WIN / 2, by + BALL_WIN / 2];
}
function createBallWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const [cx0, cy0] = ballCenterFromLegacy(config.ballPos, wa);
  ballWin = new BrowserWindow(glassWinOpts({
    width: BALL_WW, height: BALL_WH,
    x: (cx0 - BALL_WW / 2) | 0, y: (cy0 - BALL_WH / 2) | 0,
    resizable: true,
  }));
  ballWin.loadFile(path.join(ctx.SRC, 'renderer', 'ball.html'));
  ballWin.setAlwaysOnTop(true, 'screen-saver');
  guardZoomKeys(ballWin);
  ballWin.webContents.on('did-finish-load', () => { try { ballWin.webContents.setZoomFactor(1); } catch {} });   // 清掉被Ctrl+-污染过的会话缩放
  // 尺寸看门狗（坑56）：球窗常驻大画布尺寸恒定，任何变化都是舍入漂移/系统DPI偷改→压回+落日志
  ballWin.on('resize', () => {
    if (ballWin.isDestroyed()) return;
    const [bw2, bh2] = ballWin.getSize();
    if (Math.abs(bw2 - BALL_WW) > 1 || Math.abs(bh2 - BALL_WH) > 1) {
      try { ctx.dlog('[sizeguard] 球窗尺寸漂移 ' + BALL_WW + 'x' + BALL_WH + '→' + bw2 + 'x' + bh2 + ' 已压回'); } catch {}
      try { ballWin.setSize(BALL_WW, BALL_WH); } catch {}
    }
  });
}

// 页面上报的按钮热区（CSS像素，页面坐标系）；锁定时鼠标在热区上→接收点击，否则穿透
ipcMain.on('pass-rects', (e, rects) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w._passRects = rects || [];
});
function cursorOnPassRect(w, p) {
  const rects = w._passRects;
  if (!rects || !rects.length) return false;
  const b = w.getBounds();
  const zoom = (w._rz && w._rz.zoom) || 1;
  // 页面CSS坐标 → 屏幕DIP：css * zoom + 窗口原点
  const lx = p.x - b.x, ly = p.y - b.y;
  for (const r of rects) {
    if (lx >= r.x * zoom && lx <= (r.x + r.w) * zoom && ly >= r.y * zoom && ly <= (r.y + r.h) * zoom) return true;
  }
  return false;
}

// 点击穿透：主进程轮询鼠标，球区内接收点击，其余穿透给PS
// 锁定模式下：卡片/面板只有按钮热区接收点击，其余穿透；拖拽缩放另在drag/grip入口拦截
let ignoreState = null;
let lockLoopWasOn = false;   // 锁定→解锁的一次性恢复标志
let menuAwayTicks = 0;       // 球菜单展开中光标离开窗口的连续计数（>25≈800ms自动收起）
// 堆牌方向键状态（注册/注销在下方轮询里做；stacks/deckOrder/deckCut定义在后文，轮询首跳远晚于模块加载，无TDZ）
let deckKeysOn = false, deckHoverStack = null;
function deckUnderCursor(p) {
  for (const s of stacks) {
    for (const m of s.members) {
      const w = cardWins[m];
      if (!w || w.isDestroyed() || !w.isVisible()) continue;
      const b = w.getBounds();
      if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return s;
    }
  }
  return null;
}
function deckKeyCut(dir) {
  const s = deckHoverStack;
  if (!s || deckAnim || !stacks.includes(s)) return;
  deckStepCut(s, dir, '方向键');
}
// 按堆序步进切牌（方向键/滚轮共用）：真正的轮换，N张全部可达
//   dir>0（下滚/↓）：当前前卡沉到最底，order[1]上来 → 连滚N次遍历整堆
//   dir<0（上滚/↑）：最底那张翻上来当前卡 → 反向遍历
// ⚠0908用户实测4张堆只能在两张间跳：旧写法每次切order[1]，切完原前卡正好退到order[1]，下一格又切回去=死循环。
function deckStepCut(s, dir, via) {
  const order = deckOrder(s);
  if (order.length < 2) return;
  let next;
  if (dir > 0) {
    // 前卡沉底：新顺序 = [order[1..], order[0]]
    next = order.slice(1).concat(order[0]);
  } else {
    // 底张翻上：新顺序 = [order[last], order[0..last-1]]
    next = [order[order.length - 1]].concat(order.slice(0, -1));
  }
  const target = next[0];
  try { ctx.dlog('[deck] ' + (via || '') + '切牌 → ' + target + ' 序=' + next.join('>')); } catch (e) {}
  deckCut(s, target, { order: next });
}
// 滚轮切牌（发起窗口所在的堆；渲染端已做区域判定与节流）
ipcMain.on('deck-wheel', (e, dir) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !w._cardId) return;
  const s = stackOf(w._cardId);
  if (!s || deckAnim) return;
  deckStepCut(s, Number(dir) > 0 ? 1 : -1, '滚轮');
});
setInterval(() => {
  if (!app.isReady()) return;   // screen模块在app ready前调用会直接抛错闪退
  const p = screen.getCursorScreenPoint();
  if (ballWin && !ballWin.isDestroyed()) {
    const b = ballWin.getBounds();
    let wantIgnore;
    if (ballWin._menuOpen) {
      // 菜单展开中：窗口内按页面上报的热区(菜单项+球)判定；窗口外穿透并计数自动收起
      const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
      wantIgnore = inside ? !cursorOnPassRect(ballWin, p) : true;
      if (!inside) { if (++menuAwayTicks > 25) openBallMenu(false); }
      else menuAwayTicks = 0;
    } else {
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      const dx = p.x - cx, dy = p.y - cy;
      wantIgnore = (dx * dx + dy * dy) > 46 * 46;   // 球始终可点（锁定时也要能开面板）
    }
    if (wantIgnore !== ignoreState) {
      ignoreState = wantIgnore;
      // 0915去forward：forward=true在Windows上挂WH_MOUSE_LL全局鼠标钩子（主进程线程），
      // 生图落盘/base64编码把主线程一堵，钩子回调排不上号=全系统鼠标肉眼卡顿（用户实报"关软件就好"）。
      // 球页面的mousemove只在拖动中用（拖动必然从非穿透态的mousedown开始），穿透期根本不需要转发。
      ballWin.setIgnoreMouseEvents(wantIgnore);
    }
  }
  // 堆牌方向键（0906用户裁定）：光标悬在堆上时 ↑=切出上面那张 ↓=反向轮换；
  // 只在悬停期间注册全局快捷键，离开立刻注销——方向键还给PS（PS里方向键=挪图层，绝不能常驻抢）
  const ds = stacks.length ? deckUnderCursor(p) : null;
  deckHoverStack = ds;
  if (!!ds !== deckKeysOn) {
    deckKeysOn = !!ds;
    try {
      if (deckKeysOn) {
        globalShortcut.register('Up', () => deckKeyCut(1));
        globalShortcut.register('Down', () => deckKeyCut(-1));
      } else {
        globalShortcut.unregister('Up');
        globalShortcut.unregister('Down');
      }
    } catch (e) {}
  }
  // 卡片与主面板：仅锁定时逐窗判热区；解锁瞬间一次性恢复全接收（未锁定时不再每30ms空转全窗循环）
  if (config.locked) {
    lockLoopWasOn = true;
    const others = [...Object.values(cardWins), hubWin];
    for (const cw of others) {
      if (!cw || cw.isDestroyed()) continue;
      const want = !cursorOnPassRect(cw, p);
      // 防拖断抖动：想要的状态连续稳定2拍(≈60ms)才真翻转——在PS里拉选区/拖拽时光标扫过热区，
      // 高频翻穿透会打断底层按住的拖拽；人手点按钮必有停留，60ms无感
      if (cw._ignoreState === want) { cw._ignoreWant = null; continue; }
      if (cw._ignoreWant !== want) { cw._ignoreWant = want; cw._ignoreTicks = 1; continue; }
      if (++cw._ignoreTicks < 2) continue;
      cw._ignoreState = want; cw._ignoreWant = null;
      // 不带forward：热区判定本来就在主进程轮询，不需要转发；forward=每窗挂全局鼠标钩子，
      // 锁定时16窗齐挂会拖垮/打断PS的鼠标拖拽（面板展开拉选区断开的元凶）
      cw.setIgnoreMouseEvents(want);
    }
  } else if (lockLoopWasOn) {
    lockLoopWasOn = false;
    for (const cw of [...Object.values(cardWins), hubWin]) {
      if (!cw || cw.isDestroyed()) continue;
      if (cw._ignoreState) {
        cw._ignoreState = false;
        cw._ignoreWant = null;
        cw.setIgnoreMouseEvents(false);
      }
    }
  }
}, 30);

// ====== 交互门禁（唯一出口）======
// 两态模型：锁定=布局冻结+鼠标穿透；未锁定=拖动缩放全开。
// 所有"能不能拖/能不能缩/球能不能动"的判断只许问这里——别处不得再写第二份规则
// （历史教训：门禁散落多处，每次改交互语义都漏一处=一堆回归bug）
function canLayout() { return !config.locked && !config.layoutLock; }   // 卡牌/控制台的拖动与缩放
function canMoveBall() { return !!ballWin && !ballWin.isDestroyed() && !ballWin._menuOpen && !ballWin._bootFx; }
function canBallMenu() { return !!ballWin && !ballWin.isDestroyed() && !ballWin._bootFx; }
ctx.canLayout = canLayout;

// ---------- 缩放引擎（混合模式） ----------
// Win上透明无边框窗口没有系统边缘拖拽，全部由页面自绘手柄驱动：
//   角部圆钮 = 等比缩放（窗口和内容一起zoom）
//   右/下边缘 = 自由拉伸（只改宽或高，内容按布局重排）
// 卡片最小尺寸开关：on=钉住宽（base×minZ，缩到底账实一致）；off=放开为(0,0)（堆牌被压卡要收成标题条）
// ⚠只钉宽不钉高（0908实锤）：四边自由拉伸允许把卡拉得比 base×minZ 矮（forge 70 / logs 126 / colorcal 124 都是
// 用户合法拉出来的），若把高也钉到 base×0.45，重启/切牌/出堆时 setMinimumSize 把窗顶大、看门狗再压回=
// 每启一场拉锯（日志 `[sizeguard] 468x126→468x207 已压回`），且堆牌切回时 anti 高 113→149 断言红。
// 等比缩放到底时宽先撞 base×minZ，高随等比自然到位，所以只钉宽已经能保证"缩到极限拉得回来"。
function applyMinSize(win, on) {
  if (!win || win.isDestroyed() || !win._rz) return;
  try {
    if (on) win.setMinimumSize(Math.max(136, Math.round(win._rz.baseW * win._rz.minZ)), 40);
    else win.setMinimumSize(0, 0);
  } catch (e) {}
}

// 缩放引擎（统一等比，0907#7/#9）：所有卡只走一条缩放路径。
// Win上透明无边框窗口没有系统边缘拖拽，全部由页面自绘手柄驱动：
//   角部圆钮 + 四边自由手柄 = 全部等比缩放（窗口和内容一起zoom，文字随缩放跟随）
// 0907#9：四个边手柄也按"拖动方向换算成zoom变化"处理——四边与角部都是等比，所有卡缩放逻辑一致。
// 0907#6：加最大尺寸上限（clamp工作区，且不超可见区太多），拉不爆。
function bindScale(win, baseW, baseH, initialZoom, onResized) {
  win._rz = { baseW, baseH, zoom: initialZoom || 1, minZ: 0.45, maxZ: 2.2 };
  win._saveSize = onResized || null;
  // 显式最小窗尺寸（0908用户实测"缩到极限拉不回来"）：minZ 0.25 时所有卡都小于 Windows 默认最小窗(≈136×39)，
  // 系统把窗口钳住但缩放引擎的 zoom 账还在往下记，账与真实尺寸脱节→再拉大按被钳尺寸算=拉不动。
  // 下限抬到 0.45 + 显式 setMinimumSize，保证缩到底时窗口仍是缩放引擎算出的那个尺寸（账实一致）。
  // ⚠堆牌被压卡要收成标题条(比最小高矮)，deckShrink 会临时放开、deckExpand/出堆恢复——见 applyMinSize
  applyMinSize(win, true);
  win._authSize = win.getSize();   // 权威DIP尺寸：只有缩放引擎/布局恢复能改（跨屏DPI守卫按此归位）
  // 尺寸看门狗（坑54/56）：125%/150%等非整数缩放屏上，反复setPosition/setBounds的
  // DIP↔物理像素舍入误差会累积=按住面板不动窗口也一点点长大（100%屏永远复刻不出来）。
  // 任何未经授权的尺寸变化（不是缩放引擎作业）立刻压回权威尺寸+落日志留指纹。
  // 原生隐形边框拉伸=用户驱动的合法改尺寸（透明无边框窗外沿仍有系统resize区，落在12px
  // 透明边距里，用户拉伸经常抓到的其实是它而不是自绘手柄——实测被看门狗误杀，坑58）：
  // will-resize只在用户原生拉伸时发射→给看门狗放行；resized收尾把新尺寸转正+落盘
  // 堆牌：被压卡=纯标题条，用户原生拉伸一律拒绝（条会被拉开，且它的隐形拉伸区就露在前卡上方——
  // 0906用户实测"特定位置能拉到后方卡牌"）；前卡的原生拉伸=整堆跟随（拉伸中轻量跟位，松手精确收尾）
  const deckRole = () => {
    const s = win._cardId && stackOf(win._cardId);
    if (!s) return null;
    return deckOrder(s)[0] === win._cardId ? { s, front: true } : { s, front: false };
  };
  // 原生隐形边框拉伸=禁止：统一等比后，拉任意一边都应是等比（由页面自绘手柄grip-start驱动）。
  // 原生resize区会绕开grip直接把宽高改掉=出现"只改一个方向/形变"的怪（0907#8"拉边框调出弧度"类）。
  // 堆牌被压卡同理全部拒绝，因为窗口已收成标题条。
  // 注：不可能彻底移除系统resize区（无边框窗12px边距仍有THICKFRAME），这里用will-resize挡在最前。
  win.on('will-resize', (e) => {
    const r = deckRole();
    // 前卡在被拉伸时，"程序化deckFitToFront"需要的真实收尾走grip-end，这里只拦用户原生拉伸
    if (r && !r.front) { e.preventDefault(); return; }
    e.preventDefault();   // 统一等比：原生拉伸一律拦掉，交给自绘手柄（grip）走缩放引擎
    win._userRz = Date.now();
  });
  win.on('resized', () => {
    if (win.isDestroyed()) return;
    if (Date.now() - (win._userRz || 0) < 800) {
      win._userRz = 0;
      win._authSize = win.getSize();
      if (win._saveSize) win._saveSize();
    }
  });
  win.on('resize', () => {
    if (win.isDestroyed() || !win._authSize) return;
    if (win._rz && win._rz.start) return;   // 缩放引擎作业中=授权变化
    if (Date.now() - (win._userRz || 0) < 800) {   // 被will-resize放行的一瞬（极少）：不视为授权
      return;
    }
    const [cw2, ch2] = win.getSize();
    const [aw, ah] = win._authSize;
    if (Math.abs(cw2 - aw) > 1 || Math.abs(ch2 - ah) > 1) {
      // 日志限频：每窗每秒最多一条（真DPI偷改是低频事件，刷屏说明误杀了谁）
      if (Date.now() - (win._sgLogT || 0) > 1000) {
        win._sgLogT = Date.now();
        try { ctx.dlog('[sizeguard] 未授权尺寸变化 ' + aw + 'x' + ah + '→' + cw2 + 'x' + ch2 + ' 已压回'); } catch {}
      }
      try { win.setSize(aw, ah); } catch {}
    }
  });
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) {
      win.webContents.setZoomFactor(win._rz.zoom);
      win.webContents.send('zoom-var', win._rz.zoom);
    }
  });
}

// 跨屏DPI尺寸守卫（坑54）：Win混合DPI双屏拖窗跨屏时，WM_DPICHANGED的换算误差会把
// 窗口DIP尺寸/渲染缩放单向撑大——棘轮：进一次大一次，拖回来不还原。
// 药方：拖动每帧setBounds强制带上权威尺寸（系统偷改16ms内被踩回），松手再重申zoomFactor
// （文字被撑大的兜底——无论是DIP还是deviceScaleFactor哪层炸了，双保险都归位）。
function reassertZoom(w) {
  if (!w || w.isDestroyed()) return;
  try {
    const z = (w._rz && w._rz.zoom) || 1;
    w.webContents.setZoomFactor(z);
    w.webContents.send('zoom-var', z);
  } catch {}
}

// 等比缩放的上限：拉不爆、盖不掉别的卡太多（0907#6）。以主屏工作区为基准——等比例时宽/高
// 任一不超过工作区对应边 ×1.2，且绝对不超 3840×2160 逻辑尺寸。防止"拉得过大把其他卡挤掉/跳屏外/卡死"。
// ⚠基准必须用 _rz.baseW/baseH（模块定义默认尺寸）——等比缩放窗口尺寸=base×zoom，上限=工作区×1.2/base，
// 与当前实际尺寸无关。用 _authSize 会误判：卡被自由拉伸变宽/变长后 _authSize 变大→上限被算小甚至负，
// 长卡/宽卡就无法再放大（0907用户实测"长卡没法调比例/无法放大缩小"）。
function zoomMaxOf(win) {
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const rz = win._rz || {};
    const [bw, bh] = (rz.baseW > 0 && rz.baseH > 0)
      ? [rz.baseW, rz.baseH]
      : ((win._authSize && win._authSize[0] > 0 && win._authSize[1] > 0)
        ? [win._authSize[0], win._authSize[1]]
        : [300, 200]);
    // zoom上限=min(工作区边长×1.2 / base边长, 绝对上限2.2)
    const capW = (wa.width * 1.2) / bw, capH = (wa.height * 1.2) / bh;
    return Math.min(2.2, capW, capH, 3840 / bw, 2160 / bh);
  } catch { return 2.2; }
}

// 拖动量由主进程直接轮询系统鼠标坐标——不经过页面(页面坐标会被zoom缩放污染)、不刷IPC
let gripTimer = null;
ipcMain.on('grip-start', (e, mode) => {
  if (!canLayout()) {
    try { ctx.dlog('[grip] 拒绝 mode=' + mode + '（锁定中）'); } catch {}
    return;
  }
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed() || !w._rz) return;
  const [cw, ch] = w.getSize();
  const [wx, wy] = w.getPosition();
  const c = screen.getCursorScreenPoint();
  w._rz.start = { w: cw, h: ch, x: wx, y: wy, zoom: w._rz.zoom, cx: c.x, cy: c.y, mode, moved: false };
  // 堆牌前卡被拉伸：整堆当一张卡动（0906/0908 用户裁定"一起放大缩小，就像一个卡牌"）。
  // 被压卡与前卡**同一拍**（每 8ms 帧）一次 setBounds 同步改宽改位——0908 实测教训：曾"位置每帧跟、宽度限频 50ms 跟"，
  // 前卡每帧在变而被压卡每 50ms 跳一格，视觉就是被压卡拖着旧影子追前卡=重影+掉帧；改成"只跟位置不跟宽"用户又说不像一张卡。
  // 昂贵的 setResizable 开关只在会话首尾各做一次（被压卡平时不可缩放，跟随帧里若每次都开关=一帧一抖），缩放借用等松手
  const deckS = (w._cardId && stackOf(w._cardId)) || null;
  const deckLive = !!(deckS && deckOrder(deckS)[0] === w._cardId);
  if (deckS) deckS._liveOrder = deckOrder(deckS).slice();   // 0907#3：拖动会话内缓存堆序，deckFollowLive复用
  if (deckLive) {
    for (const m of deckS._liveOrder.slice(1)) {
      const rw = cardWins[m];
      try { if (rw && !rw.isDestroyed() && !rw.isResizable()) rw.setResizable(true); } catch (e) {}   // grip-end 的 deckShrink 收回
    }
  }
  clearInterval(gripTimer);
  gripTimer = setInterval(() => {
    if (w.isDestroyed() || !w._rz.start) { clearInterval(gripTimer); return; }
    const st = w._rz.start;
    const p = screen.getCursorScreenPoint();
    const dx = p.x - st.cx, dy = p.y - st.cy;
    // 0907#3 守卫：光标没真动过(水平+垂直<3px)不开始缩放——"按住不松手"是用户想点击/停留，
    // 不该第一帧就把内容缩放（用户报"按住卡牌某处不松手却缩小了文字按钮比例"）。与拖动第一帧吸附守卫同源(坑81)。
    if (!st.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      st.moved = true;
    }
    // 角部=统一等比缩放（内容连窗口一起缩放，0907#9）；四边=自由拉伸（只改宽或高，内容布局重排）。
    // 0907用户第三轮反馈"只能等比例拉伸无法随意调节大小"——四边必须恢复成自由拉伸，两种能力都要。
    // 0907#6 上限：每帧 clamp 进 zoomMaxOf/w，拉不爆；0907#9 防御：单帧异常 try/catch 不终止会话
    try {
      const maxZ = zoomMaxOf(w);
      const minW = 90, minH = 70;
      if (st.mode === 'corner') {
        // 等比：窗口与内容一起 zoom
        let nz = (st.w + dx) / st.w;
        nz = Math.min(maxZ, Math.max(w._rz.minZ, st.zoom * nz));
        const f2 = nz / st.zoom;
        w.setSize(Math.round(st.w * f2), Math.round(st.h * f2));
        if (Math.abs(nz - w._rz.zoom) > 0.004) {
          w._rz.zoom = nz;
          w.webContents.setZoomFactor(nz);
          w.webContents.send('zoom-var', nz);   // 页面据此反向补偿"尺寸恒定"元素
        }
      } else if (st.mode === 'right') {
        // 自由拉宽：只改宽，高不变，内容重排。带对齐吸附（0907 bug2"没有对齐手感"=吸附被我摘了）
        const nw = snapStretchW(w, st, Math.min(1600, Math.max(minW, st.w + dx)), 'right');
        w.setSize(nw, st.h);
      } else if (st.mode === 'left') {
        // 拉左边：宽度反向变化+窗口x补偿（吸附同样走snapStretchW）
        // ⚠下限必须用窗口自己的最小宽（setMinimumSize=max(136,base×minZ)），不能用 JS 里的 minW=90：
        //   否则 nw 在 JS 里一路缩到 90、OS 把窗口钳在 136，x 却按"缩到 90"的差值补偿→卡整体被往右推（0908用户实锤）
        const [wmin] = (() => { try { return w.getMinimumSize(); } catch (e) { return [minW, minH]; } })();
        const floorW = Math.max(minW, wmin || 0);
        const nw = snapStretchW(w, st, Math.min(1600, Math.max(floorW, st.w - dx)), 'left');
        w.setBounds({ x: st.x + (st.w - nw), y: st.y, width: nw, height: st.h });
      } else if (st.mode === 'top') {
        // 拉上边：高度反向变化+窗口y补偿（吸附走snapStretchH）；同上，下限用窗口最小高
        const [, hmin] = (() => { try { return w.getMinimumSize(); } catch (e) { return [minW, minH]; } })();
        const floorH = Math.max(minH, hmin || 0);
        const nh = snapStretchH(w, st, Math.min(1400, Math.max(floorH, st.h - dy)), 'top');
        w.setBounds({ x: st.x, y: st.y + (st.h - nh), width: st.w, height: nh });
      } else {
        // bottom：只改高（吸附走snapStretchH）
        const nh = snapStretchH(w, st, Math.min(1400, Math.max(minH, st.h + dy)), 'bottom');
        w.setSize(st.w, nh);
      }
    } catch (e) {
      try { ctx.dlog('[grip] 缩放帧异常(' + w._cardId + '): ' + (e && e.message)); } catch (e2) {}
    }
    // 被压卡跟随放在前卡改完尺寸**之后**同一拍：放在帧头会拿前卡上一帧的宽，被压卡永远慢一帧（实测落后 5px=肉眼重影）
    if (deckLive) { try { deckFollowLive(deckS, true); } catch (e) {} }
  }, 8);
});

const STRETCH_SNAP = 9;   // 拉伸吸附阈值（吸附函数仍被启动自检snaptest调用，保留）
const STRETCH_ESCAPE = STRETCH_SNAP + 6;   // 粘滞逃逸滞回：进吸附±9，拉开±15才松口
function stretchTargets(w, axis) {
  // 相关性过滤（坑59）：拉高度只看与我横向有重叠(或缝隙<40px)的邻居，拉宽度只看纵向邻居。
  // 此前全部开着的卡（跨双屏十几张）的边线+等尺寸候选全参战，候选密到拖动边永远
  // 泡在某个吸附区里——逐帧取最近就在相邻候选间跳变=拉不动+抽搐
  const b = w.getBounds();
  const mi = insetOf(w);
  const L = b.x + mi, T = b.y + mi, R = b.x + b.width - mi, B = b.y + b.height - mi;
  const list = [];
  const myDeck = (w._cardId && stackOf(w._cardId)) || null;
  for (const o of BrowserWindow.getAllWindows()) {
    if (o === w || o === ballWin || o.isDestroyed() || !o.isVisible() || o._isViewer) continue;
    if (myDeck && o._cardId && myDeck.members.includes(o._cardId)) continue;   // 同堆的被压卡逐帧跟着我，不能当吸附目标（自咬死锁）
    const ob = o.getBounds();
    const oi = insetOf(o);
    const t = { l: ob.x + oi, t: ob.y + oi, r: ob.x + ob.width - oi, b: ob.y + ob.height - oi };
    const nearX = Math.min(R, t.r) - Math.max(L, t.l) > -40;
    const nearY = Math.min(B, t.b) - Math.max(T, t.t) > -40;
    if (axis === 'h' ? nearX : nearY) list.push(t);
  }
  return list;
}
function pickSnap(cands, cur) {
  let best = null;
  for (const c of cands) {
    const d = c - cur;
    if (Math.abs(d) < STRETCH_SNAP && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}
// 粘滞吸附（坑59）：吸上一个候选后就咬住它，原始边线拉开逃逸距离才松口并放行一帧自由移动
// ——不做粘滞时相邻候选间逐帧跳变=抽搐；key按维度隔离（w/h各自粘滞）
function stickySnap(st, key, cands, movingEdge) {
  st._snapHold = st._snapHold || {};
  const held = st._snapHold[key];
  if (held !== undefined) {
    if (Math.abs(held - movingEdge) <= STRETCH_ESCAPE) return held - movingEdge;   // 咬住不放
    delete st._snapHold[key];
    return null;   // 逃逸成功：本帧自由，下帧再看新候选
  }
  const d = pickSnap(cands, movingEdge);
  if (d === null) return null;
  st._snapHold[key] = movingEdge + d;
  return d;
}
function snapStretchW(w, st, nw, mode) {
  const myIn = insetOf(w);
  const GAP = 1;
  const cands = [];
  // 被拖边线的当前屏幕坐标（left模式窗口x会补偿，右边固定；right模式x固定）
  const movingEdge = mode === 'right' ? st.x + nw - myIn : st.x + st.w - nw + myIn;
  for (const tg of stretchTargets(w, 'w')) {
    if (mode === 'right') { cands.push(tg.r, tg.l, tg.l - GAP); }   // 同线对齐右/左边线、留缝拼上左边线
    else { cands.push(tg.l, tg.r, tg.r + GAP); }
    // 等尺寸：换算成"我的边该到哪"参与同一轮取最近
    const oVisW = tg.r - tg.l;
    cands.push(mode === 'right' ? st.x + myIn + oVisW : st.x + st.w - myIn - oVisW);
  }
  const d = stickySnap(st, 'w', cands, movingEdge);
  if (d === null) return nw;
  if (!st._snapLogged) { st._snapLogged = true; try { ctx.dlog('[snap] 拉伸吸附生效 ' + mode + ' Δ=' + d.toFixed(1)); } catch {} }
  return Math.round(mode === 'right' ? nw + d : nw - d);
}
function snapStretchH(w, st, nh, mode) {
  const myIn = insetOf(w);
  const GAP = 1;
  const cands = [];
  const movingEdge = mode === 'bottom' ? st.y + nh - myIn : st.y + st.h - nh + myIn;
  for (const tg of stretchTargets(w, 'h')) {
    if (mode === 'bottom') { cands.push(tg.b, tg.t, tg.t - GAP); }
    else { cands.push(tg.t, tg.b, tg.b + GAP); }
    const oVisH = tg.b - tg.t;
    cands.push(mode === 'bottom' ? st.y + myIn + oVisH : st.y + st.h - myIn - oVisH);
  }
  const d = stickySnap(st, 'h', cands, movingEdge);
  if (d === null) return nh;
  return Math.round(mode === 'bottom' ? nh + d : nh - d);
}
ipcMain.on('grip-end', (e) => {
  clearInterval(gripTimer);
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed() && w._rz) {
    w._rz.start = null;
    w._authSize = w.getSize();   // 缩放引擎收尾＝新的权威尺寸
    if (w._saveSize) w._saveSize();
    // 堆牌前卡被拉伸/缩放：整堆跟着它走（被压卡借它的新缩放、宽对齐它、几何重排）——0906用户实测"下方卡牌不跟"
    const s = w._cardId && stackOf(w._cardId);
    if (s) delete s._liveOrder;   // 0907#3：拖动会话结束，清掉缓存的堆序
    if (s && deckOrder(s)[0] === w._cardId) { delete w._deckW0; deckFitToFront(s); }
  }
  enforceZOrder();   // 缩放结束=整理时刻：控制台回到卡牌之上、球压顶（用户裁定铁序 球>控制台>卡牌）
});
// 0907#8 机测探针：模拟"拉某条边"的等比计算结果，断言宽高比保持（不出现单边拉伸/弧度形变的那种怪）。
// 与grip-start循环同一套公式。返回proportional=前后宽高比误差<0.01。
ipcMain.handle('grip-probe', (_e, p) => {
  const w = p && cardWins[p.id];
  if (!w || w.isDestroyed() || !w._rz) return null;
  const bw = w._rz.baseW || 300, bh = w._rz.baseH || 200;
  const sw = bw * w._rz.zoom, sh = bh * w._rz.zoom;
  const dx = Number(p.dx) || 0, dy = Number(p.dy) || 0, mode = p.mode || 'corner';
  const ratioBefore = sw / sh;
  // 0907第三轮：角部=等比(内容随zoom)，四边=自由拉伸(只改宽或高，zoom不变)
  if (mode === 'corner') {
    let nz = (sw + dx) / sw;
    nz = Math.min(zoomMaxOf(w), Math.max(w._rz.minZ, w._rz.zoom * nz));
    const nw = bw * nz, nh = bh * nz;
    const ratioAfter = nw / nh;
    return { zoom: +nz.toFixed(4), w: Math.round(nw), h: Math.round(nh), dim: 'both', proportional: Math.abs(ratioBefore - ratioAfter) < 0.01 };
  }
  // 自由拉伸：只改一个维度
  const dim = (mode === 'right' || mode === 'left') ? 'w' : 'h';
  const nw = dim === 'w' ? (mode === 'left' ? sw - dx : sw + dx) : sw;
  const nh = dim === 'h' ? (mode === 'bottom' ? sh + dy : sh - dy) : sh;
  const nz = w._rz.zoom;
  return { zoom: +nz.toFixed(4), w: Math.round(nw), h: Math.round(nh), dim, single: true, proportional: false };
});

// ---------- 磁吸拖动：标题栏拖动由主进程采样驱动，窗口间/屏幕边缘自动吸附 ----------
const GLASS_INSET = 12;   // 玻璃卡片在窗口内的透明边距（CSS像素；实际可见边距=它×窗口zoom）
const SNAP = 14;          // 吸附阈值

// 窗口的真实可见边距：页面inset是CSS像素，会随等比缩放zoom一起缩放
function insetOf(w) {
  return GLASS_INSET * ((w._rz && w._rz.zoom) || 1);
}

function applySnap(win, x, y, exclude) {
  const b = win.getBounds();
  const myIn = insetOf(win);
  const vw = b.width - myIn * 2, vh = b.height - myIn * 2;
  const vx = x + myIn, vy = y + myIn;
  const targets = [];
  for (const o of BrowserWindow.getAllWindows()) {
    if (o === win || o === ballWin || o.isDestroyed() || !o.isVisible() || o._isViewer) continue;   // 球是大画布，不当吸附目标；看图层是全屏临时层
    if (exclude && exclude.has(o)) continue;   // 同组窗口不作为吸附目标
    const ob = o.getBounds();
    const oi = insetOf(o);
    targets.push({ l: ob.x + oi, t: ob.y + oi, r: ob.x + ob.width - oi, b: ob.y + ob.height - oi, container: false });
  }
  const wa = screen.getPrimaryDisplay().workArea;
  targets.push({ l: wa.x, t: wa.y, r: wa.x + wa.width, b: wa.y + wa.height, container: true });

  let bestX = null, bestY = null;
  const myL = vx, myR = vx + vw, myT = vy, myB = vy + vh;
  for (const tg of targets) {
    const vOverlap = myT < tg.b + SNAP && myB > tg.t - SNAP;
    const hOverlap = myL < tg.r + SNAP && myR > tg.l - SNAP;
    // 容器(屏幕)贴内侧；窗口贴外侧(拼接，留1px间隙防重叠)+同边对齐+中心线对齐
    const GAP = 1;  // 拼接间隙
    const dcx = (tg.l + tg.r) / 2 - (myL + vw / 2);   // 垂直中线对齐
    const dcy = (tg.t + tg.b) / 2 - (myT + vh / 2);   // 水平中线对齐
    const xs = tg.container ? [tg.l - myL, tg.r - myR, dcx] : [tg.r - myL + GAP, tg.l - myR - GAP, tg.l - myL, tg.r - myR, dcx];
    const ys = tg.container ? [tg.t - myT, tg.b - myB, dcy] : [tg.b - myT + GAP, tg.t - myB - GAP, tg.t - myT, tg.b - myB, dcy];
    if (vOverlap) for (const d of xs) if (Math.abs(d) < SNAP && (bestX === null || Math.abs(d) < Math.abs(bestX))) bestX = d;
    if (hOverlap) for (const d of ys) if (Math.abs(d) < SNAP && (bestY === null || Math.abs(d) < Math.abs(bestY))) bestY = d;
  }
  return [x + (bestX || 0), y + (bestY || 0)];
}

// 磁吸成组：边缘相贴的窗口视为一组，拖动其一整组联动
function visualRect(w) {
  const b = w.getBounds();
  const i = insetOf(w);
  return { l: b.x + i, t: b.y + i, r: b.x + b.width - i, b2: b.y + b.height - i };
}
function isAttached(a, b) {
  const A = visualRect(a), B = visualRect(b), T = 3;
  // 重叠区域宽高
  const overlapW = Math.max(0, Math.min(A.r, B.r) - Math.max(A.l, B.l));
  const overlapH = Math.max(0, Math.min(A.b2, B.b2) - Math.max(A.t, B.t));
  // 两窗口大面积重叠=堆叠，不算拼接；只有重叠很小（≤5px）才是"边缘拼接"
  if (overlapW > 5 && overlapH > 5) return false;
  const vOverlap = overlapH > 0;
  const hOverlap = overlapW > 0;
  const touchX = Math.abs(A.r - B.l) <= T || Math.abs(A.l - B.r) <= T;
  const touchY = Math.abs(A.b2 - B.t) <= T || Math.abs(A.t - B.b2) <= T;
  return (touchX && vOverlap) || (touchY && hOverlap);
}
function collectGroup(win) {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible() && w !== ballWin && !w._isViewer);
  const group = new Set([win]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of wins) {
      if (group.has(w)) continue;
      for (const g of group) {
        if (isAttached(w, g)) { group.add(w); grew = true; break; }
      }
    }
  }
  return group;
}

let dragTimer = null;
let dragActive = false;   // 拖动会话进行中（堆牌悬停抽牌据此让位）
let dragFuseSrc = null, dragFuseTgt = null;   // 融合预览：拖动中的候选（松手即融）
ipcMain.on('drag-start', (e, alone) => {
  if (!canLayout()) return;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  const c = screen.getCursorScreenPoint();
  const b = w.getBounds();
  dragActive = true;
  // 堆牌成员开拖：先掐掉悬停抽牌的小动画并复位（它算的是旧锚点，拖动中会把卡拽回原地）
  if (w._cardId && stackOf(w._cardId)) {
    const s0 = stackOf(w._cardId);
    if (deckAnim || s0._nudged) deckApply(s0);
  }
  // 右键拖堆牌成员=把它摘出堆单独拖走——但要等光标真动了才摘（下方dragTimer里做）：
  // 按下即摘会让"右键点一下空白"就把卡剥出堆，剥下来的卡与新前卡叠在同一槽位=越点越点不到（0906用户实测）
  const detachOnMove = !!(alone && w._cardId && stackOf(w._cardId));
  // 左键拖=整组联动；右键拖=只拖自己（从吸附组里拆出来）
  const group = alone ? new Set([w]) : collectGroup(w);
  // 左键拖到融合叠成员：把叠里隐藏的成员也带上一起走（整叠如一卡）
  if (!alone) {
    for (const g of [...group]) {
      const s = g._cardId && stackOf(g._cardId);
      if (s) for (const m of s.members) {
        const mw = cardWins[m];
        if (mw && !mw.isDestroyed()) group.add(mw);
      }
    }
  }
  const members = [...group].map((m) => {
    const mb = m.getBounds();
    // 权威尺寸随行：拖动全程按它压制，跨DPI屏时系统偷改的尺寸站不住脚
    const [aw, ah] = m._authSize || [mb.width, mb.height];
    return { w: m, x: mb.x, y: mb.y, aw, ah };
  });
  // 融合候选源：拖动单位=单卡，或整堆（以堆的前卡为源，落到别的卡上=两堆合并）
  // （压>60%有发光预告，误融概率低）
  const visDragged = members.filter((m) => m.w && !m.w.isDestroyed() && m.w.isVisible() && m.w._cardId);
  const oneDeck = visDragged.length > 1 && w._cardId && stackOf(w._cardId)
    && visDragged.every((m) => stackOf(m.w._cardId) === stackOf(w._cardId));
  dragFuseSrc = visDragged.length === 1 ? visDragged[0].w : (oneDeck ? cardWins[deckOrder(stackOf(w._cardId))[0]] : null);
  dragFuseTgt = null;
  const st = { cx: c.x, cy: c.y, x: b.x, y: b.y, group, members, moved: false };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (w.isDestroyed()) { clearInterval(dragTimer); return; }
    const p = screen.getCursorScreenPoint();
    // 光标没真动过（<3px）一律不碰窗口：否则"按一下标题栏"第一帧就被磁吸拽走十几px
    //（堆牌切牌=按下即松，曾因此每切一次整堆漂12px）
    if (!st.moved) {
      if (Math.abs(p.x - st.cx) + Math.abs(p.y - st.cy) < 3) return;
      st.moved = true;
      if (detachOnMove && stackOf(w._cardId)) {
        stackDetach(w._cardId);   // 出堆会还原原宽：随行的权威尺寸同步换掉
        const nb = w.getBounds();
        st.x = nb.x; st.y = nb.y;
        for (const m of st.members) if (m.w === w) { m.x = nb.x; m.y = nb.y; m.aw = nb.width; m.ah = nb.height; }
      }
    }
    const nx = st.x + (p.x - st.cx), ny = st.y + (p.y - st.cy);
    const [sx2, sy2] = applySnap(w, nx, ny, st.group);   // 只吸附组外目标
    const dx = Math.round(sx2) - st.x, dy = Math.round(sy2) - st.y;
    for (const m of st.members) {
      if (!m.w.isDestroyed()) deckSetBounds(m.w, { x: m.x + dx, y: m.y + dy, width: m.aw, height: m.ah });   // 堆牌被压卡不可缩放，裸setBounds会被拒
    }
    // 融合预览：压住另一卡>60%→双方持续发光示意"松手即融合"；离开→熄灭
    if (dragFuseSrc && !dragFuseSrc.isDestroyed()) {
      const tgt = findFuseTarget(dragFuseSrc);
      if (tgt !== dragFuseTgt) {
        if (dragFuseTgt && !dragFuseTgt.isDestroyed()) sendFx(dragFuseTgt, { mode: 'reset' });
        if (tgt) {
          sendFx(tgt, { mode: 'fusehint' });
          sendFx(dragFuseSrc, { mode: 'fusehint' });
        } else {
          sendFx(dragFuseSrc, { mode: 'reset' });
        }
        dragFuseTgt = tgt;
      }
    }
  }, 8);
  w._dragMembers = members;
  w._dragSt = st;
});
ipcMain.on('drag-end', (e) => {
  clearInterval(dragTimer);
  dragActive = false;
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  // 按下即松（没拖动）：位置/锚点/融合全部不动，只清会话
  const st0 = w._dragSt;
  w._dragSt = null;
  if (st0 && !st0.moved) {
    if (dragFuseSrc && !dragFuseSrc.isDestroyed()) sendFx(dragFuseSrc, { mode: 'reset' });
    dragFuseSrc = dragFuseTgt = null;
    w._dragMembers = null;
    return;
  }
  // 整组落位全部保存
  const members = w._dragMembers || [{ w }];
  for (const m of members) {
    if (m.w.isDestroyed()) continue;
    // DPI守卫收尾：跨屏落位后按权威尺寸再压一次+重申zoom（文字/尺寸棘轮双兜底）
    if (m.aw) {
      try { const [ex, ey] = m.w.getPosition(); deckSetBounds(m.w, { x: ex, y: ey, width: m.aw, height: m.ah }); } catch {}
    }
    reassertZoom(m.w);
    const [px, py] = m.w.getPosition();
    if (m.w === hubWin) config.hubPos = [px, py];
    else if (m.w._cardId) config.cards[m.w._cardId] = Object.assign(config.cards[m.w._cardId] || {}, { x: px, y: py, open: true });
  }
  // 融合落地（左右键一视同仁）：预览光熄灭，有候选目标即融合
  if (dragFuseSrc && !dragFuseSrc.isDestroyed()) sendFx(dragFuseSrc, { mode: 'reset' });
  if (dragFuseTgt && !dragFuseTgt.isDestroyed()) sendFx(dragFuseTgt, { mode: 'reset' });
  if (dragFuseSrc && dragFuseTgt && !dragFuseSrc.isDestroyed() && !dragFuseTgt.isDestroyed()
      && dragFuseSrc._cardId && dragFuseTgt._cardId) {
    stackFuse(dragFuseSrc._cardId, dragFuseTgt._cardId);
  } else if (w._cardId && stackOf(w._cardId)) {
    const s2 = stackOf(w._cardId);
    deckSyncAnchor(s2);   // 整堆拖动=锚点跟着前卡走
    deckApply(s2);        // 再按几何精确复位（吸附/舍入不许把堆拖散）
  }
  dragFuseSrc = dragFuseTgt = null;
  w._dragMembers = null;
  saveConfig();
  enforceZOrder();   // 拖动结束=整理时刻：铁序 球>控制台>卡牌 重新断言
});

// ---------- 主面板 ----------
function toggleHub(forceOpen) {
  if (hubWin && !hubWin.isDestroyed()) {
    // 若主面板正处于"收纳"状态（被挪到了球心藏起来），展开前先还原记忆位置
    if (gatherState) {
      const i = gatherState.items.findIndex((it) => it.id === '__hub');
      if (i >= 0) {
        hubWin.setPosition(gatherState.items[i].x, gatherState.items[i].y);
        hubWin.setOpacity(1);
        gatherState.items.splice(i, 1);
        if (!gatherState.items.length) { destroyGatherProxy(gatherState); gatherState = null; }
      }
    }
    if (forceOpen === true) { hubWin.show(); config.hubOpen = true; }
    else if (hubWin.isVisible()) { hubWin.hide(); config.hubOpen = false; }
    else { hubWin.show(); config.hubOpen = true; }
    saveConfig();
    enforceZOrder();
    return;
  }
  // 无记忆位置时默认出现在屏幕正中；有记忆位置也要夹进当前工作区(历史坐标可能在已消失的屏上)
  const wa = screen.getPrimaryDisplay().workArea;
  const [hw, hh] = config.hubSize || [HUB_W, HUB_H];
  const [rhx, rhy] = config.hubPos || [Math.round(wa.x + (wa.width - hw) / 2), Math.round(wa.y + (wa.height - hh) / 2)];
  const [hx, hy] = clampToWork(rhx, rhy, hw, hh);
  // resizable必须为true——Win上不可调尺寸的窗口连程序化setSize都会被拒绝
  hubWin = new BrowserWindow(glassWinOpts({ width: hw, height: hh, x: hx, y: hy, resizable: true, show: !bootDeferring }));
  bootTrack(hubWin);
  guardZoomKeys(hubWin);
  hubWin.loadFile(path.join(ctx.SRC, 'renderer', 'hub.html'));
  hubWin.setAlwaysOnTop(true, 'screen-saver');
  const hubZoom = Math.min(2.2, Math.max(0.45, config.hubZoom || 1));
  bindScale(hubWin, HUB_W, HUB_H, hubZoom, () => {
    const [w2, h2] = hubWin.getSize();
    config.hubSize = [w2, h2];
    config.hubZoom = hubWin._rz.zoom;
    saveConfig();
  });
  hubWin.on('moved', () => {
    const [x, y] = hubWin.getPosition();
    config.hubPos = [x, y];
    saveConfig();
  });
  config.hubOpen = true;
  saveConfig();
  hubWin.webContents.on('did-finish-load', () => enforceZOrder());
}

// ---------- 关卡回收：气泡收回的卡片闲置5分钟后销毁窗口，内存还给系统 ----------
// 每张卡=独立渲染进程(30-80MB)，隐藏≠释放；闲置够久就close()，重开时openCard按config恢复位置尺寸
// 例外不回收：当前武装模块(总控生成要向隐藏窗executeJavaScript收负载)/Forge(面板参数未落盘)/收纳中的窗口(要飞回来)
const reapTimers = {};
const REAP_MS = 5 * 60 * 1000;
function cancelReap(id) { clearTimeout(reapTimers[id]); delete reapTimers[id]; }
function scheduleReap(id) {
  cancelReap(id);
  reapTimers[id] = setTimeout(() => {
    delete reapTimers[id];
    const w = cardWins[id];
    if (!w || w.isDestroyed() || w.isVisible()) return;
    if (id === 'forge') return;
    if (ctx.getArmedId && ctx.getArmedId() === id) return;
    if (gatherState && gatherState.items.some((it) => it.id === id)) return;
    if (stackOf(id)) return;   // 融合叠成员（藏在叠下）不回收
    w.close();   // closed钩子会清cardWins/open标记/广播状态
  }, REAP_MS);
}

// ---------- 功能卡片 ----------
function openCard(id, atPos, byUser) {
  const def = modById[id];
  if (!def) return null;
  // 用户自己把它开起来了 → 撤销"他关过这张卡"的记录（companions 判断用），意愿以最新一次操作为准。
  // 只有 byUser 路径才算：伴生卡自动拉起、开机恢复、F词条注入都不算用户意愿。
  if (byUser && config.cardClosedByUser && config.cardClosedByUser[id]) {
    delete config.cardClosedByUser[id];
    saveConfig();
  }
  cancelReap(id);
  if (cardWins[id] && !cardWins[id].isDestroyed()) {
    // 收纳期间被程序化打开（F词条填Forge等）：先还原记忆位置并摘出收纳清单，再显示——
    // 否则窗口会在球心原地show出来（0906“收纳后只剩Forge留在球边”根因之一）
    if (!atPos) ungather(id);
    if (atPos) cardWins[id].setPosition(atPos[0], atPos[1]);
    // 开机编排期不亮相（伴生卡先被创建、随后主循环又openCard同一id会走到这——之前的"个别卡提前出来"）
    if (!bootDeferring) {
      const s0 = stackOf(id);
      if (s0) { stackShow(s0, id); }   // 堆成员：整堆亮出并切它到最前（裸moveTop会把它抬到堆序之外）
      else {
        cardWins[id].show(); cardWins[id].focus();
        raiseCard(cardWins[id]);
      }
    }
    return cardWins[id];
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const saved = config.cards[id];
  const cw = (saved && saved.w) || def.width;
  const ch = (saved && saved.h) || def.height;
  const rx = atPos ? atPos[0] : (saved ? saved.x : Math.round((sw - cw) / 2));
  const ry = atPos ? atPos[1] : (saved ? saved.y : Math.round((sh - ch) / 2));
  // 拖出跟手中(atPos)不夹取；从保存坐标恢复时夹进当前工作区（历史坐标可能在已消失的屏上）
  const [x, y] = atPos ? [rx | 0, ry | 0] : clampToWork(rx, ry, cw, ch);

  const win = new BrowserWindow(glassWinOpts({ width: cw, height: ch, x, y, resizable: true, show: !bootDeferring }));
  bootTrack(win);
  guardZoomKeys(win);
  win._cardId = id;
  // 占位模块共用stub.html，通过query传入身份
  win.loadFile(path.join(ctx.SRC, 'renderer', def.file), {
    query: { id: def.id, icon: def.icon, label: def.label },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // 「只浮在PS之上」模式且此刻正撤顶中（用户在浏览器里，程序化弹出的进度卡等）：新卡也不置顶，别盖到浏览器上
  try { if (ctx.cardsTopSuppressed && ctx.cardsTopSuppressed()) win.setAlwaysOnTop(false); } catch (e) {}
  const cardZoom = Math.min(2.2, Math.max(0.45, (saved && saved.zoom) || 1));
  bindScale(win, def.width, def.height, cardZoom, () => {
    const [w2, h2] = win.getSize();
    config.cards[id] = Object.assign(config.cards[id] || {}, { w: w2, h: h2, zoom: win._rz.zoom });
    saveConfig();
  });
  win.on('moved', () => {
    const [wx, wy] = win.getPosition();
    // ⚠只有"用户看得见时被移动"才算用户把它摆在了这、才算它开着（0917 多用户实报"甄选卡莫名跳出来、重启也有"）。
    // 原写法无条件写 open:true：关掉的卡只是 hide() 不销毁（还有5分钟回收倒计时），这期间
    // 开机夹取屏幕外坐标 / 显示器变化 / 快速布局应用 / 堆牌调整 都会程序化移动这个隐藏窗口 →
    // moved 钩子把 open 改写成 true 并落盘 → 用户毫不知情，下次启动 index.js 见 open=true 就 openCard() → 卡自己跳出来，
    // 且配置已被改脏，从此每次重启都犯。隐藏窗口的移动只记坐标，绝不动 open。
    const vis = !win.isDestroyed() && win.isVisible();
    config.cards[id] = Object.assign(config.cards[id] || {}, vis ? { x: wx, y: wy, open: true } : { x: wx, y: wy });
    saveConfig();
  });
  win.on('closed', () => {
    cancelReap(id);
    if (stackOf(id)) stackDetach(id);
    delete cardWins[id];
    if (config.cards[id]) { config.cards[id].open = false; saveConfig(); }
    broadcastOpenStates();
  });
  config.cards[id] = Object.assign(config.cards[id] || {}, { x, y, open: true });
  saveConfig();
  cardWins[id] = win;
  raiseCard(win);   // 新建的卡当下浮到控制台之上（开在控制台底下=开了看不见）
  win.webContents.on('did-finish-load', () => {
    broadcastOpenStates();
    // 堆牌状态补发：开机恢复堆时stack-state在页面就绪前就发了=丢（0906实锤：打光卡在堆里却标签露出、控件活着）
    const s0 = stackOf(id);
    if (s0) stackBroadcast(s0);
  });
  // 伴生卡片（如AI生图→提示词卡、提示词库→甄选）自动一起弹出。
  // ⚠0917 多用户实报"甄选卡莫名其妙跳出来、重启之后也有"——链条：
  //   开提示词库 → 伴生 openCard('fav') → fav 无窗口则新建并把 config.cards.fav.open 写成 true 落盘
  //   → 用户没主动开过它却出现在眼前；关掉它只改 open=false，可**下次启动** index.js 见 prompts.open 仍是 true
  //     就又 openCard('prompts') → 伴生又把它拉出来 → 又写 open:true。每次重启都犯，用户完全没法根治。
  // 修法：用户**主动关掉**过的伴生卡（记在 config.cardClosedByUser），不再被伴生机制自动拉出；
  //   他自己再点开一次（openCard 的 byUser 路径）就清掉这个记录，意愿以最新一次操作为准。
  const closedByUser = config.cardClosedByUser || {};
  (def.companions || []).forEach((cid) => {
    if (closedByUser[cid]) return;   // 用户关过它，别自作主张再弹
    if (!cardWins[cid] || cardWins[cid].isDestroyed()) openCard(cid);
  });
  return win;
}

// ---------- 气泡拖出主面板（跨窗口拖拽） ----------
// hub按住气泡拖动时：立即建卡片窗口跟随鼠标，松手落位
let dragTarget = null;
const DRAG_OFF_X = 70, DRAG_OFF_Y = 24;   // 鼠标抓住卡片头部的位置

ipcMain.on('bubble-drag-start', (_e, { id, sx, sy }) => {
  // 锁定=布局冻结：气泡拖出降级为普通打开（恢复记忆位置），与drag/grip入口门禁一致
  if (!canLayout()) { openCard(id, null, true); revealForUser('拖出(锁定降级) ' + id); return; }
  const win = openCard(id, [sx - DRAG_OFF_X, sy - DRAG_OFF_Y], true);   // 拖出=用户主动
  dragTarget = win || null;
  revealForUser('拖出气泡 ' + id);   // 拖出=用户主动，别生在浏览器底下
});
ipcMain.on('bubble-drag-move', (_e, { sx, sy }) => {
  if (dragTarget && !dragTarget.isDestroyed()) {
    // 跨屏DPI守卫：跟手全程锁权威尺寸（坑54，同磁吸拖动）
    const [aw, ah] = dragTarget._authSize || dragTarget.getSize();
    dragTarget.setBounds({ x: sx - DRAG_OFF_X, y: sy - DRAG_OFF_Y, width: aw, height: ah });
  }
});
ipcMain.on('bubble-drag-end', () => {
  if (dragTarget && !dragTarget.isDestroyed()) reassertZoom(dragTarget);
  dragTarget = null;
});

// ---------- IPC ----------
// 卡片开关状态：hub气泡点亮用
function openStates() {
  const st = {};
  for (const id in cardWins) {
    if (cardWins[id] && !cardWins[id].isDestroyed() && cardWins[id].isVisible()) st[id] = true;
  }
  // 融合叠：面亮=全员亮（藏在叠下的成员翻页可达，hub气泡应点亮）
  for (const s of stacks) {
    if (st[s.active]) for (const m of s.members) st[m] = true;
  }
  return st;
}
// 置顶失守自愈（0905实测坑61）：全屏尺寸的代理飞行窗销毁后，Windows重排置顶带
// 可能连坐剥掉其他窗的topmost——球+全部卡牌集体沉到PS底下。
// 修法：3秒验伤isAlwaysOnTop，任一失守=按铁序全员重申（卡牌→控制台→球，球收尾=最顶）
// hard=true：先摘再装置顶（连续失守时的升级手段——同态重申可能被Chromium当no-op吞掉，
// 拆装一次才真正重写WS_EX_TOPMOST）
function assertTopmost(tag, hard) {
  try {
    // ⚠重申必须用与创建同级的'screen-saver'带——0905晚实锤：普通setAlwaysOnTop(true)=floating低带，
    // PS全屏时被系统每3秒压下去→看门狗低带再救→再被压=827次死循环，面板永沉PS底（球在screen-saver安然）
    const re = (w) => {
      if (!w || w.isDestroyed()) return;
      if (hard) { try { w.setAlwaysOnTop(false); } catch (e) {} }
      w.setAlwaysOnTop(true, 'screen-saver');
    };
    // 「卡牌只浮在PS之上」模式主动撤下卡牌置顶时（fgwatch.js），全员重申跳过卡牌——否则与它打架；球/控制台照常
    const sup = !!(ctx.cardsTopSuppressed && ctx.cardsTopSuppressed());
    if (!sup) for (const id in cardWins) { try { re(cardWins[id]); } catch (e) {} }   // 单窗异常不连累后面的窗（铁律4）
    re(hubWin);
    re(ballWin);
    deckRestackAll();   // 逐窗重申会按遍历序洗z序：堆牌先按堆序排回
    enforceZOrder();
    if (tag) { try { ctx.dlog('[aot] 置顶重申(' + tag + ')' + (hard ? ' [硬]' : '') + (sup ? ' [卡牌撤顶中,仅球/控制台]' : '')); } catch (e) {} }
  } catch (e) {}
}
ctx.assertTopmost = assertTopmost;   // 供对话框/子进程收场后主动重申（坑61"案发现场无条件重申"模式）
// 系统位核验（0909 实锤）：快速切回 PS 后用"硬重申"（先 false 再 true）把 17 窗批量摘顶再装顶，Windows 里个别卡（gen/anti）
// 的 WS_EX_TOPMOST 位会留在 0（Chromium 账 isAlwaysOnTop 却说 true），卡沉到 PS 下面，要等 1s 看门狗（还只看账）才救回
// =用户看到的"卡掉一会儿又出现"。修法三层：①恢复置顶改**软重申**（false→true 本来就是真变化，不需要硬拆装；15 轮机测零丢失）；
// ②恢复后 60/250/700ms 按 Windows 真实位核验，缺的单独硬补；③看门狗也看真实位。真实位读法在 fgwatch（koffi）。
let verifyTimers = [];
function verifyCardsTopmost(tag) {
  if (!ctx.win32IsTopmost) return 0;
  if (ctx.cardsTopSuppressed && ctx.cardsTopSuppressed()) return 0;
  const lost = [];
  for (const id in cardWins) {
    const w = cardWins[id];
    if (!w || w.isDestroyed() || !w.isVisible()) continue;
    if (ctx.win32IsTopmost(w) !== false) continue;
    lost.push(id);
    try { w.setAlwaysOnTop(false); w.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {}
  }
  if (lost.length) { enforceZOrder(); try { ctx.dlog('[aot] 系统位核验补顶(' + tag + '): ' + lost.join(',')); } catch (e) {} }
  return lost.length;
}
function scheduleTopmostVerify(tag) {
  for (const t of verifyTimers) clearTimeout(t);
  verifyTimers = [60, 250, 700].map((ms) => setTimeout(() => verifyCardsTopmost(tag + '+' + ms + 'ms'), ms));
}
// 「卡牌只浮在PS之上」（0909）：fgwatch 裁决后调用——on=卡牌整体拉回置顶带并按铁序整理；off=撤掉卡牌置顶（球/控制台不动）
ctx.applyCardsTop = (on, reason) => {
  if (on) { assertTopmost('回到PS:' + (reason || ''), false); scheduleTopmostVerify('回到PS'); return; }   // ⚠软重申：硬拆装会让个别卡真实位留 0（见上）
  for (const t of verifyTimers) clearTimeout(t);
  verifyTimers = [];
  for (const id in cardWins) {
    const w = cardWins[id];
    try { if (w && !w.isDestroyed()) w.setAlwaysOnTop(false); } catch (e) {}
  }
};
// 置顶看门狗（1秒验伤）：失守即重申；连续失守=系统在反复压我们（PS全屏等）→升级为硬重申，
// 并把次数攒起来每分钟向用户日志报一次（Beta"面板沉到PS后面"要靠这条指纹定位，别再哑巴）
let aotStreak = 0, aotLostCount = 0, aotLastReport = 0;
setInterval(() => {
  try {
    if (!app.isReady()) return;
    const lost = [];
    // 账（isAlwaysOnTop）与 Windows 真实位（WS_EX_TOPMOST）任一说没在顶=失守（0909：账 true 位 0 的冤案就是"卡掉一会儿"）
    const chk = (w, name) => { try { if (w && !w.isDestroyed() && w.isVisible() && (!w.isAlwaysOnTop() || (ctx.win32IsTopmost && ctx.win32IsTopmost(w) === false))) lost.push(name); } catch (e) {} };
    chk(ballWin, '球'); chk(hubWin, '控制台');
    // 卡牌撤顶中（「只浮在PS之上」模式主动撤的）不算失守
    if (!(ctx.cardsTopSuppressed && ctx.cardsTopSuppressed())) for (const id in cardWins) chk(cardWins[id], id);
    if (lost.length) {
      aotStreak++; aotLostCount++;
      assertTopmost('失守:' + lost.join(','), aotStreak >= 2);
      const now = Date.now();
      if (now - aotLastReport > 60000) {
        aotLastReport = now;
        olog('📌 面板置顶被系统压掉 ' + aotLostCount + ' 次，已自动拉回（PS处于全屏模式？若仍沉底：右键小球→「拉回最前」）', 'err');
      }
    } else aotStreak = 0;
  } catch (e) {}
}, 1000);
// 手动逃生口（球右键菜单「拉回最前」）：无条件硬重申 + 堆序 + 铁序。
// 「只浮在PS之上」模式下=手动覆盖：先解除撤顶（fgwatchOverride）再重申，卡牌立刻回到 PS 之上，直到下一次前台变化
ipcMain.on('reassert-top', () => {
  try { if (ctx.fgwatchOverride) ctx.fgwatchOverride(); } catch (e) {}
  assertTopmost('手动拉回', true);
});

// 层级铁序（用户裁定）：小橙子(含右键菜单) > 控制台 > 各卡牌
// Win上alwaysOnTop同band内按最后置顶排序，每次窗口状态变化后重新断言
function enforceZOrder() {
  try {
    if (hubWin && !hubWin.isDestroyed() && hubWin.isVisible()) hubWin.moveTop();
    if (ballWin && !ballWin.isDestroyed()) ballWin.moveTop();
    if (ctx.viewerOnTop) ctx.viewerOnTop();   // 看图层开着时压过球（它是全屏临时层，关了就没了）
  } catch {}
}
// 开卡例外：用户主动打开/翻出的卡当下必须看得见——若它落在控制台底下会"开了没反应"
// （实测翻车：设置卡位置与控制台重叠，开卡即被铁序压没）。球永远压最顶。
function raiseCard(w) {
  try {
    if (w && !w.isDestroyed()) w.moveTop();
    if (ballWin && !ballWin.isDestroyed()) ballWin.moveTop();
    if (ctx.viewerOnTop) ctx.viewerOnTop();
  } catch {}
  // 挂靠模式下 moveTop 会把卡抬到 PS 浮动面板之上，立刻压回主窗正上方（不等 fgwatch 下一拍＝开卡不再闪一下面板）
  try { if (ctx.fgwatchLayerFix) ctx.fgwatchLayerFix('开卡/翻卡'); } catch (e) {}
}
// 用户主动开卡=必须看得见（0915用户实报："控制台里点模块，点击反馈正常但卡牌不出现，重启也没用"）
// 根因：「只浮在PS之上」模式下前台是浏览器/看课程等非PS程序时，卡牌整体被撤顶（挂靠模式则挂在PS主窗名下），
// 新开或show出来的卡就生在那个全屏窗口**底下**——气泡已点亮、config已记open，可用户什么也没看见；
// 重启没用是因为开机恢复照样把它开在底下。控制台/球是唯二不被撤顶的窗（所以点得到），这就是"有反馈没卡牌"。
// 修法：用户点气泡=明确要看这张卡，等同一次「拉回最前」（fgwatchOverride，点进别的程序自动解除）。
// 只在"确实被压着"时出手，PS在前台的常态一行不动；程序化弹卡（生图自动弹进度卡等）不走这里——
// 那时用户可能正在浏览器里，不该被抢到脸前（windows.js:1061 那条设计保留）。
function revealForUser(why) {
  try {
    // 判据用 cardsBuried（前台是别的程序）而不是 cardsTopSuppressed——挂靠模式下后者恒为 true 是常态，
    // 拿它当判据会让每次点气泡都空跑一次覆盖（无害但日志噪音、语义也不对）
    if (!(ctx.cardsBuried && ctx.cardsBuried())) return;
    if (!ctx.fgwatchOverride) return;
    ctx.fgwatchOverride();
    ctx.dlog('[reveal] 用户主动开卡，卡牌正被前台程序埋着→拉回最前 · ' + (why || ''));
  } catch (e) {}
}
// 卡真的露出来了才拉（收回分支不拉——那是用户要它消失）
function revealIfVisible(id, why) {
  const w = cardWins[id];
  if (w && !w.isDestroyed() && w.isVisible()) revealForUser(why + ' ' + id);
}
ctx.revealForUser = revealForUser;   // 托盘/F词条等直调 openCard 的用户路径也能用
function broadcastOpenStates() {
  broadcast('card-states', openStates());
  // 注意：这里不再统一enforceZOrder——开卡瞬间要允许新卡浮在控制台上（见raiseCard）；
  // 铁序在拖动结束/释放归位/控制台交互等时机重新断言
}
ipcMain.handle('get-card-states', () => openStates());

ipcMain.on('toggle-hub', () => { try { ctx.dlog('[ball] toggle-hub'); } catch {} toggleHub(); });
// 提示词库/甄选点击填入的来源提示：转发给所有窗口，提示词卡据此"带控件优先翻牌"（0904机制）
ipcMain.on('prompt-lib-fill', () => {
  try { ctx.dlog('[wake] 收到词条点击信号'); } catch (e) {}
  broadcast('prompt-lib-fill-hint', {});
  // 提示词卡已可见时置顶：压在别的卡底下时"点了没反应"的冤案（0905修）。
  // 自动唤醒（不在画面时自动弹出、生成后自动收回）已于0906按用户要求移除
  const w = cardWins['prompt-box'];
  if (w && !w.isDestroyed() && w.isVisible()) raiseCard(w);
});
ipcMain.on('open-hub', () => toggleHub(true));
// 程序化确保打开（不toggle）：生图弹进度卡等场景用
ipcMain.on('show-card', (_e, id) => {
  cancelReap(id);
  // 融合叠成员：程序化确保可见=翻到它（如生图自动弹进度卡）
  const st0 = stackOf(id);
  if (st0) { stackShow(st0, id); return; }
  const w = cardWins[id];
  ungather(id);   // 收纳期间程序化确保打开：还原记忆位置并摘出清单
  if (w && !w.isDestroyed()) { if (!w.isVisible()) w.showInactive(); raiseCard(w); }
  else openCard(id);
  broadcastOpenStates();
});

// 0919 进度卡/聊天等"点击填入提示词"专用：发起方发请求→主进程广播给所有窗口→提示词卡无条件覆盖
ipcMain.on('prompt-force-fill-request', (_e, txt) => {
  for (const w of Object.values(cardWins)) {
    if (w && !w.isDestroyed()) w.webContents.send('prompt-force-fill', txt);
  }
  if (hubWin && !hubWin.isDestroyed()) hubWin.webContents.send('prompt-force-fill', txt);
});


// 收起→重开跟随控制台（0904反馈#3）：收起时记下控制台位置，重开按控制台位移平移卡牌，
// 相对位置不散架；越屏兜底夹回工作区。只作用于气泡开关路径，布局恢复/拖出/收纳不受影响
function hubFollowPos(id) {
  const c = config.cards[id];
  if (!c || !Array.isArray(c.hubAt) || !Array.isArray(config.hubPos)) return null;
  const dx = ((config.hubPos[0] - c.hubAt[0]) | 0), dy = ((config.hubPos[1] - c.hubAt[1]) | 0);
  c.hubAt = null;
  if (!dx && !dy) return null;
  let nx = (c.x | 0) + dx, ny = (c.y | 0) + dy;
  try {
    const wa = screen.getDisplayMatching({ x: nx, y: ny, width: (c.w | 0) || 300, height: (c.h | 0) || 200 }).workArea;
    nx = Math.min(Math.max(nx, wa.x - 40), wa.x + wa.width - 80);
    ny = Math.min(Math.max(ny, wa.y - 10), wa.y + wa.height - 60);
  } catch (e) {}
  c.x = nx; c.y = ny;
  return [nx, ny];
}

// 点亮式开关：开着→收回；关着→展开
ipcMain.on('open-card', (_e, id) => {
  try { ctx.dlog('[hub] open-card ' + id); } catch {}
  enforceZOrder();   // 用户正在点控制台=整理时刻：先把控制台压回全部卡牌之上，只让接下来要开的那张按"开卡例外"浮上来
  // 融合叠成员：整叠开关（开=翻到它并亮整叠，关=整叠收起）
  if (stackOf(id) && stackToggle(id)) { revealIfVisible(id, '点气泡·堆牌'); return; }
  const w = cardWins[id];
  // 收纳期间单独点开：还原记忆位置并从收纳清单摘除
  if (w && !w.isDestroyed() && ungather(id)) {
    w.show();
    revealForUser('点气泡·收纳中取出 ' + id);
    broadcastOpenStates();
    return;
  }
  if (w && !w.isDestroyed() && w.isVisible()) {
    w.hide();
    scheduleReap(id);   // 收回的卡进入闲置回收倒计时
    if (config.cards[id]) {
      config.cards[id].open = false;
      // 跟随控制台（0904#3）：收起时刻的控制台位置=重开时的相对参照
      config.cards[id].hubAt = Array.isArray(config.hubPos) ? config.hubPos.slice() : null;
      // 用户主动点气泡收起=他不想要这张卡：同"点X关卡"，记下来别让伴生机制下次开机又拉出来（0917 甄选卡）
      config.cardClosedByUser = Object.assign({}, config.cardClosedByUser || {}, { [id]: true });
      saveConfig();
    }
  } else if (w && !w.isDestroyed()) {
    cancelReap(id);
    const fp = hubFollowPos(id);
    if (fp) { try { w.setPosition(fp[0], fp[1]); } catch (e) {} saveConfig(); }
    w.show();
    raiseCard(w);
    revealForUser('点气泡·show ' + id);
    if (config.cards[id]) { config.cards[id].open = true; saveConfig(); }
    // 用户自己开起来了 → 撤销"他关过这张卡"的记录（伴生机制据此判断，0917）
    if (config.cardClosedByUser && config.cardClosedByUser[id]) { delete config.cardClosedByUser[id]; saveConfig(); }
  } else {
    hubFollowPos(id);   // 窗口已被回收：平移量直接写进config坐标，openCard按它落位
    openCard(id, null, true);   // byUser=true：用户点气泡开的
    revealForUser('点气泡·新建 ' + id);   // 新窗口 show:true 建完即可见，此刻拉得到
  }
  broadcastOpenStates();
});
ipcMain.on('close-self', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  if (w === hubWin) { w.hide(); config.hubOpen = false; saveConfig(); }
  else {
    // 用户主动点 X 关卡（程序化 close 不走这条，所以这里只记"用户意愿"）：记下来，
    // 免得它作为伴生卡在下次开机又被自动拉出来（0917 甄选卡反复自己跳出的根治点）
    const cid = w._cardId;
    if (cid) { config.cardClosedByUser = Object.assign({}, config.cardClosedByUser || {}, { [cid]: true }); saveConfig(); }
    w.close();
  }
});
// 球拖动=主进程光标采样跟随（渲染端增量在双屏DPI不一致时坐标断层=乱跳,坑7同族）；
// 夹取按「光标所在屏」的工作区——球才能跟着光标跨到副屏
let ballDragTimer = null, ballDragOff = null;
function ballFollowTick() {
  if (!ballWin || ballWin.isDestroyed() || !ballDragOff) { clearInterval(ballDragTimer); ballDragTimer = null; return; }
  const p = screen.getCursorScreenPoint();
  let cx = p.x + ballDragOff.dx, cy = p.y + ballDragOff.dy;
  try {
    const wa = screen.getDisplayNearestPoint(p).workArea;
    cx = Math.min(Math.max(cx, wa.x + 20), wa.x + wa.width - 20);
    cy = Math.min(Math.max(cy, wa.y + 20), wa.y + wa.height - 20);
  } catch {}
  // setBounds带常驻画布尺寸：跨DPI屏拖动时系统撑大的窗口16ms内被踩回（坑54尺寸棘轮）
  ballWin.setBounds({ x: (cx - BALL_WW / 2) | 0, y: (cy - BALL_WH / 2) | 0, width: BALL_WW, height: BALL_WH });
  config.ballPos = [(cx - BALL_WIN / 2) | 0, (cy - BALL_WIN / 2) | 0];   // 存96口径，兼容老配置
}
ipcMain.on('ball-drag-start', () => {
  if (!canMoveBall()) return;   // 菜单展开/开机动效中球不动
  const c0 = screen.getCursorScreenPoint();
  const b = ballWin.getBounds();
  ballDragOff = { dx: b.x + b.width / 2 - c0.x, dy: b.y + b.height / 2 - c0.y };   // 抓取点偏移
  clearInterval(ballDragTimer);
  ballDragTimer = setInterval(ballFollowTick, 8);
});
ipcMain.on('ball-drag-end', () => {
  clearInterval(ballDragTimer);
  ballDragTimer = null; ballDragOff = null;
  // DPI守卫收尾：按常驻画布尺寸压回+重申zoom=1（球窗跨屏后的尺寸/文字棘轮兜底）
  if (ballWin && !ballWin.isDestroyed()) {
    try {
      const [bx, by] = ballWin.getPosition();
      ballWin.setBounds({ x: bx, y: by, width: BALL_WW, height: BALL_WH });
      ballWin.webContents.setZoomFactor(1);
    } catch {}
  }
  saveConfig();
});

// ---------- 球全局快捷菜单：右键小球展开（Beta反馈：小橙子=Global Launcher） ----------
// 实现方式=原窗口就地扩展(96→330×400)并保持球心屏幕坐标不变，页面在球旁画菜单；
// 展开期间穿透判定走pass-rects(菜单项+球)，光标远离自动收起
// 菜单开合完全不碰窗口bounds（球窗常驻大画布）：纯CSS滑入滑出，零resize=零残影零卡顿
function openBallMenu(open) {
  if (!canBallMenu()) return;   // 开机动效期间先不响应
  if (!!open === !!ballWin._menuOpen) return;
  if (open) {
    const b = ballWin.getBounds();
    const bcx = b.x + b.width / 2, bcy = b.y + b.height / 2;
    let wa;
    try { wa = screen.getDisplayMatching(b).workArea; } catch { return; }
    const side = bcx > wa.x + wa.width / 2 ? 'left' : 'right';   // 菜单朝屏幕中心一侧滑出
    const below = bcy + 300 <= wa.y + wa.height;                 // 下方放得下就向下排
    ballWin._menuOpen = true;
    menuAwayTicks = 0;
    enforceZOrder();   // 菜单展开时球必须压在一切之上
    ballWin.webContents.send('ball-menu-state', { open: true, side, below });
  } else {
    ballWin._menuOpen = false;
    ballWin._passRects = [];   // 恢复球的圆形判定，清掉菜单热区
    ballWin.webContents.send('ball-menu-state', { open: false });
  }
}
ipcMain.on('ball-menu', (_e, p) => openBallMenu(p && p.open));

// ---------- 收纳/释放：右键悬浮球，全部气泡飞向球心收起 / 飞回记忆位置 ----------
// 动画=主进程16ms tween（easeInOutCubic + 透明度渐变），落位瞬间广播全体发光
let gatherState = null;   // null=展开中 / {items:[{id,win,x,y}]}=已收纳（记录原位）
let gatherAnim = null;
let gatherPhase = null;   // 收纳前奏（发光变大）计时器
let releaseDone = null;   // 释放落定后的一次性回调（布局应用用它重建堆牌）；两条释放路径收尾处各调一次 fireReleaseDone
function fireReleaseDone() {
  const f = releaseDone; releaseDone = null;
  if (!f) return;
  try { f(); } catch (e) { try { ctx.dlog('[release] 收尾回调异常: ' + (e && e.message)); } catch (e2) {} }
}

const easeInQuart = (t) => t * t * t * t;
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
// 丝滑打磨（0905）：吸入改三次方加速（四次方末段冲刺跳变大），落位改五次方缓出（收尾极柔）
const easeInCubic = (t) => t * t * t;
const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);

// 快速直线归位（减速落位）
function animateFly(moves, dur, done) {
  clearInterval(gatherAnim);
  const list = moves.filter((m) =>
    m.win && !m.win.isDestroyed()
    && Number.isFinite(m.x0) && Number.isFinite(m.y0)
    && Number.isFinite(m.x1) && Number.isFinite(m.y1));
  if (!list.length) { if (done) done(); return; }
  const t0 = Date.now();
  let fc = 0;
  gatherAnim = setInterval(() => {
    let t = (Date.now() - t0) / dur;
    if (t > 1) t = 1;
    fc++;
    const k = easeOutQuint(t);
    for (const m of list) {
      if (m.win.isDestroyed()) continue;
      try {
        m.win.setPosition(Math.round(m.x0 + (m.x1 - m.x0) * k) | 0, Math.round(m.y0 + (m.y1 - m.y0) * k) | 0);
        // 透明度隔帧更新（0905丝滑）：分层窗改alpha是额外合成开销，带宽让给位置
        if ((fc & 1) === 0 || t >= 1) m.win.setOpacity(Math.min(1, 0.06 + 0.94 * Math.min(1, t * 1.8)));
      } catch {}
    }
    if (t >= 1) {
      clearInterval(gatherAnim);
      gatherAnim = null;
      if (done) done();
    }
  }, 8);
}

// 螺旋吸入：绕球心极坐标收缩，半径→0同时角度顺时针扫过，加速缓动
function animateSpiral(moves, dur, done) {
  clearInterval(gatherAnim);
  const list = moves.filter((m) =>
    m.win && !m.win.isDestroyed() && Number.isFinite(m.r0) && Number.isFinite(m.th0));
  if (!list.length) { if (done) done(); return; }
  const t0 = Date.now();
  let fc = 0;
  gatherAnim = setInterval(() => {
    let t = (Date.now() - t0) / dur;
    if (t > 1) t = 1;
    fc++;
    const k = easeInCubic(t);
    for (const m of list) {
      if (m.win.isDestroyed()) continue;
      try {
        const r = m.r0 * (1 - k);
        const th = m.th0 + k * 1.9;   // 顺时针扫≈110°
        m.win.setPosition(
          Math.round(m.bx + r * Math.cos(th) - m.hw) | 0,
          Math.round(m.by + r * Math.sin(th) - m.hh) | 0);
        if ((fc & 1) === 0 || t >= 1) m.win.setOpacity(Math.max(0.05, 1 - 0.95 * k));
      } catch {}
    }
    if (t >= 1) {
      clearInterval(gatherAnim);
      gatherAnim = null;
      if (done) done();
    }
  }, 8);
}

// 幽灵扫雷（坑59）：收纳/释放动画把窗口压到0.05~0.06透明度，中途被打断（强杀/异常）就留下
// "看不见但吃点击"的隐形窗——大片空白点不到其他软件的元凶。动画收尾+收纳入口都扫一遍：
// 可见窗口透明度必须=1，幂等，扫到了就落日志留指纹
function sweepGhosts(tag) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed() && w.isVisible() && w.getOpacity() < 0.99) {
        ctx.dlog('[ghost] ' + (tag || '') + ' 扫到隐形窗 opacity=' + w.getOpacity().toFixed(2) + ' 已恢复');
        w.setOpacity(1);
      }
    } catch {}
  }
}
// ---------- 释放飞行代理层（0905丝滑第4层） ----------
// 收纳时趁卡可见抓快照+预热每块屏一个全屏透明代理窗；释放时真窗预落位藏着，
// 代理页用rAF+GPU飞快照（vsync+亚像素），收尾真窗瞬间现身。快照alpha验伤不合格自动回退。
function makeFlyOverlay(disp) {
  const w = new BrowserWindow(glassWinOpts({
    x: disp.bounds.x, y: disp.bounds.y, width: disp.bounds.width, height: disp.bounds.height,
    show: false,
  }));
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setIgnoreMouseEvents(true);
  w._display = disp;
  w._ready = false;
  w.webContents.once('did-finish-load', () => { w._ready = true; });
  w.loadFile(path.join(ctx.SRC, 'renderer', 'flyover.html'));
  return w;
}
function destroyGatherProxy(gs) {
  if (!gs || !Array.isArray(gs.overlays)) return;
  for (const o of gs.overlays) { try { if (o && !o.isDestroyed()) o.destroy(); } catch {} }
  gs.overlays = [];
}
// 代理页可能还在加载（快照通常比它先回来）：没ready就挂到did-finish-load再发
function overlaySend(o, channel, payload) {
  try {
    if (!o || o.isDestroyed()) return;
    if (o._ready) o.webContents.send(channel, payload);
    else o.webContents.once('did-finish-load', () => { try { if (!o.isDestroyed()) o.webContents.send(channel, payload); } catch (e) {} });
  } catch (e) {}
}

// 把一张卡从收纳清单摘出并还原记忆位置（open-card/show-card/openCard三条"单独打开"路径共用）；
// 清单空了顺手销毁代理层。返回是否真的摘了
function ungather(id) {
  if (!gatherState) return false;
  const i = gatherState.items.findIndex((it) => it.id === id);
  if (i < 0) return false;
  const it = gatherState.items[i];
  try { if (it.win && !it.win.isDestroyed() && Number.isFinite(it.x) && Number.isFinite(it.y)) it.win.setPosition(it.x | 0, it.y | 0); } catch (e) {}
  gatherState.items.splice(i, 1);
  if (!gatherState.items.length) { destroyGatherProxy(gatherState); gatherState = null; }
  return true;
}

const sendFx = (w, payload) => { try { if (w && !w.isDestroyed()) w.webContents.send('gather-fx', payload); } catch {} };
const ballFx = (mode) => { try { if (ballWin && !ballWin.isDestroyed()) ballWin.webContents.send('ball-fx', { mode }); } catch {} };

let lastGatherAt = 0;   // 0907#2 连点掉帧：记录上次收纳时刻，快速反复收纳/释放时跳过快照代理层
function gatherAll(after) {
  if (gatherAnim || gatherPhase) return;   // 动画中防抖
  const b = ballWin.getBounds();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const wins = [];
  if (hubWin && !hubWin.isDestroyed() && hubWin.isVisible()) wins.push({ id: '__hub', win: hubWin });
  for (const id in cardWins) {
    const w = cardWins[id];
    if (w && !w.isDestroyed() && w.isVisible()) wins.push({ id, win: w });
  }
  if (!wins.length) return;
  // 0907#2 折中：距上次收纳<6s内的重复触发，跳过快照+代理层（capturePage×17+建全屏透明窗=掉帧大头），
  // 直接走真窗动画。前几次仍完整走丝滑代理飞行；连点之后以稳定为先。
  const now = Date.now();
  const quick = (now - lastGatherAt) < 6000;
  lastGatherAt = now;
  const items = [], moves = [];
  for (const { id, win } of wins) {
    const wb = win.getBounds();
    items.push({ id, win, x: wb.x, y: wb.y });
    const vx = wb.x + wb.width / 2 - cx, vy = wb.y + wb.height / 2 - cy;
    moves.push({
      win, bx: cx, by: cy, hw: wb.width / 2, hh: wb.height / 2,
      r0: Math.hypot(vx, vy), th0: Math.atan2(vy, vx),
    });
  }
  // 0915泄漏修（实机探针抓到5个2560全屏幽灵窗=GPU数百MB）：部分卡还收着时再次收纳，
  // 旧gatherState被整个盖掉——旧代理窗永远销毁不了，旧items的记忆位置也一并丢失（那些卡从此飞不回原位）。
  // 修法：先销毁旧代理层；旧单里这次没参战的卡（仍藏着）原样并入新单，释放时照旧飞回。
  if (gatherState) {
    destroyGatherProxy(gatherState);
    for (const old of gatherState.items) {
      // 只留身份和记忆位置：旧快照(snapOk/idx)指向已销毁的旧代理画布，带过去=释放时代理层引用空画布
      if (!items.some((n) => n.id === old.id)) items.push({ id: old.id, win: old.win, x: old.x, y: old.y });
    }
  }
  gatherState = { items };
  // 快照采集+代理层预热（0905丝滑第4层）：趁卡还可见抓画面，释放时走GPU单表面飞行
  const gs = gatherState;
  gs.proxyOk = false;
  gs.notQuick = !quick;   // releaseAll据此决定是否走代理飞行
  gs.overlays = [];
  try {
    const dispSeen = new Set();
    const addDisp = (bounds) => {
      try {
        const d = screen.getDisplayMatching(bounds);
        if (!dispSeen.has(d.id)) { dispSeen.add(d.id); gs.overlays.push(makeFlyOverlay(d)); }
      } catch (e) {}
    };
    addDisp(ballWin.getBounds());
    for (const it of items) addDisp({ x: it.x | 0, y: it.y | 0, width: 200, height: 150 });
  } catch (e) {}
  // 0906丝滑：快照不再在主进程压PNG（toDataURL=每张30-50ms同步编码×17张=吸入动画期间主线程堵400-700ms，
  // 就是"收纳卡顿"的元凶）。改成toBitmap原始BGRA(memcpy级)逐张丢给代理页预热成canvas，
  // 释放时只发坐标——起飞零等待。位图发完主进程即释放引用
  const t0 = Date.now();
  if (quick) {
    // 0907#2：连点快路径——跳过截图+代理预热，直接走真窗动画（锚定稳定优先）
    try { ctx.dlog('[proxy] 快速反复收纳，跳过代理层(' + wins.length + '张)'); } catch (e2) {}
    gs.proxyOk = false;
  } else {
  Promise.all(items.map(async (it, i) => {
    try {
      const img = await it.win.webContents.capturePage();
      const sz = it.win.getSize();
      const isz = img.getSize();
      it.bmp = img.toBitmap();
      it.bw = isz.width; it.bh = isz.height;
      it.sw = sz[0]; it.sh = sz[1];
      it.idx = i;
    } catch (e) {}
  })).then(() => {
    try {
      const first = items.find((x) => x.bmp);
      if (first) {
        const a = first.bmp.length >= 4 ? first.bmp[3] : 255;
        gs.proxyOk = a < 250;   // 角像素在玻璃外透明区：alpha没保住=黑底快照，回退真窗动画
        try { ctx.dlog('[proxy] 快照x' + items.filter((x) => x.bmp).length + ' 角alpha=' + a + ' 代理可用=' + gs.proxyOk + ' 耗时' + (Date.now() - t0) + 'ms'); } catch (e2) {}
      }
      if (gs.proxyOk) {
        for (const it of items) {
          if (!it.bmp) continue;
          const payload = { i: it.idx, w: it.sw, h: it.sh, bw: it.bw, bh: it.bh, bmp: it.bmp };
          for (const o of gs.overlays) overlaySend(o, 'fly-prep', payload);
          it.snapOk = true;
          it.bmp = null;
        }
      }
    } catch (e) {}
  });
  }   // 0907#2: !quick 分支闭合（连点时跳过整段快照采集）
  // 第一幕：全体发光+变大（前奏；0906从190→100ms：过渡照跑，只是不等它演完就开吸——响应更跟手）
  for (const m of moves) sendFx(m.win, { mode: 'pregather' });
  // 第二幕：快速螺旋卷入球心
  gatherPhase = setTimeout(() => {
    gatherPhase = null;
    ballFx('inhale');
    const DUR = 340;   // 0905丝滑：三次方缓动+稍长时长=帧间位移更均匀
    for (const m of moves) sendFx(m.win, { mode: 'gather', dur: DUR });
    animateSpiral(moves, DUR, () => {
      for (const { win } of wins) {
        if (!win.isDestroyed()) { win.hide(); win.setOpacity(1); sendFx(win, { mode: 'reset' }); }
      }
      broadcastOpenStates();
      if (after) after();   // 布局切换：收拢完成后接管
    });
  }, 100);
}

// 释放：全体从球心快速归位 → 落定后齐闪一次
// ⚠归位目标必须逐一Number.isFinite校验：脏坐标会让个别卡飞不回去（"forge不复位"级bug温床）
function releaseAll() {
  if (gatherAnim || gatherPhase || !gatherState) return;
  const b = ballWin.getBounds();
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const gs = gatherState;
  const items = gs.items;
  gatherState = null;
  const moves = [];
  for (const it of items) {
    if (!it.win || it.win.isDestroyed()) continue;
    if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) {
      // 目标坐标是脏的：不参与飞行，直接显示在当前位置（总比消失/飞错强）
      try { if (!it.win.isVisible()) it.win.showInactive(); it.win.setOpacity(1); } catch {}
      continue;
    }
    const wb = it.win.getBounds();
    moves.push({
      win: it.win,
      x0: Math.round(cx - wb.width / 2), y0: Math.round(cy - wb.height / 2),
      x1: it.x, y1: it.y,
      idx: it.idx, snapOk: !!it.snapOk,
    });
  }
  ballFx('exhale');
  // ---- 快照代理飞行（0905丝滑第4层）：vsync+亚像素+GPU，真窗预落位收尾瞬间现身 ----
  const useProxy = gs.proxyOk && Array.isArray(gs.overlays) && gs.overlays.length
    && gs.overlays.every((o) => o && !o.isDestroyed() && o._ready)
    && moves.length && moves.every((m) => m.snapOk);
  if (useProxy) {
    try { ctx.dlog('[proxy] 代理飞行 ' + moves.length + '张 · ' + gs.overlays.length + '屏'); } catch (e) {}
    const DUR = 320;
    // 0906丝滑：先起飞再安置——代理页拿到的只是坐标（位图收纳时已预热成canvas），
    // 收到即rAF开画；飞行在它自己的渲染进程里，下面主进程安置17张真窗的百来毫秒完全不影响它
    for (const o of gs.overlays) {
      try {
        const db = o._display.bounds;
        o.showInactive();
        o.moveTop();
        o.webContents.send('fly-data', {
          dur: DUR,
          items: moves.map((m) => ({
            i: m.idx,
            x0: m.x0 - db.x, y0: m.y0 - db.y,
            x1: (m.x1 | 0) - db.x, y1: (m.y1 | 0) - db.y,
          })),
        });
      } catch (e) {}
    }
    // 收尾定时器在安置循环之前挂：从起飞算起DUR+30ms准点交接，不被下面安置真窗的耗时往后推
    gatherPhase = setTimeout(() => {
      gatherPhase = null;
      // 原子交接（0905闪烁修）：真窗opacity 0→1与撤幻影同一同步块=同一合成帧内完成，
      // 无重叠（双重玻璃变深）也无空档（先撤后现的空白帧）
      for (const m of moves) { try { if (!m.win.isDestroyed()) m.win.setOpacity(1); } catch (e) {} }
      destroyGatherProxy(gs);
      sweepGhosts('释放收尾');
      deckRestackAll();   // 堆牌z序：释放落位后前卡必须回到堆顶
      broadcast('glow-all', {});
      broadcastOpenStates();
      assertTopmost('释放代理收尾');   // 代理窗销毁=置顶连坐的案发时刻，无条件全员重申（坑61）
      fireReleaseDone();
    }, DUR + 30);
    for (const m of moves) {
      try {
        sendFx(m.win, { mode: 'reset' });
        const [aw, ah] = m.win._authSize || [0, 0];
        if (aw) deckSetBounds(m.win, { x: m.x1 | 0, y: m.y1 | 0, width: aw, height: ah });
        else m.win.setPosition(m.x1 | 0, m.y1 | 0);
        reassertZoom(m.win);
        // 透明度0现身（0905闪烁修）：飞行期真窗就位且保持热渲染——藏着的窗被合成器节流，
        // 收尾才show会补画一帧=闪；opacity 0→1是原子翻转，且不与幻影叠出双重玻璃
        m.win.setOpacity(0);
        m.win.showInactive();
      } catch (e) {}
    }
    return;
  }
  // 回退路径：真窗动画（快照不合格/代理层未就绪/开机绽放）
  destroyGatherProxy(gs);
  for (const m of moves) {
    try {
      sendFx(m.win, { mode: 'reset' });   // 内容复位到正常尺寸
      m.win.setPosition(m.x0 | 0, m.y0 | 0);
      m.win.setOpacity(0.06);
      m.win.showInactive();   // 不抢焦点
    } catch {}
  }
  animateFly(moves, 320, () => {   // 0905丝滑：五次方缓出+稍长时长，落位极柔不急停
    for (const m of moves) {
      if (m.win.isDestroyed()) continue;
      // 先解除隐身再摆位置：后续任何一步出错都绝不留下吃点击的幽灵（坑59）
      try { m.win.setOpacity(1); } catch {}
      try {
        // 终点落位带权威尺寸+重申zoom：球在副屏时飞行跨DPI边界，同坑54
        const [aw, ah] = m.win._authSize || [0, 0];
        if (aw) deckSetBounds(m.win, { x: m.x1 | 0, y: m.y1 | 0, width: aw, height: ah });
        else m.win.setPosition(m.x1 | 0, m.y1 | 0);
        reassertZoom(m.win);
      } catch {}
    }
    sweepGhosts('释放收尾');
    deckRestackAll();   // 堆牌z序先排好，再让控制台/球按铁序压顶
    broadcast('glow-all', {});   // 归位完成，全体闪烁一次
    broadcastOpenStates();
    enforceZOrder();   // 释放归位是"整理"时刻：铁序重新断言（控制台回到卡牌之上）
    fireReleaseDone();
  });
}

function ballGatherToggle() {
  if (!ballWin || ballWin.isDestroyed()) return;
  if (gatherAnim || gatherPhase) return;   // 动画中防抖
  if (bootDeferring) return;   // 开机编排未收场：卡还藏着，此时收纳会记下错误原位
  sweepGhosts('收纳入口');   // 上一轮动画若被打断，先治好隐形窗再开新一轮（坑59）
  if (gatherState) releaseAll();
  else gatherAll();
}
ipcMain.on('ball-gather', () => {
  try { ctx.dlog('[ball] ball-gather'); } catch {}
  ballGatherToggle();
});
ctx.ballGatherToggle = ballGatherToggle;   // 托盘菜单「收纳/释放」复用球左键同一入口
ctx.isGathered = () => !!gatherState;

// ---------- 卡牌堆叠（0906堆牌版，取代"只显当前页+箭头翻页"的假融合） ----------
// 形态：N张卡全部可见，最前（当前）一张完整，其后每张往上错开一条标题条（DECK_STRIP CSS px×各卡自身zoom），
//      像一叠错开的扑克牌；被压卡露出的标题条=它的身份牌+操作面（悬停抽出发光/点击切牌/左拖整叠走/右拖抽出）。
// 几何：宽度统一到堆里最宽的可见宽（只放宽不缩窄），高度各自；z序=后→前逐个moveTop。
// 融合手势不变=左键拖单卡(或单叠)砸到另一张卡上重叠>60%松手；拆出=右键拖标题条摘走。
// 各成员保持独立窗口/进程/武装/负载——武装机制零改动。
const DECK_STRIP = 24;     // 被压卡默认露出的条高（CSS px，随缩放）——紧凑叠放（0906用户两轮裁定：48太宽16太窄，24正好）
const DECK_STRIP_FULL = 48;// 悬停抽出后露出的完整标题条高（logo+名字全可读）
const DECK_NUDGE = DECK_STRIP_FULL - DECK_STRIP;   // 悬停抽出位移=补足到完整标题条（随被压卡自身zoom缩放，见deck-hover）
// 露出条的DIP下限（0908用户实测：三张卡借前卡0.718缩放，每张后卡只露24×0.718≈17px，第三张再被前两张
// 透明边距一叠=完全没地方点，"堆里有一张显示不出来"）。露出量随缩放缩但绝不低于40 DIP，小缩放堆也能点到每一张。
const DECK_STRIP_MIN = 40;
const deckStripGap = (z) => Math.max(DECK_STRIP_MIN, DECK_STRIP * z);   // 第k张比前一张高出多少（DIP）
const DECK_CUT_MS = 150;  // 切牌时长：老千手感=快、干脆、不回弹
let stackSeq = 0;
let stacks = [];   // {id, members:[cardId](加入序，标签用), order:[cardId](前→后), active:cardId(=order[0])}
let deckAnim = null;
function stackOf(id) { return stacks.find((s) => s.members.includes(id)) || null; }
function deckOrder(s) {
  if (!Array.isArray(s.order) || s.order.length !== s.members.length || s.order.some((m) => !s.members.includes(m))) {
    s.order = [s.active].concat(s.members.filter((m) => m !== s.active));
  }
  s.active = s.order[0];
  return s.order;
}
// 堆牌快照（config 落盘与布局快照共用一种形态）
function stackSnapshot() {
  return stacks.map((s) => ({
    members: s.members.slice(),
    order: deckOrder(s).slice(),
    active: s.active,
    anchor: s.anchor ? { vx: s.anchor.vx, vy: s.anchor.vy } : null,
    visW: Number.isFinite(s.visW) ? s.visW : undefined,   // 宽账随堆落盘（0908）：重启后被压卡宽是按借来缩放存的，不能再从现宽反推
    hidden: !(cardWins[s.active] && !cardWins[s.active].isDestroyed() && cardWins[s.active].isVisible()),
  }));
}
function stackSave() {
  config.stacks = stackSnapshot();
  saveConfig();
}
function stackBroadcast(s) {
  if (!s) return;
  const order = deckOrder(s);
  for (const mid of s.members) {
    const w = cardWins[mid];
    if (!w || w.isDestroyed()) continue;
    const depth = order.indexOf(mid);
    try {
      w.webContents.send('stack-state', {
        inStack: true, total: s.members.length,
        depth, behind: depth > 0,
        activeIndex: s.members.indexOf(s.active),
        members: s.members.map((m) => ({ id: m, label: (modById[m] && modById[m].label) || m })),
      });
    } catch (e) {}
  }
}
function stackClearState(id) {
  const w = cardWins[id];
  if (w && !w.isDestroyed()) { try { w.webContents.send('stack-state', null); } catch (e) {} }
}
const zoomOf = (w) => (w._rz && w._rz.zoom) || 1;
function stackPulse(win) { try { if (win && !win.isDestroyed()) win.webContents.send('glow-all', {}); } catch (e) {} }

// 入堆统一宽度：只放宽不缩窄（各卡都支持自由拉宽重排）；原宽记在_deckW0，出堆还原
// 堆的可见宽只记一本账 s.visW（0908 "反复切牌越切越宽"根因）：以前每次都拿"各卡当前窗口宽−各自边距"取最大，
// 可切牌时刚还原自己缩放的那张卡，窗口宽还是按借来的前卡缩放算的，可见宽凭空多出 2×12×(z自−z借)
// （实测 0.98 vs 0.70 每轮 +7px：266→273→280→287→294），"只放宽不缩窄"就把整堆一起撑宽。
// 账只在成堆（stackFuse）和前卡被用户改尺寸（deckFitToFront）时写；切牌/就位只按账套宽，绝不从窗口现宽反推。
function deckVisibleW(w) { return w.getBounds().width - 2 * insetOf(w); }
// 没账时立账：必须在任何借/还缩放之前调（各卡窗口宽与自己缩放一致的时刻），否则第一笔账就带 2×12×Δz 的误差
function deckEnsureVisW(s) {
  if (Number.isFinite(s.visW) && s.visW > 0) return;
  let v = 0;
  for (const m of deckOrder(s)) {
    const w = cardWins[m];
    if (w && !w.isDestroyed()) v = Math.max(v, deckVisibleW(w));
  }
  s.visW = v;
}
function deckUnifyWidth(s) {
  const wins = deckOrder(s).map((m) => cardWins[m]).filter((w) => w && !w.isDestroyed());
  deckEnsureVisW(s);
  const visW = s.visW;
  for (const w of wins) {
    const b = w.getBounds();
    const want = Math.round(visW + 2 * insetOf(w));
    if (Math.abs(want - b.width) < 1) continue;
    if (w._deckW0 == null) w._deckW0 = b.width;
    // ⚠先记权威尺寸再改窗口：'resize'事件同步触发尺寸看门狗，反过来写=被当非法变化当场压回（0906日志实锤）
    w._authSize = [want, (w._authSize || [0, b.height])[1]];
    deckSetBounds(w, { x: b.x, y: b.y, width: want, height: w._authSize[1] });
    if (w._cardId) config.cards[w._cardId] = Object.assign(config.cards[w._cardId] || {}, { w: want });
  }
}
// 被压卡不可缩放（setResizable(false)=系统去掉WS_THICKFRAME：没有拉伸光标、任何角度都拉不到——0906用户裁定
// "后方牌只能点击切换"）。铁律3：不可缩放时Windows拒绝程序化setBounds（0906实锤：连位置都不动），
// 所以凡是可能落到被压卡上的落位一律走这里：尺寸没变=setPosition；尺寸要变=临时打开可缩放再关回
function deckSetBounds(w, b) {
  if (!w || w.isDestroyed()) return;
  let resizable = true;
  try { resizable = w.isResizable(); } catch (e) {}
  if (resizable) { try { w.setBounds(b); } catch (e) {} return; }
  const [cw, ch] = w.getSize();
  if ((b.width == null || b.width === cw) && (b.height == null || b.height === ch)) {
    try { w.setPosition(b.x | 0, b.y | 0); } catch (e) {}
    return;
  }
  try { w.setResizable(true); } catch (e) {}
  try { w.setBounds(b); } catch (e) {}
  try { w.setResizable(false); } catch (e) {}
}
// 出堆还原：入堆统一过的宽（_deckW0）、被压时收成标题条的高（_deckH0）、被压时借用的前卡缩放（_deckZ0）一起还原，可缩放恢复
function deckSetZoom(w, z) {
  if (!w || w.isDestroyed() || !w._rz) return;
  // 借用/还原的缩放一律夹进 [minZ, maxZ]（0908：入堆前若 _rz.zoom 已是老版本灌进来的 0.26，出堆原样还回=账实再度脱节）
  z = Math.min(w._rz.maxZ || 2.2, Math.max(w._rz.minZ || 0.45, Number(z) || 1));
  if (Math.abs(w._rz.zoom - z) < 0.001) return;
  w._rz.zoom = z;
  try { w.webContents.setZoomFactor(z); w.webContents.send('zoom-var', z); } catch (e) {}
}
function deckRestoreSize(w) {
  if (!w || w.isDestroyed()) return;
  try { if (!w.isResizable()) w.setResizable(true); } catch (e) {}
  applyMinSize(w, true);   // 出堆=自由卡，最小尺寸恢复
  if (w._deckW0 == null && w._deckH0 == null && w._deckZ0 == null) return;
  if (w._deckZ0 != null) { deckSetZoom(w, w._deckZ0); delete w._deckZ0; }
  const b = w.getBounds();
  const W = w._deckW0 != null ? (w._deckW0 | 0) : (w._authSize || [b.width])[0];
  const H = w._deckH0 != null ? (w._deckH0 | 0) : (w._authSize || [0, b.height])[1];
  delete w._deckW0; delete w._deckH0;
  w._authSize = [W, H];   // 先记账再改尺寸（看门狗只认_authSize）
  try { w.setBounds({ x: b.x, y: b.y, width: W, height: H }); } catch (e) {}
  // 0907#1 出堆复原：setBounds后按实际尺寸回写_authSize（Windows对无边框窗有系统最小高，实际可能≠W/H），
  // 并重申zoom让内容与窗口一致——否则出堆后尺寸/缩放对不上，缩放手柄像失效（用户"解开牌堆后无法缩放"）
  try {
    const [aw, ah] = w.getSize();
    w._authSize = [aw, ah];
    reassertZoom(w);
  } catch (e) {}
  if (w._cardId && config.cards[w._cardId]) {
    const [aw, ah] = w.getSize();
    config.cards[w._cardId] = Object.assign(config.cards[w._cardId] || {}, { w: aw, h: ah });
  }
}
// 被压卡的窗口只保留一条标题条：真高度收进_deckH0，切到最前再放回——
// 比前卡高的部分不会从前卡底下露出来，标题条以外也没有任何可点/可输入的东西（0906用户裁定）
// 条窗高 = 露出的标题条 + 藏在前卡底下的尾巴(DECK_TAIL，DIP)：悬停往上抽DECK_NUDGE时露出的是尾巴上的阴影区，
// 不是窗口切口（0906用户实测"抽出后只显示一半很丑"）。尾巴必须≥抽出量。
// 被压卡还临时借用前卡的缩放（自己的记在_deckZ0）：各卡缩放悬殊时（lock 0.26 vs settings 1.15）小卡的条
// 只有12px且全在前卡透明边距底下=永远点不到（0906用户实测）；借前卡缩放=条高一致、都能点、字能读
// 另：极小缩放的卡算出的条高会被Windows撑到系统最小窗高，下限取48让权威尺寸与实际一致、别和尺寸看门狗打架
// 条窗高按"抽出后"的完整标题条算（DECK_STRIP_FULL）+ 藏在前卡底下的尾巴(DECK_TAIL)：
// 默认只露DECK_STRIP，悬停上抽DECK_NUDGE后恰好露出完整标题条，露出的下缘仍是尾巴上的阴影区（不是窗口切口）
const DECK_TAIL = 40;
const deckStripH = (w) => Math.max(48, Math.round((GLASS_INSET * 2 + DECK_STRIP_FULL) * zoomOf(w)) + DECK_TAIL);
function deckSetHeight(w, h) {
  const b = w.getBounds();
  const W = (w._authSize || [b.width])[0];
  w._authSize = [W, h];
  deckSetBounds(w, { x: b.x, y: b.y, width: W, height: h });
}
function deckExpand(w) {   // 切到最前：可缩放 + 还原自己的缩放 + 放回真高度 + 恢复最小尺寸
  if (!w || w.isDestroyed()) return;
  try { if (!w.isResizable()) w.setResizable(true); } catch (e) {}
  applyMinSize(w, true);
  if (w._deckZ0 != null) { deckSetZoom(w, w._deckZ0); delete w._deckZ0; }
  if (w._deckH0 == null) return;
  const h = w._deckH0 | 0;
  delete w._deckH0;
  deckSetHeight(w, h);
}
function deckShrink(w, zFront) {   // 被压：借前卡缩放 + 收成标题条 + 不可缩放（先放开最小尺寸，条比最小高矮）
  if (!w || w.isDestroyed()) return;
  applyMinSize(w, false);
  if (w._deckH0 == null) w._deckH0 = (w._authSize || w.getSize())[1];
  // 原宽也在借缩放之前记（0908）：否则最宽的那张成堆时没被放宽、_deckW0 空着，之后在借来的缩放下才被记上
  // =出堆还原成"按前卡边距算的宽"，可见宽差 2×12×(z借−z自)
  if (w._deckW0 == null) w._deckW0 = (w._authSize || w.getSize())[0];
  if (w._deckZ0 == null) w._deckZ0 = zoomOf(w);
  if (Number.isFinite(zFront) && zFront > 0) deckSetZoom(w, zFront);
  const sh = deckStripH(w);
  if ((w._authSize || [])[1] !== sh) deckSetHeight(w, sh);
  try { if (w.isResizable()) w.setResizable(false); } catch (e) {}
}
function deckShape(s) {
  const order = deckOrder(s);
  const front = cardWins[order[0]];
  if (front && !front.isDestroyed()) deckExpand(front);
  const zf = front && !front.isDestroyed() ? zoomOf(front) : 1;
  for (let k = 1; k < order.length; k++) deckShrink(cardWins[order[k]], zf);
}
// 堆的锚点=前槽位的可见玻璃左上角（固定，谁切到最前都落到这里——不然切一次整堆往上蹿一格）
// 只在成堆/整堆拖动/启动恢复时从前卡现位同步
function deckSyncAnchor(s) {
  const front = cardWins[deckOrder(s)[0]];
  if (!front || front.isDestroyed()) return;
  const b = front.getBounds();
  const i = insetOf(front);
  s.anchor = { vx: b.x + i, vy: b.y + i };
}
// 目标几何：前卡落在锚位；第k张（后）的可见玻璃左边与前卡对齐，顶边比前一张高出一条自己的标题条
//   visibleStrip_k = (y_{k-1}+12·z_{k-1}) − (y_k+12·z_k) = STRIP·z_k  →  y_k = y_{k-1} + 12·z_{k-1} − 12·z_k − STRIP·z_k
function deckTargets(s) {
  const order = deckOrder(s);
  const front = cardWins[order[0]];
  if (!front || front.isDestroyed()) return null;
  if (!s.anchor || !Number.isFinite(s.anchor.vx) || !Number.isFinite(s.anchor.vy)) deckSyncAnchor(s);
  const vx = s.anchor.vx;
  const fy = Math.round(s.anchor.vy - insetOf(front));
  const out = new Map();
  out.set(order[0], { x: Math.round(vx - insetOf(front)), y: fy });
  let prevY = fy, prevZ = zoomOf(front);
  for (let k = 1; k < order.length; k++) {
    const w = cardWins[order[k]];
    if (!w || w.isDestroyed()) continue;
    const z = zoomOf(w);
    const y = Math.round(prevY + GLASS_INSET * prevZ - GLASS_INSET * z - deckStripGap(z));
    out.set(order[k], { x: Math.round(vx - insetOf(w)), y });
    prevY = y; prevZ = z;
  }
  return out;
}
// z序：后→前逐个moveTop，前卡最上；控制台再压卡牌、球永远压顶（0908 用户裁定铁序 球>控制台>卡牌：
// 以前这里只抬球，每次切牌/成堆都把整堆抬到控制台之上=控制台被卡牌压住）
function deckRestack(s) {
  const order = deckOrder(s);
  for (let k = order.length - 1; k >= 0; k--) {
    const w = cardWins[order[k]];
    try { if (w && !w.isDestroyed() && w.isVisible()) w.moveTop(); } catch (e) {}
  }
  enforceZOrder();
  try { if (ctx.fgwatchLayerFix) ctx.fgwatchLayerFix('堆牌重排'); } catch (e) {}   // 同 raiseCard：抬完立刻压回 PS 面板之下
}
function deckRestackAll() { for (const s of stacks) deckRestack(s); }
// 拉伸过程中的同步跟随：被压卡与前卡同一帧同步位置+宽（withWidth），一张窗一帧最多一次 setBounds/setPosition；
// 高与缩放不碰（借用等松手）。被压卡在会话内已被放开可缩放（grip-start），这里直接 setBounds 不走开关
// 0907#3 卡顿优化：拖动会话内缓存一次s.order（成员在拖拽期间不变），不再每8ms deckOrder重建数组
function deckFollowLive(s, withWidth) {
  const order = s._liveOrder || deckOrder(s);
  const front = cardWins[order[0]];
  if (!front || front.isDestroyed()) return;
  const fb = front.getBounds();
  const fi = insetOf(front);
  const vx = fb.x + fi;
  const visW = fb.width - 2 * fi;
  let prevY = fb.y, prevZ = zoomOf(front);
  for (let k = 1; k < order.length; k++) {
    const w = cardWins[order[k]];
    if (!w || w.isDestroyed()) continue;
    const z = zoomOf(w);
    const y = Math.round(prevY + GLASS_INSET * prevZ - GLASS_INSET * z - deckStripGap(z));
    const x = Math.round(vx - insetOf(w));
    prevY = y; prevZ = z;
    const b = w.getBounds();
    const want = Math.round(visW + 2 * insetOf(w));
    if (withWidth && Math.abs(want - b.width) >= 1) {
      if (w._deckW0 == null) w._deckW0 = b.width;
      w._authSize = [want, (w._authSize || [0, b.height])[1]];   // 先记账再改（看门狗只认 _authSize）
      deckSetBounds(w, { x, y, width: want, height: w._authSize[1] });
    } else if (b.x !== x || b.y !== y) {
      try { w.setPosition(x, y); } catch (e) {}
    }
  }
}
// 前卡被用户改了尺寸/缩放：被压卡一律对齐前卡（宽跟前卡，可宽可窄；缩放借前卡的新值），再按几何就位
// live=只摆位不排z序不落盘
function deckFitToFront(s, live) {
  clearInterval(deckAnim); deckAnim = null;
  const order = deckOrder(s);
  const front = cardWins[order[0]];
  if (!front || front.isDestroyed()) return;
  deckSyncAnchor(s);
  deckShape(s);   // 被压卡借前卡新缩放（inset随之变）
  // 前卡的可见宽=堆的新账（可宽可窄）；全体按账套宽（0908：不再各自从现宽反推，见 deckUnifyWidth）
  s.visW = deckVisibleW(front);
  deckUnifyWidth(s);
  const T = deckTargets(s);
  if (!T) return;
  for (const [m, t] of T) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    const [aw, ah] = w._authSize || w.getSize();
    deckSetBounds(w, { x: t.x | 0, y: t.y | 0, width: aw, height: ah });
    config.cards[m] = Object.assign(config.cards[m] || {}, { x: t.x | 0, y: t.y | 0 });
  }
  if (live) return;
  deckRestack(s);
  stackSave();
}
// 就位（无动画）：统一宽→按几何摆位→z序→记账
function deckApply(s) {
  clearInterval(deckAnim); deckAnim = null;   // 悬停抽牌等小动画不许在就位后补写旧坐标
  deckEnsureVisW(s);   // 立账要在借缩放之前
  deckShape(s);        // 先定各卡缩放/高（inset随缩放变，宽与几何都要在它之后算）
  deckUnifyWidth(s);
  const T = deckTargets(s);
  if (!T) return;
  for (const [m, t] of T) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    const [aw, ah] = w._authSize || w.getSize();
    deckSetBounds(w, { x: t.x | 0, y: t.y | 0, width: aw, height: ah });
    config.cards[m] = Object.assign(config.cards[m] || {}, { x: t.x | 0, y: t.y | 0 });
  }
  s._nudged = null;
  deckRestack(s);
}
// 多窗位移tween（8ms，缓出）；detourId那张走侧向弧线（切牌：抽出→落到最前）
function deckTween(moves, dur, detourId, done) {
  clearInterval(deckAnim);
  const list = moves.filter((m) => m.win && !m.win.isDestroyed()
    && [m.x0, m.y0, m.x1, m.y1].every(Number.isFinite));
  if (!list.length) { if (done) done(); return; }
  const t0 = Date.now();
  deckAnim = setInterval(() => {
    let t = (Date.now() - t0) / dur;
    if (t > 1) t = 1;
    const k = 1 - Math.pow(1 - t, 3);
    for (const m of list) {
      if (m.win.isDestroyed()) continue;
      const side = m.id === detourId ? Math.sin(Math.PI * t) * m.detour : 0;
      try {
        const [aw, ah] = m.win._authSize || m.win.getSize();
        deckSetBounds(m.win, { x: Math.round(m.x0 + (m.x1 - m.x0) * k + side) | 0, y: Math.round(m.y0 + (m.y1 - m.y0) * k) | 0, width: aw, height: ah });
      } catch (e) {}
    }
    if (t >= 1) { clearInterval(deckAnim); deckAnim = null; if (done) done(); }
  }, 8);
}
// 切牌：目标抽到最前，其余保持相对顺序往后错一格；目标飞行中先压顶（它在最上飞），落定重排z序+边框爆闪一次
function deckCut(s, targetId, opts) {
  if (!s || !s.members.includes(targetId)) return;
  const order = deckOrder(s);
  const prevFront = order[0];
  deckSyncAnchor(s);   // 重排前先以"此刻坐在前槽位的那张"为锚：存起来的锚点可能已陈旧（拖完即融合等路径）
  // 点击切牌=目标抽到最前、其余相对顺序不变；滚轮/方向键切牌=调用方给出完整轮换后的顺序（opts.order）
  const forced = opts && Array.isArray(opts.order) && opts.order.length === order.length && opts.order.every((m) => order.includes(m)) ? opts.order.slice() : null;
  if (forced) s.order = forced;
  else if (targetId !== prevFront) s.order = [targetId].concat(order.filter((m) => m !== targetId));
  s.active = targetId;
  s._nudged = null;
  const tw = cardWins[targetId];
  if (!tw || tw.isDestroyed()) return;
  const quick = !!(opts && opts.quick) || targetId === prevFront;
  deckEnsureVisW(s);   // 立账要在目标还原自己缩放之前（0908）
  deckExpand(tw);   // 目标先还原缩放+真高度（它在最上飞，飞的时候就是整张牌）；其余落定后再收成条
  deckUnifyWidth(s);
  const T = deckTargets(s);
  if (!T) return;
  const finish = () => {
    // 落定：被压的借前卡缩放+收条（inset随之变）→ 宽再统一一次 → 按最终几何精确落位
    deckShape(s);
    deckUnifyWidth(s);
    const T2 = deckTargets(s) || T;
    for (const [m, t] of T2) {
      const w = cardWins[m];
      if (!w || w.isDestroyed()) continue;
      const [aw, ah] = w._authSize || w.getSize();
      deckSetBounds(w, { x: t.x | 0, y: t.y | 0, width: aw, height: ah });
      config.cards[m] = Object.assign(config.cards[m] || {}, { x: t.x | 0, y: t.y | 0 });
    }
    deckRestack(s);
    if (ctx.tryArm) ctx.tryArm(targetId);   // 切到谁谁武装（所见即所跑）
    stackPulse(tw);
    stackBroadcast(s);
    broadcastOpenStates();
    stackSave();
  };
  if (quick) { finish(); return; }
  try { tw.moveTop(); if (ballWin && !ballWin.isDestroyed()) ballWin.moveTop(); } catch (e) {}
  const moves = [];
  for (const [m, t] of T) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    const b = w.getBounds();
    moves.push({ id: m, win: w, x0: b.x, y0: b.y, x1: t.x, y1: t.y, detour: Math.min(90, Math.round(b.width * 0.22)) });
  }
  deckTween(moves, DECK_CUT_MS, targetId, finish);
}
// 悬停抽出/归位（被压卡标题条）：3帧小位移，不改几何记账（切牌/就位会精确复位）
ipcMain.on('deck-hover', (e, on) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !w._cardId) return;
  const s = stackOf(w._cardId);
  // 拖动中（光标扫过被压卡）/切牌动画中不抽——否则会用锚点把正在拖的卡拽回原地。
  // 锁定态照抽：抽出只是90ms小位移不改布局记账，且切牌本就允许在锁定下用（0907实锤：用户锁着时悬停全无反馈）
  if (!s || deckAnim || dragActive) return;
  const order = deckOrder(s);
  if (order.indexOf(w._cardId) <= 0) return;   // 前卡不抽
  deckSyncAnchor(s);
  const T = deckTargets(s);
  const t = T && T.get(w._cardId);
  if (!t) return;
  const b = w.getBounds();
  // 抽牌=往上抽到露出完整标题条：抽出量=完整条(48×z)减去已露出的条(deckStripGap，含40 DIP下限)，不足0不抽
  const y1 = on ? t.y - Math.max(0, Math.round(DECK_STRIP_FULL * zoomOf(w) - deckStripGap(zoomOf(w)))) : t.y;
  s._nudged = on ? w._cardId : null;
  deckTween([{ id: w._cardId, win: w, x0: b.x, y0: b.y, x1: t.x, y1, detour: 0 }], 90, null, null);
});
ipcMain.on('deck-cut', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !w._cardId) return;
  const s = stackOf(w._cardId);
  if (!s) return;
  try { ctx.dlog('[deck] 切牌 → ' + w._cardId); } catch (e2) {}
  deckCut(s, w._cardId);
});
// 程序化堆牌/拆牌（smoke机测、日后布局快照恢复堆用）：只认已开着的卡
ipcMain.handle('deck-fuse', (_e, p) => {
  const src = p && p.src, dst = p && p.dst;
  const a = cardWins[src], b = cardWins[dst];
  if (!a || a.isDestroyed() || !b || b.isDestroyed() || src === dst) return { ok: false, error: '卡未打开' };
  stackFuse(src, dst);
  const s = stackOf(dst);
  return { ok: !!s, order: s ? deckOrder(s).slice() : [] };
});
ipcMain.handle('deck-detach', (_e, id) => { stackDetach(id); return { ok: true, inStack: !!stackOf(id) }; });
// 机测：融合判定探针——给定"拖动中的卡"和"光标屏幕坐标"，返回会融合到哪张（不真融）
ipcMain.handle('deck-fuse-probe', (_e, p) => {
  const w = p && cardWins[p.id];
  if (!w || w.isDestroyed()) return { target: null, error: '卡未打开' };
  const t = findFuseTarget(w, (p.cursor && Number.isFinite(p.cursor.x)) ? p.cursor : undefined);
  return { target: t ? t._cardId : null };
});
ipcMain.handle('card-resizable', (_e, id) => { const w = cardWins[id]; try { return w && !w.isDestroyed() ? w.isResizable() : null; } catch (e) { return null; } });
// 机测用：模拟"缩放引擎把前卡改成某尺寸/缩放后收尾"（真实路径=grip-start…grip-end，同一收尾逻辑）
ipcMain.handle('deck-front-resize', (_e, p) => {
  const w = p && cardWins[p.id];
  if (!w || w.isDestroyed() || !w._rz) return { ok: false };
  const s = stackOf(p.id);
  if (!s || deckOrder(s)[0] !== p.id) return { ok: false, error: '不是堆的前卡' };
  const b = w.getBounds();
  // 0907#9 统一等比：模拟缩放引擎把前卡按zoom等比放大/缩小（不再直接改宽高破坏比例）。
  // 目标宽高 = base×zoom，与grip的真实路径一致（grip也是nz→setSize(base×z)）。
  const nz = Number.isFinite(p.zoom) ? Math.min(zoomMaxOf(w), Math.max(w._rz.minZ, p.zoom)) : zoomOf(w);
  const nw = Math.round((w._rz.baseW || b.width) * nz), nh = Math.round((w._rz.baseH || b.height) * nz);
  w._rz.start = { w: b.width, h: b.height, x: b.x, y: b.y, zoom: zoomOf(w), cx: 0, cy: 0, mode: 'corner' };
  deckSetZoom(w, nz);
  try { w.setBounds({ x: b.x, y: b.y, width: nw, height: nh }); } catch (e) {}
  w._rz.start = null;
  w._authSize = w.getSize();
  if (w._saveSize) w._saveSize();
  delete w._deckW0;
  deckFitToFront(s);
  return { ok: true };
});
// 机测/复位用：读/摆某张卡的位置（不动尺寸；只认已开着的卡）
ipcMain.handle('card-bounds', (_e, id) => {
  const w = cardWins[id];
  if (!w || w.isDestroyed()) return null;
  const b = w.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height, vis: w.isVisible() };
});
ipcMain.handle('card-move', (_e, p) => {
  const w = p && cardWins[p.id];
  if (!w || w.isDestroyed() || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return { ok: false };
  const [aw, ah] = w._authSize || w.getSize();
  deckSetBounds(w, { x: p.x | 0, y: p.y | 0, width: aw, height: ah });
  config.cards[p.id] = Object.assign(config.cards[p.id] || {}, { x: p.x | 0, y: p.y | 0 });
  saveConfig();
  return { ok: true };
});
ipcMain.handle('deck-info', (_e, id) => {
  const s = stackOf(id);
  if (!s) return { inStack: false };
  const T = deckTargets(s) || new Map();
  const geo = {};
  for (const m of deckOrder(s)) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    const b = w.getBounds();
    geo[m] = { x: b.x, y: b.y, w: b.width, h: b.height, z: zoomOf(w), tx: (T.get(m) || {}).x, ty: (T.get(m) || {}).y, vis: w.isVisible(),
      h0: w._deckH0 != null ? w._deckH0 : null, z0: w._deckZ0 != null ? w._deckZ0 : null, stripH: deckStripH(w), authH: (w._authSize || [0, 0])[1],
      resizable: (() => { try { return w.isResizable(); } catch (e) { return null; } })() };
  }
  return { inStack: true, order: deckOrder(s).slice(), active: s.active, anchor: s.anchor || null, geo };
});

// 融合：源(拖来的卡/叠)并入目标(卡/叠)。拖来的成为最前（所见即所跑），目标原前卡往后错一格露出标题条；
// 新成员从落手位置滑进槽位，整堆微沉一下
function stackFuse(srcId, dstId) {
  const srcStack = stackOf(srcId), dstStack = stackOf(dstId);
  if (srcStack && srcStack === dstStack) return;
  const dstWin = cardWins[dstId];
  if (!dstWin || dstWin.isDestroyed()) return;
  const srcOrder = srcStack ? deckOrder(srcStack).slice() : [srcId];
  let s = dstStack;
  if (!s) { s = { id: 'st' + (++stackSeq), members: [dstId], order: [dstId], active: dstId }; stacks.push(s); }
  deckSyncAnchor(s);   // 目标堆的前卡此刻坐在前槽位（被拖来的是源，不是它）
  const dstOrder = deckOrder(s).slice();
  if (srcStack) stacks = stacks.filter((x) => x !== srcStack);
  for (const m of srcOrder) if (!s.members.includes(m)) s.members.push(m);
  // 堆的宽账（0908）：目标堆旧账（新堆=目标卡此刻自己缩放下的可见宽）与源方（源是堆=它的账；源是单卡=它的可见宽）
  // 取最大=只放宽不缩窄。绝不从被压卡现宽反推——它们的窗口宽是按借来的缩放算的
  {
    let v = (Number.isFinite(s.visW) && s.visW > 0) ? s.visW : 0;
    if (!v) for (const m of dstOrder) { const w = cardWins[m]; if (w && !w.isDestroyed()) v = Math.max(v, deckVisibleW(w)); }
    if (srcStack && Number.isFinite(srcStack.visW) && srcStack.visW > 0) v = Math.max(v, srcStack.visW);
    else { const sw = cardWins[srcId]; if (sw && !sw.isDestroyed()) v = Math.max(v, deckVisibleW(sw)); }
    s.visW = v;
  }
  // 锚点=目标堆的前槽位（已有堆沿用它的锚；新堆=目标卡原位）：拖来的卡滑进这个槽位，目标往后错
  s.order = srcOrder.concat(dstOrder.filter((m) => !srcOrder.includes(m)));
  s.active = s.order[0];
  s._nudged = null;
  for (const m of s.members) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    cancelReap(m);
    if (!w.isVisible()) w.showInactive();
    if (config.cards[m]) config.cards[m].open = true;
  }
  deckUnifyWidth(s);
  const T = deckTargets(s);
  if (!T) return;
  const moves = [];
  for (const [m, t] of T) {
    const w = cardWins[m];
    if (!w || w.isDestroyed()) continue;
    const b = w.getBounds();
    moves.push({ id: m, win: w, x0: b.x, y0: b.y, x1: t.x, y1: t.y, detour: 0 });
    if (srcOrder.includes(m)) sendFx(w, { mode: 'fusein' });
    else sendFx(w, { mode: 'bump' });
  }
  deckRestack(s);
  deckTween(moves, 170, null, () => {
    // 落定：被压的借前卡缩放+收成标题条 → 宽再统一 → 按最终几何精确落位
    deckShape(s);
    deckUnifyWidth(s);
    const T2 = deckTargets(s) || T;
    for (const [m, t] of T2) {
      const w = cardWins[m];
      if (!w || w.isDestroyed()) continue;
      const [aw, ah] = w._authSize || w.getSize();
      deckSetBounds(w, { x: t.x | 0, y: t.y | 0, width: aw, height: ah });
      config.cards[m] = Object.assign(config.cards[m] || {}, { x: t.x | 0, y: t.y | 0 });
    }
    deckRestack(s);
    if (ctx.tryArm) ctx.tryArm(s.active);
    stackPulse(cardWins[s.active]);
    stackBroadcast(s);
    broadcastOpenStates();
    stackSave();
  });
  olog('🃏 堆牌：' + deckOrder(s).map((m) => (modById[m] && modById[m].label) || m).join(' / '));
}

// 程序化确保某成员在最前（生图弹进度卡等）：整堆先亮出，再快速切牌
function stackShow(s, targetId) {
  if (!s || !s.members.includes(targetId)) return;
  for (const m of s.members) {
    const w = cardWins[m];
    if (w && !w.isDestroyed() && !w.isVisible()) w.showInactive();
    if (config.cards[m]) config.cards[m].open = true;
  }
  deckCut(s, targetId, { quick: true });
}

// 拆出：把某成员从堆里摘走（右键拖标题条触发；成员窗口销毁也走这里清理）；剩余重新就位，只剩一张则解散
function stackDetach(id) {
  const s = stackOf(id);
  if (!s) return;
  clearInterval(deckAnim); deckAnim = null;
  deckSyncAnchor(s);   // 摘之前前卡还在槽位上（右键拖摘走发生在拖动开始那一刻，位置未变）
  // ⚠先在成员表还完整时算好剩余顺序，再缩成员表——反过来deckOrder会因长度不符按"加入顺序"重建，
  // 剩余卡的视觉顺序被打乱（0907 smoke实锤：pee,lock,anti摘出再回融变成pee,anti,lock）
  const ord = deckOrder(s).filter((m) => m !== id);
  s.members = s.members.filter((m) => m !== id);
  s.order = ord;
  s.active = s.order[0];
  stackClearState(id);
  deckRestoreSize(cardWins[id]);
  if (s.members.length <= 1) {
    if (s.members[0]) { stackClearState(s.members[0]); deckRestoreSize(cardWins[s.members[0]]); }
    stacks = stacks.filter((x) => x !== s);
  } else {
    deckApply(s);
    stackBroadcast(s);
  }
  broadcastOpenStates();
  stackSave();
}

// hub气泡点到堆内成员：整堆开关（开=整堆亮出并切它到最前，关=整堆收起）
function stackToggle(id) {
  const s = stackOf(id);
  if (!s) return false;
  const activeWin = cardWins[s.active];
  const visible = activeWin && !activeWin.isDestroyed() && activeWin.isVisible();
  if (visible && s.active === id) {
    for (const m of s.members) {
      const w = cardWins[m];
      if (w && !w.isDestroyed() && w.isVisible()) w.hide();
      if (config.cards[m]) config.cards[m].open = false;
    }
    stackSave();
  } else {
    stackShow(s, id);
  }
  broadcastOpenStates();
  return true;
}

// 老通道兼容（滚轮翻页等）：按加入序切上一张/下一张
ipcMain.on('stack-switch', (e, dir) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !w._cardId) return;
  const s = stackOf(w._cardId);
  if (!s || s.members.length < 2) return;
  const i = s.members.indexOf(s.active);
  const n = (i + (Number(dir) > 0 ? 1 : -1) + s.members.length) % s.members.length;
  deckCut(s, s.members[n]);
});
ipcMain.on('stack-jump', (e, idx) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !w._cardId) return;
  const s = stackOf(w._cardId);
  if (!s) return;
  const t = s.members[Math.max(0, Math.min(s.members.length - 1, Number(idx) || 0))];
  deckCut(s, t);
});

// 融合落点检测（0907重写）：旧公式"重叠/较小卡面积>0.6"对长宽比差异大的两张卡天然吃亏
//（矮宽的生图模式×高窄的甄选：手握标题栏时宽边两侧各露一截，包含比跌破0.6永远融不上，只有横向缩窄才行——用户实锤）。
// 现在双判定任一满足：①包含比>0.5；②光标本身落在目标卡可见区内 且 重叠≥较小卡面积25%（=用户明确"拖到它上面了"）
function findFuseTarget(dw, cursor) {
  const A = visualRect(dw);
  const areaA = Math.max(1, (A.r - A.l) * (A.b2 - A.t));
  const myStack = dw._cardId ? stackOf(dw._cardId) : null;
  const p = cursor || (() => { try { return screen.getCursorScreenPoint(); } catch (e) { return null; } })();
  let best = null, bestScore = 0;
  for (const id in cardWins) {
    const w = cardWins[id];
    if (!w || w.isDestroyed() || !w.isVisible() || w === dw) continue;
    if (myStack && myStack.members.includes(id)) continue;
    const B = visualRect(w);
    const ow = Math.max(0, Math.min(A.r, B.r) - Math.max(A.l, B.l));
    const oh = Math.max(0, Math.min(A.b2, B.b2) - Math.max(A.t, B.t));
    if (!ow || !oh) continue;
    const areaB = Math.max(1, (B.r - B.l) * (B.b2 - B.t));
    const ratio = (ow * oh) / Math.min(areaA, areaB);
    const cursorIn = !!p && p.x >= B.l && p.x <= B.r && p.y >= B.t && p.y <= B.b2;
    const hit = ratio > 0.5 || (cursorIn && ratio >= 0.25);
    if (!hit) continue;
    const score = ratio + (cursorIn ? 1 : 0);   // 光标所在的卡优先（多卡重叠时选用户手底下那张）
    if (score > bestScore) { bestScore = score; best = w; }
  }
  return best;
}

// 启动恢复：按config.stacks重建（成员窗口缺失的补开；hidden堆整堆隐藏；开机编排期不亮等绽放）
function restoreStacks() {
  for (const sv of (config.stacks || [])) {
    const members = (sv.members || []).filter((m) => modById[m]);
    if (members.length < 2) continue;
    for (const m of members) {
      if (!cardWins[m] || cardWins[m].isDestroyed()) openCard(m);
    }
    const valid = members.filter((m) => cardWins[m] && !cardWins[m].isDestroyed());
    if (valid.length < 2) continue;
    const active = valid.includes(sv.active) ? sv.active : valid[0];
    const order = (Array.isArray(sv.order) ? sv.order : []).filter((m) => valid.includes(m));
    for (const m of valid) if (!order.includes(m)) order.push(m);
    if (order[0] !== active) { const i = order.indexOf(active); if (i > 0) { order.splice(i, 1); order.unshift(active); } }
    const s = { id: 'st' + (++stackSeq), members: valid, order, active: order[0] };
    if (Number.isFinite(sv.visW) && sv.visW > 0) s.visW = sv.visW;
    if (sv.anchor && Number.isFinite(sv.anchor.vx) && Number.isFinite(sv.anchor.vy)) s.anchor = { vx: sv.anchor.vx, vy: sv.anchor.vy };
    else deckSyncAnchor(s);
    stacks.push(s);
    for (const m of valid) {
      const w = cardWins[m];
      cancelReap(m);
      if (sv.hidden) { if (w.isVisible()) w.hide(); }
      else if (!w.isVisible() && !bootDeferring) w.showInactive();
      if (config.cards[m]) config.cards[m].open = !sv.hidden;
    }
    deckApply(s);
    stackBroadcast(s);
  }
  broadcastOpenStates();
}

// ---------- 快速布局：快照/自动对齐贴合/动画切换 ----------
function captureLayout() {
  const data = { hub: null, cards: {} };
  if (hubWin && !hubWin.isDestroyed()) {
    const b = hubWin.getBounds();
    data.hub = { x: b.x, y: b.y, w: b.width, h: b.height, zoom: (hubWin._rz && hubWin._rz.zoom) || 1, open: hubWin.isVisible() };
  }
  for (const id in cardWins) {
    const w = cardWins[id];
    if (!w || w.isDestroyed()) continue;
    const b = w.getBounds();
    // 堆牌成员记真实尺寸（入堆统一过的宽/收成条的高不是它自己的）：布局应用前会解散堆，尺寸得是散开后的
    const rw = w._deckW0 != null ? (w._deckW0 | 0) : b.width;
    const rh = w._deckH0 != null ? (w._deckH0 | 0) : b.height;
    const rz = w._deckZ0 != null ? w._deckZ0 : ((w._rz && w._rz.zoom) || 1);
    data.cards[id] = { x: b.x, y: b.y, w: rw, h: rh, zoom: rz, open: w.isVisible() };
  }
  // 堆牌进快照（0912 用户实报：存了含堆的布局，一点布局堆散成一地、被压卡露出整张盖住别的卡点不到）：
  // 应用时先解散按单卡落位，释放落定后按这份重新成堆（成员/顺序/宽账/隐藏态原样；锚点从前卡现位取）
  data.stacks = stackSnapshot();
  return data;
}

// 应用布局：全体收回球心 → 按目标尺寸/缩放就位 → 从球心绽放到新位置
// 堆牌（0912 用户裁定"布局要记住我的堆"）：
//   · 新快照（data.stacks 是数组）= 权威：按它成堆（成员只取布局里开着的），不在它里的现有堆解散
//   · 老快照（没有 stacks 字段）= 保留此刻屏幕上的堆：成员凡在布局里开着的留在堆里，整堆落到前卡在布局里记的位置；
//     应用完把堆写回这份布局（persist），下次即使当时没这个堆也能按布局堆好
//   · 堆在起飞前就成形（窗口此刻全隐藏，看不见拆装），以"一叠"的样子飞过去落位——没有"散开再合上"那一帧
function stackDissolveAll() {
  clearInterval(deckAnim); deckAnim = null;
  for (const s of stacks) for (const m of s.members) { stackClearState(m); deckRestoreSize(cardWins[m]); }
  stacks = [];
  config.stacks = [];
  saveConfig();
}
function applyLayoutData(data, persist) {
  if (!data || !ballWin || ballWin.isDestroyed() || gatherAnim || gatherPhase) return;
  // 目标堆：新快照按 data.stacks（权威）；老快照（无该字段）按**它自己存的卡位置**反推当时有没有叠着（deck-geo.inferStacks）——
  // 绝不拿屏幕此刻的堆当依据（v5.18.45 这么干过：切到没叠牌的老布局，现堆被保留又写回去=所有布局被污染成叠牌，用户实报）
  const openIn = (id) => !!(data.cards && data.cards[id] && data.cards[id].open && modById[id]);
  const targets = [];
  const legacy = !Array.isArray(data.stacks);
  const src = legacy ? require('./deck-geo').inferStacks(data.cards) : data.stacks;
  for (const sv of src) {
    const order = ((Array.isArray(sv.order) && sv.order.length) ? sv.order : (sv.members || [])).filter(openIn);
    for (const m of (sv.members || [])) if (openIn(m) && !order.includes(m)) order.push(m);
    if (order.length < 2) continue;
    targets.push({ order, visW: (Number.isFinite(sv.visW) && sv.visW > 0) ? sv.visW : undefined });
  }
  if (stacks.length) stackDissolveAll();
  // 快速布局卡自身豁免：切布局时它留在画面里原位不被收走（连续切换布局要它一直在手边）
  const lw0 = cardWins['layout'];
  const layoutKeep = (lw0 && !lw0.isDestroyed() && lw0.isVisible())
    ? { x: lw0.getBounds().x, y: lw0.getBounds().y } : null;
  const doApply = () => {
    const b = ballWin.getBounds();
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const items = [];
    // 布局快照里的 zoom 可能来自 minZ 还是 0.25 的老版本（0908 实锤 layouts.default/custom 里 lock=0.2629）：
    // 落到窗口前先夹进 [minZ, 2.2]，否则每切一次布局就把低于下限的旧值灌回 _rz.zoom→config，迁移v6白做
    const clampZ = (win, z) => {
      const lo = (win && win._rz && win._rz.minZ) || 0.45;
      return Math.min(2.2, Math.max(lo, Number(z) || 1));
    };
    const prep = (win, t) => {
      try {
        t.zoom = clampZ(win, t.zoom);
        // ⚠先记账再改尺寸（deckRestoreSize 同款）：setBounds 会同步触发 resize 事件，
        // 看门狗按旧 _authSize 判"未授权变化"当场压回旧尺寸（glass 日志实锤 144x90→161x147 已压回），
        // 之后靠释放落位再改回来=白折腾一轮，慢机/跨DPI时就是"切布局后卡尺寸不对/位置跳"
        win._authSize = [t.w | 0, t.h | 0];   // 布局恢复=新的权威尺寸（DPI守卫口径同步）
        win.setBounds({ x: Math.round(cx - t.w / 2) | 0, y: Math.round(cy - t.h / 2) | 0, width: t.w | 0, height: t.h | 0 });
        if (win._rz) {
          win._rz.zoom = t.zoom;
          win.webContents.setZoomFactor(t.zoom);
          win.webContents.send('zoom-var', t.zoom);
        }
      } catch {}
    };
    if (data.hub && data.hub.open) {
      if (!hubWin || hubWin.isDestroyed()) { toggleHub(true); if (hubWin) hubWin.hide(); }
      if (hubWin && !hubWin.isDestroyed()) {
        prep(hubWin, data.hub);
        // 布局快照可能录自更大的屏幕：落位前夹进当前工作区
        const [chx, chy] = clampToWork(data.hub.x, data.hub.y, data.hub.w, data.hub.h);
        data.hub.x = chx; data.hub.y = chy;
        items.push({ id: '__hub', win: hubWin, x: chx, y: chy });
        config.hubPos = [data.hub.x, data.hub.y];
        config.hubSize = [data.hub.w, data.hub.h];
        config.hubZoom = Math.min(2.2, Math.max(0.45, data.hub.zoom || 1));
        config.hubOpen = true;
      }
    } else if (hubWin && !hubWin.isDestroyed()) { hubWin.hide(); config.hubOpen = false; }
    for (const [id, t] of Object.entries(data.cards || {})) {
      if (!modById[id] || !t.open) continue;
      if (!cardWins[id] || cardWins[id].isDestroyed()) {
        const w = openCard(id);
        if (w) w.hide();
      }
      const w = cardWins[id];
      if (!w || w.isDestroyed()) continue;
      prep(w, t);
      const [ctx2, cty2] = clampToWork(t.x, t.y, t.w, t.h);   // 快照坐标夹进当前工作区
      items.push({ id, win: w, x: ctx2, y: cty2 });
      config.cards[id] = Object.assign(config.cards[id] || {}, { x: ctx2, y: cty2, w: t.w, h: t.h, zoom: t.zoom || 1, open: true });
    }
    // 快速布局卡豁免：不在布局快照里也留在原位（跟着释放动画飞回自己的位置）
    const lw = cardWins['layout'];
    if (layoutKeep && lw && !lw.isDestroyed() && !items.find((i) => i.id === 'layout')) {
      items.push({ id: 'layout', win: lw, x: layoutKeep.x | 0, y: layoutKeep.y | 0 });
      config.cards['layout'] = Object.assign(config.cards['layout'] || {}, { x: layoutKeep.x, y: layoutKeep.y, open: true });
    }
    // 布局外的卡全部收起（含openCard伴生带出来的）
    for (const id in cardWins) {
      const w = cardWins[id];
      if (!w || w.isDestroyed()) continue;
      if (!items.find((i) => i.win === w)) {
        w.hide();
        scheduleReap(id);   // 布局外收起的卡同样进入闲置回收
        if (config.cards[id]) config.cards[id].open = false;
      }
    }
    saveConfig();
    // 起飞前成堆：成员都已按快照的"散开尺寸"备好（隐藏中）。收成条+统一宽+按前卡在布局里的落点算整堆的落点，
    // 飞行目标替换成堆内位置——落地即是一叠，后面的卡全程只露标题条，不会有整张压在别的卡上的一帧
    const formed = [];
    for (const t of targets) {
      const order = t.order.filter((m) => cardWins[m] && !cardWins[m].isDestroyed() && items.find((i) => i.id === m));
      if (order.length < 2) continue;
      const s = { id: 'st' + (++stackSeq), members: order.slice(), order: order.slice(), active: order[0] };
      if (t.visW) s.visW = t.visW;
      stacks.push(s);
      deckEnsureVisW(s);
      deckShape(s);
      deckUnifyWidth(s);
      const front = cardWins[order[0]];
      const fi = items.find((i) => i.id === order[0]);
      s.anchor = { vx: fi.x + insetOf(front), vy: fi.y + insetOf(front) };
      const T = deckTargets(s);
      if (T) for (const [m, p] of T) { const it = items.find((i) => i.id === m); if (it) { it.x = p.x | 0; it.y = p.y | 0; config.cards[m] = Object.assign(config.cards[m] || {}, { x: it.x, y: it.y }); } }
      stackBroadcast(s);
      formed.push(s);
    }
    if (formed.length) { stackSave(); try { ctx.dlog('[layout] 堆牌' + (legacy ? '(老快照·按位置反推)' : '') + ' ' + formed.map((s) => s.order.join('/')).join(' | ')); } catch (e) {} }
    else if (legacy) { try { ctx.dlog('[layout] 老快照按位置反推：无堆'); } catch (e) {} }
    // 0915泄漏修主路径：卡可见时切布局=gatherAll(doApply)，收纳完这里用布局单盖掉刚才那份
    // gatherState——收纳时诞生的代理窗随之失联，每切一次布局漏一个全屏透明窗（5个幽灵窗的主要来源）。
    // 布局释放本来就走真窗动画（布局单没有快照），销毁代理层零损失。
    if (gatherState) destroyGatherProxy(gatherState);
    gatherState = { items };
    // 落地收尾：按锚位精确归位+z序（飞行是逐帧 setPosition，末帧取整可能差 1px）；老快照把堆写回布局
    releaseDone = () => {
      for (const s of formed) { if (stacks.includes(s)) { deckApply(s); stackBroadcast(s); } }
      if (formed.length) stackSave();
      if (legacy && persist) { try { persist(stackSnapshot()); } catch (e) {} }
    };
    releaseAll();
    if (gatherState) releaseDone = null;   // releaseAll 没接手（动画中被拒）：别把回调留给下一次无关的释放
  };
  const anyVisible = (hubWin && !hubWin.isDestroyed() && hubWin.isVisible())
    || Object.values(cardWins).some((w) => w && !w.isDestroyed() && w.isVisible());
  if (anyVisible && !gatherState) gatherAll(doApply);
  else {
    // 0915泄漏修真凶：收纳状态下应用布局，这里直接 gatherState=null——旧代理窗（每屏一个全屏透明窗）
    // 从此无人销毁。中键切一次布局漏一个，实机探针抓到5个2560全屏幽灵窗=GPU几百MB
    if (gatherState) destroyGatherProxy(gatherState);
    gatherState = null; doApply();
  }
}

ipcMain.handle('layout-list', () => ({
  hasDefault: !!config.layouts.default,
  custom: (config.layouts.custom || []).map((c) => c.name),
}));
// 老快照应用完把反推结果写回去（有堆记堆、没堆记 []，之后它就是权威不再猜；只补没有 stacks 字段的）
function layoutPersistStacks(name) {
  return (snap) => {
    const stored = name === '__default' ? config.layouts.default : ((config.layouts.custom || []).find((c) => c.name === name) || {}).data;
    if (!stored || Array.isArray(stored.stacks)) return;
    stored.stacks = snap;
    saveConfig();
    try { ctx.dlog('[layout] 老布局「' + (name === '__default' ? '默认' : name) + '」已补记 ' + (snap.length ? ('堆牌 ' + snap.map((s) => s.order.join('/')).join(' | ')) : '"无堆"')); } catch (e) {}
  };
}
ipcMain.handle('layout-apply', (_e, name) => {
  const data = name === '__default'
    ? config.layouts.default
    : ((config.layouts.custom || []).find((c) => c.name === name) || {}).data;
  if (!data) return { ok: false, error: '布局不存在' };
  olog('📐 切换布局: ' + (name === '__default' ? '默认' : name));
  applyLayoutData(JSON.parse(JSON.stringify(data)), layoutPersistStacks(name));
  return { ok: true };
});
// 机测专用：把某布局的 stacks 字段抹掉，模拟 v5.18.43 之前存的老布局（只记单卡）
ipcMain.handle('layout-strip-stacks', (_e, name) => {
  const stored = name === '__default' ? config.layouts.default : ((config.layouts.custom || []).find((c) => c.name === name) || {}).data;
  if (!stored) return { ok: false };
  delete stored.stacks;
  saveConfig();
  return { ok: true };
});
ipcMain.handle('layout-save', (_e, name) => {
  name = String(name || '').trim().slice(0, 12);
  if (!name) return { ok: false, error: '名称为空' };
  const snap = captureLayout();
  const ex = (config.layouts.custom || []).find((c) => c.name === name);
  if (ex) ex.data = snap;
  else config.layouts.custom.push({ name, data: snap });
  saveConfig();
  broadcast('layouts-changed', {});
  olog('📐 已保存布局「' + name + '」');
  return { ok: true };
});
// 用当前排布重新收录默认布局（布局卡右键触发）——原样快照，零偏差；删过默认的（noDefault）在此复活
ipcMain.handle('layout-set-default', () => {
  const snap = captureLayout();
  if (!Object.keys(snap.cards).length && !snap.hub) return { ok: false, error: '当前没有开着的卡片' };
  config.layouts.default = snap;
  config.layouts.noDefault = false;
  saveConfig();
  broadcast('layouts-changed', {});
  olog('📐 已用当前排布原样收录为默认布局');
  return { ok: true };
});
// 删布局：自定义按名删；'__default'=删默认布局（第21轮用户裁定：内置布局不再写死，可删；noDefault 记住不自动长回来）
ipcMain.handle('layout-delete', (_e, name) => {
  if (name === '__default') {
    config.layouts.default = null;
    config.layouts.noDefault = true;
    olog('📐 已删除默认布局（右键「存当前」可用当前排布重新收录）');
  } else {
    config.layouts.custom = (config.layouts.custom || []).filter((c) => c.name !== name);
  }
  saveConfig();
  broadcast('layouts-changed', {});
  return { ok: true };
});
// 球中键「快速切换布局」：默认→自定义1→自定义2→…→默认 循环；游标只在内存里（重启从默认起）
let layoutCursor = -1;
ipcMain.handle('layout-next', () => {
  const seq = [];
  if (config.layouts.default) seq.push({ name: '__default', data: config.layouts.default });
  for (const c of (config.layouts.custom || [])) if (c && c.data) seq.push({ name: c.name, data: c.data });
  if (!seq.length) { olog('📐 还没有任何布局：先在「快速布局」卡存一个', 'err'); return { ok: false, error: '无布局' }; }
  layoutCursor = (layoutCursor + 1) % seq.length;
  const t = seq[layoutCursor];
  olog('📐 切换布局: ' + (t.name === '__default' ? '默认' : t.name) + '（' + (layoutCursor + 1) + '/' + seq.length + '）');
  applyLayoutData(JSON.parse(JSON.stringify(t.data)), layoutPersistStacks(t.name));
  return { ok: true, name: t.name };
});

ipcMain.handle('get-modules', () => ctx.MODULES_ALL || MODULES);   // 控制台要看到学员特供占位（灰气泡）

// 镜面捕获源：整块主屏幕（镜面引擎已退役，保留IPC兼容老页面调用）
ipcMain.handle('get-ps-source', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const primary = sources.find((s) => s.display_id === String(screen.getPrimaryDisplay().id)) || sources[0];
    return primary ? primary.id : null;
  } catch (e) {
    try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [main] getSources异常: ' + (e && e.message) + '\n'); } catch {}
    return null;
  }
});

// 【诊断自检】启动6秒后用真实窗口空跑一次拉伸吸附数学（不动任何窗口），结果落glass.log
app.whenReady().then(() => setTimeout(() => {
  try {
    const vis = Object.entries(cardWins).filter(([, w]) => w && !w.isDestroyed() && w.isVisible());
    if (vis.length < 2) { ctx.dlog('[snaptest] 可见卡不足2张，跳过'); return; }
    const [idA, a] = vis[0], [idB, b] = vis[1];
    const ab = a.getBounds(), bb = b.getBounds();
    const st = { x: ab.x, y: ab.y, w: ab.width, h: ab.height };
    const bVisW = bb.width - 2 * insetOf(b);
    const near = Math.round(bVisW + 2 * insetOf(a)) + 5;   // 与b等宽差5px，应触发吸附
    const out = snapStretchW(a, st, near, 'right');
    ctx.dlog('[snaptest] a=' + idA + ' b=' + idB + ' 输入宽=' + near + ' 输出宽=' + out
      + ' b可见宽=' + bVisW.toFixed(1)
      + ' → ' + (out !== near ? '吸附生效(Δ=' + (out - near) + ')' : '吸附未生效!'));
  } catch (e) { ctx.dlog('[snaptest] 异常: ' + (e && e.message)); }
}, 6000));

ctx.broadcast = broadcast;
ctx.cardWins = cardWins;
ctx.glassWinOpts = glassWinOpts;   // 看图层等非卡牌窗口复用同一套透明窗选项（0913）
ctx.getBallWin = () => ballWin;
ctx.createBallWindow = createBallWindow;
ctx.toggleHub = toggleHub;
ctx.openCard = openCard;
ctx.broadcastOpenStates = broadcastOpenStates;
ctx.captureLayout = captureLayout;
ctx.restoreStacks = restoreStacks;
ctx.recoverAllWindows = recoverAllWindows;
