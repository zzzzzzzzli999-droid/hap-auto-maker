const { chromium } = require("playwright");
const fs = require("fs");
async function run(bundle) {
  fs.copyFileSync(bundle, "bundle.js");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  await page.goto("http://localhost:8765/index.html?latency=600&scale=3");
  await page.waitForFunction(() => document.querySelectorAll(".schedule-row").length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  // pick the card holding 联动线印刷+开槽 (original: that card; new: merged 联动线 card)
  await page.locator(".machine-tab", { hasText: "联动线" }).first().click();
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => list.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ["longtask"] });
    window.__drops = [];
    const board = document.querySelector(".scheduled-board");
    board.addEventListener("drop", () => {
      const t = performance.now();
      const n = board.querySelectorAll(".schedule-row").length;
      const poll = () => { if (board.querySelectorAll(".schedule-row").length !== n) window.__drops.push(performance.now() - t); else requestAnimationFrame(poll); };
      requestAnimationFrame(poll);
    }, true);
  });
  for (let i = 0; i < 5; i += 1) {
    await page.locator(".unscheduled-board .schedule-row").first().dragTo(page.locator(".scheduled-board .card-list"));
    await page.waitForTimeout(250);
  }
  // click another card while saves are running: time until it becomes active
  const clickLatency = await page.evaluate(async () => {
    const tab = Array.from(document.querySelectorAll(".machine-tab")).find((t) => t.textContent.includes("覆膜"));
    const t = performance.now(); tab.click();
    await new Promise((r) => { const poll = () => tab.classList.contains("active") ? r() : requestAnimationFrame(poll); poll(); });
    return performance.now() - t;
  });
  await page.waitForTimeout(8000);
  const r = await page.evaluate(() => ({ drops: window.__drops, long: window.__long }));
  // split modal close time
  await page.locator(".machine-tab", { hasText: "覆膜" }).first().click();
  await page.waitForTimeout(500);
  await page.click(".unscheduled-board .schedule-row .split-icon");
  const t0 = Date.now(); await page.click(".split-modal .primary");
  await page.waitForSelector(".split-modal", { state: "detached", timeout: 15000 });
  const splitMs = Date.now() - t0;
  await browser.close();
  const sum = r.long.reduce((a, b) => a + b, 0);
  return { rows: 0, dropToVisibleMs: r.drops.map((d) => Math.round(d)), maxDrop: Math.round(Math.max(...r.drops)), cardClickMs: Math.round(clickLatency), longTasks: r.long.length, longTaskTotalMs: Math.round(sum), longestTaskMs: Math.round(Math.max(0, ...r.long)), splitModalCloseMs: splitMs };
}
(async () => {
  for (const [label, file] of [["原版", "bundle-orig.js"], ["新版", "bundle-new.js"]]) {
    const r = await run(file);
    console.log(label, JSON.stringify(r));
  }
  fs.copyFileSync("bundle-new.js", "bundle.js");
})();
