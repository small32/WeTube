// node scripts/verify-enhancer-features.js (no external dependencies)
//
// enhancer 里几个"静默退化、肉眼很难发现"的点的回归测试：
//
//   A. videoHistory 的节流落盘与定时器回收（R5）
//      flush() 原来只把 flushTimer 置 null 而不 clearTimeout，收尾写完盘之后
//      那个 10 秒定时器还活着；再 scheduleFlush() 又新建一个 —— 实测 5 轮
//      enable/disable 残留 7 个孤儿定时器。
//   B. skipContinueWatching 的还原对象（E14）
//      disable 原来拿"当前 querySelector 到的元素"去还原。SPA 换过 DOM 之后
//      拿到的是新元素：旧元素被改坏且永远不还原，新元素还被装上了旧元素的方法。
//   C. pageType 的 /live 判定（E13）
//      裸 startsWith("/live") 会把 /live_chat、/live_chat_replay 判成 watch，
//      而这些页面没有播放器，依赖播放器的功能会白等 10 秒超时。
//
// 用法：node scripts/verify-enhancer-features.js
// 退出码 0 = 通过，1 = 有失败项。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const SRC = process.env.WETUBE_SRC || path.join(__dirname, '..', 'src');
const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');

const checks = [];
const check = (name, ok, detail) => checks.push([name, ok, detail]);

const featuresSrc = read('enhancer/features.js');
/** 从 features.js 里切一段出来单独跑——比整篇加载省事得多。 */
function slice(from, to) {
  const a = featuresSrc.indexOf(from);
  const b = a >= 0 ? featuresSrc.indexOf(to, a) : -1;
  assert.ok(a >= 0 && b > a, `切片失败：${JSON.stringify(from)} → ${JSON.stringify(to)}`);
  return featuresSrc.slice(a, b);
}

/* ============================================================ A. videoHistory */

function loadVideoHistory() {
  const timers = new Map();
  let nextId = 1;
  const written = [];
  const handlers = {};
  const listeners = {};
  const video = { currentTime: 3, duration: 100 };

  const ctx = {
    F: {},
    window: {
      addEventListener: (type, fn) => { listeners[`w:${type}`] = fn; },
      removeEventListener: (type, fn) => { if (listeners[`w:${type}`] === fn) delete listeners[`w:${type}`]; },
    },
    document: {
      title: '标题',
      visibilityState: 'visible',
      getElementById: () => null,
      addEventListener: (type, fn) => { listeners[`d:${type}`] = fn; },
      removeEventListener: (type, fn) => { if (listeners[`d:${type}`] === fn) delete listeners[`d:${type}`]; },
    },
    URLSearchParams,
    Date,
    console: { warn() {} },
    // 只登记不执行：测试自己决定什么时候"到点"
    setTimeout: (fn) => { const id = nextId++; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
    waitForPlayer: async () => ({ querySelector: () => video }),
    videoData: async () => ({ video_id: 'abc', title: '标题' }),
    readHistory: () => ({ abc: { time: 50, duration: 100 } }),
    writeHistory: (h) => written.push(JSON.parse(JSON.stringify(h))),
    showResumePrompt: () => {},
    // on/off 用的是 YTE 那套 (target, event, handler, tag) 签名：
    // 按 tag 记账，off(tag) 时要把它注册过的那条一起摘掉。
    on: (_target, evt, handler, tag) => { handlers[tag || evt] = handler; handlers[evt] = handler; },
    off: (tag) => {
      const fn = handlers[tag];
      if (!fn) return;
      for (const key of Object.keys(handlers)) {
        if (handlers[key] === fn) delete handlers[key];
      }
    },
  };
  ctx.location = { search: '?v=abc', href: 'https://www.youtube.com/watch?v=abc' };

  vm.runInNewContext(slice('\tF.videoHistory = {', '\n\tfunction showResumePrompt('), ctx);
  return { impl: ctx.F.videoHistory, timers, written, handlers, listeners, video };
}

async function caseVideoHistory() {
  const vh = loadVideoHistory();
  await vh.impl.enable();

  check('A1 enable 后挂上 timeupdate', typeof vh.handlers.timeupdate === 'function');
  check('A2 enable 后监听 pagehide / visibilitychange',
    typeof vh.listeners['w:pagehide'] === 'function' && typeof vh.listeners['d:visibilitychange'] === 'function');

  vh.handlers.timeupdate();
  check('A3 第一次 timeupdate 起了落盘定时器', vh.timers.size === 1, `timers=${vh.timers.size}`);
  vh.handlers.timeupdate();
  vh.handlers.timeupdate();
  check('A4 连续 timeupdate 只保留一个定时器（这就是节流）', vh.timers.size === 1, `timers=${vh.timers.size}`);
  check('A5 节流期间不落盘', vh.written.length === 0, JSON.stringify(vh.written));

  vh.impl.persist();
  check('A6 persist 立即落盘一次', vh.written.length === 1, `written=${vh.written.length}`);
  check('A7 落盘内容是最新进度', vh.written[0]?.abc?.time === 3, JSON.stringify(vh.written[0]));
  check('A8 persist 后定时器被 clear（R5 的核心：不留孤儿）', vh.timers.size === 0, `timers=${vh.timers.size}`);
  check('A9 persist 后摘掉收尾监听',
    !vh.listeners['w:pagehide'] && !vh.listeners['d:visibilitychange'], JSON.stringify(Object.keys(vh.listeners)));

  // 再走一轮：定时器数必须回到 1 → 0，不能 1 → 2
  vh.handlers.timeupdate();
  check('A10 第二轮重新起一个定时器', vh.timers.size === 1, `timers=${vh.timers.size}`);
  vh.handlers.persist?.();
  vh.impl.persist();
  check('A11 第二轮收尾后仍是 0 个定时器（没有累积）', vh.timers.size === 0, `timers=${vh.timers.size}`);

  // disable 也要把内存里的进度写掉
  const vh2 = loadVideoHistory();
  await vh2.impl.enable();
  vh2.handlers.timeupdate();
  vh2.impl.disable();
  check('A12 disable 会把没落盘的进度写掉', vh2.written.length === 1, `written=${vh2.written.length}`);
  check('A13 disable 后没有残留定时器', vh2.timers.size === 0, `timers=${vh2.timers.size}`);
  check('A14 disable 后摘掉 timeupdate', typeof vh2.handlers.timeupdate !== 'function');
}

/* ==================================================== B. skipContinueWatching */

function loadSkipContinueWatching() {
  const oldEl = { name: 'old', autoContinue: () => 'old-real' };
  const newEl = { name: 'new', autoContinue: () => 'new-real' };
  let queried = oldEl;
  const ctx = {
    F: {},
    // 只能查到"当前"的那个元素——正是这个函数里的陷阱：它跟 enable 时不是同一个
    document: { querySelector: () => queried },
    console: { warn() {} },
    CONTINUE_WATCHING_HOOKS: ['autoContinue', 'legacyHook'],
  };
  vm.runInNewContext(
    slice('\tF.skipContinueWatching = {', '\t// ---------------------------------------------------------------- 播放器自动化'),
    ctx,
  );
  return { impl: ctx.F.skipContinueWatching, oldEl, newEl, setQuery: (el) => { queried = el; } };
}

function caseSkipContinueWatching() {
  const s = loadSkipContinueWatching();
  s.impl.enable();
  check('B1 enable 把被改的元素记下来了', s.impl.element === s.oldEl);
  check('B2 enable 后原方法被摘掉', s.oldEl.autoContinue() === undefined);

  // SPA 换了 DOM：querySelector 现在返回另一个元素
  s.setQuery(s.newEl);
  s.impl.disable();
  check('B3 disable 还原的是被改过的那个元素（拿新元素还原就永远修不回来）',
    s.oldEl.autoContinue() === 'old-real', `old=${s.oldEl.autoContinue()}`);
  check('B4 新元素没被写进旧元素的方法', s.newEl.autoContinue() === 'new-real', `new=${s.newEl.autoContinue()}`);
  check('B5 disable 后清空记录', s.impl.element === null && s.impl.hook === null && s.impl.original === null);

  // 没有续播回调时不能改坏元素
  const s2 = loadSkipContinueWatching();
  const bare = { name: 'bare' };
  s2.setQuery(bare);
  s2.impl.enable();
  check('B6 找不到回调时不改动元素、也不记状态', bare.autoContinue === undefined && !s2.impl.element);
}

/* =============================================================== C. pageType */

function casePageType() {
  const ctx = {
    window: { __YTE_CONFIG__: {}, dispatchEvent() {} },
    document: { readyState: 'loading', addEventListener() {} },
    console,
    Event: class {},
  };
  vm.runInNewContext(read('enhancer/runtime.js'), ctx);
  const pageType = ctx.window.__YTE?.pageType;
  if (typeof pageType !== 'function') {
    check('C0 runtime 导出了 pageType', false, 'YTE.pageType 不是函数');
    return;
  }
  const type = (pathname, search = '') => {
    ctx.location = { pathname, search, href: `https://www.youtube.com${pathname}${search}` };
    return pageType();
  };

  check('C1 /live 直播页按 watch 处理', type('/live') === 'watch', type('/live'));
  check('C2 /live/<id> 直播页按 watch 处理', type('/live/AbCdEfGh') === 'watch', type('/live/AbCdEfGh'));
  // 这两条是修复点：它们没有播放器，判成 watch 会让功能白等 10 秒超时
  check('C3 /live_chat 不算 watch', type('/live_chat') !== 'watch', type('/live_chat'));
  check('C4 /live_chat_replay 不算 watch', type('/live_chat_replay') !== 'watch', type('/live_chat_replay'));
  check('C5 /watch 仍是 watch', type('/watch', '?v=x') === 'watch', type('/watch', '?v=x'));
  check('C6 首页仍是 home', type('/') === 'home', type('/'));
  check('C7 /feed/subscriptions 仍是 subscriptions',
    type('/feed/subscriptions') === 'subscriptions', type('/feed/subscriptions'));
}

/* ================================================================ 执行 */

(async () => {
  try {
    await caseVideoHistory();
    caseSkipContinueWatching();
    casePageType();
  } catch (err) {
    console.error('脚本异常：', err && err.stack ? err.stack : err);
    process.exit(1);
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✔' : '✘'} ${name}${ok || !detail ? '' : `  ← ${detail}`}`);
    if (!ok) failed += 1;
  }
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（共 ${checks.length} 项）`);
  process.exit(failed === 0 ? 0 : 1);
})();
