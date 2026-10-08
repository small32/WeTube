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

/* ---- 3. 排队中的任务也算"有活"（E8） ---- */
{
  const { window } = setup("https://www.youtube.com/");
  const fab = window.document.getElementById("wetube-dl-fab");
  const badge = window.document.getElementById("wetube-dl-badge");
  const visible = () => fab.style.display === "flex";
  const nav = () => window.dispatchEvent(new window.Event("yt-navigate-finish"));

  window.history.pushState({}, "", "/watch?v=aaaaaaaaaaa");
  nav();

  // 探测 → 点「下载」→ 卡片进入 queued（Rust 侧并发闸门满了就在这儿等）
  window.__wetubeDownloadEvent({ kind: "probe-start", url: "https://x/1" });
  window.__wetubeDownloadEvent({
    kind: "probe-ok", url: "https://x/1", title: "T", duration: 61,
    formats: [
      { kind: "video", formatId: "137", height: 1080, ext: "mp4", size: 1024 },
      { kind: "audio", formatId: "140", abr: 128, ext: "m4a", size: 128 },
    ],
  });
  const go = window.document.querySelector("#wetube-dl-panel .t-go");
  check("探测完成后出现下载按钮", Boolean(go), `go=${go && go.tagName}`);
  go.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

  window.history.pushState({}, "", "/");
  nav();
  check("排队中的任务离开视频页仍显示悬浮球", visible(), `display=${fab.style.display}`);
  check(
    "排队中的任务计入角标",
    badge.textContent === "1",
    `badge=${badge.textContent} display=${badge.style.display}`
  );

  // 两个 started 的跑完、排队者还没收到 started 时，计数不能归零
  window.__wetubeDownloadEvent({ kind: "started", id: 1, requestId: "r1", title: "T", url: "https://x/1" });
  const badgeAfterStart = badge.textContent;
  window.__wetubeDownloadEvent({ kind: "done", id: 1, detail: "a.mp4" });
  window.__wetubeDownloadEvent({ kind: "started", id: 2, requestId: "r2", title: "T", url: "https://x/1" });
  window.__wetubeDownloadEvent({ kind: "done", id: 2, detail: "b.mp4" });
  check(
    "先跑的任务完成后排队者仍在计数内（不闪）",
    badgeAfterStart !== "0" && badge.textContent === "1",
    `before=${badgeAfterStart} after=${badge.textContent}`
  );
}

/* ---- 4. 终态卡片上限：pruneFinished 的 >40 裁剪分支 ---- */
{
  const { window } = setup("https://www.youtube.com/watch?v=aaaaaaaaaaa");
  // 以前这个分支从没被跑到过：脚本最多只放两三张终态卡，
  // "卡片只增不减"的回归就全落在 DOM 里没人管。
  for (let i = 1; i <= 60; i += 1) {
    window.__wetubeDownloadEvent({ kind: "started", id: i, requestId: `r${i}`, title: `T${i}`, url: "U" });
    window.__wetubeDownloadEvent({ kind: "done", id: i, detail: `f${i}.mp4` });
  }
  const cards = [...window.document.querySelectorAll("#wetube-dl-panel .dl-task")];
  check("终态卡片裁剪到 40 张以内", cards.length === 40, `cards=${cards.length}`);
  const titles = cards.map((c) => c.querySelector(".t-title").textContent);
  check("裁剪的是最老的，最新一张还在", titles.includes("T60"), `first=${titles[0]} last=${titles.at(-1)}`);
  check("最老的一张已被移除", !titles.includes("T1"), `first=${titles[0]}`);
  check(
    "所有卡片都带 done 标记（没有卡在中间态）",
    cards.every((c) => c.classList.contains("done")),
    cards.filter((c) => !c.classList.contains("done")).length + " 张没标记"
  );
}

/* ---- 输出 ---- */
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed += 1;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
