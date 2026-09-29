// node scripts/verify-state-lifecycle.js (no external dependencies)
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');

async function main() {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const runtime = {window: {__YTE_CONFIG__: {hidePosts: {enabled: true}}, dispatchEvent() {}},
    document: {readyState: 'loading', addEventListener() {}}, console, Event: class {}};
  vm.runInNewContext(read('enhancer/runtime.js'), runtime);
  const defaults = {hidePosts: {enabled: false}};
  runtime.window.__YTE.replaceConfig(defaults);
  assert.equal(runtime.window.__YTE.cfg('hidePosts', 'enabled'), false);
  assert.equal(runtime.window.__YTE_CONFIG__, defaults);

  const source = read('enhancer/features.js');
  const extract = (start, end) => {
    const from = source.indexOf(start), to = source.indexOf(end, from);
    assert(from >= 0 && to > from);
    return source.slice(from, to);
  };
  const input = {value: ''};
  const links = {F: {}, document: {querySelector: () => input}, URL, watchMutations() {}, unwatchMutations() {}};
  vm.runInNewContext(extract('F.shareShortener =', '// 跳过'), links);
  for (const [url, expected] of [
    ['https://www.youtube.com/playlist?list=PL1&si=tracking', 'https://www.youtube.com/playlist?list=PL1'],
    ['https://www.youtube.com/watch?v=abc&t=90&feature=share', 'https://www.youtube.com/watch?v=abc&t=90'],
    ['https://youtu.be/abc?si=tracking', 'https://youtu.be/abc'],
  ]) {
    input.value = url; links.F.shareShortener.enable(); assert.equal(input.value, expected);
  }

  const pending = [], sent = [];
  const state = {generation: 0, controller: null, seq: 0, batchId: 0, pendingBatches: 0};
  const player = {appendChild() {}};
  const ctx = {
    subtitleState: state, window: {__WETUBE_PAGE_ID__: 'page-one', ipc: {postMessage: (s) => sent.push(JSON.parse(s))}},
    location: {href: 'https://www.youtube.com/watch?v=A', pathname: '/watch'},
    document: {createElement: () => ({isConnected: true, classList: {remove() {}}, remove() {}})},
    waitForPlayer: async () => player,
    loadTrackCues: (signal) => new Promise((resolve) => pending.push({resolve, signal})),
    AbortController, URL, cfg: () => 'zh-CN', setTimeout: () => 1, clearTimeout() {},
    applyOverlayFont() {}, attachTimeLoop() {}, detachTimeLoop() {}, log() {},
    positionOverlay() {}, updateButton() {}, renderCurrentCue() {},
  };
  vm.runInNewContext(extract('function subtitleRequestId(', '/** Rust 收到批量消息'), ctx);
  vm.runInNewContext(extract('async function startEngine()', '\n\t/**\n\t * SPA 切视频'), ctx);
  const loaded = (id) => ({videoId: id, hash: id, cues: [{text: id}]});
  const first = ctx.startEngine(); await flush();
  ctx.location.href = 'https://www.youtube.com/watch?v=B';
  const second = ctx.startEngine(); await flush();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(loaded('B')); assert.equal(await second, true);
  pending[0].resolve(loaded('A')); assert.equal(await first, false);
  assert.equal(state.cueVideoId, 'B');
  const oldId = sent.at(-1).id;

  const stopped = ctx.startEngine(); await flush();
  ctx.stopEngine(); pending[2].resolve(loaded('B'));
  assert.equal(await stopped, false);
  assert.equal(state.cues, null);

  ctx.window.__WETUBE_PAGE_ID__ = 'page-two';
  const refreshed = ctx.startEngine(); await flush();
  pending[3].resolve(loaded('B')); await refreshed;
  const newId = sent.at(-1).id;
  assert.notEqual(newId, oldId);
  ctx.window.__wetubeOnSubtitleBatchTranslated(oldId, ['stale']);
  assert.equal(state.cues[0].translated, undefined);
  assert.equal(state.pendingBatches, 1);
  ctx.window.__wetubeOnSubtitleBatchTranslated(newId, ['current']);
  assert.equal(state.cues[0].translated, 'current');
  console.log('Config reset, sharing, subtitle cancellation and page isolation regressions passed.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
