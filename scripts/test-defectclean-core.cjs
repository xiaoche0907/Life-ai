// 瑕疵清理核心回归：检测、修复、商品保护、确定性
const core = require('../src/renderer/defectclean-core.js');

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

check('亮瑕疵（灰尘点）：检出并修复', () => {
  // 均匀灰底 + 几个亮点灰尘
  const p = makeImage(200, 200, (x, y) => {
    if ((x === 50 && y === 50) || (x === 120 && y === 80) || (x === 90 && y === 150)) return [250, 250, 250];
    return [120, 120, 120];
  });
  const r = core.clean(p, { sensitivity: .5 });
  assert(r.defectPixels > 0, '未检出瑕疵: ' + r.defectPixels);
  // 修复后亮点应被填成接近底色
  const i = (50 * 200 + 50) * 4;
  const v = (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
  assert(v < 200, '亮点未修复: ' + Math.round(v));
});

check('暗瑕疵（污点）：检出并修复', () => {
  const p = makeImage(200, 200, (x, y) => {
    if (x > 95 && x < 105 && y > 95 && y < 105) return [20, 20, 20];   // 暗污点
    return [200, 200, 200];
  });
  const r = core.clean(p, { sensitivity: .5 });
  assert(r.defectPixels > 0, '未检出暗瑕疵');
  const i = (100 * 200 + 100) * 4;
  const v = (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
  assert(v > 120, '暗污点未修复: ' + Math.round(v));
});

check('平滑渐变背景：无误检', () => {
  const p = makeImage(200, 200, (x) => [200 + Math.round(30 * x / 200), 200, 200]);
  const r = core.clean(p, { sensitivity: .5 });
  assert(r.defectPixels < 200, '渐变背景误检过多: ' + r.defectPixels);
});

check('修复后与周边过渡自然（无明显接缝）', () => {
  const p = makeImage(150, 150, (x, y) => {
    if (x > 70 && x < 80 && y > 70 && y < 80) return [255, 255, 255];
    return [130, 130, 130];
  });
  const r = core.clean(p, { sensitivity: .5 });
  // 瑕疵中心修复值应接近底色（周围全是130）
  const i = (75 * 150 + 75) * 4;
  const v = (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
  assert(Math.abs(v - 130) < 25, '修复值偏离底色: ' + Math.round(v));
});

check('确定性：同输入两次一致', () => {
  const p = makeImage(120, 120, (x, y) => {
    if ((x * 7 + y * 11) % 97 === 0) return [240, 240, 240];
    return [125, 125, 125];
  });
  const a1 = core.clean(p, { sensitivity: .5 }), a2 = core.clean(p, { sensitivity: .5 });
  for (let i = 0; i < a1.data.length; i++) if (a1.data[i] !== a2.data[i]) throw Error('不确定@' + i);
});

process.exit(failures ? 1 : 0);
