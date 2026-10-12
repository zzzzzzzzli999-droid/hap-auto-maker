// 打印“点装载”前后的接口调用时间线
const { chromium } = require("playwright");
const fs = require("fs");
(async () => {
  const [bundle, query] = process.argv.slice(2);
  fs.copyFileSync(bundle, "bundle.js");
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  await page.goto(`http://localhost:8765/index.html?${query}`);
  await page.waitForFunction(() => document.querySelectorAll("tbody input[type=checkbox]").length > 0);
  await page.waitForTimeout(5500);
  const row = page.locator("tbody tr").filter({ has: page.locator("input[type=checkbox]") }).first();
  await row.locator("input[type=checkbox]").check();
  await page.waitForTimeout(80);
  const tClick = await page.evaluate(() => performance.now());
  await page.locator("button:not([draggable])", { hasText: /^装载$/ }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim() === "装载中"), null, { timeout: 120000 });
  const tDone = await page.evaluate(() => performance.now());
  const calls = await page.evaluate(({ from, to }) => window.__mock.calls.filter((c) => (c.done || 1e12) > from - 3000 && c.t < to).map((c) => ({ name: c.name.replace("worksheet.", ""), ws: (c.payload.worksheetId || "").slice(-4), t: Math.round(c.t - from), start: Math.round((c.started || 0) - from), done: Math.round((c.done || 0) - from) })), { from: tClick, to: tDone });
  console.log("loading ms", Math.round(tDone - tClick));
  calls.forEach((c) => console.log(String(c.t).padStart(6), String(c.start).padStart(6), String(c.done).padStart(6), c.name, c.ws));
  await browser.close();
})();
