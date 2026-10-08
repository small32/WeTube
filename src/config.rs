//! 配置存储：schema 是唯一数据源，用户值覆盖在默认值之上。
//!
//! `src/enhancer/schema.json` 同时喂给两边：
//!   * Rust 在这里读它，生成默认值、校验、落盘；
//!   * 注入的 JS 读它，自动渲染设置面板、按页面启用功能。
//! 所以加一个配置项只需要改那一个 JSON。

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde_json::{Map, Value};

pub const SCHEMA_JSON: &str = include_str!("enhancer/schema.json");

/// feature id → { 字段路径 → 值 }，嵌套路径用点分（如 `colors.mainColor`）。
pub type Values = Map<String, Value>;

pub struct ConfigStore {
    schema: Value,
    /// 只有用户显式改过的项，没改过的不写进文件。
    overrides: Values,
    /// 快捷键 id → spec 字符串（如 `Mod+Shift+H`）。没改过的不写。
    ///
    /// 跟增强功能配置分开存，两者结构不一样：那边是 feature → 点分路径 → 值，
    /// 这边是扁平的一层。混在一起会让 `full_config()` 多出一堆无关字段。
    shortcuts: Map<String, Value>,
    path: PathBuf,
    /// 主文件解析不出来且备份也不可用：为 true 时 `save()` 直接拒绝，避免清空用户数据。
    corrupt: bool,
    /// 本次是从 `settings.bak` 恢复出来的：保存时不能再拿损坏的主文件把 bak 顶掉。
    recovered: bool,
}

/// 读备份文件，读不到或解析不了返回 `None`。
fn read_backup(path: &std::path::Path) -> Option<Value> {
    fs::read_to_string(path.with_extension("bak"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("读写配置文件失败：{0}")]
    Io(#[from] std::io::Error),
    #[error("schema 解析失败：{0}")]
    Schema(#[from] serde_json::Error),
    /// 配置文件存在但解析不出来，且备份也救不回来。
    ///
    /// 这时继续写文件只会把用户的设置和快捷键清空、还会把完好的备份顶掉，
    /// 所以一律拒绝落盘，让界面把错误显式报出来。
    #[error("配置文件已损坏，拒绝覆盖（请手动修复或删除 settings.json 后重试）")]
    Corrupt,
}

impl ConfigStore {
    pub fn load() -> Result<Self, ConfigError> {
        let schema: Value = serde_json::from_str(SCHEMA_JSON)?;
        let path = config_path();

        // 「文件不存在」和「文件读不出来/解析不了」必须分开：
        // 前者是首次启动，正常；后者说明用户数据可能已经坏了，
        // 绝不能当成空配置再写回去（原写法会连带覆盖 settings.bak）。
        let mut corrupt = false;
        let mut recovered = false;
        let root: Value = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(value) => value,
                Err(_) => match read_backup(&path) {
                    // 主文件坏了但备份还完好：用备份把数据救回来，允许继续保存。
                    Some(value) => {
                        recovered = true;
                        value
                    }
                    None => {
                        corrupt = true;
                        Value::Null
                    }
                },
            },
            // 主文件不存在：首次启动，或上次写坏了没有留下主文件。
            Err(_) => read_backup(&path).unwrap_or(Value::Null),
        };

        let (overrides, shortcuts) = split_saved(root);

        Ok(Self { schema, overrides, shortcuts, path, corrupt, recovered })
    }

    /// 配置是否损坏到无法安全保存（见 [`ConfigError::Corrupt`]）。
    pub fn is_corrupt(&self) -> bool {
        self.corrupt
    }

    /// 默认值打底、用户值覆盖，得到完整配置。
    pub fn full_config(&self) -> Value {
        let mut config = defaults_from_schema(&self.schema);
        merge_into(&mut config, &Value::Object(self.overrides.clone()));
        config
    }

    /// 设置某一项并落盘。key 是点分路径。
    pub fn set(&mut self, feature: &str, key: &str, value: Value) -> Result<(), ConfigError> {
        let entry = self
            .overrides
            .entry(feature.to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        set_path(entry, key, value);
        self.save()
    }

    /// 重置某个 feature（或传 None 全部重置）。
    pub fn reset(&mut self, feature: Option<&str>) -> Result<(), ConfigError> {
        match feature {
            Some(id) => {
                self.overrides.remove(id);
            }
            None => self.overrides.clear(),
        }
        self.save()
    }

    /// 某项快捷键的用户自定义值，没改过返回 `None`。
    pub fn shortcut(&self, id: &str) -> Option<&str> {
        self.shortcuts.get(id).and_then(Value::as_str)
    }

    /// 整张快捷键表，喂给设置面板渲染用。
    pub fn shortcuts(&self) -> &Map<String, Value> {
        &self.shortcuts
    }

    /// 设置快捷键并落盘。`spec` 传 `None` 表示恢复默认。
    pub fn set_shortcut(&mut self, id: &str, spec: Option<&str>) -> Result<(), ConfigError> {
        match spec {
            Some(value) => {
                self.shortcuts
                    .insert(id.to_string(), Value::String(value.to_string()));
            }
            None => {
                self.shortcuts.remove(id);
            }
        }
        self.save()
    }

    /// 全部快捷键恢复默认。
    pub fn reset_shortcuts(&mut self) -> Result<(), ConfigError> {
        self.shortcuts.clear();
        self.save()
    }

    fn save(&self) -> Result<(), ConfigError> {
        // 数据已经救不回来就别写了：写下去只会把空配置盖到用户文件上，
        // 还会把 settings.bak 里那份完好的备份一起顶掉。
        if self.corrupt {
            return Err(ConfigError::Corrupt);
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let root = serde_json::json!({
            "features": self.overrides,
            "shortcuts": self.shortcuts,
        });
        let text = serde_json::to_string_pretty(&root)?;
        let tmp = self.path.with_extension("tmp");
        let mut file = fs::File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        {
            let backup = self.path.with_extension("bak");
            if self.path.exists() {
                if backup.exists() {
                    if self.recovered {
                        // bak 是本次用来救数据的那份，不能再被覆盖：直接删掉坏掉的主文件。
                        fs::remove_file(&self.path)?;
                    } else {
                        fs::remove_file(&backup)?;
                        fs::rename(&self.path, &backup)?;
                    }
                } else {
                    fs::rename(&self.path, &backup)?;
                }
            }
            if let Err(err) = fs::rename(&tmp, &self.path) {
                if backup.exists() {
                    let _ = fs::rename(&backup, &self.path);
                }
                return Err(err.into());
            }
        }
        #[cfg(not(windows))]
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// 从配置文件内容里拆出 feature 覆盖表和快捷键表。
///
/// 加了快捷键之后 settings.json 变成 `{ "features": …, "shortcuts": … }` 两层。
/// 早期版本顶层直接就是 feature 覆盖表，这里认不出新格式就按老格式读，
/// 别把用户已经配好的东西弄丢。
fn split_saved(root: Value) -> (Values, Map<String, Value>) {
    let wrapped = root.get("features").is_some() || root.get("shortcuts").is_some();
    if wrapped {
        (
            root.get("features")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            root.get("shortcuts")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        )
    } else {
        (root.as_object().cloned().unwrap_or_default(), Map::new())
    }
}

/// 从 schema 里抽出所有默认值，拼成一棵完整配置树。
fn defaults_from_schema(schema: &Value) -> Value {
    let mut config = Map::new();
    let Some(features) = schema["features"].as_array() else {
        return Value::Object(config);
    };
    for feature in features {
        let Some(id) = feature["id"].as_str() else { continue };
        let mut node = Value::Object(Map::new());
        if let Some(fields) = feature["fields"].as_array() {
            for field in fields {
                let (Some(key), Some(default)) = (field["key"].as_str(), field.get("default")) else {
                    continue;
                };
                set_path(&mut node, key, default.clone());
            }
        }
        config.insert(id.to_string(), node);
    }
    Value::Object(config)
}

fn merge_into(base: &mut Value, patch: &Value) {
    let (Some(base_map), Some(patch_map)) = (base.as_object_mut(), patch.as_object()) else {
        return;
    };
    for (key, value) in patch_map {
        let both_objects = value.is_object() && base_map.get(key).is_some_and(Value::is_object);
        if both_objects {
            let incoming = value.clone();
            if let Some(existing) = base_map.get_mut(key) {
                merge_into(existing, &incoming);
            }
        } else {
            base_map.insert(key.clone(), value.clone());
        }
    }
}

/// 按点分路径写值，中间的层级自动补 Object。
///
/// 碰上非对象的中间层（老格式残留、手改过的配置文件）就把它顶掉重建，
/// 不能 panic —— 这条路径直接吃用户输入，崩在主线程上就是"改设置就闪退"。
pub fn set_path(value: &mut Value, path: &str, new_value: Value) {
    let parts: Vec<&str> = path.split('.').collect();
    let mut node = value;
    for part in &parts[..parts.len() - 1] {
        if !node.is_object() {
            *node = Value::Object(Map::new());
        }
        let entry = node
            .as_object_mut()
            .expect("上一行已保证是对象")
            .entry((*part).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        node = entry;
    }
    if !node.is_object() {
        *node = Value::Object(Map::new());
    }
    node.as_object_mut()
        .expect("上一行已保证是对象")
        .insert(parts[parts.len() - 1].to_string(), new_value);
}

/// 配置文件位置：
///   macOS   ~/Library/Application Support/WeTube/settings.json
///   Windows %APPDATA%\WeTube\settings.json
fn config_path() -> PathBuf {
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("WeTube").join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        serde_json::from_str(SCHEMA_JSON).expect("schema 必须能解析")
    }

    /// schema 是设置面板的唯一数据源，这几个字段是它的契约。
    #[test]
    fn schema_is_well_formed() {
        let schema = schema();
        let features = schema["features"].as_array().expect("features 必须是数组");
        assert!(!features.is_empty(), "schema 里得有功能");

        let mut paths = std::collections::HashSet::new();
        for feature in features {
            let id = feature["id"].as_str().expect("每个功能都要有 id");
            let fields = feature["fields"].as_array().expect("每个功能都要有 fields");
            assert!(!fields.is_empty(), "{id} 没有任何配置项");
            for field in fields {
                let key = field["key"].as_str().expect("字段要有 key");
                assert!(field.get("default").is_some(), "{id}.{key} 缺少默认值");
                assert!(field["label"].as_str().is_some(), "{id}.{key} 缺少中文标签");
                assert!(paths.insert(format!("{id}.{key}")), "重复的配置项 {id}.{key}");

                // 下拉框的默认值必须真的在候选列表里
                if field["type"] == "select" {
                    let options = field["options"].as_array().expect("select 要有 options");
                    assert!(
                        options.contains(&field["default"]),
                        "{id}.{key} 的默认值不在候选列表中"
                    );
                }
            }
            // 父子联动指向的字段得存在
            for field in fields {
                if let Some(parent) = field["parent"].as_str() {
                    assert!(
                        fields.iter().any(|item| item["key"] == parent),
                        "{id}.{} 的 parent({parent}) 不存在",
                        field["key"].as_str().unwrap()
                    );
                }
            }
        }
    }

    #[test]
    fn defaults_expand_nested_paths() {
        let defaults = defaults_from_schema(&schema());
        // 点分路径要展开成嵌套对象
        assert_eq!(defaults["deepDarkCSS"]["colors"]["mainColor"], "#367bf0");
        assert_eq!(defaults["hideShorts"]["home"]["enabled"], false);
        // 布尔开关的默认值统一是 false（屏显除外，它默认开）
        assert_eq!(defaults["hidePosts"]["enabled"], false);
        assert_eq!(defaults["onScreenDisplay"]["enabled"], true);
    }

    #[test]
    fn overrides_merge_over_defaults() {
        let defaults = defaults_from_schema(&schema());
        let overrides = serde_json::json!({
            "hideShorts": { "home": { "enabled": true } }
        });

        let mut merged = defaults;
        merge_into(&mut merged, &overrides);

        assert_eq!(merged["hideShorts"]["home"]["enabled"], true, "覆盖值要生效");
        // 同一层级的其它键不能被覆盖冲掉
        assert_eq!(merged["hideShorts"]["search"]["enabled"], false);
        assert_eq!(merged["hidePosts"]["enabled"], false);
    }

    /// 加了快捷键之后 settings.json 多了一层，老文件得还能读。
    #[test]
    fn split_saved_reads_legacy_and_wrapped() {
        // 老格式：顶层直接是 feature 覆盖表
        let legacy = serde_json::json!({ "hideShorts": { "home": { "enabled": true } } });
        let (overrides, shortcuts) = split_saved(legacy);
        assert_eq!(overrides["hideShorts"]["home"]["enabled"], true);
        assert!(shortcuts.is_empty(), "老文件里没有快捷键");

        // 新格式：features / shortcuts 各占一块
        let wrapped = serde_json::json!({
            "features": { "hideShorts": { "home": { "enabled": true } } },
            "shortcuts": { "reload": "Mod+Shift+R" },
        });
        let (overrides, shortcuts) = split_saved(wrapped);
        assert_eq!(overrides["hideShorts"]["home"]["enabled"], true);
        assert_eq!(shortcuts["reload"], "Mod+Shift+R");

        // 空文件 / 空对象不能炸
        let (overrides, shortcuts) = split_saved(Value::Null);
        assert!(overrides.is_empty() && shortcuts.is_empty());
        let (overrides, shortcuts) = split_saved(serde_json::json!({}));
        assert!(overrides.is_empty() && shortcuts.is_empty());
    }

    #[test]
    fn set_path_creates_missing_levels() {
        let mut node = Value::Object(Map::new());
        set_path(&mut node, "a.b.c", Value::Bool(true));
        assert_eq!(node["a"]["b"]["c"], true);

        // 中间层不是对象时要能顶掉
        let mut node = serde_json::json!({ "a": 1 });
        set_path(&mut node, "a.b", Value::from("x"));
        assert_eq!(node["a"]["b"], "x");
    }

    /// 根节点本身就不是对象（脏配置）时不能 panic —— 原来会 expect 炸在主线程。
    #[test]
    fn set_path_tolerates_non_object_root() {
        let mut node = Value::Bool(true);
        set_path(&mut node, "a.b", Value::from("x"));
        assert_eq!(node["a"]["b"], "x");

        let mut node = Value::Null;
        set_path(&mut node, "enabled", Value::Bool(true));
        assert_eq!(node["enabled"], true);
    }

    /// 配置文件损坏时 save() 必须拒绝落盘，不能把用户文件和备份顶掉。
    #[test]
    fn save_refuses_when_corrupt() {
        let dir = std::env::temp_dir().join(format!(
            "wetube-config-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos())
                .unwrap_or_default()
        ));
        fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join("settings.json");
        fs::write(&path, "{ 这不是合法 JSON").expect("写损坏文件");

        let store = ConfigStore {
            schema: schema(),
            overrides: Map::new(),
            shortcuts: Map::new(),
            path: path.clone(),
            corrupt: true,
            recovered: false,
        };
        assert!(matches!(store.save(), Err(ConfigError::Corrupt)));
        assert_eq!(
            fs::read_to_string(&path).expect("文件还在"),
            "{ 这不是合法 JSON",
            "损坏的配置不能被空配置覆盖"
        );
        assert!(!dir.join("settings.bak").exists(), "备份也不能被动过");

        let _ = fs::remove_dir_all(&dir);
    }
}
