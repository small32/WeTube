//! GitHub stable Release discovery; downloads are handed to the default browser.
use serde_json::{Value, json};

fn version(value: &str) -> Option<Vec<u64>> {
    let value = value.strip_prefix('v').unwrap_or(value);
    if value.contains('-') { return None; }
    let parts: Vec<u64> = value.split('+').next()?.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;
    (parts.len() == 3).then_some(parts)
}

fn release_result(release: &Value, current: &str, platform: &str) -> Result<Value, String> {
    let tag = release["tag_name"].as_str().ok_or("Release 缺少版本号")?;
    let latest = version(tag).ok_or("Release 版本号无效")?;
    let local = version(current).ok_or("本地版本号无效")?;
    if release["draft"] == true || release["prerelease"] == true { return Err("未找到正式 Release".into()); }
    if latest <= local { return Ok(json!({"status":"current"})); }
    let suffix = match platform {
        "windows" => "-windows-x64.zip",
        "macos" => "-macos-arm64.zip",
        _ => return Err("此平台暂无更新安装包".into()),
    };
    let name = format!("WeTube-{}{}", tag.trim_start_matches('v'), suffix);
    let asset = release["assets"].as_array().and_then(|assets| assets.iter().find(|a| a["name"] == name))
        .ok_or("发现新版本，但对应平台的安装包尚未发布，请稍后重试")?;
    let url = asset["browser_download_url"].as_str().ok_or("安装包缺少下载地址")?;
    if !url.starts_with("https://github.com/small32/WeTube/releases/download/") {
        return Err("Release 下载地址无效".into());
    }
    Ok(json!({"status":"available", "version":tag, "url":url}))
}

pub fn check() -> Value {
    let result = (|| {
        let response = minreq::get("https://api.github.com/repos/small32/WeTube/releases/latest")
            .with_header("User-Agent", concat!("WeTube/", env!("CARGO_PKG_VERSION")))
            .with_header("Accept", "application/vnd.github+json")
            .with_timeout(20).send().map_err(|e| format!("检查更新失败：{e}"))?;
        if response.status_code != 200 { return Err(format!("检查更新失败（HTTP {}）", response.status_code)); }
        let release: Value = serde_json::from_str(response.as_str().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        release_result(&release, env!("CARGO_PKG_VERSION"), std::env::consts::OS)
    })();
    result.unwrap_or_else(|message| json!({"status":"error", "message":message}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions_and_platform_assets() {
        let release = json!({"tag_name":"v3.0.10", "assets":[
            {"name":"WeTube-3.0.10-windows-x64.zip", "browser_download_url":"https://github.com/small32/WeTube/releases/download/v3.0.10/win.zip"},
            {"name":"WeTube-3.0.10-macos-arm64.zip", "browser_download_url":"https://github.com/small32/WeTube/releases/download/v3.0.10/mac.zip"}
        ]});
        assert!(release_result(&release, "3.0.8", "windows").unwrap()["url"].as_str().unwrap().ends_with("win.zip"));
        assert!(release_result(&release, "3.0.8", "macos").unwrap()["url"].as_str().unwrap().ends_with("mac.zip"));
        assert_eq!(release_result(&release, "3.0.10", "windows").unwrap()["status"], "current");
        assert_eq!(release_result(&release, "3.1.0", "windows").unwrap()["status"], "current");
        assert!(release_result(&json!({"tag_name":"v3.0.10","assets":[]}), "3.0.8", "macos").is_err());
    }
}
