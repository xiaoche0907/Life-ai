// 安全桥：把主进程能力有限度地暴露给各窗口UI
const { contextBridge, ipcRenderer } = require('electron');

const API = {
  // --- 悬浮球 ---
  ballDragStart: () => ipcRenderer.send('ball-drag-start'),
  ballDragEnd: () => ipcRenderer.send('ball-drag-end'),
  toggleHub: () => ipcRenderer.send('toggle-hub'),
  openHub: () => ipcRenderer.send('open-hub'),
  ballGather: () => ipcRenderer.send('ball-gather'),
  ballMenu: (open) => ipcRenderer.send('ball-menu', { open: !!open }),
  onBallMenuState: (cb) => ipcRenderer.on('ball-menu-state', (_e, s) => cb(s)),

  onGlowAll: (cb) => ipcRenderer.on('glow-all', () => cb()),
  onGatherFx: (cb) => ipcRenderer.on('gather-fx', (_e, p) => cb(p)),
  onBallFx: (cb) => ipcRenderer.on('ball-fx', (_e, p) => cb(p)),
  onBootProgress: (cb) => ipcRenderer.on('boot-progress', (_e, p) => cb(p)),

  // --- 退出软件 ---
  quitApp: () => ipcRenderer.send('app-quit'),
  // --- 拉回最前（面板沉到PS后面时的逃生口） ---
  reassertTop: () => ipcRenderer.send('reassert-top'),
  fgwatchState: () => ipcRenderer.invoke('fgwatch-state'),
  // --- 免抢焦点：输入框临时聚焦 ---
  wantFocus: (on) => ipcRenderer.send('want-focus', !!on),

  // --- 主面板/卡片 ---
  getModules: () => ipcRenderer.invoke('get-modules'),
  openCard: (id) => ipcRenderer.send('open-card', id),
  showCard: (id) => ipcRenderer.send('show-card', id),
  sendPromptForceFill: (txt) => ipcRenderer.send('prompt-force-fill-request', txt),   // 进度卡等"点击填入"向主进程发起，主进程广播给所有窗口（0919）
  closeSelf: () => ipcRenderer.send('close-self'),
  getCardStates: () => ipcRenderer.invoke('get-card-states'),
  onCardStates: (cb) => ipcRenderer.on('card-states', (_e, s) => cb(s)),

  // --- 气泡拖出（跨窗口拖拽） ---
  bubbleDragStart: (id, sx, sy) => ipcRenderer.send('bubble-drag-start', { id, sx, sy }),
  bubbleDragMove: (sx, sy) => ipcRenderer.send('bubble-drag-move', { sx, sy }),
  bubbleDragEnd: () => ipcRenderer.send('bubble-drag-end'),

  // --- 武装机制：最后调节的跑图模块整卡发光，总控生成跑它 ---
  armModule: (id) => ipcRenderer.send('arm-module', id),
  // 提示词库点击填入的来源标记（0904机制）：提示词卡据此决定"带控件的预设优先翻滑块/正则面"
  promptLibFill: () => ipcRenderer.send('prompt-lib-fill'),
  onPromptLibFill: (cb) => ipcRenderer.on('prompt-lib-fill-hint', () => cb()),
  getArmed: () => ipcRenderer.invoke('get-armed'),
  onArmed: (cb) => ipcRenderer.on('armed', (_e, a) => cb(a)),
  fireArmed: (count) => ipcRenderer.invoke('fire-armed', { count }),
  // 卡内跑图键触发批处理（0918）：开关关着返回 {batch:false}，调用方照旧跑单张
  batchFire: (modId, count) => ipcRenderer.invoke('batch-fire', { modId, count }),
  psUiRefresh: () => ipcRenderer.invoke('ps-ui-refresh'),
  alignLayers: () => ipcRenderer.invoke('align-layers'),

  // --- 卡牌堆叠（0906堆牌版） ---
  stackSwitch: (dir) => ipcRenderer.send('stack-switch', dir),
  stackJump: (i) => ipcRenderer.send('stack-jump', i),
  onStackState: (cb) => ipcRenderer.on('stack-state', (_e, s) => cb(s)),
  deckHover: (on) => ipcRenderer.send('deck-hover', !!on),   // 被压卡标题条悬停：抽出/归位
  deckCut: () => ipcRenderer.send('deck-cut'),               // 点被压卡标题条：切牌到最前
  deckWheel: (dir) => ipcRenderer.send('deck-wheel', dir),   // 滚轮切牌（渲染端只在标题栏/被压条/Ctrl时发）
  deckFuse: (src, dst) => ipcRenderer.invoke('deck-fuse', { src, dst }),   // 程序化堆牌（机测/布局恢复）
  deckDetach: (id) => ipcRenderer.invoke('deck-detach', id),
  deckInfo: (id) => ipcRenderer.invoke('deck-info', id),
  deckFrontResize: (id, w, h, zoom) => ipcRenderer.invoke('deck-front-resize', { id, w, h, zoom }),   // 机测：模拟前卡缩放收尾
  cardResizable: (id) => ipcRenderer.invoke('card-resizable', id),   // 机测：读窗口可缩放状态
  deckFuseProbe: (id, cursor) => ipcRenderer.invoke('deck-fuse-probe', { id, cursor }),   // 机测：融合判定探针
  cardBounds: (id) => ipcRenderer.invoke('card-bounds', id),                                // 机测：读卡位置尺寸
  cardMove: (id, x, y) => ipcRenderer.invoke('card-move', { id, x, y }),                    // 机测：摆卡位置（不动尺寸）

  // --- 磁吸拖动（标题栏拖动，主进程采样+吸附） ---
  dragStart: (alone) => ipcRenderer.send('drag-start', !!alone),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // --- 自绘缩放手柄（0907#9统一等比；拖动量主进程自采） ---
  gripStart: (mode) => ipcRenderer.send('grip-start', mode),
  gripEnd: () => ipcRenderer.send('grip-end'),
  gripProbe: (id, mode, dx, dy) => ipcRenderer.invoke('grip-probe', { id, mode, dx, dy }),   // 0907#8 机测：拉边=等比、比例保持

  // --- 主题/界面参数 ---
  setTheme: (theme) => ipcRenderer.send('set-theme', theme),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  onUIVars: (cb) => ipcRenderer.on('ui-vars', (_e, u) => cb(u)),
  onLockState: (cb) => ipcRenderer.on('lock-state', (_e, s) => cb(s)),
  onZoomVar: (cb) => ipcRenderer.on('zoom-var', (_e, z) => cb(z)),
  setPassRects: (rects) => ipcRenderer.send('pass-rects', rects),

  // --- PS镜面几何（窗口/PS的屏幕坐标） ---
  onGeo: (cb) => ipcRenderer.on('geo', (_e, g) => cb(g)),
  getPSSource: () => ipcRenderer.invoke('get-ps-source'),
  glassLog: (msg) => ipcRenderer.send('glass-log', msg),
  // 写生图日志（0905：卡面不挂红字，报错一律进日志卡）
  ologWrite: (msg, type) => ipcRenderer.send('olog-write', { msg, type }),

  // --- PS状态 ---
  isPSConnected: () => ipcRenderer.invoke('ps-connected'),
  onPSStatus: (cb) => ipcRenderer.on('ps-status', (_e, data) => cb(data)),
  onPSReply: (cb) => ipcRenderer.on('ps-reply', (_e, data) => cb(data)),

  // --- 配置 ---
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),

  // --- AI生图 ---
  aiGenerate: (params) => ipcRenderer.invoke('ai-generate', params),
  aiGenerateBatch: (params, count) => ipcRenderer.invoke('ai-generate-batch', { params, count }),
  getGenTasks: () => ipcRenderer.invoke('get-gen-tasks'),
  onGenTasks: (cb) => ipcRenderer.on('gen-tasks', (_e, t) => cb(t)),
  taskAction: (id, action) => ipcRenderer.send('task-action', { id, action }),
  // --- 看图层：进度卡结果图右键 → 整屏压暗模糊看大图（0913） ---
  viewerOpen: (taskId) => ipcRenderer.invoke('viewer-open', taskId),
  viewerClose: () => ipcRenderer.send('viewer-close'),
  viewerState: () => ipcRenderer.invoke('viewer-state'),
  onViewerData: (cb) => ipcRenderer.on('viewer-data', (_e, d) => cb(d)),
  onViewerItems: (cb) => ipcRenderer.on('viewer-items', (_e, d) => cb(d)),
  viewerTestSeed: (p) => ipcRenderer.invoke('viewer-test-seed', p),   // 仅带 CDP 口启动时主进程才应答（smoke 直测）
  tasksTest: (op) => ipcRenderer.invoke('tasks-test', op),   // 同上：进度持久化/自动清理机测钩子
  onGenVars: (cb) => ipcRenderer.on('gen-vars', (_e, g) => cb(g)),
  onPromptForceFill: (cb) => ipcRenderer.on('prompt-force-fill', (_e, txt) => cb(txt)),   // 进度卡/聊天等"点击填入提示词"专用，无视输入框焦点状态强制覆盖（0919）
  aiModels: () => ipcRenderer.invoke('ai-models'),
  aiBalance: () => ipcRenderer.invoke('ai-balance'),
  getProviders: () => ipcRenderer.invoke('get-providers'),
  onProvidersChanged: (cb) => ipcRenderer.on('providers-changed', () => cb()),   // 渠道增删/显隐（0908）
  cacheInfo: () => ipcRenderer.invoke('cache-info'),
  openCache: () => ipcRenderer.invoke('open-cache'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  autoCleanNow: () => ipcRenderer.invoke('auto-clean-now'),   // 0913：按当前档位立刻清一次（改档位后即时生效用）
  pickFolder: () => ipcRenderer.invoke('pick-folder'),   // 0911：设置卡「缓存文件夹」选目录
  captureRef: () => ipcRenderer.invoke('capture-ref'),
  onBilling: (cb) => ipcRenderer.on('billing', (_e, b) => cb(b)),
  getOlog: () => ipcRenderer.invoke('get-olog'),
  onOlog: (cb) => ipcRenderer.on('olog', (_e, l) => cb(l)),
  onOlogClear: (cb) => ipcRenderer.on('olog-clear', () => cb()),
  clearOlog: () => ipcRenderer.send('clear-olog'),
  pickImages: () => ipcRenderer.invoke('pick-images'),
  // --- 通用文件选择（ComfyUI 参考图等） ---
  pickFiles: (opts) => ipcRenderer.invoke('pick-files', opts),
  readImageThumb: (path, size) => ipcRenderer.invoke('read-image-thumb', { path, size }),
  // --- 背景图片/视频（设置卡选文件；路径直引） ---
  bgPick: () => ipcRenderer.invoke('bg-pick'),
  // --- 自定义提示音（文档目录橙子/sounds） ---
  soundList: () => ipcRenderer.invoke('sound-list'),
  soundOpenFolder: () => ipcRenderer.invoke('sound-open-folder'),
  // --- PS桥接插件自动安装 ---
  bridgeReinstall: () => ipcRenderer.invoke('bridge-reinstall'),

  // --- 提示词库（存文档目录，卸载重装不丢） ---
  plibGet: () => ipcRenderer.invoke('plib-get'),
  plibSet: (lib) => ipcRenderer.invoke('plib-set', lib),
  plibImport: (groupId) => ipcRenderer.invoke('plib-import', groupId),
  plibExport: () => ipcRenderer.invoke('plib-export'),
  // 批量导入/搬运（0906）：扫文件夹或橙子老插件 → 候选 → 确认入库 → 可撤销
  plibScanDir: (dir) => ipcRenderer.invoke('plib-scan-dir', dir),
  plibListPlugins: () => ipcRenderer.invoke('plib-list-plugins'),   // 0908：可搬运插件清单（只有魔改版可点，其余灰掉）
  plibScanPlugins: (id) => ipcRenderer.invoke('plib-scan-plugins', id),
  plibImportApply: (payload) => ipcRenderer.invoke('plib-import-apply', payload),
  plibImportUndo: (batch) => ipcRenderer.invoke('plib-import-undo', batch),
  plibCarryStatus: () => ipcRenderer.invoke('plib-carry-status'),   // 搬回（0907）：最近插件搬运批次
  plibCarryBack: () => ipcRenderer.invoke('plib-carry-back'),
  plibImportForgePresets: (files) => ipcRenderer.invoke('plib-import-forge-presets', files),
  // 自动修图（0905）：双文件夹流水线批修
  autofixPickDir: (kind) => ipcRenderer.invoke('autofix-pick-dir', kind),
  autofixScan: (dir) => ipcRenderer.invoke('autofix-scan', dir),
  autofixRun: (recipe) => ipcRenderer.invoke('autofix-run', recipe),
  autofixStop: () => ipcRenderer.send('autofix-stop'),
  onAutofixProgress: (cb) => ipcRenderer.on('autofix-progress', (_e, p) => cb(p)),
  // 跑批收尾（0906）：完成后自动关机的倒计时/取消
  autofixShutdownCancel: () => ipcRenderer.send('autofix-shutdown-cancel'),
  autofixShutdownStatus: () => ipcRenderer.invoke('autofix-shutdown-status'),
  onAutofixShutdown: (cb) => ipcRenderer.on('autofix-shutdown', (_e, p) => cb(p || {})),
  plibRestoreTrash: () => ipcRenderer.invoke('plib-restore-trash'),
  onPlibChanged: (cb) => ipcRenderer.on('plib-changed', (_e, lib) => cb(lib)),
  // 释放飞行代理层（0905丝滑）：主进程发快照+起止坐标，代理页rAF飞行
  onFlyData: (cb) => ipcRenderer.on('fly-data', (_e, d) => cb(d)),
  onFlyPrep: (cb) => ipcRenderer.on('fly-prep', (_e, d) => cb(d)),   // 收纳时逐张预热快照位图（0906）

  // --- 打光：灯光示意拖拽进PS ---
  lhPrepDrag: (base64, name) => ipcRenderer.invoke('lh-prep-drag', { base64, name }),
  lhStartDrag: (file) => ipcRenderer.send('lh-start-drag', file),

  // --- Forge（SD WebUI 本地API） ---
  forgeTest: (url) => ipcRenderer.invoke('forge-test', { url }),
  forgeResources: (url) => ipcRenderer.invoke('forge-resources', { url }),
  forgeImg2Img: (params) => ipcRenderer.invoke('forge-img2img', params),
  forgeInterrupt: (url) => ipcRenderer.send('forge-interrupt', { url }),
  forgePresets: () => ipcRenderer.invoke('forge-presets'),
  forgeFillPos: (text) => ipcRenderer.invoke('forge-fill-pos', text),
  forgeApplyPreset: (name, text) => ipcRenderer.invoke('forge-apply-preset', { name, text }),
  forgePresetSave: (preset) => ipcRenderer.invoke('forge-preset-save', preset),
  forgeOpenFolder: () => ipcRenderer.invoke('forge-open-folder'),
  onForgeProgress: (cb) => ipcRenderer.on('forge-progress', (_e, p) => cb(p)),
  // --- ComfyUI（0916，免装节点：原生 HTTP/WS 接口） ---
  comfyTest: (url) => ipcRenderer.invoke('comfy-test', { url }),
  comfyWorkflows: () => ipcRenderer.invoke('comfy-workflows'),
  comfyOpenFolder: () => ipcRenderer.invoke('comfy-open-folder'),
  comfyLoad: (name) => ipcRenderer.invoke('comfy-load', { name }),
  comfySaveParams: (name, params) => ipcRenderer.invoke('comfy-save-params', { name, params }),
  comfyRun: (p) => ipcRenderer.invoke('comfy-run', p),
  comfyInterrupt: (url) => ipcRenderer.send('comfy-interrupt', { url }),
  onComfyProgress: (cb) => ipcRenderer.on('comfy-progress', (_e, p) => cb(p)),
  // --- AI对话 ---
  chatSend: (message, image) => ipcRenderer.invoke('chat-send', { message, image }),
  chatClear: () => ipcRenderer.invoke('chat-clear'),
  chatGetHistory: () => ipcRenderer.invoke('chat-get-history'),
  onChatMessage: (cb) => ipcRenderer.on('chat-message', (_e, m) => cb(m)),
  onChatVars: (cb) => ipcRenderer.on('chat-vars', (_e, c) => cb(c)),
  chatBuiltinRoles: () => ipcRenderer.invoke('chat-builtin-roles'),
  chatProviders: () => ipcRenderer.invoke('chat-providers'),                          // 0908 对话独立渠道表 {conf, meta}
  chatModelsFetch: (prov) => ipcRenderer.invoke('chat-models-fetch', { prov }),      // 自定义对话渠道拉 /v1/models
  chatToJson: (text) => ipcRenderer.invoke('chat-to-json', { text }),
  chatAsk: (prompt, imageBase64) => ipcRenderer.invoke('chat-ask', { prompt, imageBase64 }),

  // --- 快速布局 ---
  layoutList: () => ipcRenderer.invoke('layout-list'),
  layoutApply: (name) => ipcRenderer.invoke('layout-apply', name),
  layoutSave: (name) => ipcRenderer.invoke('layout-save', name),
  layoutDelete: (name) => ipcRenderer.invoke('layout-delete', name),
  layoutStripStacks: (name) => ipcRenderer.invoke('layout-strip-stacks', name),   // 机测：模拟老版本存的布局（无 stacks 字段）
  layoutSetDefault: () => ipcRenderer.invoke('layout-set-default'),
  layoutNext: () => ipcRenderer.invoke('layout-next'),   // 球中键：循环切到下一个布局
  onLayoutsChanged: (cb) => ipcRenderer.on('layouts-changed', () => cb()),

  // --- 尿尿提醒 ---
  peeStart: (minutes) => ipcRenderer.invoke('pee-start', minutes),
  peeStop: () => ipcRenderer.invoke('pee-stop'),
  peeStatus: () => ipcRenderer.invoke('pee-status'),
  peeAck: () => ipcRenderer.send('pee-ack'),
  onPeeAlarm: (cb) => ipcRenderer.on('pee-alarm', (_e, p) => cb(p || {})),
  onPeeAlarmClear: (cb) => ipcRenderer.on('pee-alarm-clear', () => cb()),
  placeInPS: (file, ctx) => ipcRenderer.invoke('place-in-ps', ctx ? { file, ctx } : file),
  // --- 快捷预设（0912）：修图师标准动作一键执行；用户可增删改（绑定 PS 动作 / 复制现有预设）、换图标 ---
  qpList: () => ipcRenderer.invoke('qpresets-list'),
  qpRun: (id) => ipcRenderer.invoke('qpresets-run', id),
  qpOpenFolder: () => ipcRenderer.invoke('qpresets-open-folder'),
  qpSave: (p) => ipcRenderer.invoke('qpresets-save', p),
  qpDelete: (id) => ipcRenderer.invoke('qpresets-delete', id),
  qpRestore: () => ipcRenderer.invoke('qpresets-restore'),
  qpActions: () => ipcRenderer.invoke('qpresets-actions'),
  psExec: (action, params, timeoutMs) => ipcRenderer.invoke('ps-exec', { action, params, timeoutMs }),
  relightBake: (payload) => ipcRenderer.invoke('relight-bake', payload),
  relightAiGen: (payload) => ipcRenderer.invoke('relight-ai-gen', payload),
  glow: (op, payload) => ipcRenderer.invoke('glow', { op, payload }),   // 辉光卡单通道（capture/bake/presets/…）
  restoreSelection: (ctx) => ipcRenderer.invoke('restore-selection', ctx),

  // --- 提前贴回（0916）：进度卡每批的橙子 logo 钮——已生成好的现在就打组贴回，这批剩下的完成后不自动贴 ---
  earlyPlace: (batchId, dry) => ipcRenderer.invoke('early-place', { batchId, dry: !!dry }),
  // --- 任务中心机测钩子（主进程只在带 CDP 口启动时应答）---
  testInjectTasks: (tasks) => ipcRenderer.invoke('test-inject-tasks', tasks),
  testUpdateTask: (id, updates) => ipcRenderer.invoke('test-update-task', { id, updates }),
  testRemoveTasks: (ids) => ipcRenderer.invoke('test-remove-tasks', ids),
};

// ---------- 报错人话化的兜底闸门（0915用户裁定「不能出现英文信息」） ----------
// 卡片普遍直接显示 IPC 返回的 r.error（14 个页面），那些文本里混着 HTTP 状态、fetch 异常、
// 各种 SDK 原文。与其逐页翻译（改14处还容易漏新增的），在这唯一的出海关口统一过一道：
// 凡是返回对象里的 error 字段是字符串，就翻成人话。主进程日志侧走 log.js olog，同一份规则表。
// ⚠只碰 error 字段：其他字段可能是用户提示词/模型名/路径，一律原样。
// ⚠preload 在沙箱里不能 require 本地模块 → 靠主进程开一条 IPC 专线翻译（log.js 挂 ctx.humanizeErr）
function humanizeResult(r) {
  if (!r || typeof r !== 'object') return r;
  if (typeof r.error === 'string' && r.error) {
    const zh = ipcRenderer.sendSync('humanize-err', r.error);
    if (zh && zh !== r.error) return Object.assign({}, r, { error: zh });
  }
  return r;
}
const wrapped = {};
for (const k of Object.keys(API)) {
  const fn = API[k];
  if (typeof fn !== 'function') { wrapped[k] = fn; continue; }
  wrapped[k] = (...args) => {
    const out = fn(...args);
    // invoke 返回 Promise → 翻译后再交给页面；send 返回 undefined、订阅类返回别的，一律原样
    return (out && typeof out.then === 'function') ? out.then(humanizeResult) : out;
  };
}
contextBridge.exposeInMainWorld('orange', wrapped);
