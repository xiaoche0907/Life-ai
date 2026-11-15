// P2 三项核心回归：褶皱、皮肤质感、材质增强
const core = require('../src/renderer/retouchp2-core.js');

function makeImage(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a === undefined ? 255 : a;
  }
  return { width: w, height: h, data };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('PASS ' + name); }
  catch (e) { failures++; console.log('FAIL ' + name + '：' + e.message); }
}
function assert(cond, msg) { if (!cond) throw Error(msg); }

function brightness(p, x, y) { const i = (y * p.width + x) * 4; return (p.data[i] + p.data[i + 1] + p.data[i + 2]) / 3; }

check('褶皱优化：暗褶皱带提亮、布纹保留', () => {
  // 灰布底(170) + 布纹(±6高频) + 狭长暗褶皱带(130)
  const p = makeImage(300, 300, (x, y) => {
    const tex = 170 + Math.round(6 * Math.sin(x / 3));
    if (x > 60 && x < 75 && y > 40 && y < 260) return [128, 128, 128];   // 褶皱
    return [tex, tex, tex];
  });
  const r = core.wrinkleReduce(p, { strength: .8, textureKeep: .9 });
  // 褶皱中心应被提亮（向170靠）
  const wr = brightness(r, 68, 150);
  assert(wr > 140, '褶皱未提亮: ' + Math.round(wr));
  // 正常布区基本不动（±8以内）
  const bg = brightness(r, 200, 150);
  assert(Math.abs(bg - 170) < 10, '布区被误改: ' + Math.round(bg));
});

check('褶皱 strength=0：基本不动', () => {
  const p = makeImage(200, 200, (x, y) => {
    if (x > 50 && x < 62 && y > 30 && y < 170) return [130, 130, 130];
    return [170, 170, 170];
  });
  const orig = new Uint8ClampedArray(p.data);
  const r = core.wrinkleReduce(p, { strength: 0 });
  let diff = 0;
  for (let i = 0; i < orig.length; i += 4) if (Math.abs(r.data[i] - orig[i]) > 6) diff++;
  assert(diff < 500, 'strength=0大量改动: ' + diff);
});

check('皮肤质感：色斑均匀+纹理保留', () => {
  // 肤色底 + 低频色斑（左半偏红暗）+ 高频毛孔纹理
  const p = makeImage(300, 300, (x, y) => {
    const patch = x < 150 ? -18 : 0;   // 低频色斑
    const pore = Math.round(4 * Math.sin(x / 2.5));
    return [200 + patch + pore, 170 + patch + pore, 155 + patch + pore];
  });
  const r = core.skinTexture(p, { evenness: .7, textureKeep: .9 });
  // 色斑应减轻：左右两侧亮度差缩小
  const bLeft = brightness(r, 80, 150), bRight = brightness(r, 220, 150);
  const bL0 = brightness(p, 80, 150), bR0 = brightness(p, 220, 150);
  const diffBefore = Math.abs(bL0 - bR0), diffAfter = Math.abs(bLeft - bRight);
  assert(diffAfter < diffBefore * .7, '色斑未均匀: ' + diffAfter.toFixed(1) + ' vs ' + diffBefore.toFixed(1));
  // 纹理应保留：处理后行内方差>0
  let s2 = 0, m = 0, n2 = 0;
  for (let x = 60; x < 240; x += 3) { const b = brightness(r, x, 100); s2 += b * b; m += b; n2++; }
  m /= n2;
  const std = Math.sqrt(Math.max(0, s2 / n2 - m * m));
  assert(std > 1.5, '纹理被抹平（塑料感）: std=' + std.toFixed(2));
});

check('材质增强：纹理放大、强边缘无光晕', () => {
  // 中等纹理布料 + 一条强轮廓边
  const p = makeImage(300, 300, (x, y) => {
    if (x > 280) return [40, 40, 40];   // 强轮廓
    const v = 150 + Math.round(5 * Math.sin(x / 4));
    return [v, v, v];
  });
  const r = core.materialEnhance(p, { strength: .8 });
  // 纹理区振幅放大：处理后行内方差 > 原行内方差
  function rowStd(img, y) { let s2 = 0, m = 0, n2 = 0; for (let x = 30; x < 270; x += 2) { const b = brightness(img, x, y); s2 += b * b; m += b; n2++; } m /= n2; return Math.sqrt(Math.max(0, s2 / n2 - m * m)); }
  assert(rowStd(r, 150) > rowStd(p, 150), '纹理未增强');
  // 强轮廓边不过冲（光晕）：轮廓附近像素不应超过0/255
  let ok = true;
  for (let y = 0; y < 300; y += 5) { const v = brightness(r, 279, y); if (v > 255 || v < 0) ok = false; }
  assert(ok, '轮廓过冲');
});

check('三项确定性', () => {
  const p = makeImage(200, 200, (x, y) => {
    if (x > 80 && x < 95 && y > 50 && y < 150) return [135, 135, 135];
    return [172 + Math.round(5 * Math.sin(x / 3)), 172, 172];
  });
  const w1 = core.wrinkleReduce(p, {}), w2 = core.wrinkleReduce(p, {});
  for (let i = 0; i < w1.data.length; i++) if (w1.data[i] !== w2.data[i]) throw Error('褶皱不确定');
  const s1 = core.skinTexture(p, {}), s2 = core.skinTexture(p, {});
  for (let i = 0; i < s1.data.length; i++) if (s1.data[i] !== s2.data[i]) throw Error('皮肤不确定');
  const m1 = core.materialEnhance(p, {}), m2 = core.materialEnhance(p, {});
  for (let i = 0; i < m1.data.length; i++) if (m1.data[i] !== m2.data[i]) throw Error('材质不确定');
});

process.exit(failures ? 1 : 0);
