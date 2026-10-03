// macOS 原生 WKWebView 验证，不 mock Web Audio。输出静音，只测信号幅度。
// swift scripts/verify-volume-boost-webkit.swift
// 可选：传入本地 AAC fragmented MP4，验证 MSE 通路及 WebKit 缺陷提示：
// swift scripts/verify-volume-boost-webkit.swift /tmp/audio.mp4
import Cocoa
import WebKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let source = try String(contentsOf: root.appendingPathComponent("src/enhancer/volume-boost.js"), encoding: .utf8)
let styles = try String(contentsOf: root.appendingPathComponent("src/enhancer/styles.css"), encoding: .utf8)
let mse = CommandLine.arguments.count > 1
let media: String
if mse {
    let bytes = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    media = """
    const media = new MediaSource(); video.src = URL.createObjectURL(media);
    media.addEventListener('sourceopen', () => {
      const buffer = media.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
      buffer.addEventListener('updateend', () => media.endOfStream(), {once: true});
      buffer.appendBuffer(Uint8Array.from(atob('\(bytes.base64EncodedString())'), c => c.charCodeAt(0)));
    });
    """
} else {
    media = """
    const bytes = new Uint8Array(44 + 48000 * 2), wav = new DataView(bytes.buffer);
    const label = (at, text) => [...text].forEach((c, i) => bytes[at + i] = c.charCodeAt(0));
    label(0, 'RIFF'); wav.setUint32(4, bytes.length - 8, true); label(8, 'WAVE');
    label(12, 'fmt '); wav.setUint32(16, 16, true); wav.setUint16(20, 1, true);
    wav.setUint16(22, 1, true); wav.setUint32(24, 48000, true); wav.setUint32(28, 96000, true);
    wav.setUint16(32, 2, true); wav.setUint16(34, 16, true); label(36, 'data');
    wav.setUint32(40, bytes.length - 44, true);
    for (let i = 0; i < 48000; i++) wav.setInt16(44 + i * 2, 2500 * Math.sin(2 * Math.PI * 440 * i / 48000), true);
    video.src = URL.createObjectURL(new Blob([bytes], {type: 'audio/wav'}));
    """
}
let html = """
<!doctype html><style>\(styles)</style>
<div id="movie_player"><video loop></video><div class="ytp-left-controls">
<div class="ytp-volume-area"><button class="ytp-mute-button"></button></div></div></div>
<script>
const send = result => window.webkit.messageHandlers.result.postMessage(JSON.stringify(result));
window.onerror = (message, file, line) => send({ok: false, message, line});
const NativeContext = window.AudioContext;
let context, input, output;
window.AudioContext = class extends NativeContext {
  constructor() {
    super(); context = this;
    this.master = super.createGain(); this.master.gain.value = 0; this.master.connect(super.destination);
  }
  get destination() { return this.master; }
  createGain() { const gain = super.createGain(); output = this.createAnalyser(); gain.connect(output); return gain; }
  createMediaElementSource(video) {
    const node = super.createMediaElementSource(video); input = this.createAnalyser(); node.connect(input); return node;
  }
};
const config = {enabled: true, mode: '全局', amount: 20};
window.__YTE = {features: {}, cfg: (_, key) => config[key],
  getPlayer: () => document.getElementById('movie_player'), log: () => {}};
</script><script>\(source)</script><script>
const video = document.querySelector('video');
\(media)
document.addEventListener('DOMContentLoaded', () => document.querySelector('.yte-volume-boost-btn').click(), {once:true});
video.play().catch(error => send({ok: false, message: String(error)}));
const rms = node => {
  const samples = new Float32Array(node.fftSize); node.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
};
setTimeout(() => {
  try {
    const button = document.querySelector('.yte-volume-boost-btn');
    const before = rms(input), after = rms(output), ratio = before > 0 ? after / before : null;
    const blue = button.classList.contains('yte-volume-boost-active');
    const playing = !video.paused && video.currentTime > 0 && video.readyState >= 2 && context.state === 'running';
    if (!playing) throw Error('测试音频未进入播放状态');
    button.dispatchEvent(new Event('mouseenter'));
    const popup = document.querySelector('[role="tooltip"]');
    if (!popup || popup.hidden) throw Error('悬停提示没有显示');
    if (\(mse) && before === 0) {
      send({ok: !blue && button.title.includes('未检测到可处理音频'),
        result: '本机复现 MSE 音频数据缺失；新按钮正确显示兼容性提示', before, after, blue});
      return;
    }
    if (!blue || ratio === null || Math.abs(ratio - 10 ** (5 / 20)) > 0.05)
      throw Error('5 dB 增益不正确：' + ratio);
    button.click();
    setTimeout(() => {
      const restored = rms(output) / rms(input);
      send({ok: !button.classList.contains('yte-volume-boost-active') && Math.abs(restored - 1) < 0.05,
        result: '原生增益、恢复原声及悬停提示', ratio, restored});
    }, 300);
  } catch (error) { send({ok: false, message: String(error)}); }
}, 4500);
</script>
"""

class Receiver: NSObject, WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String,
              let data = text.data(using: .utf8),
              let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            print("无效测试结果"); exit(1)
        }
        print(text)
        exit(result["ok"] as? Bool == true ? 0 : 1)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.mediaTypesRequiringUserActionForPlayback = []
let receiver = Receiver()
config.userContentController.add(receiver, name: "result")
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 800, height: 500), configuration: config)
let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.contentView = view
window.orderFront(nil)
view.loadHTMLString(html, baseURL: URL(string: "https://www.youtube.com/watch?v=local-audio-test"))
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("原生音频验证超时"); exit(1) }
app.run()
