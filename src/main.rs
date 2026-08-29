//! WeTube — 一个内建 YouTube-Enhancer 的 YouTube 桌面壳。
//!
//! 前身是 [MacTube](https://github.com/diontron/MacTube)（macOS 上的 SwiftUI +
//! WKWebView 小应用），这里用 Rust 重写并同时支持 macOS 与 Windows。
//!
//!   * 窗口：tao（Tauri 的窗口库，winit 的分支）
//!   * 网页：wry（macOS 用 WKWebView，Windows 用 WebView2，都是系统自带内核）
//!   * 菜单：muda（macOS 原生菜单栏 / Windows 窗口菜单栏）
//!   * 增强：注入的 JS，配置由 Rust 侧持久化，设置面板按 schema 自动生成

use std::error::Error;

use muda::MenuEvent;
use serde_json::Value;
use tao::{
    dpi::LogicalSize,
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::{Fullscreen, Window, WindowBuilder},
};
use wry::{http::Request, NewWindowResponse, RGBA, WebView, WebViewBuilder};

mod config;
use config::ConfigStore;

const APP_NAME: &str = "WeTube";
const HOME_URL: &str = "https://www.youtube.com";
const PROJECT_URL: &str = "http://small32.top:8418/winc0/WeTube";

/// WeTube 自己的工具栏（后退/前进/刷新/首页/设置）。
const TOOLBAR_JS: &str = include_str!("ui.js");
/// 增强功能运行时 + 功能实现 + 设置面板。
const ENHANCER_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/enhancer-bundle.js"));
/// 功能 CSS 与深黑主题，由 build.rs 转成 JS 字符串常量。
const ENHANCER_ASSETS_JS: &str = include_str!(concat!(env!("OUT_DIR"), "/enhancer-assets.js"));
/// 32 套 DeepDark 配色预设。
const DEEPDARK_PRESETS_JS: &str = include_str!("enhancer/deepdark-presets.js");

/// 事件循环里流动的消息：工具栏指令、菜单点击、页面标题、或设置面板的配置变更。
#[derive(Debug, Clone)]
enum Command {
    Ipc(String),
    Menu(String),
    Title(String),
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut store = ConfigStore::load()?;
    let init_script = init_script(&store);

    let event_loop = EventLoopBuilder::<Command>::with_user_event().build();

    let window = WindowBuilder::new()
        .with_title(APP_NAME)
        .with_inner_size(LogicalSize::new(1180.0, 760.0))
        .with_min_inner_size(LogicalSize::new(620.0, 420.0))
        .build(&event_loop)?;

    // 菜单必须活得比事件循环里的引用久，所以绑在 main 上。
    let menu = build_menu()?;
    install_menu(&menu, &window)?;

    let menu_proxy = event_loop.create_proxy();
    MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
        let _ = menu_proxy.send_event(Command::Menu(event.id().0.clone()));
    }));

    let ipc_proxy = event_loop.create_proxy();
    let title_proxy = event_loop.create_proxy();
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
                eprintln!("[wetube] 打开外部链接失败: {err}");
            }
            NewWindowResponse::Deny
        })
        .with_document_title_changed_handler(move |title: String| {
            let _ = title_proxy.send_event(Command::Title(title));
        })
        .build(&window)?;

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,
            Event::UserEvent(Command::Title(title)) => window.set_title(&format_title(&title)),
            Event::UserEvent(Command::Ipc(msg)) => {
                if let Some(url) = msg.strip_prefix("open:") {
                    if let Err(err) = open::that(url) {
                        eprintln!("[wetube] 打开外部链接失败: {err}");
                    }
                    return;
                }
                // 设置面板发的是 JSON，工具栏发的是裸命令
                match serde_json::from_str::<Value>(&msg) {
                    Ok(Value::Object(payload)) => handle_panel_message(&mut store, &webview, &payload),
                    _ => act(&webview, &window, &msg),
                }
            }
            Event::UserEvent(Command::Menu(id)) => {
                if id == "quit" {
                    *control_flow = ControlFlow::Exit;
                } else if id == "project" {
                    if let Err(err) = open::that(PROJECT_URL) {
                        eprintln!("[wetube] 打开项目主页失败: {err}");
                    }
                } else if id == "settings" {
                    eval(&webview, "window.__YTE?.togglePanel?.()");
                } else {
                    act(&webview, &window, &id);
                }
            }
            _ => {}
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
                eprintln!("[wetube] 保存设置失败: {err}");
            }
        }
        Some("config:reset") => {
            if let Err(err) = store.reset(None) {
                eprintln!("[wetube] 重置设置失败: {err}");
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
                eprintln!("[wetube] 导航失败: {err}");
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
        other => eprintln!("[wetube] 未知指令: {other}"),
    }
}

fn eval(webview: &WebView, script: &str) {
    if let Err(err) = webview.evaluate_script(script) {
        eprintln!("[wetube] 执行脚本失败: {err}");
    }
}

fn format_title(page_title: &str) -> String {
    let trimmed = page_title.trim();
    if trimmed.is_empty() {
        APP_NAME.to_string()
    } else {
        format!("{trimmed} — {APP_NAME}")
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
fn init_script(store: &ConfigStore) -> String {
    format!(
        "window.__YTE_SCHEMA__ = {schema};\n\
         window.__YTE_CONFIG__ = {config};\n\
         {presets}\n\
         {assets}\n\
         {toolbar}\n\
         {enhancer}\n",
        schema = js_literal(store.schema()),
        config = js_literal(&store.full_config().to_string()),
        presets = DEEPDARK_PRESETS_JS,
        assets = ENHANCER_ASSETS_JS,
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
fn install_menu(menu: &Menu, window: &Window) -> Result<(), Box<dyn Error>> {
    use wry::raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle()?;
    if let RawWindowHandle::Win32(win32) = handle.as_ref() {
        // SAFETY: hwnd 来自 tao 的窗口句柄，生命周期覆盖整个 main。
        unsafe { menu.init_for_hwnd(win32.hwnd.get() as isize)? };
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn install_menu(_menu: &Menu, _window: &Window) -> Result<(), Box<dyn Error>> {
    // Linux 上 muda 需要 GTK 容器，这里暂不支持菜单，工具栏与快捷键依旧可用。
    Ok(())
}
