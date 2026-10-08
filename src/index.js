// 橙子桌面版 - 主进程入口（拆分版，2026-08-28从单体main.js重组）
// 作者：橙子是oranG
// 架构：悬浮球(开关) -> 主面板(功能集合) -> 功能卡片(独立窗口,可拖出任意摆放)
// 模块注册表 modules.json 驱动：加功能=加一行+一个html，互不影响
// core/各模块通过 core/ctx.js 共享能力；旧单体实现保留在 src/main.js（回滚=package.json的main改回去）
const { app, ipcMain } = require('electron');
const _path = require('path');

// 单实例锁的钥匙=userData路径——显式钉死（0904双开实证：开发版electron与安装版橙AIper.exe
// 同时在跑、PS桥接连在其中一个身上，另一个批处理报"没有打开文档"。钥匙必须两版完全一致）
try { app.setPath('userData', _path.join(app.getPath('appData'), '橙AIper')); } catch (e) {}

// 0911：任务管理器折叠——显式设 AppUserModelID（与 package.json appId 一致），所有进程共享同一 AUMI
// 不设=18个橙AIper.exe进程全折叠成1行但AUMI为空，NSIS快捷方式的AUMI是com.orange.aiper，进程却没有
if (process.platform === 'win32') {
  try { app.setAppUserModelId('com.orange.aiper'); } catch {}
}

// 0916 用户实报（修了多次仍在）："右键进度卡看大图 → 收起后卡牌动画冻住不动，点一下 PS 才活"。
// 层序修法（收起时重申置顶+插回主窗之上）上一版已加仍复现 → 不是层序。指纹对得上 Chromium 的 Windows
// 原生遮挡检测（CalculateNativeWinOcclusion）：全屏看图窗盖上来时它把底下的卡判成"被完全遮住"→停渲染，
// 看图窗收起后它不重算，直到点 PS 引发一次系统前台/层序事件才醒。悬浮窗类软件的标准处方=整个关掉：
// 卡牌不管被什么盖住都照常渲染（本就常驻置顶，几乎不会真被遮，多出的渲染量可忽略）。必须在 app ready 前设。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 单实例锁：双开=两套透明窗口叠一起互相挡鼠标（EADDRINUSE后半死实例的窗口盖在新窗口上），必须拒绝
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {

const ctx = require('./core/ctx');
// 装配顺序：state(config)先行 → 日志 → 窗口(broadcast) → 桥接 → 渠道 → 库 → 生图 → 对话 → Forge → 杂项
require('./core/state');
require('./core/log');
require('./core/windows');
require('./core/bridge');
require('./core/bridge-install');
require('./core/fgwatch');   // 卡牌只浮在PS之上：前台窗口助手 + 卡牌置顶裁决（0909）
require('./core/com-bridge');   // COM自动化兜底通道：UXP桥接缺席时全版本PS零安装可用
require('./core/providers');
require('./core/plib');
require('./core/plib-import');   // 提示词批量导入/搬运（0906）
require('./core/gen');
require('./core/viewer');   // 看图层：进度卡右键大图（整屏压暗模糊/滚轮切图/点图贴回，0913）
require('./core/chat');
require('./core/forge');
require('./core/comfy');   // ComfyUI 卡：工作流库切换+快捷参数+选区喂图跑图贴回（0916，免装节点走原生 HTTP/WS 接口）
require('./core/relight');
require('./core/glow');   // 辉光：本地实时预览 → 黑底辉光层贴回（0912，独立模块）
require('./core/autofix');   // 自动修图：文件夹批量工序流水线→分层PSD（0905）
require('./core/qpresets');   // 快捷预设：修图师标准动作一键执行，预设=文档夹里的 JSON（0912）
require('./core/misc');
require('./core/tray');   // 系统托盘：任务栏右下角常驻入口（0909用户要求"做到任务栏里"）

// ---------- 系统关机/注销：立即落盘并退出（0909用户实拍"正在关闭 21 个应用"每张卡一行阻止关机）----------
// 病因：Windows 关机给每个顶层窗发 WM_ENDSESSION，Electron 只发 'session-end' 事件不退出，进程赖到系统超时才被杀，
//      关机画面就把 17 张卡逐个列出来。实测（对窗口直接发 WM_ENDSESSION）：21 个进程 4 秒后仍全活着。
// 修法：任一窗口收到 session-end → 同步写盘（配置/词库）→ 停掉前台助手 → app.exit(0)。app.exit 不走 before-quit，所以这里手动 flush。
let shuttingDown = false;
ctx.shutdownNow = (why) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try { ctx.dlog('[quit] 系统会话结束(' + why + ')：立即落盘并退出'); } catch {}
  try { ctx.flushConfig && ctx.flushConfig(); } catch {}
  try { ctx.flushPlib && ctx.flushPlib(); } catch {}
  try { ctx.flushTasks && ctx.flushTasks(); } catch {}   // 进度索引（0913 持久化）
  try { ctx.fgwatchStop && ctx.fgwatchStop(); } catch {}
  app.exit(0);
};
app.on('browser-window-created', (_e, w) => {
  try { w.on('session-end', () => ctx.shutdownNow('session-end')); } catch {}
});

app.on('second-instance', () => {
  // 二次启动时把悬浮球亮出来提示已在运行
  const b = ctx.getBallWin();
  if (b && !b.isDestroyed()) { b.show(); b.focus(); }
});

// ---------- 启动：恢复上次的窗口布局 ----------
app.whenReady().then(() => {
  ctx.loadConfig();
  ctx.startBridgeServer();
  ctx.createBallWindow();
  const config = ctx.config;
  // 开机编排：小橙子先亮 → 其余窗口静默加载（球上波纹+进度环）→ 齐了从球心绽放飞位
  ctx.beginBootChoreo();
  if (config.hubOpen) ctx.toggleHub(true);
  for (const [id, c] of Object.entries(config.cards)) {
    if (c.open && ctx.modById[id]) ctx.openCard(id);
  }
  ctx.restoreStacks();   // 融合叠按上次状态重建（叠放/当前页/整叠隐藏）
  ctx.recoverAllWindows();   // 历史配置里跑到屏幕外的窗口开机即拉回有效工作区
  ctx.finishBootChoreo();   // 等加载齐(或4秒兜底)后绽放

  // 默认布局收录：还没有默认布局时，把当前排布原样存为默认
  setTimeout(() => {
    if (!config.layouts.default) {
      const snap = ctx.captureLayout();
      if (Object.keys(snap.cards).length || snap.hub) {
        config.layouts.default = snap;
        ctx.saveConfig();
        ctx.olog('📐 已将当前布局原样收录为默认布局');
      }
    }
  }, 3000);

  // （0827的开机8秒"词条→Forge注入"自检已移除：它每启动都openCard('forge')，用户若在那10秒内收纳，
  //   Forge会被单独show在球心=“收纳后只剩Forge”的元凶。该检查已搬进 tools/smoke.js）
});

app.on('window-all-closed', () => app.quit());
ipcMain.on('app-quit', () => app.quit());   // 退出开关（hub电源钮/设置卡退出按钮）
}   // 单实例锁else闭合
