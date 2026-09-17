// 用法: node _setver.js 2.8.3
const fs = require('fs');
const path = require('path');
const v = process.argv[2];
if (!v || !/^\d+\.\d+\.\d+$/.test(v)) {
  console.error('用法: node _setver.js <版本号>  例如 2.8.3');
  process.exit(1);
}
const f = path.join(__dirname, 'electron', 'package.json');
const p = JSON.parse(fs.readFileSync(f, 'utf8'));
const old = p.version;
p.version = v;
fs.writeFileSync(f, JSON.stringify(p, null, 2));
console.log('版本 ' + old + ' -> ' + v);
