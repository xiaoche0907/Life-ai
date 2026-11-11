const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/core/gen.js'), 'utf8');
const start = source.indexOf('async function generateViaChat(');
const end = source.indexOf('// ---- 路③', start);
assert(start >= 0 && end > start);

// New API v1.0.0-rc.44: relaykit/relayconvert/internal/oai_chat/to_gemini_chat_req.go
// Only extra_body.google.image_config is converted in this deployed version.
function convertRc44(body) {
  const config = body.extra_body?.google?.image_config;
  if (!config) return {};
  const result = {};
  if (config.image_size) result.imageSize = config.image_size;
  if (config.aspect_ratio) result.aspectRatio = config.aspect_ratio;
  return result;
}

async function request(size, ratio) {
  let body;
  const context = {
    Buffer, AbortController, setTimeout, clearTimeout,
    readRefs: () => [], tmoOf: () => 0,
    fetch: async (_url, options) => {
      body = JSON.parse(options.body.toString('utf8'));
      return { ok: true, json: async () => ({ data: [{ b64_json: 'YQ==' }] }) };
    },
    saveResult: () => ({ ok: true }), errText: String,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const result = await context.generateViaChat({ prompt: 'test', ratio }, {
    effSize: size, model: 'nano-banana-pro', base: 'https://example.invalid', key: 'test',
  });
  assert.equal(result.ok, true);
  return body;
}

(async () => {
  // Regression: fields sent by 6.0.23 are discarded by rc.44.
  assert.deepEqual(convertRc44({ imageConfig: { imageSize: '2K' }, image_config: { image_size: '2K' } }), {});
  for (const size of ['1K', '2K', '4K']) {
    for (const ratio of ['Auto', '3:4', '16:9']) {
      const body = await request(size, ratio);
      const expected = { imageSize: size };
      if (ratio !== 'Auto') expected.aspectRatio = ratio;
      assert.deepEqual(convertRc44(body), expected);
      assert.deepEqual(body.imageConfig, expected);
      assert.equal(body.image_config.image_size, size);
    }
  }
  const auto = await request('Auto', 'Auto');
  assert.equal(auto.extra_body, undefined);
  console.log('通过：旧版本回归、9组尺寸比例映射及Auto参数省略');
})().catch((error) => { console.error(error); process.exitCode = 1; });
