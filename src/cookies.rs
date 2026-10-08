//! 把 WeTube 内置浏览器里 youtube.com 的 cookie 导出成 Netscape
//! 格式的 cookies.txt，交给 yt-dlp 使用。
//!
//! 为什么不直接让 yt-dlp 读 WebView2 的配置目录：
//!
//! 1. **文件被独占锁住**。应用运行时 Chromium 打开 cookie 数据库时没留共享
//!    窗口，其他进程连只读打开都会被拒（实测 `--cookies-from-browser
//!    chrome:<WebView2 目录>` 报 "Could not copy Chrome cookie database"，
//!    手工 `cp` 同样是 "Device or resource busy"）。而下载只可能发生在应用
//!    运行时——关掉应用就没人下载了，所以这条路是死的。
//! 2. **就算读到了也是密文**。值用 DPAPI 加密存放（`v10`/`v20` 前缀），还得
//!    拿 Local State 里的密钥解密，新版 Chromium 更是用了 app-bound 加密。
//!
//! 走 WebView2 自己的 CookieManager 两个问题一起绕开：COM 接口返回的就是
//! 明文 name/value，既不碰那个文件，也不用解密。
//!
//! 线程亲和性：`ICoreWebView2` 是 STA 对象，本模块的函数只能在主线程调用。

use std::path::PathBuf;

/// cookies.txt 的落盘位置：`%LOCALAPPDATA%\WeTube\cookies.txt`。
///
/// 放用户数据目录而不是 exe 同级——Program Files 之类不可写，而且这是
/// 「当前用户的登录态」，本来就该按用户隔离。
pub fn cookies_path() -> Option<PathBuf> {
    let base = dirs::data_local_dir().or_else(dirs::cache_dir)?;
    Some(base.join("WeTube").join("cookies.txt"))
}

/// 导出过程的诊断日志：写到 cookies.txt 同目录的 cookies.log。
///
/// release 版是 GUI 程序没有终端，排障主要依赖这个文件。
fn log_line(message: &str) {
    let Some(path) = cookies_path().map(|p| p.with_file_name("cookies.log")) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) else {
        return;
    };
    use std::io::Write as _;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{secs}] {message}");
}

/// 同步导出一次 youtube.com 的 cookie，返回写入的条目数。
///
/// 必须在主线程调用（COM 对象有线程亲和性），内部会泵消息循环直到回调返回——
/// 所以不要在外层已经阻塞消息循环的地方调用。耗时是毫秒级。
#[cfg(windows)]
pub fn export(webview: &wry::WebView) -> Result<usize, String> {
    let target = cookies_path().ok_or("拿不到用户数据目录")?;
    let result = imp::export_sync(webview, &target);
    match &result {
        Ok(count) => log_line(&format!(
            "导出成功：{count} 条 -> {}",
            target.display()
        )),
        Err(err) => log_line(&format!("导出失败：{err}")),
    }
    result
}

#[cfg(not(windows))]
pub fn export(webview: &wry::WebView) -> Result<usize, String> {
    let target = cookies_path().ok_or("拿不到用户数据目录")?;
    let result = portable::export_sync(webview, &target);
    match &result {
        Ok(count) => log_line(&format!(
            "导出成功：{count} 条 -> {}",
            target.display()
        )),
        Err(err) => log_line(&format!("导出失败：{err}")),
    }
    result
}

#[cfg(not(windows))]
mod portable {
    use std::io::Write;
    use std::path::Path;

    /// 一条 cookie 转成 Netscape 格式的一行。**带 Domain 属性的 cookie 必须
    /// 写成前导点 + 第二列 TRUE**——否则 http.cookiejar 会当成 host-only，
    /// 请求 `www.youtube.com` 时根本不发这条 cookie，导出的文件等于白写。
    ///
    /// 返回空串表示这条不该导出（host-only cookie 拿不到 host，写空 domain
    /// 反而会让 yt-dlp 解析异常），调用方跳过。
    pub(super) fn cookie_line(cookie: &wry::cookie::Cookie<'_>) -> String {
        // cookie 库在 build 时就把前导点剥掉了，所以这里不能再靠
        // `domain.starts_with('.')` 判断——`domain()` 为 Some 本身就意味着
        // 这条 cookie 设了 Domain 属性（应作用于子域）。
        let Some(raw) = cookie.domain().filter(|d| !d.is_empty()) else {
            return String::new();
        };
        let domain = if raw.starts_with('.') {
            raw.to_string()
        } else {
            format!(".{raw}")
        };
        let include_sub = "TRUE";
        let path = cookie.path().unwrap_or("/");
        let secure = if cookie.secure().unwrap_or(false) {
            "TRUE"
        } else {
            "FALSE"
        };
        let expiry = cookie
            .expires_datetime()
            .map(|time| time.unix_timestamp())
            .unwrap_or(0);
        format!(
            "{domain}\t{include_sub}\t{path}\t{secure}\t{expiry}\t{}\t{}",
            cookie.name(),
            cookie.value(),
        )
    }

    fn write_atomic(target: &Path, text: &str) -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = target.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        std::fs::rename(&tmp, target)
    }

    pub(super) fn export_sync(webview: &wry::WebView, target: &Path) -> Result<usize, String> {
        let cookies = webview
            .cookies()
            .map_err(|err| format!("读取内置浏览器 Cookie 失败：{err}"))?;
        let mut text = String::from("# Netscape HTTP Cookie File\n");
        for cookie in &cookies {
            if cookie.name().is_empty() {
                continue;
            }
            let line = cookie_line(cookie);
            // 空串 = host-only cookie，没有 host 可写，跳过而不是留空 domain 行
            if line.is_empty() {
                continue;
            }
            text.push_str(&line);
            text.push('\n');
        }
        write_atomic(target, &text).map_err(|err| format!("写 cookies.txt 失败：{err}"))?;
        Ok(text.lines().count().saturating_sub(1))
    }
}

#[cfg(windows)]
mod imp {
    use std::cell::RefCell;
    use std::io::Write;
    use std::path::Path;
    use std::rc::Rc;

    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_2, ICoreWebView2Cookie, ICoreWebView2CookieList,
    };
    use webview2_com::GetCookiesCompletedHandler;
    use windows::core::{HSTRING, PWSTR, Interface};
    use windows_core::BOOL;
    use wry::WebViewExtWindows;

    /// 查哪个源站的 cookie。YouTube 的登录态挂在 `.youtube.com` 上，
    /// 用这个地址查能把父域 cookie 一并带出来。
    const COOKIE_URI: &str = "https://www.youtube.com";

    // COM 约定：out 形式的字符串由调用方用 CoTaskMemFree 释放。
    // 这里只用到这一个函数，不值得为它给 windows crate 开一整个 feature，
    // 直接声明 ole32 的入口即可。
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(pv: *const std::ffi::c_void);
    }

    /// 读走 PWSTR 的内容并**释放它占用的 COM 内存**。
    ///
    /// 每个 cookie 要读 Name / Value / Domain / Path 四个字符串，之前一个都不
    /// 释放——导出发生在启动、每次探测、每次下载开始时，会话久了会稳定泄漏。
    fn pwstr_to_string(ptr: PWSTR) -> String {
        if ptr.is_null() {
            return String::new();
        }
        let text = unsafe { ptr.to_string() }.unwrap_or_default();
        unsafe { CoTaskMemFree(ptr.as_ptr() as *const std::ffi::c_void) };
        text
    }

    /// 一条 cookie 转成 Netscape 格式的一行（Tab 分隔）。
    ///
    /// 字段顺序：域、是否含子域、路径、是否仅 HTTPS、过期时间、名、值。
    /// 没名字的条目跳过；过期时间拿不到就写 0（会话 cookie 的写法）。
    fn cookie_line(cookie: &ICoreWebView2Cookie) -> Option<String> {
        let mut name = PWSTR::null();
        unsafe { cookie.Name(&mut name) }.ok()?;
        let name = pwstr_to_string(name);
        if name.is_empty() {
            return None;
        }
        let mut value = PWSTR::null();
        unsafe { cookie.Value(&mut value) }.ok()?;
        let mut domain = PWSTR::null();
        unsafe { cookie.Domain(&mut domain) }.ok()?;
        let mut path = PWSTR::null();
        unsafe { cookie.Path(&mut path) }.ok()?;
        let mut secure = BOOL::default();
        unsafe { cookie.IsSecure(&mut secure) }.ok()?;
        let mut expires = 0f64;
        unsafe { cookie.Expires(&mut expires) }.ok()?;

        let domain = pwstr_to_string(domain);
        // WebView2 的 Domain 属性既不带前导点，也不区分 host-only / 带 Domain
        // 属性，拿不到「是否含子域」这个标志。YouTube 的登录态 cookie 本来
        // 就是 `.youtube.com`（含子域），一律按含子域写：写成 host-only 的话
        // 请求 www.youtube.com 时这条 cookie 根本不会被发送。
        if domain.is_empty() {
            return None;
        }
        let domain = if domain.starts_with('.') {
            domain
        } else {
            format!(".{domain}")
        };
        let include_sub = "TRUE";
        let secure_flag = if secure.as_bool() { "TRUE" } else { "FALSE" };
        let expiry = if expires > 0.0 { expires as i64 } else { 0 };
        Some(format!(
            "{domain}\t{include_sub}\t{path}\t{secure_flag}\t{expiry}\t{name}\t{value}",
            path = pwstr_to_string(path),
            value = pwstr_to_string(value),
        ))
    }

    fn netscape(list: &ICoreWebView2CookieList) -> Result<String, String> {
        let mut text = String::from("# Netscape HTTP Cookie File\n");
        let mut count = 0u32;
        unsafe { list.Count(&mut count) }
            .map_err(|err| format!("读取 Cookie 数量失败：{err}"))?;
        for index in 0..count {
            let Ok(cookie) = (unsafe { list.GetValueAtIndex(index) }) else {
                continue;
            };
            if let Some(line) = cookie_line(&cookie) {
                text.push_str(&line);
                text.push('\n');
            }
        }
        Ok(text)
    }

    fn write_atomic(target: &Path, text: &str) -> std::io::Result<()> {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = target.with_extension("tmp");
        {
            let mut file = std::fs::File::create(&tmp)?;
            file.write_all(text.as_bytes())?;
            file.sync_all()?;
        }
        let backup = target.with_extension("bak");
        if target.exists() {
            if backup.exists() {
                std::fs::remove_file(&backup)?;
            }
            std::fs::rename(target, &backup)?;
        }
        if let Err(err) = std::fs::rename(&tmp, target) {
            if backup.exists() {
                let _ = std::fs::rename(&backup, target);
            }
            return Err(err);
        }
        Ok(())
    }

    pub(super) fn export_sync(webview: &wry::WebView, target: &Path) -> Result<usize, String> {
        let core = webview.webview();
        // CookieManager 在 ICoreWebView2_2 上，基接口没有，得先 QueryInterface
        let core2 = core
            .cast::<ICoreWebView2_2>()
            .map_err(|err| format!("拿不到 ICoreWebView2_2：{err}"))?;
        let manager = unsafe { core2.CookieManager() }
            .map_err(|err| format!("取 CookieManager 失败：{err}"))?;

        // 回调在同线程触发，用 Rc<RefCell> 把结果带回来即可（不跨线程）
        let text = Rc::new(RefCell::new(None::<Result<String, String>>));
        let sink = Rc::clone(&text);

        GetCookiesCompletedHandler::wait_for_async_operation(
            // move：闭包要求 'static，manager 交给它持有（后面不再用）
            Box::new(move |handler| {
                unsafe { manager.GetCookies(&HSTRING::from(COOKIE_URI), &handler) }
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(move |error, list| {
                *sink.borrow_mut() = Some(match (error, list) {
                    (Ok(_), Some(list)) => netscape(&list),
                    (Err(err), _) => Err(format!("查询 Cookie 失败：{err:?}")),
                    (_, None) => Err("查询 Cookie 未返回列表".to_string()),
                });
                Ok(())
            }),
        )
        .map_err(|err| format!("等待 cookie 查询返回失败：{err}"))?;

        let text = text.borrow_mut().take()
            .ok_or("查询 Cookie 没有回调")??;
        write_atomic(target, &text).map_err(|err| format!("写 cookies.txt 失败：{err}"))?;
        Ok(text.lines().count().saturating_sub(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 缓存路径落在用户的 WeTube 目录下（不是 exe 同级，那里通常不可写）。
    #[test]
    fn cookies_path_points_into_app_data_dir() {
        if let Some(path) = cookies_path() {
            assert_eq!(path.file_name().unwrap(), "cookies.txt");
            assert!(path.parent().unwrap().ends_with("WeTube"));
        }
    }

    /// host-only cookie（没设 Domain 属性）拿不到 host，不能写出空 domain 的行，
    /// 否则 yt-dlp 解析到的就是一条域名为空的废条目。
    #[cfg(not(windows))]
    #[test]
    fn portable_cookie_skips_host_only_entries() {
        let cookie = wry::cookie::Cookie::build(("SID", "secret")).path("/").build();
        assert_eq!(portable::cookie_line(&cookie), "");
    }

    #[cfg(not(windows))]
    #[test]
    fn portable_cookie_uses_netscape_columns() {
        let cookie = wry::cookie::Cookie::build(("SID", "secret"))
            .domain(".youtube.com")
            .path("/")
            .secure(true)
            .build();
        assert_eq!(
            portable::cookie_line(&cookie),
            ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret"
        );
    }
}
