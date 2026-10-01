/*
 * 快捷键设置面板的功能验证（jsdom）。
 *
 * 真实加载 src/ui.js + src/shortcut-panel.js，模拟用户操作：
 *   打开面板 → 点「更改」→ 按下一个组合键 → 检查发出的 IPC 消息
 *
 * 用法：
 *   npm install jsdom
 *   node scripts/verify-shortcuts.js
 *
 * 退出码 0 = 全部通过，1 = 有失败项。
 * 改了面板或快捷键分发逻辑后跑一遍，比手动点菜单快得多。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = process.env.WETUBE_SRC || path.join(__dirname, "..", "src");

// 与 Rust 侧 shortcuts.rs 的注册表保持一致（macOS 显示形态）
const REGISTRY = [
  { id: "back", label: "后退", group: "导航", spec: "Mod+ArrowLeft", display: "⌘←", default: "Mod+ArrowLeft", custom: false },
  { id: "forward", label: "前进", group: "导航", spec: "Mod+ArrowRight", display: "⌘→", default: "Mod+ArrowRight", custom: false },
  { id: "reload", label: "刷新", group: "导航", spec: "Mod+KeyR", display: "⌘R", default: "Mod+KeyR", custom: false },
  { id: "home", label: "回到首页", group: "导航", spec: "Mod+Shift+KeyH", display: "⌘⇧H", default: "Mod+Shift+KeyH", custom: false },
  { id: "open-external", label: "在系统浏览器中打开", group: "导航", spec: "Mod+Shift+KeyO", display: "⌘⇧O", default: "Mod+Shift+KeyO", custom: false },
  { id: "shortcuts", label: "快捷键设置…", group: "视图", spec: "Mod+Shift+KeyK", display: "⌘⇧K", default: "Mod+Shift+KeyK", custom: false },
  { id: "settings", label: "增强设置…", group: "视图", spec: "Mod+Comma", display: "⌘,", default: "Mod+Comma", custom: false },
  { id: "fullscreen", label: "切换全屏", group: "视图", spec: "F11", display: "F11", default: "F11", custom: false },
];

function setup() {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body></body></html>`,
    { url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  window.__WETUBE_PLATFORM__ = "macos";
  window.__WETUBE_SHORTCUTS__ = JSON.parse(JSON.stringify(REGISTRY));

  const sent = [];
  window.ipc = { postMessage: (msg) => sent.push(msg) };

  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(SRC, "shortcut-panel.js"), "utf8"));
  return { window, sent };
}

/** 每次都重新查——进入捕获态会整体重绘，之前拿到的节点就废了。 */
function rowFor(panel, label) {
  return [...panel.querySelectorAll(".sc-row")]
    .find((r) => r.querySelector(".sc-label").textContent === label);
}

/** 取最后一条指定类型的消息，别被前面的干扰。 */
function lastMessage(sent, type) {
  const parsed = sent.map((s) => { try { return JSON.parse(s); } catch { return null; } });
  for (let i = parsed.length - 1; i >= 0; i--) {
    if (parsed[i] && parsed[i].type === type) return parsed[i];
  }
  return null;
}

/** 模拟一次按键。spec 里的修饰键按 platform 决定。 */
function pressKey(window, { code, metaKey = false, ctrlKey = false, shiftKey = false, altKey = false, key = "" }) {
  const ev = new window.KeyboardEvent("keydown", {
    code, key, metaKey, ctrlKey, shiftKey, altKey,
    bubbles: true, cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev;
}

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

// ---------------------------------------------------------------- 用例

// 1. 面板能打开，条目数、分组正确
{
  const { window } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  check("面板能打开", !!panel);
  check("渲染出全部 8 项", panel && panel.querySelectorAll(".sc-row").length === 8,
    panel && `实际 ${panel.querySelectorAll(".sc-row").length} 项`);
  const groups = panel && [...panel.querySelectorAll(".sc-group")].map((n) => n.textContent);
  check("分组是 导航 / 视图", JSON.stringify(groups) === JSON.stringify(["导航", "视图"]),
    JSON.stringify(groups));
  const labels = panel && [...panel.querySelectorAll(".sc-label")].map((n) => n.textContent);
  check("快捷键设置排在增强设置前面",
    labels && labels.indexOf("快捷键设置…") < labels.indexOf("增强设置…"));
}

// 2. 捕获按键：点「更改」→ 按 Cmd+Shift+K → 发出正确的 IPC
{
  const { window, sent } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");

  // 找到「刷新」那一行，点它的「更改」
  const changeBtn = rowFor(panel, "刷新").querySelectorAll("button")[0];
  changeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  check("进入捕获态后显示提示",
    rowFor(panel, "刷新").querySelector(".sc-keys").textContent.includes("按下新的组合"),
    rowFor(panel, "刷新").querySelector(".sc-keys").textContent);
  check("捕获期间置上让路标志", window.__wetubeCapturingShortcut === true);

  // 按下 Cmd+Shift+K
  pressKey(window, { code: "KeyK", key: "k", metaKey: true, shiftKey: true });

  const payload = lastMessage(sent, "shortcut:set");
  check("发出了 shortcut:set", !!payload, JSON.stringify(sent));
  check("spec 是规范的 Mod+Shift+KeyK", payload && payload.spec === "Mod+Shift+KeyK",
    payload && payload.spec);
  check("id 是 reload", payload && payload.id === "reload", payload && payload.id);
  check("捕获结束后清掉让路标志", window.__wetubeCapturingShortcut === false);
}

// 3. 裸字母要被拒绝，不能存
{
  const { window, sent } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  const rows = [...panel.querySelectorAll(".sc-row")];
  rowFor(panel, "刷新").querySelectorAll("button")[0]
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  pressKey(window, { code: "KeyR", key: "r" }); // 没有任何修饰键

  const hasSet = sent.some((s) => { try { return JSON.parse(s).type === "shortcut:set"; } catch { return false; } });
  check("裸字母被拒绝，没有发出保存", !hasSet);
  const note = panel.querySelector(".sc-note");
  check("给出了提示文案", note && note.textContent.includes("Cmd"), note && note.textContent);
}

// 4. Esc 取消捕获
{
  const { window, sent } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  rowFor(panel, "刷新").querySelectorAll("button")[0]
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  pressKey(window, { code: "Escape", key: "Escape" });

  const hasSet = sent.some((s) => { try { return JSON.parse(s).type === "shortcut:set"; } catch { return false; } });
  check("Esc 取消，不保存", !hasSet);
  check("Esc 后退出捕获态", window.__wetubeCapturingShortcut === false);
}

// 5. 冲突提示（但仍允许保存）
{
  const { window, sent } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  rowFor(panel, "回到首页").querySelectorAll("button")[0]
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  // 改成跟「刷新」一样的 ⌘R
  pressKey(window, { code: "KeyR", key: "r", metaKey: true });

  check("冲突时仍然保存", !!lastMessage(sent, "shortcut:set"));
  const note = panel.querySelector(".sc-note");
  check("冲突有提示", note && note.textContent.includes("冲突"), note && note.textContent);
}

// 6. 恢复默认按钮
{
  const { window, sent } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  const [, defaultBtn] = rowFor(panel, "刷新").querySelectorAll("button");
  check("没改过时「默认」按钮置灰", defaultBtn.disabled === true);
  defaultBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  // 置灰状态下点击不该发消息
  check("置灰时点击不发消息", sent.length === 0, JSON.stringify(sent));

  // header 上的「全部恢复默认」
  panel.querySelector("header button").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const resetAll = lastMessage(sent, "shortcut:reset");
  check("「全部恢复默认」发出 shortcut:reset", !!resetAll && resetAll.id === undefined);
}

// 7. 改完注册表推回来要重绘
{
  const { window } = setup();
  window.__wetubeToggleShortcutPanel();
  const panel = window.document.getElementById("wetube-shortcut-panel");
  const before = [...panel.querySelectorAll(".sc-keys")].map((n) => n.textContent);

  const next = JSON.parse(JSON.stringify(REGISTRY));
  next[2] = { ...next[2], spec: "Mod+Shift+KeyR", display: "⌘⇧R", custom: true };
  window.__wetubeOnShortcutsChanged(next);

  const after = [...panel.querySelectorAll(".sc-keys")].map((n) => n.textContent);
  check("推新注册表后面板重绘", after[2] === "⌘⇧R" && before[2] === "⌘R",
    `前 ${before[2]} → 后 ${after[2]}`);
}

// 8. Ctrl/Cmd+, 只能把设置面板切换一次
//    ui.js 在 window 捕获阶段发出 IPC，Rust 收到后回调 __YTE.togglePanel()；
//    而 panel.js 自己又在 document 捕获阶段硬编码了一条同样的 Cmd/Ctrl+, 监听。
//    window 捕获先于 document 捕获 —— 不拦住的话同一次按键会 toggle 两次
//    （panel.js 先开、IPC 回环再关），用户看到的就是「按了没反应」。
{
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body></body></html>`,
    { url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  const sent = [];
  window.__WETUBE_PLATFORM__ = "windows";
  window.__WETUBE_SHORTCUTS__ = JSON.parse(JSON.stringify(REGISTRY));
  window.ipc = { postMessage: (msg) => sent.push(msg) };
  window.__YTE = {
    schema: JSON.parse(fs.readFileSync(path.join(SRC, "enhancer", "schema.json"), "utf8")),
    features: {},
    cfg: () => undefined,
    setConfig() {},
    isEnabled: () => false,
    log() {},
  };

  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(SRC, "enhancer", "panel.js"), "utf8"));

  const isOpen = () => {
    const root = window.document.getElementById("yte-settings-panel");
    return !!root && root.style.display !== "none";
  };

  // 派发在 body 上，传播路径才是 window → document → body，两处捕获监听都会跑到
  window.document.body.dispatchEvent(new window.KeyboardEvent("keydown", {
    code: "Comma", key: ",", ctrlKey: true, bubbles: true, cancelable: true,
  }));

  // ui.js 的 send() 发的是裸命令字符串（不是 JSON），与 main.rs 的 act() 对应
  const settingsMsgs = sent.filter((s) => s === "settings");
  check("Ctrl+, 发出且只发出一条 settings", settingsMsgs.length === 1, `实际收到 ${JSON.stringify(sent)}`);

  // 模拟 Rust 的 act("settings")：eval("window.__YTE.togglePanel()")
  for (const _ of settingsMsgs) window.__YTE.togglePanel();

  check("走完 IPC 回环后面板是打开的（说明只切换了一次）", isOpen() === true,
    `isOpen=${isOpen()}；若被切了两次这里会是关的`);
}

// ---------------------------------------------------------------- 输出

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed++;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
