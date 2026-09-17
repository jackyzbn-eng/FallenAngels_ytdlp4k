# -*- coding: utf-8 -*-
"""ytdlp4k 一键打包脚本（带版本号）

用法：
    python build_release.py 1.0.1

流程：
    1. 把版本号写入 installer/ytdlp4k.iss 的 MyAppVersion
    2. PyInstaller 打包 dist/ytdlp4k.exe
    3. ISCC 编译安装包 installer/output/ytdlp4k_setup_v<版本>.exe
    4. 复制到桌面（文件名带版本号）

注意：本脚本**只做本地构建**，不推送 GitHub、不发 Release。
     对外发布要等用户明确指示，且版本号由用户指定。
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ISS = os.path.join(ROOT, "installer", "ytdlp4k.iss")
OUTPUT_DIR = os.path.join(ROOT, "installer", "output")
DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")

PYTHON = r"C:\Users\jacky\AppData\Local\Programs\Python\Python314\python.exe"
ISCC = r"C:\Users\jacky\AppData\Local\Programs\Inno Setup 6\ISCC.exe"


def set_version(ver):
    """把版本号写进 iss（保持单一来源）"""
    with open(ISS, encoding="utf-8") as f:
        text = f.read()
    new, n = re.subn(r'(#define MyAppVersion ")[^"]*(")', r"\g<1>%s\g<2>" % ver, text)
    if n != 1:
        raise SystemExit("未能定位 iss 中的 MyAppVersion（匹配 %d 处）" % n)
    with open(ISS, "w", encoding="utf-8") as f:
        f.write(new)
    print("1) 版本号已写入 installer/ytdlp4k.iss -> %s" % ver)


def run(cmd, desc):
    print("   %s ..." % desc)
    r = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        print((r.stdout or "")[-1500:])
        print((r.stderr or "")[-1500:])
        raise SystemExit("失败: %s" % desc)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit("请提供版本号，例如：python build_release.py 1.0.1")

    ver = sys.argv[1].strip().lstrip("vV")
    print("=== 构建 ytdlp4k v%s ===" % ver)
    set_version(ver)

    run([PYTHON, "-m", "PyInstaller", "--noconfirm", "--clean", "ytdlp4k.spec"],
        "PyInstaller 打包主程序")
    print("2) 主程序完成: dist/ytdlp4k.exe")

    run([ISCC, ISS], "Inno Setup 编译安装包")
    setup = os.path.join(OUTPUT_DIR, "ytdlp4k_setup_v%s.exe" % ver)
    if not os.path.isfile(setup):
        raise SystemExit("未找到安装包产物: %s" % setup)
    print("3) 安装包完成: %s" % setup)

    dest = os.path.join(DESKTOP, os.path.basename(setup))
    shutil.copy2(setup, dest)
    print("4) 已放到桌面: %s (%.1f MB)" % (dest, os.path.getsize(dest) / 1048576.0))
    print("\n=== 完成（仅本地构建，未推送 GitHub）===")


main()
