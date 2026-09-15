# WeTube

WeTube 是一个用 Rust 写的 YouTube 桌面端App：一个装 youtube.com 的 `WKWebView` /
`WebView2`，加后退 / 前进 / 刷新三个按钮（以及更多），同时支持 macOS 和 Windows，
并把 [YouTube-Enhancer](https://github.com/YouTube-Enhancer/extension)
扩展的功能直接内建进了程序——不是让你去装扩展，是程序自带。目前内置 **42 个功能、81 个可调节项**。

| 平台   | 网页内核                    | 说明                                   |
| ------ | --------------------------- | -------------------------------------- |
| macOS  | WKWebView（Safari 同内核）  | 和原版体验一致，系统自带，无需额外安装 |
| Windows| WebView2（Chromium / Edge） | Windows 11 自带；Win10 多半也已带      |

技术选型（都是 Tauri 底层的库，跟 SwiftUI + WebKit 一一对应）：

- `tao` — 窗口（winit 的分支）
- `wry` — WebView（macOS → WKWebView，Windows → WebView2）
- `muda` — 原生菜单栏（macOS 顶部菜单栏 / Windows 窗口菜单栏）
- `open` — 用系统默认浏览器打开外链
- `dark-light` — 启动时读取系统深浅色，避免白屏闪烁
- `serde_json` / `dirs` — 增强功能的配置持久化
- `minreq` — 字幕翻译的 HTTP 客户端（同步，走系统 TLS，不引入异步运行时）

## 内建的 YouTube-Enhancer

原扩展是三层架构：background / content script / embedded。功能代码全在 embedded 层，
本来就**没有 `chrome.*` 权限**——它靠两个隐藏 div 做「信箱」跟扩展通信。所以搬过来
很自然：信箱换成同步的 `window.__YTE.config`，落盘交给 Rust 走 IPC。

点工具栏最右边的齿轮（或按 `Cmd/Ctrl + ,`）打开设置面板：

- **81 个可调节项全部自动生成**，加一项只需要改 `src/enhancer/schema.json` 一处
- 按内容过滤 / 播放器 / 按钮 / Shorts / 播放列表 / 外观 / 高级分成 7 组，支持搜索
- 改动即时生效，自动存盘

配置存在：

| 平台    | 路径                                              |
| ------- | ------------------------------------------------- |
| macOS   | `~/Library/Application Support/WeTube/settings.json` |
| Windows | `%APPDATA%\WeTube\settings.json`                 |

**进度**：42 个功能条目全部已实现，设置面板里每一项都能正常生效。

## 字幕双语翻译

设置面板 → **播放器** 分组最上方，默认开启，目标语言默认简体中文。打开视频后播放器
控制栏会多一个「译」按钮，点一下把 YouTube 原生字幕实时翻成目标语言，译文排在原文下方。

| 可调项         | 说明                                                   |
| -------------- | ------------------------------------------------------ |
| 显示翻译按钮   | 默认开                                                 |
| 目标语言       | 简中 / 繁中 / 英 / 日 / 韩 / 法 / 德 / 西 / 俄，共 9 种 |
| 只显示译文     | 用译文替换原文，默认关                                 |
| 字幕字号       | 小 / 标准 / 大 / 特大 / 超大                           |

顺带在「内容过滤」分组加了「隐藏翻译评论按钮」（默认关），用来去掉评论下方的
「翻译」按钮——它跟字幕翻译是两回事，容易混。

### 翻译日志

排障时看这里（跟设置文件同一个目录）：

| 平台    | 路径                                                     |
| ------- | -------------------------------------------------------- |
| macOS   | `~/Library/Application Support/WeTube/translate.log`     |
| Windows | `%APPDATA%\WeTube\translate.log`                        |

每行形如 `[1788763825] batch-done id=7 ok=30/30`，超过 64 MiB 自动清空重来。
release 版也写——之前排查「批量全败但零错误记录」的教训就是诊断日志不能只在 debug 下生效。

## 相比原版多了什么

- **工具栏**（后退 / 前进 / 刷新 / 首页 / 在系统浏览器打开），跟随系统深浅色自动换肤
  - 在 YouTube 页面里会把页面内容整体下推 40px，不遮搜索栏
- **原生菜单栏**：macOS 上有标准的「关于 / 服务 / 隐藏 / 退出 / 编辑 / 窗口」菜单，
  Windows 上有「文件 / 导航 / 视图 / 帮助」
  - 没有菜单栏的 macOS 应用是没法用 `Cmd+Q`、`Cmd+C/V` 的，所以这一块是必需的
- **键盘快捷键**：`Cmd/Ctrl + R` 或 `F5` 刷新、`Cmd/Ctrl + ←/→` 或 `Alt + ←/→` 前进后退、
  `Cmd/Ctrl + Shift + H` 回首页、`F11` 全屏
  - 除 `F5` / `Alt + ←/→` 这几个浏览器惯例别名外，全部可以自己改，见下方「快捷键设置」
- **全屏联动（单向）**：点播放器自己的全屏按钮时，App 窗口会一并全屏，退出时
  跟着还原。
  反方向没做：按 `F11` 或菜单里的「切换全屏」只切窗口全屏，视频仍是页面里的
  常规尺寸，需要再点一下播放器的全屏按钮。原因是合成调用拿不到用户激活，
  WebKit 会拒绝 `requestFullscreen()`；用 CSS 兜底的方案试过，副作用太多，已回退。
- **外链不乱跑**：`target="_blank"` 和 `window.open` 一律交给系统默认浏览器，
  不会把整个壳子带走到别的网站
- **自定义滚动条（Windows）**：WebView2 默认启用 Fluent 覆盖式滚动条，
  `::-webkit-scrollbar` 那一套会被整体忽略，只能用 `scrollbar-width: none` 藏。
  所以视口原生滚动条隐藏后，在标题栏下方自绘了一条 Windows 风格的：支持拖拽、
  点轨道翻页、跟随深色模式、全屏时自动隐藏
- **字幕双语翻译**：播放器控制栏注入「译」按钮，实时把字幕翻成 9 种语言之一，
  详见上面的「字幕双语翻译」
- **窗口标题跟着视频走**：显示成「视频标题 — WeTube」
- **Windows 图标**：`build.rs` 会把 `icons/app.ico` 嵌进 exe

## 构建

需要 Rust 1.85 以上（tao 0.37 的要求）。

### Windows

```powershell
# 先把外置工具取到 vendor/（版本 pin 死 + SHA256 校验），构建时会被内嵌
powershell -ExecutionPolicy Bypass -File scripts/fetch-bundled-tools-windows.ps1
cargo build --release
# 产物：target/release/WeTube.exe（单文件，含内嵌的 yt-dlp + ffmpeg）
```

> **外置工具内嵌**：Windows 版把 `vendor/yt-dlp.exe`（约 17MB）和 `vendor/ffmpeg.exe`
> （约 98MB）用 `include_bytes!` 编进产物，运行时解到
> `%LOCALAPPDATA%\WeTube\bin\<工具>-<版本>.exe` 再执行——对外只有一个 exe。
> 解出后按版本名复用，升级会换新文件并清掉旧副本；没跑 fetch 脚本也能构建，
> 只是不内嵌，运行时退回 exe 同目录 / PATH 查找。`vendor/` 不入库（见 `.gitignore`）。
>
> 为什么要 ffmpeg：YouTube 1080p 以上的音视频是**两条分离的流**，下载后必须用
> ffmpeg 合并成带声音的 MP4；没有它就只能下 ≤720p 的渐进式单文件。
>
> 图标嵌入需要资源编译器：Windows 上用 SDK 里的 `rc.exe`（装了 MSVC 生成工具就有），
> 从 macOS / Linux 交叉编译时用 MinGW 的 `windres`（可用 `WINDRES` 环境变量指定路径）。
> 找不到也只是没有图标，照样能编译和运行。
>
> 交叉编译：`rustup target add x86_64-pc-windows-gnu && cargo build --release --target x86_64-pc-windows-gnu`。
> 判断目标系统走的是 `CARGO_CFG_TARGET_OS` 环境变量——`build.rs` 里的
> `#[cfg(target_os)]` 判断的是**宿主**而不是目标，用它会让交叉编译时图标整个跳过。
> 内嵌 yt-dlp 只对 Windows 目标生效，其他平台落空实现（macOS 走 `.app` 的 `Resources/bin`）。

### macOS

```bash
./scripts/build-macos-app.sh                          # 打本机架构
./scripts/build-macos-app.sh aarch64-apple-darwin     # Apple Silicon
./scripts/build-macos-app.sh x86_64-apple-darwin      # Intel
# 产物：target/<target>/release/WeTube.app
```

脚本会做这几件事：`cargo build --release` → 组装 `.app` 目录 → 用 `iconutil`
把 `icons/AppIcon.iconset` 转成 `AppIcon.icns` → 生成 `Info.plist` → ad-hoc 签名。
图标来自 `Dakirby309-Simply-Styled-YouTube.ico`，通过 `scripts/make-icons.py` 一次性
生成 ico 和 iconset。

### 图标

`icons/source.ico` 是源文件。想换图标，覆盖它（或直接指定路径）后跑一次：

```bash
python scripts/make-icons.py /路径/到/新.ico   # 顺便存进 icons/source.ico
# 或者：覆盖 icons/source.ico 后再次运行
python scripts/make-icons.py
```

一次生成两份产物。脚本不依赖 ImageMagick / PIL，标准库就能跑：

| 产物 | 用途 | 怎么来的 |
| ---- | ---- | -------- |
| `icons/app.ico` | Windows 嵌进 exe | 源文件原样复制（已含 9 个尺寸） |
| `icons/AppIcon.iconset/*.png` | macOS 打包，`iconutil` 的输入 | 由源文件最大尺寸插值生成，10 个文件 |

要分发给别人的话，把 ad-hoc 签名换成 Developer ID 并做公证，否则对方会看到
「无法检查是否包含恶意软件」的提示。

## 快捷键设置

「视图」菜单里「增强设置…」上方那项（默认 `Cmd/Ctrl + Shift + K`），打开后可以
自己改导航和视图两个菜单里的快捷键：

| 菜单 | 能改的项 |
| ---- | -------- |
| 导航 | 后退 / 前进 / 刷新 / 回到首页 / 在系统浏览器中打开 |
| 视图 | 快捷键设置 / 增强设置 / 切换全屏 |

点「更改」后直接按下新组合即可，`Esc` 取消。主键必须带 `Cmd` / `Ctrl` / `Alt` /
`Shift` 中的至少一个（`F1`–`F12` 除外），否则在 YouTube 里打个字都会触发功能。
跟已有快捷键撞了会提示，但仍然按你的设置保存。

**「编辑」和「窗口」菜单改不了**，这是 muda 的限制：那些是 `PredefinedMenuItem`，
muda 没给它 `set_accelerator`。它们走的是系统 responder 链——焦点在哪个输入框，
`Cmd+V` 就作用在哪个输入框，自己实现反而会弄坏粘贴
（浏览器里 `document.execCommand('paste')` 是被禁的）。

自定义值存在 `settings.json` 的 `shortcuts` 里，`spec` 格式是 `Mod+Shift+KeyH`：
`Mod` 是平台主键（macOS 的 Command / Windows 的 Control），主键用 `Code` 的
Debug 名，跟 JS 的 `KeyboardEvent.code` 一致。

## 已知限制

- 工具栏的「内容下推」是针对 YouTube 当前 DOM（`#masthead-container` 等）写的 CSS，
  YouTube 改版后可能需要跟着调 `src/ui.js` 里的 `.wetube-support-shift` 规则。
- 后退 / 前进按钮的禁用状态只能粗略判断（`history.length`），SPA 下并不精确。
- Linux 上能跑（wry 支持 webkit2gtk），但没有菜单，只有工具栏和快捷键。
- 大部分功能依赖 YouTube 的 DOM class（`.ytp-*`）和播放器内部 API
  （`getVideoData` / `setPlaybackQualityRange` 等）。这些是 YouTube 的私有实现，
  改版就可能失效——原扩展也一样。凡是依赖内部 API 的地方都做了能力探测，
  拿不到就静默降级，不会让整个功能崩掉。
- 字幕翻译依赖公共翻译端点（微软 Edge，Google 兜底），需要能联网。共享出口 IP
  有被限流的可能，失败时只是不显示译文，字幕原文不受影响。译文是机器翻译，
  专有名词和口语会翻得比较生硬。

## 许可证

GPL-3.0
