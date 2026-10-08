/*
 * YouTube-Enhancer 运行时（桌面端App 版）
 *
 * 原版是浏览器扩展，功能代码跑在没有 chrome.* 权限的 embedded 层，靠两个隐藏 div
 * 做「信箱」跟扩展通信。搬到桌面端App之后这层通信直接换成同步的 window.__YTE.config，
 * 落盘交给 Rust（走 ipc）。所以功能逻辑基本是原样搬过来的。
 */
(() => {
	if (window.__YTE) return;

	// ---------------------------------------------------------------- 基础设施

	// Rust 在 document-start 就把这两份数据塞进来了。
	const YTE = {
		config: window.__YTE_CONFIG__ ?? {},
		schema: window.__YTE_SCHEMA__ ?? { features: [], groups: [] },
		features: Object.create(null),
		started: false,
	};

	window.__YTE = YTE;

	const log = (...args) => console.debug("[yte]", ...args);

	// ---------------------------------------------------------------- 配置

	/** 读某个 feature 的配置，key 支持点分路径。 */
	function cfg(id, key) {
		const node = YTE.config[id];
		if (!node) return undefined;
		if (!key) return node;
		return key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), node);
	}

	function isEnabled(id) {
		const node = YTE.config[id];
		if (!node) return false;
		// 某些功能没有顶层 enabled（由子开关控制），任一子开关打开就算启用
		if (node.enabled === undefined) return deepAnyTrue(node);
		return node.enabled === true;
	}

	function deepAnyTrue(node) {
		if (typeof node !== "object" || node === null) return node === true;
		return Object.values(node).some(deepAnyTrue);
	}

	/** 改配置：本地立即生效 + 通知 Rust 落盘。 */
	function setConfig(id, key, value) {
		const node = (YTE.config[id] ??= {});
		const parts = key.split(".");
		let target = node;
		for (const part of parts.slice(0, -1)) {
			target = target[part] ??= {};
		}
		target[parts.at(-1)] = value;
		post({ type: "config:set", feature: id, key, value });
	}

	function post(message) {
		try {
			window.ipc.postMessage(JSON.stringify(message));
		} catch (err) {
			log("ipc 不可用", err);
		}
	}

	function replaceConfig(config) {
		YTE.config = config;
		window.__YTE_CONFIG__ = config;
		void syncAll({ force: true });
		window.dispatchEvent(new Event("wetube:config-reset"));
	}

	// ---------------------------------------------------------------- 页面类型

	function pageType() {
		const { pathname, search } = location;
		if (pathname === "/") return "home";
		// /live/<id> 是直播间的独立路径。以前它落到 "other"，而依赖里写
		// `pages: ["live"]` 的功能经 LIVE_ALIAS 映射后要的就是 "watch"，
		// 结果这类功能在直播间永远不生效。直播按 watch 页处理（与下面
		// LIVE_ALIAS 的语义一致），是不是真直播由功能自己判断。
		if (pathname.startsWith("/live")) return "watch";
		if (pathname.startsWith("/watch")) return "watch";
		if (pathname.startsWith("/shorts")) return "shorts";
		if (pathname.startsWith("/results")) return "search";
		if (pathname.startsWith("/feed/subscriptions")) return "subscriptions";
		if (pathname.startsWith("/playlist")) return "playlist";
		if (search.includes("list=")) return "playlist";
		if (/^\/(@|c\/|channel\/|user\/)[^/]+(\/(videos|shorts|streams|posts))?\/?$/.test(pathname)) {
			const tail = pathname.split("/").filter(Boolean).at(-1);
			if (tail === "shorts") return "channel_videos";
			if (tail === "streams") return "channel_streams";
			if (tail === "posts") return "channel_posts";
			return pathname.split("/").filter(Boolean).length > 1 ? "channel_videos" : "channel_home";
		}
		return "other";
	}

	// 直播是 watch 页的一种状态，功能依赖里写的 live 也按 watch 匹配，
	// 具体是不是直播由功能自己在播放器就绪后判断。
	const LIVE_ALIAS = { live: "watch" };

	function pageAllowed(pages) {
		if (!pages || pages.length === 0) return true;
		const current = pageType();
		return pages.some((page) => (LIVE_ALIAS[page] ?? page) === current);
	}

	// ---------------------------------------------------------------- 事件管理

	// 按功能名分命名空间，方便整个功能关掉时一次性摘干净。
	// 原版用强引用 Map，YouTube 频繁重建 DOM 会泄漏，这里改用 WeakMap。
	const listeners = new WeakMap();

	function addListener(target, type, handler, owner, options) {
		if (!target) return;
		let byOwner = listeners.get(target);
		if (!byOwner) {
			byOwner = new Map();
			listeners.set(target, byOwner);
		}
		let byType = byOwner.get(owner);
		if (!byType) {
			byType = new Map();
			byOwner.set(owner, byType);
		}
		let entries = byType.get(type);
		if (!entries) {
			entries = [];
			byType.set(type, entries);
		}
		if (entries.some((entry) => entry.handler === handler)) return;
		entries.push({ handler, options });
		target.addEventListener(type, handler, options);
	}

	function removeListeners(owner) {
		// WeakMap 没法遍历，所以另存一份 target 清单
		for (const target of ownedTargets.get(owner) ?? []) {
			const byOwner = listeners.get(target);
			const byType = byOwner?.get(owner);
			if (!byType) continue;
			for (const [type, entries] of byType) {
				for (const entry of entries) target.removeEventListener(type, entry.handler, entry.options);
			}
			byOwner.delete(owner);
		}
		ownedTargets.delete(owner);
	}

	const ownedTargets = new Map();

	function trackTarget(owner, target) {
		let set = ownedTargets.get(owner);
		if (!set) {
			set = new Set();
			ownedTargets.set(owner, set);
		}
		set.add(target);
	}

	function on(target, type, handler, owner, options) {
		trackTarget(owner, target);
		addListener(target, type, handler, owner, options);
	}

	// ---------------------------------------------------------------- DOM 等待

	function waitForElement(selector, { timeout = 5000, root = document, all = false } = {}) {
		return new Promise((resolve) => {
			const found = all ? root.querySelectorAll(selector) : root.querySelector(selector);
			if (all ? found.length : found) {
				resolve(found);
				return;
			}
			const observer = new MutationObserver(() => {
				const hit = all ? root.querySelectorAll(selector) : root.querySelector(selector);
				if (all ? hit.length : hit) {
					observer.disconnect();
					clearTimeout(timer);
					resolve(hit);
				}
			});
			observer.observe(root.documentElement ?? root, { childList: true, subtree: true });
			const timer = setTimeout(() => {
				observer.disconnect();
				resolve(all ? root.querySelectorAll(selector) : null);
			}, timeout);
		});
	}

	/** 等播放器对象就绪（YouTube 的 SPA 换视频时会短暂返回上一个视频的数据）。 */
	function waitForPlayer(timeout = 10000) {
		return new Promise((resolve) => {
			const start = performance.now();
			const tick = async () => {
				const player = getPlayer();
				if (player && (await playerReady(player))) {
					resolve(player);
					return;
				}
				if (performance.now() - start >= timeout) {
					resolve(null);
					return;
				}
				setTimeout(tick, 200);
			};
			void tick();
		});
	}

	async function playerReady(player) {
		try {
			const state = player.getPlayerStateObject?.();
			// 原来是 `!isUnstarted || !isBuffering`，两个条件只要有一个成立就真，
			// 等于把"播放器就绪"这道过滤整个放弃了——unstarted 的空播放器也会
			// 被认为就绪，后面 setPlaybackQuality/setVolume 就作用在空壳上。
			if (state && !state.isUnstarted) return true;
		} catch {
			/* 内部 API 可能不存在，走 video 兜底 */
		}
		const video = player.querySelector?.("video");
		return Boolean(video && video.readyState >= 2);
	}

	function getPlayer() {
		if (pageType() === "shorts") return document.querySelector("div#shorts-player");
		return document.querySelector("div#movie_player");
	}

	/** 取播放器数据，并校验它跟当前 URL 是同一个视频。 */
	async function videoData() {
		const player = getPlayer();
		if (!player?.getVideoData) return null;
		try {
			const data = await player.getVideoData();
			const urlId = new URLSearchParams(location.search).get("v");
			if (urlId && data?.video_id && data.video_id !== urlId) return null;
			return data ?? null;
		} catch {
			return null;
		}
	}

	// ---------------------------------------------------------------- 样式注入

	const styleNodes = new Map();

	function setStyle(id, css) {
		let node = styleNodes.get(id);
		if (!css) {
			node?.remove();
			styleNodes.delete(id);
			return;
		}
		if (!node || !node.isConnected) {
			node = document.createElement("style");
			node.id = id;
			(document.head ?? document.documentElement).appendChild(node);
			styleNodes.set(id, node);
		}
		node.textContent = css;
	}

	function toggleBodyClass(className, on) {
		document.body?.classList.toggle(className, Boolean(on));
	}

	// ---------------------------------------------------------------- 生命周期

	const active = new Map(); // id → { enabled, config }
	const syncQueues = new Map(); // id → Promise，同一功能的快速连续改动必须串行

	function shouldRun(id) {
		const feature = YTE.schema.features.find((item) => item.id === id);
		if (!feature) return false;
		return pageAllowed(feature.pages);
	}

	function syncFeature(id, options = {}) {
		const previous = syncQueues.get(id) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => syncFeatureNow(id, options));
		syncQueues.set(id, next);
		return next.finally(() => {
			if (syncQueues.get(id) === next) syncQueues.delete(id);
		});
	}

	async function syncFeatureNow(id, { force = false } = {}) {
		const impl = YTE.features[id];
		if (!impl) return;

		const feature = YTE.schema.features.find((item) => item.id === id);
		const enabled = isEnabled(id) && pageAllowed(feature?.pages);
		const previous = active.get(id);
		const config = cfg(id);

		if (!force && previous && previous.enabled === enabled && !configChanged(previous.config, config)) {
			return;
		}

		// 配置热更新和 SPA 导航都必须先拆掉旧实例。直接重复 enable 会留下旧的
		// wheel/timeupdate 监听器和 MutationObserver，使一次操作被执行多次；同时
		// disable 应拿到旧配置，而不是刚写入的新配置。
		if (previous?.enabled && (force || !enabled)) {
			try {
				await impl.disable?.(previous.config);
			} catch (err) {
				log(`功能 ${id} 停用失败`, err);
			} finally {
				removeListeners(id);
			}
		}

		if (enabled) {
			try {
				await impl.enable?.(config);
			} catch (err) {
				log(`功能 ${id} 启用失败`, err);
			}
		} else if (!previous?.enabled) {
			return;
		}
		active.set(id, { enabled, config: clone(config) });
	}

	function configChanged(a, b) {
		return JSON.stringify(a) !== JSON.stringify(b);
	}

	function clone(value) {
		return value == null ? value : JSON.parse(JSON.stringify(value));
	}

	async function syncAll({ force = false } = {}) {
		// 各功能之间互不依赖，串行 await 会被单个功能卡住整条链：
		// hideMastheadWhilePlaying 的 waitForPlayer(5s) 或字幕翻译的 30s 注入
		// deadline 一慢，后面二十多个功能就整体推迟生效。
		// allSettled 保证单个功能抛错也不会拖垮其余。
		await Promise.allSettled(
			Object.keys(YTE.features).map((id) => syncFeature(id, { force }))
		);
	}

	// ---------------------------------------------------------------- SPA 导航

  // YouTube 是单页应用，切视频不会重新加载文档，得自己重放功能。
  // 不再包装 history.pushState / replaceState：包装会在 YouTube 的 SPA 关键
  // 点击时序（close-flyout → pushState → 重新渲染侧栏）里插队 scheduleResync，
  // 制造竞态，导致侧栏（特别是 mini-guide flyout）子项点击后既不跳转也不
  // 响应。yt-navigate-finish + popstate + yt-page-data-updated 已经覆盖所有
  // 导航场景，scheduleResync 自身的 250ms 防抖也保证不抖动。
  let navigateTimer = null;

	  function scheduleResync() {
	    clearTimeout(navigateTimer);
	    navigateTimer = setTimeout(() => {
	      // watch → watch 时配置没变，但播放器、video 节点和当前频道已经变了。
	      void syncAll({ force: true });
	    }, 250);
	  }

  function installNavigationHooks() {
    for (const type of ["yt-navigate-start", "yt-navigate-finish", "yt-page-data-updated", "popstate"]) {
      window.addEventListener(type, scheduleResync, true);
    }
  }

	// ---------------------------------------------------------------- 启动

	async function start() {
		if (YTE.started) return;
		YTE.started = true;
		injectBaseStyles();
		installNavigationHooks();
		await syncAll({ force: true });
		log(`已就绪，${Object.keys(YTE.features).length} 个功能`);
	}

	/** 功能 CSS 全量注入一次，之后靠 body 上的 class 开关，不用反复改样式表。 */
	function injectBaseStyles() {
		const css = window.__YTE_STYLES;
		if (!css) return;
		const node = document.createElement("style");
		node.id = "yte-styles";
		node.textContent = css;
		(document.head ?? document.documentElement).appendChild(node);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", () => void start(), { once: true });
	} else {
		queueMicrotask(() => void start());
	}

	// ---------------------------------------------------------------- 导出

	Object.assign(YTE, {
		cfg,
		setConfig,
		replaceConfig,
		isEnabled,
		pageType,
		pageAllowed,
		waitForElement,
		waitForPlayer,
		getPlayer,
		videoData,
		setStyle,
		toggleBodyClass,
		on,
		off: removeListeners,
		syncAll,
		syncFeature,
		post,
		log,
	});
})();
