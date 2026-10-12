// 装车插件的模拟 HAP 运行时：在 bundle.js 之前加载，提供 window.env / window.config / window.api，
// 用内存里的“装车单 + 送货明细 + 货车”三张表回答插件的所有接口请求。
//
// URL 参数：
//   rows=60          明细条数（全部挂在同一张装车单的“送货明细”关联下）
//   customers=12     客户数
//   latency=400      每个请求的服务器耗时（毫秒，±30% 抖动）
//   conn=6           同时在途的请求上限（浏览器同域连接数 / 明道云限流），0 = 不限
//   omit=1           关联列表里不返回查询/公式字段（真实明道云的列表接口常常这样），触发插件逐条补读
//   silent=rowId,..  这些明细的写入“返回成功但不落库”（明道云被业务规则拦截时就是这样）
//   silentonce=...   同上，但只吞掉第一次写入
//   silentuncheck=.. 这些明细“取消勾选”的写入返回成功但不落库（勾选仍正常保存）
//   slowwrite=ms     明细写入额外耗时（模拟勾选后马上点装载、写入还没回来）
//   account=deep     当前账号姓名不放在 config.currentAccount，只能靠深度搜索 config 找到
//   toparea=31       主表“在装平方”的字段类型（31 公式 / 6 数值）
(function () {
  const params = new URLSearchParams(location.search);
  const ROWS = Number(params.get("rows") || 60);
  const CUSTOMERS = Number(params.get("customers") || 12);
  const LATENCY = Number(params.get("latency") || 400);
  const CONN = Number(params.get("conn") ?? 6);
  const OMIT = params.get("omit") !== "0";
  const SILENT = new Set((params.get("silent") || "").split(",").filter(Boolean));
  const SILENT_ONCE = new Set((params.get("silentonce") || "").split(",").filter(Boolean));
  const SILENT_UNCHECK = new Set((params.get("silentuncheck") || "").split(",").filter(Boolean));
  const SLOW_WRITE = Number(params.get("slowwrite") || 0);
  const ACCOUNT_DEEP = params.get("account") === "deep";
  const TOP_AREA_TYPE = Number(params.get("toparea") || 31);

  // 24 位十六进制的稳定 ID（插件按 /[a-f0-9]{24}/ 识别字段 ID）
  const hex24 = (seed) => {
    let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9;
    for (const ch of String(seed)) {
      const c = ch.charCodeAt(0);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
      h3 = Math.imul(h3 ^ c, 3266489917) >>> 0;
    }
    return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0") + h3.toString(16).padStart(8, "0")).slice(0, 24);
  };

  const APP_ID = "bc95b483-fa07-469a-9bdc-d5741494280b";
  const LOAD_WS = "6a24c033b6274becb18d68b8";
  const LOAD_VIEW = "6aa44296ed24522e86eccfa3";
  const DETAIL_WS = "6a24c033b6274becb18d68cd";
  const TRUCK_WS = hex24("ws_truck");
  const TRUCK_VIEW = hex24("view_truck");
  const LOAD_ROW = "load-0001";
  const ACCOUNT = { accountId: "a1b2c3d4-0000-4000-8000-00000000wxf1", fullname: "王晓芳", avatar: "" };

  // 送货明细里插件写死的字段 ID（与 App.js 的 DELIVERY_DETAIL_FIELD_IDS 一致）
  const F = {
    loadedQty: "6776593ce86abfdddb7904dc",
    convertedVolume: "68835959b32711b754eb9ab0",
    unitArea: "69d8550dab5a7577bef739c2",
    checked: "69da6289f7066f665c470856",
    convertedArea: "6a4cb45718106fdb136c34a3",
    giftQty: "6a618e1869025bfb932d7d4f",
    loadedArea: "6aa2cf1f511361c488aeb156",
    loadingUser: "6aa41d644a300a9aee47c40d",
  };
  const id = (name) => hex24(`detail:${name}`);
  const adv = (extra = {}) => ({
    sorttype: "zh", showtype: "0", filters: "[]", defsource: "[]", checkradioid: "", datamask: "0",
    maskregex: "", masklen: "", allowedit: "1", searchrange: "1", ...extra,
  });
  const ctl = (controlId, controlName, type, extra = {}) => ({
    controlId, controlName, type, attribute: 0, row: 0, col: 0, size: 6, alias: "", desc: "", hint: "",
    unit: "", dot: type === 6 || type === 31 ? 2 : 0, required: false, fieldPermission: "111", disabled: false,
    advancedSetting: adv(), strDefault: "000", enumDefault: 0, enumDefault2: 0, sourceControlId: "", dataSource: "",
    ...extra,
  });

  const detailControls = [
    ctl(id("客户名称"), "客户名称", 2, { attribute: 1 }),
    ctl(id("客户简称"), "客户简称", 2),
    ctl(id("客户编码"), "客户编码", 2),
    ctl(id("送货地址"), "送货地址", 2),
    ctl(id("路径"), "路径", 2),
    ctl(id("产品档案"), "产品档案", 29, { dataSource: hex24("ws_product") }),
    ctl(id("生产工单"), "生产工单", 29, { dataSource: hex24("ws_workorder") }),
    ctl(id("采购单号"), "采购单号", 2),
    ctl(id("楞型"), "楞型", 30, { dataSource: id("产品档案"), sourceControlId: hex24("product:楞型") }),
    ctl(id("品名"), "品名", 2),
    ctl(id("规格型号"), "规格型号", 2),
    ctl(id("物料代码"), "物料代码", 2),
    ctl(id("尺寸"), "尺寸", 2),
    ctl(id("单价"), "单价", 6),
    ctl(id("生产状态"), "生产状态", 30, { dataSource: id("生产工单"), sourceControlId: hex24("wo:状态") }),
    ctl(id("计划量"), "计划量", 6),
    ctl(id("库存数量"), "库存数量", 6),
    ctl(F.convertedVolume, "立方系数", 30, { dataSource: id("产品档案") }),
    ctl(F.unitArea, "单位面积", 30, { dataSource: id("产品档案") }),
    ctl(F.convertedArea, "平方系数", 30, { dataSource: id("产品档案") }),
    ctl(F.giftQty, "赠量", 6),
    ctl(id("计划平方"), "计划平方", 31),
    ctl(id("库存平方"), "库存平方", 31),
    ctl(F.loadedArea, "在装平方", 31),
    ctl(F.loadingUser, "装载人", 26),
    ctl(F.loadedQty, "装载量", 6),
    ctl(F.checked, "勾选", 36),
    ctl(id("备注"), "备注", 2),
    ctl(id("总采购量"), "总采购量", 30),
    ctl(id("总纸板量"), "总纸板量", 30),
    ctl(id("印刷完工"), "印刷完工", 30),
    ctl(id("成型完工"), "成型完工", 30),
    ctl(id("总入库量"), "总入库量", 30),
    ctl(id("总出库量"), "总出库量", 30),
  ];
  // 真实 ERP 明细表还有大量与装车无关的字段，模板体积对解析耗时影响很大
  for (let index = 0; index < 70; index += 1) {
    detailControls.push(ctl(id(`扩展${index}`), `扩展字段${index}`, index % 5 === 0 ? 11 : 2, {
      options: index % 5 === 0 ? Array.from({ length: 6 }, (_, k) => ({ key: hex24(`opt${index}-${k}`), value: `选项${k}`, index: k, color: "#2196f3" })) : undefined,
      advancedSetting: adv({ filters: JSON.stringify([{ controlId: id("客户名称"), values: ["x"], dataType: 2 }]), defsource: JSON.stringify([{ staticValue: "", cid: "", rcid: "" }]) }),
    }));
  }
  const COMPUTED_TYPES = new Set([30, 31]);

  const loadControls = [
    ctl("69da5981341ced4fdcf27ce4", "送货明细", 29, { dataSource: DETAIL_WS, enumDefault: 2 }),
    ctl(hex24("load:货车"), "货车", 29, { dataSource: TRUCK_WS, enumDefault: 1 }),
    ctl(hex24("load:送货日期"), "送货日期", 15),
    ctl(hex24("load:可载平方"), "可载平方", 6),
    ctl(hex24("load:在装平方"), "在装平方", TOP_AREA_TYPE),
    ctl(hex24("load:可载立方"), "可载立方", 6),
    ctl(hex24("load:已载立方"), "已载立方", 6),
    ctl(hex24("load:在装立方"), "在装立方", 6),
    ctl(hex24("load:进度"), "进度", 6),
    ctl(hex24("load:装车单号"), "装车单号", 2, { attribute: 1 }),
    ctl(hex24("load:状态"), "状态", 11, { options: [{ key: "s1", value: "装车中" }, { key: "s2", value: "装车未送" }] }),
  ];
  const truckControls = [
    ctl(hex24("truck:车牌"), "车牌号", 2, { attribute: 1 }),
    ctl(hex24("truck:司机"), "司机", 2),
    ctl(hex24("truck:可载平方"), "可载平方", 6),
    ctl(hex24("truck:可载立方"), "可载立方", 6),
  ];
  const lc = (name) => loadControls.find((c) => c.controlName === name).controlId;

  const PRODUCTS = ["AUCSX 7113# 无盐-玉米托盒 12听装 F239", "AUCSX 7113# 有盐 玉米托盒 12听装 F223", "RUKDV884#玉米纸箱12听装V237",
    "280g绿色瓦楞盖加碘三连包纸箱", "1226纸箱（30包装）", "1486纸箱（20包装）", "1493纸箱（30包装）", "1509纸箱（6提装）"];
  const SHORT = ["开创食品", "云冈纸业", "红太阳", "盛安诺", "昕陞", "优慕食品", "文辰包装", "额吉淖尔", "娜仁其木格", "丰网", "顺丰", "伊利"];

  const detailStore = new Map();
  const relationIds = [];
  for (let index = 0; index < ROWS; index += 1) {
    const rowid = `d-${String(index + 1).padStart(4, "0")}`;
    const customer = SHORT[index % Math.min(CUSTOMERS, SHORT.length)] + (CUSTOMERS > SHORT.length ? `${Math.floor(index / SHORT.length) % Math.ceil(CUSTOMERS / SHORT.length)}` : "");
    const planned = [1570, 5760, 500, 2400, 10013, 10000, 210, 14][index % 8];
    const record = {
      rowid,
      [id("客户名称")]: `${customer}有限公司`,
      [id("客户简称")]: customer,
      [id("客户编码")]: `C${String(index % CUSTOMERS).padStart(3, "0")}`,
      [id("送货地址")]: `呼和浩特市${customer}路${index % 30}号`,
      [id("路径")]: ["东线", "西线", "南线"][index % 3],
      [id("产品档案")]: JSON.stringify([{ sid: hex24(`product${index % 8}`), name: PRODUCTS[index % 8], sourcevalue: JSON.stringify({ rowid: hex24(`product${index % 8}`) }) }]),
      [id("生产工单")]: JSON.stringify([{ sid: hex24(`wo${index}`), name: `X26${String(1012000 + index)}`, sourcevalue: JSON.stringify({ rowid: hex24(`wo${index}`) }) }]),
      [id("采购单号")]: `PO${20261000 + index}`,
      [id("楞型")]: "B",
      [id("品名")]: PRODUCTS[index % 8],
      [id("规格型号")]: "",
      [id("物料代码")]: `M${index}`,
      [id("尺寸")]: ["305*232*30", "350*260*90", "275*265*2"][index % 3],
      [id("单价")]: "1.25",
      [id("生产状态")]: "已完工",
      [id("计划量")]: String(planned),
      [id("库存数量")]: String(index % 3 === 0 ? planned + 5 : 0),
      [F.convertedVolume]: "0",
      [F.unitArea]: index % 8 === 2 ? "0.4361" : "0.1361",
      [F.convertedArea]: "0.5",
      [F.giftQty]: "0",
      [id("计划平方")]: String((planned * 0.1361 * 0.5).toFixed(2)),
      [id("库存平方")]: "0",
      [F.loadedArea]: "0",
      [F.loadingUser]: "",
      [F.loadedQty]: "",
      [F.checked]: "0",
      [id("备注")]: "",
      [id("总采购量")]: String(planned), [id("总纸板量")]: String(planned), [id("印刷完工")]: String(planned),
      [id("成型完工")]: String(planned), [id("总入库量")]: String(planned), [id("总出库量")]: "0",
    };
    for (let k = 0; k < 70; k += 1) record[id(`扩展${k}`)] = k % 5 === 0 ? JSON.stringify([hex24(`opt${k}-${index % 6}`)]) : `扩展值${k}-${index}`;
    detailStore.set(rowid, record);
    relationIds.push(rowid);
  }

  const trucks = ["蒙A12345", "蒙A67890", "蒙A24680"].map((plate, index) => ({
    rowid: hex24(`truck${index}`),
    [hex24("truck:车牌")]: plate,
    [hex24("truck:司机")]: ["张师傅", "李师傅", "赵师傅"][index],
    [hex24("truck:可载平方")]: String([0, 120, 200][index]),
    [hex24("truck:可载立方")]: "0",
  }));
  const loadRecord = {
    rowid: LOAD_ROW,
    [lc("货车")]: JSON.stringify([{ sid: trucks[0].rowid, name: "蒙A12345", sourcevalue: JSON.stringify(trucks[0]) }]),
    [lc("送货日期")]: "2026-10-12",
    [lc("可载平方")]: "0",
    [lc("在装平方")]: "0",
    [lc("可载立方")]: "0",
    [lc("已载立方")]: "0",
    [lc("在装立方")]: "0",
    [lc("进度")]: "0",
    [lc("装车单号")]: "ZC20261012001",
    [lc("状态")]: JSON.stringify(["s1"]),
  };

  window.env = {
    detailRelation: ["69da5981341ced4fdcf27ce4"],
    truckRelation: [lc("货车")],
    capacityVolume: lc("可载立方"),
    capacityArea: lc("可载平方"),
    loadingArea: lc("在装平方"),
    loadedVolume: lc("已载立方"),
    deliveryDate: lc("送货日期"),
    detailLoadingArea: F.loadedArea,
    detailLoadingUser: F.loadingUser,
    detailAreaCoefficient: F.convertedArea,
    detailVolumeCoefficient: F.convertedVolume,
  };
  window.config = {
    appId: APP_ID,
    projectId: hex24("project"),
    worksheetId: LOAD_WS,
    viewId: LOAD_VIEW,
    controls: loadControls,
    worksheetInfo: { worksheetId: LOAD_WS, name: "装车单", template: { controls: loadControls } },
    ...(ACCOUNT_DEEP
      ? { accountId: ACCOUNT.accountId, extra: { session: { profile: { fullname: ACCOUNT.fullname } } } }
      : { currentAccount: ACCOUNT }),
  };

  // ---------- 网络模型 ----------
  const calls = [];
  let inflight = 0;
  const waiting = [];
  const acquire = () => new Promise((resolve) => {
    if (!CONN || inflight < CONN) { inflight += 1; resolve(); } else waiting.push(resolve);
  });
  const release = () => {
    const next = waiting.shift();
    if (next) next(); else inflight -= 1;
  };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  async function respond(name, payload, handler, extraDelay = 0) {
    const entry = { name, payload, t: performance.now() };
    calls.push(entry);
    await acquire();
    entry.started = performance.now();
    try {
      await new Promise((resolve) => setTimeout(resolve, LATENCY * (0.7 + Math.random() * 0.6) + extraDelay));
      const result = handler();
      entry.done = performance.now();
      return clone(result);
    } finally {
      release();
    }
  }

  const relationRow = (record) => {
    const row = { ...record, ctime: "2026-10-12 08:00:00", utime: "2026-10-12 08:00:00", ownerid: ACCOUNT.accountId, allowedit: true, allowdelete: true };
    if (OMIT) detailControls.forEach((control) => { if (COMPUTED_TYPES.has(control.type)) delete row[control.controlId]; });
    return row;
  };
  const detailResponse = (wsId, record, controls) => ({
    rowId: record.rowid,
    worksheetId: wsId,
    allowEdit: true,
    receiveControls: controls.map((control) => ({ ...control, value: record[control.controlId] ?? "" })),
    resultCode: 1,
  });

  const loaded = [];
  const writes = [];
  const handlers = {
    getFilterRows(p) {
      if (p.worksheetId === TRUCK_WS) return { data: trucks, count: trucks.length, resultCode: 1 };
      return { data: [{ ...loadRecord }], count: 1, resultCode: 1 };
    },
    getRowDetail(p) {
      if (p.worksheetId === DETAIL_WS && detailStore.has(p.rowId)) return detailResponse(DETAIL_WS, detailStore.get(p.rowId), detailControls);
      if (p.rowId === LOAD_ROW) return detailResponse(LOAD_WS, { ...loadRecord, "69da5981341ced4fdcf27ce4": String(relationIds.length) }, loadControls);
      return { resultCode: 1, receiveControls: [] };
    },
    getRowRelationRows(p) {
      if (p.rowId === LOAD_ROW && p.controlId === "69da5981341ced4fdcf27ce4") {
        const size = p.pageSize || 20;
        const start = ((p.pageIndex || 1) - 1) * size;
        const rows = relationIds.slice(start, start + size).map((rowId) => relationRow(detailStore.get(rowId)));
        return { data: rows, count: relationIds.length, ...(p.getWorksheet ? { template: { controls: detailControls }, worksheet: { worksheetId: DETAIL_WS, template: { controls: detailControls } } } : {}), resultCode: 1 };
      }
      // 明细自己的关联（产品档案/生产工单）用于补显示文字
      return { data: [{ rowid: hex24(`rel:${p.rowId}:${p.controlId}`), [hex24("x:名称")]: "B", [hex24("x:状态")]: "已完工" }], count: 1, template: { controls: [ctl(hex24("x:名称"), "名称", 2, { attribute: 1 }), ctl(hex24("x:状态"), "生产状态", 2)] }, resultCode: 1 };
    },
    getWorksheetInfo(p) {
      if (p.worksheetId === TRUCK_WS) return { worksheetId: TRUCK_WS, template: { controls: truckControls }, views: [{ viewId: TRUCK_VIEW, name: "全部", advancedSetting: {} }], resultCode: 1 };
      if (p.worksheetId === DETAIL_WS) return { worksheetId: DETAIL_WS, template: { controls: detailControls }, views: [], resultCode: 1 };
      return { worksheetId: p.worksheetId, template: { controls: [] }, views: [], resultCode: 1 };
    },
    getWorksheetControls(p) { return handlers.getWorksheetInfo(p); },
    getWorksheetBtns() {
      return [{ btnId: hex24("btn:装载"), name: "装载" }, { btnId: hex24("btn:补装车"), name: "补装车" }];
    },
    updateWorksheetRow(p) {
      const store = p.worksheetId === DETAIL_WS ? detailStore.get(p.rowId) : p.rowId === LOAD_ROW ? loadRecord : null;
      writes.push({ rowId: p.rowId, controls: (p.newOldControl || []).map((c) => [c.controlId, c.value]), t: performance.now() });
      if (!store) return { resultCode: 1, data: {} };
      if (SILENT.has(p.rowId)) return { resultCode: 1, data: { rowid: p.rowId } };
      if (SILENT_ONCE.has(p.rowId)) { SILENT_ONCE.delete(p.rowId); return { resultCode: 1, data: { rowid: p.rowId } }; }
      if (SILENT_UNCHECK.has(p.rowId) && (p.newOldControl || []).some((c) => c.controlId === F.checked && c.value === "0")) {
        return { resultCode: 1, data: { rowid: p.rowId } };
      }
      (p.newOldControl || []).forEach((control) => {
        const all = p.worksheetId === DETAIL_WS ? detailControls : loadControls;
        const def = all.find((c) => c.controlId === control.controlId);
        if (!def || COMPUTED_TYPES.has(def.type)) return;
        store[control.controlId] = control.value;
      });
      if (p.worksheetId === DETAIL_WS) {
        const qty = Number(store[F.loadedQty]) || 0;
        store[F.loadedArea] = String((qty + (Number(store[F.giftQty]) || 0)) * Number(store[F.unitArea]) * Number(store[F.convertedArea]));
      }
      return { resultCode: 1, data: { rowid: p.rowId } };
    },
    updateWorksheetRows(p) {
      (p.rowIds || []).forEach((rowId) => handlers.updateWorksheetRow({ worksheetId: p.worksheetId, rowId, newOldControl: p.controls }));
      return { resultCode: 1, data: true };
    },
    startProcess(p) {
      const payload = p.startProcess || p;
      // 模拟“装载”工作流：把本装车单下 勾选=是 且 装载人=触发人 的明细装走（移出“送货明细”待装关联）
      setTimeout(() => {
        const taken = relationIds.filter((rowId) => {
          const record = detailStore.get(rowId);
          if (record[F.checked] !== "1") return false;
          const users = (() => { try { return JSON.parse(record[F.loadingUser] || "[]"); } catch (e) { return []; } })();
          return users.some((u) => u.accountId === ACCOUNT.accountId);
        });
        taken.forEach((rowId) => {
          const record = detailStore.get(rowId);
          loaded.push({ rowId, qty: Number(record[F.loadedQty]) || 0, at: performance.now(), trigger: payload.triggerId });
          relationIds.splice(relationIds.indexOf(rowId), 1);
        });
        window.postMessage({ from: "widget-container", action: "update-record", value: {} }, "*");
      }, 300);
      return { resultCode: 1, data: { instanceId: hex24(`inst${calls.length}`) } };
    },
  };

  function call(moduleName, methodName, payload = {}) {
    const handler = handlers[methodName];
    if (!handler) return Promise.reject(new Error(`mock: ${moduleName}.${methodName} 未实现`));
    const isDetailWrite = (methodName === "updateWorksheetRow" || methodName === "updateWorksheetRows") && payload.worksheetId === DETAIL_WS;
    return respond(`${moduleName}.${methodName}`, payload, () => handler(payload), isDetailWrite ? SLOW_WRITE : 0);
  }
  const api = { call };
  ["getFilterRows", "getRowDetail", "getRowRelationRows", "getWorksheetInfo", "updateWorksheetRow"].forEach((name) => {
    api[name] = (payload) => call("worksheet", name, payload);
  });
  window.api = api;
  window.utils = {};

  window.__mock = {
    calls, loaded, writes, detailStore, relationIds, F, DETAIL_WS, LOAD_ROW, ACCOUNT,
    get inflight() { return inflight; },
    get queued() { return waiting.length; },
    rowTitle: (rowId) => detailStore.get(rowId)?.[id("品名")],
    customerOf: (rowId) => detailStore.get(rowId)?.[id("客户简称")],
    serverChecked: () => relationIds.filter((rowId) => detailStore.get(rowId)[F.checked] === "1"),
  };
})();
