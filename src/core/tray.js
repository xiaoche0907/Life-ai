// 系统托盘（0909用户要求"把软件做到任务栏里"）：任务栏右下角常驻来福图标，卡牌再多也有一个固定入口
// 左键=拉回最前（收纳中先释放，再无条件把全员拉到 PS 之上）；右键=菜单（收纳/释放 · 拉回最前 · 控制台 · 设置 · 退出）
// 图标=src/icon-256.png（与安装包同一张，打包 files 含 src/**，asar 内路径 nativeImage 可直读）
const { app, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const ctx = require('./ctx');

let tray = null;

function pullFront(tag) {
  try { if (ctx.isGathered && ctx.isGathered() && ctx.ballGatherToggle) ctx.ballGatherToggle(); } catch (e) {}
  try { if (ctx.fgwatchOverride) ctx.fgwatchOverride(); } catch (e) {}   // 「只浮在PS之上」模式下=手动覆盖到下次前台变化
  try { if (ctx.assertTopmost) ctx.assertTopmost(tag, true); } catch (e) {}
}
function buildMenu() {
  const gathered = !!(ctx.isGathered && ctx.isGathered());
  return Menu.buildFromTemplate([
    { label: gathered ? '释放卡牌' : '收纳卡牌', click: () => { try { ctx.ballGatherToggle && ctx.ballGatherToggle(); } catch (e) {} } },
    { label: '拉回最前', click: () => pullFront('托盘菜单') },
    { type: 'separator' },
    { label: '控制台', click: () => { try { ctx.toggleHub && ctx.toggleHub(true); } catch (e) {} } },
    { label: '设置', click: () => { try { ctx.openCard && ctx.openCard('settings'); ctx.revealForUser && ctx.revealForUser('托盘·设置'); } catch (e) {} } },
    { type: 'separator' },
    { label: '退出来福', click: () => app.quit() },
  ]);
}
function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(ctx.SRC, 'icon-256.png'));
    tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 32, height: 32 }));
    tray.setToolTip('来福');
    tray.on('click', () => pullFront('托盘左键'));
    tray.on('right-click', () => { try { tray.popUpContextMenu(buildMenu()); } catch (e) {} });
    try { ctx.dlog('[tray] 托盘图标已创建'); } catch (e) {}
  } catch (e) {
    try { ctx.dlog('[tray] 创建失败: ' + (e && e.message)); } catch (e2) {}
  }
}

app.whenReady().then(() => setTimeout(createTray, 800));
ctx.getTray = () => tray;
