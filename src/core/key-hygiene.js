// Key卫生（纯函数，无 electron 依赖，smoke 直测）——复制API Key最容易粘进空格/换行/中文字符
//
// 由来（0915用户实报）：两位用户分别在"16bit色彩空间"和"8bit色彩空间下修图"报同一条错——
//   Cannot convert argument to a ByteString because the character at index 7 has a value of 24067...
// 24067 = 「布」。跟色彩位深毫无关系：请求头 'Bearer ' + key 的前7位正是 "Bearer "，
// 所以 index 7 = Key 的第一个字符。用户粘 Key 时把中文一起粘进去了，fetch 造请求头时抛的。
//
// cleanKey：所有取 Key 处都过一道（空白/零宽是纯粘贴垃圾，静默清掉，不打扰用户）。
// keyIssue：请求入口做前置体检——清完仍有非ASCII就用人话拦在发请求之前，并指出第几位是哪个字。
function cleanKey(raw) {
  return String(raw == null ? '' : raw).replace(/[\s\u200B-\u200D\uFEFF]/g, '');
}
function keyIssue(raw, label) {
  const k = cleanKey(raw);
  for (let i = 0; i < k.length; i++) {
    if (k.charCodeAt(i) > 126) {
      return (label ? '「' + label + '」渠道的' : '') + 'Key第' + (i + 1) + '位混进了中文/全角字符「' + k[i] + '」'
        + '——去渠道设置删掉它，或重新复制粘贴整个Key';
    }
  }
  return null;
}
module.exports = { cleanKey, keyIssue };
