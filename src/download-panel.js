/*
 * WeTube 下载面板。
 *
 * 与 chrome（titlebar.js）独立：macOS 上没有 HTML 标题栏，下载入口必须
 * 在两个平台都可用，所以自成一体——右下角悬浮球 + 展开面板。
 *
 * 交互流程：
 *   1. 悬浮球（下载图标）点开面板；面板里输入框预填当前页面 URL（自动识别
 *      /watch、/shorts、youtu.be 链接）；
 *   2. 「探测」→ Rust 端 yt-dlp -J → 回填标题 + 格式列表（视频按高度分档、
 *      音频单独一组）；
 *   3. 选一档点「下载」→ 进度条逐行更新（percent/speed/eta）；
 *   4. 完成/失败/取消都有状态行；可同时跑多个任务（面板按任务分卡片）。
 *
 * ⚠️ YouTube 开启 Trusted Types：绝不 innerHTML 赋值，全部 createElement 构建。
 */
(() => {
  if (window.__wetubeDownloadPanel) return;
  window.__wetubeDownloadPanel = true;

  const send = (obj) => {
    try {
      window.ipc.postMessage(JSON.stringify(obj));
    } catch (e) {
      /* ignore */
    }
  };

  /* 任务状态表：id → {el, bar, status, url, title, mode} */
  const tasks = new Map();
  let seq = 0; // 面板本地自增，仅用于探测中转占位

  const STYLE = `
#wetube-dl-fab {
  position: fixed;
  right: 18px; bottom: 18px;
  z-index: 2147483000;
  width: 44px; height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(0,0,0,0.12);
  background: rgba(255,255,255,0.95);
  box-shadow: 0 4px 16px rgba(0,0,0,0.22);
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: #f03;
  transition: transform .15s ease;
}
#wetube-dl-fab:hover { transform: scale(1.06); }
#wetube-dl-fab svg { width: 22px; height: 22px; }

#wetube-dl-panel {
  position: fixed;
  right: 18px; bottom: 72px;
  z-index: 2147483000;
  width: 380px; max-height: 70vh;
  display: none; flex-direction: column;
  background: rgba(252,252,252,0.98);
  color: #111;
  border: 1px solid rgba(0,0,0,0.12);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.24);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}
#wetube-dl-panel.open { display: flex; }
#wetube-dl-panel .dl-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(0,0,0,0.08);
  font-weight: 600;
}
#wetube-dl-panel .dl-head .close {
  border: 0; background: transparent; cursor: pointer;
  font-size: 16px; color: #666; padding: 2px 6px; border-radius: 4px;
}
#wetube-dl-panel .dl-head .close:hover { background: rgba(0,0,0,0.06); }
#wetube-dl-panel .dl-body { overflow-y: auto; padding: 12px 14px; }
#wetube-dl-panel .dl-row { display: flex; gap: 8px; margin-bottom: 10px; }
#wetube-dl-panel .dl-row input {
  flex: 1; padding: 7px 10px;
  border: 1px solid rgba(0,0,0,0.18); border-radius: 6px;
  font: inherit; color: inherit; background: #fff;
}
#wetube-dl-panel .dl-row button {
  padding: 7px 14px;
  border: 1px solid rgba(0,0,0,0.18); border-radius: 6px;
  background: #f6f6f6; cursor: pointer; font: inherit;
}
#wetube-dl-panel .dl-row button:hover { background: #ececec; }
#wetube-dl-panel .dl-task {
  border: 1px solid rgba(0,0,0,0.1);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fff;
}
#wetube-dl-panel .dl-task .t-title {
  font-weight: 600; margin-bottom: 6px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#wetube-dl-panel .dl-task .t-bar {
  height: 6px; border-radius: 3px;
  background: rgba(0,0,0,0.08);
  overflow: hidden; margin: 8px 0 6px;
}
#wetube-dl-panel .dl-task .t-bar > div {
  height: 100%; width: 0%;
  background: #f03;
  transition: width .25s ease;
}
#wetube-dl-panel .dl-task .t-status {
  display: flex; justify-content: space-between; align-items: center;
  color: #666; font-size: 12px;
}
#wetube-dl-panel .dl-task .t-status .t-cancel {
  border: 0; background: transparent; color: #c33;
  cursor: pointer; font-size: 12px; padding: 2px 6px; border-radius: 4px;
}
#wetube-dl-panel .dl-task .t-status .t-cancel:hover { background: rgba(200,40,40,0.08); }
#wetube-dl-panel .dl-task .t-formats { margin-top: 8px; }
#wetube-dl-panel .dl-task .t-formats select {
  width: 100%; padding: 6px 8px;
  border: 1px solid rgba(0,0,0,0.18); border-radius: 6px;
  font: inherit; background: #fff; color: inherit;
  margin-bottom: 8px;
}
#wetube-dl-panel .dl-task .t-formats .t-go {
  width: 100%; padding: 7px 0;
  border: 0; border-radius: 6px;
  background: #f03; color: #fff;
  font-weight: 600; cursor: pointer; font: inherit;
}
#wetube-dl-panel .dl-task .t-formats .t-go:hover { background: #d9029b00; background: #d90229; }
#wetube-dl-panel .dl-task .t-err { color: #c33; font-size: 12px; margin-top: 6px; }
#wetube-dl-panel .dl-task.done .t-bar > div { background: #2e7d32; width: 100% !important; }
#wetube-dl-panel .dl-empty { color: #999; text-align: center; padding: 18px 0; }

@media (prefers-color-scheme: dark) {
  #wetube-dl-fab {
    background: rgba(30,30,30,0.95);
    border-color: rgba(255,255,255,0.14);
    color: #ff4d6a;
  }
  #wetube-dl-panel {
    background: rgba(26,26,26,0.98);
    color: #f1f1f1;
    border-color: rgba(255,255,255,0.14);
  }
  #wetube-dl-panel .dl-head { border-bottom-color: rgba(255,255,255,0.1); }
  #wetube-dl-panel .dl-row input,
  #wetube-dl-panel .dl-task .t-formats select {
    background: #1c1c1c; border-color: rgba(255,255,255,0.2); color: inherit;
  }
  #wetube-dl-panel .dl-row button {
    background: #2a2a2a; border-color: rgba(255,255,255,0.2); color: inherit;
  }
  #wetube-dl-panel .dl-row button:hover { background: #333; }
  #wetube-dl-panel .dl-task { background: #202020; border-color: rgba(255,255,255,0.1); }
  #wetube-dl-panel .dl-task .t-bar { background: rgba(255,255,255,0.1); }
  #wetube-dl-panel .dl-task .t-status { color: #aaa; }
  #wetube-dl-panel .dl-empty { color: #777; }
}
`;

  /* 下载图标（SVG path 手绘，走 createElementNS 规避 Trusted Types） */
  function dlIcon(size) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", size);
    svg.setAttribute("height", size);
    const mk = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      return n;
    };
    svg.appendChild(mk("path", { d: "M12 3v11m0 0 4-4m-4 4-4-4", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    svg.appendChild(mk("path", { d: "M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }));
    return svg;
  }

  /* 从当前地址提取可下载 URL：/watch?v=、/shorts/、youtu.be 都算 */
  function currentVideoUrl() {
    try {
      const u = new URL(location.href);
      if (u.hostname === "youtu.be") return location.href;
      if (u.pathname === "/watch" && u.searchParams.get("v")) return location.href;
      if (u.pathname.startsWith("/shorts/")) return location.href;
    } catch (e) { /* ignore */ }
    return "";
  }

  /* 当前是否为视频播放页。悬浮球只在这些页面出现（需求：其他页面不显示）。 */
  function isVideoPage() {
    return currentVideoUrl() !== "";
  }

  /* 下载功能总开关（设置面板 → 下载 → 下载设置）。默认 true，
   * 没有配置 / 旧配置文件读不到该字段时也当作开启。 */
  function downloadEnabled() {
    try {
      const node = window.__YTE_CONFIG__?.downloadSettings;
      if (!node || node.enabled === undefined) return true;
      return node.enabled === true;
    } catch (e) { return true; }
  }

  function syncFabVisibility() {
    const fab = document.getElementById("wetube-dl-fab");
    if (!fab) return;
    const show = downloadEnabled() && isVideoPage();
    fab.style.display = show ? "flex" : "none";
    // 离开视频页时顺手收起面板，避免下次进来残留旧状态
    if (!show) {
      document.getElementById("wetube-dl-panel")?.classList.remove("open");
    }
  }

  function fmtSize(bytes) {
    if (!bytes || bytes <= 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let v = bytes, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function fmtDuration(sec) {
    if (!sec || sec <= 0) return "";
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
      : `${m}:${String(s).padStart(2, "0")}`;
  }

  function mount() {
    if (document.getElementById("wetube-dl-fab")) return;

    const style = document.createElement("style");
    style.id = "wetube-dl-style";
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    const fab = document.createElement("button");
    fab.id = "wetube-dl-fab";
    fab.title = "下载视频 / 音频";
    fab.appendChild(dlIcon(22));
    fab.addEventListener("click", togglePanel);

    const panel = document.createElement("div");
    panel.id = "wetube-dl-panel";
    const head = document.createElement("div");
    head.className = "dl-head";
    const headTitle = document.createElement("span");
    headTitle.textContent = "下载";
    const closeBtn = document.createElement("button");
    closeBtn.className = "close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => panel.classList.remove("open"));
    head.append(headTitle, closeBtn);

    const body = document.createElement("div");
    body.className = "dl-body";

    /* 顶部：URL 输入 + 探测按钮 */
    const row = document.createElement("div");
    row.className = "dl-row";
    const urlInput = document.createElement("input");
    urlInput.placeholder = "粘贴视频链接…";
    const probeBtn = document.createElement("button");
    probeBtn.textContent = "探测";
    probeBtn.addEventListener("click", () => {
      const url = urlInput.value.trim();
      if (!url) { urlInput.focus(); return; }
      send({ type: "download:probe", url });
      urlInput.value = "";
    });
    // 回车 = 探测
    urlInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") probeBtn.click();
    });
    row.append(urlInput, probeBtn);

    const empty = document.createElement("div");
    empty.className = "dl-empty";
    empty.textContent = "暂无下载任务";

    body.append(row, empty);
    panel.append(head, body);
    (document.body || document.documentElement).append(fab, panel);

    /* 悬浮球上的角标：有活动任务时显示。 */
    const badge = document.createElement("span");
    badge.id = "wetube-dl-badge";
    Object.assign(badge.style, {
      position: "absolute", top: "-2px", right: "-2px",
      minWidth: "16px", height: "16px", borderRadius: "8px",
      background: "#f03", color: "#fff", fontSize: "10px",
      display: "none", alignItems: "center", justifyContent: "center",
      fontWeight: "600", padding: "0 4px",
    });
    fab.style.position = "fixed";
    fab.appendChild(badge);

    function refreshBadge() {
      const active = [...tasks.values()].filter((t) => t.state === "running" || t.state === "probing").length;
      badge.textContent = String(active);
      badge.style.display = active > 0 ? "flex" : "none";
    }
    window.__wetubeDlRefreshBadge = refreshBadge;

    /* 打开面板时预填当前视频链接 */
    function togglePanel() {
      const opening = !panel.classList.contains("open");
      panel.classList.toggle("open");
      if (opening) {
        const cur = currentVideoUrl();
        if (cur && !urlInput.value.trim()) urlInput.value = cur;
        urlInput.focus();
      }
    }

    /* ---- 悬浮球显隐 ----
     * YouTube 是 SPA：监听导航事件 + 初始检查，只在视频播放页显示悬浮球。
     * 捕获阶段监听，跟 enhancer/runtime.js 的做法一致。 */
    window.addEventListener("yt-navigate-finish", syncFabVisibility, true);
    window.addEventListener("popstate", syncFabVisibility, true);
    syncFabVisibility();
  }

  /* 设置面板改了 downloadSettings 配置后由 runtime 通知到这里：总开关
   * 关掉立即隐藏悬浮球，打开则按当前页面类型重新判断。 */
  window.__wetubeDlSyncSettings = syncFabVisibility;

  /* ---- 任务卡片 ---- */

  function ensureEmpty() {
    const empty = document.querySelector("#wetube-dl-panel .dl-empty");
    const body = document.querySelector("#wetube-dl-panel .dl-body");
    if (empty) empty.remove();
    return body;
  }

  function makeCard(key, titleText) {
    const body = ensureEmpty();
    const card = document.createElement("div");
    card.className = "dl-task";

    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = titleText || "正在获取视频信息…";
    title.title = titleText || "";

    const bar = document.createElement("div");
    bar.className = "t-bar";
    const fill = document.createElement("div");
    bar.appendChild(fill);

    const status = document.createElement("div");
    status.className = "t-status";
    const left = document.createElement("span");
    left.textContent = "准备中…";
    const cancel = document.createElement("button");
    cancel.className = "t-cancel";
    cancel.textContent = "取消";
    cancel.style.display = "none";
    status.append(left, cancel);

    const formats = document.createElement("div");
    formats.className = "t-formats";

    card.append(title, bar, status, formats);
    body.prepend(card);

    tasks.set(key, {
      el: card, fill, left, cancel, formats,
      state: "probing", id: 0, title: titleText || "",
    });
    window.__wetubeDlRefreshBadge?.();
    return tasks.get(key);
  }

  function fillFormats(task, info) {
    task.formats.textContent = "";
    const videos = (info.formats || [])
      .filter((f) => f.kind === "video")
      .sort((a, b) => (b.height || 0) - (a.height || 0));
    const audios = (info.formats || [])
      .filter((f) => f.kind === "audio")
      .sort((a, b) => (b.abr || 0) - (a.abr || 0));

    const sel = document.createElement("select");
    // 默认档：最高画质（Rust 端自动选 bestvideo*+bestaudio）
    const best = document.createElement("option");
    best.value = "video:";
    best.textContent = `最高画质${videos[0]?.height ? `（约 ${videos[0].height}p）` : ""}`;
    sel.appendChild(best);
    for (const f of videos.slice(0, 12)) {
      const opt = document.createElement("option");
      opt.value = `video:${f.formatId}`;
      opt.textContent = `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ""} ${f.ext}${f.size ? ` · ${fmtSize(f.size)}` : ""}`;
      sel.appendChild(opt);
    }
    const sep = document.createElement("option");
    sep.disabled = true;
    sep.textContent = "──── 仅音频 ────";
    sel.appendChild(sep);
    const audioBest = document.createElement("option");
    audioBest.value = "audio:";
    audioBest.textContent = `最佳音质${audios[0]?.abr ? `（约 ${Math.round(audios[0].abr)} kbps）` : ""}`;
    sel.appendChild(audioBest);
    for (const f of audios.slice(0, 6)) {
      const opt = document.createElement("option");
      opt.value = `audio:${f.formatId}`;
      opt.textContent = `${Math.round(f.abr || 0)} kbps ${f.ext}${f.size ? ` · ${fmtSize(f.size)}` : ""}`;
      sel.appendChild(opt);
    }

    const go = document.createElement("button");
    go.className = "t-go";
    go.textContent = "下载";
    go.addEventListener("click", () => {
      const [mode, formatId] = sel.value.split(":");
      send({
        type: "download:start",
        url: task.url,
        mode,
        formatId: formatId || "",
      });
      task.formats.textContent = "";
      task.left.textContent = "排队中…";
      task.state = "queued";
      window.__wetubeDlRefreshBadge?.();
    });

    task.formats.append(sel, go);
  }

  /* ---- Rust 事件入口 ---- */

  window.__wetubeDownloadEvent = (event) => {
    if (!event || typeof event !== "object") return;
    switch (event.kind) {
      case "probe-start": {
        const key = `probe:${++seq}`;
        const card = makeCard(key, "");
        card.url = event.url;
        card.left.textContent = "探测中…";
        card._probeKey = key;
        break;
      }
      case "probe-ok": {
        // 找到最近一个仍处于 probing 的任务（探测返回序与发起序一致）
        const entry = [...tasks.entries()].find(([, t]) => t.state === "probing" && t.url === event.url);
        if (!entry) break;
        const [, t] = entry;
        t.state = "ready";
        t.title = event.title || "视频";
        t.el.querySelector(".t-title").textContent = event.title || "视频";
        const dur = fmtDuration(event.duration);
        if (dur) {
          const d = document.createElement("span");
          d.style.fontWeight = "400";
          d.style.color = "#888";
          d.textContent = ` · ${dur}`;
          t.el.querySelector(".t-title").appendChild(d);
        }
        t.left.textContent = "选择格式";
        fillFormats(t, event);
        break;
      }
      case "probe-fail": {
        const entry2 = [...tasks.entries()].find(([, t]) => t.state === "probing" && t.url === event.url);
        if (!entry2) break;
        const [, t] = entry2;
        t.state = "failed";
        t.left.textContent = "";
        const err = document.createElement("div");
        err.className = "t-err";
        err.textContent = event.error || "探测失败";
        t.el.appendChild(err);
        window.__wetubeDlRefreshBadge?.();
        break;
      }
      case "started": {
        // 把最早一个 queued 任务绑定到真实 id
        const entry3 = [...tasks.entries()].find(([, t]) => t.state === "queued");
        if (entry3) {
          const [key, t] = entry3;
          tasks.delete(key);
          t.id = event.id;
          t.state = "running";
          t.cancel.style.display = "";
          t.cancel.onclick = () => send({ type: "download:cancel", id: event.id });
          tasks.set(`task:${event.id}`, t);
        }
        window.__wetubeDlRefreshBadge?.();
        break;
      }
      case "progress": {
        const t = tasks.get(`task:${event.id}`);
        if (!t) break;
        const p = event.progress || {};
        t.fill.style.width = /^\d+$/.test(String(p.percent).replace("%", "").trim())
          ? `${parseInt(p.percent, 10)}%`
          : "50%"; // unknown 时给个中间值动效
        t.left.textContent = `${p.percent || ""}  ${p.speed || ""}${p.eta ? ` · 剩余 ${p.eta}` : ""}`;
        break;
      }
      case "done": {
        const t = tasks.get(`task:${event.id}`);
        if (!t) break;
        t.state = "done";
        t.el.classList.add("done");
        t.fill.style.width = "100%";
        t.left.textContent = event.detail ? `已保存：${event.detail}` : "完成";
        t.cancel.style.display = "none";
        window.__wetubeDlRefreshBadge?.();
        break;
      }
      case "fail": {
        const t = tasks.get(`task:${event.id}`) || (event.id === 0 ? [...tasks.entries()].find(([, t]) => t.state === "queued")?.[1] : null);
        if (!t) break;
        t.state = "failed";
        t.left.textContent = event.detail === "已取消" ? "已取消" : "失败";
        if (event.detail && event.detail !== "已取消") {
          let err = t.el.querySelector(".t-err");
          if (!err) {
            err = document.createElement("div");
            err.className = "t-err";
            t.el.appendChild(err);
          }
          err.textContent = event.detail;
        }
        t.cancel.style.display = "none";
        window.__wetubeDlRefreshBadge?.();
        break;
      }
      case "cancelled": {
        const t = tasks.get(`task:${event.id}`);
        if (t) {
          t.left.textContent = "已取消";
          t.cancel.style.display = "none";
          t.state = "failed";
          window.__wetubeDlRefreshBadge?.();
        }
        break;
      }
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
