# -*- coding: utf-8 -*-
"""
ytdlp4k v2 —— pywebview 版主程序
Python 后端（复用现有下载/环境检测逻辑）+ HTML/CSS 前端（4 套主题皮肤）

运行：python web_main.py
打包：见 build 脚本，必须 --hidden-import webview.platforms.edgechromium
"""
import os
import sys
import json
import threading

import webview

# 让 web_main.py 能 import 同目录的 ytdlp4k / envcheck 模块
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import envcheck          # 环境检测（yt-dlp / ffmpeg / deno 定位、系统代理）
import core              # 核心逻辑（无 tkinter 依赖，可跑在 Python 3.13）
load_config = core.load_config
save_config = core.save_config
QUALITY = core.QUALITY
QUALITY_ORDER = core.QUALITY_ORDER
CONFIG_PATH = core.CONFIG_PATH


def _safe_log(*args):
    """windowed 打包后无 stdout，print 会抛异常，这里兜底"""
    try:
        if sys.stdout is not None:
            print(*args)
            sys.stdout.flush()
    except Exception:
        pass


class Api:
    """暴露给前端 JS 的接口（window.pywebview.api.*）"""

    def __init__(self, window):
        self.window = window
        self.cfg = load_config()
        self._log_queue = []

    # ---------- 配置 ----------
    def get_config(self):
        return {
            "skin": self.cfg.get("skin", "dark-linear"),
            "dirs": self.cfg.get("dirs", []),
            "quality": self.cfg.get("quality", "4K"),
            "default_fps": self.cfg.get("default_fps", "0"),
            "proxy_mode": self.cfg.get("proxy_mode", "system"),
            "proxy": self.cfg.get("proxy", ""),
        }

    def _save(self, **kw):
        self.cfg.update(kw)
        save_config(self.cfg)

    def set_skin(self, skin_id):
        self._save(skin=skin_id)
        return True

    def save_quality(self, q):
        self._save(quality=q)
        return True

    def save_fps(self, fps):
        self._save(default_fps=fps)
        return True

    def save_proxy_mode(self, mode):
        self._save(proxy_mode=mode)
        return True

    def save_dirs(self, dirs):
        self.cfg["dirs"] = dirs
        save_config(self.cfg)
        return True

    # ---------- 环境检测 ----------
    def get_components(self):
        comps = []
        info_map = envcheck.component_info()
        for key in envcheck.COMPONENTS:
            info = info_map[key]
            ok = envcheck.find_tool(key) is not None
            comps.append({
                "name": info["name"],
                "desc": info["desc"],
                "ok": ok,
                "status": "已就绪" if ok else "缺失",
            })
        return comps

    # ---------- 文件选择 ----------
    def pick_folder(self):
        try:
            import tkinter as tk
            from tkinter import filedialog
            root = tk.Tk()
            root.withdraw()
            root.attributes("-topmost", True)
            path = filedialog.askdirectory(title="选择下载文件夹")
            root.destroy()
            return path or ""
        except Exception:
            return ""

    # ---------- 下载 ----------
    def start_download(self, params):
        """params: {url, dir, quality, fps, proxyMode, proxy}"""
        url = (params or {}).get("url", "").strip()
        folder = (params or {}).get("dir", "").strip()
        quality = (params or {}).get("quality", "4K")
        fps = (params or {}).get("fps", "0")
        proxy_mode = (params or {}).get("proxyMode", "system")
        proxy = (params or {}).get("proxy", "").strip()

        self._save(proxy_mode=proxy_mode, proxy=proxy)

        if not url:
            self._log("请先粘贴视频链接", "err")
            return False
        if not folder:
            self._log("请先为分类设置保存文件夹", "err")
            return False

        try:
            os.makedirs(folder, exist_ok=True)
        except Exception as e:
            self._log("无法创建目录: %s" % e, "err")
            return False

        threading.Thread(target=self._download_worker,
                         args=(url, folder, quality, fps, proxy_mode, proxy),
                         daemon=True).start()
        return True

    def _download_worker(self, url, folder, quality, fps, proxy_mode, proxy):
        try:
            self._log(">>> 开始下载", "dim")
            self._log(">>> 链接: %s" % url[:80], "dim")
            self._log(">>> 画质: %s | 帧率: %s | 目录: %s" % (quality, fps, folder), "dim")

            # 下载内核：只用自带 tools/ 官方独立版（含 EJS 反爬脚本）
            ytdlp_exe = envcheck.find_ytdlp_kernel()
            if not ytdlp_exe:
                self._log("错误：未找到下载内核 tools/yt-dlp.exe", "err")
                self._log("请到「环境检测」页点「一键安装缺失组件」", "err")
                return

            fmt = QUALITY.get(quality, QUALITY["4K"])
            template = os.path.join(folder, "%(title)s.%(ext)s")
            cmd = [ytdlp_exe, "-o", template, "-f", fmt,
                   "--merge-output-format", "mkv", "--no-update",
                   "--newline"]  # --newline 让进度逐行输出

            ffmpeg_exe = envcheck.find_tool("ffmpeg")
            if ffmpeg_exe:
                cmd += ["--ffmpeg-location", os.path.dirname(ffmpeg_exe)]

            # JS 运行时（YouTube n challenge 反爬必需）
            rt = envcheck.find_js_runtime()
            if rt:
                rt_name, rt_exe = rt
                cmd += ["--js-runtimes", "%s:%s" % (rt_name, rt_exe)]
                self._log(">>> JS 运行时: %s" % rt_name, "dim")
            else:
                self._log(">>> 警告：未检测到 deno/node，YouTube 可能下载失败", "warn")

            # 代理
            if proxy_mode == "manual" and proxy:
                cmd += ["--proxy", proxy]
                self._log(">>> 代理: 手动 %s" % proxy, "dim")
            elif proxy_mode == "direct":
                cmd += ["--proxy", ""]
                self._log(">>> 代理: 直连", "dim")
            else:
                _u, msg = envcheck.get_system_proxy()
                self._log(">>> 代理: %s" % msg, "dim")

            flags = getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0)
            import subprocess
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
                creationflags=flags)

            for line in proc.stdout:
                line = line.strip()
                if not line:
                    continue
                cls = "dim"
                if "[download]" in line and "%" in line:
                    cls = "ok" if "100%" in line else ""
                self._log(line, cls)
            proc.wait()
            if proc.returncode == 0:
                self._log(">>> 下载完成 ✓", "ok")
            else:
                self._log(">>> 下载失败 (exit %d)" % proc.returncode, "err")
        except Exception as e:
            self._log("下载错误: %s" % e, "err")

    # ---------- 日志推送到前端 ----------
    def _log(self, text, cls=""):
        try:
            if self.window:
                self.window.evaluate_js(
                    "appendLog(%s, %s)" % (json.dumps(text), json.dumps(cls)))
        except Exception:
            pass


def main():
    # 前端：读内联 HTML（CSS/JS 全部内联，避免 file:// 相对路径问题，也方便打包单文件）
    base = getattr(sys, "_MEIPASS", HERE)
    inline = os.path.join(base, "web", "index_inline.html")
    if not os.path.exists(inline):
        inline = os.path.join(HERE, "web", "index_inline.html")
    with open(inline, encoding="utf-8") as f:
        html = f.read()
    _safe_log("前端 HTML:", inline, "(%d 字节)" % len(html))

    api = Api(None)          # 先建 Api，window 引用稍后回填
    window = webview.create_window(
        "ytdlp4k - YouTube 视频下载器",
        html=html,
        js_api=api,
        width=1020, height=720,
    )
    api.window = window      # 回填，供 _log 推送到前端
    webview.start()


if __name__ == "__main__":
    main()
