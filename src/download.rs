//! 视频下载：把 yt-dlp（打包在 Resources/bin 下的独立二进制）包装成 App 内的
//! 下载功能。
//!
//! 为什么用子进程而不是嵌 Python/移植 Rust：yt-dlp 对 YouTube 的对抗更新
//! 非常频繁（站点一改版就要发新版），自研解析器意味着永远在追。官方二进制
//! 支持 `-U` 自更新，跟随成本几乎为零。我们只做三件事：
//!
//!   1. `yt-dlp -J <url>`            —— 探测视频信息与可选格式列表（纯 JSON）；
//!   2. `yt-dlp --newline --progress-template ...` —— 下载并逐行解析进度；
//!   3. 把结果经 `EventLoopProxy` 送回主线程 eval 给页面。
//!
//! 取消：进程句柄放在全局表里，页面发 cancel 时 kill。临时文件残留由
//! yt-dlp 自己的 .part 机制兜底，下次同名下载会续传。

use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

/// 本 App 打包的 yt-dlp 在 Resources/bin 下。打包脚本保证它存在；
/// 开发模式（cargo run）没有 bundle，退回系统 PATH 里的 yt-dlp，都没有就报错。
///
/// macOS bundle 布局：WeTube.app/Contents/{MacOS/WeTube, Resources/bin/yt-dlp}，
/// 所以从可执行文件向上两级再进 Resources/bin。
pub fn yt_dlp_path() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        // Contents/MacOS/WeTube → Contents/Resources/bin/yt-dlp
        let bundled = exe
            .parent()?
            .parent()?
            .join("Resources/bin/yt-dlp");
        if bundled.exists() {
            return Some(bundled);
        }
    }
    which("yt-dlp")
}

/// ffmpeg/ffprobe 同样优先找打包的，没有再退系统 PATH。
/// yt-dlp 会用 --ffmpeg-location 指过去；找不到时 yt-dlp 自己也能凑合
/// （渐进式格式 + m4a 不需要 ffmpeg），所以这里返回 None 不算错误。
pub fn ffmpeg_dir() -> Option<std::path::PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        let dir = exe.parent()?.parent()?.join("Resources/bin");
        if dir.join("ffmpeg").exists() {
            return Some(dir);
        }
    }
    None
}

/// 极简 which：按 PATH 逐目录找可执行文件。不引依赖，就查两个名字。
fn which(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// 下载中的进程表：key 是下载任务 id，value 是子进程句柄。
/// 页面点取消 → 查表 kill。进程退出后由收尾线程从表里摘除。
static CHILDREN: std::sync::LazyLock<Mutex<HashMap<u32, Child>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 自增任务 id。从 1 开始，0 留作"无效"。
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// kill 掉一个下载任务。返回是否真的杀掉了（页面据此提示）。
pub fn cancel(id: u32) -> bool {
    let Ok(mut map) = CHILDREN.lock() else {
        return false;
    };
    match map.remove(&id) {
        Some(mut child) => child.kill().is_ok(),
        None => false,
    }
}

/// App 退出时清场：kill 掉所有还在跑的 yt-dlp 子进程。
///
/// 子进程是独立于 App 生命周期的，事件循环直接退出的话它们会变成孤儿
/// 继续在后台下载。在 `Event::LoopDestroyed` 里调用本函数兜底。
///
/// 注：SIGKILL 级强杀（活动监视器「强制退出」）时这段代码不会执行，
/// 残留的 yt-dlp 会把当前任务下完自然退出，不会永久驻留；.part 续传
/// 机制保证下次下载同一视频时接着传，不算数据损坏。
pub fn kill_all() {
    let Ok(mut map) = CHILDREN.lock() else {
        return;
    };
    let running = map.len();
    for (_, mut child) in map.drain() {
        if let Err(err) = child.kill() {
            // 进程已经自己退出的竞态会报「无此进程」，忽略即可
            log(&format!("退出清理：终止 yt-dlp({}) 失败: {err}", child.id()));
        }
    }
    if running > 0 {
        log(&format!("退出清理：已终止 {running} 个下载进程"));
    }
}

/// SIGTERM 路径的尽力清理：拿不到锁（主线程正持锁的窄窗口）就放弃，
/// 交给调用方直接退进程。只在信号处理器里用——那里不能阻塞等锁。
#[cfg(unix)]
pub fn kill_all_best_effort() {
    if let Ok(mut map) = CHILDREN.try_lock() {
        for (_, mut child) in map.drain() {
            let _ = child.kill();
        }
    }
}

/// download 模块内部用的轻量日志：不依赖 main.rs 的 log_err（避免循环引用），
/// 直接走 stderr——App 退出路径上多这一行没副作用。
fn log(message: &str) {
    eprintln!("[WeTube] {message}");
}

/// 取全部格式里"画质最好的一档"用到的公共信息——页面上要显示标题、时长、
/// 缩略图，格式列表只挑关键的几个字段，避免把几十个 itag 全塞给页面。
fn summarize(info: &Value) -> Value {
    let formats: Vec<Value> = info
        .get("formats")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|f| {
                    let vcodec = f.get("vcodec").and_then(Value::as_str).unwrap_or("none");
                    let acodec = f.get("acodec").and_then(Value::as_str).unwrap_or("none");
                    let height = f.get("height").and_then(Value::as_u64);
                    let abr = f.get("abr").and_then(Value::as_f64);
                    // 只留"有视频流"或"纯音频"的两类，跳过故事板/无效项
                    let is_video = vcodec != "none" && height.is_some();
                    let is_audio = vcodec == "none" && acodec != "none";
                    if !is_video && !is_audio {
                        return None;
                    }
                    let mut item = serde_json::json!({
                        "formatId": f.get("format_id").and_then(Value::as_str).unwrap_or(""),
                        "ext": f.get("ext").and_then(Value::as_str).unwrap_or(""),
                    });
                    if is_video {
                        item["kind"] = "video".into();
                        item["height"] = height.into();
                        // 现代格式几乎都是分开的音视频流，标出来让页面提示"需合并"
                        item["combined"] = (acodec != "none").into();
                        if let Some(fps) = f.get("fps").and_then(Value::as_f64) {
                            item["fps"] = fps.into();
                        }
                    } else {
                        item["kind"] = "audio".into();
                        item["abr"] = abr.into();
                    }
                    // 文件大小：filesize（精确）优先，tbr 估算兜底都不强求
                    if let Some(size) = f
                        .get("filesize")
                        .and_then(Value::as_u64)
                        .or_else(|| f.get("filesize_approx").and_then(Value::as_u64))
                    {
                        item["size"] = size.into();
                    }
                    Some(item)
                })
                .collect()
        })
        .unwrap_or_default();

    // 视频档位去重：同一高度留体积最大的（通常是 avc1/vp9 主档）
    serde_json::json!({
        "title": info.get("title").and_then(Value::as_str).unwrap_or("video"),
        "duration": info.get("duration").and_then(Value::as_f64),
        "thumbnail": info.get("thumbnail").and_then(Value::as_str),
        "extractor": info.get("extractor_key").and_then(Value::as_str).unwrap_or(""),
        "formats": formats,
    })
}

/// 探测视频信息（阻塞，跑在后台线程）。成功时返回可直接发给页面的摘要 JSON。
pub fn probe(url: &str) -> Result<Value, String> {
    let ytdlp = yt_dlp_path().ok_or("未找到 yt-dlp（App 包损坏或未安装）")?;
    let mut cmd = Command::new(&ytdlp);
    cmd.arg("-J").arg("--no-warnings").arg(url);
    if let Some(dir) = ffmpeg_dir() {
        cmd.arg("--ffmpeg-location").arg(&dir);
    }
    let output = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("启动 yt-dlp 失败：{err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // 挑最后一行非空内容——yt-dlp 的报错摘要总在末尾
        let reason = stderr
            .lines()
            .rev()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .unwrap_or("未知错误");
        return Err(format!("探测失败：{reason}"));
    }

    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("解析 yt-dlp 输出失败：{err}"))?;
    Ok(summarize(&info))
}

/// 开始一次下载。立即返回任务 id；进度经 `on_event` 回调逐行送出，
/// 结束（成功/失败/被杀）时回调 `done=false/true/killed`。
///
/// `mode`：`video`（最高画质合并，需要 ffmpeg）、`audio`（提取 m4a/mp3）。
/// `formatId` 为空时按 mode 给 yt-dlp 默认选择器。
pub fn start(
    url: &str,
    mode: &str,
    format_id: &str,
    out_dir: &std::path::Path,
    on_event: impl Fn(Value) + Send + 'static,
    done: impl Fn(bool, Option<String>) + Send + 'static,
) -> Result<u32, String> {
    let ytdlp = yt_dlp_path().ok_or("未找到 yt-dlp（App 包损坏或未安装）")?;
    std::fs::create_dir_all(out_dir).map_err(|err| format!("创建下载目录失败：{err}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    let mut cmd = Command::new(&ytdlp);
    // --newline：进度事件一行一个（默认进度条会用 \r 刷屏，没法按行读）
    // --no-part 关掉 .part 后缀？不，保留 part：取消后重下可续传。
    // --restrict-filenames：避免奇怪字符在某些文件系统上出问题
    // --no-mtime：别把文件时间改成视频发布时间，下载时间更符合直觉
    cmd.arg("--newline")
        .arg("--no-warnings")
        .arg("--no-mtime")
        .arg("--restrict-filenames")
        .arg("--progress-template")
        // 固定前缀方便按行识别；大小单位交给页面格式化
        .arg("download:|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s")
        .arg("--print")
        .arg("after_move:filepath")
        .arg("-P")
        .arg(out_dir);
    if let Some(dir) = ffmpeg_dir() {
        cmd.arg("--ffmpeg-location").arg(&dir);
    }
    match (mode, format_id) {
        (m, "") if m == "audio" => {
            cmd.arg("-x").arg("--audio-format").arg("m4a");
        }
        (m, "") if m == "video" => {
            // 有 ffmpeg 时拿最好的视频+音频合并；没有就退渐进式（≤720p）
            if ffmpeg_dir().is_some() {
                cmd.arg("-f").arg("bestvideo*+bestaudio/best");
            } else {
                cmd.arg("-f").arg("best[protocol^=http][acodec!=none]");
            }
        }
        (_, fid) => {
            cmd.arg("-f").arg(fid);
        }
    }
    cmd.arg("--").arg(url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|err| format!("启动 yt-dlp 失败：{err}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("stdout 已 piped");
    let stderr = child.stderr.take().expect("stderr 已 piped");

    CHILDREN
        .lock()
        .map_err(|_| "进程表损坏")?
        .insert(pid, child);

    // 读 stdout：进度行 + 最终文件路径行
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut final_path: Option<String> = None;
        for line in reader.lines().map_while(Result::ok) {
            if let Some(rest) = line.strip_prefix("download:|") {
                let parts: Vec<&str> = rest.split('|').collect();
                if parts.len() >= 6 {
                    on_event(serde_json::json!({
                        "percent": parts[0].trim(),
                        "speed": parts[1].trim(),
                        "eta": parts[2].trim(),
                        "downloaded": parts[3].trim().parse::<u64>().unwrap_or(0),
                        "total": parts[4].trim().parse::<u64>().unwrap_or(0),
                    }));
                }
            } else if let Some(path) = line.strip_prefix("[Merger] ") {
                // "[Merger] Merging formats into "xxx.mp4"" → 合并产物路径
                if let Some(p) = path.split('"').nth(1) {
                    final_path = Some(p.to_string());
                }
            } else if let Some(path) = line.strip_prefix("[ExtractAudio] Destination: ") {
                final_path = Some(path.trim().to_string());
            } else if line.starts_with("[download] Destination:") {
                if final_path.is_none() {
                    final_path = line
                        .strip_prefix("[download] Destination: ")
                        .map(str::trim)
                        .map(str::to_string);
                }
            } else if line.starts_with("[download] ") && line.contains(" has already been downloaded") {
                // "[download] xxx.mp4 has already been downloaded"
                final_path = Some(
                    line.trim_start_matches("[download] ")
                        .trim_end_matches(" has already been downloaded")
                        .to_string(),
                );
            }
        }

        // 等 stderr 排干再收尸，防止管道缓冲把子进程卡死
        let stderr_text = {
            let mut buf = String::new();
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                buf.push_str(&line);
                buf.push('\n');
            }
            buf
        };

        let mut map = CHILDREN.lock().ok();
        let child = map.as_mut().and_then(|m| m.remove(&pid));
        let (ok, err) = match child {
            Some(mut child) => match child.wait() {
                Ok(status) if status.success() => (true, None),
                Ok(_) => {
                    // 被我们 kill 的表现为非零退出，stderr 通常是空的
                    if stderr_text.trim().is_empty() {
                        (false, Some("已取消".to_string()))
                    } else {
                        let reason = stderr_text
                            .lines()
                            .rev()
                            .map(str::trim)
                            .find(|l| !l.is_empty())
                            .unwrap_or("下载失败");
                        (false, Some(reason.to_string()))
                    }
                }
                Err(err) => (false, Some(format!("等待进程退出失败：{err}"))),
            },
            // 不在表里 = cancel() 已经 kill 并摘除了
            None => (false, Some("已取消".to_string())),
        };

        done(ok, if ok { final_path } else { err });
    });

    Ok(id)
}
