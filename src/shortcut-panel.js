/*
 * 快捷键设置面板。
 *
 * 注册表由 Rust 侧注入到 `window.__WETUBE_SHORTCUTS__`，每项长这样：
 *   { id, label, group, spec, display, default, custom }
 * 其中 `display` 是 Rust 算好的人话显示（macOS 是 ⌘⇧H，Windows 是 Ctrl+Shift+H），
 * 这里不再做一次格式化——两边各写一份迟早对不上。
 *
 * 改动通过 ipc 发 JSON 给 Rust 落盘，Rust 再调 `window.__wetubeOnShortcutsChanged`
 * 把最新注册表推回来重绘。单向数据流，面板自己不维护"已保存"状态。
 *
 * ⚠️ YouTube 开了 Trusted Types：innerHTML 和 DOMParser 都是受控 sink，
 *    一律用 createElement + textContent，别拼接 HTML 字符串。
 */

(() => {
	if (window.__wetubeShortcutPanelMounted) return;
	window.__wetubeShortcutPanelMounted = true;

	const PANEL_ID = "wetube-shortcut-panel";
	const isMac = window.__WETUBE_PLATFORM__ === "macos";

	/** 注册表快照。Rust 每次改完会整体推过来一份新的。 */
	let registry = Array.isArray(window.__WETUBE_SHORTCUTS__)
		? window.__WETUBE_SHORTCUTS__
		: [];

	let root = null;
	let backdrop = null;
	/** 正在等用户按键的条目 id，null 表示没在捕获。 */
	let capturingId = null;

	const send = (payload) => {
		try {
			window.ipc.postMessage(JSON.stringify(payload));
		} catch (e) {
			/* ipc 不可用时静默忽略 */
		}
	};

	// ---------------------------------------------------------------- 样式

	const CSS = `
#${PANEL_ID} *, #${PANEL_ID}-backdrop * { box-sizing: border-box; }
#${PANEL_ID}-backdrop {
	position: fixed; inset: 0; z-index: 2147483200;
	background: rgba(0,0,0,.45);
}
#${PANEL_ID} {
	--sc-bg: #ffffff;
	--sc-fg: #16181c;
	--sc-dim: #5f6672;
	--sc-line: rgba(0,0,0,.12);
	--sc-hover: rgba(0,0,0,.05);
	--sc-accent: #367bf0;
	--sc-warn: #d93025;
	position: fixed; z-index: 2147483201;
	top: 50%; left: 50%; transform: translate(-50%, -50%);
	width: min(560px, calc(100vw - 32px));
	max-height: min(80vh, 720px);
	display: flex; flex-direction: column;
	background: var(--sc-bg); color: var(--sc-fg);
	border: 1px solid var(--sc-line); border-radius: 12px;
	box-shadow: 0 24px 64px rgba(0,0,0,.32);
	font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
	#${PANEL_ID} {
		--sc-bg: #1b1d22;
		--sc-fg: #eceef2;
		--sc-dim: #9aa1ad;
		--sc-line: rgba(255,255,255,.12);
		--sc-hover: rgba(255,255,255,.06);
		--sc-warn: #ff6b66;
	}
}
#${PANEL_ID} header {
	display: flex; align-items: center; gap: 8px;
	padding: 14px 16px; border-bottom: 1px solid var(--sc-line);
}
#${PANEL_ID} h1 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
#${PANEL_ID} .sc-btn {
	border: 1px solid var(--sc-line); background: transparent; color: var(--sc-fg);
	font: inherit; padding: 5px 11px; border-radius: 7px; cursor: pointer;
}
#${PANEL_ID} .sc-btn:hover { background: var(--sc-hover); }
#${PANEL_ID} .sc-btn.icon { border: 0; color: var(--sc-dim); font-size: 18px; padding: 4px 8px; }
#${PANEL_ID} .sc-btn.icon:hover { color: var(--sc-fg); }
#${PANEL_ID} .sc-body { overflow-y: auto; padding: 4px 0 8px; }
#${PANEL_ID} .sc-group {
	padding: 12px 16px 4px;
	font-size: 11px; font-weight: 700; letter-spacing: .08em;
	text-transform: uppercase; color: var(--sc-dim);
}
#${PANEL_ID} .sc-row {
	display: flex; align-items: center; gap: 10px;
	padding: 7px 16px;
}
#${PANEL_ID} .sc-row:hover { background: var(--sc-hover); }
#${PANEL_ID} .sc-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#${PANEL_ID} .sc-keys {
	min-width: 132px; text-align: center;
	padding: 4px 10px; border-radius: 6px;
	border: 1px solid var(--sc-line); background: var(--sc-hover);
	font-variant-numeric: tabular-nums;
}
#${PANEL_ID} .sc-keys.capturing {
	border-color: var(--sc-accent); color: var(--sc-accent);
	box-shadow: 0 0 0 3px rgba(54,123,240,.2);
}
#${PANEL_ID} .sc-keys.conflict { border-color: var(--sc-warn); color: var(--sc-warn); }
#${PANEL_ID} .sc-note {
	padding: 10px 16px 4px; color: var(--sc-dim); font-size: 12px;
}
#${PANEL_ID} .sc-note.warn { color: var(--sc-warn); }
`;

	// ------------------------------------------------------------ DOM 工具

	function el(tag, attrs, children) {
		const node = document.createElement(tag);
		if (attrs) {
			for (const key in attrs) {
				if (key === "class") node.className = attrs[key];
				else if (key === "text") node.textContent = attrs[key];
				else node.setAttribute(key, attrs[key]);
			}
		}
		for (const child of children || []) {
			if (child) node.appendChild(child);
		}
		return node;
	}

	// ------------------------------------------------------------ 按键捕获

	const MODIFIER_CODES = new Set([
		"ShiftLeft", "ShiftRight",
		"ControlLeft", "ControlRight",
		"AltLeft", "AltRight",
		"MetaLeft", "MetaRight",
		"CapsLock",
	]);
	const FN_KEYS = new Set(
		Array.from({ length: 12 }, (_, i) => `F${i + 1}`)
	);

	/**
	 * 按键 → spec 的转换在 ui.js 里（`window.__wetubeEventToSpec`）。
	 *
	 * 那边拿它做快捷键分发，这边拿它捕获新按键——必须是同一套规则，
	 * 否则"面板显示捕获到了 Cmd+R"和"按下去真正触发的动作"会对不上。
	 */
	const eventToSpec = window.__wetubeEventToSpec;
	if (typeof eventToSpec !== "function") return;

	/** 这次按键能不能当快捷键。不能的话返回提示文案。 */
	function rejectReason(ev) {
		// 只按了修饰键本身：等真正的键落下再算
		if (MODIFIER_CODES.has(ev.code)) return null;

		const hasMod = isMac
			? ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey
			: ev.ctrlKey || ev.altKey || ev.shiftKey || ev.metaKey;

		if (!isMac && ev.metaKey) {
			return "Windows 键不能用作快捷键";
		}
		// 裸字母/数字会在打字时误触发，只有 F1–F12 允许裸用
		if (!hasMod && !FN_KEYS.has(ev.code)) {
			return "请带上 Cmd / Ctrl / Alt / Shift 中的至少一个";
		}
		return null;
	}

	/** 找出占用了同一个组合的其它条目。 */
	function findConflict(spec, exceptId) {
		return registry.find((it) => it.id !== exceptId && it.spec === spec) || null;
	}

	function onCaptureKeyDown(ev) {
		if (!capturingId) return;
		ev.preventDefault();
		ev.stopPropagation();

		if (ev.key === "Escape") {
			stopCapture();
			return;
		}

		const reason = rejectReason(ev);
		if (reason === null && MODIFIER_CODES.has(ev.code)) return; // 还在按修饰键
		if (reason) {
			showNote(reason, true);
			return;
		}

		const spec = eventToSpec(ev);
		const id = capturingId;
		stopCapture();

		// 冲突只提示，不强拦——用户可能就是想这么设
		const clash = findConflict(spec, id);
		showNote(
			clash ? `与「${clash.label}」冲突了，仍然按你的设置保存` : "已保存",
			Boolean(clash)
		);
		send({ type: "shortcut:set", id, spec });
	}

	function startCapture(id) {
		capturingId = id;
		// ui.js 的 keydown 是捕获阶段注册的，比这里早；靠这个标志让它先让开，
		// 否则按 Cmd+R 会直接把页面刷新掉。
		window.__wetubeCapturingShortcut = true;
		render();
	}

	function stopCapture() {
		capturingId = null;
		window.__wetubeCapturingShortcut = false;
		render();
	}

	// ---------------------------------------------------------------- 渲染

	let noteNode = null;

	function showNote(text, warn) {
		if (!noteNode) return;
		noteNode.textContent = text || "";
		noteNode.className = warn ? "sc-note warn" : "sc-note";
	}

	function render() {
		if (!root) return;
		const body = root.querySelector(".sc-body");
		if (!body) return;
		body.textContent = "";

		let lastGroup = null;
		for (const item of registry) {
			if (item.group !== lastGroup) {
				lastGroup = item.group;
				body.appendChild(el("div", { class: "sc-group", text: item.group }));
			}

			const keys = el("span", {
				class:
					"sc-keys" +
					(capturingId === item.id ? " capturing" : ""),
				text: capturingId === item.id ? "按下新的组合…" : item.display,
			});

			const row = el("div", { class: "sc-row" }, [
				el("span", { class: "sc-label", text: item.label }),
				keys,
				el("button", {
					class: "sc-btn",
					text: capturingId === item.id ? "取消" : "更改",
				}),
				el("button", { class: "sc-btn", text: "默认" }),
			]);

			const [changeBtn, defaultBtn] = row.querySelectorAll("button");
			changeBtn.addEventListener("click", () => {
				if (capturingId === item.id) stopCapture();
				else startCapture(item.id);
			});
			defaultBtn.addEventListener("click", () => {
				// 真浏览器里 disabled 的按钮不会派发 click，但别指望这个——
				// 合成事件（测试、脚本）照样能触发。
				if (defaultBtn.disabled) return;
				send({ type: "shortcut:reset", id: item.id });
			});
			defaultBtn.disabled = !item.custom;
			if (!item.custom) defaultBtn.style.opacity = ".4";

			body.appendChild(row);
		}
	}

	function mount() {
		if (document.getElementById(PANEL_ID)) return;

		const style = document.createElement("style");
		style.textContent = CSS;
		(document.head || document.documentElement).appendChild(style);

		backdrop = el("div", { id: `${PANEL_ID}-backdrop` });
		backdrop.addEventListener("click", close);

		noteNode = el("div", { class: "sc-note" });

		root = el("div", { id: PANEL_ID }, [
			el("header", null, [
				el("h1", { text: "快捷键设置" }),
				el("button", { class: "sc-btn", text: "全部恢复默认" }),
				el("button", { class: "sc-btn icon", text: "×" }),
			]),
			el("div", { class: "sc-body" }),
			noteNode,
		]);

		const [resetAllBtn, closeBtn] = root.querySelectorAll("header button");
		resetAllBtn.addEventListener("click", () => {
			send({ type: "shortcut:reset" });
		});
		closeBtn.addEventListener("click", close);

		document.body.appendChild(backdrop);
		document.body.appendChild(root);
		render();

		window.addEventListener("keydown", onCaptureKeyDown, true);
	}

	function close() {
		stopCapture();
		if (backdrop) backdrop.remove();
		if (root) root.remove();
		backdrop = null;
		root = null;
		noteNode = null;
	}

	function toggle() {
		if (document.getElementById(PANEL_ID)) close();
		else mount();
	}

	// ---------------------------------------------------------------- 出口

	window.__wetubeToggleShortcutPanel = toggle;

	/** Rust 改完快捷键后回调：更新注册表、广播给 ui.js 重算键位映射、重绘面板。 */
	window.__wetubeOnShortcutsChanged = (next) => {
		if (Array.isArray(next)) {
			registry = next;
			window.__WETUBE_SHORTCUTS__ = next;
		}
		window.dispatchEvent(new CustomEvent("wetube:shortcuts-changed"));
		if (document.getElementById(PANEL_ID)) render();
	};
})();
