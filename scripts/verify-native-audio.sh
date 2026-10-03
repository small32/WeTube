#!/usr/bin/env bash
# Real WKWebView MSE + Core Audio test. Requires macOS 14.2+, ffmpeg, and
# the user's system-audio permission for the test app when macOS requests it.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
TEST_DIR="$ROOT/target/native-audio-test"
APP="$TEST_DIR/WeTubeAudioTest.app"
FFMPEG_BIN="${FFMPEG_BIN:-}"
if [ -z "$FFMPEG_BIN" ]; then
  FFMPEG_BIN="$(command -v ffmpeg || true)"
fi
if [ -z "$FFMPEG_BIN" ] && [ -x "$ROOT/target/release/WeTube.app/Contents/Resources/bin/ffmpeg" ]; then
  FFMPEG_BIN="$ROOT/target/release/WeTube.app/Contents/Resources/bin/ffmpeg"
fi
if [ -z "$FFMPEG_BIN" ]; then
  echo "请设置 FFMPEG_BIN 为 ffmpeg 的绝对路径" >&2; exit 1
fi
mkdir -p "$APP/Contents/MacOS"
clang -fobjc-arc -fblocks -std=c11 -mmacosx-version-min=11.0 -c src/native_audio.m -o "$TEST_DIR/native_audio.o"
swiftc scripts/verify-native-audio.swift "$TEST_DIR/native_audio.o" \
  -framework Foundation -framework CoreAudio -framework WebKit \
  -o "$APP/Contents/MacOS/WeTubeAudioTest"
python3 - "$APP/Contents/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as output:
    plistlib.dump({
        'CFBundleIdentifier': 'com.wecode.wetube.audio-test',
        'CFBundleName': 'WeTubeAudioTest', 'CFBundleExecutable': 'WeTubeAudioTest',
        'CFBundlePackageType': 'APPL',
        'NSAudioCaptureUsageDescription': '验证 WeTube 流媒体音量增强，仅实时处理测试音频，不录制或保存。',
    }, output)
PY
codesign --force --deep --sign - "$APP"
for CODEC in aac opus; do
  if [ "$CODEC" = aac ]; then
    FIXTURE="$TEST_DIR/aac.mp4"
    "$FFMPEG_BIN" -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=5' \
      -af volume=0.25 -c:a aac -movflags frag_keyframe+empty_moov -f mp4 -y "$FIXTURE"
  else
    FIXTURE="$TEST_DIR/opus.webm"
    "$FFMPEG_BIN" -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=5' \
      -af volume=0.25 -c:a libopus -f webm -y "$FIXTURE"
  fi
  LOG="$TEST_DIR/$CODEC.log"
  open -n -W -a "$APP" --stdout "$LOG" --stderr "$TEST_DIR/$CODEC-error.log" --args "$ROOT" "$FIXTURE" 0.03125
  python3 - "$LOG" <<'PY'
import json,sys
results = [json.loads(line) for line in open(sys.argv[1]) if line.startswith('{')]
result = results[-1] if results else {'ok':False, 'message':'无测试结果'}
print(json.dumps(result, ensure_ascii=False))
if result.get('ok') is not True: sys.exit(1)
PY
done
