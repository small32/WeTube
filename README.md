# WeTube

WeTube 是一个用 Rust 写的 YouTube 桌面端App：一个装 youtube.com 的 `WKWebView` /
`WebView2`，加后退 / 前进 / 刷新三个按钮（以及更多），同时支持 macOS 和 Windows，
并把 [YouTube-Enhancer](https://github.com/YouTube-Enhancer/extension)
扩展的功能直接内建进了程序——不是让你去装扩展，是程序自带。目前内置 **43 个功能、86 项设置**（含每个功能自己的「启用」开关，其余 43 项是可调参数）。

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

- **86 项设置全部自动生成**，加一项只需要改 `src/enhancer/schema.json` 一处
- 按内容过滤 / 播放器 / 按钮 / Shorts / 播放列表 / 外观 / 高级分成 7 组，支持搜索
- 改动即时生效，自动存盘

配置存在：

| 平台    | 路径                                              |
| ------- | ------------------------------------------------- |
| macOS   | `~/Library/Application Support/WeTube/settings.json` |
| Windows | `%APPDATA%\WeTube\settings.json`                 |

**进度**：43 个功能条目已实现，部分功能受浏览器内核限制，详见下面的说明。

## 音量增强

设置 → 播放器 → **音量增强**（默认关闭）。增益默认 5 dB，可调 0–20 dB：
6 dB 约为原声的 2 倍，20 dB 约为 10 倍；较高增益可能失真。

增强按钮在播放页面始终显示，直接点击即可开启，再次点击恢复原声。
检测到音频进入处理通路后图标变蓝；等待启动、未检测到信号或启动失败时图标为黄色。
鼠标悬停或键盘聚焦按钮可查看当前状态和增益。

- **全局**：播放视频时自动应用增益。
- **逐视频**：点击播放器音量按钮右侧的闪电声波按钮开关，切换视频后恢复关闭。
- 在增强按钮上滚轮调节增益；Shift / Ctrl 加大步长。全局模式下点击按钮会转为逐视频并关闭当前增强。
- 关闭设置后恢复原声，固定音量、音量记忆和滚轮调音量仍控制播放器的 0–100% 音量。

macOS 14.2 及更新版本使用原生 **Core Audio Process Tap**，处理 WeTube 的 WebKit
音频进程输出，支持 AAC / Opus 流媒体。首次开启时，按系统提示允许系统音频录制权限；
音频仅实时处理，不录制或保存。等待授权或音频信号时保持原声，确认通路正常后才接管输出。
暂停、静音、关闭增强或离开播放页面时解除接管；恢复播放时按当前开关重新开启。
输出设备或采样率变化时重新建立通路。较早的 macOS 会显示版本要求并保留原声。

辅助进程 PID 使用 WebKit 内部接口获取，并在调用前检测接口是否存在。无法确定进程、
权限不足或设备格式不受支持时保持原声；不会按进程名猜测，也不会捕获其他应用的声音。
Windows / Linux 保留 Web Audio 增益通路。

本地验证：`pnpm run verify`；macOS 还可以运行
`swift scripts/verify-volume-boost-webkit.swift`，用原生 WKWebView 验证 6 dB 增益及恢复原声。
该原生测试使用本地 WAV 信号，不代表 YouTube 流媒体兼容性。
向脚本传入本地 AAC fragmented MP4 路径可检测 MSE 通路；复现内核缺陷时会明确报告信号缺失。
macOS 原生后端的实际流媒体测试：`bash scripts/verify-native-audio.sh`，覆盖 AAC / Opus
及 6 / 12 dB 增益、关闭恢复。需提供 ffmpeg（可用 `FFMPEG_BIN` 指定），并按系统要求授权测试应用。

实现参考 [YouTube-Enhancer 音量增强](https://github.com/YouTube-Enhancer/extension/tree/6b1a2f6384071cc995dc7e6e06f02c6d3c66da37/src/features/volumeBoost)，上游授权见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

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

## 许可证

GPL-3.0
