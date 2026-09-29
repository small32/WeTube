// Run with node scripts/verify-download-events.js; no external dependencies.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../src/download-panel.js'), 'utf8');
const start = source.indexOf('window.__wetubeDownloadEvent =');
const end = source.indexOf('  if (document.readyState', start);
assert(start >= 0 && end > start);
const task = { state: 'running', fill: { style: {} }, left: {}, cancel: { style: {} } };
const context = { window: {}, tasks: new Map([['task:7', task]]) };
vm.runInNewContext(source.slice(start, end), context);
const send = context.window.__wetubeDownloadEvent;
for (const [percent, expected] of [['0.0%', '0%'], ['12.5%', '12.5%'], ['99.9%', '99.9%'], ['100.0%', '100%'], ['NA', '50%'], ['-2%', '0%'], ['120%', '100%']]) {
  send({ kind: 'progress', id: 7, progress: { percent } });
  assert.equal(task.fill.style.width, expected);
}
send({ kind: 'cancelled', id: 7, killed: false });
assert.equal(task.state, 'running');
assert.match(task.left.textContent, /取消未成功/);
send({ kind: 'cancelled', id: 7, killed: true });
// cancelled 是中间状态，不设置终态，等待 cleanup 线程的最终结果
assert.equal(task.left.textContent, '已取消');
console.log('Download progress and cancellation event regressions passed.');

function card(requestId) {
  return { requestId, state: 'queued', fill: { style: {} }, left: {}, cancel: { style: {} },
    el: { classList: { add() {} } } };
}
const a = card('request-A'), b = card('request-B');
context.tasks = new Map([['probe:A', a], ['probe:B', b]]);
let cancelled;
context.send = (event) => { cancelled = event.id; };
context.makeCard = (key, title) => {
  const result = card(); result.title = title; context.tasks.set(key, result); return result;
};
send({kind: 'started', id: 42, requestId: 'request-B', url: 'B'});
assert.equal(context.tasks.get('task:42'), b);
assert.equal(a.state, 'queued');
b.cancel.onclick();
assert.equal(cancelled, 42);
send({kind: 'fail', id: 0, requestId: 'request-A'});
assert.equal(a.state, 'failed');
assert.equal(b.state, 'running');

// 新页面没有任何卡片：后端快照应重建任务并恢复终态。
context.tasks = new Map();
const snapshot = {kind: 'snapshot', events: [
  {kind: 'started', id: 42, requestId: 'request-B', title: 'Video B', url: 'B'},
  {kind: 'progress', id: 42, progress: {percent: '70%'}},
  {kind: 'started', id: 43, requestId: 'request-C', title: 'Video C', url: 'C'},
  {kind: 'done', id: 43, detail: 'saved.mp4'},
]};
send(snapshot);
assert.equal(context.tasks.get('task:42').fill.style.width, '70%');
assert.equal(context.tasks.get('task:43').state, 'done');
send(snapshot);
assert.equal(context.tasks.size, 2);
context.tasks.get('task:42').cancel.onclick();
assert.equal(cancelled, 42);
console.log('Download correlation and reload recovery regressions passed.');
