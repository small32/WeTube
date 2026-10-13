# WeTube

[中文](#中文) · [English](#english)

## 中文

WeTube 是使用 Rust 编写的 YouTube 桌面应用，内建 [YouTube-Enhancer](https://github.com/YouTube-Enhancer/extension) 功能，无需另装浏览器扩展。

项目地址：[small32/WeTube](https://github.com/small32/WeTube) · 开发人：Small32 · 版本：3.0.9

### 下载与更新

从 [GitHub Releases](https://github.com/small32/WeTube/releases/latest) 下载并解压对应平台安装包：

| 平台 | 安装包 | 网页内核 |
| --- | --- | --- |
| Windows x64 | `WeTube-*-windows-x64.zip` | WebView2（Chromium / Edge） |
| macOS Apple Silicon（arm64） | `WeTube-*-macos-arm64.zip` | WKWebView（Safari） |

macOS 不再支持 Intel（x86_64）。Windows 需要 WebView2 Runtime，Windows 11 通常已自带。

通过“帮助 → 关于”查看版本、开发人和项目地址，并检查 GitHub 正式 Release。发现新版后，点击“更新”通过默认浏览器下载对应平台安装包；下载完成后退出应用，手动解压并替换旧版。

### 功能与设置

- 后退、前进、刷新、主页、全屏及自定义快捷键。
- 内建内容过滤、播放器、按钮、Shorts、播放列表、外观和高级设置；支持搜索，即时生效并自动保存。
- 通过“视图 → 增强设置”或 `Cmd/Ctrl + ,` 打开设置面板。
- 字幕设置统一为“自动开启字幕”，默认不勾选。勾选时自动开启；未勾选时新视频默认关闭，仍可手动开启。已有用户保留原来的选项状态，如需默认关闭，请取消勾选。
- 字幕双语翻译：播放器的“译”按钮可启用翻译，支持九种目标语言、只显示译文及字幕字号调整。显示按钮默认开启，翻译需手动开启。
- 视频下载：内置 yt-dlp、ffmpeg 和 QuickJS，支持格式选择与下载进度。

### 音量增强

播放器音量按钮右侧的增强按钮提供固定 **5 dB** 增益。点击开启，再次点击恢复原声，切换视频后恢复关闭。蓝色表示音频进入处理通路，黄色表示等待或失败；悬停可查看状态。播放器音量、音量记忆及滚轮音量仍控制 0–100% 音量。

macOS 14.2 及更新版本使用 Core Audio Process Tap 处理 WeTube 的 WebKit 音频进程输出，支持 AAC / Opus。首次开启需允许系统音频录制权限；音频仅实时处理，不录制或保存。无法建立通路时保持原声。Windows 使用 Web Audio 增益通路。

### 配置与日志

| 平台 | 配置文件 | 翻译日志 |
| --- | --- | --- |
| Windows | `%APPDATA%\WeTube\settings.json` | `%APPDATA%\WeTube\translate.log` |
| macOS | `~/Library/Application Support/WeTube/settings.json` | `~/Library/Application Support/WeTube/translate.log` |

翻译日志在 Release 中也会写入，超过 64 MiB 自动清空。

### 构建与验证

需要 Rust；前端回归测试需要 Node.js。仓库使用 Git LFS 存储内嵌工具，克隆后须获取真实载荷。

```sh
git clone https://github.com/small32/WeTube.git
cd WeTube
git lfs pull
npm ci
npm run verify
cargo test --locked
```

Windows 构建：`cargo build --release --locked`，产物为 `target/release/WeTube.exe`。

macOS 构建：`./scripts/build-macos-app.sh`，仅构建 arm64，产物为 `target/aarch64-apple-darwin/release/WeTube.app`。脚本包含工具下载、动态库打包和 ad-hoc 签名。

macOS 音频验证可运行 `bash scripts/verify-native-audio.sh`（需要 ffmpeg 和系统音频权限），或 `swift scripts/verify-volume-boost-webkit.swift`。后者默认使用本地 WAV 信号，不代表 YouTube 流媒体兼容性。

发布 `v*` 标签会触发 GitHub Actions，验证后构建 Windows x64 和 macOS arm64 安装包并发布 Release。

## English

WeTube is a Rust-based YouTube desktop app with built-in [YouTube-Enhancer](https://github.com/YouTube-Enhancer/extension) features. No browser extension installation is required.

Repository: [small32/WeTube](https://github.com/small32/WeTube) · Developer: Small32 · Version: 3.0.9

### Downloads and updates

Download and extract the matching package from [GitHub Releases](https://github.com/small32/WeTube/releases/latest):

| Platform | Package | Web engine |
| --- | --- | --- |
| Windows x64 | `WeTube-*-windows-x64.zip` | WebView2 (Chromium / Edge) |
| macOS Apple Silicon (arm64) | `WeTube-*-macos-arm64.zip` | WKWebView (Safari) |

Intel (x86_64) macOS is no longer supported. Windows requires WebView2 Runtime, which is usually included with Windows 11.

Open Help → About to view the version, developer, and project link, or check for a newer stable GitHub Release. Click Update to download the matching platform package through your default browser. Quit the app, extract the download, and replace the existing app manually.

### Features and settings

- Back, forward, reload, home, fullscreen, and customizable keyboard shortcuts.
- Built-in settings for content filtering, player controls, buttons, Shorts, playlists, appearance, and advanced features. Settings are searchable, apply immediately, and save automatically.
- Open settings from View → Enhancement Settings or press `Cmd/Ctrl + ,`.
- A single “Automatically enable captions” option, unchecked by default. When checked, captions turn on automatically. When unchecked, each new video starts with captions off, and captions can still be enabled manually. Existing users retain their saved setting; uncheck it to start new videos with captions off.
- Bilingual subtitle translation: use the translation button in the player to enable it. Supports nine target languages, translation-only display, and caption font sizes. The button is shown by default; translation is enabled manually.
- Video downloads with bundled yt-dlp, ffmpeg, and QuickJS, format selection, and progress reporting.

### Volume boost

The boost button next to the player's volume button provides a fixed **5 dB** gain. Click to enable it, click again to restore the original audio; it resets when changing videos. Blue indicates an active audio path, while yellow indicates waiting or failure. Hover for status. Player volume, volume memory, and wheel adjustments still control the 0–100% volume level.

On macOS 14.2 and later, Core Audio Process Tap processes audio from WeTube's WebKit audio process, supporting AAC / Opus. Grant system audio recording permission when prompted. Audio is processed live without recording or saving. The original audio is retained if the processing path cannot be established. Windows uses Web Audio.

### Configuration and logs

| Platform | Configuration | Translation log |
| --- | --- | --- |
| Windows | `%APPDATA%\WeTube\settings.json` | `%APPDATA%\WeTube\translate.log` |
| macOS | `~/Library/Application Support/WeTube/settings.json` | `~/Library/Application Support/WeTube/translate.log` |

Translation logs are also written in Release builds and cleared when they exceed 64 MiB.

### Building and testing

Rust is required; frontend regression tests also require Node.js. Bundled tools are stored with Git LFS, so fetch the actual payloads after cloning.

```sh
git clone https://github.com/small32/WeTube.git
cd WeTube
git lfs pull
npm ci
npm run verify
cargo test --locked
```

Windows: run `cargo build --release --locked`. Output: `target/release/WeTube.exe`.

macOS: run `./scripts/build-macos-app.sh`. Only arm64 is built. Output: `target/aarch64-apple-darwin/release/WeTube.app`. The script downloads tools, bundles dynamic libraries, and applies an ad-hoc signature.

For macOS audio tests, run `bash scripts/verify-native-audio.sh` (requires ffmpeg and system audio permission), or `swift scripts/verify-volume-boost-webkit.swift`. The latter uses a local WAV signal by default and does not establish YouTube streaming compatibility.

Pushing a `v*` tag triggers GitHub Actions to validate, build Windows x64 and macOS arm64 packages, and publish a Release.

## License / 许可证

GPL-3.0. Third-party attribution: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
