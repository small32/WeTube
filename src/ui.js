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

  const isYouTube = () =>
    /(^|\.)youtube\.com$/.test(location.hostname) ||
    /(^|\.)youtube-nocookie\.com$/.test(location.hostname);

  function mountStyle() {
    if (document.getElementById("wetube-support-style")) return;
    const style = document.createElement("style");
    style.id = "wetube-support-style";
    style.textContent = SUPPORT_STYLE;
    (document.head || document.documentElement).appendChild(style);
    applyShift(isYouTube());
  }

  function applyShift(on) {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("wetube-support-shift", on);
  }

  /* 最大化/宽屏时使用 YouTube 完整侧栏，普通窗口保留 mini guide。
   * YouTube 会记住用户上次折叠状态，因此单靠 resize 不一定自动展开。 */
  const WIDE_GUIDE_BREAKPOINT = 1350;
  let wasWide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
  let guideOpenRequested = false;
  let lastAutoClick = 0; // 上次自动点击展开按钮的时间戳（冷却用，防侧栏闪烁）

  function syncWideGuide() {
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

  /* 键盘快捷键：webview 会先吃掉绝大多数按键，窗口级快捷键只能在页面内拦。 */
  window.addEventListener(
    "keydown",
    (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod && ev.key !== "F5" && ev.key !== "F11") return;

      if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "r" || ev.key === "R")) {
        ev.preventDefault();
        send("reload");
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        send("reload");
        return;
      }
      if (mod && ev.key === "ArrowLeft" || ev.altKey && ev.key === "ArrowLeft") {
        ev.preventDefault();
        send("back");
        return;
      }
      if (mod && ev.key === "ArrowRight" || ev.altKey && ev.key === "ArrowRight") {
        ev.preventDefault();
        send("forward");
        return;
      }
      if (mod && ev.shiftKey && (ev.key === "h" || ev.key === "H")) {
        ev.preventDefault();
        send("home");
        return;
      }
      if (mod && ev.shiftKey && (ev.key === "o" || ev.key === "O")) {
        ev.preventDefault();
        send("open-external");
        return;
      }
      if (ev.key === "F11") {
        ev.preventDefault();
        send("fullscreen");
        return;
      }
      if (mod && ev.key === ",") {
        ev.preventDefault();
        send("settings");
        return;
      }
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

  // 显隐整个自定义 chrome（菜单按钮 + 工具栏 + 窗口控制）
  window.__wetubeToggleChrome = () => {
    const bar = document.getElementById("wetube-chrome");
    if (!bar) return false;
    const hidden = bar.style.display === "none";
    bar.style.display = hidden ? "" : "none";
    // 重设下移偏移
    document.documentElement.style.setProperty(
      "--wetube-bar-height",
      hidden ? BAR_HEIGHT + "px" : "0px"
    );
    applyShift(hidden && isYouTube());
    return hidden;
  };
})();
