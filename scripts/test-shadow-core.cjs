// 智能阴影核心回归：接触阴影、方向投影、商品保护、确定性
const core = require('../src/renderer/shadow-core.js');

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

function buildScene(W, H) {
  // 白底 + 中央方形商品（底边 y=H*0.7）
  return makeImage(W, H, (x, y) => (x > W * .3 && x < W * .7 && y > H * .3 && y < H * .7) ? [90, 90, 100] : [250, 250, 250]);
}

check('接触阴影：商品底部下方生成衰减暗带', () => {
  const p = buildScene(400, 500);
  const r = core.generate(p, { type: 'contact', opacity: .5, length: .08 });
  // 商品底边 y=350，阴影应在其下方 y≈352-382 有 alpha
  const hasAlpha = (y, x) => r.data[(y * 400 + x) * 4 + 3];
  assert(hasAlpha(365, 200) > 40, '接触带无阴影: ' + hasAlpha(365, 200));
  // 阴影峰值应在靠近底边处
  assert(hasAlpha(360, 200) >= hasAlpha(380, 200), '衰减方向错误');
  // 商品内部（y=300）不应有阴影alpha（商品保护：接触带只画商品下沿外）
  assert(hasAlpha(300, 200) === 0 || hasAlpha(300, 200) < 30, '商品内部出现阴影');
});

check('方向投影：偏移方向正确', () => {
  const p = buildScene(400, 500);
  const r = core.generate(p, { type: 'direction', direction: 90, opacity: .5, length: .1, blur: .3 });
  // 光源方向90°(向下偏移) → 阴影在商品下方
  const hasAlpha = (y, x) => r.data[(y * 400 + x) * 4 + 3];
  assert(hasAlpha(380, 200) > 30, '下方无投影: ' + hasAlpha(380, 200));
  assert(hasAlpha(250, 200) < 20, '商品上方不该有投影');
});

check('商品保护：alpha场不覆盖商品中心', () => {
  const p = buildScene(400, 500);
  const r = core.generate(p, { type: 'both', opacity: .6 });
  // 商品中心 (200,250)
  const a = r.data[(250 * 400 + 200) * 4 + 3];
  assert(a < 60, '商品中心阴影alpha过高: ' + a);
});

check('opacity=0：无阴影', () => {
  const p = buildScene(400, 500);
  const r = core.generate(p, { type: 'both', opacity: 0 });
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] > 0) throw Error('opacity=0仍有阴影@' + i);
});

check('确定性：同输入两次一致', () => {
  const p = buildScene(300, 380);
  const a1 = core.generate(p, { type: 'both' }), a2 = core.generate(p, { type: 'both' });
  for (let i = 0; i < a1.data.length; i++) if (a1.data[i] !== a2.data[i]) throw Error('不确定@' + i);
});

process.exit(failures ? 1 : 0);
