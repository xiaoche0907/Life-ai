# 来福桥接：手动安装 Photoshop 插件

桌面程序自带桥接插件及自动安装逻辑。如果 PS 没有显示“来福桥接”，可以单独下载 `.ccx` 插件包尝试手动安装，无需重新下载安装整个桌面程序。

## 下载

- [来福桥接 1.0.59（.ccx）](https://github.com/xiaoche0907/Life-ai/releases/download/v6.0.7-test.2/Life-ai-PS-Bridge-1.0.59.ccx)
- [Life-ai 桌面程序](https://github.com/xiaoche0907/Life-ai/releases/tag/v6.0.7-test.2)

`.ccx` 包只包含 PS 桥接插件，使用时仍需运行 Life-ai 桌面程序。插件声明的最低 PS 版本为 23.3.0，实际兼容性取决于 PS 的 UXP 环境。

## 安装步骤

1. 保存 Photoshop 中的作品，彻底退出 Photoshop。
2. 下载 `Life-ai-PS-Bridge-1.0.59.ccx`，保留 `.ccx` 扩展名，无需解压。
3. 使用 [OpenUXP Installer](https://moonvy.com/apps/upx-installer/) 打开或拖入该文件，确认名称为“来福桥接”、版本为 `1.0.59`、宿主为 Photoshop，然后按安装器提示安装。安装器提供官方安装与用户级侧载；可用方式取决于本机 Adobe 环境。
4. 如果电脑已安装并配置 Creative Cloud Desktop，也可双击 `.ccx`，按 Adobe 安装提示操作。
5. 启动 Life-ai，再打开 Photoshop。插件配置为随 PS 启动加载；如没有连接，从 PS“增效工具”菜单手动打开“来福桥接”。
6. 面板显示“已连接来福软件”，且 Life-ai 日志显示桥接已连接，说明桥接通道已经建立。仅显示“COM 兜底”不代表桥接已连接。

## 没有连接时

- **没有“来福桥接”菜单项**：检查安装器是否报告成功、PS 版本及 UXP 插件环境是否支持。用户级侧载可能仍遇到安装目录未被 PS 识别的问题。
- **仍显示旧名称或旧版本**：确认后台没有残留的 `Photoshop.exe`，再重新启动 PS。旧插件与新版沿用相同 ID，不应当作为两个不同插件重复安装。
- **面板显示未连接**：确认 Life-ai 正在运行；桥接使用本机 `127.0.0.1:40125`，再检查应用日志、端口占用及插件运行错误。
- **已有 PSD 中仍有旧品牌图层名**：手动安装不会重命名已有图层。新版只改变后续新建图层组和操作的名称。

不要为安装插件删除其他插件、个人配置或 PSD 文件。反馈问题时请附上 PS 版本、安装器提示和连接日志。

## 验证范围

已检查插件包 ZIP 完整性、根目录 `manifest.json`、6 个文件的逐字节一致性及脚本语法，内容与当前桌面程序内置桥接一致。尚未完成 OpenUXP Installer / Creative Cloud 安装此 `.ccx` 的实测，也未覆盖所有 PS 版本的加载与功能验证。

打包格式参考 [Adobe UXP 插件打包文档](https://developer.adobe.com/photoshop/uxp/guides/distribution/packaging-your-plugin/)。
