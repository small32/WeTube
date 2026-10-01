/*
 * 验证三个平台下前端 chrome 的渲染差异。
 *
 * 用 jsdom 模拟 src/main.rs 的 init_script() 注入顺序：
 *   1. window.__WETUBE_PLATFORM__ = "<platform>"
 *   2. 执行 src/titlebar.js
 *   3. 执行 src/ui.js
 *   4. 触发 DOMContentLoaded
 *
 * 然后检查各平台该有 / 不该有的 DOM 节点，确保「为某个平台做的改动」不会
 * 悄悄改坏另一个平台。
 *
 * 用法：
 *   npm install jsdom
 *   node scripts/verify-platform-ui.js
 *
 * 默认读脚本上一级目录的 src/，可用 WETUBE_SRC 覆盖：
 *   WETUBE_SRC=/path/to/src node scripts/verify-platform-ui.js
 *
 * 退出码 0 = 全部通过，1 = 有失败项（CI 据此判定）。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = process.env.WETUBE_SRC || path.join(__dirname, "..", "src");

function run(platform) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body><div id="masthead-container"></div></body></html>`,
    { url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;

  // 模拟 Rust 注入的平台常量
  window.__WETUBE_PLATFORM__ = platform;

  // 依次执行注入脚本（与 init_script 里的 titlebar → toolbar 顺序一致）
  window.eval(fs.readFileSync(path.join(SRC, "titlebar.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));

  // document-start 注入时 DOM 还没 ready，脚本会挂 DOMContentLoaded
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  const q = (sel) => window.document.querySelectorAll(sel).length;

  return {
    platform,
    chrome_bar: !!window.document.getElementById("wetube-chrome"),
    brand: q(".wetube-brand"),
    menu_triggers: q(".wetube-menu-trigger"),
    toolbar_btns: q(".wetube-toolbar .icon-btn"),
    window_ctrls: q(".wetube-winbtn"),
    support_style: !!window.document.getElementById("wetube-support-style"),
    shift_class: window.document.documentElement.classList.contains("wetube-support-shift"),
  };
}

const results = ["windows", "macos", "linux"].map(run);

const KEYS = [
  ["chrome_bar", "整条 chrome"],
  ["brand", "WeTube logo"],
  ["menu_triggers", "菜单项(文件/导航/视图/帮助)"],
  ["toolbar_btns", "工具按钮(后退等)"],
  ["window_ctrls", "窗口控制按钮"],
  ["support_style", "下推样式注入"],
  ["shift_class", "页面下推 class"],
];

const pad = (s, n) => String(s).padEnd(n, " ");
const PLATFORMS = results.map((r) => r.platform);

console.log(pad("检查项", 34) + PLATFORMS.map((p) => pad(p, 10)).join(""));
console.log("-".repeat(64));
for (const [key, label] of KEYS) {
  const row = results
    .map((r) => pad(r[key] === true ? "有" : r[key] === false ? "无" : r[key], 10))
    .join("");
  console.log(pad(label, 30) + row);
}

/**
 * 行为回归：这些是实际点/按键才会暴露的问题，静态 DOM 结构看不出来。
 *   1. 全屏（chrome 被隐藏）时页面不该还留着 36px 下推——导航事件会把 applyShift
 *      再跑一遍，若它不看 chrome 是否可见，就会在全屏下切视频后多出一条空白带。
 *   2. 后退按钮的 disabled 必须跟随 SPA 导航刷新——YouTube 走 pushState，不触发
 *      popstate，只在挂载时算一次的话，disabled 的按钮连 click 都不派发，永远点不动。
 */
function behaviorChecks() {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body></body></html>`,
    { url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  window.__WETUBE_PLATFORM__ = "windows";
  window.eval(fs.readFileSync(path.join(SRC, "titlebar.js"), "utf8"));
  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));

  const root = window.document.documentElement;
  const hasShift = () => root.classList.contains("wetube-support-shift");
  const out = [];

  out.push(["① 初始有下推", hasShift() === true]);
  window.__wetubeSetChromeVisible(false);
  out.push(["① 隐藏 chrome 后下推被撤销", hasShift() === false]);
  window.dispatchEvent(new window.Event("yt-navigate-finish"));
  out.push(["① 全屏下导航不得把下推加回来", hasShift() === false]);
  window.__wetubeSetChromeVisible(true);
  out.push(["① 退出全屏后下推恢复", hasShift() === true]);

  const back = window.document.querySelectorAll(".wetube-toolbar .icon-btn")[0];
  out.push(["② 初始（无历史）后退按钮灰显", !!back && back.disabled === true]);
  window.history.pushState({}, "", "/watch?v=aaaaaaaaaaa");
  window.history.pushState({}, "", "/watch?v=bbbbbbbbbbb");
  window.dispatchEvent(new window.Event("yt-navigate-finish"));
  out.push(["② SPA 导航后后退按钮可点", !!back && back.disabled === false]);

  return out;
}

const [win, mac, lin] = results;
const checks = [
  // Windows：改动前是什么样，现在还得是什么样
  ["Windows 整条 chrome 存在", win.chrome_bar === true],
  ["Windows 菜单项 4 个", win.menu_triggers === 4],
  ["Windows 工具按钮 4 个", win.toolbar_btns === 4],
  ["Windows 窗口控制 3 个", win.window_ctrls === 3],
  ["Windows 下推样式已注入", win.support_style === true],
  ["Windows 页面已下推", win.shift_class === true],
  // macOS：整条 chrome 都不该出现
  ["macOS 整条 chrome 不存在", mac.chrome_bar === false],
  ["macOS 无 logo", mac.brand === 0],
  ["macOS 无菜单项", mac.menu_triggers === 0],
  ["macOS 无工具按钮", mac.toolbar_btns === 0],
  ["macOS 无窗口控制", mac.window_ctrls === 0],
  ["macOS 未注入下推样式", mac.support_style === false],
  ["macOS 页面未下推", mac.shift_class === false],
  // Linux：同样依赖 HTML chrome，别被误伤
  ["Linux 保持完整 chrome", lin.chrome_bar === true && lin.window_ctrls === 3],
  ["Linux 页面已下推", lin.shift_class === true],
  ...behaviorChecks(),
];

console.log();
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}`);
  if (!ok) failed++;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}`);
process.exit(failed === 0 ? 0 : 1);
