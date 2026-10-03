//! WeTube — 一个内建 YouTube-Enhancer 的 YouTube 桌面端App。
//!
//! 用 Rust 写的 YouTube 桌面端App：macOS 用 WKWebView、Windows 用 WebView2，
//! 同时支持 macOS 与 Windows。
//!
//!   * 窗口：tao（Tauri 的窗口库，winit 的分支）
//!   * 网页：wry（macOS 用 WKWebView，Windows 用 WebView2，都是系统自带内核）
//!   * 菜单：macOS 用系统全局菜单栏；其他平台把菜单搬进 WebView 自己的 HTML 顶部 chrome
//!   * 增强：注入的 JS，配置由 Rust 侧持久化，设置面板按 schema 自动生成

// Windows 上隐藏控制台窗口（debug / release 都隐藏，避免每次启动弹黑框）。
// 需要看调试日志时，把 eprintln 输出重定向到文件即可。
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

use std::collections::HashMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    window::{Fullscreen, Icon, Window, WindowBuilder},
};
use wry::{
    dpi::{PhysicalPosition, PhysicalSize},
    http::{Request, Uri},
    NewWindowResponse, Rect, RGBA, WebView, WebViewBuilder,
};

#[cfg(target_os = "macos")]
use muda::MenuEvent;

mod config;
mod cookies;
mod download;
mod shortcuts;
mod translate;
#[cfg(target_os = "macos")]
mod native_audio;
use config::ConfigStore;

const APP_NAME: &str = "WeTube";
const HOME_URL: &str = "https://www.youtube.com";

/// 仅可信的 YouTube 主页面能调用具有本地副作用的 IPC。
fn is_trusted_ipc_uri(uri: &Uri) -> bool {
    uri.scheme_str() == Some("https")
        && uri.port_u16().is_none_or(|port| port == 443)
        && uri.host().is_some_and(|host| host == "youtube.com" || host.ends_with(".youtube.com"))
}

fn is_login_uri(uri: &Uri) -> bool {
    uri.scheme_str() == Some("https")
        && uri.port_u16().is_none_or(|port| port == 443)
        && uri.host() == Some("accounts.google.com")
}

/// 只有 http(s) 才交给系统处理器。
///
/// `window.open` / `target="_blank"` 不经过 `with_navigation_handler`，这里是唯一关口；
/// 不设白名单的话，页面能借自定义协议或 `file:` 拉起本机程序（导航那边是有白名单的）。
fn is_openable_external(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn is_allowed_ipc(uri: &Uri, message: &str) -> bool {
    if is_trusted_ipc_uri(uri) { return true; }
    if !is_login_uri(uri) { return false; }
    // 登录页面只能操作窗口/导航，不能读写配置、下载或执行翻译。
    matches!(message, "back" | "forward" | "reload" | "home" | "window-close"
        | "window-minimize" | "window-toggle-maximize" | "window-drag" | "fullscreen")
        || serde_json::from_str::<Value>(message).ok()
            .is_some_and(|v| v.get("type").and_then(Value::as_str) == Some("app:ready"))
}

#[cfg(test)]
mod ipc_origin_tests {
    use super::*;

    #[test]
    fn bootstrap_fixture() {
        if let Some(path) = std::env::var_os("WETUBE_BOOTSTRAP_FIXTURE") {
            std::fs::write(path, init_script()).unwrap();
        }
    }

    #[test]
    fn login_can_navigate_but_cannot_access_downloads_or_config() {
        let login: Uri = "https://accounts.google.com/signin".parse().unwrap();
        for command in ["window-close", "window-drag", "home", "back", r#"{"type":"app:ready","pageId":"test"}"#] {
            assert!(is_allowed_ipc(&login, command));
        }
        for command in [r#"{"type":"config:set"}"#, r#"{"type":"download:start"}"#,
            r#"{"type":"download:sync"}"#, "open:file:///tmp/example"] {
            assert!(!is_allowed_ipc(&login, command));
        }
        assert!(!is_allowed_ipc(&"https://evil.example".parse().unwrap(), "window-close"));
    }

    #[test]
    fn only_https_youtube_origins_can_use_ipc() {
        for allowed in ["https://www.youtube.com/watch?v=1", "https://music.youtube.com/"] {
            assert!(is_trusted_ipc_uri(&allowed.parse().unwrap()), "{allowed}");
        }
        for denied in [
            "http://www.youtube.com/",
            "https://youtube.com.evil.example/",
            "https://www.youtube.com:8443/",
            "https://accounts.google.com/",
            "https://evil.example/",
        ] {
            assert!(!is_trusted_ipc_uri(&denied.parse().unwrap()), "{denied}");
        }
    }

    /// window.open / target="_blank" 只放行 http(s) 交给系统处理器。
    /// 这条与 navigation_handler、is_allowed_ipc 是同一道防线，缺一个等于留后门。
    #[test]
    fn only_http_schemes_are_handed_to_the_system() {
        for allowed in ["https://www.youtube.com/", "http://example.com/a?b=1"] {
            assert!(is_openable_external(allowed), "{allowed}");
        }
        for denied in [
            "file:///C:/Windows/System32/calc.exe",
            "ms-settings:",
            "vscode://foo/bar",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "ftp://example.com/",
            "",
        ] {
            assert!(!is_openable_external(denied), "{denied}");
        }
    }
}
#[allow(dead_code)] // 仅 macOS 菜单里 "项目主页" 用到
const PROJECT_URL: &str = "http://small32.top:8418/winc0/WeTube";

/// 注入到页面里，让前端知道该用哪种拖拽方式。
#[cfg(target_os = "windows")]
const PLATFORM: &str = "windows";
#[cfg(target_os = "macos")]
const PLATFORM: &str = "macos";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const PLATFORM: &str = "linux";

/// 自定义标题栏拖拽：Windows 上 WebView2 不认 `-webkit-app-region: drag`，
/// 所以由前端在拖动区按下时发 IPC，这里用系统消息让 OS 接管整个拖动过程。
#[cfg(target_os = "windows")]
use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};

// 编译时由 build.rs 把 PNG 解码出来的窗口图标 RGBA 字节和尺寸。
const WINDOW_ICON_RGBA: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/window-icon.rgba"));
include!(concat!(env!("OUT_DIR"), "/window-icon-dims.rs"));
use icon_dims as WINDOW_ICON_DIMS;
/// WeTube 自己的工具栏（后退/前进/刷新/首页/设置）。
const TOOLBAR_JS: &str = include_str!("ui.js");
/// 自定义窗口 chrome：图标 + 应用名 + 菜单下拉 + 窗口控制按钮。
const TITLEBAR_JS: &str = include_str!("titlebar.js");
/// 增强功能运行时 + 功能实现 + 设置面板。
const ENHANCER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/enhancer-bundle.js"));
/// 功能 CSS 与深黑主题，由 build.rs 转成 JS 字符串常量。
const ENHANCER_ASSETS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/enhancer-assets.js"));
const SHORTCUT_PANEL_JS: &str = include_str!("shortcut-panel.js");
/// 下载面板：悬浮球 + 格式选择 + 进度显示（两平台通用，见 download-panel.js）。
const DOWNLOAD_PANEL_JS: &str = include_str!("download-panel.js");
/// 32 套 DeepDark 配色预设。
const DEEPDARK_PRESETS_JS: &str = include_str!("enhancer/deepdark-presets.js");


/// 事件循环里流动的消息：工具栏指令、菜单点击、或设置面板的配置变更。
#[derive(Debug, Clone)]
enum Command {
    #[cfg(target_os = "macos")]
    NativeAudioEvent(Value),
    Ipc(String, bool),
    #[cfg(target_os = "macos")]
    Menu(String),
    /// 后台线程翻译完的结果。
    ///
    /// `WebView` 不能跨线程使用，所以工作线程翻译完不能直接 eval 回页面，
    /// 只能经 `EventLoopProxy` 把结果送回主线程再 eval。
    /// `id` 用来和页面那边的请求对号——字幕滚动很快，回来的顺序
    /// 未必等于发出去的顺序，靠 id 才不会把译文安到错误的行上。
    SubtitleTranslated {
        id: String,
        result: Result<String, String>,
    },
    /// 字幕轨道批量翻译结果（逐位对应，失败位为 None）。
    SubtitleBatchTranslated {
        id: String,
        results: Vec<Option<String>>,
    },
    /// 下载相关事件：探测结果 / 进度 / 结束。负载是构造好的 JSON，
    /// 主线程直接 eval 给页面（`window.__wetubeDownloadEvent(payload)`）。
    DownloadEvent(Value),
}

/// 把编译期嵌入的图标字节装成 tao::Icon。任何一步失败（图标文件缺失、PNG 解码异常等）
/// 都不影响启动——顶多窗口/任务栏没图标。
fn build_window_icon() -> Option<Icon> {
    Icon::from_rgba(WINDOW_ICON_RGBA.to_vec(), WINDOW_ICON_DIMS::W, WINDOW_ICON_DIMS::H).ok()
}

/// 输出错误日志。release 版在 Windows 上没有控制台，直接 eprintln! 会 panic；
/// 这里同时追加写入日志文件，无论是否有控制台都保证错误被记录。
///
/// 日志文件路径：`dirs::data_dir()/WeTube/webrtc.err.log`（macOS 和 Windows 同源）。
static LOG_FILE: std::sync::Mutex<Option<std::fs::File>> =
    std::sync::Mutex::new(None);

fn log_err(message: &str) {
    // 先写文件再写 stderr：stderr 失败不应阻止文件日志写入
    if let Ok(mut guard) = LOG_FILE.lock() {
        if guard.is_none() {
            let dir = dirs::data_dir()
                .map(|base| base.join("WeTube"))
                .or_else(|| dirs::home_dir().map(|h| h.join("AppData").join("Roaming").join("WeTube")))
                .or_else(dirs::home_dir);
            if let Some(dir) = dir {
                let _ = std::fs::create_dir_all(&dir);
                if let Ok(f) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(dir.join("webrtc.err.log"))
                {
                    *guard = Some(f);
                }
            }
        }
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(format!("{}\n", message).as_bytes());
        }
    }
    // stderr 写失败也不 panic：release 版可能根本没控制台
    let _ = writeln!(std::io::stderr(), "[WeTube] {message}");
}

/// 终止类信号处理器：清掉 yt-dlp 子进程后按信号的默认语义退出。
///
/// 处理器里绝不碰 Mutex::lock（可能死锁）、不分配堆内存，只做
/// try_lock + kill + `_exit`。不恢复默认处理器再 raise 是刻意的：
/// 再 raise 会重入信号路径，而这里已经完成了唯一目标（杀子进程）。
#[cfg(unix)]
extern "C" fn handle_exit_signal(sig: i32) {
    download::kill_all_best_effort();
    // _exit 是异步信号安全的立即退出；退出码 128+sig 与 shell 惯例一致。
    std::process::exit(128 + sig);
}

/// 翻译链路日志统一由 translate 模块提供（写入应用数据目录下的 WeTube/translate.log，
/// 路径跨平台，详见 translate::translate_log）。
use translate::translate_log;

fn main() -> Result<(), Box<dyn Error>> {
    // SIGTERM/SIGHUP/SIGINT（kill 命令、注销、Ctrl+C）不走事件循环，
    // 事件循环里的 LoopDestroyed 清场接不到——装个信号处理器把 yt-dlp
    // 子进程一并带走。信号处理器里只能调异步安全函数，所以 download
    // 那边给了 try_lock 的尽力清理版本；锁拿不到就随进程去，孤儿
    // yt-dlp 会把当前任务下完自然退出。
    #[cfg(unix)]
    unsafe {
        let handler = handle_exit_signal as extern "C" fn(i32) as *const () as usize;
        libc::signal(libc::SIGTERM, handler);
        libc::signal(libc::SIGHUP, handler);
        libc::signal(libc::SIGINT, handler);
    }

    let mut store = ConfigStore::load()?;
    let init_script = init_script();

    let event_loop = EventLoopBuilder::<Command>::with_user_event().build();

    let window = {
        // 下面的 with_decorations(false) 只在非 macOS 上执行，macOS 上 mut 用不上。
        #[cfg_attr(target_os = "macos", allow(unused_mut))]
        let mut builder = WindowBuilder::new()
            .with_title(APP_NAME)
            .with_inner_size(LogicalSize::new(1180.0, 760.0))
            .with_min_inner_size(LogicalSize::new(620.0, 420.0))
            // 设置任务栏 / Alt+Tab / 文件管理器里的图标。HTML chrome 不用这个，
            // 但留着没有损失。
            .with_window_icon(build_window_icon());

        // 把原生标题栏去掉，让我们自己的 HTML chrome 控制一切（图标 + 菜单 + 控件）。
        // macOS 不去掉，否则会失去红绿黄交通灯按钮，而 macOS 系统也习惯原生菜单栏。
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.with_decorations(false);
        }

        builder.build(&event_loop)?
    };

    // macOS 才有原生菜单栏的需求——HTML chrome 上的菜单项直接发 IPC 字符串，
    // 走这里一样能 dispatch。
    #[cfg(target_os = "macos")]
    let (menu, built_items) = build_menu(&store)?;
    #[cfg(target_os = "macos")]
    install_menu(&menu, &window)?;

    // 只有 macOS 有原生菜单栏要跟着更新；Windows 的菜单是 HTML 画的，
    // 改完靠前端自己重绘。统一成 Option，省得到处写 cfg。
    #[cfg(target_os = "macos")]
    let menu_items = Some(built_items);
    #[cfg(not(target_os = "macos"))]
    let menu_items: Option<MenuItemMap> = None;

    #[cfg(target_os = "macos")]
    let menu_proxy = event_loop.create_proxy();
    #[cfg(target_os = "macos")]
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_proxy.send_event(Command::Menu(event.id().0.clone()));
    }));

    let ipc_proxy = event_loop.create_proxy();
    // 翻译请求在后台线程里跑，结果要靠这个 proxy 送回主线程再 eval。
    // ipc_proxy 稍后会被 move 进 IPC 回调，所以这里先克隆一份。
    let translate_proxy = ipc_proxy.clone();
    let webview = WebViewBuilder::new()
        .with_url(HOME_URL)
        // 只注入主框架：这一坨有几百 KB，塞进每个 iframe 纯属浪费
        .with_initialization_script_for_main_only(init_script, true)
        .with_background_color(background_color())
        .with_autoplay(true)
        .with_clipboard(true)
        .with_devtools(cfg!(debug_assertions))
        .with_ipc_handler(move |req: Request<String>| {
            if is_allowed_ipc(req.uri(), req.body()) {
                let _ = ipc_proxy.send_event(Command::Ipc(req.body().to_string(), is_trusted_ipc_uri(req.uri())));
            }
        })
        .with_navigation_handler(|url| {
            let allowed = url.parse::<Uri>().ok()
                .is_some_and(|uri| is_trusted_ipc_uri(&uri) || is_login_uri(&uri));
            if !allowed && (url.starts_with("https://") || url.starts_with("http://")) {
                let _ = open::that(&url);
            }
            allowed
        })
        // target="_blank" / window.open 一律交给系统浏览器，别把壳子整个带走。
        .with_new_window_req_handler(|url: String, _features| {
            // 这里必须和上面的 navigation_handler 一样只放行 http(s)：window.open 不经过
            // navigation_handler，这是唯一关口，否则页面能借自定义协议 / file: 拉起本机程序。
            if is_openable_external(&url) {
                if let Err(err) = open::that(&url) {
                    log_err(&format!("打开外部链接失败: {err}"));
                }
            } else {
                log_err(&format!("拒绝把非 http(s) 链接交给系统处理: {url}"));
            }
            NewWindowResponse::Deny
        })
        .build(&window)?;

    // 启动先导一份（可能是上次登录留下的会话），之后每次点下载前再刷一次。
    if let Err(err) = cookies::export(&webview) {
        log_err(&format!("启动时导出 cookie 失败：{err}"));
    }

    #[cfg(target_os = "macos")]
    let native_audio = {
        use wry::WebViewExtMacOS;
        let wk = webview.webview();
        native_audio::NativeAudio::new(&*wk as *const _ as *mut std::ffi::c_void, event_loop.create_proxy())
    };
    let mut download_history = download::EventHistory::default();
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::Resized(size),
                ..
            } => {
                // 无边框窗口最大化/还原时，WebView2 不会自动跟随 tao 客户区尺寸。
                // 显式同步 bounds，避免窗口变大后右侧/底部仍是旧尺寸的空白区域。
                if let Err(err) = webview.set_bounds(Rect {
                    position: PhysicalPosition::new(0, 0).into(),
                    size: PhysicalSize::new(size.width, size.height).into(),
                }) {
                    log_err(&format!("调整 WebView 尺寸失败: {err}"));
                }
                // 进入/退出全屏（含 Esc 之类的系统退出路径）都会触发尺寸变化，
                // 在这里同步 chrome 显隐，保证真正全屏时标题栏/菜单栏一并藏掉。
                sync_fullscreen_chrome(&window, &webview);

                // 绿色按钮 / Esc 这类系统路径不走 act("fullscreen")。
                // 窗口一旦不在全屏，元素全屏就必须跟着退——否则会残留一个
                // 「按 Esc 退出全屏」的浮层。JS 那边没有元素全屏时是空操作，
                // 所以每次 Resized 都调也没事。
                if window.fullscreen().is_none() {
                    eval(&webview, "window.__wetubeExitElementFullscreen?.()");
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            // 事件循环销毁（Cmd+Q / 关窗口 / 菜单退出都会走到这里）：
            // 把还在跑的 yt-dlp 下载子进程一并杀掉，别让它们变孤儿继续后台下载。
            Event::LoopDestroyed => {
                #[cfg(target_os = "macos")]
                native_audio.shutdown();
                download::kill_all();
            }
            Event::UserEvent(Command::Ipc(msg, trusted)) => {
                debug_log(&format!("指令来源: 页面 IPC → {msg:?}"));
                if let Some(url) = msg.strip_prefix("open:") {
                    if let Err(err) = open::that(url) {
                        log_err(&format!("打开外部链接失败: {err}"));
                    }
                    return;
                }
                // 设置面板发的是 JSON，工具栏/菜单发的是裸命令字符串。
                // 关闭指令直接在当前事件结束时退出，不依赖下一次窗口事件。
                if msg == "window-close" {
                    *control_flow = ControlFlow::Exit;
                    return;
                }
                match serde_json::from_str::<Value>(&msg) {
                    Ok(payload) if payload["type"] == "app:ready" => {
                        #[cfg(target_os = "macos")]
                        native_audio.stop();
                        let config = if trusted { store.full_config() } else { serde_json::json!({}) };
                        eval(&webview, &format!("window.__wetubeBootstrap?.({}, {}, {}, {});",
                            payload["pageId"], config, shortcuts::registry_json(store.shortcuts()), trusted));
                        sync_fullscreen_chrome(&window, &webview);
                    }
                    #[cfg(target_os = "macos")]
                    Ok(payload) if payload["type"] == "volume-boost:set" && trusted => {
                        native_audio.set(&payload);
                    }
                    Ok(payload) if payload["type"] == "download:sync" && trusted => {
                        eval(&webview, &format!("window.__wetubeDownloadEvent?.({});",
                            serde_json::json!({"kind":"snapshot", "events":download_history.snapshot()})));
                    }
                    Ok(Value::Object(payload)) => handle_panel_message(
                        &mut store,
                        &webview,
                        menu_items.as_ref(),
                        &translate_proxy,
                        &payload,
                    ),
                    _ => act(&webview, &window, &msg),
                }
            }
            #[cfg(target_os = "macos")]
            Event::UserEvent(Command::NativeAudioEvent(payload)) => {
                eval(&webview, &format!("window.__wetubeNativeAudioEvent?.({payload});"));
            }
            Event::UserEvent(Command::DownloadEvent(event)) => {
                download_history.record(&event);
                // 下载事件统一从这里 eval 给页面；serde_json 保证生成的
                // 是合法 JS 字面量，路径里有什么怪字符都不会破坏语法。
                eval(
                    &webview,
                    &format!(
                        "window.__wetubeDownloadEvent?.({})",
                        serde_json::to_string(&event)
                            .unwrap_or_else(|_| "{\"kind\":\"fail\"}".into())
                    ),
                );
            }
            // 后台线程翻译完，结果回到主线程——只有这里能碰 webview。
            Event::UserEvent(Command::SubtitleTranslated { id, result }) => {
                let (ok, payload) = match result {
                    Ok(text) => (true, text),
                    Err(err) => {
                        // 失败也回传页面，让字幕位置显示一句提示，而不是静默什么都不发生。
                        log_err(&format!("字幕翻译失败: {err}"));
                        (false, err)
                    }
                };
                // 一律用 serde_json 生成字面量：译文里可能有引号、换行、反斜杠，
                // 手拼字符串迟早把 JS 语法搞坏。
                let id_json = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_string());
                let payload_json =
                    serde_json::to_string(&payload).unwrap_or_else(|_| "\"\"".to_string());
                eval(
                    &webview,
                    &format!(
                        "window.__wetubeOnSubtitleTranslated?.({id_json}, {ok}, {payload_json})"
                    ),
                );
            }
            // 批量翻译结果：序列化成 JSON 数组（失败位 null）eval 回页面。
            Event::UserEvent(Command::SubtitleBatchTranslated { id, results }) => {
                let id_json = serde_json::to_string(&id).unwrap_or_else(|_| "\"\"".to_string());
                let results_json = serde_json::to_string(&results)
                    .unwrap_or_else(|_| "[]".to_string());
                eval(
                    &webview,
                    &format!(
                        "window.__wetubeOnSubtitleBatchTranslated?.({id_json}, {results_json})"
                    ),
                );
            }
            #[cfg(target_os = "macos")]
Event::UserEvent(Command::Menu(id)) => {
                debug_log(&format!("指令来源: 菜单栏 → {id:?}"));
                if id == "quit" {
                    *control_flow = ControlFlow::Exit;
                } else if id == "project" {
                    if let Err(err) = open::that(PROJECT_URL) {
                        log_err(&format!("打开项目主页失败: {err}"));
                    }
                } else if id == "shortcuts" {
                    eval(&webview, "window.__wetubeToggleShortcutPanel?.()");
                } else if id == "settings" {
                    eval(&webview, "window.__YTE?.togglePanel?.()");
                } else {
                    act(&webview, &window, &id);
                }
            }
            // 非 macOS 用 HTML 菜单，菜单事件不会触发，无需 dispatch。
            _ => {}
        }

    });
}

/// 处理设置面板发来的配置变更：落盘 + 让页面重新应用。
///
/// `menu_items` 是 macOS 原生菜单栏里那几个可自定义项的引用；Windows 没有
/// 原生菜单栏，传 `None`，改完由前端自己重绘 HTML 菜单。
fn handle_panel_message(
    store: &mut ConfigStore,
    webview: &WebView,
    menu_items: Option<&MenuItemMap>,
    proxy: &EventLoopProxy<Command>,
    payload: &serde_json::Map<String, Value>,
) {
    match payload.get("type").and_then(Value::as_str) {
        // 页面抓到一行字幕，送来翻译。
        //
        // 翻译是网络请求，耗时不可控，绝不能在这里同步等——那样会把整个
        // 事件循环卡住，界面直接假死。丢到后台线程去跑，结果经 proxy 送回主线程。
        Some("subtitle-translate") => {
            let (Some(id), Some(text)) = (
                payload.get("id").and_then(Value::as_str),
                payload.get("text").and_then(Value::as_str),
            ) else {
                return;
            };
            // 目标语言没给就用中文；页面那边按设置传，这里只是兜底。
            let target = payload
                .get("targetLang")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("zh-CN");

            let id = id.to_string();
            let text = text.to_string();
            let target = target.to_string();
            // 立即回执：页面据此区分"消息没到 Rust"和"到了但结果没回传"。
            eval(webview, "window.__wetubeSubtitleAck?.()");
            translate_log(&format!(
                "recv id={id} target={target} chars={}",
                text.chars().count()
            ));
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let result = translate::translate(&text, &target);
                match &result {
                    Ok(t) => translate_log(&format!("done id={id} OK chars={}", t.chars().count())),
                    Err(e) => translate_log(&format!("done id={id} ERR {e}")),
                }
                if let Err(err) = proxy.send_event(Command::SubtitleTranslated { id, result }) {
                    log_err(&format!("回传翻译结果失败: {err}"));
                }
            });
        }
        //
        // 字幕轨道批量翻译：整条轨道按块送翻，逐位回传（失败位 null）。
        Some("subtitle-translate-batch") => {
            let (Some(id), Some(texts)) = (
                payload.get("id").and_then(Value::as_str),
                payload
                    .get("texts")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .map(|value| value.as_str().unwrap_or_default().to_string())
                            .collect::<Vec<_>>()
                    }),
            ) else {
                return;
            };
            let target = payload
                .get("targetLang")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("zh-CN");

            let id = id.to_string();
            let target = target.to_string();
            eval(
                webview,
                &format!("window.__wetubeSubtitleAck?.({})", texts.len()),
            );
            translate_log(&format!(
                "batch-recv id={id} items={} target={target}",
                texts.len()
            ));
            let proxy = proxy.clone();
            std::thread::spawn(move || {
                let results = translate::translate_batch(&texts, &target);
                let ok_count = results.iter().filter(|item| item.is_some()).count();
                translate_log(&format!("batch-done id={id} ok={ok_count}/{}", results.len()));
                if let Err(err) =
                    proxy.send_event(Command::SubtitleBatchTranslated { id, results })
                {
                    log_err(&format!("回传批量翻译结果失败: {err}"));
                }
            });
        }
        Some("config:set") => {
            let (Some(feature), Some(key)) = (
                payload.get("feature").and_then(Value::as_str),
                payload.get("key").and_then(Value::as_str),
            ) else {
                return;
            };
            let value = payload.get("value").cloned().unwrap_or(Value::Null);
            if let Err(err) = store.set(feature, key, value) {
                log_err(&format!("保存设置失败: {err}"));
            }
        }
        Some("config:reset") => {
            if let Err(err) = store.reset(None) {
                log_err(&format!("重置设置失败: {err}"));
            }
            let script = format!(
                "window.__YTE?.replaceConfig({});",
                store.full_config()
            );
            eval(webview, &script);
        }
        Some("shortcut:set") => {
            let (Some(id), Some(spec)) = (
                payload.get("id").and_then(Value::as_str),
                payload.get("spec").and_then(Value::as_str),
            ) else {
                return;
            };
            apply_shortcut(store, webview, menu_items, id, Some(spec));
        }
        Some("shortcut:reset") => {
            // 带 id 只恢复一项，不带就全部恢复默认
            match payload.get("id").and_then(Value::as_str) {
                Some(id) => apply_shortcut(store, webview, menu_items, id, None),
                None => reset_all_shortcuts(store, webview, menu_items),
            }
        }
        // ---- 下载：探测 / 启动 / 取消 ----
        //
        // 与字幕翻译同一个套路：网络+子进程的活儿全部丢后台线程，
        // 结果经 proxy 送回主线程再 eval，绝不卡事件循环。
        Some("download:probe") => {
            let Some(url) = payload.get("url").and_then(Value::as_str) else {
                return;
            };
            let url = url.to_string();
            // YouTube 的机器人校验只能靠 cookie 过，来源由设置决定。
            // 先同步导一份最新的——毫秒级，且下游要用文件，不能异步。
            if let Err(err) = cookies::export(webview) {
                log_err(&format!("导出 cookie 失败：{err}"));
            }
            let cookies = cookie_source(store);
            let proxy = proxy.clone();
            let _ = proxy.send_event(Command::DownloadEvent(serde_json::json!({
                "kind": "probe-start", "url": url,
            })));
            std::thread::spawn(move || {
                let event = match download::probe(&url, &cookies) {
                    Ok(mut info) => {
                        info["kind"] = "probe-ok".into();
                        info["url"] = url.clone().into();
                        info
                    }
                    Err(err) => serde_json::json!({ "kind": "probe-fail", "url": url, "error": err }),
                };
                if let Err(err) = proxy.send_event(Command::DownloadEvent(event)) {
                    log_err(&format!("回传探测结果失败: {err}"));
                }
            });
        }
        Some("download:start") => {
            let request_id = payload.get("requestId").and_then(Value::as_str).unwrap_or("").to_string();
            let title = payload.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            let (Some(url), Some(mode)) = (
                payload.get("url").and_then(Value::as_str),
                payload.get("mode").and_then(Value::as_str),
            ) else {
                return;
            };
            let format_id = payload
                .get("formatId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // 选中的格式是否自带音轨。YouTube 1080p 以上音视频分离，页面选中的
            // 多是不含音轨的视频轨，缺了这条就会下出无声视频。
            let has_audio = payload
                .get("hasAudio")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let url = url.to_string();
            let mode = mode.to_string();
            // 输出目录，按优先级：
            //   1. 页面显式指定的 outDir（必须在用户家目录之下，防注入）；
            //   2. 设置面板「下载设置 → 下载文件夹」里手填的绝对路径
            //      （支持 ~ 开头；前后引号/空白顺手剥掉，Finder 的
            //      「拷贝为路径名称」带引号也能直接粘）；
            //   3. 默认：系统下载文件夹下的 WeTube 子目录——macOS 是
            //      /Users/<用户名>/Downloads/WeTube，Windows 是
            //      C:\Users\<用户名>\Downloads\WeTube（Known Folder）。
            let out_dir = match payload.get("outDir").and_then(Value::as_str) {
                Some(dir) if dirs::home_dir().is_some_and(|home| Path::new(dir).starts_with(&home)) => {
                    PathBuf::from(dir)
                }
                _ => {
                    let configured = store
                        .full_config()
                        .get("downloadSettings")
                        .and_then(|node| node.get("folder"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .map(|s| s.trim_matches('"').trim_matches('\'').trim())
                        .filter(|s| !s.is_empty())
                        .and_then(resolve_dir_input);
                    configured.unwrap_or_else(default_download_dir)
                }
            };
            if let Err(err) = cookies::export(webview) {
                log_err(&format!("导出 cookie 失败：{err}"));
            }
            let cookies = cookie_source(store);
            // 并发分片数：设置面板「下载设置 → 并发分片」，缺省 8
            let concurrent = store
                .full_config()
                .get("downloadSettings")
                .and_then(|node| node.get("concurrency"))
                .and_then(|value| {
                    value
                        .as_u64()
                        .map(|n| n as u32)
                        .or_else(|| value.as_str().and_then(|s| s.parse::<u32>().ok()))
                })
                .unwrap_or(download::DEFAULT_CONCURRENT_FRAGMENTS);
            let proxy = proxy.clone();
            match download::start(
                download::Job {
                    url: &url,
                    mode: &mode,
                    format_id: &format_id,
                    has_audio,
                    out_dir: &out_dir,
                    concurrent,
                    cookies: &cookies,
                },
                {
                    let proxy = proxy.clone();
                    let url = url.clone();
                    let mode = mode.clone();
                    let request_id = request_id.clone();
                    move |id| {
                        let _ = proxy.send_event(Command::DownloadEvent(
                            serde_json::json!({ "kind": "started", "id": id, "url": url, "mode": mode, "requestId":request_id, "title":title }),
                        ));
                    }
                },
                // 进度回调：包装上任务标识送回主线程
                {
                    let proxy = proxy.clone();
                    move |id, progress| {
                        let _ = proxy.send_event(Command::DownloadEvent(
                            serde_json::json!({
                                "kind": "progress",
                                "id": id,
                                "progress": progress,
                            }),
                        ));
                    }
                },
                {
                    let proxy = proxy.clone();
                    move |id, ok, detail| {
                        let kind = if ok { "done" } else { "fail" };
                        let _ = proxy.send_event(Command::DownloadEvent(
                            serde_json::json!({
                                "kind": kind,
                                "id": id,
                                "detail": detail,
                            }),
                        ));
                    }
                },
                // 取消回调：cleanup 线程在检测到我们取消时调用
                // 发 fail 事件带"已取消"，前端状态守卫确保不会覆盖已收到的 cancelled 事件
                {
                    let proxy = proxy.clone();
                    move |id| {
                        let _ = proxy.send_event(Command::DownloadEvent(
                            serde_json::json!({
                                "kind": "fail",
                                "id": id,
                                "detail": "已取消",
                            }),
                        ));
                    }
                },
            ) {
                Ok(_) => {}
                Err(err) => {
                    let _ = proxy.send_event(Command::DownloadEvent(
                        serde_json::json!({ "kind": "fail", "id": 0, "detail": err, "requestId":request_id }),
                    ));
                }
            }
        }
        Some("download:cancel") => {
            if let Some(id) = payload.get("id").and_then(Value::as_u64) {
                let killed = download::cancel(id as u32);
                let _ = proxy.send_event(Command::DownloadEvent(
                    serde_json::json!({ "kind": "cancelled", "id": id, "killed": killed }),
                ));
            }
        }
        _ => {}
    }
}

/// 把用户在设置里手填的目录字符串解析成 PathBuf。
///
/// 支持 `~` 与 `~/` 开头（展开到家目录）；路径不含 `~` 时按原样使用
/// （相对路径会被 resolve 成 cwd 下的路径，不算错误，但一般没人这么填）。
/// 明显不像路径的输入（含空中间段的）直接判无效，回退默认目录。
fn resolve_dir_input(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed == "~" {
        return dirs::home_dir();
    }
    if let Some(rest) = trimmed.strip_prefix("~/").or(trimmed.strip_prefix("~\\")) {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    Some(PathBuf::from(trimmed))
}

/// 从设置里读 cookie 来源（「设置 → 下载设置」）。
///
/// cookies.txt 路径优先；没填就看「从浏览器读取」选的是哪个浏览器。
/// 两者都没配就是不用 cookie——YouTube 弹机器人校验时才会体现出来。
fn cookie_source(store: &ConfigStore) -> download::CookieSource {
    let settings = store.full_config();
    let node = settings.get("downloadSettings");
    let file = node
        .and_then(|node| node.get("cookiesFile"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let browser = node
        .and_then(|node| node.get("cookiesFromBrowser"))
        .and_then(Value::as_str)
        .unwrap_or("");
    download::CookieSource::from_settings(file, browser)
}

/// 默认下载目录：系统下载文件夹下的 WeTube 子目录。
///
/// macOS：~/Downloads/WeTube；Windows：Known Folder "Downloads"（一般是
/// C:\Users\<用户名>\Downloads）下的 WeTube。拿不到系统下载文件夹时
/// 兜底到家目录拼 Downloads。
fn default_download_dir() -> PathBuf {
    let base = dirs::download_dir()
        .or_else(|| dirs::home_dir().map(|home| home.join("Downloads")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("WeTube")
}

/// 改（或清空）一项快捷键：落盘 → 更新菜单项 → 让页面重绘。
fn apply_shortcut(
    store: &mut ConfigStore,
    webview: &WebView,
    menu_items: Option<&MenuItemMap>,
    id: &str,
    spec: Option<&str>,
) {
    // 前端已经挡过一道，这里再挡一道：配置文件是能被手改的。
    let spec = match spec {
        Some(raw) => {
            if !shortcuts::is_valid(raw) {
                log_err(&format!("忽略非法快捷键({id}): {raw}"));
                return;
            }
            // 归一化成规范写法，冲突比对和"是否改过默认值"才准
            shortcuts::normalize(raw)
        }
        None => None,
    };

    if let Err(err) = store.set_shortcut(id, spec.as_deref()) {
        log_err(&format!("保存快捷键失败: {err}"));
        return;
    }
    sync_shortcuts(store, webview, menu_items, Some(id));
}

/// 全部快捷键恢复默认。
fn reset_all_shortcuts(
    store: &mut ConfigStore,
    webview: &WebView,
    menu_items: Option<&MenuItemMap>,
) {
    if let Err(err) = store.reset_shortcuts() {
        log_err(&format!("重置快捷键失败: {err}"));
        return;
    }
    sync_shortcuts(store, webview, menu_items, None);
}

/// 把注册表里的最新值推给菜单和页面。
///
/// `only` 传 `Some(id)` 只同步一项，`None` 表示全部（重置时用）。
/// 菜单项用的是 `Rc` 克隆体，对它调 `set_accelerator` 就是改菜单栏上那个。
fn sync_shortcuts(
    store: &ConfigStore,
    webview: &WebView,
    menu_items: Option<&MenuItemMap>,
    only: Option<&str>,
) {
    if let Some(items) = menu_items {
        for def in shortcuts::SHORTCUTS {
            if let Some(id) = only {
                if def.id != id {
                    continue;
                }
            }
            let Some(item) = items.get(def.id) else {
                continue;
            };
            let accel = shortcuts::resolve(def.id, store.shortcut(def.id));
            if let Err(err) = item.set_accelerator(accel) {
                log_err(&format!("更新菜单快捷键失败({}): {err}", def.id));
            }
        }
    }

    // 面板和 Windows 的 HTML 菜单都从这份注册表渲染，整体推一次最省心。
    eval(
        webview,
        &format!(
            "window.__wetubeOnShortcutsChanged?.({});",
            shortcuts::registry_json(store.shortcuts())
        ),
    );
}

/// 跟随窗口全屏状态切换 HTML chrome 的显隐：全屏时整个藏掉，给视频让出屏幕。
/// 幂等，进入/退出全屏（含系统路径）时都可安全调用。
fn sync_fullscreen_chrome(window: &Window, webview: &WebView) {
    let visible = window.fullscreen().is_none();
    eval(webview, &format!("window.__wetubeSetChromeVisible?.({visible})"));
}

/// 上次执行 fullscreen 指令的时刻，用来去重。
///
/// 全屏指令有两条独立来源：
///   1. 菜单加速键 —— muda 把快捷键注册成 NSMenuItem 的 key equivalent；
///   2. 页面里的快捷键分发 —— `src/ui.js` 的 keydown 按注册表查出 id 后发 IPC。
///
/// 理想情况下 AppKit 处理 key equivalent 时会把按键吃掉，页面收不到；但按键
/// 有时会继续传到 WKWebView，于是两条路径都触发一次 `act("fullscreen")`。
/// 第一次按 `window.fullscreen().is_none()` 判定要进入，第二次状态已更新，
/// 判定成退出——表现就是「刚进全屏又被弹回来」。
/// 播放页上看不出来，是因为浏览器的元素全屏把窗口那一下抖动盖住了。
static LAST_FULLSCREEN: Mutex<Option<Instant>> = Mutex::new(None);

/// 去重窗口。两条路径的间隔通常只有几毫秒，250ms 足够覆盖；
/// 又不至于妨碍用户隔一小会儿再按一次切回窗口。
const FULLSCREEN_DEDUPE: Duration = Duration::from_millis(250);

/// 窗口期内重复到达的 fullscreen 指令判为重复触发，直接丢弃。
///
/// 只对 fullscreen 做：它是个开关，重复执行一次就翻转了。
/// 后退 / 刷新那些是「重复执行没什么副作用」或「用户可能真想连按两次」的，
/// 拦了反而碍事。
fn fullscreen_is_duplicate() -> bool {
    let Ok(mut last) = LAST_FULLSCREEN.lock() else {
        return false;
    };
    let now = Instant::now();
    let duplicate = last.is_some_and(|t| now.duration_since(t) < FULLSCREEN_DEDUPE);
    if !duplicate {
        *last = Some(now);
    }
    duplicate
}

/// 调试日志开关：设了 `WETUBE_DEBUG=1` 才输出，平时只有一次 OnceLock 查表。
///
/// 排查快捷键「被触发了几次、每次看到的窗口状态是什么」时开：
///   WETUBE_DEBUG=1 ~/WorkBuddy/WeTube/target/release/WeTube.app/Contents/MacOS/WeTube
fn debug_enabled() -> bool {
    static ENABLED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("WETUBE_DEBUG").is_some())
}

fn debug_log(line: &str) {
    if debug_enabled() {
        eprintln!("[WeTube] {line}");
    }
}

/// 执行一条来自工具栏或菜单的指令。
fn act(webview: &WebView, window: &Window, action: &str) {
    if debug_enabled() {
        debug_log(&format!(
            "act({action}) 进入时全屏={}",
            window.fullscreen().is_some()
        ));
    }
    match action {
        "back" => eval(webview, "history.back()"),
        "forward" => eval(webview, "history.forward()"),
        "reload" => eval(webview, "location.reload()"),
        "home" => {
            if let Err(err) = webview.load_url(HOME_URL) {
                log_err(&format!("导航失败: {err}"));
            }
        }
        "open-external" => eval(webview, "window.ipc.postMessage('open:'+location.href)"),
        "settings" => eval(webview, "window.__YTE?.togglePanel?.()"),
        // 菜单事件走 menu 分支，键盘快捷键走这里，两边都能开。
        "shortcuts" => eval(webview, "window.__wetubeToggleShortcutPanel?.()"),
        "fullscreen" => {
            // 菜单和页面可能各触发一次，丢掉紧接着的重复那次
            if fullscreen_is_duplicate() {
                debug_log("act(fullscreen) 判为重复触发，丢弃");
                return;
            }
            let next_full = window.fullscreen().is_none();
            debug_log(&format!("act(fullscreen) 切换为 next_full={next_full}"));
            window.set_fullscreen(if next_full {
                Some(Fullscreen::Borderless(None))
            } else {
                None
            });
            // 切完立刻按「将要进入的状态」同步 chrome 显隐，别等 Resized——
            // tao 在全屏切换时序里不保证 fullscreen() 同步反映新状态。
            //
            if next_full {
                eval(webview, &format!("window.__wetubeSetChromeVisible?.({})", !next_full));
            } else {
                // 退出时要连浏览器的元素全屏一起退掉，否则播放器还留在全屏里，
                // WebKit 会弹「按 Esc 退出全屏」的浮层盖住整个页面。
                eval(
                    webview,
                    &format!(
                        "window.__wetubeSetChromeVisible?.({hidden}); \
                         window.__wetubeExitElementFullscreen?.();",
                        hidden = !next_full,
                    ),
                );
            }
        }
        // YouTube 播放器按钮的 HTML5 全屏联动：元素全屏时窗口跟着全屏，
        // 退出时窗口还原。状态由前端在 fullscreenchange 里上报（见 src/ui.js）。
        "player-fullscreen:on" | "player-fullscreen:off" => {
            let entering = action.ends_with(":on");
            debug_log(&format!(
                "播放器上报 entering={entering}，当前窗口全屏={}",
                window.fullscreen().is_some()
            ));
            // macOS：WKWebView 的元素全屏由 WebKit 自己的专用全屏窗口接管
            // （wry 恒开 setElementFullscreenEnabled，见 WKFullScreenWindowController：
            // 视图被整体搬进 borderless 的 WebCoreFullScreenWindow 铺满屏幕），
            // 跟 Safari 里视频全屏同一机制，宿主窗口本就不需要动。这里若再
            // set_fullscreen 会触发原生全屏的 Space 切换，把 WebKit 的元素全屏
            // 中途打断——元素全屏被迫退出、player-fullscreen:off 又把窗口还原，
            // 表现就是「点播放器全屏后刚放大又自动弹回」。所以 macOS 上窗口不动。
            //
            // Windows：WebView2 的元素全屏只铺满 WebView 自身区域，必须把窗口
            // 也切到全屏视频才能真正铺满；chrome 显隐也走这条链路同步。
            #[cfg(not(target_os = "macos"))]
            {
                window.set_fullscreen(if entering {
                    Some(Fullscreen::Borderless(None))
                } else {
                    None
                });
                eval(
                    webview,
                    &format!("window.__wetubeSetChromeVisible?.({})", !entering),
                );
            }
        }
        // 窗口控制（被自定义标题栏调用，macOS 上通常不会到这里）。
        "window-minimize" => window.set_minimized(true),
        "window-toggle-maximize" => {
            window.set_maximized(!window.is_maximized());
        }
        // 前端在标题栏拖动区按下时发来，由系统接管窗口拖动。
        // 只有 Windows 需要这条：macOS 的 WKWebView 认 `-webkit-app-region: drag`，
        // 前端也只在 Windows 下才发这条指令（见 src/titlebar.js）。
        #[cfg(target_os = "windows")]
        "window-drag" => start_window_drag(window),
        other => {
            if other != "window-drag" {
                log_err(&format!("未知指令: {other}"));
            }
        }
    }
}

fn eval(webview: &WebView, script: &str) {
    if let Err(err) = webview.evaluate_script(script) {
        log_err(&format!("执行脚本失败: {err}"));
    }
}

/// 深色模式下先把底色压暗，避免加载 YouTube 之前闪一下白屏。
fn background_color() -> RGBA {
    match dark_light::detect() {
        Ok(dark_light::Mode::Dark) => (24, 24, 24, 255),
        _ => (255, 255, 255, 255),
    }
}

/// 拼 document-start 注入脚本：先放数据，再放读数据的代码。
///
/// titlebar.js 在 ui.js 之前注入——前者依赖图标的 inline 注入先完成，
/// 后者再往 `document.body` 追加工具栏。
fn init_script() -> String {
    format!(
        "(() => {{\n\
         const pageId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');\n\
         window.__WETUBE_PAGE_ID__ = pageId;\n\
         let booted = false;\n\
         window.__wetubeBootstrap = (id, config, shortcuts, trusted) => {{\n\
         if (id !== pageId || booted) return; booted = true;\n\
         window.__YTE_SCHEMA__ = {schema};\n\
         window.__YTE_CONFIG__ = config;\n\
         window.__WETUBE_PLATFORM__ = \"{platform}\";\n\
         window.__WETUBE_SHORTCUTS__ = shortcuts;\n\
         {presets}\n\
         {assets}\n\
         {titlebar}\n\
         {toolbar}\n\
         if (!trusted) return;\n\
         {enhancer}\n\
         {shortcut_panel}\n\
         {download_panel}\n\
         }};\n\
         const ready = () => window.ipc.postMessage(JSON.stringify({{type:'app:ready', pageId}}));\n\
         if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, {{once:true}});\n\
         else ready();\n\
         }})();",
        schema = js_literal(config::SCHEMA_JSON),
        platform = PLATFORM,
        presets = DEEPDARK_PRESETS_JS,
        assets = ENHANCER_ASSETS_JS,
        titlebar = TITLEBAR_JS,
        toolbar = TOOLBAR_JS,
        enhancer = ENHANCER_JS,
        shortcut_panel = SHORTCUT_PANEL_JS,
        download_panel = DOWNLOAD_PANEL_JS,
    )
}

/// JSON 嵌进 <script> 时要断开 `</` 和行分隔符，否则会提前结束脚本块。
fn js_literal(json: &str) -> String {
    json.replace("</", "<\\/")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

// ---------------------------------------------------------------- 菜单

use muda::{
    accelerator::Accelerator,
    Menu, MenuItem, PredefinedMenuItem, Submenu,
};
// Code / Modifiers 现在只有 Windows 菜单里的 Alt+F4 还在用，macOS 下那条分支
// 整个被 cfg 掉了。属性不能挂在嵌套的 use 项上，所以单独拆一条出来。
#[cfg_attr(target_os = "macos", allow(unused_imports))]
use muda::accelerator::{Code, Modifiers};
#[cfg(target_os = "macos")]
use muda::AboutMetadata;

/// 取某项快捷键当前生效的 `Accelerator`。
///
/// 用户改过就用改过的，没改过用注册表里的默认值；注册表里查不到返回 `None`，
/// 菜单项就没有快捷键。
fn accel_for(store: &ConfigStore, id: &str) -> Option<Accelerator> {
    shortcuts::resolve(id, store.shortcut(id))
}

/// 建好的菜单里，可自定义快捷键那几项的引用。
///
/// `MenuItem` 内部是 `Rc<RefCell<MenuChild>>`，克隆体和原对象是同一个底层菜单项。
/// 所以改快捷键时直接对这里存的引用调 `set_accelerator` 就能就地生效，
/// 不必重建整棵菜单——也就不用操心新 Menu 的存活期。
type MenuItemMap = HashMap<String, MenuItem>;

/// 把建好的菜单项登记进 `items`，顺手把所有权交回给调用方（菜单里用的是它的引用）。
fn track(items: &mut MenuItemMap, id: &str, item: &MenuItem) {
    items.insert(id.to_string(), item.clone());
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(store: &ConfigStore) -> Result<(Menu, MenuItemMap), Box<dyn Error>> {
    let mut items = MenuItemMap::new();

    let nav_back = MenuItem::with_id("back", "后退", true, accel_for(store, "back"));
    let nav_forward = MenuItem::with_id("forward", "前进", true, accel_for(store, "forward"));
    let nav_reload = MenuItem::with_id("reload", "刷新", true, accel_for(store, "reload"));
    let nav_home = MenuItem::with_id("home", "回到首页", true, accel_for(store, "home"));
    let nav_open = MenuItem::with_id(
        "open-external",
        "在系统浏览器中打开",
        true,
        accel_for(store, "open-external"),
    );

    let view_shortcuts =
        MenuItem::with_id("shortcuts", "快捷键设置…", true, accel_for(store, "shortcuts"));
    let view_settings = MenuItem::with_id("settings", "增强设置…", true, accel_for(store, "settings"));
    let view_fullscreen =
        MenuItem::with_id("fullscreen", "切换全屏", true, accel_for(store, "fullscreen"));
    let nav = Submenu::with_items(
        "导航",
        true,
        &[
            &nav_back,
            &nav_forward,
            &nav_reload,
            &PredefinedMenuItem::separator(),
            &nav_home,
            &nav_open,
        ],
    )?;

    let view = Submenu::with_items(
        "视图",
        true,
        &[
            &view_shortcuts,
            &view_settings,
            &PredefinedMenuItem::separator(),
            &view_fullscreen,
        ],
    )?;

    track(&mut items, "back", &nav_back);
    track(&mut items, "forward", &nav_forward);
    track(&mut items, "reload", &nav_reload);
    track(&mut items, "home", &nav_home);
    track(&mut items, "open-external", &nav_open);
    track(&mut items, "shortcuts", &view_shortcuts);
    track(&mut items, "settings", &view_settings);
    track(&mut items, "fullscreen", &view_fullscreen);

    // 所有子菜单都得先于 `top` 声明，否则引用活不过 Menu::with_items。
    #[cfg(target_os = "macos")]
    let (app, edit, window_menu) = {
        let app = Submenu::with_items(
            APP_NAME,
            true,
            &[
                &PredefinedMenuItem::about(
                    None,
                    Some(AboutMetadata {
                        name: Some(APP_NAME.to_string()),
                        version: Some(env!("CARGO_PKG_VERSION").to_string()),
                        comments: Some("一个同时支持 macOS 与 Windows 的 YouTube 桌面端App，内建 YouTube-Enhancer".to_string()),
                        website: Some(PROJECT_URL.to_string()),
                        ..Default::default()
                    }),
                ),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::services(None),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::hide(None),
                &PredefinedMenuItem::hide_others(None),
                &PredefinedMenuItem::show_all(None),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::quit(None),
            ],
        )?;
        let edit = Submenu::with_items(
            "编辑",
            true,
            &[
                &PredefinedMenuItem::undo(None),
                &PredefinedMenuItem::redo(None),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::cut(None),
                &PredefinedMenuItem::copy(None),
                &PredefinedMenuItem::paste(None),
                &PredefinedMenuItem::select_all(None),
            ],
        )?;
        let window_menu = Submenu::with_items(
            "窗口",
            true,
            &[
                &PredefinedMenuItem::minimize(None),
                &PredefinedMenuItem::maximize(None),
                &PredefinedMenuItem::separator(),
                &PredefinedMenuItem::bring_all_to_front(None),
            ],
        )?;
        window_menu.set_as_windows_menu_for_nsapp();
        (app, edit, window_menu)
    };

    #[cfg(not(target_os = "macos"))]
    let (file, help) = {
        let file = Submenu::with_items(
            "文件",
            true,
            &[&MenuItem::with_id(
                "quit",
                "退出",
                true,
                Some(Accelerator::new(Some(Modifiers::ALT), Code::F4)),
            )],
        )?;
        let help = Submenu::with_items(
            "帮助",
            true,
            &[&MenuItem::with_id("project", "项目主页", true, None)],
        )?;
        (file, help)
    };

    #[cfg(target_os = "macos")]
    let top: Vec<&dyn muda::IsMenuItem> = vec![&app, &edit, &nav, &view, &window_menu];
    #[cfg(not(target_os = "macos"))]
    let top: Vec<&dyn muda::IsMenuItem> = vec![&file, &nav, &view, &help];

    Ok((Menu::with_items(&top)?, items))
}

#[cfg(target_os = "macos")]
fn install_menu(menu: &Menu, _window: &Window) -> Result<(), Box<dyn Error>> {
    // macOS 只有一个全局菜单栏，直接挂到 NSApp 上即可。
    menu.init_for_nsapp();
    Ok(())
}

#[cfg(target_os = "windows")]
#[allow(dead_code)] // 仅在 macOS 上调用，但留着方便 Linux 等无原生菜单场景的扩展。
fn install_menu(_menu: &Menu, _window: &Window) -> Result<(), Box<dyn Error>> {
    // 自定义 HTML chrome 已经接管菜单，不再挂系统菜单栏到 hwnd。
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[allow(dead_code)]
fn install_menu(_menu: &Menu, _window: &Window) -> Result<(), Box<dyn Error>> {
    // Linux 上 muda 需要 GTK 容器，这里暂不支持菜单，工具栏与快捷键依旧可用。
    Ok(())
}

// ---------------------------------------------------------------- 拖拽

/// 让 Windows 接管窗口拖动：向 HWND 发送 `WM_SYSCOMMAND` + `SC_MOVE | HTCAPTION`。
///
/// 这个消息会进入系统的模态拖动循环（鼠标被 OS 捕获，跟着光标走，松手结束），
/// 跟拖原生标题栏完全一致——最大化态下拖动还会自动还原。WebView2 不认
/// `-webkit-app-region: drag`，所以必须用这条系统消息来代替。
#[cfg(target_os = "windows")]
fn start_window_drag(window: &Window) {
    use std::ffi::c_void;

    const WM_SYSCOMMAND: u32 = 0x0112;
    const SC_MOVE: usize = 0xF010;
    const HTCAPTION: usize = 0x0002;

    unsafe extern "system" {
        fn ReleaseCapture() -> i32;
        fn PostMessageW(hWnd: *mut c_void, Msg: u32, wParam: usize, lParam: isize) -> i32;
    }

    let handle = match window.window_handle() {
        Ok(h) => h,
        Err(_) => return,
    };
    if let RawWindowHandle::Win32(win32) = handle.as_ref() {
        let hwnd = win32.hwnd.get() as *mut c_void;
        // SAFETY: hwnd 来自 tao 的窗口句柄，生命周期覆盖整个 main。
        unsafe {
            // 关键：WebView2 在 mousedown 时捕获了鼠标，不释放的话系统的移动循环
            // 收不到后续鼠标消息，拖动会完全没反应。必须先把捕获放掉。
            ReleaseCapture();
            // 用 PostMessage 而非 SendMessage：SendMessage 是同步的，会在处理 IPC
            // 的回调里直接阻塞进系统移动循环，卡住整个事件循环。投递出去更干净。
            PostMessageW(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
        }
    }
}
