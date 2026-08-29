# WeTube

WeTube 是一个用 Rust 重写的 YouTube 桌面壳：一个装 youtube.com 的 `WKWebView` /
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

- **135 个可调节项全部自动生成**，加一项只需要改 `src/enhancer/schema.json` 一处
- 按内容过滤 / 播放器 / 按钮 / Shorts / 播放列表 / 外观 / 高级分成 7 组，支持搜索
- 改动即时生效，自动存盘

配置存在：

| 平台    | 路径                                              |
| ------- | ------------------------------------------------- |
| macOS   | `~/Library/Application Support/WeTube/settings.json` |
| Windows | `%APPDATA%\WeTube\settings.json`                 |

**进度**：59 个功能条目里已实现 40 个。剩下 19 个主要是播放器按钮类——它们依赖原扩展的
`buttonController`（一个 36KB 的按钮注入系统，含控制栏插槽、功能菜单、全屏重定位），
需要单独移植，见下方「尚未实现」。设置面板里未实现的功能会灰显并标注。

## 相比原版多了什么

- **工具栏**（后退 / 前进 / 刷新 / 首页 / 在系统浏览器打开），跟随系统深浅色自动换肤
  - 在 YouTube 页面里会把页面内容整体下推 40px，不遮搜索栏
  - `Cmd/Ctrl + Shift + B` 可以随时隐藏它
- **原生菜单栏**：macOS 上有标准的「关于 / 服务 / 隐藏 / 退出 / 编辑 / 窗口」菜单，
  Windows 上有「文件 / 导航 / 视图 / 帮助」
  - 没有菜单栏的 macOS 应用是没法用 `Cmd+Q`、`Cmd+C/V` 的，所以这一块是必需的
- **键盘快捷键**：`Cmd/Ctrl + R` 或 `F5` 刷新、`Cmd/Ctrl + ←/→` 或 `Alt + ←/→` 前进后退、
  `Cmd/Ctrl + Shift + H` 回首页、`F11` 全屏
- **外链不乱跑**：`target="_blank"` 和 `window.open` 一律交给系统默认浏览器，
  不会把整个壳子带走到别的网站
- **窗口标题跟着视频走**：显示成「视频标题 — WeTube」
- **Windows 图标**：`build.rs` 会把 `icons/app.ico` 嵌进 exe

## 构建

需要 Rust 1.85 以上（tao 0.37 的要求）。

### Windows

```bash
cargo build --release
# 产物：target/release/wetube.exe
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

`icons/source.ico` 是源文件（脚本会从外部拷进来）。想换图标直接覆盖源文件再跑：

```bash
python scripts/make-icons.py /路径/到/新.ico
# 或者：覆盖 icons/source.ico 后再次运行
python scripts/make-icons.py
```

要分发给别人的话，把 ad-hoc 签名换成 Developer ID 并做公证，否则对方会看到
「无法检查是否包含恶意软件」的提示。

### 图标

`icons/AppIcon.iconset/` 是 macOS 用的，直接用原版仓库的 PNG 拼的。
Windows 的 `icons/app.ico` 由这个 iconset 生成：

```bash
python scripts/make-ico.py
```

## 项目结构

```
src/main.rs              窗口、webview、菜单、IPC、配置落盘
src/config.rs            读 schema → 默认值 + 用户覆盖 → 持久化（含单元测试）
src/ui.js                WeTube 工具栏 + 页面内快捷键
src/enhancer/
  schema.json            135 个配置项的单一数据源（Rust 与 JS 共用）
  runtime.js             配置读写、事件命名空间、元素等待、播放器封装、SPA 重放
  features.js            功能实现（每个功能一个 enable/disable 对）
  panel.js               按 schema 自动生成的悬浮设置面板
  styles.css             功能 CSS（从原扩展 18 份 index.css 合并，已展开嵌套语法）
  deepdark-presets.js    32 套 DeepDark 配色（由原仓库 TS 自动生成，勿手改）
  deepdark-material.css  DeepDark 主题主体，3989 行
build.rs                 打包注入脚本、CSS 转 JS 常量、Windows 图标资源
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
的播放器，桌面壳只有一个页面，没有意义。

## 已知限制

- 工具栏的「内容下推」是针对 YouTube 当前 DOM（`#masthead-container` 等）写的 CSS，
  YouTube 改版后可能需要跟着调 `src/ui.js` 里的 `.wetube-support-shift` 规则；
  实在不喜欢就按 `Cmd/Ctrl + Shift + B` 藏起来。
- 后退 / 前进按钮的禁用状态只能粗略判断（`history.length`），SPA 下并不精确。
- Linux 上能跑（wry 支持 webkit2gtk），但没有菜单，只有工具栏和快捷键。
- 大部分功能依赖 YouTube 的 DOM class（`.ytp-*`）和播放器内部 API
  （`getVideoData` / `setPlaybackQualityRange` 等）。这些是 YouTube 的私有实现，
  改版就可能失效——原扩展也一样。凡是依赖内部 API 的地方都做了能力探测，
  拿不到就静默降级，不会让整个功能崩掉。

## 相比原扩展修掉的问题

移植时顺手修了原仓库几个已知缺陷：

- `getAudioEngine()` 首次调用必然返回 `null`（`return engine` 写在了赋值之前）
- `AudioContext` 从不 `resume()`，自动播放策略下会静音
- `OnScreenDisplayManager.handleError` 无限递归，一出错就栈溢出
- 事件管理器用强引用 `Map` 存 DOM 目标，YouTube 频繁重建节点会泄漏（改用 `WeakMap`）
- 配置信箱是单槽 + 竞态，并发请求可能永久挂起（改成同步读全局变量）
