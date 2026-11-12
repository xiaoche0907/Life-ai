/* 批量改色核心 —— 移植自「衣色 v0.23」colormatch-core（REA 逆向取证 rea-work/colormatch-core.pretty.js）。
   纯函数、零依赖、无随机无时间依赖：同输入必同输出。
   与原版差异（架构层，算法逐行对应）：
   - 蒙版来源：PSD maskWeight → PS 选区权重图（bbox + smoothstep 羽化）
   - 输出：可编辑PSD调整层 → 调色后 PNG 贴回 PS 图层（fitMode mode1 同款像素结果）
   - 不移植：ag-psd 读写 / mode2-4（其为 PSD 原生调整层拟合服务）/ 导出内存预算 */
(function (root) {
  'use strict';

  const clamp = (v, a = 0, b = 255) => Math.max(a, Math.min(b, v));
  const lum = (r, g, b) => .30 * r + .59 * g + .11 * b;
  const lin = v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
  const srgb = v => 255 * (v <= .0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - .055);

  function rgbLab(r, g, b) {
    r = lin(r); g = lin(g); b = lin(b);
    const f = v => v > .00885645168 ? Math.cbrt(v) : 7.787037 * v + 16 / 116;
    const x = f((.4124564 * r + .3575761 * g + .1804375 * b) / .95047),
      y = f(.2126729 * r + .7151522 * g + .072175 * b),
      z = f((.0193339 * r + .119192 * g + .9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  function labRgb(L, a, b) {
    const fy = (L + 16) / 116, inv = t => t > .2068965517 ? t * t * t : (t - 16 / 116) / 7.787037;
    function convert(scale) {
      const x = .95047 * inv(fy + a * scale / 500), y = inv(fy), z = 1.08883 * inv(fy - b * scale / 200);
      return [3.2404542 * x - 1.5371385 * y - .4985314 * z, -.969266 * x + 1.8760108 * y + .041556 * z, .0556434 * x - .2040259 * y + 1.0572252 * z];
    }
    let c = convert(1);
    if (c.some(v => v < -.00005 || v > 1.00005)) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 9; i++) {
        const mid = (lo + hi) / 2, tryC = convert(mid);
        if (tryC.every(v => v >= 0 && v <= 1)) lo = mid; else hi = mid;
      }
      c = convert(lo);
    }
    return c.map(v => Math.round(clamp(srgb(clamp(v, 0, 1)), 0, 255)));
  }

  function setLum(rgb, L) {
    let c = rgb.map(v => v + L - lum(...rgb)), mn = Math.min(...c), mx = Math.max(...c);
    if (mn < 0) {
      const den = L - mn;
      c = c.map(v => den > 0 ? L + (v - L) * L / den : L);
    }
    mx = Math.max(...c);
    if (mx > 255) {
      const den = mx - L;
      c = c.map(v => den > 0 ? L + (v - L) * (255 - L) / den : L);
    }
    return c.map(v => clamp(v));
  }

  function curveLUT(points) {
    const n = points.length, x = points.map(p => p.input), y = points.map(p => p.output),
      a = new Float64Array(n), b = new Float64Array(n), c = new Float64Array(n), d = new Float64Array(n), m = new Float64Array(n);
    b[0] = b[n - 1] = 1;
    for (let i = 1; i < n - 1; i++) {
      const h0 = x[i] - x[i - 1], h1 = x[i + 1] - x[i];
      a[i] = h0; b[i] = 2 * (h0 + h1); c[i] = h1;
      d[i] = 6 * ((y[i + 1] - y[i]) / h1 - (y[i] - y[i - 1]) / h0);
    }
    for (let i = 1; i < n; i++) {
      const v = a[i] / b[i - 1];
      b[i] -= v * c[i - 1]; d[i] -= v * d[i - 1];
    }
    m[n - 1] = d[n - 1] / b[n - 1];
    for (let i = n - 2; i >= 0; i--) m[i] = (d[i] - c[i] * m[i + 1]) / b[i];
    const lut = new Float64Array(256);
    let j = 0;
    for (let v = 0; v < 256; v++) {
      const z = clamp(v, x[0], x[n - 1]);
      while (j < n - 2 && z > x[j + 1]) j++;
      const h = x[j + 1] - x[j], A = (x[j + 1] - z) / h, B = (z - x[j]) / h;
      lut[v] = clamp(A * y[j] + B * y[j + 1] + ((A * A * A - A) * m[j] + (B * B * B - B) * m[j + 1]) * h * h / 6);
    }
    return lut;
  }

  const identityCurve = () => [{ input: 0, output: 0 }, { input: 255, output: 255 }];
  function smoothPoints(fn) {
    return [0, 32, 64, 96, 128, 160, 192, 224, 255].map(input => ({ input, output: Math.round(clamp(fn(input))) }));
  }
  function softAnchor(x, center, target, slope) {
    const delta = (x - center) * slope, room = delta < 0 ? Math.max(.01, target) : Math.max(.01, 255 - target);
    return clamp(target + room * Math.tanh(delta / room));
  }
  function shadowAnchor(x, center, target, slope) {
    const soft = softAnchor(x, center, target, slope);
    if (x >= center) return soft;
    const gap = center - x, q = clamp(gap / Math.max(28, center * .55), 0, 1), weight = .55 * q * q * (3 - 2 * q);
    const retained = clamp(target + (x - center) * Math.max(slope, .85));
    return clamp(soft - Math.min(14, Math.max(0, soft - retained) * weight));
  }

  const TONE_Q = [.01, .05, .10, .20, .35, .50, .65, .80, .90, .95, .99];

  function quantiles(h, total) {
    let acc = 0, idx = 0, qs = [.1, .5, .9], out = [];
    for (let i = 0; i < 256; i++) {
      acc += h[i];
      while (idx < 3 && acc >= qs[idx] * total) { out.push(i); idx++; }
    }
    while (out.length < 3) out.push(255);
    return { p10: out[0], p50: out[1], p90: out[2] };
  }

  function statistics(p, rect, weight) {
    const x0 = clamp(Math.floor(rect.x), 0, p.width - 1), y0 = clamp(Math.floor(rect.y), 0, p.height - 1);
    const x1 = clamp(Math.ceil(rect.x + rect.width), x0 + 1, p.width), y1 = clamp(Math.ceil(rect.y + rect.height), y0 + 1, p.height);
    const h = new Float64Array(256), rh = new Float64Array(256), gh = new Float64Array(256), bh = new Float64Array(256);
    let total = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 160000)));
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * p.width + x) * 4, a = p.data[i + 3] / 255, w = a * (weight ? weight(x, y) : 1);
      if (w < .5) continue;
      const r = p.data[i], g = p.data[i + 1], b = p.data[i + 2];
      h[Math.round(lum(r, g, b))] += w; rh[r] += w; gh[g] += w; bh[b] += w;
      total += w;
    }
    if (total < 32) throw Error('有效像素太少：请框选更大的服饰区域（参考图）或确认PS选区覆盖服装');
    return { rgb: [quantiles(rh, total).p50, quantiles(gh, total).p50, quantiles(bh, total).p50], ...quantiles(h, total), samples: Math.round(total) };
  }

  function clothTones(p, rect, weight) {
    const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y)),
      x1 = Math.min(p.width, Math.ceil(rect.x + rect.width)), y1 = Math.min(p.height, Math.ceil(rect.y + rect.height));
    const step = Math.max(1, Math.floor(Math.sqrt((x1 - x0) * (y1 - y0) / 45000))), hist = new Float64Array(1001), samples = [];
    let total = 0;
    for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
      const i = (y * p.width + x) * 4, w = p.data[i + 3] / 255 * (weight ? weight(x, y) : 1);
      if (w < .7) continue;
      const c = rgbLab(p.data[i], p.data[i + 1], p.data[i + 2]), bin = Math.round(clamp(c[0], 0, 100) * 10);
      hist[bin] += w;
      samples.push({ c, w });
      total += w;
    }
    if (samples.length < 32) throw Error('布料样本不足：请扩大取色范围或换更清晰的参考图');
    const quantiles = [];
    let sum = 0, idx = 0;
    for (let k = 0; k <= 1000; k++) {
      sum += hist[k];
      while (idx < TONE_Q.length && sum >= TONE_Q[idx] * total) { quantiles.push(k / 10); idx++; }
    }
    while (quantiles.length < TONE_Q.length) quantiles.push(100);
    const colors = quantiles.map((L, j) => {
      const radius = Math.max(1.5, ((quantiles[Math.min(j + 1, quantiles.length - 1)] - quantiles[Math.max(0, j - 1)]) / 2));
      let a = 0, b = 0, t = 0;
      for (const s of samples) {
        const d = (s.c[0] - L) / radius, w = s.w * Math.exp(-.5 * d * d);
        a += s.c[1] * w; b += s.c[2] * w; t += w;
      }
      return [L, a / t, b / t];
    });
    return { quantiles, colors, qs: TONE_Q.slice(), samples: samples.length };
  }

  function softModel(stats, options = {}) {
    if (!stats.src.tone || !stats.ref.tone) throw Error('布料明暗统计缺失');
    const st = stats.src.tone, rt = stats.ref.tone,
      at = t => t.qs.reduce((best, q, i) => Math.abs(q - .5) < Math.abs(t.qs[best] - .5) ? i : best, 0), si = at(st), ri = at(rt);
    const source = labRgb(...st.colors[si]), target = labRgb(...rt.colors[ri]), sourceLum = lum(...source), targetLum = lum(...target);
    const cs = clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1),
      ls = clamp(options.lightStrength === undefined ? 1 : options.lightStrength, 0, 1);
    const qrgb = (t, q) => {
      const i = t.qs.reduce((best, v, i) => Math.abs(v - q) < Math.abs(t.qs[best] - q) ? i : best, 0);
      return lum(...labRgb(...t.colors[i]));
    };
    const spanSource = Math.max(1, qrgb(st, .9) - qrgb(st, .1)), spanTarget = Math.max(1, qrgb(rt, .9) - qrgb(rt, .1));
    const baseSlope = clamp(spanTarget / spanSource, .55, .9),
      same = Math.hypot(...st.colors[si].map((v, i) => v - rt.colors[ri][i])) < .5;
    const lightSlope = same ? 1 : 1 + (baseSlope - 1) * ls, lightTarget = sourceLum + (targetLum - sourceLum) * ls;
    const bright = ls === 0 || same ? identityCurve() : smoothPoints(x => shadowAnchor(x, sourceLum, lightTarget, lightSlope)), blut = curveLUT(bright);
    const middle = rgb => ls === 0 || same ? rgb.slice() : setLum(rgb, lum(...rgb.map(v => blut[Math.floor(clamp(v))])));
    const anchor = ls === 0 || same ? source.slice() : setLum(source, lum(...source.map(v => blut[Math.floor(clamp(v))]))),
      wanted = target.map((v, c) => anchor[c] + (v - anchor[c]) * cs), colorSlope = 1 - .12 * cs;
    const channels = [0, 1, 2].map(c => cs === 0 || same ? identityCurve() : smoothPoints(x => softAnchor(x, anchor[c], wanted[c], colorSlope))), luts = channels.map(curveLUT);
    const mapped = rgb => {
      if (cs === 0 && ls === 0 || same) return rgb.slice();
      const mid = middle(rgb);
      if (cs === 0) return mid;
      return setLum(mid.map((v, c) => luts[c][Math.floor(clamp(v))]), lum(...mid));
    };
    return { source, target, sourceLum, targetLum, lightSlope, bright, channels, mapped, method: 'soft-midtone-color-separated', same };
  }

  function controlValue(options, key, min, max) {
    const v = options[key] === undefined ? 0 : options[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw Error('手动调节参数超出有效范围');
    return v;
  }

  function hueSaturationRGB(rgb, hue, saturation) {
    const r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, L = (max + min) / 2;
    let H = 0, S = d ? d / (1 - Math.abs(2 * L - 1)) : 0;
    if (d) {
      H = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      H *= 60;
    }
    H = ((H + hue) % 360 + 360) % 360;
    S = saturation >= 0 ? (saturation === 1 ? (S > 0 ? 1 : 0) : S / (1 - saturation)) : S * (1 + saturation);
    S = clamp(S, 0, 1);
    const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs((H / 60) % 2 - 1)), m = L - c / 2;
    const q = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
    return q.map(v => Math.round(clamp((v + m) * 255)));
  }

  function manualColorModel(options = {}) {
    const hue = Math.round(controlValue(options, 'hue', -180, 180)), contrast = controlValue(options, 'contrast', -1, 1),
      shadows = controlValue(options, 'shadows', -1, 1), highlights = controlValue(options, 'highlights', -1, 1),
      saturation = controlValue(options, 'saturation', -1, 1), xs = [0, 32, 64, 96, 128, 160, 192, 224, 255], adjustments = [];
    if (contrast) {
      const points = xs.map(input => ({ input, output: Math.round(clamp(input - 25 * contrast * Math.sin(2 * Math.PI * input / 255))) })), lut = curveLUT(points);
      for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1]) throw Error('对比度曲线非单调，请重置');
      adjustments.push({
        kind: 'contrast', value: contrast,
        mapped: rgb => setLum(rgb, lum(...rgb.map(v => lut[v]))).map(v => Math.round(clamp(v)))
      });
    }
    for (const [kind, value] of [['shadows', shadows], ['highlights', highlights]]) if (value) {
      const points = kind === 'shadows' && value > 0
        ? [{ input: 0, output: Math.round(85 * value + 1e-9) }, { input: 255, output: 255 }]
        : xs.map(input => {
          const t = kind === 'shadows' ? Math.max(0, (128 - input) / 128) : Math.max(0, (input - 128) / 127);
          return { input, output: Math.round(clamp(input + 40 * value * t * t)) };
        });
      const lut = curveLUT(points);
      for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1] - .05) throw Error('阴影 / 高光曲线非单调，请重置');
      adjustments.push({ kind, value, mapped: rgb => setLum(rgb, lum(...rgb.map(v => lut[v]))).map(v => Math.round(clamp(v))) });
    }
    if (hue) adjustments.push({ kind: 'hue', value: hue, mapped: rgb => hueSaturationRGB(rgb, hue, 0) });
    if (saturation) adjustments.push({ kind: 'saturation', value: saturation, mapped: rgb => hueSaturationRGB(rgb, 0, Math.round(saturation * 100) / 100) });
    const mapped = rgb => { let out = rgb.map(v => Math.round(clamp(v))); for (const a of adjustments) out = a.mapped(out); return out; };
    return { hue, contrast, shadows, highlights, saturation, adjustments, mapped };
  }

  function colorizationModel(stats, options = {}) {
    if (options.colorize !== undefined && typeof options.colorize !== 'boolean') throw Error('着色开关无效');
    const opacity = options.colorizeOpacity === undefined ? 1 : controlValue(options, 'colorizeOpacity', 0, 1), enabled = options.colorize === true;
    if (!enabled) return { enabled: false, opacity, adjustment: null };
    const rt = stats.ref.tone, i = rt.qs.reduce((best, v, j) => Math.abs(v - .5) < Math.abs(rt.qs[best] - .5) ? j : best, 0),
      rgb = labRgb(...rt.colors[i]), max = Math.max(...rgb) / 255, min = Math.min(...rgb) / 255, d = max - min, L = (max + min) / 2;
    let H = 0;
    if (d) { const [r, g, b] = rgb.map(v => v / 255); H = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4; H *= 60; }
    const hue = Math.round((H + 360) % 360) % 360,
      referenceSaturation = Math.round(clamp(d ? d / Math.max(.00001, 1 - Math.abs(2 * L - 1)) : 0, 0, 1) * 100),
      saturation = Math.max(referenceSaturation, Math.min(90, Math.round(referenceSaturation + Math.min(20, referenceSaturation * .5)))),
      amount = Math.round(opacity * 255) / 255;
    const mapped = rgb => {
      if (!amount) return rgb.slice();
      const l = (Math.max(...rgb) + Math.min(...rgb)) / 510, s = saturation / 100, c = (1 - Math.abs(2 * l - 1)) * s, h = hue / 60,
        x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2,
        q = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x],
        colored = q.map(v => Math.round(clamp((v + m) * 255)));
      return rgb.map((v, j) => v + (colored[j] - v) * amount);
    };
    return { enabled: true, opacity: amount, hue, saturation, referenceSaturation, mapped };
  }

  // 完整 mode1 管线（对应原 fitMode mode1 分支）：底层手动（对比/阴影/高光）→ softModel 曲线 → fill75 着色 → 顶层手动（色相/饱和度）→ colorize
  function buildPipeline(stats, options = {}) {
    const base = softModel(stats, options);
    const fillRGB = base.target.map(v => Math.round(clamp(v))),
      cs = base.same ? 0 : Math.round(clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1) * 255) / 255,
      amount = cs * Math.round(.75 * 255) / 255;
    const tone = manualColorModel(options), colorize = colorizationModel(stats, options);
    const bottom = tone.adjustments.filter(a => ['contrast', 'shadows', 'highlights'].includes(a.kind)),
      top = tone.adjustments.filter(a => !['contrast', 'shadows', 'highlights'].includes(a.kind));
    const transform = rgb => {
      let input = rgb.map(v => Math.round(clamp(v)));
      for (const a of bottom) input = a.mapped(input);
      let out = base.mapped(input);
      if (amount) {
        const color = setLum(fillRGB, lum(...out));
        out = out.map((v, c) => v + (color[c] - v) * amount);
      }
      out = out.map(v => Math.round(clamp(v)));
      for (const a of top) out = a.mapped(out);
      if (colorize.enabled && colorize.opacity) out = colorize.mapped(out);
      return out;
    };
    return { base, transform, tone, colorize, method: base.method };
  }

  // ============ mode2：可选颜色（衣色 mode2Model/mode2LightModel 逐行移植） ============
  // SELECTIVE_RANGES / selectiveColorScales / selectiveColorRGB 原样照抄
  const SELECTIVE_RANGES = ['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks'];
  function selectiveColorScales(rgb) {
    const [r, g, b] = rgb.map(v => clamp(v) / 255), lo = Math.min(r, g, b), hi = Math.max(r, g, b), mid = r + g + b - lo - hi;
    return [r === hi ? hi - mid : 0, b === lo ? mid - lo : 0, g === hi ? hi - mid : 0, r === lo ? mid - lo : 0, b === hi ? hi - mid : 0, g === lo ? mid - lo : 0, Math.max(0, 2 * lo - 1), Math.max(0, 1 - Math.abs(hi - .5) - Math.abs(lo - .5)), Math.max(0, 1 - 2 * hi)];
  }
  function selectiveColorRGB(rgb, adjustment) {
    const input = rgb.map(v => clamp(v) / 255), scales = selectiveColorScales(rgb), delta = [0, 0, 0];
    for (let i = 0; i < SELECTIVE_RANGES.length; i++) {
      const s = scales[i], a = adjustment[SELECTIVE_RANGES[i]];
      if (!s || !a) continue;
      const k = (a.k || 0) / 100;
      for (let c = 0; c < 3; c++) {
        const v = (a[['c', 'm', 'y'][c]] || 0) / 100;
        let change = (-1 - v) * k - v;
        if (adjustment.mode === 'relative') change *= 1 - input[c];
        delta[c] += clamp(change, -input[c], 1 - input[c]) * s;
      }
    }
    return input.map((v, c) => clamp((v + delta[c]) * 255));
  }

  function mode2Model(stats, options = {}) {
    if (!stats.src.tone || !stats.ref.tone) throw Error('布料明暗统计缺失');
    const csInput = clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1),
      ls = clamp(options.lightStrength === undefined ? 1 : options.lightStrength, 0, 1);
    const light = mode2LightModel(stats, { colorStrength: 1, lightStrength: ls }),
      st = stats.src.tone, rt = stats.ref.tone,
      nearest = (t, q) => t.qs.reduce((b, v, i) => Math.abs(v - q) < Math.abs(t.qs[b] - q) ? i : b, 0),
      blut = curveLUT(light.bright), cs = light.same ? 0 : Math.round(csInput * 255) / 255,
      fillRGB = light.target.map(v => Math.round(clamp(v))), fillOpacity = Math.round(.35 * cs * 255) / 255;
    const middle = rgb => light.same || ls === 0 ? rgb.slice() : setLum(rgb, lum(...rgb.map(v => blut[Math.floor(clamp(v))])));
    const adjustment = { type: 'selective color', mode: 'absolute' };
    for (const range of SELECTIVE_RANGES) adjustment[range] = { c: 0, m: 0, y: 0, k: 0 };
    const tint = (rgb, amount) => {
      if (!amount) return rgb.slice();
      const fill = setLum(fillRGB, lum(...rgb));
      return rgb.map((v, c) => v + (fill[c] - v) * amount);
    };
    const rows = st.qs.map((q, i) => ({ q, i })).filter(v => v.q >= .05 && v.q <= .95).map(({ q, i }) => {
      const rgb = middle(labRgb(...st.colors[i])), want = labRgb(...rt.colors[nearest(rt, q)]);
      return { rgb, want, scales: selectiveColorScales(rgb), weight: Math.abs(q - .5) < .001 ? 12 : Math.abs(q - .5) <= .15 ? 2 : 1 };
    });
    const fullFill = Math.round(.35 * 255) / 255;
    const active = SELECTIVE_RANGES.map((name, i) => ({ name, i })).filter(v => rows.some(row => row.scales[v.i] > .003));
    const outputFull = rgb => tint(selectiveColorRGB(rgb, adjustment), fullFill);
    const score = () => {
      let e = 0;
      for (const row of rows) {
        const out = outputFull(row.rgb);
        for (let c = 0; c < 3; c++) e += (out[c] - row.want[c]) ** 2 * row.weight;
      }
      for (const { name } of active) for (const k of ['c', 'm', 'y', 'k']) e += .003 * adjustment[name][k] ** 2;
      return e;
    };
    if (!light.same) {
      let best = score();
      for (const step of [32, 16, 8, 4, 2, 1]) for (let pass = 0; pass < 7; pass++) {
        let changed = false;
        for (const { name } of active) for (const k of ['c', 'm', 'y', 'k']) {
          const old = adjustment[name][k];
          let value = old, error = best;
          for (const sign of [-1, 1]) {
            const v = clamp(old + sign * step, -100, 100);
            if (v === old) continue;
            adjustment[name][k] = v;
            const s = score();
            if (s < error - 1e-6) { value = v; error = s; }
          }
          adjustment[name][k] = value;
          if (value !== old) { best = error; changed = true; }
        }
        if (!changed) break;
      }
    }
    const mapped = rgb => {
      const mid = middle(rgb), selected = selectiveColorRGB(mid, adjustment), out = mid.map((v, c) => v + (selected[c] - v) * cs);
      return tint(out, fillOpacity);
    };
    return { ...light, cs, fillRGB, fillOpacity, adjustment, mapped, method: 'mode2-absolute-selective-color-fill35' };
  }

  function mode2LightModel(stats, options = {}) {
    if (!stats.src.tone || !stats.ref.tone) throw Error('布料明暗统计缺失');
    const st = stats.src.tone, rt = stats.ref.tone,
      nearest = (t, q) => t.qs.reduce((b, v, i) => Math.abs(v - q) < Math.abs(t.qs[b] - q) ? i : b, 0),
      si = nearest(st, .5), ri = nearest(rt, .5);
    const source = labRgb(...st.colors[si]), target = labRgb(...rt.colors[ri]), sourceLum = lum(...source), targetLum = lum(...target);
    const same = st.qs.length === rt.qs.length && st.colors.every((v, i) => Math.hypot(...v.map((x, c) => x - rt.colors[i][c])) < .35);
    const cs = same ? 0 : Math.round(clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1) * 255) / 255,
      ls = clamp(options.lightStrength === undefined ? 1 : options.lightStrength, 0, 1);
    const ids = st.qs.map((q, i) => ({ q, i })).filter(v => v.q >= .05 && v.q <= .95), mid = ids.findIndex(v => v.i === si), sourceL = ids.map(v => st.colors[v.i][0]);
    const wantedL = ids.map(v => {
      const r = rt.colors[nearest(rt, v.q)][0];
      return rt.colors[ri][0] + .85 * (r - rt.colors[ri][0]) + .15 * (st.colors[v.i][0] - st.colors[si][0]);
    });
    if (mid < 0) throw Error('布料中间调统计缺失');
    const sourceRange = sourceL[sourceL.length - 1] - sourceL[0], trust = clamp((sourceRange - 1) / 5, 0, 1);
    for (let i = 0; i < wantedL.length; i++) wantedL[i] = rt.colors[ri][0] + (wantedL[i] - rt.colors[ri][0]) * trust + (sourceL[i] - sourceL[mid]) * (1 - trust);
    wantedL[mid] = rt.colors[ri][0];
    for (let i = mid - 1; i >= 0; i--) {
      const d = Math.max(0, sourceL[i + 1] - sourceL[i]);
      wantedL[i] = clamp(wantedL[i + 1] - clamp(wantedL[i + 1] - wantedL[i], .55 * d, 1.75 * d), 1, 99);
    }
    for (let i = mid + 1; i < wantedL.length; i++) {
      const d = Math.max(0, sourceL[i] - sourceL[i - 1]);
      wantedL[i] = clamp(wantedL[i - 1] + clamp(wantedL[i] - wantedL[i - 1], .55 * d, 1.45 * d), 1, 99);
    }
    // 反演原生 Color 混合（含色域裁剪）匹配目标 Lab 亮度：9点明度曲线（二分）
    const colorAt = (rgb, L, amount = 1) => { const midRGB = setLum(rgb, L), fill = setLum(target, L); return midRGB.map((v, c) => v + (fill[c] - v) * amount); };
    const rows = ids.map((v, j) => {
      const rgb = labRgb(...st.colors[v.i]), goal = v.i === si ? rgbLab(...target)[0] : wantedL[j];
      let lo = 0, hi = 255;
      for (let k = 0; k < 18; k++) {
        const L = (lo + hi) / 2, out = rgbLab(...colorAt(rgb, L))[0];
        if (out < goal) lo = L; else hi = L;
      }
      return { rgb, want: colorAt(rgb, (lo + hi) / 2), L: (lo + hi) / 2, weight: v.q === .5 ? 12 : 1 };
    });
    const bright = ls === 0 || same ? identityCurve() : smoothPoints(x => {
      let best = rows[0].L, bd = Infinity;
      for (const r of rows) { const d = Math.abs(r.L - x); if (d < bd) { bd = d; best = r.L; } }
      return best;
    }), blut = curveLUT(bright);
    const anchorRGB = rows.reduce((acc, r) => acc, null);
    void anchorRGB;
    const light = { source, target, sourceLum, targetLum, same, cs, bright };
    return light;
  }

  // ============ mode3：渐变映射（mode3Model + gradientMapRGB 移植） ============
  function gradientMapRGB(stops, value, rounded = true) {
    const x = clamp(value / 255, 0, 1);
    let i = 0;
    while (i < stops.length - 2 && x > stops[i + 1].location) i++;
    const a = stops[i], b = stops[i + 1], t = clamp((x - a.location) / Math.max(1 / 4096, b.location - a.location), 0, 1);
    return ['r', 'g', 'b'].map(c => {
      const v = clamp(a.color[c] + (b.color[c] - a.color[c]) * t);
      return rounded ? Math.round(v) : v;
    });
  }

  function mode3Model(stats, options = {}) {
    if (!stats.src.tone || !stats.ref.tone) throw Error('布料明暗统计缺失');
    const st = stats.src.tone, rt = stats.ref.tone,
      at = (t, q) => t.qs.reduce((b, v, i) => Math.abs(v - q) < Math.abs(t.qs[b] - q) ? i : b, 0), si = at(st, .5), ri = at(rt, .5);
    const source = labRgb(...st.colors[si]), target = labRgb(...rt.colors[ri]), sourceLum = lum(...source), targetLum = lum(...target);
    const same = st.qs.length === rt.qs.length && st.colors.every((v, i) => Math.hypot(...v.map((x, c) => x - rt.colors[i][c])) < .35);
    const cs = same ? 0 : Math.round(clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1) * 255) / 255,
      ls = clamp(options.lightStrength === undefined ? 1 : options.lightStrength, 0, 1);
    const span = t => lum(...labRgb(...t.colors[at(t, .9)])) - lum(...labRgb(...t.colors[at(t, .1)]));
    const lightSlope = clamp(span(rt) / Math.max(6, span(st)), .55, 1.25), lightTarget = sourceLum + (targetLum - sourceLum) * ls;
    const bright = ls === 0 || same ? identityCurve() : smoothPoints(x => shadowAnchor(x, sourceLum, lightTarget, 1 + (lightSlope - 1) * ls)), blut = curveLUT(bright);
    const middle = rgb => ls === 0 || same ? rgb.slice() : setLum(rgb, lum(...rgb.map(v => blut[Math.floor(clamp(v))])));
    const nodes = [.05, .2, .5, .8, .95].map(q => ({
      location: Math.round(clamp(lum(...middle(labRgb(...st.colors[at(st, q)]))) / 255, 0, 1) * 4096) / 4096,
      rgb: labRgb(...rt.colors[at(rt, q)]), weight: q === .5 ? 4 : 1
    })).sort((a, b) => a.location - b.location);
    const merged = [];
    for (const n of nodes) {
      const last = merged[merged.length - 1];
      if (last && n.location === last.location) {
        last.rgb = last.rgb.map((v, c) => (v * last.weight + n.rgb[c] * n.weight) / (last.weight + n.weight));
        last.weight += n.weight;
      } else merged.push({ ...n, rgb: n.rgb.slice() });
    }
    if (merged[0].location > 0) merged.unshift({ ...merged[0], location: 0 });
    if (merged[merged.length - 1].location < 1) merged.push({ ...merged[merged.length - 1], location: 1 });
    const colorStops = merged.map(n => ({ location: n.location, midpoint: .5, color: { r: Math.round(n.rgb[0]), g: Math.round(n.rgb[1]), b: Math.round(n.rgb[2]) } }));
    const mapped = rgb => {
      const mid = middle(rgb);
      if (!cs) return mid;
      const color = gradientMapRGB(colorStops, lum(...mid));
      return mid.map((v, c) => v + (color[c] - v) * cs);
    };
    return { source, target, sourceLum, targetLum, same, cs, bright, colorStops, mapped, method: 'mode3-gradient-map-lightness-compensated' };
  }

  // ============ mode4：通道混合器（mode4Model 移植，含岭回归+坐标下降） ============
  // 插件版系数为浮点权重 [-2,2]（非原版整数百分比），公式不再 /100
  function channelMixerRGB(rgb, adjustment) {
    return ['red', 'green', 'blue'].map(c => {
      const a = adjustment[c];
      return clamp(a.red * rgb[0] + a.green * rgb[1] + a.blue * rgb[2] + a.constant * 255);
    });
  }
  function solve3(A, b) {
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let pivot = c;
      for (let j = c + 1; j < 3; j++) if (Math.abs(m[j][c]) > Math.abs(m[pivot][c])) pivot = j;
      [m[c], m[pivot]] = [m[pivot], m[c]];
      const d = m[c][c];
      if (Math.abs(d) < 1e-9) return null;
      for (let k = c; k < 4; k++) m[c][k] /= d;
      for (let j = 0; j < 3; j++) if (j !== c) {
        const v = m[j][c];
        for (let k = c; k < 4; k++) m[j][k] -= v * m[c][k];
      }
    }
    return m.map(row => row[3]);
  }

  function mode4Model(stats, options = {}) {
    const base = mode3Model(stats, { ...options, colorStrength: 0 }), st = stats.src.tone, rt = stats.ref.tone;
    const at = (t, q) => t.qs.reduce((b, v, i) => Math.abs(v - q) < Math.abs(t.qs[b] - q) ? i : b, 0), lut = curveLUT(base.bright);
    const middle = rgb => options.lightStrength === 0 || base.same ? rgb.slice() : setLum(rgb, lum(...rgb.map(v => lut[Math.floor(clamp(v))])));
    const sourceMid = middle(base.source), targetMid = setLum(base.target, lum(...sourceMid));
    const rows = [.05, .1, .2, .35, .5, .65, .8, .9, .95].map(q => {
      const rgb = middle(labRgb(...st.colors[at(st, q)])), ref = labRgb(...rt.colors[at(rt, q)]);
      return { rgb, want: setLum(ref, lum(...rgb)), weight: q === .5 ? 12 : Math.abs(q - .5) < .2 ? 3 : 1 };
    });
    const adjustment = { type: 'channel mixer', monochrome: false, gray: { red: 30, green: 59, blue: 11, constant: 0 } };
    const variance = rows.reduce((v, row) => v + row.weight * (lum(...row.rgb) - lum(...sourceMid)) ** 2, 0), regularization = Math.max(80, variance * .015), ls = [.30, .59, .11];
    for (let c = 0; c < 3; c++) {
      const range = lum(...rows[rows.length - 1].rgb) - lum(...rows[0].rgb),
        slope = range > 4 ? clamp((rows[rows.length - 1].want[c] - rows[0].want[c]) / range, .2, 1.6) : 1;
      const prior = ls.map((v, j) => .85 * v * slope + (j === c ? .15 : 0)),
        A = Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) => i === j ? regularization : 0)),
        b = prior.map(v => v * regularization);
      for (const row of rows) {
        const x = row.rgb.map((v, j) => v - sourceMid[j]), y = row.want[c] - targetMid[c];
        for (let i = 0; i < 3; i++) {
          b[i] += row.weight * x[i] * y;
          for (let j = 0; j < 3; j++) A[i][j] += row.weight * x[i] * x[j];
        }
      }
      let weights = solve3(A, b) || prior;
      weights = weights.map(v => clamp(v, -2, 2));
      const total = weights.reduce((a, b) => a + b, 0);
      if (total < .2 || total > 1.8) {
        const d = (clamp(total, .2, 1.8) - total) / 3;
        weights = weights.map(v => clamp(v + d, -2, 2));
      }
      // 插件版直接用浮点系数（不整化——不是导出PSD，精度更高）；保留坐标下降微调
      let candidate = [...weights, clamp((targetMid[c] - weights.reduce((s, v, j) => s + v * sourceMid[j], 0)) / 255, -1, 1)];
      const score = p => {
        const t = p[0] + p[1] + p[2];
        if (t < .18 || t > 1.82) return Infinity;
        let e = 0;
        for (const row of rows) {
          const actual = clamp(p[0] * row.rgb[0] + p[1] * row.rgb[1] + p[2] * row.rgb[2] + p[3] * 255);
          e += row.weight * (actual - row.want[c]) ** 2;
        }
        return e + regularization * p.slice(0, 3).reduce((s, v, j) => s + (v - prior[j]) ** 2, 0);
      };
      let error = score(candidate);
      for (const step of [.04, .02, .01, .002, .001]) for (let pass = 0; pass < 5; pass++) {
        let changed = false;
        for (let j = 0; j < 4; j++) for (const sign of [-1, 1]) {
          const p = candidate.slice();
          p[j] = clamp(p[j] + step * sign, j === 3 ? -1 : -2, j === 3 ? 1 : 2);
          const e = score(p);
          if (e < error - 1e-7) { candidate = p; error = e; changed = true; }
        }
        if (!changed) break;
      }
      adjustment[['red', 'green', 'blue'][c]] = { red: candidate[0], green: candidate[1], blue: candidate[2], constant: candidate[3] };
    }
    if (base.same) for (let c = 0; c < 3; c++) adjustment[['red', 'green', 'blue'][c]] = { red: c === 0 ? 100 : 0, green: c === 1 ? 100 : 0, blue: c === 2 ? 100 : 0, constant: 0 };
    const cs = base.same ? 0 : Math.round(clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1) * 255) / 255;
    const mapped = rgb => {
      const mid = middle(rgb);
      if (!cs) return mid;
      const mixed = channelMixerRGB(mid, adjustment);
      return mid.map((v, c) => v + (mixed[c] - v) * cs);
    };
    return { ...base, cs, adjustment, mapped, method: 'mode4-channel-mixer-bounded-ridge-fit' };
  }

  // 按模式构建完整管线（手动调节叠加顺序与原版一致：底层对比/阴影/高光 → 模式映射 → 顶层色相/饱和度 → colorize）
  function buildPipelineMode(stats, options = {}) {
    const mode = options.matchMode === 'mode2' || options.matchMode === 'mode3' || options.matchMode === 'mode4' ? options.matchMode : 'mode1';
    const base = mode === 'mode2' ? mode2Model(stats, options) : mode === 'mode3' ? mode3Model(stats, options) : mode === 'mode4' ? mode4Model(stats, options) : softModel(stats, options);
    const fillRGB = base.target.map(v => Math.round(clamp(v))),
      cs = base.same ? 0 : Math.round(clamp(options.colorStrength === undefined ? 1 : options.colorStrength, 0, 1) * 255) / 255,
      amount = mode === 'mode1' ? cs * Math.round(.75 * 255) / 255 : 0;
    const tone = manualColorModel(options), colorize = colorizationModel(stats, options);
    const bottom = tone.adjustments.filter(a => ['contrast', 'shadows', 'highlights'].includes(a.kind)),
      top = tone.adjustments.filter(a => !['contrast', 'shadows', 'highlights'].includes(a.kind));
    const transform = rgb => {
      let input = rgb.map(v => Math.round(clamp(v)));
      for (const a of bottom) input = a.mapped(input);
      let out = base.mapped(input);
      if (amount) {
        const color = setLum(fillRGB, lum(...out));
        out = out.map((v, c) => v + (color[c] - v) * amount);
      }
      out = out.map(v => Math.round(clamp(v)));
      for (const a of top) out = a.mapped(out);
      if (colorize.enabled && colorize.opacity) out = colorize.mapped(out);
      return out;
    };
    return { base, transform, tone, colorize, method: base.method, mode };
  }


  // 选区权重图：bbox 内 1、边缘 featherPx smoothstep 羽化、外 0。null=全图 1（整幅参与）
  function buildWeight(W, H, selection, featherPx) {
    const w = new Float32Array(W * H);
    if (!selection || typeof selection.x !== 'number') { w.fill(1); return w; }
    const f = Math.max(0, Math.min(32, featherPx === undefined ? 2 : featherPx));
    const x0 = clamp(Math.floor(selection.x), 0, W), y0 = clamp(Math.floor(selection.y), 0, H),
      x1 = clamp(Math.ceil(selection.x + selection.width), 0, W), y1 = clamp(Math.ceil(selection.y + selection.height), 0, H);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      let e = 1;
      if (f > 0) {
        const dx = Math.min(x - x0 + 1, x1 - x), dy = Math.min(y - y0 + 1, y1 - y);
        const d = Math.min(dx, dy);
        if (d < f) { const t = d / f; e = t * t * (3 - 2 * t); }
      }
      w[y * W + x] = e;
    }
    return w;
  }

  function analyzeSource(p, weight) {
    const rect = { x: 0, y: 0, width: p.width, height: p.height };
    const wf = (x, y) => weight[y * p.width + x];
    return { ...statistics(p, rect, wf), tone: clothTones(p, rect, wf) };
  }

  function analyzeReference(p, rect) {
    if (!rect || rect.width < 3 || rect.height < 3) throw Error('请在参考图上拖框选取色范围（至少3×3），避开背景');
    return { ...statistics(p, rect), tone: clothTones(p, rect) };
  }

  // 全图渲染：transform 逐像素 + 32768 色 LRU-ish 缓存（原版同款 clear-all）+ 权重 alpha
  function renderToImageData(src, weight, transform, onProgress) {
    const W = src.width, H = src.height, out = new Uint8ClampedArray(src.data), cache = new Map();
    let dirty = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, w = weight[y * W + x], a = src.data[i + 3] / 255;
        if (w <= 0 || a <= 0) { out[i + 3] = 0; continue; }
        const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], ck = (r << 16) | (g << 8) | b;
        let final = cache.get(ck);
        if (!final) {
          final = transform([r, g, b]);
          if (cache.size >= 32768) cache.clear();
          cache.set(ck, final);
        }
        out[i] = final[0]; out[i + 1] = final[1]; out[i + 2] = final[2];
        out[i + 3] = Math.round(clamp(w * a * 255, 0, 255));
        dirty++;
      }
      if (onProgress && (y & 255) === 0) onProgress(y / H, dirty);
    }
    return { width: W, height: H, data: out, painted: dirty };
  }
  // ---- 参考图自动服装分割（衣色 referenceGarmentMask 逐行移植） ----
  // 颜色种子区域生长，非语义AI。米色/黄色布料不会因"像肤色"被丢弃（原版铁律）。
  // weight: 源图选区权重图（替代原版 maskWeight）——只作种子先验，不限制轮廓
  function garmentCropAuto(srcW, srcH, weight, refW, refH) {
    const scale = Math.min(1, 180 / Math.max(srcW, srcH)), w = Math.max(12, Math.round(srcW * scale)), h = Math.max(12, Math.round(srcH * scale));
    const inside = new Uint8Array(w * h), heights = new Int32Array(w);
    let best = { area: 0 };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const wx = (x + .5) * srcW / w, wy = (y + .5) * srcH / h;
      let ok = true;
      for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const sx = Math.round(wx + dx * srcW / w), sy = Math.round(wy + dy * srcH / h);
        if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH || weight[sy * srcW + sx] < .90) { ok = false; break; }
      }
      inside[y * w + x] = ok ? 1 : 0;
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) heights[x] = inside[y * w + x] ? heights[x] + 1 : 0;
      const stack = [];
      for (let x = 0; x <= w; x++) {
        const val = x === w ? 0 : heights[x];
        while (stack.length && heights[stack[stack.length - 1]] > val) {
          const at = stack.pop(), height = heights[at], left = stack.length ? stack[stack.length - 1] + 1 : 0, width = x - left;
          const area = width * height, score = area * (Math.min(width, height) < 8 ? .15 : 1);
          if (score > (best.score || 0)) best = { score, area, x: left, y: y - height + 1, width, height };
        }
        if (x < w) stack.push(x);
      }
    }
    if (!best.area || best.width < 3 || best.height < 3) throw Error('选区内缺少足够大的布料区域，请检查PS选区/蒙版是否覆盖服装');
    const nx = (best.x + best.width * .10) / w, ny = (best.y + best.height * .08) / h, nw = best.width * .80 / w, nh = best.height * .84 / h;
    const crop = {
      x: Math.max(0, Math.floor(nx * refW)), y: Math.max(0, Math.floor(ny * refH)),
      width: Math.max(3, Math.round(nw * refW)), height: Math.max(3, Math.round(nh * refH))
    };
    crop.width = Math.min(crop.width, refW - crop.x);
    crop.height = Math.min(crop.height, refH - crop.y);
    return { crop, sameFraming: Math.abs((refW / refH) / (srcW / srcH) - 1) < .08 };
  }

  function referenceGarmentMask(srcW, srcH, weight, p, auto) {
    const w = p.width, h = p.height, n = w * h, mask = new Uint8Array(n);
    let opaque = 0, transparent = 0;
    for (let i = 0; i < n; i++) {
      const a = p.data[i * 4 + 3];
      if (a > 180) opaque++;
      if (a < 100) transparent++;
    }
    if (transparent > n * .01 && opaque >= 32) {
      for (let i = 0; i < n; i++) mask[i] = p.data[i * 4 + 3] > 0 ? 255 : 0;
      return { mask, method: 'reference-alpha', uncertain: false };
    }
    const prior = new Uint8Array(n), lab = new Float32Array(n * 3), seeds = [];
    const c = auto.crop, sy0 = c.y + c.height * .10, sy1 = c.y + c.height * .55, sx0 = c.x + c.width * .15, sx1 = c.x + c.width * .85;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const j = y * w + x, px = Math.round((x + .5) * srcW / w), py = Math.round((y + .5) * srcH / h);
      let inside = (px >= 0 && py >= 0 && px < srcW && py < srcH) ? weight[py * srcW + px] > .9 : false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const sx = Math.round(px + dx * srcW / w), sy = Math.round(py + dy * srcH / h);
        if (sx < 0 || sy < 0 || sx >= srcW || sy >= srcH || weight[sy * srcW + sx] < .85) inside = false;
      }
      const color = rgbLab(p.data[j * 4], p.data[j * 4 + 1], p.data[j * 4 + 2]);
      lab.set(color, j * 3);
      if (!inside || p.data[j * 4 + 3] < 190) continue;
      prior[j] = 1;
      if (x >= sx0 && x < sx1 && y >= sy0 && y < sy1 && x % 2 === 0 && y % 2 === 0) seeds.push({ c: color, x, y });
    }
    if (seeds.length < 16) throw Error('自动取色种子不足：请确认PS选区覆盖服装主体，或手动框选取色范围');
    const dist = (a, b) => ((a[0] - b[0]) * .35) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    const centers = [seeds[Math.floor(seeds.length / 2)].c.slice()];
    for (let k = 1; k < 4; k++) {
      let best = -1, value = 0;
      for (let i = 0; i < seeds.length; i++) {
        const d = Math.min(...centers.map(cc => dist(cc, seeds[i].c)));
        if (d > value) { value = d; best = i; }
      }
      if (best < 0 || value < 9) break;
      centers.push(seeds[best].c.slice());
    }
    const labels = new Uint8Array(seeds.length), counts = new Uint32Array(centers.length);
    for (let iteration = 0; iteration < 10; iteration++) {
      counts.fill(0);
      const sums = centers.map(() => [0, 0, 0]);
      for (let i = 0; i < seeds.length; i++) {
        let at = 0, d = Infinity;
        for (let k = 0; k < centers.length; k++) {
          const v = dist(seeds[i].c, centers[k]);
          if (v < d) { at = k; d = v; }
        }
        labels[i] = at;
        counts[at]++;
        for (let v = 0; v < 3; v++) sums[at][v] += seeds[i].c[v];
      }
      for (let k = 0; k < centers.length; k++) if (counts[k]) centers[k] = sums[k].map(v => v / counts[k]);
    }
    let dominant = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[dominant]) dominant = k;
    const color = centers[dominant], spread = [];
    for (let i = 0; i < seeds.length; i++) if (labels[i] === dominant) spread.push(Math.hypot(seeds[i].c[1] - color[1], seeds[i].c[2] - color[2]));
    spread.sort((a, b) => a - b);
    const tolerance = clamp((spread[Math.floor(spread.length * .9)] || 0) * 2 + 5, 6, 14),
      ls = seeds.filter((_, i) => labels[i] === dominant).map(s => s.c[0]).sort((a, b) => a - b),
      low = (ls[0] || 0) - 24, high = (ls[ls.length - 1] || 100) + 24;
    const hsv = (r, g, b) => {
      const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
      let hue = d === 0 ? 0 : hi === r ? 60 * ((g - b) / d % 6) : hi === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
      return [(hue + 360) % 360, hi ? d / hi : 0, hi];
    };
    const hueDistance = (a, b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
    const anchorHSV = hsv(...labRgb(...color)), colorful = anchorHSV[1] > .28 && Math.hypot(color[1], color[2]) > 18;
    const hueSpreads = [];
    for (let i = 0; i < seeds.length; i++) if (labels[i] === dominant) {
      const j = (seeds[i].y * w + seeds[i].x) * 4;
      hueSpreads.push(hueDistance(hsv(p.data[j], p.data[j + 1], p.data[j + 2])[0], anchorHSV[0]));
    }
    hueSpreads.sort((a, b) => a - b);
    const hueTolerance = clamp((hueSpreads[Math.floor(hueSpreads.length * .9)] || 0) * 1.8 + 6, 12, 22);
    const edges = [[], [], []], edgeStep = Math.max(1, Math.floor((w + h) / 300));
    for (let y = 0; y < h; y += edgeStep) for (const x of [0, w - 1]) for (let k = 0; k < 3; k++) edges[k].push(lab[(y * w + x) * 3 + k]);
    for (let x = 0; x < w; x += edgeStep) for (const y of [0, h - 1]) for (let k = 0; k < 3; k++) edges[k].push(lab[(x * w + y) * 3 + k]);
    const background = edges.map(a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; });
    const candidate = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      if (p.data[j * 4 + 3] < 190) continue;
      const L = lab[j * 3], a = lab[j * 3 + 1], b = lab[j * 3 + 2];
      let ok;
      if (colorful) {
        const v = hsv(p.data[j * 4], p.data[j * 4 + 1], p.data[j * 4 + 2]);
        ok = v[2] > 4 && v[1] >= Math.max(.2, anchorHSV[1] * .32) && hueDistance(v[0], anchorHSV[0]) <= hueTolerance;
      } else ok = Math.hypot(a - color[1], b - color[2]) <= tolerance && L >= low && L <= high;
      if (ok && !colorful && Math.hypot(L - background[0], a - background[1], b - background[2]) < 3.5) ok = false;
      candidate[j] = ok ? 1 : 0;
    }
    const seen = new Uint8Array(n), queue = new Int32Array(n), min = Math.max(8, Math.floor(n * .0002));
    let panels = 0, kept = 0;
    for (let i = 0; i < n; i++) if (candidate[i] && !seen[i]) {
      let head = 0, tail = 1, overlap = 0;
      queue[0] = i; seen[i] = 1;
      while (head < tail) {
        const at = queue[head++], x = at % w;
        overlap += prior[at];
        for (const next of [x ? at - 1 : -1, x < w - 1 ? at + 1 : -1, at - w, at + w]) if (next >= 0 && next < n && candidate[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
      if (tail >= min && overlap >= Math.min(8, Math.max(1, tail * .005))) {
        panels++; kept += tail;
        for (let j = 0; j < tail; j++) mask[queue[j]] = 255;
      }
    }
    seen.fill(0);
    let repaired = 0;
    const maxHole = Math.max(8, Math.min(64, Math.floor(n * .00015)));
    for (let i = 0; i < n; i++) if (!mask[i] && !seen[i]) {
      let head = 0, tail = 1, touchesEdge = false, dark = true;
      queue[0] = i; seen[i] = 1;
      while (head < tail) {
        const at = queue[head++], x = at % w, y = Math.floor(at / w);
        if (!x || x === w - 1 || !y || y === h - 1) touchesEdge = true;
        if (lab[at * 3] > Math.min(45, color[0] + 8) || p.data[at * 4 + 3] < 190) dark = false;
        for (const next of [x ? at - 1 : -1, x < w - 1 ? at + 1 : -1, at - w, at + w]) if (next >= 0 && next < n && !mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
      if (!touchesEdge && dark && tail <= maxHole) {
        repaired += tail;
        for (let j = 0; j < tail; j++) mask[queue[j]] = 255;
      }
    }
    return {
      mask, method: 'reference-color-region-grow',
      uncertain: counts[dominant] / seeds.length < .4 || !auto.sameFraming || Math.hypot(color[1] - 12, color[2] - 18) < 10 || kept / n < .06 || panels > 8,
      diagnostics: { panels, repairedTexturePixels: repaired, colorful, hueTolerance }
    };
  }

  // 自动分析参考图：自动蒙版 → 带权统计（不框选时的默认路径）
  function analyzeReferenceAuto(srcW, srcH, weight, p) {
    const auto = garmentCropAuto(srcW, srcH, weight, p.width, p.height);
    const seg = referenceGarmentMask(srcW, srcH, weight, p, auto);
    const selection = { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) };
    let total = 0;
    for (let j = 0; j < p.width * p.height; j++) {
      const i = j * 4, a = Math.round(p.data[i + 3] * seg.mask[j] / 255);
      selection.data[i + 3] = a;
      if (a < 1) { selection.data[i] = selection.data[i + 1] = selection.data[i + 2] = 0; }
      if (a >= 180) total++;
    }
    if (total < 32) throw Error('自动识别的衣服像素不足：请换更清晰的参考图，或手动框选取色范围');
    const sample = { x: 0, y: 0, width: p.width, height: p.height };
    return { ...statistics(selection, sample), tone: clothTones(selection, sample), method: seg.method, uncertain: seg.uncertain, coverage: Math.round(total / (p.width * p.height) * 100) };
  }


  const api = {
    clamp, lum, rgbLab, labRgb, setLum, curveLUT, identityCurve, softAnchor, shadowAnchor,
    TONE_Q, statistics, clothTones, softModel, manualColorModel, colorizationModel,
    buildPipeline, buildWeight, analyzeSource, analyzeReference, renderToImageData, hueSaturationRGB,
    garmentCropAuto, referenceGarmentMask, analyzeReferenceAuto, buildPipelineMode,
  };
  root.ColorRecolor = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
