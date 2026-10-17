# 发版 / 在线更新说明

应用里的「设置 → 软件更新 → 检查更新」会去这个固定地址读版本清单：

```
https://github.com/jackyzbn-eng/FallenAngels_ytdlp4k/releases/latest/download/latest.yml
```

`releases/latest/download/` 永远指向**最新一个正式发布**（不是草稿）的附件，所以地址不用改，
发新版只要把两个文件传上去。

## 每次发版的步骤

1. 改版本号（`electron/package.json` 的 `version`），然后打包：

   ```bash
   cd electron
   CODEBUDDY_SAFE_DELETE_ENABLED=0 npx electron-builder --win --x64 --publish never
   ```

   产物在 `electron/dist/`：

   - `FallenAngels_setup_<版本>.exe` ← 安装包
   - `latest.yml` ← **版本清单，必须一起传**
   - `FallenAngels_setup_<版本>.exe.blockmap` ← 差分更新用（可选，一起传更省流量）

2. 到 https://github.com/jackyzbn-eng/FallenAngels_ytdlp4k/releases/new 新建 Release：

   - Tag 用 `v<版本>`（例如 `v2.21.0`）
   - **勾上「Set as the latest release」**，别存成 Draft（草稿不算 latest，检查更新会 404）
   - 把上面三个文件**都拖进附件区**

3. 完成后，旧版本点「检查更新」就能看到新版；下载完点「立即重启安装」即可。

## 如果国内下载太慢

设置页「软件更新 → 更新源」可以改成自己的静态地址（比如 Cloudflare R2 的公开域名）。
只要那个地址下有 `latest.yml` + 安装包，格式和 GitHub 那份完全一样，改了立刻生效，不用重新打包。

## 已实现的细节

- 进度条 + 可取消的下载；下载完自动校验 `sha512`（清单里带的）
- 安装前如果还有下载/转码任务在跑，会提醒「重启会中断它们」
- 下载完没立刻安装的话，退出应用时会顺手装上（`autoInstallOnAppQuit`）
- 报错会翻成人话：连不上（提示开代理）/ 没有 latest.yml / 校验不通过
