// init_script 注入内容的回归测试。两步：
//   1) 先生成 fixture（**环境变量**只是给 cargo test 判断"该往外写文件了"）：
//        WETUBE_BOOTSTRAP_FIXTURE=/tmp/bootstrap.js cargo test bootstrap_fixture
//   2) 再跑这个脚本，fixture 路径是**命令行参数**，不是环境变量：
//        node scripts/verify-bootstrap.js /tmp/bootstrap.js   （需要 jsdom）
// 注意它不在 `npm run verify` 链里——因为依赖第 1 步的 cargo test 先跑完。
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(process.argv[2], 'utf8')
  .replace('window.__WETUBE_PLATFORM__ = "macos";', 'window.__WETUBE_PLATFORM__ = "windows";');
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
let config = {hidePosts: {enabled: false}};
let shortcuts = [{id: 'reload', spec: 'Mod+KeyR'}];
const windows = [];

async function page(trusted = true) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: trusted ? 'https://www.youtube.com/' : 'https://accounts.google.com/signin',
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const { window } = dom;
  windows.push(window);
  const sent = [];
  window.confirm = () => true;
  window.ipc = {postMessage(message) {
    sent.push(message);
    if (!message.startsWith('{')) return;
    const event = JSON.parse(message);
    if (event.type === 'app:ready') {
      // Real IPC dispatch is asynchronous, so answer after the injected script returns.
      window.setTimeout(() => window.__wetubeBootstrap(event.pageId,
        structuredClone(trusted ? config : {}), structuredClone(shortcuts), trusted), 0);
    } else if (event.type === 'config:set') {
      config[event.feature] ||= {};
      config[event.feature][event.key] = event.value;
    } else if (event.type === 'config:reset') {
      config = {hidePosts: {enabled: false}};
      window.__YTE.replaceConfig(structuredClone(config));
    } else if (event.type === 'download:sync') {
      window.__wetubeDownloadEvent({kind: 'snapshot', events: [
        {kind: 'started', id: 9, requestId: 'old-page:1', title: 'Restored download', url: 'https://www.youtube.com/watch?v=9'},
        {kind: 'progress', id: 9, progress: {percent: '40%'}},
      ]});
    }
  }};
  window.eval(source);
  await pause();
  return {window, sent};
}

async function main() {
  const first = await page();
  first.window.__YTE.setConfig('hidePosts', 'enabled', true);
  shortcuts = [{id: 'reload', spec: 'Mod+Shift+KeyR'}];
  first.window.close();
  const second = await page();
  assert.equal(second.window.__YTE.cfg('hidePosts', 'enabled'), true);
  assert(second.window.document.body.classList.contains('yte-hide-posts'));
  assert.equal(second.window.__WETUBE_SHORTCUTS__[0].spec, 'Mod+Shift+KeyR');
  assert(second.window.document.querySelector('.dl-task').textContent.includes('Restored download'));
  assert.equal(second.window.document.querySelector('.t-bar > div').style.width, '40%');
  second.window.document.querySelector('.t-cancel').click();
  assert(second.sent.includes(JSON.stringify({type: 'download:cancel', id: 9})));
  second.window.__YTE.openPanel();
  second.window.document.querySelector('#yte-settings-panel footer button').click();
  await pause();
  assert.equal(second.window.__YTE.cfg('hidePosts', 'enabled'), false);
  assert(!second.window.document.body.classList.contains('yte-hide-posts'));
  assert.equal(second.window.document.querySelector('[data-feature="hidePosts"] input').checked, false);
  const login = await page(false);
  assert.equal(login.window.__YTE, undefined);
  assert(login.window.document.querySelector('.wetube-winbtn.close'));
  login.window.document.querySelector('.wetube-winbtn.close').click();
  assert(login.sent.includes('window-close'));
  assert(!login.sent.some((m) => m.includes('download:sync')));
  console.log('Full bootstrap, reload, reset, download recovery and login chrome regressions passed.');
}
main().catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => windows.forEach((window) => window.close()));
