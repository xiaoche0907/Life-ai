// 模型身份判定（0908用户裁定"绝对不允许"生图卡拉到语言模型）：生图卡只许列生图模型，对话卡只许列语言模型。
// 两头把关：拉取 /v1/models 时过滤（providers.js ai-models / chat.js chat-models-fetch）
//          + 启动回读时清洗已存清单（state.js applyInvariants，老配置里混进的一并清掉）。
// 生图=白名单（认得出是生图的才进）；对话=黑名单（排除生图/音频/视频/向量/审核/实时等非对话模型）。
// 纯函数、不依赖 electron，state.js 在 providers.js 之前加载也能直接 require。
const IMG_RE = /image|banana|flux|dall-?e|imagen|stable-?diffusion|sdxl|\bsd3|seedream|kolors|midjourney|\bmj\b|ideogram|recraft|hidream|kontext|cogview|playground-v|wanx|hunyuan-image|gpt-image|z-image|firefly|janus|pixart|dreamshaper|juggernaut|omnigen|bagel|jimeng|香蕉|生图|绘图|画图|文生图|图生图/i;
const NONCHAT_RE = /embed|\btts\b|whisper|audio|speech|transcri|rerank|moderation|video|\bveo\b|sora|kling|runway|hailuo|\bwan\d|wan-|realtime|\bclip\b|bge-|\be5-|voice|music|suno|upscale|remove-?bg|rembg|\bocr\b|trellis|hunyuan3d/i;

function isImageModel(id) { return IMG_RE.test(String(id || '')); }
function isChatModel(id) {
  const s = String(id || '');
  return !!s && !IMG_RE.test(s) && !NONCHAT_RE.test(s);
}

module.exports = { isImageModel, isChatModel };
