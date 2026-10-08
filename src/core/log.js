// 统一日志：olog(生图日志流,日志卡订阅) + glass.log诊断文件 + dlog简写
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

// 诊断日志文件（桥接握手/capture/回图/校色装载全在里面）
const glassLogPath = () => path.join(app.getPath('temp'), 'orange-glass.log');
const dlog = (msg) => { try { fs.appendFileSync(glassLogPath(), new Date().toISOString() + ' ' + msg + '\n'); } catch {} };
ipcMain.on('glass-log', (_e, msg) => {
  try { fs.appendFileSync(glassLogPath(), new Date().toISOString() + ' ' + msg + '\n'); } catch {}
});

// ---------- 报错人话化：规则表与翻译在 err-human.js（纯模块，preload 侧也用它兜 IPC 返回值） ----------
const { humanizeErr } = require('./err-human');
ctx.humanizeErr = humanizeErr;
// preload 在沙箱里不能 require 本地模块 → 给它开一条 IPC 专线（preload 的 humanizeResult 闸门要用）
ipcMain.on('humanize-err', (e, msg) => { try { e.returnValue = humanizeErr(msg); } catch { e.returnValue = msg; } });

// ---------- Key卫生：挂到 ctx 供各渠道取Key处使用（纯函数在 key-hygiene.js，smoke 直测） ----------
const KH = require('./key-hygiene');
ctx.cleanKey = KH.cleanKey;
ctx.keyIssue = KH.keyIssue;

// ---------- 生图日志：全局日志流，日志卡实时订阅 ----------
const genLog = [];
function olog(msg, type) {
  const entry = { ts: Date.now(), msg: (type === 'err' ? humanizeErr(msg) : msg), type: type || 'info' };
  genLog.push(entry);
  if (genLog.length > 500) genLog.shift();
  ctx.broadcast('olog', entry);
}
ipcMain.handle('get-olog', () => genLog);
// 渲染端写生图日志（0905用户裁定：卡片上不许挂红字报错，一律进生图日志）
ipcMain.on('olog-write', (_e, p) => { try { olog(String((p && p.msg) || ''), (p && p.type) || 'info'); } catch (e) {} });
ipcMain.on('clear-olog', () => { genLog.length = 0; ctx.broadcast('olog-clear', {}); });

ctx.glassLogPath = glassLogPath;
ctx.dlog = dlog;
ctx.olog = olog;
