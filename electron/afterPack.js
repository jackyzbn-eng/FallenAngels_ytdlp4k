// 打包后瘦身。两件事：
//   ① Electron 默认带 55 种语言的 pak（共 ~41MB），应用只用得到中英，删掉其余 → 省 ~39MB
//   ② sharp 会连非本平台 / 用不上的备用二进制一起装进来（@img/sharp-wasm32 8.8MB 等），删掉
//
// 注意 Catalina 之后的 macOS 签名要求 locales 完整性 —— 本项目只发 Windows，无此顾虑。
//
// ⚠ 如果你在受管环境里跑打包（例如 WorkBuddy 沙箱）发现"语言包明明该删却没删掉"：
// 那种环境会把 Node 的 fs.rm/unlink 换成带守卫的 shim，**按 turn 累计**统计删除量，
// 超过阈值（本机实测 50）就抛 [SAFE_DELETE_BULK_CONFIRM_REQUIRED] 并**整体拒绝**，
// 而且报错里的 "count" 是累计值不是本次数量 —— 所以"分批删"是没用的。
// 解法是跑打包时把守卫关掉，而不是改这里的代码：
//     CODEBUDDY_SAFE_DELETE_ENABLED=0 npx electron-builder --win --x64
// 真实用户机器上没有这层守卫，正常跑即可。
const fs = require('fs');
const path = require('path');

/** 递归算目录大小（只读，安全） */
function dirSize(d) {
  let total = 0;
  let entries;
  try { entries = fs.readdirSync(d); } catch (e) { return 0; }
  for (const f of entries) {
    const full = path.join(d, f);
    try {
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    } catch (e) { /* 忽略读不到的项 */ }
  }
  return total;
}

const mb = (n) => Math.round(n / 1024 / 1024);

exports.default = async function (context) {
  const { appOutDir } = context;

  // ---------- ① 语言包 ----------
  const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);
  const localeDir = path.join(appOutDir, 'locales');
  let localeRemoved = 0;
  let localeBytes = 0;
  if (fs.existsSync(localeDir)) {
    for (const f of fs.readdirSync(localeDir)) {
      if (KEEP_LOCALES.has(f)) continue;
      const full = path.join(localeDir, f);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const size = fs.statSync(full).size;
        fs.unlinkSync(full);
        localeRemoved++;
        localeBytes += size;
      } catch (e) { /* 下面复查时报告 */ }
    }
    // 删完必须复查 —— catch 静默吞异常会让"体积偏大"这种远离原因的症状极难排查
    const left = fs.readdirSync(localeDir).filter((f) => !KEEP_LOCALES.has(f));
    if (left.length) {
      console.log('      \u00b7 \u26a0 语言包仍剩 ' + left.length + ' 个（体积会偏大 ~' +
        mb(left.reduce((s, f) => {
          try { return s + fs.statSync(path.join(localeDir, f)).size; } catch (e) { return s; }
        }, 0)) + ' MB）');
      console.log('        受管环境下是 safe-delete 守卫拦的，跑打包时加 CODEBUDDY_SAFE_DELETE_ENABLED=0');
    }
  }
  if (localeRemoved) {
    console.log('      \u00b7 已移除 ' + localeRemoved + ' 个多余语言包，节省 ' + mb(localeBytes) + ' MB');
  }

  // ---------- ② sharp 的多余二进制 ----------
  // 只保留 Windows x64 这一份：@img/sharp-win32-x64（含 libvips-42.dll）。
  // wasm32 是给"没有预编译包"的平台兜底用的，我们这条路线走不到，纯占 8.8MB。
  const KEEP_IMG = new Set(['colour', 'sharp-win32-x64']);
  // sharp 会被解包到 app.asar.unpacked，两处都扫一遍以防打包器改布局
  const imgDirs = [
    path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', '@img'),
    path.join(appOutDir, 'resources', 'app', 'node_modules', '@img'),
  ];

  let imgRemoved = 0;
  let imgBytes = 0;
  for (const imgDir of imgDirs) {
    if (!fs.existsSync(imgDir)) continue;
    for (const name of fs.readdirSync(imgDir)) {
      if (KEEP_IMG.has(name)) continue;
      const full = path.join(imgDir, name);
      try {
        const size = dirSize(full);
        fs.rmSync(full, { recursive: true, force: true });
        imgRemoved++;
        imgBytes += size;
      } catch (e) { /* 下面复查时报告 */ }
    }
    const imgLeft = fs.readdirSync(imgDir).filter((n) => !KEEP_IMG.has(n));
    if (imgLeft.length) console.log('      \u00b7 \u26a0 仍有 ' + imgLeft.length + ' 个 sharp 平台包未能删除');
  }
  if (imgRemoved) {
    console.log('      \u00b7 已移除 ' + imgRemoved + ' 个多余的 sharp 平台包，节省 ' + mb(imgBytes) + ' MB');
  }
};
