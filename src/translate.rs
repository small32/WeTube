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
        .and_then(|body| parse_edge_batch_response(&body, 1).into_iter().next().flatten())
    {
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
/// 每项独立成败：失败的项返回 None，页面按原文兜底显示。
pub fn translate_batch(texts: &[String], target_lang: &str) -> Vec<Option<String>> {
    match edge_request(texts, target_lang) {
        Ok(body) => parse_edge_batch_response(&body, texts.len()),
        Err(_) => vec![None; texts.len()],
    }
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

/// 翻译链路日志（唯一入口，main 与本模块共用）：追加写在
/// %TEMP%\\WeTube-translate.log，release 也落盘——这次排查"批量全败但零错误
/// 记录"的教训：诊断日志不能只在 debug 下生效。
pub fn translate_log(message: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[WeTube][translate] {message}");
    let Ok(path) = std::env::var("TEMP") else { return };
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{path}\\WeTube-translate.log"))
    else {
        return;
    };
    use std::io::Write as _;
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(file, "[{epoch}] {message}");
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
}
