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

  // 样式注入一次（类名pc-前缀，避免与宿主页面冲突；玻璃内嵌风与params.html的.prow同款）
  let styleDone = false;
  function ensureStyle() {
    if (styleDone) return;
    styleDone = true;
    const st = document.createElement('style');
    st.textContent = [
      // 双列网格：一横排两个滑块，紧凑尺寸一屏见6个；填空框独占整行
      '.pc-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }',
      '.pc-row { display: flex; flex-direction: column; gap: 3px; padding: 6px 9px; min-width: 0;',
      '  border-radius: 11px; background: var(--inset-bg); border: 1px solid var(--inset-border); }',
      '.pc-row.pc-wide { grid-column: 1 / -1; }',
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
  function render(container, text, ctl, onChange) {
    ensureStyle();
    if (!ctl.params) ctl.params = {};
    if (!ctl.blanks) ctl.blanks = {};
    const { sliders, blanks } = parse(text || '');
    container.innerHTML = '';
    // 双列网格用内联样式钉死——宿主页面的#id选择器（如#pcList的flex单列）优先级会压过.pc-grid类
    container.classList.add('pc-grid');
    container.style.display = 'grid';
    container.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
    container.style.gridAutoRows = 'min-content';
    container.style.gap = '6px';

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
    return { count: sliders.length + blanks.length };
  }

  window.ORANGE_PARAM_CTL = { parse, render, signature };
})();
