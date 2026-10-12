// 装车插件端到端测量：卡顿（long task）、装载耗时、勾选记录是否丢失。
// 用法：NODE_PATH=$(npm root -g) node run.js <bundle> "<mock 参数>" [选项 JSON]
//   选项：{"pick":[2,15,29],"waitBeforeCheck":3000,"profile":"out.cpuprofile"}
const { chromium } = require("playwright");
const fs = require("fs");

async function run(bundle, query, options = {}) {
  fs.copyFileSync(bundle, "bundle.js");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__long = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push({ start: e.startTime, dur: e.duration }))).observe({ entryTypes: ["longtask"] });
  });
  let cdp;
  if (options.profile) {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  const t0 = Date.now();
  await page.goto(`http://localhost:8765/index.html?${query}`);
  await page.waitForFunction(() => document.querySelectorAll("tbody input[type=checkbox]").length > 0, null, { timeout: 60000 });
  const firstRowsMs = Date.now() - t0;
  // 等待后台补读结束（无在途请求持续 1.5 秒）
  const settle = async (limit = 90000) => {
    const start = Date.now();
    let idleSince = 0;
    while (Date.now() - start < limit) {
      const busy = await page.evaluate(() => window.__mock.inflight + window.__mock.queued);
      if (!busy) { if (!idleSince) idleSince = Date.now(); if (Date.now() - idleSince > 1500) return Date.now() - start - 1500; }
      else idleSince = 0;
      await page.waitForTimeout(100);
    }
    return -1;
  };
  let loadSettleMs = null;
  if (options.waitBeforeCheck === "settle") loadSettleMs = firstRowsMs + (await settle());
  else await page.waitForTimeout(options.waitBeforeCheck ?? 3000);
  const loadPhase = await page.evaluate(() => {
    const list = window.__long.slice();
    return { calls: window.__mock.calls.length, longTasks: list.length, longTaskMs: Math.round(list.reduce((a, b) => a + b.dur, 0)), longestMs: Math.round(Math.max(0, ...list.map((x) => x.dur))) };
  });

  const pick = options.pick || [2, 15, 29];
  const picked = pick.map((index) => `d-${String(index + 1).padStart(4, "0")}`);
  const targets = await page.evaluate((ids) => ids.map((rowId) => {
    const record = window.__mock.detailStore.get(rowId);
    const key = Object.keys(record).find((k) => typeof record[k] === "string" && record[k].includes('"X26'));
    return { rowId, workOrder: JSON.parse(record[key])[0].name, customer: window.__mock.customerOf(rowId) };
  }), picked);
  const checkLatency = [];
  for (const { workOrder, customer } of targets) {
    // 像操作员一样：先在左侧汇总里点客户，再在右侧勾选该客户的明细
    await page.locator("td button", { hasText: new RegExp(`^${customer}$`) }).first().click();
    await page.waitForTimeout(200);
    const row = page.locator("tbody tr").filter({ has: page.locator("td", { hasText: new RegExp(`^${workOrder}$`) }) }).first();
    await row.scrollIntoViewIfNeeded();
    const t = Date.now();
    await row.locator("input[type=checkbox]").check();
    await page.waitForFunction((wo) => {
      const tr = Array.from(document.querySelectorAll("tbody tr")).find((el) => Array.from(el.children).some((td) => td.innerText.trim() === wo));
      return tr && tr.querySelector("input[type=checkbox]").checked;
    }, workOrder);
    checkLatency.push(Date.now() - t);
    await page.waitForTimeout(options.gap ?? 150);
  }
  const longBeforeLoad = await page.evaluate(() => window.__long.length);
  const loadButton = page.locator("button:not([draggable])", { hasText: /^装载$/ });
  const tClick = Date.now();
  await loadButton.click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim() === "装载中"), null, { timeout: 180000 });
  const loadingMs = Date.now() - tClick;
  const statusAfter = await page.evaluate(() => document.querySelector("span[title]")?.innerText || "");
  await page.waitForTimeout(options.after ?? 7000);
  const result = await page.evaluate(({ picked, longBeforeLoad }) => {
    const m = window.__mock;
    const loadedIds = m.loaded.map((x) => x.rowId);
    const visibleChecked = Array.from(document.querySelectorAll("tbody tr")).filter((tr) => tr.querySelector("input[type=checkbox]")?.checked).length;
    const list = window.__long.slice(longBeforeLoad);
    return {
      loaded: loadedIds,
      lost: picked.filter((id) => !loadedIds.includes(id)),
      extraLoaded: loadedIds.filter((id) => !picked.includes(id)),
      stillInRelation: picked.filter((id) => m.relationIds.includes(id)),
      visibleChecked,
      status: document.querySelector("span[title]")?.innerText || "",
      loadingLongTasks: list.length,
      loadingLongTaskMs: Math.round(list.reduce((a, b) => a + b.dur, 0)),
      loadingLongestMs: Math.round(Math.max(0, ...list.map((x) => x.dur))),
      totalCalls: m.calls.length,
    };
  }, { picked, longBeforeLoad });
  if (cdp) {
    const { profile } = await cdp.send("Profiler.stop");
    fs.writeFileSync(options.profile, JSON.stringify(profile));
  }
  await browser.close();
  return { firstRowsMs, loadSettleMs, ...loadPhase, checkLatency, loadingMs, statusAfter, ...result, errors: errors.slice(0, 5) };
}

if (require.main === module) {
  const [bundle, query, optionText] = process.argv.slice(2);
  run(bundle, query || "", optionText ? JSON.parse(optionText) : {}).then((r) => console.log(JSON.stringify(r)));
}
module.exports = { run };
