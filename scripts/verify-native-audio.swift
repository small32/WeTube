// Build together with src/native_audio.m into a signed .app (see README).
// Uses an actual MSE AAC stream and Core Audio IOProc, never mocked Web Audio.
import Cocoa
import WebKit

@_silgen_name("wetube_audio_create")
func createAudio(_ web: UnsafeMutableRawPointer, _ callback: @convention(c) (UnsafeMutableRawPointer?, UnsafePointer<CChar>?) -> Void, _ context: UnsafeMutableRawPointer) -> UnsafeMutableRawPointer
@_silgen_name("wetube_audio_update")
func updateAudio(_ engine: UnsafeMutableRawPointer, _ enabled: Bool, _ db: Double, _ request: UnsafePointer<CChar>)
@_silgen_name("wetube_audio_destroy")
func destroyAudio(_ engine: UnsafeMutableRawPointer)
@_silgen_name("wetube_audio_metrics")
func audioMetrics(_ engine: UnsafeMutableRawPointer, _ values: UnsafeMutablePointer<Float>)

let root = URL(fileURLWithPath: CommandLine.arguments[1])
let audio = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])).base64EncodedString()
let codec = CommandLine.arguments[2].hasSuffix(".webm") ? "audio/webm; codecs=\"opus\"" : "audio/mp4; codecs=\"mp4a.40.2\""
let expectedSourcePeak = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) : nil
let source = try String(contentsOf: root.appendingPathComponent("src/enhancer/volume-boost.js"), encoding: .utf8)
let styles = try String(contentsOf: root.appendingPathComponent("src/enhancer/styles.css"), encoding: .utf8)
let html = """
<!doctype html><style>\(styles)</style><div id="movie_player"><video loop></video>
<div class="ytp-left-controls"><div class="ytp-volume-area"><button class="ytp-mute-button"></button></div></div></div>
<script>
window.__WETUBE_PLATFORM__='macos'; window.__WETUBE_PAGE_ID__='native-mse-test';
const config={enabled:false,mode:'逐视频',amount:6};
window.__YTE={features:{},cfg:(_,key)=>config[key],setConfig:(_,key,value)=>config[key]=value,
  getPlayer:()=>document.getElementById('movie_player'),log:()=>{},
  post:payload=>window.webkit.messageHandlers.native.postMessage(payload)};
window.onerror=(message,file,line)=>window.webkit.messageHandlers.result.postMessage({ok:false,message,line});
</script><script>\(source)</script><script>
const video=document.querySelector('video'),media=new MediaSource();video.src=URL.createObjectURL(media);
media.addEventListener('sourceopen',()=>{
 const buffer=media.addSourceBuffer('\(codec)');
 buffer.addEventListener('updateend',()=>media.endOfStream(),{once:true});
 buffer.appendBuffer(Uint8Array.from(atob('\(audio)'),c=>c.charCodeAt(0)));
});
video.play().catch(error=>window.webkit.messageHandlers.result.postMessage({ok:false,message:String(error)}));
video.addEventListener('playing',()=>document.querySelector('.yte-volume-boost-btn').click(),{once:true});
</script>
"""

func nativeEvent(_ context: UnsafeMutableRawPointer?, _ text: UnsafePointer<CChar>?) {
    guard let context, let text else { return }
    let receiver = Unmanaged<Receiver>.fromOpaque(context).takeUnretainedValue()
    let json = String(cString: text)
    DispatchQueue.main.async { receiver.status(json) }
}
class Receiver: NSObject, WKScriptMessageHandler {
    var web: WKWebView!
    var engine: UnsafeMutableRawPointer!
    var phase = 0
    var ratios: [Double] = []
    var inputPeaks: [Float] = []
    var scheduled = Set<String>()
    var finished = false
    func finish(_ result: [String: Any]) {
        if finished { return }; finished = true
        destroyAudio(engine)
        let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        print(String(data: data, encoding: .utf8)!)
        exit(result["ok"] as? Bool == true ? 0 : 1)
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = message.body as? [String: Any] else { return }
        if message.name == "result" { finish(data); return }
        guard let on = data["enabled"] as? Bool, let amount = data["amount"] as? Double, let request = data["request"] as? String else { return }
        request.withCString { updateAudio(engine, on, amount, $0) }
    }
    func status(_ json: String) {
        if finished { return }
        print(json); fflush(stdout)
        web.evaluateJavaScript("window.__wetubeNativeAudioEvent?.(\(json));", completionHandler: nil)
        let data = try! JSONSerialization.jsonObject(with: json.data(using: .utf8)!) as! [String: Any]
        let state = data["state"] as? String
        let request = data["request"] as? String ?? ""
        if state == "error" { finish(["ok":false,"native":data]); return }
        if state == "active" && scheduled.insert(request).inserted {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                if self.finished { return }
                var values: [Float] = [0,0,0]; audioMetrics(self.engine, &values)
                let ratio = Double(values[1] / max(values[0], 1e-10))
                let expected = pow(10.0, (self.phase == 0 ? 6.0 : 12.0) / 20.0)
                if let peak = expectedSourcePeak, abs(Double(values[0]) - peak) > peak * 0.2 {
                    self.finish(["ok":false,"message":"捕获音频与测试源幅度不一致","inputPeak":values[0],"expectedPeak":peak]); return
                }
                guard values[2] == 1, abs(ratio - expected) < 0.08 else {
                    self.finish(["ok":false,"message":"原生流媒体增益不正确","input":values[0],"output":values[1],"ratio":ratio]); return
                }
                self.ratios.append(ratio)
                self.inputPeaks.append(values[0])
                self.web.evaluateJavaScript("document.querySelector('.yte-volume-boost-btn').click();", completionHandler:nil)
            }
        }
        if state == "off" && ratios.count == phase + 1 {
            var values: [Float] = [0,0,0]; audioMetrics(engine, &values)
            if values[2] != 0 { finish(["ok":false,"message":"关闭后仍接管原声"]); return }
            if phase == 0 {
                phase = 1
                web.evaluateJavaScript("config.amount=12; document.querySelector('.yte-volume-boost-btn').click();", completionHandler:nil)
            } else { finish(["ok":true,"result":"MSE 原生增强及关闭恢复","gain6dB":ratios[0],"gain12dB":ratios[1],"inputPeaks":inputPeaks]); }
        }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.mediaTypesRequiringUserActionForPlayback = []
let receiver = Receiver()
config.userContentController.add(receiver, name:"native")
config.userContentController.add(receiver, name:"result")
let view = WKWebView(frame:NSRect(x:0,y:0,width:650,height:250),configuration:config)
receiver.web = view
receiver.engine = createAudio(Unmanaged.passUnretained(view).toOpaque(), nativeEvent, Unmanaged.passUnretained(receiver).toOpaque())
let window = NSWindow(contentRect:view.frame,styleMask:[.titled,.closable],backing:.buffered,defer:false)
window.title = "WeTube 原生音量增强验证（6 / 12 dB）"
window.contentView = view
window.center(); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps:true)
view.loadHTMLString(html,baseURL:URL(string:"https://www.youtube.com/watch?v=local-native-audio"))
DispatchQueue.main.asyncAfter(deadline:.now()+60) { receiver.finish(["ok":false,"message":"等待系统音频授权或流媒体信号超时；原声未接管"]); }
app.run()
