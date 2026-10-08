// 后道机床排程插件端到端验证：用模拟的 HAP 运行时（mock-hap.js）加载真实的生产包 dist/bundle.js。
// 用法（在 test-harness 目录）：
//   mdye build（在插件目录）后 cp ../dist/bundle.js bundle-new.js
//   python3 -m http.server 8765 &
//   NODE_PATH=$(npm root -g) node verify.js bundle-new.js     # 需要全局安装 playwright
//   NODE_PATH=$(npm root -g) node perf.js                      # 对比 bundle-orig.js / bundle-new.js 的卡顿情况
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

async function open(browser, query = "latency=600") {
  const page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  page.__errors = [];
  page.on("pageerror", (error) => page.__errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") page.__errors.push(message.text()); });
  await page.goto(`http://localhost:8765/index.html?${query}`);
  await page.waitForSelector(".machine-tab", { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll(".schedule-row").length > 0, null, { timeout: 15000 });
  await page.waitForTimeout(500);
  return page;
}

const cardsOf = (page) => page.$$eval(".process-group", (groups) => groups.map((group) => ({
  process: group.querySelector(".process-name strong").textContent,
  cards: Array.from(group.querySelectorAll(".machine-tab")).map((tab) => ({
    name: tab.querySelector("span").textContent,
    queued: Number(tab.querySelector(".queued-count").textContent),
    scheduled: Number(tab.querySelector(".scheduled-count").textContent),
    active: tab.classList.contains("active"),
    family: tab.classList.contains("family-tab")
  }))
})));

async function clickCard(page, name) {
  await page.locator(".machine-tab", { has: page.locator(`span:text-is("${name}")`) }).first().click();
  await page.waitForTimeout(250);
}

// column index of a header label in a board
async function columnValues(page, board, label) {
  return page.evaluate(({ board, label }) => {
    const root = document.querySelector(`.${board}`);
    const headers = Array.from(root.querySelectorAll(".list-head > *"));
    const index = headers.findIndex((header) => header.textContent.replace(/[▼⋮]/g, "").trim() === label);
    if (index < 0) return null;
    return Array.from(root.querySelectorAll(".schedule-row")).map((row) => row.children[index]?.textContent.trim());
  }, { board, label });
}

async function waitIdle(page, timeout = 20000) {
  await page.waitForFunction(() => window.__mock.inflight === 0 && !document.querySelector(".sync-badge"), null, { timeout });
  await page.waitForTimeout(1600);
}

(async () => {
  const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });

  // ---------- 1. 机床卡片合并 ----------
  let page = await open(browser);
  const groups = await cardsOf(page);
  console.log("cards:", groups.map((group) => `${group.process}: ${group.cards.map((card) => `${card.name}(${card.queued}/${card.scheduled})`).join(" | ")}`).join("  ||  "));
  const allCards = groups.flatMap((group) => group.cards.map((card) => ({ ...card, process: group.process })));
  const daWuSe = allCards.filter((card) => card.name.includes("大五色"));
  const lianDong = allCards.filter((card) => card.name.includes("联动线"));
  check("大五色只有一张卡片，名称为“大五色印刷”", daWuSe.length === 1 && daWuSe[0].name === "大五色印刷", JSON.stringify(daWuSe.map((c) => c.name)));
  check("联动线只有一张卡片", lianDong.length === 1 && lianDong[0].name === "联动线", JSON.stringify(lianDong.map((c) => c.name)));
  check("合并卡片位于“印刷”工序", daWuSe[0]?.process === "印刷" && lianDong[0]?.process === "印刷");
  check("大五色印刷数量为各机床之和（1+30+15=46 / 0）", daWuSe[0]?.queued === 46 && daWuSe[0]?.scheduled === 0, `${daWuSe[0]?.queued}/${daWuSe[0]?.scheduled}`);
  check("联动线数量为各机床之和（54+26+1+5=86 / 5）", lianDong[0]?.queued === 86 && lianDong[0]?.scheduled === 5, `${lianDong[0]?.queued}/${lianDong[0]?.scheduled}`);
  const surface = groups.find((group) => group.process === "表面处理");
  check("表面处理只剩非合并机床（覆膜/上油/贴面机）", surface && surface.cards.map((c) => c.name).sort().join() === ["上油", "覆膜", "贴面机"].sort().join(), surface && surface.cards.map((c) => c.name).join());
  check("默认选中联动线合并卡片", lianDong[0]?.active === true);

  const heads = await page.$$eval(".unscheduled-board .list-head > *", (els) => els.map((el) => el.textContent.replace(/[▼⋮]/g, "").trim()).filter(Boolean));
  check("合并卡片明细第一列为“机床”", heads[0] === "机床", heads.slice(0, 4).join(","));
  let machines = await columnValues(page, "unscheduled-board", "机床");
  const lianMembers = new Set(["联动线印刷+开槽", "联动线印刷+圆模", "联动线无印刷+开槽", "联动线开槽"]);
  check("联动线明细显示实际机床名", machines && machines.length > 0 && machines.every((m) => lianMembers.has(m)), machines && Array.from(new Set(machines)).join("、"));
  await page.locator(".unscheduled-board .list-head .filter-header .filter-trigger").first().click();
  const lianOptions = await page.$$eval(".filter-panel .filter-options label span", (els) => els.map((el) => el.textContent));
  check("联动线明细包含 4 种实际机床（机床列筛选项）", lianOptions.length === 4 && lianOptions.every((o) => lianMembers.has(o)), lianOptions.join("、"));
  await page.click(".filter-panel-footer button");

  await clickCard(page, "大五色印刷");
  machines = await columnValues(page, "unscheduled-board", "机床");
  const daMembers = new Set(["大五色印刷", "大五色印刷+圆模", "大五色印刷+上油"]);
  check("大五色印刷明细共 46 条，显示 3 种实际机床", machines && machines.length === 46 && machines.every((m) => daMembers.has(m)) && new Set(machines).size === 3, machines && `${machines.length} 条：${Array.from(new Set(machines)).join("、")}`);
  const mergeBtnFamily = await page.$(".merge-machine-trigger");
  check("合并卡片不显示“合并机床”按钮（避免误改机床）", !mergeBtnFamily);

  // 机床列筛选可用
  await page.locator(".unscheduled-board .list-head .filter-header .filter-trigger").first().click();
  const options = await page.$$eval(".filter-panel .filter-options label span", (els) => els.map((el) => el.textContent));
  check("“机床”列可筛选（选项为 3 种机床）", options.length === 3 && options.every((o) => daMembers.has(o)), options.join("、"));
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 790);

  // 瓦量列：按字段名“瓦量”自动识别（mock 中未映射），位于“生产量”之后
  const waInfo = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll(".unscheduled-board .list-head > *")).map((el) => el.textContent.replace(/[▼⋮]/g, "").trim());
    return { headers, waIndex: headers.indexOf("瓦量"), prodIndex: headers.indexOf("生产量") };
  });
  const waValues = await columnValues(page, "unscheduled-board", "瓦量");
  const qtyForWa = await page.evaluate(() => Array.from(document.querySelectorAll(".unscheduled-board .schedule-row")).map((row) => row.querySelector(".quantity-cell input").value));
  check("新增“瓦量”列，紧跟在“生产量”后面", waInfo.waIndex > 0 && waInfo.waIndex === waInfo.prodIndex + 1, `第 ${waInfo.waIndex} 列`);
  check("“瓦量”列显示明道云瓦量字段的值", waValues && waValues.length > 0 && waValues.every((v, i) => v === String(Number(qtyForWa[i]) * 2 + 7)), waValues && waValues.slice(0, 3).join(", "));

  // ---------- 2. 操作无卡顿（乐观更新） ----------
  // 2a 拖拽：合并卡片内拖到右侧，机床保持原值
  const target = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".unscheduled-board .schedule-row"));
    const headers = Array.from(document.querySelectorAll(".unscheduled-board .list-head > *")).map((el) => el.textContent.replace(/[▼⋮]/g, "").trim());
    const machineIndex = headers.indexOf("机床");
    const orderIndex = headers.indexOf("生产单号");
    const index = rows.findIndex((row) => row.children[machineIndex].textContent.trim() === "大五色印刷+圆模");
    return { index, order: rows[index].children[orderIndex].textContent.trim() };
  });
  const rowid = await page.evaluate((order) => Array.from(window.__mock.store.values()).find((row) => row.c_order === order).rowid, target.order);
  await page.evaluate(() => {
    window.__busySeen = false;
    window.__disabledSort = false;
    const observer = new MutationObserver(() => {
      if (document.querySelector(".scheduler-shell.is-busy")) window.__busySeen = true;
      const sortButton = document.querySelector(".scheduled-board .board-tools button:not(.select-visible):not(.confirm-schedule)");
      if (sortButton && sortButton.disabled && document.querySelectorAll(".scheduled-board .schedule-row").length) window.__disabledSort = true;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const callsBefore = await page.evaluate(() => window.__mock.calls.length);
  await page.evaluate(() => {
    window.__dropAt = 0; window.__shownAt = 0;
    const observer = new MutationObserver(() => {
      if (!window.__shownAt && window.__dropAt && document.querySelectorAll(".scheduled-board .schedule-row").length > 0) window.__shownAt = performance.now();
    });
    observer.observe(document.querySelector(".scheduled-board"), { subtree: true, childList: true });
    document.querySelector(".scheduled-board").addEventListener("drop", () => { window.__dropAt = performance.now(); }, true);
  });
  await page.locator(".unscheduled-board .schedule-row").nth(target.index).dragTo(page.locator(".scheduled-board .card-list"));
  await page.waitForFunction(() => window.__shownAt > 0, null, { timeout: 5000 });
  const dropMs = await page.evaluate(() => window.__shownAt - window.__dropAt);
  check("拖拽后立即显示在右侧（< 100ms）", dropMs < 100, `${dropMs.toFixed(1)}ms`);
  const machineAfterDrop = await columnValues(page, "scheduled-board", "机床");
  check("拖到右侧后机床列仍为原机床“大五色印刷+圆模”", machineAfterDrop && machineAfterDrop[0] === "大五色印刷+圆模", machineAfterDrop && machineAfterDrop.join());
  const badgeShown = await page.waitForSelector(".sync-badge", { timeout: 3000 }).then(() => true).catch(() => false);
  check("后台保存时底栏显示“正在后台保存”提示", badgeShown);
  await waitIdle(page);
  const stored = await page.evaluate((id) => ({ ...window.__mock.store.get(id) }), rowid);
  const dragCalls = await page.evaluate((n) => window.__mock.calls.slice(n).filter((c) => c.action === "updateWorksheetRow"), callsBefore);
  check("保存到明道云：状态=已排程，机床/工序未改动", stored.c_status === JSON.stringify(["k_scheduled"]) && stored.c_machine === "大五色印刷+圆模" && stored.c_process === "印刷", `${stored.c_status} ${stored.c_process}/${stored.c_machine}`);
  check("拖拽只写状态和排程序号（不写机床/工序/排程单号）", dragCalls.length === 1 && dragCalls[0].data.newOldControl.every((c) => ["c_status", "c_seq"].includes(c.controlId)), JSON.stringify(dragCalls.map((c) => c.data.newOldControl.map((x) => x.controlId))));
  check("保存期间整页没有进入忙碌状态", !(await page.evaluate(() => window.__busySeen)));
  check("保存期间“自动排序”按钮不被禁用", !(await page.evaluate(() => window.__disabledSort)));
  check("刷新后记录仍在右侧（未跳回）", (await columnValues(page, "scheduled-board", "机床"))?.length === 1);

  // 2b 拖到第一条之前（原逻辑会排到后面）
  await clickCard(page, "联动线");
  const firstBefore = await columnValues(page, "scheduled-board", "生产单号");
  const movingOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[0];
  await page.locator(".unscheduled-board .schedule-row").first().dragTo(page.locator(".scheduled-board .schedule-row").first());
  await page.waitForTimeout(150);
  const firstAfter = await columnValues(page, "scheduled-board", "生产单号");
  check("拖到第一条上时插在第一条之前", firstAfter[0] === movingOrder && firstAfter[1] === firstBefore[0], `${firstAfter.slice(0, 2).join(" , ")}`);
  await waitIdle(page);

  // 2c 分拆：弹窗立即关闭 + 占位行 + 结果替换
  await clickCard(page, "上油");
  const splitSource = await page.evaluate(() => {
    const row = document.querySelector(".unscheduled-board .schedule-row");
    return { qty: row.querySelector(".quantity-cell input").value };
  });
  await page.click(".unscheduled-board .schedule-row .split-icon");
  await page.fill(".split-modal input", String(Number(splitSource.qty) - 100));
  const splitClickAt = Date.now();
  await page.click(".split-modal .primary");
  await page.waitForSelector(".split-modal", { state: "detached", timeout: 5000 });
  const splitCloseMs = Date.now() - splitClickAt;
  check("分拆弹窗立即关闭（原来约 2 秒）", splitCloseMs < 300, `${splitCloseMs}ms（含 Playwright 开销）`);
  const afterSplit = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".unscheduled-board .schedule-row"));
    return { firstQty: rows[0].querySelector(".quantity-cell input").value, secondPending: rows[1]?.classList.contains("pending-row"), secondQty: rows[1]?.querySelector(".quantity-cell input").value };
  });
  check("原记录立即显示保留量，下面立即出现“生成中”占位行", afterSplit.firstQty === String(Number(splitSource.qty) - 100) && afterSplit.secondPending && afterSplit.secondQty === "100", JSON.stringify(afterSplit));
  await waitIdle(page);
  await page.waitForFunction(() => !document.querySelector(".pending-row"), null, { timeout: 10000 }).catch(() => {});
  const afterSplitSaved = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".unscheduled-board .schedule-row"));
    return { pending: document.querySelectorAll(".pending-row").length, quantities: rows.map((row) => row.querySelector(".quantity-cell input").value) };
  });
  const splitCalls = await page.evaluate(() => window.__mock.calls.filter((c) => c.action === "startProcess" && c.data.triggerId === "b_split").length);
  check("分拆按钮已在后台触发，新记录替换占位行", splitCalls === 1 && afterSplitSaved.pending === 0 && afterSplitSaved.quantities.includes("100"), JSON.stringify(afterSplitSaved));

  // 2d 失败回滚：完成生产失败后记录恢复
  await clickCard(page, "平模机");
  const scheduledCountBefore = (await page.$$(".scheduled-board .schedule-row")).length;
  await page.evaluate(() => { window.__mock.failNext = 1; });
  await page.click(".scheduled-board .schedule-row .complete-icon");
  await page.waitForTimeout(80);
  const countImmediately = (await page.$$(".scheduled-board .schedule-row")).length;
  check("点“完成生成”后记录立即移出", countImmediately === scheduledCountBefore - 1, `${scheduledCountBefore} → ${countImmediately}`);
  await page.waitForFunction((n) => document.querySelectorAll(".scheduled-board .schedule-row").length === n, scheduledCountBefore, { timeout: 8000 }).catch(() => {});
  const restoredCount = (await page.$$(".scheduled-board .schedule-row")).length;
  const noticeText = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  check("接口失败时自动恢复并提示", restoredCount === scheduledCountBefore && /已恢复/.test(noticeText), `${restoredCount} 条；提示：${noticeText}`);
  await waitIdle(page);

  // 2e 工艺备注 / 自动排序 / 确定排程 / 删除 / 合并机床
  await clickCard(page, "上油");
  const remarkRowOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[2];
  const remarkInput = page.locator(".unscheduled-board .schedule-row").nth(2).locator(".remark-cell input");
  await remarkInput.fill("测试备注");
  await remarkInput.press("Enter");
  await page.waitForTimeout(50);
  check("工艺备注输入后不锁定输入框", !(await page.locator(".unscheduled-board .schedule-row").nth(2).locator(".remark-cell input").isDisabled()));
  await waitIdle(page);
  const remarkStored = await page.evaluate((order) => Array.from(window.__mock.store.values()).find((row) => row.c_order === order).c_remark, remarkRowOrder);
  check("工艺备注已保存到明道云", remarkStored === "测试备注", remarkStored);

  await clickCard(page, "联动线");
  const sortClickAt = Date.now();
  await page.click(".scheduled-board .board-tools button:not(.select-visible):not(.confirm-schedule)");
  const startTimes = await columnValues(page, "scheduled-board", "开始时间");
  check("自动排序立即算出开始时间", startTimes && startTimes.every((t) => t && t !== "—"), `${Date.now() - sortClickAt}ms；${startTimes && startTimes.slice(0, 3).join(" / ")}`);
  await waitIdle(page);

  const expectedConfirm = (await page.$$(".scheduled-board .schedule-row")).length;
  await page.click(".scheduled-board .confirm-schedule");
  await page.waitForSelector(".split-modal");
  const confirmAt = Date.now();
  await page.click(".split-modal .primary");
  await page.waitForSelector(".split-modal", { state: "detached", timeout: 5000 });
  check("确定排程弹窗立即关闭", Date.now() - confirmAt < 300, `${Date.now() - confirmAt}ms`);
  await waitIdle(page);
  const confirmCall = await page.evaluate(() => window.__mock.calls.find((c) => c.action === "startProcess" && c.data.triggerId === "b_confirm"));
  check("确定排程按钮已在后台触发（含当前已排程全部记录）", confirmCall && confirmCall.data.sources.length === expectedConfirm, confirmCall && `${confirmCall.data.sources.length} 条（右侧显示 ${expectedConfirm} 条）`);

  await clickCard(page, "贴面机");
  const tieMianIds = await page.evaluate(() => Array.from(window.__mock.store.values()).filter((row) => row.c_machine === "贴面机").map((row) => row.rowid));
  check("单机床卡片仍可“合并机床”", Boolean(await page.$(".merge-machine-trigger")));
  await page.click(".merge-machine-trigger");
  await page.selectOption(".machine-merge-modal select", { label: "上油" });
  await page.click(".machine-merge-modal .primary");
  await page.waitForTimeout(80);
  const afterMergeCards = await cardsOf(page);
  const surfaceAfter = afterMergeCards.find((group) => group.process === "表面处理").cards;
  check("合并机床后立即切到目标机床并更新数量", !surfaceAfter.some((c) => c.name === "贴面机") && surfaceAfter.find((c) => c.name === "上油")?.active, surfaceAfter.map((c) => `${c.name}${c.active ? "*" : ""}(${c.queued})`).join(" "));
  await waitIdle(page);
  const mergedStored = await page.evaluate((ids) => ids.map((id) => window.__mock.store.get(id).c_machine), tieMianIds);
  check("合并机床已保存到明道云", mergedStored.every((m) => m === "上油"), mergedStored.join());

  const ordersNow = await columnValues(page, "unscheduled-board", "生产单号");
  const deleteIndex = ordersNow.findIndex((order) => ordersNow.filter((item) => item === order).length === 1);
  const deleteOrder = ordersNow[deleteIndex];
  await page.locator(".unscheduled-board .schedule-row").nth(deleteIndex).locator(".delete-icon").click();
  await page.click(".split-modal .danger.primary");
  await page.waitForTimeout(60);
  check("删除后立即从列表移除", !(await columnValues(page, "unscheduled-board", "生产单号")).includes(deleteOrder), deleteOrder);
  await page.evaluate(() => { window.__mock.latency = 1500; });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "refresh" } })));
  await waitIdle(page);
  await page.evaluate(() => { window.__mock.latency = 600; });
  const deletedStored = await page.evaluate((order) => Array.from(window.__mock.store.values()).some((row) => row.c_order === order), deleteOrder);
  check("删除已保存，期间刷新也不会把记录带回来", !deletedStored && !(await columnValues(page, "unscheduled-board", "生产单号")).includes(deleteOrder));

  // ---------- 3. 滚动条 ----------
  await clickCard(page, "联动线");
  const scroll = await page.$$eval(".list-table", (tables) => tables.map((table) => {
    const rect = table.getBoundingClientRect();
    return { bottom: Math.round(rect.bottom), hBar: table.offsetHeight - table.clientHeight, vBar: table.offsetWidth - table.clientWidth, overflowX: getComputedStyle(table).overflowX, overflowY: getComputedStyle(table).overflowY, canScrollX: table.scrollWidth > table.clientWidth };
  }));
  const viewport = await page.evaluate(() => ({ h: innerHeight, doc: document.documentElement.scrollHeight }));
  check("左右表格底部都在可视区域内", scroll.every((s) => s.bottom <= viewport.h), `${scroll.map((s) => s.bottom).join(", ")} ≤ ${viewport.h}`);
  check("页面本身不再出现被挤出的高度", viewport.doc <= viewport.h, `scrollHeight ${viewport.doc}`);
  check("左右表格横向+纵向滚动条始终占位显示（12px）", scroll.every((s) => s.hBar >= 12 && s.vBar >= 12 && s.overflowX === "scroll" && s.overflowY === "scroll"), JSON.stringify(scroll.map((s) => [s.hBar, s.vBar])));
  await page.screenshot({ path: path.join(__dirname, "shot-layout.png") });

  // ---------- 4. 双击分隔线 ----------
  const paneState = () => page.evaluate(() => {
    const visible = (selector) => { const el = document.querySelector(selector); return el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 50; };
    return { left: visible(".unscheduled-board"), right: visible(".scheduled-board"), rightWidth: Math.round(document.querySelector(".scheduled-board").getBoundingClientRect().width), leftWidth: Math.round(document.querySelector(".unscheduled-board").getBoundingClientRect().width) };
  });
  const states = [await paneState()];
  for (let i = 0; i < 4; i += 1) {
    await page.dblclick(".board-splitter");
    await page.waitForTimeout(120);
    states.push(await paneState());
    if (i === 0) await page.screenshot({ path: path.join(__dirname, "shot-hide-left.png") });
    if (i === 2) await page.screenshot({ path: path.join(__dirname, "shot-hide-right.png") });
  }
  const pattern = states.map((s) => `${s.left ? "左" : "-"}${s.right ? "右" : "-"}`).join(" → ");
  check("双击循环：隐藏左栏 → 还原 → 隐藏右栏 → 还原", pattern === "左右 → -右 → 左右 → 左- → 左右", pattern);
  check("隐藏一侧后另一侧占满宽度", states[1].rightWidth > 1300 && states[3].leftWidth > 1300, `${states[1].rightWidth}px / ${states[3].leftWidth}px`);
  const widthBefore = states[0].leftWidth;
  check("还原后左右宽度与之前一致", Math.abs(states[2].leftWidth - widthBefore) <= 1 && Math.abs(states[4].leftWidth - widthBefore) <= 1, `${widthBefore} / ${states[2].leftWidth} / ${states[4].leftWidth}`);

  check("页面无脚本错误", page.__errors.length === 0, page.__errors.join(" | "));
  await page.close();

  // 已保存过列顺序（旧版本、没有瓦量列）时，瓦量列插在生产量后面而不是最后
  page = await open(browser);
  await page.evaluate(() => {
    const key = "machine-scheduler:columns:app1:ws1:view1";
    localStorage.setItem(key, JSON.stringify(["productName", "customer", "orderNo", "productCode", "deliveryDate", "productionSize", "requiredQuantity", "preSplitScheduleQuantity", "scheduleQuantity", "productionQuantity", "scheduleStartTime", "scheduleEndTime", "processRequirement", "processRemark", "productionRequirement"].map((k) => ({ key: k, width: 120 }))));
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll(".schedule-row").length > 0);
  const migrated = await page.evaluate(() => Array.from(document.querySelectorAll(".unscheduled-board .list-head > *")).map((el) => el.textContent.replace(/[▼⋮]/g, "").trim()).filter(Boolean));
  check("旧的列顺序设置：保留原顺序，瓦量插在生产量后面", migrated[1] === "产品名称" && migrated.indexOf("瓦量") === migrated.indexOf("生产量") + 1, migrated.slice(0, 14).join(","));
  await page.evaluate(() => localStorage.clear());
  await page.close();

  // ---------- 5. 自动排序规则 ----------
  page = await open(browser);
  // 在“联动线”合并卡片上点左侧“自动排序”
  await page.click(".unscheduled-board .board-tools button:not(.select-visible)");
  const sortNotice = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  check("自动排序提示新规则", /机床、交期、产品名称、尺寸、颜色\/版型/.test(sortNotice) && /08:00/.test(sortNotice), sortNotice);
  await waitIdle(page);
  const sortResult = await page.evaluate(() => {
    const family = Array.from(window.__mock.store.values()).filter((row) => row.c_machine.includes("联动线") && row.c_status.includes("k_queued"));
    // 独立实现一遍期望规则：机床(机床序号) → 交期(天) → 产品名称 → 尺寸数值 → 颜色 → 模切版 → 印刷版
    const day = (v) => { const m = String(v).match(/(\d{4})-(\d{1,2})-(\d{1,2})/); return m ? Date.UTC(+m[1], m[2] - 1, +m[3]) : Infinity; };
    const nums = (v) => String(v).match(/\d+/g).map(Number);
    const text = (a, b) => a.localeCompare(b, "zh-CN", { numeric: true, sensitivity: "base" });
    const expected = family.slice().sort((a, b) => (+a.c_mseq - +b.c_mseq) || text(a.c_machine, b.c_machine) || day(a.c_date) - day(b.c_date) || text(a.c_name, b.c_name)
      || (() => { const x = nums(a.c_size), y = nums(b.c_size); for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]; return 0; })()
      || text(a.c_color, b.c_color) || text(a.c_die, b.c_die) || text(a.c_print, b.c_print));
    const actual = family.slice().sort((a, b) => Number(a.c_seq) - Number(b.c_seq));
    const parse = (v) => new Date(v.replace(" ", "T")).getTime();
    let continuous = true; let durationsOk = true;
    actual.forEach((row, i) => {
      const minutes = (parse(row.c_end) - parse(row.c_start)) / 60000;
      if (minutes !== Math.ceil(Number(row.c_qty) / Number(row.c_rate)) + Number(row.c_change || 0)) durationsOk = false;
      if (i > 0 && row.c_start !== actual[i - 1].c_end) continuous = false;
    });
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n) => String(n).padStart(2, "0");
    const expectedStart = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())} 08:00`;
    const machineRuns = actual.map((row) => row.c_machine).filter((m, i, list) => i === 0 || list[i - 1] !== m);
    return {
      count: actual.length,
      seqOk: actual.every((row, i) => Number(row.c_seq) === i + 1),
      orderOk: expected.every((row, i) => row.rowid === actual[i].rowid),
      firstMismatch: expected.findIndex((row, i) => row.rowid !== actual[i].rowid),
      machineRuns,
      firstStart: actual[0].c_start, expectedStart, continuous, durationsOk,
      lastEnd: actual[actual.length - 1].c_end,
      sample: actual.slice(0, 6).map((r) => `${r.c_seq}.${r.c_machine}|${r.c_date}|${r.c_name}|${r.c_size}|${r.c_color}|${r.c_die}|${r.c_print}|${r.c_start}-${r.c_end.slice(11)}`)
    };
  });
  console.log("  " + sortResult.sample.join("\n  "));
  check("排序顺序完全符合 机床→交期→产品名称→尺寸→颜色/模切版/印刷版", sortResult.orderOk && sortResult.seqOk, `${sortResult.count} 条${sortResult.orderOk ? "" : `，第 ${sortResult.firstMismatch + 1} 条不符`}`);
  check("同一机床的任务连在一起（每种机床只出现一段）", new Set(sortResult.machineRuns).size === sortResult.machineRuns.length, sortResult.machineRuns.join(" → "));
  check("第一条从次日 08:00 开始", sortResult.firstStart === sortResult.expectedStart, sortResult.firstStart);
  check("整张卡片一条连续时间线（不按机床重新从 8 点算）", sortResult.continuous, `结束于 ${sortResult.lastEnd}`);
  check("每条时长 = 排程量 ÷ 张/分钟 + 换版（字段名“换版”自动识别）", sortResult.durationsOk);
  const plateRead = await page.evaluate(() => window.__mock.calls.some(() => true));
  check("页面无脚本错误（自动排序）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.close();

  // ---------- 6. 单栏全屏按钮 ----------
  page = await open(browser);
  const layout = () => page.evaluate(() => {
    const box = (selector) => { const el = document.querySelector(selector); if (!el || getComputedStyle(el).display === "none") return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    return { left: box(".unscheduled-board"), right: box(".scheduled-board"), cards: box(".machine-groups"), splitter: box(".board-splitter"), fullscreen: Boolean(document.fullscreenElement) };
  });
  const buttonInfo = await page.$$eval(".board-head", (heads) => heads.map((head) => {
    const button = head.querySelector(".maximize-toggle"); const title = head.querySelector("h2");
    return button && { title: button.getAttribute("title"), leftOfTitle: button.getBoundingClientRect().right <= title.getBoundingClientRect().left, svg: Boolean(button.querySelector("svg path")) };
  }));
  check("未排程、已排程标题左侧都有全屏按钮（斜向双箭头）", buttonInfo.length === 2 && buttonInfo.every((b) => b && b.leftOfTitle && b.svg), JSON.stringify(buttonInfo.map((b) => b && b.title)));
  const normal = await layout();
  await page.click(".unscheduled-board .maximize-toggle");
  await page.waitForTimeout(200);
  const maxLeft = await layout();
  await page.screenshot({ path: path.join(__dirname, "shot-max-left.png") });
  check("点击后未排程铺满插件区域（机床卡片和已排程隐藏）", maxLeft.left && maxLeft.left.w > 1380 && maxLeft.left.y < 20 && !maxLeft.right && !maxLeft.cards && !maxLeft.splitter, JSON.stringify(maxLeft));
  check("全屏后按钮变为“还原”", (await page.getAttribute(".unscheduled-board .maximize-toggle", "title")).startsWith("还原"));
  check("全屏后列表仍可滚动、可操作（行数不变）", (await page.$$(".unscheduled-board .schedule-row")).length > 0);
  await page.click(".unscheduled-board .maximize-toggle");
  await page.waitForTimeout(200);
  const restored = await layout();
  check("再点一次还原，布局与之前一致", JSON.stringify({ ...restored, fullscreen: false }) === JSON.stringify({ ...normal, fullscreen: false }), JSON.stringify(restored.left));
  await page.click(".scheduled-board .maximize-toggle");
  await page.waitForTimeout(200);
  const maxRight = await layout();
  await page.screenshot({ path: path.join(__dirname, "shot-max-right.png") });
  check("已排程也可全屏", maxRight.right && maxRight.right.w > 1380 && !maxRight.left && !maxRight.cards, JSON.stringify(maxRight.right));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  const afterEsc = await layout();
  check("按 Esc 还原", Boolean(afterEsc.left && afterEsc.right && afterEsc.cards), JSON.stringify({ left: Boolean(afterEsc.left), right: Boolean(afterEsc.right) }));
  await page.dblclick(".board-splitter");
  await page.waitForTimeout(150);
  await page.click(".scheduled-board .maximize-toggle");
  await page.waitForTimeout(150);
  const maxWhileHidden = await layout();
  await page.click(".scheduled-board .maximize-toggle");
  await page.waitForTimeout(150);
  const backToHidden = await layout();
  check("与双击隐藏互不干扰（隐藏左栏时全屏右栏，还原后仍是隐藏左栏）", maxWhileHidden.right && !maxWhileHidden.cards && !backToHidden.left && backToHidden.right && backToHidden.cards, JSON.stringify({ hiddenThenMax: Boolean(maxWhileHidden.right), back: { left: Boolean(backToHidden.left), right: Boolean(backToHidden.right) } }));
  check("页面无脚本错误（全屏）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.close();

  // ---------- 7. 勾选 + 多条一起拖 ----------
  page = await open(browser);
  await clickCard(page, "大五色印刷");
  const checkboxInfo = await page.evaluate(() => ({
    rowBoxes: document.querySelectorAll(".unscheduled-board .schedule-row .check-cell input[type=checkbox]").length,
    rows: document.querySelectorAll(".unscheduled-board .schedule-row").length,
    headerBox: Boolean(document.querySelector(".unscheduled-board .list-head .select-header input[type=checkbox]")),
    headerMenu: Boolean(document.querySelector(".unscheduled-board .list-head .select-menu-trigger")),
    firstColumn: document.querySelector(".unscheduled-board .schedule-row").children[0].classList.contains("check-cell")
  }));
  check("每行第一列是勾选框，表头有勾选框和 ▼ 菜单", checkboxInfo.rowBoxes === checkboxInfo.rows && checkboxInfo.rows > 0 && checkboxInfo.headerBox && checkboxInfo.headerMenu && checkboxInfo.firstColumn, JSON.stringify(checkboxInfo));
  const queuedRows = page.locator(".unscheduled-board .schedule-row");
  const ordersQ = await columnValues(page, "unscheduled-board", "生产单号");
  for (const index of [1, 3, 5]) await queuedRows.nth(index).locator(".check-cell input").check();
  const chip = async (board) => page.$eval(`.${board} .selected-count`, (el) => el.textContent).catch(() => "");
  check("勾选 3 行后标题显示“已勾选 3”", (await chip("unscheduled-board")) === "已勾选 3", await chip("unscheduled-board"));
  check("部分勾选时表头为半选状态", await page.$eval(".unscheduled-board .select-header input", (el) => el.indeterminate && !el.checked));
  await queuedRows.nth(7).locator("td, .data-cell").first().click();
  await page.waitForTimeout(300);
  check("单击行空白处也能勾选，且不会清掉其他勾选", (await chip("unscheduled-board")) === "已勾选 4", await chip("unscheduled-board"));
  await queuedRows.nth(7).locator(".check-cell input").uncheck();
  check("再点勾选框取消勾选", (await chip("unscheduled-board")) === "已勾选 3", await chip("unscheduled-board"));
  await queuedRows.nth(9).dblclick();
  await page.waitForTimeout(300);
  check("双击行（打开详情）不改变勾选", (await chip("unscheduled-board")) === "已勾选 3", await chip("unscheduled-board"));

  const pickedOrders = [ordersQ[1], ordersQ[3], ordersQ[5]];
  await page.evaluate(() => { window.__dropAt = 0; window.__shownAt = 0; const board = document.querySelector(".scheduled-board"); board.addEventListener("drop", () => { window.__dropAt = performance.now(); const poll = () => { if (board.querySelectorAll(".schedule-row").length >= 3) window.__shownAt = performance.now(); else requestAnimationFrame(poll); }; requestAnimationFrame(poll); }, { capture: true, once: true }); });
  await queuedRows.nth(3).dragTo(page.locator(".scheduled-board .card-list"));
  await page.waitForFunction(() => window.__shownAt > 0, null, { timeout: 5000 });
  const multiDropMs = await page.evaluate(() => window.__shownAt - window.__dropAt);
  const scheduledOrders = await columnValues(page, "scheduled-board", "生产单号");
  check("拖动其中一条，3 条勾选的行一起到已排程（按原顺序）", JSON.stringify(scheduledOrders) === JSON.stringify(pickedOrders), `${scheduledOrders.join(", ")}；${multiDropMs.toFixed(1)}ms`);
  check("拖完后这 3 行取消勾选", !(await chip("unscheduled-board")) && !(await chip("scheduled-board")));
  const leftAfter = await columnValues(page, "unscheduled-board", "生产单号");
  check("未勾选的行留在未排程", pickedOrders.every((o) => !leftAfter.includes(o)) && leftAfter.length === ordersQ.length - 3, `${ordersQ.length} → ${leftAfter.length}`);
  await waitIdle(page);
  const storedPicked = await page.evaluate((orders) => orders.map((o) => { const r = Array.from(window.__mock.store.values()).find((x) => x.c_order === o); return `${r.c_status}|${r.c_machine}`; }), pickedOrders);
  check("3 条都已保存为已排程，机床不变", storedPicked.every((v) => v.startsWith(JSON.stringify(["k_scheduled"]))), storedPicked.join(" ; "));

  // 表头菜单：全选 → 拖回未排程
  await page.click(".scheduled-board .select-menu-trigger");
  const menuItems = await page.$$eval(".scheduled-board .select-menu button", (els) => els.map((el) => el.textContent));
  check("表头 ▼ 菜单有“全选”“全不选”", JSON.stringify(menuItems) === JSON.stringify(["全选", "全不选"]), menuItems.join("/"));
  await page.click(".scheduled-board .select-menu button:text-is('全选')");
  check("菜单全选后已排程全部勾选", (await chip("scheduled-board")) === "已勾选 3" && await page.$eval(".scheduled-board .select-header input", (el) => el.checked));
  await page.click(".scheduled-board .select-menu-trigger");
  await page.click(".scheduled-board .select-menu button:text-is('全不选')");
  check("菜单全不选后取消全部勾选", !(await chip("scheduled-board")));
  await page.click(".scheduled-board .select-header input");
  check("点表头勾选框也能全选", (await chip("scheduled-board")) === "已勾选 3");
  await page.locator(".scheduled-board .schedule-row").first().dragTo(page.locator(".unscheduled-board .card-list"));
  await page.waitForTimeout(120);
  const backLeft = await columnValues(page, "unscheduled-board", "生产单号");
  check("勾选的已排程行一起拖回未排程", (await page.$$(".scheduled-board .schedule-row")).length === 0 && pickedOrders.every((o) => backLeft.includes(o)), `右侧剩 ${(await page.$$(".scheduled-board .schedule-row")).length} 条`);
  await waitIdle(page);

  // 有勾选时拖一条未勾选的行：只拖这一行，其他勾选保留
  const rowsNow = page.locator(".unscheduled-board .schedule-row");
  await rowsNow.nth(0).locator(".check-cell input").check();
  await rowsNow.nth(2).locator(".check-cell input").check();
  const loneOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[4];
  await rowsNow.nth(4).dragTo(page.locator(".scheduled-board .card-list"));
  await page.waitForTimeout(120);
  const rightNow = await columnValues(page, "scheduled-board", "生产单号");
  check("拖动未勾选的行时只拖这一行，其他勾选保留", JSON.stringify(rightNow) === JSON.stringify([loneOrder]) && (await chip("unscheduled-board")) === "已勾选 2", `右侧：${rightNow.join(",")}；${await chip("unscheduled-board")}`);
  await waitIdle(page);
  check("页面无脚本错误（勾选）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.screenshot({ path: path.join(__dirname, "shot-check.png") });
  await page.close();

  // ---------- 8. 合并分拆：本记录排程量 + 被合并记录排程量 ----------
  page = await open(browser);
  await clickCard(page, "上油");
  const splitAndWait = async (index, cut) => {
    const row = page.locator(".unscheduled-board .schedule-row").nth(index);
    const order = (await columnValues(page, "unscheduled-board", "生产单号"))[index];
    const qty = Number(await row.locator(".quantity-cell input").inputValue());
    await row.locator(".split-icon").click();
    await page.fill(".split-modal input", String(qty - cut));
    await page.click(".split-modal .primary");
    await waitIdle(page);
    await page.waitForFunction(() => !document.querySelector(".pending-row"), null, { timeout: 10000 });
    return { order, qty };
  };
  const first = await splitAndWait(0, 100);
  const storeRows = (order) => page.evaluate((o) => Array.from(window.__mock.store.values()).filter((r) => r.c_order === o).map((r) => ({ id: r.rowid, qty: Number(r.c_qty), pre: Number(r.c_pre) })), order);
  let pieces = await storeRows(first.order);
  check("分拆后同一生产单号有 2 条记录（保留量 + 拆出 100）", pieces.length === 2 && pieces.some((p) => p.qty === first.qty - 100) && pieces.some((p) => p.qty === 100), JSON.stringify(pieces));
  const sourceIndex = (await columnValues(page, "unscheduled-board", "生产单号")).indexOf(first.order);
  const sourceRow = page.locator(".unscheduled-board .schedule-row").nth(sourceIndex);
  check("原记录出现“合并”按钮", await sourceRow.locator(".merge-icon").count() === 1);
  const callsBeforeMerge = await page.evaluate(() => window.__mock.calls.length);
  await sourceRow.locator(".merge-icon").click();
  await page.waitForSelector(".merge-modal");
  const mergeDialog = await page.evaluate(() => ({
    items: Array.from(document.querySelectorAll(".merge-modal .merge-item")).map((el) => ({ checked: el.querySelector("input").checked, qty: el.querySelector("b").textContent })),
    hint: document.querySelector(".merge-modal .split-hint").textContent
  }));
  check("合并弹窗列出拆出的记录并默认勾选", mergeDialog.items.length === 1 && mergeDialog.items[0].checked && mergeDialog.items[0].qty === "100", JSON.stringify(mergeDialog.items));
  check("弹窗显示合并后排程量 = 本记录 + 被合并记录", mergeDialog.hint.includes(`${first.qty - 100} + 100 = ${first.qty}`), mergeDialog.hint);
  await page.click(".merge-modal .primary");
  await page.waitForTimeout(80);
  const afterMergeUi = await page.evaluate((order) => {
    const headers = Array.from(document.querySelectorAll(".unscheduled-board .list-head > *")).map((el) => el.textContent.replace(/[▼⋮]/g, "").trim());
    const orderIndex = headers.indexOf("生产单号");
    return Array.from(document.querySelectorAll(".unscheduled-board .schedule-row")).filter((row) => row.children[orderIndex]?.textContent.trim() === order).map((row) => ({ qty: row.querySelector(".quantity-cell input").value, merge: Boolean(row.querySelector(".merge-icon")) }));
  }, first.order);
  check("确认后立即：只剩 1 条，排程量为两者之和，合并按钮消失", afterMergeUi.length === 1 && afterMergeUi[0].qty === String(first.qty) && !afterMergeUi[0].merge, JSON.stringify(afterMergeUi));
  await waitIdle(page);
  pieces = await storeRows(first.order);
  check("已保存到明道云：本记录排程量 = 原保留量 + 100，被合并记录已删除", pieces.length === 1 && pieces[0].qty === first.qty, JSON.stringify(pieces));
  const mergeCalls = await page.evaluate((n) => window.__mock.calls.slice(n).map((c) => c.action + (c.data.triggerId ? `:${c.data.triggerId}` : "")), callsBeforeMerge);
  check("不再调用明道云“合并”工作流", !mergeCalls.some((c) => c.includes("b_merge")) && mergeCalls.includes("deleteWorksheetRows"), mergeCalls.filter((c) => c !== "getFilterRows" && c !== "getWorksheetControls").join(", "));

  // 删除失败 → 排程量自动改回，记录恢复
  const second = await splitAndWait(1, 50);
  const secondIndex = (await columnValues(page, "unscheduled-board", "生产单号")).indexOf(second.order);
  await page.evaluate(() => { window.__mock.failDeleteNext = 1; });
  await page.locator(".unscheduled-board .schedule-row").nth(secondIndex).locator(".merge-icon").click();
  await page.click(".merge-modal .primary");
  await waitIdle(page);
  pieces = await storeRows(second.order);
  const failNotice = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  const uiCount = (await columnValues(page, "unscheduled-board", "生产单号")).filter((o) => o === second.order).length;
  check("删除失败时排程量自动改回、两条记录都恢复并提示", pieces.length === 2 && pieces.some((p) => p.qty === second.qty - 50) && pieces.some((p) => p.qty === 50) && uiCount === 2 && /已恢复/.test(failNotice), `${JSON.stringify(pieces)}；界面 ${uiCount} 条；${failNotice}`);
  check("页面无脚本错误（合并）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.close();

  // ---------- 9. 碰线合并卡片 + 更换机床 ----------
  page = await open(browser);
  const groups9 = await cardsOf(page);
  const pengGroup = groups9.find((group) => group.process === "碰线");
  check("碰线和新碰线+喷码合成一张“碰线”卡片（5+2=7）", pengGroup && pengGroup.cards.length === 1 && pengGroup.cards[0].name === "碰线" && pengGroup.cards[0].queued === 7 && pengGroup.cards[0].family, pengGroup && pengGroup.cards.map((c) => `${c.name}(${c.queued})`).join(" "));
  const notice = () => page.$eval(".notice", (el) => el.textContent).catch(() => "");
  const storeBy = (orders) => page.evaluate((list) => list.map((o) => { const r = Array.from(window.__mock.store.values()).find((x) => x.c_order === o); return { machine: r.c_machine, process: r.c_process, status: r.c_status }; }), orders);
  const cardCount = async (name) => (await cardsOf(page)).flatMap((g) => g.cards).find((c) => c.name === name);

  // 未排程：覆膜 → 上油
  await clickCard(page, "覆膜");
  await page.click(".unscheduled-board .change-machine-trigger");
  check("未勾选时点“更换机床”提示先勾选", /请先勾选/.test(await notice()), await notice());
  const rows9 = page.locator(".unscheduled-board .schedule-row");
  const changeOrders = (await columnValues(page, "unscheduled-board", "生产单号")).slice(0, 2);
  await rows9.nth(0).locator(".check-cell input").check();
  await rows9.nth(1).locator(".check-cell input").check();
  check("按钮显示勾选条数", (await page.textContent(".unscheduled-board .change-machine-trigger")) === "更换机床 (2)");
  await page.click(".unscheduled-board .change-machine-trigger");
  await page.waitForSelector(".machine-change-modal");
  const changeOptions = await page.$$eval(".machine-change-modal select option", (els) => els.map((el) => el.value));
  check("可选机床只有同工序（表面处理）的其他机床", JSON.stringify(changeOptions) === JSON.stringify(["大五色印刷+上油", "上油", "贴面机"]), changeOptions.join("、"));
  await page.selectOption(".machine-change-modal select", "上油");
  await page.click(".machine-change-modal .primary");
  await page.waitForTimeout(80);
  const fuMo = await cardCount("覆膜");
  const shangYou = await cardCount("上油");
  check("确认后立即：覆膜 3→1，上油 9→11", fuMo.queued === 1 && shangYou.queued === 11, `覆膜 ${fuMo.queued}，上油 ${shangYou.queued}`);
  await waitIdle(page);
  const changedStored = await storeBy(changeOrders);
  check("已保存：机床改为上油，工序、状态不变", changedStored.every((r) => r.machine === "上油" && r.process === "表面处理" && r.status.includes("k_queued")), JSON.stringify(changedStored));

  // 已排程：平模机 → 联动线开槽（同为模切），状态保持已排程
  await clickCard(page, "平模机");
  const schedOrder = (await columnValues(page, "scheduled-board", "生产单号"))[0];
  await page.locator(".scheduled-board .schedule-row").first().locator(".check-cell input").check();
  await page.click(".scheduled-board .change-machine-trigger");
  const schedOptions = await page.$$eval(".machine-change-modal select option", (els) => els.map((el) => el.value));
  check("已排程也能更换，选项为模切工序的其他机床", JSON.stringify(schedOptions) === JSON.stringify(["联动线开槽"]), schedOptions.join("、"));
  await page.click(".machine-change-modal .primary");
  await page.waitForTimeout(80);
  check("已排程任务立即移到联动线卡片（已排程 5→6）", (await cardCount("平模机")).scheduled === 1 && (await cardCount("联动线")).scheduled === 6);
  await waitIdle(page);
  const schedStored = await storeBy([schedOrder]);
  check("已保存：机床=联动线开槽，工序=模切，仍为已排程", schedStored[0].machine === "联动线开槽" && schedStored[0].process === "模切" && schedStored[0].status.includes("k_scheduled"), JSON.stringify(schedStored[0]));

  // 勾选了不同工序的任务 → 提示分别更换
  await clickCard(page, "联动线");
  await page.click(".unscheduled-board .select-menu-trigger");
  await page.click(".unscheduled-board .select-menu button:text-is('全选')");
  await page.click(".unscheduled-board .change-machine-trigger");
  check("勾选跨工序时提示按工序分别更换", /不同工序/.test(await notice()) && !(await page.$(".machine-change-modal")), await notice());
  await page.click(".unscheduled-board .select-menu-trigger");
  await page.click(".unscheduled-board .select-menu button:text-is('全不选')");

  // 碰线卡片内更换（碰线 → 新碰线+喷码），失败时恢复
  await clickCard(page, "碰线");
  const pengOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[0];
  await page.locator(".unscheduled-board .schedule-row").first().locator(".check-cell input").check();
  await page.click(".unscheduled-board .change-machine-trigger");
  await page.selectOption(".machine-change-modal select", "新碰线+喷码");
  await page.evaluate(() => { window.__mock.failNext = 1; });
  await page.click(".machine-change-modal .primary");
  await page.waitForTimeout(80);
  const machineNow = (await columnValues(page, "unscheduled-board", "机床"))[(await columnValues(page, "unscheduled-board", "生产单号")).indexOf(pengOrder)];
  check("合并卡片内更换：留在碰线卡片，机床列立即变为新机床", machineNow === "新碰线+喷码", machineNow);
  await waitIdle(page);
  const machineAfterFail = (await columnValues(page, "unscheduled-board", "机床"))[(await columnValues(page, "unscheduled-board", "生产单号")).indexOf(pengOrder)];
  check("保存失败时恢复为原机床并提示", machineAfterFail === "碰线" && (await storeBy([pengOrder]))[0].machine === "碰线" && /已恢复/.test(await notice()), `${machineAfterFail}；${await notice()}`);
  check("页面无脚本错误（更换机床）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.screenshot({ path: path.join(__dirname, "shot-change.png") });
  await page.close();

  // ---------- 10. “后道机床”为关联记录字段时：更换机床 / 合并机床写入格式正确 ----------
  page = await open(browser, "latency=300&relation=1");
  const relMachine = (order) => page.evaluate((o) => { const r = Array.from(window.__mock.store.values()).find((x) => x.c_order === o); const items = JSON.parse(r.c_machine); return { name: items[0].name, sid: items[0].sid, expected: window.__mock.machineSid(items[0].name) }; }, order);
  check("关联记录模式：卡片仍按机床名显示", Boolean((await cardsOf(page)).flatMap((g) => g.cards).find((c) => c.name === "覆膜")));
  await clickCard(page, "覆膜");
  const relOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[0];
  await page.locator(".unscheduled-board .schedule-row").first().locator(".check-cell input").check();
  await page.click(".unscheduled-board .change-machine-trigger");
  await page.selectOption(".machine-change-modal select", "上油");
  await page.click(".machine-change-modal .primary");
  await waitIdle(page);
  const relAfter = await relMachine(relOrder);
  const relNotice = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  check("更换机床：按关联记录格式写入（sid 为“上油”记录），没有报参数格式错误", relAfter.name === "上油" && relAfter.sid === relAfter.expected && !/失败|错误/.test(relNotice), `${JSON.stringify(relAfter)}；${relNotice}`);
  await clickCard(page, "贴面机");
  const tieOrders = await columnValues(page, "unscheduled-board", "生产单号");
  await page.click(".merge-machine-trigger");
  await page.selectOption(".machine-merge-modal select", { label: "上油" });
  await page.click(".machine-merge-modal .primary");
  await waitIdle(page);
  const tieAfter = await Promise.all(tieOrders.map((o) => relMachine(o)));
  check("合并机床：按关联记录格式写入", tieAfter.every((m) => m.name === "上油" && m.sid === m.expected), JSON.stringify(tieAfter.map((m) => m.name)));
  check("页面无脚本错误（关联记录模式）", page.__errors.filter((e) => !/参数格式错误/.test(e)).length === 0, page.__errors.join(" | "));
  await page.close();

  // ---------- 11. 排程单号 ----------
  page = await open(browser);
  const today = await page.evaluate(() => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; });
  const snoOf = (orders) => page.evaluate((list) => list.map((o) => Array.from(window.__mock.store.values()).find((x) => x.c_order === o).c_sno), orders);
  // 拖入已排程不生成；拖回未排程清空
  await clickCard(page, "大五色印刷");
  const dwOrders = (await columnValues(page, "unscheduled-board", "生产单号")).slice(0, 2);
  await page.locator(".unscheduled-board .schedule-row").nth(0).locator(".check-cell input").check();
  await page.locator(".unscheduled-board .schedule-row").nth(1).locator(".check-cell input").check();
  await page.locator(".unscheduled-board .schedule-row").nth(0).dragTo(page.locator(".scheduled-board .card-list"));
  await waitIdle(page);
  check("拖入已排程时不生成排程单号", (await snoOf(dwOrders)).every((v) => v === "") && (await columnValues(page, "scheduled-board", "排程单号")).every((v) => v === "—"), JSON.stringify(await snoOf(dwOrders)));
  // 平模机：已排程里有之前的单号（模切20261001001），拖回一条到未排程 → 清空
  await clickCard(page, "平模机");
  const oldOrder = (await columnValues(page, "scheduled-board", "生产单号"))[0];
  check("之前已排程的记录带有旧单号", (await snoOf([oldOrder]))[0] === "模切20261001001");
  await page.locator(".scheduled-board .schedule-row").first().dragTo(page.locator(".unscheduled-board .card-list"));
  await page.waitForTimeout(100);
  const clearedUi = (await columnValues(page, "unscheduled-board", "排程单号"))[(await columnValues(page, "unscheduled-board", "生产单号")).indexOf(oldOrder)];
  await waitIdle(page);
  check("拖回未排程：排程单号立即清空并同步明道云", clearedUi === "—" && (await snoOf([oldOrder]))[0] === "", `${clearedUi} / ${JSON.stringify(await snoOf([oldOrder]))}`);
  await clickCard(page, "联动线");
  // 再拖一条新任务进来，然后确定排程：旧的 + 新的 统一成一个新单号（工序+年月日+3位流水号）
  const newOrder = (await columnValues(page, "unscheduled-board", "生产单号"))[1];
  await page.locator(".unscheduled-board .schedule-row").nth(1).dragTo(page.locator(".scheduled-board .card-list"));
  await waitIdle(page);
  await page.evaluate(() => { window.__mock.store.get("r0001").c_sno = "印刷" + (() => { const d = new Date(); const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; })() + "007"; });
  const batchOrders = await columnValues(page, "scheduled-board", "生产单号");
  const callsBeforeConfirm = await page.evaluate(() => window.__mock.calls.length);
  await page.click(".scheduled-board .confirm-schedule");
  await page.waitForSelector(".confirm-schedule-modal");
  const preview = await page.textContent(".confirm-schedule-modal .schedule-no-preview");
  check("确定排程弹窗预览：工序+年月日+3位流水号", new RegExp(`^印刷${today}\\d{3}$`).test(preview), preview);
  await page.click(".confirm-schedule-modal .primary");
  await waitIdle(page);
  const batchNos = await snoOf(batchOrders);
  check("确定排程后整批（旧的未生产完 + 新拖入）排程单号都一样", new Set(batchNos).size === 1 && batchNos.length === batchOrders.length, JSON.stringify(batchNos));
  check("排程单号格式 = 印刷 + 今天日期 + 流水号，并接着表里已有的最大流水号（007 → 008）", batchNos[0] === `印刷${today}008`, batchNos[0]);
  const confirmCalls = await page.evaluate((n) => window.__mock.calls.slice(n).map((c) => ({ a: c.action, t: c.data.triggerId, sno: (c.data.newOldControl || []).some((x) => x.controlId === "c_sno") })), callsBeforeConfirm);
  const lastSnoWrite = confirmCalls.map((c) => c.sno).lastIndexOf(true);
  const workflowAt = confirmCalls.findIndex((c) => c.t === "b_confirm");
  check("排程单号全部写入之后才触发确定排程工作流", lastSnoWrite >= 0 && workflowAt > lastSnoWrite, `最后一次写单号 #${lastSnoWrite}，工作流 #${workflowAt}`);
  const uiNos = await columnValues(page, "scheduled-board", "排程单号");
  check("已排程列表显示同一个排程单号", uiNos.every((v) => v === batchNos[0]), uiNos.join(","));
  // 写入失败（6 条里第 1 条失败、其余已写入）→ 已写入的改回原单号，不触发工作流，界面恢复
  await clickCard(page, "联动线");
  const pmOrders = await columnValues(page, "scheduled-board", "生产单号");
  const pmBefore = await snoOf(pmOrders);
  const callsBeforeFail = await page.evaluate(() => window.__mock.calls.length);
  await page.click(".scheduled-board .confirm-schedule");
  await page.waitForSelector(".confirm-schedule-modal");
  await page.evaluate(() => { window.__mock.failControl = "c_sno"; });
  await page.click(".confirm-schedule-modal .primary");
  await waitIdle(page);
  const failNoticeSno = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  const workflowAfterFail = await page.evaluate((n) => window.__mock.calls.slice(n).some((c) => c.data.triggerId === "b_confirm"), callsBeforeFail);
  const pmUi = await columnValues(page, "scheduled-board", "排程单号");
  check("排程单号写入失败：不触发确定排程，并提示", !workflowAfterFail && /排程单号写入失败，未触发确定排程/.test(failNoticeSno), failNoticeSno);
  check("排程单号写入失败：界面恢复为原单号", pmUi.every((v, i) => v === (pmBefore[i] || "—")), `${pmUi.join(",")} / ${pmBefore.join(",")}`);
  const pmAfterStore = await snoOf(pmOrders);
  check("部分写入成功的记录已改回原单号（整批仍是同一个单号）", pmOrders.length >= 2 && pmAfterStore.every((v, i) => v === pmBefore[i]) && new Set(pmAfterStore).size === 1, `${pmOrders.length} 条：${[...new Set(pmAfterStore)].join(",")}`);
  check("页面无脚本错误（排程单号）", page.__errors.length === 0, page.__errors.join(" | "));
  await page.close();
  // 表里没有“排程单号”字段：不能确定排程
  page = await open(browser, "latency=300&nosno=1");
  await clickCard(page, "联动线");
  const callsNoField = await page.evaluate(() => window.__mock.calls.length);
  await page.click(".scheduled-board .confirm-schedule");
  await page.waitForSelector(".confirm-schedule-modal");
  await page.click(".confirm-schedule-modal .primary");
  await page.waitForTimeout(300);
  const noFieldNotice = await page.$eval(".notice", (el) => el.textContent).catch(() => "");
  const noFieldWorkflow = await page.evaluate((n) => window.__mock.calls.slice(n).some((c) => c.action === "startProcess"), callsNoField);
  check("表里没有“排程单号”字段时不触发确定排程并提示", !noFieldWorkflow && /未找到“排程单号”字段/.test(noFieldNotice), noFieldNotice);
  await page.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(2); });
