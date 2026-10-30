function modelsURL(base) {
  const value = String(base || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(value); } catch { throw new Error('接口地址无效，请填写完整的 http:// 或 https:// 地址'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址格式不正确，请使用不含账号、查询参数或锚点的 HTTP 地址');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/(?:v1|v1beta)\/models$/.test(pathname) ? pathname
    : /\/v1$/.test(pathname) ? pathname + '/models'
    : pathname.replace(/\/v1beta$/, '') + '/v1/models';
  return url.toString();
}
function networkMessage(error) {
  const reason = String((error.cause && error.cause.code) || error.code || error.message || '');
  if (/abort|timeout|timed_out/i.test(reason)) return '模型列表请求超时，请检查网络或代理后重试';
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(reason)) return '接口域名无法解析，请检查 Base URL 和 DNS';
  if (/CERT|SSL|TLS/i.test(reason)) return '接口 HTTPS 证书校验失败，请检查服务端证书、系统时间或代理证书';
  if (/PROXY|TUNNEL/i.test(reason)) return '代理连接失败，请检查系统代理是否正在运行';
  if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(reason)) return '接口或代理拒绝连接，请检查地址、端口及服务是否运行';
  return '无法连接模型接口，请检查 Base URL、网络和系统代理'
    + (reason.match(/(?:net::)?ERR_[A-Z_]+|E[A-Z]{4,}/)?.[0] ? '（' + reason.match(/(?:net::)?ERR_[A-Z_]+|E[A-Z]{4,}/)[0] + '）' : '');
}
async function requestModels(fetcher, base, key) {
  const url = modelsURL(base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetcher(url, { headers: { Authorization: 'Bearer ' + key }, signal: controller.signal });
    if (!response.ok) {
      const hints = { 401: 'Key 无效或已过期', 403: 'Key 没有访问权限，或被服务端限制', 404: '未找到模型列表接口，请核对 Base URL', 429: '请求过于频繁或额度受限，请稍后重试' };
      throw new Error((hints[response.status] || '模型接口返回错误') + '（HTTP ' + response.status + '）');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('模型接口返回的不是 JSON，请确认 Base URL 是 API 地址而非网站首页'); }
    if (!data || !Array.isArray(data.data)) throw new Error('模型列表格式不兼容：接口应返回 data 数组');
    return data.data.map((model) => model && model.id).filter((id) => typeof id === 'string' && id);
  } catch (error) {
    if (controller.signal.aborted) throw new Error('模型列表请求超时，请检查网络或代理后重试');
    if (/HTTP \d+|JSON|data 数组/.test(error.message)) throw error;
    throw new Error(networkMessage(error));
  } finally { clearTimeout(timer); }
}
module.exports = { modelsURL, requestModels, networkMessage };
