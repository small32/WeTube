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
 *   3. 最大化按钮的图标只能由 Rust 回推的状态驱动（双击标题栏 / Win+↑ / 贴边 /
 *      绿色按钮这些系统路径都不经过按钮自己的 click）。
 *   4. 标题栏拖动必须"先移动超过阈值再发 window-drag"，且按钮/logo 上按下不拖动。
 *   5. 双击 logo 不能连发两次 home（浏览器对双击就是派发两次 click）。
 */
function behaviorChecks() {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body></body></html>`,
    { url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  window.__WETUBE_PLATFORM__ = "windows";
  const sent = [];
  window.ipc = { postMessage: (msg) => sent.push(msg) };
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

  /* ---- ③ 最大化按钮状态由 Rust 回推（window.__wetubeSetMaximized）---- */
  const chromeEl = window.document.getElementById("wetube-chrome");
  const maxBtn = window.document.querySelectorAll(".wetube-winbtn")[1];
  const maxLabel = () => `${maxBtn.title}|${maxBtn.getAttribute("aria-label")}`;
  out.push(["③ 初始是「最大化」", maxLabel() === "最大化|最大化"]);
  window.__wetubeSetMaximized(true);
  out.push([
    "③ 回推最大化后切成「还原」并标记 is-maximized",
    maxLabel() === "还原|还原" && maxBtn.classList.contains("is-maximized"),
  ]);
  window.__wetubeSetMaximized(true);
  out.push(["③ 重复回推同一个状态是幂等的", maxLabel() === "还原|还原"]);
  window.__wetubeSetMaximized(false);
  out.push([
    "③ 回推还原后回到「最大化」",
    maxLabel() === "最大化|最大化" && !maxBtn.classList.contains("is-maximized"),
  ]);
  // 非布尔值不能把状态带偏（Rust 那边传的是 bool，但配置/脚本可能给别的）
  window.__wetubeSetMaximized("yes");
  out.push(["③ 非 true 的值不当作最大化", maxLabel() === "最大化|最大化"]);

  /* ---- ④ 拖动：只有真正移动了才发 window-drag ---- */
  const dragCount = () => sent.filter((m) => m === "window-drag").length;
  const drag = (target) => {
    const base = dragCount();
    target.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, button: 0, screenX: 100, screenY: 100 }));
    // 2px：低于 4px 阈值（原地按下/松开要完整留给浏览器识别单击和双击）
    window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, screenX: 102, screenY: 101 }));
    const afterSmall = dragCount() - base;
    // 40px+：过阈值，应发一次
    window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, screenX: 140, screenY: 160 }));
    window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, screenX: 140, screenY: 160 }));
    // 松手后再动（此时监听已摘）不该再发
    window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, screenX: 200, screenY: 220 }));
    return { afterSmall, total: dragCount() - base };
  };

  const blankDrag = drag(chromeEl);
  out.push(["④ 小幅移动（<4px）不触发拖动", blankDrag.afterSmall === 0, `afterSmall=${blankDrag.afterSmall}`]);
  out.push(["④ 空白处拖过阈值后只发一条 window-drag", blankDrag.total === 1, `total=${blankDrag.total} sent=${JSON.stringify(sent)}`]);

  const brandDrag = drag(window.document.querySelector(".wetube-brand"));
  out.push(["④ logo 上按下不拖动", brandDrag.total === 0]);
  const menuDrag = drag(window.document.querySelector(".wetube-menu-trigger"));
  out.push(["④ 菜单按钮上按下不拖动", menuDrag.total === 0]);
  const ctrlDrag = drag(window.document.querySelectorAll(".wetube-winbtn")[2]);
  out.push(["④ 窗口控制按钮上按下不拖动", ctrlDrag.total === 0]);

  /* ---- ⑤ 双击 logo 不能连发两次 home ---- */
  const homes = () => sent.filter((m) => m === "home").length;
  const brandEl = window.document.querySelector(".wetube-brand");
  const clickBrand = () => brandEl.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  clickBrand();
  out.push(["⑤ 单击 logo 回首页", homes() === 1, `homes=${homes()} sent=${JSON.stringify(sent)}`]);
  clickBrand(); // 双击 = 两次 click
  out.push(["⑤ 双击的第二次 click 被去重", homes() === 1, `homes=${homes()}`]);

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
