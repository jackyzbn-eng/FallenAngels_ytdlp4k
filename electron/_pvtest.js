// 验证「预览播放器」：能不能直接播 HEVC（不转制）、拖动定位、设为切点
// 用真实 main.js 起窗口，靠 executeJavaScript 读 DOM + capturePage 截图（CDP 在这台机器上不通）
require('./main.js');
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || '.';
const VIDEO = process.argv[3];
const LOGF = path.resolve(__dirname, '..', '_pv.log');

try { fs.unlinkSync(LOGF); } catch (e) { /* 首次 */ }
const LOG = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOGF, s + '\n'); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('uncaughtException', (e) => { LOG('!! ' + e.stack); app.exit(9); });

const proxyDir = () => path.join(app.getPath('temp'), 'fallen-angels-preview');
const proxyCount = () => {
  try { return fs.readdirSync(proxyDir()).length; } catch (e) { return -1; }   // -1 = 目录不存在
};

app.whenReady().then(async () => {
  LOG('== app ready ' + new Date().toLocaleTimeString());

  let win = null;
  for (let i = 0; i < 80; i++) {
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { win = ws[0]; break; }
    await sleep(300);
  }
  if (!win) { LOG('致命：没建出窗口'); app.exit(1); return; }

  const wc = win.webContents;
  wc.on('render-process-gone', (e, d) => LOG('!! 渲染进程没了 ' + d.reason + ' ' + d.exitCode));
  const ev = (expr) => Promise.race([
    wc.executeJavaScript(expr, true),
    sleep(10000).then(() => '__TIMEOUT__'),
  ]);
  const shot = async (name) => {
    let buf = null;
    // 打开硬件加速后 wc.capturePage() 读不回 GPU 合成的画面（返回 0 字节空图）。
    // 改走 webContents.debugger —— 它是**进程内**调用 CDP，不经过 WebSocket，
    // 所以不受之前"CDP 端口连上就超时"那个问题影响。
    // ⚠️ 但 sendCommand 偶尔也不回包，必须加超时，否则整个自检就卡在这儿（踩过）。
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const r = await Promise.race([
        wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
        sleep(8000).then(() => null),
      ]);
      if (r && r.data) buf = Buffer.from(r.data, 'base64');
      else LOG('  调试接口截图无响应，回退 capturePage');
    } catch (e) {
      LOG('  调试接口截图失败（' + e.message + '），回退 capturePage');
    }
    if (!buf || !buf.length) {
      try { buf = (await wc.capturePage()).toPNG(); } catch (e2) { buf = null; }
    }
    if (!buf || !buf.length) { LOG('!! 截图拿到空图: ' + name); return; }
    fs.writeFileSync(path.join(OUT, name + '.png'), buf);
    LOG('已保存 ' + name + '.png（' + Math.round(buf.length / 1024) + ' KB）');
  };

  for (let i = 0; i < 60; i++) {
    const n = await ev(`document.querySelectorAll('.log .line').length`);
    if (typeof n === 'number' && n > 0) { LOG('前端就绪'); break; }
    await sleep(400);
  }

  LOG('');
  LOG('=== 准备：切到视频处理页，拖入一个 HEVC 视频 ===');
  LOG('代理目录里现有文件数: ' + proxyCount() + '（-1 = 目录不存在）');
  await ev(`window.alert = (m) => { (window.__alerts = window.__alerts || []).push(String(m)); }; 'ok'`);
  // 切到视频处理页。init 末尾还会 switchPage('yt') 把页面重置回去，
  // 所以这里必须断言当前页真的切过去了 —— 否则 DOM 操作照样成功、截图却拍到的是另一页（踩过）
  for (let i = 0; i < 12; i++) {
    await ev(`switchPage('video'); 'ok'`);
    await sleep(250);
    const shown = await ev(`document.querySelector('#page-video').style.display`);
    if (i === 0 || shown === 'flex') LOG('切换尝试 ' + (i + 1) + ' → #page-video display=' + shown);
    if (shown === 'flex') break;
  }
  await ev(`addVidFiles([${JSON.stringify(VIDEO)}], 22282773)`);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!(vidInfo && vidKeyframes.length)`)) { LOG('视频信息就绪'); break; }
    await sleep(500);
  }

  LOG('');
  LOG('=== 等预览加载（HEVC 能否直接播，看这里）===');
  const t0 = Date.now();
  let pv = null;
  for (let i = 0; i < 40; i++) {
    pv = JSON.parse(await ev(`JSON.stringify({
      pageShown: document.querySelector('#page-video').style.display === 'flex',
      src: (document.querySelector('#vid-pv').currentSrc || document.querySelector('#vid-pv').src || ''),
      readyState: document.querySelector('#vid-pv').readyState,
      w: document.querySelector('#vid-pv').videoWidth,
      h: document.querySelector('#vid-pv').videoHeight,
      dur: document.querySelector('#vid-pv').duration,
      hint: document.querySelector('#vid-pv-hint').textContent,
      err: document.querySelector('#vid-pv').error ? document.querySelector('#vid-pv').error.code : 0
    })`));
    if (pv.readyState >= 1) break;
    await sleep(500);
  }
  LOG('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  LOG('视频处理页在前台: ' + pv.pageShown);
  LOG('readyState=' + pv.readyState + '（>=1 表示元数据已读到）');
  LOG('画面尺寸: ' + pv.w + 'x' + pv.h + '（0x0 = 解不出画面）');
  LOG('时长: ' + (typeof pv.dur === 'number' ? pv.dur.toFixed(2) : pv.dur));
  LOG('播放地址: ' + pv.src);
  LOG('是不是原片直连: ' + (/fallen-angels-preview/.test(pv.src) ? '否，走的是代理副本 ✗' : '是 ✓ 没有转制'));
  LOG('代理目录文件数: ' + proxyCount() + '（0 或 -1 = 全程没转制 ✓）');
  LOG('提示文案: ' + pv.hint);
  await shot('8-视频处理-预览');

  LOG('');
  LOG('=== 播放：时间要往前走 ===');
  await ev(`document.querySelector('#vid-pv-play').click(); 'ok'`);
  await sleep(1600);
  const playing = JSON.parse(await ev(`JSON.stringify({
    t: document.querySelector('#vid-pv').currentTime,
    paused: document.querySelector('#vid-pv').paused,
    btn: document.querySelector('#vid-pv-play').textContent,
    head: document.querySelector('#vid-kf-head').style.left,
    headHidden: document.querySelector('#vid-kf-head').hidden,
    time: document.querySelector('#vid-pv-time').textContent,
    range: document.querySelector('#vid-pv-range').value
  })`));
  LOG('当前时间 ' + playing.t.toFixed(2) + ' 秒 · 暂停中=' + playing.paused + ' · 按钮="' + playing.btn + '"');
  LOG('进度条 value=' + playing.range + ' · 时间显示 ' + playing.time);
  LOG('轨道绿线 left=' + playing.head + ' 隐藏=' + playing.headHidden);
  await shot('9-视频处理-播放中');

  LOG('');
  LOG('=== 拖动进度条到 60% → 画面应跳到 60% 处 ===');
  await ev(`(() => {
    const v = document.querySelector('#vid-pv');
    v.pause();
    const r = document.querySelector('#vid-pv-range');
    r.value = '600';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  await sleep(900);
  const seeked = JSON.parse(await ev(`JSON.stringify({
    t: document.querySelector('#vid-pv').currentTime,
    dur: document.querySelector('#vid-pv').duration,
    head: document.querySelector('#vid-kf-head').style.left,
    time: document.querySelector('#vid-pv-time').textContent
  })`));
  LOG('跳到 ' + seeked.t.toFixed(2) + ' / ' + seeked.dur.toFixed(2) + ' 秒（期望约 ' +
    (seeked.dur * 0.6).toFixed(2) + '）· 绿线 left=' + seeked.head);
  LOG('时间显示: ' + seeked.time);

  LOG('');
  LOG('=== 点「设为起点」（应吸附到最近关键帧并写进输入框）===');
  const beforeStart = await ev(`document.querySelector('#vid-start').value`);
  await ev(`document.querySelector('#vid-pv-set-start').click(); 'ok'`);
  await sleep(400);
  const after = JSON.parse(await ev(`JSON.stringify({
    start: document.querySelector('#vid-start').value,
    pos: document.querySelector('#vid-kf-pos').textContent,
    trimHint: document.querySelector('#vid-trim-hint').textContent,
    logTail: [...document.querySelectorAll('#log-video .line')].slice(-2).map(d => d.textContent),
    kf: vidKeyframes
  })`));
  LOG('起点: ' + beforeStart + ' → ' + after.start + '（关键帧位置: ' + after.kf.join(' / ') + '）');
  LOG('微调行: ' + after.pos);
  LOG('提示: ' + after.trimHint);
  LOG('日志: ' + JSON.stringify(after.logTail));
  await shot('10-视频处理-预览定起点');

  LOG('');
  LOG('=== 点「跳到起点」→ 画面应回到起点那一秒 ===');
  await ev(`document.querySelector('#vid-pv').currentTime = 1; 'ok'`);
  await sleep(300);
  await ev(`document.querySelector('#vid-pv-to-start').click(); 'ok'`);
  await sleep(700);
  const back = JSON.parse(await ev(`JSON.stringify({
    t: document.querySelector('#vid-pv').currentTime,
    start: document.querySelector('#vid-start').value
  })`));
  LOG('画面停在 ' + back.t.toFixed(2) + ' 秒（起点是 ' + back.start + '）');

  // ---- 兜底路径：故意用一个 Chromium 放不了的编码（mpeg4/avi），该出现「用系统播放器打开」 ====
  const BAD = process.argv[4];
  if (BAD) {
    LOG('');
    LOG('=== 兜底：放不出来的视频 ===');
    await ev(`clearVidFiles(); 'ok'`);
    await sleep(600);
    await ev(`addVidFiles([${JSON.stringify(BAD)}], 90976)`);
    for (let i = 0; i < 40; i++) {
      if (await ev(`!!(vidInfo && vidKeyframes.length >= 0 && document.querySelector('#vid-pv-hint').textContent.indexOf('放不出来') >= 0)`)) break;
      await sleep(500);
    }
    const st = JSON.parse(await ev(`JSON.stringify({
      readyState: document.querySelector('#vid-pv').readyState,
      errCode: document.querySelector('#vid-pv').error ? document.querySelector('#vid-pv').error.code : 0,
      hint: document.querySelector('#vid-pv-hint').textContent,
      extHidden: document.querySelector('#vid-pv-external').hidden,
      extText: document.querySelector('#vid-pv-external').textContent,
      hasHandler: typeof document.querySelector('#vid-pv-external').onclick === 'function'
    })`));
    LOG('readyState=' + st.readyState + ' · 播放器错误码=' + st.errCode + '（4 = 源不支持）');
    LOG('提示文案: ' + st.hint);
    LOG('「' + st.extText + '」按钮可见: ' + !st.extHidden + ' · 已绑定点击: ' + st.hasHandler);
    await shot('11-视频处理-播不了时的兜底');

    LOG('');
    LOG('=== A + D：外部播放器检测与播放能力卡片 ===');
    const caps = JSON.parse(await ev(`(async () => JSON.stringify(await window.api.get_playback_caps()))()`));
    LOG('get_playback_caps → ' + JSON.stringify(caps));
    LOG('  · 找到自带解码器的播放器: ' + (caps.external ? caps.external.name + ' @ ' + caps.external.path : '没有（会退回系统默认）'));
    const card = await ev(`document.querySelector('#playback-list').innerText`);
    LOG('环境检测页「视频播放能力」卡片内容:');
    LOG(String(card).split('\n').map((l) => '    ' + l).join('\n'));
  }

  LOG('');
  LOG('== 完成 ' + new Date().toLocaleTimeString());
  LOG('最终代理目录文件数: ' + proxyCount());
  app.quit();   // 真实退出路径，会触发 will-quit
});
