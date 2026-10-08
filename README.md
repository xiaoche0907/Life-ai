<div align="center">
  <img src="src/assets/life-logo.png" alt="Life-ai 来福" width="160" />
  <h1>Life-ai · 来福</h1>
  <p>面向 Photoshop 工作流的 AI 桌面助手</p>
  <p>把生图、提示词与修图工具放到工作区旁，让创作操作更集中。</p>
  <p>
    <a href="https://github.com/xiaoche0907/Life-ai/releases/tag/v6.0.7-test">下载测试版</a> ·
    <a href="#快速上手">快速上手</a> ·
    <a href="https://github.com/xiaoche0907/Life-ai/issues">反馈问题</a>
  </p>
</div>

## 项目介绍

Life-ai（来福）是一款基于 Electron 的 Windows 桌面助手，围绕 Photoshop 图像创作与修图工作流提供独立工具窗口。通过 Life 狗狗悬浮球打开控制台，可以组合使用生图、提示词库、参考图、批处理及图像工具，并按自己的习惯排列窗口。

当前版本为 **6.0.7 测试版**，采用青绿色主题、Life 狗狗标志和可拖动的工具卡片。仓库包含桌面应用源码、Photoshop 桥接插件、图标资源和 Windows 安装包构建配置。

## 主要功能

以下功能模块来自现有应用源码，实际使用效果取决于 Photoshop 连接、服务渠道和本地工作流配置。

| 模块 | 用途 |
| --- | --- |
| AI 生图 | 配置渠道与模型，调整比例、分辨率及生成数量，查看进度和日志 |
| 提示词与参考图 | 编辑提示词、管理分组词库与收藏，使用参考图辅助创作 |
| Photoshop 联动 | 通过桥接调用 Photoshop 能力，配合选区、全图输入及结果回传 |
| Forge / ComfyUI | 连接已配置的本地服务，使用预设和工作流 |
| 批处理与自动修图 | 使用批处理入口及自动修图工序，处理重复任务 |
| 图像工具 | 提供打光、辉光、校色、特效、半合成、对齐和快捷预设入口 |
| AI 对话 | 独立配置对话渠道、模型与角色 |
| 窗口与布局 | 使用悬浮球、托盘、可拖动工具卡片、快速布局和界面设置 |

## 下载与安装

**[下载 Life-ai测试版安装包](https://github.com/xiaoche0907/Life-ai/releases/download/v6.0.7-test/Life-ai-test-6.0.7-setup.exe)**

- 平台：Windows x64。
- 当前发布：[`v6.0.7-test`](https://github.com/xiaoche0907/Life-ai/releases/tag/v6.0.7-test)。
- 安装包：`Life-ai-test-6.0.7-setup.exe`，约 83 MB。
- 安装后程序：`Life-ai.exe`。
- 桌面与开始菜单快捷方式：`Life-ai测试版`。

1. 从托盘退出已运行的同系列桌面应用。
2. 下载并运行安装包，按向导选择安装目录。
3. 安装完成后，使用桌面或开始菜单快捷方式启动。

测试版尚未进行代码签名，Windows 可能显示发布者未验证提示。请从本仓库 Releases 下载；安装包的 SHA256 为：

```text
977454573ebea5630d747b8894ec3f179907b146f9fd2dc5fb27423862223e5a
```

## 快速上手

1. **打开控制台**：右键 Life 狗狗悬浮球，选择“控制台”，再打开需要的工具卡片。
2. **连接 Photoshop**：打开 Photoshop。应用包含桥接安装逻辑；如连接失败，在界面设置中点击“重新安装PS插件”，按提示完成安装并重启 Photoshop。
3. **配置生成渠道**：打开“生图模式”，进入该卡片的设置，填写自己使用的渠道地址、API Key，并选择模型。
4. **准备输入**：编辑提示词，按需加入参考图，并在 Photoshop 中准备选区或使用全图模式。
5. **开始生成**：调整比例、分辨率及数量，在“生成”入口运行任务，通过“生图进度”和“生图日志”查看结果。

AI 生图与对话需要自行配置对应服务，费用以服务提供方规则为准。Forge 和 ComfyUI 需要先启动相应本地服务，并配置正确的连接地址。

桥接插件声明的最低 Photoshop 版本为 **23.3.0**；不同 Photoshop 版本及安装环境的实际兼容性仍需验证。为保持旧配置兼容，部分内部标识和桥接面板名称沿用原应用。

## 界面与操作

- **悬浮球左键**：收纳或释放工具卡片。
- **悬浮球右键**：打开控制台、设置、锁定、拉回最前与退出菜单。
- **窗口布局**：拖动工具卡片排列工作区，通过快速布局管理常用排布。
- **界面设置**：调整主题、背景不透明度、文字大小等参数。

Life 标志替换了原悬浮球图案，默认图案尺寸保持 72 × 72。应用、安装器与卸载器使用多尺寸 Life 图标。

## 测试版状态

当前发布已经完成以下检查：

- Windows 安装与卸载验证。
- 119 个安装文件的 SHA256 一致性检查。
- Electron 33.4.11 与 `ws`、`ag-psd`、`koffi` 依赖加载检查。
- 应用、安装器及卸载器图标检查。
- 源码、页面内脚本和 JSON 文件检查。

**真实 Photoshop 联动、各渠道生图及完整业务流程尚未完成全面验证。** 使用中遇到问题，请提交 Issue，并附上复现步骤及相关日志。

## 本地开发

准备 Git、Node.js 与 npm，然后执行：

```powershell
git clone https://github.com/xiaoche0907/Life-ai.git
cd Life-ai
npm ci
npm run check
npm start
```

| 命令 | 作用 |
| --- | --- |
| `npm start` | 启动 Electron 开发版 |
| `npm run check` | 检查 JavaScript 语法、JSON、页面内脚本及必需资源 |
| `npm run build` | 构建 Windows x64 NSIS 安装包 |

开发版与已有桌面版保留相同配置路径和单实例身份，运行前应退出已有应用。`npm run check` 是静态检查，不等同于业务功能测试。

## 构建安装包

在 Windows 上安装依赖后运行：

```powershell
npm run build
```

输出文件：

```text
dist/Life-ai测试版-安装包.exe
```

构建使用 electron-builder 与 NSIS。桥接插件和提示音通过 `extraResources` 随包分发；`build/icon.ico` 包含 16、24、32、48、64、128、256 像素七种尺寸。

首次构建可能需要下载 Electron 和打包工具。仓库中的 `dist`、`node_modules` 与用户配置已加入忽略规则，安装包通过 Releases 分发。

## 项目结构

```text
Life-ai/
├─ src/
│  ├─ index.js            # Electron 主进程入口
│  ├─ preload.js          # 页面与主进程之间的接口
│  ├─ core/               # 生图、桥接、窗口及其他功能模块
│  ├─ renderer/           # 页面、公共样式与图标
│  ├─ assets/             # Life 标志资源
│  └─ modules.json        # 功能模块注册表
├─ ps-bridge/             # Photoshop 桥接插件
├─ sounds/                # 出厂提示音
├─ build/icon.ico         # 应用和安装器图标
├─ scripts/               # 源码检查脚本
└─ package.json           # 依赖、运行命令与打包配置
```

## 配置、卸载与反馈

应用保留原有配置目录，以兼容已有渠道设置、词库和窗口布局。卸载不会自动删除原有用户数据。仓库不包含个人 API Key、用户配置或图片缓存。

在 [Issues](https://github.com/xiaoche0907/Life-ai/issues) 中反馈问题时，建议提供应用版本、Windows 和 Photoshop 版本、复现步骤、预期结果以及日志或截图。分享日志前请移除 API Key 和其他个人信息。

## 致谢与来源

本仓库从现有桌面应用整理而来，原应用作者为 **oranG**。来福版调整了品牌文案、主题与图标，并整理了源码及安装包构建配置，保留原有功能结构与作者署名。

本次整理未新增或替换原应用的许可证授权；第三方组件的许可证以各组件自带声明为准。
