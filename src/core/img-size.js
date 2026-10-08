// 生图尺寸换算（0909：GRS 自家接口 / AJI OpenAI 图片接口都要"像素尺寸"而不是 Gemini 的 imageSize+aspectRatio）
// 纯函数、无 electron 依赖，smoke 直测。表=OpenAI gpt-image 系列官方档位（GRS 文档同表），按 1K/2K/4K 三档
const SIZE_TABLE = {
  '1:1': ['1024x1024', '2048x2048', '2880x2880'],
  '16:9': ['1280x720', '2048x1152', '3840x2160'],
  '9:16': ['720x1280', '1152x2048', '2160x3840'],
  '4:3': ['1152x864', '2304x1728', '3264x2448'],
  '3:4': ['864x1152', '1728x2304', '2448x3264'],
  '3:2': ['1536x1024', '2048x1360', '3504x2336'],
  '2:3': ['1024x1536', '1360x2048', '2336x3504'],
  '5:4': ['1120x896', '2240x1792', '3200x2560'],
  '4:5': ['896x1120', '1792x2240', '2560x3200'],
  '21:9': ['1456x624', '2912x1248', '3840x1648'],
  '9:21': ['624x1456', '1248x2912', '1648x3840'],
  '2:1': ['1536x768', '3072x1536', '3840x1920'],
  '1:2': ['768x1536', '1536x3072', '1920x3840'],
};
// 软件里有、表里没有的比例 → 最接近的档（2.35:1≈2.33=21:9）
const RATIO_ALIAS = { '2.35:1': '21:9', '1:2.35': '9:21' };

function normRatio(ratio) {
  const r = String(ratio || 'Auto');
  if (r === 'Auto') return 'auto';
  return RATIO_ALIAS[r] || r;
}
// 比例+档位 → "WxH"；Auto → 'auto'（两家接口都认）；认不出的比例也 'auto'（让网关自定，别硬猜）
function pixelSize(ratio, tier) {
  const r = normRatio(ratio);
  if (r === 'auto') return 'auto';
  const row = SIZE_TABLE[r];
  if (!row) return 'auto';
  const i = tier === '4K' ? 2 : (tier === '2K' ? 1 : 0);
  return row[i];
}
module.exports = { pixelSize, normRatio, SIZE_TABLE };
