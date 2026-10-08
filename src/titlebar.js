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
  /* 图标形状描述：tag + 属性。logo 不用 SVG（见 LOGO_DATA_URL，直接用 App 图标）。 */
  const ICON_SHAPES = {
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
  /* 品牌 logo：直接用 App 图标（icons/AppIcon.iconset/icon_32x32.png 的 base64）。
   * 生成方式：python scripts/png-to-source-ico.py 后取 icon_32x32.png 编码。 */
  const LOGO_DATA_URL =
    "data:image/png;base64,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";
  function buildLogo(size) {
    const img = document.createElement("img");
    img.src = LOGO_DATA_URL;
    img.width = size;
    img.height = size;
    img.alt = "";
    img.style.display = "block";
    img.style.borderRadius = "20%";
    return img;
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

  /* 菜单项只声明 id 和 label，快捷键的显示文字到弹层生成时才去注册表取
   * （见 shortcutOf）——用户改完快捷键，下次点开菜单就是新的，不用重建菜单条。 */
  function shortcutOf(id) {
    const list = window.__WETUBE_SHORTCUTS__ || [];
    const hit = list.find((it) => it.id === id);
    return hit ? hit.display : "";
  }

  /* 菜单结构定义：label + items[]。点击项发 IPC；{ sep: true } 表示分隔线。 */
  const MENUS = [
    {
      label: "文件",
      items: [
        { id: "home", label: "回到首页" },
        { id: "open-external", label: "在系统浏览器中打开" },
        { sep: true },
        { id: "window-close", label: "退出" },
      ],
    },
    {
      label: "导航",
      items: [
        { id: "back", label: "后退" },
        { id: "forward", label: "前进" },
        { id: "reload", label: "刷新" },
        { sep: true },
        { id: "home", label: "主页" },
      ],
    },
    {
      label: "视图",
      items: [
        { id: "shortcuts", label: "快捷键设置…" },
        { id: "settings", label: "增强设置…" },
        { sep: true },
        { id: "fullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "帮助",
      items: [{ id: "project", label: "项目主页" }],
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
  /* 不能顶到 int 上限：快捷键面板的遮罩是 2147483200，chrome 比它高的话
     模态弹层盖不住顶部 36px，标题栏按钮仍可点，模态语义就破了。 */
  z-index: 2147483000;
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
#wetube-chrome .wetube-toolbar .icon-btn:disabled {
  opacity: .32;
  cursor: default;
  background: transparent !important;
}
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

  /* 视口原生滚动条从窗口最顶上开始，会顶进标题栏那一行（出现在 X 按钮右侧）。
   * Chromium 的根滚动条位置 DOM 移不动，所以直接接管：隐藏根滚动条（只影响
   * 视口这一条，YouTube 页内容器——评论区、下拉等——的滚动条不受影响），
   * 在标题栏下方画一条自己的，行为对齐 Windows 惯例。
   * ⚠️ WebView2 默认启用 Fluent 覆盖式滚动条，::-webkit-scrollbar 定制会被
   * Chromium 整体忽略，必须用标准属性 scrollbar-width 才藏得掉。 */
  html {
    scrollbar-width: none;
  }
  html::-webkit-scrollbar { width: 0; height: 0; }
  #wetube-scrollbar {
    position: fixed;
    top: ${BAR_HEIGHT}px;
    right: 0; bottom: 0;
    width: 12px;
    /* 比设置面板（2147483001）低，面板从右侧滑出时盖住它；比 YouTube 内容高。 */
    z-index: 2147482999;
    background: #f1f1f1;
    border-left: 1px solid rgba(0, 0, 0, 0.12);
  }
  #wetube-scrollbar .wetube-scrollbar-thumb {
    width: 100%;
    height: 24px;
    background: #c1c1c1;
  }
  #wetube-scrollbar .wetube-scrollbar-thumb:hover { background: #a8a8a8; }
  #wetube-scrollbar .wetube-scrollbar-thumb:active { background: #787878; }

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

  #wetube-scrollbar {
    background: #202020;
    border-left-color: rgba(255, 255, 255, 0.12);
  }
  #wetube-scrollbar .wetube-scrollbar-thumb { background: #4d4d4d; }
  #wetube-scrollbar .wetube-scrollbar-thumb:hover { background: #6b6b6b; }
  #wetube-scrollbar .wetube-scrollbar-thumb:active { background: #8a8a8a; }
}
`;

  /* 替代视口原生滚动条：从标题栏下方开始（原生那条会顶进 X 按钮那一行）。
   * 滚轮 / 触摸板 / 键盘滚动仍由页面原生处理，这里只补可视部分：
   *   - thumb 位置随滚动同步（scroll + resize + 内容高度变化都监听）；
   *   - thumb 可拖拽，点轨道按 Windows 惯例翻页；
   *   - 页面不够长时不显示；全屏藏 chrome 时一起藏（ui.js 驱动）。 */
  function mountScrollbar() {
    if (document.getElementById("wetube-scrollbar")) return;

    const bar = document.createElement("div");
    bar.id = "wetube-scrollbar";
    const thumb = document.createElement("div");
    thumb.className = "wetube-scrollbar-thumb";
    bar.appendChild(thumb);
    (document.body || document.documentElement).appendChild(bar);

    const scroller = () => document.scrollingElement || document.documentElement;
    let chromeVisible = true;
    let dragging = false;

    function update() {
      const el = scroller();
      const scrollable = el && el.scrollHeight > el.clientHeight + 1;
      const show = chromeVisible && scrollable;
      bar.style.display = show ? "block" : "none";
      if (!show) return;
      const track = bar.clientHeight;
      const thumbH = Math.max(24, Math.round(track * (el.clientHeight / el.scrollHeight)));
      const maxScroll = el.scrollHeight - el.clientHeight;
      const y = maxScroll > 0 ? (el.scrollTop / maxScroll) * (track - thumbH) : 0;
      thumb.style.height = thumbH + "px";
      thumb.style.transform = `translateY(${y}px)`;
    }

    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    /* feed 无限加载、SPA 换页都会改内容高度：盯住根节点尺寸。 */
    if (typeof ResizeObserver === "function") {
      const ro = new ResizeObserver(update);
      if (document.documentElement) ro.observe(document.documentElement);
      if (document.body) ro.observe(document.body);
    }
    window.addEventListener("yt-navigate-finish", () => requestAnimationFrame(update), true);

    /* 拖 thumb：按位移比例换算成 scrollTop。 */
    thumb.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const el = scroller();
      const startY = ev.screenY;
      const startTop = el.scrollTop;
      const travel = Math.max(1, bar.clientHeight - thumb.clientHeight);
      const scale = (el.scrollHeight - el.clientHeight) / travel;
      const onMove = (mv) => {
        el.scrollTop = startTop + (mv.screenY - startY) * scale;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", onUp, true);
        setTimeout(() => { dragging = false; }, 0);
      };
      dragging = true;
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
    });

    /* 点轨道 = 翻页（Windows 惯例）：点 thumb 上方向上翻一屏，下方向下翻。 */
    bar.addEventListener("mousedown", (ev) => {
      if (ev.target === thumb || dragging) return;
      const el = scroller();
      const rect = thumb.getBoundingClientRect();
      const step = el.clientHeight * 0.9;
      el.scrollBy({ top: ev.clientY < rect.top ? -step : step, behavior: "smooth" });
    });

    /* 全屏时 Rust 侧藏 chrome（ui.js 的 __wetubeSetChromeVisible）顺带通知这里。 */
    window.__wetubeScrollbarSyncVisible = (visible) => {
      chromeVisible = visible;
      update();
    };
    update();
  }

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
    brand.appendChild(buildLogo(18));
    const brandText = document.createElement("span");
    brandText.textContent = "WeTube";
    brand.appendChild(brandText);
    // 不再绑 dblclick：双击 logo 会先派发两次 click（回到首页导航两次）
    // 再切一次最大化。品牌区就是回首页，最大化交给标题栏空白处双击。
    brand.addEventListener("click", () => send("home"));

    /* 菜单条：macOS 上由系统菜单栏接管，不渲染 HTML 菜单。 */
    const menuStrip = document.createElement("div");
    menuStrip.className = "wetube-menu-strip";
    const triggers = [];
    if (window.__WETUBE_PLATFORM__ !== "macos") {
      for (const m of MENUS) {
        const t = document.createElement("button");
        t.className = "wetube-menu-trigger";
        t.type = "button";
        t.textContent = m.label;
        t.addEventListener("click", (ev) => {
          ev.stopPropagation();
          // 注意：triggers 存的是 {node, menu} 对象，得按 node 找，不能直接 indexOf(t)
          toggleMenu(triggers.findIndex((entry) => entry.node === t));
        });
        triggers.push({ node: t, menu: m });
        menuStrip.appendChild(t);
      }
    }

    /* 工具栏（后退/前进/刷新/首页） */
    const tb = document.createElement("div");
    tb.className = "wetube-toolbar";
    const navButtons = {};
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
      // 直接绑在按钮上，不靠事件委托 + closest（点中内部 SVG 时 target 是 path，容易取不到）
      if (b.id === "back") btn.addEventListener("click", goBack);
      else if (b.id === "forward") btn.addEventListener("click", goForward);
      else btn.addEventListener("click", () => send(b.id));
      navButtons[b.id] = btn;
      tb.appendChild(btn);
    });

    /* 前进/后退的可用状态：没有历史记录时灰显，避免按钮看起来"点了没反应"。 */
    let backSteps = 0; // 已经后退了几步，>0 才说明能前进
    function refreshNav() {
      if (navButtons.back) navButtons.back.disabled = history.length <= 1;
      if (navButtons.forward) navButtons.forward.disabled = backSteps <= 0;
    }
    function goBack() {
      if (history.length <= 1) return;
      backSteps = Math.min(backSteps + 1, history.length - 1);
      send("back");
      refreshNav();
    }
    function goForward() {
      if (backSteps <= 0) return;
      backSteps -= 1;
      send("forward");
      refreshNav();
    }
    window.addEventListener("popstate", refreshNav);
    // YouTube 的 SPA 导航走 history.pushState，**不触发 popstate**：只在挂载时算一次的话，
    // history.length 增长后这两个按钮的 disabled 永远不刷新。而 disabled 的按钮连 click
    // 都不派发，goBack() 根本没机会执行——表现为后退按钮一直灰显、点了没反应。
    window.addEventListener("yt-navigate-finish", refreshNav);
    window.addEventListener("yt-page-data-updated", refreshNav);
    refreshNav();

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

    /* 双击标题栏、Win+↑、贴边、绿色按钮这些系统路径都不经过上面的 click，
     * 按钮图标必须靠 Rust 在 Resized 里回推的状态才不会长期停在「最大化」。 */
    let maximizedNow = false;
    window.__wetubeSetMaximized = (maximized) => {
      const next = maximized === true;
      if (next === maximizedNow) return;
      maximizedNow = next;
      btnMax.textContent = "";
      btnMax.appendChild(buildIcon(next ? "restore" : "maximize", 16));
      btnMax.title = next ? "还原" : "最大化";
      btnMax.setAttribute("aria-label", btnMax.title);
      btnMax.classList.toggle("is-maximized", next);
    };

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

      // 不要在按下的瞬间进入 Windows 系统拖动循环，否则 WebView 收不到
      // 第二次点击，下面的 dblclick 永远不会触发。移动超过阈值后才拖动；
      // 原地按下/松开则完整保留给浏览器识别单击和双击。
      const startX = ev.screenX;
      const startY = ev.screenY;
      let dragging = false;
      const cleanup = () => {
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("mouseup", cleanup, true);
      };
      const onMove = (moveEv) => {
        if (dragging) return;
        if (Math.hypot(moveEv.screenX - startX, moveEv.screenY - startY) < 4) return;
        dragging = true;
        cleanup();
        // Windows 与 Linux 都去掉了原生标题栏，只能由 Rust 调 tao 的
        // drag_window 接管；原来只判 windows，Linux 上窗口根本拖不动。
        if (window.__WETUBE_PLATFORM__ !== "macos") send("window-drag");
      };
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", cleanup, true);
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
        // 现在才查注册表，改完快捷键立刻反映到菜单上
        const accel = shortcutOf(it.id);
        if (accel) {
          const accelNode = document.createElement("span");
          accelNode.className = "accel";
          accelNode.textContent = accel;
          item.appendChild(accelNode);
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
      // 弹层必须留在 chrome 内：样式、z-index 和“点击外部关闭”的选择器
      // 都以 #wetube-chrome 为作用域。追加到 body 会让弹层变成无样式的普通 div。
      chromeEl.appendChild(pop);
    }

    mountScrollbar();
  }

  /* macOS 上整条 HTML chrome 都不渲染：菜单由系统菜单栏提供，窗口控制由原生
   * 标题栏的交通灯按钮提供。
   * Windows / Linux 走 with_decorations(false)，原生标题栏被去掉了，必须靠这条
   * chrome 提供标题栏、菜单和窗口控制，所以照常渲染。 */
  if (window.__WETUBE_PLATFORM__ !== "macos") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
    } else {
      mount();
    }
  }
})();
