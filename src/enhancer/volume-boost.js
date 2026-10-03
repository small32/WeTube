/*
 * 音量增强：移植 YouTube-Enhancer 的 AudioContext → GainNode 路线。
 * 参考：https://github.com/YouTube-Enhancer/extension/tree/6b1a2f6384071cc995dc7e6e06f02c6d3c66da37/src/features/volumeBoost
 * 上游 MIT 授权见 THIRD_PARTY_NOTICES.md。适配 WeTube 的设置及 SPA 生命周期。
 */
(() => {
	const YTE = window.__YTE;
	if (!YTE) return;
	const graphs = new WeakMap();
	let context = null;
	let currentGraph = null;
	let observer = null;
	let button = null;
	let enabled = false;
	let videoKey = "";
	let perVideoOn = false;
	let scheduled = false;
	let lastError = "";

	const amount = () => {
		const value = Number(YTE.cfg("volumeBoost", "amount") ?? 5);
		return Math.min(20, Math.max(0, Number.isFinite(value) ? value : 5));
	};
	const globalMode = () => YTE.cfg("volumeBoost", "mode") !== "逐视频";
	const boosted = () => enabled && (globalMode() || perVideoOn);
	const key = () => new URLSearchParams(location.search).get("v")
		?? location.pathname.match(/^\/shorts\/([^/]+)/)?.[1] ?? "";

	function updateButton() {
		if (!button) return;
		const db = amount();
		button.setAttribute("aria-pressed", String(boosted()));
		button.classList.toggle("yte-volume-boost-active", boosted());
		button.title = lastError || `音量增强：${boosted() ? "开启" : "关闭"} · ${db} dB（约 ${(10 ** (db / 20)).toFixed(1)} 倍）\n点击切换；滚轮调增益，Shift/Ctrl 加大步长`;
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
		if (context?.state === "suspended") {
			void context.resume().catch((err) => {
				lastError = `音量增强等待播放或点击：${err.message ?? err}`;
				updateButton();
			});
		}
	}

	function createGraph(video) {
		let graph = graphs.get(video);
		if (graph) return graph;
		if (!context) {
			const AudioContext = window.AudioContext ?? window.webkitAudioContext;
			if (!AudioContext) throw new Error("当前浏览器不支持音频增益");
			context = new AudioContext();
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
		const source = context.createMediaElementSource(video);
		source.connect(gain);
		gain.connect(context.destination);
		graph = { source, gain };
		graphs.set(video, graph);
		return graph;
	}

	function apply(video) {
		if (!video || !boosted()) {
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			return;
		}
		try {
			const nextGraph = createGraph(video);
			if (currentGraph && currentGraph !== nextGraph) currentGraph.gain.gain.value = 1;
			currentGraph = nextGraph;
			const target = 10 ** (amount() / 20);
			// YouTube 的普通 DOM 更新不应反复把增益切回原声再拉高。
			if (currentGraph.gain.gain.value !== target) currentGraph.gain.gain.value = target;
			lastError = "";
			resumeAudio();
		} catch (err) {
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			lastError = `音量增强不可用：${err.message ?? err}`;
			YTE.log(lastError);
		}
	}

	function sync() {
		if (!document?.documentElement) return; // 页面销毁后丢弃已排队的 DOM 更新
		enabled = YTE.cfg("volumeBoost", "enabled") === true;
		if (!/^\/(watch|shorts|live)(\/|$)/.test(location.pathname)) {
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
				button.addEventListener("click", () => {
					if (!enabled) {
						YTE.setConfig("volumeBoost", "mode", "逐视频");
						YTE.setConfig("volumeBoost", "enabled", true);
						perVideoOn = true;
					} else if (globalMode()) {
						YTE.setConfig("volumeBoost", "mode", "逐视频");
						perVideoOn = false;
					} else perVideoOn = !perVideoOn;
					sync();
				});
				button.addEventListener("wheel", (event) => {
					if (!event.deltaY) return;
					event.preventDefault();
					event.stopPropagation(); // 播放器的滚轮音量功能不能同时处理
					const step = (event.shiftKey ? 2.5 : 1) * (event.ctrlKey ? 5 : 1);
					YTE.setConfig("volumeBoost", "amount", Math.min(20, Math.max(0, amount() + (event.deltaY < 0 ? step : -step))));
					sync();
				}, { passive: false });
			}
			if (volume) {
				if (volume.nextElementSibling !== button) controls.insertBefore(button, volume.nextSibling);
			} else if (button.parentElement !== controls) {
				const time = controls.querySelector(".ytp-time-display");
				controls.insertBefore(button, time?.parentElement === controls ? time : null);
			}
		}
		updateButton();
	}

	function scheduleSync() {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => { scheduled = false; sync(); });
	}

	YTE.features.volumeBoost = {
		enable() {
			enabled = true;
			sync();
		},
		disable() {
			enabled = false;
			if (currentGraph) currentGraph.gain.gain.value = 1;
			currentGraph = null;
			if (!YTE.cfg("volumeBoost", "enabled")) perVideoOn = false;
			updateButton();
		},
	};

	// 按钮入口与增强开关分开：默认关闭增强时，也可以直接点击按钮开启。
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
