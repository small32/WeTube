// node scripts/verify-volume-boost.js (jsdom; Web Audio mocked for routing/lifecycle checks)
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/enhancer/volume-boost.js'), 'utf8');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/enhancer/schema.json'), 'utf8'));
const definition = schema.features.find(f => f.id === 'volumeBoost');
assert.equal(definition, undefined, '增强设置中不再提供音量增强选项');
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(mode = '全局', supported = true, initiallyEnabled = true, audio = {}) {
  const dom = new JSDOM('<div id="movie_player"><video></video><div class="ytp-left-controls"><div class="ytp-volume-area"><button class="ytp-mute-button"></button><div class="ytp-volume-panel"></div></div><div class="ytp-time-display"></div></div><div class="ytp-right-controls"><button class="ytp-settings-button"></button></div></div>', {
    url: 'https://www.youtube.com/watch?v=A', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  if (audio.platform) window.__WETUBE_PLATFORM__ = audio.platform;
  window.__WETUBE_PAGE_ID__ = 'test-page';
  const contexts = [], graphs = [], changes = [], owned = [], posts = [];
  const timers = new Map(); let timerId = 0;
  window.setTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  const video = window.document.querySelector('video');
  Object.defineProperty(video, 'paused', {value: false, configurable: true});
  class AudioContext {
    constructor() { this.state = audio.state ?? 'suspended'; this.destination = {}; this.resumes = 0; contexts.push(this); }
    addEventListener() {}
    resume() { this.resumes++; if (audio.reject) return Promise.reject(new Error('blocked')); if (!audio.stuck) this.state = 'running'; return Promise.resolve(); }
    createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
    createAnalyser() { return {fftSize: 2048, getFloatTimeDomainData(values) {values.fill(audio.silent ? 0 : 0.05);}}; }
    createMediaElementSource(video) {
      assert.ok(!graphs.some(g => g.video === video), '同一媒体元素不能重复创建 source');
      const graph = {video, gain: null, connect(node) { if (node.gain) this.gain = node; }};
      graphs.push(graph); return graph;
    }
    close() { throw new Error('停用不能关闭原声通路'); }
  }
  if (supported) window.AudioContext = AudioContext;
  const config = {enabled: initiallyEnabled, mode, amount: 6};
  window.__YTE = {
    features: {}, cfg: (_, key) => config[key], getPlayer: () => window.document.querySelector('#movie_player, #shorts-player'),
    setConfig: (id, key, value) => { assert.equal(id, 'volumeBoost'); config[key] = value; changes.push([key, value]); },
    log() {}, on(target, type, handler) { target.addEventListener(type, handler); owned.push([target, type, handler]); },
    post(message) { posts.push(message); },
    off() { for (const [t, type, h] of owned.splice(0)) t.removeEventListener(type, h); },
  };
  window.eval(source);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return {window, dom, config, contexts, graphs, changes, posts,
    button: () => window.document.querySelector('.yte-volume-boost-btn'),
    runProbe() { const next = timers.entries().next().value; if (next) {timers.delete(next[0]); next[1]();} }, timers};
}
const gain = 10 ** (5 / 20);
function close(t) {
  t.window.history.pushState({}, '', '/');
  t.window.dispatchEvent(new t.window.Event('popstate'));
  return flush().then(() => t.dom.window.close());
}
async function main() {
  {
    // Old global/20 dB settings must not automatically capture audio.
    const t = setup('全局', true, true, {platform:'macos'}); await flush();
    assert.equal(t.posts.at(-1).enabled, false);
    assert.equal(t.window.__YTE.features.volumeBoost, undefined);
    t.config.amount = 20;
    t.button().click(); await flush();
    const first = t.posts.at(-1);
    assert.equal(first.enabled, true); assert.equal(first.amount, 5);
    assert.equal(t.graphs.length, 0, 'macOS 不创建 Web Audio source');
    assert.equal(t.contexts.length, 0);
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'waiting',error:'等待系统授权'});
    assert.ok(t.button().title.includes('等待系统授权'));
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true);
    assert.ok(t.button().title.includes('5 dB'));
    assert.ok(!t.button().title.includes('滚轮'));
    const count = t.posts.length;
    t.window.dispatchEvent(new t.window.Event('yt-navigate-finish')); await flush();
    assert.equal(t.posts.length, count, '同视频重同步不重建原生通路');
    t.button().dispatchEvent(new t.window.WheelEvent('wheel',{deltaY:-1,ctrlKey:true,shiftKey:true,cancelable:true})); await flush();
    assert.equal(t.posts.length, count, '滚轮不能改变固定增益');
    assert.equal(t.changes.length, 0, '按钮不再写入增强设置');
    t.button().click(); await flush();
    assert.equal(t.posts.at(-1).enabled, false);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '关闭后忽略过期回调');
    t.button().click(); await flush();
    const video = t.window.document.querySelector('video');
    Object.defineProperty(video,'paused',{value:true,configurable:true});
    video.dispatchEvent(new t.window.Event('pause')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '暂停时释放接管');
    assert.equal(t.button().getAttribute('aria-pressed'), 'true', '保留增强意图');
    Object.defineProperty(video,'paused',{value:false,configurable:true});
    video.dispatchEvent(new t.window.Event('playing')); await flush();
    const resumed = t.posts.at(-1);
    assert.equal(resumed.enabled, true); assert.equal(resumed.amount, 5);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '重新启动后忽略过期请求');
    video.muted = true; video.dispatchEvent(new t.window.Event('volumechange')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '静音时不接管');
    video.muted = false; video.dispatchEvent(new t.window.Event('volumechange')); await flush();
    assert.equal(t.posts.at(-1).enabled, true);
    const active = t.posts.at(-1);
    t.window.__wetubeNativeAudioEvent({request:active.request,state:'error',error:'原生音量增强需要 macOS 14.2'});
    assert.ok(t.button().title.includes('14.2'));
    t.window.history.pushState({}, '', '/watch?v=B');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '切换视频后解除接管');
    t.button().click(); await flush();
    t.window.dispatchEvent(new t.window.Event('pagehide')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '离开页面时解除接管');
    await close(t);
  }
  {
    const t = setup('全局', true, true); await flush();
    assert.ok(t.button(), '始终显示播放器按钮');
    assert.equal(t.graphs.length, 0, '旧设置不能自动接管音频');
    const volume = t.window.document.querySelector('.ytp-volume-area');
    assert.equal(volume.nextElementSibling, t.button(), '按钮保持在音量区域右侧');
    assert.equal(t.button().nextElementSibling.className, 'ytp-time-display');
    assert.equal(t.button().querySelectorAll('svg path').length, 3, '保留原有闪电声波图标');
    t.button().click(); await flush();
    assert.ok(Math.abs(t.graphs[0].gain.gain.value - gain) < 1e-10);
    assert.equal(t.button().getAttribute('aria-pressed'), 'true');
    assert.equal(t.contexts[0].state, 'running');
    t.config.amount = 12;
    t.button().dispatchEvent(new t.window.WheelEvent('wheel', {deltaY:-1,ctrlKey:true,shiftKey:true,cancelable:true}));
    t.window.dispatchEvent(new t.window.Event('yt-navigate-finish')); await flush();
    assert.ok(Math.abs(t.graphs[0].gain.gain.value - gain) < 1e-10, '旧设置和滚轮都不能改变增益');
    assert.equal(t.changes.length, 0);
    t.button().click(); await flush();
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    t.contexts[0].state = 'suspended';
    t.window.document.dispatchEvent(new t.window.Event('pointerdown'));
    assert.equal(t.contexts[0].state, 'running', '关闭增强后仍可恢复原声通路');
    const newControls = t.window.document.createElement('div');
    newControls.className = 'ytp-left-controls';
    newControls.innerHTML = '<div class="ytp-volume-area"><button class="ytp-mute-button"></button></div>';
    t.window.document.querySelector('.ytp-left-controls').replaceWith(newControls); await flush();
    assert.equal(newControls.firstElementChild.nextElementSibling, t.button());
    assert.equal(t.window.document.querySelectorAll('.yte-volume-boost-btn').length, 1);
    t.button().click(); await flush();
    assert.equal(t.graphs.length, 1, '同一 video 只创建一次 source');
    t.window.history.pushState({}, '', '/watch?v=B');
    const replacement = t.window.document.createElement('video');
    t.window.document.querySelector('video').replaceWith(replacement); await flush();
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    assert.equal(t.graphs.length, 1);
    t.button().click(); await flush();
    assert.equal(t.graphs.length, 2);
    assert.ok(Math.abs(t.graphs[1].gain.gain.value - gain) < 1e-10);
    await close(t);
  }
  {
    const audio = {silent: true};
    const t = setup('全局', true, true, audio); t.button().click(); await flush();
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    for (let i = 0; i < 13; i++) t.runProbe();
    assert.ok(t.button().title.includes('未检测到可处理音频'));
    t.button().dispatchEvent(new t.window.Event('mouseenter')); await flush();
    const tooltip = t.window.document.querySelector('[role="tooltip"]');
    assert.equal(tooltip.hidden, false); assert.ok(tooltip.textContent.includes('不兼容'));
    audio.silent = false; t.runProbe(); await flush();
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true);
    assert.ok(tooltip.textContent.includes('5 dB'));
    t.window.document.querySelector('video').dispatchEvent(new t.window.Event('loadstart'));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.button().dispatchEvent(new t.window.Event('mouseleave')); assert.equal(tooltip.hidden, true);
    t.button().click(); assert.equal(t.timers.size, 0);
    await close(t);
  }
  {
    const audio = {reject: true};
    const t = setup('全局', true, true, audio); t.button().click(); await flush();
    assert.ok(t.button().title.includes('启动失败'));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.window.dispatchEvent(new t.window.Event('yt-navigate-finish')); await flush();
    assert.ok(t.button().title.includes('启动失败'));
    audio.reject = false; t.contexts[0].state = 'interrupted';
    t.window.document.dispatchEvent(new t.window.Event('pointerdown')); await flush();
    assert.equal(t.contexts[0].state, 'running');
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true);
    await close(t);
  }
  for (const [supported, audio, message] of [[true, {stuck:true}, '未启动'], [false, {}, '不支持']]) {
    const t = setup('全局', supported, true, audio); t.button().click(); await flush();
    assert.ok(t.button().title.includes(message));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    await close(t);
  }
  {
    const t = setup();
    const player = t.window.document.querySelector('#movie_player'); player.id = 'shorts-player';
    t.window.history.pushState({}, '', '/shorts/S');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    t.config.amount = NaN; t.button().click(); await flush();
    assert.ok(Math.abs(t.graphs[0].gain.gain.value - gain) < 1e-10);
    const controls = t.window.document.createElement('div'); controls.className = 'ytp-right-controls';
    player.querySelector('.ytp-left-controls').remove();
    player.querySelector('.ytp-right-controls').replaceWith(controls); await flush();
    assert.equal(t.button().parentElement, controls);
    assert.equal(t.window.document.querySelectorAll('.yte-volume-boost-btn').length, 1);
    await close(t);
  }
  console.log('通过：无设置入口、固定 5 dB、旧配置隔离、播放器按钮、macOS 桥接及音频生命周期。');
}
main().catch(err => {console.error(err); process.exitCode = 1;});
