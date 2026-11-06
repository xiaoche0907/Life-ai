// 拼音搜索共享模块（1011 用户需求）：提示词标题支持拼音/首字母搜索，且不分平翘舌
//
// 设计要点：
// ① 字典是**数据**（pinyin-map.js，从 pinyin-pro 提取），不是库——不把 928KB 的 pinyin-pro 打进包。
// ② 只在启动时展开一次成 Map（实测 8ms / 20934 字），之后每条标题的拼音转换 ≈0.1ms。
// ③ 匹配维度：原文子串 → 全拼子串 → 首字母子串，三种都做「平翘舌折叠」等价比较。
//    折叠是在**查询词和标题拼音同时**做，所以「shoushen」和「soushen」都能命中「瘦身」。
// ④ 只作用于标题：正文通常是几千字的提示词，转拼音既慢也没意义（0910 用户已裁定搜索只搜标题）。
(function () {
  // ---------- 字典展开（懒加载，谁先搜谁触发） ----------
  let PY = null;
  function dict() {
    if (PY) return PY;
    PY = new Map();
    const raw = window.ORANGE_PINYIN_RAW;
    if (!raw) return PY;   // 字典没加载：退化成"只按原文匹配"，不会报错
    for (const seg of raw.split('|')) {
      const i = seg.indexOf(':');
      if (i < 0) continue;
      const v = seg.slice(i + 1);
      PY.set(seg.slice(0, i), v.indexOf(',') >= 0 ? v.split(',') : v);
    }
    return PY;
  }

  // ---------- 归一化 ----------
  // 去声调：拼音带声调符号，用 NFD 拆出组合符再删；ü 统一写成 v（用户键盘上打不出 ü）
  const TONE = /[̀-ͯ]/g;
  function stripTone(py) {
    return py.normalize('NFD').replace(TONE, '').replace(/ü/g, 'v').replace(/ǖ|ǘ|ǚ|ǜ/g, 'v');
  }
  // 平翘舌折叠：zh→z ch→c sh→s（**必须同时作用于两边**，否则"shoushen"与"瘦身"仍不相等）
  function fold(s) {
    return s.replace(/zh/g, 'z').replace(/ch/g, 'c').replace(/sh/g, 's');
  }

  // ---------- 汉字→拼音 ----------
  // 返回 {full:全拼, init:首字母}（已去声调）。非汉字原样保留小写（如 "cg"、"g2"）
  const cache = new Map();   // 标题 → 拼音，标题不多但会被反复搜，缓存掉重复计算
  function of(text) {
    const key = text || '';
    const c = cache.get(key);
    if (c) return c;
    const d = dict();
    let full = '', init = '';
    for (const ch of key) {
      if (/[一-鿿㐀-䶿]/.test(ch)) {
        const arr = d.get(ch);
        const py = arr ? stripTone(Array.isArray(arr) ? arr[0] : arr) : '';
        if (py) { full += py; init += py[0]; continue; }
      }
      const low = ch.toLowerCase();
      full += low;
      init += low;
    }
    const r = { full, init };
    if (cache.size > 4000) cache.clear();   // 上限保护：标题改了就重算，不影响正确性
    cache.set(key, r);
    return r;
  }

  // ---------- 打分匹配 ----------
  // 分档（数字越小越靠前），与 0910「标题以搜索词开头的最前」的口径一致，只是补上拼音那几档：
  //   0 = 标题原文以查询开头
  //   1 = 全拼以查询开头
  //   2 = 首字母以查询开头
  //   3 = 原文中段命中
  //   4 = 全拼中段命中
  //   5 = 首字母中段命中
  const RANK_ORIGIN_PREFIX = 0;
  const RANK_ORIGIN_MID = 3;
  function score(name, query) {
    const n = (name || '').toLowerCase();
    const q = (query || '').trim().toLowerCase();
    if (!q) return null;

    // ① 原文直接命中（保留原有行为：中文/英文/数字一把梭）
    const at = n.indexOf(q);
    if (at >= 0) return { rank: at === 0 ? RANK_ORIGIN_PREFIX : RANK_ORIGIN_MID, at };

    // ② 拼音命中：用户打的本来就是拼音字母串，所以只折叠查询词，再和标题拼音（原文/折叠）比
    const { full, init } = of(name);
    const qf = fold(q);
    if (!qf) return null;
    const fF = fold(full), iF = fold(init);
    if (fF.startsWith(qf)) return { rank: 1, at: 0 };
    if (iF.startsWith(qf)) return { rank: 2, at: 0 };
    // ⚠查询太短（1 个字母）到此为止：再往下就是"中段命中"，单字母能在拼音串里到处撒网
    //   （"x"会命中 fengxiong… 里的那个 x），一屏全是不相干的结果。中段匹配最少 2 个字母起。
    if (qf.length < 2) return null;
    const af = fF.indexOf(qf);
    if (af >= 0) return { rank: 4, at: af };
    const ai = iF.indexOf(qf);
    if (ai >= 0) return { rank: 5, at: ai };
    return null;
  }

  // 给排序用：压成单个数字（越小越靠前）；不命中返回 null。
  // 量纲 = rank*10000 + 命中位置，位置在同一档内仍然管用（与改动前"按匹配位置排"等价）
  function rankOf(name, query) {
    const s = score(name, query);
    return s === null ? null : s.rank * 10000 + s.at;
  }

  // 对外统一入口：字典缺失/解析异常时自动退回"只按原文子串"，搜索结果永不消失
  function rank(name, query) {
    try {
      if (window.ORANGE_PINYIN_RAW) return rankOf(name, query);
    } catch (e) {}
    return plainRankOf(name, query);
  }
  function plainRankOf(name, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return null;
    const at = (name || '').toLowerCase().indexOf(q);
    return at < 0 ? null : (at === 0 ? RANK_ORIGIN_PREFIX : RANK_ORIGIN_MID) * 10000 + at;
  }

  window.ORANGE_PINYIN = { of, score, rankOf, rank, plainRankOf, fold, stripTone };
})();
