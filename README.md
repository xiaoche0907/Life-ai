# Life-ai测试版

来福 Life-ai 是面向 Photoshop 工作流的 Electron 桌面助手，采用青绿色主题和 Life 狗狗标志。

本仓库的源码从已完成 UI 替换的桌面应用中整理而来，保留原有 PS 桥接、生图、词库及窗口交互。原应用作者为 oranG，本次修改包括品牌文案、主题、图标及安装包。

## 下载与安装

在 [Releases](https://github.com/xiaoche0907/Life-ai/releases) 下载 `Life-ai测试版-安装包.exe`。当前测试版为 6.0.7，适用于 Windows x64。安装前请先退出正在运行的同系列桌面应用。

安装包已通过安装、119 个安装文件 SHA256、Electron 与原生依赖加载、图标和卸载检查；真实 Photoshop 联动及生图需在使用环境中试用。测试版尚未进行代码签名。

## 开发

```powershell
npm ci
npm run check
npm start
```

原有配置路径和单实例身份保持兼容，开发版与已有桌面版共享设置；运行前应退出已有桌面应用。仓库不包含用户 API Key、个人配置或缓存。

## 构建 Windows 安装包

```powershell
npm run build
```

输出到 `dist/Life-ai测试版-安装包.exe`。Life ICO 包含 16、24、32、48、64、128、256 像素七种尺寸。桥接文件与提示音通过 `extraResources` 随包分发。

## 目录

- `src/core`：主进程功能模块。
- `src/renderer`：页面、公共样式与图标。
- `src/assets`：Life 标志资源。
- `ps-bridge`：Photoshop 桥接插件。
- `sounds`：出厂提示音。
- `build/icon.ico`：应用和安装器图标。

保留原作者署名。仓库整理过程未新增或替换原应用的许可证授权。
