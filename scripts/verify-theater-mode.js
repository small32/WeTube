// node scripts/verify-theater-mode.js (no external dependencies)
//
// 回归测试：automaticTheaterMode 不得在 SPA 重同步时把影院模式关掉。
//
// 背景：runtime 在每次导航事件（yt-navigate-start / yt-navigate-finish /
// yt-page-data-updated / popstate）后都会 syncAll({force:true})。进入 watch 页时
// 这些事件会连着来好几个，于是同一个功能会被「强制重建」多次：
//
//   syncFeatureNow: 先 disable()，再 enable()
//
// automaticTheaterMode 的 enable/disable 都是 `void retry(...)`——**不返回 Promise**，
// 所以 runtime 那句 `await impl.disable()` 立刻返回，disable 和 enable 两个重试循环
// 会并发跑。又因为 YouTube 切影院模式是异步生效的（点完按钮 DOM 上的 theater 属性
// 不会立刻变），实际时序是：
//
//   1. disable 第一次检查：还在影院模式 → 点按钮要求「退出」
//   2. enable  第一次检查：属性还没变，看起来「已经在影院模式」→ 直接成功返回，什么都不做
//   3. 上一步那次点击随后生效 → 影院模式被关掉
//
// 最终净效果是关掉影院模式，用户看到的就是「设置了自动进入影院模式，进视频却恢复默认」。
//
// 本测试用真实的 runtime.js（syncFeatureNow 的真实调度语义）+ 真实的 features.js
// 片段 + 真实 schema.json，配一个「点击后延迟生效」的假 YouTube 来复现这个竞态。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** YouTube 切影院模式不是同步生效的：点完按钮，DOM 上的 theater 属性要过一会儿才变。 */
const APPLY_DELAY = 20;

async function main() {
  // ---- 假 YouTube：一个 theater 开关 + 播放器上的尺寸按钮 ----
  let theater = false;
  const transitions = []; // 记录每次真实生效的切换，用于断言「一次都没被关过」
  const sizeButton = {
    click() {
      setTimeout(() => {
        theater = !theater;
        transitions.push(theater);
      }, APPLY_DELAY);
    },
  };

  const document = {
    readyState: 'loading', // 让 runtime 不自动 start()，由测试手动驱动导航
    addEventListener() {},
    createElement: () => ({ id: '', textContent: '', isConnected: true }),
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector(sel) {
      // features.js 里 inTheaterMode() 用的联合选择器
      if (sel.includes('watch-grid[theater]')) return theater ? {} : null;
      if (sel === 'button.ytp-size-button') return sizeButton;
      return null;
    },
  };

  const config = { automaticTheaterMode: { enabled: true } };
  const schema = JSON.parse(read('enhancer/schema.json'));

  const runtime = {
    window: { __YTE_CONFIG__: config, __YTE_SCHEMA__: schema, addEventListener() {}, dispatchEvent() {}, ipc: { postMessage() {} } },
    document,
    console: { debug() {}, log() {} },
    performance,
    location: { pathname: '/watch', search: '?v=abc', href: 'https://www.youtube.com/watch?v=abc' },
    setTimeout,
    clearTimeout,
    queueMicrotask,
    URLSearchParams,
    Event: class {},
  };
  vm.runInNewContext(read('enhancer/runtime.js'), runtime);
  const YTE = runtime.window.__YTE;

  // ---- 注入真实的 retry + automaticTheaterMode ----
  const source = read('enhancer/features.js');
  const extract = (start, end) => {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, `无法从 features.js 截取 ${start} … ${end}`);
    return source.slice(from, to);
  };

  const featureCtx = {
    F: YTE.features,
    document,
    performance,
    setTimeout,
    clearTimeout,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  vm.runInNewContext(extract('async function retry(task', 'async function withPlayer(handler)'), featureCtx);
  vm.runInNewContext(extract('// 自动进影院模式', '// 自动最大化播放器'), featureCtx);
  assert.ok(YTE.features.automaticTheaterMode, '未注册 automaticTheaterMode');

  // ---- 场景：进入 watch 页，随后又来一次导航事件触发强制重同步 ----
  await YTE.syncAll({ force: true }); // 第 1 次：yt-navigate-finish
  await sleep(150);
  assert.equal(theater, true, '首次同步后应当已进入影院模式');

  await YTE.syncAll({ force: true }); // 第 2 次：yt-page-data-updated（进入视频时必然发生）
  await sleep(600); // 等所有重试循环跑完

  assert.equal(
    transitions.includes(false),
    false,
    `重同步过程中影院模式被关掉了（切换序列：${JSON.stringify(transitions)}）`
  );
  assert.equal(theater, true, `最终应当仍在影院模式，但实际 theater=${theater}（切换序列：${JSON.stringify(transitions)}）`);

  // ---- 场景：关闭功能、再打开，仍应生效 ----
  config.automaticTheaterMode.enabled = false;
  await YTE.syncAll({ force: true });
  await sleep(150);
  config.automaticTheaterMode.enabled = true;
  await YTE.syncAll({ force: true });
  await sleep(600);
  assert.equal(theater, true, '重新启用后应当回到影院模式');

  console.log('通过：自动进入影院模式在 SPA 重同步时不会被关掉，切换序列 =', JSON.stringify(transitions));
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
