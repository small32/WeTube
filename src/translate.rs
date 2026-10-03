//! 字幕翻译：把页面抓到的字幕文本翻成目标语言。
//!
//! 关于为什么必须经 Rust 转发：注入进 YouTube 页面的脚本跑在 `youtube.com`
//! 源下，直接 `fetch` 第三方翻译接口会被 CORS 拦掉（免费接口大多不带
//! `Access-Control-Allow-Origin`）。所以翻译请求一律走这里，由 Rust 发出，
//! 结果再 eval 回页面。顺带也避免了在页面里暴露任何凭据。
//!
//! 实现思路参考 read-frog（GPL-3.0）的字幕翻译模块，针对 WeTube 的
//! 同步 IPC 模型重写。

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
    let payload: String = if trimmed.chars().count() > MAX_CHARS {
        trimmed.chars().take(MAX_CHARS).collect()
    } else {
        trimmed.to_string()
    };

    match edge_request(&[payload.clone()], target_lang)
        .ok()
        .and_then(|body| {
            parse_edge_batch_response(&body, 1)
                .into_iter()
                .next()
                .flatten()
        }) {
        Some(text) => Ok(text),
        // 主通道挂了再试 gtx。两个都失败时把两边的原因拼在一起返回，
        // 避免"静默失败"式的排查黑洞。
        None => translate_gtx(&payload, target_lang)
            .map_err(|_| "Edge通道与Google通道均失败（详见日志文件）".to_string()),
    }
}

/// 统一的 Edge 请求：单条与批量共用，返回原始响应体。
/// 请求失败 / 非 200 / 读响应失败统一记日志并返回 Err。
fn edge_request(texts: &[String], target_lang: &str) -> Result<String, String> {
    let target = ms_lang_code(target_lang);
    let url = format!("{EDGE_ENDPOINT}?from=&to={target}&isEnterpriseClient=false");
    let body = serde_json::to_string(texts).map_err(|err| {
        translate_log(&format!("batch encode failed: {err}"));
        format!("编码请求失败：{err}")
    })?;

    let response = minreq::post(&url)
        .with_header("Content-Type", "application/json")
        .with_header("User-Agent", BROWSER_UA)
        .with_body(body)
        .with_timeout(REQUEST_TIMEOUT)
        .send()
        .map_err(|err| {
            translate_log(&format!("batch request failed: {err}"));
            format!("请求失败：{err}")
        })?;

    if response.status_code != 200 {
        translate_log(&format!("batch http error: {}", response.status_code));
        return Err(format!("HTTP {}", response.status_code));
    }

    response.as_str().map(str::to_string).map_err(|err| {
        translate_log(&format!("batch read failed: {err}"));
        format!("读取响应失败：{err}")
    })
}

/// 批量翻译：整条字幕轨道按块送翻。Edge 接口原生支持字符串数组，
/// 请求/响应按位对应，比逐句翻快一个数量级。
/// Edge 不可用或缺项时，逐条用 Google 补齐；两个通道都失败才返回 None。
pub fn translate_batch(texts: &[String], target_lang: &str) -> Vec<Option<String>> {
    translate_batch_with(texts, target_lang, edge_request, translate_gtx)
}

fn translate_batch_with(
    texts: &[String],
    target_lang: &str,
    edge: impl FnOnce(&[String], &str) -> Result<String, String>,
    mut google: impl FnMut(&str, &str) -> Result<String, String>,
) -> Vec<Option<String>> {
    if texts.is_empty() {
        return Vec::new();
    }
    let mut results = match edge(texts, target_lang) {
        Ok(body) => parse_edge_batch_response(&body, texts.len()),
        Err(_) => vec![None; texts.len()],
    };
    let missing = results.iter().filter(|item| item.is_none()).count();
    if missing > 0 {
        translate_log(&format!(
            "batch google fallback items={missing}/{}",
            texts.len()
        ));
        // 同一块内顺序请求，避免 Edge 故障时把每句字幕同时发给 Google。
        for (index, (text, result)) in texts.iter().zip(results.iter_mut()).enumerate() {
            if result.is_some() {
                continue;
            }
            match google(text, target_lang) {
                Ok(translated) if !translated.trim().is_empty() => *result = Some(translated),
                Ok(_) => {
                    translate_log(&format!("batch google fallback index={index} empty result"))
                }
                Err(err) => translate_log(&format!(
                    "batch google fallback index={index} failed: {err}"
                )),
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

pub fn translate_log(message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[WeTube][translate] {message}");

    // data_dir 在两个平台都指向应用数据目录，不需要分平台写 cfg；
    // 目录可能还没建（配置要先改动才落盘），这里兜一下。
    let Some(dir) = dirs::data_dir().map(|base| base.join("WeTube")) else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("translate.log");
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    use std::io::Write as _;

    // 超限就清空重来。并发下可能出现"线程 A 刚写完、线程 B 判定超限清掉"——
    // 诊断日志而已，不值得为它加锁，丢几行不影响翻译本身。
    if file
        .metadata()
        .map(|meta| meta.len() > LOG_MAX_BYTES)
        .unwrap_or(false)
    {
        truncate_log(&path);
    }

    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // ⚠️ 必须拼成整行后一次 write_all，别用 writeln!：它会把格式串拆成多次
    // write() 系统调用，而每个翻译批次是独立线程（main.rs 的 thread::spawn），
    // 并发追加时多次 write 之间会被别的线程插队，日志行会交错写坏
    // （实测 12 个批次里有 2 行时间戳被吃掉）。单次 write 在 O_APPEND 下是原子的。
    let _ = file.write_all(format!("[{epoch}] {message}\n").as_bytes());
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
    let response = minreq::get(ENDPOINT)
        .with_param("client", "gtx")
        .with_param("sl", "auto")
        .with_param("tl", target_lang)
        .with_param("dt", "t")
        .with_param("q", text)
        .with_timeout(REQUEST_TIMEOUT)
        .send()
        .map_err(|err| format!("请求失败：{err}"))?;

    if response.status_code != 200 {
        // 429 是常态：Google 按出口 IP 限流，共享代理节点几乎必中。
        return Err(format!(
            "HTTP {}（Google 限流出口 IP 时高发）",
            response.status_code
        ));
    }
    let body = response
        .as_str()
        .map_err(|err| format!("读取翻译响应失败：{err}"))?;

    parse_gtx_response(body)
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
        let texts = vec!["hello".into(), "world".into(), "again".into()];
        let mut calls = Vec::new();
        let results = translate_batch_with(
            &texts,
            "zh-CN",
            |input, lang| {
                assert_eq!(input, texts);
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
            &["hello".into()],
            "en",
            |_, _| Ok(r#"[{"translations":[{"text":"Hello"}]}]"#.into()),
            |_, _| panic!("Edge 成功时不应请求 Google"),
        );
        assert_eq!(results, vec![Some("Hello".into())]);
    }

    #[test]
    fn unavailable_edge_batch_uses_google_and_preserves_failed_positions() {
        for edge_response in [
            Err("timeout".into()),
            Ok("invalid json".into()),
            Ok("{}".into()),
        ] {
            let texts = vec![
                "first".into(),
                "second".into(),
                "third".into(),
                "fourth".into(),
            ];
            let mut calls = Vec::new();
            let results = translate_batch_with(
                &texts,
                "ja",
                |_, _| edge_response,
                |text, lang| {
                    assert_eq!(lang, "ja");
                    calls.push(text.to_string());
                    match text {
                        "second" => Err("HTTP 429".into()),
                        "third" => Ok("  ".into()),
                        _ => Ok(format!("Google:{text}")),
                    }
                },
            );
            assert_eq!(calls, texts);
            assert_eq!(
                results,
                vec![
                    Some("Google:first".into()),
                    None,
                    None,
                    Some("Google:fourth".into())
                ]
            );
        }
    }

    #[test]
    fn empty_batch_does_not_request_either_provider() {
        let results = translate_batch_with(
            &[],
            "en",
            |_, _| panic!("空批次不应请求 Edge"),
            |_, _| panic!("空批次不应请求 Google"),
        );
        assert!(results.is_empty());
    }
}
