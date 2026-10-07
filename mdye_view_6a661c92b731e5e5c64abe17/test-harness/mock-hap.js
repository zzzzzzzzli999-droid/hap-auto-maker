// Mock of the HAP view-plugin runtime (window.env / config / api / utils) used by the mdye package.
// Loaded before dist/bundle.js so the real production bundle runs against an in-memory worksheet.
(function () {
  const params = new URLSearchParams(location.search);
  const LATENCY = Number(params.get("latency") || 600);
  const ROW_SCALE = Number(params.get("scale") || 1);

  const STATUS_OPTIONS = [
    { key: "k_queued", value: "已排序" },
    { key: "k_scheduled", value: "已排程" },
    { key: "k_produced", value: "已生产" }
  ];
  const controls = [
    { controlId: "c_process", controlName: "工序", type: 2 },
    { controlId: "c_machine", controlName: "机床", type: 2 },
    { controlId: "c_mseq", controlName: "机床序号", type: 6 },
    { controlId: "c_status", controlName: "排程状态", type: 11, options: STATUS_OPTIONS },
    { controlId: "c_seq", controlName: "排程序号", type: 6 },
    { controlId: "c_qty", controlName: "排程量", type: 6 },
    { controlId: "c_pre", controlName: "分拆前排程量", type: 6 },
    { controlId: "c_ok", controlName: "合格量", type: 6 },
    { controlId: "c_customer", controlName: "客户", type: 2 },
    { controlId: "c_order", controlName: "生产单号", type: 2 },
    { controlId: "c_code", controlName: "产品编号", type: 2 },
    { controlId: "c_name", controlName: "产品名称", type: 2 },
    { controlId: "c_size", controlName: "生产尺寸", type: 2 },
    { controlId: "c_req", controlName: "要求量", type: 6 },
    { controlId: "c_prod", controlName: "生产量", type: 6 },
    { controlId: "c_remark", controlName: "工艺备注", type: 2 },
    { controlId: "c_start", controlName: "开始时间", type: 2 },
    { controlId: "c_end", controlName: "结束时间", type: 2 },
    { controlId: "c_rate", controlName: "张/分钟", type: 6 },
    { controlId: "c_date", controlName: "生产交期", type: 15 },
    { controlId: "c_color", controlName: "颜色", type: 2 },
    { controlId: "c_die", controlName: "模切版", type: 2 },
    { controlId: "c_print", controlName: "印刷版", type: 2 }
  ];
  window.env = {
    process: "c_process", machine: "c_machine", machineSequence: "c_mseq", scheduleStatus: "c_status",
    scheduleSequence: "c_seq", scheduleQuantity: "c_qty", preSplitScheduleQuantity: "c_pre", qualifiedQuantity: "c_ok",
    customer: "c_customer", orderNo: "c_order", productCode: "c_code", productName: "c_name", productionSize: "c_size",
    requiredQuantity: "c_req", productionQuantity: "c_prod", processRemark: "c_remark",
    scheduleStartTime: "c_start", scheduleEndTime: "c_end", sheetsPerMinute: "c_rate",
    deliveryDate: "c_date", color: "c_color"
    // 模切版 / 印刷版 故意不映射：验证按字段名自动识别
  };
  window.config = { appId: "app1", worksheetId: "ws1", viewId: "view1", accountId: "acc1", controls };

  // [process, machine, machineSequence, queued, scheduled] — counts taken from the user's screenshots.
  const MACHINES = [
    ["表面处理", "大五色印刷+上油", 10, 1, 0],
    ["表面处理", "覆膜", 11, 3, 0],
    ["表面处理", "上油", 12, 9, 0],
    ["表面处理", "贴面机", 13, 2, 0],
    ["印刷", "大五色印刷", 20, 30, 0],
    ["印刷", "大五色印刷+圆模", 21, 15, 0],
    ["印刷", "联动线印刷+开槽", 22, 54, 5],
    ["印刷", "联动线印刷+圆模", 23, 26, 0],
    ["印刷", "联动线无印刷+开槽", 24, 1, 0],
    ["模切", "联动线开槽", 30, 5, 0],
    ["模切", "平模机", 31, 4, 2]
  ];
  const CUSTOMERS = ["顺丰速运", "红太阳食品", "丰网供应链", "盛安诺", "昕陞", "优慕食品", "云冈纸业", "文辰包装", "额吉淖尔", "娜仁其木格"];
  const store = new Map();
  let id = 0;
  MACHINES.forEach(([process, machine, mseq, queued, scheduled]) => {
    const make = (status, seq) => {
      id += 1;
      const rowid = `r${String(id).padStart(4, "0")}`;
      const qty = 300 + (id * 37) % 900;
      store.set(rowid, {
        rowid, c_process: process, c_machine: machine, c_mseq: String(mseq),
        c_status: JSON.stringify([status]), c_seq: String(seq), c_qty: String(qty), c_pre: String(qty), c_ok: "0",
        c_customer: CUSTOMERS[id % CUSTOMERS.length], c_order: `X2609${String(10000 + id)}`, c_code: `A${100 + id % 400}-${String(id).padStart(3, "0")}A`,
        c_name: ["320g大青盐加碘纸箱", "2.25kg餐饮原味", "160g番茄火锅", "周转箱", "300g精制湖盐"][id % 5], c_size: `${400 + (id * 7) % 60}*${300 + id % 3 * 10}*180`,
        c_req: String(qty), c_prod: String(qty), c_remark: "", c_start: "", c_end: "", c_rate: String(60 + id % 40),
        c_date: `2026-10-${String(10 + id % 4).padStart(2, "0")}${id % 7 === 0 ? " 15:30" : ""}`, c_color: ["红", "蓝", "黑", "四色"][id % 4],
        c_die: `D${id % 3}`, c_print: `P${id % 2}`
      });
    };
    for (let s = 0; s < queued * ROW_SCALE; s += 1) make("k_queued", 0);
    for (let s = 0; s < scheduled * ROW_SCALE; s += 1) make("k_scheduled", s + 1);
  });

  const calls = [];
  window.__mock = { store, calls, failNext: 0, failDeleteNext: 0, latency: LATENCY, inflight: 0 };
  const delay = (value) => new Promise((resolve, reject) => {
    window.__mock.inflight += 1;
    setTimeout(() => {
      window.__mock.inflight -= 1;
      if (value instanceof Error) reject(value); else resolve(value);
    }, window.__mock.latency);
  });

  function handle(controller, action, data) {
    calls.push({ t: performance.now(), controller, action, data: JSON.parse(JSON.stringify(data || {})) });
    if (action === "getFilterRows") return { data: Array.from(store.values()).map((row) => ({ ...row })), resultCode: 1 };
    if (action === "getWorksheetControls") return { data: { controls }, resultCode: 1 };
    if (action === "getWorksheetBtns") return [{ btnId: "b_split", name: "分拆" }, { btnId: "b_merge", name: "合并" }, { btnId: "b_confirm", name: "确定排程" }];
    if (window.__mock.failNext > 0 && (action === "updateWorksheetRow" || action === "startProcess")) {
      window.__mock.failNext -= 1;
      return new Error("模拟网络错误");
    }
    if (action === "updateWorksheetRow") {
      const row = store.get(data.rowId);
      if (!row) return new Error("记录不存在");
      data.newOldControl.forEach((control) => { row[control.controlId] = control.value; });
      return { data: { ...row }, resultCode: 1 };
    }
    if (action === "deleteWorksheetRows") {
      if (window.__mock.failDeleteNext > 0) { window.__mock.failDeleteNext -= 1; return new Error("模拟删除失败"); }
      data.rowIds.forEach((rowId) => store.delete(rowId));
      return { data: true };
    }
    if (action === "startProcess") {
      if (data.triggerId === "b_split") {
        const source = store.get(data.sources[0]);
        const out = Number((String(data.dataLog).match(/拆出数量：(\d+)/) || [])[1] || 0);
        id += 1;
        const rowid = `r${String(id).padStart(4, "0")}`;
        store.set(rowid, { ...source, rowid, c_qty: String(out), c_pre: String(out) });
      }
      if (data.triggerId === "b_merge") {
        const source = store.get(data.sources[0]);
        source.c_qty = source.c_pre;
      }
      return { data: true };
    }
    return { data: null };
  }
  window.api = { call: (controller, action, data) => delay(handle(controller, action, data)) };
  window.utils = { openRecordInfo: () => Promise.resolve() };
})();
