// 卡牌只浮在 PS 之上（0909用户裁定；设置里滑块开关 ui.psOnlyTop，0909 晚改为**默认开**——默认关时用户根本不知道有这功能，照样反馈"挡浏览器"）
// 裁决（每 100ms）三态：前台是 PS 主窗或橙子自己 → 卡牌置顶；前台是别的程序（浏览器等）→ 撤掉卡牌置顶并把前台窗口抬一次
//   （Windows 摘 TOPMOST 的窗口落在非置顶层最上面，仍盖着浏览器，必须再抬前台窗口才真正沉下去，坑158）；
//   前台是 PS 的弹窗/浮动面板（0910 子开关 ui.psDialogTop，默认开）→ 卡牌摘顶后插到 PS 主窗正上方、全部 PS 弹窗之下
//   （Camera Raw/滤镜库/液化/曲线一开就不用先关卡牌；弹窗赢过「拉回最前」）。球和控制台永远置顶。PS 没开也一样裁决。
// 「拉回最前」= 手动覆盖：无条件把全部卡牌置顶到 PS 之上（球/控制台本来就在最前），一直保持到用户**点进别的程序**为止；
//   点橙子自己的窗口（球/控制台/卡牌）同样进入覆盖——用户在用橙子就该看得见卡牌。点击判定靠轮询鼠标键+光标下窗口，
//   与前台变化独立（球/卡牌 focusable:false，点它们前台不变，光靠前台事件永远等不到"用户回到浏览器"）。
// 实现只有一条路：主进程内 koffi 直调 user32（100ms 轮询，单次 <1µs，无外部进程）。
//   ⚠0911 拆掉了原来的"PowerShell 助手"退避通道：它会在任务管理器里多出一个 powershell.exe 条目、常驻一个进程，
//   而且正是被安全软件拦的那类调用。koffi 加载失败时直接不用本功能（日志明说），卡牌保持普通置顶——不降级到外部进程。
// ⚠与置顶看门狗/assertTopmost 的关系：撤置顶是"主动撤下"，看门狗与全员重申一律跳过卡牌（windows.js cardsTopSuppressed），否则自己跟自己打架（坑61/160）。
const ctx = require('./ctx');
let app = null;
try { app = require('electron').app; } catch (e) {}

const config = ctx.config;
const isPS = (name) => /^photoshop/i.test(String(name || ''));
// 「PS 弹窗/浮动面板优先」子开关（0910 用户裁定，默认开）：只在「只浮在PS之上」开着时有意义
const dialogOn = () => !(config.ui && config.ui.psDialogTop === false);

// 裁决（纯函数，smoke 直测）：返回 true=撤掉卡牌置顶（别的程序在前台）
function decide(s) {
  if (!s.enabled) return false;
  if (s.override) return false;          // 「拉回最前」/点了橙子自己的窗口：覆盖中
  if (!s.fgPid) return false;            // 还没拿到前台信息
  if (s.fgPid === s.selfPid) return false;   // 前台是橙子自己（卡牌输入框拿焦点等）
  if (isPS(s.fgName)) return false;      // 前台是 PS（含其对话框，同进程）
  return true;
}
// 三态裁决（0910）：'top'=卡牌置顶 / 'other'=别的程序在前台→撤顶沉下去 /
// 'dialog'=PS 的弹窗或浮动面板在前台（Camera Raw/滤镜库/液化/曲线/拖出来的图层面板…都是主窗的 owned 窗）
//   → 卡牌摘顶后插到 PS 主窗正上方、全部 PS 弹窗之下。用户裁定"弹窗赢"：连「拉回最前」覆盖也让位。
function decideMode(s) {
  if (s.enabled && s.dlgOn && s.fgIsDialog && s.psMain && isPS(s.fgName)) return 'dialog';
  return decide(s) ? 'other' : 'top';
}

let state = { enabled: false, fgPid: 0, fgName: '', override: false, selfPid: process.pid, mode: '', dlgOn: true, fgAddr: '', fgIsDialog: false, psMain: null, fgDesc: '' };
let suppressed = false;
let curMode = 'top';
function log(m) { try { ctx.dlog('[fg] ' + m); } catch (e) {} }

function apply(reason) {
  const mode = decideMode(state);
  if (mode === curMode) return;
  curMode = mode;
  suppressed = mode !== 'top';   // 看门狗/全员重申/系统位核验一律跳过卡牌（两种"主动撤下"同待遇）
  log((mode === 'top' ? '卡牌置顶恢复' : mode === 'other' ? '撤卡牌置顶' : '进弹窗模式(卡牌落到 PS 主窗之上·弹窗之下)') + ' · ' + reason
    + ' · 前台=' + state.fgName + '(' + state.fgPid + ')' + (state.fgDesc ? ' ' + state.fgDesc : '') + (state.override ? ' 覆盖中' : '') + (own.active ? ' [挂靠中]' : ''));
  if (mode === 'top') { clearTimeout(retopTimer); retopTimer = null; }   // 恢复置顶时把撤顶遗留的 250ms 延迟抬前台作废（别在恢复之后再去抬 PS）
  // 挂靠模式（v5.18.38）：卡牌是 PS 主窗的 owned 窗，层序由 Windows 维护——'top'/'dialog' 都不动卡牌置顶；
  // 'other'（别的程序在前台）只需把前台窗口抬一次（Windows 激活别的程序时 PS 整组已沉下去，这里是双保险）
  if (own.active) { if (mode === 'other') { try { ctx.applyCardsTop(false, reason); } catch (e) {} retop(); } ownOverrideSync(); return; }
  try { if (ctx.applyCardsTop) ctx.applyCardsTop(mode === 'top', reason); } catch (e) {}
  if (mode === 'other') retop();   // 撤顶后必须把前台窗口再抬一次（坑158）
  else if (mode === 'dialog') { diagBudget = 2; insertCardsAboveMain('进弹窗模式'); }
}
function onForeground(pid, name) {
  if (pid === state.fgPid) return;
  state.fgPid = pid; state.fgName = name;
  // 前台切到别的程序=覆盖作废；切到 PS/自己不动覆盖（覆盖本来也是"置顶"，无冲突）
  if (pid !== state.selfPid && !isPS(name)) state.override = false;
  apply('前台变化');
  ownOverrideSync();   // 挂靠中：覆盖的临时置顶随前台归属增减（apply 同态早退时也要同步）
}
function onClick(pid, name) {
  if (pid === state.selfPid) { if (!state.override && !own.active) { state.override = true; apply('点击橙子窗口'); } return; }   // 挂靠中点卡牌不进覆盖（卡牌本就在主窗之上；进覆盖=置顶压弹窗，违背"弹窗赢"）
  if (isPS(name)) return;
  if (state.override) { state.override = false; apply('点进其他程序'); ownOverrideSync(); }
}

// ---------- 路①：koffi 原生 ----------
let nat = null, natTimer = null, retopTimer = null;
function loadNative() {
  if (nat) return nat;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll'), k = koffi.load('kernel32.dll');
    const POINT = koffi.struct('ORANGE_POINT', { x: 'long', y: 'long' });
    koffi.struct('ORANGE_RECT', { l: 'long', t: 'long', r: 'long', b: 'long' });
    nat = {
      GetForegroundWindow: u.func('void* __stdcall GetForegroundWindow()'),
      GetWindowThreadProcessId: u.func('uint32 __stdcall GetWindowThreadProcessId(void* h, _Out_ uint32* pid)'),
      GetAsyncKeyState: u.func('int16 __stdcall GetAsyncKeyState(int vk)'),
      GetCursorPos: u.func('bool __stdcall GetCursorPos(_Out_ ORANGE_POINT* p)'),
      WindowFromPoint: u.func('void* __stdcall WindowFromPoint(ORANGE_POINT p)'),
      GetAncestor: u.func('void* __stdcall GetAncestor(void* h, uint32 flags)'),
      SetWindowPos: u.func('bool __stdcall SetWindowPos(void* h, void* after, int x, int y, int cx, int cy, uint32 flags)'),
      SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(void* h)'),
      GetWindowLongW: u.func('int32 __stdcall GetWindowLongW(void* h, int i)'),
      GetWindow: u.func('void* __stdcall GetWindow(void* h, uint32 cmd)'),
      GetTopWindow: u.func('void* __stdcall GetTopWindow(void* h)'),
      GetClassNameW: u.func('int __stdcall GetClassNameW(void* h, _Out_ char16* buf, int n)'),
      GetWindowTextW: u.func('int __stdcall GetWindowTextW(void* h, _Out_ char16* buf, int n)'),
      IsWindowVisible: u.func('bool __stdcall IsWindowVisible(void* h)'),
      IsWindow: u.func('bool __stdcall IsWindow(void* h)'),
      GetWindowRect: u.func('bool __stdcall GetWindowRect(void* h, _Out_ ORANGE_RECT* r)'),
      GetWindowLongPtrW: u.func('intptr_t __stdcall GetWindowLongPtrW(void* h, int i)'),
      SetWindowLongPtrW: u.func('intptr_t __stdcall SetWindowLongPtrW(void* h, int i, intptr_t v)'),
      as: (v, t) => koffi.as(v, t),
      // 句柄→地址字符串：枚举来的是 koffi 指针（koffi.address），Electron 给的是 BigInt（koffi.as 造的指针不能再 address，实证抛错）
      addr: (p) => (typeof p === 'bigint' ? String(p) : (p ? String(koffi.address(p)) : '0')),
      OpenProcess: k.func('void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
      CloseHandle: k.func('bool __stdcall CloseHandle(void* h)'),
      QueryFullProcessImageNameW: k.func('bool __stdcall QueryFullProcessImageNameW(void* h, uint32 flags, _Out_ char16* buf, _Inout_ uint32* size)'),
      POINT,
    };
    return nat;
  } catch (e) { log('原生调用不可用（' + (e && e.message) + '），回退 PowerShell 助手'); nat = null; return null; }
}
const nameCache = new Map();
function exeName(pid) {
  if (!pid) return '?';
  const c = nameCache.get(pid); if (c) return c;
  let name = '?';
  try {
    const hp = nat.OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (hp) { const buf = Buffer.alloc(2048); const sz = [1024]; if (nat.QueryFullProcessImageNameW(hp, 0, buf, sz)) name = buf.toString('utf16le', 0, sz[0] * 2).split('\\').pop().replace(/\.exe$/i, ''); nat.CloseHandle(hp); }
  } catch (e) {}
  if (nameCache.size > 500) nameCache.clear();
  nameCache.set(pid, name);
  return name;
}
function pidOfWindow(h) { const p = [0]; try { nat.GetWindowThreadProcessId(h, p); } catch (e) {} return p[0] | 0; }
function wstr(fn, h) { try { const b = Buffer.alloc(512); const n = fn(h, b, 256); return b.toString('utf16le', 0, Math.max(0, n) * 2); } catch (e) { return ''; } }
// ---------- PS 弹窗判定（0910） ----------
// 真机探针（PS 2026）：主框架 class='Photoshop' 无 owner；曲线等对话框 class='PSFloatC' owner=主框架；
// 拖出来的浮动面板 OWL.Dock→owner OWL.ShadowView→owner 主框架。所以：前台窗有 owner（沿 owner 链到根=主框架）
// 或 class 不是 'Photoshop'（无 owner 的插件弹窗，主框架另找）= 弹窗/浮动面板。
let psMainCache = { pid: 0, h: null };
function findPsMain(pid) {
  if (psMainCache.pid === pid && psMainCache.h && nat.IsWindow(psMainCache.h)) return psMainCache.h;
  let found = null;
  try {
    let h = nat.GetTopWindow(null);
    for (let i = 0; h && i < 600 && !found; i++) {
      if (pidOfWindow(h) === pid && nat.IsWindowVisible(h) && !nat.GetWindow(h, 4) && wstr(nat.GetClassNameW, h) === 'Photoshop') found = h;
      h = nat.GetWindow(h, 2);   // GW_HWNDNEXT
    }
  } catch (e) {}
  psMainCache = { pid, h: found };
  return found;
}
function classifyFg(fg, pid) {
  let isDlg = false, main = null, desc = '';
  try {
    const owner = nat.GetWindow(fg, 4);   // GW_OWNER
    const cls = wstr(nat.GetClassNameW, fg);
    if (owner) {
      isDlg = true;
      // ⚠不能用 GetAncestor(GA_ROOTOWNER)：它沿 GetParent 走，对 WS_OVERLAPPED 风格的 owned 窗（Camera Raw 就是）返回窗口自己
      //   → "主窗"被认成 Camera Raw，卡牌插到 CR 上面、CR 重绘把自己抬回来、100ms 后再插=卡牌 10 次/秒疯狂闪烁（0910 用户实报）。
      //   改沿 GW_OWNER 链手工走到根；根不是 'Photoshop' 无 owner 的主框架就回退枚举
      let root = fg;
      for (let i = 0; i < 16; i++) { const o = nat.GetWindow(root, 4); if (!o) break; root = o; }
      main = (wstr(nat.GetClassNameW, root) === 'Photoshop' && nat.addr(root) !== nat.addr(fg)) ? root : findPsMain(pid);
    }
    else if (cls !== 'Photoshop') {
      // 无 owner 的插件弹窗：要有个像样的尺寸（下拉列表/工具提示这类小 popup 不算）
      const r = {}; nat.GetWindowRect(fg, r);
      if (r.r - r.l >= 160 && r.b - r.t >= 100) { isDlg = true; main = findPsMain(pid); }
      else main = findPsMain(pid);
    }
    else main = fg;
    if (isDlg) desc = '[' + cls + ' "' + wstr(nat.GetWindowTextW, fg).slice(0, 24) + '"]';
  } catch (e) {}
  state.fgIsDialog = isDlg && !!main;
  state.psMain = state.fgIsDialog ? main : null;
  state.fgDesc = desc;
}
// 可见卡牌的原生句柄表：addr → BrowserWindow（键用 BigInt 地址，与枚举指针的 koffi.address 同一口径）
let lastHandlesDiag = '';
function cardHandles() {
  const m = new Map();
  const wins = ctx.cardWins || {};
  let total = 0, hidden = 0, errs = '';
  for (const id in wins) {
    const w = wins[id]; total++;
    try {
      if (!w || w.isDestroyed()) continue;
      if (!w.isVisible()) { hidden++; continue; }
      m.set(nat.addr(w.getNativeWindowHandle().readBigUInt64LE(0)), w);
    } catch (e) { errs += id + ':' + (e && e.message) + ' '; }
  }
  lastHandlesDiag = 'total=' + total + ' hidden=' + hidden + ' ok=' + m.size + (errs ? ' err=' + errs.slice(0, 160) : '');
  return m;
}
// 弹窗模式的落位：每张可见卡牌按当前相对次序插到 PS 主窗正上方（=全部 PS owned 窗之下）
let insertLogAt = 0, diagArmed = false, diagBudget = 0;   // diagBudget：进弹窗模式后前 N 次"被打乱"落位都记前后快照
// 诊断快照：PS/自己 的顶层窗自顶向下（含隐藏），c=卡 C^=置顶橙子窗 P:类名 (h)=隐藏 ^=置顶
function zsig(main) {
  const out = []; let h = nat.GetTopWindow(null); const cards = cardHandles(); const mainAddr = nat.addr(main);
  for (let i = 0; h && i < 700 && out.length < 40; i++) {
    const a = nat.addr(h); const pid = pidOfWindow(h);
    if (pid === state.fgPid || pid === state.selfPid) {
      const top = (nat.GetWindowLongW(h, -20) & 8) ? '^' : ''; const vis = nat.IsWindowVisible(h) ? '' : '(h)';
      if (a === mainAddr) out.push('MAIN' + top + vis);
      else if (cards.has(a)) out.push('c' + top + vis);
      else if (pid === state.selfPid) out.push('O' + top + vis);
      else out.push('P:' + wstr(nat.GetClassNameW, h).slice(0, 8) + top + vis);
    }
    h = nat.GetWindow(h, 2);
  }
  return out.join(' ');
}
// 当前前台窗的简述（诊断）
function fgDesc() {
  try { const fg = nat.GetForegroundWindow(); return wstr(nat.GetClassNameW, fg).slice(0, 12) + '(' + pidOfWindow(fg) + ')'; } catch (e) { return '?'; }
}
function insertCardsAboveMain(reason, mainArg) {
  const main = mainArg || state.psMain;
  if (!main || !nat) return;
  try {
    const cards = cardHandles();
    if (!cards.size) { log('弹窗模式落位：没有可见卡牌句柄 ' + lastHandlesDiag); return; }
    const ordered = [];
    let h = nat.GetTopWindow(null);
    for (let i = 0; h && i < 600; i++) { if (cards.has(nat.addr(h))) ordered.push(h); h = nat.GetWindow(h, 2); }
    const diag = diagArmed || diagBudget > 0; diagArmed = false; if (diagBudget > 0) diagBudget--;
    if (diag) log('  落位前(' + reason + '): ' + zsig(main) + ' · fg=' + fgDesc());
    // 自顶向下逐张插到"主窗上一位"之后：先插的落在主窗正上方，后插的落在它下面 → 相对次序不变
    // ⚠上一位若是置顶窗（主窗已是普通层最上），insertAfter 它会把卡牌带进置顶层——改用 HWND_TOP（普通层顶）
    let fails = 0, firstPrev = '';
    for (const ch of ordered) {
      const prev = nat.GetWindow(main, 3);   // GW_HWNDPREV
      const after = (prev && !(nat.GetWindowLongW(prev, -20) & 8)) ? prev : null;
      if (diag && !firstPrev) firstPrev = prev ? (wstr(nat.GetClassNameW, prev) + (nat.IsWindowVisible(prev) ? '' : '(h)') + (after ? '' : ' →HWND_TOP')) : 'null';
      if (!nat.SetWindowPos(ch, after, 0, 0, 0, 0, 0x13)) fails++;   // NOSIZE|NOMOVE|NOACTIVATE
    }
    if (diag) log('  落位后: ' + zsig(main) + ' · 首个prev=' + firstPrev + ' 失败=' + fails);
    const now = Date.now();
    if (now - insertLogAt > 2000) { insertLogAt = now; log('弹窗模式落位 ' + ordered.length + ' 张 · ' + reason); }
  } catch (e) { log('弹窗模式落位异常: ' + (e && e.message)); }
}
// 弹窗模式的不变量：所有可见卡牌都在主窗之上、全部 PS owned 窗之下（点弹窗会连带把主窗抬到卡牌上面；
// 开卡/切牌的 moveTop 会把卡抬到弹窗上面）——每拍验一次，破了就重新落位。返回 ''=没破 / 原因串=破了（诊断用）
function cardsMisplaced(main, psPid) {
  if (!main) return '';
  const cards = cardHandles();
  if (!cards.size) return '';
  const mainAddr = nat.addr(main);
  let seenCard = false, passedMain = false, cardsBelowMain = 0;
  let h = nat.GetTopWindow(null);
  for (let i = 0; h && i < 600; i++) {
    const a = nat.addr(h);
    if (a === mainAddr) passedMain = true;
    else if (cards.has(a)) { if (passedMain) cardsBelowMain++; seenCard = true; }
    else if (!passedMain && seenCard && nat.IsWindowVisible(h) && pidOfWindow(h) === psPid) {   // PS 窗压在卡牌下面
      return 'PS窗夹在卡牌之间: ' + wstr(nat.GetClassNameW, h) + ' "' + wstr(nat.GetWindowTextW, h).slice(0, 20) + '" owner=' + nat.addr(nat.GetWindow(h, 4));
    }
    h = nat.GetWindow(h, 2);
  }
  return cardsBelowMain > 0 ? ('主窗压在 ' + cardsBelowMain + ' 张卡牌之上') : '';
}
// 反复打乱的诊断（0910 用户实报 Camera Raw 上悬停/点击卡牌疯狂闪烁）：1 秒内落位 ≥4 次就把原因记日志（2 秒一条）
// ⚠0911 去掉了"退避 2 秒不再落位"：挂靠模式下层序由 Windows 维护，不存在"我们和 PS 互抬"，
// 退避只会让卡牌多压在面板上 2 秒（用户实报"来回点就卡住"的放大器）。诊断日志保留——真出现互抬要能从日志看出来。
let churn = [], churnLogAt = 0;
function noteChurn(reason) {
  const now = Date.now();
  churn.push(now); churn = churn.filter((t) => now - t < 1000);
  if (churn.length >= 4 && now - churnLogAt > 2000) {
    churnLogAt = now; diagArmed = true;
    log('⚠层序反复被打乱 ' + churn.length + '次/秒 · ' + reason + ' · 当前: ' + zsig(own.main || state.psMain));
  }
}
let btnDown = false;
function nativeTick() {
  try {
    const fg = nat.GetForegroundWindow();
    const pid = pidOfWindow(fg);
    // 同一进程内主窗↔弹窗切换 pid 不变，按前台句柄变化判弹窗；先分类再报前台，apply 时状态已就绪
    const addr = nat.addr(fg);
    const winChanged = addr !== state.fgAddr;
    if (winChanged) {
      state.fgAddr = addr;
      if (pid && isPS(exeName(pid))) classifyFg(fg, pid);
      else { state.fgIsDialog = false; state.psMain = null; state.fgDesc = ''; }
    }
    if (pid && pid !== state.fgPid) onForeground(pid, exeName(pid));
    else if (winChanged) apply('前台窗口变化');
    ownTick();
    if (!own.active && curMode === 'dialog') { const why = cardsMisplaced(state.psMain, state.fgPid); if (why) { noteChurn(why); insertCardsAboveMain('层序被打乱'); } }
    // 鼠标任一键的"按下沿"：光标下顶层窗口属于谁
    const down = ((nat.GetAsyncKeyState(1) | nat.GetAsyncKeyState(2) | nat.GetAsyncKeyState(4)) & 0x8000) !== 0;
    if (down && !btnDown) {
      const pt = {}; if (nat.GetCursorPos(pt)) {
        const w = nat.GetAncestor(nat.WindowFromPoint(pt), 2);
        const cp = pidOfWindow(w);
        if (cp) onClick(cp, exeName(cp));
        // ⚠0911 用户实报路径的补救：这一下点在 PS 上（画布/浮动面板），而输入框聚焦可能已经把前台抢到橙子、
        // 把那张卡举到了面板之上——此刻立刻收缩那张卡 + 标记补按 + 就地重落层序，把暴露窗口压到最短。
        const cn = cp ? exeName(cp) : '';
        // 用户这一下落在 PS 上（画布/浮动面板）：立刻就地把卡牌压回主窗正上方，不等下一拍、不看前台归属。
        // ⚠这是 0911 用户实报"连点输入框再点 PS 浮动面板，卡牌压在面板上"的正解——PS 浮动面板**不激活自己**
        // （真机实测点面板后前台仍是主窗），面板不参与抢层，卡牌只能靠我们纠正；而 want-focus 期间前台可能还在
        // 橙子身上，老条件 `前台==PS` 就把这次纠正跳过了。
        if (cp && cp !== state.selfPid && isPS(cn) && own.active && !own.topmost) {
          const why = cardsMisplaced(own.main, own.psPid);
          if (why) insertCardsAboveMain('点进 PS：' + why, own.main);
        }
      }
    }
    btnDown = down;
  } catch (e) { log('原生轮询异常: ' + (e && e.message)); }
}

// ---------- 挂靠模式（0910 v5.18.38，用户实报 v5.18.37 "点弹窗全体闪 / 个别卡牌仍遮挡 / 已开的面板被遮"） ----------
// 根因：卡牌不是 PS 主窗的 owned 窗——用户每点一次弹窗，Windows 把 owner 组整体抬起压过卡牌，100ms 后再插回=每点一闪；
// 卡牌置顶时又必然压住浮动面板。改=PS 主窗在时把每张可见卡牌 SetWindowLongPtr(GWLP_HWNDPARENT) 挂到主窗名下：
// Windows 自己保证 owned 永远在 owner 之上、被激活的弹窗/面板之上，不用轮询纠正；PS 最小化卡牌跟着藏、切到浏览器整组沉下去。
// 跨进程 owner 实验（tools/_ownexp）：owner 最小化/还原卡牌跟随；owner 进程被杀卡牌不受影响（Windows 只清 owner 指针）。
// 挂靠期间卡牌不置顶（置顶=压弹窗）；「拉回最前」只在前台不是 PS 时把卡牌临时置顶（压浏览器），点进别的程序解除。
let own = { active: false, main: null, mainAddr: '', psPid: 0, lastScan: 0, topmost: false };
const ownWanted = () => !!(state.enabled && state.dlgOn && nat);
// 0911：wantFocus 时窗口的前台主动交还（输入框失焦后立刻把前台还给 PS，不等轮询发现）
ctx.returnForeground = () => {
  if (!nat || !own.main || !own.active) return;
  try { nat.SetForegroundWindow(own.main); nat.BringWindowToTop(own.main); } catch (e) {}
};
function scanPsMain() {
  let h = nat.GetTopWindow(null);
  for (let i = 0; h && i < 700; i++) {
    if (nat.IsWindowVisible(h) && !nat.GetWindow(h, 4) && wstr(nat.GetClassNameW, h) === 'Photoshop') { const pid = pidOfWindow(h); if (isPS(exeName(pid))) return h; }
    h = nat.GetWindow(h, 2);
  }
  return null;
}
function ownerOf(h) { try { return String(nat.GetWindowLongPtrW(h, -8)); } catch (e) { return '?'; } }
function setOwner(h, ownerNum) {
  nat.SetWindowLongPtrW(h, -8, ownerNum);
  nat.SetWindowPos(h, null, 0, 0, 0, 0, 0x13 | 0x20);   // SWP_FRAMECHANGED：owner 变化落地
}
function ownTick() {
  if (!ownWanted()) { if (own.active) ownRelease('开关关闭'); return; }
  if (own.main && !nat.IsWindow(own.main)) ownRelease('PS 主窗消失');
  if (!own.main) {
    const now = Date.now();
    if (now - own.lastScan < 1000) return;
    own.lastScan = now;
    const m = scanPsMain();
    if (!m) return;
    own.main = m; own.mainAddr = nat.addr(m); own.psPid = pidOfWindow(m); own.active = true; own.topmost = false;
    log('挂靠 PS 主窗 ' + own.mainAddr + ' (pid ' + own.psPid + ')');
  }
  // 收养：可见且 owner 还不是主窗的卡牌（新开的卡、收纳释放出来的卡、刚重启的 PS）
  const cards = cardHandles();
  let adopted = 0;
  for (const [a, w] of cards) {
    if (a === own.mainAddr) continue;
    const h = nat.as(BigInt(a), 'void*');
    if (ownerOf(h) === own.mainAddr) continue;
    try { w.setAlwaysOnTop(false); } catch (e) {}
    try { setOwner(h, Number(own.mainAddr)); adopted++; } catch (e) { log('收养失败 ' + (e && e.message)); }
  }
  if (adopted) {
    insertCardsAboveMain('收养 ' + adopted + ' 张', own.main);
    // 「拉回最前」临时置顶期间新收养的卡（刚开的卡、刚释放的卡）：上面收养时把它 setAlwaysOnTop(false) 了，
    // 而 ownOverrideSync 会被同态早退（want===own.topmost）挡住＝这张卡再也抬不起来，埋在浏览器底下（0915同源修）
    if (own.topmost) {
      const wins = ctx.cardWins || {};
      for (const id in wins) { const w = wins[id]; try { if (w && !w.isDestroyed() && w.isVisible()) w.setAlwaysOnTop(true, 'screen-saver'); } catch (e) {} }
      log('收养后重申临时置顶（拉回最前中）');
    }
  }
  // 层序自纠：我们自己的 moveTop（开卡/切牌/焦点）会把卡抬到弹窗/面板之上，压回主窗正上方。
  // ⚠0911 修：原来只在"前台==PS 且不在退避中"时纠正，两个条件各留一个洞——
  //   ①点卡牌输入框会让那张卡临时可聚焦并抢到前台（前台==自己），此时纠正被跳过，卡牌就一直压在浮动面板上；
  //     而 PS 的浮动面板**不激活自己**（真机实测点面板后前台仍是主窗），面板永远不会把自己抬回去 → 死局。
  //     用户实报的正是这条路径（"输入框和PS浮窗来回点，提示词卡卡在图层面板上边"）。
  //   ②退避（churnBackoffUntil）本是防"我们和 Camera Raw 互抬"的老机制，挂靠模式下层序由 Windows 维护、
  //     不存在互抬，退避只会让misplace多停 2 秒。
  // 现在：挂靠中、非临时置顶就纠正，与前台归属无关。正在打字的那张卡照样压回面板之下——用户裁定"弹窗/面板赢"，
  // 且键盘焦点与 z 序无关，压下去仍然能继续打字。
  if (!own.topmost) {
    const why = cardsMisplaced(own.main, own.psPid);
    if (why) { noteChurn(why); insertCardsAboveMain('层序被打乱：' + why, own.main); }
  }
}
function ownRelease(reason) {
  const wins = ctx.cardWins || {};
  let n = 0;
  for (const id in wins) {
    const w = wins[id];
    try {
      if (!w || w.isDestroyed()) continue;
      const h = nat.as(w.getNativeWindowHandle().readBigUInt64LE(0), 'void*');
      if (ownerOf(h) !== '0') { setOwner(h, 0); n++; }
    } catch (e) {}
  }
  log('解除挂靠 ' + n + ' 张 · ' + reason);
  own = { active: false, main: null, mainAddr: '', psPid: 0, lastScan: 0, topmost: false };
  curMode = '';   // 逼 apply 重新裁决（PS 关了→按老规矩置顶/撤顶）
  apply('解除挂靠');
}
// 挂靠中的「拉回最前」：前台不是 PS（浏览器等）才把卡牌置顶压过去；前台是 PS 时弹窗赢，不动
function ownOverrideSync() {
  if (!own.active) return;
  const want = !!(state.override && state.fgPid && state.fgPid !== state.selfPid && !isPS(state.fgName));
  if (want === own.topmost) return;
  own.topmost = want;
  const wins = ctx.cardWins || {};
  for (const id in wins) { const w = wins[id]; try { if (w && !w.isDestroyed() && w.isVisible()) w.setAlwaysOnTop(want, 'screen-saver'); } catch (e) {} }
  log('挂靠中' + (want ? '临时置顶（拉回最前·压过 ' + state.fgName + '）' : '撤临时置顶（override=' + state.override + ' 前台=' + state.fgName + '(' + state.fgPid + ')' + (state.fgPid === state.selfPid ? '=自己' : '') + '）'));
  if (!want) insertCardsAboveMain('撤临时置顶', own.main);
}
function nativeRetop() {
  try { const fg = nat.GetForegroundWindow(); if (fg && pidOfWindow(fg) !== state.selfPid) nat.SetWindowPos(fg, null, 0, 0, 0, 0, 0x13); } catch (e) {}   // HWND_TOP + NOSIZE|NOMOVE|NOACTIVATE
}
function retop() {
  nativeRetop();
  clearTimeout(retopTimer);
  retopTimer = setTimeout(nativeRetop, 250);
}

function start() {
  if (state.mode) return;
  if (!loadNative()) {
    // ⚠0911：不再退避到 PowerShell 常驻助手（任务管理器里多一条 powershell.exe、常驻一个进程，且正是安全软件拦的那类调用）
    state.mode = '';
    try { ctx.olog('📌 「卡牌只浮在PS之上」没能启动：原生窗口接口不可用（koffi 加载失败）——本功能暂不生效，卡牌保持普通置顶', 'err'); } catch (e) {}
    log('koffi 不可用，不启动前台监测');
    return;
  }
  state.mode = 'native';
  btnDown = false;
  natTimer = setInterval(nativeTick, 100);
  log('原生监测已启动（koffi，100ms）');
}
function stop() {
  if (state.mode === 'native') { if (own.active) ownRelease('监测停止'); clearInterval(natTimer); natTimer = null; clearTimeout(retopTimer); retopTimer = null; log('原生监测已停止'); }
  state.mode = '';
}
// 设置开关变化/启动时同步：开=起监测；关=停监测并把卡牌置顶还回去；子开关（弹窗优先）变化=重新裁决
function sync() {
  const on = !!(config.ui && config.ui.psOnlyTop);
  state.dlgOn = dialogOn();
  if (on === state.enabled && (on === !!state.mode)) { apply('设置变化'); return; }
  state.enabled = on;
  if (on) start();
  else { stop(); state.fgPid = 0; state.fgName = ''; state.fgAddr = ''; state.fgIsDialog = false; state.psMain = null; state.override = false; apply('开关关闭'); }
}

ctx.cardsTopSuppressed = () => suppressed || (own.active && !own.topmost);   // 挂靠中卡牌不置顶，看门狗/全员重申/系统位核验都别碰
// 卡牌此刻是否被**外部程序**埋着（前台既不是 PS 也不是自己）——挂靠模式下 cardsTopSuppressed 恒为 true 是常态，
// 判"要不要为用户拉回来"必须用这条更窄的：只有别的程序在前台压着，用户点了气泡才会"什么也没看见"（0915）
ctx.cardsBuried = () => !!(state.enabled && decide(state));
// 给 windows.js want-focus / raiseCard 用：抬过卡牌之后立刻把层序压回，不等下一拍（把"卡压面板"的暴露窗口从 100ms 压到 ~0）
ctx.fgwatchLayerFix = (why) => {
  try { if (own.active && !own.topmost) insertCardsAboveMain(why || '抬卡后压回', own.main); } catch (e) {}
};
ctx.fgwatchSync = sync;
ctx.fgwatchStop = stop;   // 系统关机路径：关闭前台监测（无外部进程可留，保留调用点）
// 「拉回最前」（球右键菜单 / 托盘）：手动覆盖——全部卡牌置顶到 PS 之上，保持到用户点进别的程序
// （PS 弹窗在前台时不生效：用户裁定"弹窗赢"；挂靠中只在前台不是 PS 时临时置顶）
ctx.fgwatchOverride = () => {
  if (!state.enabled) return;
  state.override = true;
  apply('拉回最前');
  if (own.active) { ownOverrideSync(); if (!own.topmost) log('拉回最前：挂靠中且前台是 PS，弹窗/面板赢，不置顶 ' + state.fgDesc); }
  else if (curMode === 'dialog') log('拉回最前被弹窗模式让位 ' + state.fgDesc);
};
ctx.fgwatchDecide = decide;   // smoke 直测
ctx.fgwatchDecideMode = decideMode;
// 给 windows.js want-focus 用的原生句柄（koffi 不可用时返回 null，调用方自行跳过）
ctx.win32 = () => loadNative();
ctx.win32PidOf = (h) => (nat ? pidOfWindow(h) : 0);
// Windows 真实 TOPMOST 位（WS_EX_TOPMOST=0x8）：true/false；koffi 不可用或读失败=null（调用方当"不知道"处理）
ctx.win32IsTopmost = (win) => {
  try {
    if (!loadNative()) return null;
    const h = nat.as(win.getNativeWindowHandle().readBigUInt64LE(0), 'void*');
    return (nat.GetWindowLongW(h, -20) & 8) !== 0;
  } catch (e) { return null; }
};
ctx.fgwatchState = () => Object.assign({ suppressed, curMode, owned: own.active, ownMain: own.mainAddr || null, ownTopmost: own.topmost }, state, { psMain: state.psMain ? nat.addr(state.psMain) : null });
try { require('electron').ipcMain.handle('fgwatch-state', () => ctx.fgwatchState()); } catch (e) {}   // 真机测试脚本读裁决状态

if (app && app.whenReady) {
  app.whenReady().then(() => setTimeout(sync, 1500));
  app.on('before-quit', stop);
}
module.exports = { decide, decideMode };
