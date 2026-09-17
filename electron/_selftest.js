// 自检脚本：以 electron 的入口身份加载**真实的 main.js**，然后用 webContents 的
// executeJavaScript 读 DOM、capturePage 截图。
//
// 为什么不用 Chrome DevTools Protocol：这台机器上 CDP 的 WebSocket 连上后所有请求都无响应
// （Node 内置 WebSocket 的 onmessage / addEventListener 都试过，均超时），
// 而 executeJavaScript 走的是进程内调用，不受这些影响，也不需要开调试端口。
//
// 放在 electron/ 目录里是有意的：main.js 用 __dirname 定位项目根，脚本换个目录就会找错路径。
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

require('./main.js');   // 把真实主进程整个加载进来（建窗口、注册 IPC）

const OUT = process.argv[2] || '.';
const VIDEO = process.argv[3];
const LOGF = path.resolve(__dirname, '..', '_kf.log');

try { fs.unlinkSync(LOGF); } catch (e) { /* 首次没有 */ }
const LOG = (...a) => {
  const s = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  try { fs.appendFileSync(LOGF, s + '\n'); } catch (e) {}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('uncaughtException', (e) => { LOG('!! uncaughtException: ' + e.stack); app.exit(9); });

app.whenReady().then(async () => {
  LOG('== app ready ' + new Date().toLocaleTimeString());

  let win = null;
  for (let i = 0; i < 80; i++) {
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { win = ws[0]; break; }
    await sleep(300);
  }
  if (!win) { LOG('致命：主进程没建出窗口'); app.exit(1); return; }
  LOG('窗口已创建');

  const wc = win.webContents;
  // 把渲染进程的状态暴露出来：executeJavaScript 会一直挂着不返回的时候，
  // 只能靠这些事件判断页面到底是没加载完、加载失败，还是渲染进程直接没了
  wc.on('did-finish-load', () => LOG('  [wc] did-finish-load'));
  wc.on('did-fail-load', (e, code, desc, url) => LOG('  [wc] !! did-fail-load ' + code + ' ' + desc + ' ' + url));
  wc.on('render-process-gone', (e, d) => LOG('  [wc] !! 渲染进程没了 ' + JSON.stringify(d)));
  wc.on('preload-error', (e, p, err) => LOG('  [wc] !! preload 出错 ' + p + ' ' + err.message));
  wc.on('console-message', (e, level, message) => { if (level >= 2) LOG('  [页面控制台] ' + message); });
  LOG('  URL=' + wc.getURL() + ' · 是否仍在加载=' + wc.isLoading() + ' · 崩溃过=' + wc.isCrashed());

  // executeJavaScript 可能永久挂住（页面没就绪时），加超时兜底，否则整个自检就停在这儿
  const ev = (expr) => Promise.race([
    wc.executeJavaScript(expr, true),
    sleep(8000).then(() => '__TIMEOUT__'),
  ]);
  const shot = async (name) => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
    LOG('已保存 ' + name + '.png');
  };

  for (let i = 0; i < 60; i++) {
    let n = '__ERR__';
    try { n = await ev(`document.querySelectorAll('.log .line').length`); } catch (e) { n = '异常: ' + e.message; }
    if (typeof n === 'number' && n > 0) { LOG('前端已就绪（日志行 ' + n + '）'); break; }
    if (i % 5 === 0) LOG('  等待前端就绪… 第 ' + i + ' 次得到: ' + JSON.stringify(n));
    await sleep(400);
  }

  LOG('');
  LOG('=== 切到视频处理页，加入一个真实视频 ===');
  // 把 alert 接管掉：否则弹窗会阻塞渲染进程，后面所有 executeJavaScript 都拿不到结果，
  // 只能看到"点了没反应"，查不出到底报的什么错
  await ev(`(() => {
    if (!window.__alertHooked) {
      window.__alertHooked = true;
      window.__alerts = [];
      window.alert = (m) => { window.__alerts.push(String(m)); };
    }
    return 'ok';
  })()`);
  await ev(`switchPage('video')`);
  await ev(`addVidFiles([${JSON.stringify(VIDEO)}], 22282773)`);
  for (let i = 0; i < 80; i++) {
    if (await ev(`!!(typeof vidInfo !== 'undefined' && vidInfo && vidKeyframes.length)`)) {
      LOG('视频信息与关键帧已就绪');
      break;
    }
    await sleep(500);
  }

  const state = async () => JSON.parse(await ev(`JSON.stringify({
    info: vidInfo ? vidInfo.duration : null,
    kfCount: vidKeyframes.length,
    kf: vidKeyframes,
    rowHidden: document.querySelector('#vid-kf-row').hidden,
    navHidden: document.querySelector('#vid-kf-nav-row').hidden,
    ticks: document.querySelectorAll('#vid-kf-ticks .kf-tick').length,
    railW: Math.round(document.querySelector('#vid-kf-rail').clientWidth),
    startVal: document.querySelector('#vid-start').value,
    endVal: document.querySelector('#vid-end').value,
    curStartLeft: document.querySelector('#vid-kf-cur-start').style.left,
    curEndLeft: document.querySelector('#vid-kf-cur-end').style.left,
    selWidth: document.querySelector('#vid-kf-sel').style.width,
    pos: document.querySelector('#vid-kf-pos').textContent,
    hint: document.querySelector('#vid-kf-hint').textContent,
    trimHint: document.querySelector('#vid-trim-hint').textContent,
    hasBtnStart: !!document.querySelector('#vid-btn-start')
  })`));

  LOG('');
  LOG('=== 初始状态 ===');
  const s0 = await state();
  LOG('时长 ' + s0.info + ' 秒 · 关键帧 ' + s0.kfCount + ' 个: ' + s0.kf.join(' / '));
  LOG('轨道可见: ' + !s0.rowHidden + ' · 轨道宽 ' + s0.railW + 'px · 刻度 ' + s0.ticks + ' 根');
  LOG('微调行可见: ' + !s0.navHidden + ' · ' + s0.pos);
  LOG('轨道提示: ' + s0.hint);
  LOG('"开始处理"按钮 id 已修正: ' + s0.hasBtnStart);
  await shot('5-视频处理-关键帧轨道');

  LOG('');
  LOG('=== 单击轨道 42%（约 6.8 秒）→ 起点应吸附到最近关键帧 7.5 ===');
  await ev(`(() => {
    const rail = document.querySelector('#vid-kf-rail');
    const r = rail.getBoundingClientRect();
    rail.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * 0.42, clientY: r.top + 15, bubbles: true }));
    return 'ok';
  })()`);
  const s1 = await state();
  LOG('起点 = ' + s1.startVal + '（关键帧只有 0/2.5/5/7.5/10/12.5/15，落到 7.5 才算吸附生效）');
  LOG('起点游标 left = ' + s1.curStartLeft + ' · 选中区间宽 = ' + s1.selWidth);
  LOG('微调行: ' + s1.pos);
  LOG('吸附提示: ' + s1.trimHint);

  LOG('');
  LOG('=== Shift+单击轨道 70% → 设终点 ===');
  await ev(`(() => {
    const rail = document.querySelector('#vid-kf-rail');
    const r = rail.getBoundingClientRect();
    rail.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * 0.70, clientY: r.top + 15, shiftKey: true, bubbles: true }));
    return 'ok';
  })()`);
  const s2 = await state();
  LOG('起点 = ' + s2.startVal + ' · 终点 = ' + s2.endVal + ' · 区间宽 = ' + s2.selWidth);
  LOG('提示: ' + s2.trimHint);

  LOG('');
  LOG('=== 右键轨道 95% → 终点应到 15.0 ===');
  await ev(`(() => {
    const rail = document.querySelector('#vid-kf-rail');
    const r = rail.getBoundingClientRect();
    rail.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + r.width * 0.95, clientY: r.top + 15, bubbles: true }));
    return 'ok';
  })()`);
  const s3 = await state();
  LOG('终点 = ' + s3.endVal + ' · 终点游标 left = ' + s3.curEndLeft);

  LOG('');
  LOG('=== 起点微调：下一个 → 上一个（应回到原值）===');
  const before = (await state()).startVal;
  await ev(`document.querySelector('#vid-kf-next').click(); 'ok'`);
  const mid = (await state()).startVal;
  await ev(`document.querySelector('#vid-kf-prev').click(); 'ok'`);
  const back = (await state()).startVal;
  LOG(before + ' → 下一个 → ' + mid + ' → 上一个 → ' + back);
  LOG('往返一致: ' + (before === back ? '是 ✓' : '否 ✗'));
  const s4 = await state();
  LOG('微调行: ' + s4.pos + ' · 提示: ' + s4.trimHint);
  await shot('6-视频处理-挑好切点');

  LOG('');
  LOG('=== 点「开始处理」，验证按钮真的触发（修复前事件绑在了起点输入框上）===');
  const pre = JSON.parse(await ev(`JSON.stringify({
    disabled: document.querySelector('#vid-btn-start').disabled,
    hasOnclick: typeof document.querySelector('#vid-btn-start').onclick,
    vidFiles: vidFiles.length,
    mode: vidOpts.mode,
    start: document.querySelector('#vid-start').value,
    end: document.querySelector('#vid-end').value
  })`));
  LOG('点击前: ' + JSON.stringify(pre));

  await ev(`document.querySelector('#vid-btn-start').dispatchEvent(new MouseEvent('click', { bubbles: true })); 'ok'`);
  await sleep(400);
  const soon = JSON.parse(await ev(`JSON.stringify({
    jobId: (typeof vidJob !== 'undefined' && vidJob) ? vidJob.id : null,
    status: document.querySelector('#vid-status').textContent,
    alerts: window.__alerts || []
  })`));
  LOG('点击后 0.4 秒: ' + JSON.stringify(soon));
  await sleep(1100);
  const busy = JSON.parse(await ev(`JSON.stringify({
    jobId: (vidJob ? vidJob.id : null),
    status: document.querySelector('#vid-status').textContent,
    btnDisabled: document.querySelector('#vid-btn-start').disabled,
    alerts: window.__alerts || [],
    logTail: [...document.querySelectorAll('#log-video .line')].slice(-6).map(d => d.textContent)
  })`));
  LOG('任务已启动: ' + (busy.jobId ? '是 ✓ ' + busy.jobId : '否 ✗ 没反应') +
    ' · 状态: ' + busy.status + ' · 按钮已禁用: ' + busy.btnDisabled);
  if (busy.alerts.length) LOG('弹窗内容: ' + JSON.stringify(busy.alerts));
  LOG('日志尾部: ' + JSON.stringify(busy.logTail, null, 1));

  for (let i = 0; i < 90; i++) {
    const done = await ev(`document.querySelectorAll('#vid-result-list .img-row').length > 0 && !vidJob`);
    if (done) break;
    await sleep(1000);
  }
  const fin = JSON.parse(await ev(`JSON.stringify({
    rows: [...document.querySelectorAll('#vid-result-list .img-row')].map(r => ({
      name: r.querySelector('.img-name').textContent,
      size: r.querySelector('.img-size').textContent,
      range: r.querySelector('.res-range') ? r.querySelector('.res-range').textContent : ''
    })),
    summary: document.querySelector('#vid-summary').textContent,
    status: document.querySelector('#vid-status').textContent
  })`));
  LOG('结果行: ' + JSON.stringify(fin.rows));
  LOG('汇总: ' + fin.summary + ' · 状态: ' + fin.status);
  await sleep(600);
  await shot('7-视频处理-剪完的结果');

  LOG('== 完成 ' + new Date().toLocaleTimeString());
  app.exit(0);
});
