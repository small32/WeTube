//! 可自定义快捷键的注册表与序列化。
//!
//! ## 存储格式
//!
//! `Mod+Shift+H` —— 令牌用 `+` 连接，最后一个是主键，前面都是修饰键：
//!
//! | 令牌 | 含义 |
//! | ---- | ---- |
//! | `Mod` | 平台主键：macOS 是 Command，Windows / Linux 是 Control |
//! | `Ctrl` | 字面 Control（macOS 上要单独绑它时用） |
//! | `Alt` | Alt（macOS 上是 Option） |
//! | `Shift` | Shift |
//!
//! 主键**一律用 `Code` 的 Debug 名**（`KeyH` / `ArrowLeft` / `F11` / `Comma`…），
//! 三个好处：
//!   * 正好是 muda 解析表接受的写法；
//!   * 和 JS 里 `KeyboardEvent.code` 完全一致，前端捕获按键后可以直接把
//!     `ev.code` 拼进 spec，不用再做一层映射；
//!   * 规范形式唯一——`R` 和 `KeyR` muda 都认，但字符串不相等，两边各写一种
//!     会让"是否改过默认值"和冲突检测的判断全部失效。
//!
//! 解析时短写法（`Mod+R`）也接受，方便手改配置文件；存回去一律是长写法。
//!
//! ## ⚠️ 不能用 muda 自带的 `Accelerator::from_str`
//!
//! 它把 `Cmd` / `Super` 解析成 `Modifiers::META`(0x40)，但 muda 的 macOS 实现
//! 在拼 `keyEquivalentModifierMask` 时**只检查 `Modifiers::SUPER`(0x2000)**
//! （muda-0.19.3/src/platform_impl/macos/accelerator.rs 的 `modifier_mask`），
//! META 被直接忽略。照它解析 `"Cmd+R"` 会得到一个裸 `R` —— Command 静默丢失，
//! 菜单上只剩字母 R。所以修饰键这里自己解析，只有主键借用它的 `Code` 解析表。

use std::str::FromStr;

use muda::accelerator::{Accelerator, Code, Modifiers};
use serde_json::{Map, Value};

/// 一条可自定义的快捷键。
pub struct ShortcutDef {
    /// 与菜单项 id 一致：菜单事件、IPC、`act()` 都按这个分发。
    pub id: &'static str,
    /// 面板和菜单里显示的名字。
    pub label: &'static str,
    /// 所属菜单，设置面板按这个分组。
    pub group: &'static str,
    /// 默认快捷键，格式见模块文档。
    pub default: &'static str,
}

/// 全部可自定义项。
///
/// 只列 `MenuItem::with_id` 建的项。**`PredefinedMenuItem` 改不了快捷键**——
/// muda 没给它 `set_accelerator`，而且编辑菜单那几项走的是系统 responder 链，
/// 自己实现反而会弄坏 Cmd+V（`document.execCommand('paste')` 在浏览器里被禁）。
/// 所以「编辑」「窗口」保持系统标准快捷键。
pub const SHORTCUTS: &[ShortcutDef] = &[
    ShortcutDef { id: "back",          label: "后退",               group: "导航", default: "Mod+ArrowLeft" },
    ShortcutDef { id: "forward",       label: "前进",               group: "导航", default: "Mod+ArrowRight" },
    ShortcutDef { id: "reload",        label: "刷新",               group: "导航", default: "Mod+KeyR" },
    ShortcutDef { id: "home",          label: "回到首页",           group: "导航", default: "Mod+Shift+KeyH" },
    ShortcutDef { id: "open-external", label: "在系统浏览器中打开", group: "导航", default: "Mod+Shift+KeyO" },
    // 顺序要跟菜单里的一致：快捷键设置排在增强设置上面，面板照注册表顺序渲染。
    ShortcutDef { id: "shortcuts",     label: "快捷键设置…",        group: "视图", default: "Mod+Shift+KeyK" },
    ShortcutDef { id: "settings",      label: "增强设置…",          group: "视图", default: "Mod+Comma" },
    ShortcutDef { id: "fullscreen",    label: "切换全屏",           group: "视图", default: "F11" },
];

pub fn def(id: &str) -> Option<&'static ShortcutDef> {
    SHORTCUTS.iter().find(|d| d.id == id)
}

/// 平台主键：macOS 是 Command，Windows / Linux 是 Control。
#[cfg(target_os = "macos")]
pub fn primary() -> Modifiers {
    Modifiers::SUPER
}
#[cfg(not(target_os = "macos"))]
pub fn primary() -> Modifiers {
    Modifiers::CONTROL
}

/// 解析成 muda 的 `Accelerator`。格式非法返回 `None`。
pub fn parse(spec: &str) -> Option<Accelerator> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let (mods_part, key_part) = match spec.rfind('+') {
        Some(pos) => (&spec[..pos], spec[pos + 1..].trim()),
        None => ("", spec),
    };

    let mut mods = Modifiers::empty();
    for token in mods_part.split('+').map(str::trim).filter(|t| !t.is_empty()) {
        mods |= match token.to_ascii_lowercase().as_str() {
            "mod" => primary(),
            "ctrl" | "control" => Modifiers::CONTROL,
            "alt" | "option" => Modifiers::ALT,
            "shift" => Modifiers::SHIFT,
            _ => return None,
        };
    }

    Some(Accelerator::new(Some(mods), parse_key(key_part)?))
}

/// 解析主键：复用 muda 的 `Code` 解析表，省一份映射。
///
/// 传单个裸键（`"Left"` / `"F11"` / `"KeyR"`）进去，它的
/// `split_key_and_modifiers` 会把修饰键部分当空串处理，正好只用上解析表的
/// 那一半。
fn parse_key(token: &str) -> Option<Code> {
    Accelerator::from_str(token).ok().map(|a| a.key())
}

/// `Accelerator` → 存储用的字符串。顺序固定成 `Mod+Ctrl+Alt+Shift+Key`，
/// 这样同一组合不管怎么录入都会归一化成同一份文本，比对冲突时不会误判。
pub fn encode(accel: &Accelerator) -> String {
    let mut mods = accel.modifiers();
    let mut out = String::new();
    if mods.contains(primary()) {
        mods.remove(primary());
        out.push_str("Mod+");
    }
    if mods.contains(Modifiers::CONTROL) {
        out.push_str("Ctrl+");
    }
    if mods.contains(Modifiers::ALT) {
        out.push_str("Alt+");
    }
    if mods.contains(Modifiers::SHIFT) {
        out.push_str("Shift+");
    }
    // Code 是 #[derive(Debug)]，Debug 名正好就是解析表接受的写法。
    out.push_str(&format!("{:?}", accel.key()));
    out
}

/// 归一化：解析后再编码，顺手校验。非法返回 `None`。
pub fn normalize(spec: &str) -> Option<String> {
    parse(spec).map(|a| encode(&a))
}

/// 主键必须带修饰键，否则在 YouTube 里打个字母就触发功能。
/// 只有 F1–F12 这类不会干扰输入的功能键允许裸用。
pub fn is_valid(spec: &str) -> bool {
    let Some(accel) = parse(spec) else {
        return false;
    };
    if !accel.modifiers().is_empty() {
        return true;
    }
    matches!(
        accel.key(),
        Code::F1 | Code::F2 | Code::F3 | Code::F4 | Code::F5 | Code::F6
        | Code::F7 | Code::F8 | Code::F9 | Code::F10 | Code::F11 | Code::F12
    )
}

/// 实际生效的快捷键：有自定义用自定义，没有（或存的值坏了）退回默认。
pub fn resolve(id: &str, custom: Option<&str>) -> Option<Accelerator> {
    let d = def(id)?;
    custom.and_then(parse).or_else(|| parse(d.default))
}

/// 面板上显示用：macOS 用符号，Windows / Linux 用文字。
pub fn display(spec: &str) -> String {
    match parse(spec) {
        Some(accel) => display_accel(&accel),
        None => "未设置".to_string(),
    }
}

#[cfg(target_os = "macos")]
fn display_accel(accel: &Accelerator) -> String {
    let mods = accel.modifiers();
    let mut out = String::new();
    // macOS 习惯顺序：⌃ ⌥ ⇧ ⌘
    if mods.contains(Modifiers::CONTROL) {
        out.push('⌃');
    }
    if mods.contains(Modifiers::ALT) {
        out.push('⌥');
    }
    if mods.contains(Modifiers::SHIFT) {
        out.push('⇧');
    }
    if mods.contains(primary()) {
        out.push('⌘');
    }
    out.push_str(&display_key(accel.key()));
    out
}

#[cfg(not(target_os = "macos"))]
fn display_accel(accel: &Accelerator) -> String {
    let mods = accel.modifiers();
    // 非 macOS 上 primary() 就是 CONTROL，`Mod` 和 `Ctrl` 是同一个键，
    // 没有"字面的 Ctrl"这回事，所以这里只查一次。
    let mut parts: Vec<String> = Vec::new();
    if mods.contains(primary()) {
        parts.push("Ctrl".into());
    }
    if mods.contains(Modifiers::ALT) {
        parts.push("Alt".into());
    }
    if mods.contains(Modifiers::SHIFT) {
        parts.push("Shift".into());
    }
    parts.push(display_key(accel.key()));
    parts.join("+")
}

/// 主键的人话显示。`KeyR` → `R`，`Digit1` → `1`，方向键用箭头。
fn display_key(code: Code) -> String {
    match code {
        Code::ArrowLeft => "←".into(),
        Code::ArrowRight => "→".into(),
        Code::ArrowUp => "↑".into(),
        Code::ArrowDown => "↓".into(),
        Code::Space => "空格".into(),
        Code::Comma => ",".into(),
        Code::Period => ".".into(),
        Code::Slash => "/".into(),
        Code::Escape => "Esc".into(),
        Code::Enter => "回车".into(),
        Code::Tab => "Tab".into(),
        Code::Backspace => "退格".into(),
        other => {
            let name = format!("{other:?}");
            if let Some(rest) = name.strip_prefix("Key") {
                rest.to_string()
            } else if let Some(rest) = name.strip_prefix("Digit") {
                rest.to_string()
            } else {
                name
            }
        }
    }
}

/// 喂给设置面板的 JSON。
///
/// `display` 在 Rust 侧算好，JS 不用再抄一份格式化逻辑——两边各写一份迟早会
/// 对不上。
pub fn registry_json(custom: &Map<String, Value>) -> String {
    let items: Vec<Value> = SHORTCUTS
        .iter()
        .map(|d| {
            let stored = custom.get(d.id).and_then(Value::as_str);
            let spec = stored.unwrap_or(d.default);
            serde_json::json!({
                "id": d.id,
                "label": d.label,
                "group": d.group,
                "spec": spec,
                "display": display(spec),
                "default": d.default,
                "custom": stored.is_some(),
            })
        })
        .collect();
    serde_json::to_string(&Value::Array(items)).unwrap_or_else(|_| "[]".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这条是本模块存在的原因：muda 自带的解析器会把 Cmd 变成 META，
    /// 而 macOS 实现只认 SUPER，用它会让 Command 静默丢失。
    #[test]
    fn primary_uses_super_not_meta() {
        let accel = parse("Mod+R").expect("Mod+R 要能解析");
        let mods = accel.modifiers();

        #[cfg(target_os = "macos")]
        {
            assert!(
                mods.contains(Modifiers::SUPER),
                "macOS 上 Mod 必须是 SUPER(0x2000)，META 会被 muda 忽略"
            );
            assert!(
                !mods.contains(Modifiers::META),
                "绝不能落到 META(0x40) 上，否则菜单里 Cmd 会消失"
            );
        }
        #[cfg(not(target_os = "macos"))]
        assert!(mods.contains(Modifiers::CONTROL), "非 macOS 上 Mod 是 CONTROL");
    }

    #[test]
    fn round_trips() {
        for spec in [
            "Mod+KeyR",
            "Mod+Shift+KeyH",
            "Mod+ArrowLeft",
            "F11",
            "Mod+Comma",
            // 注意：本模块在 Windows 上把 Ctrl 规范成 Mod（见 primary_uses_super_not_meta），
            // 所以这里用规范写法，避免测试在 Windows 上把 Mod+Alt+Delete 误判成不 round-trip。
            "Mod+Alt+Delete",
        ] {
            let accel = parse(spec).unwrap_or_else(|| panic!("{spec} 要能解析"));
            assert_eq!(encode(&accel), spec, "{spec} 编码后应还原");
        }
    }

    /// 短写法只进不出：解析认，但存回去一定规范化成长写法。
    /// 否则"用户把刷新改回 Cmd+R"会被判成改过默认值。
    #[test]
    fn normalize_canonicalizes_short_forms() {
        assert_eq!(normalize("Mod+R").as_deref(), Some("Mod+KeyR"));
        assert_eq!(normalize("Mod+Left").as_deref(), Some("Mod+ArrowLeft"));
        assert_eq!(
            normalize("Mod+R").as_deref(),
            Some(def("reload").unwrap().default),
            "短写法必须归一化到跟默认值一致"
        );
    }

    /// 录入顺序不影响存储，否则比对冲突时会漏判。
    #[test]
    fn normalize_is_order_independent() {
        assert_eq!(normalize("Shift+Mod+KeyH").as_deref(), Some("Mod+Shift+KeyH"));
        assert_eq!(normalize("Mod+Shift+KeyH").as_deref(), Some("Mod+Shift+KeyH"));
        assert_eq!(normalize("  mod + shift + h ").as_deref(), Some("Mod+Shift+KeyH"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("").is_none());
        assert!(parse("NotAModifier+R").is_none());
        assert!(parse("Mod+").is_none());
        assert!(parse("Mod+NoSuchKey").is_none());
    }

    /// 裸字母会把打字误判成快捷键，必须拦掉；F11 这类功能键可以裸用。
    #[test]
    fn bare_keys_need_to_be_function_keys() {
        assert!(!is_valid("R"), "裸 R 会在打字时触发");
        assert!(!is_valid("Left"), "裸方向键会抢掉光标移动");
        assert!(is_valid("F11"), "全屏键允许裸用");
        assert!(is_valid("Mod+R"));
    }

    /// 存了坏值要退回默认，不能让菜单项变成无快捷键。
    #[test]
    fn resolve_falls_back_to_default() {
        let def = def("reload").expect("reload 得在注册表里");
        let default = parse(def.default).unwrap();

        assert!(resolve("reload", None).is_some());
        assert!(resolve("reload", Some("Mod+K")).is_some());
        assert_eq!(
            resolve("reload", Some("这不是快捷键")).unwrap().modifiers(),
            default.modifiers(),
            "坏值要退回默认"
        );
        assert!(resolve("不存在的 id", None).is_none());
    }

    /// 注册表里的默认值必须都能解析，否则启动就有菜单项没有快捷键。
    #[test]
    fn defaults_are_valid() {
        for d in SHORTCUTS {
            assert!(
                parse(d.default).is_some(),
                "{} 的默认值 {} 解析不了",
                d.id,
                d.default
            );
            assert!(is_valid(d.default), "{} 的默认值 {} 不合法", d.id, d.default);
        }
    }

    /// 菜单项 id 不能重复，不然两个功能抢同一个事件。
    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for d in SHORTCUTS {
            assert!(seen.insert(d.id), "重复的快捷键 id: {}", d.id);
        }
    }

    /// 设置面板完全照这份 JSON 渲染，少一个字段界面就废一半。
    #[test]
    fn registry_json_has_everything_the_panel_needs() {
        let items: Vec<Value> =
            serde_json::from_str(&registry_json(&Map::new())).expect("必须是合法 JSON 数组");
        assert_eq!(items.len(), SHORTCUTS.len());

        for item in &items {
            for field in ["id", "label", "group", "spec", "display", "default", "custom"] {
                assert!(item.get(field).is_some(), "缺少字段 {field}");
            }
            assert!(
                !item["display"].as_str().unwrap().is_empty(),
                "{} 的 display 是空的，面板上会显示成空白",
                item["id"]
            );
            assert_eq!(item["spec"], item["default"], "没自定义时 spec 应等于默认值");
            assert_eq!(item["custom"], false);
        }
    }

    /// 改过的项要标出来——面板靠 custom 决定"恢复默认"按钮能不能点。
    #[test]
    fn registry_json_marks_customized_items() {
        let mut custom = Map::new();
        custom.insert("reload".to_string(), Value::String("Mod+Shift+KeyR".into()));
        let items: Vec<Value> = serde_json::from_str(&registry_json(&custom)).unwrap();

        let reload = items.iter().find(|it| it["id"] == "reload").unwrap();
        assert_eq!(reload["spec"], "Mod+Shift+KeyR");
        assert_eq!(reload["custom"], true);
        // 只有改过的那项标 custom，别的一个都不能被带偏
        assert_eq!(
            items.iter().filter(|it| it["custom"] == true).count(),
            1,
            "应该只有一项是 custom"
        );
    }
}
