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
  /* YouTube 会用 transform 动态收起 masthead，单改 top 会被其定位逻辑抵消。 */
  transform: translateY(calc(${BAR_HEIGHT}px - 16px)) !important;
}
.wetube-support-shift #page-manager {
  /* 保留 YouTube 自己为 masthead 预留的 56px，再追加 WeTube chrome。
   * 只写 BAR_HEIGHT 会覆盖原值，使分类栏和首页卡片挤进搜索栏。 */
  margin-top: calc(var(--ytd-masthead-height, 56px) + ${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-mini-guide-renderer {
  top: calc(56px + ${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-feed-filter-chip-bar-renderer {
  /* 首页分类栏由 YouTube 单独 sticky 定位，不随 #page-manager 的外边距移动。 */
  transform: translateY(${BAR_HEIGHT}px) !important;
}
.wetube-support-shift ytd-rich-grid-renderer > #contents {
  /* 分类栏视觉上下移后也要为视频网格保留同等空间，否则第一排封面会压到标签栏。 */
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

  function syncWideGuide() {
    const wide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
    if (!wide) {
      wasWide = false;
      guideOpenRequested = false;
      return;
    }

    const app = document.querySelector("ytd-app");
    if (app?.hasAttribute("guide-persistent-and-visible")) {
      wasWide = true;
      guideOpenRequested = false;
      return;
    }
    if (guideOpenRequested) return;

    const button = document.querySelector(
      "ytd-masthead #guide-button button, ytd-masthead #guide-button yt-icon-button"
    );
    if (!button) {
      setTimeout(syncWideGuide, 250);
      return;
    }
    guideOpenRequested = true;
    button.click();
    wasWide = true;
  }

  window.addEventListener("resize", () => {
    const wide = window.innerWidth >= WIDE_GUIDE_BREAKPOINT;
    if (wide !== wasWide || (wide && !guideOpenRequested)) {
      setTimeout(syncWideGuide, 100);
    }
  });
  window.addEventListener("yt-navigate-finish", () => setTimeout(syncWideGuide, 100));

  // 监听路由变化，让 SPA 跳转后能保持正确的下移状态。
  window.addEventListener("yt-navigate-finish", () => applyShift(isYouTube()));
  window.addEventListener("popstate", () => applyShift(isYouTube()));
  const _push = history.pushState;
  history.pushState = function () {
    const r = _push.apply(this, arguments);
    setTimeout(() => applyShift(isYouTube()), 0);
    return r;
  };

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
