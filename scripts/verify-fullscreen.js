/*
 * 播放器全屏联动的验证（jsdom）。
 *
 * 覆盖两个方向：
 *   窗口全屏 → 播放器跟着进/退（__wetubeSyncPlayerFullscreen）
 *   播放器全屏 → 上报 Rust 让窗口全屏（fullscreenchange 分支）
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

function setup(bodyHtml) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${bodyHtml}</body></html>`,
    {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    }
  );
  const { window } = dom;
  window.__WETUBE_PLATFORM__ = "macos";
  window.__WETUBE_SHORTCUTS__ = [];
  const sent = [];
  window.ipc = { postMessage: (m) => sent.push(m) };
  window.eval(fs.readFileSync(path.join(SRC, "ui.js"), "utf8"));
  return { window, sent };
}

/** 造一个带全屏按钮的播放页，并返回点击计数器。 */
function withPlayer(window) {
  let clicks = 0;
  window.document
    .querySelector(".ytp-fullscreen-button")
    .addEventListener("click", () => {
      clicks++;
    });
  return () => clicks;
}

/** 假装当前处于（或不在）元素全屏。 */
function setFullscreenElement(window, value) {
  Object.defineProperty(window.document, "fullscreenElement", {
    value,
    configurable: true,
  });
}

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

// 1. 播放页，未全屏 → 要进全屏：应该点按钮
{
  const { window } = setup(`<button class="ytp-fullscreen-button"></button>`);
  const clicks = withPlayer(window);
  const r = window.__wetubeSyncPlayerFullscreen(true);
  check("未全屏时点按钮进入", clicks() === 1, `点了 ${clicks()} 次`);
  check("找到播放器时返回 true", r === true);
}

// 2. 播放页，已经全屏 → 仍要进全屏：不能重复点，否则会直接退出去
{
  const { window } = setup(`<button class="ytp-fullscreen-button"></button>`);
  const clicks = withPlayer(window);
  setFullscreenElement(window, {});
  window.__wetubeSyncPlayerFullscreen(true);
  check("已全屏时不重复点", clicks() === 0, `点了 ${clicks()} 次`);
}

// 3. 播放页，已全屏 → 要退出：应该点按钮
{
  const { window } = setup(`<button class="ytp-fullscreen-button"></button>`);
  const clicks = withPlayer(window);
  setFullscreenElement(window, {});
  window.__wetubeSyncPlayerFullscreen(false);
  check("已全屏时退出会点按钮", clicks() === 1, `点了 ${clicks()} 次`);
}

// 4. 播放页，未全屏 → 要退出：本来就没全屏，不用点
{
  const { window } = setup(`<button class="ytp-fullscreen-button"></button>`);
  const clicks = withPlayer(window);
  window.__wetubeSyncPlayerFullscreen(false);
  check("本来就没全屏时不点", clicks() === 0, `点了 ${clicks()} 次`);
}

// 5. 非播放页（首页）：没有全屏按钮，什么都不做也不能报错
{
  const { window } = setup(`<div>首页内容</div>`);
  const r = window.__wetubeSyncPlayerFullscreen(true);
  check("非播放页返回 false", r === false);
}

// 6. 反向联动不能被破坏：播放器全屏 → 上报 Rust
{
  const { window, sent } = setup(`<button class="ytp-fullscreen-button"></button>`);
  setFullscreenElement(window, {});
  window.document.dispatchEvent(new window.Event("fullscreenchange"));
  check(
    "进入时上报 player-fullscreen:on",
    sent.includes("player-fullscreen:on"),
    JSON.stringify(sent)
  );
}
{
  const { window, sent } = setup(`<button class="ytp-fullscreen-button"></button>`);
  window.document.dispatchEvent(new window.Event("fullscreenchange"));
  check(
    "退出时上报 player-fullscreen:off",
    sent.includes("player-fullscreen:off"),
    JSON.stringify(sent)
  );
}

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed++;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
