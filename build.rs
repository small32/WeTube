use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    bundle_enhancer();

    #[cfg(target_os = "windows")]
    windows_icon();

    println!("cargo:rerun-if-changed=src/enhancer");
    println!("cargo:rerun-if-changed=src/ui.js");
    println!("cargo:rerun-if-changed=icons");
}

/// 把注入脚本拼成一个文件，省得运行时每次启动都做字符串拼接。
///
/// 另外把 CSS 转成 JS 字符串常量——CSS 里什么字符都可能有，用 JSON 转义最省事。
fn bundle_enhancer() {
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR 未设置"));
    let src = Path::new("src/enhancer");

    let bundle = ["runtime.js", "features.js", "panel.js"]
        .iter()
        .map(|name| {
            fs::read_to_string(src.join(name))
                .unwrap_or_else(|err| panic!("读取 src/enhancer/{name} 失败: {err}"))
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

/// 给 Windows 可执行文件塞进图标和版本信息。
///
/// 需要 Windows SDK 里的 rc.exe（装了 MSVC 生成工具就有）。找不到的话只是没有图标，
/// 不影响编译和运行。
#[cfg(target_os = "windows")]
fn windows_icon() {
    let result = winresource::WindowsResource::new()
        .set_icon("icons/app.ico")
        .set("ProductName", "WeTube")
        .set("FileDescription", "WeTube — YouTube 桌面壳")
        .set("CompanyName", "WeTube")
        .set("OriginalFilename", "wetube.exe")
        .compile();

    if let Err(err) = result {
        println!("cargo:warning=嵌入 Windows 图标失败（不影响运行）: {err}");
    }
}
