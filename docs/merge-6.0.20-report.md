# Life-ai 6.0.8 → 6.0.20 合并报告

> 合并日期：2026-11-07 ｜ 策略：整体采用官方「橙AIper」6.0.20 为新基线 + 重套「来福 Life」品牌层
> 备份：`backup-6.0.8-20261106-233909`（旧源码全量 163 文件）｜ 装机版回滚快照：`rollback-resources-20261107-021434`（旧 app.asar + 旧 ps-bridge + 旧 unpacked）

---

## 一、合并内容（官方 6.0.20 新功能）

- **软件更新卡**（1013）：`core/updater.js` + `renderer/updater.html`，两个自动开关（autoApp/autoPlib）默认**关**
- **提示词库云端更新**：`core/plib-update.js`、`core/plib-parse.js`（本地底账 `documents/橙子/plib-sync.json`）
- **AI对话/转JSON 语料解耦**（1011/1013，见下文「角色结构」）
- **出厂布局折算重算**（1012，修 2560×1600@150% 布局乱）：`core/layout-scale.js` + `state.js` v20 迁移
- **拼音搜索**：`renderer/pinyin.js`、`pinyin-map.js`
- **PS 桥接 1.0.59 → 1.0.66**：新命令、批处理、工具预设导入；安装脚本 `bridge-machine-install.ps1` 重写（纯 ASCII，文案读 manifest.json，品牌自动跟随）
- **新出厂提示词**：`factory_prompts/` 新增 prop-material 等 9 套、`factory-layouts.json`
- **性能与修复**：windows.js 1010-1014 系列修复（卡牌置顶/前台抢回等）

## 二、品牌层（来福 Life）回套清单

### 显示文案（用户可见串，共 ~90 处）
| 区域 | 内容 |
|---|---|
| core | autofix/bridge-install/bridge/com-bridge/gen/glow(来福辉光)/misc(尿尿提醒)/relight(来福主体_/来福打光：)/qpresets(来福预设：×7)/tray(退出来福) |
| renderer | ball/chat/comfy/forge/glass/glow.html/icons.js(life-logo 图标)/prompts×6/relight fallback×8/settings(来福自己/来福悬浮球/来福图标)/statement(原作者 oranG) |
| ps-bridge | manifest「来福桥接」、bridge.js 全部 commandName（来福：×××）、index.html |
| 预设资产 | `marquee.tpl` 16 个预设名按字节替换橙子→来福（MD5 与旧版一致），PS 里手录过的旧「橙子预设_」仍被回退链兼容 |

### 主题与图标
- `theme.css`：深色 `--accent` `#ff9f0a`→青色 `#19b5bc`；末尾追加 `.life-mark` 品牌块（球/托盘菜单图标走 `assets/life-logo.png`）
- `relight.html` 8 处 `--accent-rgb` fallback 改青色 `25,181,188`
- 浅色主题保持官方 `#ff9500`（与旧分支一致，未改）

### 角色结构（重要）
上游 6.0.20 按「1011 用户裁定」删除了人设角色，只留语料角色。**Life 分支恢复了旧版双角色**：
```js
BUILTIN_ROLES = [
  { id: 'b_orange', name: '来福', file: 'orange.txt' },                       // 可见人设，文本随角色表下发
  { id: 'b_corpus', name: '来福语料（阉割版）', file: 'corpus-20260726.txt', hidden: true },  // 工法语料，文本不出主进程
]
```
- `chat.html` selectRole 恢复 hidden 分支（可见角色显示原文、hidden 显示面具文案）
- `state.js` v19 迁移改为**只补 caps**、删除 b_orange→b_corpus 重映射（角色已恢复，重映射会破坏人设选择）
- v25 语料归一保留：旧配置空值钉到 b_corpus；旧值「来福语料（阉割版）」按名解析命中
- ⚠ 注意（1013 架构）：**系统提示词由「其它功能的模型 → AI对话 → 语料」下拉决定，不再跟随角色**。想让「来福」人设实际作答，把语料挑成「来福」即可

### 有意保留的「橙子」串（数据连续性，勿改）
- 数据目录 `documents\橙子\…`（chat/comfy/forge/glow/misc/plib/qpresets/imports/forge-presets/glow-presets/sounds）
- userData `appData\橙AIper`（index.js:11）、AUMI `com.orange.aiper`、插件 id `com.orange.*`
- comfy.js:170 工作流匹配正则 `/橙子|输入|input|ps\b|photoshop/i`
- plib-import「橙子魔改版」插件标签（与 UXP 插件存储实际 id 对应）
- updater 临时目录 `orange-update`、state.js 迁移描述中的历史值
- factory_prompts 内 JSON 提示词正文中的「橙子PS插件」正则描述（own04.json 标题等）

## 三、验证记录

- `node --check`：50 个 JS 全通过（src + ps-bridge）
- 项目自带 `scripts/check-source.cjs`：163 个源文件/JSON/渲染端检查通过
- modules.json 全部注册模块文件在位（含新增 statement/updater）
- 关键 JSON（modules/factory-layouts/prop-material/manifest/package）解析通过
- 残留「橙子/橙AIper」全扫描：剩余项均为上述有意保留（路径/注释/正则/回退链）
- electron-builder 打包成功 → `dist\win-unpacked` 冷启动 14 进程正常 → 已部署装机目录 → 装机版 `Life-ai.exe` 冷启动 12 进程正常
- 新 asar 内抽查：package.json `life-ai 6.0.20`、chat.js 双角色、orange.txt「来福」人设、theme.css 青色+life-mark ✓
- `resources\ps-bridge` 同步为 1.0.66「来福桥接」✓

## 四、⚠️ 重要风险：自动更新

新版 `core/updater.js` 的内置更新源指向**官方 OSS**：
```
BUILTIN_BASE = 'https://chengzi-prompt.oss-cn-hongkong.aliyuncs.com'
```
若在「设置 → 软件更新」开启**自动更新**（autoApp），会下载官方「橙AIper」安装包覆盖 Life-ai 品牌。

**建议**：
1. 保持「自动检查更新」「自动下载」两个开关**默认关闭**（当前默认值即关闭，未动过就不受影响）
2. 需要更新时：先在本仓库合并上游新版 + 重套品牌层（参照本报告流程），再手动打包
3. 「提示词库更新」（autoPlib）拉的是提示词内容，不带品牌，风险较低，可按需开启

## 五、文件清单与回滚

| 位置 | 说明 |
|---|---|
| `source\` | 合并后的源码（6.0.20 基线 + 来福品牌），开发预览走 `启动开发预览.cmd` |
| `resources\app.asar` 等 | 已更新的装机版（7.7MB，来自 source 打包） |
| `backup-6.0.8-20261106-233909\` | 旧 6.0.8 源码全量备份 |
| `rollback-resources-20261107-021434\` | 装机版旧 app.asar/ps-bridge/unpacked 快照 |
| `source\dist\win-unpacked\` | 本次构建产物（可整体复制部署，也可 `npm run build` 出安装包） |

**回滚方法**：把 `rollback-resources-20261107-021434\` 三个子项拷回 `resources\` 即可还原装机版；源码回滚用 backup 目录覆盖 `source\src`。
