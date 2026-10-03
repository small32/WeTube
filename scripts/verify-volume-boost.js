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
function setup(mode = '全局', supported = true, initiallyEnabled = true) {
  const dom = new JSDOM('<div id="movie_player"><video></video><div class="ytp-left-controls"><div class="ytp-volume-area"><button class="ytp-mute-button"></button><div class="ytp-volume-panel"></div></div><div class="ytp-time-display"></div></div><div class="ytp-right-controls"><button class="ytp-settings-button"></button></div></div>', {
    url: 'https://www.youtube.com/watch?v=A', runScripts: 'outside-only',
  });
  const { window } = dom;
  const contexts = [], graphs = [], changes = [], owned = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.destination = {}; this.resumes = 0; contexts.push(this); }
    resume() { this.state = 'running'; this.resumes++; return Promise.resolve(); }
    createGain() { return {gain: {value: 1}, connect() {}, disconnect() {}}; }
    createMediaElementSource(video) {
      assert.ok(!graphs.some(g => g.video === video), '同一媒体元素不能重复创建 source');
      const graph = {video, gain: null, connect(gain) { this.gain = gain; }};
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
    off() { for (const [t, type, h] of owned.splice(0)) t.removeEventListener(type, h); },
  };
  window.eval(source);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
  return {window, dom, config, contexts, graphs, changes, impl: window.__YTE.features.volumeBoost,
    button: () => window.document.querySelector('.yte-volume-boost-btn')};
}
async function main() {
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
  console.log('通过：音量增强增益、逐视频/全局、媒体节点复用、SPA/Shorts、原声恢复和滚轮隔离。');
}
main().catch(err => {console.error(err); process.exitCode = 1;});
