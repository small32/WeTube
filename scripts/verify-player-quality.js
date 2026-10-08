// node scripts/verify-player-quality.js (no external dependencies)
//
// 回归测试：playerQuality 的 fallbackStrategy 必须真的生效。
//   lower（默认，也是本功能一直以来的行为）：接受**不高于**目标的档位
//   higher：接受**不低于**目标的档位
// 另外钉住「未知档位一律接受」——否则播放器日后加了新档位会把重试空转到 10 秒超时。
//
// 第二组：disable 只在 enable **真的设过画质**时才复位（qualityApplied）。
// 每次 SPA 导航 runtime 都会 force 重放（disable → enable），无条件复位会让
// 画质在每次切视频时先掉回 auto 再设回来，播放器跟着重新缓冲。

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const read = (name) => fs.readFileSync(path.join(__dirname, '../src', name), 'utf8');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ORDER = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'hd2880', 'highres'];

/**
 * mode = "cap"（只肯给到 hd1080）或 "unknown"（返回一个表里没有的档位）
 * isEnabled 用来模拟 runtime 的 featureEnabled 查询：force 重放时它仍是 true。
 */
function load(mode, { isEnabled = () => false } = {}) {
  const calls = [];
  const player = {
    quality: 'medium',
    async setPlaybackQualityRange(q) {
      calls.push(q);
      if (mode === 'unknown') { this.quality = 'someFutureQuality'; return; }
      this.quality = ORDER.indexOf(q) > ORDER.indexOf('hd1080') ? 'hd1080' : q;
    },
    async getPlaybackQuality() { return this.quality; },
  };

  const source = read('enhancer/features.js');
  // slice 的起点要在 `let qualityApplied = false;` 之前，否则 enable/disable
  // 一碰这个变量就是 ReferenceError（它和 F.playerQuality 是两个独立声明）。
  const from = source.indexOf('\t// 默认画质');
  const to = source.indexOf('// 固定音量', from);
  assert.ok(from >= 0 && to > from, '无法从 features.js 截取 playerQuality');
  const ctx = {
    F: {},
    YTE: { isEnabled },
    performance,
    setTimeout,
    clearTimeout,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitForPlayer: async () => player,
    getPlayer: () => player,
  };
  vm.runInNewContext(source.slice(from, to), ctx);

  const rFrom = source.indexOf('async function retry(task');
  const rTo = source.indexOf('async function withPlayer(handler)');
  assert.ok(rFrom >= 0 && rTo > rFrom, '无法从 features.js 截取 retry');
  vm.runInNewContext(source.slice(rFrom, rTo), ctx);

  return { impl: ctx.F.playerQuality, calls };
}

async function main() {
  // 1) 默认 lower：目标 hd2160 拿不到（只给 hd1080）→ 应当接受，首次尝试就结束
  {
    const { impl, calls } = load('cap');
    await impl.enable({ quality: 'hd2160' });
    assert.equal(calls.length, 1, `lower 应在首次尝试后就接受降级，实际尝试 ${calls.length} 次`);
  }

  // 2) higher：同样的降级不该被接受 → 会继续重试
  {
    const { impl, calls } = load('cap');
    void impl.enable({ quality: 'hd2160', fallbackStrategy: 'higher' });
    await sleep(700); // retry 的 interval 是 500ms，要等过一轮才能看到第二次尝试
    assert.ok(calls.length >= 2, `higher 不该接受降级，应继续重试，实际只尝试 ${calls.length} 次`);
  }

  // 3) 未知档位一律接受，两种策略都不该把重试卡死
  for (const strategy of [undefined, 'higher', 'lower']) {
    const { impl, calls } = load('unknown');
    await impl.enable({ quality: 'hd2160', fallbackStrategy: strategy });
    assert.equal(calls.length, 1, `未知档位应被接受（strategy=${strategy}），实际尝试 ${calls.length} 次`);
  }

  // 4) 从没设过画质时 disable 不该碰播放器
  {
    const { impl, calls } = load('cap');
    await impl.disable();
    assert.deepEqual(calls, [], `没设过画质却调了设置器：${JSON.stringify(calls)}`);
  }

  // 5) 设过之后 disable 要复位成 auto
  {
    const { impl, calls } = load('cap');
    await impl.enable({ quality: 'hd1080' });
    await impl.disable();
    assert.deepEqual(calls, ['hd1080', 'auto'], `复位序列不对：${JSON.stringify(calls)}`);
  }

  // 6) force 重放（功能仍处于开启态）：disable 不复位，画质不该在切视频时抖一下
  {
    const { impl, calls } = load('cap', { isEnabled: () => true });
    await impl.enable({ quality: 'hd1080' });
    await impl.disable();
    assert.deepEqual(calls, ['hd1080'], `force 重放时不该复位成 auto：${JSON.stringify(calls)}`);
    await impl.enable({ quality: 'hd1080' });
    assert.deepEqual(calls, ['hd1080', 'hd1080']);
  }

  // 7) quality 设成 auto/空时视为"没设过"：随后 disable 也不该再动播放器
  {
    const { impl, calls } = load('cap');
    await impl.enable({ quality: 'auto' });
    await impl.disable();
    assert.deepEqual(calls, [], `auto 不该调用设置器：${JSON.stringify(calls)}`);
  }

  console.log('通过：fallbackStrategy 的 lower/higher 语义、未知档位兜底与 qualityApplied 复位时机都正确。');
}

main()
  .then(() => process.exit(0)) // 情形 2 会留下未跑完的重试定时器，显式退出
  .catch((err) => {
    console.error('失败：', err.message);
    process.exit(1);
  });
