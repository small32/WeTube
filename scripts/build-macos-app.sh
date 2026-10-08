#!/usr/bin/env bash
# 在 macOS 上构建并打包成 WeTube.app。
#
#   ./scripts/build-macos-app.sh            # 打本机架构
#   ./scripts/build-macos-app.sh aarch64-apple-darwin
#   ./scripts/build-macos-app.sh x86_64-apple-darwin
# Intel 构建需在构建机上安装 x86_64 版 ffmpeg 与 qjs（或 Universal 版）。
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="WeTube"
TARGET="${1:-}"
ICONSET="icons/AppIcon.iconset"

# 打包进 Resources 的 yt-dlp / ffmpeg 版本（pin 死，保证构建可复现）。
# 升级只改这几行 + 对应哈希；哈希对不上会直接构建失败，防止供应链投毒。
# 来源与许可：
#   yt-dlp  —— 官方 stable release（PyInstaller 打包，整体 GPLv3+，与本项目 GPL-3.0 兼容）。
#              每次构建都自动查 GitHub API 对比 pin 版本与最新 stable，
#              不是最新就自动改 pin 重入构建（YTDLP_AUTO_UPDATE=0 可关掉只提示）。
YTDLP_VERSION="2026.08.19"
YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos"
YTDLP_MACOS_SHA256="0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202"
#   ffmpeg  —— osxexperts.net 静态构建（GPLv3，含 x264/x265 编码器）
#
# ⚠️ ffmpeg 这两条地址是 osxexperts 的**无版本号直链**：上游发新版是原地替换同名
#    文件，所以这里 pin 死的 SHA256 迟早会对不上，`fetch_tool` 会直接中止构建
#    （这是刻意的 fail-closed）。届时先按 URL 打开看看是不是换版本了，再更新：
#      1. 改本文件头部这两对 URL/SHA256；
#      2. `release.yml` 的「准备 Intel(x86_64) 外置工具」步骤不再自己硬编码，
#         它 `source` 本文件头部的 FFMPEG_INTEL_* —— 所以只要改这一处。
#    临时绕过（别长期用）：同名环境变量覆盖，例如
#      FFMPEG_ARM_SHA256=<新哈希> FFMPEG_ARM_URL=<新地址> ./scripts/build-macos-app.sh
#
# ⚠️ 版本偏斜：Intel 仍停在 ffmpeg 8。osxexperts 只出 ffmpeg9arm.zip，
#    没有对应版本的 Intel 包（ffmpeg9intel.zip 实测 404），所以两个架构的
#    ffmpeg 主版本不同。yt-dlp 用到的合并/remux/提音频参数在 8/9 上行为一致，
#    但评估画质/编码行为的问题时要记得这一层差异。上游哪天补了 Intel 版，
#    把 FFMPEG_INTEL_* 换过去即可（记得同时换 zip 与解出二进制的哈希）。
FFMPEG_ARM_URL="${FFMPEG_ARM_URL:-https://www.osxexperts.net/ffmpeg9arm.zip}"
FFMPEG_ARM_SHA256="${FFMPEG_ARM_SHA256:-d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9}"
# Intel 版只被 release.yml 使用（脚本的 Intel 分支要求构建机 PATH 里有
# x86_64 ffmpeg）。哈希是**下载的那个 zip** 的，不是解出来的 ffmpeg 的。
FFMPEG_INTEL_URL="${FFMPEG_INTEL_URL:-https://www.osxexperts.net/ffmpeg80intel.zip}"
FFMPEG_INTEL_SHA256="${FFMPEG_INTEL_SHA256:-2d24d22db78c87f394a5822867acd5c5dc5e762cd261a44bd26923f3a5af3e07}"
# qjs —— QuickJS-NG 的 JS runtime（EJS）：YouTube 播放器挑战需要跑 JS，
# 没有它 yt-dlp 会报 "No supported JavaScript runtime" 警告。
# 用 ~1MB 的 QuickJS 替代 ~81MB 的 deno（yt-dlp 官方支持，要求 QuickJS-NG
# ≥ 0.12.0，旧版无优化会慢到几分钟）。许可 MIT，与 GPL 兼容。
QJS_VERSION="0.16.2"
QJS_URL="https://github.com/quickjs-ng/quickjs/releases/download/v${QJS_VERSION}/qjs-darwin-arm64"
QJS_SHA256="f6200e9856c45578a5d42ac873a32f3f994b421e29df9f63b452d9c7145015fc"
# 注：不打包 ffprobe。App 代码从不直接调它，yt-dlp 拿不到 ffprobe 会自动
# 退回用 ffmpeg 解析（实测合并/remux/提音频都正常），省下 50MB。

# ---- yt-dlp stable 版本检查：每次构建都查最新 stable，不是最新就自动更新 ----
#
#   默认：发现新 stable 时自动下载、算哈希、改脚本 pin 后重入构建；
#   YTDLP_AUTO_UPDATE=0：只提示不更新（手动改脚本头部 YTDLP_VERSION/SHA256）。
#
# 查询失败（离线/限流）只警告，不阻断构建。
check_ytdlp_latest() {
  local latest
  latest="$(curl -fsSL --max-time 10 "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" 2>/dev/null \
    | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["tag_name"])
except Exception: pass' 2>/dev/null)" || latest=""
  if [ -z "$latest" ]; then
    echo "警告：查不到 yt-dlp 最新 stable 版本（离线或限流），继续用 ${YTDLP_VERSION}" >&2
    return 0
  fi
  if [ "$latest" = "$YTDLP_VERSION" ]; then
    echo "yt-dlp ${YTDLP_VERSION} 已是最新 stable"
    return 0
  fi
  if [ "${YTDLP_AUTO_UPDATE:-1}" != "1" ]; then
    echo "提示：yt-dlp 有新 stable 版本 ${latest}（当前 pin ${YTDLP_VERSION}）" >&2
    echo "      升级：YTDLP_AUTO_UPDATE=1 重新构建，或手动改脚本头部 YTDLP_VERSION/SHA256" >&2
    return 0
  fi
  # 自动更新：下载新二进制算哈希 → 改脚本 pin → exec 重入（避免当前进程用旧 pin）
  local tmp new_sha
  tmp="$(mktemp)" || { echo "警告：mktemp 失败，继续用 ${YTDLP_VERSION}" >&2; return 0; }
  echo "发现新 stable：yt-dlp ${YTDLP_VERSION} → ${latest}，自动更新 pin …" >&2
  if ! curl -fL --retry 2 --max-time 300 -o "$tmp" \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${latest}/yt-dlp_macos"; then
    echo "警告：新版本下载失败，继续用 ${YTDLP_VERSION}" >&2
    rm -f "$tmp"
    return 0
  fi
  new_sha="$(shasum -a 256 "$tmp" | awk '{print $1}')"
  rm -f "$tmp"
  python3 - "$YTDLP_VERSION" "$latest" "$new_sha" <<'PY' || { echo "警告：改写 pin 失败，继续用 ${YTDLP_VERSION}" >&2; return 0; }
import re, sys
path = "scripts/build-macos-app.sh"
old_ver, new_ver, new_sha = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding="utf-8").read()
text = text.replace(f'YTDLP_VERSION="{old_ver}"', f'YTDLP_VERSION="{new_ver}"', 1)
text = re.sub(r'YTDLP_MACOS_SHA256="[0-9a-f]{64}"', f'YTDLP_MACOS_SHA256="{new_sha}"', text, count=1)
open(path, "w", encoding="utf-8").write(text)
PY
  echo "已更新 pin：${YTDLP_VERSION} → ${latest}（SHA256 ${new_sha:0:12}…），重新进入构建" >&2
  rm -f "$PWD/vendor/yt-dlp_macos" 2>/dev/null || true
  exec bash "$0" "$TARGET"
}

check_ytdlp_latest

if [ -n "$TARGET" ]; then
  cargo build --release --locked --target "$TARGET"
  BIN_DIR="target/$TARGET/release"
else
  cargo build --release --locked
  BIN_DIR="target/release"
fi

APP_DIR="$BIN_DIR/$APP_NAME.app"
CONTENTS="$APP_DIR/Contents"

rm -rf "$APP_DIR"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

cp "$BIN_DIR/WeTube" "$CONTENTS/MacOS/$APP_NAME"

if [ -d "$ICONSET" ] && command -v iconutil >/dev/null 2>&1; then
  iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns"
else
  echo "警告：没有 icons/AppIcon.iconset 或 iconutil，.app 将没有图标" >&2
fi

# 版本号唯一来源是 Cargo.toml 的 [package].version，这里读出来同时用于
# CFBundleShortVersionString（展示版本）与 CFBundleVersion（构建号）。
# 两者跟着版本走，免得改了 Cargo.toml 却忘了同步 plist。
#
# 解析失败**必须中止**：以前回退成 1.0.0，于是 Info.plist、zip 文件名、
# 二进制里的 CARGO_PKG_VERSION 三者会不一致，而且没有任何报错提示。
VERSION="$(cargo metadata --no-deps --format-version 1 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])' 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
  echo "错误：无法从 Cargo.toml 解析版本号（cargo metadata 失败）" >&2
  exit 1
fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>com.wecode.wetube</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>WeTube 需要访问自己的播放音频，以提供音量增强。音频仅实时处理，不会录制或保存。</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

# ---- 外置工具下载：yt-dlp + ffmpeg/ffprobe 打进 Resources/bin ----
# 缓存在 vendor/（不进 git），哈希校验失败即中止构建。
# 跳过：SKIP_BUNDLED_TOOLS=1 ./scripts/build-macos-app.sh
VENDOR_DIR="$PWD/vendor"
mkdir -p "$VENDOR_DIR"
BIN_DIR_RES="$CONTENTS/Resources/bin"
mkdir -p "$BIN_DIR_RES"

verify_sha() { # file expected
  echo "$2  $1" | shasum -a 256 -c - >/dev/null 2>&1
}

fetch_tool() { # url sha256 dest
  local url="$1" sha="$2" dest="$3"
  if [ -f "$dest" ] && verify_sha "$dest" "$sha"; then
    echo "复用缓存：$dest"
    return 0
  fi
  echo "下载：$url"
  if ! curl -fL --retry 2 -o "$dest" "$url"; then
    echo "错误：下载失败（curl exit=$?）：$url" >&2
    rm -f "$dest"
    exit 1
  fi
  if ! verify_sha "$dest" "$sha"; then
    echo "错误：$dest 哈希校验失败" >&2
    echo "      预期 $sha" >&2
    echo "      实际 $(shasum -a 256 "$dest" | awk '{print $1}')" >&2
    # 无版本号直链（osxexperts 的 ffmpeg）上游换版本时就会走到这里。别当成投毒
    # 直接删包重下——先确认来源，再把脚本头部的 URL/SHA 一起更新。
    echo "      若来源是 osxexperts 的 ffmpeg：多半是上游原地换了版本。" >&2
    echo "      先核对 $url ，再更新 scripts/build-macos-app.sh 头部的 URL/SHA。" >&2
    rm -f "$dest"
    exit 1
  fi
}

if [ "${SKIP_BUNDLED_TOOLS:-0}" = "1" ]; then
  echo "跳过打包 yt-dlp / ffmpeg（SKIP_BUNDLED_TOOLS=1）"
else
  # yt-dlp：官方 macOS 独立二进制（Universal），直接放。
  fetch_tool \
    "$YTDLP_URL" \
    "$YTDLP_MACOS_SHA256" \
    "$VENDOR_DIR/yt-dlp_macos"
  cp "$VENDOR_DIR/yt-dlp_macos" "$BIN_DIR_RES/yt-dlp"
  chmod +x "$BIN_DIR_RES/yt-dlp"

  BUILD_ARCH="${TARGET:-$(uname -m)}"
  LIB_ARGS=()
  if [ "$BUILD_ARCH" = "x86_64-apple-darwin" ] || [ "$BUILD_ARCH" = "x86_64" ]; then
    TOOL_ARCH="x86_64"
    # ARM 下载地址不能打进 Intel 包；从构建机取兼容的工具，并检查实际架构。
    for tool in ffmpeg qjs; do
      tool_path="$(command -v "$tool" || true)"
      if [ -z "$tool_path" ] || ! lipo -archs "$tool_path" 2>/dev/null | grep -qw x86_64; then
        echo "错误：构建 Intel 包需要可执行的 x86_64 $tool（当前：${tool_path:-未安装}）" >&2
        exit 1
      fi
      cp "$tool_path" "$BIN_DIR_RES/$tool"
      chmod +x "$BIN_DIR_RES/$tool"
      LIB_ARGS+=("--${tool}-source" "$tool_path")
    done
  else
    TOOL_ARCH="arm64"
    # ffmpeg/ffprobe：osxexperts 的 zip 里就是 ARM 裸二进制。
    if [ ! -f "$VENDOR_DIR/ffmpeg" ] || ! verify_sha "$VENDOR_DIR/ffmpeg" "$FFMPEG_ARM_SHA256"; then
      fetch_tool "$FFMPEG_ARM_URL" "$FFMPEG_ARM_SHA256" "$VENDOR_DIR/ffmpeg9arm.zip"
      unzip -o -j -q "$VENDOR_DIR/ffmpeg9arm.zip" ffmpeg -d "$BIN_DIR_RES"
      mv "$BIN_DIR_RES/ffmpeg" "$VENDOR_DIR/ffmpeg"
      rm -f "$VENDOR_DIR/ffmpeg9arm.zip"
    fi
    cp "$VENDOR_DIR/ffmpeg" "$BIN_DIR_RES/ffmpeg"
    chmod +x "$BIN_DIR_RES/ffmpeg"

    # qjs：yt-dlp 的 JS runtime（消 EJS 警告）。
    fetch_tool "$QJS_URL" "$QJS_SHA256" "$VENDOR_DIR/qjs"
    cp "$VENDOR_DIR/qjs" "$BIN_DIR_RES/qjs"
    chmod +x "$BIN_DIR_RES/qjs"
  fi

  # 收齐 Homebrew 等动态构建的传递依赖，并改成包内相对引用。
  python3 scripts/bundle-macos-libs.py "$BIN_DIR_RES" "$TOOL_ARCH" ${LIB_ARGS[@]+"${LIB_ARGS[@]}"}

  # 二进制带了 quarantine 会被 Gatekeeper 拦，删掉确保双击 App 后能直接跑。
  xattr -cr "$BIN_DIR_RES" 2>/dev/null || true
  echo "已打包：yt-dlp ${YTDLP_VERSION} + ffmpeg + qjs（Resources/bin）"
fi

# 清 quarantine 属性必须覆盖**整个** bundle（以前只清了 Resources/bin，
# MacOS/ 与顶层目录下的属性会漏掉），且必须在签名之前——签名是对 package 内容
# 取哈希，签完再改属性会把签名弄失效。
xattr -cr "$APP_DIR" 2>/dev/null || true

# ad-hoc 签名：本机双击即可打开。要分发给别人请换成 Developer ID 并做公证。
# 注意：必须在把外部二进制放进 Resources 之后签——签名覆盖整个 bundle。
#
# 失败不再降级成提示：CI 会直接发布这个 .app，静默跳过就等于发布一个
# 双击打不开的包。宁可构建失败也不要产出无签名的产物。
codesign --force --deep --sign - "$APP_DIR"

echo "完成：$APP_DIR"
