#!/usr/bin/env bash
# 在 macOS 上构建并打包成 WeTube.app。
#
#   ./scripts/build-macos-app.sh            # 打本机架构
#   ./scripts/build-macos-app.sh aarch64-apple-darwin
#   ./scripts/build-macos-app.sh x86_64-apple-darwin
set -euo pipefail
cd "$(dirname "$0")/.."

APP_NAME="WeTube"
TARGET="${1:-}"
ICONSET="icons/AppIcon.iconset"

# 打包进 Resources 的 yt-dlp / ffmpeg 版本（pin 死，保证构建可复现）。
# 升级只改这几行 + 对应哈希；哈希对不上会直接构建失败，防止供应链投毒。
# 来源与许可：
#   yt-dlp  —— 官方 release（PyInstaller 打包，整体 GPLv3+，与本项目 GPL-3.0 兼容）
#   ffmpeg  —— osxexperts.net 静态构建（GPLv3，含 x264/x265 编码器）
YTDLP_VERSION="2026.08.19"
YTDLP_MACOS_SHA256="0f192b7ec147ab6288885d6351d9ab67367640029b4377576ef46dd79cf7b202"
FFMPEG_URL="https://www.osxexperts.net/ffmpeg9arm.zip"
FFMPEG_SHA256="d0c06c5c68ce48af3143b262f7a9118a7c9f67de1e237fcc24ffb14df9c67af9"
FFPROBE_URL="https://www.osxexperts.net/ffprobe9arm.zip"
FFPROBE_SHA256="0c94fbdd8917022f28115eca512196cf4648732bc9e5db9ec8896c7e519d02aa"

if [ -n "$TARGET" ]; then
  cargo build --release --target "$TARGET"
  BIN_DIR="target/$TARGET/release"
else
  cargo build --release
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
VERSION="$(cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])' 2>/dev/null || echo 1.0.0)"

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
    echo "错误：$dest 哈希校验失败（预期 $sha）" >&2
    rm -f "$dest"
    exit 1
  fi
}

if [ "${SKIP_BUNDLED_TOOLS:-0}" = "1" ]; then
  echo "跳过打包 yt-dlp / ffmpeg（SKIP_BUNDLED_TOOLS=1）"
else
  # yt-dlp：官方 macOS 独立二进制（Universal），直接放。
  fetch_tool \
    "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_macos" \
    "$YTDLP_MACOS_SHA256" \
    "$VENDOR_DIR/yt-dlp_macos"
  cp "$VENDOR_DIR/yt-dlp_macos" "$BIN_DIR_RES/yt-dlp"
  chmod +x "$BIN_DIR_RES/yt-dlp"

  # ffmpeg/ffprobe：osxexperts 的 zip 里就是裸二进制，解出来放。
  if [ ! -f "$VENDOR_DIR/ffmpeg" ] || ! verify_sha "$VENDOR_DIR/ffmpeg" "$FFMPEG_SHA256"; then
    fetch_tool "$FFMPEG_URL" "$FFMPEG_SHA256" "$VENDOR_DIR/ffmpeg9arm.zip"
    unzip -o -j -q "$VENDOR_DIR/ffmpeg9arm.zip" ffmpeg -d "$BIN_DIR_RES"
    mv "$BIN_DIR_RES/ffmpeg" "$VENDOR_DIR/ffmpeg"
    rm -f "$VENDOR_DIR/ffmpeg9arm.zip"
  fi
  cp "$VENDOR_DIR/ffmpeg" "$BIN_DIR_RES/ffmpeg"
  chmod +x "$BIN_DIR_RES/ffmpeg"

  if [ ! -f "$VENDOR_DIR/ffprobe" ] || ! verify_sha "$VENDOR_DIR/ffprobe" "$FFPROBE_SHA256"; then
    fetch_tool "$FFPROBE_URL" "$FFPROBE_SHA256" "$VENDOR_DIR/ffprobe9arm.zip"
    unzip -o -j -q "$VENDOR_DIR/ffprobe9arm.zip" ffprobe -d "$BIN_DIR_RES"
    mv "$BIN_DIR_RES/ffprobe" "$VENDOR_DIR/ffprobe"
    rm -f "$VENDOR_DIR/ffprobe9arm.zip"
  fi
  cp "$VENDOR_DIR/ffprobe" "$BIN_DIR_RES/ffprobe"
  chmod +x "$BIN_DIR_RES/ffprobe"

  # 二进制带了 quarantine 会被 Gatekeeper 拦，删掉确保双击 App 后能直接跑。
  xattr -cr "$BIN_DIR_RES" 2>/dev/null || true
  echo "已打包：yt-dlp ${YTDLP_VERSION} + ffmpeg/ffprobe（Resources/bin）"
fi

# ad-hoc 签名：本机双击即可打开。要分发给别人请换成 Developer ID 并做公证。
# 注意：必须在把外部二进制放进 Resources 之后签——签名覆盖整个 bundle。
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null \
  || echo "提示：codesign 失败，可稍后手动执行 codesign --force --deep --sign - \"$APP_DIR\""

echo "完成：$APP_DIR"