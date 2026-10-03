/*
 * 音量增强：移植 YouTube-Enhancer 的 AudioContext → GainNode 路线。
 * 参考：https://github.com/YouTube-Enhancer/extension/tree/6b1a2f6384071cc995dc7e6e06f02c6d3c66da37/src/features/volumeBoost
 * 上游 MIT 授权见 THIRD_PARTY_NOTICES.md。适配 WeTube 的播放器按钮及 SPA 生命周期。
 */
(() => {
	const YTE = window.__YTE;
	if (!YTE) return;
	const native = window.__WETUBE_PLATFORM__ === "macos";
	let nativeKey = "";
	let nativeRequest = "";
	let nativeSequence = 0;
	const nativePage = window.__WETUBE_PAGE_ID__ ?? crypto.randomUUID();
	let nativeState = { state: "off", error: "" };
	const graphs = new WeakMap();
	let context = null;
	let currentGraph = null;
	let observer = null;
	let button = null;
	let videoKey = "";
	let perVideoOn = false;
	let scheduled = false;
	let lastError = "";
	let resumePending = null;
	let probeTimer = null;
	let tooltip = null;
	let tooltipVisible = false;

	const GAIN_DB = 5;
	const boosted = () => perVideoOn;
	const key = () => new URLSearchParams(location.search).get("v")
		?? location.pathname.match(/^\/shorts\/([^/]+)/)?.[1] ?? "";

	function updateButton() {
		if (!button) return;
		const db = GAIN_DB;
		const active = boosted() && (native ? nativeState.state === "active"
			: !lastError && context?.state === "running" && currentGraph?.hasSamples);
		let status = "关闭";
		if (boosted()) {
			if (native && !active) status = nativeState.error || "请播放视频，等待原生音量增强启动";
			else if (native) status = db === 0 ? "已连接音频 · 0 dB（原声）" : `开启 · ${db} dB（约 ${(10 ** (db / 20)).toFixed(1)} 倍）`;
			else if (lastError) status = lastError;
			else if (context?.state !== "running") status = "等待音频启动，请播放视频或点击播放器";
			else if (!currentGraph?.hasSamples) status = currentGraph?.emptyFrames >= 12
				? "未检测到可处理音频：请确认视频有声音；当前音轨也可能不兼容 macOS 音量增强"
				: "等待音频信号，请播放视频";
			else status = db === 0 ? "已连接音频 · 0 dB（原声）" : `开启 · ${db} dB（约 ${(10 ** (db / 20)).toFixed(1)} 倍）`;
		}
		button.setAttribute("aria-pressed", String(boosted()));
		button.classList.toggle("yte-volume-boost-active", Boolean(active));
		button.classList.toggle("yte-volume-boost-pending", boosted() && !active);
		const message = `音量增强：${status}\n点击开启或恢复原声 · 固定 5 dB`;
		button.title = message;
		button.setAttribute("aria-label", message);
		if (tooltip?.textContent !== message && tooltip) tooltip.textContent = message;
	}

	function requestNative(on) {
		const next = on ? `on:${GAIN_DB}` : "off";
		if (nativeKey === next) return;
		nativeKey = next;
		nativeRequest = `${nativePage}:${++nativeSequence}`;
		nativeState = { state: on ? "waiting" : "off", error: "" };
		try {
			if (typeof YTE.post !== "function") throw new Error("原生音频接口不可用");
			YTE.post({ type: "volume-boost:set", enabled: on, amount: GAIN_DB, request: nativeRequest });
		} catch (err) {
			nativeState = { state: "error", error: String(err.message ?? err) };
		}
	}
	if (native) {
		window.__wetubeNativeAudioEvent = (event) => {
			if (event?.request !== nativeRequest || !["off", "waiting", "active", "error"].includes(event.state)) return;
			nativeState = event;
			updateButton();
		};
		window.addEventListener("pagehide", () => requestNative(false));
		for (const event of ["playing", "pause", "ended", "volumechange", "emptied"]) {
			document.addEventListener(event, (e) => { if (e.target?.tagName === "VIDEO") scheduleSync(); }, true);
		}
	}

	function showTooltip() {
		if (!tooltip) {
			tooltip = document.createElement("div");
			tooltip.className = "yte-volume-boost-tooltip";
			tooltip.id = "yte-volume-boost-tooltip";
			tooltip.setAttribute("role", "tooltip");
			button.setAttribute("aria-describedby", tooltip.id);
		}
		const host = document.fullscreenElement ?? document.webkitFullscreenElement ?? document.body;
		if (tooltip.parentElement !== host) host.appendChild(tooltip);
		tooltipVisible = true;
		updateButton();
		const rect = button.getBoundingClientRect();
		tooltip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 308))}px`;
		tooltip.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
		tooltip.hidden = false;
	}

	function hideTooltip() {
		tooltipVisible = false;
		if (tooltip) tooltip.hidden = true;
	}

	function stopProbe() {
		clearTimeout(probeTimer);
		probeTimer = null;
	}

	function probeAudio() {
		stopProbe();
		const graph = currentGraph;
		if (!graph || !boosted()) return;
		if (context.state === "running" && !graph.video.paused && !graph.video.ended
			&& !graph.video.muted && graph.video.volume > 0 && !document.hidden) {
			graph.analyser.getFloatTimeDomainData(graph.samples);
			const received = graph.samples.some(value => Number.isFinite(value) && Math.abs(value) > 1e-7);
			if (received) {
				graph.hasSamples = true;
				graph.emptyFrames = 0;
			} else if (!graph.hasSamples) graph.emptyFrames++;
		}
		updateButton();
		probeTimer = setTimeout(probeAudio, 250);
	}

	function createIcon() {
		const ns = "http://www.w3.org/2000/svg";
		const svg = document.createElementNS(ns, "svg");
		svg.setAttribute("viewBox", "0 0 64 48");
		svg.setAttribute("aria-hidden", "true");
		svg.setAttribute("focusable", "false");
		for (const [d, width] of [
			["M14 6 Q0 24 14 42 M21 12 Q11 24 21 36 M50 6 Q64 24 50 42 M43 12 Q53 24 43 36", "3.5"],
			["M25 17 Q20 24 25 31 M39 17 Q44 24 39 31", "2.5"],
			["M34 8 L25 26 H31 L30 40 L40 21 H34 Z", "1.6"],
		]) {
			const path = document.createElementNS(ns, "path");
			path.setAttribute("d", d);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", "currentColor");
			path.setAttribute("stroke-width", width);
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
		}
		return svg;
	}

	// 媒体元素一旦接到 AudioContext，就不能简单断开/close，否则原声也会消失。
	// 停用时保留通路并将增益恢复为 1；同一 video 只创建一次 source。
	function resumeAudio() {
		// WebKit 回到前台时还可能处于 interrupted；仅处理 suspended 会漏掉恢复。
		if (!context || context.state === "running" || context.state === "closed") return;
		if (resumePending) return;
		const graph = currentGraph;
		try {
			resumePending = Promise.resolve(context.resume()).then(() => {
				if (currentGraph === graph) lastError = context.state === "running" ? "" : "音频未启动，请播放视频后重试";
			}).catch((err) => {
				if (currentGraph === graph) lastError = `音频启动失败：${err.message ?? err}`;
			}).finally(() => {
				resumePending = null;
				if (currentGraph === graph && boosted()) probeAudio();
				updateButton();
			});
		} catch (err) {
			lastError = `音频启动失败：${err.message ?? err}`;
			updateButton();
		}
	}

	function createGraph(video) {
		let graph = graphs.get(video);
		if (graph) return graph;
		if (!context) {
			const AudioContext = window.AudioContext ?? window.webkitAudioContext;
			if (!AudioContext) throw new Error("当前浏览器不支持音频增益");
			context = new AudioContext();
			context.addEventListener("statechange", () => {
				if (context.state === "running" && currentGraph) lastError = "";
				updateButton();
			});
			// 即使设置已关闭，已接管的原声通路也需要在回到前台时恢复。
			document.addEventListener("visibilitychange", () => {
				if (!document.hidden) resumeAudio();
			});
			document.addEventListener("pointerdown", resumeAudio, true);
			document.addEventListener("keydown", resumeAudio, true);
			document.addEventListener("playing", resumeAudio, true);
		}
		const gain = context.createGain();
		gain.gain.value = 1;
		const analyser = context.createAnalyser();
		analyser.fftSize = 2048;
		const source = context.createMediaElementSource(video);
		source.connect(gain);
		gain.connect(context.destination);
		// 旁路分析输入，不能再次连接 destination，否则会叠加两份声音。
		source.connect(analyser);
		graph = { source, gain, analyser, video, samples: new Float32Array(analyser.fftSize), hasSamples: false, emptyFrames: 0 };
		video.addEventListener("loadstart", () => {
			graph.hasSamples = false;
			graph.emptyFrames = 0;
			if (currentGraph === graph) updateButton();
		});
		graphs.set(video, graph);
		return graph;
	}

	function apply(video) {
		if (native) {
			// macOS never creates a MediaElementAudioSource: Core Audio captures the
			// decoded process output, including the MSE path Web Audio cannot read.
			requestNative(Boolean(boosted() && video && !video.paused && !video.ended && !video.muted && video.volume > 0));
			return;
		}
		if (!video || !boosted()) {
			stopProbe();
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			return;
		}
		try {
			const nextGraph = createGraph(video);
			if (currentGraph !== nextGraph) lastError = "";
			if (currentGraph && currentGraph !== nextGraph) currentGraph.gain.gain.value = 1;
			currentGraph = nextGraph;
			const target = 10 ** (GAIN_DB / 20);
			// YouTube 的普通 DOM 更新不应反复把增益切回原声再拉高。
			if (currentGraph.gain.gain.value !== target) currentGraph.gain.gain.value = target;
			resumeAudio();
			if (!probeTimer) probeAudio();
		} catch (err) {
			stopProbe();
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			lastError = `音量增强不可用：${err.message ?? err}`;
			YTE.log(lastError);
		}
	}

	function sync() {
		if (!document?.documentElement) return; // 页面销毁后丢弃已排队的 DOM 更新
		if (!/^\/(watch|shorts|live)(\/|$)/.test(location.pathname)) {
			perVideoOn = false;
			videoKey = "";
			if (native) requestNative(false);
			stopProbe();
			hideTooltip();
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			button?.remove();
			return;
		}
		const nextKey = key();
		if (nextKey !== videoKey) {
			videoKey = nextKey;
			perVideoOn = false;
		}
		const player = YTE.getPlayer();
		const video = player?.querySelector("video");
		apply(video);
		const mute = player?.querySelector(".ytp-mute-button");
		const volume = mute?.closest(".ytp-volume-area")
			?? (mute?.nextElementSibling?.matches(".ytp-volume-panel") ? mute.nextElementSibling : mute);
		const controls = volume?.parentElement ?? player?.querySelector(".ytp-left-controls, .ytp-right-controls");
		if (controls) {
			if (!button) {
				button = document.createElement("button");
				button.type = "button";
				button.className = "ytp-button yte-volume-boost-btn";
				button.appendChild(createIcon());
				button.setAttribute("aria-label", "切换音量增强");
				button.addEventListener("mouseenter", showTooltip);
				button.addEventListener("mouseleave", hideTooltip);
				button.addEventListener("focus", showTooltip);
				button.addEventListener("blur", hideTooltip);
				button.addEventListener("click", () => {
					perVideoOn = !perVideoOn;
					sync();
				});
			}
			if (volume) {
				if (volume.nextElementSibling !== button) controls.insertBefore(button, volume.nextSibling);
			} else if (button.parentElement !== controls) {
				const time = controls.querySelector(".ytp-time-display");
				controls.insertBefore(button, time?.parentElement === controls ? time : null);
			}
		}
		updateButton();
		if (tooltipVisible && !button?.isConnected) hideTooltip();
	}

	function scheduleSync() {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => { scheduled = false; sync(); });
	}

	// 独立于设置运行，旧配置不影响开关和固定增益；切换视频恢复关闭。
	function mount() {
		observer = new MutationObserver(scheduleSync);
		observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });
		for (const event of ["yt-navigate-finish", "yt-page-data-updated", "popstate"]) {
			window.addEventListener(event, scheduleSync);
		}
		sync();
	}
	if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
	else mount();
})();
