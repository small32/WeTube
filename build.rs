use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    bundle_enhancer();
    window_icon_rgba();

    // ⚠️ 这里不能用 #[cfg(target_os = "windows")]。build.rs 是为**宿主**编译的，
    // 那个 cfg 判断的也是宿主系统，不是目标系统——从 macOS 交叉编译 Windows 时
    // 它整个是 false，windows_icon() 连编译都不会编进去，产物就没有图标。
    // 判断目标系统只能靠 CARGO_CFG_TARGET_OS 这个环境变量。
    // 必须无条件调用：download.rs 里对生成文件是硬 include!，
    // 非 Windows 目标也要落一个空实现，否则那个平台直接编译不过。
    embed_bundled_tools();

    if target_os() == "windows" {
        windows_icon();
    }

    println!("cargo:rerun-if-changed=src/enhancer");
    println!("cargo:rerun-if-changed=src/ui.js");
    println!("cargo:rerun-if-changed=src/titlebar.js");
    println!("cargo:rerun-if-changed=icons");
}

/// 一个随 App 分发的外置工具：构建时内嵌进产物，运行时解出来执行。
struct BundledTool {
    /// vendor/ 下的文件名
    file: &'static str,
    /// 同目录下的版本文件名（内容是一行版本号）
    version_file: &'static str,
    /// 生成的字节常量名
    bytes_const: &'static str,
    /// 生成的版本常量名
    version_const: &'static str,
}

/// 要内嵌的工具清单。新增工具只在这里加一行，download.rs 那边同步处理即可。
/// qjs（QuickJS-NG）：yt-dlp 的 JS runtime（EJS），~2MB 替代 93MB 的 deno.exe，
/// 消 "No supported JavaScript runtime" 警告。常量名沿用 DENO_*（历史名）。
const BUNDLED_TOOLS: [BundledTool; 3] = [
    BundledTool {
        file: "yt-dlp.exe",
        version_file: "yt-dlp.version",
        bytes_const: "YTDLP_BYTES",
        version_const: "YTDLP_VERSION",
    },
    BundledTool {
        file: "ffmpeg.exe",
        version_file: "ffmpeg.version",
        bytes_const: "FFMPEG_BYTES",
        version_const: "FFMPEG_VERSION",
    },
    BundledTool {
        file: "qjs.exe",
        version_file: "qjs.version",
        bytes_const: "DENO_BYTES",
        version_const: "DENO_VERSION",
    },
];

/// 把 vendor/ 下的外置工具内嵌进产物，供 Windows 单文件分发使用。
///
/// 生成的 `bundled_tools.rs` 落进 OUT_DIR，由 download.rs include!。
/// 有 vendor/<工具> 就写真实的 include_bytes!，没有就写空切片 + 警告——
/// 没跑过 fetch 脚本的机器照样能构建，只是不内嵌、运行时退回外部查找。
fn embed_bundled_tools() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"));

    // 只有 Windows 产物需要内嵌（macOS 走 .app 的 Resources/bin）。
    // 但空实现必须照写：download.rs 对生成文件是硬 include!。
    if target_os() != "windows" {
        fs::write(out_dir.join("bundled_tools.rs"), empty_tools_rs())
            .expect("写入 bundled_tools.rs 失败");
        return;
    }

    let vendor = Path::new("vendor");
    // 直接拼 CARGO_MANIFEST_DIR 的绝对路径：fs::canonicalize 在 Windows 上
    // 会带上 \\?\ 前缀，喂给 include_bytes! 容易踩坑，这里不冒这个险。
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default();
    let mut code = String::new();

    for tool in &BUNDLED_TOOLS {
        let file = vendor.join(tool.file);
        println!("cargo:rerun-if-changed=vendor/{}", tool.file);
        println!("cargo:rerun-if-changed=vendor/{}", tool.version_file);

        if file.is_file() {
            let abs = Path::new(&manifest).join(&file);
            let version = fs::read_to_string(vendor.join(tool.version_file))
                .map(|value| value.trim().to_string())
                .unwrap_or_default();
            code.push_str(&format!(
                "pub static {}: &[u8] = include_bytes!(r\"{}\");\npub const {}: &str = \"{}\";\n",
                tool.bytes_const,
                abs.display(),
                tool.version_const,
                version
            ));
        } else {
            println!(
                "cargo:warning=未找到 vendor/{}，本次构建不内嵌它（可先跑 scripts/fetch-bundled-tools-windows.ps1）",
                tool.file
            );
            code.push_str(&format!(
                "pub static {}: &[u8] = &[];\npub const {}: &str = \"\";\n",
                tool.bytes_const, tool.version_const
            ));
        }
    }

    fs::write(out_dir.join("bundled_tools.rs"), code).expect("写入 bundled_tools.rs 失败");
}

/// 全部工具都未内嵌时的空实现。
fn empty_tools_rs() -> String {
    BUNDLED_TOOLS
        .iter()
        .map(|tool| {
            format!(
                "pub static {}: &[u8] = &[];\npub const {}: &str = \"\";\n",
                tool.bytes_const, tool.version_const
            )
        })
        .collect()
}

/// 目标系统的名字（`windows` / `macos` / `linux`…）。
///
/// build.rs 里判断目标系统只能读 `CARGO_CFG_TARGET_OS`——`cfg!(target_os)` 和
/// `#[cfg(target_os)]` 在这里都指向宿主，交叉编译时会给出错误答案。
fn target_os() -> String {
    std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default()
}

/// 把注入脚本拼成一个文件，省得运行时每次启动都做字符串拼接。
///
/// 另外把 CSS 转成 JS 字符串常量——CSS 里什么字符都可能有，用 JSON 转义最省事。
fn bundle_enhancer() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"));
    let src = Path::new("src/enhancer");

    let bundle = [
        "titlebar.js",
        "ui.js",
        "runtime.js",
        "features.js",
        "panel.js",
    ]
    .iter()
.map(|name| {
            let path = if *name == "titlebar.js" || *name == "ui.js" {
                Path::new("src").join(name)
            } else {
                src.join(name)
            };
            fs::read_to_string(&path)
                .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()))
        })
    .collect::<Vec<_>>()
    .join("\n");
    fs::write(out_dir.join("enhancer-bundle.js"), bundle).expect("写入 enhancer-bundle.js 失败");

    let styles = fs::read_to_string(src.join("styles.css")).unwrap_or_default();
    let deepdark = fs::read_to_string(src.join("deepdark-material.css")).unwrap_or_default();
    let assets = format!(
        "window.__YTE_STYLES = {styles};\nwindow.__YTE_DEEPDARK_MATERIAL = {deepdark};\n",
        styles = json_string(&styles),
        deepdark = json_string(&deepdark),
    );
    fs::write(out_dir.join("enhancer-assets.js"), assets).expect("写入 enhancer-assets.js 失败");
}

/// 转成合法的 JS 字符串字面量。顺手把 `</` 断开，免得提前闭合宿主里的 script 标签。
fn json_string(value: &str) -> String {
    let mut encoded = serde_json::to_string(value).expect("JSON 编码失败");
    encoded = encoded.replace("</", "<\\/");
    encoded
}

/// 把 `icons/AppIcon.iconset/icon_256x256.png` 解码成 RGBA 字节，
/// 与宽高一起作为常量写到 OUT_DIR，给 main.rs 的 `tao::Icon` 用。
fn window_icon_rgba() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"));
    let png_path = Path::new("icons/AppIcon.iconset/icon_256x256.png");
    let bytes = fs::read(png_path).unwrap_or_else(|err| {
        panic!("读取 {} 失败: {err}", png_path.display());
    });
    let img = image::load_from_memory(&bytes).expect("解码 PNG 失败");
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width(), rgba.height());
    let raw = rgba.into_raw();

    fs::write(out_dir.join("window-icon.rgba"), &raw).expect("写入 window-icon.rgba 失败");
    let dims = format!(
        "pub mod icon_dims {{\n    pub const W: u32 = {w};\n    pub const H: u32 = {h};\n}}\n"
    );
    fs::write(out_dir.join("window-icon-dims.rs"), dims).expect("写入 window-icon-dims.rs 失败");

    println!("cargo:rerun-if-changed=icons/AppIcon.iconset/icon_256x256.png");
}

/// 给 Windows 可执行文件塞进图标和版本信息。
///
/// 需要资源编译器：Windows 上是 SDK 的 rc.exe，交叉编译（macOS / Linux → Windows）
/// 时用 MinGW 的 windres，路径可以用 `WINDRES` 环境变量指定。找不到的话只是没有
/// 图标，不影响编译和运行——下面会把失败降级成 warning。
///
/// ⚠️ 不要给这个函数加 `#[cfg(target_os = "windows")]`：那样从非 Windows 宿主
/// 交叉编译时它根本不存在，图标就永远嵌不进去。调用点已经用 `target_os()` 判断了，
/// 这里必须让它无条件参与编译（winresource 是纯 Rust 的，任何平台都能编）。
fn windows_icon() {
    // 任务管理器进程列表的「描述」列读取 PE 资源的 FileDescription 字段。
    // 之前设成「WeTube — YouTube 桌面壳」导致系统进程里出现「YouTube桌面壳」；
    // 若不设置，winresource 会默认填包名（WeTube），仍然会显示。
    // 显式设为空字符串，让描述列完全空白。
    let mut resource = winresource::WindowsResource::new();
    resource
        .set("FileDescription", "")
        .set("ProductName", "WeTube")
        .set("CompanyName", "WeTube")
        .set("OriginalFilename", "WeTube.exe")
        .set_icon("icons/app.ico");

    // winresource 默认靠查注册表定位 rc.exe；受限环境（注册表工具被禁）下会
    // 报「系统找不到指定的路径」。这里改成直接按文件系统找 Windows SDK 的
    // rc.exe，找到了就显式传给 winresource，彻底不依赖注册表。找不到时
    // 保持默认行为（注册表探测），对正常开发机无影响。
    if let Some(rc_dir) = find_rc_dir() {
        if let Some(path) = rc_dir.to_str() {
            resource.set_toolkit_path(path);
        }
    }

    let result = resource.compile();

    if let Err(err) = result {
        println!("cargo:warning=嵌入 Windows 图标失败（不影响运行）: {err}");
    }
}

/// 在标准安装位置按文件系统找最新版本 Windows SDK 的 rc.exe 所在目录。
///
/// winresource 的 `set_toolkit_path` 约定：msvc 工具链下传入的目录会被直接
/// 拼上 `rc.exe`（找不到再试 `bin\x64` / `bin\x86`），所以这里返回
/// `...\bin\<版本>\x64` 这一层。
fn find_rc_dir() -> Option<PathBuf> {
    let root = Path::new(r"C:\Program Files (x86)\Windows Kits\10\bin");
    let mut best: Option<(String, PathBuf)> = None;
    let entries = fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // 版本目录形如 10.0.26100.0；跳过 x86 / arm64 这类非版本目录。
        if !name
            .chars()
            .next()
            .map_or(false, |c| c.is_ascii_digit())
        {
            continue;
        }
        // 优先 x64（宿主绝大多数是 x64），其次 x86。
        for arch in ["x64", "x86"] {
            let dir = entry.path().join(arch);
            let better = match &best {
                Some((version, _)) => name.as_str() > version.as_str(),
                None => true,
            };
            if dir.join("rc.exe").is_file() && better {
                best = Some((name.clone(), dir));
            }
        }
    }
    best.map(|(_, dir)| dir)
}
