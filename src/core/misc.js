// 杂项：尿尿提醒（主进程计时） + 打光灯具OS级拖放 + 自定义提示音文件夹
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');

// ---------- 自定义提示音：文档目录橙子/sounds，丢音频进去即可在设置里选用（卸载重装不丢） ----------
const soundDir = () => path.join(app.getPath('documents'), '橙子', 'sounds');

// 出厂音效播种：随包分发的音频首启复制进用户提示音文件夹（已存在的不覆盖，用户删了不复活——
// 靠soundSeedV1一次性标志），并把「爱你.mp3」设为出厂默认提示音（用户改过就不动）
app.whenReady().then(() => setTimeout(() => {
  try {
    const src = app.isPackaged
      ? path.join(process.resourcesPath, 'sounds')
      : path.join(__dirname, '..', '..', 'sounds');
    if (!fs.existsSync(src)) return;
    const config = ctx.config;
    const SEED_V = 2;   // 出厂音效批次号：新增音效时+1，老用户会补种新增的（不复活他们删过的老音效）
    if ((config.soundSeedV || 0) >= SEED_V) return;
    const dst = soundDir();
    fs.mkdirSync(dst, { recursive: true });
    let seeded = 0;
    for (const f of fs.readdirSync(src)) {
      if (!/\.(mp3|wav|ogg|m4a|flac)$/i.test(f)) continue;
      const to = path.join(dst, f);
      if (!fs.existsSync(to)) { fs.copyFileSync(path.join(src, f), to); seeded++; }
    }
    if (!config.gen.soundFile && fs.existsSync(path.join(dst, '爱你.mp3'))) {
      config.gen.soundFile = '爱你.mp3';
    }
    config.soundSeedV = SEED_V;
    ctx.saveConfig();
    if (seeded) ctx.dlog('[sound-seed] 出厂音效已播种 ' + seeded + ' 个');
  } catch (e) {
    try { ctx.dlog('[sound-seed] 异常: ' + (e && e.message)); } catch {}
  }
}, 3000));
ipcMain.handle('sound-list', () => {
  try {
    const dir = soundDir();
    fs.mkdirSync(dir, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => /\.(mp3|wav|ogg|m4a|flac|aac|webm)$/i.test(f)).sort();
    return { dir, files };
  } catch (e) {
    return { dir: soundDir(), files: [], error: e.message || String(e) };
  }
});
ipcMain.handle('sound-open-folder', async () => {
  const dir = soundDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  try { await shell.openPath(dir); } catch {}
  return { ok: true, dir };
});

// ---------- 背景图片/视频：系统文件对话框选一个，路径落config.ui.bgFile（glass.js各窗口直引file://） ----------
ipcMain.handle('bg-pick', async () => {
  const { dialog } = require('electron');
  const r = await dialog.showOpenDialog({
    title: '选择背景图片或视频',
    properties: ['openFile'],
    filters: [
      { name: '图片/动图/视频', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'mp4', 'webm', 'mov', 'm4v'] },
    ],
  });
  if (ctx.assertTopmost) ctx.assertTopmost('背景文件对话框收场');   // 无父对话框会剥置顶带（坑61家族）
  if (r.canceled || !r.filePaths.length) return { ok: false };
  return { ok: true, file: r.filePaths[0] };
});

// ---------- 打光：拖拽置入PS（原生OS拖放，PS收到文件自动在落点置入智能对象） ----------
// 面板参数一变就预渲染PNG落盘，dragstart时直接用现成文件（startDrag必须同步发起）
ipcMain.handle('lh-prep-drag', (_e, { base64, name }) => {
  try {
    const dir = path.join(ctx.genDir(), 'lightdrag');
    fs.mkdirSync(dir, { recursive: true });
    const safe = String(name || '灯光示意').replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    const file = path.join(dir, safe + '.png');
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});
ipcMain.on('lh-start-drag', (e, file) => {
  try {
    const { nativeImage } = require('electron');
    let icon = nativeImage.createFromPath(file);
    if (!icon.isEmpty()) {
      icon = icon.resize({ width: 64 });
    } else {
      // icon为空Electron会直接抛错——用1x1兜底图标保证拖拽总能发起
      icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
    }
    e.sender.startDrag({ file, icon });
  } catch (err) {
    try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [lh-drag] ' + (err && err.message) + '\n'); } catch {}
  }
});

// ---------- 尿尿提醒：倒计时在主进程跑（卡片关着也照样到点） ----------
let peeDeadline = null, peeTimer = null;
function peeClear() { clearTimeout(peeTimer); peeTimer = null; peeDeadline = null; }
// 鼓励语录池：到点洗牌逐窗分发，每张卡背一句不重复
const PEE_QUOTES = [
  '你今天修的图真的很棒喵！',
  '休息是为了修更好的图～',
  '喝口水，伸个懒腰，世界都亮了',
  '你的审美今天也在线哦♥',
  '再厉害的修图师也要照顾好膀胱',
  '起来走两步，灵感会追上你的',
  '你已经很努力了，奖励自己一杯水',
  '远眺30秒，眼睛会谢谢你喵',
  '深呼吸～肩膀放松放松',
  '今天的你比昨天更会修图了',
  '别忘了你是最棒的喵！',
  '图不会跑，健康要紧～',
  '转转手腕，脖子也动一动',
  '灵感正在洗手间等你（真的）',
  '慢一点没关系，你一直在变强',
  '世界需要你，先去尿尿',
  '你修的不是图，是艺术喵♥',
  '站起来！让血液也活动活动',
];
ipcMain.handle('pee-start', (_e, seconds) => {
  peeClear();
  const ms = Math.max(1, Math.min(43200, Number(seconds) || 2700)) * 1000;   // 1秒~12小时
  peeDeadline = Date.now() + ms;
  peeTimer = setTimeout(() => {
    peeDeadline = null; peeTimer = null;
    const pool = [...PEE_QUOTES].sort(() => Math.random() - 0.5);
    let i = 0;
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send('pee-alarm', { phrase: pool[i++ % pool.length] });
    }
    ctx.olog('🚽 橙子提醒你该尿尿了！');
  }, ms);
  return { ok: true, deadline: peeDeadline };
});
ipcMain.handle('pee-stop', () => { peeClear(); return { ok: true }; });
ipcMain.handle('pee-status', () => ({ deadline: peeDeadline }));
ipcMain.on('pee-ack', () => ctx.broadcast('pee-alarm-clear', {}));   // 点任一卡牌→全体翻回
