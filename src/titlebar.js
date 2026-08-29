/*
 * WeTube 自定义窗口 chrome。
 *
 * 由 wry 的 `with_initialization_script` 在文档创建时注入（document-start），
 * 与 ui.js 一起渲染浮在页面上方的窗口标题栏 + 菜单下拉 + 窗口控制按钮。
 *
 * 设计目标：
 *   - 单行布局：左侧 logo + 应用名，中部菜单下拉 + 工具按钮，右侧窗口控制
 *     （最大化/最小化/关闭）
 *   - 大块区域在 Windows 上通过 IPC 交给系统拖动（WebView2 不支持
 *     `-webkit-app-region: drag`），macOS 走原生标题栏。
 *   - 完全跨平台。Rust 端用 `with_decorations(false)` 去掉原生标题栏
 *     （macOS 不去掉），HTML chrome 负责接管一切。
 *   - 菜单下拉用纯 HTML/CSS 弹层实现；点击菜单项发送 IPC 字符串，
 *     与原生菜单共用 `act()` dispatch 路径。
 *
 * ⚠️ 重要：YouTube 开启了 Trusted Types，innerHTML 与 DOMParser 全是被管控的 sink，
 *    直接赋值/解析 SVG 或 HTML 字符串都会被拒。所以图标一律用 createElementNS
 *    在 SVG 命名空间里逐个节点构建，其他内容用 createElement / textContent / appendChild，
 *    绝不给 innerHTML 赋裸字符串，否则 mount 会直接抛错。
 */
(() => {
  if (window.__wetubeChromeMounted) return;
  window.__wetubeChromeMounted = true;

  const BAR_HEIGHT = 36;
  const send = (cmd) => {
    try {
      window.ipc.postMessage(cmd);
    } catch (e) {
      /* ipc 不可用时静默忽略 */
    }
  };

  /* YouTube 开启了 Trusted Types：innerHTML 和 DOMParser 全是受控 sink，
   * 直接赋值/解析 HTML 或 SVG 字符串都会被拒。所以图标一律用 createElementNS
   * 在 SVG 命名空间里逐个节点构建——这是唯一不受 Trusted Types 限制的方式。 */
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(size) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("aria-hidden", "true");
    return svg;
  }
  function svgShape(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    return node;
  }
  /* 图标形状描述：tag + 属性。 */
  const ICON_SHAPES = {
    logo: [
      { t: "rect", a: { x: 2, y: 5, width: 20, height: 14, rx: 3.5, fill: "#ff0033" } },
      { t: "path", a: { d: "M10.2 9.4 16 12l-5.8 2.6z", fill: "#fff" } },
    ],
    minimize: [
      { t: "rect", a: { x: 4, y: 11, width: 16, height: 2, rx: 0.5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 } },
    ],
    maximize: [
      { t: "rect", a: { x: 5, y: 5, width: 14, height: 14, rx: 1.5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 } },
    ],
    restore: [
      { t: "rect", a: { x: 7, y: 7, width: 12, height: 12, rx: 1.5, fill: "none", stroke: "currentColor", "stroke-width": 1.6 } },
      { t: "path", a: { d: "M9 7V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-2", fill: "none", stroke: "currentColor", "stroke-width": 1.6 } },
    ],
    close: [
      { t: "path", a: { d: "M6 6l12 12M18 6 6 18", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round" } },
    ],
  };
  function buildIcon(name, size) {
    const svg = svgEl(size);
    for (const s of ICON_SHAPES[name] || []) svg.appendChild(svgShape(s.t, s.a));
    return svg;
  }
  /* 工具按钮图标（与上面同一套形状描述）。 */
  const TOOLBAR_ICONS = {
    back: [{ t: "path", a: { d: "M15 5 L8 12 L15 19", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" } }],
    forward: [{ t: "path", a: { d: "M9 5 L16 12 L9 19", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" } }],
    reload: [
      { t: "path", a: { d: "M20.5 12a8.5 8.5 0 1 1-2.49-6.01", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" } },
      { t: "path", a: { d: "M20.5 3.5v5h-5", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" } },
    ],
    home: [{ t: "path", a: { d: "M4 11.2 12 4.5l8 6.7V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linejoin": "round" } }],
  };
  function buildToolbarIcon(id, size) {
    const svg = svgEl(size);
    for (const s of TOOLBAR_ICONS[id] || []) svg.appendChild(svgShape(s.t, s.a));
    return svg;
  }

  /* 菜单结构定义：label + items[]。点击项发 IPC；空对象 {} 表示分隔线。 */
  const MENUS = [
    {
      label: "文件",
      items: [
        { id: "home", label: "回到首页", shortcut: "Ctrl+Shift+H" },
        { id: "open-external", label: "在系统浏览器中打开", shortcut: "Ctrl+Shift+O" },
        { sep: true },
        { id: "window-close", label: "退出" },
      ],
    },
    {
      label: "导航",
      items: [
        { id: "back", label: "后退", shortcut: "Alt+←" },
        { id: "forward", label: "前进", shortcut: "Alt+→" },
        { id: "reload", label: "刷新", shortcut: "Ctrl+R" },
        { sep: true },
        { id: "home", label: "主页" },
      ],
    },
    {
      label: "视图",
      items: [
        { id: "settings", label: "增强设置…", shortcut: "Ctrl+," },
        { sep: true },
        { id: "fullscreen", label: "切换全屏", shortcut: "F11" },
      ],
    },
    {
      label: "帮助",
      items: [{ id: "project", label: "项目主页", shortcut: "" }],
    },
  ];

  /* 工具按钮：命令 + 标题；图标形状见 TOOLBAR_ICONS。 */
  const TOOLBAR_BTNS = [
    { id: "back", title: "后退" },
    { id: "forward", title: "前进" },
    { id: "reload", title: "刷新" },
    { id: "home", title: "首页" },
  ];

  const STYLE = `
#wetube-chrome {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: ${BAR_HEIGHT}px;
  z-index: 2147483647;
  display: flex;
  align-items: stretch;
  font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: #0f0f0f;
  background: rgba(255, 255, 255, 0.86);
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  backdrop-filter: saturate(180%) blur(14px);
  -webkit-backdrop-filter: saturate(180%) blur(14px);
  user-select: none;
  -webkit-user-select: none;
}
#wetube-chrome button,
#wetube-chrome .wetube-menu-trigger {
  -webkit-app-region: no-drag;
}
#wetube-chrome .wetube-brand {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
  opacity: 0.85;
  height: 100%;
  cursor: default;
}
#wetube-chrome .wetube-brand-icon {
  width: 18px; height: 18px;
  display: inline-block;
}
#wetube-chrome .wetube-menu-strip {
  display: flex;
  align-items: stretch;
  height: 100%;
}
#wetube-chrome .wetube-menu-trigger {
  display: inline-flex;
  align-items: center;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  height: 100%;
}
#wetube-chrome .wetube-menu-trigger:hover,
#wetube-chrome .wetube-menu-trigger.open {
  background: rgba(0, 0, 0, 0.08);
}
#wetube-chrome .wetube-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  height: 100%;
}
#wetube-chrome .wetube-toolbar .icon-btn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  border-radius: 6px;
}
#wetube-chrome .wetube-toolbar .icon-btn:hover { background: rgba(0, 0, 0, 0.08); }
#wetube-chrome .wetube-toolbar .icon-btn:active { background: rgba(0, 0, 0, 0.14); }
#wetube-chrome .wetube-toolbar svg { width: 16px; height: 16px; }
#wetube-chrome .wetube-toolbar .sep {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: rgba(128, 128, 128, 0.35);
}
#wetube-chrome .wetube-spacer { flex: 1 1 auto; }
#wetube-chrome .wetube-window-ctrls {
  display: flex;
  align-items: stretch;
  height: 100%;
}
#wetube-chrome .wetube-winbtn {
  width: 46px;
  height: 100%;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
#wetube-chrome .wetube-winbtn:hover { background: rgba(0, 0, 0, 0.08); }
#wetube-chrome .wetube-winbtn.close:hover { background: #e81123; color: #fff; }

#wetube-chrome .wetube-menu-pop {
  position: fixed;
  z-index: 2147483647;
  min-width: 200px;
  background: rgba(252, 252, 252, 0.98);
  color: #111;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  font: 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
#wetube-chrome .wetube-menu-pop .item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 14px;
  cursor: pointer;
  white-space: nowrap;
}
#wetube-chrome .wetube-menu-pop .item:hover { background: rgba(0, 0, 0, 0.06); }
#wetube-chrome .wetube-menu-pop .item .accel {
  color: #777;
  font-size: 12px;
}
#wetube-chrome .wetube-menu-pop .sep {
  height: 1px;
  margin: 4px 0;
  background: rgba(0, 0, 0, 0.08);
}

@media (prefers-color-scheme: dark) {
  #wetube-chrome {
    color: #f1f1f1;
    background: rgba(24, 24, 24, 0.86);
    border-bottom-color: rgba(255, 255, 255, 0.12);
  }
  #wetube-chrome .wetube-menu-trigger:hover,
  #wetube-chrome .wetube-menu-trigger.open { background: rgba(255, 255, 255, 0.12); }
  #wetube-chrome .wetube-toolbar .icon-btn:hover { background: rgba(255, 255, 255, 0.12); }
  #wetube-chrome .wetube-toolbar .icon-btn:active { background: rgba(255, 255, 255, 0.2); }
  #wetube-chrome .wetube-winbtn:hover { background: rgba(255, 255, 255, 0.12); }
  #wetube-chrome .wetube-menu-pop {
    background: rgba(28, 28, 28, 0.98);
    color: #f1f1f1;
    border-color: rgba(255, 255, 255, 0.12);
  }
  #wetube-chrome .wetube-menu-pop .item:hover { background: rgba(255, 255, 255, 0.08); }
  #wetube-chrome .wetube-menu-pop .item .accel { color: #999; }
  #wetube-chrome .wetube-menu-pop .sep { background: rgba(255, 255, 255, 0.1); }
}
`;

  function mount() {
    if (document.getElementById("wetube-chrome")) return;

    const style = document.createElement("style");
    style.id = "wetube-chrome-style";
    style.textContent = STYLE;
    (document.head || document.documentElement).appendChild(style);

    const chromeEl = document.createElement("div");
    chromeEl.id = "wetube-chrome";

    /* 左侧：品牌 */
    const brand = document.createElement("div");
    brand.className = "wetube-brand";
    brand.title = "WeTube";
    brand.appendChild(buildIcon("logo", 18));
    const brandText = document.createElement("span");
    brandText.textContent = "WeTube";
    brand.appendChild(brandText);
    brand.addEventListener("dblclick", () => send("window-toggle-maximize"));
    brand.addEventListener("click", () => send("home"));

    /* 菜单条 */
    const menuStrip = document.createElement("div");
    menuStrip.className = "wetube-menu-strip";
    const triggers = [];
    for (const m of MENUS) {
      const t = document.createElement("button");
      t.className = "wetube-menu-trigger";
      t.type = "button";
      t.textContent = m.label;
      t.addEventListener("click", (ev) => {
        ev.stopPropagation();
        toggleMenu(triggers.indexOf(t));
      });
      triggers.push({ node: t, menu: m });
      menuStrip.appendChild(t);
    }

    /* 工具栏（后退/前进/刷新/首页） */
    const tb = document.createElement("div");
    tb.className = "wetube-toolbar";
    TOOLBAR_BTNS.forEach((b, i) => {
      if (i > 0) {
        const sep = document.createElement("div");
        sep.className = "sep";
        tb.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.className = "icon-btn";
      btn.setAttribute("data-cmd", b.id);
      btn.title = b.title;
      btn.setAttribute("aria-label", b.title);
      btn.appendChild(buildToolbarIcon(b.id, 16));
      tb.appendChild(btn);
    });
    tb.addEventListener("click", (ev) => {
      const btn = ev.target.closest && ev.target.closest("button[data-cmd]");
      if (btn) send(btn.getAttribute("data-cmd"));
    });

    /* spacer + 窗口控制 */
    const spacer = document.createElement("div");
    spacer.className = "wetube-spacer";

    const ctrls = document.createElement("div");
    ctrls.className = "wetube-window-ctrls";

    const btnMin = document.createElement("button");
    btnMin.className = "wetube-winbtn minimize";
    btnMin.title = "最小化";
    btnMin.setAttribute("aria-label", "最小化");
    btnMin.appendChild(buildIcon("minimize", 16));
    btnMin.addEventListener("click", () => send("window-minimize"));

    const btnMax = document.createElement("button");
    btnMax.className = "wetube-winbtn maximize";
    btnMax.title = "最大化";
    btnMax.setAttribute("aria-label", "最大化");
    btnMax.appendChild(buildIcon("maximize", 16));
    btnMax.addEventListener("click", () => send("window-toggle-maximize"));

    const btnClose = document.createElement("button");
    btnClose.className = "wetube-winbtn close";
    btnClose.title = "关闭";
    btnClose.setAttribute("aria-label", "关闭");
    btnClose.appendChild(buildIcon("close", 16));
    btnClose.addEventListener("click", () => send("window-close"));

    ctrls.append(btnMin, btnMax, btnClose);

    chromeEl.append(brand, menuStrip, tb, spacer, ctrls);
    (document.body || document.documentElement).appendChild(chromeEl);

    /* 拖动：Windows 上 WebView2 不支持 -webkit-app-region: drag，
     * 所以在标题栏的空白区按下时，交给 Rust 用系统消息启动拖动。
     * 按钮（菜单/工具/窗口控制）和 logo 不参与拖动——它们各自有点击行为。 */
    chromeEl.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      if (ev.target.closest("button, .wetube-menu-pop, .wetube-brand")) return;
      ev.preventDefault();
      if (window.__WETUBE_PLATFORM__ === "windows") send("window-drag");
    });

    // 双击标题栏空白处（像原生标题栏一样）切换最大化。
    chromeEl.addEventListener("dblclick", (ev) => {
      if (ev.target.closest("button, .wetube-menu-pop, .wetube-brand")) return;
      send("window-toggle-maximize");
    });

    /* 全局关闭：点其他位置 / 按 Esc */
    document.addEventListener("click", (ev) => {
      if (!ev.target.closest || !ev.target.closest("#wetube-chrome .wetube-menu-pop")) {
        closeAllMenus();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeAllMenus();
    });

    function closeAllMenus() {
      triggers.forEach((t) => {
        t.node.classList.remove("open");
      });
      const existing = document.getElementById("wetube-menu-pop");
      if (existing) existing.remove();
    }

    function toggleMenu(idx) {
      const wasOpen = triggers[idx].node.classList.contains("open");
      closeAllMenus();
      if (wasOpen) return;
      triggers[idx].node.classList.add("open");
      const rect = triggers[idx].node.getBoundingClientRect();
      const pop = document.createElement("div");
      pop.id = "wetube-menu-pop";
      pop.className = "wetube-menu-pop";
      pop.style.top = rect.bottom + "px";
      pop.style.left = rect.left + "px";
      triggers[idx].menu.items.forEach((it) => {
        if (it.sep) {
          const s = document.createElement("div");
          s.className = "sep";
          pop.appendChild(s);
          return;
        }
        const item = document.createElement("div");
        item.className = "item";
        item.setAttribute("data-cmd", it.id);
        const label = document.createElement("span");
        label.textContent = it.label;
        item.appendChild(label);
        if (it.shortcut) {
          const accel = document.createElement("span");
          accel.className = "accel";
          accel.textContent = it.shortcut;
          item.appendChild(accel);
        }
        pop.appendChild(item);
      });
      pop.addEventListener("click", (ev) => {
        const item = ev.target.closest && ev.target.closest(".item");
        if (!item) return;
        const cmd = item.getAttribute("data-cmd");
        closeAllMenus();
        if (cmd) send(cmd);
      });
      document.body.appendChild(pop);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
