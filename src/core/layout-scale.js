// 出厂布局按当前工作区折算（纯函数：state.js 运行时 + tools/layout-scale-test.js 单测共用，不碰 electron）
//
// 出厂布局（default-layout.json / layout-modded.json / factory-layouts.json）是在开发机 2560×1392@100% 上摆的，
// 其他屏幕按 S=min(工作区宽/ref宽, 工作区高/ref高) 等比折算坐标/尺寸/缩放。
// 1012 用户实报「默认布局乱」（2560×1600@150% → 工作区 1707×1019，S=0.667）旧算法两处下限不跟着缩：
//   ① zoom 夹到 0.45 时尺寸改按模块出厂基准重算——作者拉成扁条的抗截断/校色 260×100 变成 171×149（高一倍多），压住下面的卡；
//   ② 折算出的宽比窗口最小宽（windows.js applyMinSize：max(136, 基准宽×0.45)）还窄，开窗时被系统撑宽。
//   位置缩了、卡没缩够 → 150% 下 6 对卡互相压住，175% 下 12 对。
// 新算法：①按 z/z0 等比放大作者摆的那个尺寸（保住长宽比）②宽不低于最小宽 ③折算后新产生的重叠按作者摆放的方位顺延错开。
// 在 ref 工作区（S=1）上输出与输入逐项一致——开发机上一像素都不动。

const MIN_Z = 0.45;           // 与 windows.js bindScale 的 minZ 一致
const GLASS_INSET = 12;       // 与 windows.js GLASS_INSET 一致：可见玻璃 = 窗口四周去掉 12×zoom
const DEFAULT_REF = { w: 2560, h: 1330 };   // 老文件没写 ref 时的录制工作区

// 卡片窗口最小宽：唯一出处（windows.js applyMinSize 直接引用这里）
function cardMinW(baseW, minZ) {
  return Math.max(136, Math.round((baseW || 0) * (minZ || MIN_Z)));
}

function refOf(fl) { return (fl && fl.ref) || DEFAULT_REF; }
function factorOf(fl, wa) {
  const ref = refOf(fl);
  return Math.min(wa.width / ref.w, wa.height / ref.h);
}

function scaleHub(fl, wa, S) {
  if (!fl || !fl.hub) return null;
  const hw = Math.round((fl.hub.w || 420) * S), hh = Math.round((fl.hub.h || 480) * S);
  return {
    x: Math.min(Math.max(Math.round(wa.x + fl.hub.x * S), wa.x), wa.x + Math.max(0, wa.width - hw)),
    y: Math.min(Math.max(Math.round(wa.y + fl.hub.y * S), wa.y), wa.y + Math.max(0, wa.height - hh)),
    w: hw, h: hh, zoom: Math.max(MIN_Z, (fl.hub.zoom || 1) * S), open: fl.hub.open !== false,
  };
}

// 旧算法（≤6.0.12）原样保留：只给 MIGRATIONS v20 判断「存着的布局是不是旧算法原样算出来的（用户没动过）」用
function scaleFactoryV1(fl, wa, modules) {
  const S = factorOf(fl, wa);
  const cards = {};
  for (const [id, c] of Object.entries((fl && fl.cards) || {})) {
    const z = Math.max(MIN_Z, (c.zoom || 1) * S);
    let w = Math.round(c.w * S), h = Math.round(c.h * S);
    if (z > (c.zoom || 1) * S) {
      const d = (modules || []).find((m) => m.id === id);
      if (d) { w = Math.round(d.width * z); h = Math.round(d.height * z); }
    }
    cards[id] = { x: Math.round(wa.x + c.x * S), y: Math.round(wa.y + c.y * S), w, h, zoom: z, open: !!c.open };
  }
  return { hub: scaleHub(fl, wa, S), cards };
}

// 可见玻璃矩形
function visRect(c) {
  const i = GLASS_INSET * (c.zoom || 1);
  return { l: c.x + i, t: c.y + i, r: c.x + c.w - i, b: c.y + c.h - i };
}
function overlapArea(a, b) {
  const w = Math.min(a.r, b.r) - Math.max(a.l, b.l), h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
  return (w > 0 && h > 0) ? w * h : 0;
}
// 4px² 以内算贴边（取整噪声），不当重叠
const OVERLAP_EPS = 4;

// 折算后新产生的重叠：按作者摆放的相对方位，把后面那张往右/往下顺延（作者本来就叠着的不管）
function resolveOverlaps(cards, authored, wa) {
  const ids = Object.keys(cards).filter((id) => cards[id].open && authored[id]);
  const aRect = {};
  for (const id of ids) aRect[id] = visRect(authored[id]);
  const wasOverlap = (p, q) => overlapArea(aRect[p], aRect[q]) > OVERLAP_EPS;
  const S = (wa && wa._S) || 1;
  let moved = 0;
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    for (const p of ids) for (const q of ids) {
      if (p >= q) continue;
      const vp = visRect(cards[p]), vq = visRect(cards[q]);
      if (overlapArea(vp, vq) <= OVERLAP_EPS || wasOverlap(p, q)) continue;
      // 作者摆放里谁在左/谁在上：后面那张（右边或下边的）让路
      const ap = aRect[p], aq = aRect[q];
      let first = p, second = q, dir = null;
      if (ap.r <= aq.l + 2) dir = 'right';
      else if (aq.r <= ap.l + 2) { first = q; second = p; dir = 'right'; }
      else if (ap.b <= aq.t + 2) dir = 'down';
      else if (aq.b <= ap.t + 2) { first = q; second = p; dir = 'down'; }
      else continue;   // 作者摆放里既不在左右也不在上下=本来就交叠，不管
      const vf = visRect(cards[first]), vs = visRect(cards[second]);
      const af = aRect[first], as = aRect[second];
      const c = cards[second];
      if (dir === 'right') {
        const gap = Math.max(2, Math.round((as.l - af.r) * S));
        const nx = Math.round(c.x + (vf.r + gap - vs.l));
        // 往右推出屏了就改往下推（宁可换行也不出屏）
        if (wa && nx + c.w > wa.x + wa.width) {
          const gapV = 6;
          c.y = Math.round(c.y + (vf.b + gapV - vs.t));
        } else c.x = nx;
      } else {
        const gap = Math.max(2, Math.round((as.t - af.b) * S));
        const ny = Math.round(c.y + (vf.b + gap - vs.t));
        // 往下推出屏了就改往右推（小屏一整列塞不下时换到旁边去），右边也放不下才认了往下（最后夹回）
        const nx = Math.round(c.x + (vf.r + 6 - vs.l));
        if (wa && ny + c.h > wa.y + wa.height && nx + c.w <= wa.x + wa.width) c.x = nx;
        else c.y = ny;
      }
      moved++; changed = true;
    }
    if (!changed) break;
  }
  // 兜底：推完仍出屏的夹回工作区（宁可留一点交叠也不跑出屏幕外）
  if (wa) {
    for (const id of ids) {
      const c = cards[id];
      c.x = Math.min(Math.max(c.x, wa.x), wa.x + Math.max(0, wa.width - c.w));
      c.y = Math.min(Math.max(c.y, wa.y), wa.y + Math.max(0, wa.height - c.h));
    }
  }
  return moved;
}

function scaleFactory(fl, wa, modules) {
  const S = factorOf(fl, wa);
  const cards = {};
  const src = (fl && fl.cards) || {};
  for (const [id, c] of Object.entries(src)) {
    const z0 = (c.zoom || 1) * S;
    const z = Math.max(MIN_Z, z0);
    const k = z / z0;   // 撞下限时内容比等比折算的大 k 倍，作者摆的尺寸同步放大 k 倍（长宽比不变）
    let w = c.w * S * k;
    const h = c.h * S * k;
    const d = (modules || []).find((m) => m.id === id);
    if (d) w = Math.max(w, cardMinW(d.width));
    cards[id] = { x: Math.round(wa.x + c.x * S), y: Math.round(wa.y + c.y * S), w: Math.round(w), h: Math.round(h), zoom: z, open: !!c.open };
  }
  if (S < 0.999) resolveOverlaps(cards, src, Object.assign({}, wa, { _S: S }));
  return { hub: scaleHub(fl, wa, S), cards };
}

// 两份折算结果是否一致（迁移判「用户没动过」用）：坐标尺寸±1、zoom±1e-6、open 相同、卡集合相同
function sameLayout(a, b) {
  if (!a || !b || !a.cards || !b.cards) return false;
  const ka = Object.keys(a.cards).sort(), kb = Object.keys(b.cards).sort();
  if (ka.join('|') !== kb.join('|')) return false;
  const near = (p, q) => Math.abs((p || 0) - (q || 0)) <= 1;
  for (const id of ka) {
    const p = a.cards[id], q = b.cards[id];
    if (!near(p.x, q.x) || !near(p.y, q.y) || !near(p.w, q.w) || !near(p.h, q.h)) return false;
    if (Math.abs((p.zoom || 1) - (q.zoom || 1)) > 1e-6 || !!p.open !== !!q.open) return false;
  }
  return true;
}

module.exports = { scaleFactory, scaleFactoryV1, resolveOverlaps, sameLayout, cardMinW, visRect, overlapArea, MIN_Z, OVERLAP_EPS };
