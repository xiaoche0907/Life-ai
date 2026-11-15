// 批量色调统一核心回归：分割、统计、匹配、商品色保护、确定性
const core = require('../src/renderer/toneunify-core.js');

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

// 场景构造：白底 + 中央商品（可指定色调偏移）
function buildShot(W, H, shift) {
  return makeImage(W, H, (x, y) => {
    if (x > W * .3 && x < W * .7 && y > H * .25 && y < H * .8) {
      return clamp([200 + shift, 140 + shift, 120 + shift], 0, 255);   // 红棕色商品带偏移
    }
    return [250, 250, 250];
  });
  function clamp(arr, lo, hi) { return arr.map(v => Math.max(lo, Math.min(hi, v))); }
}

check('前景分割与商品统计', () => {
  const p = buildShot(400, 500, 0);
  const { seg, stats } = core.analyzeRef(p);
  assert(stats.samples > 500, '样本过少: ' + stats.samples);
  // 商品是红棕色：a、b 中位应偏高
  assert(stats.a[1] > 10, 'a 中位异常: ' + stats.a[1]);
  assert(stats.b[1] > 10, 'b 中位异常: ' + stats.b[1]);
});

check('匹配：偏色图向标准图对齐', () => {
  const ref = core.analyzeRef(buildShot(400, 500, 0));
  // 偏蓝的目标图（商品带蓝偏）
  const tgt = makeImage(400, 500, (x, y) => (x > 120 && x < 280 && y > 125 && y < 400) ? [150, 150, 210] : [250, 250, 250]);
  const r = core.applyToTarget(tgt, ref.stats, { strength: .9, lightStrength: .8 });
  // 商品中心：修复后应向红棕靠（R 分量升、B 分量降）
  const i = (260 * 400 + 200) * 4;
  assert(r.out.data[i] > 150 + 10, 'R未提升: ' + r.out.data[i]);
  assert(r.out.data[i + 2] < 210 - 10, 'B未降低: ' + r.out.data[i + 2]);
});

check('商品色保护：接近标准色的像素少动', () => {
  const ref = core.analyzeRef(buildShot(400, 500, 0));
  const p = buildShot(400, 500, 0);   // 与标准同色
  const orig = new Uint8ClampedArray(p.data);
  const r = core.applyToTarget(p, ref.stats, { strength: .9 });
  // 中心是商品标准色 → 保护 → 改动小
  const i = (260 * 400 + 200) * 4;
  const diff = Math.abs(r.out.data[i] - orig[i]) + Math.abs(r.out.data[i + 2] - orig[i + 2]);
  assert(diff < 25, '标准色被大幅改动: ' + diff);
});

check('背景不受影响', () => {
  const ref = core.analyzeRef(buildShot(400, 500, 0));
  const tgt = makeImage(400, 500, (x, y) => (x > 120 && x < 280 && y > 125 && y < 400) ? [150, 150, 210] : [250, 250, 250]);
  const r = core.applyToTarget(tgt, ref.stats, { strength: .9 });
  const i = (50 * 400 + 50) * 4;   // 背景
  assert(r.out.data[i] === 250 && r.out.data[i + 1] === 250, '背景被改动: ' + r.out.data[i]);
});

check('强度0：基本不动', () => {
  const ref = core.analyzeRef(buildShot(400, 500, 0));
  const p = makeImage(400, 500, (x, y) => (x > 120 && x < 280 && y > 125 && y < 400) ? [150, 150, 210] : [250, 250, 250]);
  const orig = new Uint8ClampedArray(p.data);
  const r = core.applyToTarget(p, ref.stats, { strength: 0, lightStrength: 0 });
  let diff = 0;
  for (let i = 0; i < orig.length; i += 4) if (Math.abs(r.out.data[i] - orig[i]) > 3) diff++;
  assert(diff < 2000, '强度0仍大量改动: ' + diff);
});

check('确定性：同输入两次一致', () => {
  const ref = core.analyzeRef(buildShot(400, 500, 0));
  const p = buildShot(400, 500, 15);
  const a1 = core.applyToTarget(p, ref.stats, { strength: .8 }), a2 = core.applyToTarget(p, ref.stats, { strength: .8 });
  for (let i = 0; i < a1.out.data.length; i++) if (a1.out.data[i] !== a2.out.data[i]) throw Error('不确定@' + i);
});

process.exit(failures ? 1 : 0);
