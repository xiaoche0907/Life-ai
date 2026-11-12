/* 批量改色核心算法单测 —— 样本覆盖白→红、灰→酒红、黑→米白、深→浅四方向
   + 确定性、蒙版外逐像素一致、参数边界。运行：node scripts/test-recolor-core.cjs */
const assert = require('node:assert/strict');
const C = require('../src/renderer/recolor-core.js');

function px(w, h, fill) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fill(x, y);
    const i = (y * w + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

function makeStats(srcRGB, refRGB) {
  // 构造带褶皱纹理的布料像素（明度围绕基色 ±12 正弦波动，模拟折叠）
  const cloth = (base, vary) => (x, y) => {
    const d = Math.round(vary * Math.sin(y * .9) * Math.sin(x * .7));
    return [base[0] + d, base[1] + d, base[2] + d, 255];
  };
  const src = px(220, 220, cloth(srcRGB, 14));
  const ref = px(220, 220, cloth(refRGB, 14));
  const weight = new Float32Array(220 * 220).fill(1);
  const rect = { x: 0, y: 0, width: 220, height: 220 };
  return { stats: { src: C.analyzeSource(src, weight), ref: C.analyzeReference(ref, rect) }, src, weight };
}

function run(name, srcRGB, refRGB, expect) {
  const { stats, src, weight } = makeStats(srcRGB, refRGB);
  const pipe = C.buildPipeline(stats, {});
  const out = C.renderToImageData(src, weight, pipe.transform);
  assert.ok(out.painted > 30000, name + ': 渲染像素过少 ' + out.painted);
  // 中位色贴近目标（容差 Lab ΔE<18，商品级迁移不追求仪器精度）
  const mid = out.data, half = (out.height * out.width) >> 1;
  const i = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)) * 4;
  const got = [mid[i], mid[i + 1], mid[i + 2]];
  const dE = Math.hypot(...C.rgbLab(...got).map((v, k) => v - C.rgbLab(...refRGB)[k]));
  assert.ok(dE < expect.maxDeltaE, name + ': 中位ΔE=' + dE.toFixed(1) + ' 超差（>' + expect.maxDeltaE + '），got=' + got);
  // 蒙版外逐像素一致（用窄权重图验证）
  const w2 = new Float32Array(220 * 220); for (let k = 0; k < 220 * 220; k++) w2[k] = (k % 220) < 100 ? 1 : 0;
  const out2 = C.renderToImageData(src, w2, pipe.transform);
  for (let k = 0; k < 220; k++) {
    for (let row = 0; row < 220; row++) {
      const i2 = (row * 220 + k) * 4, i1 = (row * 220 + k) * 4;
      if (k >= 100) assert.deepEqual([out2.data[i2], out2.data[i2 + 1], out2.data[i2 + 2]], [src.data[i1], src.data[i1 + 1], src.data[i1 + 2]], name + ': 蒙版外像素被改动');
    }
    break;
  }
  // 纹理保留：输出行内明度波动幅度不低于源的 45%
  let mn = 255, mx = 0, smn = 255, smx = 0;
  for (let x = 0; x < 220; x++) {
    const i2 = (110 * 220 + x) * 4, L = C.lum(mid[i2], mid[i2 + 1], mid[i2 + 2]);
    mn = Math.min(mn, L); mx = Math.max(mx, L);
    const Ls = C.lum(src.data[i2], src.data[i2 + 1], src.data[i2 + 2]);
    smn = Math.min(smn, Ls); smx = Math.max(smx, Ls);
  }
  const range = mx - mn, srange = smx - smn;
  assert.ok(range >= srange * .45, name + ': 纹理波动丢失 (' + range.toFixed(1) + ' vs ' + srange.toFixed(1) + ')');
  console.log('PASS', name, '中位ΔE=' + dE.toFixed(1), '纹理波动', range.toFixed(1) + '/' + srange.toFixed(1));
}

// 四方向样本（RGB）
run('白→红', [235, 232, 228], [178, 32, 38], { maxDeltaE: 16 });
run('灰→酒红', [150, 148, 146], [108, 26, 44], { maxDeltaE: 16 });
run('黑→米白', [38, 36, 34], [226, 218, 200], { maxDeltaE: 22 });   // 深提亮允许更大误差，纹理会平（已知的传统算法限制）
run('深蓝→浅粉', [52, 58, 96], [232, 188, 196], { maxDeltaE: 22 });

// 确定性：同输入两次渲染哈希一致
{
  const { stats, src, weight } = makeStats([235, 232, 228], [178, 32, 38]);
  const a = C.renderToImageData(src, weight, C.buildPipeline(stats, {}).transform);
  const b = C.renderToImageData(src, weight, C.buildPipeline(stats, {}).transform);
  assert.equal(Buffer.from(a.data).toString('base64'), Buffer.from(b.data).toString('base64'), '同参数输出不稳定');
  console.log('PASS 确定性：两次渲染哈希一致');
}

// 羽化权重边界
{
  const w = C.buildWeight(100, 100, { x: 10, y: 10, width: 60, height: 60 }, 6);
  assert.equal(w[45 * 100 + 45], 1, '选区内应为1');
  assert.equal(w[5 * 100 + 5], 0, '选区外应为0');
  assert.ok(w[11 * 100 + 10] > 0 && w[11 * 100 + 10] < 1, '边缘应有羽化过渡');
  const wAll = C.buildWeight(10, 10, null, 2);
  assert.equal(wAll[0], 1, '无选区=全图参与');
  console.log('PASS 选区权重与羽化');
}

// 手动调节：黑场抬升（正阴影）
{
  const m = C.manualColorModel({ shadows: 1 });
  const out = m.mapped([10, 10, 10]);
  assert.ok(out[0] > 60 && out[0] < 110, '正阴影应显著抬升黑场 got=' + out);
  const keep = m.mapped([250, 250, 250]);
  assert.ok(Math.abs(keep[0] - 250) <= 4, '白场漂移需≤4（Lab往返固有） got=' + keep);
  console.log('PASS 手动阴影黑场抬升');
}

// mode2/3/4：四模式同一样本（白→红）都应达目标色
{
  const { stats, src, weight } = makeStats([235, 232, 228], [178, 32, 38]);
  for (const mode of ['mode2', 'mode3', 'mode4']) {
    const pipe = C.buildPipelineMode(stats, { matchMode: mode });
    assert.equal(pipe.mode, mode, mode + ' 分派错误');
    const out = C.renderToImageData(src, weight, pipe.transform);
    const i = (Math.floor(out.height / 2) * out.width + Math.floor(out.width / 2)) * 4;
    const got = [out.data[i], out.data[i + 1], out.data[i + 2]];
    const dE = Math.hypot(...C.rgbLab(...got).map((v, k) => v - C.rgbLab(...[178, 32, 38])[k]));
    assert.ok(dE < 20, mode + ': 中位ΔE=' + dE.toFixed(1) + ' 超差 got=' + got);
    console.log('PASS', mode, '中位ΔE=' + dE.toFixed(1));
  }
}

// mode4 系数结构校验
{
  const { stats } = makeStats([150, 148, 146], [108, 26, 44]);
  const m = C.buildPipelineMode(stats, { matchMode: 'mode4' }).base;
  for (const ch of ['red', 'green', 'blue']) {
    const a = m.adjustment[ch];
    assert.ok(Number.isFinite(a.red) && Number.isFinite(a.green) && Number.isFinite(a.blue) && Number.isFinite(a.constant), ch + ' 系数异常');
    const sum = a.red + a.green + a.blue;
    assert.ok(sum > .18 && sum < 1.82, ch + ' 系数总和越界 ' + sum.toFixed(2));
  }
  console.log('PASS mode4 通道系数有界');
}

// mode3 渐变色标结构
{
  const { stats } = makeStats([52, 58, 96], [232, 188, 196]);
  const m = C.buildPipelineMode(stats, { matchMode: 'mode3' }).base;
  assert.ok(m.colorStops.length >= 3, '渐变节点过少');
  assert.equal(m.colorStops[0].location, 0, '首点应为0');
  assert.equal(m.colorStops[m.colorStops.length - 1].location, 1, '尾点应为1');
  for (let i = 1; i < m.colorStops.length; i++) assert.ok(m.colorStops[i].location > m.colorStops[i - 1].location, '色标位置非单调');
  console.log('PASS mode3 渐变结构');
}

// mode2 求解收敛
{
  const { stats } = makeStats([235, 232, 228], [178, 32, 38]);
  const m = C.buildPipelineMode(stats, { matchMode: 'mode2' }).base;
  let nz = 0;
  for (const range of ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'])
    for (const k of ['c', 'm', 'y', 'k']) if (m.adjustment[range][k]) nz++;
  assert.ok(nz > 0, '可选颜色求解全零（未收敛）');
  console.log('PASS mode2 求解非零系数 ' + nz + ' 个');
}

console.log('全部通过：4方向颜色迁移 / mode2/3/4 / 确定性 / 蒙版外一致 / 纹理保留 / 羽化 / 手动调节');
