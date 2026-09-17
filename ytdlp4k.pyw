# -*- coding: utf-8 -*-
"""
ytdlp4k - YouTube 4K 视频下载器（tkinter GUI）

功能：
  - 多目录快捷选择 + 自定义保存路径
  - 下载进度实时显示
  - 播放按钮：下载完成后直接播放
  - 属性按钮：ffprobe 查看分辨率/时长/帧率/编码
  - 智能帧率：优先下载目标帧率原版流，无则 ffmpeg 转码兜底
  - GPU 优先转码（NVENC），无 GPU 自动回退 CPU

依赖（绿色分发，免 Python）：
  - yt-dlp.exe：下载内核，首次运行在“必需环境检测”页一键自动下载
  - ffmpeg/ffprobe：音视频合并与转码，同样自动下载
  - tkinter（Windows 官方 Python 自带）

运行：python ytdlp4k.pyw    （或打包为 exe，见 README）
"""
import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext, filedialog

import envcheck

APP_NAME = "ytdlp4k"
# exe/pyw 所在目录（打包后 = exe 目录，config/tools 持久化在这里，而非 _MEIPASS）
APP_DIR = envcheck.app_dir()


def _writable(path):
    """检测目录是否可写"""
    try:
        os.makedirs(path, exist_ok=True)
        probe = os.path.join(path, ".~write_test")
        with open(probe, "w", encoding="utf-8") as f:
            f.write("1")
        os.remove(probe)
        return True
    except Exception:
        return False


def _data_dir():
    """用户数据目录（安装到 Program Files 等只读位置时用）"""
    base = os.environ.get("APPDATA") or os.path.join(
        os.path.expanduser("~"), "AppData", "Roaming")
    d = os.path.join(base, APP_NAME)
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass
    return d


def _config_path():
    """配置文件位置：优先 exe 同目录（绿色版便携）；
    装到 Program Files 等只读目录时，自动回退到 %APPDATA%\\ytdlp4k\\config.json"""
    if _writable(APP_DIR):
        return os.path.join(APP_DIR, "config.json")
    return os.path.join(_data_dir(), "config.json")


CONFIG_PATH = _config_path()

# ---------- 字体层级（统一在此调整，改一处全局生效） ----------
FONT = "Microsoft YaHei UI"
F_H1 = (FONT, 16, "bold")        # 页面主标题
F_LOGO = (FONT, 19, "bold")      # 侧边栏 logo
F_H2 = (FONT, 11, "bold")        # 卡片标题
F_BODY = (FONT, 10)              # 正文 / 导航 / 控件标签
F_SMALL = (FONT, 9)              # 说明与辅助信息
F_TINY = (FONT, 8)               # 行内小标签
F_LOG = (FONT, 10)               # 日志区


DEFAULT_CONFIG = {
    "proxy_mode": "system",            # 代理模式：system=跟随系统代理 / manual=手动指定 / direct=直连
    "proxy": "",                       # 手动模式下的代理地址，如 "http://127.0.0.1:7897"
    "cookies_browser": "firefox",      # 浏览器 Cookie 来源：firefox / chrome / edge / 留空禁用
    "lastdir_file": "~/.ytdlp4k_lastdir.txt",
    "default_fps": "0",                # 0=不转换 30=转30fps 24=转24fps
    "quality": "4K",                   # 下载分辨率档位（见 QUALITY）
    "dirs": [
        {"name": "1080P", "path": ""},
        {"name": "4K",    "path": ""},
    ],
}

# 下载分辨率档位：值是 yt-dlp 格式选择器，用"上限约束"实现自动降级——
# 选了 4K 但视频最高只有 1080P 时，[height<=2160] 自动取可用最高流(1080P)；
# “原画”不设上限，取该视频可读取的最高分辨率。
QUALITY = {
    "原画": "bv*+ba/b",
    "4K":   "bv*[height<=2160]+ba/b[height<=2160]",
    "1080P": "bv*[height<=1080]+ba/b[height<=1080]",
    "720P": "bv*[height<=720]+ba/b[height<=720]",
}
QUALITY_ORDER = ["原画", "4K", "1080P", "720P"]


def load_config():
    if not os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(DEFAULT_CONFIG, f, ensure_ascii=False, indent=2)
        except OSError:
            pass
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            cfg.setdefault(k, v)
        # 兼容旧版 dirs（label 字段 → name），并保证每个分类都有 name/path
        for i, d in enumerate(cfg.get("dirs", [])):
            if "label" in d and "name" not in d:
                d["name"] = d.pop("label")
            d.setdefault("name", "分类%d" % (i + 1))
            d.setdefault("path", "")
        # 兼容旧版：分类曾自带 fmt（画质选择已独立为 quality 档位，忽略旧 fmt）
        return cfg
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))


def expand_path(p):
    if not p:
        return p
    return os.path.expanduser(os.path.expandvars(p))


class App:
    """下载页：卡片式布局（页头 + 可滚动配置卡片 + 固定日志区）"""

    PAGE_BG = "#fafafa"      # 与 sv-ttk 主题背景一致
    CARD_BG = "#ffffff"      # 卡片内底色（sv-ttk Card 样式 = 白色圆角卡片）
    FG = "#1c1c1c"
    MUTED = "#8a8a8a"
    FONT = "Microsoft YaHei UI"

    def __init__(self, root, parent):
        self.root = root          # 主窗口 Tk：用于 after / messagebox / Toplevel
        self.cfg = load_config()
        self.last_file = None

        page = tk.Frame(parent, bg=self.PAGE_BG)
        page.pack(fill="both", expand=True)

        # ---------- 页面头部 ----------
        head = tk.Frame(page, bg=self.PAGE_BG)
        head.pack(fill="x", padx=24, pady=(20, 14))
        tk.Label(head, text="下载", font=F_H1,
                 bg=self.PAGE_BG, fg=self.FG).pack(anchor="w")
        tk.Label(head, text="粘贴 YouTube 链接，选好保存分类和画质，点「开始下载」",
                 font=F_BODY, bg=self.PAGE_BG,
                 fg=self.MUTED).pack(anchor="w", pady=(4, 0))

        # ---------- 配置卡片区（可滚动） ----------
        outer = tk.Frame(page, bg=self.PAGE_BG)
        outer.pack(fill="both", expand=True)

        self._canvas = tk.Canvas(outer, bg=self.PAGE_BG, highlightthickness=0, bd=0)
        vbar = ttk.Scrollbar(outer, orient="vertical", command=self._canvas.yview)
        self._canvas.configure(yscrollcommand=vbar.set)
        vbar.pack(side="right", fill="y")
        self._canvas.pack(side="left", fill="both", expand=True)

        holder = tk.Frame(self._canvas, bg=self.PAGE_BG)
        self._win = self._canvas.create_window((0, 0), window=holder, anchor="nw")

        def _sync_scroll(_=None):
            self._canvas.configure(scrollregion=self._canvas.bbox("all"))
            # 首次布局完成后归零，避免初始停在中间导致卡片标题被裁
            if not getattr(self, "_scroll_ready", False):
                self._scroll_ready = True
                for _delay in (0, 120, 400):
                    self.root.after(_delay, lambda: self._canvas.yview_moveto(0.0))

        holder.bind("<Configure>", _sync_scroll)
        self._canvas.bind("<Configure>",
                          lambda e: self._canvas.itemconfigure(self._win, width=e.width))
        self._canvas.bind("<Enter>",
                          lambda e: self._canvas.bind_all("<MouseWheel>", self._on_wheel))
        self._canvas.bind("<Leave>",
                          lambda e: self._canvas.unbind_all("<MouseWheel>"))

        # ===== 卡片 1：保存目录 =====
        b = self._card(holder, "保存目录",
                       "分类名可直接改；每个分类点「浏览」选一个下载文件夹",
                       action=("＋ 添加分类", self._add_dir))
        self.dirs = self.cfg.get("dirs", [])
        self.choice = tk.IntVar(value=0)
        self.dir_box = tk.Frame(b, bg=self.CARD_BG)
        self.dir_box.pack(fill="x")
        self._rebuild_dirs()

        # ===== 卡片 2：画质（分辨率 + 帧率） =====
        b = self._card(holder, "画质",
                       "分辨率高于视频实际时自动降级；帧率优先下载原版流")
        self.quality_var = tk.StringVar(value=self.cfg.get("quality", "4K"))
        qrow = tk.Frame(b, bg=self.CARD_BG)
        qrow.pack(fill="x")
        tk.Label(qrow, text="分辨率", width=7, anchor="w", font=F_SMALL,
                 bg=self.CARD_BG, fg=self.FG).pack(side="left")
        for q in QUALITY_ORDER:
            ttk.Radiobutton(qrow, text=q, variable=self.quality_var,
                            value=q, command=self._on_quality).pack(side="left", padx=(0, 26))
        frow = tk.Frame(b, bg=self.CARD_BG)
        frow.pack(fill="x", pady=(10, 0))
        tk.Label(frow, text="帧率", width=7, anchor="w", font=F_SMALL,
                 bg=self.CARD_BG, fg=self.FG).pack(side="left")
        self.fps_var = tk.StringVar(value=self.cfg.get("default_fps", "0"))
        for _val, _txt in (("0", "不转换"), ("30", "转 30fps"), ("24", "转 24fps")):
            ttk.Radiobutton(frow, text=_txt, variable=self.fps_var,
                            value=_val).pack(side="left", padx=(0, 26))

        # ===== 卡片 3：视频链接 + 代理 =====
        b = self._card(holder, "视频链接")
        self.url_var = tk.StringVar()
        ttk.Entry(b, textvariable=self.url_var).pack(fill="x")

        # 代理：默认跟随 Windows 系统代理（yt-dlp 原生读注册表），也可手动指定或强制直连
        prow = tk.Frame(b, bg=self.CARD_BG)
        prow.pack(fill="x", pady=(14, 0))
        tk.Label(prow, text="网络代理", font=F_TINY,
                 bg=self.CARD_BG, fg=self.MUTED).pack(side="left", padx=(0, 14))
        if "proxy_mode" not in self.cfg:
            # 兼容旧配置：原来填了地址的视为手动模式
            self.cfg["proxy_mode"] = "manual" if self.cfg.get("proxy") else "system"
        self.proxy_mode = tk.StringVar(value=self.cfg.get("proxy_mode", "system"))
        for _val, _txt in (("system", "跟随系统代理"), ("manual", "手动指定"), ("direct", "直连")):
            ttk.Radiobutton(prow, text=_txt, variable=self.proxy_mode,
                            value=_val, command=self._on_proxy_mode).pack(side="left", padx=(0, 18))
        self.proxy_var = tk.StringVar(value=self.cfg.get("proxy", ""))
        self.proxy_entry = ttk.Entry(prow, textvariable=self.proxy_var, width=18)
        self.proxy_entry.pack(side="left", padx=(0, 10))
        self.proxy_hint = tk.Label(prow, text="", font=F_SMALL,
                                   bg=self.CARD_BG, fg=self.MUTED)
        self.proxy_hint.pack(side="left")
        self._update_proxy_ui()

        # ---------- 底部固定区：按钮 + 日志（不参与伸缩，把空间留给卡片） ----------
        bottom = tk.Frame(page, bg=self.PAGE_BG)
        bottom.pack(fill="x", padx=24, pady=(0, 16))

        btns = tk.Frame(bottom, bg=self.PAGE_BG)
        btns.pack(fill="x", pady=(0, 10))
        self.btn = ttk.Button(btns, text="开始下载", command=self.start_download,
                              style="Accent.TButton", width=12)
        self.btn.pack(side="left")
        self.play_btn = ttk.Button(btns, text="播放", command=self.play_last, state="disabled")
        self.play_btn.pack(side="left", padx=(8, 0))
        self.prop_btn = ttk.Button(btns, text="属性", command=self.show_props, state="disabled")
        self.prop_btn.pack(side="left", padx=(8, 0))
        ttk.Button(btns, text="清空日志", command=self._clear_log).pack(side="left", padx=(8, 0))
        self.status = tk.Label(btns, text="就绪", font=F_SMALL,
                               bg=self.PAGE_BG, fg="#005fb8")
        self.status.pack(side="right")

        self.log = scrolledtext.ScrolledText(
            bottom, height=6, state="disabled",
            font=F_LOG, relief="flat", bd=0,
            bg="#ffffff", fg="#2b2b2b",
            insertbackground="#2b2b2b",
            selectbackground="#cce4f7",
            highlightthickness=1, highlightbackground="#e5e5e5",
            highlightcolor="#005fb8", padx=12, pady=10)
        self.log.pack(fill="x")

        self.load_last()
        if not self.log.get("1.0", "end").strip():
            self.append_log("准备就绪。粘贴 YouTube 链接即可开始下载。")

    # ---------- 卡片与滚动 ----------
    def _card(self, parent, title, subtitle=None, action=None):
        """基于 sv-ttk 自带的 Card 样式创建卡片，返回内容容器。
        action=(文字, 回调) 时在标题右侧放一个操作按钮。"""
        card = ttk.Frame(parent, style="Card.TFrame")
        card.pack(fill="x", padx=20, pady=(0, 12))
        pad = tk.Frame(card, bg=self.CARD_BG)
        pad.pack(fill="x", padx=8, pady=8)
        head_row = tk.Frame(pad, bg=self.CARD_BG)
        head_row.pack(fill="x")
        tk.Label(head_row, text=title, font=F_H2,
                 bg=self.CARD_BG, fg=self.FG).pack(side="left")
        if action:
            ttk.Button(head_row, text=action[0],
                       command=action[1]).pack(side="right")
        if subtitle:
            tk.Label(pad, text=subtitle, font=F_SMALL,
                     bg=self.CARD_BG, fg=self.MUTED).pack(anchor="w", pady=(3, 0))
        body = tk.Frame(pad, bg=self.CARD_BG)
        body.pack(fill="x", pady=(8, 0))
        return body

    def _on_wheel(self, event):
        self._canvas.yview_scroll(int(-event.delta / 120), "units")

    def _clear_log(self):
        self.log.configure(state="normal")
        self.log.delete("1.0", "end")
        self.log.configure(state="disabled")

    # ---------- 配置与工具 ----------
    def load_last(self):
        lastfile = expand_path(self.cfg.get("lastdir_file", ""))
        if lastfile and os.path.exists(lastfile):
            with open(lastfile, encoding="utf-8", errors="ignore") as f:
                last = f.read().strip()
            if last:
                self.append_log("上次目录: %s" % last)

    # ---------- 分类（保存目录）管理 ----------
    def _rebuild_dirs(self):
        """按 self.dirs 重建分类行：◉ [分类名][路径][浏览][✕]"""
        for w in self.dir_box.winfo_children():
            w.destroy()
        self.dir_name_vars = []
        self.dir_path_vars = []
        for i, d in enumerate(self.dirs):
            row = tk.Frame(self.dir_box, bg=self.CARD_BG)
            row.pack(fill="x", pady=3)
            ttk.Radiobutton(row, variable=self.choice, value=i).pack(side="left")
            nv = tk.StringVar(value=d.get("name", ""))
            nv.trace_add("write", self._on_dir_edited)
            self.dir_name_vars.append(nv)
            ttk.Entry(row, textvariable=nv, width=12).pack(side="left", padx=(0, 8))
            pv = tk.StringVar(value=d.get("path", ""))
            self.dir_path_vars.append(pv)
            ttk.Entry(row, textvariable=pv, state="readonly").pack(
                side="left", fill="x", expand=True, padx=(0, 8))
            ttk.Button(row, text="浏览",
                       command=lambda i=i: self._pick_dir(i)).pack(side="left")
            ttk.Button(row, text="✕", width=2,
                       command=lambda i=i: self._del_dir(i)).pack(side="left", padx=(4, 0))
        # 单选值越界时收回（删除分类导致）
        if self.choice.get() < 0:
            self.choice.set(0)
        elif self.choice.get() >= len(self.dirs):
            self.choice.set(max(0, len(self.dirs) - 1))

    def _sync_dirs(self):
        """把界面编辑结果写回 self.dirs 并持久化"""
        for i, d in enumerate(self.dirs):
            if i < len(self.dir_name_vars):
                nm = self.dir_name_vars[i].get().strip()
                d["name"] = nm or ("分类%d" % (i + 1))
            if i < len(self.dir_path_vars):
                d["path"] = self.dir_path_vars[i].get()
        self._save_cfg()

    def _on_dir_edited(self, *_):
        self._sync_dirs()

    def _save_cfg(self):
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as f:
                json.dump(self.cfg, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def _pick_dir(self, i):
        name = self.dir_name_vars[i].get().strip() or ("分类%d" % (i + 1))
        path = filedialog.askdirectory(title="选择“%s”的下载文件夹" % name)
        if path:
            self.dir_path_vars[i].set(path)
            self.choice.set(i)
            self._sync_dirs()
            self.status.configure(text="分类“%s”目录: %s" % (name, path))

    def _add_dir(self):
        self.dirs.append({"name": "新分类", "path": ""})
        self.choice.set(len(self.dirs) - 1)
        self._rebuild_dirs()
        self._save_cfg()

    def _del_dir(self, i):
        if len(self.dirs) <= 1:
            messagebox.showinfo("提示", "至少保留一个分类")
            return
        del self.dirs[i]
        if self.choice.get() >= len(self.dirs):
            self.choice.set(max(0, len(self.dirs) - 1))
        self._rebuild_dirs()
        self._save_cfg()

    def _on_quality(self):
        self.cfg["quality"] = self.quality_var.get()
        self._save_cfg()

    def _on_proxy_mode(self):
        self.cfg["proxy_mode"] = self.proxy_mode.get()
        self._save_cfg()
        self._update_proxy_ui()

    def _update_proxy_ui(self):
        """按代理模式启用/禁用输入框，并展示系统代理的实际状态"""
        mode = self.proxy_mode.get()
        if mode == "manual":
            self.proxy_entry.configure(state="normal")
            self.proxy_hint.configure(text="例 127.0.0.1:7897")
        elif mode == "system":
            self.proxy_entry.configure(state="disabled")
            url, msg = envcheck.get_system_proxy()
            if url:
                # 只显示地址主体，避免过长把这一行撑爆
                short = url.replace("http://", "").replace("https://", "")
                self.proxy_hint.configure(text="系统代理 " + short)
            else:
                self.proxy_hint.configure(text=msg)
        else:
            self.proxy_entry.configure(state="disabled")
            self.proxy_hint.configure(text="不走代理")

    def get_fmt(self):
        """按当前下载分辨率档位取格式选择器（档位是上限，视频不够高时自动取可用最高）"""
        return QUALITY.get(self.quality_var.get(), QUALITY["4K"])

    def resolve_target(self):
        self._sync_dirs()   # 以界面当前值为准（防 name/path var 已改未落盘）
        c = self.choice.get()
        if 0 <= c < len(self.dirs):
            d = self.dirs[c]
            path = expand_path(d.get("path", ""))
            if not path:
                raise ValueError("分类“%s”还没选下载文件夹，点它后面的“浏览”选一个"
                                 % (d.get("name") or "分类%d" % (c + 1)))
            return path
        raise ValueError("请先选一个分类")

    def append_log(self, text):
        def _ins():
            self.log.configure(state="normal")
            self.log.insert("end", text + "\n")
            self.log.see("end")
            self.log.configure(state="disabled")
        self.root.after(0, _ins)

    @staticmethod
    def find_tool(name):
        return envcheck.find_tool(name)

    def has_nvenc(self):
        """检测 ffmpeg 是否支持 NVIDIA NVENC"""
        ffmpeg = self.find_tool("ffmpeg")
        if not ffmpeg:
            return False
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.check_output(
                [ffmpeg, "-hide_banner", "-encoders"],
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=flags)
            return "h264_nvenc" in out
        except Exception:
            return False

    @staticmethod
    def parse_fps(s):
        try:
            num, den = s.split("/")
            return round(float(num) / float(den), 2)
        except Exception:
            return "?"

    def get_file_fps(self, path):
        fp = self.find_tool("ffprobe")
        if not fp:
            return None
        import json as _json
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.check_output(
                [fp, "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=r_frame_rate", "-of", "json", path],
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=flags)
            data = _json.loads(out)
            streams = data.get("streams", [])
            if streams:
                return self.parse_fps(streams[0].get("r_frame_rate", "0/1"))
            return None
        except Exception:
            return None

    def convert_fps(self, src, fps):
        """用 ffmpeg 转帧率（GPU 优先），返回新文件路径；失败返回 None"""
        ffmpeg = self.find_tool("ffmpeg")
        if not ffmpeg:
            self.append_log("未找到 ffmpeg，跳过帧率转换")
            return None
        base, _ = os.path.splitext(src)
        dst = "%s_%sfps.mkv" % (base, fps)
        if self.has_nvenc():
            vcodec = ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "18", "-b:v", "0"]
            self.append_log(">>> 使用 GPU (NVENC) 转码")
        else:
            vcodec = ["-c:v", "libx264", "-preset", "medium", "-crf", "18"]
            self.append_log(">>> 未检测到 NVENC，使用 CPU (libx264) 转码")
        cmd = [ffmpeg, "-y", "-i", src, "-vf", "fps=%s" % fps] + vcodec + ["-c:a", "copy", dst]
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    creationflags=flags)
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    self.append_log(line)
            proc.wait()
            if proc.returncode == 0 and os.path.exists(dst):
                return dst
            self.append_log("帧率转换失败 (exit %d)" % proc.returncode)
            return None
        except Exception as e:
            self.append_log("帧率转换错误: %s" % e)
            return None

    # ---------- 下载 ----------
    def start_download(self):
        url = self.url_var.get().strip()
        if not url:
            messagebox.showwarning("提示", "请粘贴视频链接")
            return
        # 代理设置即时落盘，下次启动保留
        self.cfg["proxy_mode"] = self.proxy_mode.get()
        self.cfg["proxy"] = self.proxy_var.get().strip()
        self._save_cfg()
        try:
            folder = self.resolve_target()
            fmt = self.get_fmt()
            self.append_log(">>> 分辨率档位: %s" % self.quality_var.get())
        except ValueError as e:
            messagebox.showwarning("提示", str(e))
            return
        try:
            os.makedirs(folder, exist_ok=True)
            lastfile = expand_path(self.cfg.get("lastdir_file", ""))
            if lastfile:
                with open(lastfile, "w", encoding="utf-8") as f:
                    f.write(folder)
        except Exception as e:
            messagebox.showerror("错误", "无法创建目录: %s" % e)
            return
        self.btn.configure(state="disabled")
        self.status.configure(text="下载中...")
        threading.Thread(target=self.download_worker, args=(url, folder, fmt), daemon=True).start()

    def download_worker(self, url, folder, fmt):
        template = os.path.join(folder, "%(title)s.%(ext)s")
        fps = self.fps_var.get()
        fmt_arg = fmt
        if fps in ("30", "24"):
            if "+" in fmt and "/" in fmt:
                bv_part, rest = fmt.split("+", 1)
                ba_part = rest.split("/")[0]
                fmt_arg = "%s[fps<=%s]+%s[fps<=%s]/%s" % (bv_part, fps, ba_part, fps, fmt)
            self.append_log(">>> 帧率模式: 优先下载 %sfps 原版流，无则转码兜底" % fps)

        # 下载内核：只用自带 tools/ 的官方独立版。
        # pip 安装的 yt-dlp 不含 yt-dlp-ejs 反爬脚本且版本滞后，会导致
        # YouTube 报 "n challenge solving failed / The page needs to be reloaded"，
        # 所以绝不回退到 PATH 上的其它 yt-dlp。
        ytdlp_exe = envcheck.find_ytdlp_kernel()
        if not ytdlp_exe:
            self.append_log(">>> 错误：未找到下载内核 tools/yt-dlp.exe")
            self.append_log(">>> 请切换到左侧「必需环境检测」页，点「一键安装缺失组件」")
            self.status.configure(text="缺少内核")
            self.btn.configure(state="normal")
            self.root.after(0, lambda: messagebox.showwarning(
                "缺少下载内核",
                "未找到 tools/yt-dlp.exe。\n请到左侧「必需环境检测」页点「一键安装缺失组件」。"))
            return

        cmd = [ytdlp_exe, "-o", template, "-f", fmt_arg,
               "--merge-output-format", "mkv", "--no-update"]
        ffmpeg_exe = envcheck.find_tool("ffmpeg")
        if ffmpeg_exe:
            cmd += ["--ffmpeg-location", os.path.dirname(ffmpeg_exe)]
        self.append_log(">>> 内核: %s" % ytdlp_exe)

        # JS 运行时：YouTube 现在强制要求解 n challenge（YouTube 2025 起）
        rt = envcheck.find_js_runtime()
        if rt:
            rt_name, rt_exe = rt
            cmd += ["--js-runtimes", "%s:%s" % (rt_name, rt_exe)]
            self.append_log(">>> JS 运行时: %s (%s)" % (rt_name, rt_exe))
        else:
            self.append_log(">>> 警告：未检测到 deno/node，YouTube 可能报"
                            "「n challenge solving failed」，请到环境检测页安装 deno")

        # 代理：
        #   system —— 不传参，yt-dlp 自动读取 Windows 系统代理（IE 设置）
        #   manual —— 显式传用户填的地址
        #   direct —— 传空串，强制直连（即使系统开了代理）
        proxy_mode = self.cfg.get("proxy_mode", "system")
        if proxy_mode == "manual":
            proxy = self.cfg.get("proxy", "").strip()
            if proxy:
                cmd += ["--proxy", proxy]
                self.append_log(">>> 代理: 手动指定 %s" % proxy)
            else:
                self.append_log(">>> 代理: 手动模式但未填地址，按直连处理")
        elif proxy_mode == "system":
            _url, msg = envcheck.get_system_proxy()
            self.append_log(">>> 代理: %s" % msg)
        else:
            cmd += ["--proxy", ""]
            self.append_log(">>> 代理: 直连（已禁用系统代理）")

        cookies = self.cfg.get("cookies_browser", "")
        if cookies:
            if cookies == "firefox":
                # 主动挑 cookie 库最新的 profile：profiles.ini 里的 Default 可能指向空 profile
                prof = envcheck.find_firefox_profile()
                if prof:
                    cmd += ["--cookies-from-browser", "firefox:%s" % prof]
                    self.append_log(">>> Cookies: firefox profile %s" % os.path.basename(prof))
                else:
                    self.append_log(">>> 警告：未找到含 cookies.sqlite 的 Firefox profile，跳过 cookies")
            elif cookies == "chrome" or cookies == "edge":
                cmd += ["--cookies-from-browser", cookies]
                self.append_log(">>> Cookies: %s（浏览器需完全退出，否则可能读取失败）" % cookies)
            else:
                cmd += ["--cookies-from-browser", cookies]
        cmd.append(url)

        self.append_log(">>> 开始下载: %s" % url)
        self.append_log(">>> 保存到: %s" % folder)
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    creationflags=flags)
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    self.append_log(line)
            proc.wait()
            if proc.returncode == 0:
                exts = (".mkv", ".mp4", ".webm")
                candidates = []
                try:
                    for fn in os.listdir(folder):
                        if fn.lower().endswith(exts):
                            p = os.path.join(folder, fn)
                            if os.path.isfile(p):
                                candidates.append((os.path.getmtime(p), p))
                except OSError:
                    pass
                if candidates:
                    self.last_file = max(candidates)[1]
                    fps = self.fps_var.get()
                    if fps not in ("", "0"):
                        cur = self.get_file_fps(self.last_file)
                        if cur and cur <= float(fps) + 0.5:
                            self.append_log(">>> 下载的已是 %sfps，无需转换" % cur)
                        else:
                            self.append_log(">>> 开始转换帧率到 %sfps ..." % fps)
                            self.status.configure(text="转换帧率中...")
                            new_path = self.convert_fps(self.last_file, fps)
                            if new_path:
                                self.last_file = new_path
                                self.append_log("=== 帧率转换完成: %s ===" % new_path)
                            else:
                                self.append_log("=== 帧率转换失败，保留原文件 ===")
                    self.play_btn.configure(state="normal")
                    self.prop_btn.configure(state="normal")
                    self.append_log("=== 下载完成: %s ===" % self.last_file)
                    self.status.configure(text="完成")
                else:
                    self.append_log("=== 下载完成（未找到文件）===")
                    self.status.configure(text="完成")
            else:
                self.append_log("=== 下载失败 (exit %d) ===" % proc.returncode)
                self.status.configure(text="失败")
        except Exception as e:
            self.append_log("错误: %s" % e)
            self.status.configure(text="错误")
        self.btn.configure(state="normal")
        self.root.after(0, lambda: messagebox.showinfo("完成", "下载流程已结束，请查看日志确认结果"))

    # ---------- 播放 / 属性 ----------
    def play_last(self):
        if self.last_file and os.path.exists(self.last_file):
            try:
                os.startfile(self.last_file)
            except Exception as e:
                messagebox.showerror("错误", "无法打开: %s" % e)
        else:
            messagebox.showwarning("提示", "还没有已下载的视频")

    def show_props(self):
        if not self.last_file or not os.path.exists(self.last_file):
            messagebox.showwarning("提示", "还没有已下载的视频")
            return
        fp = self.find_tool("ffprobe")
        if not fp:
            messagebox.showerror("错误", "未找到 ffprobe（ffmpeg 套件），请安装 ffmpeg")
            return
        import json as _json
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            out = subprocess.check_output(
                [fp, "-v", "error",
                 "-show_entries", "format=duration,size,bit_rate:stream=codec_name,codec_type,width,height,r_frame_rate",
                 "-of", "json", self.last_file],
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
                creationflags=flags)
            data = _json.loads(out)
        except Exception as e:
            messagebox.showerror("错误", "读取属性失败: %s" % e)
            return
        fmt = data.get("format", {})
        dur = float(fmt.get("duration", 0) or 0)
        size = int(fmt.get("size", 0) or 0)
        br = int(fmt.get("bit_rate", 0) or 0)
        streams = data.get("streams", [])
        vstream = next((s for s in streams if s.get("codec_type") == "video"), {})
        astream = next((s for s in streams if s.get("codec_type") == "audio"), {})
        mm, ss = int(dur // 60), int(dur % 60)
        lines = [
            "文件: %s" % os.path.basename(self.last_file),
            "大小: %.2f MB" % (size / 1048576.0),
            "时长: %d 分 %02d 秒" % (mm, ss),
            "分辨率: %s x %s" % (vstream.get("width", "?"), vstream.get("height", "?")),
            "视频编码: %s" % vstream.get("codec_name", "?"),
            "帧率: %s fps" % self.parse_fps(vstream.get("r_frame_rate", "0/1")),
            "音频编码: %s" % astream.get("codec_name", "无"),
            "总码率: %d kbps" % (br / 1000) if br else "总码率: ?",
        ]
        win = tk.Toplevel(self.root)
        win.title("视频属性")
        win.geometry("520x300")
        txt = tk.Text(win, font=("Microsoft YaHei", 10))
        txt.pack(fill="both", expand=True, padx=10, pady=10)
        txt.insert("1.0", "\n".join(lines))
        txt.configure(state="disabled")


class EnvPage:
    """必需环境检测页：yt-dlp / ffmpeg / deno 状态检测 + 一键安装（嵌入主窗口内容区）"""

    PAGE_BG = "#fafafa"
    CARD_BG = "#ffffff"
    FG = "#1c1c1c"
    MUTED = "#8a8a8a"
    FONT = "Microsoft YaHei UI"
    STATE_COLORS = {"ok": "#0f7b0f", "miss": "#c42b1c", "busy": "#9d5d00", "idle": "#8a8a8a"}

    def __init__(self, root, parent):
        self.root = root          # 主窗口 Tk：用于 after / messagebox
        self.cfg = load_config()
        self.info = envcheck.component_info()
        self.results = {}
        self.status_var = {}
        self.status_lbl = {}
        self.bar = {}
        self.installing = False

        page = tk.Frame(parent, bg=self.PAGE_BG)
        page.pack(fill="both", expand=True)

        # ---------- 页面头部 ----------
        head = tk.Frame(page, bg=self.PAGE_BG)
        head.pack(fill="x", padx=24, pady=(20, 14))
        tk.Label(head, text="必需环境检测", font=F_H1,
                 bg=self.PAGE_BG, fg=self.FG).pack(anchor="w")
        tk.Label(head, text="运行需要三个组件，缺失的点「一键安装缺失组件」自动补齐，无需手动装软件",
                 font=F_BODY, bg=self.PAGE_BG,
                 fg=self.MUTED).pack(anchor="w", pady=(4, 0))

        # ---------- 组件卡片 ----------
        card = ttk.Frame(page, style="Card.TFrame")
        card.pack(fill="x", padx=20)
        inner = tk.Frame(card, bg=self.CARD_BG)
        inner.pack(fill="x", padx=16, pady=14)
        tk.Label(inner, text="组件状态", font=F_H2,
                 bg=self.CARD_BG, fg=self.FG).pack(anchor="w")
        for key in envcheck.COMPONENTS:
            self._build_row(inner, key)

        # ---------- 操作按钮 ----------
        act = tk.Frame(page, bg=self.PAGE_BG)
        act.pack(fill="x", padx=24, pady=(14, 0))
        self.install_btn = ttk.Button(act, text="一键安装缺失组件",
                                      command=self.install_missing,
                                      style="Accent.TButton")
        self.install_btn.pack(side="left")
        ttk.Button(act, text="重新检测", command=self.refresh).pack(side="left", padx=(8, 0))

        # ---------- 进度与提示 ----------
        self.progress_bar = ttk.Progressbar(page, mode="determinate", maximum=1000)
        self.progress_bar.pack(fill="x", padx=24, pady=(14, 4))
        self.progress_var = tk.StringVar(value="")
        tk.Label(page, textvariable=self.progress_var, font=F_SMALL,
                 bg=self.PAGE_BG, fg=self.MUTED).pack(anchor="w", padx=24)

        self.hint_var = tk.StringVar()
        self.hint_lbl = tk.Label(page, textvariable=self.hint_var, font=F_SMALL,
                                 bg=self.PAGE_BG, fg=self.MUTED, wraplength=720,
                                 justify="left")
        self.hint_lbl.pack(anchor="w", padx=24, pady=(8, 0))

        # 后台线程 → 主线程消息队列（避免跨线程直接调 tkinter）
        self._q = queue.Queue()
        self._pump()

        self.refresh()

    def _post(self, fn):
        """后台线程安全地向主线程投递回调"""
        self._q.put(fn)

    def _pump(self):
        try:
            while True:
                fn = self._q.get_nowait()
                try:
                    fn()
                except Exception:
                    pass
        except queue.Empty:
            pass
        self.root.after(100, self._pump)

    # ---------- UI 构建 ----------
    def _build_row(self, parent, key):
        """组件状态行：名称 …… 状态 / 说明文字 / 进度条"""
        info = self.info[key]
        row = tk.Frame(parent, bg=self.CARD_BG)
        row.pack(fill="x", pady=(12, 0))
        line = tk.Frame(row, bg=self.CARD_BG)
        line.pack(fill="x")
        tk.Label(line, text=info["name"], font=(FONT, 10, "bold"),
                 bg=self.CARD_BG, fg=self.FG).pack(side="left")
        sv = tk.StringVar(value="检测中...")
        st = tk.Label(line, textvariable=sv, font=F_SMALL,
                      bg=self.CARD_BG, fg=self.STATE_COLORS["idle"])
        st.pack(side="right")
        self.status_var[key] = sv
        self.status_lbl[key] = st
        tk.Label(row, text=info["desc"], font=F_SMALL,
                 bg=self.CARD_BG, fg=self.MUTED).pack(anchor="w", pady=(2, 0))
        bar = ttk.Progressbar(row, mode="determinate", maximum=1000)
        self.bar[key] = bar

    # ---------- 检测 ----------
    def refresh(self):
        self.installing = False
        for key in self.status_var:
            self.status_var[key].set("检测中...")
            self.status_lbl[key].configure(foreground=self.STATE_COLORS["idle"])
        self.progress_bar["value"] = 0
        self.progress_var.set("正在检测本机环境...")
        threading.Thread(target=self._detect_worker, daemon=True).start()

    def _detect_worker(self):
        results = envcheck.check_all()
        self._post(lambda: self._apply_results(results))

    def _apply_results(self, results):
        self.results = results
        missing = [k for k, st in results.items() if not st["ok"]]
        for key, st in results.items():
            sv = self.status_var[key]
            if st["ok"]:
                sv.set("就绪 · %s" % st["version"])
                self.status_lbl[key].configure(foreground=self.STATE_COLORS["ok"])
            else:
                sv.set("未安装")
                self.status_lbl[key].configure(foreground=self.STATE_COLORS["miss"])
        if missing:
            self.install_btn.configure(state="normal")
            self.hint_lbl.configure(fg="#c42b1c")
            self.hint_var.set("缺少: " + "、".join(self.info[k]["name"] for k in missing) +
                              "。点击“一键安装缺失组件”自动下载（首次约需 150 MB）。" +
                              "若下载缓慢，可在 config.json 中配置 proxy 后点“重新检测”重试。")
        else:
            self.install_btn.configure(state="disabled")
            self.hint_lbl.configure(fg="#0f7b0f")
            self.hint_var.set("环境就绪，可直接在“下载”页使用")
        self.progress_var.set("")

    # ---------- 一键安装 ----------
    def install_missing(self):
        if self.installing:
            return
        missing = [k for k, st in self.results.items() if not st["ok"]]
        if not missing:
            return
        self.installing = True
        self.install_btn.configure(state="disabled")
        self.hint_var.set("")
        for key in missing:
            self.status_var[key].set("安装中...")
            self.status_lbl[key].configure(foreground=self.STATE_COLORS["busy"])
            self.bar[key].pack(fill="x", pady=(8, 0))
        threading.Thread(target=self._install_worker, args=(missing,), daemon=True).start()

    def _install_worker(self, missing):
        # 安装组件走 urllib：system 模式交给 urllib 自动读系统代理，
        # manual 模式用用户填的地址
        _mode = self.cfg.get("proxy_mode", "system")
        if _mode == "manual":
            proxy = self.cfg.get("proxy", "").strip() or None
        else:
            proxy = None
        ok_all = True
        for key in envcheck.COMPONENTS:
            if key not in missing:
                continue
            name = self.info[key]["name"]

            def _mark(text, frac, key=key, name=name):
                def _up():
                    if frac is None:
                        self.bar[key]["value"] = 0
                    else:
                        self.bar[key]["value"] = int(frac * 1000)
                    self.progress_var.set("%s: %s" % (name, text))
                self._post(_up)

            ok, msg = envcheck.install_component(
                key, proxy=proxy,
                progress=lambda t, f, key=key: _mark(t, f, key))
            if not ok:
                ok_all = False
                def _fail(key=key, msg=msg):
                    self.status_var[key].set("安装失败")
                    self.status_lbl[key].configure(foreground=self.STATE_COLORS["miss"])
                    self.hint_var.set(msg)
                self._post(_fail)
                break
        self._post(lambda: self._install_finished(ok_all))

    def _install_finished(self, ok_all):
        self.installing = False
        if ok_all:
            self.progress_var.set("全部安装完成，正在确认...")
            self.refresh()
        else:
            self.install_btn.configure(state="normal")


class MainWindow:
    """主窗口：左侧导航栏（下载 / 必需环境检测）+ 右侧内容区"""

    NAV = [("download", "下载"), ("env", "必需环境检测")]

    # Windows 11 Fluent 浅色配色
    SIDE_BG = "#f3f3f3"
    SIDE_HOVER = "#e9e9e9"
    SIDE_SEL = "#e8f0fb"
    ACCENT = "#0067c0"
    TEXT = "#1a1a1a"
    MUTED = "#8a8a8a"
    FONT = "Microsoft YaHei UI"

    def __init__(self, root):
        self.root = root
        self._current = None
        root.title("ytdlp4k - YouTube 视频下载器")
        root.geometry("1020x760")
        root.minsize(920, 640)

        body = ttk.Frame(root)
        body.pack(fill="both", expand=True)

        # ---------- 左侧导航栏 ----------
        side = tk.Frame(body, bg=self.SIDE_BG, width=196)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        tk.Label(side, text="ytdlp4k", font=F_LOGO,
                 bg=self.SIDE_BG, fg=self.TEXT).pack(anchor="w", padx=22, pady=(26, 2))
        tk.Label(side, text="YouTube 视频下载器", font=F_SMALL,
                 bg=self.SIDE_BG, fg=self.MUTED).pack(anchor="w", padx=22, pady=(0, 26))

        self.nav_rows = {}
        for key, text in self.NAV:
            row = tk.Frame(side, bg=self.SIDE_BG, cursor="hand2")
            row.pack(fill="x", padx=10, pady=2)
            bar = tk.Frame(row, bg=self.SIDE_BG, width=3)   # 左侧指示条
            bar.pack(side="left", fill="y")
            lbl = tk.Label(row, text=text, font=F_BODY,
                           bg=self.SIDE_BG, fg=self.TEXT, anchor="w",
                           padx=14, pady=11)
            lbl.pack(side="left", fill="x", expand=True)
            for w in (row, lbl):
                w.bind("<Button-1>", lambda e, k=key: self.show(k))
                w.bind("<Enter>", lambda e, k=key: self._hover(k, True))
                w.bind("<Leave>", lambda e, k=key: self._hover(k, False))
            self.nav_rows[key] = (row, bar, lbl)

        # ---------- 右侧内容区 ----------
        content = ttk.Frame(body)
        content.pack(side="left", fill="both", expand=True)
        content.grid_rowconfigure(0, weight=1)
        content.grid_columnconfigure(0, weight=1)

        self.pages = {}
        self.pages["download"] = self._make_page(content, App)
        self.pages["env"] = self._make_page(content, EnvPage)
        self.show("download")

    def _hover(self, key, on):
        if self._current == key:
            return
        row, _bar, lbl = self.nav_rows[key]
        bg = self.SIDE_HOVER if on else self.SIDE_BG
        row.configure(bg=bg)
        lbl.configure(bg=bg)

    def _make_page(self, content, page_cls):
        f = ttk.Frame(content)
        f.grid(row=0, column=0, sticky="nsew")
        inst = page_cls(self.root, f)
        inst.frame = f
        return inst

    def show(self, key):
        """切换右侧页面并高亮侧边栏当前项"""
        self._current = key
        self.pages[key].frame.tkraise()
        for k, (row, bar, lbl) in self.nav_rows.items():
            if k == key:
                row.configure(bg=self.SIDE_SEL)
                lbl.configure(bg=self.SIDE_SEL, fg=self.ACCENT,
                              font=(FONT, 10, "bold"))
                bar.configure(bg=self.ACCENT)
            else:
                row.configure(bg=self.SIDE_BG)
                lbl.configure(bg=self.SIDE_BG, fg=self.TEXT,
                              font=F_BODY)
                bar.configure(bg=self.SIDE_BG)


def main():
    root = tk.Tk()
    try:
        import sv_ttk
        sv_ttk.set_theme("light")       # Windows 11 Fluent 浅色主题
    except Exception:
        pass                            # 主题库缺失时回退到系统默认
    root.option_add("*Font", (FONT, 10))
    # ttk 控件（按钮/单选框/输入框）字体统一为微软雅黑：
    # sv-ttk 默认用 Segoe UI，中文走系统回退，字形和字号与自绘部分不统一
    _style = ttk.Style()
    for _name in ("TButton", "TRadiobutton", "TCheckbutton", "TEntry",
                  "TCombobox", "TSpinbox", "TLabelframe.Label", "TLabel"):
        try:
            _style.configure(_name, font=F_BODY)
        except Exception:
            pass
    MainWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
