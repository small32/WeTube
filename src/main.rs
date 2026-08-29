//! WeTube — 一个内建 YouTube-Enhancer 的 YouTube 桌面壳。
//!
//! 前身是 [MacTube](https://github.com/diontron/MacTube)（macOS 上的 SwiftUI +
//! WKWebView 小应用），这里用 Rust 重写并同时支持 macOS 与 Windows。
//!
//!   * 窗口：tao（Tauri 的窗口库，winit 的分支）
//!   * 网页：wry（macOS 用 WKWebView，Windows 用 WebView2，都是系统自带内核）
//!   * 菜单：macOS 用系统全局菜单栏；其他平台把菜单搬进 WebView 自己的 HTML 顶部 chrome
//!   * 增强：注入的 JS，配置由 Rust 侧持久化，设置面板按 schema 自动生成

// release 版关掉控制台窗口（Windows 上 Rust 默认会弹一个黑乎乎的 cmd 窗口）。
// debug 版保留，方便开发时看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::Value;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Fullscreen, Icon, Window, WindowBuilder},
};
use wry::{http::Request, NewWindowResponse, RGBA, WebView, WebViewBuilder};

#[cfg(target_os = "macos")]
use muda::MenuEvent;

mod config;
use config::ConfigStore;

const APP_NAME: &str = "WeTube";
const HOME_URL: &str = "https://www.youtube.com";
#[allow(dead_code)] // 仅 macOS 菜单里 "项目主页" 用到
const PROJECT_URL: &str = "http://small32.top:8418/winc0/WeTube";

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
    eprintln!("[wetube] {message}");
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut store = ConfigStore::load()?;
    let init_script = init_script(&store);

    let event_loop = EventLoopBuilder::<Command>::with_user_event().build();

    let window = {
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
    let menu = build_menu()?;
    #[cfg(target_os = "macos")]
    install_menu(&menu, &window)?;

    #[cfg(target_os = "macos")]
    let menu_proxy = event_loop.create_proxy();
    #[cfg(target_os = "macos")]
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_proxy.send_event(Command::Menu(event.id().0.clone()));
    }));

    // 从自定义标题栏"关闭"按钮进来时，事件循环退出要靠这个共享标志触发。
    // tao 的 Window 没有直接 close()，我们只能让 control_flow = Exit。
    let window_close_pending = AtomicBool::new(false);

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
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(Command::Ipc(msg)) => {
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
                    Ok(Value::Object(payload)) => handle_panel_message(&mut store, &webview, &payload),
                    _ => act(&webview, &window, &msg),
                }
            }
            #[cfg(target_os = "macos")]
Event::UserEvent(Command::Menu(id)) => {
                if id == "quit" {
                    *control_flow = ControlFlow::Exit;
                } else if id == "project" {
                    if let Err(err) = open::that(PROJECT_URL) {
                        log_err(&format!("打开项目主页失败: {err}"));
                    }
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
fn handle_panel_message(store: &mut ConfigStore, webview: &WebView, payload: &serde_json::Map<String, Value>) {
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
        _ => {}
    }
}

/// 执行一条来自工具栏或菜单的指令。
fn act(webview: &WebView, window: &Window, action: &str) {
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
        "fullscreen" => {
            let next = if window.fullscreen().is_some() {
                None
            } else {
                Some(Fullscreen::Borderless(None))
            };
            window.set_fullscreen(next);
        }
        // 窗口控制（被自定义标题栏调用，macOS 上通常不会到这里）。
        "window-minimize" => window.set_minimized(true),
        "window-toggle-maximize" => {
            window.set_maximized(!window.is_maximized());
        }
        other => log_err(&format!("未知指令: {other}")),
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
         {presets}\n\
         {assets}\n\
         {titlebar}\n\
         {toolbar}\n\
         {enhancer}\n",
        schema = js_literal(store.schema()),
        config = js_literal(&store.full_config().to_string()),
        presets = DEEPDARK_PRESETS_JS,
        assets = ENHANCER_ASSETS_JS,
        titlebar = TITLEBAR_JS,
        toolbar = TOOLBAR_JS,
        enhancer = ENHANCER_JS,
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
    accelerator::{Accelerator, Code, Modifiers},
    Menu, MenuItem, PredefinedMenuItem, Submenu,
};
#[cfg(target_os = "macos")]
use muda::AboutMetadata;

/// 主快捷键：macOS 用 Command，Windows / Linux 用 Control。
#[cfg(target_os = "macos")]
const PRIMARY: Modifiers = Modifiers::SUPER;
#[cfg(not(target_os = "macos"))]
const PRIMARY: Modifiers = Modifiers::CONTROL;

fn accel(key: Code, extra: Modifiers) -> Option<Accelerator> {
    Some(Accelerator::new(Some(PRIMARY | extra), key))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu() -> Result<Menu, Box<dyn Error>> {
    let nav = Submenu::with_items(
        "导航",
        true,
        &[
            &MenuItem::with_id("back", "后退", true, accel(Code::ArrowLeft, Modifiers::empty())),
            &MenuItem::with_id(
                "forward",
                "前进",
                true,
                accel(Code::ArrowRight, Modifiers::empty()),
            ),
            &MenuItem::with_id("reload", "刷新", true, accel(Code::KeyR, Modifiers::empty())),
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id("home", "回到首页", true, accel(Code::KeyH, Modifiers::SHIFT)),
            &MenuItem::with_id(
                "open-external",
                "在系统浏览器中打开",
                true,
                accel(Code::KeyO, Modifiers::SHIFT),
            ),
        ],
    )?;

    let view = Submenu::with_items(
        "视图",
        true,
        &[
            &MenuItem::with_id(
                "settings",
                "增强设置…",
                true,
                accel(Code::Comma, Modifiers::empty()),
            ),
            &PredefinedMenuItem::separator(),
            &MenuItem::with_id(
                "fullscreen",
                "切换全屏",
                true,
                Some(Accelerator::new(None, Code::F11)),
            ),
        ],
    )?;

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
                        comments: Some("一个同时支持 macOS 与 Windows 的 YouTube 桌面壳，内建 YouTube-Enhancer".to_string()),
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

    Ok(Menu::with_items(&top)?)
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
