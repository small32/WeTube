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
  <string>$(cargo metadata --no-deps --format-version 1 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["packages"][0]["version"])' 2>/dev/null || echo 0.1.0)</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

# ad-hoc 签名：本机双击即可打开。要分发给别人请换成 Developer ID 并做公证。
codesign --force --deep --sign - "$APP_DIR" 2>/dev/null \
  || echo "提示：codesign 失败，可稍后手动执行 codesign --force --deep --sign - \"$APP_DIR\""

echo "完成：$APP_DIR"
