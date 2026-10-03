/*
 * 设置面板：完全按 schema.json 生成，加一个配置项不用改这里的代码。
 *
 * 面板是注入在 YouTube 页面里的一个浮层，跨平台长得一模一样。
 * 改动即时生效（重新调度对应功能），同时通过 ipc 让 Rust 落盘。
 */
(() => {
	const YTE = window.__YTE;
	if (!YTE) return;

	const { cfg, setConfig, isEnabled, log } = YTE;

	const PANEL_ID = "yte-settings-panel";
	// 构建号戳：显示在面板底部，用于确认运行的是哪个版本（每次发布手动更新）。
	const BUILD_STAMP = "3.0.6";

	// 页面里没有 devtools，任何 JS 错误都记到全局，面板 footer 会显示出来。
	window.addEventListener("error", (event) => {
		window.__YTE_PAGE_ERROR__ = `${event.message} @ ${String(event.filename ?? "").split("/").pop()}:${event.lineno}`;
	});
	window.addEventListener("unhandledrejection", (event) => {
		window.__YTE_PAGE_ERROR__ = `未处理的 Promise 拒绝: ${event.reason}`;
	});
	let root = null;
	window.addEventListener("wetube:config-reset", () => {
		if (!root) return;
		const visible = root.style.display !== "none";
		closePanel();
		root.remove();
		root = null;
		if (visible) openPanel();
	});

	// ---------------------------------------------------------------- 样式

	const PANEL_CSS = `
#yte-settings-panel * { box-sizing: border-box; }
#yte-settings-panel {
	--yte-panel-bg: #ffffff;
	--yte-panel-fg: #16181c;
	--yte-panel-dim: #5f6672;
	--yte-panel-line: rgba(0,0,0,.12);
	--yte-panel-accent: #367bf0;
	--yte-panel-hover: rgba(0,0,0,.05);
	color: var(--yte-panel-fg);
	font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
	#yte-settings-panel {
		--yte-panel-bg: #1b1d22;
		--yte-panel-fg: #eceef2;
		--yte-panel-dim: #9aa1ad;
		--yte-panel-line: rgba(255,255,255,.12);
		--yte-panel-hover: rgba(255,255,255,.06);
	}
}
#yte-settings-panel-backdrop {
	position: fixed; inset: 0; z-index: 2147483000;
	background: rgba(0,0,0,.45);
}
#yte-settings-panel {
	position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483001;
	width: min(460px, 100vw);
	display: flex; flex-direction: column;
	background: var(--yte-panel-bg);
	border-left: 1px solid var(--yte-panel-line);
	box-shadow: -16px 0 48px rgba(0,0,0,.28);
}
#yte-settings-panel header {
	display: flex; align-items: center; gap: 8px;
	padding: 14px 16px; border-bottom: 1px solid var(--yte-panel-line);
}
#yte-settings-panel h1 { margin: 0; font-size: 15px; font-weight: 650; flex: 1; }
#yte-settings-panel .yte-icon-btn {
	border: 0; background: transparent; color: var(--yte-panel-dim);
	font-size: 20px; line-height: 1; cursor: pointer; padding: 4px 8px; border-radius: 6px;
}
#yte-settings-panel .yte-icon-btn:hover { background: var(--yte-panel-hover); color: var(--yte-panel-fg); }
#yte-settings-panel .yte-search {
	margin: 12px 16px; padding: 8px 12px; width: calc(100% - 32px);
	border: 1px solid var(--yte-panel-line); border-radius: 8px;
	background: transparent; color: inherit; font-size: 13px;
}
#yte-settings-panel .yte-body { flex: 1; overflow-y: auto; padding: 0 16px 16px; }
#yte-settings-panel .yte-group-title {
	position: sticky; top: 0; z-index: 1;
	margin: 16px 0 8px; padding: 6px 0;
	background: var(--yte-panel-bg);
	font-size: 12px; font-weight: 700; letter-spacing: .04em;
	text-transform: uppercase; color: var(--yte-panel-dim);
}
#yte-settings-panel .yte-card {
	border: 1px solid var(--yte-panel-line); border-radius: 10px;
	padding: 12px 14px; margin-bottom: 10px; background: var(--yte-panel-bg);
}
#yte-settings-panel .yte-card.is-off { opacity: .62; }
#yte-settings-panel .yte-card-head { display: flex; align-items: flex-start; gap: 10px; }
#yte-settings-panel .yte-card-title { font-weight: 620; flex: 1; }
#yte-settings-panel .yte-card-desc { margin-top: 4px; font-size: 12px; color: var(--yte-panel-dim); }
#yte-settings-panel .yte-todo {
	display: inline-block; margin-left: 6px; padding: 1px 6px;
	border-radius: 4px; background: var(--yte-panel-hover);
	font-size: 11px; color: var(--yte-panel-dim);
}
#yte-settings-panel .yte-fields { margin-top: 10px; display: grid; gap: 10px; }
#yte-settings-panel .yte-field { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; }
#yte-settings-panel .yte-field > label { font-size: 12.5px; }
#yte-settings-panel .yte-field.is-block { grid-template-columns: 1fr; }
#yte-settings-panel .yte-field.is-disabled { opacity: .4; pointer-events: none; }
#yte-settings-panel .yte-hint { grid-column: 1 / -1; font-size: 11.5px; color: var(--yte-panel-dim); }
#yte-settings-panel input[type="number"], #yte-settings-panel input[type="text"],
#yte-settings-panel select, #yte-settings-panel textarea {
	border: 1px solid var(--yte-panel-line); border-radius: 6px;
	background: var(--yte-panel-bg); color: var(--yte-panel-fg); font: inherit;
	padding: 5px 8px; min-width: 132px;
}
#yte-settings-panel input[type="number"] { width: 92px; }
#yte-settings-panel textarea { width: 100%; min-height: 84px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; resize: vertical; }
/* select 展开的下拉列表是浏览器/系统渲染的弹层，不继承面板的 background/color。
 * 必须给 option 显式指定底色与文字色，否则深色面板下会出现白底白字看不清。 */
#yte-settings-panel select option {
	background: #ffffff;
	color: #000000;
}
#yte-settings-panel select option:checked,
#yte-settings-panel select option:hover {
	background: #e0e0e0; /* 浅色模式：选中/悬停项变浅灰 */
	color: #000000;
}
@media (prefers-color-scheme: dark) {
	#yte-settings-panel select option {
		background: #000000;
		color: #ffffff;
	}
	#yte-settings-panel select option:checked,
	#yte-settings-panel select option:hover {
		background: #3d3d3d; /* 深色模式：选中/悬停项变浅灰 */
		color: #ffffff;
	}
}
#yte-settings-panel input[type="color"] {
	width: 44px; height: 26px; padding: 0; border: 1px solid var(--yte-panel-line);
	border-radius: 6px; background: transparent; cursor: pointer;
}
#yte-settings-panel input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--yte-panel-accent); }
#yte-settings-panel footer {
	display: flex; align-items: center; gap: 10px;
	padding: 12px 16px; border-top: 1px solid var(--yte-panel-line);
	font-size: 12px; color: var(--yte-panel-dim);
}
#yte-settings-panel footer button {
	margin-left: auto; padding: 6px 14px; border: 1px solid var(--yte-panel-line);
	border-radius: 6px; background: transparent; color: inherit; cursor: pointer; font: inherit;
}
#yte-settings-panel footer button:hover { background: var(--yte-panel-hover); }
`;

	// ---------------------------------------------------------------- 控件

	function el(tag, props = {}, children = []) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props)) {
			if (key === "class") node.className = value;
			else if (key === "text") node.textContent = value;
			else if (key === "html") node.innerHTML = value;
			else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
			else if (value !== null && value !== undefined) node.setAttribute(key, value);
		}
		for (const child of [].concat(children)) if (child) node.append(child);
		return node;
	}

	function buildField(feature, field, onChange) {
		const value = cfg(feature.id, field.key);
		const wrap = el("div", { class: "yte-field" });
		if (field.parent) {
			const parentValue = cfg(feature.id, field.parent);
			if (parentValue === false) wrap.classList.add("is-disabled");
		}

		const label = el("label", { text: field.label });
		let input;

		if (field.type === "boolean") {
			input = el("input", { type: "checkbox" });
			input.checked = Boolean(value);
			input.addEventListener("change", () => onChange(field.key, input.checked));
		} else if (field.type === "number") {
			input = el("input", { type: "number", value: String(value ?? 0) });
			if (field.min !== undefined) input.min = field.min;
			if (field.max !== undefined) input.max = field.max;
			if (field.step !== undefined) input.step = field.step;
			// 必须自己校验：`Number("") === 0`，清空输入框（很常见的"想重输"操作）会把设置
			// 静默写成 0，而 0 往往低于 min——例如滚轮调倍速的 steps 变成 0 后
			// `Math.round(x / 0) * 0` 得到 NaN，给 video.playbackRate 赋值会抛 TypeError。
			// min/max 只是 HTML 属性，不点表单的提交按钮不会自动裁剪。
			input.addEventListener("change", () => {
				const raw = input.value.trim();
				const next = Number(raw);
				if (!raw || !Number.isFinite(next)) {
					input.value = String(cfg(feature.id, field.key) ?? 0); // 回填当前值，不写库
					return;
				}
				const lo = field.min !== undefined ? Number(field.min) : -Infinity;
				const hi = field.max !== undefined ? Number(field.max) : Infinity;
				const clamped = Math.min(Math.max(next, lo), hi);
				input.value = String(clamped);
				if (clamped !== cfg(feature.id, field.key)) onChange(field.key, clamped);
			});
		} else if (field.type === "select") {
			input = el("select", {}, (field.options ?? []).map((option) => el("option", { value: option, text: option, selected: option === value ? "selected" : null })));
			input.addEventListener("change", () => onChange(field.key, input.value));
		} else if (field.type === "color") {
			input = el("input", { type: "color", value: value ?? "#000000" });
			input.addEventListener("input", () => onChange(field.key, input.value));
		} else if (field.type === "textarea") {
			wrap.classList.add("is-block");
			input = el("textarea", { placeholder: field.placeholder ?? "" });
			input.value = value ?? "";
			input.addEventListener("change", () => onChange(field.key, input.value));
		} else {
			input = el("input", { type: "text", value: value ?? "", placeholder: field.placeholder ?? "" });
			input.addEventListener("change", () => onChange(field.key, input.value));
		}

		wrap.append(label, input);
		if (field.hint) wrap.append(el("div", { class: "yte-hint", text: field.hint }));
		return wrap;
	}

	// ---------------------------------------------------------------- 渲染

	function buildCard(feature, onChange) {
		const implemented = Boolean(YTE.features[feature.id]);
		const enabled = isEnabled(feature.id);
		const card = el("div", { class: `yte-card${enabled ? "" : " is-off"}`, "data-feature": feature.id });

		const head = el("div", { class: "yte-card-head" });
		const title = el("div", { class: "yte-card-title" });
		title.append(el("span", { text: feature.label }));
		if (!implemented) title.append(el("span", { class: "yte-todo", text: "尚未实现" }));
		head.append(title);

		const main = feature.fields?.find((field) => field.key === "enabled");
		if (main) {
			const toggle = el("input", { type: "checkbox" });
			toggle.checked = Boolean(cfg(feature.id, "enabled"));
			toggle.addEventListener("change", () => {
				onChange("enabled", toggle.checked);
				card.classList.toggle("is-off", !toggle.checked);
				card.querySelectorAll(".yte-field").forEach((node) => {
					const key = node.dataset.key;
					const field = feature.fields.find((item) => item.key === key);
					if (field?.parent === "enabled") node.classList.toggle("is-disabled", !toggle.checked);
				});
			});
			head.append(toggle);
		}
		card.append(head);

		if (feature.desc) card.append(el("div", { class: "yte-card-desc", text: feature.desc }));

		const rest = (feature.fields ?? []).filter((field) => field.key !== "enabled");
		if (rest.length) {
			const fields = el("div", { class: "yte-fields" });
			for (const field of rest) {
				const node = buildField(feature, field, onChange);
				node.dataset.key = field.key;
				fields.append(node);
			}
			card.append(fields);
		}

		card.dataset.search = `${feature.id} ${feature.label} ${feature.desc ?? ""}`.toLowerCase();
		return card;
	}

	function render(body, query = "") {
		body.textContent = "";
		const needle = query.trim().toLowerCase();

		for (const group of YTE.schema.groups ?? []) {
			const features = (YTE.schema.features ?? []).filter((feature) => feature.group === group.id);
			if (!features.length) continue;

			const cards = [];
			for (const feature of features) {
				if (needle && !`${feature.id} ${feature.label} ${feature.desc ?? ""}`.toLowerCase().includes(needle)) continue;
				try {
					cards.push(buildCard(feature, (key, value) => onConfigChange(feature.id, key, value)));
				} catch (err) {
					// 单卡渲染出错不能拖垮整个面板：显示错误详情而不是静默消失。
					cards.push(el("div", { class: "yte-card", "data-feature": feature.id }, [
						el("div", { class: "yte-card-title", text: `${feature.label ?? feature.id}（渲染出错）` }),
						el("div", { class: "yte-card-desc", text: String((err && err.stack) || err) }),
					]));
				}
			}

			if (!cards.length) continue;
			body.append(el("div", { class: "yte-group-title", text: group.label }), ...cards);
		}

		if (!body.childElementCount) {
			body.append(el("div", { class: "yte-card-desc", text: "没有匹配的功能" }));
		}
	}

	function onConfigChange(featureId, key, value) {
		setConfig(featureId, key, value);
		// 立即重新调度这个功能，让改动马上在页面上生效
		void YTE.syncFeature(featureId, { force: true });
	}

	// ---------------------------------------------------------------- 打开/关闭

	function openPanel() {
		if (root) {
			root.style.display = "";
			return;
		}
		root = el("div", { id: PANEL_ID });
		const style = el("style", { text: PANEL_CSS });

		const backdrop = el("div", { id: "yte-settings-panel-backdrop" });
		backdrop.addEventListener("click", closePanel);

		const panel = el("aside", { id: "yte-settings-panel" });
		const body = el("div", { class: "yte-body" });
		const search = el("input", { class: "yte-search", type: "search", placeholder: "搜索功能或设置…" });
		search.addEventListener("input", () => render(body, search.value));

		const close = el("button", { class: "yte-icon-btn", text: "×", title: "关闭 (Esc)" });
		close.addEventListener("click", closePanel);

		const reset = el("button", { text: "全部重置为默认" });
		reset.addEventListener("click", () => {
			if (!confirm("把所有设置恢复成默认值？")) return;
				YTE.post({ type: "config:reset" });
		});

		const total = (YTE.schema.features ?? []).reduce((sum, feature) => sum + (feature.fields?.length ?? 0), 0);
		const done = (YTE.schema.features ?? []).filter((feature) => YTE.features[feature.id]).length;

		// 运行时自诊断：schema 是否真的进了页面、目标功能在不在、有无 JS 错误。
		const sub = YTE.__subtitleDebug?.() ?? {};
		const diag = [
			`schema ${YTE.schema.features?.length ?? 0} 功能`,
			`字幕翻译: ${(YTE.schema.features ?? []).some((feature) => feature.id === "subtitleTranslation") ? "在" : "缺"}`,
			`已注册 ${Object.keys(YTE.features).length}`,
			`译钮:${sub.button ? "在" : sub.button === false ? "无" : "?"}@${sub.page ?? "?"}`,
			`译请求 发${sub.sent ?? 0}/回${sub.recv ?? 0}`,
		];
		if (sub.lastError) diag.push(`译错误:${sub.lastError}`);
		if (window.__YTE_PAGE_ERROR__) diag.push(`⚠ ${window.__YTE_PAGE_ERROR__}`);

		panel.append(
			el("header", {}, [el("h1", { text: "WeTube 增强设置" }), close]),
			search,
			body,
			el("footer", {}, [
				el("span", { text: `${done}/${YTE.schema.features?.length ?? 0} 个功能已实现 · 共 ${total} 项设置 · 构建 ${BUILD_STAMP}` }),
				el("span", { text: diag.join(" · "), style: "margin-left:auto;font-size:11px;opacity:.75;" }),
				reset,
			])
		);

		root.append(style, backdrop, panel);
		document.documentElement.append(root);
		render(body);

		document.addEventListener("keydown", onKeyDown, true);
		search.focus();
	}

	function closePanel() {
		if (!root) return;
		root.style.display = "none";
		document.removeEventListener("keydown", onKeyDown, true);
	}

	function onKeyDown(event) {
		if (event.key === "Escape") {
			event.stopPropagation();
			closePanel();
		}
	}

	function togglePanel() {
		if (root && root.style.display !== "none") closePanel();
		else openPanel();
	}

	YTE.openPanel = openPanel;
	YTE.closePanel = closePanel;
	YTE.togglePanel = togglePanel;

	// 工具栏齿轮会调 window.__YTE.togglePanel()；这里也留个快捷键 Cmd/Ctrl+,
	document.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key === ",") {
			event.preventDefault();
			event.stopPropagation();
			togglePanel();
		}
	}, true);

	log("设置面板已就绪");
})();
