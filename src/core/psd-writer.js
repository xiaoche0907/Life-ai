// PSD装配子进程（utilityProcess.fork入口）：读manifest+图层bin → ag-psd组树写出 → 退出归还全部内存
// 为什么要子进程：61MP大图×多层的ImageData+写出缓冲在主进程会撞V8 ArrayBuffer上限，
// 且跨文件碎片累积让"第一张必成、后面的死"（0905实测）；每文件新鲜进程=干净地址空间+用完全还。
// 用法：utilityProcess.fork(psd-writer.js, [manifest.json路径])；成功exit(0)，失败stderr带原因exit(1)
const fs = require('fs');

function white2() { const d = new Uint8ClampedArray(16); d.fill(255); return { width: 2, height: 2, data: d }; }

const binCache = new Map();   // 同一bin被多层引用(盖印复用候选/平铺复用盖印)时共享一份内存
function loadBin(b) {
  if (!binCache.has(b.f)) {
    const buf = fs.readFileSync(b.f);
    binCache.set(b.f, { width: b.w, height: b.h, data: new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength) });
  }
  return binCache.get(b.f);
}

function buildNode(n) {
  const out = { name: n.name };
  if (n.opened !== undefined) out.opened = n.opened;
  if (n.hidden) out.hidden = true;
  if (n.left !== undefined) out.left = n.left;
  if (n.top !== undefined) out.top = n.top;
  if (n.mask) out.mask = { top: 0, left: 0, right: 2, bottom: 2, defaultColor: 255, disabled: false, imageData: white2() };
  if (n.bin) out.imageData = loadBin(n.bin);
  if (n.children) out.children = n.children.map(buildNode);
  return out;
}

try {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  // 走内部writer而非writePsdBuffer：①按图层总量预分配，消灭翻倍增长的"旧1G+新2G"叠加峰值
  // ②getWriterBufferNoCopy零拷贝（writePsdBuffer末尾的Buffer.from会把1GB级输出整体再复制一份）
  const psdWriter = require('ag-psd/dist/psdWriter');
  const psd = {
    width: manifest.width, height: manifest.height,
    children: manifest.children.map(buildNode),
    imageData: loadBin(manifest.flat),
  };
  // 预估=图层原始总量×1.0+128MB，硬顶1.99GB：单个ArrayBuffer有2GB上限(0905实测2.08GB申请被拒)，
  // 而RLE照片输出≈RGBA原始的75%(alpha恒255近零)，×1.0已含25%+余量
  let est = 128 * 1024 * 1024;
  for (const v of binCache.values()) est += v.data.byteLength;
  est = Math.min(est, 1990000000);
  const writer = psdWriter.createWriter(est);
  psdWriter.writePsd(writer, psd, { generateThumbnail: false });
  const u8 = psdWriter.getWriterBufferNoCopy(writer);
  fs.writeFileSync(manifest.out + '.tmp', u8);
  fs.renameSync(manifest.out + '.tmp', manifest.out);
  process.exit(0);
} catch (e) {
  process.stderr.write(String((e && e.stack) || e));
  process.exit(1);
}
