// 本地WS服务（软件 <-> PS桥接件）：连接管理/版本握手/命令收发/推流转发
const { ipcMain } = require('electron');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const ctx = require('./ctx');

const WS_PORT = 40125;

let wss = null;
let psSocket = null;
let psBridgeVer = 0;   // 桥接件握手版本，<3说明PS里跑的是旧版没Reload
let cmdSeq = 0;
const pending = new Map();
let lastLutKey = '';   // LUT进度打点去重

// 桥接件开机自装选框工具预设的结果：exists=已有跳过 / imported=刚导入 / err:...=失败（只有失败和刚导入才值得进日志卡）
function logPresetImport(state) {
  if (state === 'imported') ctx.olog('🧲 选框工具预设已装进PS（矩形选框工具→工具预设里可见）', 'ok');
  else if (String(state).indexOf('err:') === 0) ctx.olog('🧲 选框工具预设自动导入失败：' + state.slice(4) + '（切一次比例会再试）', 'err');
  try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [main] presetImport=' + state + '\n'); } catch {}
}
// 握手时状态还是pending → 8s/30s/70s 三次主动问桥接件，问到终态为止（同一条socket才问，重连由新握手接手）
function pollPresetImport(socket, attempt) {
  if (attempt > 2) return;
  setTimeout(async () => {
    if (psSocket !== socket || socket.readyState !== 1) return;
    const r = await sendToPSAwait({ action: 'presetImportState', params: {} }, 8000);
    const st = r && r.ok && r.result && r.result.state;
    if (st && st !== 'pending') logPresetImport(st);
    else pollPresetImport(socket, attempt + 1);
  }, [8000, 30000, 70000][attempt]);
}

function startBridgeServer() {
  wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });
  wss.on('connection', (socket) => {
    psSocket = socket;
    psBridgeVer = 0;
    ctx.broadcast('ps-status', { connected: true, bridgeVer: 0 });
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.hello) {   // 桥接件版本握手
        psBridgeVer = msg.version || 1;
        ctx.broadcast('ps-status', { connected: true, bridgeVer: psBridgeVer });
        setTimeout(refreshPsBase, 600);   // 「跟随PS」主题：连上就同步一次PS界面明暗
        try {
          fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [main] 桥接件版本=' + psBridgeVer
            + ' 校色actions=' + (msg.colorcal || '无') + (msg.hostErr ? ' 加载错误=' + msg.hostErr : '') + '\n');
        } catch {}
        // PS里跑的是旧版插件（软件已把新版装进PS目录，但PS没重启一直跑内存里的旧版）：
        // 连上的瞬间就用人话提醒，别等用户跑图撞墙
        const CUR_BRIDGE_VER = ctx.curBridgeVer || 28;
        const fatal = ctx.bridgeFatalVers && ctx.bridgeFatalVers[psBridgeVer];
        if (fatal) {
          ctx.olog('🛑 PS里跑的来福插件 v' + psBridgeVer + ' 有致命bug（' + fatal + '）。本软件已带 v' + CUR_BRIDGE_VER + '：请**完全退出并重启一次 PS**（任务管理器里确认没有 Photoshop.exe 再开）', 'err');
        } else if (psBridgeVer < CUR_BRIDGE_VER) {
          ctx.olog('🔌 PS桥接已连接，但PS里跑的是旧版插件（v' + psBridgeVer + '→v' + CUR_BRIDGE_VER + '）——完全退出并重启一次PS才会加载新版', 'err');
        } else {
          ctx.olog('🔌 PS桥接已连接（插件 v' + psBridgeVer + '）', 'ok');   // 0908用户要求：连上要在生图日志里明说
        }
        if (msg.presetImport && msg.presetImport !== 'pending') logPresetImport(msg.presetImport);
        else if (psBridgeVer >= 52) pollPresetImport(socket, 0);   // 握手时还在查/导：稍后主动问（开机阶段的推送实证丢过）
        return;
      }
      // 桥接件开机自装选框预设的终态（v52：PS开机即查即导，不等切比例）
      if (msg.presetImport) { logPresetImport(msg.presetImport); return; }
      // 老host模块的推流消息（校色等）：统一写入生图日志 + 转发给卡片
      if (msg.push) {
        const d = msg.data || {};
        if (msg.push === 'lutProgress') {
          const pct = d.total > 0 ? Math.round(d.done / d.total * 100) : null;
          const key = (d.stage || '') + '|' + (pct == null ? '' : Math.floor(pct / 20));
          if (key !== lastLutKey) {
            lastLutKey = key;
            ctx.olog('[LUT精修] ' + (d.stage || '处理中') + (pct == null ? ' …' : ' ' + pct + '%'));
          }
        }
        else if (msg.push === 'colorCalResult') ctx.olog('[轻校准] ' + (d.message || ''), d.success ? 'ok' : 'err');
        else if (msg.push === 'lutCalResult') ctx.olog('[LUT精修] ' + (d.message || ''), d.success ? 'ok' : 'err');
        else if (msg.push === 'chartStampResult') ctx.olog('[色卡] ' + (d.ok ? '贴卡完成' : '贴卡失败: ' + (d.message || '')), d.ok ? 'info' : 'err');
        else if (msg.push === 'chartFinishResult') ctx.olog('[色卡] ' + (d.message || ''), d.success ? 'ok' : 'err');
        // 1013：桥接件的进程日志（LUT烘焙/贴卡/色卡测量等）。以前 hostCtx 没有 logToPanel，
        // 这些行全被吞了——排查"曲线没作用"这类问题时完全看不见中间数据。
        else if (msg.push === 'logToPanel') {
          const ty = (d.type === 'err' || d.type === 'warn') ? 'err' : 'info';
          ctx.olog(d.message || '', ty);
        }
        ctx.broadcast('ps-reply', msg);
        return;
      }
      const p = pending.get(msg.id);
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); p.resolve(msg); }
      else ctx.broadcast('ps-reply', msg);
    });
    socket.on('close', () => {
      if (psSocket === socket) psSocket = null;
      // 断线立即裁决（0905审计采纳）：在途命令马上失败返回，不再傻等60-180秒超时
      for (const [, pd] of pending) {
        clearTimeout(pd.timer);
        try { pd.resolve({ ok: false, error: 'PS连接已断开（命令未完成）' }); } catch (e) {}
      }
      pending.clear();
      ctx.broadcast('ps-status', { connected: false });
      try { ctx.olog('🔌 PS桥接已断开（PS关闭或插件被卸载；重新打开PS会自动重连）', 'err'); } catch (e) {}
    });
    socket.on('error', () => {});
    // 连接后自动探测captureInput能力，结果落日志便于诊断
    setTimeout(() => {
      sendToPSAwait({ action: 'captureInput', params: {} }, 15000).then((r) => {
        try {
          fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [main] captureInput探测: ok=' + r.ok
            + ' err=' + (r.error || '') + ' sel=' + JSON.stringify((r.result && r.result.selection) || null)
            + ' img=' + (r.result && r.result.image ? Math.round(r.result.image.length / 1024) + 'KB' : '无')
            + ' note=' + ((r.result && r.result.note) || '') + '\n');
        } catch {}
      });
    }, 1500);
  });
  wss.on('error', (err) => {
    console.error('[bridge]', err.message);
    try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [main] ⚠ WS桥接服务器错误: ' + err.message + '\n'); } catch (e2) {}
  });
}

function sendToPSAwait(cmd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    if (!psSocket || psSocket.readyState !== 1) {
      // COM自动化兜底（0904）：UXP桥接没连上但PS进程在跑→零安装通道顶上（全PS版本通吃）
      if (ctx.comBridge) {
        ctx.comBridge.tryCall(cmd, timeoutMs).then(resolve);
        return;
      }
      resolve({ ok: false, error: 'PS未连接：请启动PS（插件已随软件自动安装；刚装的话重启一次PS）' });
      return;
    }
    const id = 'm_' + (++cmdSeq);
    cmd.id = id;
    // timeoutMs<=0=不限时（0905用户裁定：回传不设截断——大批量贴回超180秒被误报失败，
    // 而PS那头其实还在贴；真死等由断线秒裁决兜底）
    pending.set(id, {
      resolve,
      timer: timeoutMs > 0 ? setTimeout(() => { pending.delete(id); resolve({ ok: false, error: 'PS执行超时' }); }, timeoutMs) : null,
    });
    psSocket.send(JSON.stringify(cmd));
  });
}

ipcMain.handle('ps-connected', () => !!(psSocket && psSocket.readyState === 1));

// 0908用户要求：每次生图都要在生图日志里把"桥接没连上"说出来（连上了不刷屏；没连上=每批都提醒一行）
// 返回 true=UXP桥接在线；false=离线（走COM兜底或直接失败，由调用方决定继续与否）
ctx.warnIfBridgeDown = (tag) => {
  if (psSocket && psSocket.readyState === 1) return true;
  const t = tag ? '[' + tag + '] ' : '';
  ctx.comBridge && ctx.comBridge.psProcessAlive && ctx.comBridge.psProcessAlive().then((alive) => {
    ctx.olog(t + '🔌 PS桥接未连接' + (alive
      ? '：PS在跑但插件没接上——本次走COM兜底通道（功能受限）；完全退出并重启一次PS可恢复'
      : '：PS未启动——请先打开PS（插件已随软件自动安装）'), 'err');
  });
  if (!(ctx.comBridge && ctx.comBridge.psProcessAlive)) ctx.olog(t + '🔌 PS桥接未连接：请先打开PS；刚装的话完全退出并重启一次PS', 'err');
  return false;
};

// 通用PS命令通道（校色等模块用；timeoutMs按需放大）
ipcMain.handle('ps-exec', (_e, { action, params, timeoutMs }) =>
  sendToPSAwait({ action, params: params || {} }, timeoutMs || 60000)
);

// 一键对齐（对齐卡）：全程进生图日志，报错走人话化
ipcMain.handle('align-layers', async () => {
  ctx.olog('🎯 自动对齐：选中层 → 对齐到其下方基准层…');
  const r = await sendToPSAwait({ action: 'alignLayers', params: {} }, 120000);
  if (r.ok) ctx.olog('🎯 ' + ((r.result && r.result.msg) || '对齐完成'), 'ok');
  else ctx.olog('🎯 对齐失败: ' + (r.error || ''), 'err');
  return r;
});

// 复原选区：在PS里重建任务发起时的选区
ipcMain.handle('restore-selection', (_e, ctx2) =>
  sendToPSAwait({ action: 'restoreSelection', params: { docId: ctx2.docId || null, selection: ctx2.selection || null } }, 30000)
);

// 色卡结算（手动贴回通道专用）：色卡模式下"回图后测偏→生成校正层→遮卡"这一步，
// 原先只在**自动回传/提前贴回**成功后才触发（gen.js 里 `if (chartOn && (placedOk || held))`）。
// 而 autoReturn=false 时那两条都不成立 → 用户手动点图贴回，色卡一直留在文档上、永远不出曲线
// （1013 用户实测报的 bug）。这里补上：手动贴回成功后也结算一次。
// ⚠重复调用是安全的：colorcal.host.js 的 chartFinish 结算完就 `delete _charts[docId]`，
//   第二次只会回"没有待结算的色卡任务"；而且它结算的是**文档上所有新增图层**（不是单张），
//   所以贴回第一张时就该结算，不必等整批贴完。
async function settleChartIfOn(docId) {
  try {
    if (!ctx.config || !ctx.config.gen || !ctx.config.gen.chartOn) return;
    await new Promise((r) => setTimeout(r, 700));   // 等 PS 落完图层（与 gen.js 同款等待）
    // 结果日志不用在这里写：桥接端会推 chartFinishResult，bridge.js 的 push 分支已经把它写进生图日志
    // （成功=ok、失败=err）。这里再加一句就是同一件事两行。
    // ⚠重复调用安全：PS 端结算完会把"当前图层"重新登记成底账（不再删状态），第二次进来不会重复建层。
    // 1013 诊断（落盘）：把"哪条链、拿哪个 docId 去结算、PS 回话"记下来。
    //   用户实报"提前回图没曲线、手动单点有曲线"，两条链只差这个 docId 的来源——
    //   不落盘就没法比对，所以这一行必须留。
    const r = await sendToPSAwait({ action: 'chartFinish', params: { docId: docId || null } }, 120000);
    try { ctx.dlog('[chart] settle doc=' + String(docId) + ' ok=' + !!(r && r.ok) + (r && r.error ? ' err=' + r.error : '')); } catch (e2) {}
    return r;
  } catch (e) {
    try { if (ctx.olog) ctx.olog('[色卡] 结算异常: ' + ((e && e.message) || e), 'err'); } catch (e2) {}
  }
}
ctx.settleChartIfOn = settleChartIfOn;

ipcMain.handle('place-in-ps', async (_e, payload) => {
  // 兼容两种调用：纯文件路径 / {file, ctx:{docId, selection}}
  const file = typeof payload === 'string' ? payload : payload.file;
  const pctx = (payload && payload.ctx) || {};
  const r = await sendToPSAwait({
    action: 'placeImage',
    params: { path: file, docId: pctx.docId || null, selection: pctx.selection || null, antiMode: pctx.antiMode || 0 },
  }, 0);   // 0905:手动贴回同样不限时
  try {
    const note = r.result && r.result.note;
    if (note) fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [place] ' + note + '\n');
  } catch {}
  // 色卡模式下：手动贴回成功后也要结算，否则不出曲线（老版本只有自动回传那条链会结算）
  if (r && r.ok) await settleChartIfOn(pctx.docId || null);
  return r;
});

// ---------- 「跟随PS」主题：读PS界面明暗档位→映射玻璃底色psBase，随ui-vars下发 ----------
// 浅色两档压到中灰——界面文字是白字体系，纯浅灰底会看不清（完整浅色主题是另一个工程）
const PS_GREYS = {
  kPanelBrightnessOriginal: '#1b1c20',
  kPanelBrightnessDarkGray: '#33353a',
  kPanelBrightnessMediumGray: '#54575e',
  kPanelBrightnessLightGray: '#6e7178',
};
async function refreshPsBase() {
  try {
    const ui = ctx.config.ui || {};
    if (ui.style !== 'pssync') return;
    const r = await sendToPSAwait({ action: 'getUIPrefs', params: {} }, 8000);
    const lvl = r && r.ok && r.result && r.result.brightness;
    const base = PS_GREYS[lvl] || '#2e3036';
    if (ui.psBase !== base) {
      ui.psBase = base;
      if (ctx.saveConfig) ctx.saveConfig();
      ctx.broadcast('ui-vars', ctx.config.ui);
      try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [pssync] PS明暗=' + (lvl || '未知') + ' → 底色' + base + '\n'); } catch {}
    }
  } catch {}
}
ipcMain.handle('ps-ui-refresh', () => { refreshPsBase(); return { ok: true }; });

ctx.startBridgeServer = startBridgeServer;
ctx.sendToPSAwait = sendToPSAwait;
ctx.psConnected = () => !!(psSocket && psSocket.readyState === 1);   // COM兜底探测据此让位
ctx.bridgeVer = () => psBridgeVer;
ctx.curBridgeVer = 69;   // 期望的桥接件版本（与ps-bridge/bridge.js的hello version同步抬；68=批量改色原生工程；69=肤色统一写回动作）
// v56 是致命版：captureInput 必抛 "fullMode is not defined"（有没有选区都采不到）。握手撞见它要用最响的话说清楚——
// 用户在 v5.18.39~42 安装包上重启过 PS 才会加载到它，"重启也没用"就是这个
ctx.bridgeFatalVers = { 56: 'v56 采集选区必失败（fullMode 作用域错误）' };
