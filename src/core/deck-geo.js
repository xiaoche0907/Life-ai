// 堆牌几何（纯函数、无 electron 依赖）：从布局快照里各卡的落位反推"哪些卡当时是叠着的"
// 为什么要反推：v5.18.43 之前存的布局只记单卡，不记堆。0912 用户裁定"布局要记住我的堆"，但老布局究竟有没有堆，
// 只能看它自己存的卡位置——拿屏幕上此刻的堆当依据（v5.18.45）会把没叠牌的布局也污染成叠牌（用户实报）。
// 堆的落位是 deckTargets 定的：前卡在锚位，后面每张与前卡窗口 x 相同（都按前卡缩放算边距），
// 顶边比前一张高出 deckStripGap(zf)=max(40, 24·zf)；存布局时若正悬停抽出，那张再高 nudge=max(0, 48·zf−gap)。
// 快照里记的是各卡"散开尺寸"和自己的缩放，但位置是叠着时的——所以只用位置判定，zf 取前卡自己的缩放（它当时没借别人的）。
const GLASS_INSET = 12, DECK_STRIP = 24, DECK_STRIP_FULL = 48, DECK_STRIP_MIN = 40;
const stripGap = (z) => Math.max(DECK_STRIP_MIN, DECK_STRIP * z);
const nudgeOf = (z) => Math.max(0, DECK_STRIP_FULL * z - stripGap(z));
const TOL = 3;

// 后一张相对前一张是否处在"被压"位置（同 x、上方一条的距离）
function behindOk(prev, next, zf) {
  if (!prev || !next) return false;
  if (Math.abs((next.x | 0) - (prev.x | 0)) > 1) return false;
  const dy = prev.y - next.y, gap = stripGap(zf);
  return Math.abs(dy - gap) <= TOL || Math.abs(dy - gap - nudgeOf(zf)) <= TOL;
}
// 一条已记录的堆（order/members）与快照里各卡位置是否自洽：全员在且逐张满足被压位置 → 真堆；否则=拿屏幕现堆写进去的污染
function stackGeomOk(sv, cards) {
  const order = ((Array.isArray(sv.order) && sv.order.length) ? sv.order : (sv.members || []));
  if (order.length < 2) return false;
  const cs = order.map((id) => cards && cards[id]);
  if (cs.some((c) => !c || !Number.isFinite(c.x) || !Number.isFinite(c.y))) return false;
  const zf = Number(cs[0].zoom) > 0 ? Number(cs[0].zoom) : 1;
  for (let k = 1; k < cs.length; k++) if (!behindOk(cs[k - 1], cs[k], zf)) return false;
  return true;
}
// 从快照 cards 反推堆：按 y 从大到小挑前卡（前卡在最下方），沿"同 x、上方一条"往上串，串到 ≥2 张就是一堆
function inferStacks(cards) {
  const list = Object.entries(cards || {})
    .filter(([, c]) => c && c.open !== false && Number.isFinite(c.x) && Number.isFinite(c.y))
    .map(([id, c]) => ({ id, x: c.x, y: c.y, zoom: Number(c.zoom) > 0 ? Number(c.zoom) : 1 }))
    .sort((a, b) => b.y - a.y);
  const used = new Set();
  const out = [];
  for (const f of list) {
    if (used.has(f.id)) continue;
    const chain = [f];
    let cur = f;
    for (;;) {
      const nx = list.find((c) => !used.has(c.id) && !chain.includes(c) && behindOk(cur, c, f.zoom));
      if (!nx) break;
      chain.push(nx); cur = nx;
    }
    if (chain.length < 2) continue;
    for (const c of chain) used.add(c.id);
    const order = chain.map((c) => c.id);
    out.push({ members: order.slice(), order, active: order[0], anchor: null, hidden: false });
  }
  return out;
}
module.exports = { inferStacks, stackGeomOk, behindOk, stripGap, nudgeOf, GLASS_INSET };
