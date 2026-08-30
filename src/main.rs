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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Fullscreen, Icon, Window, WindowBuilder},
};
use wry::{
    dpi::{PhysicalPosition, PhysicalSize},
    http::Request,
    NewWindowResponse, Rect, RGBA, WebView, WebViewBuilder,
};

#[cfg(target_os = "macos")]
use muda::MenuEvent;

mod config;
mod shortcuts;
use config::ConfigStore;

const APP_NAME: &str = "WeTube";
const HOME_URL: &str = "https://www.youtube.com";
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
/// 32 套 DeepDark 配色预设。
const DEEPDARK_PRESETS_JS: &str = include_str!("enhancer/deepdark-presets.js");


/// 事件循环里流动的消息：工具栏指令、菜单点击、或设置面板的配置变更。
#[derive(Debug, Clone)]
enum Command {
    Ipc(String),
    #[cfg(target_os = "macos")]
    Menu(String),
}

/// 把编译期嵌入的图标字节装成 tao::Icon。任何一步失败（图标文件缺失、PNG 解码异常等）
/// 都不影响启动——顶多窗口/任务栏没图标。
fn build_window_icon() -> Option<Icon> {
    Icon::from_rgba(WINDOW_ICON_RGBA.to_vec(), WINDOW_ICON_DIMS::W, WINDOW_ICON_DIMS::H).ok()
}

/// 输出错误日志。release 版在 Windows 上没有控制台，直接 eprintln! 会 panic；
/// 这里只在 stderr 确实是终端（即有控制台）时才写。
fn log_err(message: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::io::IsTerminal;
        if !std::io::stderr().is_terminal() {
            return;
        }
    }
    eprintln!("[WeTube] {message}");
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut store = ConfigStore::load()?;
    let init_script = init_script(&store);

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

    // 从自定义标题栏"关闭"按钮进来时，事件循环退出要靠这个共享标志触发。
    // tao 的 Window 没有直接 close()，我们只能让 control_flow = Exit。
    let window_close_pending = AtomicBool::new(false);

    // 上一次的窗口全屏状态。Esc / 绿色按钮这类系统退出路径不会走 act("fullscreen")，
    // 只在 Resized 里能察觉到，靠这个把播放器一起带出去。
    let mut was_fullscreen = false;

    let ipc_proxy = event_loop.create_proxy();
    let webview = WebViewBuilder::new()
        .with_url(HOME_URL)
        // 只注入主框架：这一坨有几百 KB，塞进每个 iframe 纯属浪费
        .with_initialization_script_for_main_only(init_script, true)
        .with_background_color(background_color())
        .with_autoplay(true)
        .with_clipboard(true)
        .with_devtools(cfg!(debug_assertions))
        .with_ipc_handler(move |req: Request<String>| {
            let _ = ipc_proxy.send_event(Command::Ipc(req.body().to_string()));
        })
        // target="_blank" / window.open 一律交给系统浏览器，别把壳子整个带走。
        .with_new_window_req_handler(|url: String, _features| {
            if let Err(err) = open::that(&url) {
                log_err(&format!("打开外部链接失败: {err}"));
            }
            NewWindowResponse::Deny
        })
        .build(&window)?;

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

                // 全屏状态真的变了才碰播放器——拖窗口同样会触发 Resized，
                // 不加这个判断会把正在全屏播放的视频一次次踢回小窗。
                let full = window.fullscreen().is_some();
                if full != was_fullscreen {
                    debug_log(&format!("Resized 察觉到全屏变化: {was_fullscreen} → {full}"));
                    was_fullscreen = full;
                    eval(
                        &webview,
                        &format!("window.__wetubeSyncPlayerFullscreen?.({full})"),
                    );
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(Command::Ipc(msg)) => {
                debug_log(&format!("指令来源: 页面 IPC → {msg:?}"));
                if let Some(url) = msg.strip_prefix("open:") {
                    if let Err(err) = open::that(url) {
                        log_err(&format!("打开外部链接失败: {err}"));
                    }
                    return;
                }
                // 设置面板发的是 JSON，工具栏/菜单发的是裸命令字符串。
                // `window-close` 之类的窗口控制命令不能直接改 control_flow，
                // 通过共享标志位告诉事件循环自己退。
                if msg == "window-close" {
                    window_close_pending.store(true, Ordering::SeqCst);
                    return;
                }
                match serde_json::from_str::<Value>(&msg) {
                    Ok(Value::Object(payload)) => {
                        handle_panel_message(&mut store, &webview, menu_items.as_ref(), &payload)
                    }
                    _ => act(&webview, &window, &msg),
                }
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

        if window_close_pending.load(Ordering::SeqCst) {
            *control_flow = ControlFlow::Exit;
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
    payload: &serde_json::Map<String, Value>,
) {
    match payload.get("type").and_then(Value::as_str) {
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
                "window.__YTE_CONFIG__ = {}; window.__YTE.syncAll({{force:true}});",
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
        // 前端的调试回传。页面的状态（有没有进元素全屏、铺满 class 挂没挂上）
        // 在 Rust 这边看不到，只能让它报回来。
        Some("debug") => {
            if let Some(msg) = payload.get("msg").and_then(Value::as_str) {
                debug_log(&format!("页面: {msg}"));
            }
        }
        Some("shortcut:reset") => {
            // 带 id 只恢复一项，不带就全部恢复默认
            match payload.get("id").and_then(Value::as_str) {
                Some(id) => apply_shortcut(store, webview, menu_items, id, None),
                None => reset_all_shortcuts(store, webview, menu_items),
            }
        }
        _ => {}
    }
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
            // 播放页上还要让播放器跟着一起进/退全屏，否则窗口铺满了但视频
            // 还是嵌在页面里的小窗。两条合并成一次 eval，保证执行顺序。
            eval(
                webview,
                &format!(
                    "window.__wetubeSetChromeVisible?.({hidden}); \
                     window.__wetubeSyncPlayerFullscreen?.({next_full});",
                    hidden = !next_full,
                    next_full = next_full,
                ),
            );
        }
        // YouTube 播放器按钮的 HTML5 全屏联动：元素全屏时窗口跟着全屏，
        // 退出时窗口还原。状态由前端在 fullscreenchange 里上报（见 src/ui.js）。
        "player-fullscreen:on" | "player-fullscreen:off" => {
            let entering = action.ends_with(":on");
            debug_log(&format!(
                "播放器上报 entering={entering}，当前窗口全屏={}",
                window.fullscreen().is_some()
            ));
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
fn init_script(store: &ConfigStore) -> String {
    format!(
        "window.__YTE_SCHEMA__ = {schema};\n\
         window.__YTE_CONFIG__ = {config};\n\
         window.__WETUBE_PLATFORM__ = \"{platform}\";\n\
         window.__WETUBE_SHORTCUTS__ = {shortcuts};\n\
         window.__WETUBE_DEBUG__ = {debug};\n\
         {presets}\n\
         {assets}\n\
         {titlebar}\n\
         {toolbar}\n\
         {enhancer}\n\
         {shortcut_panel}\n",
        schema = js_literal(store.schema()),
        config = js_literal(&store.full_config().to_string()),
        platform = PLATFORM,
        shortcuts = shortcuts::registry_json(store.shortcuts()),
        debug = if debug_enabled() { "true" } else { "false" },
        presets = DEEPDARK_PRESETS_JS,
        assets = ENHANCER_ASSETS_JS,
        titlebar = TITLEBAR_JS,
        toolbar = TOOLBAR_JS,
        enhancer = ENHANCER_JS,
        shortcut_panel = SHORTCUT_PANEL_JS,
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
