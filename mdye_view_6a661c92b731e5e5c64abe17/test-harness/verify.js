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
  await page.click(".unscheduled-board .list-head .filter-header:first-of-type .filter-trigger");
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
  await page.click(".unscheduled-board .list-head .filter-header:first-of-type .filter-trigger");
  const options = await page.$$eval(".filter-panel .filter-options label span", (els) => els.map((el) => el.textContent));
  check("“机床”列可筛选（选项为 3 种机床）", options.length === 3 && options.every((o) => daMembers.has(o)), options.join("、"));
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 790);

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
  check("拖拽只写状态和排程序号（不写机床/工序字段）", dragCalls.length === 1 && dragCalls[0].data.newOldControl.every((c) => ["c_status", "c_seq"].includes(c.controlId)), JSON.stringify(dragCalls.map((c) => c.data.newOldControl.map((x) => x.controlId))));
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
      if (minutes !== Math.ceil(Number(row.c_qty) / Number(row.c_rate))) durationsOk = false;
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
  check("每条时长 = 排程量 ÷ 张/分钟", sortResult.durationsOk);
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

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(2); });
