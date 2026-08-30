/*
 * 播放器全屏联动的验证（jsdom）。
 *
 * 覆盖三个入口都能全屏：
 *   1. 菜单「切换全屏」
 *   2. 全屏快捷键（F11 / 自定义）
 *   3. 播放器自己的全屏按钮
 *
 * 入口 3 是真实手势，元素全屏能成；入口 1、2 是 Rust 侧合成调用，拿不到用户
 * 激活，requestFullscreen 会被拒绝——所以要有 CSS 铺满兜底。这里两条路都测。
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

/** 播放页骨架：播放器容器 + 全屏按钮 + 一个 video。 */
const WATCH_PAGE = `
  <div id="movie_player" class="html5-video-player">
    <video></video>
  </div>
  <button class="ytp-fullscreen-button"></button>
`;
const HOME_PAGE = `<div>首页内容</div>`;

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

/** 造一个播放页，返回点击次数读取器。 */
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
function setElementFullscreen(window, value) {
  Object.defineProperty(window.document, "fullscreenElement", {
    value,
    configurable: true,
  });
}

const hasFill = (window) =>
  window.document.documentElement.classList.contains("wetube-video-fill");

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 1. 播放页，未全屏 → 要进全屏：先试原生，点按钮
  {
    const { window } = setup(WATCH_PAGE);
    const clicks = withPlayer(window);
    const r = window.__wetubeSyncPlayerFullscreen(true);
    check("未全屏时尝试点原生按钮", clicks() === 1, `点了 ${clicks()} 次`);
    check("播放页返回 true", r === true);
  }

  // 2. 播放页，已在元素全屏 → 要进全屏：不能重复点（否则直接退出去）
  {
    const { window } = setup(WATCH_PAGE);
    const clicks = withPlayer(window);
    setElementFullscreen(window, {});
    window.__wetubeSyncPlayerFullscreen(true);
    check("已元素全屏时不重复点", clicks() === 0, `点了 ${clicks()} 次`);
  }

  // 3. 播放页，已全屏 → 要退出：点按钮
  {
    const { window } = setup(WATCH_PAGE);
    const clicks = withPlayer(window);
    setElementFullscreen(window, {});
    window.__wetubeSyncPlayerFullscreen(false);
    check("已全屏时退出会点按钮", clicks() === 1, `点了 ${clicks()} 次`);
  }

  // 4. 兜底路径：原生没成（WebKit 拒绝合成调用）→ 上 CSS 铺满
  {
    const { window } = setup(WATCH_PAGE);
    withPlayer(window); // 按钮存在，但点了不会真的进元素全屏（jsdom 里没有实现）
    window.__wetubeSyncPlayerFullscreen(true);
    await sleep(600); // 等过 400ms 的兜底判定
    check("原生失败时兜底铺满", hasFill(window) === true);
  }

  // 5. 原生成功时不能再叠一层 CSS，否则两套打架
  {
    const { window } = setup(WATCH_PAGE);
    withPlayer(window);
    setElementFullscreen(window, {});
    window.__wetubeSyncPlayerFullscreen(true);
    await sleep(600);
    check("元素全屏成功时不叠 CSS", hasFill(window) === false);
  }

  // 6. 退出全屏要撤掉铺满
  {
    const { window } = setup(WATCH_PAGE);
    withPlayer(window);
    window.__wetubeSyncPlayerFullscreen(true);
    await sleep(600);
    check("先进入铺满", hasFill(window) === true);
    window.__wetubeSyncPlayerFullscreen(false);
    check("退出后撤掉铺满", hasFill(window) === false);
  }

  // 7. 非播放页：不铺满，也不报错
  {
    const { window } = setup(HOME_PAGE);
    const r = window.__wetubeSyncPlayerFullscreen(true);
    await sleep(600);
    check("非播放页返回 false", r === false);
    check("非播放页不铺满", hasFill(window) === false);
  }

  // 8. 反向联动：播放器全屏 → 上报 Rust
  {
    const { window, sent } = setup(WATCH_PAGE);
    setElementFullscreen(window, {});
    window.document.dispatchEvent(new window.Event("fullscreenchange"));
    check(
      "进入时上报 player-fullscreen:on",
      sent.includes("player-fullscreen:on"),
      JSON.stringify(sent)
    );
  }
  {
    const { window, sent } = setup(WATCH_PAGE);
    window.document.dispatchEvent(new window.Event("fullscreenchange"));
    check(
      "退出时上报 player-fullscreen:off",
      sent.includes("player-fullscreen:off"),
      JSON.stringify(sent)
    );
  }

  // 9. 退出元素全屏的那一瞬间不能闪一下 CSS 铺满
  {
    const { window } = setup(WATCH_PAGE);
    withPlayer(window);
    window.__wetubeSyncPlayerFullscreen(true);
    await sleep(600);
    setElementFullscreen(window, {}); // 模拟用户点了播放器全屏，原生成了
    window.document.dispatchEvent(new window.Event("fullscreenchange"));
    setElementFullscreen(window, null); // 再退出
    window.document.dispatchEvent(new window.Event("fullscreenchange"));
    check("退出元素全屏时不闪 CSS", hasFill(window) === false);
  }

  // 10. Rust 会连调两次（act 一次 + 紧跟着的 Resized 一次），只能点一次
  {
    const { window } = setup(WATCH_PAGE);
    const clicks = withPlayer(window);
    window.__wetubeSyncPlayerFullscreen(true);
    window.__wetubeSyncPlayerFullscreen(true); // 去重闸应该拦掉这次
    check("同目标重复调用只点一次", clicks() === 1, `点了 ${clicks()} 次`);
  }

  // 11. 目标变了（已进全屏 → 要退出）时不能被去重闸误伤
  {
    const { window } = setup(WATCH_PAGE);
    const clicks = withPlayer(window);
    window.__wetubeSyncPlayerFullscreen(true);
    // 补上真实浏览器里会发生的事：点击生效、元素进入全屏、事件回来解除去重闸
    setElementFullscreen(window, {});
    window.document.dispatchEvent(new window.Event("fullscreenchange"));
    window.__wetubeSyncPlayerFullscreen(false);
    check("目标变化时仍然会点", clicks() === 2, `点了 ${clicks()} 次`);
    setElementFullscreen(window, null);
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
    if (!ok) failed++;
  }
  console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
  process.exit(failed === 0 ? 0 : 1);
})();
