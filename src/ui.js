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
#wetube-support-shift ytd-app,
#wetube-support-shift ytd-masthead,
#wetube-support-shift #page-manager,
#wetube-support-shift #masthead-container,
#wetube-support-shift #header,
#wetube-support-shift #container.ytd-searchbox,
#wetube-support-shift div#top { margin-top: ${BAR_HEIGHT}px !important; }
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
    document.addEventListener("DOMContentLoaded", mountStyle, { once: true });
  } else {
    mountStyle();
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
