/*
 * 设置面板「数字输入框」的校验回归（jsdom）。
 *
 * `<input type="number">` 被清空时 `input.value === ""`，而 `Number("") === 0`——
 * 旧实现直接把这个 0 写进配置。于是「清空重输」这个很常见的操作会把设置悄悄改成 0，
 * 而 0 往往低于 schema 的 min：以滚轮调倍速的 steps 为例，0 会让
 * `Math.round(x / 0) * 0` 得到 NaN，给 video.playbackRate 赋值直接抛 TypeError。
 * min/max 只是 HTML 属性，不点表单的提交按钮浏览器不会自动裁剪。
 *
 * 用法：
 *   npm install
 *   node scripts/verify-panel-input.js
 *
 * 退出码 0 = 全部通过，1 = 有失败项。
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SRC = process.env.WETUBE_SRC || path.join(__dirname, "..", "src");
const schema = JSON.parse(fs.readFileSync(path.join(SRC, "enhancer", "schema.json"), "utf8"));

const checks = [];
const check = (name, ok, detail) => { checks.push([name, ok, detail]); };

function setup(config) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body></body></html>`, {
    url: "https://www.youtube.com/watch?v=aaaaaaaaaaa",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const writes = [];
  const data = JSON.parse(JSON.stringify(config));

  const read = (id, key) => {
    if (!key) return data[id];
    return key.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), data[id]);
  };

  window.__YTE = {
    schema,
    features: {},
    cfg: read,
    setConfig(id, key, value) {
      writes.push([id, key, value]);
      const parts = key.split(".");
      let node = (data[id] ??= {});
      for (const part of parts.slice(0, -1)) node = (node[part] ??= {});
      node[parts[parts.length - 1]] = value;
    },
    isEnabled: () => true,
    syncFeature() {},
    log() {},
  };

  window.eval(fs.readFileSync(path.join(SRC, "enhancer", "panel.js"), "utf8"));
  window.__YTE.togglePanel();
  return { window, writes, data };
}

/** 按 label 文本定位输入框。 */
function inputByLabel(window, label) {
  const field = [...window.document.querySelectorAll(".yte-field")]
    .find((f) => f.querySelector("label")?.textContent === label);
  return field?.querySelector("input") ?? null;
}

{
  // scrollWheelSpeedControl.steps：number，min 0.05 / max 2 / default 0.25
  const { window, writes } = setup({
    scrollWheelSpeedControl: { enabled: true, steps: 0.25, modifierKey: "altKey" },
  });
  const input = inputByLabel(window, "步长");
  check("找得到「步长」数字输入框", !!input && input.type === "number");

  const commit = (value) => {
    input.value = value;
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  };

  writes.length = 0;
  commit("");
  check("清空输入框不写配置", writes.length === 0, JSON.stringify(writes));
  check("清空后回填原值", input.value === "0.25", `value=${input.value}`);

  writes.length = 0;
  commit("0");
  check("低于 min 裁剪到 0.05 再写", writes.length === 1 && writes[0][2] === 0.05, JSON.stringify(writes));
  check("裁剪后的值回填到输入框", input.value === "0.05", `value=${input.value}`);

  writes.length = 0;
  commit("999");
  check("高于 max 裁剪到 2 再写", writes.length === 1 && writes[0][2] === 2, JSON.stringify(writes));

  writes.length = 0;
  commit("abc");
  check("非数字不写配置", writes.length === 0, JSON.stringify(writes));

  writes.length = 0;
  commit("1.5");
  check("合法值原样写入", writes.length === 1 && writes[0][2] === 1.5, JSON.stringify(writes));
}

/* ---- 输出 ---- */
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✔" : "✘"} ${name}${ok || !detail ? "" : `  ← ${detail}`}`);
  if (!ok) failed += 1;
}
console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${checks.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
