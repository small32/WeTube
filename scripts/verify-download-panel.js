/*
 * 下载面板的行为回归（jsdom）。
 *
 *   1. 悬浮球只在视频播放页出现，**任务做完后离开视频页必须收起来**。
 *      旧实现用 `tasks.size > 0` 判断，而完成/失败的卡片从不从 tasks 里删除，
 *      于是 tasks.size 一旦 >0 就永远 >0，悬浮球出现过一次就再也隐藏不了。
 *   2. URL 预填要跟随 SPA 切视频。
 *      旧实现只在「输入框为空」时填一次，切视频后输入框里还是上一支视频的链接，
 *      点「探测」会拿到完全不相干的文件。
 *
 * 用法：
 *   npm install
 *   node scripts/verify-download-panel.js
 *
 * 退出码 0 = 全部通过，1 = 有失败项。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = process.env.WETUBE_SRC || path.join(__dirname, "..", "src");

const checks = [];
const check = (name, ok, detail) => { checks.push([name, ok, detail]); };

function setup(startUrl) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    url: startUrl,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const sent = [];
  window.__YTE_CONFIG__ = { downloadSettings: { enabled: true } };
  window.ipc = { postMessage: (msg) => sent.push(msg) };
  window.eval(fs.readFileSync(path.join(SRC, "download-panel.js"), "utf8"));
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return { window, sent };
}

/* ---- 1. 悬浮球显隐 ---- */
{
  const { window } = setup("https://www.youtube.com/");
  const fab = window.document.getElementById("wetube-dl-fab");
  const visible = () => fab.style.display === "flex";
  const nav = () => window.dispatchEvent(new window.Event("yt-navigate-finish"));

  check("首页不显示悬浮球", !visible(), `display=${fab.style.display}`);

  window.history.pushState({}, "", "/watch?v=aaaaaaaaaaa");
  nav();
  check("进视频页显示悬浮球", visible(), `display=${fab.style.display}`);

  // 有进行中的任务时，离开视频页也得留着——用户要看进度
  window.__wetubeDownloadEvent({ kind: "started", id: 7, requestId: "r7", title: "T", url: "U" });
  window.history.pushState({}, "", "/");
  nav();
  check("有进行中任务时离开视频页仍显示", visible(), `display=${fab.style.display}`);

  // 任务结束后再离开，就该收起（这一条就是修复点）
  window.__wetubeDownloadEvent({ kind: "done", id: 7, detail: "saved.mp4" });
  nav();
  check("任务结束后离开视频页应隐藏悬浮球", !visible(), `display=${fab.style.display}`);
}

/* ---- 2. URL 预填跟随切视频 ---- */
{
  const { window } = setup("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  const fab = window.document.getElementById("wetube-dl-fab");
  const panel = window.document.getElementById("wetube-dl-panel");
  const input = window.document.querySelector('input[placeholder="粘贴视频链接…"]');
  const nav = () => window.dispatchEvent(new window.Event("yt-navigate-finish"));

  fab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  check(
    "打开面板后预填当前视频",
    panel.classList.contains("open") && input.value === "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    `open=${panel.classList.contains("open")} value=${input.value}`
  );

  window.history.pushState({}, "", "/watch?v=bbbbbbbbbbb");
  nav();
  check(
    "切视频后预填跟着更新",
    input.value === "https://www.youtube.com/watch?v=bbbbbbbbbbb",
    `value=${input.value}`
  );

  input.value = "https://example.com/custom";
  window.history.pushState({}, "", "/watch?v=ccccccccccc");
  nav();
  check("用户手输的链接不被覆盖", input.value === "https://example.com/custom", `value=${input.value}`);
}

/* ---- 输出 ---- */
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed += 1;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
