// node scripts/verify-captions-mode.js (no external dependencies)
//
// 回归测试：automaticallyEnableClosedCaptions 不得在 SPA 重同步时把字幕关掉。
//
// runtime 在每次导航事件（yt-navigate-start / yt-navigate-finish /
// yt-page-data-updated / popstate）后都会 syncAll({force:true})，对「仍启用」的功能
// 走「先 disable 再 enable」的重建路径；进入 watch 页时这些事件会连着触发好几次。
//
// 而本功能的 disable 原本是 `getPlayer()?.unloadModule?.("captions")`——真的把字幕
// 模块卸掉（= 关掉字幕），方向与功能语义完全相反；enable 又是不返回 Promise 的
// `void retry(...)`，两者并发时净效果是「开着自动开启字幕，切个视频字幕反而没了」。
// 这与此前修掉的 automaticTheaterMode 是同一类缺陷。
//
// 现在 disable 是空操作。本测试钉住：重同步过程中不得调用 unloadModule，字幕保持开着。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** YouTube 切字幕不是同步生效的：点完按钮，aria-pressed 要过一拍才变。 */
const APPLY_DELAY = 20;

async function main() {
  let captionsOn = false;
  const unloadCalls = [];

  const button = {
    getAttribute(name) {
      return name === 'aria-pressed' ? String(captionsOn) : null;
    },
    click() {
      setTimeout(() => { captionsOn = true; }, APPLY_DELAY);
    },
  };

  const document = {
    readyState: 'loading', // 让 runtime 不自动 start()，由测试手动驱动导航
    addEventListener() {},
    createElement: () => ({ id: '', textContent: '', isConnected: true }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { classList: { toggle() {} }, style: { setProperty() {}, removeProperty() {} } },
    querySelector(sel) {
      if (sel === 'button.ytp-subtitles-button') return button;
      return null;
    },
  };

  const config = { automaticallyEnableClosedCaptions: { enabled: true } };
  const schema = JSON.parse(read('enhancer/schema.json'));

  const runtime = {
    window: {
      __YTE_CONFIG__: config, __YTE_SCHEMA__: schema,
      addEventListener() {}, dispatchEvent() {}, ipc: { postMessage() {} },
    },
    document,
    console: { debug() {}, log() {} },
    performance,
    location: { pathname: '/watch', search: '?v=abc', href: 'https://www.youtube.com/watch?v=abc' },
    setTimeout, clearTimeout, queueMicrotask, URLSearchParams,
    Event: class {},
  };
  vm.runInNewContext(read('enhancer/runtime.js'), runtime);
  const YTE = runtime.window.__YTE;

  const source = read('enhancer/features.js');
  const extract = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `无法从 features.js 截取 ${start} … ${end}`);
    return source.slice(from, to);
  };

  const ctx = {
    F: YTE.features,
    document,
    performance,
    setTimeout,
    clearTimeout,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // 旧实现会经这里卸载字幕模块（异步把字幕关掉）；新实现不该再碰它
    getPlayer: () => ({
      unloadModule(name) {
        unloadCalls.push(name);
        if (name === 'captions') setTimeout(() => { captionsOn = false; }, APPLY_DELAY);
      },
    }),
  };
  vm.runInNewContext(extract('async function retry(task', 'async function withPlayer(handler)'), ctx);
  vm.runInNewContext(extract('const subtitlesButton =', '// 自动进影院模式'), ctx);
  assert.ok(YTE.features.automaticallyEnableClosedCaptions, '未注册 automaticallyEnableClosedCaptions');

  await YTE.syncAll({ force: true }); // 进入 watch 页
  await sleep(150);
  assert.equal(captionsOn, true, '首次同步后字幕应当已开启');

  await YTE.syncAll({ force: true }); // yt-page-data-updated 带来的第二次重同步
  await sleep(600);

  assert.equal(
    unloadCalls.length,
    0,
    `重同步时不应该卸载字幕模块（实际调用 ${unloadCalls.length} 次）`
  );
  assert.equal(captionsOn, true, `重同步后字幕应当仍开着，但实际 captionsOn=${captionsOn}`);

  console.log('通过：自动开启字幕在 SPA 重同步时不会被关掉，unloadModule 调用次数 =', unloadCalls.length);
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
