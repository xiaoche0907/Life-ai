// 参数控件共享渲染器：提示词里的 @param滑块 / 【填空:】控件解析+渲染
// 供提示词卡内联区使用（滑块卡params.html保留独立实现，喜欢浮窗的用户继续用；
// 两边写的都是 config.gen.ctl 同一份，同开时后写者胜）
// 正则逐字来自语料原典（与params.html一致，不可改）
(function () {
  const RE_PARAM = /@param:([^"\s:]+?)"\s*:\s*("[^"]*"|[-\d.]+)/g;
  const RE_BLANK = /【填空:([^=】]+?)(?:=([^】]*))?】/g;

  // 解析：滑块（含_label/_desc/_note/_range元数据、同名去重、文本值不渲染）+ 填空（同名共用一框）
  function parse(text) {
    const meta = {};   // name → {label, desc}
    let m;
    RE_PARAM.lastIndex = 0;
    while ((m = RE_PARAM.exec(text))) {
      const name = m[1], val = m[2];
      const mm = name.match(/^(.*)_(label|desc|note|range)$/);
      if (mm && val[0] === '"') (meta[mm[1]] = meta[mm[1]] || {})[mm[2]] = val.slice(1, -1);
    }
    const sliders = [], seen = new Set();
    RE_PARAM.lastIndex = 0;
    while ((m = RE_PARAM.exec(text))) {
      const name = m[1], val = m[2];
      if (/_(label|desc|note|range)$/.test(name)) continue;
      if (val[0] === '"') continue;   // 文本值=写错的滑块，原典插件同样不渲染
      if (seen.has(name)) continue;   // 同名只渲一个
      seen.add(name);
      sliders.push({
        name,
        label: (meta[name] && meta[name].label) || name,
        desc: (meta[name] && meta[name].desc) || '',
        def: Math.max(0, Math.min(1, parseFloat(val) || 0)),
      });
    }
    const blanks = [], bseen = new Set();
    RE_BLANK.lastIndex = 0;
    while ((m = RE_BLANK.exec(text))) {
      if (bseen.has(m[1])) continue;   // 同名同值：一个框注入全部
      bseen.add(m[1]);
      blanks.push({ name: m[1], def: m[2] || '' });
    }
    return { sliders, blanks };
  }

  // 解析结果签名：控件集合没变就不重建DOM（保住正在输入的填空框焦点）
  function signature(text) {
    const { sliders, blanks } = parse(text || '');
    return sliders.map((s) => 's:' + s.name + ':' + s.def).join('|')
      + '#' + blanks.map((b) => 'b:' + b.name + ':' + b.def).join('|');
  }

  // ---------- 列数自适应（1011 用户反馈②：卡拉成竖长/缩很小之后滑块挤成一条缝，拖不动） ----------
  // 判据两条，任一命中就降到"一横排一个"：
  //   ①竖长卡（窗口高>宽）——自由拉伸只改宽不改zoom，竖长=卡内可用宽真的变窄了
  //   ②横卡但卡内可用宽不够一列 110px（缩到极限 136 DIP×zoom0.45 时≈302 CSS px，三列每列仅 ~97px）
  // 竖长卡一律 1 列；横卡按实测宽度分 3/2/1 档（不用 media query：这一列的宽度与视口无关，得实测容器）
  // ⚠110 是实测标定的：出厂横卡内实测 226~328 CSS px（380×250 的卡在开发机上卡内宽 226，
  //   出厂不缩放时 328），110 会把出厂横卡也压成 2 列——用户要的是"出厂横卡维持原样"。
  //   取 100 后：出厂 328px→3列每列 105px（与改动前完全一致），226px→2列，竖长→1列
  const MIN_COL_W = 100;
  const COL_GAP = 6;
  function colsFor(width, portrait, maxCols) {
    const hi = Math.max(1, Math.min(3, maxCols || 3));
    if (portrait) return 1;
    const usable = Math.max(0, Number(width) || 0) + COL_GAP;
    const n = Math.floor(usable / (MIN_COL_W + COL_GAP));
    return Math.max(1, Math.min(hi, n));
  }
  function applyCols(c, n) {
    if (c._pcCols === n) return;
    c._pcCols = n;
    c.style.gridTemplateColumns = 'repeat(' + n + ', minmax(0, 1fr))';
    c.classList.toggle('pc-one', n === 1);   // 单列时把滑轨加粗（一行一个=有高度余量，好下手）
  }
  function watchCols(c) {
    const sync = () => applyCols(c, colsFor(c.clientWidth, window.innerHeight > window.innerWidth, c._pcMaxCols));
    // ⚠每次render都会走这里，监听必须只挂一次（否则重建N次=挂N个resize监听，退出时全泄漏）
    if (!c._pcRO && window.ResizeObserver) {
      c._pcRO = new ResizeObserver(() => {
        if (!c.isConnected) {   // 容器已被宿主换掉/重渲：自己收摊，别留着监听
          try { c._pcRO.disconnect(); } catch (e) {}
          c._pcRO = null;
          if (c._pcWinSync) window.removeEventListener('resize', c._pcWinSync);
          return;
        }
        sync();
      });
      try { c._pcRO.observe(c); } catch (e) {}
    }
    if (!c._pcWinSync) {
      c._pcWinSync = sync;   // 竖长⇄横长翻转只有窗口 resize 报得到（容器宽未必变）
      window.addEventListener('resize', c._pcWinSync);
    }
    sync();
  }

  // 样式注入一次（类名pc-前缀，避免与宿主页面冲突；玻璃内嵌风与params.html的.prow同款）
  let styleDone = false;
  function ensureStyle() {
    if (styleDone) return;
    styleDone = true;
    const st = document.createElement('style');
    st.textContent = [
      // 多列网格：默认一横排三个，实测宽度不够时由 applyCols 降到 2/1 列；填空框独占整行
      '.pc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }',
      '.pc-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 9px; min-width: 0;',
      '  border-radius: 11px; background: var(--inset-bg); border: 1px solid var(--inset-border); }',
      '.pc-row.pc-wide { grid-column: 1 / -1; }',
      // 一排一个时滑轨加粗到 22px：行矮了滑轨还细=还是拖不动，加粗才是"方便拉动"的关键
      '.pc-grid.pc-one .pc-row { padding: 8px 11px; }',
      '.pc-grid.pc-one input[type="range"] { height: 22px; }',
      '.pc-grid.pc-one .pc-name { font-size: 11.5px; }',
      '.pc-grid.pc-one .pc-val { min-width: 38px; font-size: 11px; }',
      '.pc-name { font-size: 10.5px; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
      '.pc-line { display: flex; align-items: center; gap: 6px; }',
      '.pc-line input[type="range"] { flex: 1; min-width: 0; accent-color: var(--accent); height: 14px; cursor: pointer; }',
      '.pc-val { min-width: 30px; text-align: right; font-size: 10px; color: var(--accent-text); font-variant-numeric: tabular-nums; }',
      '.pc-row input[type="text"] { width: 100%; height: 26px; padding: 0 9px; border-radius: 8px;',
      '  border: 1px solid var(--inset-border); background: rgba(0,0,0,0.22); color: var(--text);',
      '  font-size: 11px; outline: none; user-select: text; }',
      '.pc-row input[type="text"]:focus { border-color: var(--accent-border); }',
    ].join('\n');
    document.head.appendChild(st);
  }

  // 渲染进container：值优先取ctl里已调值；用户改动写回ctl并回调onChange（防抖由宿主做）
  // opts.maxCols：宿主嫌 3 列太挤时自己压低上限（不传=3列，老宿主行为不变）
  function render(container, text, ctl, onChange, opts) {
    ensureStyle();
    if (!ctl.params) ctl.params = {};
    if (!ctl.blanks) ctl.blanks = {};
    const { sliders, blanks } = parse(text || '');
    container.innerHTML = '';
    // 网格列数用内联样式钉死——宿主页面的#id选择器（如#pcList的flex单列）优先级会压过.pc-grid类。
    // ⚠列数不写死，交给 applyCols 按"容器实测宽 + 窗口长宽比"决定（1011用户反馈②：竖长卡要一排一个）
    container.classList.add('pc-grid');
    container.style.display = 'grid';
    container.style.gridAutoRows = 'min-content';
    container.style.gap = COL_GAP + 'px';
    container._pcCols = null;   // 强制重算（重建后 DOM 换了，宽要重新量）
    container._pcMaxCols = (opts && opts.maxCols) || 3;

    for (const s of sliders) {
      const cur = (ctl.params[s.name] != null) ? ctl.params[s.name] : s.def;
      const row = document.createElement('div');
      row.className = 'pc-row';
      const name = document.createElement('div');
      name.className = 'pc-name';
      name.textContent = s.label;
      if (s.desc) name.title = s.desc;   // 档位说明只在悬停主标题时显示
      const line = document.createElement('div');
      line.className = 'pc-line';
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0'; inp.max = '1'; inp.step = '0.01'; inp.value = cur;
      const pv = document.createElement('span');
      pv.className = 'pc-val'; pv.textContent = Number(cur).toFixed(2);
      inp.addEventListener('input', () => {
        ctl.params[s.name] = Number(inp.value);
        pv.textContent = Number(inp.value).toFixed(2);
        onChange();
      });
      // 滚轮微调±0.01
      inp.addEventListener('wheel', (e) => {
        e.preventDefault();
        const nv = Math.max(0, Math.min(1, Number(inp.value) + (e.deltaY > 0 ? -0.01 : 0.01)));
        inp.value = nv;
        ctl.params[s.name] = nv;
        pv.textContent = nv.toFixed(2);
        onChange();
      });
      line.appendChild(inp); line.appendChild(pv);
      row.appendChild(name); row.appendChild(line);
      container.appendChild(row);
    }

    for (const b of blanks) {
      const row = document.createElement('div');
      row.className = 'pc-row pc-wide';   // 填空独占整行
      const name = document.createElement('div');
      name.className = 'pc-name';
      name.textContent = b.name;
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = (ctl.blanks[b.name] != null) ? ctl.blanks[b.name] : b.def;
      inp.placeholder = b.def || '留空=空字符串注入';
      inp.title = '同名填空全篇共用这一个框（填一次全部注入）';
      inp.addEventListener('input', () => {
        ctl.blanks[b.name] = inp.value;
        onChange();
      });
      row.appendChild(name); row.appendChild(inp);
      container.appendChild(row);
    }
    // 行都进 DOM 之后再量（此刻容器宽度才是最终值；空了再量会拿到上一轮的宽度）
    watchCols(container);
    return { count: sliders.length + blanks.length };
  }

  window.ORANGE_PARAM_CTL = { parse, render, signature };
})();
