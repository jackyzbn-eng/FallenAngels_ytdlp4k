// Fallen Angels preload：把主进程 IPC 暴露为 window.api（前端 app.js 通过它调用）
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  get_config: () => ipcRenderer.invoke('get_config'),
  set_skin: (skin) => ipcRenderer.invoke('set_skin', skin),
  save_quality: (q) => ipcRenderer.invoke('save_quality', q),
  save_fps: (fps) => ipcRenderer.invoke('save_fps', fps),
  save_proxy_mode: (mode) => ipcRenderer.invoke('save_proxy_mode', mode),
  save_proxy: (addr) => ipcRenderer.invoke('save_proxy', addr),
  get_system_proxy: () => ipcRenderer.invoke('get_system_proxy'),
  save_cookies_browser: (b) => ipcRenderer.invoke('save_cookies_browser', b),
  get_cookie_info: () => ipcRenderer.invoke('get_cookie_info'),
  import_cookies_file: () => ipcRenderer.invoke('import_cookies_file'),
  has_cookies_file: () => ipcRenderer.invoke('has_cookies_file'),
  clear_cookies_file: () => ipcRenderer.invoke('clear_cookies_file'),
  save_dirs: (dirs) => ipcRenderer.invoke('save_dirs', dirs),
  pick_folder: (title) => ipcRenderer.invoke('pick_folder', title),
  copy_text: (text) => ipcRenderer.invoke('copy_text', text),
  read_clipboard: () => ipcRenderer.invoke('read_clipboard'),
  open_file: (filePath) => ipcRenderer.invoke('open_file', filePath),
  open_url: (url) => ipcRenderer.invoke('open_url', url),
  preview_file: (filePath) => ipcRenderer.invoke('preview_file', filePath),
  show_in_folder: (filePath) => ipcRenderer.invoke('show_in_folder', filePath),
  probe_file: (filePath) => ipcRenderer.invoke('probe_file', filePath),
  get_components: () => ipcRenderer.invoke('get_components'),
  start_download: (params) => ipcRenderer.invoke('start_download', params),
  get_tasks: () => ipcRenderer.invoke('get_tasks'),
  stop_all: (source) => ipcRenderer.invoke('stop_all', source),
  cancel_task: (id) => ipcRenderer.invoke('cancel_task', id),
  pause_task: (id) => ipcRenderer.invoke('pause_task', id),
  resume_task: (id) => ipcRenderer.invoke('resume_task', id),
  retry_task: (id) => ipcRenderer.invoke('retry_task', id),
  clear_finished: (source) => ipcRenderer.invoke('clear_finished', source),

  // ---- 图片压缩 ----
  save_img_settings: (s) => ipcRenderer.invoke('save_img_settings', s),
  pick_images: () => ipcRenderer.invoke('pick_images'),
  collect_images: (recursive) => ipcRenderer.invoke('collect_images', recursive),
  expand_image_paths: (paths) => ipcRenderer.invoke('expand_image_paths', paths),
  start_image_job: (params) => ipcRenderer.invoke('start_image_job', params),
  stop_image_job: (jobId) => ipcRenderer.invoke('stop_image_job', jobId),
  open_folder: (dir) => ipcRenderer.invoke('open_folder', dir),

  // 日志推送（主进程 -> 渲染进程）
  on_log: (cb) => ipcRenderer.on('log', (e, data) => cb(data)),
  // 下载进度推送（主进程 -> 渲染进程）
  on_progress: (cb) => ipcRenderer.on('progress', (e, data) => cb(data)),
  // 批量任务状态推送（主进程 -> 渲染进程）
  on_task_update: (cb) => ipcRenderer.on('task-update', (e, data) => cb(data)),
  // 队列全部结束通知
  on_queue_idle: (cb) => ipcRenderer.on('queue-idle', (e, data) => cb(data)),
  // 图片压缩：单张完成 / 整批结束
  on_image_item: (cb) => ipcRenderer.on('image-item', (e, data) => cb(data)),
  on_image_done: (cb) => ipcRenderer.on('image-done', (e, data) => cb(data)),

  // ---- 视频处理（无损修剪 / 压缩） ----
  pick_videos: () => ipcRenderer.invoke('pick_videos'),
  collect_videos: (recursive) => ipcRenderer.invoke('collect_videos', recursive),
  expand_video_paths: (paths) => ipcRenderer.invoke('expand_video_paths', paths),
  probe_video: (file) => ipcRenderer.invoke('probe_video', file),
  probe_merge_files: (files, opts) => ipcRenderer.invoke('probe_merge_files', files, opts),
  pick_audio: () => ipcRenderer.invoke('pick_audio'),
  probe_audio: (file) => ipcRenderer.invoke('probe_audio', file),
  start_compose_job: (params) => ipcRenderer.invoke('start_compose_job', params),
  get_video_caps: () => ipcRenderer.invoke('get_video_caps'),
  // 视频处理页的设置（模式/画质/编码器/切点）。主进程早就有这个 handler，
  // 但 preload 一直漏了桥接 —— 结果切点、编码器这些设置从来没存下来过。
  save_video_settings: (s) => ipcRenderer.invoke('save_video_settings', s),
  start_video_job: (params) => ipcRenderer.invoke('start_video_job', params),
  stop_video_job: (jobId) => ipcRenderer.invoke('stop_video_job', jobId),
  // 预览：拿到原片的 file:// 地址；放不出来时用 open_in_player 丢给外部播放器
  get_video_url: (file) => ipcRenderer.invoke('get_video_url', file),
  get_playback_caps: () => ipcRenderer.invoke('get_playback_caps'),
  open_in_player: (file) => ipcRenderer.invoke('open_in_player', file),
  // 玻璃皮肤背景流体的性能档位 + 显卡/渲染能力自检（环境检测页用）
  // ⚠️ 名字必须和 app.js 里 callApi("save_perf_tier") 一致 ——
  //    叫成 set_perf_tier 过 callApi 的鸭子判断会静默返回 null（踩过）
  save_perf_tier: (t) => ipcRenderer.invoke('set_perf_tier', t),
  get_render_caps: () => ipcRenderer.invoke('get_render_caps'),
  // 手动指定外部播放器路径（设置页 →「视频播放」卡）
  set_external_player: (p) => ipcRenderer.invoke('set_external_player', p),
  pick_external_player: () => ipcRenderer.invoke('pick_external_player'),
  // 在线更新
  get_update_state: () => ipcRenderer.invoke('get_update_state'),
  check_update: () => ipcRenderer.invoke('check_update'),
  download_update: () => ipcRenderer.invoke('download_update'),
  install_update: () => ipcRenderer.invoke('install_update'),
  set_update_url: (u) => ipcRenderer.invoke('set_update_url', u),
  on_update_status: (cb) => ipcRenderer.on('update-status', (e, d) => cb(d)),

  // ---- 下载完成后的「转为 30 帧」（队列行内按钮） ----
  convert_fps30: (file) => ipcRenderer.invoke('convert_fps30', file),
  on_fps_progress: (cb) => ipcRenderer.on('fps-progress', (e, data) => cb(data)),
  on_fps_done: (cb) => ipcRenderer.on('fps-done', (e, data) => cb(data)),

  // ---- 封面图下载页 ----
  save_cover_dir: (dir) => ipcRenderer.invoke('save_cover_dir', dir),
  start_cover_job: (params) => ipcRenderer.invoke('start_cover_job', params),
  stop_cover_job: (jobId) => ipcRenderer.invoke('stop_cover_job', jobId),
  on_cover_item: (cb) => ipcRenderer.on('cover-item', (e, data) => cb(data)),
  on_cover_done: (cb) => ipcRenderer.on('cover-done', (e, data) => cb(data)),

  on_video_item: (cb) => ipcRenderer.on('video-item', (e, data) => cb(data)),
  on_video_progress: (cb) => ipcRenderer.on('video-progress', (e, data) => cb(data)),
  on_video_done: (cb) => ipcRenderer.on('video-done', (e, data) => cb(data)),
  on_compose_item: (cb) => ipcRenderer.on('compose-item', (e, data) => cb(data)),
  on_compose_progress: (cb) => ipcRenderer.on('compose-progress', (e, data) => cb(data)),
  on_compose_done: (cb) => ipcRenderer.on('compose-done', (e, data) => cb(data)),

  /* 拖拽进窗口的文件路径。
     渲染进程拿不到 File 的真实路径（Electron 32 起移除了 File.path），
     只有 preload 里的 webUtils 能取到。所以由 preload 直接在 window 上挂拖拽监听，
     把路径数组回调给前端 —— 顺带 preventDefault 掉，免得拖进图片时整页跳成图片预览。 */
  on_dropped_files: (cb) => {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', (e) => {
      stop(e);
      const paths = [];
      const files = (e.dataTransfer && e.dataTransfer.files) || [];
      for (const f of files) {
        try {
          const p = webUtils.getPathForFile(f);
          if (p) paths.push(p);
        } catch (err) { /* 拿不到就跳过 */ }
      }
      if (paths.length) cb(paths);
    });
  },
});
