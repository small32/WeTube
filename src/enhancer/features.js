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

	const { cfg, on, off, waitForElement, getPlayer, videoData, toggleBodyClass, setStyle, log } = YTE;
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
			const observer = new MutationObserver((mutations) => {
				for (const mutation of mutations) {
					if (mutation.type !== "childList") continue;
					mutation.addedNodes.forEach(process);
				}
			});
			observer.observe(document.body, { childList: true, subtree: true });
			removeRedirect.observer = observer;
		},
		disable() {
			removeRedirect.observer?.disconnect();
			removeRedirect.observer = null;
		},
	};

	// 精简分享链接：去掉 si、feature 之类的附加参数
	F.shareShortener = {
		enable() {
			const clean = () => {
				const input = document.querySelector("#share-url-container input, tp-yt-paper-input input");
				if (input?.value) input.value = input.value.split("?")[0];
			};
			const observer = new MutationObserver(clean);
			observer.observe(document.body, { childList: true, subtree: true, attributes: true });
			F.shareShortener.observer = observer;
			clean();
		},
		disable() {
			F.shareShortener.observer?.disconnect();
			F.shareShortener.observer = null;
		},
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

	F.automaticallyDisableClosedCaptions = {
		enable: () =>
			void retry(() => {
				const button = subtitlesButton();
				if (!button) return false;
				if (button.getAttribute("aria-pressed") !== "true") return true;
				button.click();
				return true;
			}, { attempts: 12, interval: 250, timeout: 6000 }),
		disable: () => {},
	};

	F.automaticallyEnableClosedCaptions = {
		enable: () =>
			void retry(() => {
				const button = subtitlesButton();
				if (!button) return false;
				if (button.getAttribute("aria-pressed") === "true") return true;
				button.click();
				return true;
			}, { attempts: 12, interval: 250, timeout: 6000 }),
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

	// 滚轮调音量
	F.scrollWheelVolumeControl = {
		enable: async (config = {}) => {
			const player = await waitForPlayer();
			if (!player) return;
			toggleBodyClass("yte-scroll-wheel-volume-control", true);
			const host = document.querySelector("div#player") ?? player;
			on(host, "wheel", async (event) => {
				const { steps = 5, modifierKey = "ctrlKey", holdModifierKey = false, holdRightClick = false } = config;
				if (holdModifierKey && !event[modifierKey]) return;
				if (holdRightClick && event.buttons !== 2) return;
				if (event.target?.closest?.("div.ytp-settings-menu")) return;
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
			const host = document.querySelector("div#player") ?? player;
			on(host, "wheel", async (event) => {
				const { steps = 0.25, modifierKey = "altKey" } = config;
				if (!event[modifierKey]) return;
				if (event.target?.closest?.("div.ytp-settings-menu")) return;
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

	log(`功能表已注册 ${Object.keys(F).length} 个功能`);
})();
