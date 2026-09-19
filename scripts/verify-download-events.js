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
