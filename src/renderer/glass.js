// 界面参数应用器：不透明度/主题色 实时可调
// 镜面引擎已退役——用户放弃模糊后，窗口原生透明即是零延迟的"纯透视玻璃"，
// 无需捕获流(显存归零)、无需捕获隐身(截图工具恢复正常拍到面板)
(function () {
  if (!window.orange || !window.orange.getConfig) return;
  try {

  // ---------- 盲人修图模式：肌肉记忆党的极简界面（去文字标注/悬停提示/气泡名） ----------
  // 悬停提示是title属性，CSS藏不掉：摘掉并把原文存进data-otitle，切回新手模式时原样还原；
  // 动态新建的元素靠2秒兜底轮询补摘
  let blindTimer = null;
  function stripTitles() {
    document.querySelectorAll('[title]').forEach((el) => {
      if (!el.dataset.otitle) el.dataset.otitle = el.getAttribute('title');
      el.removeAttribute('title');
    });
  }
  function applyBlindMode(on) {
    if (/hub\.html$/.test(location.pathname)) return;   // 控制台不受盲人模式影响（气泡名/logo/提示全保留）
    document.body.classList.toggle('blindmode', on);
    clearInterval(blindTimer);
    blindTimer = null;
    if (on) {
      stripTitles();
      blindTimer = setInterval(stripTitles, 2000);
    } else {
      document.querySelectorAll('[data-otitle]').forEach((el) => {
        el.setAttribute('title', el.dataset.otitle);
        delete el.dataset.otitle;
      });
    }
  }

  // ---------- 背景图片/视频（0906设置项）：挂在.lg首子，玻璃底之上、内容之下；路径直引file://，视频静音循环 ----------
  // 球页豁免（球是主题色玻璃球不铺图）；同一路径只建一次媒体元素，滑杆只改opacity
  let bgEl = null, bgSrc = '';
  function applyBgMedia(ui) {
    if (/ball\.html$/.test(location.pathname)) return;
    const lg = document.querySelector('.lg');
    if (!lg) return;
    const file = (ui && typeof ui.bgFile === 'string') ? ui.bgFile : '';
    const op = (ui && ui.bgOpacity != null) ? Math.max(0, Math.min(1, Number(ui.bgOpacity))) : 0.6;
    if (!file) {
      if (bgEl) { bgEl.remove(); bgEl = null; bgSrc = ''; }
      return;
    }
    if (!bgEl) {
      bgEl = document.createElement('div');
      bgEl.className = 'bgMedia';
      lg.insertBefore(bgEl, lg.firstChild);
    }
    bgEl.style.opacity = String(op);
    if (file === bgSrc) return;
    bgSrc = file;
    // 中文/空格路径encodeURI；#和?不在encodeURI范围内要单独转，否则被当成URL片段/查询串
    const url = 'file:///' + encodeURI(file.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
    const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(file);
    bgEl.innerHTML = '';
    const m = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      m.muted = true; m.loop = true; m.autoplay = true; m.playsInline = true;
      m.setAttribute('disablepictureinpicture', '');
    }
    m.src = url;
    bgEl.appendChild(m);
    if (isVideo) { try { m.play().catch(() => {}); } catch (e) {} }
  }

  function applyUI(ui) {
    if (!ui) return;
    const r = document.documentElement.style;
    if (ui.tint != null) r.setProperty('--mirror-tint', String(ui.tint));
    if (ui.accent) r.setProperty('--accent', ui.accent);
    if (ui.psBase) r.setProperty('--ps-base', ui.psBase);   // 「跟随PS」主题的自适应底色
    // 底板风格（classic/frost/gradient/sharp），theme.css按data-style整套换材质
    document.documentElement.setAttribute('data-style', ui.style || 'classic');
    userFontScale = (Number(ui.fontScale) || 100) / 100;   // 文字大小滑杆（0905）
    applyBlindMode(ui.uiMode === 'blind');
    applyConstFont(ui.uiMode !== 'blind');
    applyBgMedia(ui);
  }
  window.orange.getConfig().then((c) => applyUI(c.ui)).catch(() => {});
  if (window.orange.onUIVars) window.orange.onUIVars(applyUI);

  // ---------- 字体缩放系统（0904恒定+0905用户滑杆+高分屏适配） ----------
  // 手法：全部样式表字号一次性改写——px→calc(N*var(--fz))，vw→calc(N*var(--fzv))
  //   --fz  = 用户滑杆 × 高分屏系数 × (新手模式?1/zoom:1)   （px字号：卡缩字不缩）
  //   --fzv = 用户滑杆 × 高分屏系数                        （vw字号如hub网格：随宽排版，不吃zoom补偿）
  // 高分屏系数：DIP高≥2000(4K@100%)=×1.25——真实像素太密导致"文字小"的元凶（0905用户反馈）
  let fontRewritten = false;
  function rewriteFontRules() {
    if (fontRewritten) return;
    fontRewritten = true;
    // ⚠坑65：新Chromium支持CSS嵌套后，普通CSSStyleRule也带cssRules属性——
    // 用"有cssRules=分组规则"分流会把每条规则都当分组跳过（0改写0报错，特性静默全灭）。
    // 正解：先处理自身style再递归子规则；逐条try包住，单条失败不连坐全表
    const walk = (rule) => {
      const st = rule.style;
      if (st) {
        try {
          const fz = st.fontSize;
          if (fz) {
            if (/^[0-9.]+px$/.test(fz)) st.fontSize = 'calc(' + fz + ' * var(--fz, 1))';
            else if (/^[0-9.]+vw$/.test(fz)) st.fontSize = 'calc(' + fz + ' * var(--fzv, 1))';
          }
        } catch (e3) {}
      }
      if (rule.cssRules && rule.cssRules.length) { for (const r of rule.cssRules) walk(r); }
    };
    try {
      for (const sheet of document.styleSheets) {
        let rules = null;
        try { rules = sheet.cssRules; } catch (e2) { continue; }
        for (const rule of rules) walk(rule);
      }
    } catch (e) {}
  }
  let constFontOn = false, lastZi = 1, userFontScale = 1;
  function updateFzVars() {
    if (/ball\.html$/.test(location.pathname)) return;   // 球窗无正文文字
    rewriteFontRules();
    // DIP屏高=CSS屏高×zoom（坑7家族：screen.height被zoom污染，乘回zoom归DIP口径）
    let auto = 1;
    try {
      const dipH = window.screen.height * (1 / lastZi);
      if (dipH >= 2000) auto = 1.25;
    } catch (e) {}
    const base = userFontScale * auto;
    document.documentElement.style.setProperty('--fzv', String(base));
    // 0907#7/#9 统一等比：字体随窗口缩放一起放大缩小（去掉旧"卡缩字不缩"的 lastZi 反向补偿）。
    // 渲染字体 = Npx×var(--fz)×zoom，--fz=base 时正好全程跟随 zoom。——fz不再乘(1/zoom)，
    // 否则缩放时字仍恒定（正是"窗口缩小字体不变"的来源）。--zi 保留给真正需尺寸恒定的元素。
    document.documentElement.style.setProperty('--fz', String(base));
  }
  function applyConstFont(on) {
    constFontOn = !!on;
    updateFzVars();
  }

  // 缩放反向补偿变量：--zi = 1/zoom，配合 calc(Npx * var(--zi,1)) 让元素在等比缩放下保持视觉尺寸恒定
  if (window.orange.onZoomVar) {
    window.orange.onZoomVar((z) => {
      lastZi = 1 / (Number(z) || 1);
      document.documentElement.style.setProperty('--zi', String(lastZi));
      updateFzVars();
    });
  }

  // ---------- 页面身份（关闭钮/盲人模式/热区豁免都要用） ----------
  const isBallPage = /ball\.html$/.test(location.pathname);
  const isHubPage = /hub\.html$/.test(location.pathname);
  // 交互门禁唯一出口在主进程windows.js的canLayout()：渲染端一律直接发起拖/缩请求，
  // 由主进程统一裁决（锁定=拒绝）——渲染端不再持有第二份门禁规则

  // ---------- 武装机制：本卡=武装模块时整卡边缘持续发光 ----------
  // 页面body标 data-arm-id="模块id" 即接入：卡内任何调节(input/change/滚轮/特定点击)自动上报武装
  const armId = document.body.dataset.armId;
  if (armId && window.orange.armModule) {
    let armedOn = false;
    function applyArmed(a) {
      const lg = document.querySelector('.lg');
      if (!lg) return;
      let ring = lg.querySelector(':scope > .armring');
      const on = !!(a && a.id === armId);
      if (on) {
        if (!ring) {
          ring = document.createElement('div');
          ring.className = 'glowring armring';   // 专属armPulse常亮脉冲（不挂loop的全灭渐隐）
          lg.appendChild(ring);
        }
        // 上装爆闪（0905用户裁定）：只在"未武装→武装"翻转沿闪一次——
        // 卡内每次调节都重播同id武装广播，不做沿判定=打字一下闪一下
        if (!armedOn) {
          const b = document.createElement('div');
          b.className = 'armburst';
          b.addEventListener('animationend', () => b.remove());
          lg.appendChild(b);
          setTimeout(() => { try { b.remove(); } catch (e) {} }, 1200);   // 动画事件丢失兜底
        }
      } else if (ring) {
        ring.remove();
      }
      armedOn = on;
    }
    window.orange.getArmed && window.orange.getArmed().then(applyArmed);
    if (window.orange.onArmed) window.orange.onArmed(applyArmed);

    // 调节即武装：输入/改动/滚轮任何表单与交互元素都算
    // ⚠只认真实用户事件——代码dispatchEvent的合成事件isTrusted=false，不得抢武装
    const arm = (e) => {
      if (e && e.isTrusted === false) return;
      window.orange.armModule(armId);
    };
    document.addEventListener('input', arm, true);
    document.addEventListener('change', arm, true);
    document.addEventListener('wheel', (e) => {
      // 只有落在交互元素上的滚轮才算调节（列表滚动不算）
      if (e.target.closest('input, select, .pill, .pslider, #carousel, #cntPill, .switch, canvas, [data-arm]')) arm(e);
    }, true);
    document.addEventListener('click', (e) => {
      // 点交互元素算调节（含点进输入框）；点标题栏/空白不算
      if (e.target.closest('button, input, textarea, select, .pill, .fx-el, .row, .switch, .heart, .gpill, canvas, [data-arm]')) arm(e);
    }, true);
  }

  // ---------- 免抢焦点模式：窗口默认不可聚焦（点按钮/滑块不夺PS焦点） ----------
  // 点进输入类控件→临时开聚焦打字；焦点离开输入控件→立即释放（PS快捷键无缝恢复）
  if (window.orange.wantFocus) {
    const needsKb = (el) => el && el.closest && el.closest('input, textarea, select, [contenteditable]');
    // 释放要留150ms缓冲再核实：中文输入法按Shift切换时会瞬时失焦又回来，
    // 立刻释放会把窗口变不可聚焦→系统把焦点甩给旁边按钮，表现为"切中文后打不了字"
    let wfRelease = null;
    let wfOn = false;   // 渲染端也做幂等：已在聚焦态就不再重发（防IPC风暴）
    const holdFocus = () => {
      clearTimeout(wfRelease);
      wfRelease = null;
      if (!wfOn) { wfOn = true; window.orange.wantFocus(true); }
    };
    document.addEventListener('pointerdown', (e) => {
      if (needsKb(e.target)) holdFocus();
    }, true);
    document.addEventListener('focusin', (e) => {
      if (needsKb(e.target)) holdFocus();
    });
    document.addEventListener('focusout', (e) => {
      if (needsKb(e.target) && !needsKb(e.relatedTarget)) {
        clearTimeout(wfRelease);
        wfRelease = setTimeout(() => {
          wfRelease = null;
          // ⚠activeElement在窗口失焦后仍陈旧指向输入框（老坑21）：必须配hasFocus双条件，
          // 只有"窗口仍聚焦且焦点真在输入控件上"才算还在打字，否则照常释放还给PS
          if (!(document.hasFocus() && needsKb(document.activeElement))) {
            wfOn = false;
            window.orange.wantFocus(false);
          }
        }, 150);
      }
    });
  }

  // ---------- 堆牌（0906）：被压卡只露标题条——悬停抽出发光 / 点击切牌 / 前卡投影画在自己身上 ----------
  // 主进程按几何摆窗与排z序；这里只管：deckbehind状态类、投影层、悬停/点击手势、武装呼吸、锁定热区
  let deckBehind = false;
  if (window.orange.onStackState) {
    const sst = document.createElement('style');
    sst.textContent = [
      // 前卡压上来的投影：画在被压卡自己露出的标题条底部（跨窗口画不了真投影，这是"看着真"的做法）
      // 覆盖完整标题条(48px)+前卡底下的尾巴(40 DIP=40×--zi CSS px)：默认露24px，悬停抽出后整条可读；
      // 阴影从24px就开始压深（默认态也要有被压感），抽出后渐变自然过渡
      '.deckshade { position: absolute; left: 0; right: 0; top: 0; height: calc(48px + 40px * var(--zi, 1)); border-radius: inherit; pointer-events: none; z-index: 5;',
      '  background: linear-gradient(to bottom, rgba(0,0,0,0) 12px, rgba(0,0,0,0.16) 24px, rgba(0,0,0,0.30) 44px, rgba(0,0,0,0.44) 48px, rgba(0,0,0,0.52) 100%); }',
      'body.deckbehind #head { cursor: pointer; }',
      'body.deckbehind #head .title { transition: color 0.15s; }',
      // 被压卡=纯标题条：窗口已收成一条（主进程），条上的按钮/输入框一律失活、关闭钮/缩放手柄藏起、
      // 条以下的正文不画（半透明前卡会把它透出来）；底角改直角——条的下缘正好接在前卡玻璃顶边上
      'body.deckbehind #head .hbtn, body.deckbehind #head input, body.deckbehind #head select, body.deckbehind #head button, body.deckbehind #head textarea, body.deckbehind #head [data-pass] { pointer-events: none !important; opacity: 0.55; }',
      'body.deckbehind .lg-close, body.deckbehind .lg-grip, body.deckbehind .lg-edge { display: none !important; }',
      'body.deckbehind .lg > *:not(#head):not(.deckshade):not(.glowring):not(.armburst):not(.bgMedia) { visibility: hidden; }',
      'body.deckbehind .lg { border-bottom-left-radius: 0 !important; border-bottom-right-radius: 0 !important; }',
      // 武装成员被压在堆里：它的标题logo+字主题色呼吸，提示"武装在这张"
      'body.deckbehind.deckarmed #head .title, body.deckbehind.deckarmed #head .title svg { color: var(--accent-text); animation: deckArmed 1.3s ease-in-out infinite; }',
      '@keyframes deckArmed { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }',
      // 入堆滑入（缩0.96弹回）/ 被压堆微沉
      '.lg.fusein { animation: deckFuseIn 0.2s cubic-bezier(0.34, 1.4, 0.64, 1); }',
      '@keyframes deckFuseIn { 0% { transform: scale(0.96); } 100% { transform: scale(1); } }',
      '.lg.deckbump { animation: deckBump 0.22s ease-out; }',
      '@keyframes deckBump { 0% { transform: translateY(0); } 45% { transform: translateY(3px); } 100% { transform: translateY(0); } }',
    ].join('\n');
    document.head.appendChild(sst);

    let stackState = null;
    let armedNow = null;
    let hovering = false;
    function applyDeck() {
      const lg = document.querySelector('.lg');
      deckBehind = !!(stackState && stackState.inStack && stackState.behind);
      document.body.classList.toggle('deckbehind', deckBehind);
      // 本卡被压着且正是武装模块 → 标题条主题色呼吸（提示"武装在这张"）
      document.body.classList.toggle('deckarmed', deckBehind && !!armedNow && armedNow === document.body.dataset.armId);
      if (!lg) return;
      let sh = lg.querySelector(':scope > .deckshade');
      if (deckBehind) {
        if (!sh) { sh = document.createElement('div'); sh.className = 'deckshade'; lg.appendChild(sh); }
      } else if (sh) sh.remove();
      if (!deckBehind && hovering) { hovering = false; hoverRing(false); }
    }
    // 悬停亮环（本地即时）+ 通知主进程抽出/归位
    function hoverRing(on) {
      const lg = document.querySelector('.lg');
      if (!lg) return;
      let ring = lg.querySelector(':scope > .deckhover');
      if (on) {
        if (!ring) { ring = document.createElement('div'); ring.className = 'glowring deckhover holdglow'; lg.appendChild(ring); }
      } else if (ring) ring.remove();
    }
    // 被压卡只露标题条：光标进入本窗即=进入标题条（mouseover冒泡到document，合成/真实输入都触发；
    // mouseleave在根元素上捕获离开；按下拖动中不抽——拖动由主进程接管）
    const hoverOn = () => {
      if (!deckBehind || hovering) return;
      hovering = true;
      hoverRing(true);
      if (window.orange.deckHover) window.orange.deckHover(true);
    };
    const hoverOff = () => {
      if (!hovering) return;
      hovering = false;
      hoverRing(false);
      if (window.orange.deckHover) window.orange.deckHover(false);
    };
    document.addEventListener('mouseover', (e) => { if (!(e.buttons & 1)) hoverOn(); });
    document.documentElement.addEventListener('mouseleave', hoverOff);
    document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) hoverOff(); });
    document.addEventListener('pointerdown', hoverOff, true);   // 按下=要拖或要切，先收回抽出态
    window.addEventListener('blur', hoverOff);
    window.__deckBehind = () => deckBehind;   // 标题栏手势判定用（下方磁吸拖动段）

    // 滚轮切牌（0907用户裁定，前提=绝不抢卡身正文的调参/滚列表）：只在三个"无主区"接管——
    //   ①被压卡（整窗只是一条标题条，控件全失活）  ②前卡的标题栏#head（从无滑块/列表）  ③按着Ctrl任意位置
    //   （Ctrl+滚轮本就被guardZoomKeys拦掉防Chromium缩放，是空位）。其余位置一律不碰。
    // 节流：一格滚轮切一张，150ms内多余的delta吞掉（高精度滚轮一次滚出十几个事件=一口气切穿整堆）
    let wheelCutAt = 0;
    document.addEventListener('wheel', (e) => {
      const inStack = stackState && stackState.inStack && stackState.total >= 2;
      if (!inStack) return;
      const onHead = !!e.target.closest('#head');
      if (!(deckBehind || onHead || e.ctrlKey)) return;
      e.preventDefault(); e.stopPropagation();
      const now = Date.now();
      if (now - wheelCutAt < 150) return;
      wheelCutAt = now;
      if (window.orange.deckWheel) window.orange.deckWheel(e.deltaY > 0 ? 1 : -1);
    }, { capture: true, passive: false });

    window.orange.onStackState((s) => { stackState = s; applyDeck(); });
    if (window.orange.getArmed) window.orange.getArmed().then((a) => { armedNow = a && a.id; applyDeck(); });
    if (window.orange.onArmed) window.orange.onArmed((a) => { armedNow = a && a.id; applyDeck(); });
  }

  // ---------- 收纳/释放特效 ----------
  // 收纳：pregather=全体发光+变大 → gather=快速螺旋卷入(内容缩小微旋)
  // 释放：主进程快速归位，落定后广播glow-all齐闪一次
  if (window.orange.onGatherFx) {
    const st = document.createElement('style');
    st.textContent = '.glowring.holdglow { opacity: 1 !important; animation: none !important; }';
    document.head.appendChild(st);

    function fxRing(lg) {
      let ring = lg.querySelector(':scope > .fxring');
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'glowring fxring';
        lg.appendChild(ring);
      }
      return ring;
    }
    window.orange.onGatherFx(({ mode, dur }) => {
      const lg = document.querySelector('.lg');
      if (!lg) return;
      lg.style.transformOrigin = '50% 50%';
      if (mode === 'pregather') {
        // 收回第一幕：边框亮起+整体胀大
        fxRing(lg).classList.add('holdglow');
        lg.style.transition = 'transform 170ms cubic-bezier(.34,1.56,.64,1)';
        lg.style.transform = 'scale(1.07)';
      } else if (mode === 'fusehint') {
        // 融合预览：持续亮环示意"松手即融合"（不做形变，拖动中不能抖）
        fxRing(lg).classList.add('holdglow');
      } else if (mode === 'fusein' || mode === 'bump') {
        // 堆牌：新成员滑入(缩0.96弹回) / 被压堆微沉一下；动画走class，结束自摘
        const ring = lg.querySelector(':scope > .fxring');
        if (ring) ring.remove();
        lg.style.transition = 'none'; lg.style.transform = '';
        const cls = mode === 'fusein' ? 'fusein' : 'deckbump';
        lg.classList.remove(cls); void lg.offsetWidth; lg.classList.add(cls);
        setTimeout(() => lg.classList.remove(cls), 260);
      } else if (mode === 'gather') {
        // 收回第二幕：随螺旋收缩旋转
        lg.style.transition = 'transform ' + dur + 'ms cubic-bezier(.6,0,.9,.4)';
        lg.style.transform = 'scale(0.38) rotate(-14deg)';
      } else {
        // reset
        lg.style.transition = 'none';
        lg.style.transform = '';
        const ring = lg.querySelector(':scope > .fxring');
        if (ring) ring.remove();
      }
    });
  }

  // ---------- 尿尿提醒：到点全体卡牌翻面快闪5下，点击任意卡背全体翻回 ----------
  if (window.orange.onPeeAlarm) {
    const ps = document.createElement('style');
    ps.textContent = [
      '.peeback { position: absolute; inset: 0; z-index: 9999; display: none; flex-direction: column;',
      ' align-items: center; justify-content: center; gap: 12px; border-radius: inherit; cursor: pointer;',
      ' padding: 18px; text-align: center;',
      ' background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 32%, rgba(30,26,20,0.97)), rgba(18,16,12,0.99));',
      ' border: 1px solid var(--accent-border); }',
      '@keyframes peeBreath { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.5); } }',
      '.peeback.on { display: flex; animation: peeBreath 1.9s ease-in-out infinite; }',
      '.pb-big { font-size: 17px; font-weight: 800; color: var(--accent-text); letter-spacing: 1px; }',
      '.pb-small { font-size: 12px; color: #fff; opacity: 0.85; line-height: 1.7; }',
      '.pb-quote { font-size: 11px; color: var(--accent-text); opacity: 0.92; margin-top: 4px; letter-spacing: 0.5px; }',
    ].join('\n');
    document.head.appendChild(ps);

    let peeFlipped = false;
    function peeBack(lg) {
      let back = lg.querySelector(':scope > .peeback');
      if (!back) {
        back = document.createElement('div');
        back.className = 'peeback';
        back.innerHTML = '<div class="pb-big">来福提醒你该尿尿了！</div>'
          + '<div class="pb-small">修图虽好可不要贪杯喵，该休息一下了喵喵♥</div>'
          + '<div class="pb-quote"></div>';
        back.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.orange.peeAck) window.orange.peeAck();
        });
        lg.appendChild(back);
      }
      return back;
    }
    window.orange.onPeeAlarm((p) => {
      const lg = document.querySelector('.lg');
      if (!lg || peeFlipped) return;
      peeFlipped = true;
      const back = peeBack(lg);
      const q = back.querySelector('.pb-quote');
      if (q) q.textContent = (p && p.phrase) ? '「 ' + p.phrase + ' 」' : '';
      // 翻面：侧转90°→亮出卡背→转回→快闪5下
      lg.style.transition = 'transform 160ms ease-in';
      lg.style.transform = 'perspective(900px) rotateY(90deg)';
      setTimeout(() => {
        back.classList.add('on');   // 卡背常驻呼吸闪烁直到被点击
        lg.style.transition = 'transform 160ms ease-out';
        lg.style.transform = 'perspective(900px) rotateY(0deg)';
      }, 165);
    });
    window.orange.onPeeAlarmClear(() => {
      const lg = document.querySelector('.lg');
      if (!lg || !peeFlipped) return;
      peeFlipped = false;
      const back = lg.querySelector(':scope > .peeback');
      lg.style.transition = 'transform 160ms ease-in';
      lg.style.transform = 'perspective(900px) rotateY(90deg)';
      setTimeout(() => {
        if (back) back.classList.remove('on');
        lg.style.transition = 'transform 160ms ease-out';
        lg.style.transform = '';
      }, 165);
    });
  }

  // ---------- 释放落位全体发光：主进程广播glow-all → 卡片边框单次脉冲 ----------
  if (window.orange.onGlowAll) {
    window.orange.onGlowAll(() => {
      const lg = document.querySelector('.lg');
      if (!lg) return;
      let ring = lg.querySelector(':scope > .glowring');
      if (!ring) {
        ring = document.createElement('div');
        ring.className = 'glowring';
        lg.appendChild(ring);
      }
      ring.classList.remove('once');
      void ring.offsetWidth;   // 重启动画
      ring.classList.add('once');
    });
  }

  // ---------- 锁定模式按钮热区上报 ----------
  // 锁定时窗口整体穿透，只有这些矩形内的点击被窗口接收（主进程轮询判定）
  // ⚠球窗口豁免：球菜单自己上报菜单项热区，通用上报会每250ms把它覆盖掉（菜单点击时灵时不灵的元凶）；
  //   菜单关着时球走主进程的圆形判定，本来就不需要热区
  if (window.orange.setPassRects && !isBallPage) {
    let lockRectTimer = null;
    function reportPassRects() {
      // 锁定时放行的可点元素：原生控件 + canvas + 各卡片的交互类（气泡/胶囊/pill/列表行/开关/爱心/灯具格等）
      const sel = 'button, input, select, textarea, a, canvas, .hbtn, .lock-btn, .bubble, .gpill, .row, .heart, .fbtn, .pill, .switch, .sq, .fx-el, .cfollow, .chip, .fp-item, .tbtn, .slot, .gpr, .gin, .gout, .gx, #btnAddRef, #presetTrig, #presetList, #carousel, #cntPill, [data-pass]';
      const rects = [];
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) rects.push({ x: r.x, y: r.y, w: r.width, h: r.height });
      });
      // 堆牌被压卡：露出的标题条要能点（切牌），锁定时也放行
      if (window.__deckBehind && window.__deckBehind()) {
        const h = document.getElementById('head');
        if (h) { const r = h.getBoundingClientRect(); if (r.width > 0) rects.push({ x: r.x, y: r.y, w: r.width, h: r.height }); }
      }
      window.orange.setPassRects(rects);
    }
    function setLockReporting(on) {
      document.body.classList.toggle('lockedon', !!on);   // 锁定时CSS隐藏缩放手柄（主进程同时拒绝grip）
      clearInterval(lockRectTimer);
      lockRectTimer = null;
      if (on) {
        reportPassRects();
        lockRectTimer = setInterval(reportPassRects, 250);   // 布局变化跟随
        document.addEventListener('click', reportPassRects, true);   // 点击后（如弹窗弹出）立即补报
      } else {
        document.removeEventListener('click', reportPassRects, true);
      }
    }
    window.orange.getConfig().then((c) => setLockReporting(!!c.locked)).catch(() => {});
    if (window.orange.onLockState) window.orange.onLockState(({ locked }) => setLockReporting(locked));
  }

  // ---------- 磁吸拖动：标题栏按住拖动（主进程采样鼠标并做窗口间吸附） ----------
  const head = document.getElementById('head');
  if (head && window.orange.dragStart) {
    head.addEventListener('pointerdown', (e) => {
      // 点在按钮/输入控件上不触发拖动
      if (e.target.closest('.hbtn') || e.target.closest('input') || e.target.closest('select') || e.target.closest('button')) return;
      e.preventDefault();
      head.setPointerCapture(e.pointerId);
      // 两态模型：未锁定=随时可拖（锁定时主进程直接拒绝）；左键拖=整组联动；右键拖=单独摘走(拆组)
      window.orange.dragStart(e.button === 2);
      // 堆牌：被压卡标题条"按下即松、没拖动"=切牌（拖动交主进程；监听挂window级，坑70）
      const sx = e.screenX, sy = e.screenY, btn = e.button;
      let moved = false, ended = false;
      const mv = (ev) => { if (Math.abs(ev.screenX - sx) + Math.abs(ev.screenY - sy) > 4) moved = true; };
      const end = () => {
        if (ended) return; ended = true;
        window.orange.dragEnd();
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        head.removeEventListener('lostpointercapture', end);
        if (!moved && btn === 0 && window.__deckBehind && window.__deckBehind() && window.orange.deckCut) window.orange.deckCut();
      };
      // ⚠setPointerCapture后pointerup/pointermove都定向到head(捕获元素)，window级收不到→dragEnd/切牌判定失效
      //  →主进程dragTimer一直拿光标坐标挪窗=卡牌失控跟着鼠标飞(0907 bug5)。head上move/up/cancel/lostpointercapture兜底。
      head.addEventListener('pointermove', mv);
      head.addEventListener('pointerup', end);
      head.addEventListener('pointercancel', end);
      head.addEventListener('lostpointercapture', end);
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    head.addEventListener('contextmenu', (e) => e.preventDefault());   // 右键用于摘走，屏蔽菜单

    // ---------- 全卡拖拽：按住任意"非交互"区域=左键拖动整卡 ----------
    // 起因：窗口顶边探出屏幕后标题栏抓不到=卡片永远拖不回来；现在任意可见处都是把手
    // 排除清单=原生控件+各卡自定义拖动区(气泡拖出/灯光画布/取色盘/转盘)+可选文字+缩放手柄
    const NODRAG = [
      'button', 'input', 'textarea', 'select', 'a', 'canvas', '[contenteditable]',
      '#head', '.lg-grip', '.lg-edge', '.peeback', '.msg-content', '[data-pass]', '[data-nodrag]',
      '.hbtn', '.lock-btn', '.bubble', '.gpill', '.row', '.heart', '.fbtn', '.pill', '.switch', '.sq',
      '.fx-el', '.cfollow', '.chip', '.fp-item', '.tbtn', '.slot', '.pslider', '.gitem',
      '#sv', '#carousel', '#cntPill', '#presetTrig', '#presetList', '#btnAddRef', '#newMsgTip',
    ].join(', ');
    let bodyDragging = false, swallowClick = false, dSx = 0, dSy = 0, dMoved = false;
    document.addEventListener('pointerdown', (e) => {
      // 左键=整组联动；右键=单独摘走（与标题栏语义一致——forge这类标题窄、卡身大的卡右键才有地方按）
      if ((e.button !== 0 && e.button !== 2) || bodyDragging) return;
      if (e.target.closest(NODRAG)) return;
      try { if (getComputedStyle(e.target).userSelect === 'text') return; } catch {}
      e.preventDefault();
      bodyDragging = true; dMoved = false; dSx = e.screenX; dSy = e.screenY;
      window.orange.dragStart(e.button === 2);   // 锁定时主进程直接拒绝
      const move = (ev) => { if (Math.abs(ev.screenX - dSx) + Math.abs(ev.screenY - dSy) > 4) dMoved = true; };
      const end = () => {
        window.orange.dragEnd();
        bodyDragging = false;
        // 真拖动过才吞后续click，原地点击不吞（不影响正常点按）
        if (dMoved) { swallowClick = true; setTimeout(() => { swallowClick = false; }, 80); }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
    // 右键拖过卡身后不弹上下文菜单（打光等卡自己的contextmenu逻辑在NODRAG区内，不受影响）
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest(NODRAG)) e.preventDefault();
    });
    // 拖动释放瞬间的click吞掉，防止"抓着卡内空白拖完"误触点击逻辑
    document.addEventListener('click', (e) => {
      if (swallowClick) { e.stopPropagation(); e.preventDefault(); }
    }, true);
  }

  // ---------- 卡片本地关闭钮：每张卡自己就能收起，不用回控制台（Beta反馈P2第9条） ----------
  // 悬停标题栏才现身的弱化×；hub有自己的收起钮、球没有标题栏，都跳过
  (function () {
    const h = document.getElementById('head');
    if (!h || isHubPage || isBallPage || !window.orange.closeSelf) return;
    const cb = document.createElement('div');
    cb.className = 'hbtn lg-close';
    cb.innerHTML = '×';
    cb.title = '关闭卡片';
    cb.setAttribute('data-pass', '');   // 穿透模式放行
    cb.addEventListener('click', (e) => { e.stopPropagation(); window.orange.closeSelf(); });
    h.appendChild(cb);
  })();

  // ---------- 自绘缩放手柄（透明窗口没有系统边缘拖拽） ----------
  // 角部圆钮=等比缩放；右边缘=自由拉宽；下边缘=自由拉高（内容重排）
  const root = document.querySelector('.lg');
  if (root && window.orange.gripStart) {
    function makeHandle(el, mode) {
      let active = false;
      const done = () => {
        if (!active) return;
        active = false;
        window.orange.gripEnd();
        window.removeEventListener('pointerup', done);
        window.removeEventListener('pointercancel', done);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        el.setPointerCapture(e.pointerId);
        active = true;
        window.orange.gripStart(mode);   // 拖动量由主进程轮询鼠标自采，页面只发开始/结束
        // ⚠0907 bug5"鼠标不按按钮却跟着鼠标动"：若用户拖出窗口/系统抢占指针捕获，pointerup
        //  只定向到捕获元素el、或根本不发→gripEnd永不调用→主进程gripTimer一直用光标坐标挪窗=卡牌失控。
        //  三层兜底：el的up/cancel(主通道) + window级up/cancel + lostpointercapture，保证会话一定终结。
        window.addEventListener('pointerup', done);
        window.addEventListener('pointercancel', done);
      });
      el.addEventListener('pointerup', done);
      el.addEventListener('pointercancel', done);
      el.addEventListener('lostpointercapture', done);
      // 挂body(窗口视图层)而非.lg：缩放手柄定位在窗口最外沿的透明边距区(12px)，
      // 不覆盖.lg内容——否则拉伸热区(z-index:5)会压住排到边缘的滑块/按钮(0907 bug8"拉伸框和滑块重叠点不到")，
      // 且用户能自由拖窗口边缘(0907 bug7)。CSS用fixed定位到窗口四边/右下角。
      document.body.appendChild(el);
    }

    // 右下角落：隐形热区，拖动=等比缩放（无按钮不占视觉）
    const grip = document.createElement('div');
    grip.className = 'lg-grip';
    grip.title = '按住拖动：等比缩放';
    makeHandle(grip, 'corner');

    // 四边自由拉伸（0907#1修正：b/t恢复整条单段——拆左右两角分段会连卡片中间区域的上下边
    //   都没有手柄=只能横向拉伸没法上下拉伸。手柄在窗口外沿12px透明区，(content在inset:12px内)不盖滚动条）
    const er = document.createElement('div');
    er.className = 'lg-edge lg-edge-r';
    er.title = '按住拖动：调整宽度';
    makeHandle(er, 'right');

    const el = document.createElement('div');
    el.className = 'lg-edge lg-edge-l';
    el.title = '按住拖动：调整宽度';
    makeHandle(el, 'left');

    const eb = document.createElement('div');
    eb.className = 'lg-edge lg-edge-b';
    eb.title = '按住拖动：调整高度';
    makeHandle(eb, 'bottom');

    const et = document.createElement('div');
    et.className = 'lg-edge lg-edge-t';
    et.title = '按住拖动：调整高度';
    makeHandle(et, 'top');
  }
  } catch (e) {
    // 任何窗口的glass.js运行时错误都落诊断日志（不然拖动/缩放悄悄失效很难排查）
    try { window.orange.glassLog('[glass.js异常] ' + location.pathname.split('/').pop() + ' → ' + (e && e.message)); } catch (_) {}
  }
})();
