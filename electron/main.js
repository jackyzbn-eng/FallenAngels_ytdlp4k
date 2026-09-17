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

// ---------- 显示相关的三个启动开关（都必须在 app ready 之前设置） ----------

// ① GPU 逻辑并进主进程。
// GPU 子进程起不来时 Chromium 会连试 6 次然后 FATAL 自杀（"GPU process isn't usable. Goodbye."，
// 退出码 2147483651），窗口根本不出现、也没有任何 JS 报错。并进主进程就没有那个会崩的独立进程了。
app.commandLine.appendSwitch('in-process-gpu');

// ② 渲染进程沙箱。
// 这台机器上渲染进程会被系统直接杀掉（render-process-gone: reason="killed" exitCode=1），
// 表现是应用打开了却一片空白。本应用只加载本地 file:// 页面、不加载远程内容，攻击面很小。
app.commandLine.appendSwitch('no-sandbox');

// ③ 硬件加速要不要开，取决于上一次启动稳不稳。
// **开着才能播 HEVC** —— 实测（2026-09-17）：
//   硬件加速开 → HEVC 竖屏 .mov 正常 loadedmetadata 1080×1920，能播；
//   硬件加速关 → HEVC 报 DEMUXER_ERROR_COULD_NOT_OPEN，H.264 也只解出 0×0。
// 用户的素材大量是 HEVC，关了它就只能先转一份低画质代理才能预览（费时费盘），
// 所以默认开着。代价是：GPU 驱动出问题时可能把主进程一起带走 —— 用一个标记文件自愈：
// 启动时写标记，稳定跑满 12 秒就删掉；下次启动若发现标记还在，说明上次没跑稳，
// 这次就自动降级成禁用硬件加速（视频预览可能因此播不了 HEVC，前端会退到"用系统播放器打开"）。
// 标记文件路径。"启动中"标记的语义：存在 = 上次启动没能跑稳。
// 正常退出（含用户开完就秒关）必须在 will-quit 里清掉，否则下次会被误判成崩溃而降级 —— 这个坑实测踩到过。
function startFlagPath() {
  try { return path.join(app.getPath('userData'), 'starting.flag'); } catch (e) { return ''; }
}

function gpuCompatMode() {
  const flag = startFlagPath();
  if (!flag) return false;
  try {
    if (fs.existsSync(flag)) {
      try { fs.unlinkSync(flag); } catch (e) { /* 删不掉也无所谓 */ }
      return true;                       // 上次启动没跑稳 → 兼容模式
    }
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, String(Date.now()));
    // 跑满 12 秒就说明启动这关过了，标记撤掉：之后再怎么崩也不算"启动失败"，
    // 不会因为一次运行中的崩溃就把用户永久打进兼容模式
    setTimeout(() => { try { fs.unlinkSync(flag); } catch (e) { /* 已经删了 */ } }, 12000);
  } catch (e) { /* 写不了标记就算了，按正常模式来 */ }
  return false;
}

const HW_DISABLED = gpuCompatMode();
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
  const appD = appDir();
  if (writable(appD)) return path.join(appD, 'config.json');
  return path.join(dataDir(), 'config.json');
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

// 缓存里除了"要不要 cookies"，也要记"有没有用封顶客户端" ——
// 否则下次命中缓存时会漏掉 player_client，年龄限制视频会掉回 360p。
function setCached(key, cookies, capped) {
  const all = loadCache();
  all[key] = { cookies: !!cookies, capped: !!capped, ts: Date.now() };
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
  // 两个下载页各有自己的分类列表，所以 dirs 按来源分组
  dirs: {
    yt: [{ name: '1080P', path: '' }, { name: '4K', path: '' }],
    social: [{ name: '社媒', path: '' }],
  },
  // 图片压缩页的设置（记住上次选择）
  img_quality: '中',
  img_format: 'keep',
  img_maxedge: 0,
  img_outmode: 'sub',
  img_outdir: '',
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
    cfg.dirs = { yt: d, social: [{ name: '社媒', path: '' }] };
  } else if (!d || typeof d !== 'object') {
    cfg.dirs = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs));
  } else {
    if (!Array.isArray(d.yt)) d.yt = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs.yt));
    if (!Array.isArray(d.social)) d.social = JSON.parse(JSON.stringify(DEFAULT_CONFIG.dirs.social));
  }
  for (const k of ['yt', 'social']) {
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
    backgroundColor: '#08090a',
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

ipcMain.handle('set_skin', (e, skin) => { cfg.skin = skin; saveConfig(cfg); return true; });
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

// 导入 cookies.txt（Chrome/Edge 在 v127+ 只能走这条路）
// 支持两类来源：yt-dlp 的 Netscape 格式、以及浏览器扩展导出的同格式文件
ipcMain.handle('import_cookies_file', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle('pick_folder', async (e, title) => {
  const r = await dialog.showOpenDialog(mainWindow, {
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
const pendingBySource = { yt: [], social: [] };
const runningBySource = { yt: 0, social: 0 };

// 「停止全部」的标记按来源分开 —— 油管页点停止不该把社媒的任务也停掉。
const stoppedBySource = { yt: false, social: false };
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
  pushLog('>>> 实际分辨率: ' + res + ' · ' + r.info.videoCodec + ' · ' + r.info.size, 'ok', t.id);

  const cap = QUALITY_HEIGHT[quality] || 0;
  const h = Number(String(res).split('×')[1]) || 0;
  // 阈值放宽到 85%：YouTube 的实际高度常因画面比例而低于标称值
  // （如 720p 可能是 1280×676、2160p 可能是 3840×2026），
  // 用 95% 会把成功下载误判成"没拿到该清晰度"。明显缩水（如 4K 只下到 1012）仍会提示。
  if (cap && h && h < cap * 0.85) {
    pushLog(
      '>>> 提示：该视频没有给出 ' + quality + ' 流（YouTube 对部分视频启用 SABR 流 + PO Token 限制，' +
      '只有拿到 token 的客户端才能取到更高清晰度），已下到当前可用的最高 ' + res + '。' +
      '这与"是否带 cookies"无关，带 cookies 只解决年龄限制/需要登录的问题。',
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
      await reportResolution(t, o.quality);   // 核对真实分辨率并写入 t.res
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
  // 来源：yt（YouTube）/ social（抖音·小红书·B站·微博·TikTok）。
  // 两者的解析参数差异很大，见 downloadWorker 里的分支。
  const src = source === 'social' ? 'social' : 'yt';

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
  const src = source === 'social' ? 'social' : 'yt';
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

// 清空已完成/失败的任务记录 —— 同样只清当前页面的
ipcMain.handle('clear_finished', (e, source) => {
  const src = source === 'social' ? 'social' : 'yt';
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

// 带 cookies 时补上备用 player client：
// `web_safari,tv` 能过年龄限制（默认客户端在这种情况下只给 360p），
// 但它会把清晰度**封顶在 1080p 级**（实测：普通 4K 视频用它会从 2160 掉到 1080）。
// 所以只在"鉴权失败后的补救轮"用它 —— 普通失败不要用，否则 4K 被静默降级。
function clientArgs(capped) {
  return capped ? ['--extractor-args', 'youtube:player_client=web_safari,tv'] : [];
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
        pushLog(line, 'dim', taskId);
      }
    });
    proc.stderr.on('data', (buf) => {
      const line = decodeOut(buf).trim();
      if (line) {
        if (isRetryableAuthError(line)) sawAuthError = true;
        // 错误行标红
        pushLog(line, /error|ERROR/.test(line) ? 'err' : 'dim', taskId);
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

// 单个任务的完整下载流程。所有状态都通过 taskId 归属到具体任务。
async function downloadWorker(url, folder, quality, fps, pMode, proxy, taskId, source) {
  const ytdlp = findYtdlpKernel();
  if (!ytdlp) {
    pushLog('错误：未找到下载内核 tools/yt-dlp.exe', 'err', taskId);
    pushLog('请到「环境检测」页安装缺失组件', 'err', taskId);
    return { ok: false, msg: '未找到下载内核' };
  }

  const isSocial = source === 'social';

  // 社媒站固定取平台最高画质（前端也只传「原画」），不做帧率转换
  const fmt = isSocial ? SOCIAL_FMT : (QUALITY[quality] || QUALITY['4K']);
  let fmtArg = fmt;
  if (!isSocial && (fps === '30' || fps === '24')) {
    if (fmt.includes('+') && fmt.includes('/')) {
      const bvPart = fmt.split('+')[0];
      const baPart = fmt.split('/')[0].split('+')[1];
      fmtArg = `${bvPart}[fps<=${fps}]+${baPart}[fps<=${fps}]/${fmt}`;
    }
    pushLog(`>>> 帧率模式: 优先下载 ${fps}fps 原版流`, 'dim', taskId);
  }

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
    plan = cached.cookies
      ? [{ withCookies: true, cappedClient: !!cached.capped, label: '（按上次成功记录带 cookies）' }]
      : [{ withCookies: false, label: '（按上次成功记录，不带 cookies）' }];
    // 缓存说"带 cookies 但没动用备用客户端"，而当前 PO Token 又不可用 —— 补一步兜底，
    // 否则会退化成 360p（证明过：不带备用客户端时年龄限制视频各客户端只给 338）
    if (cached.cookies && !hasPot && !cached.capped) {
      plan.push({ withCookies: true, cappedClient: true, label: '（备用客户端兜底）' });
    }
    pushLog('>>> 命中缓存：该链接上次' + (cached.cookies ? '需要' : '无需') + ' cookies'
      + (cached.capped ? '，且需要备用客户端' : '') + '，直接沿用', 'dim', taskId);
  } else {
    plan = [
      { withCookies: false, label: '（不带 cookies）' },
      // cappedClient 不写死：留给下一轮根据"上一轮是不是鉴权失败"动态决定
      { withCookies: true, label: '（带浏览器 cookies 重试）' },
    ];
  }

  let lastFile = '';
  let lastAuthFail = false;   // 上一轮是否因鉴权失败（决定要不要动用封顶客户端）
  for (const step of plan) {
    // 关键：被「取消/停止全部」掐断后不能再开新一轮 —— 否则杀掉进程的下一刻
    // 又拉起一个新下载，用户看到的是"点了停止但还在下"。
    if (taskId && cancelledTasks.has(taskId)) {
      pushLog('>>> 已取消，不再重试', 'warn', taskId);
      return { ok: false, msg: '已取消' };
    }

    // 封顶客户端（web_safari,tv）会把清晰度压到 1080p 级，只在两种情况用：
    //   ① 缓存明确记录上次需要它；② 上一轮是鉴权失败（年龄限制/需登录）——
    //      这种情况默认客户端只给 360p，只能靠它。
    // 但**只要 PO Token 可用就不用它** —— 有 token 时默认客户端能直接拿到 4K，
    // 用封顶客户端反而把 4K 压成 1080p（实测同一视频 3840×2026 → 1920×1012）。
    // 封顶客户端是 YouTube 的 player_client 参数，社媒站不能用
    const cappedClient = !isSocial && step.withCookies && !hasPot
      && (step.cappedClient === true || lastAuthFail);

    const r = await runYtdlp({
      ytdlp, args, cwdEnv, withCookies: step.withCookies, cappedClient,
      label: step.label + (cappedClient ? ' [备用客户端]' : ''),
      url, taskId,
    });
    if (r.code === 0) {
      lastFile = r.lastFile;
      setCached(key, step.withCookies, cappedClient);
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
  const r = await dialog.showOpenDialog(mainWindow, {
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
  const r = await dialog.showOpenDialog(mainWindow, {
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

      const vLine = pick(/Stream #[\d:]+.*?Video:/);
      const vres = vLine.match(/(\d{2,5})x(\d{2,5})/);
      const vcodec = (vLine.match(/Video:\s*([A-Za-z0-9_]+)/) || [])[1] || '';
      const vfps = (vLine.match(/([\d.]+)\s*fps/) || [])[1] || '';

      const aLine = pick(/Stream #[\d:]+.*?Audio:/);
      const acodec = (aLine.match(/Audio:\s*([A-Za-z0-9_]+)/) || [])[1] || '';

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
      });
    });
  });
}

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
// 找法三条路，按可靠性排序：
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
    ],
    userRel: ['Programs\\VideoLAN\\VLC\\vlc.exe'],
  },
  {
    name: 'MPV',
    exes: ['mpv.exe'],
    rel: ['Program Files\\mpv\\mpv.exe', 'mpv\\mpv.exe'],
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
  for (const p of EXTERNAL_PLAYERS) {
    for (const exe of p.exes) {
      const hit = queryAppPath(exe);      // ① 注册表
      if (hit) { externalPlayerCache = { name: p.name, path: hit, via: 'registry' }; return externalPlayerCache; }
    }
    for (const f of playerStdPaths(p)) {  // ② 标准路径（多盘符）
      try {
        if (f && fs.existsSync(f)) { externalPlayerCache = { name: p.name, path: f, via: 'path' }; return externalPlayerCache; }
      } catch (e) { /* 路径非法就跳过 */ }
    }
  }
  return externalPlayerCache;
}

// 环境检测页和"预览失败"提示都要用：应用内能不能播、外部兜底该找谁
ipcMain.handle('get_playback_caps', () => {
  const pl = findExternalPlayer();
  return {
    hwDisabled: HW_DISABLED,
    appPreview: !HW_DISABLED,
    // regBlocked 只是提示"注册表那条路没走通"，不代表没装播放器（路径扫描可能已经找到了）
    regBlocked,
    external: pl ? { name: pl.name, path: pl.path, via: pl.via } : null,
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
function runFfmpegOnce({ ff, args, jobId, taskId, expectedSec, label, onLog }) {
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
            sendToRenderer('video-progress', { jobId, percent: pct, detail: `已处理 ${fmtTime(cur)} / ${fmtTime(expectedSec)}` });
          }
        }
        if (/^progress=end/.test(t)) {
          sendToRenderer('video-progress', { jobId, percent: 100, detail: '收尾中…' });
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
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择视频文件',
    filters: [{ name: '视频', extensions: [...VIDEO_EXTS].map((e) => e.slice(1)) }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return { ok: false, files: [], totalBytes: 0 };
  const files = r.filePaths;
  return { ok: true, files, totalBytes: sumFileSize(files) };
});

ipcMain.handle('collect_videos', async (e, recursive) => {
  const r = await dialog.showOpenDialog(mainWindow, {
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

// 退出前的收尾。注意：预览不做转制，所以这里没有"清预览缓存"的事（临时目录压根不会产生）。
app.on('will-quit', () => {
  // 正常退出要撤掉"启动中"标记，否则下次启动会被误判成"上次崩了"而降级到兼容模式
  // （用户开完应用秒关就会踩到，实测过）
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
