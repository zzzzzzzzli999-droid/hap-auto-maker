// 装车插件端到端验证：用模拟的 HAP 运行时（mock-hap.js）加载打包后的插件，逐条检查
// “勾上的记录点装载不会丢”和“后台补读不和操作抢通道”。
// 用法（在 test-harness 目录）：
//   NODE_PATH=<装好 mdye/react/react-dom/styled-components/esbuild 的 node_modules> node build.js ../src bundle-new.js
//   python3 -m http.server 8765 &
//   NODE_PATH=$(npm root -g) node verify.js bundle-new.js      # 需要全局安装 playwright
//   NODE_PATH=$(npm root -g) node compare.js                   # 原版 bundle-orig.js 与新版的卡顿/耗时对比
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const bundle = process.argv[2] || "bundle-new.js";
fs.copyFileSync(path.join(__dirname, bundle), path.join(__dirname, "bundle.js"));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function open(browser, query) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(error.message));
  await page.goto(`http://localhost:8765/index.html?${query}`);
  await page.waitForFunction(() => document.querySelectorAll("tbody input[type=checkbox]").length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  return page;
}

const rowIdOf = (index) => `d-${String(index + 1).padStart(4, "0")}`;

async function target(page, rowId) {
  return page.evaluate((id) => {
    const record = window.__mock.detailStore.get(id);
    const key = Object.keys(record).find((k) => typeof record[k] === "string" && record[k].includes('"X26'));
    return { rowId: id, workOrder: JSON.parse(record[key])[0].name, customer: window.__mock.customerOf(id) };
  }, rowId);
}

function rowLocator(page, workOrder) {
  return page.locator("tbody tr").filter({ has: page.locator("td", { hasText: new RegExp(`^${workOrder}$`) }) }).first();
}

async function showCustomer(page, customer) {
  await page.locator("td button", { hasText: new RegExp(`^${customer}$`) }).first().click();
  await page.waitForTimeout(200);
}

async function setChecked(page, rowId, checked) {
  const { workOrder, customer } = await target(page, rowId);
  await showCustomer(page, customer);
  const row = rowLocator(page, workOrder);
  await row.scrollIntoViewIfNeeded();
  const box = row.locator("input[type=checkbox]");
  if (checked) await box.check(); else await box.uncheck();
}

async function clickLoad(page) {
  await page.locator("button:not([draggable])", { hasText: /^装载$/ }).click();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim() === "装载中"), null, { timeout: 120000 });
}

const status = (page) => page.evaluate(() => document.querySelector("span[title]")?.innerText || "");
const loaded = (page) => page.evaluate(() => window.__mock.loaded.map((x) => x.rowId));
const inRelation = (page, ids) => page.evaluate((list) => list.filter((id) => window.__mock.relationIds.includes(id)), ids);

(async () => {
  const browser = await chromium.launch();
  const picks = [2, 15, 29].map(rowIdOf);

  // A. 正常：跨三个客户各勾一条 → 装载 → 三条全部装走并从列表消失
  {
    const page = await open(browser, "rows=80&latency=300");
    for (const id of picks) await setChecked(page, id, true);
    await clickLoad(page);
    await page.waitForTimeout(1200);
    const ids = await loaded(page);
    check("A 正常装载：勾选的 3 条全部被工作流装走", picks.every((id) => ids.includes(id)) && ids.length === 3, ids.join(","));
    check("A 状态栏没有报错", !(await status(page)), await status(page));
    const { workOrder, customer } = await target(page, picks[2]);
    await showCustomer(page, customer);
    check("A 装走的明细已不在列表", (await rowLocator(page, workOrder).count()) === 0);
    check("A 无脚本错误", !page.__errors.length, page.__errors.join(" | "));
    await page.close();
  }

  // B. 勾选后立刻点装载，写入还要 4 秒才返回 → 装载必须等写入落库后再触发
  {
    const page = await open(browser, "rows=80&latency=300&slowwrite=4000");
    for (const id of picks) await setChecked(page, id, true);
    await clickLoad(page);
    await page.waitForTimeout(1200);
    const ids = await loaded(page);
    check("B 写入慢时立刻装载：3 条全部装走", picks.every((id) => ids.includes(id)), ids.join(","));
    await page.close();
  }

  // C. 一条写入第一次“返回成功但没保存” → 装载前核对发现、自动补写 → 3 条全部装走
  {
    const page = await open(browser, `rows=80&latency=300&silentonce=${picks[1]}`);
    for (const id of picks) await setChecked(page, id, true);
    await clickLoad(page);
    await page.waitForTimeout(1200);
    const ids = await loaded(page);
    check("C 写入被吞一次：自动补写后 3 条全部装走", picks.every((id) => ids.includes(id)), ids.join(","));
    await page.close();
  }

  // D. 一条写入一直保存不上 → 不触发装载、三条都保留在待装、该行标红；取消它后再装，另两条装走
  {
    const page = await open(browser, `rows=80&latency=300&silent=${picks[1]}`);
    for (const id of picks) await setChecked(page, id, true);
    const startCalls = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === "process.startProcess").length);
    await clickLoad(page);
    await page.waitForTimeout(800);
    const startCallsAfter = await page.evaluate(() => window.__mock.calls.filter((c) => c.name === "process.startProcess").length);
    check("D 有明细没保存上时不触发装载工作流", startCallsAfter === startCalls);
    check("D 三条都还在本单待装明细里（没有被装走一部分）", (await inRelation(page, picks)).length === 3);
    const text = await status(page);
    check("D 状态栏说明本次未装载并点名该明细", text.includes("本次未装载") && text.includes("1509纸箱"), text);
    const { workOrder, customer } = await target(page, picks[1]);
    await showCustomer(page, customer);
    const row = rowLocator(page, workOrder);
    check("D 该明细仍在列表、勾选保留", (await row.count()) === 1 && (await row.locator("input[type=checkbox]").isChecked()));
    check("D 该明细整行标红", ((await row.getAttribute("title")) || "").includes("没有存进明道云"));
    const other = await target(page, picks[0]);
    await showCustomer(page, other.customer);
    check("D 其他已勾选明细的勾选也保留", await rowLocator(page, other.workOrder).locator("input[type=checkbox]").isChecked());
    // 操作员取消这条后再装载
    await setChecked(page, picks[1], false);
    const unsavedRow = rowLocator(page, workOrder);
    check("D 取消勾选后标红消失", !((await unsavedRow.getAttribute("title")) || "").includes("没有存进明道云"));
    await showCustomer(page, other.customer);
    await clickLoad(page);
    await page.waitForTimeout(1200);
    const ids = await loaded(page);
    check("D 取消问题明细后再装载：另外 2 条装走", [picks[0], picks[2]].every((id) => ids.includes(id)) && !ids.includes(picks[1]), ids.join(","));
    await page.close();
  }

  // E. 勾选的明细在点装载前已被别人装走（不在本单待装关联里了）→ 本次不装、移除该行并提示；再点装载其余装走
  {
    const page = await open(browser, "rows=80&latency=300");
    for (const id of picks) await setChecked(page, id, true);
    await page.waitForTimeout(1500);
    await page.evaluate((id) => { const list = window.__mock.relationIds; list.splice(list.indexOf(id), 1); }, picks[0]);
    await clickLoad(page);
    await page.waitForTimeout(800);
    const text = await status(page);
    check("E 有明细已被装走时本次不装载并提示", text.includes("本次未装载") && text.includes("已不在本装车单的待装列表"), text);
    check("E 其余勾选明细没有被装一半", (await loaded(page)).length === 0);
    await page.waitForTimeout(1500);
    const { customer } = await target(page, picks[2]);
    await showCustomer(page, customer);
    await clickLoad(page);
    await page.waitForTimeout(1200);
    const ids = await loaded(page);
    check("E 再点装载：其余 2 条装走", [picks[1], picks[2]].every((id) => ids.includes(id)), ids.join(","));
    await page.close();
  }

  // G. 取消勾选的写入被吞：屏幕上已取消、明道云里仍勾着 → 不能被一起装走
  {
    const extra = rowIdOf(41);
    const page = await open(browser, `rows=80&latency=300&silentuncheck=${extra}`);
    await setChecked(page, extra, true);
    await page.waitForTimeout(1200);
    await setChecked(page, extra, false);
    await setChecked(page, picks[2], true);
    await clickLoad(page);
    await page.waitForTimeout(800);
    const text = await status(page);
    check("G 已取消但明道云仍勾着：本次不装载并提示", text.includes("本次未装载") && text.includes("仍是勾选"), text);
    check("G 没有把已取消的明细装上车", !(await loaded(page)).includes(extra));
    await page.close();
  }

  // F. 后台补读期间勾选：保存开始后不再派发新的补读请求，保存不用排在几十个补读后面
  {
    const page = await open(browser, "rows=80&latency=800&conn=2");
    await page.waitForFunction(() => window.__mock.calls.some((c) => c.name === "worksheet.getRowDetail" && c.payload.worksheetId === window.__mock.DETAIL_WS), null, { timeout: 20000 });
    const before = await page.evaluate(() => performance.now());
    await setChecked(page, picks[0], true);
    await page.waitForFunction(() => window.__mock.writes.length > 0, null, { timeout: 30000 });
    const r = await page.evaluate((t) => {
      const write = window.__mock.calls.find((c) => c.name === "worksheet.updateWorksheetRow");
      const hydrationAfterClick = window.__mock.calls.filter((c) => c.name === "worksheet.getRowDetail" && c.payload.worksheetId === window.__mock.DETAIL_WS && c.t > t + 200 && c.t < write.done).length;
      return { waitedMs: Math.round(write.started - write.t), hydrationAfterClick };
    }, before);
    check("F 勾选保存期间没有新派发的补读请求", r.hydrationAfterClick === 0, JSON.stringify(r));
    await page.close();
  }

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})();
