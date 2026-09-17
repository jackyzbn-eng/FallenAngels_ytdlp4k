/* Fallen Angels 前端逻辑 —— 通过 window.api（preload 桥接）调用 Electron 主进程 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ============ 皮肤 ============ */
const SKINS = [
  { id: "light-cindy",     name: "浅色极简",      colors: ["#f8f8f6", "#ffffff", "#111111"] },
  { id: "light-workbuddy", name: "WorkBuddy 浅色", colors: ["#f5f6f7", "#ffffff", "#0fc98c"] },
  { id: "dark-linear",     name: "深色 Linear",   colors: ["#08090a", "#101114", "#8fa4ff"] },
  { id: "light-motrix",    name: "渐变科技",      colors: ["#dfeaff", "#ffffff", "#2f7cf6"] },
  { id: "dark-neon",       name: "深色霓虹",      colors: ["#0b0d12", "#161b23", "#38bdf8"] },
];

let currentSkin = "dark-linear";

function applySkin(id) {
  currentSkin = id;
  // 用 body class 切换主题
  document.body.className = "theme-" + id;
  renderSkinGrid();
  // 记忆选择
  if (window.api && window.api.set_skin) {
    try { window.api.set_skin(id); } catch (e) {}
  }
}

/* 应用名下方显示版本号。
   version 由主进程 app.getVersion() 提供（读 package.json）；
   取不到时（如浏览器里直接开 index.html 调试）留空，CSS 里 :empty 会隐藏，不占位。 */
function renderVersion(version) {
  const el = $("#app-version");
  if (!el) return;
  const v = String(version || "").trim();
  el.textContent = v ? "v" + v.replace(/^v/i, "") : "";
}

function renderSkinGrid() {
  const grid = $("#skin-grid");
  grid.innerHTML = "";
  SKINS.forEach((s) => {
    const card = document.createElement("div");
    card.className = "skin-card" + (s.id === currentSkin ? " selected" : "");
    card.innerHTML =
      '<div class="skin-preview">' +
        '<div class="sp-side" style="background:' + s.colors[0] + '"></div>' +
        '<div class="sp-main" style="background:' + s.colors[0] + '">' +
          '<div style="height:14px;border-radius:5px;background:' + s.colors[1] + ';margin-bottom:6px"></div>' +
          '<div style="height:8px;border-radius:4px;background:' + s.colors[2] + ';width:60%"></div>' +
        '</div>' +
      '</div>' +
      '<div class="skin-name">' + s.name + '</div>';
    card.onclick = () => applySkin(s.id);
    grid.appendChild(card);
  });
}

/* ============ 两个下载页：完全分开的队列 / 按钮 / 日志 ============
   油管与社媒各自一套 DOM（id 统一带 -yt / -social 后缀），互不干扰。
   主进程仍只有一个调度器（并行上限 3），任务靠 source 字段路由回各自的页面。 */
const SOURCES = ["yt", "social"];

const SOURCE_CONF = {
  yt: {
    urlBox: "#url",
    hint: "#url-hint",
    paste: "#btn-paste-list",
    empty: "支持批量：一行一个链接，也可用空格或逗号分隔；下载中也能随时再添加",
  },
  social: {
    urlBox: "#social-url",
    hint: "#social-url-hint",
    paste: "#social-btn-paste",
    empty: "支持批量：一行一个链接，也可用空格或逗号分隔；分享短链（如 v.douyin.com/…）直接贴即可",
  },
};

// 取某个来源的专属元素：el("task-list", "yt") → #task-list-yt
function el(name, src) { return document.getElementById(name + "-" + src); }

/* ============ 页面切换 ============ */
function switchPage(name) {
  $$(".nav-item").forEach((n) => n.classList.toggle("active", n.dataset.page === name));
  $$(".page").forEach((p) => (p.style.display = "none"));
  const target = $("#page-" + name);
  if (target) target.style.display = "flex";
  // 页面藏起来时宽度是 0，关键帧轨道的刻度抽样密度会算错，切回来重画一次
  if (name === "video") renderKfRail();
}

$$(".nav-item").forEach((n) => (n.onclick = () => switchPage(n.dataset.page)));

/* ============ 事件绑定（移到函数内，延迟到 DOM 就绪后调用） ============ */
function bindEvents() {
  $$(".nav-item").forEach((n) => (n.onclick = () => switchPage(n.dataset.page)));
  // 「＋ 添加分类」两个下载页各有一个，各加到自己那一份里
  $$(".add-dir").forEach((b) => {
    const s = b.dataset.src;
    b.onclick = () => {
      dirs[s].push({ name: "分类" + (dirs[s].length + 1), path: "" });
      saveDirs(); renderDirs(s);
    };
  });

  // 两个下载页各绑一套：加入队列 / 粘贴 / 输入框 / 停止全部 / 清除已完成 / 日志
  SOURCES.forEach((src) => {
    const conf = SOURCE_CONF[src];
    // 社媒站不像油管有 4K 分档，一律取平台最高的「原画」，也不做帧率转换
    const isSocial = src === "social";

    el("btn-download", src).onclick = async () => {
      const raw = $(conf.urlBox).value || "";
      const list = parseUrls(raw, src);
      if (!list.length) { alert("请粘贴视频链接"); return; }
      const target = currentDir(src);
      if (!target || !target.path) { alert("请先为所选分类设置保存文件夹"); return; }

      const uniq = dedupeUrls(list);
      if (uniq.dupCount > 0) {
        addLogLineLocal(`已忽略 ${uniq.dupCount} 个重复链接`, "dim", src);
      }

      // 注意：这里不禁用按钮 —— 随时可以再贴一批进来追加任务。
      const r = await callApi("start_download", {
        urls: uniq.urls, dir: target.path,
        quality: isSocial ? "原画" : quality,
        fps: isSocial ? "0" : fps,
        proxyMode,
        proxy: $("#proxy-addr").value.trim(),
        source: src,
      });

      if (!r || !r.ok) {
        updateProgress({ state: "error", detail: (r && r.msg) || "启动失败" });
        return;
      }

      // 追加成功：清空输入框，方便马上贴下一个
      $(conf.urlBox).value = "";
      updateUrlHint(src);
      addLogLineLocal(`已添加 ${r.added} 个任务` + (r.skipped ? `（跳过 ${r.skipped} 个已在队列中）` : ""), "dim", src);
      updateDownloadButtonState(src);
    };

    // 从剪贴板一键粘贴（多链接时比手动 Ctrl+V 顺手）
    $(conf.paste).onclick = async () => {
      const txt = await callApi("read_clipboard");
      if (!txt || !String(txt).trim()) return;
      const box = $(conf.urlBox);
      box.value = box.value.trim() ? box.value.trim() + "\n" + String(txt).trim() : String(txt).trim();
      updateUrlHint(src);
    };
    $(conf.urlBox).addEventListener("input", () => updateUrlHint(src));

    // 停止全部：只停本页的任务
    el("btn-stop-all", src).onclick = async () => {
      await callApi("stop_all", src);
    };
    el("btn-clear-finished", src).onclick = async () => {
      const rest = await callApi("clear_finished", src);
      allTasks = Array.isArray(rest) ? rest : [];
      renderTasks(src);
      updateDownloadButtonState(src);
    };
    el("btn-clear-log", src).onclick = () => clearLog(src);
  });

  // 复制日志（便于把问题日志直接粘给开发者，不用截图）
  SOURCES.forEach((src) => {
    const b = el("btn-copy-log", src);
    b.onclick = async () => {
    const lines = Array.from(el("log", src).querySelectorAll(".line")).map((d) => d.textContent);
    if (!lines.length) return;
    const head = "=== Fallen Angels 日志 " + new Date().toLocaleString() + " ===";
    const ok = await callApi("copy_text", head + "\n" + lines.join("\n"));
    const old = b.textContent;
    b.textContent = ok ? "已复制 ✓" : "复制失败";
    setTimeout(() => { b.textContent = old; }, 1200);
    };
  });

  /* 注：播放 / 属性 / 打开目录 已改为「队列行内按钮」（见 renderTasks），
     底栏不再放这三个——它们针对的是某一个视频，放在全局底栏容易点错对象。 */

  // 浏览器 Cookies 来源切换（年龄限制视频需要登录态）
  $$("#cookies-opts .radio").forEach((el) => {
    el.onclick = async () => {
      $$("#cookies-opts .radio").forEach((r) => r.classList.remove("checked"));
      el.classList.add("checked");
      cookiesBrowser = el.dataset.v;
      await callApi("save_cookies_browser", cookiesBrowser);
      renderCookieHint();
    };
  });

  // 导入 cookies.txt（Chrome/Edge 在新版本下唯一可行的方式）
  $("#btn-import-cookies").onclick = async () => {
    const r = await callApi("import_cookies_file");
    if (!r) return;
    if (!r.ok) { alert("导入失败：" + r.msg); return; }
    await renderCookieHint();
    alert(r.msg + "\n\n现在可以下载需要登录的视频了。");
  };

  // 清除已导入的 cookies.txt
  $("#btn-clear-cookies").onclick = async () => {
    if (!confirm("确定清除已导入的 cookies.txt？\n清除后年龄限制视频将无法下载。")) return;
    const r = await callApi("clear_cookies_file");
    if (r && r.ok) { await renderCookieHint(); alert("已清除"); }
  };

  // 环境检测：重新检测
  $("#btn-refresh").onclick = async () => {
    const b = $("#btn-refresh");
    const old = b.textContent;
    b.textContent = "检测中…";
    b.disabled = true;
    const comps = await callApi("get_components");
    b.textContent = old;
    b.disabled = false;
    if (comps) renderComponents(comps);
    renderPlaybackCaps();      // 播放能力跟着一起重检测
  };

  // 环境检测：一键安装（组件均随应用内置，这里给出说明与修复指引）
  $("#btn-install").onclick = async () => {
    const comps = await callApi("get_components");
    const missing = (comps || []).filter((c) => !c.ok);
    if (!missing.length) {
      alert("所有组件均已就绪，无需安装 ✓");
    } else {
      alert(
        "检测到缺失：" + missing.map((c) => c.name).join("、") +
        "\n\n这些组件已随应用一起分发（位于安装目录的 resources\\tools）。" +
        "若显示缺失，通常是文件被清理软件误删，建议重新运行安装包修复。"
      );
    }
  };

  // 图片压缩页 / 视频处理页
  bindImageEvents();
  bindVideoEvents();

  // 关闭属性弹窗（点 ✕ 或点遮罩）
  $("#attr-close").onclick = () => { $("#attr-modal").hidden = true; };
  $("#attr-modal").onclick = (e) => {
    if (e.target && e.target.id === "attr-modal") $("#attr-modal").hidden = true;
  };
}

/* ============ 图片压缩 ============ */
// 与下载页无关的一套状态：待处理文件、当前任务、统计、设置
let imgFiles = [];
let imgTotalSize = 0;                               // 待处理图片合计体积（主进程算好给过来）
let imgJob = null;                                  // { id, total }
let imgStats = { ok: 0, skip: 0, err: 0, before: 0, after: 0 };
let imgOpts = { quality: "中", format: "keep", maxEdge: 0, outMode: "sub", outDir: "" };

function humanSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  const u = ["KB", "MB", "GB"];
  let x = v / 1024, i = 0;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return x.toFixed(x >= 100 ? 0 : 1) + " " + u[i];
}

function imgDirOf(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : "";
}

// 这次运行的图片最终会落到哪个目录（用于「打开输出目录」）
function imgOutputDir() {
  if (imgOpts.outMode === "custom") return imgOpts.outDir || "";
  if (!imgFiles.length) return "";
  return imgDirOf(imgFiles[0]) + "\\compressed";
}

function saveImgOpts() {
  callApi("save_img_settings", imgOpts);
}

function renderImgCount() {
  const el = $("#img-count");
  if (!el) return;
  const btn = $("#img-start");
  if (!imgFiles.length) {
    el.textContent = "尚未选择图片";
    if (btn) btn.disabled = true;
    return;
  }
  el.textContent = `${imgFiles.length} 张图片` + (imgTotalSize ? ` · 合计 ${humanSize(imgTotalSize)}` : "");
  if (btn) btn.disabled = !!imgJob;
}

// 追加一批图片（主进程同时把合计体积一并算好给过来，前端读不了文件）
function addImgFiles(files, totalBytes) {
  if (Array.isArray(files) && files.length) imgFiles = imgFiles.concat(files);
  imgTotalSize += Number(totalBytes) || 0;
  renderImgCount();
}

function clearImgFiles() {
  imgFiles = [];
  imgTotalSize = 0;
  renderImgCount();
}

function clearImgResult() {
  const card = $("#img-result-card");
  const list = $("#img-result-list");
  const sum = $("#img-summary");
  if (list) list.innerHTML = "";
  if (sum) sum.textContent = "";
  if (card) card.hidden = true;
  imgStats = { ok: 0, skip: 0, err: 0, before: 0, after: 0 };
}

function appendImgResult(d) {
  const card = $("#img-result-card");
  if (card) card.hidden = false;
  const box = $("#img-result-list");
  if (!box) return;

  const before = d.before || 0;
  const after = d.after || 0;
  const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;

  const cls = !d.ok ? "error" : (d.skipped ? "skip" : "done");
  const sizeText = !d.ok ? "失败"
    : (d.skipped ? humanSize(before) + "（原图已更小）"
      : humanSize(before) + " → " + humanSize(after));
  const savedText = !d.ok ? "失败" : (d.skipped ? "跳过" : "-" + saved + "%");

  const row = document.createElement("div");
  row.className = "img-row " + cls;
  row.innerHTML =
    '<span class="img-name" title="' + escapeAttr(d.msg || d.file || "") + '">' + escapeHtml(d.name) + "</span>" +
    '<span class="img-size">' + escapeHtml(sizeText) + "</span>" +
    '<span class="img-saved">' + escapeHtml(savedText) + "</span>";
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function updateImgSummary() {
  const sum = $("#img-summary");
  if (!sum) return;
  const s = imgStats;
  const total = s.ok + s.skip + s.err;
  if (!total) { sum.textContent = ""; return; }
  let txt = `共 ${total} 张 · 成功 ${s.ok}`;
  if (s.skip) txt += ` · 跳过 ${s.skip}`;
  if (s.err) txt += ` · 失败 ${s.err}`;
  if (s.before > 0) {
    txt += ` · ${humanSize(s.before)} → ${humanSize(s.after)}`;
    txt += `（省 ${Math.round((1 - s.after / s.before) * 100)}%）`;
  }
  sum.textContent = txt;
}

function updateImgProgress(done, total) {
  const wrap = $("#img-progress-wrap");
  const fill = $("#img-progress-fill");
  const pct = $("#img-progress-percent");
  const detail = $("#img-progress-detail");
  if (!wrap || !fill || !pct || !detail) return;
  if (!total) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const p = Math.max(0, Math.min(100, (done / total) * 100));
  fill.style.width = p + "%";
  pct.textContent = Math.round(p) + "%";
  detail.textContent = `${done} / ${total}`;
}

function setImgBusy(on) {
  imgJob = on ? (imgJob || { id: "", total: 0 }) : null;
  const start = $("#img-start");
  const stop = $("#img-stop");
  if (start) start.disabled = !!on || !imgFiles.length;
  if (stop) stop.disabled = !on;
}

function bindImageEvents() {
  const pickFiles = $("#img-pick-files");
  const pickDir = $("#img-pick-dir");
  const clearBtn = $("#img-clear");

  if (pickFiles) {
    pickFiles.onclick = async () => {
      const r = await callApi("pick_images");
      if (!r || !r.ok || !r.files.length) return;
      addImgFiles(r.files, r.totalBytes);
      addLogLineLocal(`已加入 ${r.files.length} 张图片`, "dim", "img");
    };
  }
  if (pickDir) {
    pickDir.onclick = async () => {
      const r = await callApi("collect_images", true);
      if (!r || !r.ok) return;
      if (!r.files.length) { alert("这个文件夹里没找到图片"); return; }
      addImgFiles(r.files, r.totalBytes);
      addLogLineLocal(`从「${r.dir}」收集到 ${r.files.length} 张图片`, "dim", "img");
    };
  }
  if (clearBtn) clearBtn.onclick = () => { clearImgFiles(); };

  // 拖拽（路径由 preload 的 webUtils 取，渲染进程拿不到 File.path）
  if (window.api && window.api.on_dropped_files) {
    window.api.on_dropped_files(async (paths) => {
      const r = await callApi("expand_image_paths", paths);
      if (!r || !r.files || !r.files.length) {
        addLogLineLocal("拖进来的内容里没有可压缩的图片", "warn", "img");
        return;
      }
      addImgFiles(r.files, r.totalBytes);
      addLogLineLocal(`拖入 ${r.files.length} 张图片`, "dim", "img");
    });
  }

  const pickOut = $("#img-pick-outdir");
  if (pickOut) {
    pickOut.onclick = async () => {
      const p = await callApi("pick_folder", "选择输出文件夹");
      if (!p) return;
      imgOpts.outDir = p;
      $("#img-outdir").value = p;
      saveImgOpts();
    };
  }

  const clearResult = $("#img-clear-result");
  if (clearResult) clearResult.onclick = () => clearImgResult();

  const start = $("#img-start");
  if (start) {
    start.onclick = async () => {
      if (!imgFiles.length) { alert("请先选择图片"); return; }
      clearImgResult();
      updateImgProgress(0, imgFiles.length);
      setImgBusy(true);
      const r = await callApi("start_image_job", { files: imgFiles, ...imgOpts });
      if (!r || !r.ok) {
        setImgBusy(false);
        updateImgProgress(0, 0);
        $("#img-status").textContent = "就绪";
        alert("启动失败：" + ((r && r.msg) || "未知错误"));
        return;
      }
      imgJob = { id: r.jobId, total: r.total };
      $("#img-status").textContent = `压缩中 0 / ${r.total}`;
    };
  }

  const stop = $("#img-stop");
  if (stop) {
    stop.onclick = async () => {
      if (!imgJob) return;
      await callApi("stop_image_job", imgJob.id);
    };
  }

  const openOut = $("#img-open-out");
  if (openOut) {
    openOut.onclick = async () => {
      const d = imgOutputDir();
      if (!d) return;
      const r = await callApi("open_folder", d);
      if (r && !r.ok) alert("打开失败：" + (r.msg || ""));
    };
  }
}

// 主进程推送：单张完成
function onImageItem(d) {
  if (!d) return;
  if (d.ok) {
    imgStats.before += d.before || 0;
    imgStats.after += d.skipped ? (d.before || 0) : (d.after || 0);
    if (d.skipped) imgStats.skip++; else imgStats.ok++;
  } else {
    imgStats.err++;
  }
  appendImgResult(d);
  updateImgSummary();
  updateImgProgress(d.done || 0, d.total || 0);
  const st = $("#img-status");
  if (st) st.textContent = `压缩中 ${d.done || 0} / ${d.total || 0}`;
}

// 图片压缩页的单选组与显示联动（在 init 里调用）
function initImagePage() {
  renderRadios("img-quality-opts", [
    { value: "高", label: "高（画质优先）" },
    { value: "中", label: "中（推荐）" },
    { value: "低", label: "低（体积优先）" },
  ], imgOpts.quality, (v) => {
    imgOpts.quality = v;
    saveImgOpts();
    renderImgQualityHint();
  });

  renderRadios("img-format-opts", [
    { value: "keep", label: "保持原格式" },
    { value: "webp", label: "WebP" },
    { value: "avif", label: "AVIF" },
    { value: "jpeg", label: "JPEG" },
  ], imgOpts.format, (v) => { imgOpts.format = v; saveImgOpts(); });

  renderRadios("img-edge-opts", [
    { value: 0, label: "不限制" },
    { value: 1920, label: "1920" },
    { value: 2560, label: "2560" },
    { value: 4096, label: "4096" },
  ], imgOpts.maxEdge, (v) => { imgOpts.maxEdge = v; saveImgOpts(); });

  renderRadios("img-out-opts", [
    { value: "sub", label: "各图目录下 compressed/" },
    { value: "custom", label: "指定文件夹" },
  ], imgOpts.outMode, (v) => {
    imgOpts.outMode = v;
    saveImgOpts();
    const row = $("#img-outdir-row");
    if (row) row.hidden = v !== "custom";
  });

  const row = $("#img-outdir-row");
  if (row) row.hidden = imgOpts.outMode !== "custom";

  renderImgQualityHint();
  renderImgCount();
}

function renderImgQualityHint() {
  const el = $("#img-quality-hint");
  if (!el) return;
  const map = {
    高: "几乎看不出差别，适合还要再编辑的图",
    中: "日常够用，体积和画质平衡最好",
    低: "压得最狠，适合只用于预览或上传的图",
  };
  el.textContent = map[imgOpts.quality] || "";
}

// 主进程推送：整批结束
function onImageDone(d) {
  setImgBusy(false);
  if (d && d.total) updateImgProgress(d.total, d.total);
  const st = $("#img-status");
  if (st) {
    if (!d) st.textContent = "就绪";
    else if (d.cancelled) st.textContent = "已中止";
    else st.textContent = d.errCount ? `${d.errCount} 张失败` : "全部完成";
  }
  const openOut = $("#img-open-out");
  if (openOut) openOut.disabled = !imgOutputDir();
  imgJob = null;

  // 跑完把结果卡片滚进视野 —— 结果列表在折叠区下方，不滚用户会以为"没反应"
  const card = $("#img-result-card");
  if (card && !card.hidden) {
    try { card.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
  }
}

/* ============ 视频处理（无损修剪 / 压缩） ============ */
let vidFiles = [];
let vidTotalSize = 0;
let vidJob = null;                 // { id, total }
let vidStats = { ok: 0, err: 0, grew: 0, before: 0, after: 0 };
let vidInfo = null;                // 首个视频的信息（时长/分辨率/关键帧间隔）
let vidKeyframes = [];             // 首个视频的关键帧位置，用来提前算出起点会吸附到哪
let vidKeyInterval = 0;            // 平均关键帧间隔（秒），写在轨道提示里
let vidCaps = null;                // ffmpeg 与硬件编码器可用性

const vidOpts = {
  mode: "trim",                    // trim | compress
  quality: "中",
  encoder: "hevc_nv",
  maxHeight: 0,
  audio: "copy",
  container: "mp4",
  outMode: "same",
  outDir: "",
};

// "83.5" / "0:01:23.500" → 秒
function vidParseTime(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return NaN;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const parts = s.split(":").map((x) => parseFloat(x));
  if (parts.some((x) => isNaN(x))) return NaN;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return sec;
}

function vidFmtTime(sec) {
  const s = Math.max(0, Number(sec) || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const pad = (x, n) => String(x).padStart(n, "0");
  return `${h}:${pad(m, 2)}:${pad(ss.toFixed(3), 6)}`;
}

function saveVidOpts() {
  callApi("save_video_settings", {
    mode: vidOpts.mode, quality: vidOpts.quality, encoder: vidOpts.encoder,
    maxHeight: vidOpts.maxHeight, audio: vidOpts.audio, container: vidOpts.container,
    outMode: vidOpts.outMode, outDir: vidOpts.outDir,
    start: $("#vid-start") ? $("#vid-start").value : "",
    end: $("#vid-end") ? $("#vid-end").value : "",
  });
}

function vidDirOf(p) {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : "";
}

function vidOutputDir() {
  if (vidOpts.outMode === "custom") return vidOpts.outDir || "";
  return vidFiles.length ? vidDirOf(vidFiles[0]) : "";
}

function addVidFiles(files, totalBytes) {
  if (Array.isArray(files) && files.length) vidFiles = vidFiles.concat(files);
  vidTotalSize += Number(totalBytes) || 0;
  renderVidCount();
  loadFirstVideoInfo();
}

function clearVidFiles() {
  vidFiles = [];
  vidTotalSize = 0;
  vidInfo = null;
  vidKeyframes = [];
  vidKeyInterval = 0;
  pvFor = "";
  pvSeq++;                          // 作废还在进行的预览加载
  const v = $("#vid-pv");
  if (v) { try { v.pause(); v.removeAttribute("src"); v.load(); } catch (e) { /* 忽略 */ } }
  pvSetExternal(null);
  renderVidCount();
  const box = $("#vid-info");
  if (box) box.textContent = "";
  renderKfRail();          // 没有视频了，把关键帧轨道收起来
}

function renderVidCount() {
  const el = $("#vid-count");
  const btn = $("#vid-start");
  if (!el) return;
  if (!vidFiles.length) {
    el.textContent = "尚未选择视频";
    if (btn) btn.disabled = true;
    return;
  }
  el.textContent = `${vidFiles.length} 个视频` + (vidTotalSize ? ` · 合计 ${humanSize(vidTotalSize)}` : "");
  if (btn) btn.disabled = !!vidJob;
}

// 读首个视频的信息：时长、分辨率、编码，以及关键帧间隔（决定无损修剪的精度）
async function loadFirstVideoInfo() {
  const box = $("#vid-info");
  if (!box) return;
  if (!vidFiles.length) { box.textContent = ""; vidInfo = null; return; }
  box.textContent = "读取视频信息…";
  const r = await callApi("probe_video", vidFiles[0]);
  if (!r || !r.ok) {
    box.textContent = "读取视频信息失败";
    // 别留着上一个视频的关键帧，否则轨道会显示成别的片子的切点
    vidInfo = null;
    vidKeyframes = [];
    vidKeyInterval = 0;
    renderKfRail();
    return;
  }
  vidInfo = r.info;
  vidKeyframes = Array.isArray(r.kf) ? r.kf : [];
  vidKeyInterval = r.keyInterval || 0;
  const extra = vidFiles.length > 1 ? `（下面这些是第 1 个视频的：${escapeHtml(vidFiles[0].split(/[\\/]/).pop())}）` : "";
  box.innerHTML =
    `${vidInfo.width}×${vidInfo.height} · ${vidInfo.vcodec || "未知编码"}` +
    (vidInfo.fps ? ` · ${vidInfo.fps}fps` : "") +
    ` · 时长 ${vidFmtTime(vidInfo.duration)}` +
    (r.keyframes ? ` · 关键帧 ${r.keyframes} 个，间隔约 ${r.keyInterval} 秒` : "") +
    (vidInfo.acodec ? "" : " · 无音轨") +
    (extra ? `<br>${extra}` : "");
  // 终点默认填满全长，省得用户手输
  const endBox = $("#vid-end");
  if (endBox && !endBox.value.trim()) endBox.value = vidFmtTime(vidInfo.duration);
  updateVidTrimHint();
  pvFor = "";            // 换了片子，预览要重新准备
  setupPreview();
}

// 吸附到最近的关键帧（与主进程同一套规则：谁近选谁，误差最小）
function vidSnapNearest(kfs, t) {
  if (!kfs || !kfs.length) return t;
  let best = kfs[0], bestD = Math.abs(kfs[0] - t);
  for (const k of kfs) {
    const d = Math.abs(k - t);
    if (d < bestD) { best = k; bestD = d; }
  }
  return best;
}

function updateVidTrimHint() {
  const el = $("#vid-trim-hint");
  if (!el) return;
  if (!vidInfo) { el.textContent = ""; renderKfRail(); return; }
  const s = vidParseTime($("#vid-start").value);
  const e = vidParseTime($("#vid-end").value);
  if (isNaN(s) || isNaN(e) || e <= s) {
    el.textContent = "起止时间填好后这里会显示实际会剪出哪一段";
    renderKfRail();
    return;
  }

  // 跑之前就告诉用户起点会不会被吸附 —— 不然跑完才发现少剪/多剪了很恼火
  const snapped = vidSnapNearest(vidKeyframes, s);
  const moved = Math.abs(snapped - s) > 0.02;
  const realStart = Math.max(0, Math.min(snapped, e - 0.05));
  const realDur = e - realStart;

  el.textContent = moved
    ? `起点 ${vidFmtTime(s)} 不是关键帧，将自动对齐到最近的关键帧 ${vidFmtTime(realStart)}；` +
      `实际剪出 ${vidFmtTime(realStart)} → ${vidFmtTime(e)}（共 ${realDur.toFixed(2)} 秒）`
    : `将剪出 ${vidFmtTime(realStart)} → ${vidFmtTime(e)}（共 ${realDur.toFixed(2)} 秒），起点正好在关键帧上`;
  renderKfRail();
}

/* ---- 关键帧轨道 ----
   把整片的关键帧画成刻度，直接点着挑切点。以前只在信息行里写一句「间隔约 2.5 秒」，
   用户得自己心算 2.5 的倍数在哪 —— 这一步纯属让机器算的东西，不该丢给人。 */
function vidKfIndexOf(t) {
  if (!vidKeyframes.length) return -1;
  let best = 0;
  let bestD = Infinity;
  vidKeyframes.forEach((k, i) => {
    const d = Math.abs(k - t);
    if (d < bestD) { best = i; bestD = d; }
  });
  return best;
}

function renderKfRail() {
  const rail = $("#vid-kf-rail");
  const row = $("#vid-kf-row");
  const hint = $("#vid-kf-hint");
  const navRow = $("#vid-kf-nav-row");
  if (!rail || !row) return;

  const has = !!(vidInfo && vidInfo.duration > 0 && vidKeyframes.length > 1);
  row.hidden = !has;
  if (hint) hint.hidden = !has;
  if (navRow) navRow.hidden = !has;
  if (!has) return;

  const dur = vidInfo.duration;
  const pct = (t) => Math.max(0, Math.min(1, (Number(t) || 0) / dur)) * 100;

  // 刻度：宽度有限，关键帧密的时候按 3px 一根抽样，否则会糊成一条实心线
  const w = rail.clientWidth || 600;
  const maxTicks = Math.max(40, Math.floor(w / 3));
  const step = Math.ceil(vidKeyframes.length / maxTicks);
  const box = $("#vid-kf-ticks");
  if (box) {
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < vidKeyframes.length; i += step) {
      const d = document.createElement("div");
      d.className = "kf-tick" + (i === 0 ? " kf-tick-major" : "");
      d.style.left = pct(vidKeyframes[i]) + "%";
      frag.appendChild(d);
    }
    box.appendChild(frag);
  }

  // 游标与选中区间
  const s = vidParseTime($("#vid-start").value);
  const e = vidParseTime($("#vid-end").value);
  const sv = isNaN(s) ? 0 : s;
  const ev = isNaN(e) ? dur : e;
  const curS = $("#vid-kf-cur-start");
  const curE = $("#vid-kf-cur-end");
  const sel = $("#vid-kf-sel");
  if (curS) curS.style.left = pct(sv) + "%";
  if (curE) curE.style.left = pct(ev) + "%";
  if (sel) {
    sel.style.left = pct(sv) + "%";
    sel.style.width = Math.max(0, pct(ev) - pct(sv)) + "%";
  }

  if (hint) {
    hint.textContent =
      `轨道上每一根刻度就是一个关键帧（共 ${vidKeyframes.length} 个` +
      (vidKeyInterval ? `，平均间隔约 ${vidKeyInterval.toFixed(2)} 秒` : "") +
      `）。单击轨道把起点移到最近的关键帧，Shift+单击或右键设终点。`;
  }
  const pos = $("#vid-kf-pos");
  if (pos) {
    const ci = vidKfIndexOf(sv);
    pos.textContent = ci >= 0 ? `起点在第 ${ci + 1} / ${vidKeyframes.length} 个关键帧` : "";
  }
  updatePlayhead();      // 轨道重画后绿线位置要跟着重算
}

// 点在轨道上的哪个位置 → 换算成秒 → 吸附到最近的关键帧
function vidRailSeek(ev, asEnd) {
  const rail = $("#vid-kf-rail");
  if (!rail || !vidInfo) return;
  const r = rail.getBoundingClientRect();
  if (!r.width) return;
  const t = ((ev.clientX - r.left) / r.width) * vidInfo.duration;
  const snapped = vidSnapNearest(vidKeyframes, t);
  if (asEnd) {
    const s = vidParseTime($("#vid-start").value);
    const floor = isNaN(s) ? 0 : s + 0.05;
    $("#vid-end").value = vidFmtTime(Math.max(snapped, floor));
  } else {
    const e = vidParseTime($("#vid-end").value);
    const cap = isNaN(e) ? vidInfo.duration : e;
    $("#vid-start").value = vidFmtTime(cap > 0.05 ? Math.min(snapped, cap - 0.05) : 0);
  }
  updateVidTrimHint();
}

// 起点按关键帧逐格跳（轨道点点不准时用这个）
function vidStepKeyframe(dir) {
  if (!vidKeyframes.length || !vidInfo) return;
  const s = vidParseTime($("#vid-start").value);
  const idx = vidKfIndexOf(isNaN(s) ? 0 : s);
  const next = Math.max(0, Math.min(vidKeyframes.length - 1, idx + dir));
  const e = vidParseTime($("#vid-end").value);
  const cap = isNaN(e) ? vidInfo.duration : e;
  $("#vid-start").value = vidFmtTime(Math.min(vidKeyframes[next], Math.max(0, cap - 0.05)));
  updateVidTrimHint();
}

/* ============ 视频预览 ============
   拖进视频后能直接在应用里拖着看画面 —— 不然根本不知道该剪哪一段。
   麻烦在于原片常是 HEVC，而应用关了硬件加速、Chromium 又没有 HEVC 软解，
   <video> 放它是黑屏。所以交给主进程判断，必要时先转一份低画质代理。
   代理与原片时长一致，时间轴对齐，预览里停在第几秒就是源片第几秒。 */
let pvSeq = 0;        // 换视频就 +1，用来丢弃过期的代理结果
let pvFor = "";       // 当前预览对应哪个文件（同一个文件不重复准备）
let pvDragging = false;

function pvFmt(s) { return vidFmtTime(isFinite(s) ? s : 0); }

function pvSetHint(text) {
  const hint = $("#vid-pv-hint");
  if (hint) hint.textContent = text;
}

let pbCaps = null;    // { hwDisabled, appPreview, external: {name,path}|null }

async function loadPlaybackCaps(force) {
  if (pbCaps && !force) return pbCaps;
  pbCaps = await callApi("get_playback_caps");
  return pbCaps;
}

// 预览放不出来时的退路：丢给外部播放器。
// 优先 PotPlayer / VLC / MPV（自带解码器）；都没有才落到系统默认 ——
// 而系统默认在缺 HEVC 组件的机器上同样放不了，所以按钮文案要说清用的是哪个（用户明确要求）。
async function pvSetExternal(file) {
  const btn = $("#vid-pv-external");
  if (!btn) return;
  btn.hidden = !file;
  if (!file) { btn.onclick = null; return; }

  const caps = await loadPlaybackCaps();
  const name = caps && caps.external ? caps.external.name : "";
  btn.textContent = name ? ("用 " + name + " 打开") : "用系统播放器打开";
  btn.onclick = async () => {
    const r = await callApi("open_in_player", file);
    if (!r || !r.ok) {
      addLogLineLocal("打开播放器失败：" + ((r && r.msg) || "未知错误"), "err", "video");
      return;
    }
    addLogLineLocal(r.player ? ("已用 " + r.player + " 打开原片（它自带解码器）") : "已交给系统默认播放器打开", "dim", "video");
  };
}

async function setupPreview() {
  const v = $("#vid-pv");
  const card = $("#vid-trim-card");     // 预览长在修剪卡里，跟着它一起显隐
  if (!v || !card) return;

  if (vidOpts.mode !== "trim" || !vidFiles.length || !vidInfo) {
    pvSetExternal(null);
    updatePlayhead();
    return;
  }

  const file = vidFiles[0];
  // readyState >= 1 才算"真的准备好了"：否则会把上一轮加载失败的源当成可用
  if (pvFor === file && v.src && v.readyState >= 1) {
    updatePlayhead();
    return;
  }

  pvSeq++;
  const seq = pvSeq;
  try { v.pause(); } catch (e) { /* 还没 src */ }
  try { v.removeAttribute("src"); v.load(); } catch (e) { /* 忽略 */ }
  pvSetHint("正在准备预览…");
  pvSetExternal(null);
  loadPlaybackCaps();     // 并行查一下本机有没有自带解码器的播放器，失败提示里要说它

  // 这里不做任何转制：直接把原片地址交给 <video>。
  // 能不能播取决于编码 + 硬件加速状态（HEVC 在硬件加速开着时能直接播），
  // 播不出来就退到"用系统播放器打开"这条兜底，一点磁盘和时间都不花。
  const r = await callApi("get_video_url", file);
  if (seq !== pvSeq) return;

  const fail = (msg) => {
    pvSetHint(msg);
    pvSetExternal(file);
    updatePlayhead();
  };
  if (!r || !r.ok) {
    fail("读不到这个视频：" + ((r && r.msg) || "未知错误"));
    return;
  }

  let settled = false;
  let timer = 0;
  const cleanup = () => {
    v.removeEventListener("loadedmetadata", ok);
    v.removeEventListener("error", bad);
    clearTimeout(timer);
  };
  const ok = () => {
    if (settled) return;
    settled = true;
    cleanup();
    pvFor = file;
    pvSetHint("拖动进度条看画面，停下来点「设为起点 / 设为终点」。下面轨道上的绿线就是当前播放位置。");
    updatePlayhead();
  };
  const bad = async () => {
    if (settled) return;
    settled = true;
    cleanup();
    // 说清"为什么放不了"和"该怎么办" —— 只写"放不出来"用户会以为是软件坏了
    const caps = await loadPlaybackCaps();
    const ext = caps && caps.external ? caps.external.name : "";
    let tip = "这个视频在应用里放不出来。常见原因是这台电脑没装 HEVC 解码组件" +
      "（Windows 默认不带，很多人装了独显也一样），或者显卡比较老不支持这种编码。" +
      "不影响修剪，只是看不到画面。";
    tip += ext
      ? ("点右边的「用 " + ext + " 打开」看画面（它自带解码器，不依赖系统组件），再回来填时间或用下面的关键帧轨道定切点。")
      : "点右边按钮用系统播放器打开看看；要是它也放不了，装一个 VLC 或 PotPlayer 就能看（这两个自带解码器）。";
    fail(tip);
  };
  v.addEventListener("loadedmetadata", ok);
  v.addEventListener("error", bad);
  timer = setTimeout(bad, 5000);      // 5 秒还出不来元数据就当它放不了
  v.src = r.url;
  v.load();
}

function bindPreview() {
  const v = $("#vid-pv");
  if (!v) return;
  const range = $("#vid-pv-range");
  const playBtn = $("#vid-pv-play");

  if (playBtn) {
    playBtn.onclick = () => {
      if (v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      else v.pause();
    };
  }
  // 这里一律用 addEventListener：loadPreviewSrc 也要挂 loadedmetadata/error，
  // 用 onXxx = 赋值会互相覆盖（踩过）
  v.addEventListener("play", () => { if (playBtn) playBtn.textContent = "⏸ 暂停"; });
  v.addEventListener("pause", () => { if (playBtn) playBtn.textContent = "▶ 播放"; });

  const sync = () => {
    const t = isFinite(v.currentTime) ? v.currentTime : 0;
    const d = isFinite(v.duration) && v.duration > 0 ? v.duration : ((vidInfo && vidInfo.duration) || 0);
    const timeEl = $("#vid-pv-time");
    if (timeEl) timeEl.textContent = pvFmt(t) + " / " + pvFmt(d);
    // 手指还在拖的时候别回写 range，否则会跟拖动打架
    if (range && !pvDragging && d > 0) range.value = String(Math.round((t / d) * 1000));
    updatePlayhead();
  };
  v.addEventListener("timeupdate", sync);
  v.addEventListener("loadedmetadata", sync);
  v.addEventListener("seeked", sync);

  if (range) {
    range.oninput = () => {
      const d = v.duration;
      if (!isFinite(d) || d <= 0) return;
      pvDragging = true;
      v.currentTime = (Number(range.value) / 1000) * d;
      sync();
    };
    range.onchange = () => { pvDragging = false; };
  }

  const toStart = $("#vid-pv-to-start");
  if (toStart) toStart.onclick = () => pvSeekTo($("#vid-start").value);
  const toEnd = $("#vid-pv-to-end");
  if (toEnd) toEnd.onclick = () => pvSeekTo($("#vid-end").value);
  const setStart = $("#vid-pv-set-start");
  if (setStart) setStart.onclick = () => pvSetCut("start");
  const setEnd = $("#vid-pv-set-end");
  if (setEnd) setEnd.onclick = () => pvSetCut("end");
}

// 「跳到起点 / 跳到终点」：把画面挪到切点上，用来核对这一刀切得对不对
function pvSeekTo(value) {
  const v = $("#vid-pv");
  if (!v || !v.src) return;
  let t = vidParseTime(value);
  if (isNaN(t)) t = 0;
  const d = isFinite(v.duration) ? v.duration : 0;
  v.currentTime = Math.max(0, Math.min(t, d > 0.05 ? d - 0.05 : t));
  v.pause();
}

// 把"现在看到的这一帧"设成起点/终点。
// 切点必须落在关键帧上才能无损，所以吸附到最近的关键帧，并把真实落点说清楚。
function pvSetCut(which) {
  const v = $("#vid-pv");
  if (!v || !vidInfo) return;
  const t = isFinite(v.currentTime) ? v.currentTime : 0;
  const snapped = vidSnapNearest(vidKeyframes, t);
  const moved = Math.abs(snapped - t) > 0.02;
  let real;
  if (which === "start") {
    const e = vidParseTime($("#vid-end").value);
    const cap = isNaN(e) ? vidInfo.duration : e;
    real = Math.max(0, Math.min(snapped, cap > 0.05 ? cap - 0.05 : 0));
    $("#vid-start").value = vidFmtTime(real);
  } else {
    const s = vidParseTime($("#vid-start").value);
    const floor = isNaN(s) ? 0 : s + 0.05;
    real = Math.max(snapped, floor);
    $("#vid-end").value = vidFmtTime(real);
  }
  updateVidTrimHint();
  addLogLineLocal(
    `>>> 已设为${which === "start" ? "起点" : "终点"} ${vidFmtTime(real)}` +
    (moved ? `（停在第 ${t.toFixed(2)} 秒，已对齐到最近的关键帧）` : "（正好在关键帧上）"),
    "dim", "video");
}

// 关键帧轨道上的绿色播放头：让"我看到哪"和"关键帧在哪"同框
function updatePlayhead() {
  const head = $("#vid-kf-head");
  if (!head) return;
  const v = $("#vid-pv");
  const dur = vidInfo ? vidInfo.duration : 0;
  // offsetParent 为 null 说明元素（或祖先）当前不显示 —— 比翻 hidden 更省心
  const on = !!(v && v.src && dur > 0 && v.offsetParent !== null);
  head.hidden = !on;
  if (!on) return;
  const t = isFinite(v.currentTime) ? v.currentTime : 0;
  head.style.left = Math.max(0, Math.min(1, t / dur)) * 100 + "%";
}

function appendVidResult(d) {
  const card = $("#vid-result-card");
  if (card) card.hidden = false;
  const box = $("#vid-result-list");
  if (!box) return;

  const before = d.before || 0;
  const after = d.after || 0;
  const saved = before > 0 ? Math.round((1 - after / before) * 100) : 0;

  let sizeText, savedText, cls;
  if (!d.ok) {
    cls = "error"; sizeText = "失败"; savedText = "失败";
  } else if (d.grew) {
    // 压完反而更大 —— 必须显眼，否则用户以为工具坏了
    cls = "skip";
    sizeText = `${humanSize(before)} → ${humanSize(after)}`;
    savedText = `+${Math.abs(saved)}%`;
  } else {
    cls = "done";
    sizeText = `${humanSize(before)} → ${humanSize(after)}`;
    savedText = "-" + saved + "%";
  }

  // 无损修剪额外把实际剪出的区间单独放一列 —— 起点可能被吸附，必须让人一眼看见
  let range = "";
  let tip = d.msg || d.outPath || d.file || "";
  if (d.trimInfo) {
    const t = d.trimInfo;
    const snapped = Math.abs(t.start - t.wantStart) > 0.02;
    range = `${vidFmtTime(t.start)} → ${vidFmtTime(t.end)}`;
    tip = snapped
      ? `你填的起点 ${vidFmtTime(t.wantStart)} 不是关键帧，已对齐到最近的 ${vidFmtTime(t.start)}`
      : `起点正好在关键帧上`;
  }

  const row = document.createElement("div");
  row.className = "img-row " + cls;
  row.innerHTML =
    '<span class="img-name" title="' + escapeAttr(tip) + '">' + escapeHtml(d.name) + "</span>" +
    (range ? '<span class="res-range" title="' + escapeAttr(tip) + '">' + escapeHtml(range) + "</span>" : "") +
    '<span class="img-size">' + escapeHtml(sizeText) + "</span>" +
    '<span class="img-saved">' + escapeHtml(savedText) + "</span>";
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

function updateVidSummary() {
  const sum = $("#vid-summary");
  if (!sum) return;
  const s = vidStats;
  const total = s.ok + s.err;
  if (!total) { sum.textContent = ""; return; }
  let txt = `共 ${total} 个 · 成功 ${s.ok}`;
  if (s.err) txt += ` · 失败 ${s.err}`;
  if (s.grew) txt += ` · ${s.grew} 个反而变大`;
  if (s.before > 0) {
    txt += ` · ${humanSize(s.before)} → ${humanSize(s.after)}`;
    txt += `（省 ${Math.round((1 - s.after / s.before) * 100)}%）`;
  }
  sum.textContent = txt;
}

function updateVidProgress(detail, percent) {
  const wrap = $("#vid-progress-wrap");
  const fill = $("#vid-progress-fill");
  const pct = $("#vid-progress-percent");
  const det = $("#vid-progress-detail");
  if (!wrap || !fill || !pct || !det) return;
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  wrap.hidden = false;
  fill.style.width = p + "%";
  pct.textContent = Math.round(p) + "%";
  det.textContent = detail || "";
}

function setVidBusy(on) {
  vidJob = on ? (vidJob || { id: "", total: 0 }) : null;
  const start = $("#vid-btn-start");
  const stop = $("#vid-stop");
  if (start) start.disabled = !!on || !vidFiles.length;
  if (stop) stop.disabled = !on;
}

function updateVidModeUI() {
  const isTrim = vidOpts.mode === "trim";
  const t = $("#vid-trim-card");
  const c = $("#vid-compress-card");
  if (t) t.hidden = !isTrim;
  if (c) c.hidden = isTrim;
  const hint = $("#vid-mode-hint");
  if (hint) {
    hint.textContent = isTrim
      ? "无损修剪：只搬数据、不重新编码，画质一点不变，几秒就能跑完。"
      : "压缩：重新编码，画质基本不变但体积明显变小；慢一些，取决于编码器和片子长度。";
  }
  // 修剪卡片藏起来时轨道宽度是 0，切回来要按新宽度重画刻度
  if (isTrim) renderKfRail();

  // 预览现在长在修剪卡里，跟着卡片一起显隐；切走时暂停，免得在后台一直播
  const v = $("#vid-pv");
  if (!isTrim && v) { try { v.pause(); } catch (e) { /* 忽略 */ } }
  updatePlayhead();
  if (isTrim) setupPreview();
}

function renderVidQualityHint() {
  const el = $("#vid-quality-hint");
  if (!el) return;
  const q = { 高: "约省 40%，几乎看不出差别", 中: "约省 60%，日常够用", 低: "约省 75%，适合上传或存档" };
  el.textContent = (q[vidOpts.quality] || "") + "（实测值，实际取决于你的片源）";
}

function initVideoPage() {
  renderRadios("vid-mode-opts", [
    { value: "trim", label: "无损修剪" },
    { value: "compress", label: "压缩" },
  ], vidOpts.mode, (v) => { vidOpts.mode = v; saveVidOpts(); updateVidModeUI(); });

  renderRadios("vid-quality-opts", [
    { value: "高", label: "高（画质优先）" },
    { value: "中", label: "中（推荐）" },
    { value: "低", label: "低（体积优先）" },
  ], vidOpts.quality, (v) => { vidOpts.quality = v; saveVidOpts(); renderVidQualityHint(); });

  renderVidEncoderOptions();

  renderRadios("vid-height-opts", [
    { value: 0, label: "不缩放" },
    { value: 2160, label: "2160p" },
    { value: 1440, label: "1440p" },
    { value: 1080, label: "1080p" },
    { value: 720, label: "720p" },
  ], vidOpts.maxHeight, (v) => { vidOpts.maxHeight = v; saveVidOpts(); });

  renderRadios("vid-audio-opts", [
    { value: "copy", label: "原样复制" },
    { value: "aac", label: "转 AAC 128k" },
  ], vidOpts.audio, (v) => { vidOpts.audio = v; saveVidOpts(); });

  renderRadios("vid-out-opts", [
    { value: "same", label: "和源视频放一起" },
    { value: "custom", label: "指定文件夹" },
  ], vidOpts.outMode, (v) => {
    vidOpts.outMode = v; saveVidOpts();
    const row = $("#vid-outdir-row");
    if (row) row.hidden = v !== "custom";
  });

  const row = $("#vid-outdir-row");
  if (row) row.hidden = vidOpts.outMode !== "custom";
  if (vidOpts.outDir) $("#vid-outdir").value = vidOpts.outDir;

  updateVidModeUI();
  renderVidQualityHint();
  renderVidCount();
  updateVidTrimHint();
  bindPreview();
}

// 硬件编码器不一定可用（没 N 卡 / 驱动不对），拿到结果后重建一次选项
async function renderVidEncoderOptions() {
  vidCaps = await callApi("get_video_caps");
  const list = (vidCaps && vidCaps.encoders) || [
    { key: "hevc_nv", label: "HEVC 硬件加速 (NVENC)", hw: true, usable: true },
    { key: "hevc_sw", label: "HEVC 软件 (x265，慢但更省)", hw: false, usable: true },
    { key: "h264_nv", label: "H.264 硬件加速 (NVENC)", hw: true, usable: true },
    { key: "h264_sw", label: "H.264 软件 (x264)", hw: false, usable: true },
    { key: "av1_nv", label: "AV1 硬件加速 (NVENC)", hw: true, usable: true },
  ];
  const usable = list.filter((e) => e.usable);
  // 原来选的那个不可用就换掉
  if (!usable.some((e) => e.key === vidOpts.encoder) && usable.length) {
    vidOpts.encoder = usable[0].key;
  }
  renderRadios("vid-encoder-opts", usable.map((e) => ({ value: e.key, label: e.label })),
    vidOpts.encoder, (v) => { vidOpts.encoder = v; saveVidOpts(); });

  const info = $("#vid-info");
  if (vidCaps && vidCaps.ffmpeg === false && info) {
    info.textContent = "未找到内置 ffmpeg（见「环境检测」页），无法处理视频";
  }
}

function bindVideoEvents() {
  const pickFiles = $("#vid-pick-files");
  const pickDir = $("#vid-pick-dir");
  const clearBtn = $("#vid-clear");

  if (pickFiles) {
    pickFiles.onclick = async () => {
      const r = await callApi("pick_videos");
      if (!r || !r.ok || !r.files.length) return;
      addVidFiles(r.files, r.totalBytes);
      addLogLineLocal(`已加入 ${r.files.length} 个视频`, "dim", "video");
    };
  }
  if (pickDir) {
    pickDir.onclick = async () => {
      const r = await callApi("collect_videos", true);
      if (!r || !r.ok) return;
      if (!r.files.length) { alert("这个文件夹里没找到视频"); return; }
      addVidFiles(r.files, r.totalBytes);
      addLogLineLocal(`从「${r.dir}」收集到 ${r.files.length} 个视频`, "dim", "video");
    };
  }
  if (clearBtn) clearBtn.onclick = () => clearVidFiles();

  // 拖拽：复用 preload 里的路径回调，只收视频
  if (window.api && window.api.on_dropped_files) {
    window.api.on_dropped_files(async (paths) => {
      const r = await callApi("expand_video_paths", paths);
      if (!r || !r.files || !r.files.length) {
        addLogLineLocal("拖进来的内容里没有可处理的视频", "warn", "video");
        return;
      }
      addVidFiles(r.files, r.totalBytes);
      addLogLineLocal(`拖入 ${r.files.length} 个视频`, "dim", "video");
    });
  }

  // 起止时间改动 → 刷新提示
  ["#vid-start", "#vid-end"].forEach((sel) => {
    const box = $(sel);
    if (box) box.addEventListener("input", updateVidTrimHint);
  });

  // 关键帧轨道：单击设起点，Shift+单击 / 右键设终点
  const rail = $("#vid-kf-rail");
  if (rail) {
    rail.onclick = (ev) => vidRailSeek(ev, ev.shiftKey);
    rail.oncontextmenu = (ev) => { ev.preventDefault(); vidRailSeek(ev, true); };
  }
  const kfPrev = $("#vid-kf-prev");
  if (kfPrev) kfPrev.onclick = () => vidStepKeyframe(-1);
  const kfNext = $("#vid-kf-next");
  if (kfNext) kfNext.onclick = () => vidStepKeyframe(1);

  // 窗口宽度变了，刻度的抽样密度要重算（轨道是 flex:1，宽度不固定）
  let kfResizeT = 0;
  window.addEventListener("resize", () => {
    clearTimeout(kfResizeT);
    kfResizeT = setTimeout(renderKfRail, 150);
  });

  // 快捷：剪掉开头 / 剪掉结尾（在当前值上累积，点几次剪几段）
  const cutHead = $("#vid-cut-head");
  if (cutHead) {
    cutHead.onclick = () => {
      const s = vidParseTime($("#vid-start").value);
      const e = vidParseTime($("#vid-end").value);
      const ns = (isNaN(s) ? 0 : s) + 3;
      if (!isNaN(e) && ns >= e - 0.1) { alert("开头已经剪到超过结束时间了"); return; }
      $("#vid-start").value = vidFmtTime(ns);
      updateVidTrimHint();
    };
  }
  const cutTail = $("#vid-cut-tail");
  if (cutTail) {
    cutTail.onclick = () => {
      const s = vidParseTime($("#vid-start").value);
      let e = vidParseTime($("#vid-end").value);
      if (isNaN(e) && vidInfo) e = vidInfo.duration;
      if (isNaN(e)) { alert("请先选择视频"); return; }
      const ne = Math.max(0, e - 3);
      if (!isNaN(s) && ne <= s + 0.1) { alert("结尾已经剪到超过开始时间了"); return; }
      $("#vid-end").value = vidFmtTime(ne);
      updateVidTrimHint();
    };
  }
  const full = $("#vid-full");
  if (full) {
    full.onclick = () => {
      $("#vid-start").value = vidFmtTime(0);
      $("#vid-end").value = vidInfo ? vidFmtTime(vidInfo.duration) : "";
      updateVidTrimHint();
    };
  }

  const pickOut = $("#vid-pick-outdir");
  if (pickOut) {
    pickOut.onclick = async () => {
      const p = await callApi("pick_folder", "选择输出文件夹");
      if (!p) return;
      vidOpts.outDir = p;
      $("#vid-outdir").value = p;
      saveVidOpts();
    };
  }

  const clearResult = $("#vid-clear-result");
  if (clearResult) {
    clearResult.onclick = () => {
      const card = $("#vid-result-card");
      const list = $("#vid-result-list");
      if (list) list.innerHTML = "";
      if (card) card.hidden = true;
      const sum = $("#vid-summary");
      if (sum) sum.textContent = "";
      vidStats = { ok: 0, err: 0, grew: 0, before: 0, after: 0 };
    };
  }

  // 「开始处理」按钮。注意 id 是 vid-btn-start，跟上面那个起点输入框 vid-start 不是一回事 ——
  // 两处若混用，就会出现「点输入框开始下载、点按钮没反应」的诡异现象（踩过）。
  const start = $("#vid-btn-start");
  if (start) {
    start.onclick = async () => {
      if (!vidFiles.length) { alert("请先选择视频"); return; }
      const params = {
        files: vidFiles,
        mode: vidOpts.mode,
        quality: vidOpts.quality,
        encoder: vidOpts.encoder,
        maxHeight: vidOpts.maxHeight,
        audio: vidOpts.audio,
        container: vidOpts.container,
        outMode: vidOpts.outMode,
        outDir: vidOpts.outDir,
        start: $("#vid-start").value.trim(),
        end: $("#vid-end").value.trim(),
      };
      if (vidOpts.mode === "trim") {
        const s = vidParseTime(params.start), e = vidParseTime(params.end);
        if (isNaN(s) || isNaN(e)) { alert("请把起止时间填成 0:00:00.000 这样的格式（也可以直接填秒数）"); return; }
        if (e <= s) { alert("结束时间必须晚于开始时间"); return; }
      }
      saveVidOpts();
      setVidBusy(true);
      updateVidProgress("准备中…", 0);
      const r = await callApi("start_video_job", params);
      if (!r || !r.ok) {
        setVidBusy(false);
        $("#vid-status").textContent = "就绪";
        alert("启动失败：" + ((r && r.msg) || "未知错误"));
        return;
      }
      vidJob = { id: r.jobId, total: r.total };
      $("#vid-status").textContent = `处理中 0 / ${r.total}`;
    };
  }

  const stop = $("#vid-stop");
  if (stop) {
    stop.onclick = async () => {
      if (!vidJob) return;
      await callApi("stop_video_job", vidJob.id);
    };
  }

  const openOut = $("#vid-open-out");
  if (openOut) {
    openOut.onclick = async () => {
      const d = vidOutputDir();
      if (!d) return;
      const r = await callApi("open_folder", d);
      if (r && !r.ok) alert("打开失败：" + (r.msg || ""));
    };
  }
}

function onVideoProgress(d) {
  if (!d) return;
  updateVidProgress(d.detail, d.percent);
}

function onVideoItem(d) {
  if (!d) return;
  if (d.ok) {
    vidStats.ok++;
    vidStats.before += d.before || 0;
    vidStats.after += d.after || 0;
    if (d.grew) vidStats.grew++;
  } else {
    vidStats.err++;
  }
  appendVidResult(d);
  updateVidSummary();
  const st = $("#vid-status");
  if (st) st.textContent = `处理中 ${d.done || 0} / ${d.total || 0}`;
}

function onVideoDone(d) {
  setVidBusy(false);
  if (d && d.total) updateVidProgress("", 100);
  const st = $("#vid-status");
  if (st) {
    if (!d) st.textContent = "就绪";
    else if (d.cancelled) st.textContent = "已中止";
    else st.textContent = d.errCount ? `${d.errCount} 个失败` : "全部完成";
  }
  const openOut = $("#vid-open-out");
  if (openOut) openOut.disabled = !vidOutputDir();
  vidJob = null;
  const card = $("#vid-result-card");
  if (card && !card.hidden) {
    try { card.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {}
  }
}

/* ============ 属性弹窗渲染 ============ */
// 读取文件属性并弹出（底栏按钮与队列行的「属性」按钮共用）
async function probeAndShow(file, btn) {
  if (!file) return;
  const old = btn && btn.textContent;
  if (btn) { btn.textContent = "读取中…"; btn.disabled = true; }
  const r = await callApi("probe_file", file);
  if (btn) { btn.textContent = old; btn.disabled = false; }
  if (!r || !r.ok) {
    alert("读取属性失败：" + ((r && r.msg) || "未知错误"));
    return;
  }
  renderAttr(r.info);
  $("#attr-modal").hidden = false;
}

function renderAttr(info) {
  const esc = (s) => String(s == null || s === "" ? "-" : s)
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rows = (list) => list
    .map(([k, v]) => '<div class="attr-row"><span class="attr-key">' + esc(k) +
      '</span><span class="attr-val">' + esc(v) + "</span></div>")
    .join("");

  $("#attr-body").innerHTML =
    '<div class="attr-sec">文件</div>' +
    rows([
      ["文件名", info.fileName],
      ["大小", info.size],
      ["时长", info.duration],
      ["容器", info.container],
      ["总码率", info.bitrate],
      ["完整路径", info.filePath],
    ]) +
    '<div class="attr-sec">视频</div>' +
    rows([
      ["编码", info.videoCodec],
      ["分辨率", info.resolution],
      ["帧率", info.fps],
      ["码率", info.videoBitrate],
    ]) +
    '<div class="attr-sec">音频</div>' +
    rows([
      ["编码", info.audioCodec],
      ["声道", info.channels],
      ["采样率", info.sampleRate],
      ["码率", info.audioBitrate],
    ]);
}

/* ============ 单选组渲染 ============ */
function renderRadios(containerId, options, current, onSelect) {
  const c = $("#" + containerId);
  c.innerHTML = "";
  options.forEach((opt) => {
    const el = document.createElement("div");
    el.className = "radio" + (opt.value === current ? " checked" : "");
    el.innerHTML = '<span class="dot"></span><span>' + opt.label + "</span>";
    el.onclick = () => {
      $$("#" + containerId + " .radio").forEach((r) => r.classList.remove("checked"));
      el.classList.add("checked");
      onSelect(opt.value);
    };
    c.appendChild(el);
  });
}

/* ============ 网络代理提示（设置页） ============
   「跟随系统」到底走哪个端口，直接显示出来 —— 否则用户只知道选了"跟随系统"，
   却不知道实际有没有走代理、走的是哪个端口。 */
async function refreshProxyHint() {
  const hint = $("#proxy-hint");
  const row = $("#proxy-addr-row");
  const addr = $("#proxy-addr");
  if (!hint) return;

  if (proxyMode === "manual") {
    if (row) row.hidden = false;
    if (addr) addr.disabled = false;
    hint.textContent = "格式：主机:端口，如 127.0.0.1:7897";
    return;
  }

  if (proxyMode === "direct") {
    if (row) row.hidden = true;
    hint.textContent = "不走代理，直连下载";
    return;
  }

  // system：把手填框置灰（此时手填不生效，避免误解），并显示实际解析结果
  if (row) row.hidden = false;
  if (addr) addr.disabled = true;
  hint.textContent = "读取中…";
  const r = await callApi("get_system_proxy");
  hint.textContent = r && r.ok && r.url
    ? "当前走 " + r.url
    : ((r && r.msg) || "直连（系统未设置代理）");
}

/* ============ 日志 ============ */
// 每个页面有自己的日志框。带 source 的只进对应页面；
// 不带 source 的全局提示（极少）所有页面各写一份，保证在哪个页面都能看到。
const LOG_SOURCES = ["yt", "social", "img", "video"];

function appendLog(text, cls, src) {
  (src ? [src] : LOG_SOURCES).forEach((s) => {
    const log = el("log", s);
    if (!log) return;
    const line = document.createElement("div");
    line.className = "line" + (cls ? " " + cls : "");
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  });
}
function clearLog(src) { const l = el("log", src); if (l) l.innerHTML = ""; }
// 本地提示（不来自主进程）：如"已忽略 2 个重复链接"
function addLogLineLocal(text, cls, src) { appendLog(text, cls, src); }

/* ============ 批量链接解析 ============ */
// 一行一个链接，同时兼容空格/逗号/分号分隔，以及常见的分享文本（带前后文字）
// source: "yt" | "social"。差别只有一处 —— 「贴一个裸 ID 就当 YouTube 视频」这条规则
// 只在油管页成立，社媒页里一段纯文本不该被拼成 YouTube 链接。
function parseUrls(raw, source) {
  const s = String(raw || "");
  // 先按换行、逗号、分号、空白切分
  const parts = s.split(/[\r\n,;]+|\s{2,}/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    // 从一段文字里抠出 URL（应对"看看这个 https://youtu.be/xxx 好好看"这类粘贴）
    const m = p.match(/https?:\/\/[^\s"'<>）)]+/g);
    if (m) out.push(...m.map(cleanUrl));
    else if (source !== "social" && /^[\w-]{6,}$/.test(p) && p.length >= 8) {
      // 纯视频 ID（用户有时只贴 ID）—— 仅油管页适用
      out.push("https://www.youtube.com/watch?v=" + p);
    }
  }
  return out;
}

// 去掉 URL 尾部的常见多余字符（中文标点、括号等）
function cleanUrl(u) {
  return String(u).replace(/[.,;:!?、，。；：！？)\]}】》」'"]+$/, "");
}

// 去重：同一视频的不同写法（watch?v= / youtu.be / 带播放列表参数）视为同一个
function dedupeUrls(list) {
  const seen = new Map();
  const urls = [];
  let dupCount = 0;
  for (const u of list) {
    const k = videoKey(u);
    if (seen.has(k)) { dupCount++; continue; }
    seen.set(k, true);
    urls.push(u);
  }
  return { urls, dupCount };
}

function videoKey(u) {
  const s = String(u);
  let m = s.match(/[?&]v=([\w-]{6,})/);
  if (m) return "yt:" + m[1];
  m = s.match(/youtu\.be\/([\w-]{6,})/);
  if (m) return "yt:" + m[1];
  m = s.match(/[?&]list=([\w-]{6,})/);
  if (m) return "list:" + m[1];
  return "url:" + s.replace(/[?&](t|si|feature|pp)=[^&]*/g, "");
}

// 输入框下方的实时提示：解析出几个链接
function updateUrlHint(source) {
  const conf = SOURCE_CONF[source || "yt"];
  if (!conf) return;
  const el = $(conf.hint);
  if (!el) return;
  const list = parseUrls($(conf.urlBox).value, source || "yt");
  const { urls, dupCount } = dedupeUrls(list);
  if (!urls.length) {
    el.textContent = conf.empty;
    return;
  }
  let msg = `识别到 ${urls.length} 个链接`;
  if (dupCount > 0) msg += `（已自动去除 ${dupCount} 个重复）`;
  el.textContent = msg;
}

/* ============ 分类目录 ============ */
// 油管与社媒各有一套分类，互不影响：dirs[src] + selectedDir[src]。
const dirs = { yt: [], social: [] };
const selectedDir = { yt: 0, social: 0 };

function currentDir(src) {
  const list = dirs[src] || [];
  const i = selectedDir[src] || 0;
  return list[i] || null;
}

// 渲染某个页面自己的那份分类列表（容器带 data-src）
function renderDirs(src) {
  const targets = src ? [src] : SOURCES;
  targets.forEach((s) => {
    const box = document.querySelector('.dir-list[data-src="' + s + '"]');
    if (!box) return;
    const list = dirs[s] || [];
    box.innerHTML = "";
    list.forEach((d, i) => {
      const row = document.createElement("div");
      row.className = "row dir-row";
      row.innerHTML =
        '<div class="radio' + (i === selectedDir[s] ? " checked" : "") + '" style="flex:none">' +
          '<span class="dot"></span></div>' +
        '<input class="input" value="' + escapeAttr(d.name || "") + '" data-i="' + i + '" data-f="name">' +
        '<input class="input grow readonly" value="' + escapeAttr(d.path || "") + '" data-f="path" readonly placeholder="未选择文件夹">' +
        '<button class="btn ghost" data-i="' + i + '" data-f="browse">浏览</button>' +
        '<button class="btn ghost" data-i="' + i + '" data-f="del">✕</button>';
      box.appendChild(row);
    });

    // 单选（事件限定在当前容器内，避免跨容器串扰）
    box.querySelectorAll(".radio").forEach((r, i) => {
      r.onclick = () => { selectedDir[s] = i; renderDirs(s); };
    });
    // 名称编辑
    box.querySelectorAll('input[data-f="name"]').forEach((inp) => {
      inp.onchange = () => {
        dirs[s][+inp.dataset.i].name = inp.value;
        saveDirs();
      };
    });
    // 浏览
    box.querySelectorAll('button[data-f="browse"]').forEach((b) => {
      b.onclick = async () => {
        const i = +b.dataset.i;
        const p = await callApi("pick_folder");
        if (p) { dirs[s][i].path = p; saveDirs(); renderDirs(s); }
      };
    });
    // 删除
    box.querySelectorAll('button[data-f="del"]').forEach((b) => {
      b.onclick = () => {
        dirs[s].splice(+b.dataset.i, 1);
        if (selectedDir[s] >= dirs[s].length) selectedDir[s] = Math.max(0, dirs[s].length - 1);
        saveDirs(); renderDirs(s);
      };
    });
  });
}

function saveDirs() { callApi("save_dirs", dirs); }

/* ============ 环境检测 ============ */
function renderComponents(comps) {
  const box = $("#comp-list");
  box.innerHTML = "";
  comps.forEach((c) => {
    const row = document.createElement("div");
    row.className = "comp-row";
    row.innerHTML =
      '<div class="comp-head">' +
        '<span class="comp-name">' + c.name + "</span>" +
        '<span class="comp-status ' + (c.ok ? "ok" : "miss") + '">' + c.status + "</span>" +
      "</div>" +
      '<div class="comp-desc">' + c.desc + "</div>";
    box.appendChild(row);
  });
}

/* 环境检测：视频播放能力。
   回答两个问题 —— 应用内能不能拖看画面、放不出来时外部兜底会找谁。
   这两件事跟"下载/修剪能不能用"无关，单独列出来免得用户以为软件坏了。 */
async function renderPlaybackCaps() {
  const box = $("#playback-list");
  if (!box) return;
  const caps = await loadPlaybackCaps(true);
  if (!caps) { box.textContent = "检测失败"; return; }
  const rows = [
    {
      name: "应用内预览（拖进度条看画面）",
      ok: !!caps.appPreview,
      status: caps.appPreview ? "可用" : "受限",
      desc: caps.appPreview
        ? "常见编码（HEVC / H.264）由显卡硬解，选中视频就能直接拖着看画面、定切点。"
        : "当前是兼容模式（上次启动没跑稳，已自动关闭硬件加速），HEVC 这类需要显卡解码的片子可能放不出来；" +
          "改用下面的外部播放器看即可，不影响修剪。",
    },
    {
      name: "外部播放器兜底",
      ok: !!caps.external,
      status: caps.external ? caps.external.name : "系统默认",
      desc: caps.external
        ? ("已检测到 " + caps.external.name + "（自带解码器，不依赖系统组件），应用内放不出来的视频会交给它打开。")
        : ("没检测到 PotPlayer / VLC / MPV，放不出来时会交给系统默认播放器。注意 Windows 自带的播放器同样依赖" +
           "系统的 HEVC 解码组件 —— 如果它也放不了，装一个 VLC 或 PotPlayer 就能看（它们自带解码器）。" +
           (caps.regBlocked ? "（注：本次注册表查询被系统安全策略拦截，检测结果可能不全）" : "")),
    },
  ];
  box.innerHTML = rows.map((c) => (
    '<div class="comp-row">' +
      '<div class="comp-head">' +
        '<span class="comp-name">' + c.name + "</span>" +
        '<span class="comp-status ' + (c.ok ? "ok" : "busy") + '">' + c.status + "</span>" +
      "</div>" +
      '<div class="comp-desc">' + c.desc + "</div>" +
    "</div>"
  )).join("");
}

/* ============ API 封装（Electron 桥接 window.api） ============ */
function callApi(method, ...args) {
  if (window.api && window.api[method]) {
    try {
      return window.api[method](...args);
    } catch (e) {
      return Promise.resolve(null);
    }
  }
  return Promise.resolve(null);
}

/* ============ 下载 ============ */
let quality = "4K";
let fps = "0";
let proxyMode = "system";
let cookiesBrowser = "firefox";

/* ============ 浏览器 Cookies ============ */
// Chrome/Edge v127+ 启用了 App-Bound Encryption（Chrome 与 Edge 同源，同一时期引入），
// cookie 只有浏览器自己能解密，yt-dlp 直读会报 "Failed to decrypt with DPAPI"。
// 唯一出路：让用户用扩展导出 cookies.txt，程序读文件（--cookies）。
const COOKIE_STEPS = {
  chrome: {
    title: 'Chrome 无法直接读取 cookies（v127 起已加密），请按下面 3 步导出：',
    steps: [
      '在 Chrome 打开网上应用店，搜「Get cookies.txt LOCALLY」并安装（开源、数据不外传）。',
      '在已登录 YouTube 的标签页点扩展图标，格式选 Netscape，点「Export」导出 cookies.txt。',
      '回到这里点下方「导入 cookies.txt」，选择刚导出的文件。',
    ],
  },
  edge: {
    title: 'Edge 无法直接读取 cookies（v127 起已加密），请按下面 4 步导出：',
    steps: [
      '先在 Edge 地址栏输入 edge://extensions/，打开左下角「允许来自其他应用商店的扩展」开关（Edge 默认关闭，不开会装不上）。',
      '访问 Chrome 网上应用店，搜「Get cookies.txt LOCALLY」并安装。',
      '在已登录 YouTube 的标签页点扩展图标，格式选 Netscape，点「Export」导出 cookies.txt。',
      '回到这里点下方「导入 cookies.txt」，选择刚导出的文件。',
    ],
  },
};

async function renderCookieHint() {
  const el = $("#cookies-hint");
  const fileRow = $("#cookies-file-row");
  const fileHint = $("#cookies-file-hint");
  const guide = $("#cookies-guide");
  if (!el) return;

  const info = await callApi("get_cookie_info");
  if (!info) { el.textContent = ""; return; }
  el.textContent = info.detail || "";

  // 只有 Chrome / Edge 才需要「导入 cookies.txt」这条路
  const needFile = info.browser === "chrome" || info.browser === "edge";
  if (fileRow) fileRow.hidden = !needFile;
  if (fileHint) fileHint.textContent = info.hasCookiesFile ? "已导入 ✓" : "未导入";
  if (guide) {
    const cfg = COOKIE_STEPS[info.browser];
    if (!needFile || !cfg) {
      guide.hidden = true;
      guide.innerHTML = "";
    } else {
      guide.hidden = false;
      // 已导入成功就不再啰嗦步骤，改成一句状态提示
      guide.innerHTML = info.hasCookiesFile
        ? '<div class="guide-title">已使用导入的 cookies.txt。若换了浏览器或重新登录过，请重新导出并导入。</div>'
        : '<div class="guide-title">' + cfg.title + '</div>' +
          '<ol class="guide-steps">' +
          cfg.steps.map((s) => "<li>" + s + "</li>").join("") +
          '</ol>' +
          '<div class="guide-note">提示：cookies 相当于你的登录凭证，别把导出的文件发给别人。' +
          '文件会保存在本机，随时可点「清除」删掉。</div>';
    }
  }
}

function renderCookiesOptions() {
  const c = $("#cookies-opts");
  if (!c) return;
  c.innerHTML = "";
  [
    { value: "firefox", label: "Firefox" },
    { value: "chrome", label: "Chrome" },
    { value: "edge", label: "Edge" },
    { value: "off", label: "不使用" },
  ].forEach((opt) => {
    const el = document.createElement("div");
    el.className = "radio" + (opt.value === cookiesBrowser ? " checked" : "");
    el.dataset.v = opt.value;
    el.innerHTML = '<span class="dot"></span><span>' + opt.label + "</span>";
    c.appendChild(el);
  });
}

/* ============ 下载进度条 ============ */

/* ============ 批量任务列表 ============ */
// 主进程只有一个调度器，任务按 source 字段路由回各自的页面显示。
let allTasks = [];   // 主进程推送的任务快照（两个来源混在一起）

function tasksOf(src) { return allTasks.filter((t) => (t.source || "yt") === src); }

const TASK_STATE_TEXT = {
  queued: "等待中",
  running: "下载中",
  done: "已完成",
  error: "失败",
};

function renderTasks(src) {
  const card = el("task-card", src);
  const box = el("task-list", src);
  if (!card || !box) return;

  const tasks = tasksOf(src);
  if (!tasks.length) {
    card.hidden = true;
    box.innerHTML = "";
    return;
  }
  card.hidden = false;

  // 汇总：完成数 / 总数
  const total = tasks.length;
  const done = tasks.filter((t) => t.state === "done").length;
  const failed = tasks.filter((t) => t.state === "error").length;
  const running = tasks.filter((t) => t.state === "running").length;
  let summary = `共 ${total} 个 · 完成 ${done}`;
  if (failed) summary += ` · 失败 ${failed}`;
  if (running) summary += ` · 进行中 ${running}`;

  box.innerHTML = `<div class="queue-summary">${escapeHtml(summary)}</div>`;

  tasks.forEach((t) => {
    const title = t.title || t.url || "";
    const pct = Math.max(0, Math.min(100, t.percent || 0));
    const pctText = t.state === "done" ? "100%"
      : (t.state === "queued" ? "—" : (pct % 1 === 0 ? pct + "%" : pct.toFixed(1) + "%"));
    // 完成态把真实分辨率显示出来 —— 选了 4K 实际拿到 1080p 时一眼就能看见
    const meta = t.state === "error" ? (t.msg || "失败")
      : (t.state === "running" ? (t.detail || "下载中…")
        : (t.state === "done" ? (t.res ? "完成 · " + t.res : "完成") : "等待中…"));

    const item = document.createElement("div");
    item.className = "task-item state-" + t.state;
    item.dataset.id = t.id;
    item.innerHTML =
      '<div class="task-main">' +
        '<div class="task-title" title="' + escapeAttr(t.url || "") + '">' +
          t.seq + '. ' + escapeHtml(title) +
        '</div>' +
        '<div class="task-bar"><div class="task-bar-fill" style="width:' + pct + '%"></div></div>' +
        '<div class="task-meta">' + escapeHtml(meta) + '</div>' +
      '</div>' +
      '<div class="task-pct">' + pctText + '</div>' +
      '<div class="task-actions">' +
        (t.state === "done" && t.file
          ? '<button class="btn ghost" data-act="play">播放</button>' +
            '<button class="btn ghost" data-act="props">属性</button>' +
            '<button class="btn ghost" data-act="dir">目录</button>'
          : '') +
        (t.state === "queued" ? '<button class="btn ghost" data-act="cancel">取消</button>' : '') +
        (t.state === "running" ? '<button class="btn ghost" data-act="cancel">停止</button>' : '') +
      '</div>';

    // 完成的任务可以单独播放/看属性/定位
    if (t.state === "done" && t.file) {
      item.querySelector('[data-act="play"]').onclick = () => callApi("open_file", t.file);
      item.querySelector('[data-act="props"]').onclick = (e) => probeAndShow(t.file, e.currentTarget);
      item.querySelector('[data-act="dir"]').onclick = () => callApi("show_in_folder", t.file);
    }
    const cancelBtn = item.querySelector('[data-act="cancel"]');
    if (cancelBtn) {
      cancelBtn.onclick = () => callApi("cancel_task", t.id);
    }
    box.appendChild(item);
  });
}

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function escapeAttr(s) { return escapeHtml(s); }

// 收到单任务状态更新：合并进 allTasks 并重绘它所属的那个页面
function applyTaskUpdate(snap) {
  if (!snap || !snap.id) return;
  const src = snap.source || "yt";
  const idx = allTasks.findIndex((t) => t.id === snap.id);
  if (idx >= 0) allTasks[idx] = snap;
  else allTasks.push(snap);
  renderTasks(src);
  updateDownloadButtonState(src);
}

// 主按钮永不因队列忙而禁用 —— 用户要的就是"随时追加"，随时贴一批进来都行。
function updateDownloadButtonState(src) {
  const tasks = tasksOf(src);
  const btn = el("btn-download", src);
  const st = el("download-status", src);
  const runningN = tasks.filter((t) => t.state === "running").length;
  const queuedN = tasks.filter((t) => t.state === "queued").length;
  if (btn) btn.disabled = false;
  if (st) {
    if (runningN || queuedN) {
      st.textContent = `${runningN} 个下载中` + (queuedN ? ` · ${queuedN} 个等待` : "");
    } else {
      const failed = tasks.filter((t) => t.state === "error").length;
      st.textContent = failed ? `${failed} 个失败` : "就绪";
    }
  }
  refreshMainProgress(src);
}

// 主进度条是「总览」，唯一写入方。
// 并行时显示各在跑任务的平均进度（速度/ETA 明细留给队列卡片里每条任务自己的进度条）。
function refreshMainProgress(src) {
  const wrap = el("progress-wrap", src);
  const fill = el("progress-fill", src);
  const pctEl = el("progress-percent", src);
  const detailEl = el("progress-detail", src);
  if (!wrap || !fill || !pctEl || !detailEl) return;

  const tasks = tasksOf(src);
  const runningTasks = tasks.filter((t) => t.state === "running");
  const queuedN = tasks.filter((t) => t.state === "queued").length;

  const setBar = (p, text) => {
    const v = Math.max(0, Math.min(100, p));
    fill.style.width = v + "%";
    pctEl.textContent = (v % 1 === 0 ? v : v.toFixed(1)) + "%";
    detailEl.textContent = text;
  };

  if (!tasks.length) { wrap.hidden = true; return; }
  wrap.hidden = false;

  if (runningTasks.length === 0) {
    if (queuedN > 0) { setBar(0, `等待开始 · 队列 ${queuedN} 个`); return; }
    const done = tasks.filter((t) => t.state === "done").length;
    const failed = tasks.filter((t) => t.state === "error").length;
    // 进度条按"真正下成功的比例"收尾 —— 全失败时不该显示满格的 100%
    setBar(tasks.length ? (done / tasks.length) * 100 : 0,
      `已结束 · 成功 ${done}${failed ? ` · 失败 ${failed}` : ""}`);
    return;
  }

  if (runningTasks.length === 1) {
    const t = runningTasks[0];
    setBar(t.percent || 0, t.detail || "下载中…");
  } else {
    const avg = runningTasks.reduce((s, t) => s + (t.percent || 0), 0) / runningTasks.length;
    setBar(avg, `并行 ${runningTasks.length} 个` + (queuedN ? ` · 队列 ${queuedN} 个待下载` : ""));
  }
}

// 就地刷新某条任务的进度条（避免每次进度回调都整表重绘）
function updateTaskRowProgress(id, percent, detail) {
  const t = allTasks.find((x) => x.id === id);
  const src = (t && t.source) || "yt";
  const box = el("task-list", src);
  if (!box) return;
  const item = box.querySelector('.task-item[data-id="' + id + '"]');
  if (!item) return;
  const fill = item.querySelector(".task-bar-fill");
  const pct = item.querySelector(".task-pct");
  const meta = item.querySelector(".task-meta");
  const p = Math.max(0, Math.min(100, percent || 0));
  if (fill) fill.style.width = p + "%";
  if (pct) pct.textContent = (p % 1 === 0 ? p : p.toFixed(1)) + "%";
  if (meta && detail) meta.textContent = detail;
}

// 处理单任务的状态类事件（进度条不在这里写，见 refreshMainProgress）
// 播放/属性/目录已移到队列行内，底栏不再有需要跟随任务状态启停的按钮，
// 这里只负责同步队列状态文案与总览进度。src 为空时两页都刷新。
function updateProgress(src) {
  if (src) updateDownloadButtonState(src);
  else SOURCES.forEach(updateDownloadButtonState);
}

/* ============ 初始化 ============ */
async function init() {
  bindEvents();
  applySkin("dark-linear");
  const cfg = await callApi("get_config");
  if (cfg) {
    if (cfg.skin) applySkin(cfg.skin);
    renderVersion(cfg.version);
    // dirs 形如 { yt: [...], social: [...] }；老版本可能是数组，主进程已归一化
    if (cfg.dirs && !Array.isArray(cfg.dirs)) {
      dirs.yt = Array.isArray(cfg.dirs.yt) ? cfg.dirs.yt : [];
      dirs.social = Array.isArray(cfg.dirs.social) ? cfg.dirs.social : [];
    } else if (Array.isArray(cfg.dirs)) {
      dirs.yt = cfg.dirs;
    }
    quality = cfg.quality || "4K";
    fps = cfg.default_fps || "0";
    proxyMode = cfg.proxy_mode || "system";
    cookiesBrowser = cfg.cookies_browser || "firefox";
    $("#proxy-addr").value = cfg.proxy || "";
    if (cfg.url) $("#url").value = cfg.url;
  }

  renderDirs();   // 两个页面各渲染自己那一份
  renderRadios("quality-opts",
    ["原画", "4K", "1080P", "720P"].map((v) => ({ value: v, label: v })), quality,
    (v) => { quality = v; callApi("save_quality", v); });
  renderRadios("fps-opts",
    [{ value: "0", label: "不转换" }, { value: "30", label: "转 30fps" }, { value: "24", label: "转 24fps" }], fps,
    (v) => { fps = v; callApi("save_fps", v); });
  renderRadios("proxy-opts",
    [{ value: "system", label: "跟随系统" }, { value: "manual", label: "手动" }, { value: "direct", label: "直连" }], proxyMode,
    (v) => { proxyMode = v; callApi("save_proxy_mode", v); refreshProxyHint(); });

  // 网络代理（设置页）：手动地址改完即存；「跟随系统」时把实际解析到的端口显示出来
  const proxyAddr = $("#proxy-addr");
  if (proxyAddr) {
    proxyAddr.addEventListener("change", async () => {
      const v = proxyAddr.value.trim();
      await callApi("save_proxy", v);
      const hint = $("#proxy-hint");
      if (hint) {
        hint.textContent = v ? "已保存 ✓" : "已清空 ✓";
        setTimeout(refreshProxyHint, 1000);   // 一秒后恢复常驻提示
      }
    });
  }
  refreshProxyHint();

  // 浏览器 Cookies（设置页）
  renderCookiesOptions();
  renderCookieHint();

  // 图片压缩（设置记住上次选择）
  if (cfg && cfg.img) {
    imgOpts.quality = cfg.img.quality || "中";
    imgOpts.format = cfg.img.format || "keep";
    imgOpts.maxEdge = cfg.img.maxEdge || 0;
    imgOpts.outMode = cfg.img.outMode || "sub";
    imgOpts.outDir = cfg.img.outDir || "";
    if (imgOpts.outDir) $("#img-outdir").value = imgOpts.outDir;
  }
  initImagePage();

  // 视频处理（设置记住上次选择；编码器列表要等硬件探测结果）
  if (cfg && cfg.video) {
    const v = cfg.video;
    if (v.mode) vidOpts.mode = v.mode;
    if (v.quality) vidOpts.quality = v.quality;
    if (v.encoder) vidOpts.encoder = v.encoder;
    if (v.maxHeight !== undefined) vidOpts.maxHeight = v.maxHeight;
    if (v.audio) vidOpts.audio = v.audio;
    if (v.container) vidOpts.container = v.container;
    if (v.outMode) vidOpts.outMode = v.outMode;
    if (v.outDir) vidOpts.outDir = v.outDir;
    if ($("#vid-start") && v.start) $("#vid-start").value = v.start;
    if ($("#vid-end") && v.end) $("#vid-end").value = v.end;
  }
  initVideoPage();
  renderVidEncoderOptions();

  // 环境检测
  const comps = await callApi("get_components");
  if (comps) renderComponents(comps);
  renderPlaybackCaps();

  // 恢复队列显示（如页面刷新过，主进程里可能还有任务在跑）
  const t = await callApi("get_tasks");
  if (Array.isArray(t) && t.length) {
    allTasks = t;
    SOURCES.forEach((s) => { renderTasks(s); updateDownloadButtonState(s); });
  }
  updateUrlHint("yt");
  updateUrlHint("social");
  switchPage("yt");   // 默认停在油管下载页

  appendLog("Fallen Angels v" + ((cfg && cfg.version) || "") + " · 界面已就绪", "dim");
}

/* 初始化：Electron 下 window.api 由 preload 同步注入，DOM 就绪后直接 init */
function boot() {
  if (window._ytdlp4k_inited) return;
  window._ytdlp4k_inited = true;
  init();
}

// 日志监听：主进程 pushLog 推过来的
if (window.api && window.api.on_log) {
  window.api.on_log((data) => {
    appendLog(data.text, data.cls, data.source);
  });
}

// 下载进度监听：主进程 sendProgress 推过来的
if (window.api && window.api.on_progress) {
  window.api.on_progress((data) => {
    if (!data) return;
    const t = data.taskId ? allTasks.find((x) => x.id === data.taskId) : null;
    const src = (t && t.source) || data.source || null;
    // 高频的百分比行：同步进 allTasks（否则重绘会退回旧值）+ 就地刷新那一行 + 更新总览条
    if (data.state === "progress") {
      if (data.taskId) {
        if (t) {
          t.percent = data.percent || 0;
          if (data.detail) t.detail = data.detail;
        }
        updateTaskRowProgress(data.taskId, data.percent, data.detail);
        if (src) refreshMainProgress(src);
      }
      return;
    }
    // 状态类事件（start/done/error）：进度条由 refreshMainProgress 统管，这里只刷状态文案
    updateProgress(src);
  });
}

// 批量任务状态监听：主进程 task-update 推过来的
if (window.api && window.api.on_task_update) {
  window.api.on_task_update((snap) => {
    applyTaskUpdate(snap);
  });
}

// 队列全部结束
if (window.api && window.api.on_queue_idle) {
  window.api.on_queue_idle(() => {
    SOURCES.forEach(updateDownloadButtonState);
  });
}

// 图片压缩：单张完成 / 整批结束
if (window.api && window.api.on_image_item) {
  window.api.on_image_item((d) => onImageItem(d));
}
if (window.api && window.api.on_image_done) {
  window.api.on_image_done((d) => onImageDone(d));
}

// 视频处理：单条完成 / 进度 / 整批结束
if (window.api && window.api.on_video_item) {
  window.api.on_video_item((d) => onVideoItem(d));
}
if (window.api && window.api.on_video_progress) {
  window.api.on_video_progress((d) => onVideoProgress(d));
}
if (window.api && window.api.on_video_done) {
  window.api.on_video_done((d) => onVideoDone(d));
}

// DOM 就绪后初始化（Electron preload 的 window.api 此时已可用）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
