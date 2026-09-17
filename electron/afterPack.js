// 打包后瘦身。两件事：
//   ① Electron 默认带 55 种语言的 pak（共 ~41MB），应用只用得到中英，删掉其余 → 省 ~39MB
//   ② sharp 会连非本平台 / 用不上的备用二进制一起装进来（@img/sharp-wasm32 8.8MB 等），删掉
//
// 注意 Catalina 之后的 macOS 签名要求 locales 完整性 —— 本项目只发 Windows，无此顾虑。
exports.default = async function (context) {
  const fs = require('fs');
  const path = require('path');
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
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        fs.unlinkSync(full);
        localeRemoved++;
        localeBytes += st.size;
      } catch (e) { /* 删不掉就算了，不影响打包结果 */ }
    }
  }
  if (localeRemoved) {
    console.log('      \u00b7 已移除 ' + localeRemoved + ' 个多余语言包，节省 ' +
      Math.round(localeBytes / 1024 / 1024) + ' MB');
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

  const dirSize = (d) => {
    let total = 0;
    for (const f of fs.readdirSync(d)) {
      const full = path.join(d, f);
      const st = fs.statSync(full);
      total += st.isDirectory() ? dirSize(full) : st.size;
    }
    return total;
  };

  let imgRemoved = 0;
  let imgBytes = 0;
  for (const imgDir of imgDirs) {
    if (!fs.existsSync(imgDir)) continue;
    for (const name of fs.readdirSync(imgDir)) {
      if (KEEP_IMG.has(name)) continue;
      const full = path.join(imgDir, name);
      try {
        const size = fs.statSync(full).isDirectory() ? dirSize(full) : fs.statSync(full).size;
        fs.rmSync(full, { recursive: true, force: true });
        imgRemoved++;
        imgBytes += size;
      } catch (e) { /* 忽略 */ }
    }
  }
  if (imgRemoved) {
    console.log('      \u00b7 已移除 ' + imgRemoved + ' 个多余的 sharp 平台包，节省 ' +
      Math.round(imgBytes / 1024 / 1024) + ' MB');
  }
};
