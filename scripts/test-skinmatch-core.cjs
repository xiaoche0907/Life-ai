// 肤色统一核心回归：分割、统计、匹配模型、预览、确定性
const core = require('../src/renderer/skinmatch-core.js');

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

// 典型肤色 RGB
const SKIN = [222, 184, 158], SKIN_DARK = [190, 140, 120], RED_BG = [200, 40, 40];

check('皮肤规则命中典型肤色', () => {
  assert(core.skinProbability(...SKIN) > .8, '典型肤色概率不足');
  assert(core.skinProbability(...RED_BG) === 0, '红背景被误判为皮肤');
  assert(core.skinProbability(20, 20, 25) === 0, '近黑被误判');
});

check('分割：肤色块保留、噪点清除', () => {
  const p = makeImage(200, 200, (x, y) => (x > 40 && x < 160 && y > 40 && y < 160) ? SKIN : RED_BG);
  const seg = core.segmentSkin(p);
  assert(seg.keptDomains >= 1, '未找到保留域');
  assert(seg.coverage > .2 && seg.coverage < .8, '覆盖率异常：' + seg.coverage.toFixed(2));
  const m = core.upsampleMask(seg, 200, 200);
  assert(m[(100 * 200 + 100)] > 200, '中心蒙版应高权重');
  assert(m[(10 * 200 + 10)] === 0, '角落不应为皮肤');
});

check('分割：置信度指标有效', () => {
  const p = makeImage(120, 120, (x, y) => y < 60 ? SKIN : RED_BG);
  const seg = core.segmentSkin(p);
  assert(seg.confidence > 0 && seg.confidence <= 1, '置信度范围错误');
  assert(seg.domains >= seg.keptDomains, '域计数不一致');
});

check('skinStats：分位数输出有效', () => {
  const p = makeImage(100, 100, () => SKIN);
  const w = new Uint8Array(100 * 100).fill(255);
  const s = core.skinStats(p, w);
  assert(s.samples >= 64, '样本数不足');
  assert(s.L[0] <= s.L[2] && s.L[2] <= s.L[4], 'L 分位未排序');
  assert(s.a[1] > 5 && s.a[1] < 40, '肤色 a 中位异常：' + s.a[1]);
  assert(s.b[1] > 5 && s.b[1] < 45, '肤色 b 中位异常：' + s.b[1]);
});

check('fitSkinModel：向目标分布迁移', () => {
  const src = { L: [50, 58, 65, 72, 80], a: [12, 18, 24, 28, 34], b: [14, 20, 26, 30, 38] };
  const ref = { L: [55, 63, 70, 78, 86], a: [14, 21, 27, 32, 38], b: [16, 23, 30, 35, 42] };
  const model = core.fitSkinModel(src, ref, { colorStrength: .8, lightStrength: .7 });
  const midOut = model.lMap(65);
  assert(midOut > 65 && midOut < 80, 'L 中位迁移不足：' + midOut.toFixed(1));
  const aOut = model.aMap(24);
  assert(aOut > 24 && aOut < 27, 'a 中位迁移异常：' + aOut.toFixed(1));
  assert(model.method === 'skin-quantile-soft', '方法标记错误');
});

check('fitSkinModel：hueOnly 不改亮度', () => {
  const src = { L: [50, 58, 65, 72, 80], a: [12, 18, 24, 28, 34], b: [14, 20, 26, 30, 38] };
  const ref = { L: [70, 80, 88, 95, 99], a: [14, 21, 27, 32, 38], b: [16, 23, 30, 35, 42] };
  const model = core.fitSkinModel(src, ref, { hueOnly: true });
  assert(Math.abs(model.lMap(65) - 65) < .01, 'hueOnly 应保持 L 不变');
});

check('renderToImageData：权重混合预览', () => {
  const p = makeImage(4, 1, () => SKIN);
  const w = new Uint8Array([255, 255, 128, 0]);
  const src = { L: [50, 58, 65, 72, 80], a: [12, 18, 24, 28, 34], b: [14, 20, 26, 30, 38] };
  const ref = { L: [60, 68, 75, 82, 90], a: [14, 21, 27, 32, 38], b: [16, 23, 30, 35, 42] };
  const model = core.fitSkinModel(src, ref, { colorStrength: 1, lightStrength: 1 });
  const out = core.renderToImageData(p, w, model);
  const bright0 = out.data[0] + out.data[1] + out.data[2];
  const bright3 = out.data[12] + out.data[13] + out.data[14];
  assert(bright0 > bright3, '高权重处应更接近目标');
  assert(Math.abs(bright3 - 564) < 3, '零权重处应保持原样（SKIN 亮度总和 564）');
});

check('确定性：同输入两次结果一致', () => {
  const p = makeImage(80, 80, (x, y) => (x + y) % 7 === 0 ? SKIN_DARK : SKIN);
  const a1 = core.segmentSkin(p), a2 = core.segmentSkin(p);
  for (let i = 0; i < a1.probSmall.length; i++) assert(a1.probSmall[i] === a2.probSmall[i], '分割不确定');
  const w = new Uint8Array(80 * 80).fill(255);
  const s1 = core.skinStats(p, w), s2 = core.skinStats(p, w);
  assert(JSON.stringify(s1) === JSON.stringify(s2), '统计不确定');
});

process.exit(failures ? 1 : 0);
