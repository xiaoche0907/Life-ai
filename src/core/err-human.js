// 报错人话化（纯函数，无 electron 依赖）：底层英文/技术报错翻成通俗中文
//
// 0915用户裁定：「所有的英文保持用大白话告诉用户，不能出现英文信息」。
// 两条通道共用本模块：
//   ①主进程日志 log.js olog(type='err') —— 生图日志/日志卡
//   ②preload 的 IPC 返回值兜底 —— 各卡片直接显示 r.error 的那 14 处（不必逐个改页面）
// 只作用于报错文本（info 里可能含用户提示词原文，误翻会闹笑话）；
// 译文后括号保留原始报错，方便用户截图反馈时排查。
const ERR_MAP = [
  [/未知命令.{0,40}/, 'PS里的插件还是旧版（没有这个新功能）——重启一次PS完成更新'],
  // 整句一起吃掉（后半截"because the character at index N has a value of M"别掉在括号外面）；
  // 那个 M 是字符码点，下面 humanizeErr 会解出到底是哪个字（实报的 24067=「布」）
  [/cannot convert argument to a ByteString[\s\S]*/i, 'Key里混进了中文/全角字符（复制时最容易粘进去）——去渠道设置删掉Key重新粘贴'],
  [/only 8 bit image data can be encoded as jpeg/i, '图片是16位色深，旧版插件转不了——重启一次PS完成插件更新即可'],
  [/executeAsModal|modal state|another modal|user is interacting/i, 'PS正忙（有弹窗或正在执行别的操作）——把PS里的事处理完再试'],
  [/user cancell?ed|cancell?ed by user/i, '操作在PS里被取消了'],
  [/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|socket hang up|ERR_NETWORK|network error/i, '网络连不上——检查网络、代理或渠道地址后再试'],
  // Node 的 AbortError 原文是 "This operation was aborted"（0916 ComfyUI 卡真机实测），只认 "The" 会剩半句英文
  [/Th(?:e|is) operation was aborted|AbortError|\baborted\b/i, '等太久没结果，请求已中断——网络慢或服务器忙，再试一次'],
  [/etimedout|timed? ?out|timeout/i, '等待超时——再试一次'],
  // HTTP 系列后面常跟一串英文说明（"HTTP 401 unauthorized"）：用 EN_TAIL 一起吃掉，
  // 否则英文尾巴会掉在译文括号外边，用户还是看见英文
  [/(?:HTTP 401|HTTP 403|unauthorized|invalid.{0,8}key|incorrect api key|authentication)[A-Za-z0-9 _.:'"-]*/i, 'Key不对或没权限——去渠道设置里检查Key'],
  [/(?:HTTP 429|rate.?limit|too many requests|quota|insufficient)[A-Za-z0-9 _.:'"-]*/i, '请求太频繁或额度不够——稍等一会儿，或查查余额'],
  [/(?:HTTP 5\d\d|internal server error|bad gateway|service unavailable|overloaded)[A-Za-z0-9 _.:'"-]*/i, '服务器那边出故障了——稍等几分钟再试'],
  // 必须排在 HTTP 400 前面：ComfyUI 这句报错同时含 "HTTP 400" 和 "Value not in list"，
  // 让 400 那条先命中就会翻成"换个模型或分辨率"，把真正的病因盖掉（0916 用户实报）。整段从
  // "Prompt outputs failed validation" 一路吃到句尾，否则英文尾巴会露在译文外面
  [/Prompt outputs failed validation[\s\S]*/i, '工作流里用到的模型，ComfyUI 那边找不到——多半是启动的 ComfyUI 不对（那台没挂模型目录），或模型文件被移动/删除了'],
  [/(?:HTTP 400|invalid request)[A-Za-z0-9 _.:'"-]*/i, '请求被服务器拒绝——换个模型或分辨率再试'],
  [/(?:HTTP 404|not found)[A-Za-z0-9 _.:'"-]*/i, '这个地址服务器上没有——渠道地址填错了，或该渠道不支持这个模型'],
  [/ENOENT|no such file/i, '文件找不到了（可能已被清理）'],
  [/unexpected token.{0,30}json|json parse|not valid json/i, '服务器返回了看不懂的数据——稍后重试'],
];
function humanizeErr(msg) {
  let s = String(msg == null ? '' : msg);
  // ByteString 专案：报错自带"index N has a value of M"，M 是码点——直接解出那个字告诉用户，
  // 用户就不用把整条 Key 一个字一个字看了（实报 24067=「布」，index 7=Key首字，因为 'Bearer ' 正好7位）
  const bs = s.match(/cannot convert argument to a ByteString[\s\S]*?index (\d+) has a value of (\d+)/i);
  if (bs) {
    const pos = Number(bs[1]), code = Number(bs[2]);
    let ch = '';
    try { ch = String.fromCodePoint(code); } catch (e) {}
    const inKey = pos >= 7 ? ('Key第' + (pos - 7 + 1) + '位') : ('第' + (pos + 1) + '个字符');
    return 'Key里混进了中文/全角字符' + (ch ? '「' + ch + '」' : '') + '（在' + inKey + '，复制时最容易粘进去）'
      + '——去渠道设置删掉Key重新粘贴';
  }
  for (const [re, zh] of ERR_MAP) {
    if (re.test(s)) {
      return s.replace(re, (m) => zh + '（' + m + '）');   // 只翻第一条命中的，避免叠加改写
    }
  }
  // 兜底：没被任何规则接住的英文报错，人话开头、原文殿后（截图排查用）
  if (s && !/[一-鿿]/.test(s) && /[A-Za-z]{4,}/.test(s)) {
    return '遇到一个技术报错，再试一次通常就好；反复出现请把这行截图反馈（' + s + '）';
  }
  return s;
}
module.exports = { ERR_MAP, humanizeErr };
