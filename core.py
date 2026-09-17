# -*- coding: utf-8 -*-
"""
ytdlp4k 核心逻辑（无 GUI 依赖）
供 tkinter 版（ytdlp4k.pyw）和 pywebview 版（web_main.py）共用。

只含：路径定位、配置读写、画质档位。不 import tkinter / webview。
"""
import json
import os

import envcheck

APP_NAME = "ytdlp4k"
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

DEFAULT_CONFIG = {
    "skin": "dark-linear",             # 主题皮肤：light-cindy / dark-linear / light-motrix / dark-neon
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
        return cfg
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))


def save_config(cfg):
    """写回 config.json"""
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def expand_path(p):
    if not p:
        return p
    return os.path.expanduser(os.path.expandvars(p))
