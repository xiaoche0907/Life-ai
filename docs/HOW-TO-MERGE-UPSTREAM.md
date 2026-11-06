# 官方新版合并指南（HOW-TO-MERGE-UPSTREAM）

> 官方「橙AIper」出新版后，照这份清单把新功能合并进 Life（来福）分支。
> 上次执行：2026-11-07，6.0.8 → 6.0.20，记录见 `merge-6.0.20-report.md`。

## 前置认知

- 本仓库 `source/` = 独立 git 仓库 = Life 分支源码。上游 exe 需先解包出源码。
- 合并策略：**整体以上游新版为基线覆盖 + 重新套「来福」品牌层**。不要逐文件手挑。
- 品牌替换只动**用户可见字符串**；数据路径、注释、正则、id 一律保留（见第四节）。

## 一、解包上游新版（10 分钟）

1. 拿到官方新版安装后的 `resources\app.asar`
2. 解包：`npx @electron/asar extract app.asar _new_extracted`
3. 出清单备查：`npx @electron/asar list app.asar > _asar_list.txt`

## 二、差异比对（10 分钟）

与上次合并的基线（`git log` 找到「合并官方橙AIper x.x.x」那个提交的树，或本地 `backup-*` 目录）逐文件 MD5 比对：

- 内容有变化的文件 + 新增文件 → 都要覆盖进来
- 本分支独有文件（`assets/life-logo.png`、`core/dev-reload.js` 等）→ **必须保留**

## 三、覆盖 + 品牌回套（30 分钟）

1. 覆盖：`_new_extracted\src\*` → `source\src`，`_new_extracted\ps-bridge\*` → `source\ps-bridge`（覆盖前先备份）
2. 按下面的**品牌替换表**逐条执行替换（写个带计数校验的 Node 脚本，期望处数不符就报错不写盘）
3. 逐项核对「保留不动」清单没被覆盖坏

### 品牌替换表（6.0.20 实测，新版可参考但行号会漂移）

| 文件 | 替换内容 |
|---|---|
| core/autofix.js | `橙AIper 自动修图已全部完成` → `来福 …` |
| core/bridge-install.js | `'橙子桥接'` → `'来福桥接'`（含 fallback 与提示文案） |
| core/bridge.js | `PS里跑的橙子插件` → `来福插件` |
| core/com-bridge.js | `"橙子 生成组"` → `"来福 生成组"` |
| core/gen.js | `PS里的橙子插件` / `不是橙子写的` → 来福 |
| core/glow.js | `LAYER_NAME '橙子辉光'` → `'来福辉光'` + commandName 同步 |
| core/misc.js | `🚽 橙子提醒你该尿尿了！` → 来福 |
| core/qpresets.js | `'橙子预设：'` ×7 → `'来福预设：'` |
| core/relight.js | `'橙子主体_'` → `'来福主体_'`；`橙子打光：` ×3 → 来福 |
| core/tray.js | `退出橙AIper` → `退出来福`；tooltip → 来福 |
| renderer/ball.html | `退出橙子` → `退出来福` |
| renderer/chat.html | 兜底 `mk('b_corpus','橙子语料')` → `来福语料（阉割版）` |
| renderer/comfy.html / forge.html | `请重启橙子后再试` → 来福 |
| renderer/glass.js | 尿尿提醒 → 来福 |
| renderer/glow.html | `「橙子辉光」` ×3 → 「来福辉光」 |
| renderer/icons.js | `orange:` 键 → `<img class="life-mark" src="../assets/life-logo.png" alt="来福 Life" draggable="false" />`（新版若是 SVG 就整个换掉；新增的 updater 等图标保留） |
| renderer/prompts.html | `本机橙子魔改版插件` / `移出橙子库` / `搬运橙子魔改版插件` / `其他橙子系列插件` → 来福；**`|| '橙子魔改版'` 兜底保留** |
| renderer/relight.html | `var(--accent-rgb, 255,159,10)` ×N → `25,181,188` |
| renderer/settings.html | `橙子自己`→来福自己、`小橙子`→来福悬浮球、`橙子图标`→来福图标 |
| renderer/statement.html | `橙AIper`→来福、`橙子是oranG`→原作者 oranG、`橙子QQ：`→原作者QQ： |
| renderer/theme.css | `--accent: #ff9f0a;` → `#19b5bc`；文件末尾追加 `.life-mark` 品牌块（样式见 merge-6.0.20-report.md 或 git 历史里 6.0.8 的 theme.css 末尾） |
| ps-bridge/manifest.json | `name` + `label.default` → 来福桥接（version 与 id 不动） |
| ps-bridge/bridge.js | 全部 `commandName '橙子：'` → `'来福：'`；连接状态文案；**工具预设回退链** `['来福预设_'+aspect,'来福选框_'+aspect,'橙子预设_'+aspect,'橙子选框_'+aspect]`（Auto 同理四项——保留橙子名兼容 PS 里已手录的旧预设） |
| ps-bridge/index.html | `未连接橙子软件` → 来福 |
| ps-bridge/presets/marquee.tpl | 二进制，16 个 UTF-16BE 预设名 `橙子(6A 59 5B 50)` → `来福(67 65 79 8F)`（若上游 tpl 无内容变化，直接用上一版的来福版 tpl 覆盖） |
| roles/orange.txt | 首行「你是「橙子」」→「你是「来福」」（用上一版整个文件覆盖最稳） |

### 角色结构（每版必查）

上游可能在 `chat.js` 的 `BUILTIN_ROLES` 里只有单角色（他们的「1011 裁定」）。Life 分支要保持双角色：

```js
const BUILTIN_ROLES = [
  { id: 'b_orange', name: '来福', file: 'orange.txt' },
  { id: 'b_corpus', name: '来福语料（阉割版）', file: 'corpus-20260726.txt', hidden: true },
];
```

- `chat-builtin-roles` IPC：`prompt: r.hidden ? '' : r.prompt`（hidden 不发文本，可见人设发原文）
- `chat.html` selectRole / 初始化：`sysTa.value = b.hidden ? HIDDEN_MASK : b.prompt`
- `state.js` 迁移：若上游新增了 b_orange→b_corpus 的重映射迁移（如 v19），**删掉重映射、只保留 caps 补建**；语料归一迁移里 `'橙子语料'` 字面量改成能同时接受 `'来福语料（阉割版）'`
- `src/index.js`：确认有 `require('./core/dev-reload').enableDevReload(require('electron'), ctx);`（紧跟 tray require 之后）——上游没有这行，覆盖后要补回
- `package.json`：version 同步上游，但 `name/productName/appId/executableName/nsis` 等**保持 Life-ai 身份**

### 保留不动清单（覆盖后必须完好）

- 所有 `documents/橙子` 数据路径（chat.js:14、comfy.js:30、forge.js:15、glow.js:14、misc.js:8、plib.js:7、plib-update.js:21、qpresets.js:17、state.js appData 迁移源）
- `index.js` userData `'橙AIper'`、AUMI `com.orange.aiper`
- `comfy.js` 正则 `/橙子|输入|input|ps\b|photoshop/i`
- plib-import.js 的 `'橙子魔改版'` 标签与 com.orange 插件 id 扫描逻辑
- updater 的 `orange-update` 临时目录、`'com.orange'` 系列 id
- factory_prompts 内 JSON 正文的「橙子PS插件」描述、own04.json 标题
- `assets/life-logo.png`、`core/dev-reload.js`、`core/model-request.js`（Life 独有文件）

## 四、校验（10 分钟）

```powershell
# 1. 语法：所有 JS 零错误
Get-ChildItem src,ps-bridge -Recurse -Filter *.js | ForEach-Object { node --check $_.FullName }

# 2. 项目自带一致性检查
node scripts/check-source.cjs

# 3. 关键 JSON 可解析
"src/modules.json","package.json","ps-bridge/manifest.json" | ForEach-Object { Get-Content $_ -Raw | ConvertFrom-Json }

# 4. 残留扫描：排除保留项后，「橙子|橙AIper」应只剩数据路径/注释/正则/回退链
Get-ChildItem src,ps-bridge -Recurse -Include *.js,*.html,*.json,*.txt |
  Where-Object { $_.FullName -notmatch "factory_prompts|pinyin-map" } |
  Select-String -Pattern "橙子|橙AIper"
```

## 五、打包 + 部署（15 分钟）

```powershell
cd source
npx electron-builder --win --x64 --dir --publish never   # 先出 win-unpacked 验证
# 冷启动 dist\win-unpacked\Life-ai.exe 验证能起、功能正常，然后部署：
# 1. 退出正在运行的 Life-ai
# 2. 备份 resources\app.asar / app.asar.unpacked / ps-bridge → rollback-* 目录
# 3. 拷贝 dist\win-unpacked\resources\app.asar 和 app.asar.unpacked → 装机 resources\
# 4. 拷贝 source\ps-bridge\* → 装机 resources\ps-bridge\
# 5. 拷贝 source\bridge-machine-install.ps1 → 装机 resources\
# 6. 再冷启动装机版 Life-ai.exe 验证
```

出安装包（分发用）：`npm run build`（产物 `dist\Life-ai测试版-安装包.exe`）。

## 六、收尾

- `git add -A && git commit`（写清上游版本号与品牌动作）
- `git push origin main`
- 更新本文档的「上次执行」与 merge-report

## ⚠️ 每版必查的风险点

1. **updater 更新源**：官方 updater 指向官方 OSS，装机后**自动更新开关必须保持关闭**（默认关，别替用户打开）
2. **state.js 新迁移**：通读上游新增的每个迁移 `up()`，凡涉及角色/语料/品牌字面量的，对照本分支结构修正
3. **ps-bridge 版本号**：manifest version 跟上游走（注册表 `com.orange.bridge_live` 依赖 id 不变）；`CUR_BRIDGE_VER` 是协议握手版本，别手改
4. **nest 仓库结构**：本仓库的 git 仓库在 `source/`，`E:\life\Life-ai` 根目录不是 git 仓库，别在根目录 init/commit
