// 去油光核心回归：检测、压制、镜面保护、纹理保留、确定性
const core = require('../src/renderer/shineremove-core.js');

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

check('油光检测与压制：亮斑显著压暗', () => {
  // 中灰底 + 额头区域高亮油光斑
  const p = makeImage(200, 200, (x, y) => {
    if (x > 70 && x < 130 && y > 60 && y < 110) return [230, 215, 205];   // 油光斑（比底亮）
    return [150, 140, 135];
  });
  const origBright = (230 + 215 + 205) / 3;
  const r = core.removeShine(p, { sensitivity: .6, strength: .8 });
  const i = (85 * 200 + 100) * 4;
  const newBright = (r.data[i] + r.data[i + 1] + r.data[i + 2]) / 3;
  assert(newBright < origBright - 15, '油光未压暗: ' + Math.round(newBright) + ' vs ' + origBright);
  // 底部正常区基本不动
  const j = (180 * 200 + 20) * 4;
  const bgBright = (r.data[j] + r.data[j + 1] + r.data[j + 2]) / 3;
  assert(Math.abs(bgBright - 141.7) < 6, '正常区被误压: ' + bgBright);
  assert(r.touched > 500, '处理像素过少: ' + r.touched);
});

check('strength=0：完全不动', () => {
  const p = makeImage(100, 100, (x, y) => (x > 30 && x < 70 && y > 30 && y < 70) ? [240, 230, 220] : [150, 145, 140]);
  const orig = new Uint8ClampedArray(p.data);
  const r = core.removeShine(p, { strength: 0 });
  for (let i = 0; i < orig.length; i += 4) {
    if (r.data[i] !== orig[i]) throw Error('strength=0仍改动@' + i);
  }
});

check('镜面保护：极亮反射不动', () => {
  const p = makeImage(150, 150, (x, y) => {
    if (x > 50 && x < 100 && y > 50 && y < 100) return [253, 252, 250];   // 镜面高光
    return [140, 135, 130];
  });
  const r = core.removeShine(p, { sensitivity: .9, strength: 1, protectSpecular: true });
  const i = (75 * 150 + 75) * 4;
  assert(r.data[i] >= 250, '镜面高光被压制: ' + r.data[i]);
  // 关闭保护时会被压
  const r2 = core.removeShine(p, { sensitivity: .9, strength: 1, protectSpecular: false });
  assert(r2.data[i] < 250, '关闭保护应压制: ' + r2.data[i]);
});

check('纹理保留：textureKeep=1保留更多细节', () => {
  // 油光斑上叠加纹理（正弦明暗）
  const p = makeImage(160, 160, (x, y) => {
    if (x > 50 && x < 110 && y > 50 && y < 110) {
      const v = 225 + Math.round(8 * Math.sin(x / 4));
      return [v, v - 8, v - 15];
    }
    return [145, 140, 135];
  });
  const keepLow = core.removeShine(p, { sensitivity: .7, strength: .9, textureKeep: .1 });
  const keepHigh = core.removeShine(p, { sensitivity: .7, strength: .9, textureKeep: .95 });
  // 高保留版的斑内方差应更大（细节更多）
  function varianceIn(img) {
    let s = 0, s2 = 0, n = 0;
    for (let y = 60; y < 100; y++) for (let x = 60; x < 100; x++) {
      const i = (y * 160 + x) * 4;
      const b = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / 3;
      s += b; s2 += b * b; n++;
    }
    return Math.sqrt(s2 / n - (s / n) * (s / n));
  }
  const vLow = varianceIn(keepLow), vHigh = varianceIn(keepHigh);
  assert(vHigh > vLow * 1.5, '高纹理保留未体现: ' + vHigh.toFixed(1) + ' vs ' + vLow.toFixed(1));
});

check('亮度不变色相：压制是等比例缩放', () => {
  const p = makeImage(120, 120, (x, y) => (x > 40 && x < 80 && y > 40 && y < 80) ? [235, 200, 170] : [150, 145, 140]);
  const r = core.removeShine(p, { sensitivity: .6, strength: .7, textureKeep: 0 });
  const i = (60 * 120 + 60) * 4;
  const ratioBefore = p.data[i] / Math.max(1, p.data[i + 2]);
  const ratioAfter = r.data[i] / Math.max(1, r.data[i + 2]);
  assert(Math.abs(ratioBefore - ratioAfter) < .05, '色相偏移: ' + ratioAfter + ' vs ' + ratioBefore);
});

check('确定性：同输入两次一致', () => {
  const p = makeImage(120, 120, (x, y) => (x > 40 && x < 80 && y > 40 && y < 80) ? [230, 220, 210] : [150, 145, 140]);
  const a1 = core.removeShine(p, { sensitivity: .6, strength: .8 });
  const a2 = core.removeShine(p, { sensitivity: .6, strength: .8 });
  for (let i = 0; i < a1.data.length; i++) if (a1.data[i] !== a2.data[i]) throw Error('不确定@' + i);
});

process.exit(failures ? 1 : 0);
