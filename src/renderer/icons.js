// 来福图标库：线描风SVG，继承老插件的图标语言
// (fill=none / stroke=currentColor / 圆头描边，颜色由容器color控制)
(function () {
  const S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">';
  const E = '</svg>';

  window.ORANGE_ICONS = {
    // 来福logo（老插件原版：圆+叶）
    orange: '<img class="life-mark" src="../assets/life-logo.png" alt="来福 Life" draggable="false" />',

    // AI生图：魔法棒+星
    'ai-gen': S + '<path d="m3 21 9.4-9.4"/><path d="M15.6 6.4 17.6 4.4"/><path d="M15 2v2.5"/><path d="M20.5 7.5H18"/><path d="m19 11 1.5 1.5"/><path d="M11 4.5 12.5 6"/><path d="M12.4 12.4 11 11"/>' + E,

    // 特效：四角星
    fx: S + '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>' + E,

    // 校色：调节滑杆
    colorcal: S + '<line x1="21" y1="4" x2="14" y2="4"/><line x1="10" y1="4" x2="3" y2="4"/><line x1="21" y1="12" x2="12" y2="12"/><line x1="8" y1="12" x2="3" y2="12"/><line x1="21" y1="20" x2="16" y2="20"/><line x1="12" y1="20" x2="3" y2="20"/><line x1="14" y1="2" x2="14" y2="6"/><line x1="8" y1="10" x2="8" y2="14"/><line x1="16" y1="18" x2="16" y2="22"/>' + E,

    // 半合成：图层堆叠
    composite: S + '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/>' + E,

    // 打光：灯泡（老插件原版）
    relight: S + '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2V17h6v-.3c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/>' + E,

    // 辉光：光核 + 八向射线
    glow: S + '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2M5.3 5.3l2.2 2.2M16.5 16.5l2.2 2.2M5.3 18.7l2.2-2.2M16.5 7.5l2.2-2.2"/>' + E,

    // 提示词（独立输入卡）：铅笔
    'prompt-box': S + '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' + E,

    // 校色-轻校准：曲线
    'cc-light': S + '<path d="M3 3v18h18"/><path d="M5 19c7 0 10-4 14-14"/>' + E,
    // 校色-色卡校准：色卡条
    'cc-chart': S + '<rect x="3" y="4" width="18" height="10" rx="2"/><rect x="3" y="17" width="4" height="4" rx="1"/><rect x="10" y="17" width="4" height="4" rx="1"/><rect x="17" y="17" width="4" height="4" rx="1"/>' + E,
    // 校色-LUT精修：3D立方
    'cc-lut': S + '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/>' + E,

    // 批处理：层叠照片
    batchall: S + '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/><circle cx="12" cy="12.5" r="1.3"/><path d="m21 17-3.5-3.5L11 20"/>' + E,

    // 对齐：十字靶心
    align: S + '<circle cx="12" cy="12" r="7"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M12 12h.01"/>' + E,

    // 抗截断：盾牌（老插件语义）
    anti: S + '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' + E,

    // 锁定：挂锁（闭合）
    lock: S + '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>' + E,
    // 锁定-已解锁：挂锁（锁梁弹开）
    'lock-open': S + '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/>' + E,

    // 生图日志：列表行（老插件原版）
    logs: S + '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>' + E,

    // 生图进度：脉冲线
    progress: S + '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>' + E,

    // 提示词库：摊开的书
    prompts: S + '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' + E,

    // 甄选：爱心
    fav: S + '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' + E,

    // 声明：文书
    statement: S + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>' + E,

    // 生成：播放三角
    gen: S + '<polygon points="6 3 20 12 6 21 6 3"/>' + E,

    // Forge：铁砧
    forge: S + '<path d="M3 6h13v3c0 2-1.5 4-4 4h-1v4h4v3H7v-3h4v-4H9c-3.5 0-6-2.5-6-6z"/><path d="M16 6c2.5 0 4.5 1 5.5 3H16z"/>' + E,
    comfy: S + '<rect x="3" y="4" width="7" height="5" rx="1.5"/><rect x="14" y="4" width="7" height="5" rx="1.5"/><rect x="8.5" y="15" width="7" height="5" rx="1.5"/><path d="M6.5 9v3h11V9M12 12v3"/>' + E,   // 节点图：两上一下三块连线

    // 尿尿提醒：水滴
    pee: S + '<path d="M12 2.7 C12 2.7 5.5 10 5.5 14.5 a6.5 6.5 0 0 0 13 0 C18.5 10 12 2.7 12 2.7 Z"/>' + E,

    // 参考图：相框山景
    refs: S + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>' + E,

    // 快速布局：错落方块
    layout: S + '<rect x="3" y="3" width="8" height="11" rx="1.5"/><rect x="14" y="3" width="7" height="6" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="17" width="8" height="4" rx="1.5"/>' + E,

    // 滑块：三轨混音推子
    params: S + '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="10" r="2"/><circle cx="20" cy="14" r="2"/>' + E,

    // 电源：退出来福
    power: S + '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>' + E,

    // 设置：齿轮
    settings: S + '<circle cx="12" cy="12" r="3"/><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>' + E,

    // AI对话：气泡对话框
    chat: S + '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' + E,

    // 对话设置：齿轮+对话
    'chat-settings': S + '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>' + E,

    // ——对话卡按钮图标化（0903用户裁定：按钮一律线描logo不用emoji）——
    // 垃圾桶：清空对话
    trash: S + '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>' + E,
    // 相机：抓取PS选区
    camera: S + '<path d="M22 18.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8.5a2 2 0 0 1 2-2h3.2l1.8-2.7h6l1.8 2.7H20a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.6"/>' + E,
    // 纸飞机：发送
    send: S + '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>' + E,
    // 刷新：拉取模型列表
    refresh: S + '<polyline points="21.5 3.5 21.5 9.5 15.5 9.5"/><polyline points="2.5 20.5 2.5 14.5 8.5 14.5"/><path d="M4.6 9a8 8 0 0 1 13.2-3l3.7 3.5"/><path d="M2.5 14.5 6.2 18a8 8 0 0 0 13.2-3"/>' + E,
    // 自动修图：文件夹+闪星（批量流水线）
    autofix: S + '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><path d="m14 10 .9 2.1L17 13l-2.1.9L14 16l-.9-2.1L11 13l2.1-.9z"/>' + E,

    // 人像：用户消息头像
    user: S + '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>' + E,
    // 快捷预设：闪电（一键动作）
    qpresets: S + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' + E,
    // 文件夹：打开预设文件夹
    folder: S + '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>' + E,
    // —— 快捷预设动作图标（与控制台同一线描语言；用户自建预设可在图标选择器里挑）——
    'qp-skin': S + '<path d="M3 9c3-3 6-3 9 0s6 3 9 0"/><path d="M3 15c3-3 6-3 9 0s6 3 9 0"/><path d="M18 4l.6 1.4L20 6l-1.4.6L18 8l-.6-1.4L16 6l1.4-.6z"/>' + E,
    'qp-freq2': S + '<path d="M3 7l2-2 2 2 2-2 2 2 2-2 2 2 2-2 2 2 2-2"/><path d="M3 17c3-4 6-4 9 0s6 4 9 0"/>' + E,
    'qp-freq3': S + '<path d="M3 5l1.5-1.5L6 5l1.5-1.5L9 5l1.5-1.5L12 5l1.5-1.5L15 5l1.5-1.5L18 5l1.5-1.5L21 5"/><path d="M3 12c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 19c3-4 6-4 9 0s6 4 9 0"/>' + E,
    'qp-gray': S + '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 12h16v5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z" fill="currentColor"/>' + E,
    'qp-curves2': S + '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M4 20c7 0 11-9 16-16"/><path d="M4 20c4-3 9-6 16-7"/>' + E,
    'qp-obs-bw': S + '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>' + E,
    'qp-obs-sat': S + '<circle cx="12" cy="12" r="8"/><path d="M12 4v8"/><path d="M12 12l6.9 4"/><path d="M12 12l-6.9 4"/>' + E,
    'qp-obs-inv': S + '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 4l16 16V6a2 2 0 0 0-2-2z" fill="currentColor"/>' + E,
    'qp-obs-contrast': S + '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M4 20c3-1 5-9 8-8s5 8 8-8"/>' + E,
    'qp-stamp': S + '<path d="M5 21h14"/><path d="M7 17h10v-3a2 2 0 0 0-2-2h-1V7a2 2 0 0 0-4 0v5H9a2 2 0 0 0-2 2z"/>' + E,
    'qp-mask-black': S + '<rect x="3" y="3" width="18" height="18" rx="3"/><rect x="7" y="7" width="10" height="10" rx="1" fill="currentColor"/>' + E,
    'qp-mask-white': S + '<rect x="3" y="3" width="18" height="18" rx="3"/><rect x="7" y="7" width="10" height="10" rx="1"/>' + E,
    'qp-mask-inv': S + '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 17V7h10z" fill="currentColor"/>' + E,
    'qp-sharp-web': S + '<path d="M12 3l5 9-5 9-5-9z"/><path d="M7 12h10"/>' + E,
    'qp-sharp-print': S + '<path d="M6 3h9l4 4v14H6z"/><path d="M12 8l3 5-3 5-3-5z"/>' + E,
    'qp-grain': S + '<circle cx="6" cy="6" r="1.2" fill="currentColor"/><circle cx="12" cy="7" r="1.2" fill="currentColor"/><circle cx="18" cy="5" r="1.2" fill="currentColor"/><circle cx="8" cy="12" r="1.2" fill="currentColor"/><circle cx="15" cy="12" r="1.2" fill="currentColor"/><circle cx="5" cy="18" r="1.2" fill="currentColor"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/><circle cx="19" cy="18" r="1.2" fill="currentColor"/>' + E,
    'qp-action': S + '<polygon points="6 3 20 12 6 21 6 3"/>' + E,
    'qp-plus': S + '<path d="M12 5v14"/><path d="M5 12h14"/>' + E,
    'qp-edit': S + '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>' + E,
    'qp-x': S + '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>' + E,
    'qp-check': S + '<polyline points="20 6 9 17 4 12"/>' + E,
    'qp-star': S + '<polygon points="12 2 15.1 8.5 22 9.3 16.9 14.1 18.2 21 12 17.6 5.8 21 7.1 14.1 2 9.3 8.9 8.5"/>' + E,
    'qp-bolt': S + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>' + E,
    'qp-drop': S + '<path d="M12 2.7 C12 2.7 5.5 10 5.5 14.5 a6.5 6.5 0 0 0 13 0 C18.5 10 12 2.7 12 2.7 Z"/>' + E,
    'qp-eye': S + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' + E,
    'qp-brush': S + '<path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08"/><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z"/>' + E,
    'qp-layers': S + '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/>' + E,
    'qp-sun': S + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>' + E,
    'qp-moon': S + '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>' + E,
  };

  // 提示词库分组图标集：11个内置默认分组 + 自定义分组可选池（同一线描语言）
  window.PLIB_ICONS = {
    // —— 内置默认分组（key与分组id同名）——
    hair:  S + '<path d="M7 3.5c-2 3-2 6 0 8.5s2 6 0 8.5"/><path d="M12 2.5c-2 3.2-2 6.3 0 9.5s2 6.3 0 9.5"/><path d="M17 3.5c-2 3-2 6 0 8.5s2 6 0 8.5"/>' + E,
    face:  S + '<circle cx="12" cy="12" r="8.5"/><path d="M9 10h.01"/><path d="M15 10h.01"/><path d="M9 14.5c1 1 2 1.5 3 1.5s2-.5 3-1.5"/>' + E,
    body:  S + '<circle cx="12" cy="4.5" r="2.3"/><path d="M12 7v6.5"/><path d="M7.5 9.5h9"/><path d="m12 13.5-3 8"/><path d="m12 13.5 3 8"/>' + E,
    upper: S + '<circle cx="12" cy="6.5" r="3.2"/><path d="M4.5 21v-1.5a7.5 7.5 0 0 1 15 0V21"/>' + E,
    lower: S + '<path d="M7 3h10"/><path d="M7 3 5.6 21h4.2L12 10.5 14.2 21h4.2L17 3"/>' + E,
    cloth: S + '<path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.3 2.2l.5 3.5a1 1 0 0 0 1 .8H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.2a1 1 0 0 0 1-.8l.5-3.5a2 2 0 0 0-1.3-2.2z"/>' + E,
    prop:  S + '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>' + E,
    scene: S + '<path d="M14.5 4h-5L7.5 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.5z"/><circle cx="12" cy="13.5" r="3.5"/>' + E,
    bg:    S + '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>' + E,
    gfx:   S + '<path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/>' + E,
    other: S + '<path d="M5 12h.01"/><path d="M12 12h.01"/><path d="M19 12h.01"/>' + E,
    // —— 特殊分组 ——
    forgeF: S + '<path d="M16.5 4H8.5v16"/><path d="M8.5 12.5H15"/>' + E,
    // —— 自定义分组可选池 ——
    tag:    S + '<path d="M12 2H2v10l9.3 9.3a2 2 0 0 0 2.8 0l7-7a2 2 0 0 0 0-2.8z"/><path d="M7 7h.01"/>' + E,
    star:   S + '<polygon points="12 2 15.1 8.5 22 9.3 16.9 14.1 18.2 21 12 17.6 5.8 21 7.1 14.1 2 9.3 8.9 8.5"/>' + E,
    heart2: S + '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>' + E,
    folder: S + '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/>' + E,
    drop:   S + '<path d="M12 2.7 6.6 8.9a7.2 7.2 0 1 0 10.8 0z"/>' + E,
    fire:   S + '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>' + E,
    moon:   S + '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>' + E,
    bolt:   S + '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>' + E,
    eye:    S + '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>' + E,
    flower: S + '<circle cx="12" cy="12" r="2.6"/><path d="M12 9.4V3.5"/><path d="M12 20.5v-5.9"/><path d="M14.6 12h5.9"/><path d="M3.5 12h5.9"/><path d="m14 10 4-4"/><path d="m6 18 4-4"/><path d="m14 14 4 4"/><path d="m6 6 4 4"/>' + E,
    sun:    S + '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.3 17.7-1.4 1.4"/><path d="m19.1 4.9-1.4 1.4"/>' + E,
    cloud:  S + '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9z"/>' + E,
    snow:   S + '<path d="M12 3v18"/><path d="m4.3 7.5 15.4 9"/><path d="m19.7 7.5-15.4 9"/><path d="m9.5 4 2.5 2 2.5-2"/><path d="m9.5 20 2.5-2 2.5 2"/>' + E,
    leaf:   S + '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.5 3.5-7"/>' + E,
    tree:   S + '<path d="M12 22v-5"/><path d="m12 2-5 8h3l-4 7h12l-4-7h3z"/>' + E,
    mount:  S + '<path d="m8 3 4 8 5-5 5 15H2z"/>' + E,
    wave:   S + '<path d="M2 8c2.5 0 2.5 3 5 3s2.5-3 5-3 2.5 3 5 3 2.5-3 5-3"/><path d="M2 15c2.5 0 2.5 3 5 3s2.5-3 5-3 2.5 3 5 3 2.5-3 5-3"/>' + E,
    feather:S + '<path d="M20.2 3.8c-2.6-2.6-6.9-2.4-9.8.5L4 10.7V20h9.3l6.4-6.4c2.9-2.9 3.1-7.2.5-9.8z"/><path d="M16 8 4 20"/>' + E,
    crown:  S + '<path d="M3 7l4.5 4L12 5l4.5 6L21 7l-2 12H5z"/>' + E,
    gem:    S + '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20"/><path d="m9 3 3 6 3-6"/>' + E,
    film:   S + '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18"/><path d="M17 3v18"/><path d="M3 8h4"/><path d="M3 16h4"/><path d="M17 8h4"/><path d="M17 16h4"/>' + E,
    brush:  S + '<path d="M9.1 11.9 20 2.1c.9-.9 2.4.5 1.5 1.5l-9.9 10.8"/><path d="M8.5 12.5c-2.2 0-4.5 1.2-4.5 4 0 1.5-.9 2.5-2 3.2 1.5 1.4 3.5 1.8 5 1.8 3 0 5-2.4 5-5"/>' + E,
    palette:S + '<path d="M12 21a9 9 0 1 1 9-9c0 2-1.5 3-3 3h-2a2 2 0 0 0-1.5 3.3c.4.5.5.9.5 1.2 0 .8-1 1.5-3 1.5z"/><path d="M7.5 10.5h.01"/><path d="M12 7.5h.01"/><path d="M16.5 10.5h.01"/>' + E,
    glasses:S + '<circle cx="6.5" cy="14" r="3.5"/><circle cx="17.5" cy="14" r="3.5"/><path d="M10 14h4"/><path d="M3 13.5 2 8"/><path d="m21 13.5 1-5.5"/>' + E,
    hat:    S + '<path d="M4 17.5c0-1.1 1.4-2 3-2h10c1.6 0 3 .9 3 2s-1.4 2-3 2H7c-1.6 0-3-.9-3-2z"/><path d="M8 15.5c0-4.5 1.2-9.5 4-9.5s4 5 4 9.5"/>' + E,
    bag:    S + '<path d="M6 8h12l1.5 12.3a1.5 1.5 0 0 1-1.5 1.7H6a1.5 1.5 0 0 1-1.5-1.7z"/><path d="M9 11V6a3 3 0 0 1 6 0v5"/>' + E,
    lips:   S + '<path d="M12 9.5c-1.8-2-4.8-2-6.5-.3L2.5 12c2.8 4 6 6 9.5 6s6.7-2 9.5-6l-3-2.8c-1.7-1.7-4.7-1.7-6.5.3z"/><path d="M2.5 12h19"/>' + E,
    hand:   S + '<path d="M7 12V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M10 11V4a1.5 1.5 0 0 1 3 0v7"/><path d="M13 11V5.5a1.5 1.5 0 0 1 3 0V13"/><path d="M16 12.5c1-1.5 3.4-.7 3 1.5-.5 2.7-1 4-2.5 5.5A8 8 0 0 1 11 22c-2.5 0-4.5-1.5-6-4l-2.3-4.2c-.9-1.7 1.2-3 2.4-1.6L7 14.5"/>' + E,
    house:  S + '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22v-8h6v8"/>' + E,
    cup:    S + '<path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v2.5"/><path d="M10 2v2.5"/><path d="M14 2v2.5"/>' + E,
  };

  // 图标中文名（选择器微标签+悬停提示用，防"盲选"）
  window.PLIB_ICON_NAMES = {
    hair: '头发', face: '面部', body: '全身', upper: '上半身', lower: '下半身',
    cloth: '服饰', prop: '道具', scene: '场照', bg: '背景', gfx: '特效', other: '其他',
    forgeF: 'F组', tag: '标签', star: '星星', heart2: '爱心', folder: '文件夹',
    drop: '水滴', fire: '火焰', moon: '月亮', bolt: '闪电', eye: '眼睛', flower: '花',
    sun: '太阳', cloud: '云', snow: '雪花', leaf: '叶子', tree: '树', mount: '山',
    wave: '水波', feather: '羽毛', crown: '皇冠', gem: '宝石', film: '胶片',
    brush: '画笔', palette: '调色盘', glasses: '眼镜', hat: '帽子', bag: '包',
    lips: '嘴唇', hand: '手', house: '房子', cup: '杯子',
  };
})();
