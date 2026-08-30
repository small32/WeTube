# WeTube

WeTube 是一个用 Rust 写的 YouTube 桌面端App：一个装 youtube.com 的 `WKWebView` /
`WebView2`，加后退 / 前进 / 刷新三个按钮（以及更多），同时支持 macOS 和 Windows，
并把 [YouTube-Enhancer](https://github.com/YouTube-Enhancer/extension)
扩展的 **58 个功能、135 个可调节项**直接内建进了程序——不是让你去装扩展，是程序自带。

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

## 内建的 YouTube-Enhancer

原扩展是三层架构：background / content script / embedded。功能代码全在 embedded 层，
本来就**没有 `chrome.*` 权限**——它靠两个隐藏 div 做「信箱」跟扩展通信。所以搬过来
很自然：信箱换成同步的 `window.__YTE.config`，落盘交给 Rust 走 IPC。

点工具栏最右边的齿轮（或按 `Cmd/Ctrl + ,`）打开设置面板：

- **136 个可调节项全部自动生成**，加一项只需要改 `src/enhancer/schema.json` 一处
- 按内容过滤 / 播放器 / 按钮 / Shorts / 播放列表 / 外观 / 高级分成 7 组，支持搜索
- 改动即时生效，自动存盘

配置存在：

| 平台    | 路径                                              |
| ------- | ------------------------------------------------- |
| macOS   | `~/Library/Application Support/WeTube/settings.json` |
| Windows | `%APPDATA%\WeTube\settings.json`                 |

**进度**：60 个功能条目里已实现 41 个。剩下 19 个主要是播放器按钮类——它们依赖原扩展的
`buttonController`（一个 36KB 的按钮注入系统，含控制栏插槽、功能菜单、全屏重定位），
需要单独移植，见下方「尚未实现」。设置面板里未实现的功能会灰显并标注。

## 相比原版多了什么

- **工具栏**（后退 / 前进 / 刷新 / 首页 / 在系统浏览器打开），跟随系统深浅色自动换肤
  - 在 YouTube 页面里会把页面内容整体下推 40px，不遮搜索栏
- **原生菜单栏**：macOS 上有标准的「关于 / 服务 / 隐藏 / 退出 / 编辑 / 窗口」菜单，
  Windows 上有「文件 / 导航 / 视图 / 帮助」
  - 没有菜单栏的 macOS 应用是没法用 `Cmd+Q`、`Cmd+C/V` 的，所以这一块是必需的
- **键盘快捷键**：`Cmd/Ctrl + R` 或 `F5` 刷新、`Cmd/Ctrl + ←/→` 或 `Alt + ←/→` 前进后退、
  `Cmd/Ctrl + Shift + H` 回首页、`F11` 全屏
  - 除 `F5` / `Alt + ←/→` 这几个浏览器惯例别名外，全部可以自己改，见下方「快捷键设置」
- **全屏联动**：播放页上窗口全屏和播放器全屏是绑定的——按 `F11` 或菜单里的
  「切换全屏」，视频会跟着真正铺满；点播放器自己的全屏按钮，窗口也会一并全屏。
  非播放页（首页、订阅页）只切窗口全屏。
- **外链不乱跑**：`target="_blank"` 和 `window.open` 一律交给系统默认浏览器，
  不会把整个壳子带走到别的网站
- **窗口标题跟着视频走**：显示成「视频标题 — WeTube」
- **Windows 图标**：`build.rs` 会把 `icons/app.ico` 嵌进 exe

## 构建

需要 Rust 1.85 以上（tao 0.37 的要求）。

### Windows

```bash
cargo build --release
# 产物：target/release/WeTube.exe
```

> 图标嵌入需要 Windows SDK 里的 `rc.exe`（装了 MSVC 生成工具就有了）。
> 找不到也只是没有图标，照样能编译和运行。

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

## 项目结构

```
src/main.rs              窗口、webview、菜单、IPC、配置落盘
src/config.rs            读 schema → 默认值 + 用户覆盖 → 持久化（含单元测试）
src/shortcuts.rs         可自定义快捷键的注册表 + spec 解析/序列化（含单元测试）
src/titlebar.js          自定义窗口 chrome（工具栏 + 菜单条 + 窗口控制）
                         注：macOS 上不渲染，见上文「构建」
src/ui.js                YouTube 内容下推避让 + 页面内快捷键分发（按注册表）
src/shortcut-panel.js    快捷键设置面板
src/enhancer/
  schema.json            135 个配置项的单一数据源（Rust 与 JS 共用）
  runtime.js             配置读写、事件命名空间、元素等待、播放器封装、SPA 重放
  features.js            功能实现（每个功能一个 enable/disable 对）
  panel.js               按 schema 自动生成的悬浮设置面板
  styles.css             功能 CSS（从原扩展 18 份 index.css 合并，已展开嵌套语法）
  deepdark-presets.js    32 套 DeepDark 配色（由原仓库 TS 自动生成，勿手改）
  deepdark-material.css  DeepDark 主题主体，3989 行
build.rs                 打包注入脚本、CSS 转 JS 常量、Windows 图标资源
scripts/
  build-macos-app.sh     macOS 构建并打包成 .app
  make-icons.py          从源 ico 生成 app.ico 与 AppIcon.iconset
  verify-platform-ui.js  三平台 UI 差异校验（jsdom，改完前端跑一遍）
  verify-shortcuts.js    快捷键面板功能验证（jsdom，20 项断言）
  verify-fullscreen.js   播放器全屏联动验证（jsdom，8 项断言）
icons/
  source.ico             源图标
  app.ico                Windows 嵌入用
  AppIcon.iconset/*.png  macOS iconset
```

## 尚未实现（19 个）

这些功能在设置面板里**配置齐全但灰显标注**，等对应基础设施落地后即可启用：

| 卡在什么上 | 功能 |
| ---------- | ---- |
| 需要移植 `buttonController`（播放器按钮注入系统：4 种插槽、功能菜单、全屏重定位） | `playbackSpeedButtons` `forwardRewindButtons` `loopButton` `maximizePlayerButton` `miniPlayerButton` `copyTimestampUrlButton` `screenshotButton` `openTranscriptButton` `hideEndScreenCardsButton` `flipVideoButtons` `saveToWatchLaterButton` `featureMenu` |
| 需要移植 `audioEngine`（WebAudio 图） | `volumeBoost` `monoToStereoButton` |
| 复杂 DOM 注入 | `miniPlayer` `timestampPeek` `playlistLength` `playlistReverseButton` `playlistManagementButtons` |

顺带一提，原扩展的 `pauseBackgroundPlayers` 我没搬——它的作用是暂停**其他标签页**
的播放器，桌面端App只有一个页面，没有意义。

## 已知限制

- 工具栏的「内容下推」是针对 YouTube 当前 DOM（`#masthead-container` 等）写的 CSS，
  YouTube 改版后可能需要跟着调 `src/ui.js` 里的 `.wetube-support-shift` 规则。
- 后退 / 前进按钮的禁用状态只能粗略判断（`history.length`），SPA 下并不精确。
- Linux 上能跑（wry 支持 webkit2gtk），但没有菜单，只有工具栏和快捷键。
- 大部分功能依赖 YouTube 的 DOM class（`.ytp-*`）和播放器内部 API
  （`getVideoData` / `setPlaybackQualityRange` 等）。这些是 YouTube 的私有实现，
  改版就可能失效——原扩展也一样。凡是依赖内部 API 的地方都做了能力探测，
  拿不到就静默降级，不会让整个功能崩掉。
