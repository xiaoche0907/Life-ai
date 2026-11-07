// 配置持久化 + 模块注册表（原main.js的config/loadConfig/saveConfig/MODULES段）
const { app, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const ctx = require('./ctx');
const LS = require('./layout-scale');

const SRC = path.join(__dirname, '..');

// ---------- 模块注册表 ----------
// locked=学员特供占位（阉割版用，见 tools/build-student.js）：只给控制台画灰气泡；
// 主进程的模块表一律不含它们（开不了卡、布局/堆牌恢复都当不存在）。完整版没有任何 locked，两表等价。
const MODULES_ALL = JSON.parse(fs.readFileSync(path.join(SRC, 'modules.json'), 'utf8'));
const MODULES = MODULES_ALL.filter((m) => !m.locked);
const modById = Object.fromEntries(MODULES.map((m) => [m.id, m]));

// ---------- 配置（默认值；loadConfig原地覆写，对象引用永不变） ----------
const config = {
  ballPos: null,
  hubPos: null,
  hubOpen: false,
  cards: {},                       // id -> {x, y, open}
  // style=底板风格(classic/frost/gradient/sharp)；uiMode=修图模式(novice新手/blind盲人极简)；
  // ballMiddle=小球中键动作(layout循环切布局/gather收纳释放/hub开关控制台/pass锁定开关；左键固定收纳释放)
  // bgFile=背景图片/视频绝对路径(空=无)，bgOpacity=背景媒体不透明度
  ui: { theme: 'dark', blur: 36, tint: 0.32, accent: '#ff9f0a', style: 'classic', uiMode: 'novice', ballMiddle: 'layout', bgFile: '', bgOpacity: 0.6, psOnlyTop: true, psDialogTop: true },   // psOnlyTop: 卡牌只浮在PS之上（0909 晚改默认开：默认关时用户不知有此功能，照样反馈"挡浏览器"）；psDialogTop: PS 弹窗/浮动面板压在卡牌上（0910）
  api: { base: 'https://api.momoapi.icu', key: '', model: '', models: [] },   // 旧结构，迁移后作为momo镜像保留
  provider: 'yingce',
  providers: {
    yingce: { base: 'https://api.yingce.tv', key: '', model: '', models: [], balance: null },
    wanyin: { base: 'https://lxmone.xyz', key: '', model: '', models: [], balance: null },
  },
  gen: { ratio: 'Auto', size: '2K', noSelFull: true, genTimeout: 600, autoCleanDays: 0 },   // noSelFull默认开：用户没框选区就按全图跑（关了会撞"没有选区"墙，用户找不到开关）；size 0908去Auto默认2K；genTimeout=生成超时秒数(0918)；autoCleanDays=缓存清理天数,0=永不(0918)
  cacheDir: null,
  locked: false,   // 点击穿透：true=按钮以外区域鼠标穿透到PS（原"锁定"，与布局锁定是两回事）
  layoutLock: false,   // 布局锁定：true=禁拖动/禁缩放/禁进布局编辑模式，业务点击完全正常
  // 流畅优先（低配电脑，1011）：实测默认15张卡=19个进程=1.9GB内存（渲染进程占77%），低端机被虚拟内存拖死。
  // 开启后：①关掉没用的卡并回收 ②闲置回收5分钟→45秒 ③光标轮询30ms→120ms ④穿透上报250→1000ms
  //        ⑤停掉装饰性无限动画（省GPU）⑥回收周期按空闲自动收紧
  perf: { lite: false, autoClosed: false },
  forge: { url: '' },   // Forge(SD WebUI)本地API地址
  comfy: { url: 'http://127.0.0.1:8188', current: '', params: {} },   // ComfyUI 卡（0916）：地址 / 当前工作流文件名 / 每个工作流用户改过的快捷参数
  autofix: { recipes: [], last: null },   // 自动修图：配方列表+上次整套设置（0905）
  qpresets: { hidden: [], overrides: {} },   // 快捷预设（0912）：hidden=用户删掉的出厂预设 id；overrides[id]={label,group,icon,params} 用户对出厂预设的改动（出厂文件每启覆盖，改动记这里）
  layouts: { default: null, custom: [] },   // 快速布局：默认(首启收录当前排布并自动对齐)+自定义
  chat: { provider: 'grs', model: 'gemini-3.5-flash', base: '', key: '', history: [], systemPrompt: '', presets: [], roleModels: {},
    // caps（1011）：各"用对话模型"的功能各自指定渠道/模型，空=跟随默认（行为与加这个功能之前完全一致）。
    //   chat=AI对话（**1013新增**：原「默认渠道/模型」那块界面已删，它的槽位搬到「其它功能的模型」里，
    //         config.chat.provider/model 保留当兜底，老用户不填这行行为完全不变）；
    //   json=提示词卡转JSON；ask=半合成IP清单生成。
    //   ⚠自动修图识图**不在这里**——它有 autofix.det（卡面选择器+配方可存），两处入口会互相打架。
    caps: { chat: {}, json: {}, ask: {} },
    // corpus（1013）：**语料**与**模型**解耦——每个功能各自选"用谁的语料"。⚠两个名字别混：
    //   'b_corpus'（=橙子语料，内置角色文件）= AI对话 / 转JSON 的默认；
    //   '__none__'（=内置语料，半合成卡写死的那套看图用词）= 半合成识图 的默认，语义是"不叠加角色语料"。
    //   其余值 = 用户自建角色的名字。**没有"跟随当前角色"这一档**（第三轮已删）。
    corpus: { chat: 'b_corpus', json: 'b_corpus', ask: '__none__' } },
  // 0908 对话渠道与生图渠道彻底解耦：对话有自己的一张渠道表（内置 aji/grs 各自的 Key + 用户自定义 cc_* 多个），
  // 模型目录：内置的走 providers.js 的 chatModels 静态表；cc_* 靠"拉取模型"动态存进 models
  chatProviders: {
    aji: { label: 'AJI', base: 'https://ai.ajiai.top', key: '', models: [] },
    grs: { label: 'GRS', base: 'https://grsai.dakka.com.cn', key: '', models: [] },
    // 1013：墨墨（对话侧）。与生图侧同一个渠道商、同一把 Key，但对话渠道是独立表
    // （0908 用户裁定"对话与生图彻底解耦"）——所以在两处都要各填一次 Key
    momo: { label: '墨墨', base: 'https://api.momoapi.icu', key: '', models: [] },
  },
  stacks: [],   // 卡牌融合叠：[{members:[卡id], active:卡id, hidden:bool}]
  // 提示词远程更新（1012）：base=更新地址（OSS，空=没配）；auto=开机自动（默认关，用户自己开）；
  // lastCheck/lastResult=上次检查时间与结果（界面显示用）
  // 1013：auto 的**界面入口**搬去「更新」卡（更名"提示词库自动更新"），这个字段本身仍在用（不改名，少一次迁移）
  plibUpdate: { base: '', auto: false, lastCheck: 0, lastResult: '' },
  // 软件本体更新（1013，更新卡）：
  //   autoApp=开机自动检查并下载新版（默认关，用户自己开）；autoPlib=提示词库自动更新（原 plibUpdate.auto 的搬家目标）
  //   lastCheck/lastResult=上次检查的结果；latest=云端版本号；notes=更新报告；seen=用户已看过的版本（红点用）
  //   doneFile=已下载好的安装包路径（下载完成但用户还没装时留着）
  updater: { autoApp: false, autoPlib: false, lastCheck: 0, lastResult: '', latest: '', notes: [], seen: '', doneFile: '' },
};
const configPath = () => path.join(app.getPath('userData'), 'orange-config.json');
// 图片缓存目录（可在设置里更改）
const genDir = () => config.cacheDir || path.join(app.getPath('temp'), 'orange-ai');

// 读安全网：主文件坏了自动逐个试备份；坏文件封存.corrupt便于验尸；
// 绝不走"读失败→写默认值覆盖→配置自杀"的老路（UXP插件webview_storage 8.8MB惨案同款雷）
function readConfigFile() {
  const p = configPath();
  for (const f of [p, p + '.bak1', p + '.bak2', p + '.bak3']) {
    try {
      if (!fs.existsSync(f)) continue;
      const txt = fs.readFileSync(f, 'utf8');
      if (!txt.trim()) continue;   // 空文件=截断现场，跳过
      const j = JSON.parse(txt);
      if (f !== p) {
        try { fs.copyFileSync(p, p + '.corrupt-' + Date.now()); } catch {}
        try { fs.copyFileSync(f, p); } catch {}
        setTimeout(() => { try { ctx.olog('⚠️ 配置主文件损坏，已自动从备份恢复(' + path.basename(f) + ')', 'warn'); } catch {} }, 3000);
      }
      return j;
    } catch {}
  }
  return null;
}
// 出厂布局(随包分发)：src/default-layout.json=默认布局（0908第21轮：用户当前排布收录，ref 2560×1392）；
// src/layout-modded.json=「魔改布局」（原出厂默认，ref 2560×1330），首启作为一条可删的自定义布局一起种下
function readFactoryLayout() {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, 'default-layout.json'), 'utf8')); } catch { return null; }
}
function readModdedLayout() {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, 'layout-modded.json'), 'utf8')); } catch { return null; }
}
// 出厂内置预设布局（1011）：一本多套常用场景排布（辉光/生图/特效…），随包分发、首启即出现在布局列表里。
// 结构 { ref:{w,h}, presets:[{name, ref, hub, cards, stacks}] }；每套按自己的工作区基准折算后夹进当前屏幕。
// 出厂只种一次（首启）；之后用户对自己的布局列表有完全支配权（可删可改），改名不会长回来。
function readFactoryLayouts(wa) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SRC, 'factory-layouts.json'), 'utf8'));
    const list = Array.isArray(j && j.presets) ? j.presets : [];
    return list.filter((p) => p && p.name && p.cards).map((p) => {
      const s = scaleFactory(p, wa);
      return { name: String(p.name), data: { hub: s.hub, cards: s.cards, stacks: p.stacks || [] } };
    });
  } catch { return []; }
}
// 把一份出厂布局按当前工作区等比折算（各文件自带 ref=录制时的工作区；老文件没有 ref 按 2560×1330）
// 实现在纯函数模块 layout-scale.js（1012：撞 0.45 下限保长宽比 + 不低于最小宽 + 新增重叠顺延错开；单测 tools/layout-scale-test.js）
function scaleFactory(fl, wa) {
  return LS.scaleFactory(fl, wa, MODULES);
}
function currentWorkArea() {
  let wa = { x: 0, y: 0, width: 2560, height: 1392 };
  try { wa = screen.getPrimaryDisplay().workArea; } catch {}   // loadConfig在app ready后调用，screen可用
  return wa;
}
function seedFirstRun() {
  const fl = readFactoryLayout();
  if (!fl) return;
  // 出厂布局是在开发机上排的，其他分辨率必须按比例折算再夹进当前工作区，
  // 否则低分辨率屏上小球/控制台直接初始化到屏幕外（Beta反馈P0第1条）
  const wa = currentWorkArea();
  const def = scaleFactory(fl, wa);
  // 小球：当前屏右上角（不用出厂坐标）
  config.ballPos = [Math.round(wa.x + wa.width - 130), Math.round(wa.y + 120)];
  // 控制台：跟出厂布局里的位置（折算后）；出厂没记就居中
  const hubL = def.hub || { x: Math.round(wa.x + (wa.width - 420) / 2), y: Math.round(wa.y + (wa.height - 480) / 2), w: 420, h: 480, zoom: 1, open: true };
  config.hubPos = [hubL.x, hubL.y];
  config.hubSize = [hubL.w, hubL.h];
  config.hubZoom = hubL.zoom;
  config.hubOpen = true;
  config.ui.tint = 0.8;   // 首次打开：背景不透明度默认80%（0907#1 初始模式）= 底板比32%更实、字更清楚
  // 卡片：首启只展开【快速布局】这一张（1011 用户裁定：控制台+快速布局两张，其余全收起来）。
  // ⚠这里**必须显式覆盖 open**：出厂布局文件里 layout 是 open:true，但其它卡也有 open:true（那是给
  //   「默认布局」整套展开用的），不覆盖的话首启会把十几张卡全弹出来——低配机第一印象就是卡死。
  const FIRST_RUN_OPEN = new Set(['layout']);
  for (const [id, c] of Object.entries(def.cards)) {
    config.cards[id] = { x: c.x, y: c.y, w: c.w, h: c.h, zoom: c.zoom, open: FIRST_RUN_OPEN.has(id) };
  }
  // 默认布局存折算后的整套（保留出厂open标志，用户点"默认布局"时才整套展开）
  config.layouts.default = { hub: hubL, cards: def.cards };
  // 出厂内置预设布局（1011）：常用场景整套排布随包分发，首启即出现在布局列表里。
  // 顺序：原有的「魔改布局」在前，内置预设在后——用户自己的排在前面更符合直觉。
  const md = readModdedLayout();
  const builtin = [];
  if (md) {
    const mm = scaleFactory(md, wa);
    builtin.push({ name: md.name || '魔改布局', data: { hub: mm.hub, cards: mm.cards } });
  }
  for (const p of readFactoryLayouts(wa)) builtin.push(p);
  if (builtin.length) config.layouts.custom = builtin;
  config.peeCompactV2 = true;   // 出厂即紧凑版，跳过尿尿卡迁移
  config.noSelFullV2 = true;
  config.schemaV = SCHEMA_V;    // 全新安装=所有迁移天然完成
}
// 改名迁移：产品从「橙子」改名「橙AIper」后userData目录随之更换，
// 首启若新目录无配置而旧「橙子」目录有，整套拷过来（配置+备份），老机器无缝升级、新机器无感
function migrateFromOldDir() {
  try {
    const oldDir = path.join(app.getPath('appData'), '橙子');
    const oldCfg = path.join(oldDir, 'orange-config.json');
    if (!fs.existsSync(oldCfg)) return false;
    const p = configPath();
    fs.copyFileSync(oldCfg, p);
    for (const s of ['.bak1', '.bak2', '.bak3']) {
      try { if (fs.existsSync(oldCfg + s)) fs.copyFileSync(oldCfg + s, p + s); } catch {}
    }
    return true;
  } catch { return false; }
}
function loadConfig() {
  try {
    let saved = readConfigFile();
    if (!saved && migrateFromOldDir()) saved = readConfigFile();
    if (!saved) { seedFirstRun(); return; }   // 首次运行：按出厂默认布局整套就位（读失败仍是内存默认值，不动磁盘现场）
    // ---- 第一段：回读（每个字段都要读，漏读=每次重启回弹，坑28）----
    Object.assign(config.api, saved.api || {});
    Object.assign(config.gen, saved.gen || {});
    if (saved.providers) {
      for (const k of Object.keys(config.providers)) {
        if (saved.providers[k]) Object.assign(config.providers[k], saved.providers[k]);
      }
      // 1107 渠道精简：cus_* 自定义渠道已废除，不再回读（saved 里的旧渠道由 v27 迁移清掉）
    }
    if (saved.provider && config.providers[saved.provider]) config.provider = saved.provider;
    // 内置渠道的显隐（0908 小眼睛）：存在 providers[k].hidden 上，上面 Object.assign 已回读；无需额外字段
    if (saved.cacheDir) config.cacheDir = saved.cacheDir;
    if (saved.locked !== undefined) config.locked = !!saved.locked;
    // 流畅优先开关（铁律19：漏回读=每次重启弹回默认；老配置没这字段=关，不迁移）
    if (saved.perf && typeof saved.perf === 'object') config.perf.lite = !!saved.perf.lite;
    if (saved.forge) Object.assign(config.forge, saved.forge);
    if (saved.comfy) { Object.assign(config.comfy, saved.comfy); if (!config.comfy.params || typeof config.comfy.params !== 'object') config.comfy.params = {}; }
    if (saved.autofix) Object.assign(config.autofix, saved.autofix);
    if (saved.qpresets && typeof saved.qpresets === 'object') {
      config.qpresets.hidden = Array.isArray(saved.qpresets.hidden) ? saved.qpresets.hidden.filter((x) => typeof x === 'string') : [];
      config.qpresets.overrides = (saved.qpresets.overrides && typeof saved.qpresets.overrides === 'object') ? saved.qpresets.overrides : {};
    }
    if (saved.layouts) config.layouts = saved.layouts;
    if (!Array.isArray(config.layouts.custom)) config.layouts.custom = [];
    // 缺默认布局时补出厂默认——但用户主动删过（noDefault）就尊重，不再自动长回来（第21轮：默认布局可删）
    if (!config.layouts.default && !config.layouts.noDefault) {
      const fl = readFactoryLayout();
      if (fl) { const d = scaleFactory(fl, currentWorkArea()); config.layouts.default = { hub: d.hub, cards: d.cards }; }
    }
    if (saved.chat) Object.assign(config.chat, saved.chat);
    if (!config.chat.roleModels || typeof config.chat.roleModels !== 'object') config.chat.roleModels = {};
    // 对话功能分配表回读（铁律19：漏读=每次重启回弹）；老配置没这字段=空对象=全部跟随默认
    if (!config.chat.caps || typeof config.chat.caps !== 'object') config.chat.caps = {};
    for (const k of ['chat', 'json', 'ask']) {
      const v = config.chat.caps[k];
      config.chat.caps[k] = (v && typeof v === 'object') ? { provider: v.provider || '', model: v.model || '' } : { provider: '', model: '' };
    }
    // 语料分配表回读（1013，铁律19）。缺字段时给的是**默认值**（橙子语料 / 内置不叠加），
    // 老配置的改写一律走 MIGRATIONS v25，别在这儿擅自改值。
    if (!config.chat.corpus || typeof config.chat.corpus !== 'object') config.chat.corpus = {};
    if (typeof config.chat.corpus.chat !== 'string') config.chat.corpus.chat = 'b_corpus';
    if (typeof config.chat.corpus.json !== 'string') config.chat.corpus.json = 'b_corpus';
    if (typeof config.chat.corpus.ask !== 'string') config.chat.corpus.ask = '__none__';
    // 对话渠道表回读（铁律19：漏读=每次重启回弹）：内置两个合并，cc_* 逐个补进
    if (saved.chatProviders && typeof saved.chatProviders === 'object') {
      for (const k of Object.keys(saved.chatProviders)) {
        const v = saved.chatProviders[k];
        if (!v || typeof v !== 'object') continue;
        if (config.chatProviders[k]) Object.assign(config.chatProviders[k], v);
        else if (/^cc_[a-z0-9]{3,16}$/.test(k)) config.chatProviders[k] = Object.assign({ label: k, base: '', key: '', models: [] }, v);
      }
    }
    if (Array.isArray(saved.stacks)) config.stacks = saved.stacks;
    // 提示词远程更新（1012）：漏回读=每次重启地址/开关回弹（坑28）
    if (saved.plibUpdate && typeof saved.plibUpdate === 'object') {
      config.plibUpdate.base = typeof saved.plibUpdate.base === 'string' ? saved.plibUpdate.base : '';
      config.plibUpdate.auto = !!saved.plibUpdate.auto;
      config.plibUpdate.lastCheck = Number(saved.plibUpdate.lastCheck) || 0;
      config.plibUpdate.lastResult = typeof saved.plibUpdate.lastResult === 'string' ? saved.plibUpdate.lastResult : '';
    }
    // 软件更新（1013）：同样必须逐字段回读，漏一个就是每次重启回弹（铁律19）
    if (saved.updater && typeof saved.updater === 'object') {
      const u = saved.updater;
      config.updater.autoApp = !!u.autoApp;
      config.updater.autoPlib = !!u.autoPlib;
      config.updater.lastCheck = Number(u.lastCheck) || 0;
      config.updater.lastResult = typeof u.lastResult === 'string' ? u.lastResult : '';
      config.updater.latest = typeof u.latest === 'string' ? u.latest : '';
      config.updater.notes = Array.isArray(u.notes) ? u.notes : [];
      config.updater.seen = typeof u.seen === 'string' ? u.seen : '';
      config.updater.doneFile = typeof u.doneFile === 'string' ? u.doneFile : '';
    }
    // 老的一次性标志继续回读+回写（老版本软件读这份配置时还认它们）
    config.noSelFullV2 = true;
    config.peeCompactV2 = true;
    // 出厂音效播种批次号——漏回读=用户删掉的音效每启复活；兼容老的布尔标志soundSeedV1
    config.soundSeedV = Number(saved.soundSeedV) || (saved.soundSeedV1 ? 1 : 0);
    Object.assign(config.ui, saved.ui || {});
    config.ballPos = saved.ballPos || null;
    config.hubPos = saved.hubPos || null;
    if (Array.isArray(saved.hubSize)) config.hubSize = saved.hubSize;
    if (saved.hubZoom) config.hubZoom = saved.hubZoom;
    config.hubOpen = !!saved.hubOpen;
    config.cards = saved.cards || {};
    // ---- 第二段：一次性迁移（有序表，见MIGRATIONS）+ 每启不变量 ----
    runMigrations(saved);
    applyInvariants();
  } catch {}
}

// ---------- 一次性迁移表（止血0906）：所有"老配置→新结构"的改写只许写在这里 ----------
// 规则：saved.schemaV >= v 的跳过；每条自带幂等守卫（老用户没有schemaV但可能带着旧标志，
// 靠守卫不重跑）；跑完写 config.schemaV = SCHEMA_V。新增迁移 = 表尾追加一条 + SCHEMA_V+1，
// 禁止在loadConfig里散写"if (!saved.xxxV2)"式的一次性逻辑（那正是改A坏B的温床）
const SCHEMA_V = 27;
const MIGRATIONS = [
  { v: 1, name: '无选区跑全图改默认开', up(saved) {
    // 老配置里存过false的也掰成开；此后用户自己的选择保留（守卫=老标志noSelFullV2）
    if (!saved.noSelFullV2) config.gen.noSelFull = true;
  } },
  { v: 2, name: '老api字段→生图渠道（1107 渠道精简后落到影策）', up(saved) {
    if (!saved.providers && saved.api && saved.api.key) {
      config.providers.yingce.key = saved.api.key;
      config.providers.yingce.base = 'https://api.yingce.tv';
    }
  } },
  { v: 3, name: '尿尿卡紧凑版：清掉老的宽高缩放', up(saved) {
    if (!saved.peeCompactV2 && config.cards && config.cards.pee) {
      delete config.cards.pee.w; delete config.cards.pee.h; delete config.cards.pee.zoom;
    }
  } },
  { v: 4, name: '球左键自定义挪到中键 + 自动唤醒提示词卡移除', up(saved) {
    // 左键固定收纳/释放；老配置里左键选的hub/pass搬到中键（习惯不丢），选的gather和左键重复=中键给循环切布局
    if (!saved.ui || !saved.ui.ballMiddle) {
      const old = saved.ui && saved.ui.ballLeft;
      config.ui.ballMiddle = ['hub', 'pass'].includes(old) ? old : 'layout';
    }
    delete config.ui.ballLeft;
    delete config.ui.autoWakePrompt;
  } },
  { v: 5, name: '硬边动效v1(blueprint/obsidian)下架→落到v2(amber/steel)', up(saved) {
    const st = saved.ui && saved.ui.style;
    if (st === 'blueprint') { config.ui.style = 'amber'; config.ui.accent = '#ffb648'; }
    else if (st === 'obsidian') { config.ui.style = 'steel'; config.ui.accent = '#9fb4cc'; }
  } },
  { v: 6, name: '缩放下限0.25→0.45：低于下限的卡按0.45重算宽高（否则setMinimumSize把窗顶大而zoom账仍是旧值=内容与窗口脱节）', up(saved) {
    const base = (id) => MODULES.find((m) => m.id === id);   // 本文件顶部常量（ctx.MODULES在文件尾才赋值）
    for (const [id, c] of Object.entries(config.cards || {})) {
      if (!c || typeof c.zoom !== 'number' || c.zoom >= 0.45) continue;
      const d = base(id);
      c.zoom = 0.45;
      if (d) { c.w = Math.round(d.width * 0.45); c.h = Math.round(d.height * 0.45); }
    }
    if (typeof config.hubZoom === 'number' && config.hubZoom < 0.45) config.hubZoom = 0.45;
  } },
  { v: 7, name: 'AI对话默认从AJI切到GRS的Gemini（0908实测AJI分组下GPT/Claude全部503下架）', up(saved) {
    // 只改"还停在AJI默认值"的用户；用户自己选过GRS/自定义的不动
    const ch = saved.chat || {};
    if (!ch.provider || ch.provider === 'aji') { config.chat.provider = 'grs'; config.chat.model = 'gemini-3.5-flash'; }
  } },
  { v: 8, name: '布局快照里低于0.45的zoom按0.45重算（v6只清了cards，layouts.default/custom漏了→每切一次布局把0.26灌回来）', up(saved) {
    const base = (id) => MODULES.find((m) => m.id === id);
    const fix = (cards) => {
      for (const [id, c] of Object.entries(cards || {})) {
        if (!c || typeof c.zoom !== 'number' || c.zoom >= 0.45) continue;
        const d = base(id);
        c.zoom = 0.45;
        if (d) { c.w = Math.round(d.width * 0.45); c.h = Math.round(d.height * 0.45); }
      }
    };
    const L = config.layouts || {};
    if (L.default) { fix(L.default.cards); if (L.default.hub && typeof L.default.hub.zoom === 'number' && L.default.hub.zoom < 0.45) L.default.hub.zoom = 0.45; }
    for (const x of (L.custom || [])) if (x && x.data) { fix(x.data.cards); if (x.data.hub && typeof x.data.hub.zoom === 'number' && x.data.hub.zoom < 0.45) x.data.hub.zoom = 0.45; }
    fix(config.cards);   // 被老快照灌回过的 cards 再清一遍
  } },
  { v: 9, name: '对齐卡基准 300x200→240x220（与"生成"卡同形，按钮铺满后占比一致）：已存的对齐卡 w/h 按新基准×原zoom重算', up(saved) {
    const d = MODULES.find((m) => m.id === 'align');
    if (!d) return;
    const fix = (c) => {
      if (!c || typeof c.zoom !== 'number') return;
      c.w = Math.round(d.width * c.zoom); c.h = Math.round(d.height * c.zoom);
    };
    fix(config.cards && config.cards.align);
    const L = config.layouts || {};
    if (L.default && L.default.cards) fix(L.default.cards.align);
    for (const x of (L.custom || [])) if (x && x.data && x.data.cards) fix(x.data.cards.align);
  } },
  { v: 10, name: '默认布局里被v6/v8撑宽的锁定卡(96→144)压住右边同排的卡：同排右侧邻居整体右移让出重叠量（只动出厂默认布局那一排，自定义布局不动）', up(saved) {
    const shiftRow = (cards) => {
      const lk = cards && cards.lock;
      if (!lk || typeof lk.x !== 'number' || typeof lk.w !== 'number') return;
      const lockRight = lk.x + lk.w - 12;   // 视觉右沿（12px 透明边距）
      const row = Object.entries(cards).filter(([id, c]) => id !== 'lock' && c && typeof c.x === 'number' && typeof c.y === 'number'
        && Math.abs(c.y - lk.y) < 40 && c.x > lk.x);   // 同一排、在锁定卡右边
      if (!row.length) return;
      row.sort((a, b) => a[1].x - b[1].x);
      const first = row[0][1];
      const overlap = lockRight - (first.x + 12);   // 首个邻居的视觉左沿被压进去多少
      if (overlap <= 0) return;
      for (const [, c] of row) c.x = Math.round(c.x + overlap + 8);   // 让出重叠量再留 8px 缝（与这一排其余缝隙同量级）
    };
    const L = config.layouts || {};
    if (L.default) shiftRow(L.default.cards);
    shiftRow(config.cards);
  } },
  { v: 11, name: '对话渠道独立成 chatProviders（与生图解耦）：内置 aji/grs 的 Key 从生图渠道复制一份；老的 custom/cus_* 对话渠道搬成 cc_*', up(saved) {
    const gp = saved.providers || {};
    const cp = config.chatProviders;
    // 之前对话共用生图的 Key——复制一份过来，老用户升级后对话不断线（之后两边各改各的）
    for (const k of ['aji', 'grs']) {
      if (!cp[k].key && gp[k] && gp[k].key) cp[k].key = gp[k].key;
    }
    const ch = saved.chat || {};
    const mk = (label, src) => {
      const id = 'cc_' + Math.random().toString(36).slice(2, 8);
      cp[id] = { label, base: (src.base || '').trim(), key: (src.key || '').trim(), models: Array.isArray(src.models) ? src.models.slice() : [] };
      return id;
    };
    let cur = ch.provider || config.chat.provider;
    if (cur === 'custom') {
      // 老"自定义"：地址/Key 落在 providers.custom（0907#5）或更老的 chat.base/key
      const src = (gp.custom && (gp.custom.base || gp.custom.key)) ? gp.custom : { base: ch.base, key: ch.key, models: gp.custom && gp.custom.models };
      cur = (src.base || src.key) ? mk('自定义', src) : 'grs';
    } else if (/^cus_/.test(cur) && gp[cur]) {
      cur = mk(gp[cur].label || cur, gp[cur]);
    } else if (!cp[cur]) {
      cur = 'grs';
    }
    config.chat.provider = cur;
    config.chat.base = ''; config.chat.key = '';   // 旧字段清空（不再消费）
  } },
  { v: 12, name: '默认布局换新（用户0908当前排布）：原默认布局改名「魔改布局」进自定义列表（可删）；默认布局本身也可删', up(saved) {
    const L = config.layouts;
    if (!Array.isArray(L.custom)) L.custom = [];
    // 原默认 → 「魔改布局」（同名已存在就不重复塞；用户删过默认（noDefault）也不复活）
    if (L.default && !L.custom.some((c) => c && c.name === '魔改布局')) {
      L.custom.unshift({ name: '魔改布局', data: JSON.parse(JSON.stringify(L.default)) });
    }
    if (!L.noDefault) {
      const fl = readFactoryLayout();
      if (fl) { const d = scaleFactory(fl, currentWorkArea()); L.default = { hub: d.hub, cards: d.cards }; }
    }
  } },
  { v: 13, name: '抗截断/校色两卡窗口统一 220×124（瓷砖钉成固定 DIP 后两卡要同框）：只改还停在 v12 出厂值的条目，同排右侧邻居按 10px 视觉缝顺延', up(saved) {
    const OLD = { anti: [186, 118], colorcal: [210, 124] };
    const NEW = [220, 124];
    const fix = (cards) => {
      if (!cards) return;
      let touched = false;
      for (const id of Object.keys(OLD)) {
        const c = cards[id];
        if (!c || c.w !== OLD[id][0] || c.h !== OLD[id][1]) continue;   // 用户自己调过的不动
        c.w = NEW[0]; c.h = NEW[1]; touched = true;
      }
      if (!touched || !cards.anti) return;
      // 同一排（与 anti 同高±40）且在其右侧的卡，从左到右保证视觉缝 ≥10px（12px 透明边距各扣一次），只往右推不往左拉
      const a = cards.anti;
      const row = Object.entries(cards).filter(([id, c]) => id !== 'anti' && c && typeof c.x === 'number' && Math.abs(c.y - a.y) < 40 && c.x > a.x)
        .sort((p, q) => p[1].x - q[1].x);
      let right = a.x + a.w - 12;
      for (const [, c] of row) {
        const vl = c.x + 12;
        if (vl - right < 10) c.x = Math.round(right + 10 - 12);
        right = c.x + c.w - 12;
      }
    };
    fix(config.cards);
    const L = config.layouts || {};
    if (L.default) fix(L.default.cards);
  } },
  { v: 14, name: '抗截断/校色两卡缩放统一 0.62（瓷砖已钉固定DIP，剩下的玻璃边框/标题字差来自 zoom 不同）：只改仍是出厂 zoom 且已是 220×124 的条目', up(saved) {
    const OLDZ = { anti: 0.5523201515035016, colorcal: 0.7 };
    const fix = (cards) => {
      if (!cards) return;
      for (const id of Object.keys(OLDZ)) {
        const c = cards[id];
        if (!c || c.w !== 220 || c.h !== 124 || Math.abs((c.zoom || 0) - OLDZ[id]) > 1e-6) continue;
        c.zoom = 0.62;
      }
    };
    fix(config.cards);
    const L = config.layouts || {};
    if (L.default) fix(L.default.cards);
  } },
  { v: 15, name: '抗截断/校色去标题栏后窗口改 260×100（三个正方形大按钮撑满卡身）：只改仍是 220×124/0.62 出厂值的条目，同排右侧邻居按 10px 视觉缝顺延', up(saved) {
    const fix = (cards) => {
      if (!cards) return;
      let touched = false;
      for (const id of ['anti', 'colorcal']) {
        const c = cards[id];
        if (!c || c.w !== 220 || c.h !== 124 || Math.abs((c.zoom || 0) - 0.62) > 1e-6) continue;
        c.w = 260; c.h = 100; touched = true;
      }
      if (!touched || !cards.anti) return;
      const a = cards.anti;
      const row = Object.entries(cards).filter(([id, c]) => id !== 'anti' && c && typeof c.x === 'number' && Math.abs(c.y - a.y) < 40 && c.x > a.x)
        .sort((p, q) => p[1].x - q[1].x);
      let right = a.x + a.w - 12;
      for (const [, c] of row) {
        const vl = c.x + 12;
        if (vl - right < 10) c.x = Math.round(right + 10 - 12);
        right = c.x + c.w - 12;
      }
    };
    fix(config.cards);
    const L = config.layouts || {};
    if (L.default) fix(L.default.cards);
  } },
  { v: 16, name: '生图分辨率去掉Auto（0908用户裁定）：存过Auto/空值的按2K（Auto在AJI主渠道原本就落到2K）', up() {
    if (!['1K', '2K', '4K'].includes(config.gen.size)) config.gen.size = '2K';
  } },
  { v: 17, name: '「卡牌只浮在PS之上」改默认开（0909晚用户反馈：默认关=用户不知道有这功能，照样挡浏览器）：老配置一次性拨开，之后随用户', up() {
    config.ui.psOnlyTop = true;
  } },
  { v: 18, name: '清理 v5.18.45 污染进布局的假堆（切到没叠牌的老布局时把屏幕现堆写了进去）：布局里记的堆若成员位置不是叠着的（同x·各高一条）就删；真堆位置必然叠着，不会误删', up() {
    const { stackGeomOk } = require('./deck-geo');
    const clean = (name, d) => {
      if (!d || !Array.isArray(d.stacks) || !d.stacks.length) return;
      const keep = d.stacks.filter((s) => stackGeomOk(s, d.cards));
      if (keep.length !== d.stacks.length) {
        try { ctx.dlog('[config] v18 布局「' + name + '」删去假堆 ' + d.stacks.filter((s) => !keep.includes(s)).map((s) => (s.order || s.members || []).join('/')).join(' | ')); } catch {}
        d.stacks = keep;
      }
    };
    const L = config.layouts || {};
    clean('默认', L.default);
    for (const x of (L.custom || [])) if (x && x.data) clean(x.name, x.data);
  } },
  { v: 19, name: '对话功能分配表 caps 首次引入：老配置没有这个字段，补成空对象（=全部跟随默认）。Life 分支已恢复「来福」人设角色 b_orange，故不做上游的 b_orange→b_corpus 重映射', up() {
    const ch = config.chat || (config.chat = {});
    if (!ch.caps || typeof ch.caps !== 'object') ch.caps = {};
    for (const k of ['json', 'ask']) {
      const v = ch.caps[k];
      ch.caps[k] = (v && typeof v === 'object') ? { provider: v.provider || '', model: v.model || '' } : { provider: '', model: '' };
    }
  } },
  { v: 20, name: '出厂布局按新折算重算（1012 用户 2560×1600@150% 实报「默认布局乱」：旧算法撞 0.45 下限/最小宽后卡被撑大互相压住）：存着的默认布局/魔改布局/内置预设若仍是旧算法在当前屏幕原样算出的（=用户没动过）就重算，动过的一律不碰', up() {
    const L = config.layouts;
    if (!L) return;
    const wa = currentWorkArea();
    const redo = (label, fl, data) => {
      if (!fl || !data || !data.cards) return null;
      if (!LS.sameLayout(data, LS.scaleFactoryV1(fl, wa, MODULES))) return null;
      const n = LS.scaleFactory(fl, wa, MODULES);
      try { ctx.dlog('[config] v20 「' + label + '」仍是旧折算原样，按新折算重算（工作区 ' + wa.width + 'x' + wa.height + '）'); } catch {}
      return n;
    };
    const fl = readFactoryLayout();
    const d = redo('默认布局', fl, L.default);
    if (d) L.default = Object.assign({}, L.default, { hub: d.hub || L.default.hub, cards: d.cards });
    if (!Array.isArray(L.custom)) return;
    const src = {};
    const md = readModdedLayout();
    if (md) src[md.name || '魔改布局'] = md;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SRC, 'factory-layouts.json'), 'utf8'));
      for (const p of (j && j.presets) || []) if (p && p.name) src[String(p.name)] = p;
    } catch {}
    for (const x of L.custom) {
      if (!x || !x.data || !src[x.name]) continue;
      const n = redo(x.name, src[x.name], x.data);
      if (n) x.data = Object.assign({}, x.data, { hub: n.hub || x.data.hub, cards: n.cards });
    }
  } },
  { v: 21, name: '提示词远程更新上线（1012）：老配置补齐 plibUpdate 字段——地址留空、自动更新默认关（用户自己开）；只补结构，不替用户开任何开关', up(saved) {
    if (!config.plibUpdate || typeof config.plibUpdate !== 'object') config.plibUpdate = { base: '', auto: false, lastCheck: 0, lastResult: '' };
    if (typeof config.plibUpdate.base !== 'string') config.plibUpdate.base = '';
    config.plibUpdate.auto = !!config.plibUpdate.auto;   // 老配置没有=false，绝不默认开
  } },
  { v: 22, name: '墨墨（momo）对话渠道上线（1013）——生图侧已随 1107 渠道精简移除，只补对话侧槽位；地址内置，用户只填 Key', up(saved) {
    // 对话侧：0908 起对话渠道是独立表，momo 原来不在里面 → 补上
    if (!config.chatProviders.momo || typeof config.chatProviders.momo !== 'object') {
      config.chatProviders.momo = { label: '墨墨', base: 'https://api.momoapi.icu', key: '', models: [] };
    }
  } },
  { v: 23, name: '模型/语料解耦（1013 用户裁定）：①「默认渠道/模型」那块界面删掉，槽位搬进「其它功能的模型」当 AI对话 一行（caps.chat）②转JSON 与 AI对话 各自能选语料，与模型分开（chat.corpus）——两边补空值=跟随当前角色=行为与加这两样之前完全一致', up(saved) {
    const ch = config.chat || (config.chat = {});
    if (!ch.caps || typeof ch.caps !== 'object') ch.caps = {};
    for (const k of ['chat', 'json', 'ask']) {
      const v = ch.caps[k];
      ch.caps[k] = (v && typeof v === 'object') ? { provider: v.provider || '', model: v.model || '' } : { provider: '', model: '' };
    }
    // 「AI对话」行**预填**成老的那对值（provider/model）——这是"原地搬家"：原来没指定专属模型的角色
    //   以前吃 config.chat.provider/model，现在吃 caps.chat，预填上就一字不差地延续。
    //   ⚠这里**不校验模型名**：迁移跑在 config 加载期，此刻 ctx.PROVIDERS 还没挂上
    //   （providers.js 排在 state.js 之后加载，实测 undefined），内置渠道的静态模型表读不到，
    //   "对齐一个已下架的模型名"这件事在迁移期做不了。改由渲染端 renderCaps 时对齐（那儿拿到的是
    //   主进程解析用的同一张表），迁移只管搬家、不管校名。
    if (!ch.caps.chat.provider && ch.provider) {
      ch.caps.chat.provider = ch.provider;
      ch.caps.chat.model = ch.model || '';
    }
    // 语料表：**故意全部留空**。空串='跟随当前角色'，正是老行为；绝不能拿 currentPreset 去填，
    // 否则用户以后切角色，转JSON 那边还钉在旧语料上（这就是这次要治的病）。
    if (!ch.corpus || typeof ch.corpus !== 'object') ch.corpus = { chat: '', json: '' };
    for (const k of ['chat', 'json']) {
      ch.corpus[k] = typeof ch.corpus[k] === 'string' ? ch.corpus[k] : '';
    }
    // config.chat.provider/model **保留**：caps.chat 留空时的兜底，也是老用户不碰新行时的延续
  } },
  { v: 24, name: '角色专属模型整块移除（1013 用户裁定"多角色不管"）：删界面前先把"实际生效的那份"搬进 caps.chat——否则新的 AI对话 行会回落到 chat.model，用户模型被静默换掉', up(saved) {
    const ch = config.chat || (config.chat = {});
    if (!ch.caps || typeof ch.caps !== 'object') ch.caps = {};
    if (!ch.caps.chat || typeof ch.caps.chat !== 'object') ch.caps.chat = { provider: '', model: '' };
    const rm = (ch.roleModels && typeof ch.roleModels === 'object') ? ch.roleModels : {};
    // 搬哪个角色的？**当前在用的那个**（currentPreset）——它才是"用户实际在跑"的模型。
    // 实测本机：currentPreset=b_corpus → roleModels[b_corpus]={grs, gemini-3.8-flash}，
    //   而 caps.chat 那时已经被 v23 预填成 {grs, gpt-5.6-sol}（= 被角色专属盖住的死值）。
    //   不搬的话，删掉角色专属后 gpt-5.6-sol 会突然生效 —— 用户看到的模型被换了，这才是真坑。
    const cur = String(ch.currentPreset || '').trim();
    const curRm = cur && rm[cur] && rm[cur].provider ? rm[cur] : null;
    if (curRm) {
      try { ctx.dlog('[config] v24 角色专属模型搬进 AI对话 行: ' + curRm.provider + '/' + (curRm.model || '') + '（原 caps.chat=' + (ch.caps.chat.provider || '空') + '/' + (ch.caps.chat.model || '空') + '）'); } catch (e) {}
      ch.caps.chat = { provider: curRm.provider, model: curRm.model || '' };
    }
    // 数据清干净：留着它毫无意义（解析链已经不读 roleModels 了），还会让后来者以为它还在生效
    ch.roleModels = {};
    // 顺带把半合成识图的语料补成默认值（=内置语料，与老行为一致）
    if (!ch.corpus || typeof ch.corpus !== 'object') ch.corpus = { chat: '', json: '', ask: '__builtin__' };
    if (typeof ch.corpus.ask !== 'string' || !ch.corpus.ask) ch.corpus.ask = '__builtin__';
  } },
  { v: 25, name: '语料下拉去掉「跟随当前角色」这一档，并把两个语料名字分清楚（1013 用户裁定）：橙子语料=内置角色 b_corpus（AI对话/转JSON 的默认）；内置语料=半合成卡写死的那套看图用词，**不是角色**，对应"不叠加角色语料"这个档。老的空值就地钉成具体角色名——不钉的话换角色时语料还会跟着变，等于没做到"精确到角色名"', up(saved) {
    const ch = config.chat || (config.chat = {});
    if (!ch.corpus || typeof ch.corpus !== 'object') ch.corpus = {};
    // 解析"当时到底用的哪个角色"——逻辑对齐 chat.js 的 resolveCorpus(pick='')：
    //   currentPreset 是**自定义角色且正文非空** → 用它的名字；其余（内置角色 id / 空 / 找不到）→ 橙子语料。
    const cur = String(ch.currentPreset || '').trim();
    const cu = (ch.presets || []).find((p) => p && p.name === cur);
    const pinned = (cu && String(cu.prompt || '').trim()) ? cur : 'b_corpus';
    for (const k of ['chat', 'json']) {
      const v = ch.corpus[k];
      // 空 = 老的「跟随当前角色」；'__builtin__' 是本轮中途出现过的一个哨兵值（已废弃）——
      //   它当时指的就是橙子语料，一并归一到 b_corpus，免得留个没人认的值在配置里
      if (v === undefined || v === null || v === '' || v === '__builtin__' || v === '橙子语料') ch.corpus[k] = pinned;
    }
    // ask（半合成）：默认 = 内置语料 = 不叠加角色语料
    const av = ch.corpus.ask;
    if (av === undefined || av === null || av === '' || av === '__builtin__' || av === 'b_corpus' || av === '橙子语料') {
      ch.corpus.ask = '__none__';
    }
  } },
  { v: 26, name: '软件更新卡上线（1013）：新增 config.updater（两个自动开关默认**关**）；把用户已经开过的提示词自动更新（plibUpdate.auto）搬进 updater.autoPlib，免得他升级后发现开关被重置', up(saved) {
    if (!config.updater || typeof config.updater !== 'object') {
      config.updater = { autoApp: false, autoPlib: false, lastCheck: 0, lastResult: '', latest: '', notes: [], seen: '', doneFile: '' };
    }
    // 搬家：老开关开着 → 新的也开着（用户的选择不能因为换界面就丢）
    //   ⚠plibUpdate.auto 本身**不关掉**：plib-update.js 的开机检查还读它，
    //     新卡的开关写的是 updater.autoPlib，两边由 updater.js 的开机逻辑统一成"或"关系。
    if (saved.plibUpdate && saved.plibUpdate.auto) config.updater.autoPlib = true;
    // autoApp 一律保持原值（新装=默认 false：不让用户默认背上下载流量）
    config.updater.autoApp = !!config.updater.autoApp;
  } },
  { v: 27, name: '生图渠道精简（1107 用户裁定）：只留影策/万有引力两家 /v1 站，墨墨/AJI/GRS/自定义全部移除。旧渠道的 Key 不迁移（站点不同 Key 不通用），当前渠道指向已删渠道时改回默认影策', up() {
    // 默认表已经是新的 yingce/wanyin（state 默认值），这里只清 saved 里回读过/将回读不到的旧渠道残留
    for (const k of Object.keys(config.providers)) {
      if (k !== 'yingce' && k !== 'wanyin') delete config.providers[k];
    }
    if (!config.providers[config.provider]) config.provider = 'yingce';
  } },
];
function runMigrations(saved) {
  const from = Number(saved.schemaV) || 0;
  for (const m of MIGRATIONS) {
    if (m.v <= from) continue;
    try {
      m.up(saved);
      try { ctx.dlog('[config] 迁移 v' + m.v + ' ' + m.name); } catch {}
    } catch (e) {
      try { ctx.dlog('[config] 迁移 v' + m.v + ' 失败: ' + (e && e.message)); } catch {}
    }
  }
  config.schemaV = SCHEMA_V;
}
// 每次启动都要成立的不变量（不是迁移，别往MIGRATIONS里塞）
function applyInvariants() {
  // 布局锁定已并入锁头（一键双锁）：启动时强制跟随locked——老配置里独立的layoutLock=true必须被覆盖
  config.layoutLock = config.locked;
  config.gen.forgePos = '';   // 一次性信使字段，清掉历史残留防重放
  config.ui.theme = 'dark';   // 只保留深色主题
  // 模型清单清洗（0908用户裁定"绝对不允许"）：生图渠道只留生图模型、对话渠道只留语言模型（老配置里混进的一并清掉）
  const MK = require('./model-kind');
  const DYN_PROV = { yingce: 1, wanyin: 1 };   // 动态渠道（模型靠拉取，回读时校验；1107 渠道精简后只有这两家）
  for (const k of Object.keys(config.providers)) {
    const pc = config.providers[k];
    if (!pc) continue;
    if (Array.isArray(pc.models)) pc.models = pc.models.filter(MK.isImageModel);
    if (DYN_PROV[k] && pc.model && !MK.isImageModel(pc.model)) pc.model = '';
  }
  for (const k of Object.keys(config.chatProviders)) {
    const cp = config.chatProviders[k];
    if (cp && Array.isArray(cp.models)) cp.models = cp.models.filter(MK.isChatModel);
  }
  if (config.chat.model && !MK.isChatModel(config.chat.model)) config.chat.model = '';
}

// 写安全网：tmp+rename原子替换（写一半崩溃/断电不会截断正主文件）；
// 每次启动的首个保存前，把上一份好文件轮转进备份（bak1新→bak3旧）
let bakRotated = false;
function rotateBackups() {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) return;
    for (let i = 2; i >= 1; i--) {
      if (fs.existsSync(p + '.bak' + i)) { try { fs.copyFileSync(p + '.bak' + i, p + '.bak' + (i + 1)); } catch {} }
    }
    fs.copyFileSync(p, p + '.bak1');
  } catch {}
}
function writeConfigNow() {
  const p = configPath();
  try {
    if (!bakRotated) { rotateBackups(); bakRotated = true; }
    fs.writeFileSync(p + '.tmp', JSON.stringify(config, null, 2));
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    try { fs.appendFileSync(ctx.glassLogPath(), new Date().toISOString() + ' [config] 保存失败: ' + (e && e.message) + '\n'); } catch {}
  }
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 400);
}
// 退出前把还在防抖等待中的保存立刻落盘（不然最后400ms内的改动会丢）
app.on('before-quit', () => { clearTimeout(saveTimer); writeConfigNow(); });

// ---------- 配置IPC ----------
ipcMain.handle('get-config', () => config);
ipcMain.handle('set-config', (e, patch) => {
  if (patch.api) Object.assign(config.api, patch.api);
  if (patch.gen) {
    Object.assign(config.gen, patch.gen);
    // 武装自动切换（用户要求）：改提示词→武装提示词卡；改其他参数→武装对应卡
    if (patch.gen.prompt !== undefined && ctx.armModule) {
      ctx.armModule('prompt-box');
    } else if (patch.gen.scDen !== undefined || patch.gen.scRel !== undefined || patch.gen.scStudio !== undefined || patch.gen.scHalf !== undefined || patch.gen.scObj !== undefined || patch.gen.scIp !== undefined || patch.gen.scGnd !== undefined || patch.gen.scFloat !== undefined) {
      // 半合成卡参数（scDen/scRel/scStudio/scHalf/scObj/scIp/scGnd/scFloat）→武装 composite
      if (ctx.armModule && ctx.modById && ctx.modById['composite']) ctx.armModule('composite');
    } else if (patch.gen.fxCurrent !== undefined) {
      // 特效卡参数（fxCurrent=当前特效ID）→武装 fx
      if (ctx.armModule && ctx.modById && ctx.modById['fx']) ctx.armModule('fx');
    } else if (Object.keys(patch.gen).some((k) => k !== 'prompt' && k !== 'batchAll' && k !== 'genTimeout' && k !== 'autoCleanDays' && k !== 'noSelFull' && k !== 'forgeFields' && k !== 'forgeStarred' && !k.startsWith('sc') && k !== 'fxCurrent')) {
      // 其他生图参数（ratio/size等，排除开关/配置/Forge内部字段）→武装 ai-gen（提示词卡的参数面板）
      if (ctx.modById && ctx.modById['ai-gen']) ctx.armModule('ai-gen');
      else ctx.armModule('prompt-box');   // ai-gen卡不存在时回退提示词卡
    }
  }
  if (patch.ui) {
    Object.assign(config.ui, patch.ui);
    ctx.broadcast('ui-vars', config.ui);   // 界面参数实时应用到所有窗口
    if ((patch.ui.psOnlyTop !== undefined || patch.ui.psDialogTop !== undefined) && ctx.fgwatchSync) { try { ctx.fgwatchSync(); } catch (e) {} }   // 「只浮在PS之上」/「弹窗优先」开关即时生效
  }
  if (patch.gen) ctx.broadcast('gen-vars', config.gen);   // 提示词等跨卡片同步
  if (patch.provider && config.providers[patch.provider]) config.provider = patch.provider;
  if (patch.providers) {
    for (const k of Object.keys(patch.providers)) {
      const v = patch.providers[k];
      if (v === null) continue;   // 1107 渠道精简：自定义渠道已废除，null 删除请求直接忽略
      if (config.providers[k]) Object.assign(config.providers[k], v);
    }
    if (typeof ctx.broadcast === 'function') ctx.broadcast('providers-changed', {});   // 渠道增删/显隐→各卡刷新（broadcast 由 windows.js 稍后挂上，启动早期可能还没有）
  }
  // 流畅优先（低配电脑）：写入后立即重算轮询频率/回收时限/动画开关，并广播给各卡（省得重启才生效）
  if (patch.perf && typeof patch.perf === 'object') {
    Object.assign(config.perf, patch.perf);
    try { if (ctx.applyPerf) ctx.applyPerf('设置卡切换'); } catch (e) {}
    ctx.broadcast('perf-vars', config.perf);
    try { ctx.dlog('[perf] 流畅优先=' + !!config.perf.lite); } catch {}
  }
  if (patch.locked !== undefined) {
    // 排查探针：锁定的每次切换都落日志+发起窗口（点气泡却切锁定的悬案侦办中）
    try { ctx.dlog('[lock] locked→' + !!patch.locked + ' 来自 ' + ((e && e.sender && e.sender.getURL()) || '?').split('/').pop()); } catch {}
    // 锁头一键双锁（用户裁定）：穿透与布局锁定同起同落，界面上只有「锁定」一个概念
    config.locked = !!patch.locked;
    config.layoutLock = config.locked;
    ctx.broadcast('lock-state', { locked: config.locked });
  }
  if (patch.forge) {
    Object.assign(config.forge, patch.forge);
    // 武装自动切换：改 Forge 参数→武装 Forge 卡
    if (ctx.armModule && ctx.modById && ctx.modById['forge']) ctx.armModule('forge');
  }
  if (patch.comfy) {
    Object.assign(config.comfy, patch.comfy);   // params 由 comfy.js 自己的通道写，这里只接 url/current
    // 武装自动切换：改 ComfyUI 参数→武装 ComfyUI 卡（current=切换工作流也算调节）
    if (ctx.armModule && ctx.modById && ctx.modById['comfy']) ctx.armModule('comfy');
  }
  // 缓存文件夹（0911 设置卡自定义）：空串/非法=回到默认位置（null → genDir() 走 temp/orange-ai）；三处齐：这里放行 + loadConfig 回读 + genDir 消费
  if (patch.cacheDir !== undefined) {
    const p = (typeof patch.cacheDir === 'string') ? patch.cacheDir.trim() : '';
    const before = genDir();
    config.cacheDir = p || null;
    const after = genDir();
    // 进度索引跟着缓存夹搬（0913 持久化）：留在旧夹=下次启动读不到
    if (before !== after && ctx.tasksFileMoveTo) { try { ctx.tasksFileMoveTo(after); } catch (e) {} }
    try { ctx.dlog('[cache] 缓存文件夹 → ' + (config.cacheDir || '(默认)')); } catch (e) {}
  }
  if (patch.autofix) {
    Object.assign(config.autofix, patch.autofix);
    // 武装自动切换：改自动修图参数→武装自动修图卡
    if (ctx.armModule && ctx.modById && ctx.modById['autofix']) ctx.armModule('autofix');
  }
  if (patch.chat) {
    Object.assign(config.chat, patch.chat);
    ctx.broadcast('chat-vars', config.chat);   // 对话卡模型徽标等实时跟随（替代页面5秒轮询）
  }
  if (patch.chatProviders && typeof patch.chatProviders === 'object') {
    // 对话渠道表（0908 与生图解耦）：内置 aji/grs 只许改字段；cc_* 可增/改/删（null=删，删当前渠道回落 grs）
    for (const k of Object.keys(patch.chatProviders)) {
      const v = patch.chatProviders[k];
      if (v === null) {
        if (/^cc_/.test(k)) { delete config.chatProviders[k]; if (config.chat.provider === k) config.chat.provider = 'grs'; }
        continue;
      }
      if (!v || typeof v !== 'object') continue;
      if (config.chatProviders[k]) Object.assign(config.chatProviders[k], v);
      else if (/^cc_[a-z0-9]{3,16}$/.test(k)) config.chatProviders[k] = Object.assign({ label: k, base: '', key: '', models: [] }, v);
    }
    ctx.broadcast('chat-vars', config.chat);
  }
  if (patch.plibUpdate && typeof patch.plibUpdate === 'object') {
    // 提示词远程更新（1012）：地址与自动开关；lastCheck/lastResult 只由 plib-update.js 自己写，这里不接
    if (typeof patch.plibUpdate.base === 'string') config.plibUpdate.base = patch.plibUpdate.base.trim().replace(/\/+$/, '');
    if (patch.plibUpdate.auto !== undefined) config.plibUpdate.auto = !!patch.plibUpdate.auto;
    ctx.broadcast('plib-update-vars', config.plibUpdate);
  }
  if (patch.updater && typeof patch.updater === 'object') {
    // 软件更新（1013，更新卡）：只接用户能改的开关。
    // ⚠lastCheck/lastResult/latest/notes/doneFile 由 updater.js 自己写——这里**不接**，
    //   否则渲染端一句 setConfig 就能伪造"有新版本"（与 plibUpdate 同一条纪律）。
    if (patch.updater.autoApp !== undefined) config.updater.autoApp = !!patch.updater.autoApp;
    if (patch.updater.autoPlib !== undefined) config.updater.autoPlib = !!patch.updater.autoPlib;
    if (typeof patch.updater.seen === 'string') config.updater.seen = patch.updater.seen;   // 用户"已看过"标记（清红点）
    ctx.broadcast('updater-vars', config.updater);
  }
  saveConfig();
  return config;
});
ipcMain.on('set-theme', (_e, theme) => {
  config.ui.theme = theme;
  saveConfig();
  ctx.broadcast('theme', theme);
});

ctx.SRC = SRC;
ctx.MODULES = MODULES;
ctx.MODULES_ALL = MODULES_ALL;   // 含学员特供占位，仅供控制台画灰气泡
ctx.modById = modById;
ctx.config = config;
ctx.configPath = configPath;
ctx.genDir = genDir;
ctx.loadConfig = loadConfig;
ctx.saveConfig = saveConfig;
ctx.flushConfig = writeConfigNow;   // 系统关机路径（app.exit 不走 before-quit）手动同步落盘
