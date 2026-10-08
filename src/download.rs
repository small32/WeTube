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
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// 构建期内嵌的外置工具（Windows 单文件分发用）。由 build.rs 生成：
/// 有 vendor/<工具> 时是真实字节数组，否则是空切片。
mod bundled {
    include!(concat!(env!("OUT_DIR"), "/bundled_tools.rs"));
}

/// 内嵌工具解出后的目录缓存，避免每次取路径都碰文件系统。
static EMBEDDED_TOOLS: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

/// 工具可执行文件名，必须是**规范名**（`ffmpeg.exe` / `ffmpeg` / `yt-dlp.exe`）。
///
/// 这里曾经把版本号也编进文件名（`ffmpeg-9.0.1.exe`），想着"升级后不会误用
/// 旧副本"，结果踩了坑：yt-dlp 的 `--ffmpeg-location` 指到目录时，它会自己
/// 去那个目录里找名为 `ffmpeg` 的文件，带版本号的名字它根本不会看一眼——
/// 于是合并被**静默跳过**，下出来只剩视频没有声音，而且因为 `--no-warnings`
/// 连警告都被吞了（用户看到的是"下载成功，但没声音"）。
/// 复用判断改用解压后的大小校验（见 `extract_tool`），同样能识别旧版本残留。
fn tool_file_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

/// 内嵌工具的落盘目录：用户级数据目录（Windows 是 %LOCALAPPDATA%）下的
/// WeTube/bin。不能放 exe 同目录——Program Files 之类通常不可写。
fn embedded_dir() -> Option<std::path::PathBuf> {
    let base = dirs::data_local_dir().or_else(dirs::cache_dir)?;
    Some(base.join("WeTube").join("bin"))
}

/// 把一份内嵌字节解到 `dir`，已存在且大小一致就直接复用。
///
/// 内嵌有两种形态：xz 压缩态（`packed`，包体小很多，ffmpeg 98MB→26MB）和
/// 原样字节。压缩态走流式解压直接写文件——ffmpeg 解压后近百 MB，不该整块
/// 进内存。先写 `.tmp` 再改名：上次解压中断留下的半截文件不会被误当成
/// 完整副本；有原始大小时顺带校验解出结果，防止压缩包损坏被当真。
fn extract_tool(
    dir: &std::path::Path,
    stem: &str,
    bytes: &[u8],
    packed: bool,
    expected_size: u64,
) -> std::io::Result<std::path::PathBuf> {
    if bytes.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("本次构建未内嵌 {stem}"),
        ));
    }
    std::fs::create_dir_all(dir)?;
    let target = dir.join(tool_file_name(stem));

    if expected_size > 0
        && std::fs::metadata(&target)
            .map(|meta| meta.len() == expected_size)
            .unwrap_or(false)
    {
        // 复用时也清理一次：从"带版本号命名"的旧版本升上来会残留几份大文件
        prune_other_copies(dir, stem, &target);
        return Ok(target);
    }

    let tmp = target.with_extension("tmp");
    {
        let mut out = std::fs::File::create(&tmp)?;
        if packed {
            let mut input = std::io::BufReader::new(bytes);
            lzma_rs::xz_decompress(&mut input, &mut out)
                .map_err(|err| std::io::Error::other(format!("解压 {stem} 失败：{err}")))?;
        } else {
            std::io::copy(&mut std::io::Cursor::new(bytes), &mut out)?;
        }
        out.sync_all()?;
    }

    if expected_size > 0 {
        let got = std::fs::metadata(&tmp)?.len();
        if got != expected_size {
            let _ = std::fs::remove_file(&tmp);
            return Err(std::io::Error::other(format!(
                "解出 {stem} 大小不符：期望 {expected_size} 字节，实际 {got} 字节"
            )));
        }
    }

    // Windows 的 rename 不覆盖已存在文件，先删掉那份不完整的旧副本
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&tmp, &target)?;
    prune_other_copies(dir, stem, &target);
    Ok(target)
}

/// 清掉同目录里同名工具的旧副本。yt-dlp 17MB、ffmpeg 98MB，
/// 不清理的话每升一次版本就多留一份。
fn prune_other_copies(dir: &std::path::Path, stem: &str, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(stem) && (name.ends_with(".exe") || !name.contains('.')) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// 解出全部内嵌工具，返回它们所在的目录。都没内嵌（非 Windows 构建，
/// 或没跑过 fetch 脚本）时返回 None，调用方退回外部查找。
fn embedded_tools_dir() -> Option<std::path::PathBuf> {
    EMBEDDED_TOOLS
        .get_or_init(|| {
            let dir = embedded_dir()?;
            let mut ready = false;
            let tools = [
                (
                    "yt-dlp",
                    bundled::YTDLP_BYTES,
                    bundled::YTDLP_PACKED,
                    bundled::YTDLP_SIZE,
                ),
                (
                    "ffmpeg",
                    bundled::FFMPEG_BYTES,
                    bundled::FFMPEG_PACKED,
                    bundled::FFMPEG_SIZE,
                ),
                (
                    "qjs",
                    bundled::DENO_BYTES,
                    bundled::DENO_PACKED,
                    bundled::DENO_SIZE,
                ),
            ];
            for (stem, bytes, packed, size) in tools {
                if bytes.is_empty() {
                    continue;
                }
                match extract_tool(&dir, stem, bytes, packed, size) {
                    Ok(_) => ready = true,
                    Err(err) => log(&format!("解出内嵌 {stem} 失败：{err}")),
                }
            }
            ready.then_some(dir)
        })
        .clone()
}

/// 内嵌 yt-dlp 的可执行路径（解出一次后缓存）。解不出来就返回 None，
/// 由调用方退回外部查找——内嵌失败不该让下载功能整个不可用。
fn embedded_ytdlp() -> Option<std::path::PathBuf> {
    let dir = embedded_tools_dir()?;
    let path = dir.join(tool_file_name("yt-dlp"));
    path.is_file().then_some(path)
}

/// 可执行文件候选名：Windows 上必须是 `yt-dlp.exe` 这种带后缀的形态。
/// 旧实现直接拿裸名拼路径再去 is_file()，Windows 下永远匹配不到——
/// Rust 的 is_file 走 GetFileAttributesW，不做 PATHEXT 展开。
fn exe_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    }
}

/// 在给定的目录列表里按候选名找一个存在的可执行文件。
/// `dirs` 按优先级给：自带目录在前，PATH 在后。
fn find_exe(dirs: &[std::path::PathBuf], name: &str) -> Option<std::path::PathBuf> {
    for dir in dirs {
        for candidate in exe_names(name) {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// 自带二进制的候选目录，按优先级：
/// 1. macOS bundle：Contents/MacOS/WeTube → Contents/Resources/bin
/// 2. exe 同目录：Windows 绿色版/解压即用的常见布局
/// 3. exe 同目录/bin：部分分发方式把依赖收在 bin 子目录
fn bundled_dirs() -> Vec<std::path::PathBuf> {
    let Ok(exe) = std::env::current_exe() else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    if let Some(dir) = exe.parent() {
        if let Some(contents) = dir.parent() {
            dirs.push(contents.join("Resources").join("bin"));
        }
        dirs.push(dir.join("bin"));
        dirs.push(dir.to_path_buf());
    }
    dirs
}

/// PATH 展开成目录列表。
fn path_dirs() -> Vec<std::path::PathBuf> {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default()
}

/// yt-dlp 的位置，按优先级：
/// 1. 内嵌副本（Windows 单文件分发：解到用户数据目录再运行）；
/// 2. 自带目录（macOS bundle / exe 同目录 / exe 同目录 bin）；
/// 3. 系统 PATH（开发模式，或用户自备了一份）。
pub fn yt_dlp_path() -> Option<std::path::PathBuf> {
    if let Some(path) = embedded_ytdlp() {
        return Some(path);
    }
    find_exe(&bundled_dirs(), "yt-dlp").or_else(|| find_exe(&path_dirs(), "yt-dlp"))
}

/// ffmpeg 可执行文件的完整路径，交给 yt-dlp 的 `--ffmpeg-location`。
///
/// 传的是**文件本身**而不是所在目录：给目录时 yt-dlp 会自己去里面找名为
/// `ffmpeg` 的文件，目录里一旦不是这个规范名就找不到（这正是"下载成功但没
/// 声音"的成因）；给文件路径则直接使用，不依赖它在目录里叫什么。
/// 注：ffmpeg 缺失不算错误——yt-dlp 会退到渐进式单文件（一般 ≤720p），
/// 只是拿不到高画质档的合并。macOS 上 brew 装的 ffmpeg 以前因为只看 bundle
/// 而被忽略，现在同样认。
pub fn ffmpeg_path() -> Option<std::path::PathBuf> {
    // 1. 内嵌副本（Windows 单文件分发的主路径）
    if let Some(dir) = embedded_tools_dir() {
        let ffmpeg = dir.join(tool_file_name("ffmpeg"));
        if ffmpeg.is_file() {
            return Some(ffmpeg);
        }
    }
    // 2. 自带目录（macOS bundle / exe 同目录 / exe 同目录 bin）
    if let Some(path) = find_exe(&bundled_dirs(), "ffmpeg") {
        return Some(path);
    }
    // 3. PATH 里装的（winget/scoop/homebrew）同样认
    find_exe(&path_dirs(), "ffmpeg")
}

/// qjs（QuickJS-NG）的位置，交给 yt-dlp 的 --js-runtimes quickjs:<path>。
///
/// yt-dlp 的 EJS（YouTube 播放器挑战）需要跑 JS：没有 runtime 时每次探测/
/// 下载都会报 "No supported JavaScript runtime" 警告，某些客户端还会直接
/// 失败。打包目录里放了 ~1MB 的 QuickJS-NG（qjs），替代 81MB 的 deno——
/// yt-dlp 官方支持 quickjs runtime（要求 QuickJS-NG ≥ 0.12.0，旧版无优化
/// 会慢到几分钟）。按与 ffmpeg 相同的优先级找：
///
/// 1. 自带目录（macOS bundle：Resources/bin / exe 同目录 / exe 同目录 bin）；
/// 2. 内嵌副本所在目录（Windows 单文件分发解出的 WeTube/bin）；
/// 3. 系统 PATH（开发模式，或用户自备）。
///
/// 找不到不算错误：只是退回无 runtime 的旧行为（有警告），下载功能照常。
/// 函数名保留 deno_path 历史名，实际找的是 qjs。
pub fn deno_path() -> Option<std::path::PathBuf> {
    // 1. 自带目录（macOS bundle 的 Resources/bin 等）
    if let Some(path) = find_exe(&bundled_dirs(), "qjs") {
        return Some(path);
    }
    // 2. 内嵌副本所在目录（Windows 单文件分发）
    if let Some(dir) = embedded_tools_dir() {
        let qjs = dir.join(tool_file_name("qjs"));
        if qjs.is_file() {
            return Some(qjs);
        }
    }
    // 3. PATH 里装的（brew/winget/scoop）同样认
    find_exe(&path_dirs(), "qjs")
}

/// GUI App 拉起控制台子程序时，Windows 会额外弹一个黑色控制台窗口。
/// CREATE_NO_WINDOW 把它按掉，让下载过程完全无感。其他平台保持原样。
fn no_console_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// 逐行读子进程输出，**单行解码失败绝不能中断迭代**。
///
/// 不能写成 `reader.lines().map_while(Result::ok)`：`BufRead::lines()` 遇到非法 UTF-8
/// 返回 `Err(InvalidData)`，而 `map_while` 在第一个 `Err` 处结束**整个迭代**；又因为
/// `lines()` 按值消耗 reader，循环一结束 BufReader 就被 drop、管道读端随之关闭，
/// 子进程下一次往里写就 EPIPE（Windows 上是 Errno 22），下载直接判失败。
///
/// 这不是理论风险：yt-dlp 输出编码跟随系统 locale，中文 Windows（cp936）下它写的是
/// GBK，而 `[download] Destination: <中文路径>` 这条**下载开始前就会打印**的行带非法
/// UTF-8 字节——进度条于是永远停在 0%，任务随后报一句看不懂的 OSError，重试必现。
/// 默认下载目录就是 `%USERPROFILE%\Downloads\WeTube`，中文用户名即中招。
///
/// 改用 `read_until` 读原始字节（不做 UTF-8 校验，只有真正的 IO 错误才失败），
/// 再 `from_utf8_lossy` 容错解码，保证管道一定被读到 EOF。
fn lines_lossy<R: std::io::Read>(reader: R) -> impl Iterator<Item = String> {
    let mut reader = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    std::iter::from_fn(move || {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => None, // EOF
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf);
                Some(text.trim_end_matches(|c| c == '\r' || c == '\n').to_string())
            }
            Err(_) => None, // 只有真正的 IO 错误才停
        }
    })
}

/// 每个任务共享一个句柄，包含进程和取消标记，供 cancel() 和 cleanup 线程共同访问。
#[derive(Default)]
struct TaskHandle {
    child: Option<Child>,
    process_group: bool,
    /// true = cancel() 已经调用 kill；cleanup wait 后据此区分"取消"和"真失败"。
    canceled: AtomicBool,
}

fn terminate_tree(child: &mut Child, process_group: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    if process_group {
        // 每次下载使用独立进程组，ffmpeg 等后代继承同一组。
        let result = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
        return if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) };
    }
    #[cfg(windows)]
    {
        let _ = process_group;
        let executable = std::env::var_os("SystemRoot")
            .map(|root| std::path::PathBuf::from(root).join("System32").join("taskkill.exe"))
            .unwrap_or_else(|| "taskkill.exe".into());
        let mut cmd = Command::new(executable);
        cmd.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null()).stderr(Stdio::null());
        no_console_window(&mut cmd);
        return if cmd.status()?.success() { Ok(()) }
            else { Err(std::io::Error::other("taskkill 未能终止下载进程树")) };
    }
    #[cfg(not(windows))]
    child.kill()
}
/// 下载中的进程表：key 是下载任务 id，value 是共享句柄。
static CHILDREN: std::sync::LazyLock<Mutex<HashMap<u32, std::sync::Arc<Mutex<TaskHandle>>>>> =

    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 同时允许的下载任务数。
///
/// 页面上的「排队中」以前是假的：每个请求一到就立刻 spawn 一个 yt-dlp，
/// 每个 yt-dlp 再开 8 个并发分片，连点几个就把带宽打满、全部一起变慢。
/// 这里给一个真实的上限，多出来的任务排队等槽位。
const MAX_CONCURRENT_JOBS: usize = 2;

/// 并发闸门：计数 + 条件变量，满了就在后台线程里等。
struct JobGate {
    running: Mutex<usize>,
    changed: std::sync::Condvar,
}

static JOB_GATE: std::sync::LazyLock<JobGate> = std::sync::LazyLock::new(|| JobGate {
    running: Mutex::new(0),
    changed: std::sync::Condvar::new(),
});

/// 试着占一个槽位，占不到返回 false（调用方据此决定要不要排队）。
fn try_acquire_slot() -> bool {
    let Ok(mut running) = JOB_GATE.running.lock() else { return false; };
    if *running >= MAX_CONCURRENT_JOBS {
        return false;
    }
    *running += 1;
    true
}

/// 阻塞等一个槽位。只在后台排队线程里用，主线程不能调。
fn acquire_slot() {
    let Ok(mut running) = JOB_GATE.running.lock() else { return; };
    while *running >= MAX_CONCURRENT_JOBS {
        match JOB_GATE.changed.wait(running) {
            Ok(guard) => running = guard,
            Err(poisoned) => {
                running = poisoned.into_inner();
                break;
            }
        }
    }
    *running += 1;
}

/// 归还槽位并唤醒一个排队中的任务。
fn release_slot() {
    if let Ok(mut running) = JOB_GATE.running.lock() {
        *running = running.saturating_sub(1);
        JOB_GATE.changed.notify_all();
    }
}

/// 预热：把内嵌的 yt-dlp / ffmpeg / qjs 提前解压好。
///
/// 首次下载时才解压的话，ffmpeg 那 98MB 的 xz 流式解压跑在主线程上，
/// 界面会冻住好几秒。启动时在后台线程里做掉，等用户点下载就已经就绪。
pub fn warmup() {
    std::thread::spawn(|| {
        let _ = yt_dlp_path();
        let _ = ffmpeg_path();
        let _ = deno_path();
        download_log("内嵌工具预热完成");
    });
}

/// 自增任务 id。从 1 开始，0 留作"无效"。
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// 主线程保留下载状态，页面重建时重放 started + 最新进度/终态。
#[derive(Default)]
pub struct EventHistory {
    tasks: std::collections::BTreeMap<u64, Vec<Value>>,
    /// 任务入场顺序（只记 started 的键），裁剪时按它删最早的。
    order: Vec<u64>,
}

impl EventHistory {
    pub fn record(&mut self, event: &Value) {
        let Some(id) = history_key(event) else { return; };
        match event["kind"].as_str() {
            Some("started") => {
                if self.tasks.contains_key(&id) {
                    return;
                }
                self.order.push(id);
                self.tasks.insert(id, vec![event.clone()]);
            }
            Some("progress" | "done" | "fail" | "cancelled") => {
                if let Some(events) = self.tasks.get_mut(&id) {
                    if events.last().is_some_and(|e| e["kind"] == "done" || e["kind"] == "fail") { return; }
                    events.truncate(1);
                    events.push(event.clone());
                }
            }
            _ => return,
        }
        // 裁剪：按**入场顺序**删最早完成的，保留最近 100 条。
        // 原来按 BTreeMap 的 id 升序删，等于删 id 最小的——id 与完成先后无关，
        // 刚下完的大 id 会被留着、早期的反而先没。
        let finished: std::collections::HashSet<u64> = self
            .tasks
            .iter()
            .filter(|(_, events)| {
                events.last().is_some_and(|e| e["kind"] == "done" || e["kind"] == "fail")
            })
            .map(|(id, _)| *id)
            .collect();
        if finished.len() <= 100 {
            return;
        }
        let mut seen = 0usize;
        let mut doomed: std::collections::HashSet<u64> = std::collections::HashSet::new();
        for id in self.order.iter().rev() {
            if !finished.contains(id) {
                continue;
            }
            seen += 1;
            if seen > 100 {
                doomed.insert(*id);
            }
        }
        if doomed.is_empty() {
            return;
        }
        self.tasks.retain(|id, _| !doomed.contains(id));
        self.order.retain(|id| !doomed.contains(id));
    }

    pub fn snapshot(&self) -> Vec<Value> {
        self.tasks.values().flatten().cloned().collect()
    }
}

/// 历史事件用的键。
///
/// 启动就失败的任务没有任务 id（`id: 0`），以前直接被丢掉——页面一旦重载，
/// 那张卡片就永远停在「排队中」。这里用 requestId 派生一个高位键：
/// 真实 id 从 1 开始自增，高位那一半不可能撞上。
fn history_key(event: &Value) -> Option<u64> {
    if let Some(id) = event["id"].as_u64().filter(|id| *id != 0) {
        return Some(id);
    }
    use std::hash::{Hash, Hasher};
    let request_id = event["requestId"].as_str()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    request_id.hash(&mut hasher);
    Some(0x8000_0000_0000_0000 | (hasher.finish() & 0x7fff_ffff_ffff_ffff))
}

/// kill 掉一个下载任务。返回是否真的杀掉了（页面据此提示）。
///
/// 逻辑：先 try_wait 看进程是否已自己退出；若还在跑，设 canceled=true 再 kill。
/// cancel() 不删除 CHILDREN 条目，由 cleanup 线程统一 wait + 移除。
pub fn cancel(id: u32) -> bool {
    // 先把 Arc 克隆出来就放开进程表的锁。
    //
    // 原来一直握着 map 的 guard 再去 `arc.lock()`，而 cleanup 线程此刻可能正
    // 持着 arc 阻塞在 `child.wait()` 上——这期间任何新的 download::start 都会
    // 卡在 `CHILDREN.lock()`，而它跑在主线程上（UI 直接假死到当前下载结束）。
    // 持锁时间越短越好，这里只需要一次查表。
    let arc = {
        let Ok(map) = CHILDREN.lock() else { return false; };
        map.get(&id).cloned()
    };
    let Some(arc) = arc else { return false; };
    let mut handle = match arc.lock() { Ok(h) => h, Err(_) => return false };
    // 先 try_wait 检查进程是否已经退出
    if handle.child.as_mut().and_then(|c| c.try_wait().ok().flatten()).is_some() {
        // 进程已退出，取消无效（任务已自然结束），返回 false
        return false;
    }
    // 进程还在跑：标记取消并 kill，由 cleanup 线程负责发事件
    handle.canceled.store(true, Ordering::SeqCst);
    let process_group = handle.process_group;
    if let Some(ref mut c) = handle.child {
        if terminate_tree(c, process_group).is_err() {
            handle.canceled.store(false, Ordering::SeqCst);
            return false;
        }
    }
    true
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
    // 同样先把条目搬出来再逐个 kill：terminate_tree 在 Windows 上会同步跑
    // taskkill 并等它退出，这期间不该占着进程表的锁。
    let tasks: Vec<_> = {
        let Ok(mut map) = CHILDREN.lock() else { return; };
        map.drain().collect()
    };
    let running = tasks.len();
    for (_, arc) in tasks {
        if let Ok(mut handle) = arc.lock() {
            let process_group = handle.process_group;
            if let Some(ref mut c) = handle.child {
                if let Err(err) = terminate_tree(c, process_group) {
                    log(&format!("退出清理：终止 yt-dlp({}) 失败: {err}", c.id()));
                }
            }
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
        for (_, arc) in map.drain() {
            if let Ok(mut handle) = arc.lock() {
                let process_group = handle.process_group;
                if let Some(ref mut c) = handle.child {
                    let _ = terminate_tree(c, process_group);
                }
            }
        }
    }
}

/// download 模块内部用的轻量日志：不依赖 main.rs 的 log_err（避免循环引用），
/// 直接走 stderr——App 退出路径上多这一行没副作用。
fn log(message: &str) {
    eprintln!("[WeTube] {message}");
}

/// 下载链路的落盘日志（`%TEMP%\WeTube-download.log`）。
///
/// GUI 版没有终端，`log` 那行看不到。踩过的坑是"合并被静默跳过"：yt-dlp 只在
/// stderr 里轻轻警告一句 ffmpeg 不可用，还被 `--no-warnings` 吞掉，界面上只看得到
/// "下载成功"。所以每次下载都把关键上下文（ffmpeg 位置、选择器、退出结果、
/// stderr 原文）留一份，事后一眼能查。
fn download_log(message: &str) {
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("WeTube-download.log"))
    else {
        return;
    };
    use std::io::Write as _;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{secs}] {message}");
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

/// 给 yt-dlp 命令挂上 JS runtime（EJS 用）。找到了就加
/// `--no-js-runtimes --js-runtimes quickjs:<path>`，找不到就不加——
/// 旧行为兜底，不该因此报错。
///
/// 必须先 `--no-js-runtimes`：deno 是默认启用的最高优先级 runtime，不清掉
/// 的话机器上装了 deno 时 quickjs 不会被用上。
fn with_deno(cmd: &mut Command, deno: &Option<std::path::PathBuf>) {
    if let Some(deno) = deno {
        cmd.arg("--no-js-runtimes")
            .arg("--js-runtimes")
            .arg(format!("quickjs:{}", deno.display()));
    }
}

/// 让 yt-dlp 的输出固定成 UTF-8，而不是跟随系统 locale。
///
/// **必须用 yt-dlp 自己的 `--encoding`，不能用 `PYTHONIOENCODING` 环境变量。**
/// yt-dlp 是 PyInstaller 打包的 CPython 程序，打包后的它不认这个变量——实测同一个
/// 中文 Windows 上，普通 `python.exe` 设了 `PYTHONIOENCODING=utf-8` 后
/// `sys.stdout.encoding` 会从 gbk 变成 utf-8，但打成 exe 的 yt-dlp 无论设不设都仍报
/// `[debug] Encodings: ... out gbk`；换成 `--encoding utf-8` 之后，它写出的中文字节
/// 才真的从 GBK 变成 UTF-8（实测 `测试中文ABC`：GBK `\xb2\xe2...` → UTF-8 `\xe6\xb5\x8b...`）。
///
/// 这一层是为了让 `[download] Destination:` / `[Merger]` 这些含中文路径的行能被正确
/// 解码，但它**不能替代** `lines_lossy`：那层保证「无论子进程吐什么字节，管道都不会
/// 被提前关掉」。两层的失效模式不重叠，必须都在。
fn with_utf8_output(cmd: &mut Command) {
    cmd.arg("--encoding").arg("utf-8");
}

/// 探测视频信息（阻塞，跑在后台线程）。成功时返回可直接发给页面的摘要 JSON。
pub fn probe(url: &str, cookies: &CookieSource) -> Result<Value, String> {
    let ytdlp = yt_dlp_path().ok_or("未找到 yt-dlp（App 包损坏或未安装）")?;
    let mut cmd = Command::new(&ytdlp);
    no_console_window(&mut cmd);
    with_utf8_output(&mut cmd);
    cmd.arg("-J").arg("--no-warnings");
    cookies.apply(&mut cmd);
    if let Some(path) = ffmpeg_path() {
        cmd.arg("--ffmpeg-location").arg(&path);
    }
    with_deno(&mut cmd, &deno_path());
    // 跟 start() 一致，用 `--` 把 URL 和选项隔开：否则以 `-` 开头的输入
    // （`--version`、`-o xxx`）会被 argparse 当成选项，探测行为被改写。
    cmd.arg("--").arg(url);
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
        return Err(format!("探测失败：{}", friendly_error(reason)));
    }

    let info: Value = serde_json::from_slice(&output.stdout)
        .map_err(|err| format!("解析 yt-dlp 输出失败：{err}"))?;
    Ok(summarize(&info))
}

/// 单任务默认并发分片数。YouTube 的音视频是分片传输，并行抓能显著提速；
/// yt-dlp 默认 1（纯串行）。8 是速度与「不被当异常流量」之间的平衡点，
/// 设置面板可改。
pub const DEFAULT_CONCURRENT_FRAGMENTS: u32 = 8;

/// Cookie 来源。
///
/// YouTube 会对部分视频/会话弹「Sign in to confirm you're not a bot」，这是
/// 站点侧的风控，换 player_client 也过不去（实测 tv/web_safari/android/ios
/// 全部一样），官方给的路子就是带上 cookie。两种给法：
/// 从浏览器读、或指定导出的 cookies.txt。
#[derive(Clone)]
pub enum CookieSource {
    /// 不用 cookie
    None,
    /// 自动：用应用自己导出的 cookies.txt（见 cookies.rs）。默认值。
    Auto,
    /// 浏览器名（chrome / edge / firefox），交给 yt-dlp 自己解密读取
    Browser(String),
    /// Netscape 格式 cookies.txt 的路径
    File(std::path::PathBuf),
}

impl CookieSource {
    /// 从设置里解析，「cookies.txt 路径」优先于「从浏览器读取」——
    /// 前者不受浏览器占用数据库的影响，更可靠。
    pub fn from_settings(file: &str, browser: &str) -> Self {
        let file = file.trim().trim_matches('"').trim_matches('\'').trim();
        if !file.is_empty() {
            // 支持 ~ 开头的家目录写法，跟下载文件夹保持一致的手感
            let path = match dirs::home_dir() {
                Some(home) if file == "~" => home,
                Some(home) => match file.strip_prefix("~/").or_else(|| file.strip_prefix("~\\")) {
                    Some(rest) => home.join(rest),
                    None => std::path::PathBuf::from(file),
                },
                None => std::path::PathBuf::from(file),
            };
            return CookieSource::File(path);
        }
        match browser.trim() {
            "" | "关闭" => CookieSource::None,
            // 「自动」= 用 WeTube 内置浏览器（WebView2）的登录态。这是默认值：
            // 用户在应用里登录过 YouTube，下载就不该再被机器人校验拦。
            // 「自动」= 用应用自己导出的 cookies.txt。不能直接让 yt-dlp 去读
            // WebView2 的配置目录：应用运行时 Chromium 会把那个数据库锁住
            // （实测报 "Could not copy Chrome cookie database"），而下载只可能
            // 在应用运行时发生，等于此路不通。所以改成应用先导出成 cookies.txt。
            "自动" => CookieSource::Auto,
            name => CookieSource::Browser(name.to_string()),
        }
    }

    /// 「自动」在真正用之前解析成文件路径。
    ///
    /// 导出由主线程在收到下载请求时同步完成（见 cookies.rs），走到这里文件
    /// 已经在了。万一没有（比如还没登录过），就当作不带 cookie——不影响下载，
    /// 只是可能被 YouTube 的机器人校验拦一下。
    fn resolved(&self) -> CookieSource {
        match self {
            CookieSource::Auto => match crate::cookies::cookies_path() {
                Some(path) if path.is_file() => CookieSource::File(path),
                _ => CookieSource::None,
            },
            other => other.clone(),
        }
    }

    /// 把参数挂到 yt-dlp 命令行上。
    fn apply(&self, cmd: &mut Command) {
        match self.resolved() {
            CookieSource::None | CookieSource::Auto => {}
            CookieSource::Browser(name) => {
                cmd.arg("--cookies-from-browser").arg(name);
            }
            CookieSource::File(path) => {
                cmd.arg("--cookies").arg(path);
            }
        }
    }
}

/// 把 yt-dlp 的英文报错翻成"能照着做"的中文。
///
/// 原来直接把原文抛给用户，机器人校验这种提示等于没说——用户看不懂
/// 「Sign in to confirm you're not a bot」该去点哪儿。
fn friendly_error(raw: &str) -> String {
    if raw.contains("Sign in to confirm you") {
        return "YouTube 要求先通过机器人校验。请在「设置 → 下载设置」里指定 cookies.txt，\
                或把「从浏览器读取 Cookie」选成你常用的浏览器（选浏览器方式时需先完全退出该浏览器）。"
            .to_string();
    }
    if raw.contains("Could not copy") && raw.contains("cookie") {
        return "读取浏览器 Cookie 失败：浏览器运行时会锁住 Cookie 数据库。\
                请完全退出该浏览器后重试，或改用导出的 cookies.txt。"
            .to_string();
    }
    if raw.contains("Failed to decrypt") || raw.contains("DPAPI") {
        return "浏览器 Cookie 解密失败（新版 Chrome/Edge 的加密方式变了）。\
                建议改用导出的 cookies.txt。"
            .to_string();
    }
    if raw.contains("No supported JavaScript runtime") {
        return "缺少 JavaScript 运行时（YouTube 的 EJS 挑战需要它）。".to_string();
    }
    if raw.contains("Private video") || raw.contains("members-only") {
        return format!("这是私享/会员专属视频，需要带登录态的 Cookie：{raw}");
    }
    raw.to_string()
}

/// 一次下载任务的参数。
pub struct Job<'a> {
    pub url: &'a str,
    /// `video` 或 `audio`
    pub mode: &'a str,
    /// 页面上选中的格式 id；空串表示让 yt-dlp 自己挑最好的
    pub format_id: &'a str,
    /// 选中的视频格式本身是否已含音轨。
    ///
    /// YouTube 1080p 以上都是音视频分离的两条流，页面上选中的多半是不含
    /// 音轨的视频轨——这时必须补一条 bestaudio 一起下再合并，否则下出来
    /// 就是无声视频（这正是之前的 bug）。
    pub has_audio: bool,
    pub out_dir: &'a std::path::Path,
    /// 单任务并发分片数
    pub concurrent: u32,
    /// cookie 来源（YouTube 机器人校验要靠它过）
    pub cookies: &'a CookieSource,
}

/// 指定的格式 id 优先，为空时用兜底选择器。
fn or_default(format_id: &str, fallback: &str) -> String {
    if format_id.is_empty() {
        fallback.to_string()
    } else {
        format_id.to_string()
    }
}

/// 视频格式选择器。
///
/// - 没指定格式：优先 avc1 + m4a（播放器兼容性最好），再退任意音视频组合。
/// - 指定了但那条格式不含音轨：补 bestaudio 一起下交给 ffmpeg 合并。
/// - 没有 ffmpeg 就没法合并，只能退渐进式单文件（音视频在同一条流里），
///   否则 yt-dlp 会以「要求合并但没有 ffmpeg」直接报错退出。
fn video_selector(format_id: &str, has_audio: bool, has_ffmpeg: bool) -> String {
    if !has_ffmpeg {
        return "b[protocol^=http][acodec!=none]/b".to_string();
    }
    match (format_id.is_empty(), has_audio) {
        (true, _) => "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b".to_string(),
        // 本来就带音轨，直接用
        (false, true) => format_id.to_string(),
        // 视频轨 + 音轨：优先 m4a（AAC），mp4 里兼容性最好；拿不到再退任意
        // 最佳音轨（YouTube 常见是 opus/webm，塞进 mp4 也能放，但老播放器
        // 可能不认）。最后一档是不带音轨的原格式，兜住「这个源根本没音轨」。
        (false, false) => format!(
            "{format_id}+ba[ext=m4a]/{format_id}+ba/{format_id}"
        ),
    }
}

/// 解析一行 yt-dlp 进度输出，格式：`WTDL|百分比|速度|剩余|已下载|总量`。
///
/// 前几行里「总量」会是 `NA`（yt-dlp 还没拿到 Content-Length），按 0 处理，
/// 页面据此显示不定进度。不是进度行（或字段不够）返回 None，由调用方
/// 继续按信息行处理。
fn parse_progress_line(line: &str) -> Option<Value> {
    let rest = line.strip_prefix("WTDL|")?;
    let parts: Vec<&str> = rest.split('|').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(serde_json::json!({
        "percent": parts[0].trim(),
        "speed": parts[1].trim(),
        "eta": parts[2].trim(),
        "downloaded": parts[3].trim().parse::<u64>().unwrap_or(0),
        "total": parts[4].trim().parse::<u64>().unwrap_or(0),
    }))
}

/// 多流任务的进度聚合器。
///
/// 音视频分离的格式（`bv*+ba`、`137+ba`……）yt-dlp 会**按流各输出一轮进度**：
/// 视频轨走到 100.0% 之后，音频轨又从 0.3% 开始。直接把百分比透传给页面，
/// 进度条就会到顶后跳回 0（用户以为卡死或已完成）。
///
/// 这里按字节把已完成的流累加进 `base`：切到下一流时把上一条流观测到的
/// 最大已下载字节计入基数，再用 `(base + 当前已下载) / (base + 当前总量)`
/// 算整体百分比。拿不到总量（yt-dlp 早期输出 `NA`）时保持原样透传。
#[derive(Default)]
struct ProgressAggregator {
    /// 前面几条流已经下完的字节总和
    base_bytes: u64,
    /// 当前这条流观测到的最大已下载字节
    stream_peak: u64,
    /// 上一行报的已下载字节，用于识别"换流"（字节数骤降）
    last_downloaded: u64,
    /// 上一行报的当前流总量
    last_total: u64,
}

impl ProgressAggregator {
    /// 吃进一行 yt-dlp 进度，返回应发给页面的进度对象。
    fn feed(&mut self, progress: Value) -> Value {
        let downloaded = progress["downloaded"].as_u64().unwrap_or(0);
        let total = progress["total"].as_u64().unwrap_or(0);

        // 换流判定：字节数明显回退（新流从头开始），或总量变了且已下载归零。
        let switched = downloaded + 1024 < self.last_downloaded
            || (total > 0 && self.last_total > 0 && total != self.last_total && downloaded == 0);
        if switched {
            self.base_bytes = self.base_bytes.saturating_add(self.stream_peak);
            self.stream_peak = 0;
        }
        self.stream_peak = self.stream_peak.max(downloaded);
        if total > 0 {
            self.last_total = total;
        }
        self.last_downloaded = downloaded;

        let overall_total = self.base_bytes.saturating_add(total);
        // 没有百分比字符串（异常行）就没法换算，原样透传。
        if !progress["percent"].is_string() {
            return progress;
        }
        // 总量未知（NA）时 yt-dlp 自己那串百分比就是唯一可用信息，原样透传。
        if overall_total == 0 {
            return progress;
        }
        let overall_downloaded = self.base_bytes.saturating_add(downloaded);
        let pct = (overall_downloaded as f64 / overall_total as f64 * 100.0).clamp(0.0, 100.0);

        let mut out = progress;
        out["percent"] = Value::from(format!("{pct:.1}%"));
        out["downloaded"] = Value::from(overall_downloaded);
        out["total"] = Value::from(overall_total);
        out
    }
}

/// 开始一次下载。立即返回任务 id；进度经 `on_event` 回调逐行送出，
/// 结束（成功/失败/被杀）时回调 `done=false/true/killed`。
///
/// `mode`：`video`（最高画质合并，需要 ffmpeg）、`audio`（提取 m4a/mp3）。
/// `formatId` 为空时按 mode 给 yt-dlp 默认选择器。
pub fn start(
    job: Job<'_>,
    on_started: impl Fn(u32) + Send + 'static,
    on_event: impl Fn(u32, Value) + Send + 'static,
    done: impl Fn(u32, bool, Option<String>) + Send + 'static,
    on_cancelled: impl Fn(u32) + Send + 'static,
) -> Result<u32, String> {
    let job = OwnedJob::new(&job);

    // 这两个校验都很轻，留在主线程同步做：出错时调用方能立刻拿到 Err。
    yt_dlp_path().ok_or("未找到 yt-dlp（App 包损坏或未安装）")?;
    std::fs::create_dir_all(&job.out_dir).map_err(|err| format!("创建下载目录失败：{err}"))?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);

    // 四个回调要能在两条路径里共用（槽位空：主线程直接跑；槽位满：搬去后台
    // 排队），排队线程还要在 run_job 失败时用 done 回报，所以包一层 Arc<Mutex>
    // ——裸闭包没法既 move 进 run_job 又在外面再调一次。
    let on_started: StartedCb = Arc::new(Mutex::new(on_started));
    let on_event: ProgressCb = Arc::new(Mutex::new(on_event));
    let done: DoneCb = Arc::new(Mutex::new(done));
    let on_cancelled: CancelCb = Arc::new(Mutex::new(on_cancelled));

    // 并发闸门：同时最多跑 MAX_CONCURRENT_JOBS 个 yt-dlp。
    // 槽位还有就照旧在主线程起进程（失败能同步返回）；槽位满了才整包
    // 搬到后台线程排队——页面显示的「排队中」到这时才是真的在排队。
    if try_acquire_slot() {
        if let Err(err) = run_job(
            id,
            job,
            Arc::clone(&on_started),
            Arc::clone(&on_event),
            Arc::clone(&done),
            Arc::clone(&on_cancelled),
        ) {
            release_slot();
            return Err(err);
        }
        return Ok(id);
    }
    std::thread::spawn(move || {
        acquire_slot();
        if let Err(err) = run_job(id, job, on_started, on_event, Arc::clone(&done), on_cancelled) {
            release_slot();
            call_done(&done, id, false, Some(err));
        }
    });
    Ok(id)
}

type StartedCb = Arc<Mutex<dyn Fn(u32) + Send + 'static>>;
type ProgressCb = Arc<Mutex<dyn Fn(u32, Value) + Send + 'static>>;
type DoneCb = Arc<Mutex<dyn Fn(u32, bool, Option<String>) + Send + 'static>>;
type CancelCb = Arc<Mutex<dyn Fn(u32) + Send + 'static>>;

/// 调一次 done 回调（锁中毒时静默跳过，回调只用于通知 UI，不值得为它 panic）。
fn call_done(done: &DoneCb, id: u32, ok: bool, detail: Option<String>) {
    if let Ok(callback) = done.lock() {
        callback(id, ok, detail);
    }
}

/// `Job` 的拥有所有权版本：`start()` 可能要把整包搬进后台线程排队，
/// 借用的 `&str` 带不进去。
struct OwnedJob {
    url: String,
    mode: String,
    format_id: String,
    has_audio: bool,
    out_dir: std::path::PathBuf,
    concurrent: u32,
    cookies: CookieSource,
}

impl OwnedJob {
    fn new(job: &Job<'_>) -> Self {
        Self {
            url: job.url.to_string(),
            mode: job.mode.to_string(),
            format_id: job.format_id.to_string(),
            has_audio: job.has_audio,
            out_dir: job.out_dir.to_path_buf(),
            concurrent: job.concurrent,
            cookies: job.cookies.clone(),
        }
    }
}

/// 真正起进程的那一步：构造命令行、spawn、注册进程表、拉起读取线程。
/// 调用方负责槽位的获取与释放。
fn run_job(
    id: u32,
    job: OwnedJob,
    on_started: StartedCb,
    on_event: ProgressCb,
    done: DoneCb,
    on_cancelled: CancelCb,
) -> Result<(), String> {
    let OwnedJob { url, mode, format_id, has_audio, out_dir, concurrent, cookies } = job;
    let ytdlp = yt_dlp_path().ok_or("未找到 yt-dlp（App 包损坏或未安装）")?;
    std::fs::create_dir_all(&out_dir).map_err(|err| format!("创建下载目录失败：{err}"))?;

    // ffmpeg 只探一次：下面选选择器和工作目录都要用
    let ffmpeg = ffmpeg_path();
    // deno 同样只探一次：EJS 挑战需要 JS runtime，没有它每次都会告警
    let deno = deno_path();

    let mut cmd = Command::new(&ytdlp);
    no_console_window(&mut cmd);
    with_utf8_output(&mut cmd);
    // --newline：进度事件一行一个（默认进度条会用 \r 刷屏，没法按行读）
    // 保留 .part 后缀：取消后重下可续传。
    // --restrict-filenames：避免奇怪字符在某些文件系统上出问题
    // --no-mtime：别把文件时间改成视频发布时间，下载时间更符合直觉
    cmd.arg("--newline")
        .arg("--no-warnings")
        .arg("--no-mtime")
        .arg("--restrict-filenames")
        // 单任务多线程：YouTube 的 DASH/HLS 是独立分片请求，并行抓比串行快得多
        // （yt-dlp 默认 concurrent-fragments=1，纯串行）
        .arg("--concurrent-fragments")
        .arg(concurrent.max(1).to_string())
        .arg("--progress-template")
        // 前缀必须是模板正文的一部分，不能借 "download:" 这个类型选择器：
        // 冒号前那段会被 yt-dlp 吞掉（它只用来指定进度类型），
        // 写成 "download:|..." 吐出来的是 "|100.0%|..."，按前缀匹配永远落空。
        .arg("download:WTDL|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s")
        .arg("--print")
        .arg("after_move:WTPATH|%(filepath)j")
        // --print 隐含 --quiet，会把进度行和 [download]/[Merger] 这些信息行
        // 一起吞掉——进度条与最终文件路径都靠这些行，必须显式关掉静默。
        .arg("--no-quiet")
        .arg("-P")
        .arg(&out_dir);
    if let Some(path) = &ffmpeg {
        cmd.arg("--ffmpeg-location").arg(path);
    }
    with_deno(&mut cmd, &deno);
    cookies.apply(&mut cmd);

    if mode == "audio" {
        if ffmpeg.is_some() {
            cmd.arg("-x").arg("--audio-format").arg("m4a");
            // 不指定 -f 时 yt-dlp 走默认 `bestvideo*+bestaudio`：先把整条视频
            // 下下来再抽音频，白下一遍视频轨。给音轨选择器，与下面的
            // 无 ffmpeg 分支保持一致。
            cmd.arg("-f")
                .arg(or_default(&format_id, "bestaudio[ext=m4a]/bestaudio/best"));
        } else {
            // 没有 ffmpeg 时 `-x` 会直接报错退出，退一步：拿原始音轨
            // 不做转封装（通常本来就是 m4a/webm）。总好过整条任务失败。
            cmd.arg("-f")
                .arg(or_default(&format_id, "bestaudio[ext=m4a]/bestaudio/best"));
        }
    } else {
        // 一律产出 mp4：指定合并容器，再 remux 一道兜住 webm 源
        // （remux 只换封装不重编码，几秒钟的事）。
        cmd.arg("--merge-output-format")
            .arg("mp4")
            .arg("--remux-video")
            .arg("mp4")
            .arg("-f")
            .arg(video_selector(&format_id, has_audio, ffmpeg.is_some()));
    }
    cmd.arg("--").arg(url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // 诊断日志要用的副本：下面整段会搬进 'static 的读取线程，
    // 借用传不进去。
    let mode_log = mode.clone();
    let format_log = format_id.clone();

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|err| format!("启动 yt-dlp 失败：{err}"))?;
    let stdout = child.stdout.take().expect("stdout 已 piped");
    let stderr = child.stderr.take().expect("stderr 已 piped");

    CHILDREN
        .lock()
        .map_err(|_| "进程表损坏")?
        .insert(id, std::sync::Arc::new(std::sync::Mutex::new(TaskHandle {
            child: Some(child),
            process_group: cfg!(unix),
            ..Default::default()
        })));

    // 两个管道必须同时排空，否则 stderr 填满会阻塞 stdout 的 EOF。
    let stderr_reader = drain_stderr(stderr);

    // 必须先入队 started，再允许工作线程发送进度或终态事件。
    if let Ok(cb) = on_started.lock() {
        cb(id);
    }

    // 读 stdout：进度行 + 最终文件路径行
    std::thread::spawn(move || {
        let mut final_path: Option<String> = None;
        let mut aggregator = ProgressAggregator::default();
        for line in lines_lossy(stdout) {
            if let Some(event) = parse_progress_line(&line) {
                // 音视频分离时 yt-dlp 会分两条流各报一轮 0→100，
                // 聚合后再发，进度条才不会到顶后跳回 0。
                if let Ok(cb) = on_event.lock() {
                    cb(id, aggregator.feed(event));
                }
            } else if let Some(path) = parse_final_path(&line) {
                final_path = Some(path);
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
        let stderr_text = stderr_reader.join().unwrap_or_default();

        // 从 CHILDREN 取出 arc 并移除（cleanup 是唯一终态路径）
        let arc = match CHILDREN.lock().ok().and_then(|mut map| map.remove(&id)) {
            Some(a) => a,
            None => {
                release_slot();
                call_done(&done, id, false, Some("进程表状态异常".to_string()));
                return;
            }
        };
        {
            let ffmpeg_note = match &ffmpeg {
                Some(path) => path.display().to_string(),
                None => "无（yt-dlp 会跳过合并）".to_string(),
            };
            let stderr_note: String = stderr_text.trim().chars().take(1200).collect();
            download_log(&format!(
                "结束 id={id} mode={mode_log} format={format_log} ffmpeg={ffmpeg_note} stderr={stderr_note}"
            ));
        }
        // 一次性持有锁完成 wait + 读 canceled 标记 + 重置标记
        // 三态结果：Ok(true)=完成, Ok(false)=取消(走 on_cancelled), Err=失败
        let result = {
            let mut handle = match arc.lock() {
                Ok(h) => h,
                Err(_) => {
                    release_slot();
                    call_done(&done, id, false, Some("进程表损坏".to_string()));
                    return;
                }
            };
            let status = match handle.child.as_mut() {
                Some(c) => c.wait().map_err(|e| format!("等待进程失败：{e}")),
                None => Err("进程句柄已被清理".to_string()),
            };
            let cancelled_by_us = handle.canceled.swap(false, Ordering::SeqCst);
            match status {
                Ok(s) if s.success() => Ok(true),
                Ok(_) if cancelled_by_us => Ok(false),
                Ok(_) => {
                    let reason = stderr_text
                        .lines()
                        .rev()
                        .map(str::trim)
                        .find(|l| !l.is_empty())
                        .unwrap_or("下载失败");
                    Err(friendly_error(reason))
                }
                Err(e) => Err(e),
            }
        };
        // 任务到这里就退出闸门了，排队中的下一个可以开始。
        release_slot();
        let final_path_for_cleanup = final_path.clone();
        match result {
            Ok(true) => call_done(&done, id, true, final_path),
            Ok(false) => {
                // 取消/失败都清一次半截文件：.part 靠 yt-dlp 续传能救回来，
                // 但用户手动删任务的语义是"别留下垃圾"。
                cleanup_partials(final_path_for_cleanup.as_deref());
                if let Ok(cb) = on_cancelled.lock() {
                    cb(id);
                }
            }
            Err(detail) => {
                cleanup_partials(final_path_for_cleanup.as_deref());
                call_done(&done, id, false, Some(detail));
            }
        }
    });

    Ok(())
}

/// 清掉一次下载留下的半截文件。
///
/// yt-dlp 下载中是 `xxx.mp4.part`（合并前还有 `.f137.mp4` 之类的分流文件），
/// 抽音频时是 `xxx.webm.ytdl`。取消或失败后它们会一直躺在下载目录里，
/// 积少成多。只删这两个确切后缀，绝不碰已经落地的成品。
fn cleanup_partials(final_path: Option<&str>) {
    let Some(path) = final_path else { return; };
    for suffix in [".part", ".ytdl"] {
        let candidate = format!("{path}{suffix}");
        if std::path::Path::new(&candidate).is_file() {
            if let Err(err) = std::fs::remove_file(&candidate) {
                download_log(&format!("清理半截文件失败 {candidate}: {err}"));
            } else {
                download_log(&format!("已清理半截文件 {candidate}"));
            }
        }
    }
}

fn parse_final_path(line: &str) -> Option<String> {
    serde_json::from_str::<String>(line.strip_prefix("WTPATH|")?).ok()
}

fn drain_stderr(reader: impl std::io::Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut text = String::new();
        // 这里同样必须用 lines_lossy：stderr 里常有中文路径，提前收工不但会截断
        // friendly_error 要用的报错信息，还会把 stderr 管道也一并关掉。
        for line in lines_lossy(reader) {
            text.push_str(&line);
            text.push('\n');
        }
        text
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn final_path_uses_tagged_json_not_intermediate_messages() {
        assert_eq!(
            parse_final_path(r#"WTPATH|"C:\\Downloads\\中文 video.mp4""#),
            Some("C:\\Downloads\\中文 video.mp4".to_string())
        );
        assert_eq!(parse_final_path("[download] Destination: old.webm"), None);
        assert_eq!(parse_final_path("WTPATH|invalid"), None);
    }

    /// 回归：非法 UTF-8 的一行**不能**让读取迭代提前结束。
    ///
    /// 曾经写成 `reader.lines().map_while(Result::ok)`。中文 Windows 下 yt-dlp 用 GBK
    /// 写出的 `[download] Destination: <中文路径>` 是下载开始前就打印的第一条含路径的
    /// 行，于是第一次读取就返回 Err、**循环体一次都不会执行**（进度事件一个都发不出去）；
    /// 又因 `lines()` 按值消耗 reader，BufReader 随之被 drop、管道读端关闭，yt-dlp 下一次
    /// 写进度就 Errno 22 失败——用户看到的是「进度永远 0% 然后失败」。
    /// 这个测试钉住「坏行之后必须继续读」。
    #[test]
    fn lines_lossy_keeps_draining_after_invalid_utf8() {
        // \xb2\xe2\xca\xd4 是 "测试" 的 GBK 字节：yt-dlp 在 cp936 下正是这么写路径的
        let mut input: Vec<u8> = Vec::new();
        input.extend_from_slice(b"[download] Destination: C:\\");
        input.extend_from_slice(&[0xb2, 0xe2, 0xca, 0xd4]);
        input.extend_from_slice(b"\\a.mp4\n");
        // 顺带覆盖 CRLF 剥离（Windows 上子进程可能吐 \r\n）
        input.extend_from_slice(b"WTDL|10.0%|1.0MiB/s|00:10|1048576|10485760\r\n");
        input.extend_from_slice(b"WTPATH|\"C:\\\\u6d4b\\\\a.mp4\"\n");
        // 结尾没有换行的残行也要交出来
        input.extend_from_slice(b"tail-without-newline");

        let lines: Vec<String> = lines_lossy(input.as_slice()).collect();
        assert_eq!(lines.len(), 4, "非法 UTF-8 那行之后必须继续读：{lines:?}");
        assert!(lines[0].starts_with("[download] Destination: "));
        // 坏字节被替换成 U+FFFD，但行本身保留了
        assert!(lines[0].contains('\u{fffd}'));
        assert_eq!(lines[1], "WTDL|10.0%|1.0MiB/s|00:10|1048576|10485760");
        assert_eq!(lines[2], "WTPATH|\"C:\\\\u6d4b\\\\a.mp4\"");
        assert_eq!(lines[3], "tail-without-newline");
    }

    /// 钉住「输出编码靠 yt-dlp 的 --encoding，而不是 PYTHONIOENCODING 环境变量」。
    ///
    /// 打包成 exe 的 yt-dlp 不认那个环境变量（实测设了仍写 GBK），所以这里断言它
    /// 真的出现在命令行参数里——若有人图省事改回 `.env(...)`，这条会失败。
    #[test]
    fn utf8_output_uses_cli_flag_not_env_var() {
        let mut cmd = Command::new("yt-dlp");
        with_utf8_output(&mut cmd);
        let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert_eq!(args, vec!["--encoding", "utf-8"]);
        assert!(cmd.get_envs().next().is_none(), "不应依赖环境变量");
    }

    #[test]
    fn cancellation_fixture() {
        if std::env::var_os("WETUBE_PIPE_TEST_CHILD").is_some() {
            use std::io::Write;
            std::io::stderr().write_all(&vec![b'x'; 1024 * 1024]).unwrap();
            println!("pipes drained");
            return;
        }
        if std::env::var_os("WETUBE_CANCEL_TEST_CHILD").is_some() {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[test]
    fn history_replays_latest_state_and_preserves_terminal_result() {
        let mut history = EventHistory::default();
        let started = serde_json::json!({"kind":"started","id":7,"requestId":"page:2","title":"Video B"});
        history.record(&started);
        for percent in [10, 20, 70] {
            history.record(&serde_json::json!({"kind":"progress","id":7,"progress":{"percent":percent}}));
        }
        let snapshot = history.snapshot();
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0], started);
        assert_eq!(snapshot[1]["progress"]["percent"], 70);
        let done = serde_json::json!({"kind":"done","id":7,"detail":"saved.mp4"});
        history.record(&done);
        history.record(&serde_json::json!({"kind":"cancelled","id":7,"killed":false}));
        assert_eq!(history.snapshot(), vec![started, done]);
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_closes_descendant_stdout_too() {
        use std::os::unix::process::CommandExt;
        let mut child = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & printf 'ready\\n'; wait"])
            .process_group(0).stdout(Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let _ = tx.send(line);
            let _ = reader.read_line(&mut String::new());
            let _ = tx.send("eof".to_string());
        });
        let ready = rx.recv_timeout(std::time::Duration::from_secs(5));
        let killed = terminate_tree(&mut child, true);
        let eof = rx.recv_timeout(std::time::Duration::from_secs(5));
        let _ = child.wait();
        assert_eq!(ready.unwrap(), "ready\n");
        killed.unwrap();
        assert_eq!(eof.unwrap(), "eof");
    }

    #[test]
    fn drains_large_stderr_while_stdout_is_open() {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "download::tests::cancellation_fixture", "--nocapture"])
            .env("WETUBE_PIPE_TEST_CHILD", "1")
            .stdout(Stdio::piped()).stderr(Stdio::piped());
        no_console_window(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let stderr = drain_stderr(child.stderr.take().unwrap());
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let lines: Vec<_> = BufReader::new(stdout).lines().map_while(Result::ok).collect();
            let _ = tx.send(lines);
        });
        let result = rx.recv_timeout(std::time::Duration::from_secs(10));
        if result.is_err() { let _ = child.kill(); }
        let status = child.wait().unwrap();
        let errors = stderr.join().unwrap();
        assert!(result.unwrap().iter().any(|line| line.contains("pipes drained")));
        assert!(status.success());
        assert!(errors.len() >= 1024 * 1024);
    }

    #[test]
    fn cancel_uses_task_id_and_reports_missing_tasks() {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["--exact", "download::tests::cancellation_fixture"])
            .env("WETUBE_CANCEL_TEST_CHILD", "1")
            .stdout(Stdio::null()).stderr(Stdio::null());
        no_console_window(&mut cmd);
        let child = cmd.spawn().unwrap();
        let task_id = u32::MAX;
        assert_ne!(child.id(), task_id);
        CHILDREN.lock().unwrap().insert(task_id, std::sync::Arc::new(std::sync::Mutex::new(TaskHandle {
            child: Some(child),
            ..Default::default()
        })));
        assert!(cancel(task_id)); // kill 成功，保留在map中供cleanup使用
        // 进程正在退出，立即再次取消：try_wait可能返回Some（进程已退出），返回false
        // 如果进程还没退出完，可能返回true（kill成功）
        // 无论哪种情况，都不应panic
        let _ = cancel(task_id);
    }

    /// 候选名必须覆盖 Windows 的 .exe 形态——旧实现的裸名在 Windows
    /// 上永远匹配不到，这是下载功能失效的根因。
    #[test]
    fn exe_names_cover_windows_suffix() {
        let names = exe_names("yt-dlp");
        if cfg!(windows) {
            assert_eq!(names, vec!["yt-dlp.exe".to_string(), "yt-dlp".to_string()]);
        } else {
            assert_eq!(names, vec!["yt-dlp".to_string()]);
        }
    }

    /// 目录按优先级命中：靠前的目录里没有才往后找。
    #[test]
    fn find_exe_respects_dir_priority() {
        let base = std::env::temp_dir().join("wetube-findexe-test");
        let first = base.join("first");
        let second = base.join("second");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let file = if cfg!(windows) { "probe-tool.exe" } else { "probe-tool" };

        // 只有后一个目录里有 → 仍然能找到
        std::fs::write(second.join(file), b"").unwrap();
        assert_eq!(
            find_exe(&[first.clone(), second.clone()], "probe-tool"),
            Some(second.join(file))
        );

        // 靠前目录补上同名文件 → 优先级更高，命中靠前的
        std::fs::write(first.join(file), b"").unwrap();
        assert_eq!(
            find_exe(&[first.clone(), second.clone()], "probe-tool"),
            Some(first.join(file))
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn find_exe_returns_none_when_absent() {
        let missing = std::env::temp_dir().join("wetube-findexe-absent");
        let _ = std::fs::remove_dir_all(&missing);
        assert!(find_exe(&[missing], "no-such-tool-xyzzy").is_none());
    }

    /// 进度行解析：真实抓自 yt-dlp 的输出，含前几行 total=NA 的情况。
    #[test]
    fn parses_progress_lines() {
        let line = "WTDL|100.0%|  56.98KiB/s|00:05|1313287|NA";
        let parsed = parse_progress_line(line).expect("应识别为进度行");
        assert_eq!(parsed["percent"], "100.0%");
        assert_eq!(parsed["downloaded"], 1313287u64);
        assert_eq!(parsed["total"], 0u64);

        let done = parse_progress_line("WTDL|100.0%|40.42KiB/s|NA|1313287|1313287").unwrap();
        assert_eq!(done["total"], 1313287u64);

        // 旧模板写法（download: 被类型选择器吞掉后只剩裸竖线）必须不再被当成进度行
        assert!(parse_progress_line("|100.0%|  56.98KiB/s|00:05|1313287|NA").is_none());
        // 信息行不该被误判
        assert!(parse_progress_line("[download] Destination: a.mp4").is_none());
        assert!(parse_progress_line("WTDL|100.0%|").is_none());
    }

    /// cookie 来源解析：cookies.txt 优先于浏览器；"关闭" 视为不用。
    #[test]
    fn cookie_source_from_settings() {
        assert!(matches!(
            CookieSource::from_settings("", ""),
            CookieSource::None
        ));
        assert!(matches!(
            CookieSource::from_settings("   ", "关闭"),
            CookieSource::None
        ));
        match CookieSource::from_settings("", "chrome") {
            CookieSource::Browser(name) => assert_eq!(name, "chrome"),
            _ => panic!("应解析为浏览器来源"),
        }
        match CookieSource::from_settings("D:/c.txt", "chrome") {
            CookieSource::File(path) => assert_eq!(path, std::path::PathBuf::from("D:/c.txt")),
            _ => panic!("cookies.txt 应优先于浏览器"),
        }
        // 从资源管理器"拷贝为路径"粘过来会带引号，顺手剥掉
        match CookieSource::from_settings("\"D:/my cookies.txt\"", "") {
            CookieSource::File(path) => {
                assert_eq!(path, std::path::PathBuf::from("D:/my cookies.txt"));
            }
            _ => panic!("应剥掉首尾引号"),
        }
    }

    /// 报错翻译：机器人校验要给能照着做的中文，无关报错原样透传。
    #[test]
    fn friendly_error_maps_bot_check() {
        let raw =
            "ERROR: [youtube] xxx: Sign in to confirm you're not a bot. Use --cookies-from-browser";
        let msg = friendly_error(raw);
        assert!(msg.contains("机器人校验"), "应翻成中文提示：{msg}");
        assert!(msg.contains("cookies.txt"), "提示里要给出可操作的办法：{msg}");

        assert!(
            friendly_error("ERROR: Could not copy Chrome cookie database.").contains("完全退出"),
            "数据库被占用时应提示退出浏览器"
        );
        let other = "ERROR: Video unavailable";
        assert_eq!(friendly_error(other), other, "无关报错保持原样");
    }

    /// 旧版本留下的带版本号副本要清掉，且不能误删别的工具。
    /// 一个 ffmpeg 副本就是 100MB，升级几次不清理会白占几百兆。
    #[test]
    fn prune_removes_versioned_leftovers_only() {
        let dir = std::env::temp_dir().join("wetube-prune-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let keep = dir.join(tool_file_name("ffmpeg"));
        std::fs::write(&keep, b"x").unwrap();
        let stale = dir.join("ffmpeg-9.0.1.exe");
        std::fs::write(&stale, b"y").unwrap();
        let other = dir.join(tool_file_name("yt-dlp"));
        std::fs::write(&other, b"z").unwrap();

        prune_other_copies(&dir, "ffmpeg", &keep);

        assert!(!stale.exists(), "带版本号的旧副本应被清掉");
        assert!(keep.exists(), "当前副本不能被删");
        assert!(other.exists(), "别的工具不能被误删");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 解出的工具必须是**规范名**：yt-dlp 拿着 `--ffmpeg-location` 指到的位置
    /// 自己去找 `ffmpeg`，名字带了版本号它就找不到，合并会被静默跳过
    /// （表现为"下载成功但没声音"）。这条守着那个回归。
    #[test]
    fn tool_file_name_is_canonical() {
        for stem in ["ffmpeg", "yt-dlp", "qjs"] {
            let name = tool_file_name(stem);
            let expected = if cfg!(windows) {
                format!("{stem}.exe")
            } else {
                stem.to_string()
            };
            assert_eq!(name, expected, "{stem} 必须是规范名");
        }
    }

    /// 视频选择器：这次「下出来没声音」的核心修复点。
    #[test]
    fn video_selector_always_keeps_audio() {
        // 没指定格式：走「最佳视频 + 最佳音轨」组合
        let auto = video_selector("", false, true);
        assert!(auto.contains("+ba"), "默认选择器必须带音轨: {auto}");

        // 指定了自带音轨的格式：原样使用，不重复加音轨
        assert_eq!(video_selector("18", true, true), "18");

        // 指定了**不含音轨**的视频轨（YouTube 1080p 以上的常态）：
        // 必须补 bestaudio，否则就是无声视频
        let merged = video_selector("137", false, true);
        assert!(merged.starts_with("137+ba"), "分离视频轨必须补音轨: {merged}");
        // 音轨优先 m4a(AAC)——opus 塞进 mp4 老播放器可能不认
        assert!(merged.contains("137+ba[ext=m4a]"), "应优先 AAC 音轨: {merged}");

        // 没有 ffmpeg 时不能要求合并（yt-dlp 会直接报错），退渐进式单文件
        let fallback = video_selector("137", false, false);
        assert!(fallback.contains("acodec!=none"), "无 ffmpeg 应退渐进式: {fallback}");
        assert!(!fallback.contains("+ba"), "无 ffmpeg 不能要求合并: {fallback}");
    }

    /// 空格式 id 时用兜底选择器，非空时用用户选的。
    #[test]
    fn or_default_prefers_chosen_format() {
        assert_eq!(or_default("", "fallback"), "fallback");
        assert_eq!(or_default("251", "fallback"), "251");
    }

    /// 单文件分发的硬证据：把内嵌的工具解出来真的跑一次。
    /// 字节没内嵌、内容损坏、解出逻辑写错，都会在这条挂掉。
    /// 没跑过 fetch 脚本的机器（如 macOS 开发机）直接跳过。
    fn extract_and_run(
        stem: &str,
        bytes: &[u8],
        version: &str,
        packed: bool,
        expected_size: u64,
        args: &[&str],
        expect_prefix: &str,
    ) {
        if bytes.is_empty() {
            eprintln!("本次构建未内嵌 {stem}，跳过");
            return;
        }
        // 目录按工具名分开：三个内嵌工具的测试是并行跑的，共用一个目录时会
        // 互相踩（正在写 .tmp 的那份被另一条测试的 prune_other_copies 删掉，
        // 或 rename 撞车 → Windows 上 "拒绝访问"）。
        let dir = std::env::temp_dir().join(format!("wetube-embedded-test-{stem}"));
        std::fs::create_dir_all(&dir).unwrap();

        let path =
            extract_tool(&dir, stem, bytes, packed, expected_size).expect("解出内嵌工具失败");
        let got = std::fs::metadata(&path).unwrap().len();
        if expected_size > 0 {
            // 压缩态下这条尤其关键：解出来的必须是原始字节数，不是压缩态大小
            assert_eq!(got, expected_size, "解出的 {stem} 大小应与原始文件一致");
        }
        // 第二遍复用同一份，不重复写盘
        assert_eq!(
            extract_tool(&dir, stem, bytes, packed, expected_size).unwrap(),
            path
        );

        let out = std::process::Command::new(&path)
            .args(args)
            .output()
            .unwrap_or_else(|err| panic!("执行解出的 {stem} 失败：{err}"));
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(
            text.starts_with(expect_prefix),
            "{stem} 输出不符合预期：{text}"
        );
        if !version.is_empty() {
            assert!(
                text.contains(version),
                "{stem} 自报版本里应含 {version}：{text}"
            );
        }
    }

    /// 内嵌 ffmpeg 解出来的路径必须是规范名——合并能否发生就取决于它。
    #[test]
    fn embedded_ffmpeg_path_is_canonical() {
        if bundled::FFMPEG_BYTES.is_empty() {
            eprintln!("本次构建未内嵌 ffmpeg，跳过");
            return;
        }
        // 与 extract_and_run 的 ffmpeg 用例分开：那边的用例会解压并执行这个
        // 98MB 的文件，两个测试并行跑同一个目录必定撞车（"拒绝访问"）。
        let dir = std::env::temp_dir().join("wetube-embedded-test-ffmpeg-path");
        std::fs::create_dir_all(&dir).unwrap();
        let path = extract_tool(
            &dir,
            "ffmpeg",
            bundled::FFMPEG_BYTES,
            bundled::FFMPEG_PACKED,
            bundled::FFMPEG_SIZE,
        )
        .expect("解出内嵌 ffmpeg 失败");
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            tool_file_name("ffmpeg"),
            "解出的 ffmpeg 必须是规范名，否则 yt-dlp 找不到它、不会合并"
        );
    }

    /// qjs 是 YouTube EJS 挑战要用的 JS runtime，同样要能真的跑起来。
    #[test]
    fn embedded_qjs_extracts_and_runs() {
        extract_and_run(
            "qjs",
            bundled::DENO_BYTES,
            bundled::DENO_VERSION,
            bundled::DENO_PACKED,
            bundled::DENO_SIZE,
            // qjs 的 --version 输出就是裸版本号（如 "0.16.2"），
            // 正好让通用断言里的"自报版本应含 vendor 版本"一并生效
            &["--version"],
            "",
        );
    }

    #[test]
    fn embedded_ytdlp_extracts_and_runs() {
        extract_and_run(
            "yt-dlp",
            bundled::YTDLP_BYTES,
            bundled::YTDLP_VERSION,
            bundled::YTDLP_PACKED,
            bundled::YTDLP_SIZE,
            &["--version"],
            "",
        );
    }

    /// ffmpeg 内嵌是「自动合并音视频」的前提，必须真的能跑起来。
    #[test]
    fn embedded_ffmpeg_extracts_and_runs() {
        extract_and_run(
            "ffmpeg",
            bundled::FFMPEG_BYTES,
            bundled::FFMPEG_VERSION,
            bundled::FFMPEG_PACKED,
            bundled::FFMPEG_SIZE,
            &["-version"],
            "ffmpeg version",
        );
    }

    /// 自带目录列表里必须包含 exe 同目录——Windows 绿色版把 yt-dlp.exe
    /// 放在 WeTube.exe 旁边，这条路径不存在就会退到 PATH 而失败。
    #[test]
    fn bundled_dirs_include_exe_dir() {
        let dirs = bundled_dirs();
        if let Ok(exe) = std::env::current_exe() {
            let exe_dir = exe.parent().unwrap().to_path_buf();
            assert!(dirs.contains(&exe_dir), "缺少 exe 同目录候选: {dirs:?}");
        }
    }
}
