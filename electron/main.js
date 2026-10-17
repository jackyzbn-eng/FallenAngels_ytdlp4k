// Fallen Angels Electron 主进程
// 职责：创建窗口、加载前端、提供 IPC 接口给渲染进程（下载/环境检测/配置/皮肤）
const { app, BrowserWindow, ipcMain, dialog, session, clipboard, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');   // 预览播放器要用 file:// 地址喂 <video>
const { spawn, execSync, execFileSync } = require('child_process');

// 防御：ELECTRON_RUN_AS_NODE=1 会让 electron 退化成纯 Node 模式（不建窗口、把参数当模块路径），
// 报错形如 "Unable to find Electron app at ..." / "Cannot find module '<dir>\1'"，极难定位。
// 某些宿主软件（如 Electron 写的 IDE / Agent 客户端）会把该变量注入子进程。
// 这里主动拦下并给出人话提示，而不是抛 TypeError。
if (!app || typeof app.disableHardwareAcceleration !== 'function') {
  console.error(
    '[Fallen Angels] 启动失败：检测到 ELECTRON_RUN_AS_NODE 环境变量，进程退化为 Node 模式。\n' +
    '请在命令行执行 set "ELECTRON_RUN_AS_NODE=" （或清空该变量）后重新启动。'
  );
  process.exit(1);
}

/* ---------- 显示相关的启动开关（都必须在 app ready 之前设置） ----------

   设计原则：**默认不给所有人的电脑打补丁，只在真的出过问题的那台机器上启用。**
   原因：下面这两个开关能治好"窗口根本不出来"，但代价是把风险转嫁给整机 ——
   比如 in-process-gpu 会让显卡出问题时连主进程一起带走（用户看到的是"软件闪退"），
   而标准模式下显卡崩了只是界面重载一下。别人的电脑不一定有我们那台机器的毛病，
   所以一律先按标准模式起，起不来才降级。

   降级机制：一个"启动中"标记文件。
     · 启动时写标记 → 稳定跑满 12 秒就删掉
     · 下次启动若发现标记还在 ⇒ 上次启动没跑稳 ⇒ 这次升一级
     · 正常退出（含开完就秒关）在 will-quit 里清标记，避免误判（这个坑实测踩到过）
     · 升到 L3 就封顶，不再往上加 —— 到顶还跑不稳就是别的毛病了
   四级，每级治一种病：
     L0 标准                  → 默认，所有人的电脑都先走这条
     L1 +no-sandbox           → 治"渲染进程被杀、窗口一片空白"
     L2 L1 +in-process-gpu    → 治"GPU 子进程起不来、窗口不出现"
     L3 L2 +关硬件加速        → 治"GPU 整体不稳、连并进主进程都救不了"
   标记文件里记下已经升到哪一级，逐级升而不是一步到位用最猛的。

   本机实测（2026-09-26）：标准模式下 GPU 子进程零崩溃、WebGL2 正常、
   玻璃皮肤流体正常，连跑 3 次全成功 —— 所以本机现在走的也是标准模式。
   ⚠️ 但注意：**这台机器上 no-sandbox 其实是必需的**（清掉标记后纯标准模式会被 SIGTERM 杀掉），
   所以本机跑一轮下来通常停在 L1。给别人用时不该复制这个结论 —— 别人的机器没这毛病，
   从 L0 起就是对的，起不来它会自己降级。 */

function startFlagPath() {
  try { return path.join(app.getPath('userData'), 'starting.flag'); } catch (e) { return ''; }
}

/* 读上次的启动结果，决定这次用哪一档。
   标记文件里存的是数字等级；返回 0~3，含义见下面 COMPAT_LEVEL 的注释。
   逐级升，到顶（3）就不再往上加 —— 到顶还跑不稳就是别的毛病了，
   继续"降级"没有意义，只会让用户每次都从零走一遍。 */
function gpuCompatMode() {
  const flag = startFlagPath();
  if (!flag) return 0;
  try {
    if (fs.existsSync(flag)) {
      // 上次没跑稳：读它记录到过哪一级，这次再升一级
      let prev = 0;
      try { prev = parseInt(fs.readFileSync(flag, 'utf8'), 10) || 0; } catch (e) { prev = 0; }
      const level = Math.min(prev + 1, 3);
      fs.writeFileSync(flag, String(level));
      return level;
    }
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, '0');
    // 跑满 12 秒就说明启动这关过了，标记撤掉：之后再怎么崩也不算"启动失败"，
    // 不会因为一次运行中的崩溃就把用户永久打进兼容模式
    setTimeout(() => { try { fs.unlinkSync(flag); } catch (e) { /* 已经删了 */ } }, 12000);
  } catch (e) { /* 写不了标记就算了，按正常模式来 */ }
  return 0;
}

/* 启动档位。逐级递进，每级治一种病，只有前面的都没治好才升到下一级：
     L0 标准                  —— 默认，所有人的电脑都先走这条
     L1 +no-sandbox           —— 治"渲染进程被杀 → 窗口一片空白"
     L2 +in-process-gpu       —— 治"GPU 子进程起不来 → 窗口压根不出现"
     L3 +关硬件加速           —— 治"GPU 整体不稳 → 连并进主进程都救不了"
   为什么不在 L2 就一起关硬件加速：关掉之后视频预览就播不了 HEVC 了（实测），
   用户素材大量是 HEVC，代价很大。**能少关一级就少关一级。**
   （这部分逻辑跟下面的 gpuCompatMode 配套，改档位时两边要一起看。） */
const COMPAT_LEVEL = gpuCompatMode();

if (COMPAT_LEVEL >= 1) {
  // L1：渲染进程沙箱。
  // 某些机器上渲染进程会被系统直接杀掉（render-process-gone: reason="killed" exitCode=1），
  // 表现是应用打开了却一片空白。本应用只加载本地 file:// 页面、不加载远程内容，攻击面很小。
  app.commandLine.appendSwitch('no-sandbox');
}

if (COMPAT_LEVEL >= 2) {
  // L2：GPU 逻辑并进主进程。
  // GPU 子进程起不来时 Chromium 会连试 6 次然后 FATAL 自杀（"GPU process isn't usable. Goodbye."，
  // 退出码 2147483651），窗口根本不出现、也没有任何 JS 报错。并进主进程就没有那个会崩的独立进程了。
  // ⚠️ 代价：显卡出问题时会把主进程一起带走（用户看到"闪退"而不是"界面重载"），
  //    所以**只在上一级也没治好时才用**，不要默认打开。
  app.commandLine.appendSwitch('in-process-gpu');
}

// L3：彻底关硬件加速。
// **开着才能播 HEVC** —— 实测（2026-09-17）：
//   硬件加速开 → HEVC 竖屏 .mov 正常 loadedmetadata 1080×1920，能播；
//   硬件加速关 → HEVC 报 DEMUXER_ERROR_COULD_NOT_OPEN，H.264 也只解出 0×0。
// 代价：视频预览播不了 HEVC，前端会退到"用系统播放器打开"（PotPlayer/VLC/MPV）。
// 所以这是最后手段 —— 只有前三档都没让它跑稳才走到这里。
const HW_DISABLED = COMPAT_LEVEL >= 3;
if (HW_DISABLED) app.disableHardwareAcceleration();

// ---------- 路径定位（与 core.py / envcheck.py 对齐） ----------
// appDir：config 落盘目录。开发时=项目根，打包后=exe 所在目录
// resourcesDir：前端 web/ 和 tools/ 所在。开发时=项目根，打包后=resources 目录
function appDir() {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }
  return path.resolve(__dirname, '..'); // 开发时 electron/ 的上一级 = 项目根
}

function resourcesDir() {
  if (app.isPackaged) {
    return process.resourcesPath; // extraResources 落这里
  }
  return path.resolve(__dirname, '..');
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.~write_test');
    fs.writeFileSync(probe, '1');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function dataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const d = path.join(base, 'Fallen Angels');
  // 迁移：旧版（ytdlp4k）目录里的配置，首次启动时搬过来，避免丢设置
  const old = path.join(base, 'ytdlp4k');
  try {
    if (!fs.existsSync(path.join(d, 'config.json')) && fs.existsSync(path.join(old, 'config.json'))) {
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(path.join(old, 'config.json'), path.join(d, 'config.json'));
    }
  } catch (e) {}
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return d;
}

function configPath() {
  const userCfg = path.join(dataDir(), 'config.json');
  const appCfg = path.join(appDir(), 'config.json');

  // 配置一律放用户目录（%APPDATA%\<产品名>\config.json）。
  //
  // ⚠️ 为什么不能放 exe 同目录：NSIS 安装新版本时会先卸载旧版、清空程序目录，
  // 放在那里的 config.json 会被一起删掉 —— 用户表现为「换个版本，
  // 之前设的保存路径全没了」。这是实测确认过的（2026-10-12）。
  //
  // 兼容早期版本（那时配置确实写在 exe 同目录）：用户目录还没有配置时搬过来，
  // 保证老用户升级后设置不丢。
  if (!fs.existsSync(userCfg) && fs.existsSync(appCfg)) {
    try {
      fs.mkdirSync(path.dirname(userCfg), { recursive: true });
      fs.copyFileSync(appCfg, userCfg);
    } catch (e) { /* 迁移失败就退回 exe 同目录那份 */ }
  }
  if (fs.existsSync(userCfg)) return userCfg;

  // 兜底：用户目录不可写（受限环境）时退回 exe 同目录
  if (writable(appDir())) return appCfg;
  return userCfg;
}

function toolDirs() {
  const dirs = [path.join(resourcesDir(), 'tools')];
  // 用户数据目录（Program Files 只读回退）
  dirs.push(path.join(dataDir(), 'tools'));
  return dirs;
}

function win(name) {
  return name.endsWith('.exe') ? name : name + '.exe';
}

function findTool(name) {
  for (const td of toolDirs()) {
    for (const base of [path.join(td, 'ffmpeg', 'bin'), td]) {
      const cand = path.join(base, win(name));
      if (fs.existsSync(cand)) return cand;
    }
  }
  // PATH 查找
  try {
    const raw = execSync('where ' + name, { encoding: 'utf-8', timeout: 2000, windowsHide: true });
    // 注意：Windows 的 where 输出是 CRLF，按 \n 切会把行尾的 \r 留在路径里，
    // 导致 existsSync 失败（曾因此让 PO Token 功能被静默判定为不可用）。
    const first = String(raw).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return first;
  } catch (e) {}
  return null;
}

function findYtdlpKernel() {
  return findTool('yt-dlp');
}

function findJsRuntime() {
  const localDeno = findTool('deno');
  if (localDeno) return { name: 'deno', path: localDeno };
  const node = findTool('node');
  if (node) return { name: 'node', path: node };
  return null;
}

// ---------- PO Token 支持（解年龄限制视频的高清晰度） ----------
// 背景：YouTube 对部分视频（尤其年龄限制的）用 SABR + PO Token 锁住高清晰度，
// 没有 token 时 yt-dlp 最高只能拿到 1080p 级；带 cookies 只能解决"需要登录"，
// 解决不了清晰度。实测某年龄限制视频：无 provider 时最高 1920×1012，
// 装上 provider 后同一视频可拿到 3840×2026（2160p）。
//
// 实现用的是 bgutil-ytdlp-pot-provider（GPL-3.0）：
//   - 插件 zip 放在 tools/yt-dlp-plugins/，用 --plugin-dirs 加载
//   - 生成器脚本在 tools/bgutil/server/build/generate_once.js（Node 运行）
//   - 只能走 Node：生成器要用 axios + ProxyAgent 走系统代理，而 Deno 的 HTTP 栈
//     不支持代理（实测直连 YouTube 必然失败）。所以 provider 优先级更高的
//     deno 版本被我们通过"不打包 src/generate_once.ts"排除掉了。
// 若系统没有 Node，则完全不启用这套东西（避免每次白等 20 秒超时）。
//
// ⚠️ 生成器还依赖 canvas（bgutils-js 用它模拟浏览器 DOM 环境）。
//    实测缺了它 PO Token 会**静默失效**，表现为「某些视频只能下到 360p」，
//    日志里只有一行容易被当噪音的 `Not implemented: HTMLCanvasElement's
//    getContext() method` —— 2026-10-14 就是栽在这上面。
//    canvas 是原生模块，npm install 失败时会被静默跳过，所以**更新 bgutil 之后
//    务必确认这个文件存在**：
//      tools/bgutil/server/node_modules/canvas/build/Release/canvas.node
//    缺失就补装：cd tools/bgutil/server && npm install canvas
function potServerHome() {
  return path.join(resourcesDir(), 'tools', 'bgutil', 'server');
}

function potPluginDir() {
  return path.join(resourcesDir(), 'tools', 'yt-dlp-plugins');
}

// 上一次 potArgs() 判定为不可用的原因（供日志说明用，避免"为什么没 4K"全靠猜）
let potDisabledReason = '';

// 返回 PO Token 相关的 yt-dlp 参数；不可用时返回空数组（行为与以前完全一致）
function potArgs() {
  const script = path.join(potServerHome(), 'build', 'generate_once.js');
  if (!fs.existsSync(script)) {
    potDisabledReason = '缺少生成器脚本 ' + script;
    return [];
  }
  if (!fs.existsSync(potPluginDir())) {
    potDisabledReason = '缺少插件目录 ' + potPluginDir();
    return [];
  }
  // 生成器需 Node 运行；缺了就不启用，免得每次白等 20 秒超时
  if (!findTool('node')) {
    potDisabledReason = '未找到 Node（PO Token 生成器需要 Node 22+，请安装 Node.js）';
    return [];
  }
  potDisabledReason = '';
  return [
    '--plugin-dirs', potPluginDir(),
    '--extractor-args', 'youtubepot-bgutilscript:server_home=' + potServerHome(),
  ];
}

// PO Token 是否可用（决定重试策略：可用时不使用会把清晰度封顶的备用客户端）
function potReady() {
  return potArgs().length > 0;
}

// ---------- 浏览器 Cookies ----------
// Firefox：不能只写 --cookies-from-browser firefox 让 yt-dlp 自己挑。
// profiles.ini 里带 Default=1 的 profile 可能是空的（无 cookies.sqlite），
// yt-dlp 会直接报 "could not find firefox cookies database"。
// 这里主动扫一遍，挑 cookies.sqlite 最新鲜的那个（= 最近实际在用的 profile）。
function findFirefoxProfile() {
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const bases = [
    path.join(roaming, 'Mozilla', 'Firefox', 'Profiles'),
    path.join(local, 'Packages', 'Mozilla.Firefox_n80bbvh6b1yt2',
      'LocalCache', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
  ];
  const cands = [];
  for (const base of bases) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { continue; }
    for (const name of names) {
      const d = path.join(base, name);
      const ck = path.join(d, 'cookies.sqlite');
      try {
        if (fs.statSync(ck).isFile()) cands.push({ mtime: fs.statSync(ck).mtimeMs, dir: d });
      } catch (e) { /* 无 cookies.sqlite 的 profile，跳过 */ }
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0].dir;
}

// 返回可直接追加到 args 的 cookies 参数；不需要时返回 []
// 注意：Chrome/Edge 在 v127+ 启用了 App-Bound Encryption，--cookies-from-browser 会
// 报 "Failed to decrypt with DPAPI"，yt-dlp 官方也无法绕过（issue #10927）。
// 所以这两家只能走「导出 cookies.txt」的路子，见 cookiesFile()。
function cookieArgs() {
  const b = String(cfg.cookies_browser || '').trim();
  if (!b || b === 'off') return [];

  if (b === 'firefox') {
    const prof = findFirefoxProfile();
    if (!prof) return [];
    return ['--cookies-from-browser', 'firefox:' + prof];
  }
  if (b === 'chrome' || b === 'edge') {
    // 优先用导出文件；没有就退回直读（老版本 Chrome 仍可能成功）
    const f = userCookiesFile();
    if (f) return ['--cookies', f];
    return ['--cookies-from-browser', b];
  }
  return ['--cookies-from-browser', b];
}

// ---------- 用户导入的 cookies.txt（Chrome/Edge 唯一可行路径） ----------
function userCookiesFile() {
  const f = path.join(dataDir(), 'cookies.txt');
  try { return fs.statSync(f).size > 0 ? f : null; } catch (e) { return null; }
}

// Chrome 系是否真的能直读（老版本可以，v127+ 不行）——用于给界面提示
function chromeAppBoundEncryptionLikely() {
  // Chrome v127 于 2024-07 发布，v127+ 基本都启用了 App-Bound Encryption
  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application'),
  ];
  for (const b of bases) {
    try {
      const vers = fs.readdirSync(b)
        .map((v) => parseInt(v.split('.')[0], 10))
        .filter((n) => !isNaN(n));
      if (vers.some((v) => v >= 127)) return true;
    } catch (e) { /* 未安装 */ }
  }
  return false;
}

// ---------- 结果缓存（记住成功过的组合，下次优先复用） ----------
// 目的：年龄限制 / 会员内容第一次试错较贵，成功后不再重复试。
const CACHE_TTL = 7 * 24 * 3600 * 1000;   // 7 天

function cachePath() {
  return path.join(dataDir(), 'download-cache.json');
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf-8')) || {};
  } catch (e) {
    return {};
  }
}

function saveCache(c) {
  try { fs.writeFileSync(cachePath(), JSON.stringify(c, null, 2)); } catch (e) {}
}

// 把 URL 归一到稳定的缓存键（去掉 playlist / 时间戳等易变参数）
function cacheKey(url) {
  const m = String(url).match(/[?&]v=([\w-]{6,})/);
  if (m) return 'yt:' + m[1];
  const s = String(url).match(/youtu\.be\/([\w-]{6,})/);
  if (s) return 'yt:' + s[1];
  return 'url:' + String(url).slice(0, 120);
}

function getCached(key) {
  const c = loadCache()[key];
  if (!c) return null;
  if (Date.now() - (c.ts || 0) > CACHE_TTL) return null;
  return c;
}

// 缓存记两件事：
//   cookies —— 上次是否需要登录态
//   auth    —— 上次"需要 cookies"是不是**鉴权失败**造成的
// 这个区分很关键（2026-10-14 实测踩的坑）：带上 cookies 会让 YouTube 的
// **账号级 SABR 实验**生效，默认客户端只给 360p；不带 cookies 反而能拿 4K。
// 所以只有**确实因为鉴权失败**才值得用 cookies。其它原因（网络抖动、PO Token
// 生成失败等）造成的 cookies 记录属于误判 —— 下次必须先用"不带 cookies"重试，
// 否则清晰度会被永久压到 360p（且看起来"下载成功"，毫无报错）。
function setCached(key, cookies, authNeeded) {
  const all = loadCache();
  all[key] = { cookies: !!cookies, auth: !!authNeeded, ts: Date.now() };
  saveCache(all);
}

// 读系统代理：用 Chromium 自带的代理解析（跟随 Windows 设置，不调外部命令，无卡死风险）
async function getSystemProxy() {
  try {
    const result = await session.defaultSession.resolveProxy('https://www.youtube.com');
    // Chromium 返回形如 "PROXY 127.0.0.1:7897; DIRECT" / "SOCKS5 127.0.0.1:1080" / "DIRECT"
    const m = result.match(/\b(PROXY|HTTPS|SOCKS5|SOCKS4|SOCKS)\s+([^\s;]+)/i);
    if (!m) {
      return { url: '', msg: '直连（系统未设置代理）' };
    }
    const kind = m[1].toUpperCase();
    const hostport = m[2];
    let url;
    if (kind === 'PROXY') url = 'http://' + hostport;
    else if (kind === 'HTTPS') url = 'https://' + hostport;
    else if (kind === 'SOCKS4') url = 'socks4://' + hostport;
    else url = 'socks5://' + hostport;   // SOCKS / SOCKS5
    return { url, msg: '系统代理: ' + url };
  } catch (e) {
    return { url: '', msg: '直连（读取系统代理失败）' };
  }
}

// ---------- 默认配置（与 core.py 对齐） ----------
const DEFAULT_CONFIG = {
  skin: 'dark-linear',
  proxy_mode: 'system',   // system / manual / direct
  proxy: '',
  cookies_browser: 'firefox',
  lastdir_file: '~/.fallen_angels_lastdir.txt',
  default_fps: '0',
  quality: '4K',
  // 在线更新源。留空 = 用代码里的默认值（GitHub Release 的固定入口）。
  // 换成自己的 R2 / CDN 时，改这里或界面上那个输入框即可，不用重新打包。
  update_url: '',
  // 三个下载页各有自己的分类列表，所以 dirs 按来源分组
  dirs: {
    yt: [{ name: '1080P', path: '' }, { name: '4K', path: '' }],
    social: [{ name: '社媒', path: '' }],
    direct: [{ name: '直链', path: '' }],
  },
  // 图片压缩页的设置（记住上次选择）
  img_quality: '中',
  img_format: 'keep',
  img_maxedge: 0,
  img_outmode: 'sub',
  img_outdir: '',
  // 封面图下载页的保存目录。跟视频/图片都分开存 —— 封面是"素材"性质，
  // 混进视频目录会越攒越乱（用户 2026-09-29 拍板：单独一个目录）
  cover_dir: '',
  // 玻璃皮肤的背景流体要吃 GPU。老核显 / 远程桌面 / 笔记本省电模式下会拖慢界面，
  // 所以留一个手动档位；auto = 自己探测掉帧后降档（见 web/ui/fluid.js 的 PERF_TIERS）
  perf_tier: 'auto',   // auto / high / low
  // 外部播放器的手动指定路径（空 = 让程序自动找）。自动找有三条路（注册表 / 标准路径 /
  // 系统默认），但在"reg.exe 被杀软拦 + 播放器装在冷门目录"的机器上会全都落空，
  // 这时靠用户手填一个路径就一定能兜住。
  external_player: '',
  // 视频处理页的设置
  video: {
    mode: 'trim',
    quality: '中',
    encoder: 'hevc_nv',
    maxHeight: 0,
    audio: 'copy',
    container: 'mp4',
    outMode: 'same',
    outDir: '',
    start: '0:00:00.000',
    end: '',
  },
};

// 分类列表结构升级：老配置里 dirs 是数组（只有一份，油管与社媒共用）。
// 直接把它当作油管的那份，社媒给一个空列表，用户自己加。
function normalizeDirs(cfg) {
  const d = cfg.dirs;
  if (Array.isArray(d)) {
    // 老配置：数组里通常就是 1080P / 4K 这类分类名，原样留给油管页
    cfg.dirs = {
      yt: d,
      social: [{ name: '社媒', path: '' }],
      direct: [{ name: '直链', path: '' }],
    };
  } else if (!d || typeof d !== 'object') {
    cfg.dirs = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs));
  } else {
    if (!Array.isArray(d.yt)) d.yt = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs.yt));
    if (!Array.isArray(d.social)) d.social = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs.social));
    if (!Array.isArray(d.direct)) d.direct = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs.direct));
  }
  for (const k of ['yt', 'social', 'direct']) {
    for (const item of cfg.dirs[k]) {
      // 老配置里分类名存在 label 字段（如 1080P / 4K），name 会是个占位值。
      // 迁移时以 label 为准，否则「1080P / 4K」会被冲成「分类 / 分类」。
      if (item.label && (!item.name || item.name === '分类')) item.name = item.label;
      if (!item.name) item.name = item.label || '分类';
      if (!item.path) item.path = '';
    }
  }
  return cfg;
}

const QUALITY = {
  '原画': 'bv*+ba/b',
  '4K': 'bv*[height<=2160]+ba/b[height<=2160]',
  '1080P': 'bv*[height<=1080]+ba/b[height<=1080]',
  '720P': 'bv*[height<=720]+ba/b[height<=720]',
};

// 各画质档位对应的目标高度（0 = 不设上限），用于下载后核对是否真的拿到了该清晰度
const QUALITY_HEIGHT = { '原画': 0, '4K': 2160, '1080P': 1080, '720P': 720 };

// 社媒站（抖音 / 小红书 / B站 / 微博 / TikTok）没有油管那样的清晰度分档，
// 也不存在 4K 上限可言 —— 一律取平台能提供的最好那一档（等价于「原画」）。
const SOCIAL_FMT = 'bv*+ba/b';

function loadConfig() {
  const cp = configPath();
  if (!fs.existsSync(cp)) {
    try { fs.writeFileSync(cp, JSON.stringify(DEFAULT_CONFIG, null, 2)); } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(cp, 'utf-8'));
    for (const k in DEFAULT_CONFIG) if (!(k in cfg)) cfg[k] = DEFAULT_CONFIG[k];
    return normalizeDirs(cfg);
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) {}
}

// 各套皮肤对应的窗口底色。玻璃皮肤的面板是半透明的，底下的窗口底色会透出来，
// 所以换皮肤时要同步把窗口底色换掉，否则会出现"深底套浅面板"的串色。
// 玻璃四套的底色就是各自流体配色的 colors[0]（纯黑/近黑，不是深蓝）。
const SKIN_WINDOW_BG = {
  'light-cindy': '#f8f8f6',
  'light-workbuddy': '#f5f6f7',
  'dark-linear': '#08090a',
  'light-motrix': '#eef4ff',
  'dark-neon': '#0b0d12',
  'dark-glass': '#000000',
  'glass-aurora': '#020807',
  'glass-amethyst': '#05020b',
  'glass-ember': '#080201',
};

// ---------- 全局状态 ----------
let cfg = loadConfig();
let mainWindow = null;

function createWindow() {
  const htmlPath = path.join(resourcesDir(), 'web', 'index.html');

  mainWindow = new BrowserWindow({
    width: 1020,
    height: 800,
    minWidth: 900,
    minHeight: 660,
    backgroundColor: SKIN_WINDOW_BG[cfg.skin] || '#08090a',
    autoHideMenuBar: true,
    title: 'Fallen Angels - 视频下载器（油管 / 社媒）',
    // 开发模式下用项目内图标；打包后由 exe 资源自带，无需运行时指定
    icon: app.isPackaged ? undefined : path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 窗口底色跟随当前皮肤（玻璃皮肤是半透明面板，底色会从面板后面透出来）
  mainWindow.setBackgroundColor(SKIN_WINDOW_BG[cfg.skin] || '#08090a');

  // 加载前端（复用 web/ 资产）
  mainWindow.loadFile(htmlPath);

  // 标题栏菜单隐藏后，Windows 上关闭按钮正常
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------- 日志推送到前端 ----------
// taskId 用于把日志归属到具体任务；source 决定这条日志进哪个页面的日志框
// （油管页与社媒页各有一个日志框，互不干扰）。
// 传了 taskId 但没传 source 时，自动从任务本身查来源。
function pushLog(text, cls, taskId, source) {
  let src = source || null;
  if (!src && taskId) {
    const t = findTask(taskId);
    if (t && t.opts) src = t.opts.source || 'yt';
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', {
      text, cls: cls || '', taskId: taskId || null, source: src,
    });
  }
}

// ---------- 下载进度推送到前端 ----------
function sendProgress(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress', data);
  }
}

// 解码 yt-dlp 的输出：中文 Windows 上 yt-dlp 输出 GBK，英文环境多为 UTF-8
// 策略：先按 UTF-8 解，出现替换字符(坏字节)则改用 GBK
function decodeOut(buf) {
  const utf8 = buf.toString('utf-8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(buf);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch (e) {
    return utf8;
  }
}

// ---------- 媒体文件属性（用内置 ffmpeg 读取，功能同 MediaInfo） ----------
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

function humanDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/* 用 ffmpeg 代替 ffprobe 读媒体信息。
   理由：ffmpeg 不带输出参数时，会把与 ffprobe 完全相同的 MediaInfo 打到 stderr，
   字段一个不少。而 ffprobe.exe 单独占 98MB —— 为一个只读信息的壳付两倍体积不划算。
   删掉它之后安装包/安装目录各减近 100MB，功能不变。 */
function parseChannels(line) {
  let m = line.match(/\b(mono|stereo)\b/i);
  if (m) return m[1].toLowerCase() === 'mono' ? '单声道' : '立体声';
  m = line.match(/(\d+)\s+channels/i);
  if (m) return m[1] + ' 声道';
  // 5.1 / 7.1 这类环绕布局，ffmpeg 写成 "5.1(side)"
  m = line.match(/,\s*(\d+\.\d)\s*(\([^)]*\))?,/);
  if (m) return m[1] + ' 声道';
  return '-';
}

function parseFfmpegInfo(text, filePath) {
  const lines = text.split(/\r?\n/);
  const pick = (re) => lines.find((l) => re.test(l)) || '';
  const durationLine = pick(/\bDuration:/);
  const videoLine = pick(/Stream #[\d:]+.*?Video:/);
  const audioLine = pick(/Stream #[\d:]+.*?Audio:/);

  // 时长 HH:MM:SS.xx
  let duration = '-';
  const dm = durationLine.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (dm) duration = humanDuration(Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number(dm[3]));

  const bm = durationLine.match(/bitrate:\s*([\d.]+)\s*kb\/s/i);
  const bitrate = bm ? Math.round(Number(bm[1])) + ' kbps' : '-';

  // 容器：ffmpeg 给的是 demuxer 名列表（"mov,mp4,m4a,3gp,3g2,mj2"），对用户不友好；
  // 直接用扩展名反而更准确也更好读（MP4 / MKV / WEBM）
  const container = (path.extname(filePath) || '').replace('.', '').toUpperCase() || '-';

  // ffprobe 的 codec_long_name / ffmpeg 的 "h264 (High)" 都很啰嗦，取简洁名
  const shortCodec = (s) => String(s || '-').split('(')[0].split('/')[0].trim();

  const kb = (m2) => (m2 ? Math.round(Number(m2[1])) + ' kbps' : '-');

  const vc = videoLine.match(/Video:\s*([^,]+)/);
  const resM = videoLine.match(/(\d{2,5})x(\d{2,5})/);
  const fpsM = videoLine.match(/([\d.]+)\s*fps/);
  const vbM = videoLine.match(/([\d.]+)\s*kb\/s/i);

  const ac = audioLine.match(/Audio:\s*([^,]+)/);
  const srM = audioLine.match(/(\d{3,6})\s*Hz/);
  const abM = audioLine.match(/([\d.]+)\s*kb\/s/i);

  let size = '-';
  try { size = humanSize(fs.statSync(filePath).size); } catch (e) {}

  return {
    fileName: path.basename(filePath),
    filePath: filePath,
    size: size,
    duration: duration,
    container: container,
    bitrate: bitrate,
    videoCodec: vc ? shortCodec(vc[1]) : '-',
    resolution: resM ? resM[1] + '×' + resM[2] : '-',
    fps: fpsM ? (Number(fpsM[1]) % 1 === 0 ? fpsM[1] : Number(fpsM[1]).toFixed(2)) + ' fps' : '-',
    videoBitrate: kb(vbM),
    audioCodec: ac ? shortCodec(ac[1]) : '-',
    channels: audioLine ? parseChannels(audioLine) : '-',
    sampleRate: srM ? Number(srM[1]) / 1000 + ' kHz' : '-',
    audioBitrate: kb(abM),
  };
}

function probeFile(filePath) {
  return new Promise((resolve) => {
    const ffmpeg = findTool('ffmpeg');
    if (!ffmpeg) {
      resolve({ ok: false, msg: '未找到 ffmpeg（应位于 tools/ffmpeg/bin）' });
      return;
    }
    // 只给 -i 不给输出文件：ffmpeg 打印完信息就以错误码退出（不会真去转码）
    const args = ['-hide_banner', '-i', filePath];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (b) => { out += decodeOut(b); });
    p.stderr.on('data', (b) => { out += decodeOut(b); });
    p.on('error', (e) => resolve({ ok: false, msg: String(e) }));
    p.on('close', () => {
      if (!/Input #\d+/.test(out)) {
        // 取 ffmpeg 报错的最后一行，比整段天书有用
        const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || '未知错误';
        resolve({ ok: false, msg: '无法读取文件：' + last });
        return;
      }
      try {
        resolve({ ok: true, info: parseFfmpegInfo(out, filePath) });
      } catch (e) {
        resolve({ ok: false, msg: '解析失败: ' + e.message });
      }
    });
  });
}

// 解析 yt-dlp 的进度行，返回 {percent, detail} 或 null
// 典型行：[download]  45.2% of ~ 105.23MiB at  1.23MiB/s ETA 00:22
function parseProgress(line) {
  const m = line.match(/\[download\]\s+(\d+\.?\d*)%/);
  if (!m) return null;
  const percent = parseFloat(m[1]);
  const bits = [];
  const sz = line.match(/of\s+~?\s*([^\s]+)\s/);
  const sp = line.match(/at\s+([^\s]+\/s)/);
  const eta = line.match(/ETA\s+([\d:]+)/);
  if (sz) bits.push(sz[1]);
  if (sp) bits.push(sp[1]);
  if (eta) bits.push('剩余 ' + eta[1]);
  return { percent, detail: bits.join(' · ') };
}

// ---------- IPC 接口 ----------
ipcMain.handle('get_config', () => {
  return {
    version: app.getVersion(),      // 从 package.json 读，打包后为实际版本号
    skin: cfg.skin || 'dark-linear',
    dirs: cfg.dirs || [],
    quality: cfg.quality || '4K',
    default_fps: cfg.default_fps || '0',
    proxy_mode: cfg.proxy_mode || 'system',
    proxy: cfg.proxy || '',
    cookies_browser: cfg.cookies_browser || 'firefox',
    img: {
      quality: cfg.img_quality || '中',
      format: cfg.img_format || 'keep',
      maxEdge: cfg.img_maxedge || 0,
      outMode: cfg.img_outmode || 'sub',
      outDir: cfg.img_outdir || '',
    },
    video: cfg.video || DEFAULT_CONFIG.video,
    perf_tier: cfg.perf_tier || 'auto',
    // 封面图下载页的保存目录。⚠️ 这个 handler 是**白名单式**返回（只挑固定字段），
    //    新加的配置项必须在这里补一行，否则前端读到的永远是 undefined
    //    —— 表现是"选好的目录重启就丢"（2026-09-29 踩到）。
    cover_dir: cfg.cover_dir || '',
  };
});

// 视频处理页的设置：改完即存
ipcMain.handle('save_video_settings', (e, s) => {
  const v = s || {};
  if (!cfg.video) cfg.video = JSON.parse(JSON.stringify(DEFAULT_CONFIG.video));
  for (const k of ['mode', 'quality', 'encoder', 'maxHeight', 'audio', 'container', 'outMode', 'outDir', 'start', 'end']) {
    if (v[k] !== undefined) cfg.video[k] = v[k];
  }
  saveConfig(cfg);
  return true;
});

// 图片压缩页的设置：改完即存，下次打开还是这套
ipcMain.handle('save_img_settings', (e, s) => {
  const v = s || {};
  if (v.quality) cfg.img_quality = v.quality;
  if (v.format) cfg.img_format = v.format;
  if (v.maxEdge !== undefined) cfg.img_maxedge = v.maxEdge;
  if (v.outMode) cfg.img_outmode = v.outMode;
  if (v.outDir !== undefined) cfg.img_outdir = v.outDir;
  saveConfig(cfg);
  return true;
});

ipcMain.handle('set_skin', (e, skin) => {
  cfg.skin = skin;
  saveConfig(cfg);
  // 玻璃皮肤要窗口底色配合，否则半透明面板后面露出的还是上一套皮肤的颜色
  try {
    if (mainWindow) mainWindow.setBackgroundColor(SKIN_WINDOW_BG[skin] || '#08090a');
  } catch (err) { /* 窗口没了就算了，下次启动会按新配置设 */ }
  return true;
});
ipcMain.handle('save_cookies_browser', (e, b) => { cfg.cookies_browser = b; saveConfig(cfg); return true; });

// 设置页用：当前 cookies 来源 + 实际会用的 Firefox profile 名（便于用户确认）
ipcMain.handle('get_cookie_info', () => {
  const b = String(cfg.cookies_browser || 'firefox');
  const hasFile = !!userCookiesFile();
  let detail = '';
  if (b === 'firefox') {
    const prof = findFirefoxProfile();
    detail = prof
      ? 'profile: ' + path.basename(prof)
      : '未找到含 cookies.sqlite 的 Firefox profile';
  } else if (b === 'off') {
    detail = '不使用 cookies（年龄限制视频会下载失败）';
  } else if (b === 'chrome' || b === 'edge') {
    if (hasFile) {
      detail = '已导入 cookies.txt，将使用该文件（推荐方式）';
    } else if (chromeAppBoundEncryptionLikely()) {
      detail = '新版 Chrome/Edge 已加密 cookies，直读会失败。请点右侧「导入 cookies.txt」';
    } else {
      detail = '浏览器需完全退出，否则可能读取失败';
    }
  } else {
    detail = '浏览器需完全退出，否则可能读取失败';
  }
  return { browser: b, detail, hasCookiesFile: hasFile };
});

// ---------- 每个「浏览」按钮各自记路径 ----------
// 为什么自己做：Electron 的 showOpenDialog 在不传 defaultPath 时，**所有弹窗共享同一份
// "上次打开目录"**，于是"选完音乐再选视频"会跳到音乐文件夹 —— 用户明确要求按按钮分开记。
// 存在 dataDir()/last-dirs.json（跟 config 同目录，升级不丢），按 key 各存一个目录。
function lastDirsPath() {
  return path.join(dataDir(), 'last-dirs.json');
}
let lastDirsCache = null;
function loadLastDirs() {
  if (lastDirsCache) return lastDirsCache;
  try { lastDirsCache = JSON.parse(fs.readFileSync(lastDirsPath(), 'utf-8')) || {}; }
  catch (e) { lastDirsCache = {}; }
  return lastDirsCache;
}
function saveLastDirs() {
  try { fs.writeFileSync(lastDirsPath(), JSON.stringify(lastDirsCache || {}, null, 2)); } catch (e) { /* 忽略 */ }
}
// 记住目录（传文件就记它所在的文件夹；目录已被删掉就当没记过，别把弹窗带进死路）
function rememberedDir(key) {
  const d = loadLastDirs()[key];
  if (!d) return '';
  try { if (fs.statSync(d).isDirectory()) return d; } catch (e) { return ''; }
  return '';
}
function rememberDir(key, picked) {
  if (!picked) return;
  const s = String(picked);
  let d = '';
  try {
    d = fs.statSync(s).isDirectory() ? s : path.dirname(s);
  } catch (e) {
    // 路径此刻访问不到（网盘没挂载 / 刚被移走）：按字符串猜一把，
    // 有扩展名就当文件取上级，否则当文件夹。猜错也只是记个目录，不会丢数据。
    d = path.extname(s) ? path.dirname(s) : s;
  }
  if (!d || d === '.') return;
  loadLastDirs()[key] = d;
  saveLastDirs();
}
// 统一入口：key 不同 → 各自记住各自的目录
async function openDialogRemembered(win, key, opts) {
  const o = Object.assign({}, opts);
  const dir = rememberedDir(key);
  if (dir) o.defaultPath = dir;
  const r = await dialog.showOpenDialog(win || mainWindow, o);
  if (!r.canceled && r.filePaths && r.filePaths.length) rememberDir(key, r.filePaths[0]);
  return r;
}

// 导入 cookies.txt（Chrome/Edge 在 v127+ 只能走这条路）
// 支持两类来源：yt-dlp 的 Netscape 格式、以及浏览器扩展导出的同格式文件
ipcMain.handle('import_cookies_file', async () => {
  const r = await openDialogRemembered(mainWindow, 'cookies_txt', {
    title: '选择导出的 cookies.txt',
    filters: [{ name: 'Cookies 文件', extensions: ['txt'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, msg: '已取消' };
  const src = r.filePaths[0];
  try {
    const text = fs.readFileSync(src, 'utf-8');
    // 粗校验：netscape 格式必须含制表符分隔的域名字段
    if (!/\t/.test(text) || !/youtube\.com|google\.com/i.test(text)) {
      return { ok: false, msg: '文件格式不对，或里面没有 YouTube / Google 的 cookie' };
    }
    const dst = path.join(dataDir(), 'cookies.txt');
    fs.writeFileSync(dst, text);
    return { ok: true, msg: '已导入（' + path.basename(src) + '）', path: dst };
  } catch (e) {
    return { ok: false, msg: '读取失败: ' + e.message };
  }
});

ipcMain.handle('has_cookies_file', () => !!userCookiesFile());

ipcMain.handle('clear_cookies_file', () => {
  try {
    const f = path.join(dataDir(), 'cookies.txt');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true };
  } catch (e) {
    return { ok: false, msg: e.message };
  }
});
ipcMain.handle('save_quality', (e, q) => { cfg.quality = q; saveConfig(cfg); return true; });
ipcMain.handle('save_fps', (e, fps) => { cfg.default_fps = fps; saveConfig(cfg); return true; });
ipcMain.handle('save_proxy_mode', (e, mode) => { cfg.proxy_mode = mode; saveConfig(cfg); return true; });
// 手动代理地址：改完就存，不用等下一次下载（设置页承诺"即时生效并自动保存"）
ipcMain.handle('save_proxy', (e, addr) => { cfg.proxy = String(addr || '').trim(); saveConfig(cfg); return true; });
// 把「跟随系统」实际解析到的代理告诉界面 —— 免得用户只知道选了"跟随系统"却不知道走的哪个端口
ipcMain.handle('get_system_proxy', async () => {
  try {
    const r = await getSystemProxy();   // 返回 { url, msg }
    return { ok: true, url: (r && r.url) || '', msg: (r && r.msg) || '' };
  } catch (err) {
    return { ok: false, url: '', msg: String(err && err.message ? err.message : err) };
  }
});
ipcMain.handle('save_dirs', (e, dirs) => { cfg.dirs = dirs; saveConfig(cfg); return true; });

ipcMain.handle('pick_folder', async (e, title, key) => {
  // key 决定"记哪个槽"；不传就按标题兜底（标题相同 = 视为同一个用途）
  const k = String(key || title || 'folder');
  const r = await openDialogRemembered(mainWindow, 'folder:' + k, {
    title: String(title || '选择下载文件夹'),
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return '';
  return r.filePaths[0];
});

// 把日志复制到系统剪贴板（用 Electron clipboard，比渲染进程 navigator.clipboard 可靠）
ipcMain.handle('copy_text', (e, text) => {
  try {
    clipboard.writeText(String(text == null ? '' : text));
    return true;
  } catch (err) {
    return false;
  }
});

// 读剪贴板文本（「从剪贴板粘贴」按钮用，方便一次贴进多个链接）
ipcMain.handle('read_clipboard', () => {
  try {
    return clipboard.readText() || '';
  } catch (err) {
    return '';
  }
});

// 用系统默认程序打开文件（下载完的视频 → 播放）
ipcMain.handle('open_file', async (e, filePath) => {
  try {
    const err = await shell.openPath(String(filePath || ''));
    return err ? { ok: false, msg: err } : { ok: true };
  } catch (err) {
    return { ok: false, msg: String(err) };
  }
});

// 预览素材（给「音视频拼接」列表和音乐用的播放按钮）。
// ⚠️ 优先用自带解码器的外部播放器（PotPlayer/VLC/MPV）——4K HEVC 交给系统默认播放器
//    很可能直接放不了（缺 HEVC 扩展），"确认素材"这个目的就落空了。都没有才退回系统默认。
ipcMain.handle('preview_file', async (e, filePath) => {
  const f = String(filePath || '');
  try { fs.accessSync(f); } catch (err) { return { ok: false, msg: '文件读不到了' }; }
  const pl = findExternalPlayer();
  if (pl && pl.exists) {
    try {
      const child = spawn(pl.path, [f], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, via: pl.name };
    } catch (err) { /* 播放器起不来就退回系统默认 */ }
  }
  try {
    const err = await shell.openPath(f);
    return err ? { ok: false, msg: err } : { ok: true, via: '系统默认' };
  } catch (err) {
    return { ok: false, msg: String(err) };
  }
});

// 用系统浏览器打开网址（更新发布页这类）
ipcMain.handle('open_url', async (e, url) => {
  const u = String(url || '');
  if (!/^https?:\/\//i.test(u)) return { ok: false, msg: '不是有效的网址' };
  try { await shell.openExternal(u); return { ok: true }; }
  catch (err) { return { ok: false, msg: String(err) }; }
});

// 在资源管理器中定位文件
ipcMain.handle('show_in_folder', (e, filePath) => {
  try {
    shell.showItemInFolder(String(filePath || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, msg: String(err) };
  }
});

// 读取媒体文件属性（ffmpeg）
ipcMain.handle('probe_file', (e, filePath) => probeFile(String(filePath || '')));

ipcMain.handle('get_components', () => {
  const comps = [
    { tool: 'ytdlp', name: 'yt-dlp 下载内核', desc: '油管与社媒共用的解析核心，自带 tools/yt-dlp.exe' },
    { tool: 'ffmpeg', name: 'FFmpeg', desc: '音视频合并、转码与读取媒体属性' },
    { tool: 'deno', name: 'deno (JS 运行时)', desc: '解 YouTube JS challenge（必需）' },
    { tool: 'sharp', name: '图片压缩内核 (sharp)', desc: '图片压缩页使用，基于 libvips，随应用一起分发' },
  ];
  return comps.map((c) => {
    const found = c.tool === 'ytdlp' ? findYtdlpKernel()
      : (c.tool === 'sharp' ? !!getSharp() : findTool(c.tool));
    const extra = c.tool === 'sharp' && !found && _sharpErr ? '（' + _sharpErr + '）' : '';
    return { name: c.name, desc: c.desc + extra, ok: !!found, status: found ? '已就绪' : '缺失' };
  });
});

// ---------- 下载任务队列 ----------
// 设计目标：像下载工具那样「随时追加」——不关心当前有没有任务在跑，
// 想起一个就丢一个进来，队列自己调度；也能一次性丢一批。
// CONCURRENCY = 3：每个来源（油管 / 社媒）各自最多 3 个 yt-dlp 并行。
// 两边是独立的调度器，互不抢坑位 —— 同时下两边最多 6 个并行。
const CONCURRENCY = 3;

let taskSeq = 0;
const tasks = [];          // 全部任务（含已完成），供前端查询
// 等待队列与在跑计数都按来源分开 —— 油管与社媒是两套独立调度器，
// 各自 CONCURRENCY=3，谁也不会把对方的坑位占掉。
const pendingBySource = { yt: [], social: [], direct: [] };
const runningBySource = { yt: 0, social: 0, direct: 0 };

// 「停止全部」的标记按来源分开 —— 油管页点停止不该把社媒的任务也停掉。
const stoppedBySource = { yt: false, social: false, direct: false };
const srcOf = (t) => (t && t.opts && t.opts.source) || 'yt';

const procs = new Map();        // taskId -> Set<ChildProcess>，用于真停
const cancelledTasks = new Set(); // 被用户取消的任务 id

function findTask(id) { return tasks.find((t) => t.id === id); }

// URL 归一化：同一个视频的不同写法（watch?v= / youtu.be / shorts / 纯 ID）视为同一任务，
// 避免"想起一个丢一个"时同一个视频被重复排进队列。
function normUrl(u) {
  const s = String(u || '').trim();
  const m = s.match(/(?:v=|\/shorts\/|\/embed\/|\/live\/|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  if (m) return 'yt:' + m[1];
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return 'yt:' + s;
  return s.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

// 记录某任务正在跑的进程，便于「取消/停止」时真正杀掉
function registerProc(taskId, proc) {
  if (!taskId) return;
  if (!procs.has(taskId)) procs.set(taskId, new Set());
  procs.get(taskId).add(proc);
  const drop = () => {
    const s = procs.get(taskId);
    if (s) { s.delete(proc); if (!s.size) procs.delete(taskId); }
  };
  proc.on('close', drop);
  proc.on('error', drop);
}

function killTaskProcs(taskId) {
  const s = procs.get(taskId);
  if (!s) return 0;
  let n = 0;
  for (const p of s) {
    try {
      // Windows 上 proc.kill() 只杀 yt-dlp 本身，它拉起的 ffmpeg 会变孤儿继续占 CPU/磁盘。
      // 用 taskkill /T 连子进程一起收掉；taskkill 不可用时退回 proc.kill()。
      if (process.platform === 'win32' && p.pid) {
        const killer = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
        killer.on('error', () => { try { p.kill(); } catch (_) { /* 已退出 */ } });
      } else {
        p.kill();
      }
      n++;
    } catch (_) { /* 已退出 */ }
  }
  return n;
}

// 把任务快照推给前端（不含 proc 等不可序列化字段）
function taskSnapshot(t) {
  return {
    id: t.id, seq: t.seq || 0, url: t.url, title: t.title || '',
    state: t.state, percent: t.percent || 0,
    detail: t.detail || '', file: t.file || '', msg: t.msg || '',
    res: t.res || '',   // 下载完成后核对出的真实分辨率，如 3840×2160
    fps: t.fps || 0,    // 下载完成后核对出的真实帧率 —— 队列行据此决定要不要给「降为30fps」按钮
    fpsOut: t.fpsOut || '',   // 已转过 30 帧的话，记下产物路径（按钮转为「已降帧」）
    source: (t.opts && t.opts.source) || 'yt',   // yt / social —— 队列是共享的，标出来才知道来自哪一页
  };
}

function pushTaskUpdate(t) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('task-update', taskSnapshot(t));
  }
}

// 向队列添加任务。
// 不检查"当前有没有在跑" —— 随时可加，加进来就排队，有坑位立刻开跑。
// 只跳过「已在队列中且未结束」的同一视频，返回 { created, skipped }。
function enqueueTasks(urls, opts) {
  const src = srcOf({ opts });   // opts.source
  const active = new Set();
  for (const t of tasks) {
    if (t.state === 'queued' || t.state === 'running') active.add(normUrl(t.url));
  }

  const created = [];
  const skipped = [];
  for (const u of urls) {
    const key = normUrl(u);
    if (active.has(key)) { skipped.push(u); continue; }
    active.add(key);

    const seq = ++taskSeq;
    const t = {
      id: 't' + seq,
      seq,   // 稳定序号（tasks.length 会随"随时追加"变化，不能用来编号）
      url: u,
      title: '',
      state: 'queued',
      percent: 0,
      detail: '等待中…',
      file: '',
      msg: '',
      opts,
    };
    tasks.push(t);
    pendingBySource[src].push(t.id);
    created.push(t.id);
    pushTaskUpdate(t);
  }

  stoppedBySource[src] = false;   // 一旦有新任务进来，解除该来源的"停止"状态
  pumpQueue(src);
  return { created, skipped };
}

// 调度：按来源独立调度，有坑位就取下一个任务执行。
// 油管与社媒各占各的并发额度，一边排满不影响另一边。
function pumpQueue(src) {
  const pending = pendingBySource[src];
  if (!pending) return;
  while (runningBySource[src] < CONCURRENCY && pending.length) {
    const id = pending.shift();
    const t = findTask(id);
    if (!t || t.state !== 'queued') continue;
    // 该来源被点了「停止全部」——跳过（stop_all 已经把它们标记成已取消，这里只是兜底）
    if (stoppedBySource[src]) continue;
    runningBySource[src]++;
    runTask(t).finally(() => {
      runningBySource[src]--;
      pumpQueue(src);      // 一个跑完立刻补下一个（同来源）
    });
  }
  // 该来源全部结束：通知前端
  if (runningBySource[src] === 0 && pending.length === 0) {
    const anyLeft = tasks.some(
      (t) => srcOf(t) === src && (t.state === 'queued' || t.state === 'running')
    );
    if (!anyLeft && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('queue-idle', { source: src });
    }
  }
}

// 队列里展示的失败说明。技术性的 "exit 1" 对用户没有意义，指向日志更有用。
function friendlyFailMsg(msg) {
  const m = String(msg || '');
  if (/^exit\s/i.test(m) || m === '重试后仍失败') return '下载失败，原因见下方日志';
  return m || '下载失败';
}

// 下载完成后核对真实分辨率。
// 用户选了 4K 却落到 1080p 时必须说清楚原因，否则只会觉得"我明明选了 4K"。
// 高清晰度缺失的常见原因是 YouTube 端对某些视频强制 SABR 流 + 需要 PO Token，
// 与"有没有带 cookies"不是一回事（本项目实测：某年龄限制视频各客户端最高只给到 1080p 级）。
async function reportResolution(t, quality) {
  if (!t.file) return;
  const r = await probeFile(t.file);
  if (!r.ok || !r.info) return;

  const res = r.info.resolution || '-';          // 形如 1920×1012
  t.res = res;
  // 顺便记下真实帧率（数值）—— 队列行据此决定要不要露出「降为30fps」按钮。
  // info.fps 是 "59.94 fps" 这样的字符串，这里解析成数字存起来。
  const fpsNum = parseFloat(String(r.info.fps || '')) || 0;
  t.fps = fpsNum;
  pushLog('>>> 实际分辨率: ' + res + ' · ' + r.info.videoCodec + ' · ' +
    (fpsNum ? fpsNum + 'fps · ' : '') + r.info.size, 'ok', t.id);

  const cap = QUALITY_HEIGHT[quality] || 0;
  const h = Number(String(res).split('×')[1]) || 0;
  // 阈值放宽到 85%：YouTube 的实际高度常因画面比例而低于标称值
  // （如 720p 可能是 1280×676、2160p 可能是 3840×2026），
  // 用 95% 会把成功下载误判成"没拿到该清晰度"。明显缩水（如 4K 只下到 1012）仍会提示。
  if (cap && h && h < cap * 0.85) {
    pushLog(
      '>>> 提示：没拿到 ' + quality + '，实际只有 ' + res + '。常见原因：① YouTube 对部分视频' +
      '启用 SABR 流，需要 PO Token 才能取到更高清晰度；② **带 cookies 时 YouTube 会把默认' +
      '客户端压到 360p**（账号级 SABR 实验，实测同一 4K 视频：不带 cookies=2160p、' +
      '带 cookies=360p）。若该视频并不需要登录，删掉已下好的文件后重新添加链接，' +
      '程序会改走"不带 cookies"分支，通常能恢复原清晰度。',
      'warn', t.id
    );
  }
}

async function runTask(t) {
  const o = t.opts;
  t.state = 'running';
  t.detail = '准备中…';
  t.percent = 0;
  pushTaskUpdate(t);
  sendProgress({ taskId: t.id, state: 'start', percent: 0, detail: '准备中…' });

  pushLog(`═══ #${t.seq} 开始: ` + t.url.slice(0, 70), 'dim', t.id);

  try {
    const r = await downloadWorker(t.url, o.folder, o.quality, o.fps, o.proxyMode, o.proxy, t.id, o.source);
    if (cancelledTasks.has(t.id)) {
      t.state = 'error';
      t.detail = '已取消';
      t.msg = '用户取消';
    } else if (r.ok) {
      t.state = 'done';
      t.percent = 100;
      t.detail = '完成';
      t.file = r.file || '';
      // 直链下的是普通文件（压缩包 / 镜像 / ROM 之类），没有"实际分辨率"可核对，跳过
      if (o.source !== 'direct') await reportResolution(t, o.quality);   // 核对真实分辨率并写入 t.res
    } else {
      t.state = 'error';
      t.detail = '失败';
      t.msg = friendlyFailMsg(r.msg);
    }
  } catch (err) {
    if (cancelledTasks.has(t.id)) {
      t.state = 'error';
      t.detail = '已取消';
      t.msg = '用户取消';
    } else {
      t.state = 'error';
      t.detail = '异常';
      t.msg = err && err.message ? err.message : String(err);
      pushLog('下载异常: ' + t.msg, 'err', t.id);
      sendProgress({ taskId: t.id, state: 'error', detail: '失败：' + t.msg });
    }
  } finally {
    cancelledTasks.delete(t.id);
  }
  pushTaskUpdate(t);
}

ipcMain.handle('start_download', (e, params) => {
  const { url, urls, dir, quality, fps, proxyMode, proxy, source } = params || {};
  const folder = (dir || '').trim();
  const q = quality || '4K';
  const fpsVal = fps || '0';
  const pMode = proxyMode || 'system';
  const pAddr = (proxy || '').trim();
  // 来源：yt（YouTube）/ social（抖音·小红书·B站·微博·TikTok）/ direct（HTTP 文件直链）。
  // 前两个共用 yt-dlp 解析，参数差异见 downloadWorker 里的分支；
  // direct 走完全不同的内核（aria2 多线程分段），见 downloadDirectWorker。
  const src = source === 'direct' ? 'direct' : (source === 'social' ? 'social' : 'yt');

  cfg.proxy_mode = pMode;
  cfg.proxy = pAddr;
  saveConfig(cfg);

  // 兼容单个 url 与批量 urls 两种调用
  let list = [];
  if (Array.isArray(urls) && urls.length) list = urls.slice();
  else if (url && String(url).trim()) list = [String(url).trim()];
  list = list.map((s) => String(s).trim()).filter(Boolean);

  if (!list.length) { pushLog('请先粘贴视频链接', 'err', null, src); return { ok: false, msg: '没有链接' }; }
  if (!folder) { pushLog('请先为分类设置保存文件夹', 'err', null, src); return { ok: false, msg: '未设置保存目录' }; }

  try { fs.mkdirSync(folder, { recursive: true }); } catch (err) {
    pushLog('无法创建目录: ' + err, 'err', null, src);
    return { ok: false, msg: '无法创建目录' };
  }

  stoppedBySource[src] = false;
  const { created, skipped } = enqueueTasks(list, {
    folder, quality: q, fps: fpsVal, proxyMode: pMode, proxy: pAddr, source: src,
  });
  if (skipped.length) {
    pushLog(`>>> 已忽略 ${skipped.length} 个：该视频已在队列中且未结束`, 'dim', null, src);
  }
  pushLog(`>>> 已加入队列：${created.length} 个任务（本页并行上限 ${CONCURRENCY}，与另一页互不占用）`, 'dim', null, src);
  return { ok: true, ids: created, added: created.length, skipped: skipped.length };
});

// 查询队列全量快照（页面重载后可恢复显示）
ipcMain.handle('get_tasks', () => tasks.map(taskSnapshot));

// 停止全部：只停**当前页面**的任务（油管页与社媒页各点各的）
ipcMain.handle('stop_all', (e, source) => {
  const src = source === 'direct' ? 'direct' : (source === 'social' ? 'social' : 'yt');
  stoppedBySource[src] = true;

  let cancelledQueued = 0;
  const pending = pendingBySource[src];
  const keep = [];
  for (const id of pending) {
    const t = findTask(id);
    if (srcOf(t) !== src) { keep.push(id); continue; }   // 别的来源原样留在队列里
    if (t && t.state === 'queued') {
      t.state = 'error';
      t.detail = '已取消';
      t.msg = '用户取消';
      cancelledQueued++;
      pushTaskUpdate(t);
    }
  }
  pending.length = 0;
  pending.push(...keep);

  let killed = 0;
  for (const t of tasks) {
    if (t.state === 'running' && srcOf(t) === src) {
      cancelledTasks.add(t.id);
      killed += killTaskProcs(t.id);
    }
  }
  pushLog(`>>> 已停止全部：取消等待 ${cancelledQueued} 个，终止下载 ${killed} 个`, 'warn', null, src);
  return { ok: true, cancelled: cancelledQueued, killed };
});

// 取消单个任务：排队中的直接剔除；正在跑的杀掉进程
ipcMain.handle('cancel_task', (e, id) => {
  const t = findTask(id);
  if (!t) return { ok: false };

  if (t.state === 'queued') {
    const pending = pendingBySource[srcOf(t)];
    const i = pending.indexOf(id);
    if (i >= 0) pending.splice(i, 1);
    t.state = 'error';
    t.detail = '已取消';
    t.msg = '用户取消';
    pushTaskUpdate(t);
    pushLog(`>>> 已取消 #${t.seq}（排队中）`, 'warn', t.id);
    return { ok: true };
  }

  if (t.state === 'running') {
    cancelledTasks.add(id);
    const n = killTaskProcs(id);
    t.detail = '正在取消…';
    pushTaskUpdate(t);
    pushLog(`>>> 正在取消 #${t.seq}（已终止 ${n} 个进程）`, 'warn', t.id);
    return { ok: true };
  }

  return { ok: false, msg: '该任务已结束' };
});

// 重试：把失败 / 已取消的任务重置回队列，用原来的参数再跑一遍。
// 刻意不新建任务 —— 否则同一个链接在列表里会堆出好几行，越试越乱。
// 复用 pendingBySource，所以并发上限、取消、来源隔离这些全都自动生效。
function retryTask(id) {
  const t = findTask(id);
  if (!t) return { ok: false, msg: '任务不存在' };
  if (t.state === 'queued' || t.state === 'running') {
    return { ok: false, msg: '该任务还在队列中' };
  }
  const src = srcOf(t);
  if (!pendingBySource[src]) return { ok: false, msg: '未知来源：' + src };

  // 清掉上一轮的痕迹（进度、错误文案、产物路径、帧率），否则界面会显示旧数据
  t.state = 'queued';
  t.percent = 0;
  t.detail = '等待重试…';
  t.msg = '';
  t.file = '';
  t.res = '';
  t.fps = 0;
  t.fpsOut = '';
  cancelledTasks.delete(t.id);   // 万一是被取消的，把取消标记也清掉

  pendingBySource[src].push(t.id);
  stoppedBySource[src] = false;  // 点了重试就说明这个来源要接着干活
  pushTaskUpdate(t);
  pushLog(`>>> #${t.seq} 已重新加入队列`, 'dim', t.id);
  pumpQueue(src);
  return { ok: true };
}

ipcMain.handle('retry_task', (e, id) => retryTask(id));

// 清空已完成/失败的任务记录 —— 同样只清当前页面的
ipcMain.handle('clear_finished', (e, source) => {
  const src = source === 'direct' ? 'direct' : (source === 'social' ? 'social' : 'yt');
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (srcOf(tasks[i]) !== src) continue;
    if (tasks[i].state === 'done' || tasks[i].state === 'error') tasks.splice(i, 1);
  }
  return tasks.map(taskSnapshot);
});

// 从 yt-dlp 输出的文件名里抠出视频标题。
// 形如 "My Video Title [dQw4w9WgXcQ].f313.webm" / "My Video Title [dQw4w9WgXcQ].mkv"
// 队列里显示标题比显示一串 URL 有用得多（尤其是想边看边加任务的时候）。
function titleFromFile(p) {
  let base = path.basename(String(p || ''));
  base = base.replace(/\.f\d+(\.[A-Za-z0-9]+)?$/, '');      // 去掉 .f313 / .f313.webm
  base = base.replace(/\.[A-Za-z0-9]{2,5}$/, '');            // 去掉 .mkv / .webm
  base = base.replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, '');   // 去掉尾巴上的 [视频id]
  return base.trim();
}

// 记下任务标题（只在变化时推一次）
function setTaskTitle(taskId, rawFile) {
  if (!taskId) return;
  const t = findTask(taskId);
  if (!t) return;
  const ttl = titleFromFile(rawFile);
  if (!ttl || ttl === t.title) return;
  t.title = ttl;
  pushTaskUpdate(t);
}

// 判断这轮失败是否值得换一套 cookies 设置重试
// 典型可恢复错误：年龄限制、请登录、需要 cookies、403
function isRetryableAuthError(log) {
  return /Sign in to confirm your age|confirm you.?re not a bot|content is age-restricted|Sign in to confirm|--cookies|Video unavailable\. Sign in|HTTP Error 403|This video requires login|login required|Fresh cookies needed/i.test(log);
}

// YouTube 的"账号级 SABR 实验"警告 —— 出现它就意味着**这份流只给到低清**。
// 实测（2026-10-14）：带 cookies 时必现，紧接着选中的就是 format 18（640×360）。
// 以前这条被当普通日志埋在 dim 级，导致"为什么只有 360p"完全无从判断，这里提出来。
function sabrDetected(log) {
  return /SABR-only streaming experiment/i.test(log);
}
function sabrNote(log) {
  return log + '  ← ⚠️ YouTube 的 SABR 实验生效：这一轮只会拿到低清晰度（通常因带 cookies 触发）';
}

// 把一行子进程输出整理成 pushLog 要的参数（文本 + 级别）。
// 单独抽成纯函数是为了**能被测试覆盖** —— 这里踩过一个坑：
// 早先 stdout 那一路写成了无条件 `sabrNote(line)`，于是**每一行**日志都被追加了
// SABR 提示（stderr 那一路写对了，而且两边逻辑重复）。抽出来后"哪些行该加提示"
// 只有一个实现，也有断言盯着。
function childLine(line, isStderr) {
  if (sabrDetected(line)) return [sabrNote(line), 'warn'];
  if (isStderr && /error|ERROR/.test(line)) return [line, 'err'];
  return [line, 'dim'];
}

// 带 cookies 时补上备用 player client 组合：`web_creator,web_safari,tv`。
//
// 为什么需要它（2026-10-14 实测）：**只要带了 cookies，默认客户端就会被账号级
// SABR 实验压到 360p**，必须换客户端才能拿到高清晰度。
//
// 为什么是这三个（同一个 4K 视频逐一实测，全部带 cookies）：
//   web_creator  → 3840×2160 ✅ ← 唯一能"带 cookies 还拿 4K"的客户端
//   web_safari   → 1920×1080（封顶 1080p）
//   tv           → 与 web_safari 同级（单独用 tv_simply 会因"不支持 cookies"报错）
//   web / web_embedded / mweb / tv_embedded → 只有 640×360
//   android_vr / ios → 直接报 "Requested format is not available"
// 写成一个组合交给 yt-dlp 自己挑最高档：creator 拿不到时 safari/tv 的格式还在，
// 一次调用就同时完成"要高清 + 有兜底"，不必多跑一轮。
//
// 调用方是「用了 cookies 就带上它」（见 downloadWorker 里的 cappedClient）。
function clientArgs(useAlt) {
  return useAlt ? ['--extractor-args', 'youtube:player_client=web_creator,web_safari,tv'] : [];
}

// 用一套 cookies 设置跑一次 yt-dlp。
// withCookies=true 时带上浏览器 cookies；解析成功则 return 0；
// 若是可恢复的鉴权错误且本次没带 cookies，return 1（调用方用 cookies 再试一次）。
// 注意：url 必须由参数传入 —— 不能用模块级变量，否则多任务并发时会互相串链接。
function runYtdlp({ ytdlp, args, cwdEnv, withCookies, cappedClient, label, url, taskId }) {
  return new Promise((resolve) => {
    const finalArgs = args.slice();
    if (withCookies) {
      const ca = cookieArgs();
      if (ca.length) finalArgs.push(...ca);
    }
    if (cappedClient) finalArgs.push(...clientArgs(true));
    // URL 末尾追加（放在所有选项之后，用 -- 分隔）
    finalArgs.push('--', url);

    pushLog(`>>> 尝试${label}`, 'dim', taskId);

    let lastFile = '';
    let sawAuthError = false;
    const proc = spawn(ytdlp, finalArgs, {
      windowsHide: true,
      env: cwdEnv,
    });
    registerProc(taskId, proc);   // 登记进程，取消任务时才能真杀掉
    proc.stdout.on('data', (buf) => {
      // yt-dlp 用 \r 在同一行刷新进度，必须按 \r 和 \n 都切开
      const parts = decodeOut(buf).split(/[\r\n]+/);
      for (const raw of parts) {
        const line = raw.trim();
        if (!line) continue;
        const prog = parseProgress(line);
        if (prog) {
          // 进度行只喂进度条，不写日志（否则刷屏）
          sendProgress({ taskId, state: 'progress', percent: prog.percent, detail: prog.detail });
          continue;
        }
        // 记录最终文件：多流合并看 [Merger]，单流下载看 [download] Destination
        const mMerge = line.match(/Merging formats into "(.+)"/);
        const mDest = line.match(/^\[download\] Destination: (.+)$/);
        const mDone = line.match(/^\[download\] (.+) has already been downloaded$/);
        if (mMerge) { lastFile = mMerge[1]; setTaskTitle(taskId, mMerge[1]); }
        else if (mDest && !/\.part$/.test(mDest[1])) { lastFile = mDest[1]; setTaskTitle(taskId, mDest[1]); }
        else if (mDone) { lastFile = mDone[1]; setTaskTitle(taskId, mDone[1]); }
        if (isRetryableAuthError(line)) sawAuthError = true;
        pushLog(...childLine(line, false), taskId);
      }
    });
    proc.stderr.on('data', (buf) => {
      const line = decodeOut(buf).trim();
      if (line) {
        if (isRetryableAuthError(line)) sawAuthError = true;
        pushLog(...childLine(line, true), taskId);
      }
    });
    proc.on('error', (e) => {
      pushLog('下载错误: ' + e, 'err', taskId);
      resolve({ code: -1, lastFile: '' });
    });
    proc.on('close', (code) => {
      resolve({ code, lastFile, sawAuthError });
    });
  });
}

/* ── 直链下载（aria2）────────────────────────────────────────────────
 * 场景：HTTP/HTTPS 文件直链（archive.org、网盘、CDN 等）。
 * yt-dlp 也能下这类文件，但它是单线程、不分片，几个 GB 的大文件很吃亏；
 * aria2 支持多线程分段（-x / -s），正好吃满服务器声明的 Accept-Ranges。
 *
 * 实测背景（2026-10-08，archive.org 节点直链）：
 *   - 服务器返回 `Accept-Ranges: bytes`，Range 请求给 206 → 确认支持分段
 *   - archive.org 国内直连会 502，必须走代理（复用 yt-dlp 那套代理设置）
 *   - 目标文件 3.27GB，这类体积单线程要等很久
 */
async function downloadDirectWorker(url, folder, pMode, proxy, taskId) {
  const aria2 = findTool('aria2c');
  if (!aria2) {
    pushLog('错误：未找到直链下载内核 tools/aria2c.exe', 'err', taskId);
    pushLog('请到「环境检测」页检查组件', 'err', taskId);
    return { ok: false, msg: '未找到直链下载内核' };
  }

  const args = [
    '--dir', folder,
    '--continue',                     // 断点续传：中断后重跑接着下
    '-x', '16',                       // 单服务器最大连接数
    '-s', '16',                       // 分段数
    '-k', '1M',                       // 分片大小
    '--file-allocation=none',         // 不预分配，避免大文件启动时长时间卡住
    '--summary-interval=1',           // 每秒输出一次进度读数
    '--auto-file-renaming=false',     // 重名直接覆盖（与 yt-dlp 行为一致）
    '--allow-overwrite=true',
    '--no-conf',                      // 不读用户的 aria2 全局配置，保证行为可预期
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  ];

  pushLog('>>> 开始直链下载', 'dim', taskId);
  pushLog('>>> 链接: ' + url.slice(0, 100), 'dim', taskId);
  pushLog('>>> 目录: ' + folder + ' · 16 线程分段', 'dim', taskId);

  if (pMode === 'manual' && proxy) {
    args.push('--all-proxy', proxy);
    pushLog('>>> 代理: 手动 ' + proxy, 'dim', taskId);
  } else if (pMode === 'direct') {
    pushLog('>>> 代理: 直连', 'dim', taskId);
  } else {
    const sp = await getSystemProxy();
    pushLog('>>> 代理: ' + sp.msg, 'dim', taskId);
    if (sp.url) args.push('--all-proxy', sp.url);
  }

  args.push(url);

  return await new Promise((resolve) => {
    let lastFile = '';
    let sawError = '';
    const proc = spawn(aria2, args, { windowsHide: true });
    registerProc(taskId, proc);   // 登记进程，「取消」时才能真杀掉

    const handle = (raw) => {
      const line = raw.trim();
      if (!line) return;

      const prog = parseAriaProgress(line);
      if (prog) {
        // 进度读数只喂进度条，不写日志（每秒一行会刷屏）
        sendProgress({ taskId, state: 'progress', percent: prog.percent, detail: prog.detail });
        return;
      }
      // 连接明细（[#xxx ...]、无百分比那种）在默认日志级别下很吵，直接丢
      if (/^\[#\w+/.test(line)) return;

      const mDone = line.match(/Download complete:\s*(.+)$/);
      if (mDone) { lastFile = mDone[1].trim(); setTaskTitle(taskId, lastFile); }
      const mFile = line.match(/^FILE:\s*(.+)$/);
      if (mFile && !lastFile) setTaskTitle(taskId, mFile[1].trim());

      if (/error/i.test(line)) sawError = line;
      pushLog(line, /error|ERROR/i.test(line) ? 'err' : 'dim', taskId);
    };

    proc.stdout.on('data', (buf) => decodeOut(buf).split(/[\r\n]+/).forEach(handle));
    proc.stderr.on('data', (buf) => decodeOut(buf).split(/[\r\n]+/).forEach(handle));

    proc.on('error', (e) => {
      pushLog('直链下载错误: ' + e, 'err', taskId);
      resolve({ ok: false, msg: String(e) });
    });
    proc.on('close', (code) => {
      if (cancelledTasks.has(taskId)) return resolve({ ok: false, msg: '已取消' });
      if (code === 0) {
        pushLog('>>> 下载完成' + (lastFile ? ': ' + lastFile : ''), 'ok', taskId);
        resolve({ ok: true, file: lastFile });
      } else {
        resolve({ ok: false, msg: sawError || ('aria2 退出码 ' + code) });
      }
    });
  });
}

// 解析 aria2 的进度读数行，返回 {percent, detail} 或 null。
// 实际输出有两种形态（随版本/选项略有差异，都覆盖）：
//   [#1bc0e0 1.2GiB/3.2GiB(37%) CN:16 DL:8.5MiB ETA:4m12s]
//   [#1 SIZE:1.2MiB/3.2GiB(0%) CN:16 DL:5.2MiB ETA:10m]
function parseAriaProgress(line) {
  const pct = line.match(/\((\d+)%\)/);
  if (!pct) return null;
  const bits = [];
  const size = line.match(/SIZE:([^\s\]]+)/) || line.match(/\s([\d.]+[A-Za-z]*\/[\d.]+[A-Za-z]*)\(/);
  if (size) bits.push(size[1]);
  const sp = line.match(/DL:([^\s\]]+)/);
  if (sp) bits.push(sp[1] + '/s');
  const eta = line.match(/ETA:([^\s\]]+)/);
  if (eta) bits.push('剩余 ' + eta[1]);
  return { percent: parseInt(pct[1], 10), detail: bits.join(' · ') };
}

/* yt-dlp 输出到 stdout 时会把无法编码的字符替换掉 —— 实测含 emoji 的视频标题
 * （如 "KYRIE IRVING RETURNS! 🔥 17 Points..."）在它的输出里 emoji 变成了空格，
 * 于是它报告的路径和实际落盘的文件名不一致（实测 od -c 确认：stdout 里就是两个空格字节，
 * 而磁盘上的文件名带完整 emoji）。后果是下载后的「属性 / 播放 / 打开目录」，以及
 * 紧接着的 probeFile 核对分辨率，全都指向一个不存在的文件 —— 表现为三个按钮齐挂、
 * 队列行也不显示「降为 30fps」（因为读不到帧率）。
 *
 * 这里做一次校正：报告路径存在就直接用；不存在就去下载目录里找「忽略非字母数字后完全相同」
 * 的那个文件，取修改时间最新的（避免撞上旧的同名文件）。文件本身没毛病，只是我们手上的名字
 * 少了个 emoji —— 所以不动文件名，只修正引用。
 */
function resolveActualFile(folder, reported) {
  const p = String(reported || '');
  if (!p) return p;
  if (fs.existsSync(p)) return p;      // 绝大多数情况：路径正确，直接返回

  try {
    const dir = folder || path.dirname(p);
    // 只保留字母/数字再比小写：emoji、空格、中英标点全部忽略
    const key = (s) => String(s).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    const wantKey = key(path.basename(p));
    if (!wantKey) return p;

    let best = '';
    let bestTime = 0;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(part|ytdl|temp)$/i.test(f)) continue;   // 跳过未完成的中间文件
      if (key(f) !== wantKey) continue;
      const fp = path.join(dir, f);
      const mt = fs.statSync(fp).mtimeMs;
      if (mt > bestTime) { bestTime = mt; best = fp; }
    }
    if (best) return best;
  } catch (e) { /* 目录读不到就原样返回，交给上层报错 */ }
  return p;
}

// 单个任务的完整下载流程。所有状态都通过 taskId 归属到具体任务。
async function downloadWorker(url, folder, quality, fps, pMode, proxy, taskId, source) {
  // 直链是另一套内核（aria2），参数体系与 yt-dlp 完全不同，先分流
  if (source === 'direct') return await downloadDirectWorker(url, folder, pMode, proxy, taskId);

  const ytdlp = findYtdlpKernel();
  if (!ytdlp) {
    pushLog('错误：未找到下载内核 tools/yt-dlp.exe', 'err', taskId);
    pushLog('请到「环境检测」页安装缺失组件', 'err', taskId);
    return { ok: false, msg: '未找到下载内核' };
  }

  const isSocial = source === 'social';

  // 社媒站固定取平台最高画质（前端也只传「原画」）
  const fmt = isSocial ? SOCIAL_FMT : (QUALITY[quality] || QUALITY['4K']);
  // 注：以前这里有个「帧率」选项，会拼 [fps<=30] 去挑平台的低帧率流。
  // 实测证明这是个坑 —— YouTube 的高清档（720p 以上）对 60fps 源只提供 60fps 版本，
  // 加了 [fps<=30] 筛选会一路往下匹配到 480p，清晰度暴跌而日志毫无提示。
  // 现已改为「下载完成后在队列里手动转 30 帧」（见 convert_fps30）。
  const fmtArg = fmt;

  const template = path.join(folder, '%(title)s.%(ext)s');
  const args = ['-o', template, '-f', fmtArg, '--merge-output-format', 'mkv', '--no-update', '--newline'];

  const ffmpeg = findTool('ffmpeg');
  if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));

  // PO Token provider（有 Node 且组件齐全时）——放在最前，后面据此决定重试策略。
  // 它是 YouTube 专属（用于解开 SABR 流的高清晰度），社媒站用不上，跳过以免白等。
  const potArgList = isSocial ? [] : potArgs();
  const hasPot = potArgList.length > 0;

  // JS 运行时：deno / node 都登记（参数可重复传）。
  // 挑战求解用哪个都行；PO Token 生成器只认 node。
  const rt = findJsRuntime();
  const runtimes = [];
  if (rt) runtimes.push(`${rt.name}:${rt.path}`);
  if (hasPot && rt && rt.name !== 'node') {
    const nd = findTool('node');
    if (nd) runtimes.push(`node:${nd}`);
  }
  if (runtimes.length) {
    // 注意：路径必须是 Windows 绝对路径，yt-dlp 不认 MSYS 风格 /d/... 路径
    for (const r of runtimes) args.push('--js-runtimes', r);
    pushLog('>>> JS 运行时: ' + runtimes.join(' | '), 'dim', taskId);
  } else {
    pushLog('>>> 警告：未检测到 deno/node，YouTube 可能下载失败', 'warn', taskId);
  }

  if (hasPot) {
    args.push(...potArgList);
    pushLog('>>> PO Token: 已启用（年龄限制视频也能拿到高清晰度）', 'dim', taskId);
  } else if (!isSocial && potDisabledReason) {
    // 说清楚为什么没启用，免得用户只看到"又是 1080p"却不知道差哪一步。
    // 社媒页不打印 —— 那里的失败原因跟 PO Token 无关，只会干扰判断。
    pushLog('>>> PO Token: 未启用 —— ' + potDisabledReason, 'dim', taskId);
  }

  // 先给用户反馈：读系统代理可能耗时，别让界面看起来卡住
  pushLog('>>> 开始下载', 'dim', taskId);
  pushLog('>>> 链接: ' + url.slice(0, 80), 'dim', taskId);
  pushLog('>>> 画质: ' + quality + ' | 目录: ' + folder, 'dim', taskId);

  if (pMode === 'manual' && proxy) {
    args.push('--proxy', proxy);
    pushLog('>>> 代理: 手动 ' + proxy, 'dim', taskId);
  } else if (pMode === 'direct') {
    args.push('--proxy', '');
    pushLog('>>> 代理: 直连', 'dim', taskId);
  } else {
    const sp = await getSystemProxy();
    pushLog('>>> 代理: ' + sp.msg, 'dim', taskId);
    if (sp.url) args.push('--proxy', sp.url);
  }

  // PyInstaller 打包的 yt-dlp.exe 启动时要把自己解包到临时目录，
  // 拿不到 TEMP/TMP 就会直接报 "Could not create temporary directory!" 并以 -1 退出。
  // 少数环境（从某些终端/宿主启动）确实会丢掉这两个变量，这里补上兜底。
  const cwdEnv = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
  };
  const key = cacheKey(url);

  // ---------- 决定第一轮是否带 cookies ----------
  // 优先级：缓存里成功过的组合 > 配置默认。缓存命中时跳过"无 cookies 先试"，
  // 避免年龄限制视频每次都白跑一轮。
  const cached = getCached(key);
  const cookieCount = cookieArgs().length;
  let plan;
  if (isSocial) {
    // 社媒站（尤其抖音）大多强制要求登录态，不带 cookies 基本都会被拒（Fresh cookies needed）。
    // 所以这里跟油管相反：**第一轮就带 cookies**，失败再退回不带 cookies 试一次。
    // 没有可用 cookies 时只跑一轮 —— 跑两遍同样的参数没有意义，白白翻倍等待时间。
    if (cached) {
      plan = [{
        withCookies: !!cached.cookies,
        label: cached.cookies ? '（按上次成功记录带 cookies）' : '（按上次成功记录不带 cookies）',
      }];
    } else if (cookieCount) {
      plan = [
        { withCookies: true, label: '（带浏览器 cookies）' },
        { withCookies: false, label: '（不带 cookies 重试）' },
      ];
    } else {
      plan = [{ withCookies: false, label: '（不带 cookies）' }];
      pushLog('>>> 提示：当前没有可用 cookies，抖音这类站点大概率会拒绝解析（Fresh cookies needed）。' +
        '请到「设置 → 浏览器 Cookies」选一个已登录过该站点的浏览器。', 'warn', taskId);
    }
  } else if (cached) {
    if (cached.cookies && cached.auth === true) {
      // 上次确实是鉴权失败才需要 cookies —— 直接沿用，省一轮等待
      plan = [{ withCookies: true, label: '（按上次成功记录带 cookies）' }];
      pushLog('>>> 命中缓存：该链接上次因鉴权需要 cookies，直接沿用', 'dim', taskId);
    } else if (cached.cookies) {
      // 上次用过 cookies，但**不是**鉴权原因（旧版缓存没有 auth 字段也走这里）——
      // 先不带 cookies 重试一遍。实测（2026-10-14）：普通视频带 cookies 只剩 360p，
      // 不带能拿 4K，所以这一步实际上是在把被误压掉的清晰度拿回来。
      plan = [
        { withCookies: false, label: '（缓存记录曾用 cookies，但并非鉴权原因，先不带重试）' },
        { withCookies: true, label: '（带浏览器 cookies 重试）' },
      ];
      pushLog('>>> 缓存显示曾用 cookies，但上次并非鉴权失败 —— 先不带 cookies 试，' +
        '避免清晰度被压到 360p', 'warn', taskId);
    } else {
      plan = [{ withCookies: false, label: '（按上次成功记录，不带 cookies）' }];
      pushLog('>>> 命中缓存：该链接上次无需 cookies，直接沿用', 'dim', taskId);
    }
  } else {
    plan = [
      { withCookies: false, label: '（不带 cookies）' },
      // cappedClient 不用在这里指定 —— 只要某一轮带 cookies，下载时会自动配上
      // web_safari,tv（否则会被 SABR 压到 360p，见下面 cappedClient 的注释）
      { withCookies: true, label: '（带浏览器 cookies 重试）' },
    ];
  }

  // 兜底（2026-10-14 补）：YouTube 上带 cookies 时会配 web_safari,tv ——
  // 实测这是唯一能避免被 SABR 压到 360p 的办法。但万一某个视频在这个客户端下
  // **一个视频格式都拿不到**，就会从"以前还能下 360p"变成"直接下载失败"。
  // 所以再挂一轮"退回默认客户端"：宁可清晰度低，也不能让本来能下的变成下不了。
  if (!isSocial && plan.length && plan[plan.length - 1].withCookies) {
    plan.push({ withCookies: true, cappedClient: false, label: '（退回默认客户端兜底）' });
  }

  let lastFile = '';
  let lastAuthFail = false;   // 上一轮是否因鉴权失败（决定"需要 cookies"要不要写进缓存）
  for (const step of plan) {
    // 关键：被「取消/停止全部」掐断后不能再开新一轮 —— 否则杀掉进程的下一刻
    // 又拉起一个新下载，用户看到的是"点了停止但还在下"。
    if (taskId && cancelledTasks.has(taskId)) {
      pushLog('>>> 已取消，不再重试', 'warn', taskId);
      return { ok: false, msg: '已取消' };
    }

    // 在 YouTube 上「只要用了 cookies」就必须换客户端（2026-10-14 实测结论）：
    //   带 cookies + 默认客户端 → 只剩 360p（账号级 SABR 实验，日志里会出现
    //   web_embedded "missing a URL" 警告）；换成 web_creator,web_safari,tv →
    //   4K 视频能拿 3840×2160、1080p 视频拿 1920×1080（详见 clientArgs 的注释）。
    // ⚠️ PO Token 救不了这种情况 —— token 的价值在于"不带 cookies"时让默认客户端
    //    拿到 4K；一旦带上 cookies，默认客户端照样被压到 360p。
    // step.cappedClient === false 是兜底轮（见下面 plan 末尾那步），专门退回默认客户端。
    const cappedClient = !isSocial && step.withCookies && step.cappedClient !== false;

    const r = await runYtdlp({
      ytdlp, args, cwdEnv, withCookies: step.withCookies, cappedClient,
      label: step.label + (cappedClient ? ' [备用客户端]' : ''),
      url, taskId,
    });
    if (r.code === 0) {
      // yt-dlp 报告的路径可能因输出编码丢失字符（含 emoji 的标题会变成空格），
      // 先校正成磁盘上真实存在的文件，否则后续属性/播放/定位/核对分辨率全都会失败
      lastFile = resolveActualFile(folder, r.lastFile);
      // 只有"上一轮确实因鉴权失败、且本次是靠 cookies 才成功"才记为需要 cookies；
      // 其它情况一律记 auth=false，下次会先不带 cookies 试（见 setCached 注释）
      setCached(key, step.withCookies, lastAuthFail);
      pushLog('>>> 下载完成 ✓', 'ok', taskId);
      if (lastFile) pushLog('>>> 文件: ' + lastFile, 'ok', taskId);
      sendProgress({ taskId, state: 'done', percent: 100, detail: '完成', file: lastFile });
      return { ok: true, file: lastFile };
    }

    lastAuthFail = !!r.sawAuthError;

    // 本轮是被掐断的：直接收尾，不进入重试分支
    if (taskId && cancelledTasks.has(taskId)) {
      return { ok: false, msg: '已取消' };
    }

    // 失败：判断要不要换一套 cookies 重试
    const isLast = step === plan[plan.length - 1];
    if (isLast) {
      pushLog('>>> 下载失败 (exit ' + r.code + ')', 'err', taskId);
      sendProgress({ taskId, state: 'error', detail: '失败 (exit ' + r.code + ')' });
      return { ok: false, msg: 'exit ' + r.code };
    }
    if (r.sawAuthError) {
      const ca = cookieArgs();
      if (ca.length) {
        pushLog(isSocial
          ? '>>> 该链接需要登录态，正用浏览器 cookies 重试…'
          : '>>> 该视频需要登录/年龄验证，正用浏览器 cookies 重试…', 'warn', taskId);
      } else {
        pushLog('>>> 该链接需要登录，但未找到可用浏览器 cookies（见「设置 → 浏览器 Cookies」）', 'warn', taskId);
      }
    } else {
      pushLog('>>> 本轮失败，换个方式再试一次…', 'warn', taskId);
    }
  }
  return { ok: false, msg: '重试后仍失败' };
}

// ============================================================
// 图片压缩（sharp / libvips）
// 为什么不用自带的 ffmpeg：实测同一张 1.50MB 的 PNG，
//   ffmpeg 重压后变成 1.57MB（反向变大），sharp 压到 517KB（省 66%）；
//   同等观感的 JPEG，sharp(mozjpeg) 比 ffmpeg 小 28%。
// 所以这一块单独上 sharp，libvips-42.dll 以独立 DLL 分发（LGPL-3.0）。
// ============================================================

// sharp 是原生模块，加载失败不能让整个应用起不来 —— 延迟加载 + 记住失败原因
let _sharp = null;
let _sharpErr = '';
let _sharpTried = false;
function getSharp() {
  if (!_sharpTried) {
    _sharpTried = true;
    try {
      _sharp = require('sharp');
    } catch (e) {
      _sharpErr = e.message || String(e);
      _sharp = null;
    }
  }
  return _sharp;
}

// 能进压缩流程的扩展名（sharp 支持的输入格式）
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tif', '.tiff', '.gif', '.bmp']);

// 质量档位 → 各编码器的实际参数。AVIF 的 quality 与 JPEG 不是一个量纲，
// 同一个数字观感差很远（q50 的 AVIF ≈ q80 的 JPEG），所以单独折算。
const IMG_QUALITY = { 高: 90, 中: 80, 低: 65 };
function imgQualityOf(label) {
  return IMG_QUALITY[label] || IMG_QUALITY['中'];
}

// 输出的目标格式。'keep' 时跟随源格式；gif / bmp 没有对应的编码器，落回 PNG。
function resolveImgFormat(want, srcExt) {
  if (want && want !== 'keep') return want;
  const e = srcExt.replace('.', '').toLowerCase();
  if (e === 'jpg' || e === 'jpeg') return 'jpeg';
  if (e === 'tif' || e === 'tiff') return 'tiff';
  if (e === 'png' || e === 'webp' || e === 'avif') return e;
  return 'png';
}

function outExtOf(format) { return format === 'jpeg' ? '.jpg' : '.' + format; }

// 这批图片合起来多大（界面要显示"合计 XX MB"，前端拿不到文件大小）
function sumImageSize(files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f).size; } catch (e) { /* 读不到就跳过 */ }
  }
  return total;
}

// 输出目录的默认名字。递归扫描时要跳过它 —— 否则第二次选同一个文件夹，
// 会把上一次压出来的产物再压一遍（越压越糊），这是个很容易踩的坑。
const IMG_OUT_SUBDIR = 'compressed';

// 把一个目录下（可含子目录）的图片列出来
function collectImages(dir, recursive) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const n of names) {
      const full = path.join(d, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (recursive && n.toLowerCase() !== IMG_OUT_SUBDIR) walk(full);
        continue;
      }
      if (IMG_EXTS.has(path.extname(n).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// 压缩单张图。返回 { ok, skipped, before, after, outPath, msg }
async function compressOne(file, opt) {
  const sharp = getSharp();
  const st = fs.statSync(file);
  const before = st.size;
  const srcExt = path.extname(file);
  const base = path.basename(file, srcExt);
  const format = resolveImgFormat(opt.format, srcExt);
  const quality = imgQualityOf(opt.quality);

  // 输出目录：'custom' 用指定目录；否则在每张图自己所在的目录下建 compressed/
  const outDir = opt.outMode === 'custom' && opt.outDir
    ? opt.outDir
    : path.join(path.dirname(file), IMG_OUT_SUBDIR);
  fs.mkdirSync(outDir, { recursive: true });

  let outPath = path.join(outDir, base + outExtOf(format));
  // 绝不覆盖原文件：万一算出来的路径就是源文件，给自己加个后缀
  if (path.resolve(outPath) === path.resolve(file)) {
    outPath = path.join(outDir, base + '.min' + outExtOf(format));
  }

  let pipe = sharp(file, { failOn: 'none' }).rotate();   // rotate() 按 EXIF 摆正，避免手机照片躺倒

  // 最长边限制（只缩不放）
  const maxEdge = Number(opt.maxEdge) || 0;
  if (maxEdge > 0) {
    const meta = await sharp(file).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w && h && Math.max(w, h) > maxEdge) {
      pipe = pipe.resize({
        width: w >= h ? maxEdge : undefined,
        height: h > w ? maxEdge : undefined,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  }

  if (format === 'jpeg') {
    pipe = pipe.jpeg({
      quality,
      mozjpeg: true,
      // 高质量档用 4:4:4 保住彩色边缘，中低档用 4:2:0 换更小体积
      chromaSubsampling: quality >= 90 ? '4:4:4' : '4:2:0',
    });
  } else if (format === 'png') {
    pipe = pipe.png({
      compressionLevel: 9,
      effort: 7,
      // 中低质量档走调色板量化 —— 截图 / 图标这类颜色少的图能小一个数量级
      palette: quality < 90,
      quality,
    });
  } else if (format === 'webp') {
    pipe = pipe.webp({ quality, effort: 4 });
  } else if (format === 'avif') {
    pipe = pipe.avif({ quality: Math.max(20, Math.round(quality * 0.6)), effort: 3 });
  } else if (format === 'tiff') {
    pipe = pipe.tiff({ quality, compression: 'deflate' });
  }

  await pipe.toFile(outPath);
  const after = fs.statSync(outPath).size;

  // 同格式却压完更大（源图本来就是优化过的）——删掉产物，保留原图更划算
  if (format === resolveImgFormat('keep', srcExt) && after >= before) {
    try { fs.unlinkSync(outPath); } catch (e) { /* 忽略 */ }
    return { ok: true, skipped: true, before, after: before, outPath: '', msg: '原图已足够小，保留原图' };
  }

  return { ok: true, skipped: false, before, after, outPath, format, msg: '' };
}

// ---------- 图片压缩任务（并发 2，可中止） ----------
const IMG_CONCURRENCY = 2;
let imgJobSeq = 0;
const imgJobs = new Map();

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

async function runImageJob(job) {
  let idx = 0;
  let okCount = 0, skipCount = 0, errCount = 0;
  let sumBefore = 0, sumAfter = 0;

  const worker = async () => {
    while (!job.cancelled) {
      const i = idx++;
      if (i >= job.files.length) return;
      const f = job.files[i];
      let res;
      try {
        res = await compressOne(f, job.opt);
      } catch (e) {
        res = { ok: false, msg: (e && e.message) || String(e) };
      }
      if (job.cancelled) return;

      if (res.ok) {
        sumBefore += res.before;
        sumAfter += res.skipped ? res.before : res.after;
        if (res.skipped) skipCount++; else okCount++;
      } else {
        errCount++;
      }
      sendToRenderer('image-item', {
        jobId: job.id,
        name: path.basename(f),
        file: f,
        ok: !!res.ok,
        skipped: !!res.skipped,
        before: res.before || 0,
        after: res.after || 0,
        outPath: res.outPath || '',
        msg: res.msg || '',
        done: okCount + skipCount + errCount,
        total: job.files.length,
      });
    }
  };

  await Promise.all(Array.from({ length: IMG_CONCURRENCY }, worker));

  sendToRenderer('image-done', {
    jobId: job.id,
    cancelled: !!job.cancelled,
    total: job.files.length,
    okCount, skipCount, errCount, sumBefore, sumAfter,
  });
  pushLog(`>>> 图片压缩结束：成功 ${okCount} · 跳过 ${skipCount} · 失败 ${errCount}` +
    (job.cancelled ? '（已中止）' : ''), job.cancelled ? 'warn' : 'ok', null, 'img');
  imgJobs.delete(job.id);
}

// 选图片（多选）
ipcMain.handle('pick_images', async () => {
  const r = await openDialogRemembered(mainWindow, 'images', {
    title: '选择要压缩的图片',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'tif', 'tiff', 'gif', 'bmp'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return { ok: false, files: [], totalBytes: 0 };
  const files = r.filePaths;
  return { ok: true, files, totalBytes: sumImageSize(files) };
});

// 选文件夹后把里面的图片都收集出来（可含子目录）
ipcMain.handle('collect_images', async (e, recursive) => {
  const r = await openDialogRemembered(mainWindow, 'image_dir', {
    title: '选择图片所在文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, msg: '已取消', files: [], totalBytes: 0 };
  const files = collectImages(r.filePaths[0], !!recursive);
  return { ok: true, dir: r.filePaths[0], files, totalBytes: sumImageSize(files) };
});

// 拖进来的路径可能是文件夹，这里统一摊平成图片列表
ipcMain.handle('expand_image_paths', (e, paths) => {
  const out = [];
  for (const p of paths || []) {
    let st;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (st.isDirectory()) out.push(...collectImages(p, true));
    else if (IMG_EXTS.has(path.extname(p).toLowerCase())) out.push(p);
  }
  return { ok: true, files: out, totalBytes: sumImageSize(out) };
});

ipcMain.handle('start_image_job', (e, params) => {
  if (!getSharp()) {
    pushLog('图片压缩内核加载失败：' + (_sharpErr || '未知原因'), 'err', null, 'img');
    return { ok: false, msg: '压缩内核不可用：' + (_sharpErr || '未知原因') };
  }
  const files = (params && params.files) || [];
  if (!files.length) return { ok: false, msg: '没有选择图片' };

  const opt = {
    quality: (params && params.quality) || '中',
    format: (params && params.format) || 'keep',
    maxEdge: (params && params.maxEdge) || 0,
    outMode: (params && params.outMode) || 'sub',
    outDir: (params && params.outDir) || '',
  };
  if (opt.outMode === 'custom' && !opt.outDir) {
    return { ok: false, msg: '请先选择输出文件夹' };
  }

  const id = 'img' + (++imgJobSeq);
  const job = { id, files, opt, cancelled: false };
  imgJobs.set(id, job);

  pushLog(`>>> 开始压缩 ${files.length} 张：质量「${opt.quality}」· 格式「${opt.format === 'keep' ? '保持原格式' : opt.format}」` +
    (opt.maxEdge ? ` · 最长边 ${opt.maxEdge}` : '') +
    ` · 输出「${opt.outMode === 'custom' ? opt.outDir : '各图目录下 compressed/'}」`, 'dim', null, 'img');

  runImageJob(job);   // 不 await：立刻把 jobId 还给界面，进度靠事件推
  return { ok: true, jobId: id, total: files.length };
});

ipcMain.handle('stop_image_job', (e, jobId) => {
  const job = imgJobs.get(jobId);
  if (!job) return { ok: false, msg: '任务已结束' };
  job.cancelled = true;
  pushLog('>>> 正在中止图片压缩…', 'warn', null, 'img');
  return { ok: true };
});

// 打开输出目录（压缩完成后一键去看结果）
ipcMain.handle('open_folder', async (e, dir) => {
  try {
    const err = await shell.openPath(String(dir || ''));
    return err ? { ok: false, msg: err } : { ok: true };
  } catch (err) {
    return { ok: false, msg: String(err) };
  }
});

// ============================================================
// 视频处理（无损修剪 / 压缩）—— 复用已内置的 ffmpeg，不新增任何二进制
//
// 命令形式参考 FFmpeg Batch AV Converter（LGPL-2.1）的 Form1.cs：
//   修剪是  -ss <起点> -to <终点> -i <输入> <用户参数> -y <输出>
//   （-ss / -to 都作为「输入选项」放在 -i 之前，-to 表示"读到该时间点为止"）
//   它本身不强制无损，"无损"靠用户自备 -c copy -avoid_negative_ts make_zero；
//   勾选框则把「结束时间」切换成「从结尾剪掉多少秒」（先读总时长再相减）。
//
// 我们把这两个模式做成固定配方，不让用户手写命令行。实测定下的两个要点：
//   ① -c copy 不重编码，所以切点必须落在关键帧上，否则产物开头是残缺帧
//      （实测 -ss 2 的产物，第一个关键帧在 0.5s → 开头 0.5 秒无法解码）
//   ② -avoid_negative_ts make_zero 会让 ffmpeg 自动把起点回退到最近的关键帧，
//      首帧因此始终可解码，代价是时长变长（实测想要 5 秒的片段变成了 7.04 秒）
//   所以：先扫关键帧、把起点「显式」吸附到前一个关键帧，再交给 ffmpeg。
//   这样时长可控、首帧可解码，还能在界面上提前把实际区间显示出来。
// ============================================================

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.wmv', '.flv', '.webm',
  '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.vob', '.rmvb']);

function getFfmpeg() { return findTool('ffmpeg'); }

function collectVideos(dir, recursive) {
  const out = [];
  const walk = (d) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return; }
    for (const n of names) {
      const full = path.join(d, n);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) { if (recursive) walk(full); continue; }
      if (VIDEO_EXTS.has(path.extname(n).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function sumFileSize(files) {
  let total = 0;
  for (const f of files) {
    try { total += fs.statSync(f).size; } catch (e) { /* 读不到就跳过 */ }
  }
  return total;
}

// 读视频基本信息。ffmpeg -i 不带输出参数时会把 MediaInfo 打到 stderr。
// （项目里已经有 probeFile 用于"文件属性弹窗"，但那个返回的是给人看的字符串，
//   这里要的是能参与计算和拼命令的数值，所以单独解析一份。）
function probeVideo(file) {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    if (!ff) return resolve(null);
    const p = spawn(ff, ['-hide_banner', '-i', file], { windowsHide: true });
    let buf = '';
    const onData = (b) => { buf += decodeOut(b); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const lines = buf.split(/\r?\n/);
      const pick = (re) => lines.find((l) => re.test(l)) || '';

      const dm = pick(/\bDuration:/).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;

      // 总码率：Duration 行末尾的 "bitrate: 6794 kb/s"
      const dmLine = pick(/\bDuration:/);
      const totalBr = (dmLine.match(/bitrate:\s*(\d+)\s*kb\/s/) || [])[1] || '';

      const vLine = pick(/Stream #[\d:]+.*?Video:/);
      const vres = vLine.match(/(\d{2,5})x(\d{2,5})/);
      const vcodec = (vLine.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
      const vfps = (vLine.match(/([\d.]+)\s*fps/) || [])[1] || '';
      // 视频流自己的码率（有些容器不写，那就空着）
      const vBr = (vLine.match(/(\d+)\s*kb\/s/) || [])[1] || '';

      const aLine = pick(/Stream #[\d:]+.*?Audio:/);
      const acodec = (aLine.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
      const aBr = (aLine.match(/(\d+)\s*kb\/s/) || [])[1] || '';

      const nStreams = lines.filter((l) => /Stream #[\d:]+/.test(l)).length;
      const hasSub = lines.some((l) => /Stream #[\d:]+.*?Subtitle:/.test(l));

      resolve({
        duration,
        width: vres ? +vres[1] : 0,
        height: vres ? +vres[2] : 0,
        vcodec,
        acodec,
        fps: vfps ? Math.round(parseFloat(vfps) * 100) / 100 : 0,
        streams: nStreams,
        hasSub,
        // 码率统一用 bps 存（便于计算）。视频流码率优先，读不到就留 0，
        // 由调用方按「总码率 - 音频」估算（见 estimateVideoBitrate）。
        bitrate: totalBr ? +totalBr * 1000 : 0,
        vbitrate: vBr ? +vBr * 1000 : 0,
        abitrate: aBr ? +aBr * 1000 : 0,
      });
    });
  });
}

// ---------- 视频合并：探测与兼容性判定 ----------
// 比 probeVideo 多要三样东西：**像素格式**、**视频轨时间基(tbn)**、**有没有音轨**。
// 这三项直接决定"能不能不重新编码就拼起来"，缺任何一个都可能拼出坏文件：
//   · 时间基不同 → concat 不会报错，但第二段时间戳从 0 重来 → 时长错、播放跳（实测踩过）
//   · 音轨有无不同 → 滤镜模式直接报 "Stream specifier ':a' ... matches no streams"
//   · 编码/分辨率/像素格式不同 → 只能重编码
function probeForMerge(file) {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    if (!ff) return resolve(null);
    const p = spawn(ff, ['-hide_banner', '-i', file], { windowsHide: true });
    let buf = '';
    const onData = (b) => { buf += decodeOut(b); };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', () => resolve(null));
    p.on('close', () => {
      const lines = buf.split(/\r?\n/);
      const pick = (re) => lines.find((l) => re.test(l)) || '';

      const dm = pick(/\bDuration:/).match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
      const duration = dm ? (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]) : 0;

      const vLine = pick(/Stream #[\d:]+.*?Video:/);
      const vcodec = (vLine.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
      const res = vLine.match(/(\d{2,5})x(\d{2,5})/);
      // 像素格式紧挨在分辨率前面，可能带括号补充（yuv420p(tv, progressive) / yuv420p10le(tv, bt2020nc/...)）。
      // 前面锚上 [,\s] 是为了别从 "yuv420p" 中间开始匹配出 "uv420p"。
      const pf = vLine.match(/[,\s]([a-z][a-z0-9_]{2,})(?:\([^)]*\))?,\s*\d{2,5}x\d{2,5}/);
      // 时间基形如 "24k tbn" / "12288 tbn" / "1k tbn"
      const tb = vLine.match(/([\d.]+)(k?)\s*tbn/);
      const tbn = tb ? Math.round(parseFloat(tb[1]) * (tb[2] ? 1000 : 1)) : 0;
      const fps = (vLine.match(/([\d.]+)\s*fps/) || [])[1] || '';

      const aLine = pick(/Stream #[\d:]+.*?Audio:/);
      const acodec = (aLine.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
      const aRate = (aLine.match(/(\d+)\s*Hz/) || [])[1] || '';

      let size = 0;
      try { size = fs.statSync(file).size; } catch (e) { /* 读不到就按 0 */ }

      resolve({
        file,
        name: path.basename(file),
        duration,
        vcodec,
        acodec,
        width: res ? +res[1] : 0,
        height: res ? +res[2] : 0,
        pixFmt: pf ? pf[1] : '',
        tbn,
        fps: fps ? Math.round(parseFloat(fps) * 100) / 100 : 0,
        hasAudio: !!aLine,
        audioRate: aRate ? +aRate : 0,
        size,
      });
    });
  });
}

// 判定这批视频能不能"无损拼接"。返回 problems 里写清每一项不一致，
// 而不是只丢一个"不能合并"——用户要知道是哪一步卡住，才知道该怎么处理。
// opts.ignoreAudio：要换掉原声时，音轨有没有/编码是否一致就无所谓了，不必拦
function checkMergeCompat(infos, opts) {
  const ignoreAudio = !!(opts && opts.ignoreAudio);
  const problems = [];
  const fail = (msg) => { if (!problems.includes(msg)) problems.push(msg); };
  const uniq = (arr) => [...new Set(arr)];

  const bad = (infos || []).filter((i) => !i || !i.width || !i.vcodec || !i.duration);
  if (bad.length) {
    fail('有文件读不出信息：' + bad.map((i) => (i && i.name) || '未知文件').join('、'));
  }
  const many = (infos || []).length >= 2;
  if (!many) fail('至少要选 2 个视频才能合并');
  if (problems.length) return { ok: false, problems, totalSec: 0, tbn: 0 };

  if (uniq(infos.map((i) => i.vcodec)).length > 1) {
    fail('视频编码不一致：' + uniq(infos.map((i) => i.vcodec)).join(' / '));
  }
  const resSet = uniq(infos.map((i) => i.width + '×' + i.height));
  if (resSet.length > 1) fail('分辨率不一致：' + resSet.join(' / '));
  const pfSet = uniq(infos.map((i) => i.pixFmt || '未知'));
  if (pfSet.length > 1) fail('像素格式不一致：' + pfSet.join(' / '));

  // 音轨：要么全有、要么全无；都有时编码和采样率都要一致（否则流复制不了）
  const withAudio = infos.filter((i) => i.hasAudio);
  if (withAudio.length > 0 && withAudio.length < infos.length) {
    const names = infos.filter((i) => !i.hasAudio).map((i) => i.name).join('、');
    fail('音轨情况不一致（这些没有声音）：' + names);
  } else if (withAudio.length === infos.length) {
    const acSet = uniq(infos.map((i) => i.acodec));
    if (acSet.length > 1) fail('音频编码不一致：' + acSet.join(' / '));
    const rateSet = uniq(infos.map((i) => i.audioRate));
    if (rateSet.length > 1) fail('音频采样率不一致：' + rateSet.map((r) => r + 'Hz').join(' / '));
  }

  const totalSec = infos.reduce((s, i) => s + i.duration, 0);
  return {
    ok: problems.length === 0,
    problems,
    totalSec,
    tbn: Math.max(...infos.map((i) => i.tbn || 0)),
    tbnSet: uniq(infos.map((i) => i.tbn || 0)),
  };
}

// mp4 容器放得下的编码（决定输出用 mp4 还是 mkv）
const MERGE_MP4_VCODECS = new Set(['h264', 'hevc', 'av1', 'mpeg4', 'vp9']);
const MERGE_MP4_ACODECS = new Set(['aac', 'mp3', 'opus', 'ac3', 'eac3', 'alac', 'flac']);

// ---------- 视频预览：直接把原片交给 <video>，不做任何转制 ----------
// 用户明确要求：不浪费时间也不占硬盘，所以这里没有任何"转代理"的路径。
// 能不能播取决于编码 + 硬件加速状态 —— HEVC 在硬件加速开着时能直接播（实测 1080×1920 正常，
// 见上面启动开关的说明）；放不出来时前端会给一个「用系统播放器打开」的按钮兜底。
ipcMain.handle('get_video_url', (e, file) => {
  const f = String(file || '');
  try { fs.statSync(f); } catch (err) { return { ok: false, msg: '文件读不到了' }; }
  return { ok: true, url: pathToFileURL(f).href };
});

// ---------- 外部播放器兜底 ----------
// 为什么不能只交给"系统默认播放器"：Win11 默认的「媒体播放器」**同样依赖系统的 HEVC 解码组件**，
// 在那台缺组件的机器上点开还是放不了，兜底等于没兜住。
// PotPlayer / VLC / MPV 这三家都**自带解码器**（内含 ffmpeg 软解），谁都不依赖，所以优先找它们。
//
// 找法四条路，按可靠性排序：
//   ⓪ 用户在设置里**手动指定**的播放器 —— 最可靠（见 config.external_player）。
//      为什么必须有这条：前三条路都可能失效（reg.exe 被安全软件拦、播放器装在冷门目录），
//      光靠自动检测在某些机器上就是找不到。手动指定是唯一"一定能兜住"的方案。
//   ① 注册表 App Paths —— 最准，能覆盖"装在 D 盘自定义目录"（本机 PotPlayer 就在 D:\2025soft\）
//      但它要调用 reg.exe，**有些环境会拦这个程序**（我自己的开发环境就被安全策略拦了，EPERM），
//      所以它失败时要能安静降级，不能当成"没装"。
//   ② 标准安装路径扫描（含常见数据盘）—— 不依赖外部命令，覆盖绝大多数正常安装
//   ③ 都没有 → shell.openPath 交给系统默认播放器。装了 PotPlayer 的人多半把它设成了默认，
//      实际也能用；真不行时前端会提示"装一个 VLC 或 PotPlayer"。
const EXTERNAL_PLAYERS = [
  {
    name: 'PotPlayer',
    exes: ['PotPlayerMini64.exe', 'PotPlayerMini.exe'],
    rel: [
      'Program Files\\DAUM\\PotPlayer\\PotPlayerMini64.exe',
      'Program Files\\PotPlayer\\PotPlayerMini64.exe',
      'Program Files (x86)\\DAUM\\PotPlayer\\PotPlayerMini.exe',
      'PotPlayer\\PotPlayerMini64.exe',
      // 播放器装在数据盘的"软件目录"下很常见，把这类习惯性目录也列上
      '2025soft\\PotPlayer\\PotPlayerMini64.exe',
      'Software\\PotPlayer\\PotPlayerMini64.exe',
      'Programs\\PotPlayer\\PotPlayerMini64.exe',
      'soft\\PotPlayer\\PotPlayerMini64.exe',
    ],
    userRel: ['Programs\\PotPlayer\\PotPlayerMini64.exe'],
  },
  {
    name: 'VLC',
    exes: ['vlc.exe'],
    rel: [
      'Program Files\\VideoLAN\\VLC\\vlc.exe',
      'Program Files (x86)\\VideoLAN\\VLC\\vlc.exe',
      'VideoLAN\\VLC\\vlc.exe',
      '2025soft\\VLC\\vlc.exe',
      'Software\\VLC\\vlc.exe',
      'Programs\\VideoLAN\\VLC\\vlc.exe',
      'soft\\VLC\\vlc.exe',
    ],
    userRel: ['Programs\\VideoLAN\\VLC\\vlc.exe'],
  },
  {
    name: 'MPV',
    exes: ['mpv.exe'],
    rel: [
      'Program Files\\mpv\\mpv.exe',
      'mpv\\mpv.exe',
      '2025soft\\mpv\\mpv.exe',
      'Software\\mpv\\mpv.exe',
      'Programs\\mpv\\mpv.exe',
      'soft\\mpv\\mpv.exe',
    ],
    userRel: ['Programs\\mpv\\mpv.exe'],
  },
];

// 标准路径要连数据盘一起扫：把播放器装 D 盘的人不少（本机就是）。
// ⚠️ userRel（用户目录下的）必须按播放器各给各的 —— 早先把这几个路径统一塞进公共列表，
//    结果遍历 PotPlayer 时命中了别的播放器的 exe，报出来的名字是错的（踩过）。
function playerStdPaths(p) {
  const out = [];
  for (const d of ['C', 'D', 'E', 'F', 'G']) {
    for (const r of p.rel) out.push(d + ':\\' + r);
  }
  const local = process.env.LOCALAPPDATA || '';
  if (local) {
    for (const r of (p.userRel || [])) out.push(path.join(local, r));
  }
  return out;
}

// 读注册表 App Paths。reg.exe 被拦 / 不存在时静默返回空，不影响下面的路径扫描
let regBlocked = false;
function queryAppPath(exe) {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg', ['query',
        `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m) {
        const p = m[1].trim().replace(/^"|"$/g, '');
        if (p && fs.existsSync(p)) return p;
      }
    } catch (e) {
      regBlocked = true;    // EPERM / 找不到 key 都会走到这，无法细分，按"可能被拦"记下
    }
  }
  return '';
}

let externalPlayerCache;    // undefined = 还没查过；null = 查过了但没有
function findExternalPlayer() {
  if (externalPlayerCache !== undefined) return externalPlayerCache;
  externalPlayerCache = null;

  // ⓪ 用户手动指定的优先。**这一条不看文件是否存在就返回** ——
  //    用户既然显式指了，就照他说的用（他可能指向一个我们没见过的播放器，
  //    也可能那文件刚好在网盘/移动盘上此刻没挂载，不该替他否决）。
  //    但路径压根填错时要能发现，所以 existsSync 的结果一并返回给前端做提示。
  const manual = (cfg.external_player || '').trim();
  if (manual) {
    externalPlayerCache = {
      name: path.basename(manual).replace(/\.exe$/i, ''),
      path: manual,
      via: 'manual',
      exists: fs.existsSync(manual),
    };
    return externalPlayerCache;
  }

  for (const p of EXTERNAL_PLAYERS) {
    for (const exe of p.exes) {
      const hit = queryAppPath(exe);      // ① 注册表
      if (hit) { externalPlayerCache = { name: p.name, path: hit, via: 'registry', exists: true }; return externalPlayerCache; }
    }
    for (const f of playerStdPaths(p)) {  // ② 标准路径（多盘符）
      try {
        if (f && fs.existsSync(f)) { externalPlayerCache = { name: p.name, path: f, via: 'path', exists: true }; return externalPlayerCache; }
      } catch (e) { /* 路径非法就跳过 */ }
    }
  }
  return externalPlayerCache;
}

// 用户在设置页改了播放器路径 → 存配置 + **清掉缓存**（否则旧结果会一直用下去）
ipcMain.handle('set_external_player', (e, p) => {
  const v = typeof p === 'string' ? p.trim() : '';
  cfg.external_player = v;
  saveConfig(cfg);
  externalPlayerCache = undefined;      // 关键：下次 findExternalPlayer 重新查
  return v;
});

// 从磁盘挑可执行文件（给设置页的「浏览」按钮用）
ipcMain.handle('pick_external_player', async () => {
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const r = await openDialogRemembered(win, 'player_exe', {
    title: '选择播放器程序',
    properties: ['openFile'],
    filters: [{ name: '可执行文件', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return '';
  return r.filePaths[0];
});

// 玻璃皮肤的背景流体性能档位。改完即存，前端会同步调用 __fluid.setTier 立即生效。
ipcMain.handle('set_perf_tier', (e, t) => {
  const v = ['auto', 'high', 'low'].includes(t) ? t : 'auto';
  cfg.perf_tier = v;
  saveConfig(cfg);
  return v;
});

/* 显卡 / 渲染能力自检 —— 给环境检测页用。
   回答三个问题：① 显卡是谁 ② 玻璃皮肤的流体背景能不能画 ③ 现在跑在哪个启动档位。

   关于 getGPUFeatureStatus()：它报的是 Chromium 各合成通道的软硬件状态，
   值域是 enabled / disabled_software / disabled_off 这类字符串，不是布尔。
   在"关硬件加速"或"GPU 进程起不来"的机器上，这里能看到 disabled_software
   —— 正好是用户想知道的那件事。取不到就返回空对象，由前端按未知处理。 */
ipcMain.handle('get_render_caps', async () => {
  let gpu = {};
  let features = {};
  try { gpu = app.getGPUInfo ? await app.getGPUInfo('basic') : {}; } catch (e) { gpu = {}; }
  try { features = app.getGPUFeatureStatus ? app.getGPUFeatureStatus() : {}; } catch (e) { features = {}; }

  // 从 GPU 信息里挑出我们真会展示的字段，别把整棵树丢给前端
  const devices = [];
  try {
    for (const g of (gpu.gpuDevice || [])) {
      devices.push({
        vendor: g.vendorString || g.vendorId || '',
        device: g.deviceString || g.deviceId || '',
        driver: g.driverVersion || '',
      });
    }
  } catch (e) { /* 结构对不上就算了 */ }

  return {
    compatLevel: COMPAT_LEVEL,          // 0 标准 / 1 +no-sandbox / 2 +in-process-gpu / 3 关硬件加速
    hwDisabled: HW_DISABLED,
    auxAttributes: (gpu.auxAttributes && gpu.auxAttributes.glRenderer) || '',  // 形如 ANGLE (Intel, ...)
    devices,
    // 只挑前端要显示的两项，避免把 Chromium 的十几个通道名全漏出去
    features: {
      gpu_compositing: features.gpu_compositing || '',
      webgl2: features.webgl2 || '',
      video_decode: features.video_decode || '',
    },
    perfTier: cfg.perf_tier || 'auto',
  };
});

// 环境检测页和"预览失败"提示都要用：应用内能不能播、外部兜底该找谁
ipcMain.handle('get_playback_caps', () => {
  const pl = findExternalPlayer();
  return {
    hwDisabled: HW_DISABLED,
    appPreview: !HW_DISABLED,
    // regBlocked 只是提示"注册表那条路没走通"，不代表没装播放器（路径扫描可能已经找到了）。
    // ⚠️ 这个字段**只进日志、不上界面** —— 安全软件拦了 reg.exe 是用户环境的事，
    //    摊在界面上只会让人以为"我的电脑有问题"（见 web/ui/app.js 的渲染逻辑）。
    regBlocked,
    external: pl ? { name: pl.name, path: pl.path, via: pl.via, exists: pl.exists !== false } : null,
    // 用户手填的路径（没填就是空串），设置页要用它回显
    manualPath: (cfg.external_player || '').trim(),
  };
});

// 用外部播放器打开：优先自带解码器的，都没有才退回系统默认
ipcMain.handle('open_in_player', async (e, filePath) => {
  const f = String(filePath || '');
  try { fs.statSync(f); } catch (err) { return { ok: false, msg: '文件读不到了' }; }

  const pl = findExternalPlayer();
  if (pl) {
    try {
      const child = spawn(pl.path, [f], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, player: pl.name };
    } catch (err) { /* 起不来就退回系统默认 */ }
  }
  try {
    const err = await shell.openPath(f);
    return err ? { ok: false, msg: err } : { ok: true, player: '' };
  } catch (err) { return { ok: false, msg: String(err) }; }
});

// ---------- 关键帧扫描（无损修剪的精度由它决定） ----------
// -skip_frame nokey 让 ffmpeg 只解关键帧，比全解码快得多（16 秒的片子 0.5 秒扫完）。
// 结果按「路径 + mtime + 大小」缓存，同一个文件不重复扫。
const kfCache = new Map();

function scanKeyframes(file) {
  return new Promise((resolve) => {
    const ff = getFfmpeg();
    if (!ff) return resolve([]);
    let st;
    try { st = fs.statSync(file); } catch (e) { return resolve([]); }
    const key = file + '|' + st.mtimeMs + '|' + st.size;
    if (kfCache.has(key)) return resolve(kfCache.get(key));

    const p = spawn(ff, ['-hide_banner', '-skip_frame', 'nokey', '-i', file,
      '-vf', 'showinfo', '-an', '-f', 'null', '-'], { windowsHide: true });
    let buf = '';
    p.stdout.on('data', (b) => { buf += decodeOut(b); });
    p.stderr.on('data', (b) => { buf += decodeOut(b); });
    p.on('error', () => resolve([]));
    p.on('close', () => {
      const list = [];
      const re = /pts_time:([\d.]+)/g;
      let m;
      while ((m = re.exec(buf))) list.push(parseFloat(m[1]));
      // 起点按 0 兜底：很多容器第一个关键帧不在 0
      if (!list.length || list[0] > 0.001) list.unshift(0);
      list.sort((a, b) => a - b);
      if (kfCache.size > 200) kfCache.clear();
      kfCache.set(key, list);
      resolve(list);
    });
  });
}

/* 把起点吸附到「最近的关键帧」。
   为什么不只往后吸（对齐到前一个关键帧）：实测这批片源关键帧间隔 2.5 秒，
   用户填 2.0 秒、往后吸会落到 0.0 秒 —— 等于什么都没剪，用户会以为功能坏了。
   取最近的那个，误差最小，方向也最符合"我要从这儿开始"的直觉。
   实测 2.0 秒 → 2.5 秒（差 0.5），比落到 0.0 秒（差 2.0）合理得多。 */
function snapToNearestKeyframe(list, t) {
  if (!list || !list.length) return t;
  let best = list[0];
  let bestD = Math.abs(list[0] - t);
  for (const k of list) {
    const d = Math.abs(k - t);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

// ---------- 视频任务（串行执行：编码吃满 CPU/GPU，并行只会互相拖慢） ----------
let vidJobSeq = 0;
const vidJobs = new Map();
const vidProcs = new Map();   // jobId -> Set<ChildProcess>

function fmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(ss.toFixed(3)).padStart(6, '0')}`;
}

// 把 "0:01:23.500" / "83.5" / "1:23" 解析成秒
function parseTimeStr(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map((x) => parseFloat(x));
  if (parts.some((x) => isNaN(x))) return NaN;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

// 各质量档 → 具体编码参数。数值来自在真实 HEVC 片源上的实测：
//   硬件 hevc cq28 省 42% / cq32 省 64% / cq36 省 77%
//   软件 x265 crf23 省 64% / crf26 省 75%
// 注意 NVENC 的 -cq 与 x265 的 -crf 不是一个量纲，所以分开给值。
const VQ = {
  高: { nv: 28, sw: 21 },
  中: { nv: 32, sw: 24 },
  低: { nv: 36, sw: 27 },
};

// 编码器表：key → { label, enc, args(质量档), ext, tag }
const VENC = {
  hevc_nv: { label: 'HEVC 硬件加速 (NVENC)', hw: true },
  hevc_sw: { label: 'HEVC 软件 (x265，慢但更省)', hw: false },
  h264_nv: { label: 'H.264 硬件加速 (NVENC)', hw: true },
  h264_sw: { label: 'H.264 软件 (x264)', hw: false },
  av1_nv: { label: 'AV1 硬件加速 (NVENC)', hw: true },
};

function videoEncArgs(enc, q) {
  const Q = VQ[q] || VQ['中'];
  switch (enc) {
    case 'hevc_nv':
      return ['-c:v', 'hevc_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Q.nv), '-b:v', '0'];
    case 'h264_nv':
      return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Q.nv), '-b:v', '0'];
    case 'av1_nv':
      return ['-c:v', 'av1_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Q.nv), '-b:v', '0'];
    case 'h264_sw':
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(Q.sw)];
    case 'hevc_sw':
    default:
      // hvc1 是给 Apple 系播放器认的 HEVC 标签，不写有些播放器认不出
      return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(Q.sw), '-tag:v', 'hvc1'];
  }
}

// 探测哪些硬件编码器真的能用（有卡、驱动对、且 ffmpeg 带 nvenc）
let hwEncCache = null;
function detectHwEncoders() {
  if (hwEncCache) return hwEncCache;
  const ff = getFfmpeg();
  const ok = { hevc_nv: false, h264_nv: false, av1_nv: false };
  if (!ff) { hwEncCache = ok; return ok; }
  // 真跑一次编码才算数：编码器编进 ffmpeg 不代表这台机器有能用的 GPU。
  // 尺寸不能太小 —— 实测 64x64 会让 NVENC 直接报错（退出码 -22），320x240 才稳。
  for (const [key, enc] of [['hevc_nv', 'hevc_nvenc'], ['h264_nv', 'h264_nvenc'], ['av1_nv', 'av1_nvenc']]) {
    try {
      execFileSync(ff, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
        '-t', '0.2', '-c:v', enc, '-preset', 'p6', '-f', 'null', '-'],
        { timeout: 30000, stdio: 'ignore', windowsHide: true });
      ok[key] = true;
    } catch (e) { ok[key] = false; }
  }
  hwEncCache = ok;
  return ok;
}

function registerVidProc(jobId, proc) {
  if (!vidProcs.has(jobId)) vidProcs.set(jobId, new Set());
  vidProcs.get(jobId).add(proc);
  const drop = () => {
    const s = vidProcs.get(jobId);
    if (s) { s.delete(proc); if (!s.size) vidProcs.delete(jobId); }
  };
  proc.on('close', drop);
  proc.on('error', drop);
}

function killVidJob(jobId) {
  const s = vidProcs.get(jobId);
  if (!s) return 0;
  let n = 0;
  for (const p of s) {
    try {
      if (process.platform === 'win32' && p.pid) {
        const k = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
        k.on('error', () => { try { p.kill(); } catch (_) {} });
      } else p.kill();
      n++;
    } catch (_) { /* 已退出 */ }
  }
  return n;
}

// 跑一个 ffmpeg 进程，带进度回调。expectedSec 用于把 out_time 折算成百分比。
// progressChannel：进度推到哪个通道。默认 'video-progress'（视频处理页）；
// 「转 30 帧」用 'fps-progress' 单独一条 —— 否则会和视频处理页的进度条串在一起。
// extra：附加到每条进度事件里的字段（「转 30 帧」用它带上 file，前端才能对准是哪一行）
function runFfmpegOnce({ ff, args, jobId, taskId, expectedSec, label, onLog, progressChannel, extra }) {
  const chan = progressChannel || 'video-progress';
  const withExtra = (obj) => Object.assign({ jobId }, obj, extra || {});
  return new Promise((resolve) => {
    const full = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args];
    onLog(`>>> ${label}`, 'dim', taskId);
    onLog('>>> ' + ff.split('\\').pop() + ' ' + full.join(' '), 'dim', taskId);

    const proc = spawn(ff, full, { windowsHide: true });
    registerVidProc(jobId, proc);

    let stdoutTail = '';   // 只保留最后一段，用于错误说明
    let lastPct = -1;

    proc.stdout.on('data', (buf) => {
      const text = decodeOut(buf);
      for (const line of text.split(/[\r\n]+/)) {
        const t = line.trim();
        if (!t) continue;
        // 形如 out_time=00:00:02.050000 / out_time_us=2050000 / progress=continue|end
        const m = t.match(/^out_time=(\d+):(\d+):([\d.]+)/);
        if (m && expectedSec > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.max(0, Math.min(100, (cur / expectedSec) * 100));
          if (pct - lastPct >= 0.4) {
            lastPct = pct;
            sendToRenderer(chan, withExtra({ percent: pct, detail: `已处理 ${fmtTime(cur)} / ${fmtTime(expectedSec)}` }));
          }
        }
        if (/^progress=end/.test(t)) {
          sendToRenderer(chan, withExtra({ percent: 100, detail: '收尾中…' }));
        }
      }
    });
    proc.stderr.on('data', (buf) => {
      const text = decodeOut(buf).trim();
      if (!text) return;
      stdoutTail = (stdoutTail + '\n' + text).slice(-1500);
      for (const line of text.split(/\r?\n/)) {
        const l = line.trim();
        if (!l) continue;
        // ffmpeg 不报错时会把整段输入信息（流列表、元数据）打到 stderr，那些对用户没用，
        // 只放行带 [模块] 前缀的行和真正的错误行；进度统计行也不写（进度条已经在显示了）。
        // 注意别把 "Unknown" 单独当错误关键字 —— ffmpeg 的 "Unknown cover type"
        // 只是个无害的警告，会被误标成红色错误行。
        if (/error|invalid|failed|No such|unable|not supported|already exists/i.test(l)) {
          onLog(l, 'err', taskId);
        } else if (/^\[[^\]]+\]/.test(l) &&
                   !/frame=|speed=|^\[(out|Parsed)|Starting second pass|moov atom|Unknown cover type|Press \[q\]/i.test(l)) {
          onLog(l, 'dim', taskId);
        }
      }
    });
    proc.on('error', (e) => resolve({ code: -1, err: String(e) }));
    proc.on('close', (code) => resolve({ code, err: code === 0 ? '' : lastMeaningfulLine(stdoutTail) }));
  });
}

function lastMeaningfulLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|invalid|failed|No such|unable|not supported|Unknown/i.test(lines[i])) return lines[i];
  }
  return lines.length ? lines[lines.length - 1] : '';
}

// 输出文件名：源目录旁加后缀；重名时自动加序号，绝不覆盖源文件。
function uniqueOutPath(dir, base, suffix, ext) {
  let p = path.join(dir, base + suffix + ext);
  let n = 2;
  while (fs.existsSync(p)) {
    p = path.join(dir, `${base}${suffix}_${n}${ext}`);
    n++;
    if (n > 999) break;
  }
  return p;
}

// 处理单个视频。mode: 'trim' | 'compress'
async function processOneVideo(file, opt, job) {
  const ff = getFfmpeg();
  const st = fs.statSync(file);
  const before = st.size;
  const srcExt = path.extname(file);
  const base = path.basename(file, srcExt);
  const outDir = opt.outMode === 'custom' && opt.outDir ? opt.outDir : path.dirname(file);
  fs.mkdirSync(outDir, { recursive: true });

  const info = await probeVideo(file);
  if (!info || !info.duration) {
    return { ok: false, msg: '读不到视频时长，可能不是有效的视频文件', before };
  }

  const onLog = (text, cls, taskId) => pushLog(text, cls, taskId || job.taskId, 'video');

  if (opt.mode === 'trim') {
    const wantStart = parseTimeStr(opt.start);
    const wantEnd = parseTimeStr(opt.end);
    if (isNaN(wantStart) || isNaN(wantEnd)) return { ok: false, msg: '起止时间格式不对', before };
    if (wantEnd <= wantStart) return { ok: false, msg: '结束时间必须晚于开始时间', before };

    // 起点吸附到最近的关键帧（保证首帧可解码），终点按原值（终点不需要落在关键帧上）
    const kfs = await scanKeyframes(file);
    let start = Math.max(0, Math.min(snapToNearestKeyframe(kfs, wantStart), wantEnd - 0.05));
    const end = Math.min(wantEnd, info.duration);
    let dur = end - start;
    if (dur <= 0.05) return { ok: false, msg: '区间太短', before };

    if (Math.abs(start - wantStart) > 0.02) {
      onLog(`>>> 起点吸附：你填的 ${fmtTime(wantStart)} 不是关键帧，已对齐到最近的关键帧 ${fmtTime(start)}` +
        (kfs.length > 1 ? `（本片关键帧间隔约 ${kfs[1] - kfs[0]} 秒，这是无损剪切的精度上限）` : ''),
        'warn', job.taskId);
    }

    const ext = srcExt || '.mp4';
    const outPath = uniqueOutPath(outDir, base, '_trim', ext);
    const args = [
      '-ss', start.toFixed(3), '-to', end.toFixed(3),
      '-i', file,
      '-map', '0',
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y', outPath,
    ];
    const r = await runFfmpegOnce({
      ff, args, jobId: job.id, taskId: job.taskId, expectedSec: dur,
      label: `无损修剪 ${fmtTime(start)} → ${fmtTime(end)}（不重编码）`, onLog,
    });
    if (r.code !== 0) return { ok: false, msg: r.err || ('ffmpeg exit ' + r.code), before };

    const after = fs.statSync(outPath).size;
    return { ok: true, before, after, outPath, actualStart: start, actualEnd: end, wantStart, wantEnd };
  }

  // ---------- 压缩（重新编码） ----------
  const encKey = VENC[opt.encoder] ? opt.encoder : 'hevc_nv';
  const vargs = videoEncArgs(encKey, opt.quality);

  const args = ['-i', file];
  // 缩放：只缩不放。用探到的宽高先判断，避免把 720p 放大成 1080p。
  const maxH = Number(opt.maxHeight) || 0;
  if (maxH > 0 && info.height > maxH) {
    args.push('-vf', `scale=-2:${maxH}`);
    onLog(`>>> 缩放：${info.width}×${info.height} → 宽自适应 × ${maxH}`, 'dim', job.taskId);
  }
  args.push(...vargs);
  if (opt.audio === 'aac') args.push('-c:a', 'aac', '-b:a', '128k');
  else args.push('-c:a', 'copy');
  const ext = opt.container === 'mkv' ? '.mkv' : '.mp4';
  const outPath = uniqueOutPath(outDir, base, '_compressed', ext);
  if (ext === '.mp4') args.push('-movflags', '+faststart');
  args.push('-y', outPath);

  onLog(`>>> 编码：${VENC[encKey].label} · 质量「${opt.quality}」${maxH ? ' · 最高 ' + maxH + 'p' : ''}` +
    ` · 音频${opt.audio === 'aac' ? '转 AAC 128k' : '原样复制'}`, 'dim', job.taskId);

  let r = await runFfmpegOnce({
    ff, args, jobId: job.id, taskId: job.taskId, expectedSec: info.duration,
    label: '压缩中', onLog,
  });

  // 音频复制失败（常见：opus/vorbis 塞不进 mp4）→ 自动改转 AAC 再试一次
  if (r.code !== 0 && opt.audio !== 'aac' && /audio|codec|not supported|incompatible/i.test(r.err + '')) {
    onLog('>>> 音频无法直接复制到该容器，改为转 AAC 128k 重试', 'warn', job.taskId);
    const i = args.indexOf('-c:a');
    const retryArgs = args.slice();
    if (i >= 0) retryArgs.splice(i, 2, '-c:a', 'aac', '-b:a', '128k');
    try { fs.unlinkSync(outPath); } catch (e) {}
    r = await runFfmpegOnce({
      ff, args: retryArgs, jobId: job.id, taskId: job.taskId, expectedSec: info.duration,
      label: '压缩重试（音频转 AAC）', onLog,
    });
  }

  if (r.code !== 0) return { ok: false, msg: r.err || ('ffmpeg exit ' + r.code), before };

  const after = fs.statSync(outPath).size;
  return { ok: true, before, after, outPath, grew: after >= before };
}

async function runVideoJob(job) {
  let okCount = 0, errCount = 0, grewCount = 0;
  let sumBefore = 0, sumAfter = 0;

  for (let i = 0; i < job.files.length; i++) {
    if (job.cancelled) break;
    const f = job.files[i];
    job.taskId = `${job.id}-${i + 1}`;
    sendToRenderer('video-progress', { jobId: job.id, percent: 0, detail: `(${i + 1}/${job.files.length}) 准备中…` });
    pushLog(`═══ ${i + 1}/${job.files.length} ${path.basename(f)}`, 'dim', job.taskId, 'video');

    let res;
    try {
      res = await processOneVideo(f, job.opt, job);
    } catch (e) {
      res = { ok: false, msg: (e && e.message) || String(e) };
    }
    if (job.cancelled) break;

    if (res.ok) {
      okCount++;
      sumBefore += res.before || 0;
      sumAfter += res.after || 0;
      if (res.grew) grewCount++;
      const saved = res.before > 0 ? Math.round((1 - res.after / res.before) * 100) : 0;
      pushLog(`>>> ${res.grew ? '注意：压完反而更大' : '完成'}：${humanSize(res.before)} → ${humanSize(res.after)}` +
        (res.grew ? `（大 ${Math.abs(saved)}%）` : `（省 ${saved}%）`), res.grew ? 'warn' : 'ok', job.taskId, 'video');
    } else {
      errCount++;
      pushLog('>>> 失败：' + res.msg, 'err', job.taskId, 'video');
    }

    sendToRenderer('video-item', {
      jobId: job.id,
      name: path.basename(f),
      file: f,
      ok: !!res.ok,
      before: res.before || 0,
      after: res.after || 0,
      outPath: res.outPath || '',
      grew: !!res.grew,
      msg: res.msg || '',
      trimInfo: res.actualStart !== undefined
        ? { wantStart: res.wantStart, start: res.actualStart, end: res.actualEnd }
        : null,
      done: i + 1,
      total: job.files.length,
    });
  }

  sendToRenderer('video-done', {
    jobId: job.id,
    cancelled: !!job.cancelled,
    total: job.files.length,
    okCount, errCount, grewCount, sumBefore, sumAfter,
  });
  pushLog(`>>> 视频处理结束：成功 ${okCount} · 失败 ${errCount}` +
    (grewCount ? ` · 有 ${grewCount} 个反而变大` : '') + (job.cancelled ? '（已中止）' : ''),
    job.cancelled ? 'warn' : 'ok', null, 'video');
  vidJobs.delete(job.id);
}

// ---------- 视频处理的 IPC ----------
ipcMain.handle('pick_videos', async () => {
  const r = await openDialogRemembered(mainWindow, 'videos', {
    title: '选择视频文件',
    filters: [{ name: '视频', extensions: [...VIDEO_EXTS].map((e) => e.slice(1)) }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return { ok: false, files: [], totalBytes: 0 };
  const files = r.filePaths;
  return { ok: true, files, totalBytes: sumFileSize(files) };
});

ipcMain.handle('collect_videos', async (e, recursive) => {
  const r = await openDialogRemembered(mainWindow, 'video_dir', {
    title: '选择视频所在文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, msg: '已取消', files: [], totalBytes: 0 };
  const files = collectVideos(r.filePaths[0], !!recursive);
  return { ok: true, dir: r.filePaths[0], files, totalBytes: sumFileSize(files) };
});

ipcMain.handle('expand_video_paths', (e, paths) => {
  const out = [];
  for (const p of paths || []) {
    let st;
    try { st = fs.statSync(p); } catch (err) { continue; }
    if (st.isDirectory()) out.push(...collectVideos(p, true));
    else if (VIDEO_EXTS.has(path.extname(p).toLowerCase())) out.push(p);
  }
  return { ok: true, files: out, totalBytes: sumFileSize(out) };
});

// 读单个视频的信息（界面选完文件就显示时长/分辨率/编码，并预扫关键帧）
ipcMain.handle('probe_video', async (e, file) => {
  const info = await probeVideo(String(file || ''));
  if (!info) return { ok: false, msg: '读取失败' };
  const kfs = await scanKeyframes(String(file || ''));
  let interval = 0;
  if (kfs.length >= 2) {
    const gaps = [];
    for (let i = 1; i < Math.min(kfs.length, 12); i++) gaps.push(kfs[i] - kfs[i - 1]);
    gaps.sort((a, b) => a - b);
    interval = gaps[Math.floor(gaps.length / 2)] || 0;
  }
  // 把关键帧位置也给前端：填了起点就能立刻算出会吸附到哪儿，不用等跑完才知道。
  // 两小时的片子也就几千个数，直接传没问题。
  return {
    ok: true,
    info,
    keyframes: kfs.length,
    keyInterval: Math.round(interval * 100) / 100,
    kf: kfs.map((x) => Math.round(x * 1000) / 1000),
  };
});

// 把这些可用性告诉界面：ffmpeg 在不在、哪些硬件编码器能用
ipcMain.handle('get_video_caps', () => {
  const hw = detectHwEncoders();
  return {
    ffmpeg: !!getFfmpeg(),
    hw,
    // 兼容模式（上一次启动没跑稳，这次禁用了硬件加速）→ 前端据此调整预览提示
    hwDisabled: HW_DISABLED,
    encoders: Object.keys(VENC).map((k) => ({ key: k, label: VENC[k].label, hw: VENC[k].hw, usable: !VENC[k].hw || !!hw[k] })),
  };
});

/* ---------- 下载完成后的「转为 30 帧」 ----------
   为什么要有这个功能：YouTube 的高清档（720p 以上）对 60fps 源视频只提供 60fps 版本，
   下载时用 [fps<=30] 去挑会一路掉到 480p（实测过，清晰度暴跌）。所以降帧只能放在下载之后做。
   60fps 是真帧的话，fps=30 就是纯抽帧，零画质损失（实测 PSNR 40.7 dB）；
   分辨率完全不动，只是帧数减半 —— 送给 Topaz 之类的逐帧处理时能省一半时间。
   输出新文件（xxx_30fps.<原容器>），绝不覆盖源文件。

   音频处理：优先 -c:a copy（零损失）。但 webm 常见的 opus 塞不进 mp4/mov 容器，
   所以当「容器与音频编码不兼容」时自动转 aac，否则会产出放不出来的文件。 */
const FPS_OUT_EXTS = new Set(['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.ts', '.m4v']);

function audioNeedsAac(srcExt, acodec) {
  const a = String(acodec || '').toLowerCase();
  if (!a) return false;
  // 这些音频编码只能待在 mkv/webm 里，装进 mp4/mov 会不兼容
  const incompatible = ['opus', 'vorbis'];
  const isMp4Family = ['.mp4', '.m4v', '.mov'].includes(srcExt);
  return isMp4Family && incompatible.includes(a);
}

/* ── 转 30 帧的目标码率怎么定 ──────────────────────────────────────────
 *
 * 一开始这里用的是「恒定质量」模式（-cq 22）。实测踩了坑：
 * 源是 AV1 编码、总码率只有 6.79Mbps 时，重压成 HEVC 为了满足 CQ 22 的
 * 质量档，编码器一口气给到 20.25Mbps —— 帧数明明减半了，体积却膨胀 3 倍
 * （64.9MB → 193.4MB）。CQ 模式不管文件大小，源压得越狠、重压涨得越凶。
 *
 * 所以改成「按源码率自适应」：源码率本身就是「这段画面需要多少码率」的
 * 最好证据。降帧后帧数减半，理论上同画质只需约一半码率；再考虑到
 * AV1 → HEVC 的效率差（HEVC 同画质约需 AV1 的 1.4~1.7 倍），
 * 两者相抵，目标码率取源码率的若干倍。
 *
 * ── 倍数怎么定（2560×1440 / AV1 6.67Mbps 视频流 / 真 60fps 源）
 * 与「ffv1 无损降帧基准」逐帧比对，全片实测（不是抽帧）：
 *   倍数   全片体积  相对源   PSNR_avg  PSNR_Y  SSIM_All  SSIM_Y
 *   0.80    52.3MB   0.85×     37.91     36.43    0.9620    0.9501
 *   1.00    64.6MB   1.04×     39.04     37.58    0.9691    0.9598
 *   1.25    77.1MB   1.25×     40.02     38.59    0.9741    0.9668   ← 选它
 *   1.55    96.2MB   1.55×     41.27     39.87    0.9792    0.9738
 *   2.05   126.9MB   2.05×     42.85     41.49    0.9843    0.9805
 *   2.98   193.4MB   2.98×     45.05     43.74    0.9891    0.9868（旧 CQ22，体积失控）
 *
 * 选 1.25 的理由：PSNR 40dB 是视频圈公认的「透明级」门槛（多数观看条件下
 * 看不出与源的区别），此时体积 1.25× 源还在合理范围。再往上收益递减很陡 ——
 * 1.25→2.05 体积多 65%，只换回 2.8dB；而旧版买到 45dB 的那部分体积里，
 * 约 130MB 属于「人眼永远用不到」的开销。1.25 是画质与体积的平衡点。
 *
 * 上下限兜底：
 *   - 下限 1.5Mbps：源码率极低的（比如 480p 老视频），别压到糊
 *   - 上限 20Mbps：源码率极高的（比如 60Mbps 录屏），别转出怪物体积
 * 注意源可能是 AV1（同画质比 HEVC 省 30~40%），所以码率相同不代表画质相同 ——
 * 这里的倍数已经把这层换算考虑进去了，不是简单照搬。
 */
const FPS_TARGET_RATIO = 1.25;
const FPS_MIN_BITRATE = 1_500_000;    // 1.5 Mbps
const FPS_MAX_BITRATE = 20_000_000;   // 20 Mbps
const DEFAULT_AUDIO_BPS = 128_000;    // 源音频码率读不到时按此估

/** 估算「视频流」码率（优先用视频流自己的，读不到就总码率减音频，音频也没有按 128k 估） */
function estimateVideoBitrate(info) {
  if (!info) return 0;
  const vbr = Number(info.vbitrate) || 0;
  if (vbr) return vbr;
  const total = Number(info.bitrate) || 0;
  if (!total) return 0;
  const abr = Number(info.abitrate) || DEFAULT_AUDIO_BPS;
  return Math.max(total - abr, 1);
}

/** 按源码率算转 30 帧的目标码率；拿不到源码率时返回 0（调用方退回 CQ 模式） */
function pickFps30Bitrate(info) {
  const vbr = estimateVideoBitrate(info);
  if (!vbr) return 0;
  const target = Math.round(vbr * FPS_TARGET_RATIO);
  return Math.min(Math.max(target, FPS_MIN_BITRATE), FPS_MAX_BITRATE);
}

/* 转 30 帧的主流程。抽成独立函数是为了自检脚本能直接调用同一份代码
   （走 IPC 要跨渲染进程，验证起来更绕）。onLog 可注入，默认写主日志。 */
async function runFps30Convert(file, logFn) {
  const f = String(file || '');
  const onLog = typeof logFn === 'function' ? logFn : (text, cls) => pushLog(text, cls, null, 'video');
  const ff = getFfmpeg();
  if (!ff) return { ok: false, msg: '未找到内置 ffmpeg（见「环境检测」页）' };
  try { fs.statSync(f); } catch (err) { return { ok: false, msg: '源文件读不到了' }; }

  const info = await probeVideo(f);
  if (!info || !info.duration) return { ok: false, msg: '读不到视频信息，可能不是有效的视频文件' };
  if (info.fps && info.fps <= 30.5) {
    return { ok: false, msg: `该视频本来就是 ${info.fps}fps，不需要转换` };
  }

  const srcExt0 = path.extname(f).toLowerCase();
  const srcExt = FPS_OUT_EXTS.has(srcExt0) ? srcExt0 : '.mp4';
  const base = path.basename(f, path.extname(f));
  const outDir = path.dirname(f);
  const outPath = uniqueOutPath(outDir, base, '_30fps', srcExt);

  const useAac = audioNeedsAac(srcExt, info.acodec);
  const jobId = 'fps' + (++vidJobSeq);

  const args = ['-i', f, '-vf', 'fps=30'];
  // 视频：HEVC NVENC。码率按源码率自适应（见 pickFps30Bitrate 的注释），
  // 而不是恒定质量 —— 后者遇到 AV1 源会把体积压涨 3 倍。
  // 万一读不到源码率（少见：老容器没写 bit_rate），退回恒定质量模式兜底。
  const targetBr = pickFps30Bitrate(info);
  args.push('-c:v', 'hevc_nvenc', '-preset', 'p6', '-tune', 'hq');
  if (targetBr) {
    args.push(
      '-rc', 'vbr',
      '-b:v', String(targetBr),
      // maxrate 给 1.6 倍、bufsize 给 3 倍：允许高动态片段超一点，但整体受控
      '-maxrate', String(Math.round(targetBr * 1.6)),
      '-bufsize', String(Math.round(targetBr * 3)),
    );
  } else {
    args.push('-rc', 'vbr', '-cq', '22', '-b:v', '0');
  }
  if (useAac) {
    args.push('-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-c:a', 'copy');
  }
  // HEVC 在 mp4 里要标 hvc1，否则部分播放器/剪辑软件认不出
  if (srcExt === '.mp4' || srcExt === '.m4v' || srcExt === '.mov') args.push('-tag:v', 'hvc1');
  args.push('-y', outPath);

  onLog(`>>> 转为 30 帧：${path.basename(f)}（源 ${info.fps}fps，${info.width}×${info.height}）`, 'dim');
  if (targetBr) {
    const srcV = Math.round(estimateVideoBitrate(info) / 1000);
    onLog(`>>> 目标码率 ${(targetBr / 1e6).toFixed(2)} Mbps（按源视频流 ${srcV} kbps 的 ${FPS_TARGET_RATIO} 倍自适应）`, 'dim');
  } else {
    onLog('>>> 读不到源码率，退回恒定质量模式（CQ 22）', 'warn');
  }
  if (useAac) {
    onLog(`>>> 源音频是 ${info.acodec}，装不进 ${srcExt} 容器，已自动转为 aac`, 'warn');
  }

  const r = await runFfmpegOnce({
    ff, args, jobId, taskId: null, expectedSec: info.duration,
    label: 'FFmpeg 转为 30fps', onLog, progressChannel: 'fps-progress',
    extra: { file: f },
  });

  if (r.code !== 0) {
    try { fs.unlinkSync(outPath); } catch (_) { /* 没生成就算了 */ }
    onLog(`>>> 转 30 帧失败：${r.err || ('exit ' + r.code)}`, 'err');
    sendToRenderer('fps-done', { file: f, ok: false, msg: r.err || ('exit ' + r.code) });
    return { ok: false, msg: r.err || ('exit ' + r.code) };
  }

  const after = fs.statSync(outPath);
  let outFps = 0;
  try {
    const oi = await probeVideo(outPath);
    if (oi) outFps = oi.fps;
  } catch (_) { /* 读不到就算了，不影响主流程 */ }

  onLog(`>>> 已生成 ${path.basename(outPath)}（${outFps || 30}fps · ${humanSize(after.size)}）`, 'ok');
  sendToRenderer('fps-done', {
    file: f, ok: true, out: outPath, outFps: outFps || 30, size: after.size,
  });
  return { ok: true, out: outPath, outFps: outFps || 30, size: after.size, bitrate: targetBr };
}

ipcMain.handle('convert_fps30', (e, file) => runFps30Convert(file));

// ---------- 在线更新 ----------
// 更新源是「静态地址」：那儿只要有 latest.yml（版本清单）+ 安装包就能工作，不需要任何服务端。
// 默认指 GitHub Release 的固定入口 —— releases/latest/download 永远指向最新一版，
// 所以发新版本只要把 exe 和 latest.yml 传上去，地址一个字都不用改。
// 以后要换到自己的 R2 / CDN，改【这一行】或界面上的「更新源」即可，更新逻辑不用动。
const DEFAULT_UPDATE_URL = 'https://github.com/jackyzbn-eng/FallenAngels_ytdlp4k/releases/latest/download';

let updaterRef = null;
let updateState = { phase: 'idle', version: '', percent: 0, detail: '', msg: '' };

function updateFeedUrl() {
  return (cfg.update_url || '').trim() || DEFAULT_UPDATE_URL;
}

function pushUpdateState(patch) {
  updateState = Object.assign({}, updateState, patch || {});
  sendToRenderer('update-status', Object.assign({
    currentVersion: app.getVersion(),
    feedUrl: updateFeedUrl(),
  }, updateState));
}

// electron-updater 的报错全是英文网络异常，用户看了只会懵 —— 翻成一句能行动的话
function updateErrorText(err) {
  const s = String((err && (err.message || err)) || '');
  if (/ECONN|ENOTFOUND|ETIMEDOUT|ERR_CONNECTION|ERR_NAME_NOT_RESOLVED|net::/i.test(s)) {
    return '连不上更新服务器（国内直连 GitHub 通常不通，开着代理再试一次）';
  }
  if (/404|latest\.yml|Cannot find/i.test(s)) {
    return '更新源上没有版本清单 latest.yml —— 这版可能还没上传到发布页';
  }
  if (/sha512|checksum/i.test(s)) {
    return '安装包校验不通过（可能没下完整），重试一次';
  }
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

function getUpdater() {
  if (updaterRef) return updaterRef;
  let au;
  try { au = require('electron-updater').autoUpdater; } catch (e) { return null; }
  updaterRef = au;
  au.autoDownload = false;            // 先问再下，别在用户不知情时占带宽
  au.autoInstallOnAppQuit = true;     // 下完没立刻装，退出时顺手装上
  au.allowPrerelease = false;
  try { au.logger = null; } catch (e) { /* 关掉它自带的日志输出 */ }
  try {
    au.setFeedURL({ provider: 'generic', url: updateFeedUrl() });
  } catch (e) { /* 设不上就退回构建时写进 app-update.yml 的那份 */ }

  au.on('checking-for-update', () => pushUpdateState({ phase: 'checking', msg: '', percent: 0 }));
  au.on('update-available', (info) => pushUpdateState({
    phase: 'available', version: (info && info.version) || '', percent: 0, msg: '',
  }));
  au.on('update-not-available', () => pushUpdateState({ phase: 'latest', version: '', percent: 0, msg: '' }));
  au.on('download-progress', (p) => pushUpdateState({
    phase: 'downloading',
    percent: Math.max(0, Math.min(100, (p && p.percent) || 0)),
    detail: p ? `${humanSize(p.transferred || 0)} / ${humanSize(p.total || 0)}` : '',
  }));
  au.on('update-downloaded', (info) => pushUpdateState({
    phase: 'downloaded', version: (info && info.version) || '', percent: 100,
  }));
  au.on('error', (err) => pushUpdateState({ phase: 'error', msg: updateErrorText(err) }));
  return au;
}

ipcMain.handle('get_update_state', () => ({
  currentVersion: app.getVersion(),
  feedUrl: updateFeedUrl(),
  custom: (cfg.update_url || '').trim(),   // 用户自己填的（空 = 用默认）
  packaged: app.isPackaged,
  state: updateState,
}));

ipcMain.handle('check_update', async () => {
  if (!app.isPackaged) {
    return { ok: false, msg: '开发运行模式下不检查更新（装成安装版后才有意义）' };
  }
  const au = getUpdater();
  if (!au) return { ok: false, msg: '缺少更新模块 electron-updater（这版打包时没装进去）' };
  try {
    pushUpdateState({ phase: 'checking', msg: '', percent: 0 });
    await au.checkForUpdates();
    return { ok: true, state: updateState };
  } catch (e) {
    const m = updateErrorText(e);
    pushUpdateState({ phase: 'error', msg: m });
    return { ok: false, msg: m };
  }
});

ipcMain.handle('download_update', async () => {
  const au = getUpdater();
  if (!au) return { ok: false, msg: '缺少更新模块' };
  try {
    await au.downloadUpdate();
    return { ok: true };
  } catch (e) {
    const m = updateErrorText(e);
    pushUpdateState({ phase: 'error', msg: m });
    return { ok: false, msg: m };
  }
});

// 真正安装：退出应用 → 静默跑新安装包 → 自动启动新版
ipcMain.handle('install_update', () => {
  const au = getUpdater();
  if (!au) return { ok: false, msg: '缺少更新模块' };
  // 延后一点点，让渲染进程先把"正在重启"的提示画出来
  setTimeout(() => {
    try { au.quitAndInstall(false, true); } catch (e) { /* 起不来就留给用户手动装 */ }
  }, 400);
  return { ok: true };
});

// 换更新源（换成自己的 R2/CDN 时用）：存配置 + 清掉已初始化的 updater，下次重新 setFeedURL
ipcMain.handle('set_update_url', (e, url) => {
  cfg.update_url = typeof url === 'string' ? url.trim() : '';
  saveConfig(cfg);
  updaterRef = null;
  updateState = { phase: 'idle', version: '', percent: 0, detail: '', msg: '' };
  return updateFeedUrl();
});

if (typeof module !== 'undefined' && module.exports) {
  // 自检脚本用：暴露内部函数以便直接验证同一份代码
  module.exports.__test = {
    runFps30Convert, pickFps30Bitrate, estimateVideoBitrate, probeVideo,
    // 直链下载（aria2）：自检脚本直接跑完整流程，不必走 GUI
    downloadDirectWorker, parseAriaProgress,
    // 含 emoji 文件名的路径校正：可独立验证匹配逻辑
    resolveActualFile,
    // reportResolution 实际用的核对函数（含路径不存在时的失败分支）
    probeFile,
    // 队列重试：自检脚本可直接造任务验证
    retryTask, tasks,
    // 配置路径：验证「安装新版不丢设置」的存储位置
    configPath, dataDir, appDir,
    // cookies 缓存 + 完整下载流程：验证「带 cookies 被压到 360p」的修复
    downloadWorker, getCached, setCached, loadCache,
    sabrDetected, isRetryableAuthError, childLine, sabrNote,
    // 视频合并：探测 / 兼容性判定 / 完整合并流程
    probeForMerge, checkMergeCompat, runMergeJob,
    // 每个浏览按钮各自的路径记忆
    rememberDir, rememberedDir, loadLastDirs, lastDirsPath,
  };
}

// 转码用哪个编码器：优先硬件（快很多），没卡就退软件；AV1 只能硬件，没有就返回空
function convertEncoderFor(vcodec) {
  const hw = detectHwEncoders();
  if (vcodec === 'hevc') return hw.hevc_nv ? 'hevc_nv' : 'hevc_sw';
  if (vcodec === 'h264') return hw.h264_nv ? 'h264_nv' : 'h264_sw';
  if (vcodec === 'av1') return hw.av1_nv ? 'av1_nv' : '';
  return '';
}

// 选出「多数派规格」，并列出需要转码的段。
// 为什么按多数派：只转少数派 → 大部分视频仍然逐字节原样拷贝，画质损失范围最小。
// 平票时取先出现的那个（顺序稳定，不会今天转 A 明天转 B）。
function pickConvertTargets(infos) {
  const keyOf = (i) => [i.vcodec, i.width, i.height, i.pixFmt].join('|');
  const cnt = new Map();
  for (const i of infos) cnt.set(keyOf(i), (cnt.get(keyOf(i)) || 0) + 1);
  let bestKey = '', bestN = -1, bestInfo = null;
  for (const i of infos) {
    const k = keyOf(i);
    const n = cnt.get(k);
    if (n > bestN) { bestN = n; bestKey = k; bestInfo = i; }
  }
  if (!bestInfo) return null;
  if (!convertEncoderFor(bestInfo.vcodec)) return null;
  const target = {
    vcodec: bestInfo.vcodec, width: bestInfo.width, height: bestInfo.height,
    pixFmt: bestInfo.pixFmt, fps: bestInfo.fps, audioRate: bestInfo.audioRate || 48000,
  };
  const idx = [];
  for (let i = 0; i < infos.length; i++) if (keyOf(infos[i]) !== bestKey) idx.push(i);
  return { target, idx };
}

// ---------- 视频合并：无损拼接 ----------
// 刻意分成三步，每一步都对应一个实测踩过的坑：
//   ① 时间基对齐（只对 tbn 不一致的文件重封装，流复制不重编码）
//   ② concat 分配器 + 流复制拼接
//   ③ 拼完核对时长必须等于各段之和
// 为什么不能一步 concat+copy 完事：实测两个 mp4 时间基一个 24k、一个 12288，
// 直接拼会满屏 "Non-monotonic DTS"，**命令还照样成功退出**，但时长只有 76 秒（应为 110 秒）。
// 这种"静默出错"只能靠第 ③ 步兜住 —— 少了它，用户拿到的就是个看着成功、实际接错的文件。
async function runMergeJob(job) {
  const ff = getFfmpeg();
  // 日志/进度发到哪条通道，由调用方指定 —— 「音视频拼接」页用自己的通道，
  // 免得和「视频处理」页的进度条互相串（两页可能同时有任务）
  const chans = job.chans || { progress: 'video-progress', item: 'video-item', done: 'video-done' };
  const logSrc = job.logSource || 'video';
  const log = (m, lv) => pushLog(m, lv || 'dim', null, logSrc);
  const prog = (p, d) => sendToRenderer(chans.progress, { jobId: job.id, percent: p, detail: d });
  const tmpDir = path.join(os.tmpdir(), 'FA_merge_' + job.id);
  const temps = [];
  const cancelled = () => !!job.cancelled;

  // 音轨模式：keep 原样 / add 加背景音乐 / replace 丢掉原声换音乐 / mix 保留原声再叠音乐
  // ⚠️ add 和 replace 底层命令完全一样（丢掉原音轨 + 加一条音频），差别只在文案：
  //    源本来就没声音时叫"添加"，本来有声音时叫"替换"。拆成两个选项纯粹是为了让用户看得懂。
  const opt = job.opt || {};
  const rawMode = String(opt.audioMode || 'keep');
  const audioMode = (rawMode === 'replace' || rawMode === 'add') ? 'replace'
    : (rawMode === 'mix' ? 'mix' : 'keep');
  const musicPath = audioMode === 'keep' ? '' : String(opt.music || '');
  const loopMusic = opt.loopMusic !== false;
  const fadeSec = Math.max(0, Math.min(10, Number(opt.fade) || 0));
  const musicVol = Math.min(1, Math.max(0.02, Number(opt.musicVol) || 0.3));
  // 只有用户明确勾了才允许转码 —— 转码会掉一代画质，不能悄悄做
  const allowConvert = !!opt.allowConvert;

  const cleanup = () => {
    for (const t of temps) { try { fs.rmSync(t, { force: true }); } catch (e) { /* 忽略 */ } }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  };
  const bail = (msg, cancelledByUser) => {
    if (cancelledByUser) {
      log('>>> 合并已中止', 'warn');
      sendToRenderer(chans.done, { total: 1, errCount: 1, cancelled: true });
    } else {
      log('>>> 合并失败：' + msg, 'err');
      sendToRenderer(chans.item, { ok: false, name: '合并', msg, done: 1, total: 1 });
      sendToRenderer(chans.done, { total: 1, errCount: 1, cancelled: false });
    }
  };

  try {
    if (!ff) return bail('未找到内置 ffmpeg');
    const files = job.files || [];
    if (!files.length) return bail('没有选择视频');
    if (files.length === 1 && audioMode === 'keep') {
      return bail('只选了一个视频、也没选音乐，没什么要处理的');
    }
    if (audioMode !== 'keep' && !musicPath) return bail('选了音轨处理，但没有指定音乐文件');
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { /* 已存在 */ }

    prog(0, '读取视频信息…');
    const infos = [];
    for (let i = 0; i < files.length; i++) {
      if (cancelled()) return bail('', true);
      prog((i / files.length) * 6, `读取信息 (${i + 1}/${files.length})`);
      const inf = await probeForMerge(files[i]);
      if (!inf || !inf.duration) return bail('读不出信息：' + path.basename(files[i]));
      infos.push(inf);
      log(`>>> [${i + 1}] ${inf.name} · ${inf.width}×${inf.height} · ${inf.vcodec}/${inf.pixFmt} · ` +
        `${fmtTime(inf.duration)} · ${inf.fps}fps · ` +
        `${inf.hasAudio ? inf.acodec + ' ' + inf.audioRate + 'Hz' : '无音轨'} · tbn=${inf.tbn}`);
    }

    // 只有一个视频又要换音轨时，根本不需要拼接 —— 兼容性也不必判（没东西可比）
    const single = files.length === 1;
    // 换掉原声时，音轨有没有/编码是否一致就无所谓了，不用拦
    const chk = (single && audioMode !== 'keep')
      ? { ok: true, problems: [], totalSec: infos[0].duration, tbn: infos[0].tbn, tbnSet: [infos[0].tbn] }
      : checkMergeCompat(infos, { ignoreAudio: audioMode === 'replace' });

    let convertTarget = null;
    let convertIdx = [];
    if (!chk.ok) {
      if (!allowConvert) {
        for (const p of chk.problems) log('>>> 无法无损合并：' + p, 'err');
        log('>>> 要强行拼就勾选「编码不一致时自动转码不匹配的片段」——只转不一致的那几段，不是全片', 'warn');
        return bail(chk.problems.join('；'));
      }
      const pick = pickConvertTargets(infos);
      if (!pick) {
        for (const p of chk.problems) log('>>> 无法合并：' + p, 'err');
        return bail('编码差异太大，找不到能统一的目标规格（AV1 只能靠硬件编码器）');
      }
      // 混音要求每段都有原声 —— 转码不会凭空造出一条音轨
      if (audioMode === 'mix' && infos.some((i) => !i.hasAudio)) {
        const noAudio = infos.filter((i) => !i.hasAudio).map((i) => i.name).join('、');
        return bail('混音需要每段都有原声，但这些没有：' + noAudio + '（改用「去掉原声，换成我的音乐」）');
      }
      convertTarget = pick.target;
      convertIdx = pick.idx;
      log(`>>> 参数不一致：按「多数派」统一到 ${convertTarget.vcodec} ` +
        `${convertTarget.width}×${convertTarget.height} ${convertTarget.pixFmt}。` +
        `只转第 ${convertIdx.map((i) => i + 1).join('、')} 段，其余段仍然逐字节拷贝`, 'warn');
    }

    // 目标规格：不转码就用第一段的，转码就用「多数派」
    const spec = convertTarget || {
      vcodec: infos[0].vcodec, width: infos[0].width, height: infos[0].height,
      pixFmt: infos[0].pixFmt, fps: infos[0].fps, audioRate: infos[0].audioRate || 48000,
    };
    // 换/叠音乐时音频最终都是 aac，容器只看视频编码；原样保留时才要看原音轨
    const audioOkForMp4 = audioMode !== 'keep'
      || !infos[0].hasAudio || MERGE_MP4_ACODECS.has(infos[0].acodec);
    let outExt;
    if (convertIdx.length) {
      // 时间基对齐要用 -video_track_timescale，只有 mp4 家族支持
      if (!MERGE_MP4_VCODECS.has(spec.vcodec)) {
        return bail('统一后的编码是 ' + spec.vcodec + '，放不进 mp4，无法做无损对齐');
      }
      outExt = '.mp4';
    } else {
      outExt = (MERGE_MP4_VCODECS.has(spec.vcodec) && audioOkForMp4) ? '.mp4' : '.mkv';
    }
    const outDir = opt.outMode === 'custom' && opt.outDir ? opt.outDir : path.dirname(files[0]);
    const base = path.basename(files[0], path.extname(files[0]));
    const suffix = audioMode === 'replace' ? '_music' : (audioMode === 'mix' ? '_mix' : '_joined');
    const outPath = uniqueOutPath(outDir, base, suffix, outExt);

    // 音乐信息（换/叠音乐时才需要）
    let mi = null;
    if (audioMode !== 'keep') {
      prog(7, '读取音乐信息…');
      mi = await probeForMerge(musicPath);
      if (!mi || !mi.duration) return bail('音乐文件读不出时长：' + path.basename(musicPath));
      if (!mi.hasAudio) return bail('这个文件里没有音频流：' + path.basename(musicPath));
      log(`>>> 音乐: ${path.basename(musicPath)} · ${mi.acodec} ` +
        `${mi.audioRate ? mi.audioRate + 'Hz · ' : ''}${fmtTime(mi.duration)}` +
        `${loopMusic ? ' · 循环铺满' : ''}${fadeSec > 0 ? ' · 淡入淡出 ' + fadeSec + 's' : ''}` +
        `${audioMode === 'mix' ? ' · 叠加音量 ' + Math.round(musicVol * 100) + '%' : ''}`);
    }

    // ① 先把"规格不一致"的段转成目标规格（只转这几段，其余原样拷贝）
    const stageFiles = files.slice();
    let totalSec = chk.totalSec;
    if (convertIdx.length) {
      const encKey = convertEncoderFor(spec.vcodec);
      const tbnHint = String(Math.max(chk.tbn || 0, 24000));
      for (let n = 0; n < convertIdx.length; n++) {
        if (cancelled()) return bail('', true);
        const i = convertIdx[n];
        const inf = infos[i];
        prog(8 + (n / convertIdx.length) * 50, `转码第 ${i + 1} 段 (${n + 1}/${convertIdx.length})`);
        const vf = [];
        if (inf.width !== spec.width || inf.height !== spec.height) {
          vf.push(`scale=${spec.width}:${spec.height}:force_original_aspect_ratio=decrease`);
          vf.push(`pad=${spec.width}:${spec.height}:(ow-iw)/2:(oh-ih)/2`);
        }
        if (inf.pixFmt && spec.pixFmt && inf.pixFmt !== spec.pixFmt) vf.push(`format=${spec.pixFmt}`);
        const cargs = ['-y', '-i', files[i], '-map', '0:v:0', '-map', '0:a?'];
        if (vf.length) cargs.push('-vf', vf.join(','));
        cargs.push(...videoEncArgs(encKey, '高'));
        cargs.push('-c:a', 'aac', '-b:a', '192k', '-ar', String(spec.audioRate), '-ac', '2', '-sn', '-dn');
        cargs.push('-video_track_timescale', tbnHint);
        if (spec.vcodec === 'hevc' && outExt !== '.mkv') cargs.push('-tag:v', 'hvc1');
        const tmp = path.join(tmpDir, `conv_${i + 1}${outExt}`);
        cargs.push(tmp);
        log(`>>> 转码第 ${i + 1} 段：${inf.vcodec} ${inf.width}×${inf.height} → ` +
          `${spec.vcodec} ${spec.width}×${spec.height}（只有这一段掉画质，其余段不受影响）`, 'warn');
        const r = await runFfmpegOnce({
          ff, args: cargs, jobId: job.id, expectedSec: inf.duration,
          label: `转码 ${inf.name}`, onLog: log,
        });
        if (r.code !== 0) return bail('转码第 ' + (i + 1) + ' 段失败：' + (r.err || 'exit ' + r.code));
        temps.push(tmp);
        stageFiles[i] = tmp;
      }
      // 转码产物的 tbn/时长由编码器决定，必须重新探测 —— 否则后面算时间基会错
      for (const i of convertIdx) {
        const re = await probeForMerge(stageFiles[i]);
        if (!re || !re.duration) return bail('转码产物读不出信息（第 ' + (i + 1) + ' 段）');
        infos[i] = re;
      }
      totalSec = infos.reduce((s, i) => s + i.duration, 0);
    }

    // ② 时间基对齐：只在真不一致时做（每个中间件都要整片重封装一遍，不能白做）
    const items = [];
    const tbnNow = [...new Set(infos.map((i) => i.tbn).filter((t) => t > 0))];
    if (tbnNow.length > 1) {
      const target = Math.max(...tbnNow);
      log(`>>> 时间基不一致（${tbnNow.join(' / ')}）→ 先统一到 ${target}，` +
        `否则拼完时间轴会接不上（这个坑不报错，只会时长变短）`, 'warn');
      for (let i = 0; i < files.length; i++) {
        if (cancelled()) return bail('', true);
        if (infos[i].tbn === target) { items.push(stageFiles[i]); continue; }
        if (outExt === '.mkv') {
          return bail('时间基不一致，但输出是 mkv（不支持指定时间基），无法无损对齐');
        }
        const tmp = path.join(tmpDir, `align_${i + 1}${outExt}`);
        prog(60 + (i / files.length) * 20, `对齐时间基 (${i + 1}/${files.length})`);
        const r = await runFfmpegOnce({
          ff,
          args: ['-y', '-i', stageFiles[i], '-map', '0:v:0', '-map', '0:a?',
            '-c', 'copy', '-sn', '-dn', '-video_track_timescale', String(target), tmp],
          jobId: job.id, expectedSec: infos[i].duration,
          label: `对齐 ${infos[i].name}`, onLog: log,
        });
        if (r.code !== 0) return bail('对齐时间基失败：' + (r.err || 'exit ' + r.code));
        temps.push(tmp);
        items.push(tmp);
      }
    } else {
      log('>>> 时间基一致，直接拼接');
      items.push(...stageFiles);
    }
    if (cancelled()) return bail('', true);

    // ③ 拼接（流复制）。只有 1 段时跳过，直接进音轨处理
    const needAudioPass = audioMode !== 'keep';
    let srcPath = '';
    if (files.length > 1) {
      const stagePath = needAudioPass ? path.join(tmpDir, 'stage' + outExt) : outPath;
      const listPath = path.join(tmpDir, 'list.txt');
      const esc = (p) => String(p).replace(/'/g, "'\\''");
      fs.writeFileSync(listPath, items.map((p) => `file '${esc(p)}'`).join('\n') + '\n', 'utf8');

      prog(82, '拼接中…');
      const cargs = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy'];
      if (/\.(mp4|m4v|mov)$/i.test(outExt)) cargs.push('-movflags', '+faststart');
      if (spec.vcodec === 'hevc' && outExt !== '.mkv') cargs.push('-tag:v', 'hvc1');
      cargs.push(stagePath);
      const rc = await runFfmpegOnce({
        ff, args: cargs, jobId: job.id, expectedSec: totalSec,
        label: '拼接（流复制，不动画质）', onLog: log,
      });
      if (rc.code !== 0) return bail('拼接失败：' + (rc.err || 'exit ' + rc.code));
      if (cancelled()) return bail('', true);
      if (needAudioPass) temps.push(stagePath);
      srcPath = stagePath;
    } else {
      srcPath = stageFiles[0];
      log('>>> 只有 1 个视频，跳过拼接，直接处理音轨');
    }

    // ④ 音轨处理：视频一律 -c:v copy（画质逐字节不变），只有音频会重编码
    if (needAudioPass) {
      prog(90, audioMode === 'replace' ? '替换音轨…' : '叠加音乐…');
      // ⚠️ -shortest 只在"音乐会无限循环"或"音乐比视频长"时才加。
      //    否则会把视频裁短到音乐长度 —— 用户会莫名其妙少一段，这个坑很隐蔽。
      const needShortest = loopMusic || (mi && mi.duration >= totalSec);
      const fadeIn = fadeSec > 0 ? `afade=t=in:st=0:d=${fadeSec}` : '';
      const fadeOut = fadeSec > 0
        ? `afade=t=out:st=${Math.max(0, totalSec - fadeSec).toFixed(3)}:d=${fadeSec}` : '';
      const fadeChain = [fadeIn, fadeOut].filter(Boolean).join(',');
      const mIn = loopMusic ? ['-stream_loop', '-1', '-i', musicPath] : ['-i', musicPath];

      // 混音要求原声存在；没有就自动退化成"直接加入音乐"
      if (audioMode === 'mix' && !infos[0].hasAudio) {
        log('>>> 源视频本来就没有原声，混音退化成"直接加入音乐"', 'warn');
      }
      const doReplace = audioMode === 'replace' || !infos[0].hasAudio;

      let aargs;
      if (doReplace) {
        // 去掉原声不需要额外操作：显式 -map 只点名一个音频流，其余原音轨自然被丢弃
        aargs = ['-y', '-i', srcPath, ...mIn, '-map', '0:v:0', '-map', '1:a:0'];
        if (fadeChain) aargs.push('-af', fadeChain);
        aargs.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
      } else {
        // 保留原声 + 叠加：normalize=0 保证旁白不被自动压小，音量全靠 musicVol 控制
        const chain = (fadeChain ? `[1:a]${fadeChain},` : '[1:a]') +
          `volume=${musicVol.toFixed(2)}[m];` +
          `[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
        aargs = ['-y', '-i', srcPath, ...mIn, '-filter_complex', chain,
          '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k'];
      }
      if (needShortest) aargs.push('-shortest');
      if (/\.(mp4|m4v|mov)$/i.test(outExt)) aargs.push('-movflags', '+faststart');
      if (spec.vcodec === 'hevc' && outExt !== '.mkv') aargs.push('-tag:v', 'hvc1');
      aargs.push(outPath);
      const ra = await runFfmpegOnce({
        ff, args: aargs, jobId: job.id, expectedSec: totalSec,
        label: doReplace ? '换音乐（视频流复制）' : '叠加音乐（视频流复制）', onLog: log,
      });
      if (ra.code !== 0) return bail('音轨处理失败：' + (ra.err || 'exit ' + ra.code));
      if (cancelled()) return bail('', true);
    }

    // ⑤ 核对时长 —— 必须等于各段之和
    prog(96, '校验时长…');
    const got = await probeForMerge(outPath);
    if (!got || !got.duration) return bail('产物读不出时长，可能没写成功');
    const diff = Math.abs(got.duration - totalSec);
    if (diff > Math.max(0.5, totalSec * 0.01)) {
      return bail(`拼接后时长 ${fmtTime(got.duration)} 与预期 ${fmtTime(totalSec)} 不符（差 ${diff.toFixed(2)} 秒）`);
    }

    // 体积对比用磁盘上的原始文件（infos 里转码段的 size 已经是临时文件的了）
    const before = files.reduce((s, f) => {
      try { return s + fs.statSync(f).size; } catch (e) { return s; }
    }, 0);
    const after = (() => { try { return fs.statSync(outPath).size; } catch (e) { return 0; } })();
    prog(100, '完成');
    const what = audioMode === 'keep' ? '拼接'
      : (audioMode === 'replace'
        ? (rawMode === 'add' ? '拼接 + 加背景音乐' : '拼接 + 换音乐')
        : '拼接 + 叠加音乐');
    log(`>>> ${what}完成 ✓ ${got.width}×${got.height} · ${fmtTime(got.duration)}` +
      `（= ${infos.map((i) => fmtTime(i.duration)).join(' + ')}）`, 'ok');
    log(`>>> 音轨: ${got.hasAudio ? got.acodec + (got.audioRate ? ' ' + got.audioRate + 'Hz' : '') : '无'}` +
      (convertIdx.length ? ` · 第 ${convertIdx.map((i) => i + 1).join('、')} 段被转码` : ' · 视频全程未重编码'), 'dim');
    log('>>> 文件: ' + outPath, 'ok');
    sendToRenderer(chans.item, {
      ok: true, name: path.basename(outPath), outPath, file: outPath,
      before, after, grew: false, done: 1, total: 1,
    });
    sendToRenderer(chans.done, { total: 1, okCount: 1, errCount: 0, cancelled: false });
  } catch (e) {
    bail(String((e && e.message) || e));
  } finally {
    cleanup();
    vidJobs.delete(job.id);
  }
}

// 选完文件后先探一遍，界面据此显示"能不能无损拼接 / 如果需要转码会转哪几段"
// opts.audioMode = keep|replace|mix —— replace 时不要求各段音轨一致
ipcMain.handle('probe_merge_files', async (e, files, opts) => {
  const o = opts || {};
  const list = (files || []).slice(0, 50);
  const infos = [];
  for (const f of list) infos.push(await probeForMerge(String(f)));
  const compat = checkMergeCompat(infos, { ignoreAudio: o.audioMode === 'replace' || o.audioMode === 'add' });
  // 不能无损时，先算一下"允许转码的话会转哪几段"，界面好把话说在前面
  let convert = null;
  if (!compat.ok && infos.length >= 2 && infos.every((i) => i && i.duration)) {
    const pick = pickConvertTargets(infos);
    if (pick) convert = { target: pick.target, idx: pick.idx };
  }
  return { ok: true, infos, compat, convert };
});

// 选音乐文件
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.wma', '.aif', '.aiff']);
ipcMain.handle('pick_audio', async () => {
  const r = await openDialogRemembered(mainWindow, 'audio', {
    title: '选择音乐文件',
    filters: [{ name: '音频', extensions: [...AUDIO_EXTS].map((x) => x.slice(1)) }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, file: '' };
  return { ok: true, file: r.filePaths[0] };
});

ipcMain.handle('probe_audio', async (e, file) => {
  const inf = await probeForMerge(String(file || ''));
  if (!inf || !inf.duration || !inf.hasAudio) return { ok: false, msg: '这个文件里没有音频流' };
  return { ok: true, info: inf };
});

// 「音视频拼接」页的入口。跟视频处理页共用 vidJobs 注册表 ——
// 所以「停止」直接复用 stop_video_job / killVidJob，不用另写一套。
ipcMain.handle('start_compose_job', (e, params) => {
  const p = params || {};
  const files = (p.files || []).filter(Boolean);
  if (!files.length) return { ok: false, msg: '没有选择视频' };
  if (!getFfmpeg()) return { ok: false, msg: '未找到内置 ffmpeg（见「环境检测」页）' };

  const audioMode = (p.audioMode === 'replace' || p.audioMode === 'add' || p.audioMode === 'mix')
    ? p.audioMode : 'keep';
  if (audioMode !== 'keep' && !p.music) return { ok: false, msg: '请先选择音乐文件' };
  if (files.length === 1 && audioMode === 'keep') {
    return { ok: false, msg: '只选了一个视频、也没选音乐，没什么要处理的' };
  }
  if (p.outMode === 'custom' && !p.outDir) return { ok: false, msg: '请先选择输出文件夹' };

  const opt = {
    audioMode,
    music: p.music || '',
    loopMusic: p.loopMusic !== false,
    fade: Number(p.fade) || 0,
    musicVol: Number(p.musicVol) || 0.3,
    allowConvert: !!p.allowConvert,
    outMode: p.outMode || 'same',
    outDir: p.outDir || '',
  };
  const id = 'mg' + (++vidJobSeq);
  const job = {
    id, files: files.slice(), opt, cancelled: false,
    logSource: 'compose',
    chans: { progress: 'compose-progress', item: 'compose-item', done: 'compose-done' },
  };
  vidJobs.set(id, job);
  runMergeJob(job);
  return { ok: true, jobId: id, total: 1 };
});

ipcMain.handle('start_video_job', (e, params) => {
  const files = (params && params.files) || [];
  if (!files.length) return { ok: false, msg: '没有选择视频' };
  if (!getFfmpeg()) return { ok: false, msg: '未找到内置 ffmpeg（见「环境检测」页）' };

  const mode = params.mode === 'compress' ? 'compress' : 'trim';
  const opt = {
    mode,
    start: params.start || '',
    end: params.end || '',
    encoder: params.encoder || 'hevc_nv',
    quality: params.quality || '中',
    maxHeight: params.maxHeight || 0,
    audio: params.audio || 'copy',
    container: params.container || 'mp4',
    outMode: params.outMode || 'same',
    outDir: params.outDir || '',
  };
  if (opt.outMode === 'custom' && !opt.outDir) return { ok: false, msg: '请先选择输出文件夹' };

  // 压缩要挑一个真能用的编码器：选了硬件但没卡，就退回同类软件编码
  if (mode === 'compress') {
    const hw = detectHwEncoders();
    if (VENC[opt.encoder] && VENC[opt.encoder].hw && !hw[opt.encoder]) {
      const fallback = opt.encoder.startsWith('hevc') ? 'hevc_sw' : 'h264_sw';
      pushLog(`>>> 硬件编码器 ${VENC[opt.encoder].label} 在本机不可用，已改用 ${VENC[fallback].label}`, 'warn', null, 'video');
      opt.encoder = fallback;
    }
  }

  const id = 'vid' + (++vidJobSeq);
  const job = { id, files: files.slice(), opt, cancelled: false };
  vidJobs.set(id, job);

  pushLog(mode === 'trim'
    ? `>>> 开始无损修剪 ${files.length} 个视频（不重新编码）`
    : `>>> 开始压缩 ${files.length} 个视频：${VENC[opt.encoder] ? VENC[opt.encoder].label : opt.encoder} · 质量「${opt.quality}」`,
    'dim', null, 'video');
  runVideoJob(job);
  return { ok: true, jobId: id, total: files.length };
});

ipcMain.handle('stop_video_job', (e, jobId) => {
  const job = vidJobs.get(jobId);
  if (!job) return { ok: false, msg: '任务已结束' };
  job.cancelled = true;
  const n = killVidJob(jobId);
  pushLog(`>>> 正在中止视频处理（已终止 ${n} 个进程）…`, 'warn', null, 'video');
  return { ok: true };
});

// ---------- 应用生命周期 ----------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* 退出前的收尾。
   ⚠️ 这里**故意不**去 dispose 页面里的 WebGL（流体渲染器）。
   曾经因为退出看到退出码 139（segfault），以为是"WebGL 上下文没释放"，于是在
   before-quit 里 preventDefault + await 页面 dispose() + app.exit(0)。
   结果：139 依然在，而且**新增**了别的不稳定 —— 对照实验（最小窗口 + 流体照跑 +
   同一套清理流程）三种模式全部 EXIT=0，把清理块摘掉后主程序也回到 0。
   结论：段错是我自己那套"拦截退出"的写法引入的，WebGL 本身退出干净。
   代价说明：Electron 在 in-process-gpu 下拆渲染进程时，rAF 里正在跑的 WebGL
   循环由 Chromium 自己负责回收，用户点关闭是**同步**走完的，实测无崩溃。
   所以：别再往这里加"退出前通知页面"的逻辑，那只会把干净的退出路径搞脏。
   正常退出要撤掉"启动中"标记，否则下次启动会被误判成"上次崩了"而降级到兼容模式
   （用户开完应用秒关就会踩到，实测过）*/
/* ============ 封面图下载（侧边栏「下载封面图」页） ============
   用途：给一个视频链接，把它的封面（缩略图）原图存下来 —— 做封面参考、
      上传平台时当封面、收集素材这类事。

   实现要点（每条都是摸索出来的，别随手改）：

   ① **必须让 yt-dlp 自己下载，不能自己拿 URL 去 fetch。**
      B站 / 微博这类站点的封面有防盗链（校验 Referer / UA），
      自己 HTTP GET 会拿到 403 或一张"防盗图"；yt-dlp 内部会给每个站点
      带上正确的 http_headers，所以交给它最稳，也最通用。

   ② `--skip-download --write-thumbnail`：只写封面、不下视频本体。
      实测 yt-dlp 只写**最佳那一张**（YouTube 上是 1920×1080 的 maxresdefault），
      不会把几十张不同尺寸的缩略图全灌下来。

   ③ 文件名走 `-o %(title)s.%(ext)s` 模板，用视频标题命名。
      yt-dlp 自己会清洗标题里的非法字符（\ / : * ? " < > |），不用我们操心。

   ④ **保持原格式、不转码**：YouTube 给 webp、多数站给 jpg。
      封面是拿来用的素材，多一次有损编码不划算（用户 2026-09-29 拍板）。
      所以**不要**顺手加 --convert-thumbnails。

   ⑤ 站点通用：任何 yt-dlp 支持的站走同一套，代码里不写死 YouTube 的字段。

   ⑥ 拿不到封面时**不算失败**：纯音频、少数站点本来就没有缩略图，
      标成"跳过"并说明，不要让整批任务因为一个链接报错中断。

   ⑦ 不启用 PO Token：那是为了解 YouTube 高清晰度视频流的（要起 Node、加载插件、
      每次白等几秒）。封面只是个图片 URL，用不上，启用只会拖慢。
      真正需要的是 **JS 运行时**（deno）—— YouTube 现在解析元数据要做 JS 挑战，
      没有它连缩略图 URL 都拿不到。
*/
const COVER_CONCURRENCY = 3;
let coverJobSeq = 0;
const coverJobs = new Map();

// 从 yt-dlp 输出里抠出封面落盘路径。
// 成功时会打印： [info] Writing video thumbnail 41 to: D:\...\标题.webp
function parseCoverPath(line) {
  const m = line.match(/Writing video thumbnail \d+ to: (.+)$/);
  return m ? m[1].trim() : '';
}

// 从封面路径反推标题（去掉扩展名）。用于界面显示"下到了什么"。
function coverTitleFromPath(p) {
  try { return path.basename(p).replace(/\.[^.]+$/, ''); } catch (e) { return ''; }
}

// 单个链接下封面。withCookies=true 用于会员 / 年龄限制这类需要登录态的视频。
function fetchOneCover(job, url, withCookies) {
  return new Promise((resolve) => {
    const ytdlp = findYtdlpKernel();
    if (!ytdlp) {
      resolve({ ok: false, msg: '未找到下载内核 tools/yt-dlp.exe' });
      return;
    }

    const args = [
      '--skip-download', '--write-thumbnail',
      '--no-update', '--newline',
      '-o', path.join(job.dir, '%(title)s.%(ext)s'),
    ];

    // ffmpeg：yt-dlp 处理部分站点的封面时要用（项目自带，不指望用户装过）
    const ffmpeg = findTool('ffmpeg');
    if (ffmpeg) args.push('--ffmpeg-location', path.dirname(ffmpeg));

    // JS 运行时：YouTube 解析元数据要做 JS 挑战，缺了直接拿不到缩略图 URL
    const rt = findJsRuntime();
    if (rt) args.push('--js-runtimes', `${rt.name}:${rt.path}`);

    // 代理：与下载页同一套口径（手动 / 直连 / 跟随系统）
    const pMode = cfg.proxy_mode || 'system';
    const proxyP = (async () => {
      if (pMode === 'manual' && cfg.proxy) return cfg.proxy;
      if (pMode === 'direct') return '';
      const sp = await getSystemProxy();
      return sp.url || '';
    })();

    proxyP.then((proxyUrl) => {
      if (proxyUrl) args.push('--proxy', proxyUrl);
      else if (pMode === 'direct') args.push('--proxy', '');

      if (withCookies) {
        const ca = cookieArgs();
        if (ca.length) args.push(...ca);
      }
      args.push('--', url);

      // PyInstaller 打包的 yt-dlp.exe 需要 TEMP/TMP 才能自解包（同下载页的兜底）
      const cwdEnv = {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        TEMP: process.env.TEMP || os.tmpdir(),
        TMP: process.env.TMP || os.tmpdir(),
      };

      let coverPath = '';
      let errLine = '';
      let authFail = false;

      const proc = spawn(ytdlp, args, { windowsHide: true, env: cwdEnv });
      job.procs.add(proc);

      const onLine = (line) => {
        const p = parseCoverPath(line);
        if (p) { coverPath = p; return; }
        if (isRetryableAuthError(line)) authFail = true;
        // 只有出错的行值得写进日志；正常行太吵（一堆 downloading / extracting）
        if (/ERROR|error/i.test(line)) errLine = line.replace(/^ERROR:\s*/, '');
      };

      proc.stdout.on('data', (buf) => {
        for (const raw of decodeOut(buf).split(/[\r\n]+/)) {
          const line = raw.trim();
          if (line) onLine(line);
        }
      });
      proc.stderr.on('data', (buf) => {
        const t = decodeOut(buf).trim();
        if (t) for (const raw of t.split(/[\r\n]+/)) {
          const line = raw.trim();
          if (line) onLine(line);
        }
      });
      proc.on('error', (e) => {
        job.procs.delete(proc);
        resolve({ ok: false, msg: '启动下载内核失败: ' + e });
      });
      proc.on('close', (code) => {
        job.procs.delete(proc);
        if (code === 0) {
          if (coverPath) resolve({ ok: true, file: coverPath, title: coverTitleFromPath(coverPath) });
          // 正常退出但没写文件 = 这个视频本身没有封面（不是错误）
          else resolve({ ok: false, nocover: true, msg: '该视频没有封面' });
          return;
        }
        resolve({ ok: false, authFail, msg: errLine || ('yt-dlp 退出码 ' + code) });
      });
    }).catch((e) => {
      resolve({ ok: false, msg: '处理代理设置失败: ' + ((e && e.message) || e) });
    });
  });
}

// 整批任务。并发 3（与下载页一致），可中止。
async function runCoverJob(job) {
  let idx = 0;
  let okCount = 0, failCount = 0, skipCount = 0;
  const doneItems = [];

  const worker = async () => {
    while (!job.cancelled) {
      const i = idx++;
      if (i >= job.urls.length) return;
      const url = job.urls[i];

      if (job.cancelled) return;

      // 两轮：先不带 cookies；上一轮是鉴权失败才带 cookies 重试。
      // 公开视频绝大多数第一轮就成，不必为它白读一次 cookies 库。
      let res = await fetchOneCover(job, url, false);
      if (!res.ok && !res.nocover && res.authFail && !job.cancelled) {
        pushLog('需要登录态，带 cookies 重试: ' + url.slice(0, 60), 'dim', null, 'cover');
        res = await fetchOneCover(job, url, true);
      }

      if (job.cancelled) return;

      if (res.ok) okCount++;
      else if (res.nocover) skipCount++;
      else failCount++;

      const doneCount = okCount + failCount + skipCount;
      const item = {
        index: i + 1,
        total: job.urls.length,
        // 进度按"已完成数"算而不是 index —— 并发 3 时完成顺序是乱的，
        // 用 index 会让进度条来回跳
        done: doneCount,
        url,
        ok: !!res.ok,
        nocover: !!res.nocover,
        title: res.title || '',
        file: res.file || '',
        msg: res.msg || '',
      };
      doneItems.push(item);
      sendToRenderer('cover-item', item);
    }
  };

  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, job.urls.length) }, worker));

  sendToRenderer('cover-done', {
    id: job.id,
    cancelled: !!job.cancelled,
    total: job.urls.length,
    okCount, failCount, skipCount,
    items: doneItems,
  });
  pushLog(`>>> 封面下载结束：成功 ${okCount} · 跳过 ${skipCount} · 失败 ${failCount}` +
    (job.cancelled ? '（已中止）' : ''), job.cancelled ? 'warn' : 'ok', null, 'cover');
  coverJobs.delete(job.id);
}

// 封面保存目录（选目录用现成的 pick_folder，这里只负责存）
ipcMain.handle('save_cover_dir', (e, dir) => {
  cfg.cover_dir = String(dir || '').trim();
  saveConfig(cfg);
  return cfg.cover_dir;
});

ipcMain.handle('start_cover_job', (e, params) => {
  const dir = String((params && params.dir) || '').trim();
  if (!dir) return { ok: false, msg: '请先选择封面保存目录' };
  try { fs.accessSync(dir); } catch (err) { return { ok: false, msg: '保存目录不存在: ' + dir }; }

  // 链接清洗：按行 / 空格 / 逗号切；去重；只留 http(s) 开头的
  const raw = String((params && params.urls) || '');
  const seen = new Set();
  const urls = [];
  for (const piece of raw.split(/[\s,，]+/)) {
    const u = piece.trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;   // 同一批里重复粘贴的只下一次
    seen.add(u);
    urls.push(u);
  }
  if (!urls.length) return { ok: false, msg: '没有识别到有效链接（需要以 http:// 或 https:// 开头）' };

  const id = 'cover' + (++coverJobSeq);
  const job = { id, urls, dir, cancelled: false, procs: new Set() };
  coverJobs.set(id, job);

  pushLog(`>>> 开始下载 ${urls.length} 个封面 → ${dir}`, 'dim', null, 'cover');
  runCoverJob(job);   // 不 await：立刻把 jobId 还给界面
  return { ok: true, jobId: id, total: urls.length };
});

ipcMain.handle('stop_cover_job', (e, jobId) => {
  const job = coverJobs.get(jobId);
  if (!job) return { ok: false, msg: '任务已结束' };
  job.cancelled = true;
  // Windows 上 yt-dlp 会拉起子进程，必须连树一起杀，否则变孤儿继续占资源
  for (const p of job.procs) {
    try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true }); } catch (err) { /* 忽略 */ }
  }
  pushLog('>>> 正在中止封面下载…', 'warn', null, 'cover');
  return { ok: true };
});

app.on('will-quit', () => {
  try { fs.unlinkSync(startFlagPath()); } catch (e) { /* 本来就没有 */ }
  // 早期版本会在这里清 fallen-angels-preview；转制方案已在 2.13.0 移除，
  // 留一行兜底把可能残留的老目录扫掉
  try {
    const dir = path.join(app.getPath('temp'), 'fallen-angels-preview');
    if (fs.existsSync(dir)) {
      for (const n of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* 被占用就留给系统清 */ }
      }
      try { fs.rmdirSync(dir); } catch (e) { /* 非空就算了 */ }
    }
  } catch (e) { /* 目录不存在 */ }
});
