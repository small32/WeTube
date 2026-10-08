//! 字幕翻译：把页面抓到的字幕文本翻成目标语言。
//!
//! 关于为什么必须经 Rust 转发：注入进 YouTube 页面的脚本跑在 `youtube.com`
//! 源下，直接 `fetch` 第三方翻译接口会被 CORS 拦掉（免费接口大多不带
//! `Access-Control-Allow-Origin`）。所以翻译请求一律走这里，由 Rust 发出，
//! 结果再 eval 回页面。顺带也避免了在页面里暴露任何凭据。
//!
//! 实现思路参考 read-frog（GPL-3.0）的字幕翻译模块，针对 WeTube 的
//! 同步 IPC 模型重写。

use std::collections::HashMap;
use std::io::Write as _;
use std::sync::{LazyLock, Mutex};

/// 微软 Edge 翻译端点（免鉴权）。2026-08 迁移后的新接口：POST 字符串数组
/// 即可，无需 token。旧版 gtx 降为备用通道——Google 会按出口 IP 限流
/// （HTTP 429 "automated queries"），共享代理节点基本必挂。
const EDGE_ENDPOINT: &str = "https://edge.microsoft.com/translate/translatetext";

/// Google 免费翻译端点（`gtx` 客户端），不需要 API key。
const ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";

/// 单次翻译的文本上限。字幕一行通常很短，这里只是防止异常长的文本把 GET 撑爆、
/// 或者被人拿去当免费批量翻译机使。
const MAX_CHARS: usize = 500;

/// 请求超时（秒）。minreq 默认没有超时：连不上的话请求会永久挂起，
/// 页面上既没有译文也没有错误，表现为"点开了却什么都没发生"。
const REQUEST_TIMEOUT: u64 = 10;

/// 429 / 5xx 的退避重试次数。免费接口偶发限流，一次重试就能救回不少；
/// 再多只会把整批拖得更久（字幕是按块并发送翻的，单块慢会拖住整条轨道）。
const RETRY_ATTEMPTS: u32 = 2;

/// 兜底通道连续失败到这个数就整批放弃。
///
/// Edge 挂掉后逐条打 Google，Google 又按出口 IP 限流（429 是常态）：
/// 不熔断的话一块 30 条就是 30 次串行请求 × 10s 超时 = 最坏 300 秒，
/// 一条长轨同时开十几个块，结果整条轨道长时间没有译文。
const MAX_FALLBACK_FAILURES: usize = 4;

/// 译文缓存：(归一后的目标语言码, 原文) → 译文。
///
/// 没有缓存时，回看、重播、以及字幕里大量重复的句子都会重新发请求，
/// 既慢又容易撞上限流。容量见 [`CACHE_MAX_ENTRIES`]。
static CACHE: LazyLock<Mutex<HashMap<(String, String), String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 缓存条目上限，超了就整体清空重来（字幕文本量有限，不需要 LRU）。
const CACHE_MAX_ENTRIES: usize = 4000;

fn cache_get(lang: &str, text: &str) -> Option<String> {
    CACHE
        .lock()
        .ok()
        .and_then(|map| map.get(&(lang.to_string(), text.to_string())).cloned())
}

fn cache_put(lang: &str, text: &str, translated: &str) {
    if let Ok(mut map) = CACHE.lock() {
        if map.len() >= CACHE_MAX_ENTRIES {
            map.clear();
        }
        map.insert((lang.to_string(), text.to_string()), translated.to_string());
    }
}

/// 超长文本截断：字幕一行通常很短，这里只是防止异常长的文本把请求搞失败。
/// 单条和批量两条路径都必须走它。
fn clamp_text(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() > MAX_CHARS {
        trimmed.chars().take(MAX_CHARS).collect()
    } else {
        trimmed.to_string()
    }
}

/// 吞掉重试之间的等待（失败路径上才用得到）。
fn backoff(attempt: u32) {
    std::thread::sleep(std::time::Duration::from_millis(300 * attempt as u64));
}

/// 把 `text` 翻译成 `target_lang`（如 `zh-CN`、`en`）。
///
/// 成功返回译文；失败返回可直接显示给用户看的错误说明。
/// 单条只是批量的特例（数组里放一个元素），失败时降级试 gtx。
pub fn translate(text: &str, target_lang: &str) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("待翻译文本为空".to_string());
    }

    // 超长文本截断，避免 URL 过长把请求搞失败。
    let payload = clamp_text(trimmed);
    let lang = ms_lang_code(target_lang);

    if let Some(cached) = cache_get(&lang, &payload) {
        return Ok(cached);
    }

    match edge_request(&[payload.clone()], target_lang)
        .ok()
        .and_then(|body| {
            parse_edge_batch_response(&body, 1)
                .into_iter()
                .next()
                .flatten()
        }) {
        Some(text) => {
            cache_put(&lang, &payload, &text);
            Ok(text)
        }
        // 主通道挂了再试 gtx。两个都失败时把两边的原因拼在一起返回，
        // 避免"静默失败"式的排查黑洞。
        None => translate_gtx(&payload, target_lang)
            .map(|text| {
                cache_put(&lang, &payload, &text);
                text
            })
            .map_err(|_| "Edge通道与Google通道均失败（详见日志文件）".to_string()),
    }
}

/// 统一的 Edge 请求：单条与批量共用，返回原始响应体。
/// 请求失败 / 非 200 / 读响应失败统一记日志并返回 Err。
fn edge_request(texts: &[String], target_lang: &str) -> Result<String, String> {
    let target = ms_lang_code(target_lang);
    let body = serde_json::to_string(texts).map_err(|err| {
        translate_log(&format!("batch encode failed: {err}"));
        format!("编码请求失败：{err}")
    })?;

    // 查询参数一律走 with_param 交给库编码：手工拼 `to={target}` 时，
    // 目标语言码里只要出现 & # 空格之类就会把请求拼坏（还能顺带注入
    // 额外参数）。Google 那条通道本来就是这么写的，两条要一致。
    let mut attempt = 0;
    loop {
        attempt += 1;
        let outcome = minreq::post(EDGE_ENDPOINT)
            .with_param("from", "")
            .with_param("to", &target)
            .with_param("isEnterpriseClient", "false")
            .with_header("Content-Type", "application/json")
            .with_header("User-Agent", BROWSER_UA)
            .with_body(body.clone())
            .with_timeout(REQUEST_TIMEOUT)
            .send();

        match outcome {
            Ok(response) => {
                // 只认 2xx：204/206 也是成功，原来 `!= 200` 会把它们一起拒掉。
                if (200..300).contains(&response.status_code) {
                    return response.as_str().map(str::to_string).map_err(|err| {
                        translate_log(&format!("batch read failed: {err}"));
                        format!("读取响应失败：{err}")
                    });
                }
                let retryable = response.status_code == 429 || response.status_code >= 500;
                translate_log(&format!("batch http error: {}", response.status_code));
                if attempt < RETRY_ATTEMPTS && retryable {
                    backoff(attempt);
                    continue;
                }
                return Err(format!("HTTP {}", response.status_code));
            }
            Err(err) => {
                translate_log(&format!("batch request failed: {err}"));
                if attempt < RETRY_ATTEMPTS {
                    backoff(attempt);
                    continue;
                }
                return Err(format!("请求失败：{err}"));
            }
        }
    }
}

/// 批量翻译：整条字幕轨道按块送翻。Edge 接口原生支持字符串数组，
/// 请求/响应按位对应，比逐句翻快一个数量级。
/// Edge 不可用或缺项时，逐条用 Google 补齐；两个通道都失败才返回 None。
///
/// 入参用 `Option<String>`：页面拼错时数组里可能混进数字 / null，
/// 以前会被当成空串送去翻译（结果回一片空白），现在直接按位留 None。
pub fn translate_batch(texts: &[Option<String>], target_lang: &str) -> Vec<Option<String>> {
    translate_batch_with(texts, target_lang, edge_request, translate_gtx)
}

fn translate_batch_with(
    texts: &[Option<String>],
    target_lang: &str,
    edge: impl FnOnce(&[String], &str) -> Result<String, String>,
    mut google: impl FnMut(&str, &str) -> Result<String, String>,
) -> Vec<Option<String>> {
    if texts.is_empty() {
        return Vec::new();
    }
    let mut results: Vec<Option<String>> = vec![None; texts.len()];
    let lang = ms_lang_code(target_lang);

    // 待翻项：非字符串直接跳过（保持 None），字符串统一截断后再送。
    // (结果下标, 原文)
    let mut pending: Vec<(usize, String)> = Vec::new();
    for (index, text) in texts.iter().enumerate() {
        let Some(raw) = text.as_ref() else {
            continue;
        };
        let payload = clamp_text(raw);
        if payload.is_empty() {
            continue;
        }
        if let Some(cached) = cache_get(&lang, &payload) {
            results[index] = Some(cached);
            continue;
        }
        pending.push((index, payload));
    }
    if pending.is_empty() {
        return results;
    }

    let batch: Vec<String> = pending.iter().map(|(_, text)| text.clone()).collect();
    let edge_results = match edge(&batch, target_lang) {
        Ok(body) => parse_edge_batch_response(&body, batch.len()),
        Err(_) => vec![None; batch.len()],
    };

    let mut consecutive_failures = 0usize;
    for (slot, (index, text)) in pending.iter().enumerate() {
        if let Some(translated) = edge_results.get(slot).and_then(|item| item.clone()) {
            cache_put(&lang, text, &translated);
            results[*index] = Some(translated);
            continue;
        }
        // 熔断：兜底通道连续失败说明这条链路整体不可用（多半是 Google 429
        // 限流），再一条条试下去只会把这一块拖到几分钟、还拿不到结果。
        if consecutive_failures >= MAX_FALLBACK_FAILURES {
            translate_log(&format!(
                "batch fallback aborted after {consecutive_failures} failures, {} items left untranslated",
                pending.len() - slot
            ));
            break;
        }
        match google(text, target_lang) {
            Ok(translated) if !translated.trim().is_empty() => {
                cache_put(&lang, text, &translated);
                results[*index] = Some(translated);
                consecutive_failures = 0;
            }
            Ok(_) => translate_log(&format!("batch google fallback index={index} empty result")),
            Err(err) => {
                consecutive_failures += 1;
                translate_log(&format!(
                    "batch google fallback index={index} failed: {err}"
                ));
            }
        }
    }
    results
}

/// 批量响应解析：`[{translations:[{text}]} × N]`，按位取第 0 个译文。
/// 位缺失/解析失败返回 None，与输入等长。
fn parse_edge_batch_response(body: &str, expect_len: usize) -> Vec<Option<String>> {
    let mut results = vec![None; expect_len];
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return results;
    };
    let Some(items) = value.as_array() else {
        return results;
    };
    for (index, item) in items.iter().enumerate().take(expect_len) {
        let text = item
            .get("translations")
            .and_then(serde_json::Value::as_array)
            .and_then(|list| list.first())
            .and_then(|first| first.get("text"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .filter(|text| !text.trim().is_empty());
        results[index] = text;
    }
    results
}

/// 日志大小上限：64 MiB（按 1024 进位）。超了就清空从头写——字幕是持续送翻的，
/// 一条长视频就能刷出几万行，不限量的话迟早把磁盘吃掉。
const LOG_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 翻译链路日志（唯一入口，main 与本模块共用）：追加写在应用数据目录下的
/// `WeTube/translate.log`，release 也落盘——这次排查"批量全败但零错误
/// 记录"的教训：诊断日志不能只在 debug 下生效。
///
/// 路径跟 `config::config_path()` 同源：macOS `~/Library/Application Support/WeTube/`，
/// Windows `%APPDATA%\WeTube\`。
///
/// ⚠️ 别改成读 `TEMP` 环境变量 + 硬编码反斜杠：macOS 没有 `TEMP`，那样日志会
/// 静默消失，翻译失败时无从查起——这个坑踩过一次。跨平台取路径一律走 `dirs`。
/// 把日志文件截断为 0。
///
/// **不能对下面那个 append 句柄直接 `set_len(0)`**：Windows 下以 `.append(true)` 打开的文件，
/// Rust 只请求 `FILE_GENERIC_WRITE & !FILE_WRITE_DATA`（不含写数据权限），而 `set_len` 走
/// `SetFileInformationByHandle(FileEndOfFileInfo)`，需要写数据权限，必然 `ERROR_ACCESS_DENIED(5)`。
/// 错误又被 `let _` 吞掉，长度不变、随后的 write_all 继续追加——注释里承诺的"超了就清空
/// 从头写"在 Windows（主要分发平台）等于没写，日志无上限增长。
/// 实测：append 句柄 `Err(5)` 且内容不变；另开一个只写句柄 `Ok(())` 且内容被清空。
fn truncate_log(path: &std::path::Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_len(0);
    }
}

/// 复用的日志文件句柄 + 已写字节数。
///
/// 以前每条日志都 `open()` + `metadata()` 一次：批量翻译一次就是好几条，
/// 长视频跑下来是几万次 open/close + stat。句柄留着，长度自己累加即可
/// （只有本进程会写这个文件，外部改动最多让长度估算偏一点，无所谓）。
static LOG_STATE: LazyLock<Mutex<Option<(std::path::PathBuf, std::fs::File, u64)>>> =
    LazyLock::new(|| Mutex::new(None));

pub fn translate_log(message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[WeTube][translate] {message}");

    let mut guard = match LOG_STATE.lock() {
        Ok(guard) => guard,
        // 锁中毒就放弃这一条：诊断日志不值得为它 panic，更不值得 try_lock 硬来。
        Err(_) => return,
    };

    if guard.is_none() {
        // data_dir 在两个平台都指向应用数据目录，不需要分平台写 cfg；
        // 目录可能还没建（配置要先改动才落盘），这里兜一下。
        let Some(dir) = dirs::data_dir().map(|base| base.join("WeTube")) else {
            return;
        };
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let path = dir.join("translate.log");
        let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        else {
            return;
        };
        let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
        *guard = Some((path, file, len));
    }

    let Some((path, file, len)) = guard.as_mut() else {
        return;
    };

    // 超限就清空重来。并发下可能出现"线程 A 刚写完、线程 B 判定超限清掉"——
    // 诊断日志而已，不值得再加一把锁，丢几行不影响翻译本身。
    if *len > LOG_MAX_BYTES {
        truncate_log(path);
        *len = 0;
    }

    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // ⚠️ 必须拼成整行后一次 write_all，别用 writeln!：它会把格式串拆成多次
    // write() 系统调用，而每个翻译批次是独立线程（main.rs 的 thread::spawn），
    // 并发追加时多次 write 之间会被别的线程插队，日志行会交错写坏
    // （实测 12 个批次里有 2 行时间戳被吃掉）。单次 write 在 O_APPEND 下是原子的。
    let line = format!("[{epoch}] {message}\n");
    if file.write_all(line.as_bytes()).is_ok() {
        *len += line.len() as u64;
    }
}

/// Edge 翻译接口会校验客户端浏览器版本（缺 UA 直接 400
/// "Client Browser Version not supported"），统一带上浏览器 UA。
const BROWSER_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/// 微软语言码：他们家简体是 zh-Hans（Google 那边是 zh-CN），做个映射。
fn ms_lang_code(lang: &str) -> String {
    match lang {
        "zh-CN" | "zh" | "zh-Hans" => "zh-Hans".to_string(),
        "zh-TW" | "zh-Hant" => "zh-Hant".to_string(),
        other => other.to_string(),
    }
}

fn translate_gtx(text: &str, target_lang: &str) -> Result<String, String> {
    let payload = clamp_text(text);
    let mut attempt = 0;
    loop {
        attempt += 1;
        let outcome = minreq::get(ENDPOINT)
            .with_param("client", "gtx")
            .with_param("sl", "auto")
            .with_param("tl", target_lang)
            .with_param("dt", "t")
            .with_param("q", &payload)
            .with_timeout(REQUEST_TIMEOUT)
            .send();

        match outcome {
            Ok(response) => {
                if (200..300).contains(&response.status_code) {
                    let body = response
                        .as_str()
                        .map_err(|err| format!("读取翻译响应失败：{err}"))?;
                    return parse_gtx_response(body);
                }
                // 429 是常态：Google 按出口 IP 限流，共享代理节点几乎必中。
                // 限流和 5xx 值得退避重试一次，其余（4xx）重试也没用。
                let retryable = response.status_code == 429 || response.status_code >= 500;
                if attempt < RETRY_ATTEMPTS && retryable {
                    backoff(attempt);
                    continue;
                }
                return Err(format!(
                    "HTTP {}（Google 限流出口 IP 时高发）",
                    response.status_code
                ));
            }
            Err(err) => {
                if attempt < RETRY_ATTEMPTS {
                    backoff(attempt);
                    continue;
                }
                return Err(format!("请求失败：{err}"));
            }
        }
    }
}

/// 解析 gtx 端点的响应。
///
/// 响应是一个嵌套数组，形如：
/// ```text
/// [[["译文","原文",null,null,10],["第二段译文","原文",...]],null,"en"]
/// ```
/// 译文段落在 `data[0][*][0]`，按顺序拼起来就是完整译文。
fn parse_gtx_response(body: &str) -> Result<String, String> {
    let value: serde_json::Value =
        serde_json::from_str(body).map_err(|err| format!("解析翻译响应失败：{err}"))?;

    let segments = value
        .get(0)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "翻译响应结构异常：缺少译文数组".to_string())?;

    let mut translated = String::new();
    for segment in segments {
        if let Some(text) = segment.get(0).and_then(serde_json::Value::as_str) {
            translated.push_str(text);
        }
    }

    if translated.trim().is_empty() {
        return Err("翻译结果为空".to_string());
    }

    Ok(translated)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日志轮转必须真的能把文件清空。
    ///
    /// 顺带在 Windows 上钉住"为什么不能对 append 句柄直接 set_len"这个前提——
    /// 那个错误会被 `let _` 吞掉，表现为日志无上限增长，很难从现象反推。
    #[test]
    fn truncate_log_empties_the_file() {
        let dir = std::env::temp_dir().join("wetube-truncate-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("translate.log");

        std::fs::write(&path, b"AAAAAAAAAA\n").unwrap();
        truncate_log(&path);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0, "truncate_log 应把文件清空");

        #[cfg(windows)]
        {
            std::fs::write(&path, b"AAAAAAAAAA\n").unwrap();
            let append = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .unwrap();
            assert!(
                append.set_len(0).is_err(),
                "append 句柄在 Windows 上没有写数据权限，set_len 本来就该失败"
            );
            drop(append);
            assert_eq!(
                std::fs::metadata(&path).unwrap().len(),
                11,
                "那次失败会让内容原封不动（错误被 let _ 吞掉）"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 网络探针（默认忽略）：`cargo test -- --ignored` 手动跑，
    /// 打印真实 HTTP 状态与响应前 300 字节，用于诊断通道问题。
    #[test]
    #[ignore]
    fn probe_edge_batch_live() {
        let texts = vec![
            "and the way that we sell it, it's the same".to_string(),
            "basic math, look what it does to the bank".to_string(),
        ];
        let target = ms_lang_code("zh-CN");
        let url = format!("{EDGE_ENDPOINT}?from=&to={target}&isEnterpriseClient=false");
        let body = serde_json::to_string(&texts).unwrap();
        let response = minreq::post(&url)
            .with_header("Content-Type", "application/json")
            .with_header("User-Agent", BROWSER_UA)
            .with_body(body)
            .with_timeout(REQUEST_TIMEOUT)
            .send()
            .expect("请求发送失败");
        println!("PROBE status={}", response.status_code);
        println!("PROBE headers={:?}", response.headers);
        let text = response.as_str().unwrap_or("<binary>");
        println!("PROBE body={}", &text[..text.len().min(300)]);
    }

    #[test]
    fn rejects_empty_text() {
        assert!(translate("", "zh-CN").is_err());
        assert!(translate("   ", "zh-CN").is_err());
    }

    #[test]
    fn parses_gtx_array_shape() {
        // 抓自真实响应的结构：外层数组第 0 项是译文段列表。
        let body = r#"[[["你好","hello",null,null,10],["世界","world",null,null,10]],null,"en"]"#;
        assert_eq!(parse_gtx_response(body).unwrap(), "你好世界");
    }

    #[test]
    fn reports_empty_translation_as_error() {
        let body = r#"[[["","",null,null,10]],null,"en"]"#;
        assert!(parse_gtx_response(body).is_err());
    }

    #[test]
    fn rejects_malformed_response() {
        assert!(parse_gtx_response("not json").is_err());
        assert!(parse_gtx_response("{}").is_err());
    }

    #[test]
    fn parses_edge_response_shape() {
        // 抓自真实响应（2026-09 新端点）；单条请求现在也走批量解析器。
        let body = r#"[{"detectedLanguage":{"language":"en","score":1.0},"translations":[{"text":"你好，世界。","to":"zh-Hans","sentLen":{"srcSentLen":[13],"transSentLen":[7]}}]}]"#;
        let results = parse_edge_batch_response(body, 1);
        assert_eq!(results[0].as_deref(), Some("你好，世界。"));
        assert!(parse_edge_batch_response("[]", 1)[0].is_none());
        assert!(parse_edge_batch_response(r#"[{"translations":[]}]"#, 1)[0].is_none());
    }

    #[test]
    fn parses_edge_batch_response() {
        let body = r#"[{"translations":[{"text":"你好"}]},{"translations":[{"text":"世界"}]}]"#;
        let results = parse_edge_batch_response(body, 2);
        assert_eq!(results[0].as_deref(), Some("你好"));
        assert_eq!(results[1].as_deref(), Some("世界"));

        // 缺项/空译文 → None 占位，与输入等长
        let partial = r#"[{"translations":[{"text":"你好"}]}]"#;
        let results = parse_edge_batch_response(partial, 2);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].as_deref(), Some("你好"));
        assert!(results[1].is_none());
        assert_eq!(parse_edge_batch_response("not json", 3).len(), 3);
    }

    #[test]
    fn batch_prefers_edge_and_only_falls_back_for_missing_items() {
        let texts = vec![Some("hello".into()), Some("world".into()), Some("again".into())];
        let mut calls = Vec::new();
        let results = translate_batch_with(
            &texts,
            "zh-CN",
            |input, lang| {
                assert_eq!(input, vec!["hello".to_string(), "world".to_string(), "again".to_string()]);
                assert_eq!(lang, "zh-CN");
                Ok(r#"[{"translations":[{"text":"你好"}]},{"translations":[]}]"#.into())
            },
            |text, lang| {
                assert_eq!(lang, "zh-CN");
                calls.push(text.to_string());
                Ok(format!("Google:{text}"))
            },
        );
        assert_eq!(calls, vec!["world", "again"]);
        assert_eq!(
            results,
            vec![
                Some("你好".into()),
                Some("Google:world".into()),
                Some("Google:again".into())
            ]
        );
    }

    #[test]
    fn successful_edge_batch_does_not_call_google() {
        let results = translate_batch_with(
            &[Some("hello".into())],
            "en",
            |_, _| Ok(r#"[{"translations":[{"text":"Hello"}]}]"#.into()),
            |_, _| panic!("Edge 成功时不应请求 Google"),
        );
        assert_eq!(results, vec![Some("Hello".into())]);
    }

    #[test]
    fn unavailable_edge_batch_uses_google_and_preserves_failed_positions() {
        // 每轮用不同的文本：译文是有缓存的，第二轮拿同一批文本会直接命中
        // 缓存，Google 一次都不会被调用，这条断言就失去意义了。
        for (round, edge_response) in [
            (0, Err("timeout".into())),
            (1, Ok("invalid json".into())),
            (2, Ok("{}".into())),
        ] {
            let texts = vec![
                Some(format!("first{round}")),
                Some(format!("second{round}")),
                Some(format!("third{round}")),
                Some(format!("fourth{round}")),
            ];
            let mut calls = Vec::new();
            let results = translate_batch_with(
                &texts,
                "ja",
                |_, _| edge_response.clone(),
                |text, lang| {
                    assert_eq!(lang, "ja");
                    calls.push(text.to_string());
                    if text.starts_with("second") {
                        Err("HTTP 429".into())
                    } else if text.starts_with("third") {
                        Ok("  ".into())
                    } else {
                        Ok(format!("Google:{text}"))
                    }
                },
            );
            assert_eq!(
                calls,
                vec![
                    format!("first{round}"),
                    format!("second{round}"),
                    format!("third{round}"),
                    format!("fourth{round}")
                ]
            );
            assert_eq!(
                results,
                vec![
                    Some(format!("Google:first{round}")),
                    None,
                    None,
                    Some(format!("Google:fourth{round}"))
                ]
            );
        }
    }

    /// 页面把数字 / null 混进数组时，那些位必须原样留空，
    /// 不能被当成空串送去翻译（以前的表现是"翻译成功但一片空白"）。
    #[test]
    fn non_string_entries_are_skipped_not_translated() {
        let texts = vec![Some("hello".into()), None, Some("".into())];
        let results = translate_batch_with(
            &texts,
            "en",
            |input, _| {
                assert_eq!(input, vec!["hello".to_string()], "只有合法文本该被送出去");
                Ok(r#"[{"translations":[{"text":"Hello"}]}]"#.into())
            },
            |_, _| panic!("没有待翻项时不应请求 Google"),
        );
        assert_eq!(results, vec![Some("Hello".into()), None, None]);
    }

    /// Edge 整批失败时，Google 也不能无限重试：连续失败到上限就整批放弃，
    /// 否则一块 30 条就是 30 × 10s = 5 分钟的等待。
    #[test]
    fn fallback_aborts_after_repeated_failures() {
        let texts: Vec<Option<String>> = (0..8).map(|i| Some(format!("line{i}"))).collect();
        let mut calls = 0;
        let results = translate_batch_with(
            &texts,
            "en",
            |_, _| Err("edge down".into()),
            |_, _| {
                calls += 1;
                Err("HTTP 429".into())
            },
        );
        assert_eq!(calls, MAX_FALLBACK_FAILURES, "连续失败到上限就该停");
        assert!(results.iter().all(|item| item.is_none()));
    }

    #[test]
    fn empty_batch_does_not_request_either_provider() {
        let empty: [Option<String>; 0] = [];
        let results = translate_batch_with(
            &empty,
            "en",
            |_, _| panic!("空批次不应请求 Edge"),
            |_, _| panic!("空批次不应请求 Google"),
        );
        assert!(results.is_empty());
    }
}
