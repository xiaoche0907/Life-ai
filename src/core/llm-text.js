// 模型回包文本清洗（纯函数、无 electron 依赖：chat.js / autofix.js 用，smoke 直测）
// 思考过程剥离（0909用户裁定：只要结果，不要思考）：正文里的 <think>…</think>（含 <thinking>）整段删掉；
// 只剩收尾标签的残片也删。Gemini parts 里 thought:true 的段由调用方在拼接前过滤。
function cleanModelText(s) {
  let t = String(s == null ? '' : s);
  t = t.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  t = t.replace(/^\s*<\/?think(?:ing)?>\s*/i, '');
  return t.trim();
}
module.exports = { cleanModelText };
