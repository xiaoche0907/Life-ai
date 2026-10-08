const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
let checked = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(js|json|html)$/.test(file)) {
      const source = fs.readFileSync(file, 'utf8');
      if (file.endsWith('.json')) JSON.parse(source);
      else if (file.endsWith('.js')) new vm.Script(source, { filename: file });
      else for (const match of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
        if (match[1].trim()) new vm.Script(match[1], { filename: file });
      }
      checked++;
    }
  }
}
walk(path.join(root, 'src'));
walk(path.join(root, 'ps-bridge'));
for (const file of ['src/index.js', 'src/preload.js', 'src/assets/life-logo.png', 'src/icon-256.png', 'build/icon.ico']) {
  if (!fs.existsSync(path.join(root, file))) throw Error('Missing required file: ' + file);
}
console.log(`Checked ${checked} source, JSON and renderer files.`);
