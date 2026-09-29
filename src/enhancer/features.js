/*
 * 功能实现：按 YouTube-Enhancer 的原逻辑用原生 JS 重写。
 *
 * 每个功能是一个 { enable(config), disable(config) } 对，由 runtime.js 按
 * 配置的 enabled 和当前页面类型调度。功能必须可重复 enable/disable（幂等）。
 *
 * 依赖播放器内部 API 的地方（getVideoData / setPlaybackQuality 等）都做了能力探测，
 * YouTube 改版拿不到就静默降级，不至于整个功能炸掉。
 */
(() => {
	const YTE = window.__YTE;
	if (!YTE) return;

	const {
		cfg,
		on,
		off,
		waitForElement,
		waitForPlayer,
		getPlayer,
		videoData,
		toggleBodyClass,
		setStyle,
		log,
	} = YTE;
	const F = YTE.features;

	const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

	/** 轮询重试：YouTube 是 SPA，播放器常常要等一会儿才就绪。 */
	async function retry(task, { attempts = 15, interval = 300, timeout = 10000 } = {}) {
		const start = performance.now();
		for (let i = 0; i < attempts; i += 1) {
			try {
				if (await task()) return true;
			} catch {
				/* 继续重试 */
			}
			if (performance.now() - start >= timeout) break;
			await sleep(interval);
		}
		return false;
	}

	async function withPlayer(handler) {
		const player = await waitForPlayer();
		if (!player) return;
		await handler(player);
	}

	// ---------------------------------------------------------------- 屏显提示

	// 屏显本身没有开关，它是一组给滚轮调音量/调速度用的显示参数，
	// 注册成空功能只是为了设置面板能把它标成「已实现」。
	F.onScreenDisplay = { enable: () => {}, disable: () => {} };

	// 下载设置同样没有页面行为：悬浮球/面板逻辑独立在 download-panel.js，
	// 注册空功能是为了 (1) 设置面板显示「已实现」；(2) 开关切换时 runtime
	// 会调用 enable/disable，借这个时机通知悬浮球重新按配置显隐。
	F.downloadSettings = {
		enable: () => { window.__wetubeDlSyncSettings?.(); },
		disable: () => { window.__wetubeDlSyncSettings?.(); },
	};

	const OSD_COLORS = {
		white: "#ffffff", red: "#ff4444", green: "#44dd44", blue: "#4488ff",
		yellow: "#ffdd44", orange: "#ff9944", purple: "#aa66ff", pink: "#ff77bb",
	};

	function showOsd(player, { text, value, max }) {
		const osd = cfg("onScreenDisplay");
		if (!osd?.enabled || osd.type === "no_display") return;
		if (!player) return;

		const host = player.parentElement?.parentElement ?? player;
		let canvas = document.getElementById("yte-osd");
		if (!canvas) {
			canvas = document.createElement("canvas");
			canvas.id = "yte-osd";
			canvas.style.cssText = "position:absolute;z-index:2021;pointer-events:none";
			host.appendChild(canvas);
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const color = OSD_COLORS[osd.color] ?? "#ffffff";
		const opacity = clamp(osd.opacity ?? 75, 1, 100) / 100;
		const padding = clamp(osd.padding ?? 5, 0, 100);
		const rect = (player.getBoundingClientRect?.() ?? { width: 640, height: 360 });

		let width = 0;
		let height = 0;
		let fontSize = clamp(Math.min(rect.width, rect.height) / 10, 24, 72);

		if (osd.type === "line") {
			width = Math.round((clamp(value / max, 0, 1) * rect.width) / 2);
			height = 5;
		} else if (osd.type === "circle") {
			width = height = 80;
		} else {
			fontSize = clamp(fontSize, 24, 72);
			ctx.font = `600 ${fontSize}px sans-serif`;
			width = Math.ceil(ctx.measureText(text).width) + 15;
			height = fontSize + 15;
		}

		canvas.width = Math.max(width, 1);
		canvas.height = Math.max(height, 1);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.globalAlpha = opacity;
		ctx.fillStyle = color;
		ctx.strokeStyle = color;
		ctx.shadowColor = "rgba(0,0,0,0.9)";
		ctx.shadowBlur = 10;

		if (osd.type === "line") {
			ctx.fillRect(0, 0, canvas.width, canvas.height);
		} else if (osd.type === "circle") {
			ctx.lineWidth = 5;
			ctx.beginPath();
			ctx.arc(40, 40, 37.5, -Math.PI / 2, -Math.PI / 2 + clamp(value / max, 0, 1) * Math.PI * 2);
			ctx.stroke();
		} else {
			ctx.font = `600 ${fontSize}px sans-serif`;
			ctx.textBaseline = "middle";
			ctx.fillText(text, 7, canvas.height / 2 + 2);
		}

		const position = osd.position ?? "center";
		const style = canvas.style;
		style.top = style.bottom = style.left = style.right = "";
		style.transform = "";
		if (position === "top_left") {
			style.top = `${padding}px`; style.left = `${padding}px`;
		} else if (position === "top_right") {
			style.top = `${padding}px`; style.right = `${padding}px`;
		} else if (position === "bottom_left") {
			style.bottom = `${padding}px`; style.left = `${padding}px`;
		} else if (position === "bottom_right") {
			style.bottom = `${padding}px`; style.right = `${padding}px`;
		} else {
			style.top = "50%"; style.left = "50%"; style.transform = "translate(-50%,-50%)";
		}

		clearTimeout(showOsd.timer);
		showOsd.timer = setTimeout(() => canvas.remove(), osd.hideTime ?? 750);
	}

	// ---------------------------------------------------------------- 纯 CSS 类功能

	/** 只有一个 body class 的功能，用这个工厂就够了。 */
	const byClass = (className) => ({
		enable: () => toggleBodyClass(className, true),
		disable: () => toggleBodyClass(className, false),
	});

	/** MutationObserver 生命周期样板：挂在 body 上、引用记到 feature 身上。 */
	const watchMutations = (feature, callback, options) => {
		const observer = new MutationObserver(callback);
		observer.observe(document.body, options);
		feature.observer = observer;
	};

	/** 与 watchMutations 配对的摘除。 */
	const unwatchMutations = (feature) => {
		feature.observer?.disconnect();
		feature.observer = null;
	};

	F.hidePosts = byClass("yte-hide-posts");
	F.hidePlayables = byClass("yte-hide-playables");
	F.hideMembersOnlyVideos = byClass("yte-hide-members-only-videos");
	F.hideOfficialArtistVideosFromHomePage = byClass("yte-hide-official-artist-videos-from-home-page");
	F.hidePlaylistRecommendationsFromHomePage = byClass("yte-hide-playlist-recommendations-from-home-page");
	F.hideSidebarRecommendedVideos = byClass("yte-hide-sidebar-recommended-videos");
	F.hideArtificialIntelligence = byClass("yte-hide-ai");
	F.hideTranslateComment = byClass("yte-hide-translate-comment");
	F.hidePaidPromotionBanner = byClass("yte-hide-paid-promotion-banner");
	F.hideEndScreenCards = byClass("yte-hide-end-screen-cards");
	F.hideScrollBar = byClass("yte-hide-scroll-bar");

	// 隐藏 Shorts：6 个位置各自独立开关
	const SHORTS_CLASSES = {
		home: "yte-hide-shorts-home",
		search: "yte-hide-shorts-search",
		sidebar: "yte-hide-shorts-sidebar",
		subscriptions: "yte-hide-shorts-subscriptions",
		channel: "yte-hide-shorts-channel",
		videos: "yte-hide-shorts-videos",
	};

	F.hideShorts = {
		enable() {
			for (const [key, className] of Object.entries(SHORTS_CLASSES)) {
				toggleBodyClass(className, Boolean(cfg("hideShorts", `${key}.enabled`)));
			}
		},
		disable() {
			for (const className of Object.values(SHORTS_CLASSES)) toggleBodyClass(className, false);
		},
	};

	// 隐藏直播聊天：只在真的是直播时生效
	F.hideLiveStreamChat = {
		enable: async () => {
			const data = await videoData();
			toggleBodyClass("yte-hide-live-stream-chat", Boolean(data?.isLive) || location.pathname.startsWith("/live/"));
		},
		disable: () => toggleBodyClass("yte-hide-live-stream-chat", false),
	};

	// 播放时隐藏 YouTube 顶栏（搜索框那一排）
	//
	// 只在视频真的在播的时候收起，暂停、鼠标移到顶部一栏、或者按「/」想搜索时
	// 立刻放出来。判「在播」直接用 <video> 自己的 paused，不去碰播放器内部 API：
	// 改版不易失效，而且缓冲期间 paused 仍是 false，不会来回闪。
	//
	// media 事件不冒泡，所以在 document 上用捕获阶段接，YouTube 换掉 video 元素
	// 也不用重新挂监听。
	const MASTHEAD_CLASS = "yte-hide-masthead-playing";
	const MASTHEAD_OWNER = "hideMastheadWhilePlaying";

	let mastheadPointerNear = false;
	let mastheadFocusInside = false;
	let mastheadRevealTimer = null;
	// 顶部感应区的下边界：chrome(36) + 顶栏(56) + 一点富余。顶栏藏起来后量不到
	// 高度，所以只在它可见时更新，藏起来期间沿用上次的值。
	let mastheadRevealLimit = 100;

	const mastheadEl = () => document.querySelector("ytd-masthead, #masthead-container");

	function videoPlaying() {
		const video = getPlayer()?.querySelector("video");
		return Boolean(video && !video.paused && !video.ended);
	}

	function syncMasthead() {
		const bar = mastheadEl();
		const rect = bar?.getBoundingClientRect();
		if (rect?.height) mastheadRevealLimit = rect.bottom + 8;

		const hidden = videoPlaying() && !mastheadPointerNear && !mastheadFocusInside && !mastheadRevealTimer;
		toggleBodyClass(MASTHEAD_CLASS, hidden);
	}

	/** 临时放出来（按了「/」之类的），几秒后自己收回去。 */
	function revealMastheadTemporarily(ms = 3000) {
		clearTimeout(mastheadRevealTimer);
		mastheadRevealTimer = setTimeout(() => {
			mastheadRevealTimer = null;
			syncMasthead();
		}, ms);
		syncMasthead();
	}

	function onMastheadPointerMove(event) {
		const near = event.clientY <= mastheadRevealLimit;
		if (near === mastheadPointerNear) return;
		mastheadPointerNear = near;
		syncMasthead();
	}

	function onMastheadPointerLeave() {
		if (!mastheadPointerNear) return;
		mastheadPointerNear = false;
		syncMasthead();
	}

	function onMastheadFocusIn(event) {
		const bar = mastheadEl();
		const path = event.composedPath?.() ?? [];
		mastheadFocusInside = Boolean(bar && path.includes(bar));
		syncMasthead();
	}

	function onMastheadFocusOut() {
		mastheadFocusInside = false;
		syncMasthead();
	}

	function onMastheadKeyDown(event) {
		// 顶栏藏起来时 display:none 的搜索框没法聚焦，「/」就成死键了——先放出来。
		if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
		const target = event.target;
		const tag = target?.tagName?.toLowerCase();
		if (tag === "input" || tag === "textarea" || target?.isContentEditable) return;
		revealMastheadTemporarily();
	}

	function attachMastheadHooks() {
		// 捕获阶段才能在 document 上收到不冒泡的 media 事件
		for (const type of ["play", "playing", "pause", "ended", "emptied", "loadedmetadata"]) {
			on(document, type, syncMasthead, MASTHEAD_OWNER, true);
		}
		on(document, "mousemove", onMastheadPointerMove, MASTHEAD_OWNER);
		on(document, "mouseleave", onMastheadPointerLeave, MASTHEAD_OWNER);
		on(document, "focusin", onMastheadFocusIn, MASTHEAD_OWNER, true);
		on(document, "focusout", onMastheadFocusOut, MASTHEAD_OWNER, true);
		on(document, "keydown", onMastheadKeyDown, MASTHEAD_OWNER, true);
	}

	F.hideMastheadWhilePlaying = {
		enable: async () => {
			attachMastheadHooks();
			syncMasthead();
			// 首屏播放器可能还没就绪，等它一下再校一次（比如半路打开这个开关）
			await waitForPlayer(5000);
			syncMasthead();
		},
		disable: () => {
			clearTimeout(mastheadRevealTimer);
			mastheadRevealTimer = null;
			mastheadPointerNear = false;
			mastheadFocusInside = false;
			toggleBodyClass(MASTHEAD_CLASS, false);
		},
	};

	// 片尾铺满推荐视频
	F.automaticallyShowMoreVideosOnEndScreen = {
		enable: () => {
			toggleBodyClass("yte-hide-ytp-fullscreen-grid", true);
			toggleBodyClass("yte-show-html5-endscreen", true);
		},
		disable: () => {
			toggleBodyClass("yte-hide-ytp-fullscreen-grid", false);
			toggleBodyClass("yte-show-html5-endscreen", false);
		},
	};

	// 恢复全屏下的滚轮滚动：class 加在 ytd-app 和 ytd-watch-flexy 上
	F.restoreFullscreenScrolling = {
		enable: async () => {
			const app = await waitForElement("ytd-app", { timeout: 3000 });
			const flexy = await waitForElement("ytd-watch-flexy, ytd-watch-grid", { timeout: 3000 });
			app?.classList.add("yte-ytd-app-restore-fullscreen-scrolling");
			flexy?.classList.add("yte-ytd-watch-flexy-restore-fullscreen-scrolling");
		},
		disable: () => {
			document.querySelector("ytd-app")?.classList.remove("yte-ytd-app-restore-fullscreen-scrolling");
			document.querySelector("ytd-watch-flexy, ytd-watch-grid")?.classList.remove("yte-ytd-watch-flexy-restore-fullscreen-scrolling");
		},
	};

	// ---------------------------------------------------------------- 自定义 CSS / 主题

	F.customCSS = {
		enable: ({ code } = {}) => setStyle("yte-custom-css", code || ""),
		disable: () => setStyle("yte-custom-css", ""),
	};

	F.deepDarkCSS = {
		enable({ preset, colors } = {}) {
			const presets = window.__YTE_DEEPDARK_PRESETS ?? {};
			const block = preset === "Custom" ? customColors(colors) : presets[preset];
			if (!block) return;
			setStyle("yte-deep-dark", `${block}\n${window.__YTE_DEEPDARK_MATERIAL ?? ""}`);
			document.documentElement.setAttribute("data-yte-deep-dark", preset ?? "Custom");
		},
		disable() {
			setStyle("yte-deep-dark", "");
			document.documentElement.removeAttribute("data-yte-deep-dark");
		},
	};

	function customColors(colors) {
		if (!colors) return "";
		return [
			":root {",
			`  --main-color: ${colors.mainColor};`,
			`  --main-background: ${colors.mainBackground};`,
			`  --second-background: ${colors.secondBackground};`,
			`  --hover-background: ${colors.hoverBackground};`,
			`  --main-text: ${colors.mainText};`,
			`  --dimmer-text: ${colors.dimmerText};`,
			`  --shadow: 0 1px 0.5px ${colors.colorShadow};`,
			"}",
		].join("\n");
	}

	F.videosPerRow = {
		enable: ({ videosPerRow: count } = {}) => {
			toggleBodyClass("yte-videos-per-row", true);
			document.body?.style.setProperty("--yte-videos-per-row-count", String(clamp(count ?? 4, 1, 12)));
		},
		disable: () => {
			toggleBodyClass("yte-videos-per-row", false);
			document.body?.style.removeProperty("--yte-videos-per-row-count");
		},
	};

	// ---------------------------------------------------------------- 键盘与链接

	// 禁用数字键跳转（输入框里不受影响）
	F.blockNumberKeySeeking = {
		enable() {
			const handler = (event) => {
				const target = event.target;
				if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
				if (/^[0-9]$/.test(event.key)) {
					event.stopImmediatePropagation();
					event.preventDefault();
				}
			};
			on(document, "keydown", handler, "blockNumberKeySeeking", { capture: true });
		},
		disable: () => off("blockNumberKeySeeking"),
	};

	// 把 /redirect?q=xxx 还原成真实地址
	F.removeRedirect = {
		enable() {
			const PREFIX = "https://www.youtube.com/redirect?";
			const unwrap = (el) => {
				const href = el.getAttribute?.("href");
				if (!href || !href.startsWith(PREFIX)) return;
				try {
					const target = new URL(href).searchParams.get("q");
					if (target) el.setAttribute("href", target);
				} catch {
					/* 忽略畸形 URL */
				}
			};
			const process = (node) => {
				if (!(node instanceof Element)) return;
				unwrap(node);
				node.querySelectorAll?.("[href]").forEach(unwrap);
			};
			document.querySelectorAll("[href]").forEach(unwrap);
			watchMutations(F.removeRedirect, (mutations) => {
				for (const mutation of mutations) {
					if (mutation.type !== "childList") continue;
					mutation.addedNodes.forEach(process);
				}
			}, { childList: true, subtree: true });
		},
		disable: () => unwatchMutations(F.removeRedirect),
	};

	// 精简分享链接：去掉 si、feature 之类的附加参数
	F.shareShortener = {
		enable() {
			const clean = () => {
				const input = document.querySelector("#share-url-container input, tp-yt-paper-input input");
				if (!input?.value) return;
				try {
					const url = new URL(input.value);
					for (const key of ["si", "feature", "utm_source", "utm_medium", "utm_campaign"]) url.searchParams.delete(key);
					input.value = url.href;
				} catch { /* 保留无法解析的输入 */ }
			};
			watchMutations(F.shareShortener, clean, { childList: true, subtree: true, attributes: true });
			clean();
		},
		disable: () => unwatchMutations(F.shareShortener),
	};

	// 跳过「继续观看」：把 YouTube 的续播回调替换成空函数
	F.skipContinueWatching = {
		enable() {
			const el = document.querySelector("ytd-watch-grid, ytd-watch-flexy");
			if (!el) return;
			F.skipContinueWatching.original = el.youthereDataChanged_;
			el.youthereDataChanged_ = () => {};
		},
		disable() {
			const el = document.querySelector("ytd-watch-grid, ytd-watch-flexy");
			if (!el) return;
			const original = F.skipContinueWatching.original;
			if (original) el.youthereDataChanged_ = original;
			else delete el.youthereDataChanged_;
		},
	};

	// ---------------------------------------------------------------- 播放器自动化

	// 自动关掉自动播放。用户自己打开过一次之后就不再干预。
	F.automaticallyDisableAutoPlay = {
		enable: () =>
			void retry(() => {
				const toggle = document.querySelector(".ytp-autonav-toggle-button");
				if (!toggle) return false;
				if (toggle.getAttribute("aria-checked") !== "true") return true;
				document.querySelector(".ytp-autonav-toggle")?.click();
				return toggle.getAttribute("aria-checked") === "false";
			}, { attempts: 12, interval: 250, timeout: 6000 }),
		disable: () => {},
	};

	const subtitlesButton = () => document.querySelector("button.ytp-subtitles-button");

	/** 用 retry 把 CC 按钮切换到目标状态（aria-pressed === want）。 */
	const setClosedCaptions = (want) =>
		void retry(() => {
			const button = subtitlesButton();
			if (!button) return false;
			if (button.getAttribute("aria-pressed") === String(want)) return true;
			button.click();
			return true;
		}, { attempts: 12, interval: 250, timeout: 6000 });

	F.automaticallyDisableClosedCaptions = {
		enable: () => setClosedCaptions(false),
		disable: () => {},
	};

	F.automaticallyEnableClosedCaptions = {
		enable: () => setClosedCaptions(true),
		disable: () => getPlayer()?.unloadModule?.("captions"),
	};

	// 自动进影院模式
	const sizeButton = () => document.querySelector("button.ytp-size-button");
	const inTheaterMode = () =>
		Boolean(document.querySelector("ytd-watch-grid[theater], ytd-watch-flexy[theater]"));

	F.automaticTheaterMode = {
		enable: () =>
			void retry(() => {
				if (inTheaterMode()) return true;
				sizeButton()?.click();
				return inTheaterMode();
			}, { attempts: 20, interval: 300, timeout: 8000 }),
		disable: () =>
			void retry(() => {
				if (!inTheaterMode()) return true;
				sizeButton()?.click();
				return !inTheaterMode();
			}, { attempts: 20, interval: 300, timeout: 8000 }),
	};

	// 自动最大化播放器
	F.automaticallyMaximizePlayer = {
		enable: () => {
			document.body?.setAttribute("yte-maximized", "");
			document.body?.style.setProperty("--yte-video-height", "100vh");
		},
		disable: () => {
			document.body?.removeAttribute("yte-maximized");
			document.body?.style.removeProperty("--yte-video-height");
		},
	};

	// 自动关掉氛围模式：展开设置菜单，按文字找到那一项
	const AMBIENT_LABELS = ["氛围模式", "Ambient mode", "Modo ambiente", "Mode ambiant", "アンビエントモード"];

	F.automaticallyDisableAmbientMode = {
		enable: () =>
			void retry(() => {
				const container = document.querySelector("ytd-watch-grid, ytd-watch-flexy");
				if (!container?.hasAttribute("cinematics-active")) return true;
				const settingsButton = document.querySelector("button.ytp-settings-button");
				if (!settingsButton) return false;
				settingsButton.click();
				const menu = document.querySelector("div.ytp-settings-menu");
				if (!menu) return false;
				const item = [...menu.querySelectorAll(".ytp-menuitem")].find((node) =>
					AMBIENT_LABELS.some((label) => node.textContent?.includes(label))
				);
				if (!item) return false;
				const checkbox = item.querySelector(".ytp-menuitem-toggle-checkbox");
				if (checkbox && item.getAttribute("aria-checked") === "true") item.click();
				settingsButton.click();
				return !container.hasAttribute("cinematics-active");
			}, { attempts: 10, interval: 400, timeout: 8000 }),
		disable: () => {},
	};

	// 悬停展开播放器设置菜单
	F.openYouTubeSettingsOnHover = {
		enable() {
			const button = document.querySelector("button.ytp-settings-button");
			if (!button) return;
			let hideTimer = null;
			const open = () => {
				clearTimeout(hideTimer);
				if (!document.querySelector("div.ytp-settings-menu")) button.click();
			};
			const close = () => {
				hideTimer = setTimeout(() => {
					if (document.querySelector("div.ytp-settings-menu")) button.click();
				}, 50);
			};
			on(button, "mouseenter", open, "openYouTubeSettingsOnHover");
			on(button, "mouseleave", close, "openYouTubeSettingsOnHover");
			on(document, "mouseover", (event) => {
				if (event.target?.closest?.("div.ytp-settings-menu")) {
					clearTimeout(hideTimer);
				}
			}, "openYouTubeSettingsOnHover");
		},
		disable: () => off("openYouTubeSettingsOnHover"),
	};

	// ---------------------------------------------------------------- 播放控制

	// 默认播放速度（可按频道覆盖）
	F.playerSpeed = {
		enable: async ({ speed, channelSpeeds } = {}) => {
			const data = await videoData();
			if (!data) return;
			const perChannel = parseChannelSpeeds(channelSpeeds);
			const channelId = data.author?.channel_id ?? data.channelId;
			const target = perChannel[channelId] ?? speed ?? 1;
			if (!target || target === 1) return;
			const player = await waitForPlayer();
			if (!player) return;
			await player.setPlaybackRate?.(clamp(Number(target), 0.25, 16));
			const video = player.querySelector("video");
			if (video) video.playbackRate = clamp(Number(target), 0.25, 16);
		},
		disable: async () => {
			const player = getPlayer();
			if (!player) return;
			await player.setPlaybackRate?.(1);
			const video = player.querySelector("video");
			if (video) video.playbackRate = 1;
		},
	};

	function parseChannelSpeeds(text) {
		const map = {};
		if (!text) return map;
		for (const line of String(text).split("\n")) {
			const [id, value] = line.split("=").map((part) => part.trim());
			const numeric = Number(value);
			if (id && Number.isFinite(numeric)) map[id] = numeric;
		}
		return map;
	}

	// 默认画质
	F.playerQuality = {
		enable: async ({ quality } = {}) => {
			if (!quality || quality === "auto") return;
			const player = await waitForPlayer();
			if (!player) return;
			await retry(async () => {
				try {
					if (player.setPlaybackQualityRange) await player.setPlaybackQualityRange(quality);
					else if (player.setPlaybackQuality) await player.setPlaybackQuality(quality);
					else return false;
					const current = await player.getPlaybackQuality?.();
					return !current || current === quality || !isBetter(current, quality);
				} catch {
					return false;
				}
			}, { attempts: 10, interval: 500, timeout: 10000 });
		},
		disable: async () => {
			const player = getPlayer();
			await player?.setPlaybackQualityRange?.("auto");
		},
	};

	const QUALITY_ORDER = ["tiny", "small", "medium", "large", "hd720", "hd1080", "hd1440", "hd2160", "hd2880", "highres"];
	function isBetter(current, desired) {
		return QUALITY_ORDER.indexOf(current) > QUALITY_ORDER.indexOf(desired);
	}

	// 固定音量
	let originalVolume = null;

	F.globalVolume = {
		enable: ({ volume } = {}) =>
			void withPlayer(async (player) => {
				if (!player.setVolume) return;
				if (originalVolume === null) originalVolume = await player.getVolume?.();
				await player.setVolume(clamp(Number(volume) || 0, 0, 100));
				if (await player.isMuted?.()) await player.unMute?.();
			}),
		disable: () =>
			void withPlayer(async (player) => {
				if (originalVolume !== null) await player.setVolume?.(originalVolume);
				originalVolume = null;
			}),
	};

	// 记住音量（普通视频和 Shorts 分开记）
	const volumeState = () => ({
		watch: Number(localStorage.getItem("yte-volume-watch") ?? 0),
		shorts: Number(localStorage.getItem("yte-volume-shorts") ?? 0),
	});

	F.rememberVolume = {
		enable: async () => {
			const player = await waitForPlayer();
			if (!player?.setVolume) return;
			const saved = volumeState();
			const target = YTE.pageType() === "shorts" ? saved.shorts : saved.watch;
			if (target) await player.setVolume(clamp(target, 0, 100));

			const video = player.querySelector("video");
			if (!video) return;
			on(video, "volumechange", async () => {
				const current = await player.getVolume?.();
				if (!Number.isFinite(current)) return;
				localStorage.setItem(
					YTE.pageType() === "shorts" ? "yte-volume-shorts" : "yte-volume-watch",
					String(current)
				);
			}, "rememberVolume");
		},
		disable: () => off("rememberVolume"),
	};

	// 滚轮调节共用的三件套：挂载宿主（播放器容器）、菜单守卫（设置菜单上
	// 滚动不该改音量/速度）、preventDefault（挡掉页面滚动）。
	const wheelHost = (player) => document.querySelector("div#player") ?? player;
	const wheelOnSettingsMenu = (event) => Boolean(event.target?.closest?.("div.ytp-settings-menu"));

	// 滚轮调音量
	F.scrollWheelVolumeControl = {
		enable: async (config = {}) => {
			const player = await waitForPlayer();
			if (!player) return;
			toggleBodyClass("yte-scroll-wheel-volume-control", true);
			const { steps = 5, modifierKey = "ctrlKey", holdModifierKey = false, holdRightClick = false } = config;
			on(wheelHost(player), "wheel", async (event) => {
				if (holdModifierKey && !event[modifierKey]) return;
				if (holdRightClick && event.buttons !== 2) return;
				if (wheelOnSettingsMenu(event)) return;
				event.preventDefault();
				const current = (await player.getVolume?.()) ?? 0;
				const delta = (event.deltaY < 0 ? 1 : -1) * Number(steps);
				const next = clamp(Math.round((current + delta) / steps) * steps, 0, 100);
				await player.setVolume?.(next);
				if (await player.isMuted?.()) await player.unMute?.();
				showOsd(player, { text: `${next}%`, value: next, max: 100 });
			}, "scrollWheelVolumeControl", { passive: false });
		},
		disable: () => {
			toggleBodyClass("yte-scroll-wheel-volume-control", false);
			off("scrollWheelVolumeControl");
		},
	};

	// 滚轮调倍速（需要按住修饰键）
	F.scrollWheelSpeedControl = {
		enable: async (config = {}) => {
			const player = await waitForPlayer();
			if (!player) return;
			const { steps = 0.25, modifierKey = "altKey" } = config;
			on(wheelHost(player), "wheel", async (event) => {
				if (!event[modifierKey]) return;
				if (wheelOnSettingsMenu(event)) return;
				event.preventDefault();
				const video = player.querySelector("video");
				if (!video) return;
				const delta = (event.deltaY < 0 ? 1 : -1) * Number(steps);
				const next = clamp(Math.round((video.playbackRate + delta) / steps) * steps, 0.25, 16);
				await player.setPlaybackRate?.(next);
				video.playbackRate = next;
				showOsd(player, { text: `${next}x`, value: next, max: 16 });
			}, "scrollWheelSpeedControl", { passive: false });
		},
		disable: () => off("scrollWheelSpeedControl"),
	};

	// 默认原声音轨
	F.defaultToOriginalAudioTrack = {
		enable: () =>
			void withPlayer(async (player) => {
				if (!player.getAvailableAudioTracks || !player.setAudioTrack) return;
				try {
					const tracks = (await player.getAvailableAudioTracks()) ?? [];
					const original = tracks.find((track) => track.isDefault || track.name?.match(/original/i));
					if (original) await player.setAudioTrack(original);
				} catch (err) {
					log("切换音轨失败", err);
				}
			}),
		disable: () => {},
	};

	// ---------------------------------------------------------------- 时间与进度

	// 显示剩余时间
	F.remainingTime = {
		enable: async () => {
			const player = await waitForPlayer();
			if (!player) return;
			const data = await videoData();
			if (data?.isLive) return;
			const display = await waitForElement(".ytp-time-contents", { timeout: 3000, root: player });
			if (!display) return;
			const span = document.createElement("span");
			span.id = "ytp-time-remaining";
			span.style.marginLeft = "4px";
			display.appendChild(span);

			const video = player.querySelector("video");
			if (!video) return;
			const update = () => {
				const remaining = video.duration - video.currentTime;
				if (Number.isFinite(remaining) && remaining > 0) span.textContent = ` -${formatTime(remaining)}`;
			};
			on(video, "timeupdate", update, "remainingTime");
			update();
		},
		disable: () => {
			document.querySelector("span#ytp-time-remaining")?.remove();
			off("remainingTime");
		},
	};

	function formatTime(seconds) {
		const total = Math.floor(seconds);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const pad = (value) => String(value).padStart(2, "0");
		return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
	}

	// Shorts 播完自动滚到下一条
	F.shortsAutoScroll = {
		enable: async () => {
			const container = await waitForElement("#shorts-player", { timeout: 5000 });
			const video = container?.querySelector("video");
			if (!video) return;
			on(video, "ended", () => {
				const next = document.querySelector("#navigation-button-down button, button.yt-spec-button-shape-next");
				next?.click();
			}, "shortsAutoScroll");
		},
		disable: () => off("shortsAutoScroll"),
	};

	// 观看进度记忆
	const HISTORY_KEY = "yte-video-history";

	function readHistory() {
		try {
			return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "{}");
		} catch {
			return {};
		}
	}

	function writeHistory(history) {
		const trimmed = Object.fromEntries(
			Object.entries(history)
				.sort((a, b) => b[1].updatedAt - a[1].updatedAt)
				.slice(0, 500)
		);
		localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
	}

	F.videoHistory = {
		enable: async ({ resumeType = "prompt" } = {}) => {
			const player = await waitForPlayer();
			if (!player) return;
			const data = await videoData();
			const videoId = data?.video_id ?? new URLSearchParams(location.search).get("v");
			if (!videoId) return;
			const video = player.querySelector("video");
			if (!video) return;

			const history = readHistory();
			const saved = history[videoId];
			if (saved && saved.time > 10 && saved.time < saved.duration - 15) {
				if (resumeType === "automatic") {
					video.currentTime = saved.time;
				} else {
					showResumePrompt(video, saved.time);
				}
			}

			on(video, "timeupdate", () => {
				const snapshot = readHistory();
				snapshot[videoId] = {
					time: video.currentTime,
					duration: video.duration,
					title: data?.title ?? document.title,
					updatedAt: Date.now(),
				};
				writeHistory(snapshot);
			}, "videoHistory");
		},
		disable: () => {
			document.getElementById("yte-resume-prompt")?.remove();
			off("videoHistory");
		},
	};

	function showResumePrompt(video, time) {
		document.getElementById("yte-resume-prompt")?.remove();
		const box = document.createElement("div");
		box.id = "yte-resume-prompt";
		box.style.cssText =
			"position:fixed;left:24px;bottom:24px;z-index:2147483000;background:rgba(24,24,24,.94);color:#fff;" +
			"padding:14px 18px;border-radius:10px;font:14px/1.5 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45)";
		// YouTube 开启了 Trusted Types，禁止 innerHTML 赋裸字符串，用 DOM 拼接。
		const line = document.createElement("div");
		const lead = document.createElement("span");
		lead.textContent = "上次看到 ";
		const bold = document.createElement("b");
		bold.textContent = formatTime(time);
		line.append(lead, bold);
		box.appendChild(line);
		const jump = document.createElement("button");
		jump.textContent = "继续播放";
		jump.style.cssText =
			"margin-top:10px;padding:6px 14px;border:0;border-radius:6px;background:#367bf0;color:#fff;cursor:pointer;font:600 13px system-ui";
		jump.onclick = () => {
			video.currentTime = time;
			box.remove();
		};
		const dismiss = document.createElement("button");
		dismiss.textContent = "从头开始";
		dismiss.style.cssText =
			"margin-top:10px;margin-left:8px;padding:6px 14px;border:0;border-radius:6px;background:#3a3a3a;color:#fff;cursor:pointer;font:600 13px system-ui";
		dismiss.onclick = () => box.remove();
		box.append(jump, dismiss);
		document.body.appendChild(box);
		setTimeout(() => box.remove(), 15000);
	}

	// ------------------------------------------------------------ 字幕双语翻译

	// 抓 YouTube 原生字幕（.ytp-caption-segment）送 Rust 翻译，译文渲染在原
	// 字幕正下方。产品思路参考 read-frog（GPL-3.0），按 WeTube 的模型重写：
	// 页面源是 youtube.com，直连翻译接口会被 CORS 拦，所以请求必须经
	// window.ipc → Rust 后端转发，结果由 Rust eval 回 __wetubeOnSubtitleTranslated。
	const CAPTION_CONTAINER = ".ytp-caption-window-container";
	const CAPTION_SEGMENT = ".ytp-caption-segment";
	const SUBTITLE_BUTTON_ID = "yte-subtitle-translate-btn";

	const subtitleState = {
		generation: 0,
		controller: null,
		// 引擎开关（控制栏按钮控制）。SPA 内跨视频保留：开了之后切视频继续翻译，
		// 应用重启后回到关闭状态。
		on: false,
		// 引擎模式："track"（轨道数据，移植 read-frog，CC 不开也能翻）/ "dom"（读渲染中的字幕，兜底）。
		mode: null,
		observer: null,
		navigateHandler: null,
		resizeHandler: null,
		overlay: null,
		container: null,
		player: null,
		button: null,
		lastSent: "",
		lastSentAt: 0,
		seq: 0,
		debounce: 0,
		// 诊断计数：发送了多少条翻译请求、回来多少、最后一条结果。
		sent: 0,
		recv: 0,
		lastError: "",
		// 字幕容器的 DOM 变更次数：>0 说明监听在跑、只是没读到字幕文本
		//（典型即 CC 没开），=0 说明容器压根没动过。
		mutCount: 0,
		// Rust 收到翻译消息后的立即回执数：发N/Ack0 = 消息没到 Rust，
		// 发N/AckN/回0 = 到了但结果没回传。与日志文件配合定位断点。
		ack: 0,
		// 开了引擎却迟迟抓不到字幕的提示定时器（多半是 CC 字幕没开）。
		hintTimer: 0,
		// ---- 轨道模式（read-frog 路线）----
		cues: null, // [{start, end, text, translated?}] 毫秒时间轴
		cueVideoId: "",
		cueTrackHash: "",
		batchId: 0,
		batchIndexById: {}, // 批量请求 id -> { 块起点, 发起时的字幕数组 }
		pendingBatches: 0, // 在途批量块数
		translatedCount: 0,
		timeHandler: null,
		videoEl: null,
	};

	/** 抓当前字幕原文：同一行字幕拆成多个 segment，按序拼接。 */
	function readCaptionText() {
		const segments = subtitleState.container?.querySelectorAll(CAPTION_SEGMENT);
		if (!segments || segments.length === 0) return "";
		return Array.from(segments)
			.map((node) => node.textContent ?? "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function applyReplaceMode() {
		// 只显示译文：把原生字幕隐掉。布局仍占位，方便译文对齐原字幕位置。
		const replace = cfg("subtitleTranslation", "replaceOriginal") === true;
		if (subtitleState.container) {
			subtitleState.container.style.visibility = replace ? "hidden" : "";
		}
	}

	/** 字号档位 → 像素。标准档即 YouTube 原生字幕的视觉大小。 */
	const SUBTITLE_FONT_SIZES = {
		小: 20,
		标准: 26,
		大: 34,
		特大: 44,
		超大: 56,
	};

	/** 把设置里的字号档位应用到译文层；改设置的即时生效（enable 会重跑）。 */
	function applyOverlayFont() {
		if (!subtitleState.overlay) return;
		const level = cfg("subtitleTranslation", "fontSize") || "标准";
		const px = SUBTITLE_FONT_SIZES[level] ?? 26;
		subtitleState.overlay.style.fontSize = `${px}px`;
	}

	function positionOverlay() {
		const { overlay, container, player, mode } = subtitleState;
		if (!overlay || !player) return;
		const playerBox = player.getBoundingClientRect();
		// 轨道模式没有字幕容器可对齐：用「底边锚点」钉在播放器下部——
		// top 锚点会让两行长字幕向下溢出画面/被控制栏遮住，bottom 锚点
		// 让文本始终向上生长，行数再多也不会超出。
		if (mode === "track") {
			const bottomGap = Math.max(playerBox.height * 0.12, 70);
			overlay.style.left = `${playerBox.width / 2}px`;
			overlay.style.top = "auto";
			overlay.style.bottom = `${bottomGap}px`;
			return;
		}
		if (!container) return;
		// 字幕容器在无字幕时高度为 0，用它的包围盒把译文钉在原字幕正下方。
		const box = container.getBoundingClientRect();
		if (box.height === 0) {
			overlay.hidden = true;
			return;
		}
		overlay.style.bottom = "auto";
		overlay.style.left = `${box.left - playerBox.left + box.width / 2}px`;
		overlay.style.top = `${box.bottom - playerBox.top}px`;
	}

	/** 把译文渲染出来；ok=false 时显示错误提示而不是静默失败。 */
	function renderTranslation(ok, payload) {
		subtitleState.recv += 1;
		subtitleState.lastError = ok ? "" : String(payload);
		const overlay = subtitleState.overlay;
		if (!overlay) return;
		const text = readCaptionText();
		if (!text) {
			// 字幕已经翻页/关闭，这条结果过期了。
			overlay.hidden = true;
			return;
		}
		if (ok) {
			overlay.textContent = payload;
			overlay.classList.remove("yte-subtitle-error");
		} else {
			overlay.textContent = `⚠ ${payload}`;
			overlay.classList.add("yte-subtitle-error");
		}
		applyReplaceMode();
		positionOverlay();
		overlay.hidden = false;
		updateButton(); // 悬停提示里的 发/回 计数与错误同步刷新
	}

	function sendTranslate(text) {
		const id = subtitleRequestId("line", ++subtitleState.seq);
		subtitleState.lastSent = text;
		subtitleState.lastSentAt = Date.now();
		subtitleState.sent += 1;
		try {
			window.ipc.postMessage(
				JSON.stringify({
					type: "subtitle-translate",
					id,
					text,
					targetLang: cfg("subtitleTranslation", "targetLang") || "zh-CN",
				}),
			);
		} catch (err) {
			log("字幕翻译请求发送失败", err);
		}
	}

	function onCaptionsChanged() {
		// 字幕是一个词一个词往上跳的，抖动期间读 DOM 会拿到半截句子；
		// 稍作合并再取文本，省掉一大半无谓的翻译请求。
		clearTimeout(subtitleState.debounce);
		subtitleState.debounce = setTimeout(() => {
			const text = readCaptionText();
			if (!text) {
				// "未检测到字幕"提示不被后续空变更隐藏，否则提示刚闪出就被盖掉
				const overlay = subtitleState.overlay;
				if (overlay && overlay.textContent?.startsWith("未检测到字幕")) return;
				if (overlay) overlay.hidden = true;
				return;
			}
			// 抓到字幕了，"没开 CC"的提示用不上了。
			clearTimeout(subtitleState.hintTimer);
			// 同一行字幕重复抖动不重发；但失败后 10 秒允许重试一次。
			if (
				text === subtitleState.lastSent &&
				Date.now() - subtitleState.lastSentAt < 10000
			) {
				return;
			}
			sendTranslate(text);
		}, 120);
	}

	// ------------------------------------------------ 控制栏按钮

	// 按钮就用一个「译」字：SVG 方案在 YouTube 的按钮盒里反复出现尺寸/居中
	// 问题，文字 + CSS 居中最稳。视觉样式（字号/激活色）在 styles.css。

	function updateButton() {
		const btn = subtitleState.button;
		if (!btn) return;
		btn.classList.toggle("yte-subtitle-btn-active", subtitleState.on);
		btn.setAttribute("aria-pressed", String(subtitleState.on));
		const state = subtitleState.on ? "已开启（点击关闭）" : "已关闭（点击开启）";
		// 轨道模式显示翻译进度；DOM 模式显示逐句收发。
		let traffic;
		if (subtitleState.mode === "track" && subtitleState.cues) {
			traffic =
				`· 模式:轨道 ${subtitleState.cues.length}条 ` +
				`已译${subtitleState.translatedCount} 在途${subtitleState.pendingBatches}块 ` +
				`Ack${subtitleState.ack}`;
		} else {
			traffic = `· 请求 发${subtitleState.sent}/Ack${subtitleState.ack}/回${subtitleState.recv}`;
		}
		const error = subtitleState.lastError ? `· 最近错误：${subtitleState.lastError}` : "";
		// 链路诊断：容器在不在、监听挂没挂、容器变更了几次、CC 开没开。
		// 发0/回0 时看这四个值就能区分"CC 没开"和"监听失效"。
		const cc = document.querySelector("button.ytp-subtitles-button");
		const ccState = !cc ? "无CC键" : cc.getAttribute("aria-pressed") === "true" ? "开" : "关";
		const chain =
			`· 容器:${subtitleState.container?.isConnected ? "在" : "无"} ` +
			`监听:${subtitleState.observer ? "在" : "无"} ` +
			`变更:${subtitleState.mutCount} CC:${ccState}`;
		btn.title = `字幕双语翻译：${state} ${traffic} ${chain} ${error}`;
	}

	/** right-controls 系列锚点兜底：WebView2 实验布局里齿轮父容器不存在时用。 */
	const BUTTON_ANCHORS = [
		".ytp-right-controls-right",
		".ytp-right-controls",
		".ytp-right-controls-left",
		".ytp-chrome-controls",
	];

	/**
	 * 把开关按钮注入播放器右下控制区。
	 *
	 * 锚点策略：设置齿轮 .ytp-settings-button 在任何布局下都可见，把按钮插到
	 * 它左边（同一父容器），保证一定显示。兜底才是 right-controls 系列类名——
	 * WebView2 拿到的实验布局里这些子容器可能存在但不可见，按钮插进去就消失，
	 * 所以只作退路。播放器初始化可能比功能 enable 晚很久，给 30 秒重试窗口。
	 */
	async function injectButton() {
		const scope = subtitleState.player ?? getPlayer() ?? document;
		let controls = null;
		const deadline = performance.now() + 30000;
		while (!controls && performance.now() < deadline) {
			// 首选：设置齿轮的父容器（齿轮必然可见，容器必然显示）
			const gear = scope.querySelector(".ytp-settings-button");
			if (gear?.parentElement) {
				controls = gear.parentElement;
				break;
			}
			for (const selector of BUTTON_ANCHORS) {
				controls = scope.querySelector(selector);
				if (controls) break;
			}
			if (!controls) await sleep(500);
		}
		if (!controls) {
			log("控制栏未找到，翻译按钮注入失败");
			return;
		}
		let btn = document.getElementById(SUBTITLE_BUTTON_ID);
		if (!btn || !btn.isConnected) {
			btn = document.createElement("button");
			btn.id = SUBTITLE_BUTTON_ID;
			btn.className = "ytp-button yte-subtitle-btn";
			btn.setAttribute("aria-label", "字幕双语翻译");
			// 字形放独立 span 里绝对定位钉死在按钮正中心：
			// YouTube 的 .ytp-button 内部样式不可控（可能覆盖 flex 布局），
			// 绝对定位 + translate(-50%,-50%) 不依赖按钮自身的任何布局模式。
			const glyph = document.createElement("span");
			glyph.className = "yte-subtitle-btn-glyph";
			glyph.textContent = "译";
			btn.appendChild(glyph);
			btn.addEventListener("click", onButtonClick);
			// 悬停时实时刷新诊断计数，看到的永远是当前状态而非历史快照
			btn.addEventListener("mouseenter", updateButton);
			// 紧挨设置齿轮左侧插入；找不到齿轮就用容器首位
			const gear = controls.querySelector(".ytp-settings-button");
			controls.insertBefore(btn, gear ?? controls.firstChild);
		}
		subtitleState.button = btn;
		updateButton();
	}

	function onButtonClick(event) {
		// 别让点击冒泡进 YouTube 播放器，否则可能顺手触发它的键盘/点击行为。
		event.preventDefault();
		event.stopPropagation();
		void toggleEngine();
	}

	/** 按钮主开关：开就启动翻译引擎，关就停掉；按钮态即时反映。 */
	async function toggleEngine() {
		if (subtitleState.on) {
			subtitleState.on = false;
			stopEngine();
		} else {
			subtitleState.on = true;
			updateButton();
			const pending = startEngine();
			const generation = subtitleState.generation;
			const ok = await pending;
			if (generation !== subtitleState.generation) return;
			if (!ok) subtitleState.on = false;
		}
		updateButton();
	}

	// ------------------------------------------------ 翻译引擎

	// ------------------------------------------------ 轨道引擎（移植 read-frog）

	// WeTube 的注入脚本跑在页面主世界，能直接调 YouTube 播放器 API，
	// 不需要 read-frog 那套 postMessage 桥（那是给扩展隔离环境用的）。

	/** 找 YouTube 播放器元素（与 read-frog 同款选择器）。 */
	function findYtPlayerEl() {
		return (
			document.querySelector(".html5-video-player.playing-mode, .html5-video-player.paused-mode") ??
			document.querySelector(".html5-video-player")
		);
	}

	/** 播放器数据快照：字幕轨道、POT 来源、设备参数、当前选中轨。 */
	function getPlayerDataSnapshot() {
		const player = findYtPlayerEl();
		if (!player?.getPlayerResponse) return null;
		let resp;
		try {
			resp = player.getPlayerResponse();
		} catch {
			return null;
		}
		const videoId = resp?.videoDetails?.videoId;
		const tlr = resp?.captions?.playerCaptionsTracklistRenderer;
		const tracks = (tlr?.captionTracks ?? []).map((t) => ({
			baseUrl: t.baseUrl,
			languageCode: t.languageCode ?? "",
			kind: t.kind ?? "",
			vssId: t.vssId ?? "",
			name: t.name?.simpleText ?? t.name?.runs?.[0]?.text ?? "",
		}));
		if (!videoId || tracks.length === 0) return null;
		const audioTracks = (player.getAudioTrack?.()?.captionTracks ?? []).map((t) => ({
			url: t.baseUrl ?? t.url ?? "",
			vssId: t.vssId ?? "",
			languageCode: t.languageCode ?? "",
			kind: t.kind ?? "",
		}));
		const selected = player.getOption?.("captions", "track") ?? null;
		let selectedVssId = selected?.vssId ?? selected?.vss_id ?? null;
		if (!selectedVssId && typeof selected?.baseUrl === "string" && selected.baseUrl) {
			try {
				selectedVssId = new URL(selected.baseUrl, location.origin).searchParams.get("vssId");
			} catch {
				/* 忽略 */
			}
		}
		const rawDefaultIndex = tlr?.defaultCaptionTrackIndex;
		const defaultIndex =
			typeof rawDefaultIndex === "number"
				? rawDefaultIndex
				: typeof rawDefaultIndex?.captionTrackIndex === "number"
					? rawDefaultIndex.captionTrackIndex
					: null;
		return {
			videoId,
			tracks,
			audioTracks,
			device: window.ytcfg?.get?.("DEVICE") ?? null,
			cver: player.getWebPlayerContextConfig?.()?.innertubeContextClientVersion ?? null,
			selectedVssId: selectedVssId ?? null,
			selectedLang: selected?.languageCode ?? null,
			defaultIndex,
		};
	}

	/** 选轨优先级与 read-frog 一致：用户选中 > 默认轨 > 人工原语言 > 人工 > ASR > 第一条。 */
	function selectCaptionTrack(data) {
		const tracks = data.tracks;
		if (data.selectedVssId) {
			const hit = tracks.find((t) => t.vssId === data.selectedVssId);
			if (hit) return hit;
		}
		if (data.selectedLang) {
			const hit = tracks.find((t) => t.languageCode === data.selectedLang);
			if (hit) return hit;
		}
		if (Number.isInteger(data.defaultIndex) && tracks[data.defaultIndex]) {
			return tracks[data.defaultIndex];
		}
		return (
			tracks.find((t) => t.kind !== "asr" && !t.name) ??
			tracks.find((t) => t.kind !== "asr") ??
			tracks.find((t) => t.kind === "asr") ??
			tracks[0] ??
			null
		);
	}

	/** POT 令牌：从音频字幕轨逐级匹配（vssId > 语言+kind > 语言 > 首条）。 */
	function extractPotToken(data, track) {
		const audio = data.audioTracks ?? [];
		const candidates = [
			audio.find((t) => track.vssId && t.vssId === track.vssId),
			audio.find(
				(t) => t.languageCode === track.languageCode && (t.kind || "") === (track.kind || ""),
			),
			audio.find((t) => t.languageCode === track.languageCode),
			audio[0],
		];
		for (const candidate of candidates) {
			if (!candidate?.url) continue;
			try {
				const params = new URL(candidate.url).searchParams;
				const pot = params.get("pot");
				if (pot) return { pot, potc: params.get("potc") };
			} catch {
				/* 忽略 */
			}
		}
		return { pot: null, potc: null };
	}

	/** 拼 timedtext 请求 URL（read-frog url-builder 同款参数）。 */
	function buildTrackUrl(data, track) {
		const url = new URL(track.baseUrl);
		const fixed = {
			fmt: "json3",
			xorb: "2",
			xobt: "3",
			xovt: "3",
			c: "WEB",
			cplayer: "UNIPLAYER",
		};
		Object.entries(fixed).forEach(([key, value]) => url.searchParams.set(key, value));
		const device = data.device ?? {};
		for (const key of ["cbrand", "cbr", "cbrver", "cos", "cosver", "cplatform"]) {
			if (device[key]) url.searchParams.set(key, device[key]);
		}
		if (data.cver) url.searchParams.set("cver", data.cver);
		const pot = extractPotToken(data, track);
		if (pot.pot) url.searchParams.set("pot", pot.pot);
		if (pot.potc) url.searchParams.set("potc", pot.potc);
		return url.toString();
	}

	/** 噪声过滤：[Music]、(Applause)、♪ 等注记从 segs 里剥掉。 */
	function filterNoiseFromEvents(events) {
		const patterns = [/\[.*?\]/g, /\(.*?\)/g, /♪.*?♪/g, /🎵.*?🎵/g, /🎶.*?🎶/g];
		return events.map((event) => {
			if (!event.segs) return event;
			const segs = event.segs
				.map((seg) => {
					let text = seg.utf8 ?? "";
					for (const pattern of patterns) text = text.replace(pattern, "");
					return { ...seg, utf8: text };
				})
				.filter((seg) => seg.utf8.trim().length > 0);
			return { ...event, segs };
		});
	}

	/** 标准解析器（read-frog standard-parser 直译）：事件流 → 毫秒时间轴。 */
	function parseStandardEvents(events) {
		const segments = [];
		let buffer = null;
		for (const event of events) {
			const segs = event.segs ?? [];
			const tStartMs = event.tStartMs ?? 0;
			segs.forEach((seg, segIndex) => {
				const text = (seg.utf8 ?? "").trim().replace(/\s+/g, " ");
				const start = tStartMs + (seg.tOffsetMs ?? 0);
				if (buffer) {
					if (!buffer.end || buffer.end > start) buffer.end = start;
					segments.push(buffer);
					buffer = null;
				}
				buffer = { text, start, end: 0, translated: "" };
				if (segIndex === segs.length - 1) buffer.end = tStartMs + (event.dDurationMs ?? 0);
			});
		}
		if (buffer) segments.push(buffer);
		return segments.filter((segment) => segment.text);
	}

	/** 拉取当前视频的字幕轨道并解析成 cue 时间轴。失败抛错，由调用方回落 DOM 模式。 */
	async function loadTrackCues(signal) {
		const data = getPlayerDataSnapshot();
		if (!data) throw new Error("播放器 API 不可用");
		const track = selectCaptionTrack(data);
		if (!track) throw new Error("没有可用字幕轨道");
		const url = buildTrackUrl(data, track);
		const resp = await fetch(url, { signal });
		if (!resp.ok) throw new Error(`字幕轨道 HTTP ${resp.status}`);
		const json = await resp.json();
		const events = filterNoiseFromEvents(json.events ?? []);
		// ASR 自动字幕是滚动式词级事件（一个词一个 seg，窗口滚动重复），
		// 必须用 scrolling-asr 解析器合并成句；人工字幕才是标准结构。
		const cues =
			track.kind === "asr"
				? parseScrollingAsrEvents(events, track.languageCode)
				: parseStandardEvents(events);
		const finalCues = cues.length > 0 ? cues : parseStandardEvents(events);
		if (finalCues.length === 0) throw new Error("轨道解析结果为空");
		return {
			videoId: data.videoId,
			cues: finalCues,
			hash: `${data.videoId}:${track.languageCode}:${track.kind}:${track.vssId}`,
		};
	}

	/**
	 * ASR 滚动字幕解析器（移植自 read-frog scrolling-asr-parser.ts）：
	 * 跨 event 累积词 segs，遇到 aAppend=1 分隔事件或句末标点/长度上限时
	 * 切出完整句子，词间按源语言决定是否补空格。
	 */
	function parseScrollingAsrEvents(events, lang) {
		const SENTENCE_END = /[,.。?？！!；;…\n]$/;
		const isSpaceSeparated = (lang || "").startsWith("en");
		const isCJK = ["zh", "ja", "ko", "th", "lo", "km", "my"].some((l) =>
			(lang || "").startsWith(l),
		);
		const maxLength = isCJK ? 30 : 15; // read-frog MAX_CHARS_CJK / MAX_WORDS
		const WORD_MS = 200; // 词尾时长估算（read-frog 同款）
		const isSpecialTag = (text) => text.startsWith("[") && text.endsWith("]");
		const result = [];
		const pushFragment = (frag) => {
			const last = result[result.length - 1];
			if (last && last.end > frag.start) last.end = frag.start; // 防重叠
			result.push(frag);
		};

		let currentText = "";
		let currentStart = 0;
		let lastSegEnd = 0;
		let isFirstSeg = true;
		let pendingSplit = false;
		const flush = () => {
			const trimmed = currentText.trim();
			if (trimmed && !isSpecialTag(trimmed)) {
				pushFragment({ text: trimmed, start: currentStart, end: lastSegEnd });
				return true;
			}
			return false;
		};

		for (const event of events) {
			// 分隔事件：只更新结束时间并在挂起切分时输出
			if (event.aAppend === 1) {
				if (currentText) {
					lastSegEnd = event.tStartMs + (event.dDurationMs || 0);
					if (pendingSplit) {
						flush();
						currentText = "";
						isFirstSeg = true;
						pendingSplit = false;
					}
				}
				continue;
			}
			const segs = event.segs ?? [];
			if (segs.length === 0) continue;
			if (pendingSplit && currentText) {
				flush();
				currentText = "";
				isFirstSeg = true;
				pendingSplit = false;
			}
			for (let i = 0; i < segs.length; i++) {
				const text = segs[i].utf8 || "";
				const segStart = event.tStartMs + (segs[i].tOffsetMs || 0);
				if (pendingSplit && currentText) {
					flush();
					currentText = "";
					isFirstSeg = true;
					pendingSplit = false;
				}
				if (isFirstSeg && text.trim()) {
					currentStart = segStart;
					isFirstSeg = false;
				}
				// 空格语言（英文）跨 event 合并时补空格
				if (isSpaceSeparated && currentText && text && i === 0) {
					if (!currentText.endsWith(" ") && !text.startsWith(" ")) {
						currentText += " ";
					}
				}
				currentText += text;
				lastSegEnd = segStart + WORD_MS;
				const isSentenceEnd = SENTENCE_END.test(text.trim());
				const textLength = isCJK
					? currentText.length
					: currentText.split(/\s+/).filter(Boolean).length;
				if (isSentenceEnd || textLength >= maxLength) pendingSplit = true;
			}
		}
		flush();
		return result;
	}

	function subtitleRequestId(kind, seq) {
		return `${window.__WETUBE_PAGE_ID__}:${subtitleState.generation}:${kind}:${seq}`;
	}

	/** 把 cue 时间轴分块送去批量翻译（Edge 接口按位对应）。 */
	function translateAllCues() {
		const cues = subtitleState.cues;
		if (!cues) return;
		const BATCH = 30;
		subtitleState.pendingBatches = 0;
		for (let offset = 0; offset < cues.length; offset += BATCH) {
			const texts = cues.slice(offset, offset + BATCH).map((cue) => cue.text);
			const id = subtitleRequestId("batch", ++subtitleState.batchId);
			subtitleState.batchIndexById[id] = { offset, cues };
			subtitleState.pendingBatches += 1;
			try {
				window.ipc.postMessage(
					JSON.stringify({
						type: "subtitle-translate-batch",
						id,
						texts,
						targetLang: cfg("subtitleTranslation", "targetLang") || "zh-CN",
					}),
				);
			} catch (err) {
				subtitleState.pendingBatches -= 1;
				log("批量翻译请求发送失败", err);
			}
		}
	}

	/** 批量结果回传：按位写回 cue.translated，当前正显示的 cue 立即刷新。 */
	window.__wetubeOnSubtitleBatchTranslated = (id, results) => {
		const batch = subtitleState.batchIndexById[String(id)];
		delete subtitleState.batchIndexById[String(id)];
		if (!batch || batch.cues !== subtitleState.cues || !Array.isArray(results)) return;
		subtitleState.pendingBatches = Math.max(0, subtitleState.pendingBatches - 1);
		results.forEach((text, index) => {
			const cue = batch.cues[batch.offset + index];
			if (cue && typeof text === "string" && text) {
				cue.translated = text;
				subtitleState.translatedCount += 1;
			}
		});
		updateButton();
		renderCurrentCue();
	};

	/** Rust 收到批量消息的立即回执（带条数）。 */
	window.__wetubeSubtitleAck = (count) => {
		subtitleState.ack += Number(count) || 1;
	};

	/** timeupdate 驱动：按 currentTime 二分查当前 cue 并渲染双语。 */
	function attachTimeLoop() {
		if (subtitleState.timeHandler) return;
		const video =
			document.querySelector("video.html5-main-video") ?? document.querySelector("video");
		if (!video) return;
		subtitleState.videoEl = video;
		subtitleState.timeHandler = () => renderCurrentCue();
		video.addEventListener("timeupdate", subtitleState.timeHandler, true);
	}

	function detachTimeLoop() {
		if (subtitleState.timeHandler && subtitleState.videoEl) {
			subtitleState.videoEl.removeEventListener("timeupdate", subtitleState.timeHandler, true);
		}
		subtitleState.timeHandler = null;
		subtitleState.videoEl = null;
	}

	/** 二分找 start <= t 的最后一个 cue；t 超出其 end 视为无字幕。 */
	function findCueIndex(cues, timeMs) {
		let low = 0;
		let high = cues.length - 1;
		let hit = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (cues[mid].start <= timeMs) {
				hit = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		return hit;
	}

	function renderCurrentCue() {
		const overlay = subtitleState.overlay;
		const cues = subtitleState.cues;
		const video = subtitleState.videoEl;
		if (!overlay || !cues?.length || !video) return;
		const timeMs = video.currentTime * 1000;
		const index = findCueIndex(cues, timeMs);
		const cue = index >= 0 ? cues[index] : null;
		if (!cue || timeMs > cue.end) {
			if (!overlay.hidden) overlay.hidden = true;
			return;
		}
		// 双语模式原文在上、译文在下；"只显示译文"则只出译文；译文未到先显示原文。
		const replace = cfg("subtitleTranslation", "replaceOriginal") === true;
		const lines = [];
		if (cue.translated) {
			if (!replace) lines.push(cue.text);
			lines.push(cue.translated);
		} else {
			lines.push(cue.text);
		}
		overlay.textContent = lines.join("\n");
		overlay.classList.remove("yte-subtitle-error");
		positionOverlay();
		overlay.hidden = false;
	}

	/**
	 * 启动翻译引擎：等字幕容器出现、挂 MutationObserver、装回传回调。
	 * 幂等：已在跑且容器还连着时直接成功返回。
	 */
	async function startEngine() {
		stopEngine();
		const generation = subtitleState.generation;
		const pageUrl = location.href;
		const current = () => generation === subtitleState.generation && location.href === pageUrl;
		const controller = new AbortController();
		subtitleState.controller = controller;
		const player = await waitForPlayer();
		if (!player || !current()) return false;
		subtitleState.player = player;

		// 译文层两种模式共用：轨道模式也要画，必须在分支前创建。
		if (!subtitleState.overlay || !subtitleState.overlay.isConnected) {
			const overlay = document.createElement("div");
			overlay.className = "yte-subtitle-translation";
			overlay.hidden = true;
			player.appendChild(overlay);
			subtitleState.overlay = overlay;
		}
		applyOverlayFont();

		// ---- 轨道模式优先（read-frog 路线）：CC 不开也能翻 ----
		try {
			const loaded = await loadTrackCues(controller.signal);
			if (!current()) return false;
			const urlId = new URL(location.href).searchParams.get("v")
				|| location.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
			if (urlId && loaded.videoId !== urlId) return false;
			const sameVideo =
				subtitleState.cues && subtitleState.cueVideoId === loaded.videoId
				&& subtitleState.cueTrackHash === loaded.hash;
			if (!sameVideo) {
				subtitleState.cues = loaded.cues;
				subtitleState.cueVideoId = loaded.videoId;
				subtitleState.cueTrackHash = loaded.hash;
				subtitleState.translatedCount = 0;
				translateAllCues();
			}
			subtitleState.mode = "track";
			attachTimeLoop();
			// 轨道就绪提示：批量翻译在途时原文立即可看，译文几秒内陆续补上。
			const overlay = subtitleState.overlay;
			if (overlay && (!overlay.hidden || subtitleState.pendingBatches > 0)) {
				overlay.textContent = `字幕轨道已加载（${loaded.cues.length} 条，翻译中…）`;
				overlay.classList.remove("yte-subtitle-error");
				positionOverlay();
				overlay.hidden = false;
				clearTimeout(subtitleState.hintTimer);
				subtitleState.hintTimer = setTimeout(() => {
					if (subtitleState.overlay?.textContent?.startsWith("字幕轨道已加载")) {
						subtitleState.overlay.hidden = true;
					}
				}, 4000);
			}
			log(`轨道模式：${loaded.cues.length} 条 cue，批量块 ${subtitleState.pendingBatches}`);
			return true;
		} catch (err) {
			if (!current()) return false;
			log("轨道模式不可用，回落 DOM 模式：", err);
		}

		// ---- DOM 模式（原逻辑兜底）----
		subtitleState.mode = "dom";
		if (subtitleState.observer && subtitleState.container?.isConnected) return true;

		const container = await waitForElement(CAPTION_CONTAINER, { timeout: 8000, root: player });
		if (!current()) return false;
		if (!container) {
			log("字幕容器未出现（CC 字幕没开？），翻译引擎未启动");
			return false;
		}
		subtitleState.container = container;

		// Rust 翻译完成 eval 回来只认最新的请求序号，旧结果直接丢弃。
		window.__wetubeOnSubtitleTranslated = (id, ok, payload) => {
			if (!current() || String(id) !== subtitleRequestId("line", subtitleState.seq)) return;
			renderTranslation(ok, payload);
		};
		// Ack 回执已在轨道引擎段统一注册（带条数），这里不再覆盖。

		subtitleState.observer?.disconnect();
		subtitleState.mutCount = 0;
		subtitleState.observer = new MutationObserver(() => {
			subtitleState.mutCount += 1;
			onCaptionsChanged();
		});
		subtitleState.observer.observe(container, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		applyReplaceMode();
		onCaptionsChanged();

		// 引擎跑起来了却迟迟抓不到字幕（没发过一条请求），多半是 CC 字幕
		// 没开。与其让用户对着黑屏猜，不如直接在字幕位置把话说清楚。
		clearTimeout(subtitleState.hintTimer);
		subtitleState.hintTimer = setTimeout(() => {
			if (!subtitleState.on || subtitleState.sent > 0) return;
			const overlay = subtitleState.overlay;
			if (!overlay) return;
			const cc = document.querySelector("button.ytp-subtitles-button");
			const ccOff = cc && cc.getAttribute("aria-pressed") === "false";
			overlay.textContent = ccOff
				? "未检测到字幕：请先点播放器的 CC 按钮开启字幕"
				: "未检测到字幕：该视频可能没有可用的 CC 字幕";
			overlay.classList.add("yte-subtitle-error");
			positionOverlay();
			overlay.hidden = false;
		}, 6000);
		return true;
	}

	/** 停引擎：摘 observer/timeupdate、删译文层、恢复原生字幕。不动 state.on（由调用方管）。 */
	function stopEngine() {
		subtitleState.generation += 1;
		subtitleState.controller?.abort();
		subtitleState.controller = null;
		clearTimeout(subtitleState.debounce);
		clearTimeout(subtitleState.hintTimer);
		subtitleState.observer?.disconnect();
		subtitleState.observer = null;
		detachTimeLoop();
		delete window.__wetubeOnSubtitleTranslated;
		subtitleState.overlay?.remove();
		subtitleState.overlay = null;
		if (subtitleState.container) {
			subtitleState.container.style.visibility = "";
			subtitleState.container = null;
		}
		subtitleState.lastSent = "";
		subtitleState.lastSentAt = 0;
		subtitleState.mode = null;
		// 重启或切换视频时旧译文不可复用，旧请求的回包也必须失效。
		subtitleState.cues = null;
		subtitleState.cueVideoId = "";
		subtitleState.cueTrackHash = "";
		subtitleState.batchIndexById = {};
		subtitleState.pendingBatches = 0;
		subtitleState.translatedCount = 0;
	}

	/**
	 * SPA 切视频后播放器 DOM 整体重建：按钮、字幕容器都会失联。
	 * runtime 在配置没变时不会重调 enable，所以必须自己监听导航事件重挂。
	 */
	function reattach() {
		void injectButton();
		if (subtitleState.on) void startEngine();
	}

	F.subtitleTranslation = {
		enable: async () => {
			// 两个事件都监听：navigate-finish 覆盖页面跳转，page-data-updated
			// 覆盖同页换视频/播放器晚就绪的场景。
			subtitleState.navigateHandler = reattach;
			document.addEventListener("yt-navigate-finish", reattach, true);
			document.addEventListener("yt-page-data-updated", reattach, true);
			subtitleState.resizeHandler = positionOverlay;
			window.addEventListener("resize", positionOverlay, true);
			await injectButton();
			// 字号设置变更时 syncFeature 会重跑 enable，这里即时套用新字号。
			applyOverlayFont();
			// 会话内已经开过翻译的话（比如从别的页面回到 watch），自动恢复。
			if (subtitleState.on) await startEngine();
		},
		disable: () => {
			stopEngine();
			subtitleState.button?.remove();
			subtitleState.button = null;
			subtitleState.player = null;
			if (subtitleState.navigateHandler) {
				document.removeEventListener("yt-navigate-finish", subtitleState.navigateHandler, true);
				document.removeEventListener("yt-page-data-updated", subtitleState.navigateHandler, true);
				subtitleState.navigateHandler = null;
			}
			if (subtitleState.resizeHandler) {
				window.removeEventListener("resize", subtitleState.resizeHandler, true);
				subtitleState.resizeHandler = null;
			}
		},
	};

	log(`功能表已注册 ${Object.keys(F).length} 个功能`);

	// 面板诊断用：字幕翻译模块的运行时状态快照。
	YTE.__subtitleDebug = () => ({
		page: YTE.pageType?.() ?? "?",
		button: Boolean(subtitleState.button?.isConnected),
		player: Boolean(subtitleState.player?.isConnected),
		engine: subtitleState.on,
		mode: subtitleState.mode,
		cues: subtitleState.cues?.length ?? 0,
		translated: subtitleState.translatedCount,
		pending: subtitleState.pendingBatches,
		sent: subtitleState.sent,
		recv: subtitleState.recv,
		ack: subtitleState.ack,
		lastError: subtitleState.lastError,
	});
})();
