// node scripts/verify-volume-boost.js (jsdom; Web Audio mocked for routing/lifecycle checks)
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, '../src/enhancer/volume-boost.js'), 'utf8');
const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/enhancer/schema.json'), 'utf8'));
const definition = schema.features.find(f => f.id === 'volumeBoost');
assert.equal(definition.fields.find(f => f.key === 'enabled').default, false);
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
  return {window, dom, config, contexts, graphs, changes, posts, impl: window.__YTE.features.volumeBoost,
    button: () => window.document.querySelector('.yte-volume-boost-btn'),
    runProbe() { const next = timers.entries().next().value; if (next) {timers.delete(next[0]); next[1]();} }, timers};
}
async function main() {
  {
    const t = setup('逐视频', true, false, {platform:'macos'}); await flush();
    assert.equal(t.posts.at(-1).enabled, false);
    t.button().click(); await flush();
    const first = t.posts.at(-1);
    assert.equal(first.enabled, true); assert.equal(first.amount, 6);
    assert.equal(t.graphs.length, 0, 'macOS 不能再创建失效的 Web Audio source');
    assert.equal(t.contexts.length, 0);
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'waiting',error:'等待系统授权'});
    assert.ok(t.button().title.includes('等待系统授权'));
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true);
    const count = t.posts.length;
    t.window.dispatchEvent(new t.window.Event('yt-navigate-finish')); await flush();
    assert.equal(t.posts.length, count, 'DOM 重同步不能反复启动原生通路');
    t.button().dispatchEvent(new t.window.WheelEvent('wheel',{deltaY:-1,ctrlKey:true,cancelable:true})); await flush();
    assert.equal(t.posts.at(-1).amount, 11);
    assert.notEqual(t.posts.at(-1).request, first.request);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '旧增益回调必须丢弃');
    t.button().click(); await flush();
    assert.equal(t.posts.at(-1).enabled, false);
    t.window.__wetubeNativeAudioEvent({request:first.request,state:'active',error:''});
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '关闭后旧回调不能恢复蓝色');
    t.button().click(); await flush();
    const video = t.window.document.querySelector('video');
    Object.defineProperty(video,'paused',{value:true,configurable:true});
    video.dispatchEvent(new t.window.Event('pause')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '暂停时释放接管');
    assert.equal(t.button().getAttribute('aria-pressed'), 'true', '保留增强意图');
    Object.defineProperty(video,'paused',{value:false,configurable:true});
    video.dispatchEvent(new t.window.Event('playing')); await flush();
    assert.equal(t.posts.at(-1).enabled, true);
    video.muted = true; video.dispatchEvent(new t.window.Event('volumechange')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '静音时不接管');
    video.muted = false; video.dispatchEvent(new t.window.Event('volumechange')); await flush();
    assert.equal(t.posts.at(-1).enabled, true);
    const active = t.posts.at(-1);
    t.window.__wetubeNativeAudioEvent({request:active.request,state:'error',error:'原生音量增强需要 macOS 14.2'});
    assert.ok(t.button().title.includes('14.2'));
    t.window.history.pushState({}, '', '/watch?v=B');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '逐视频切换后解除接管');
    t.button().click(); await flush();
    t.window.dispatchEvent(new t.window.Event('pagehide')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '离开页面时解除接管');
    t.config.enabled = false; t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const t = setup('全局', true, true, {platform:'macos'}); await flush();
    assert.equal(t.posts.at(-1).enabled, true);
    const count = t.posts.length;
    t.window.history.pushState({}, '', '/watch?v=B');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    assert.equal(t.posts.length, count, '全局模式同进程切视频不重建音频通路');
    t.window.history.pushState({}, '', '/');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    assert.equal(t.posts.at(-1).enabled, false, '离开播放页面释放原生通路');
    t.config.enabled = false; t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const t = setup('全局', true, false);
    assert.ok(t.button(), '默认关闭时仍应显示按钮');
    assert.equal(t.graphs.length, 0, '点击前不接管音频');
    const volume = t.window.document.querySelector('.ytp-volume-area');
    assert.equal(volume.nextElementSibling, t.button(), '按钮紧跟音量区域右侧');
    assert.equal(t.button().nextElementSibling.className, 'ytp-time-display');
    assert.equal(t.button().querySelectorAll('svg path').length, 3, '使用声波和闪电 SVG');
    assert.equal(t.button().textContent, '');
    t.button().click(); await flush();
    assert.equal(t.config.enabled, true);
    assert.equal(t.config.mode, '逐视频');
    assert.ok(t.graphs[0].gain.gain.value > 1);
    t.button().click(); await flush();
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    const newControls = t.window.document.createElement('div');
    newControls.className = 'ytp-left-controls';
    const newVolume = t.window.document.createElement('div');
    newVolume.className = 'ytp-volume-area';
    const mute = t.window.document.createElement('button'); mute.className = 'ytp-mute-button';
    newVolume.appendChild(mute); newControls.appendChild(newVolume);
    t.window.document.querySelector('.ytp-left-controls').replaceWith(newControls); await flush();
    assert.equal(newVolume.nextElementSibling, t.button());
    assert.equal(t.window.document.querySelectorAll('.yte-volume-boost-btn').length, 1);
    t.window.history.pushState({}, '', '/');
    t.window.dispatchEvent(new t.window.Event('popstate')); await flush();
    assert.equal(t.button(), null, '离开播放页面后移除按钮');
    await flush(); t.dom.window.close();
  }
  {
    const t = setup(); t.impl.enable();
    assert.equal(t.contexts.length, 1);
    assert.ok(Math.abs(t.graphs[0].gain.gain.value - 10 ** (6 / 20)) < 1e-10);
    assert.equal(t.contexts[0].state, 'running');
    assert.equal(t.button().getAttribute('aria-pressed'), 'true');
    t.config.amount = 12; t.impl.disable();
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.equal(t.button().getAttribute("aria-pressed"), "false");
    t.impl.enable(); await flush();
    assert.equal(t.graphs.length, 1);
    assert.ok(Math.abs(t.graphs[0].gain.gain.value - 10 ** (12 / 20)) < 1e-10);
    t.config.enabled = false; t.impl.disable();
    t.contexts[0].state = 'suspended';
    t.window.document.dispatchEvent(new t.window.Event('pointerdown'));
    assert.equal(t.contexts[0].state, 'running', '停用后恢复原声仍应支持用户手势');
    await flush(); t.dom.window.close();
  }
  {
    const t = setup('逐视频'); t.impl.enable();
    assert.equal(t.graphs.length, 0, '未激活逐视频模式时不接管音频');
    t.button().click(); await flush();
    assert.equal(t.button().getAttribute('aria-pressed'), 'true');
    t.impl.disable(); t.impl.enable(); await flush();
    assert.equal(t.button().getAttribute('aria-pressed'), 'true', '同视频 SPA 重同步保留开启状态');
    const event = new t.window.WheelEvent('wheel', {deltaY: -1, ctrlKey: true, bubbles: true, cancelable: true});
    let bubbled = false;
    t.window.document.addEventListener('wheel', () => { bubbled = true; });
    t.button().dispatchEvent(event); await flush();
    assert.equal(t.config.amount, 11); assert.equal(event.defaultPrevented, true); assert.equal(bubbled, false);
    t.config.amount = 20;
    t.button().dispatchEvent(new t.window.WheelEvent('wheel', {deltaY: -1, cancelable: true}));
    assert.equal(t.config.amount, 20);
    t.window.history.pushState({}, '', '/watch?v=B');
    const replacement = t.window.document.createElement('video');
    t.window.document.querySelector('video').replaceWith(replacement); await flush();
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    assert.equal(t.graphs.length, 1);
    t.button().click(); await flush(); assert.equal(t.graphs.length, 2);
    t.button().click(); assert.equal(t.graphs[1].gain.gain.value, 1);
    t.button().click(); assert.equal(t.graphs.length, 2);
    t.config.enabled = false; t.impl.disable();
    t.config.enabled = true; t.impl.enable();
    assert.equal(t.button().getAttribute('aria-pressed'), 'false');
    t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const t = setup(); t.impl.enable();
    const replacement = t.window.document.createElement('video');
    t.window.document.querySelector('video').replaceWith(replacement); await flush();
    assert.equal(t.graphs.length, 2);
    assert.equal(t.graphs[0].gain.gain.value, 1);
    assert.ok(t.graphs[1].gain.gain.value > 1);
    t.button().click(); assert.equal(t.config.mode, '逐视频');
    assert.equal(t.graphs[1].gain.gain.value, 1);
    t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const audio = {silent: true};
    const t = setup('全局', true, true, audio); await flush();
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '无音频数据不能假装增强生效');
    for (let i = 0; i < 13; i++) t.runProbe();
    assert.ok(t.button().title.includes('未检测到可处理音频'));
    t.button().dispatchEvent(new t.window.Event('mouseenter')); await flush();
    const tooltip = t.window.document.querySelector('[role="tooltip"]');
    assert.equal(tooltip.hidden, false); assert.ok(tooltip.textContent.includes('不兼容'));
    audio.silent = false; t.runProbe(); await flush();
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true, '静音片段结束后自动识别信号');
    assert.ok(tooltip.textContent.includes('开启'));
    t.window.document.querySelector('video').dispatchEvent(new t.window.Event('loadstart'));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false, '更换音轨须重新验证');
    t.button().dispatchEvent(new t.window.Event('mouseleave')); assert.equal(tooltip.hidden, true);
    t.config.enabled = false; t.impl.disable(); assert.equal(t.timers.size, 0);
    await flush(); t.dom.window.close();
  }
  {
    const audio = {reject: true};
    const t = setup('全局', true, true, audio); await flush();
    assert.ok(t.button().title.includes('启动失败'));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.window.dispatchEvent(new t.window.Event('yt-navigate-finish')); await flush();
    assert.ok(t.button().title.includes('启动失败'), 'DOM 同步不能掩盖启动错误');
    audio.reject = false; t.contexts[0].state = 'interrupted';
    t.window.document.dispatchEvent(new t.window.Event('pointerdown')); await flush();
    assert.equal(t.contexts[0].state, 'running');
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), true);
    t.config.enabled = false; t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const audio = {stuck: true};
    const t = setup('全局', true, true, audio); await flush();
    assert.ok(t.button().title.includes('未启动'));
    assert.equal(t.button().classList.contains('yte-volume-boost-active'), false);
    t.config.enabled = false; t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const t = setup('全局', false); t.impl.enable();
    assert.ok(t.button().title.includes('不支持'));
    t.impl.disable(); await flush(); t.dom.window.close();
  }
  {
    const t = setup();
    const player = t.window.document.querySelector('#movie_player');
    player.id = 'shorts-player';
    t.window.history.pushState({}, '', '/shorts/S');
    t.config.amount = NaN; t.impl.enable();
    assert.ok(Number.isFinite(t.graphs[0].gain.gain.value));
    const controls = t.window.document.createElement('div'); controls.className = 'ytp-right-controls';
    player.querySelector('.ytp-left-controls').remove();
    player.querySelector('.ytp-right-controls').replaceWith(controls); await flush();
    assert.equal(t.button().parentElement, controls);
    assert.equal(t.window.document.querySelectorAll('.yte-volume-boost-btn').length, 1);
    t.impl.disable(); await flush(); t.dom.window.close();
  }
  console.log('通过：Web Audio 增益、macOS 原生桥接、过期回调、暂停/静音/页面清理、逐视频/全局和滚轮隔离。');
}
main().catch(err => {console.error(err); process.exitCode = 1;});
