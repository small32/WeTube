/*
 * MacTube — 注入到每一个页面的脚本。
 *
 * 由 wry 的 `with_initialization_script` 在文档创建时注入（相当于 document-start），
 * 因此这里不能假设 body 已经存在。
 */
(() => {
  if (window.__wetubeInjected) return;
  window.__wetubeInjected = true;

  const BAR_HEIGHT = 40;

  const send = (cmd) => {
    try {
      window.ipc.postMessage(cmd);
    } catch (e) {
      /* ipc 不可用时静默忽略 */
    }
  };

  const ICONS = {
    back:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M15 5 L8 12 L15 19" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></svg>',
    forward:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M9 5 L16 12 L9 19" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></svg>',
    reload:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round"/>' +
      '<path d="M20.5 3.5v5h-5" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"/></svg>',
    home:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M4 11.2 12 4.5l8 6.7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"' +
      ' fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
    external:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M14 4h6v6" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M20 4 11 13" fill="none" stroke="currentColor" stroke-width="2"' +
      ' stroke-linecap="round"/>' +
      '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"' +
      ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    settings:
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
      '<path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1' +
      'M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1" fill="none" stroke="currentColor"' +
      ' stroke-width="2" stroke-linecap="round"/></svg>',
  };

  const STYLE = `
#wetube-bar {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: ${BAR_HEIGHT}px;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 8px;
  box-sizing: border-box;
  font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #0f0f0f;
  background: rgba(255, 255, 255, 0.86);
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  backdrop-filter: saturate(180%) blur(14px);
  -webkit-backdrop-filter: saturate(180%) blur(14px);
  user-select: none;
  -webkit-user-select: none;
}
#wetube-bar button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  transition: background-color 120ms ease;
}
#wetube-bar button:hover { background: rgba(0, 0, 0, 0.08); }
#wetube-bar button:active { background: rgba(0, 0, 0, 0.14); }
#wetube-bar button:disabled { opacity: 0.35; cursor: default; background: transparent; }
#wetube-brand {
  margin: 0 8px;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
  opacity: 0.85;
}
#wetube-spacer { flex: 1 1 auto; }
#wetube-bar .mt-sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: rgba(128, 128, 128, 0.35);
}
@media (prefers-color-scheme: dark) {
  #wetube-bar {
    color: #f1f1f1;
    background: rgba(24, 24, 24, 0.86);
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }
  #wetube-bar button:hover { background: rgba(255, 255, 255, 0.12); }
  #wetube-bar button:active { background: rgba(255, 255, 255, 0.2); }
}
html.wetube-shift ytd-app { margin-top: ${BAR_HEIGHT}px !important; }
html.wetube-shift #masthead-container,
html.wetube-shift ytd-masthead { top: ${BAR_HEIGHT}px !important; }
html.wetube-shift #page-manager { margin-top: ${BAR_HEIGHT}px !important; }
`;

  const isYouTube = () =>
    /(^|\.)youtube\.com$/.test(location.hostname) ||
    /(^|\.)youtube-nocookie\.com$/.test(location.hostname);

  const applyShift = (on) => {
    document.documentElement.classList.toggle("wetube-shift", on);
  };

  function mount() {
    if (document.getElementById("wetube-bar")) return;

    const style = document.createElement("style");
    style.id = "wetube-style";
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    const bar = document.createElement("div");
    bar.id = "wetube-bar";
    bar.innerHTML = [
      `<button data-cmd="back" title="后退" aria-label="后退">${ICONS.back}</button>`,
      `<button data-cmd="forward" title="前进" aria-label="前进">${ICONS.forward}</button>`,
      `<button data-cmd="reload" title="刷新" aria-label="刷新">${ICONS.reload}</button>`,
      `<button data-cmd="home" title="回到首页" aria-label="回到首页">${ICONS.home}</button>`,
      `<div class="mt-sep"></div>`,
      `<span id="wetube-brand" title="回到 youtube.com">WeTube</span>`,
      `<div id="wetube-spacer"></div>`,
      `<button data-cmd="open-external" title="在系统浏览器中打开" aria-label="在系统浏览器中打开">${ICONS.external}</button>`,
      `<button data-cmd="settings" title="增强设置" aria-label="增强设置">${ICONS.settings}</button>`,
    ].join("");

    bar.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest("button[data-cmd]");
      if (btn) {
        const cmd = btn.getAttribute("data-cmd");
        // 设置面板就在页面里，不用绕回 Rust
        if (cmd === "settings") {
          if (window.__YTE && window.__YTE.togglePanel) window.__YTE.togglePanel();
          return;
        }
        send(cmd);
        return;
      }
      if (ev.target && ev.target.id === "wetube-brand") send("home");
    });

    (document.body || document.documentElement).appendChild(bar);
    applyShift(isYouTube());

    // 后退/前进按钮的可用状态：SPA 里 history.length 不精确，只在明显可判断时禁用。
    const back = bar.querySelector('[data-cmd="back"]');
    if (back && history.length <= 1) back.disabled = true;
  }

  // 供菜单调用：显隐工具栏
  window.__wetubeToggleBar = () => {
    const bar = document.getElementById("wetube-bar");
    if (!bar) return false;
    const hidden = bar.style.display === "none";
    bar.style.display = hidden ? "" : "none";
    applyShift(!hidden && isYouTube());
    return hidden;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }

  // 键盘快捷键：webview 会先吃掉绝大多数按键，窗口级快捷键只能在页面内拦。
  window.addEventListener(
    "keydown",
    (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if (!mod && ev.key !== "F5") return;

      if (mod && !ev.shiftKey && !ev.altKey && (ev.key === "r" || ev.key === "R")) {
        ev.preventDefault();
        send("reload");
        return;
      }
      if (ev.key === "F5") {
        ev.preventDefault();
        send(ev.shiftKey ? "reload" : "reload");
        return;
      }
      if ((mod || ev.altKey) && ev.key === "ArrowLeft") {
        ev.preventDefault();
        send("back");
        return;
      }
      if ((mod || ev.altKey) && ev.key === "ArrowRight") {
        ev.preventDefault();
        send("forward");
        return;
      }
      if (mod && ev.shiftKey && (ev.key === "h" || ev.key === "H")) {
        ev.preventDefault();
        send("home");
        return;
      }
      if (mod && ev.shiftKey && (ev.key === "b" || ev.key === "B")) {
        ev.preventDefault();
        send("toggle-toolbar");
      }
    },
    true
  );
})();
