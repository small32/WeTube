/*
 * WeTube 全局支持：内容下移 + 键盘快捷键。
 *
 * 工具栏和窗口 chrome 都在 titlebar.js 里渲染，这里不重复创建。
 * 但是仍有以下职责：
 *   - 给 YouTube 页面追加顶部空白，让 masthead / ytd-app 不被 chrome 遮挡
 *   - 接管 webview 内能拦到的浏览器级快捷键（刷新 / 后退 / 前进 / 首页），
 *     转发给 IPC
 *   - 提供切换自定义 chrome 整体显隐的接口 `window.__wetubeToggleChrome`
 */
(() => {
  if (window.__wetubeSupportMounted) return;
  window.__wetubeSupportMounted = true;

  /* 与 src/titlebar.js 里的 BAR_HEIGHT 同步；改一处记得改另一处。 */
  const BAR_HEIGHT = 36;

  /* macOS 上没有自定义 chrome（见 titlebar.js 末尾的平台判断），所以下面给
   * YouTube 内容让出空间的下推逻辑也必须整个关掉，否则顶部会空出一条 36px。 */
  const HAS_CHROME = window.__WETUBE_PLATFORM__ !== "macos";

  const send = (cmd) => {
    try {
      window.ipc.postMessage(cmd);
    } catch (e) {
      /* ipc 不可用时静默忽略 */
    }
  };

  const SUPPORT_STYLE = `
.wetube-support-shift ytd-masthead,
.wetube-support-shift #masthead-container {
  /* 用 top 而不是 transform 下推：YouTube 自己会用 transform 做「向上滑出」
   * 收缩动画（translateY(-100%)），再用 transform 覆盖会和它打架；更重要的是
   * transform 会让内部子元素（含 popup 锚点、命中区）的 getBoundingClientRect
   * 跟着偏移，而 flyout/侧栏子项的点击 hit-test 依赖真实坐标，transform 错位
   * 会导致「订阅 / 我」下面的子菜单点击看似无响应。top 是 fixed 定位的原生属性，
   * 不会影响子元素布局参考。 */
  top: ${BAR_HEIGHT}px !important;
}
.wetube-support-shift #page-manager {
  /* 保留 YouTube 自己为 masthead 预留的 56px，再追加 WeTube chrome。 */
  margin-top: calc(var(--ytd-masthead-height, 56px) + ${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-mini-guide-renderer {
  top: calc(56px + ${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-feed-filter-chip-bar-renderer {
  /* chip-bar 本身不是 fixed，用 transform 下推不会影响其 hit-test，保留。 */
  transform: translateY(${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-rich-grid-renderer > #contents {
  padding-top: ${BAR_HEIGHT}px !important;
}
`;

  /* 窗口全屏时把播放器铺满整个 webview。
   *
   * 为什么需要这个：从菜单 / F11 进全屏时，我们是合成调用，拿不到用户激活
   * （user activation），WebKit 会直接拒绝 requestFullscreen()——包括点
   * YouTube 全屏按钮那条路。所以光靠点按钮不可靠，得有一条不依赖手势的兜底。
   *
   * 只在「窗口全屏 + 没进元素全屏 + 在播放页」三条同时成立时才挂这个 class。
   * 元素全屏成功时浏览器自己会铺满，两套并存会打架。 */
  const FILL_STYLE = `
html.wetube-video-fill, html.wetube-video-fill body {
  overflow: hidden !important;
}
html.wetube-video-fill #movie_player,
html.wetube-video-fill .html5-video-player {
  position: fixed !important;
  top: 0 !important; right: 0 !important; bottom: 0 !important; left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  z-index: 2147483646 !important;
  background: #000 !important;
}
html.wetube-video-fill video {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
}
`;

  const isYouTube = () =>
    /(^|\.)youtube\.com$/.test(location.hostname) ||
    /(^|\.)youtube-nocookie\.com$/.test(location.hostname);

  function mountStyle() {
    if (!HAS_CHROME) return;
    if (document.getElementById("wetube-support-style")) return;
    const style = document.createElement("style");
    style.id = "wetube-support-style";
    style.textContent = SUPPORT_STYLE;
    (document.head || document.documentElement).appendChild(style);
    applyShift(isYouTube());
  }

  /** 铺满用的样式跟 chrome 无关，macOS 上（不渲染 chrome）也要注入。 */
  function mountFillStyle() {
    if (document.getElementById("wetube-video-fill-style")) return;
    const style = document.createElement("style");
    style.id = "wetube-video-fill-style";
    style.textContent = FILL_STYLE;
    (document.head || document.documentElement).appendChild(style);
  }

  function applyShift(on) {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("wetube-support-shift", HAS_CHROME && on);
  }

  /* 最大化/宽屏时使用 YouTube 完整侧栏，普通窗口保留 mini guide。
   * YouTube 会记住用户上次折叠状态，因此单靠 resize 不一定自动展开。 */
  const WIDE_GUIDE_BREAKPOINT = 1350;
  let wasWide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
  let guideOpenRequested = false;
  let lastAutoClick = 0; // 上次自动点击展开按钮的时间戳（冷却用，防侧栏闪烁）

  function syncWideGuide() {
    // 播放页不自动展开侧栏：进 watch 时那一下自动点击会把侧栏撑开又收回去，
    // 看起来像「弹出来一下」。播放页保留 YouTube 自己的状态即可。
    if (location.pathname.startsWith("/watch")) return;

    const wide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
    if (!wide) {
      wasWide = false;
      guideOpenRequested = false;
      return;
    }

    // 已经展开就不管。注意：不能只信 guide-persistent-and-visible 这个
    // attribute——YouTube 设置它有时序延迟，且收起侧栏时未必立刻移除。
    // 用真实布局判断更可靠。
    if (isGuideOpen()) {
      wasWide = true;
      guideOpenRequested = false;
      return;
    }

    const button = document.querySelector(
      "ytd-masthead #guide-button button, ytd-masthead #guide-button yt-icon-button"
    );
    if (!button) {
      // 还没就绪就稍后再试，最多 ~10s，别无限重试。
      if (!syncWideGuide._wait) syncWideGuide._wait = 0;
      syncWideGuide._wait += 1;
      if (syncWideGuide._wait > 40) return;
      setTimeout(syncWideGuide, 250);
      return;
    }
    syncWideGuide._wait = 0;

    // 冷却：点过一次后 2s 内不再自动点。否则 YouTube 展开/收起的 attribute
    // 和布局更新有延迟，检测到「还没展开」就立刻再点一次，会把刚展开的侧栏
    // 又收起来，来回点击 → 侧栏不停出现/退出（播放页导航频繁触发尤其明显）。
    const now = Date.now();
    if (now - lastAutoClick < 2000) return;
    lastAutoClick = now;

    button.click();
    guideOpenRequested = true;
    wasWide = true;
  }

  /** 完整侧栏是否真的可见（宽 > 100px 且有一定高度）。 */
  function isGuideOpen() {
    const app = document.querySelector("ytd-app");
    if (app?.hasAttribute("guide-persistent-and-visible")) return true;
    const guide = document.querySelector("ytd-guide-renderer");
    if (!guide) return false;
    const rect = guide.getBoundingClientRect();
    return rect.width > 100 && rect.height > 100;
  }

  window.addEventListener("resize", () => {
    const wide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
    if (wide !== wasWide || (wide && !guideOpenRequested)) {
      setTimeout(syncWideGuide, 100);
    }
  });
  window.addEventListener("yt-navigate-finish", () => setTimeout(syncWideGuide, 100));

  // 监听路由变化，让 SPA 跳转后能保持正确的下移状态。
  // 注意：不再包装 history.pushState/replaceState——包装会在 YouTube 的关键 SPA
  // 点击时序里插队 setTimeout，与 YouTube 内部「close-flyout → pushState → 重新
  // 渲染侧栏」的步骤产生竞态，导致侧栏（特别是 mini-guide flyout）子项点击后
  // 既不跳转也不响应。yt-navigate-finish + popstate 已经覆盖所有导航场景，
  // applyShift 是幂等的，足够。
  window.addEventListener("yt-navigate-finish", () => applyShift(isYouTube()));
  window.addEventListener("popstate", () => applyShift(isYouTube()));

  const isMac = window.__WETUBE_PLATFORM__ === "macos";

  /**
   * 一次按键 → 快捷键 spec 字符串。
   *
   * `ev.code` 恰好等于 Rust 侧 `Code` 的 Debug 名（`KeyR` / `ArrowLeft` / `F11`），
   * 直接拼就行，两边不用各维护一套键名映射。
   *
   * 挂到 window 上是给快捷键设置面板复用的——它在 ui.js 之后注入。
   */
  function eventToSpec(ev) {
    const parts = [];
    if (isMac) {
      // 顺序必须跟 Rust 侧 shortcuts.rs 的 encode() 一致：Mod, Ctrl, Alt, Shift。
      // 否则面板拿 spec 做字符串比对时会漏判冲突（"Mod+Shift+x" ≠ "Shift+Mod+x"）。
      if (ev.metaKey) parts.push("Mod");
      if (ev.ctrlKey) parts.push("Ctrl");
    } else {
      if (ev.ctrlKey) parts.push("Mod");
      if (ev.metaKey) parts.push("Meta"); // Windows 键，Rust 侧不认
    }
    if (ev.altKey) parts.push("Alt");
    if (ev.shiftKey) parts.push("Shift");
    parts.push(ev.code);
    return parts.join("+");
  }
  window.__wetubeEventToSpec = eventToSpec;

  /** spec → 命令 id。快捷键被改过之后要重算。 */
  let keyMap = new Map();
  function rebuildKeyMap() {
    keyMap = new Map();
    for (const item of window.__WETUBE_SHORTCUTS__ || []) {
      keyMap.set(item.spec, item.id);
    }
  }
  rebuildKeyMap();
  window.addEventListener("wetube:shortcuts-changed", rebuildKeyMap);

  /* 键盘快捷键：webview 会先吃掉绝大多数按键，窗口级快捷键只能在页面内拦。
   *
   * 以前这里是一长串 `ev.key === "r"` 之类的硬编码，改成拿本次按键的 spec 去
   * 注册表反查——用户改了快捷键这里立刻跟着变。
   */
  window.addEventListener(
    "keydown",
    (ev) => {
      // 快捷键设置面板正在等用户按键，这次别当成功能键发出去。
      // 这个监听是捕获阶段注册的、比面板早，只能靠标志位让开。
      if (window.__wetubeCapturingShortcut) return;

      const spec = eventToSpec(ev);
      let id = keyMap.get(spec);

      // 浏览器惯例的别名：F5 刷新、Alt+←/→ 前进后退。
      // 注册表里显式配置过的优先——用户真把 F5 派给别的用途，这里就让位。
      if (!id && ev.code === "F5" && !keyMap.has("F5")) id = "reload";
      if (!id && ev.altKey && ev.code === "ArrowLeft" && !keyMap.has("Alt+ArrowLeft")) id = "back";
      if (!id && ev.altKey && ev.code === "ArrowRight" && !keyMap.has("Alt+ArrowRight")) id = "forward";

      // 按住不放时系统会连发 keydown（ev.repeat）。刷新、后退这类连发还说得过去，
      // 但全屏是开关——连发会把它来回翻转，窗口就"进去又弹出来"。
      if (!id || ev.repeat) return;
      ev.preventDefault();
      send(id);
    },
    true
  );

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mountStyle();
      setTimeout(syncWideGuide, 100);
    }, { once: true });
  } else {
    mountStyle();
    setTimeout(syncWideGuide, 100);
  }
  /* DOMContentLoaded 在 document-start 注入时还没到，体例先监听一次。 */
  document.addEventListener("DOMContentLoaded", () => applyShift(isYouTube()), {
    once: true,
  });
  applyShift(isYouTube());

  // 显隐整个自定义 chrome（菜单按钮 + 工具栏 + 窗口控制）。
  // 全屏播放时由 Rust 侧驱动（见 main.rs 的 sync_fullscreen_chrome），
  // 让出整块屏幕给视频，退出全屏再恢复。
  window.__wetubeSetChromeVisible = (visible) => {
    if (!HAS_CHROME) return;
    const bar = document.getElementById("wetube-chrome");
    if (!bar) return;
    const hidden = bar.style.display === "none";
    const wantHidden = !visible;
    if (hidden === wantHidden) return;
    bar.style.display = wantHidden ? "none" : "";
    applyShift(visible && isYouTube());
  };

  window.__wetubeToggleChrome = () => {
    if (!HAS_CHROME) return false;
    const bar = document.getElementById("wetube-chrome");
    if (!bar) return false;
    window.__wetubeSetChromeVisible(bar.style.display !== "none" ? false : true);
    return bar.style.display !== "none";
  };

  // ---- 全屏联动 ----
  //
  // 目标：窗口全屏和播放器全屏表现一致，三个入口殊途同归——
  //   1. 菜单「切换全屏」
  //   2. 全屏快捷键（默认 F11，可自定义）
  //   3. 播放器自己的全屏按钮
  // 都让视频真正铺满屏幕。
  //
  // 三个入口的实现路径不一样：
  //   入口 3 是真实用户手势，元素全屏（requestFullscreen）能成，由浏览器铺满；
  //   入口 1、2 是 Rust 侧的合成调用，拿不到用户激活，WebKit 会拒绝
  //   requestFullscreen——所以必须有不依赖手势的兜底（CSS 铺满）。

  /** 窗口是否全屏。由 Rust 侧告知，见 __wetubeSyncPlayerFullscreen。 */
  let windowFullscreen = false;

  const elementIsFullscreen = () =>
    Boolean(document.fullscreenElement || document.webkitFullscreenElement);

  const isWatchPage = () =>
    Boolean(
      document.querySelector("#movie_player") ||
        document.querySelector(".html5-video-player")
    );

  /**
   * 决定要不要用 CSS 把播放器铺满。
   *
   * 三条同时成立才铺：窗口全屏、没进元素全屏、在播放页。
   * 第二条是关键——元素全屏已经成功时浏览器自己会铺满，再糊一层会打架。
   */
  let fillTimer = null;

  /** 把页面这边的状态回传给 Rust 打日志。只在 WETUBE_DEBUG=1 时真的发。 */
  function report(msg) {
    if (!window.__WETUBE_DEBUG__) return;
    try {
      window.ipc.postMessage(JSON.stringify({ type: "debug", msg }));
    } catch (e) {
      /* 忽略 */
    }
  }

  function refreshVideoFill() {
    const on = windowFullscreen && !elementIsFullscreen() && isWatchPage();
    if (on) {
      // ⚠️ 注入的 <style> 会被导航冲掉（YouTube 切页会换 document）。
      // 挂着 class 却没有样式 = 什么都没发生，所以每次用之前先补一次。
      mountFillStyle();
    }
    document.documentElement.classList.toggle("wetube-video-fill", on);
    report(
      `铺满=${on} (窗口全屏=${windowFullscreen}, 元素全屏=${elementIsFullscreen()}, ` +
        `播放页=${isWatchPage()}, 样式在=${Boolean(
          document.getElementById("wetube-video-fill-style")
        )})`
    );
  }

  /**
   * 已经发出、但还没等到 fullscreenchange 的那次点击的目标状态。
   * `null` 表示没有待确认的点击。见 __wetubeSyncPlayerFullscreen 里的去重。
   */
  let pendingClick = null;

  const syncPlayerFullscreen = () => {
    pendingClick = null; // 结果到了，解除去重闸
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if (!fsEl) {
      // 退出元素全屏 → 窗口全屏紧接着也会退（Rust 收到 off 就退）。
      // 这里先本地置 false，否则这一瞬间会被判成「窗口全屏 + 非元素全屏」
      // 从而糊上一层 CSS，画面闪一下。
      windowFullscreen = false;
    }
    send(fsEl ? "player-fullscreen:on" : "player-fullscreen:off");
    refreshVideoFill();
  };
  document.addEventListener("fullscreenchange", syncPlayerFullscreen, true);
  document.addEventListener("webkitfullscreenchange", syncPlayerFullscreen, true);
  window.addEventListener("yt-navigate-finish", refreshVideoFill);

  /**
   * 窗口全屏状态变化时由 Rust 调用（菜单 / F11 / 自定义快捷键、以及 Esc 和
   * 绿色按钮这类系统退出路径）。
   */
  window.__wetubeSyncPlayerFullscreen = (wantFull) => {
    windowFullscreen = Boolean(wantFull);

    // 先试原生：点 YouTube 自己的全屏按钮，控制栏、双击退出、Esc 退出这些
    // 行为都能保留。成了最好，不成也无所谓——下面有兜底。
    const btn = document.querySelector(".ytp-fullscreen-button");
    if (btn && elementIsFullscreen() !== windowFullscreen && pendingClick !== windowFullscreen) {
      // ⚠️ Rust 侧会连着调两次：act("fullscreen") 一次，紧跟着 Resized 又一次。
      // 不加这道闸就会连点两下，第一下刚进的全屏被第二下取消掉。
      // 用「待确认的目标状态」而不是时间冷却——目标变了（进→退）仍然要能点。
      pendingClick = windowFullscreen;
      btn.click();
    }

    // 立刻按当前状态刷新，不等：原生成了就撤 CSS，没成就马上铺满。
    // 早先这里先等 400ms 再判定，那段时间窗口已经全屏、页面还是正常布局，
    // 看上去就是「全屏了但视频下面还挂着订阅栏和接下来播放」。
    refreshVideoFill();
    // 原生的 requestFullscreen 是异步的，落地时间不定，稍后再复核一次
    clearTimeout(fillTimer);
    fillTimer = setTimeout(refreshVideoFill, 400);

    return isWatchPage();
  };

  mountFillStyle();
})();
