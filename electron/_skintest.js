// 皮肤验证：切到 light-workbuddy，把下载页 / 视频处理页（含预览）/ 环境检测页截图
// 结束前把用户的原皮肤恢复回去（applySkin 会写 config.json）
require('./main.js');
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = process.argv[2] || '.';
const VIDEO = process.argv[3];
const LOGF = path.resolve(__dirname, '..', '_skin.log');
try { fs.unlinkSync(LOGF); } catch (e) {}
const LOG = (...a) => { try { fs.appendFileSync(LOGF, a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); } catch (e) {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('uncaughtException', (e) => { LOG('!! ' + e.stack); app.exit(9); });

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 80; i++) {
    const ws = BrowserWindow.getAllWindows();
    if (ws.length) { win = ws[0]; break; }
    await sleep(300);
  }
  const wc = win.webContents;
  const ev = (expr) => Promise.race([wc.executeJavaScript(expr, true), sleep(8000).then(() => '__TIMEOUT__')]);
  const shot = async (name) => {
    let buf = null;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const r = await Promise.race([
        wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png' }),
        sleep(8000).then(() => null),
      ]);
      if (r && r.data) buf = Buffer.from(r.data, 'base64');
    } catch (e) { LOG('  调试截图失败，回退 capturePage'); }
    if (!buf || !buf.length) { try { buf = (await wc.capturePage()).toPNG(); } catch (e) { buf = null; } }
    if (!buf || !buf.length) { LOG('!! 空图: ' + name); return; }
    fs.writeFileSync(path.join(OUT, name + '.png'), buf);
    LOG('已保存 ' + name + '.png（' + Math.round(buf.length / 1024) + ' KB）');
  };

  for (let i = 0; i < 60; i++) {
    const n = await ev(`document.querySelectorAll('.log .line').length`);
    if (typeof n === 'number' && n > 0) { LOG('前端就绪'); break; }
    await sleep(400);
  }

  const prev = await ev(`currentSkin`);
  LOG('用户原皮肤: ' + prev);
  await ev(`window.alert = (m) => { (window.__alerts = window.__alerts || []).push(String(m)); }; applySkin('light-workbuddy'); 'ok'`);
  await sleep(700);
  LOG('皮肤当前: ' + (await ev(`currentSkin`)));
  await shot('12-WorkBuddy皮肤-下载页');

  LOG('=== 视频处理页（拖入真实视频看完整效果）===');
  for (let i = 0; i < 12; i++) {
    await ev(`switchPage('video'); 'ok'`);
    await sleep(250);
    if ((await ev(`document.querySelector('#page-video').style.display`)) === 'flex') break;
  }
  await ev(`addVidFiles([${JSON.stringify(VIDEO)}], 22282773)`);
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!(vidInfo && document.querySelector('#vid-pv').readyState >= 1)`)) break;
    await sleep(500);
  }
  // 点一下轨道让起点/终点游标有内容，画面更接近真实使用
  await ev(`(() => { const r = document.querySelector('#vid-kf-rail').getBoundingClientRect();
    document.querySelector('#vid-kf-rail').dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width*0.42, clientY: r.top+15, bubbles: true }));
    document.querySelector('#vid-kf-rail').dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width*0.9, clientY: r.top+15, shiftKey: true, bubbles: true }));
    return 'ok'; })()`);
  await sleep(500);
  await shot('13-WorkBuddy皮肤-视频预览');

  LOG('=== 环境检测页 ===');
  await ev(`switchPage('env')`);
  await sleep(600);
  await shot('14-WorkBuddy皮肤-环境检测');

  LOG('=== 恢复原皮肤: ' + prev + ' ===');
  await ev(`applySkin(${JSON.stringify(prev)})`);
  await sleep(400);
  LOG('皮肤已恢复为: ' + (await ev(`currentSkin`)));
  LOG('== 完成');
  app.quit();
});
