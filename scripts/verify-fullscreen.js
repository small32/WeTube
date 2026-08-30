/*
 * 全屏联动的验证（jsdom）。
 *
 * 目前只做单向：播放器全屏 → App 窗口跟着全屏，退出时跟着还原。
 * 反方向（菜单 / 快捷键 → 播放器）没做，原因见 src/ui.js 里的说明——
 * 合成调用拿不到用户激活，requestFullscreen 会被 WebKit 拒绝；用 CSS 兜底
 * 那一版试过，副作用太多，已回退。
 *
 * 用法：
 *   npm install jsdom
 *   node scripts/verify-fullscreen.js
 *
 * 退出码 0 = 全部通过，1 = 有失败项。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = process.env.WETUBE_SRC || path.join(__dirname, "..", "src");

const WATCH_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const HOME_URL = "https://www.youtube.com/";

/** 播放页骨架：播放器容器 + 全屏按钮。 */
const WATCH_PAGE = `
  <div id="movie_player" class="html5-video-player"><video></video></div>
  <button class="ytp-fullscreen-button"></button>
`;
const HOME_PAGE = `<div>首页内容</div>`;

function setup(bodyHtml = WATCH_PAGE, url = WATCH_URL) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${bodyHtml}</body></html>`,
    { url, runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  window.__WETUBE_PLATFORM__ = "macos";
  window.__WETUBE_SHORTCUTS__ = [];
  const sent = [];
  window.ipc = { postMessage: (m) => sent.push(m) };
  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));
  return { window, sent };
}

/** 假装当前处于（或不在）元素全屏。 */
function setElementFullscreen(window, value) {
  Object.defineProperty(window.document, "fullscreenElement", {
    value,
    configurable: true,
  });
}

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

// ---- 单向联动：播放器 → 窗口 ----

{
  const { window, sent } = setup();
  setElementFullscreen(window, {});
  window.document.dispatchEvent(new window.Event("fullscreenchange"));
  check(
    "播放器进全屏 → 上报 player-fullscreen:on",
    sent.includes("player-fullscreen:on"),
    JSON.stringify(sent)
  );
  setElementFullscreen(window, null);
}

{
  const { window, sent } = setup();
  window.document.dispatchEvent(new window.Event("fullscreenchange"));
  check(
    "播放器退全屏 → 上报 player-fullscreen:off",
    sent.includes("player-fullscreen:off"),
    JSON.stringify(sent)
  );
}

{
  // webkit 前缀的事件也要接（老版本 WebKit / YouTube 会发这个）
  const { window, sent } = setup();
  setElementFullscreen(window, {});
  window.document.dispatchEvent(new window.Event("webkitfullscreenchange"));
  check(
    "webkit 前缀的 fullscreenchange 也能接住",
    sent.includes("player-fullscreen:on"),
    JSON.stringify(sent)
  );
  setElementFullscreen(window, null);
}

// ---- 没有事件时不能乱发 ----

{
  const { window, sent } = setup();
  window.document.dispatchEvent(new window.Event("click"));
  check("无关事件不触发上报", sent.length === 0, JSON.stringify(sent));
}

// ---- 反向联动已移除，不能再有残留 ----

{
  const { window } = setup();
  check(
    "不再暴露 __wetubeSyncPlayerFullscreen",
    window.__wetubeSyncPlayerFullscreen === undefined
  );
}

{
  // 首页曾经被 CSS 兜底误伤（overflow:hidden 锁死滚动）。
  // 兜底已移除，这里确认页面上不会再出现那个 class。
  const { window } = setup(HOME_PAGE, HOME_URL);
  setElementFullscreen(window, {});
  window.document.dispatchEvent(new window.Event("fullscreenchange"));
  check(
    "首页不会出现 wetube-video-fill class",
    !window.document.documentElement.classList.contains("wetube-video-fill")
  );
  setElementFullscreen(window, null);
}

{
  const { window } = setup();
  check(
    "播放页也不会出现 wetube-video-fill class",
    !window.document.documentElement.classList.contains("wetube-video-fill")
  );
}

// ---- 窗口退出全屏时，元素全屏要跟着退 ----
//
// 不掉这个会残留 WebKit 的「按 Esc 退出全屏」浮层盖住页面。

{
  const { window } = setup();
  check(
    "暴露 __wetubeExitElementFullscreen",
    typeof window.__wetubeExitElementFullscreen === "function"
  );
}

{
  // 没有元素全屏时应该是空操作，返回 false
  const { window } = setup();
  check(
    "没有元素全屏时不做任何事",
    window.__wetubeExitElementFullscreen() === false
  );
}

{
  // 处于元素全屏时调用，应该真的去调 exitFullscreen
  const { window } = setup();
  setElementFullscreen(window, {});
  let called = 0;
  window.document.exitFullscreen = () => {
    called++;
    return Promise.resolve();
  };
  const r = window.__wetubeExitElementFullscreen();
  check("有元素全屏时调用 exitFullscreen", called === 1, `调了 ${called} 次`);
  check("返回 true", r === true);
  setElementFullscreen(window, null);
}

{
  // exitFullscreen 抛异常不能冒出去（会打断 Rust 那边的 eval）
  const { window } = setup();
  setElementFullscreen(window, {});
  window.document.exitFullscreen = () => {
    throw new Error("boom");
  };
  let threw = false;
  try {
    window.__wetubeExitElementFullscreen();
  } catch (e) {
    threw = true;
  }
  check("exitFullscreen 抛异常不会冒出去", threw === false);
  setElementFullscreen(window, null);
}

{
  // 只有 webkit 前缀的老实现也要能走通
  const { window } = setup();
  setElementFullscreen(window, {});
  delete window.document.exitFullscreen;
  let called = 0;
  window.document.webkitExitFullscreen = () => {
    called++;
  };
  const r = window.__wetubeExitElementFullscreen();
  check("回退到 webkitExitFullscreen", called === 1 && r === true);
  setElementFullscreen(window, null);
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed++;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
