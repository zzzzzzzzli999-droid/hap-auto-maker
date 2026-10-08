import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api as mdyeApi,
  apis as mdyeApis,
  config as mdyeConfig,
  env as mdyeEnv,
  md_emitter as mdyeEmitter,
  utils as mdyeUtils
} from "mdye";

const runtimeApi = mdyeApi || {};
const worksheetApi = (mdyeApis && mdyeApis.worksheet) || {};
const runtimeConfig = mdyeConfig || {};
const runtimeEnv = mdyeEnv || {};
const emitter = mdyeEmitter || {};
let fetchedControls = [];
let fullControlsLoaded = false;
const buttonCache = new Map();

const FIELD_ALIASES = {
  process: ["process", "工序"],
  machine: ["machine", "机床", "后道机床", "瓦楞机"],
  machineSequence: ["machineSequence", "机床序号", "机台序号"],
  status: ["scheduleStatus", "排程状态", "状态"],
  sequence: ["scheduleSequence", "排程序号", "序号", "排序"],
  scheduleQuantity: ["scheduleQuantity", "排程量"],
  sheetsPerMinute: ["sheetsPerMinute", "张/分钟", "张每分钟", "生产速度", "机台速度"],
  changeoverMinutes: ["changeoverMinutes", "换版时间", "换版分钟", "换单时间", "换版", "换版时间（分钟）"],
  scheduleStartTime: ["scheduleStartTime", "开始时间", "排程开始时间"],
  scheduleEndTime: ["scheduleEndTime", "结束时间", "预计出板时间", "排程结束时间"],
  preSplitScheduleQuantity: ["preSplitScheduleQuantity", "拆前数量", "分拆前数量", "拆分前数量", "分拆前排程量", "分拆前排产量", "分拆前排产数量", "原排程量"],
  splitDifference: ["splitDifference", "分拆差量", "拆分差量", "分拆数量"],
  qualifiedQuantity: ["qualifiedQuantity", "合格量", "合格数", "合格数量"],
  customer: ["customer", "客户", "客户名称"],
  deliveryDate: ["deliveryDate", "生产交期", "交期"],
  productCode: ["productCode", "产品编号", "产品编码"],
  orderNo: ["orderNo", "生产单号", "订单号"],
  productName: ["productName", "产品名称", "品名"],
  specModel: ["specModel", "规格型号", "规格", "型号"],
  requiredQuantity: ["requiredQuantity", "要求量", "需求量"],
  productionQuantity: ["productionQuantity", "生产量", "生产数量", "数量"],
  // 瓦量：插件设置里可映射；未映射时按字段名“瓦量”自动识别
  corrugatedQuantity: ["corrugatedQuantity", "瓦量", "瓦楞量"],
  quantity: ["quantity", "数量", "生产数量"],
  productionSize: ["productionSize", "生产尺寸", "产品尺寸"],
  color: ["color", "颜色", "生产颜色", "印刷颜色"],
  // 自动排序第 5 条：模切版 / 印刷版相同的排在一起（插件设置里可映射；未映射时按字段名自动识别）
  dieCutPlate: ["dieCutPlate", "模切版", "模切版号", "刀版", "刀版号", "刀模", "刀模号"],
  printingPlate: ["printingPlate", "印刷版", "印刷版号", "印版", "印版号"],
  material: ["material", "材质", "生产材质"],
  materialNo: ["materialNo", "料号"],
  processRequirement: ["processRequirement", "工艺要求"],
  processRemark: ["processRemark", "工艺备注"],
  productionRequirement: ["productionRequirement", "生产要求"],
  scheduleSummary: ["scheduleSummary", "排程汇总表"]
};

const STATUS = { queued: "已排序", scheduled: "已排程", produced: "已生产" };
const DEFAULT_MACHINE = "联动线印刷+开槽";

// 同一台设备在不同工序下有多个“机床”取值（如 大五色印刷 / 大五色印刷+圆模 / 大五色印刷+上油），
// 顶部按设备合并成一张卡片（跨工序，放在 homeProcess 工序下，数量求和）；
// 明细表显示“机床”列，拖拽/排序时每条任务仍写回它原本的工序和机床。
const MACHINE_FAMILIES = [
  { match: "大五色", name: "大五色印刷", homeProcess: "印刷" },
  { match: "联动线", name: "联动线", homeProcess: "印刷" },
  { match: "碰线", name: "碰线", homeProcess: "碰线" }
];
const FAMILY_KEY_PREFIX = "FAMILY::";
const MACHINE_COLUMN = { key: "machine", label: "机床", width: 150, locked: true };

function machineFamilyOf(machineName) {
  const name = String(machineName || "");
  return MACHINE_FAMILIES.find((family) => name.includes(family.match)) || null;
}

function isFamilyKey(key) {
  return typeof key === "string" && key.startsWith(FAMILY_KEY_PREFIX);
}

function machineCardKey(row) {
  const family = machineFamilyOf(row.machine);
  return family ? `${FAMILY_KEY_PREFIX}${family.name}` : `${row.process}::${row.machine}`;
}

function isVirtualRow(row) {
  return Boolean(row && (row.__demo || row.__pending));
}

function splitIdentity(row) {
  return `${row.process}|${row.machine}|${row.orderNo}|${row.productCode}|${row.productName}`;
}

// 乐观更新的字段比较：服务端返回值与本地补丁一致即视为保存成功。
const NUMERIC_PATCH_KEYS = new Set(["sequence", "scheduleQuantity"]);
const TIME_PATCH_KEYS = new Set(["scheduleStartTime", "scheduleEndTime"]);
const CORE_PATCH_KEYS = new Set(["status", "process", "machine", "sequence", "scheduleQuantity"]);
function patchValueMatches(key, serverValue, localValue) {
  if (NUMERIC_PATCH_KEYS.has(key)) return Math.abs((Number(serverValue) || 0) - (Number(localValue) || 0)) < 0.000001;
  if (TIME_PATCH_KEYS.has(key)) return compactScheduleTime(serverValue) === compactScheduleTime(localValue);
  return String(serverValue ?? "") === String(localValue ?? "");
}

const DEFAULT_COLUMNS = [
  { key: "customer", label: "客户", width: 140 },
  { key: "orderNo", label: "生产单号", width: 140 },
  { key: "productCode", label: "产品编号", width: 140 },
  { key: "productName", label: "产品名称", width: 200 },
  { key: "deliveryDate", label: "生产交期", width: 120 },
  { key: "productionSize", label: "生产尺寸", width: 140 },
  { key: "requiredQuantity", label: "要求量", width: 110 },
  { key: "preSplitScheduleQuantity", label: "拆前数量", width: 110 },
  { key: "scheduleQuantity", label: "排产量", width: 145 },
  { key: "productionQuantity", label: "生产量", width: 110 },
  { key: "corrugatedQuantity", label: "瓦量", width: 110 },
  { key: "scheduleStartTime", label: "开始时间", width: 150 },
  { key: "scheduleEndTime", label: "结束时间", width: 150 },
  { key: "processRequirement", label: "工艺要求", width: 220 },
  { key: "processRemark", label: "工艺备注", width: 220 },
  { key: "productionRequirement", label: "生产要求", width: 260 }
];

function currentAccountId() {
  return runtimeConfig.accountId || runtimeConfig.userId || runtimeConfig.currentAccountId ||
    window.md?.global?.Account?.accountId || window.md?.global?.Account?.id || "current";
}

const DEMO_ROWS = [
  ["1", "切纸机", "未排程", 0, "蒙塞特", "2026-07-08", "A392-004A", "X260703033", "精选带皮羊排-胶印箱", 1200],
  ["2", "切纸机", "未排程", 0, "右玉惠聪", "2026-07-15", "A120-094A", "X260711001", "纯荞麦面（土黄色）改地址", 800],
  ["3", "切纸机", "已排程", 1, "锦垣商贸", "2026-07-12", "A546-005A", "X260709014", "手工烧麦礼盒", 1600],
  ["4", "切纸机", "已排程", 2, "富友联合", "2026-07-15", "A346-123A", "X260710006", "礼盒吸吸带包装箱", 2200],
  ["5", "模切机", "未排程", 0, "盛安诺", "2026-07-16", "A232-064A", "X260709008", "快递箱-胶印", 1000],
  ["6", "模切机", "已排程", 1, "宇航人生物", "2026-07-15", "A540-001A", "260712002", "300ml绿色生态沙棘礼盒", 900],
  ["7", "印刷机", "未排程", 0, "云农道农业", "2026-07-08", "A457-002A", "X260704013", "享蜜礼盒", 500]
].map(([rowid, machine, status, sequence, customer, deliveryDate, productCode, orderNo, productName, quantity]) => ({
  rowid, process: "示例工序", machine, machineSequence: Number(rowid), status, sequence, customer, deliveryDate, productCode, orderNo,
  productName, specModel: productName, productionSize: "460*330*180", requiredQuantity: quantity, scheduleQuantity: quantity,
  preSplitScheduleQuantity: rowid === "2" ? quantity + 200 : quantity, qualifiedQuantity: rowid === "1" ? 0 : rowid === "2" ? Math.round(quantity * .94) : rowid === "3" ? Math.round(quantity * .55) : quantity,
  productionQuantity: quantity, processRequirement: rowid === "2" ? "覆膜后模切，注意压线位置及成品外观，模切压力保持均匀并检查爆线情况" : "—",
  processRemark: rowid === "2" ? "首件确认后批量生产，颜色严格按客户签样执行，每批抽样检查并保留质量记录" : "—",
  productionRequirement: rowid === "2" ? "生产过程中保持版面洁净，成品按客户要求分批打包，外箱标注生产批次、数量及交货日期" : "—", quantity, __demo: true
}));

function cleanText(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    // 只有以 [ 或 { 开头的才可能是数组/对象 JSON；普通文本直接返回，避免每个字段都抛一次解析异常（刷新时的主要卡顿来源之一）。
    const first = value.trimStart()[0];
    if (first !== "[" && first !== "{") return value;
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((item) => item.name || item.label || item.value || item).join("、");
      if (parsed && typeof parsed === "object") return parsed.name || parsed.label || parsed.value || value;
    } catch (_) {}
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).join("、");
  if (typeof value === "object") return value.name || value.label || value.value || "";
  return String(value);
}

function envControlId(alias) {
  const rawValue = runtimeEnv[alias];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (typeof value === "string") return value;
  return value && (value.controlId || value.id || value.value);
}

function envControlIds(alias) {
  const value = runtimeEnv[alias];
  if (Array.isArray(value)) return value.map((item) => {
    if (typeof item === "string") return item;
    return item && (item.controlId || item.id || item.value);
  }).filter(Boolean);
  const id = envControlId(alias);
  return id ? [id] : [];
}

// 字段列表和字段映射按来源数组缓存：normalizeRow 每条记录要解析几十个字段，
// 原来每次都重新合并全部字段定义，几百条记录刷新一次会卡住半秒以上。
const controlsCache = { configured: null, fetched: null, list: [], fields: new Map() };

function controlsFromConfig() {
  const info = runtimeConfig.worksheetInfo || {};
  const configured = runtimeConfig.controls || info.template && info.template.controls || info.controls || [];
  if (controlsCache.configured === configured && controlsCache.fetched === fetchedControls) return controlsCache.list;
  const merged = new Map();
  [...configured, ...fetchedControls].forEach((control) => {
    if (control && control.controlId) merged.set(control.controlId, { ...(merged.get(control.controlId) || {}), ...control });
  });
  controlsCache.configured = configured;
  controlsCache.fetched = fetchedControls;
  controlsCache.list = Array.from(merged.values());
  controlsCache.fields = new Map();
  return controlsCache.list;
}

function extractControls(response) {
  const isControlList = (value) => Array.isArray(value) && value.some((item) =>
    item && item.controlId && (item.controlName !== undefined || item.type !== undefined || item.options !== undefined)
  );
  const queue = [response];
  const visited = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (isControlList(current)) return current;
    ["data", "result", "controls", "template", "worksheetInfo"].forEach((key) => {
      if (current[key]) queue.push(current[key]);
    });
  }
  return [];
}

function resolveField(key) {
  const controls = controlsFromConfig();
  if (controlsCache.fields.has(key)) return controlsCache.fields.get(key);
  const aliases = FIELD_ALIASES[key];
  let resolved;
  for (const alias of aliases) {
    const id = envControlId(alias);
    if (id) { resolved = controls.find((c) => c.controlId === id) || { controlId: id, controlName: alias }; break; }
  }
  if (!resolved) resolved = controls.find((control) => aliases.some((alias) =>
    alias === control.controlId || alias === control.controlName || alias === control.alias
  ));
  controlsCache.fields.set(key, resolved);
  return resolved;
}

function fieldValue(row, key) {
  const control = resolveField(key);
  if (control && row[control.controlId] !== undefined) return row[control.controlId];
  const alias = FIELD_ALIASES[key].find((name) => row[name] !== undefined);
  return alias ? row[alias] : "";
}

function controlOptions(control) {
  const raw = control && (control.options || control.advancedSetting && control.advancedSetting.options);
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") { try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch (_) {} }
  return [];
}

function decodeOption(value, control) {
  const raw = cleanText(value);
  const options = controlOptions(control);
  if (!control || !options.length) return raw;
  const keys = (() => { try { return JSON.parse(value); } catch (_) { return [value]; } })();
  const key = Array.isArray(keys) ? keys[0] : keys;
  const option = options.find((item) =>
    item.key === key || item.id === key || item.controlId === key
    || item.value === key || item.label === raw || item.text === raw || item.name === raw
  );
  return option ? option.value || option.label || option.text || option.name : raw;
}

function readableProcessName(process, machine) {
  const value = cleanText(process);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const idParts = value.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
  const isIdPayload = idParts.length > 0 && idParts.every((item) => uuidPattern.test(item));
  if (value && !isIdPayload) return value;
  const machineName = cleanText(machine);
  const rules = [
    [/碰线/, "碰线"], [/胶印/, "胶印"], [/分切|切纸/, "分切"],
    [/覆膜|上油|贴面/, "表面处理"], [/印刷/, "印刷"],
    [/平模|圆模|模切|开槽/, "模切"], [/粘箱|粘合/, "粘合"],
    [/打包/, "打包"], [/装钉/, "装钉"], [/手工/, "手工"]
  ];
  const matched = rules.find(([pattern]) => pattern.test(machineName));
  return matched ? matched[1] : machineName.replace(/机$/, "") || "未指定工序";
}

function normalizeRow(row) {
  const statusControl = resolveField("status");
  const processControl = resolveField("process");
  const machineControl = resolveField("machine");
  const machineName = decodeOption(fieldValue(row, "machine"), machineControl) || "未指定机床";
  const processName = readableProcessName(decodeOption(fieldValue(row, "process"), processControl), machineName);
  const scheduleQuantity = Number(fieldValue(row, "scheduleQuantity")) || 0;
  const mappedPreSplitQuantity = Number(String(cleanText(fieldValue(row, "preSplitScheduleQuantity"))).replace(/,/g, "")) || 0;
  const preSplitScheduleQuantity = mappedPreSplitQuantity || scheduleQuantity;
  return {
    ...row,
    rowid: row.rowid || row.rowId,
    __raw: row,
    // 原始记录签名：刷新时数据未变化就复用旧对象，避免整表重新渲染。
    __sig: JSON.stringify(row),
    process: processName,
    machine: machineName,
    machineSequence: (() => {
      const raw = cleanText(fieldValue(row, "machineSequence"));
      const parsed = Number.parseFloat(String(raw).replace(/[^\d.-]/g, ""));
      return Number.isFinite(parsed) ? parsed : 999999;
    })(),
    status: decodeOption(fieldValue(row, "status"), statusControl) || STATUS.queued,
    sequence: Number(fieldValue(row, "sequence")) || 0,
    scheduleQuantity,
    sheetsPerMinute: Number(String(cleanText(fieldValue(row, "sheetsPerMinute"))).replace(/,/g, "")) || 0,
    changeoverMinutes: Number(String(cleanText(fieldValue(row, "changeoverMinutes"))).replace(/,/g, "")) || 0,
    scheduleStartTime: cleanText(fieldValue(row, "scheduleStartTime")) || "—",
    scheduleEndTime: cleanText(fieldValue(row, "scheduleEndTime")) || "—",
    preSplitScheduleQuantity,
    splitDifference: (() => {
      const mapped = Number(String(cleanText(fieldValue(row, "splitDifference"))).replace(/,/g, ""));
      if (Number.isFinite(mapped) && mapped > 0) return mapped;
      const before = preSplitScheduleQuantity;
      const current = scheduleQuantity;
      return Math.max(0, before - current);
    })(),
    qualifiedQuantity: Number(String(cleanText(fieldValue(row, "qualifiedQuantity"))).replace(/,/g, "")) || 0,
    customer: cleanText(fieldValue(row, "customer")) || "—",
    deliveryDate: cleanText(fieldValue(row, "deliveryDate")) || "—",
    productCode: cleanText(fieldValue(row, "productCode")) || "—",
    orderNo: cleanText(fieldValue(row, "orderNo")) || "—",
    productName: cleanText(fieldValue(row, "productName")) || "未命名产品",
    specModel: cleanText(fieldValue(row, "specModel")) || cleanText(fieldValue(row, "productName")) || "—",
    requiredQuantity: cleanText(fieldValue(row, "requiredQuantity")) || "—",
    productionQuantity: cleanText(fieldValue(row, "productionQuantity")) || cleanText(fieldValue(row, "quantity")) || "—",
    corrugatedQuantity: cleanText(fieldValue(row, "corrugatedQuantity")) || "—",
    quantity: cleanText(fieldValue(row, "quantity")) || "—",
    productionSize: cleanText(fieldValue(row, "productionSize")) || "—",
    color: cleanText(fieldValue(row, "color")) || "—",
    dieCutPlate: cleanText(fieldValue(row, "dieCutPlate")) || "—",
    printingPlate: cleanText(fieldValue(row, "printingPlate")) || "—",
    processRequirement: cleanText(fieldValue(row, "processRequirement")) || "—",
    processRemark: cleanText(fieldValue(row, "processRemark")) || "—",
    productionRequirement: cleanText(fieldValue(row, "productionRequirement")) || "—"
  };
}

function displayValue(row, controlId) {
  const control = controlsFromConfig().find((item) => item.controlId === controlId);
  const value = row.__raw && row.__raw[controlId] !== undefined ? row.__raw[controlId] : row[controlId];
  return { label: control ? control.controlName : controlId, value: decodeOption(value, control) || "—" };
}

function extractRows(response) {
  if (Array.isArray(response)) return response;
  if (!response) return [];
  return response.rows || response.data || response.list || response.result && response.result.rows || [];
}

function normalizeFilters(value = {}) {
  const source = value.value || value.data || value;
  return {
    filterControls: source.filterControls || source.filters || source.filter || [],
    fastFilters: source.fastFilters || source.quickFilters || [],
    filtersGroup: source.filtersGroup,
    sortControls: source.sortControls || [],
    navGroupFilters: source.navGroupFilters || [],
    keyWords: source.keyWords || source.keywords || ""
  };
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) =>
    value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length)
  ));
}

async function getRows(payload) {
  if (typeof runtimeApi.getFilterRows === "function") return runtimeApi.getFilterRows(payload);
  if (typeof worksheetApi.getFilterRows === "function") return worksheetApi.getFilterRows(payload);
  if (window.api && typeof window.api.call === "function") return window.api.call("worksheet", "getFilterRows", payload);
  throw new Error("getFilterRows API unavailable");
}

async function ensureWorksheetControls(payload) {
  if (fullControlsLoaded) return fetchedControls;
  try {
    let response;
    const request = { ...payload, getTemplate: true, handControlSource: true, handleDefault: true, resultType: 1 };
    if (typeof runtimeApi.getWorksheetControls === "function") response = await runtimeApi.getWorksheetControls(request);
    else if (typeof worksheetApi.getWorksheetControls === "function") response = await worksheetApi.getWorksheetControls(request);
    else if (window.api && typeof window.api.call === "function") response = await window.api.call("worksheet", "getWorksheetControls", request);
    const controls = extractControls(response);
    if (controls.length) {
      const merged = new Map(fetchedControls.map((control) => [control.controlId, control]));
      controls.forEach((control) => merged.set(control.controlId, { ...(merged.get(control.controlId) || {}), ...control }));
      fetchedControls = Array.from(merged.values());
      const processId = envControlId("process");
      const processControl = fetchedControls.find((control) => control.controlId === processId || control.controlName === "工序");
      const processType = Number(processControl && processControl.type);
      fullControlsLoaded = Boolean(processControl && (![9, 10, 11].includes(processType) || controlOptions(processControl).length));
    }
  } catch (_) {}
  return fetchedControls;
}

async function updateRow(payload) {
  if (typeof runtimeApi.updateWorksheetRow === "function") return runtimeApi.updateWorksheetRow(payload);
  if (typeof worksheetApi.updateWorksheetRow === "function") return worksheetApi.updateWorksheetRow(payload);
  if (window.api && typeof window.api.call === "function") return window.api.call("worksheet", "updateWorksheetRow", payload);
  throw new Error("updateWorksheetRow API unavailable");
}

async function deleteWorksheetRows({ appId, worksheetId, viewId, rowIds }) {
  if (typeof runtimeApi.deleteWorksheetRow === "function") return runtimeApi.deleteWorksheetRow({ appId, worksheetId, rowIds });
  const payload = { appId, worksheetId, viewId, rowIds, isAll: false, excludeRowIds: [], filterControls: [], keyWords: "", fastFilters: [], navGroupFilters: [], filtersGroup: [], thoroughDelete: false };
  if (typeof worksheetApi.deleteWorksheetRows === "function") return worksheetApi.deleteWorksheetRows(payload);
  if (window.api && typeof window.api.call === "function") return window.api.call("worksheet", "deleteWorksheetRows", payload);
  throw new Error("deleteWorksheetRows API unavailable");
}

function runWhenIdle(task) {
  return new Promise((resolve, reject) => {
    const execute = () => Promise.resolve().then(task).then(resolve, reject);
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(execute, { timeout: 1200 });
    } else {
      window.setTimeout(execute, 16);
    }
  });
}

// 最多 4 个请求并发执行（空闲时发出）；任一失败则整体失败。
async function runConcurrently(tasks, limit = 4) {
  let next = 0;
  let failure = null;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length && !failure) {
      const task = tasks[next++];
      try { await runWhenIdle(task); } catch (error) { failure = failure || error; }
    }
  }));
  if (failure) throw failure;
}

async function getWorksheetButtons(payload) {
  if (worksheetApi && typeof worksheetApi.getWorksheetBtns === "function") return worksheetApi.getWorksheetBtns(payload);
  if (runtimeApi && typeof runtimeApi.getWorksheetBtns === "function") return runtimeApi.getWorksheetBtns(payload);
  if (window.api && typeof window.api.call === "function") return window.api.call("worksheet", "getWorksheetBtns", payload);
  throw new Error("getWorksheetBtns API unavailable");
}

async function startProcess(payload) {
  const processApi = (mdyeApis && mdyeApis.process) || {};
  if (typeof processApi.startProcess === "function") return processApi.startProcess(payload);
  if (runtimeApi && typeof runtimeApi.startProcess === "function") return runtimeApi.startProcess(payload);
  if (window.api && typeof window.api.call === "function") return window.api.call("process", "startProcess", payload);
  throw new Error("startProcess API unavailable");
}

function extractButtons(response) {
  if (Array.isArray(response)) return response;
  if (!response) return [];
  const candidates = [response.data, response.buttons, response.btns, response.customButtons];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") {
      const nested = candidate.buttons || candidate.btns || candidate.customButtons || candidate.data;
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

async function findWorksheetButton(buttonName, context) {
  const cacheKey = `${context.worksheetId || ""}:${context.viewId || ""}:${buttonName}`;
  const cached = buttonCache.get(cacheKey);
  if (cached && cached.btnId) return cached;
  let buttons = extractButtons(await getWorksheetButtons(context));
  if (!buttons.length) {
    const { viewId: _viewId, ...worksheetContext } = context;
    buttons = extractButtons(await getWorksheetButtons(worksheetContext));
  }
  const matched = buttons.find((item) => [item.name, item.btnName, item.text, item.label]
    .some((name) => String(name || "").includes(buttonName)));
  const button = matched && { ...matched, btnId: matched.btnId || matched.id };
  if (button && button.btnId) buttonCache.set(cacheKey, button);
  return button;
}

function getPushUniqueId() {
  return window.md && window.md.global && window.md.global.Config &&
    (window.md.global.Config.pushUniqueId || window.md.global.Config.PushUniqueId) || "";
}

function encodeValue(control, displayValue) {
  if (!control) return displayValue;
  const controlType = Number(control.type);
  if (controlType === 11 || controlType === 10) {
    const option = controlOptions(control).find((item) =>
      item.value === displayValue || item.label === displayValue || item.key === displayValue
    );
    if (!option) throw new Error(`${control.controlName || "下拉字段"}未找到“${displayValue}”选项，请检查字段映射`);
    return JSON.stringify([option.key]);
  }
  if ([6, 8, 28].includes(controlType)) return String(displayValue);
  return String(displayValue);
}

function padTimePart(value) {
  return String(value).padStart(2, "0");
}

function formatScheduleTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())} ${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}

function compactScheduleTime(value) {
  const text = cleanText(value);
  const matched = text.match(/(?:\d{4}[-/])?(\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]} ${matched[3]}:${matched[4]}` : text;
}

function defaultScheduleStartValue() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return `${date.getFullYear()}-${padTimePart(date.getMonth() + 1)}-${padTimePart(date.getDate())}T08:00`;
}

function isBlankValue(value) {
  return value == null || value === "" || value === "—";
}

// 文本相同的排在一起；空值排最后。
function compareSameText(a, b) {
  const blankA = isBlankValue(a);
  const blankB = isBlankValue(b);
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  return String(a).localeCompare(String(b), "zh-CN", { numeric: true, sensitivity: "base" });
}

// 交期按“天”比较（同一天视为相同，继续按后面的条件排）；无交期排最后。
function deliveryDay(value) {
  const matched = String(value || "").match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  return matched ? Date.UTC(Number(matched[1]), Number(matched[2]) - 1, Number(matched[3])) : Number.MAX_SAFE_INTEGER;
}

// 尺寸相近：按尺寸里的数字（长、宽、高…）依次从小到大比较，数值接近的会相邻；无尺寸排最后。
function compareSize(a, b) {
  const partsA = isBlankValue(a) ? [] : (String(a).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const partsB = isBlankValue(b) ? [] : (String(b).match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!partsA.length || !partsB.length) return (partsA.length ? 0 : 1) - (partsB.length ? 0 : 1);
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index += 1) {
    const diff = (partsA[index] ?? 0) - (partsB[index] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

// 自动排序规则（按优先级）：
// 1. 机床：同一实际机床的任务排在一起（机床按机床序号、名称排列）
// 2. 交期：早的在前
// 3. 产品名称：相同产品排在一起
// 4. 尺寸：相近的排在一起
// 5. 工艺中的颜色、模切版、印刷版：相同的排在一起
function sortForSchedule(rows) {
  const machineRank = new Map();
  rows.forEach((row) => {
    const sequence = Number.isFinite(Number(row.machineSequence)) ? Number(row.machineSequence) : 999999;
    machineRank.set(row.machine, Math.min(machineRank.has(row.machine) ? machineRank.get(row.machine) : 999999, sequence));
  });
  return rows.slice().sort((a, b) =>
    machineRank.get(a.machine) - machineRank.get(b.machine)
    || compareSameText(a.machine, b.machine)
    || deliveryDay(a.deliveryDate) - deliveryDay(b.deliveryDate)
    || compareSameText(a.productName, b.productName)
    || compareSize(a.productionSize, b.productionSize)
    || compareSameText(a.color, b.color)
    || compareSameText(a.dieCutPlate, b.dieCutPlate)
    || compareSameText(a.printingPlate, b.printingPlate)
    || a.sequence - b.sequence
  );
}

// 排程时间：同一张机床卡片是一台设备的一条连续时间线——从开始时间（默认次日 08:00）起，
// 第一条开始，后一条接着前一条的结束时间，不因“机床”列不同而重新从 8 点算。
// 合并卡片（大五色印刷 / 联动线）整张卡片连续计算；“全部机床”时每张卡片各自从开始时间算。
function calculateTimedSchedule(rows, startValue) {
  const startTime = new Date(startValue);
  if (Number.isNaN(startTime.getTime())) throw new Error("请输入有效的排程开始时间");
  const groups = new Map();
  rows.forEach((row) => {
    const key = machineCardKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  let missingRateCount = 0;
  const updates = Array.from(groups.values()).flatMap((group) => {
    let cursor = new Date(startTime);
    return sortForSchedule(group).map((row, index) => {
      const rate = Math.max(0, Number(row.sheetsPerMinute) || 0);
      const changeover = Math.max(0, Number(row.changeoverMinutes) || 0);
      const productionMinutes = rate > 0 ? Math.ceil(Math.max(0, Number(row.scheduleQuantity) || 0) / rate) : 0;
      if (!rate) missingRateCount += 1;
      const rowStart = new Date(cursor);
      cursor = new Date(cursor.getTime() + (productionMinutes + changeover) * 60 * 1000);
      return { ...row, sequence: index + 1, scheduleStartTime: formatScheduleTime(rowStart), scheduleEndTime: formatScheduleTime(cursor) };
    });
  });
  return { updates, missingRateCount };
}

function TruncatedCell({ field, onViewField }) {
  const rootRef = useRef(null);
  const textRef = useRef(null);
  const [clipped, setClipped] = useState(false);
  const zoomable = ["processRequirement", "processRemark", "productionRequirement"].includes(field.key);

  useEffect(() => {
    if (!zoomable) {
      setClipped(false);
      return undefined;
    }
    const measure = () => {
      if (!rootRef.current || !textRef.current) return;
      setClipped(zoomable && textRef.current.scrollWidth > Math.max(0, rootRef.current.clientWidth - 28));
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(rootRef.current);
    window.addEventListener("resize", measure);
    return () => { if (observer) observer.disconnect(); window.removeEventListener("resize", measure); };
  }, [field.value, zoomable]);

  return <div ref={rootRef} className={`data-cell truncate-cell ${clipped ? "is-clipped" : ""}`} title={clipped ? `${field.label}内容未显示完整` : `${field.label}：${field.value}`}>
    <span ref={textRef}>{field.value}</span>
    {clipped && <button type="button" className="magnify-cell" draggable={false} aria-label={`查看完整${field.label}`} title={`查看完整${field.label}`} onClick={(event) => { event.stopPropagation(); onViewField(field); }}>⌕</button>}
  </div>;
}

function getQuantityProgress(row, enabled) {
  if (!enabled) return null;
  const scheduled = Math.max(0, Number(row.scheduleQuantity) || 0);
  const beforeSplit = Math.max(0, Number(row.preSplitScheduleQuantity) || 0);
  const qualified = Math.max(0, Number(row.qualifiedQuantity) || 0);
  const hasSplit = beforeSplit > scheduled && scheduled > 0;
  let state = "unproduced";
  let label = "未生产";
  if (scheduled > 0 && qualified >= scheduled) { state = "complete"; label = "已完成"; }
  else if (scheduled > 0 && qualified / scheduled >= .9) { state = "near"; label = "即将完成"; }
  else if (qualified > 0) { state = "unfinished"; label = "未完成"; }
  return {
    state, label, hasSplit,
    title: `${hasSplit ? `已分拆（分拆前 ${beforeSplit}）｜` : ""}${label}｜排产量 ${scheduled}｜合格量 ${qualified}`
  };
}

const ScheduleCard = React.memo(function ScheduleCard({ row, index, selected, scheduled, title, fields, actionsRef }) {
  const columnWidths = fields.map((field) => `${field.width}px`);
  const actionWidth = scheduled ? 56 : 62;
  const tableMinWidth = CHECK_COLUMN_WIDTH + (scheduled ? 34 : 0) + actionWidth + fields.reduce((sum, field) => sum + field.width, 0);
  const gridTemplateColumns = [`${CHECK_COLUMN_WIDTH}px`, ...(scheduled ? ["34px"] : []), ...columnWidths, `${actionWidth}px`].join(" ");
  const pending = Boolean(row.__pending);
  return (
    <article
      className={`schedule-row ${scheduled ? "scheduled" : ""} ${selected ? "selected" : ""} ${pending ? "pending-row" : ""}`}
      draggable={!pending}
      title={pending ? "分拆结果生成中，完成后自动替换为新记录" : undefined}
      onDragStart={(event) => {
        if (pending) { event.preventDefault(); return; }
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.rowid);
        // 先确定这次拖动的行（勾选的行会一起拖），预览上显示条数
        const dragCount = actionsRef.current.startDrag(row);
        const preview = document.createElement("div");
        preview.className = `row-drag-preview ${scheduled ? "scheduled-preview" : "queued-preview"}`;
        [dragCount > 1 ? `${dragCount} 条` : scheduled ? "已排程" : "未排程", row.customer || "—", row.orderNo || "—", dragCount > 1 ? `等 ${dragCount} 条任务` : row.productName || "—"].forEach((text, previewIndex) => {
          const part = document.createElement(previewIndex === 0 ? "strong" : "span");
          part.textContent = text;
          preview.appendChild(part);
        });
        document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview, 22, 18);
        window.setTimeout(() => preview.remove(), 0);
      }}
      onDragEnd={() => actionsRef.current.endDrag()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.stopPropagation(); actionsRef.current.drop(scheduled ? "scheduled" : "queued", event, pending ? null : row); }}
      onClick={(event) => { if (!pending) actionsRef.current.select(event, row); }}
      onDoubleClick={() => { if (!pending) actionsRef.current.open(row); }}
      style={{ gridTemplateColumns, "--table-min-width": `${tableMinWidth}px` }}
    >
      <label className="fixed-cell check-cell" title={selected ? "取消勾选" : "勾选（勾选的行可一起拖动）"} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
        <input type="checkbox" checked={selected} disabled={pending} draggable={false} aria-label="勾选" onChange={() => actionsRef.current.toggleCheck(row)} />
      </label>
      {scheduled && <div className="fixed-cell order-cell"><span className="sequence">{index + 1}</span></div>}
      {fields.map((field, fieldIndex) => {
        if (field.key === "scheduleQuantity") {
          const progress = field.progress;
          return <div className={`quantity-cell ${progress ? `progress-${progress.state}` : ""} ${progress?.hasSplit ? "has-split" : ""}`} title={progress?.title || "排产量"} key={`${field.key}-${row.scheduleQuantity}`}>
            <input
              type="text"
              inputMode="decimal"
              draggable={false}
              defaultValue={row.scheduleQuantity}
              disabled={pending}
              aria-label="修改排产量"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onDragStart={(event) => event.stopPropagation()}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = String(row.scheduleQuantity);
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => actionsRef.current.saveQuantity(row, event.target.value.trim())}
            />
          </div>;
        }
        if (field.key === "processRemark") {
          return <div className="data-cell remark-cell" key={`${field.key}-${row.rowid}-${field.value}`}>
            <input
              type="text"
              draggable={false}
              defaultValue={field.value === "—" ? "" : field.value}
              disabled={pending}
              aria-label="编辑工艺备注"
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onDragStart={(event) => event.stopPropagation()}
              onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { event.currentTarget.value = field.value === "—" ? "" : field.value; event.currentTarget.blur(); } }}
              onBlur={(event) => actionsRef.current.saveProcessRemark(row, event.target.value.trim())}
            />
          </div>;
        }
        return <TruncatedCell field={field} onViewField={(value) => actionsRef.current.viewField(value)} key={`${field.label}-${fieldIndex}`} />;
      })}
      <div className="action-cell"><button type="button" className="split-icon" draggable={false} disabled={pending} title="分拆订单" aria-label="分拆订单" onClick={(event) => { event.stopPropagation(); actionsRef.current.split(row); }}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 10h4c3.5 0 3-5 6.5-5H17M13.5 2.5 17 5l-3.5 2.5M7 10c3.5 0 3 5 6.5 5H17M13.5 12.5 17 15l-3.5 2.5" /></svg></button>{scheduled && <button type="button" className="complete-icon" draggable={false} disabled={pending} title="完成生成（更新为已生产）" aria-label="完成生成" onClick={(event) => { event.stopPropagation(); actionsRef.current.complete(row); }}>✓</button>}{!scheduled && row.splitDifference > 0 && <button type="button" className="merge-icon" draggable={false} disabled={pending} title={`合并（分拆差量 ${row.splitDifference}）`} aria-label="合并" onClick={(event) => { event.stopPropagation(); actionsRef.current.merge(row); }}><span aria-hidden="true">⊞</span></button>}{!scheduled && <button type="button" className="delete-icon" draggable={false} disabled={pending} title="删除记录" aria-label="删除记录" onClick={(event) => { event.stopPropagation(); actionsRef.current.delete(row); }}>—</button>}</div>
    </article>
  );
});

const CHECK_COLUMN_WIDTH = 34;

// 勾选列表头：勾选框（全选/全不选，部分勾选时显示半选）+ ▼ 菜单（全选、全不选）
function SelectAllHeader({ total, selectedCount, onSelectAll, onClear }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const checkboxRef = useRef(null);
  const allSelected = total > 0 && selectedCount >= total;

  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return <div ref={rootRef} className={`select-header ${open ? "open" : ""}`}>
    <input ref={checkboxRef} type="checkbox" checked={allSelected} disabled={!total} title={allSelected ? "全不选" : "全选"} aria-label="全选当前列表" onChange={() => (allSelected ? onClear() : onSelectAll())} />
    <button type="button" className="select-menu-trigger" disabled={!total} aria-label="勾选菜单" onClick={() => setOpen((current) => !current)}>▼</button>
    {open && <div className="select-menu" role="menu">
      <button type="button" role="menuitem" onClick={() => { onSelectAll(); setOpen(false); }}>全选</button>
      <button type="button" role="menuitem" onClick={() => { onClear(); setOpen(false); }}>全不选</button>
    </div>}
  </div>;
}

const VIRTUAL_ROW_HEIGHT = 34;
const VIRTUAL_OVERSCAN = 12;

function VirtualCardList({ rows, renderRow, empty, resetKey }) {
  const listRef = useRef(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 700 });

  useEffect(() => {
    const scrollElement = listRef.current?.parentElement;
    if (!scrollElement || rows.length <= 80) return undefined;
    let frame = 0;
    const measure = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const next = { scrollTop: scrollElement.scrollTop, height: scrollElement.clientHeight };
        setViewport((current) => current.scrollTop === next.scrollTop && current.height === next.height ? current : next);
      });
    };
    scrollElement.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(scrollElement);
    else window.addEventListener("resize", measure);
    measure();
    return () => {
      window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener("scroll", measure);
      if (observer) observer.disconnect();
      else window.removeEventListener("resize", measure);
    };
  }, [rows.length > 80]);

  useEffect(() => {
    const scrollElement = listRef.current?.parentElement;
    if (scrollElement) scrollElement.scrollTop = 0;
    setViewport((current) => current.scrollTop === 0 ? current : { ...current, scrollTop: 0 });
  }, [resetKey]);

  const virtualized = rows.length > 80;
  const visibleCount = Math.ceil(viewport.height / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2;
  const startIndex = virtualized ? Math.min(Math.max(0, Math.floor(Math.max(0, viewport.scrollTop - 32) / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN), Math.max(0, rows.length - visibleCount)) : 0;
  const endIndex = virtualized ? Math.min(rows.length, startIndex + visibleCount) : rows.length;

  return <div className="card-list" ref={listRef}>
    {startIndex > 0 && <div className="virtual-spacer" style={{ height: startIndex * VIRTUAL_ROW_HEIGHT }} />}
    {rows.slice(startIndex, endIndex).map((row, index) => renderRow(row, startIndex + index))}
    {endIndex < rows.length && <div className="virtual-spacer" style={{ height: (rows.length - endIndex) * VIRTUAL_ROW_HEIGHT }} />}
    {!rows.length && empty}
  </div>;
}

function FilterHeader({ columnKey, label, value, options, onChange, onColumnDragStart, onColumnDragEnd, onColumnDrop, onResize, layoutLocked = false, className = "" }) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState("");
  const rootRef = useRef(null);
  const selected = Array.isArray(value) ? value : value ? [value] : [];
  // 选项只在面板打开时计算：拖拽、排序等每次数据变化都不再为所有列重算并排序筛选项。
  const resolvedOptions = open ? (typeof options === "function" ? options() : options || []) : [];
  const visibleOptions = resolvedOptions.filter((option) => String(option).toLowerCase().includes(keyword.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const toggleOption = (option) => {
    onChange(selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option]);
  };

  return (
    <div ref={rootRef} className={`filter-header ${className} ${selected.length ? "filtered" : ""} ${open ? "open" : ""}`} onDragOver={(event) => { if (!layoutLocked) event.preventDefault(); }} onDrop={(event) => { if (layoutLocked) return; event.preventDefault(); event.stopPropagation(); onColumnDrop(columnKey, event.dataTransfer.getData("text/column")); }}>
      {!layoutLocked && <span className="column-drag-handle" draggable onDragStart={(event) => { event.stopPropagation(); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/column", columnKey); onColumnDragStart(columnKey); }} onDragEnd={onColumnDragEnd} title="按住拖动调整字段顺序">⋮⋮</span>}
      <button type="button" className="filter-trigger" title={`筛选：${label}`} onClick={() => setOpen((current) => !current)}>
        <span>{label}</span>{selected.length > 0 && <b>{selected.length}</b>}<i>▼</i>
      </button>
      {open && <div className="filter-panel" onClick={(event) => event.stopPropagation()}>
        <div className="filter-panel-title"><strong>筛选 {label}</strong><button type="button" onClick={() => { onChange([]); setKeyword(""); }}>清空</button></div>
        <input autoFocus type="text" value={keyword} placeholder="手工输入筛选" onChange={(event) => setKeyword(event.target.value)} />
        <div className="filter-options">
          {visibleOptions.map((option) => <label key={option} className={selected.includes(option) ? "checked" : ""}><input type="checkbox" checked={selected.includes(option)} onChange={() => toggleOption(option)} /><span>{option}</span></label>)}
          {!visibleOptions.length && <div className="filter-empty">没有匹配项</div>}
        </div>
        <div className="filter-panel-footer"><span>已选 {selected.length} 项</span><button type="button" onClick={() => setOpen(false)}>完成</button></div>
      </div>}
      {!layoutLocked && <span className="column-resizer" onPointerDown={(event) => onResize(columnKey, event)} title="拖动调整字段宽度" />}
    </div>
  );
}

export default function App() {
  const { appId, worksheetId, viewId } = runtimeConfig;
  const columnStorageKey = `machine-scheduler:columns:${appId || "app"}:${worksheetId || "sheet"}:${viewId || "view"}`;
  const legacyColumnStorageKey = `${columnStorageKey}:${currentAccountId()}`;
  const machineStorageKey = `machine-scheduler:machines:${appId || "app"}:${worksheetId || "sheet"}:${viewId || "view"}:${currentAccountId()}`;
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({});
  const [activeMachine, setActiveMachine] = useState("DEFAULT");
  const [machineOrder, setMachineOrder] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(machineStorageKey) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch (_) { return {}; }
  });
  const [queuedFilters, setQueuedFilters] = useState({});
  const [scheduledFilters, setScheduledFilters] = useState({});
  const [loading, setLoading] = useState(true);
  const [syncCount, setSyncCount] = useState(0);
  const [notice, setNotice] = useState("");
  const [dragged, setDragged] = useState(null);
  const [selectedRowIds, setSelectedRowIds] = useState([]);
  const [leftWidth, setLeftWidth] = useState(39);
  // 双击中间分隔线循环：0 两栏 → 1 隐藏左栏 → 2 两栏 → 3 隐藏右栏 → 0
  const [paneStep, setPaneStep] = useState(0);
  // 单栏全屏：""（不全屏）| "queued"（未排程全屏）| "scheduled"（已排程全屏）
  const [maximizedLane, setMaximizedLane] = useState("");
  const [splitTarget, setSplitTarget] = useState(null);
  const [splitAmount, setSplitAmount] = useState("");
  const [confirmingSchedule, setConfirmingSchedule] = useState(false);
  const [confirmStartTime, setConfirmStartTime] = useState("");
  const [machineMergeTargetKey, setMachineMergeTargetKey] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergePicked, setMergePicked] = useState([]);
  // 更换机床：{ lane, rowIds, process, target }
  const [machineChange, setMachineChange] = useState(null);
  const [detailField, setDetailField] = useState(null);
  const [draggedColumn, setDraggedColumn] = useState(null);
  const [columnLayout, setColumnLayout] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(columnStorageKey) || localStorage.getItem(legacyColumnStorageKey) || "null");
      if (!Array.isArray(saved)) return DEFAULT_COLUMNS;
      const savedMap = new Map(saved.map((column) => [column.key, column]));
      const migratedKeys = [];
      saved.forEach((column) => {
        const keys = column.key === "specModel" ? ["productName", "productionSize"] : [column.key];
        keys.forEach((key) => { if (!migratedKeys.includes(key)) migratedKeys.push(key); });
      });
      const ordered = migratedKeys.map((key) => DEFAULT_COLUMNS.find((item) => item.key === key)).filter(Boolean);
      // 新增的默认列（如“瓦量”）插在它默认位置的前一列后面，而不是追加到最后
      DEFAULT_COLUMNS.forEach((column, defaultIndex) => {
        if (ordered.some((item) => item.key === column.key)) return;
        const previousKey = defaultIndex > 0 ? DEFAULT_COLUMNS[defaultIndex - 1].key : null;
        const previousIndex = previousKey ? ordered.findIndex((item) => item.key === previousKey) : -1;
        ordered.splice(previousIndex < 0 ? ordered.length : previousIndex + 1, 0, column);
      });
      return ordered.map((column) => {
        const savedWidth = Number(savedMap.get(column.key)?.width);
        return { ...column, width: Number.isFinite(savedWidth) ? Math.max(0, Math.min(500, savedWidth)) : column.width };
      });
    } catch (_) { return DEFAULT_COLUMNS; }
  });
  const boardsRef = useRef(null);
  const draggedRef = useRef(null);
  const dragGroupRef = useRef([]);
  const rowClickTimerRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const dragSaveTimerRef = useRef(null);
  const pendingDragSaveRef = useRef(null);
  // 乐观更新补丁：rowid -> { patch, soft, savedAt, version }。
  // 保存期间刷新拿到的仍是旧数据时，用补丁覆盖，界面不会跳回旧状态；服务端值与补丁一致后自动移除。
  // soft 补丁用于由工作流异步完成的操作（合并等），超时后静默以服务端为准。
  const pendingPatchRef = useRef(new Map());
  const patchVersionRef = useRef(0);
  // 分拆占位行：tempId -> { placeholder, identity, baselineIds, submittedAt }
  const pendingSplitsRef = useRef(new Map());
  // 已在界面删除、后台删除请求尚未完成的记录
  const pendingDeletesRef = useRef(new Set());
  // 后台写入队列：所有接口请求串行排队，不阻塞界面；队列清空后再统一刷新一次。
  const syncRef = useRef({ chain: Promise.resolve(), pending: 0 });
  const rowActionsRef = useRef({});
  const splitGroupRef = useRef(new Map());
  const rowPresentationCacheRef = useRef({ signature: "", entries: new Map() });

  // 提交刷新结果时再套一次最新的补丁/删除，避免“刷新结果”覆盖刷新期间刚做的操作。
  const reconcilePending = useCallback((list) => {
    let changed = false;
    const out = [];
    list.forEach((row) => {
      if (pendingDeletesRef.current.has(row.rowid)) { changed = true; return; }
      const pending = !row.__pending && pendingPatchRef.current.get(row.rowid);
      if (pending && !Object.keys(pending.patch).every((key) => patchValueMatches(key, row[key], pending.patch[key]))) {
        changed = true;
        out.push({ ...row, ...pending.patch, __sig: "" });
        return;
      }
      out.push(row);
    });
    pendingSplitsRef.current.forEach((split, tempId) => {
      if (out.some((row) => row.rowid === tempId)) return;
      const anchorIndex = out.findIndex((row) => row.rowid === split.sourceId);
      out.splice(anchorIndex < 0 ? out.length : anchorIndex + 1, 0, split.placeholder);
      changed = true;
    });
    return changed ? out : list;
  }, []);

  const refresh = useCallback(async () => {
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    if (!hasLoadedRef.current) setLoading(true);
    let awaitingSavedRows = false;
    try {
      const currentFilters = normalizeFilters(filters);
      const [, response] = await Promise.all([ensureWorksheetControls(compact({ appId, worksheetId })), getRows(compact({
        appId, worksheetId, viewId, pageIndex: 1, pageSize: 500,
        isAsc: true, notGetTotal: true, isGetWorksheet: true,
        ...currentFilters
      }))]);
      const responseControls = extractControls(response);
      if (responseControls.length && !fullControlsLoaded) fetchedControls = responseControls;
      const now = Date.now();
      let expiredRows = 0;
      const previousById = new Map(rowsRef.current.filter((row) => !row.__pending).map((row) => [row.rowid, row]));
      const serverRows = extractRows(response).map(normalizeRow).filter((row) => row.rowid && !pendingDeletesRef.current.has(row.rowid));
      const next = serverRows.map((row) => {
        const previous = previousById.get(row.rowid);
        const pending = pendingPatchRef.current.get(row.rowid);
        if (!pending) return previous && previous.__sig === row.__sig ? previous : row;
        const keys = Object.keys(pending.patch);
        if (pending.savedAt && keys.every((key) => patchValueMatches(key, row[key], pending.patch[key]))) {
          pendingPatchRef.current.delete(row.rowid);
          return row;
        }
        const timeout = pending.soft ? 9000 : 15000;
        if (pending.savedAt && now - pending.savedAt > timeout) {
          pendingPatchRef.current.delete(row.rowid);
          if (!pending.soft && keys.some((key) => CORE_PATCH_KEYS.has(key) && !patchValueMatches(key, row[key], pending.patch[key]))) expiredRows += 1;
          return row;
        }
        if (pending.savedAt) awaitingSavedRows = true;
        if (previous && previous.__sig === row.__sig && keys.every((key) => patchValueMatches(key, previous[key], pending.patch[key]))) return previous;
        return { ...row, ...pending.patch, __sig: "" };
      });
      // 分拆占位行：服务端出现同一订单的新记录后移除；工作流还没跑完时继续显示并稍后再刷新。
      const serverIds = new Set(serverRows.map((row) => row.rowid));
      pendingPatchRef.current.forEach((_, rowId) => { if (!serverIds.has(rowId) && !String(rowId).startsWith("__")) pendingPatchRef.current.delete(rowId); });
      let placeholderTimeout = false;
      pendingSplitsRef.current.forEach((split, tempId) => {
        const created = serverRows.some((row) => splitIdentity(row) === split.identity && !split.baselineIds.has(row.rowid));
        if (created) { pendingSplitsRef.current.delete(tempId); return; }
        if (split.submittedAt && now - split.submittedAt > 20000) { pendingSplitsRef.current.delete(tempId); placeholderTimeout = true; return; }
        if (split.submittedAt) awaitingSavedRows = true;
        const anchorIndex = next.findIndex((row) => row.rowid === split.sourceId);
        next.splice(anchorIndex < 0 ? next.length : anchorIndex + 1, 0, split.placeholder);
      });
      const current = rowsRef.current;
      const unchanged = current.length === next.length && next.every((row, index) => row === current[index]);
      // 低优先级提交：大量记录重新渲染时不卡住正在进行的点击、拖拽和输入。
      if (!unchanged) startTransition(() => setRows(() => reconcilePending(next)));
      if (expiredRows) setNotice(`${expiredRows} 条记录未能确认保存，请检查明道云数据`);
      else if (placeholderTimeout) setNotice("分拆结果还未生成，请稍后刷新查看");
      else if (!next.length) setNotice("当前视图暂无记录");
    } catch (error) {
      if (!hasLoadedRef.current) setRows([]);
      setNotice("读取记录失败，请刷新后重试");
    } finally {
      setLoading(false);
      hasLoadedRef.current = true;
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(refresh, 250);
      } else if (awaitingSavedRows) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = window.setTimeout(refresh, 1500);
      }
    }
  }, [appId, worksheetId, viewId, filters, reconcilePending]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice((current) => current === notice ? "" : current), /失败|未能|错误/.test(notice) ? 8000 : 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const scheduleRefresh = useCallback((delay = 180) => {
    window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(refresh, delay);
  }, [refresh]);

  // 把一个后台任务放进写入队列。界面已先行更新，任务失败时由调用方回滚。
  const enqueueSync = useCallback((task) => {
    const sync = syncRef.current;
    sync.pending += 1;
    setSyncCount(sync.pending);
    const run = sync.chain.then(task);
    sync.chain = run.catch(() => undefined);
    return run.finally(() => {
      sync.pending -= 1;
      setSyncCount(sync.pending);
      if (!sync.pending) scheduleRefresh(900);
    });
  }, [scheduleRefresh]);

  // 立即在界面上修改若干记录，并登记补丁（刷新时保持新值）。返回本次补丁，用于保存成功/失败处理。
  const applyOptimistic = useCallback((patchesById, { soft = false } = {}) => {
    const version = ++patchVersionRef.current;
    const previousValues = new Map();
    patchesById.forEach((patch, rowId) => {
      const pending = pendingPatchRef.current.get(rowId);
      pendingPatchRef.current.set(rowId, { patch: { ...(pending ? pending.patch : {}), ...patch }, soft, savedAt: 0, version });
    });
    setRows((current) => current.map((row) => {
      const patch = patchesById.get(row.rowid);
      if (!patch) return row;
      previousValues.set(row.rowid, Object.fromEntries(Object.keys(patch).map((key) => [key, row[key]])));
      return { ...row, ...patch, __sig: "" };
    }));
    return {
      version,
      saved() {
        patchesById.forEach((_, rowId) => {
          const pending = pendingPatchRef.current.get(rowId);
          if (pending && pending.version === version) pending.savedAt = Date.now();
        });
      },
      rollback() {
        // 只回滚仍由本次操作控制的记录；之后又被其他操作修改过的记录保持最新状态。
        const restore = new Set();
        patchesById.forEach((_, rowId) => {
          const pending = pendingPatchRef.current.get(rowId);
          if (pending && pending.version === version) {
            pendingPatchRef.current.delete(rowId);
            restore.add(rowId);
          }
        });
        setRows((current) => current.map((row) => {
          const previous = previousValues.get(row.rowid);
          return previous && restore.has(row.rowid) ? { ...row, ...previous, __sig: "" } : row;
        }));
      }
    };
  }, []);


  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const filterEvents = ["filters-update", "filter-update", "quick-filter-update", "quickFilters-update", "quickFiltersUpdate", "fast-filter-update", "fastFilters-update"];
    const dataEvents = ["data-update", "refresh", "update-record", "delete-record", "new-record"];
    const onFilters = (value, data) => setFilters(normalizeFilters(value || data));
    const onData = () => scheduleRefresh();
    filterEvents.forEach((name) => emitter.on && emitter.on(name, onFilters));
    dataEvents.forEach((name) => emitter.on && emitter.on(name, onData));
    const onMessage = (event) => {
      const type = event.data && (event.data.type || event.data.event);
      if (type && /filter/i.test(type)) setFilters(normalizeFilters(event.data));
      if (type && /(record|refresh|data)/i.test(type)) scheduleRefresh();
    };
    window.addEventListener("message", onMessage);
    return () => {
      filterEvents.forEach((name) => emitter.off && emitter.off(name, onFilters));
      dataEvents.forEach((name) => emitter.off && emitter.off(name, onData));
      window.removeEventListener("message", onMessage);
      window.clearTimeout(refreshTimerRef.current);
      window.clearTimeout(dragSaveTimerRef.current);
    };
  }, [refresh, scheduleRefresh]);

  const machineGroupSignature = useMemo(() => rows.map((row) => [row.rowid, row.process, row.machine, row.status, row.machineSequence].join("\u0001")).join("\u0002"), [rows]);
  const processGroups = useMemo(() => {
    const groups = new Map();
    const processNames = new Map();
    rows.forEach((row) => {
      if (!processNames.has(row.process)) processNames.set(row.process, readableProcessName(row.process, row.machine));
    });
    // 合并卡片放在 homeProcess（如“印刷”）工序下；当前数据没有该工序时放在第一条任务所在工序。
    const familyProcess = new Map();
    MACHINE_FAMILIES.forEach((family) => {
      const home = Array.from(processNames.entries()).find(([process, name]) => name === family.homeProcess || process === family.homeProcess);
      if (home) familyProcess.set(family.name, home[0]);
    });
    rows.forEach((row) => {
      if (row.__pending) return;
      const family = machineFamilyOf(row.machine);
      if (family && !familyProcess.has(family.name)) familyProcess.set(family.name, row.process);
      const groupProcess = family ? familyProcess.get(family.name) : row.process;
      if (!groups.has(groupProcess)) groups.set(groupProcess, new Map());
      const machines = groups.get(groupProcess);
      const key = machineCardKey(row);
      const current = machines.get(key) || {
        key, name: family ? family.name : row.machine, family: Boolean(family), members: [],
        count: 0, queuedCount: 0, scheduledCount: 0, sequence: row.machineSequence
      };
      if (family && !current.members.includes(row.machine)) current.members.push(row.machine);
      current.count += 1;
      if (row.status.includes(STATUS.queued) || row.__demo && row.status.includes("未排程")) current.queuedCount += 1;
      if (row.status.includes(STATUS.scheduled)) current.scheduledCount += 1;
      current.sequence = Math.min(current.sequence, row.machineSequence);
      machines.set(key, current);
    });
    return Array.from(groups.entries()).map(([process, machines]) => {
      const savedOrder = machineOrder[process] || [];
      const orderIndex = new Map(savedOrder.map((key, index) => [key, index]));
      const orderedMachines = Array.from(machines.values()).sort((a, b) => {
        const aIndex = orderIndex.has(a.key) ? orderIndex.get(a.key) : Number.MAX_SAFE_INTEGER;
        const bIndex = orderIndex.has(b.key) ? orderIndex.get(b.key) : Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex || a.sequence - b.sequence || a.name.localeCompare(b.name, "zh-CN", { numeric: true });
      });
      return { process, name: processNames.get(process) || process, sequence: orderedMachines[0]?.sequence ?? 999999, machines: orderedMachines };
    }).sort((a, b) => a.sequence - b.sequence || a.process.localeCompare(b.process, "zh-CN", { numeric: true }));
  }, [machineGroupSignature, machineOrder]);
  const allStatusCounts = useMemo(() => ({
    queued: rows.filter((row) => !row.__pending && (row.status.includes(STATUS.queued) || row.__demo && row.status.includes("未排程"))).length,
    scheduled: rows.filter((row) => !row.__pending && row.status.includes(STATUS.scheduled)).length
  }), [rows]);

  const activeMachineKey = useMemo(() => {
    if (activeMachine !== "DEFAULT") return activeMachine;
    const defaultMachine = processGroups.flatMap((group) => group.machines)
      .find((machine) => machine.name.includes(DEFAULT_MACHINE) || machine.members.includes(DEFAULT_MACHINE));
    return defaultMachine ? defaultMachine.key : "ALL";
  }, [activeMachine, processGroups]);

  const activeMachineGroup = useMemo(() => processGroups.find((group) =>
    group.machines.some((machine) => machine.key === activeMachineKey)
  ), [processGroups, activeMachineKey]);
  const activeMachineInfo = useMemo(() => activeMachineGroup && activeMachineGroup.machines.find((machine) =>
    machine.key === activeMachineKey
  ), [activeMachineGroup, activeMachineKey]);
  // 合并卡片包含多个机床取值，不参与“合并机床”（来源和目标都只能是单个机床）。
  const mergeTargetMachines = useMemo(() => activeMachineGroup && activeMachineInfo && !activeMachineInfo.family ? activeMachineGroup.machines.filter((machine) =>
    machine.key !== activeMachineKey && !machine.family
  ) : [], [activeMachineGroup, activeMachineInfo, activeMachineKey]);
  const showMachineColumn = activeMachineKey === "ALL" || isFamilyKey(activeMachineKey);

  useEffect(() => {
    const exists = processGroups.some((group) => group.machines.some((item) => item.key === activeMachineKey));
    if (activeMachine !== "DEFAULT" && activeMachineKey !== "ALL" && !exists) setActiveMachine("DEFAULT");
  }, [processGroups, activeMachine, activeMachineKey]);

  const visible = useMemo(() => rows.filter((row) => activeMachineKey === "ALL" || machineCardKey(row) === activeMachineKey), [rows, activeMachineKey]);

  const moveMachine = (process, targetKey, sourceKey) => {
    if (!sourceKey || sourceKey === targetKey) return;
    const group = processGroups.find((item) => item.process === process);
    if (!group || !group.machines.some((machine) => machine.key === sourceKey)) return;
    const currentOrder = group.machines.map((machine) => machine.key);
    const sourceIndex = currentOrder.indexOf(sourceKey);
    const targetIndex = currentOrder.indexOf(targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextOrder = currentOrder.slice();
    const [moved] = nextOrder.splice(sourceIndex, 1);
    nextOrder.splice(targetIndex, 0, moved);
    setMachineOrder((old) => {
      const next = { ...old, [process]: nextOrder };
      try { localStorage.setItem(machineStorageKey, JSON.stringify(next)); } catch (_) {}
      return next;
    });
  };

  const scheduleQuantityControl = resolveField("scheduleQuantity");
  const processRemarkControl = resolveField("processRemark");
  const qualifiedQuantityControl = resolveField("qualifiedQuantity");
  // 选中合并卡片（或全部机床）时，最前面加“机床”列显示每条任务的实际机床。
  const orderedColumns = useMemo(() => showMachineColumn ? [MACHINE_COLUMN, ...columnLayout] : columnLayout, [showMachineColumn, columnLayout]);
  const displayHeaders = useMemo(() => orderedColumns.map((column) => column.label), [orderedColumns]);
  const fieldKeys = useMemo(() => orderedColumns.map((column) => `field:${column.key}`), [orderedColumns]);
  const presentationSignature = useMemo(() => [
    orderedColumns.map((column) => `${column.key}:${column.label}:${column.width}`).join("|"),
    fieldKeys.join("|"),
    Boolean(qualifiedQuantityControl)
  ].join("\u0001"), [orderedColumns, fieldKeys, Boolean(qualifiedQuantityControl)]);
  const rowPresentation = useMemo(() => {
    const cache = rowPresentationCacheRef.current;
    const reusableEntries = cache.signature === presentationSignature ? cache.entries : new Map();
    const entries = new Map();
    const presentation = new Map();
    rows.forEach((row) => {
      const cached = reusableEntries.get(row.rowid);
      if (cached && cached.row === row) {
        entries.set(row.rowid, cached);
        presentation.set(row.rowid, cached.data);
        return;
      }
      const fields = orderedColumns.map((column) => ({
        ...column,
        value: column.key === "scheduleQuantity" ? String(row.scheduleQuantity || 0) : ["scheduleStartTime", "scheduleEndTime"].includes(column.key) ? compactScheduleTime(row[column.key]) || "—" : cleanText(row[column.key]) || "—",
        progress: column.key === "scheduleQuantity" ? getQuantityProgress(row, Boolean(qualifiedQuantityControl) || row.__demo) : null
      }));
      const data = {
        title: row.productName || row.specModel,
        fields,
        filterValues: Object.fromEntries([
          ["sequence", String(row.sequence || 0)],
          ...fields.map((field, index) => [fieldKeys[index], field.value])
        ])
      };
      entries.set(row.rowid, { row, data });
      presentation.set(row.rowid, data);
    });
    rowPresentationCacheRef.current = { signature: presentationSignature, entries };
    return presentation;
  }, [rows, orderedColumns, fieldKeys, presentationSignature, Boolean(qualifiedQuantityControl)]);
  const cardData = (row) => rowPresentation.get(row.rowid) || { title: row.productName || row.specModel, fields: [] };
  const rowFilterValues = useCallback((row) => rowPresentation.get(row.rowid)?.filterValues || {}, [rowPresentation]);
  const matchesColumnFilters = useCallback((row, columnFilters) => {
    const values = rowFilterValues(row);
    return Object.entries(columnFilters).every(([key, value]) => {
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      return !selected.length || selected.includes(values[key]);
    });
  }, [rowFilterValues]);
  const queuedBase = useMemo(() => visible
    .filter((row) => row.status.includes(STATUS.queued) || row.__demo && row.status.includes("未排程"))
    .sort((a, b) => a.sequence - b.sequence), [visible]);
  const scheduledBase = useMemo(() => {
    const rowsById = new Map(rows.map((row) => [row.rowid, row]));
    const splitAnchors = new Map();
    splitGroupRef.current.forEach((identity, rowId) => {
      const anchor = rowsById.get(rowId);
      if (anchor) splitAnchors.set(identity, anchor);
    });
    const identityFor = (row) => `${row.process}|${row.machine}|${row.orderNo}|${row.productCode}|${row.productName}`;
    return visible.filter((row) => row.status.includes(STATUS.scheduled)).sort((a, b) => {
      const aIdentity = identityFor(a);
      const bIdentity = identityFor(b);
      const aAnchor = splitAnchors.get(aIdentity);
      const bAnchor = splitAnchors.get(bIdentity);
      const aSequence = aAnchor ? aAnchor.sequence : a.sequence;
      const bSequence = bAnchor ? bAnchor.sequence : b.sequence;
      if (aSequence !== bSequence) return aSequence - bSequence;
      if (aIdentity === bIdentity && aAnchor) {
        if (a.rowid === aAnchor.rowid) return -1;
        if (b.rowid === aAnchor.rowid) return 1;
      }
      // 分拆占位行紧跟在原记录后面
      return a.sequence - b.sequence || (a.__pending ? 1 : 0) - (b.__pending ? 1 : 0) || a.rowid.localeCompare(b.rowid);
    });
  }, [rows, visible]);
  const unscheduled = useMemo(() => queuedBase.filter((row) => matchesColumnFilters(row, queuedFilters)), [queuedBase, queuedFilters, matchesColumnFilters]);
  const scheduled = useMemo(() => scheduledBase.filter((row) => matchesColumnFilters(row, scheduledFilters)), [scheduledBase, scheduledFilters, matchesColumnFilters]);
  const hasActiveFilters = (filterState) => Object.values(filterState).some((value) =>
    Array.isArray(value) ? value.length > 0 : Boolean(value)
  );

  useEffect(() => {
    if (queuedBase.length && !unscheduled.length && hasActiveFilters(queuedFilters)) setQueuedFilters({});
    if (scheduledBase.length && !scheduled.length && hasActiveFilters(scheduledFilters)) setScheduledFilters({});
  }, [queuedBase.length, unscheduled.length, scheduledBase.length, scheduled.length, queuedFilters, scheduledFilters]);

  const changeMachine = (machineKey) => {
    setActiveMachine((current) => current === machineKey ? current : machineKey);
    setQueuedFilters((current) => hasActiveFilters(current) ? {} : current);
    setScheduledFilters((current) => hasActiveFilters(current) ? {} : current);
    setSelectedRowIds((current) => current.length ? [] : current);
  };

  // 每个工序下有哪些机床（按机床序号、名称排列），用于“更换机床”只能选同工序的机床
  const machinesByProcess = useMemo(() => {
    const byProcess = new Map();
    rows.forEach((row) => {
      if (row.__pending || !row.machine || row.machine === "未指定机床") return;
      if (!byProcess.has(row.process)) byProcess.set(row.process, new Map());
      const machines = byProcess.get(row.process);
      machines.set(row.machine, Math.min(machines.has(row.machine) ? machines.get(row.machine) : 999999, Number(row.machineSequence) || 999999));
    });
    return new Map(Array.from(byProcess.entries()).map(([process, machines]) => [process,
      Array.from(machines.entries()).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], "zh-CN", { numeric: true })).map(([name]) => name)]));
  }, [machineGroupSignature]);

  // 更换机床：把当前栏里勾选的任务换到同工序的另一台机床，工序、状态、排程顺序不变。
  const openMachineChange = (lane) => {
    const laneRows = lane === "queued" ? unscheduled : scheduled;
    const picked = laneRows.filter((row) => selectedRowIdSet.has(row.rowid) && !row.__pending);
    if (!picked.length) {
      setNotice("请先勾选要更换机床的任务");
      return;
    }
    const processes = Array.from(new Set(picked.map((row) => row.process)));
    if (processes.length > 1) {
      setNotice(`勾选的任务属于不同工序（${processes.join("、")}），请按工序分别更换`);
      return;
    }
    const options = (machinesByProcess.get(processes[0]) || []).filter((name) => picked.some((row) => row.machine !== name));
    if (!options.length) {
      setNotice(`工序“${processes[0]}”下没有其他机床可更换`);
      return;
    }
    setMachineChange({ lane, rowIds: picked.map((row) => row.rowid), process: processes[0], target: options[0] });
  };

  const confirmMachineChange = () => {
    if (!machineChange) return;
    const machineControl = resolveField("machine");
    if (!machineControl) {
      setNotice("请先在插件设置中映射机床字段");
      return;
    }
    const target = machineChange.target;
    const picked = rows.filter((row) => machineChange.rowIds.includes(row.rowid) && row.machine !== target && !isVirtualRow(row));
    setMachineChange(null);
    if (!picked.length) return;
    let encodedMachine;
    try { encodedMachine = encodeValue(machineControl, target); }
    catch (error) { setNotice(`更换机床失败：${error.message}`); return; }
    const optimistic = applyOptimistic(new Map(picked.map((row) => [row.rowid, { machine: target }])));
    const pickedIds = new Set(picked.map((row) => row.rowid));
    setSelectedRowIds((current) => current.filter((rowId) => !pickedIds.has(rowId)));
    const stays = picked.every((row) => machineCardKey({ ...row, machine: target }) === activeMachineKey) || activeMachineKey === "ALL";
    setNotice(`已将 ${picked.length} 条任务更换到“${target}”${stays ? "" : "，可在对应机床卡片中查看"}`);
    enqueueSync(() => runConcurrently(picked.map((row) => () => updateRow({
      appId, worksheetId, viewId, rowId: row.rowid,
      newOldControl: [{ controlId: machineControl.controlId, controlName: machineControl.controlName, type: machineControl.type, value: encodedMachine }]
    }))))
      .then(() => optimistic.saved())
      .catch((error) => {
        optimistic.rollback();
        setNotice(`更换机床失败，已恢复：${error.message || "请检查机床字段权限"}`);
      });
  };

  const changeMachineButton = (lane, laneRows) => {
    const count = selectedVisibleCount(laneRows);
    return <button type="button" className="change-machine-trigger" onClick={() => openMachineChange(lane)} title={count ? `把勾选的 ${count} 条任务更换到同工序的其他机床` : "先勾选任务，再更换到同工序的其他机床"}>更换机床{count ? ` (${count})` : ""}</button>;
  };

  const openMachineMerge = () => {
    if (!activeMachineInfo || !mergeTargetMachines.length) return;
    setMachineMergeTargetKey(mergeTargetMachines[0].key);
  };

  const confirmMachineMerge = () => {
    const targetMachine = mergeTargetMachines.find((machine) => machine.key === machineMergeTargetKey);
    const machineControl = resolveField("machine");
    if (!activeMachineInfo || !targetMachine || !activeMachineGroup) return;
    if (!machineControl) {
      setNotice("请先在插件设置中映射机床字段");
      return;
    }
    const sourceRows = rows.filter((row) => `${row.process}::${row.machine}` === activeMachineKey && !isVirtualRow(row));
    setMachineMergeTargetKey(null);
    if (!sourceRows.length) {
      setNotice("当前机床没有可合并的真实任务");
      return;
    }
    let encodedMachine;
    try { encodedMachine = encodeValue(machineControl, targetMachine.name); }
    catch (error) { setNotice(`合并机床失败：${error.message}`); return; }
    // 先切到目标机床并改好界面，后台再逐条写入机床字段。
    const optimistic = applyOptimistic(new Map(sourceRows.map((row) => [row.rowid, { machine: targetMachine.name }])));
    changeMachine(targetMachine.key);
    setNotice(`已将 ${sourceRows.length} 条任务从“${activeMachineInfo.name}”合并至“${targetMachine.name}”，工序“${activeMachineGroup.name}”保持不变`);
    enqueueSync(() => runConcurrently(sourceRows.map((row) => () => updateRow({
      appId, worksheetId, viewId, rowId: row.rowid,
      newOldControl: [{ controlId: machineControl.controlId, controlName: machineControl.controlName, type: machineControl.type, value: encodedMachine }]
    }))))
      .then(() => optimistic.saved())
      .catch((error) => {
        optimistic.rollback();
        setNotice(`合并机床失败，已恢复：${error.message || "请检查机床字段权限"}`);
      });
  };

  // 勾选：表头勾选框/菜单全选、全不选当前列表（筛选后可见的记录）；单行勾选互不影响。
  const setLaneChecked = (sourceRows, checked) => {
    const rowIds = sourceRows.filter((row) => !row.__pending).map((row) => row.rowid);
    const rowIdSet = new Set(rowIds);
    setSelectedRowIds((current) => checked
      ? Array.from(new Set([...current, ...rowIds]))
      : current.filter((rowId) => !rowIdSet.has(rowId)));
  };
  const toggleRowChecked = (row) => {
    if (row.__pending) return;
    setSelectedRowIds((current) => current.includes(row.rowid)
      ? current.filter((rowId) => rowId !== row.rowid)
      : [...current, row.rowid]);
  };

  const toggleSelectVisible = (sourceRows) => {
    const rowIds = sourceRows.filter((row) => !row.__pending).map((row) => row.rowid);
    const sourceRowIds = new Set(rowIds);
    if (!rowIds.length) return;
    setSelectedRowIds((current) => {
      const selectedIds = new Set(current);
      const allSelected = rowIds.every((rowId) => selectedIds.has(rowId));
      return allSelected
        ? current.filter((rowId) => !sourceRowIds.has(rowId))
        : Array.from(new Set([...current, ...rowIds]));
    });
  };
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const selectedVisibleCount = (sourceRows) => sourceRows.filter((row) => selectedRowIdSet.has(row.rowid)).length;
  const filterOptions = useCallback((sourceRows, key) => Array.from(new Set(
    sourceRows.map((row) => rowFilterValues(row)[key]).filter((value) => value && value !== "—")
  )).sort((a, b) => String(a).localeCompare(String(b), "zh-CN", { numeric: true })), [rowFilterValues]);
  const queuedColumnOptions = useCallback((key) => filterOptions(queuedBase, key), [queuedBase, filterOptions]);
  const scheduledColumnOptions = useCallback((key) => filterOptions(scheduledBase, key), [scheduledBase, filterOptions]);
  const setColumnFilter = (lane, key, value) => {
    const setter = lane === "queued" ? setQueuedFilters : setScheduledFilters;
    setter((old) => ({ ...old, [key]: value }));
  };
  const saveColumnLayout = (next) => {
    setColumnLayout(next);
    try { localStorage.setItem(columnStorageKey, JSON.stringify(next.map(({ key, width }) => ({ key, width })))); } catch (_) {}
  };
  const moveColumn = (targetKey, sourceKey = draggedColumn) => {
    if (!sourceKey || sourceKey === targetKey) return;
    const next = columnLayout.slice();
    const sourceIndex = next.findIndex((column) => column.key === sourceKey);
    const targetIndex = next.findIndex((column) => column.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    saveColumnLayout(next);
    setDraggedColumn(null);
  };
  const beginColumnResize = (columnKey, event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startColumn = columnLayout.find((column) => column.key === columnKey);
    if (!startColumn) return;
    let latest = columnLayout;
    const onMove = (moveEvent) => {
      const width = Math.max(0, Math.min(500, startColumn.width + moveEvent.clientX - startX));
      latest = columnLayout.map((column) => column.key === columnKey ? { ...column, width } : column);
      setColumnLayout(latest);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      document.body.classList.remove("resizing-column");
      saveColumnLayout(latest);
    };
    document.body.classList.add("resizing-column");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  };
  const tableStyle = {
    gridTemplateColumns: [`${CHECK_COLUMN_WIDTH}px`, "34px", ...orderedColumns.map((column) => `${column.width}px`), "56px"].join(" "),
    "--table-min-width": `${CHECK_COLUMN_WIDTH + 90 + orderedColumns.reduce((sum, column) => sum + column.width, 0)}px`
  };
  const queuedTableStyle = {
    gridTemplateColumns: [`${CHECK_COLUMN_WIDTH}px`, ...orderedColumns.map((column) => `${column.width}px`), "62px"].join(" "),
    "--table-min-width": `${CHECK_COLUMN_WIDTH + 62 + orderedColumns.reduce((sum, column) => sum + column.width, 0)}px`
  };

  // 把排程顺序/状态/时间的变化写回明道云（由调用方放进后台队列）。
  const persistOrder = async (nextRows, changedIds, previousRows = rows) => {
    const statusControl = resolveField("status");
    const sequenceControl = resolveField("sequence");
    const processControl = resolveField("process");
    const machineControl = resolveField("machine");
    const startTimeControl = resolveField("scheduleStartTime");
    const endTimeControl = resolveField("scheduleEndTime");
    const changedIdSet = new Set(changedIds);
    const changed = nextRows.filter((row) => changedIdSet.has(row.rowid) && !isVirtualRow(row));
    if (!changed.length) return;
    const previousMap = new Map(previousRows.map((row) => [row.rowid, row]));
    const hasStatusChange = changed.some((row) => row.status !== previousMap.get(row.rowid)?.status);
    const hasProcessChange = changed.some((row) => row.process !== previousMap.get(row.rowid)?.process);
    const hasMachineChange = changed.some((row) => row.machine !== previousMap.get(row.rowid)?.machine);
    if (!sequenceControl || hasStatusChange && !statusControl || hasProcessChange && !processControl || hasMachineChange && !machineControl) {
      throw new Error("请先在插件设置中映射排程状态、排程序号、工序和机床字段");
    }
    const requests = changed.map((row) => {
      const previous = previousMap.get(row.rowid) || {};
      const controls = [];
      if (row.status !== previous.status) controls.push({ ...statusControl, value: encodeValue(statusControl, row.status) });
      if (row.process !== previous.process) controls.push({ ...processControl, value: encodeValue(processControl, row.process) });
      if (row.machine !== previous.machine) controls.push({ ...machineControl, value: encodeValue(machineControl, row.machine) });
      if (Number(row.sequence) !== Number(previous.sequence)) controls.push({ ...sequenceControl, value: encodeValue(sequenceControl, row.sequence) });
      if (startTimeControl && row.scheduleStartTime !== previous.scheduleStartTime) controls.push({ ...startTimeControl, value: encodeValue(startTimeControl, row.scheduleStartTime) });
      if (endTimeControl && row.scheduleEndTime !== previous.scheduleEndTime) controls.push({ ...endTimeControl, value: encodeValue(endTimeControl, row.scheduleEndTime) });
      return controls.length ? {
        rowId: row.rowid,
        payload: {
          appId, worksheetId, viewId, rowId: row.rowid,
          newOldControl: controls.map(({ controlId, controlName, type, value }) => ({ controlId, controlName, type, value }))
        }
      } : null;
    }).filter(Boolean);
    if (!requests.length) return;
    try {
      window.__machineSchedulerLastOrderSave = requests;
      await runConcurrently(requests.map((request) => () => updateRow(request.payload)));
    } catch (error) {
      window.__machineSchedulerLastOrderError = { message: error.message, requests };
      throw new Error(error.message || "请检查排程状态和排程序号字段权限及映射");
    }
  };

  // 拖拽结果已显示在界面上；连续拖拽 400ms 内合并成一次后台保存。
  const queueDragSave = (moves, optimistic) => {
    const pending = pendingDragSaveRef.current || { moves: new Map(), optimistic: [] };
    moves.forEach(({ row, previous }) => {
      const existing = pending.moves.get(row.rowid);
      pending.moves.set(row.rowid, { row, previous: existing ? existing.previous : previous });
    });
    pending.optimistic.push(optimistic);
    pendingDragSaveRef.current = pending;
    window.clearTimeout(dragSaveTimerRef.current);
    dragSaveTimerRef.current = window.setTimeout(() => {
      const save = pendingDragSaveRef.current;
      pendingDragSaveRef.current = null;
      if (!save || !save.moves.size) return;
      const entries = Array.from(save.moves.values());
      const changedIds = entries.map((entry) => entry.row.rowid);
      enqueueSync(() => persistOrder(entries.map((entry) => entry.row), changedIds, entries.map((entry) => entry.previous)))
        .then(() => save.optimistic.forEach((optimistic) => optimistic.saved()))
        .catch((error) => {
          // 恢复到拖拽前的状态；之后又被其他操作改过的记录不动。
          const maxVersion = Math.max(...save.optimistic.map((optimistic) => optimistic.version));
          const restore = new Map();
          entries.forEach((entry) => {
            const pending = pendingPatchRef.current.get(entry.row.rowid);
            if (pending && pending.version > maxVersion) return;
            pendingPatchRef.current.delete(entry.row.rowid);
            restore.set(entry.row.rowid, entry.previous);
          });
          setRows((current) => current.map((row) => {
            const previous = restore.get(row.rowid);
            return previous ? { ...row, status: previous.status, process: previous.process, machine: previous.machine, sequence: previous.sequence, __sig: "" } : row;
          }));
          setNotice(`保存失败，已恢复：${error.message || "请检查字段权限和映射"}`);
        });
    }, 400);
  };

  // 单击行 = 勾选/取消勾选该行（不影响其他已勾选的行）；延迟执行，双击打开详情时不会误勾选。
  const queueRowSelect = (event, row) => {
    if (event.ctrlKey || event.metaKey) event.preventDefault();
    window.clearTimeout(rowClickTimerRef.current);
    rowClickTimerRef.current = window.setTimeout(() => toggleRowChecked(row), 160);
  };

  // 拖动已勾选的行：同一栏里所有勾选（且当前可见）的行按显示顺序一起拖；拖动未勾选的行只拖这一行。
  // 返回本次拖动的条数（用于拖动预览）。
  const startRowDrag = (row) => {
    window.clearTimeout(rowClickTimerRef.current);
    const selectedIds = new Set(selectedRowIds);
    const laneRows = scheduled.some((item) => item.rowid === row.rowid) ? scheduled : unscheduled;
    const group = selectedIds.has(row.rowid)
      ? laneRows.filter((item) => selectedIds.has(item.rowid) && !item.__pending)
      : [row];
    dragGroupRef.current = group.length ? group : [row];
    draggedRef.current = row;
    setDragged(row);
    return dragGroupRef.current.length;
  };

  const endRowDrag = () => {
    dragGroupRef.current = [];
    draggedRef.current = null;
    setDragged(null);
  };

  const dropToLane = (lane, event, targetRow = null) => {
    event.preventDefault();
    event.stopPropagation();
    const draggedRowId = event.dataTransfer && event.dataTransfer.getData("text/plain");
    const source = draggedRef.current || dragged || rows.find((row) => row.rowid === draggedRowId);
    if (!source) return;
    const movingRows = (dragGroupRef.current.length ? dragGroupRef.current : [source])
      .filter((row, index, list) => !row.__pending && list.findIndex((item) => item.rowid === row.rowid) === index);
    const movingIds = new Set(movingRows.map((row) => row.rowid));
    if (!movingRows.length || targetRow && movingIds.has(targetRow.rowid)) { endRowDrag(); return; }
    // 单个机床卡片：任务落到该机床；合并卡片/全部机床：每条任务保持自己原本的工序和机床。
    const separator = activeMachineKey.indexOf("::");
    const fixedTarget = activeMachineKey !== "ALL" && !isFamilyKey(activeMachineKey) && separator > -1
      ? { process: activeMachineKey.slice(0, separator), machine: activeMachineKey.slice(separator + 2) }
      : null;
    const targetStatus = lane === "scheduled" ? STATUS.scheduled : STATUS.queued;
    const destinationBase = (lane === "scheduled" ? scheduledBase : queuedBase).filter((row) => !movingIds.has(row.rowid) && !row.__pending);
    let targetIndex = targetRow ? destinationBase.findIndex((row) => row.rowid === targetRow.rowid) : destinationBase.length;
    if (targetIndex < 0) targetIndex = destinationBase.length;
    let movedRows = movingRows.map((row) => ({
      ...row,
      process: fixedTarget ? fixedTarget.process : row.process,
      machine: fixedTarget ? fixedTarget.machine : row.machine,
      status: targetStatus
    }));
    if (lane === "scheduled") {
      const previousRow = destinationBase[targetIndex - 1];
      const nextRow = destinationBase[targetIndex];
      const previousSequence = previousRow ? Number(previousRow.sequence) : null;
      const nextSequence = nextRow ? Number(nextRow.sequence) : null;
      const gap = previousSequence != null && nextSequence != null ? nextSequence - previousSequence : null;
      const step = previousSequence != null && nextSequence != null
        ? gap > 0 ? gap / (movedRows.length + 1) : 0.001
        : 1;
      // 拖到第一条之前时，序号取在第一条之前（原逻辑会排到第一条后面）。
      const start = previousSequence != null ? previousSequence : nextSequence != null ? nextSequence - (movedRows.length + 1) : 0;
      movedRows = movedRows.map((row, index) => ({ ...row, sequence: start + step * (index + 1) }));
    } else {
      movedRows = movedRows.map((row) => ({ ...row, sequence: 0 }));
    }
    const currentById = new Map(rows.map((row) => [row.rowid, row]));
    const optimistic = applyOptimistic(new Map(movedRows.map((row) => [row.rowid, {
      status: row.status, process: row.process, machine: row.machine, sequence: row.sequence
    }])));
    // 拖完后这些行取消勾选，其余勾选保持
    const movedIdSet = new Set(movedRows.map((row) => row.rowid));
    setSelectedRowIds((current) => current.filter((rowId) => !movedIdSet.has(rowId)));
    dragGroupRef.current = [];
    draggedRef.current = null;
    setDragged(null);
    queueDragSave(movedRows.filter((row) => !isVirtualRow(row)).map((row) => ({ row, previous: currentById.get(row.rowid) })), optimistic);
  };

  const openRecord = (row) => {
    window.clearTimeout(rowClickTimerRef.current);
    if (row.__demo || !mdyeUtils || typeof mdyeUtils.openRecordInfo !== "function") return;
    mdyeUtils.openRecordInfo({ appId, worksheetId, viewId, recordId: row.rowid }).then(refresh);
  };

  // 以下所有操作都是“先改界面、后台排队保存、失败回滚”，不再等待接口返回。
  const saveScheduleQuantity = (row, rawValue) => {
    if (!scheduleQuantityControl || isVirtualRow(row)) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0 || value === row.scheduleQuantity) return;
    const original = Number(row.scheduleQuantity) || 0;
    let encoded;
    try { encoded = encodeValue(scheduleQuantityControl, value); }
    catch (error) { setNotice(`排程量保存失败：${error.message}`); return; }
    const optimistic = applyOptimistic(new Map([[row.rowid, { scheduleQuantity: value }]]));
    if (original > 0 && value < original) {
      setSplitTarget({ ...row, scheduleQuantity: original, __requestedQuantity: value });
      setSplitAmount(String(value));
    }
    enqueueSync(() => updateRow({
      appId, worksheetId, viewId, rowId: row.rowid,
      newOldControl: [{ controlId: scheduleQuantityControl.controlId, controlName: scheduleQuantityControl.controlName, type: scheduleQuantityControl.type, value: encoded }]
    }))
      .then(() => optimistic.saved())
      .catch((error) => {
        optimistic.rollback();
        setNotice(`排程量保存失败，已恢复：${error.message || "请检查字段权限"}`);
      });
  };

  const saveProcessRemark = (row, value) => {
    const currentValue = row.processRemark === "—" ? "" : row.processRemark;
    if (value === currentValue || !processRemarkControl || isVirtualRow(row)) return;
    let encoded;
    try { encoded = encodeValue(processRemarkControl, value); }
    catch (error) { setNotice(`工艺备注保存失败：${error.message}`); return; }
    const optimistic = applyOptimistic(new Map([[row.rowid, { processRemark: value || "—" }]]));
    enqueueSync(() => updateRow({
      appId, worksheetId, viewId, rowId: row.rowid,
      newOldControl: [{ controlId: processRemarkControl.controlId, controlName: processRemarkControl.controlName, type: processRemarkControl.type, value: encoded }]
    }))
      .then(() => optimistic.saved())
      .catch((error) => {
        optimistic.rollback();
        setNotice(`工艺备注保存失败，已恢复：${error.message || "请检查字段权限"}`);
      });
  };

  const openSplit = (row) => {
    if (row.__pending) return;
    setSplitTarget(row);
    setSplitAmount(row.scheduleQuantity > 0 ? String(Math.max(0, row.scheduleQuantity - 1)) : "");
  };

  // 分拆：弹窗立即关闭，原记录立即显示保留量，并在其下方插入“生成中”的占位行；
  // 后台依次写入保留量、触发“分拆”按钮，新记录返回后自动替换占位行。
  const confirmSplit = () => {
    if (!splitTarget) return;
    const target = splitTarget;
    const retainedAmount = Number(splitAmount);
    const originalAmount = Number(target.scheduleQuantity) || 0;
    if (!Number.isFinite(retainedAmount) || retainedAmount < 0) {
      setNotice("请输入不小于 0 的调整后排程量");
      return;
    }
    if (originalAmount <= 0 || retainedAmount >= originalAmount) {
      setNotice("调整后排程量必须小于当前排程量");
      return;
    }
    let encoded = null;
    if (scheduleQuantityControl) {
      try { encoded = encodeValue(scheduleQuantityControl, retainedAmount); }
      catch (error) { setNotice(`分拆失败：${error.message}`); return; }
    }
    setSplitTarget(null);
    const splitQuantity = originalAmount - retainedAmount;
    const source = rows.find((row) => row.rowid === target.rowid) || target;
    const identity = splitIdentity(source);
    const tempId = `__split_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const placeholder = {
      ...source, rowid: tempId, scheduleQuantity: splitQuantity, preSplitScheduleQuantity: splitQuantity,
      splitDifference: 0, qualifiedQuantity: 0, sequence: Number(source.sequence) || 0, __pending: true, __sig: ""
    };
    const split = {
      placeholder, identity, sourceId: source.rowid, submittedAt: 0,
      baselineIds: new Set(rows.filter((row) => !row.__pending && splitIdentity(row) === identity).map((row) => row.rowid))
    };
    pendingSplitsRef.current.set(tempId, split);
    const optimistic = applyOptimistic(new Map([[source.rowid, { scheduleQuantity: retainedAmount }]]));
    setRows((current) => {
      const index = current.findIndex((row) => row.rowid === source.rowid);
      const next = current.slice();
      next.splice(index < 0 ? next.length : index + 1, 0, placeholder);
      return next;
    });
    setNotice(`已分拆：保留 ${retainedAmount}，拆出 ${splitQuantity}，新记录生成中…`);
    let quantitySaved = !scheduleQuantityControl;
    enqueueSync(async () => {
      if (scheduleQuantityControl) {
        await updateRow({
          appId, worksheetId, viewId, rowId: source.rowid,
          newOldControl: [{ controlId: scheduleQuantityControl.controlId, controlName: scheduleQuantityControl.controlName, type: scheduleQuantityControl.type, value: encoded }]
        });
        quantitySaved = true;
      }
      const button = await findWorksheetButton("分拆", { appId, worksheetId, viewId, rowId: source.rowid });
      const btnId = button && button.btnId;
      if (!btnId) throw new Error("当前视图未找到“分拆”自定义按钮");
      const payload = compact({ appId: worksheetId, sources: [source.rowid], triggerId: btnId, pushUniqueId: getPushUniqueId(), viewId, isAll: false, dataLog: `原排程量：${originalAmount}；保留排程量：${retainedAmount}；拆出数量：${splitQuantity}` });
      window.__machineSchedulerLastSplitAction = { button, payload };
      await startProcess(payload);
    })
      .then(() => {
        optimistic.saved();
        split.submittedAt = Date.now();
        splitGroupRef.current.set(source.rowid, identity);
        scheduleRefresh(1500);
      })
      .catch((error) => {
        pendingSplitsRef.current.delete(tempId);
        setRows((current) => current.filter((row) => row.rowid !== tempId));
        if (quantitySaved) {
          optimistic.saved();
          setNotice(`排程量已改为 ${retainedAmount}，但分拆失败：${error.message || "请检查自定义按钮配置"}`);
        } else {
          optimistic.rollback();
          setNotice(`分拆失败，已恢复：${error.message || "请检查自定义按钮配置"}`);
        }
      });
  };

  const completeProduction = (row) => {
    if (row.__pending || row.status.includes(STATUS.produced)) return;
    const statusControl = resolveField("status");
    if (!row.__demo && !statusControl) {
      setNotice("请先在插件设置中映射排程状态字段");
      return;
    }
    let encoded = null;
    if (!row.__demo) {
      try { encoded = encodeValue(statusControl, STATUS.produced); }
      catch (error) { setNotice(`完成生成失败：${error.message}`); return; }
    }
    const optimistic = applyOptimistic(new Map([[row.rowid, { status: STATUS.produced }]]));
    setSelectedRowIds((current) => current.filter((rowId) => rowId !== row.rowid));
    setNotice("已更新为已生产");
    if (row.__demo) return;
    enqueueSync(() => updateRow({
      appId, worksheetId, viewId, rowId: row.rowid,
      newOldControl: [{ controlId: statusControl.controlId, controlName: statusControl.controlName, type: statusControl.type, value: encoded }]
    }))
      .then(() => optimistic.saved())
      .catch((error) => {
        optimistic.rollback();
        setNotice(`完成生成失败，已恢复：${error.message || "请检查排程状态字段权限"}`);
      });
  };

  const requestDelete = (row) => {
    if (row.__demo) {
      setNotice("示例记录不能删除");
      return;
    }
    if (row.__pending) return;
    setDeleteTarget(row);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    pendingDeletesRef.current.add(target.rowid);
    setRows((current) => current.filter((row) => row.rowid !== target.rowid));
    setSelectedRowIds((current) => current.filter((rowId) => rowId !== target.rowid));
    setNotice("记录已移至回收站");
    enqueueSync(() => deleteWorksheetRows({ appId, worksheetId, viewId, rowIds: [target.rowid] }))
      // 删除成功后保留一段时间，避免删除前已发出的刷新把记录带回来。
      .then(() => window.setTimeout(() => pendingDeletesRef.current.delete(target.rowid), 10000))
      .catch((error) => {
        pendingDeletesRef.current.delete(target.rowid);
        setRows((current) => current.some((row) => row.rowid === target.rowid) ? current : [...current, target]);
        setNotice(`删除失败，记录已恢复：${error.message || "请检查删除权限"}`);
      });
  };

  // 确定排程：弹窗立即关闭，排程时间立即算好显示；后台先保存时间和顺序，再触发“确定排程”按钮。
  const confirmSchedule = (startTimeValue) => {
    if (confirmingSchedule || !scheduled.length) return;
    if (!startTimeValue) {
      setConfirmStartTime(defaultScheduleStartValue());
      return;
    }
    // “确定排程”始终针对当前右侧已排程区域经过机床和字段筛选后实际显示的全部记录。
    const realTargets = scheduled.filter((row) => !isVirtualRow(row));
    if (!realTargets.length) {
      setNotice("当前没有可确定排程的真实记录");
      return;
    }
    const sortJob = autoSort("scheduled", startTimeValue, true);
    if (!sortJob) return;
    const rowIds = realTargets.map((row) => row.rowid);
    setConfirmStartTime("");
    setConfirmingSchedule(true);
    setSelectedRowIds([]);
    setNotice(`正在确定排程 ${rowIds.length} 条（后台提交中，可继续操作）`);
    sortJob
      .then((sorted) => {
        if (!sorted) throw new Error("排程时间未能保存");
        return enqueueSync(async () => {
          const button = await findWorksheetButton("确定排程", { appId, worksheetId, viewId, rowId: rowIds[0] });
          const btnId = button && button.btnId;
          if (!btnId) throw new Error("当前视图未找到“确定排程”自定义按钮");
          const payload = compact({
            appId: worksheetId, sources: rowIds, triggerId: btnId,
            pushUniqueId: getPushUniqueId(), viewId, isAll: false,
            dataLog: `机床排程工作台确定当前页面已排程记录，共 ${rowIds.length} 条`
          });
          window.__machineSchedulerLastConfirmAction = { button, payload };
          await startProcess(payload);
        });
      })
      .then(() => {
        setNotice(`已对当前页面显示的 ${rowIds.length} 条已排程记录触发确定排程`);
        scheduleRefresh(1000);
      })
      .catch((error) => setNotice(`确定排程失败：${error.message || "请检查自定义按钮配置"}`))
      .finally(() => setConfirmingSchedule(false));
  };

  // 合并分拆：本记录排程量 = 本记录排程量 + 勾选的被合并记录排程量之和，被合并记录移入回收站。
  // 不再调用明道云“合并”按钮——该工作流只把拆前数量改成当前排程量，拆出去的数量没有加回来。
  // 被合并记录 = 当前视图中同一生产单号、产品编号、产品名称的其他未生产记录（默认勾选同工序、同状态的）。
  const mergeCandidatesFor = (target) => {
    const blank = (value) => !value || value === "—";
    if (blank(target.orderNo) && blank(target.productCode)) return [];
    const identity = (row) => `${row.orderNo}|${row.productCode}|${row.productName}`;
    return rows.filter((row) => row.rowid !== target.rowid && !row.__pending && !pendingDeletesRef.current.has(row.rowid)
      && !row.status.includes(STATUS.produced) && identity(row) === identity(target))
      .sort((a, b) => (a.process === target.process ? 0 : 1) - (b.process === target.process ? 0 : 1)
        || (a.status === target.status ? 0 : 1) - (b.status === target.status ? 0 : 1)
        || a.sequence - b.sequence);
  };
  const mergeCandidates = useMemo(() => mergeTarget ? mergeCandidatesFor(mergeTarget) : [], [mergeTarget, rows]);

  const mergeSplitRow = (row) => {
    if (isVirtualRow(row) || Number(row.splitDifference) <= 0) return;
    const candidates = mergeCandidatesFor(row);
    setMergeTarget(row);
    setMergePicked(candidates.filter((item) => item.process === row.process && item.status === row.status).map((item) => item.rowid));
  };

  const confirmMergeSplit = () => {
    if (!mergeTarget) return;
    const target = rows.find((row) => row.rowid === mergeTarget.rowid) || mergeTarget;
    const picked = mergeCandidates.filter((row) => mergePicked.includes(row.rowid));
    if (!picked.length) return;
    if (!scheduleQuantityControl) {
      setNotice("请先在插件设置中映射排程量字段");
      return;
    }
    const own = Number(target.scheduleQuantity) || 0;
    const added = picked.reduce((sum, row) => sum + (Number(row.scheduleQuantity) || 0), 0);
    const total = own + added;
    const preControl = resolveField("preSplitScheduleQuantity");
    const pre = Number(target.preSplitScheduleQuantity) || 0;
    const writePre = Boolean(preControl) && total > pre;
    let controls;
    let revertControls;
    try {
      const quantityControl = (value) => ({ controlId: scheduleQuantityControl.controlId, controlName: scheduleQuantityControl.controlName, type: scheduleQuantityControl.type, value: encodeValue(scheduleQuantityControl, value) });
      const preControlValue = (value) => ({ controlId: preControl.controlId, controlName: preControl.controlName, type: preControl.type, value: encodeValue(preControl, value) });
      controls = [quantityControl(total), ...(writePre ? [preControlValue(total)] : [])];
      revertControls = [quantityControl(own), ...(writePre ? [preControlValue(pre)] : [])];
    } catch (error) {
      setNotice(`合并失败：${error.message}`);
      return;
    }
    setMergeTarget(null);
    const newPre = Math.max(pre, total);
    const optimistic = applyOptimistic(new Map([[target.rowid, {
      scheduleQuantity: total,
      ...(writePre ? { preSplitScheduleQuantity: total } : {}),
      splitDifference: Math.max(0, newPre - total)
    }]]));
    const pickedIds = picked.map((row) => row.rowid);
    pickedIds.forEach((rowId) => pendingDeletesRef.current.add(rowId));
    setRows((current) => current.filter((row) => !pickedIds.includes(row.rowid)));
    setSelectedRowIds((current) => current.filter((rowId) => !pickedIds.includes(rowId)));
    setNotice(`已合并：${own} + ${added} = ${total}，${picked.length} 条被合并记录移入回收站`);
    let revertFailed = false;
    enqueueSync(async () => {
      await updateRow({ appId, worksheetId, viewId, rowId: target.rowid, newOldControl: controls });
      try {
        await deleteWorksheetRows({ appId, worksheetId, viewId, rowIds: pickedIds });
      } catch (error) {
        // 删除失败时把排程量改回去，避免数量被重复计算
        await updateRow({ appId, worksheetId, viewId, rowId: target.rowid, newOldControl: revertControls }).catch(() => { revertFailed = true; });
        throw error;
      }
    })
      .then(() => {
        optimistic.saved();
        window.setTimeout(() => pickedIds.forEach((rowId) => pendingDeletesRef.current.delete(rowId)), 10000);
      })
      .catch((error) => {
        optimistic.rollback();
        pickedIds.forEach((rowId) => pendingDeletesRef.current.delete(rowId));
        setRows((current) => [...current, ...picked.filter((row) => !current.some((item) => item.rowid === row.rowid))]);
        setNotice(revertFailed
          ? `合并失败：被合并记录未删除，且排程量未能改回 ${own}，请手动核对（${error.message || "请检查权限"}）`
          : `合并失败，已恢复：${error.message || "请检查排程量字段和删除权限"}`);
        scheduleRefresh(600);
      });
  };

  // 自动排序：立即显示新顺序和时间；返回保存结果的 Promise（参数无效时返回 false）。
  const autoSort = (lane = "scheduled", startTimeValue = defaultScheduleStartValue(), quiet = false) => {
    const sourceRows = (lane === "scheduled" ? scheduledBase : queuedBase).filter((row) => !row.__pending);
    if (!sourceRows.length) return false;
    let updates;
    let missingRateCount;
    try {
      ({ updates, missingRateCount } = calculateTimedSchedule(sourceRows, startTimeValue));
    } catch (error) {
      setNotice(error.message || "排程开始时间无效");
      return false;
    }
    const currentById = new Map(rows.map((row) => [row.rowid, row]));
    const changed = updates.filter((row) => {
      const previous = currentById.get(row.rowid);
      return previous && (Number(previous.sequence) !== Number(row.sequence)
        || previous.scheduleStartTime !== row.scheduleStartTime
        || previous.scheduleEndTime !== row.scheduleEndTime);
    });
    if (!quiet) setNotice(`已按机床、交期、产品名称、尺寸、颜色/版型自动排序，从 ${formatScheduleTime(startTimeValue)} 起连续计算排程时间${missingRateCount ? `；${missingRateCount} 条缺少张/分钟，仅计换版时间` : ""}`);
    if (!changed.length) return Promise.resolve(true);
    const optimistic = applyOptimistic(new Map(changed.map((row) => [row.rowid, {
      sequence: row.sequence, scheduleStartTime: row.scheduleStartTime, scheduleEndTime: row.scheduleEndTime
    }])));
    return enqueueSync(() => persistOrder(changed, changed.map((row) => row.rowid), changed.map((row) => currentById.get(row.rowid))))
      .then(() => { optimistic.saved(); return true; })
      .catch((error) => {
        optimistic.rollback();
        setNotice(`自动排序保存失败，已恢复：${error.message || "请检查排程序号字段权限和映射"}`);
        return false;
      });
  };

  const hiddenPane = paneStep === 1 ? "left" : paneStep === 3 ? "right" : "";
  // 标题左侧的斜向双箭头：该栏铺满整个插件区域（隐藏机床卡片和另一栏），浏览器允许时同时进入全屏；再点或按 Esc 还原。
  const toggleMaximize = (lane) => {
    const next = maximizedLane === lane ? "" : lane;
    setMaximizedLane(next);
    try {
      if (next && !document.fullscreenElement && document.fullscreenEnabled && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => undefined);
      }
      if (!next && document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => undefined);
    } catch (_) {}
  };

  useEffect(() => {
    if (!maximizedLane) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !document.querySelector(".modal-backdrop")) setMaximizedLane("");
    };
    // 在浏览器全屏里按 Esc 会直接退出全屏，这时一并还原。
    const onFullscreenChange = () => { if (!document.fullscreenElement) setMaximizedLane(""); };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
    };
  }, [maximizedLane]);

  const maximizeButton = (lane, label) => {
    const active = maximizedLane === lane;
    return <button type="button" className={`maximize-toggle ${active ? "active" : ""}`} onClick={() => toggleMaximize(lane)} title={active ? "还原（Esc）" : `全屏显示${label}`} aria-label={active ? "还原" : `全屏显示${label}`} aria-pressed={active}>
      <svg aria-hidden="true" viewBox="0 0 20 20">{active
        ? <path d="M16.5 3.5 11 9M11 4.5V9h4.5M3.5 16.5 9 11M9 15.5V11H4.5" />
        : <path d="M4 16 16 4M10.5 4H16v5.5M9.5 16H4v-5.5" />}</svg>
    </button>;
  };

  const togglePanes = () => {
    const next = (paneStep + 1) % 4;
    setPaneStep(next);
    setNotice(next === 1 ? "已隐藏未排程区，双击中间分隔线还原"
      : next === 3 ? "已隐藏已排程区，双击中间分隔线还原"
      : "已还原左右两栏");
  };

  const beginResize = (event) => {
    event.preventDefault();
    const element = boardsRef.current;
    if (!element || hiddenPane) return;
    const rect = element.getBoundingClientRect();
    const onMove = (moveEvent) => {
      const percentage = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setLeftWidth(Math.max(24, Math.min(76, percentage)));
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.classList.remove("resizing-boards");
    };
    document.body.classList.add("resizing-boards");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  // 行操作经稳定 ref 分发；弹窗/按钮状态变化时无需重绘数百条记录。
  rowActionsRef.current = {
    select: queueRowSelect,
    toggleCheck: toggleRowChecked,
    startDrag: startRowDrag,
    endDrag: endRowDrag,
    drop: dropToLane,
    open: openRecord,
    viewField: setDetailField,
    saveQuantity: saveScheduleQuantity,
    saveProcessRemark,
    split: openSplit,
    merge: mergeSplitRow,
    complete: completeProduction,
    delete: requestDelete
  };

  return (
    <main className={`scheduler-shell ${loading && !rows.length ? "is-busy" : ""} ${maximizedLane ? `maximized maximize-${maximizedLane}` : ""}`}>
      <nav className="machine-groups" aria-label="按工序分组的机床分类">
        <button className={`all-machine ${activeMachineKey === "ALL" ? "active" : ""}`} onClick={() => changeMachine("ALL")}><span>全部机床</span><span className="status-counts"><b className="queued-count" title={`未排程 ${allStatusCounts.queued} 条`}>{allStatusCounts.queued}</b><b className="scheduled-count" title={`已排程 ${allStatusCounts.scheduled} 条`}>{allStatusCounts.scheduled}</b></span></button>
        {processGroups.map((group) => <div className="process-group" key={group.process}>
          <div className="process-name"><span>工序</span><strong>{group.name}</strong></div>
          <div className="machine-tabs">
            {group.machines.map((machine) => (
              <button key={machine.key} draggable className={`machine-tab ${machine.family ? "family-tab" : ""} ${activeMachineKey === machine.key ? "active" : ""}`} onClick={() => changeMachine(machine.key)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/machine-tab", machine.key); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveMachine(group.process, machine.key, event.dataTransfer.getData("text/machine-tab")); }} title={machine.family ? `合并显示：${machine.members.join("、")}（拖动调整顺序）` : "拖动调整本工序内机床顺序"}>
                <span>{machine.name}</span><span className="status-counts"><b className="queued-count" title={`未排程 ${machine.queuedCount} 条`}>{machine.queuedCount}</b><b className="scheduled-count" title={`已排程 ${machine.scheduledCount} 条`}>{machine.scheduledCount}</b></span>
              </button>
            ))}
          </div>
        </div>)}
      </nav>

      {notice && <div className="notice">{notice}</div>}

      <section className={`boards ${hiddenPane ? `hide-${hiddenPane}` : ""}`} ref={boardsRef} style={{ "--left-width": `${leftWidth}%` }}>
        <div className={`board unscheduled-board ${dragged ? "drop-ready" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropToLane("queued", e)}>
          <div className="board-head"><div>{maximizeButton("queued", "未排程")}<span className="dot amber" /><h2>未排程</h2><em>{unscheduled.length}</em>{selectedVisibleCount(unscheduled) > 0 && <em className="selected-count">已勾选 {selectedVisibleCount(unscheduled)}</em>}{changeMachineButton("queued", unscheduled)}{activeMachineInfo && mergeTargetMachines.length > 0 && <button className="merge-machine-trigger" onClick={openMachineMerge}>合并机床</button>}</div><div className="board-tools"><p>将任务拖至右侧开始排程</p><button className="select-visible" onClick={() => toggleSelectVisible(unscheduled)} disabled={!unscheduled.length}>{unscheduled.length && selectedVisibleCount(unscheduled) === unscheduled.length ? "取消全选" : "全选"}</button><button onClick={() => autoSort("queued")} disabled={!unscheduled.length}><span>⇅</span> 自动排序</button></div></div>
          <div className="list-table">
            <div className="list-head" style={queuedTableStyle}><SelectAllHeader key="check" total={unscheduled.filter((row) => !row.__pending).length} selectedCount={selectedVisibleCount(unscheduled)} onSelectAll={() => setLaneChecked(unscheduled, true)} onClear={() => setLaneChecked(unscheduled, false)} />{displayHeaders.map((name, index) => <FilterHeader key={orderedColumns[index].key} columnKey={orderedColumns[index].key} label={name} value={queuedFilters[fieldKeys[index]]} options={() => queuedColumnOptions(fieldKeys[index])} onChange={(value) => setColumnFilter("queued", fieldKeys[index], value)} onColumnDragStart={setDraggedColumn} onColumnDragEnd={() => setDraggedColumn(null)} onColumnDrop={moveColumn} onResize={beginColumnResize} layoutLocked={Boolean(orderedColumns[index].locked)} />)}<span className="actions-header" key="actions">操作</span></div>
            <VirtualCardList rows={unscheduled} resetKey={activeMachineKey} renderRow={(row, index) => <ScheduleCard key={row.rowid} row={row} index={index} {...cardData(row)} selected={selectedRowIdSet.has(row.rowid)} actionsRef={rowActionsRef} />} empty={!loading && <div className="empty"><strong>没有未排程任务</strong><span>当前机床暂无可排程订单</span></div>} />
          </div>
        </div>

        <div className="board-splitter" onPointerDown={beginResize} onDoubleClick={togglePanes} title={hiddenPane ? "双击还原左右两栏" : "拖动调整左右区域宽度；双击隐藏/还原左右区域"}><span /></div>

        <div className={`board scheduled-board ${dragged ? "drop-ready" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropToLane("scheduled", e)}>
          <div className="board-head"><div>{maximizeButton("scheduled", "已排程")}<span className="dot green" /><h2>已排程</h2><em>{scheduled.length}</em>{selectedVisibleCount(scheduled) > 0 && <em className="selected-count">已勾选 {selectedVisibleCount(scheduled)}</em>}{changeMachineButton("scheduled", scheduled)}</div><div className="board-tools"><p>拖动任务可自由调整优先级</p><button className="select-visible" onClick={() => toggleSelectVisible(scheduled)} disabled={!scheduled.length}>{scheduled.length && selectedVisibleCount(scheduled) === scheduled.length ? "取消全选" : "全选"}</button><button onClick={() => autoSort("scheduled")} disabled={confirmingSchedule || !scheduled.length}><span>⇅</span> 自动排序</button><button className="confirm-schedule" onClick={() => confirmSchedule()} disabled={confirmingSchedule || !scheduled.length}><span>✓</span>{confirmingSchedule ? "提交中…" : "确定排程"}</button></div></div>
          <div className="list-table">
            <div className="list-head" style={tableStyle}><SelectAllHeader key="check" total={scheduled.filter((row) => !row.__pending).length} selectedCount={selectedVisibleCount(scheduled)} onSelectAll={() => setLaneChecked(scheduled, true)} onClear={() => setLaneChecked(scheduled, false)} /><FilterHeader key="sequence" columnKey="__sequence" label="序号" value={scheduledFilters.sequence} options={() => scheduledColumnOptions("sequence")} onChange={(value) => setColumnFilter("scheduled", "sequence", value)} layoutLocked />{displayHeaders.map((name, index) => <FilterHeader key={orderedColumns[index].key} columnKey={orderedColumns[index].key} label={name} value={scheduledFilters[fieldKeys[index]]} options={() => scheduledColumnOptions(fieldKeys[index])} onChange={(value) => setColumnFilter("scheduled", fieldKeys[index], value)} onColumnDragStart={setDraggedColumn} onColumnDragEnd={() => setDraggedColumn(null)} onColumnDrop={moveColumn} onResize={beginColumnResize} layoutLocked={Boolean(orderedColumns[index].locked)} />)}<span className="actions-header" key="actions">操作</span></div>
            <VirtualCardList rows={scheduled} resetKey={activeMachineKey} renderRow={(row, index) => <ScheduleCard key={row.rowid} row={row} index={index} {...cardData(row)} scheduled selected={selectedRowIdSet.has(row.rowid)} actionsRef={rowActionsRef} />} empty={!loading && <div className="empty drop-empty"><strong>拖到这里开始排程</strong><span>任务会自动生成排程序号</span></div>} />
          </div>
        </div>
      </section>

      {splitTarget && <div className="modal-backdrop" onMouseDown={() => setSplitTarget(null)}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">调整并分拆排程量</div><p className="modal-record">{cardData(splitTarget).title}</p><label>原排程量<strong>{splitTarget.scheduleQuantity || "—"}</strong></label><label>调整后保留量<input autoFocus type="number" min="0" max={splitTarget.scheduleQuantity} value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirmSplit(); }} /></label><p className="split-hint">拆出数量：<strong>{Math.max(0, Number(splitTarget.scheduleQuantity || 0) - Number(splitAmount || 0))}</strong>，确认后调用当前视图的“分拆”按钮。</p><div className="modal-actions"><button className="secondary" onClick={() => setSplitTarget(null)}>{splitTarget.__requestedQuantity !== undefined ? "仅保留修改" : "取消"}</button><button className="primary" onClick={confirmSplit}>修改并分拆</button></div></div></div>}

      {confirmStartTime && <div className="modal-backdrop" onMouseDown={() => !confirmingSchedule && setConfirmStartTime("")}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">确定排程时间</div><p className="modal-record">将从指定时间开始，按每条任务的张/分钟和换版时间连续计算开始、结束时间。</p><label>排程开始时间<input autoFocus type="datetime-local" step="60" value={confirmStartTime} onChange={(event) => setConfirmStartTime(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirmSchedule(confirmStartTime); }} /></label><p className="split-hint">默认值为明天上午 08:00。每张机床卡片（合并卡片算一台设备）从该时间起连续计算：每条时长 = 排程量 ÷ 张/分钟 + 换版时间；缺少张/分钟的任务只计入换版时间。</p><div className="modal-actions"><button className="secondary" onClick={() => setConfirmStartTime("")} disabled={confirmingSchedule}>取消</button><button className="primary" onClick={() => confirmSchedule(confirmStartTime)} disabled={confirmingSchedule}>{confirmingSchedule ? "计算并提交中…" : "计算时间并确定排程"}</button></div></div></div>}

      {machineMergeTargetKey !== null && activeMachineInfo && activeMachineGroup && <div className="modal-backdrop" onMouseDown={() => setMachineMergeTargetKey(null)}><div className="split-modal machine-merge-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">合并机床</div><p className="modal-record">仅合并同一工序内的机床任务，工序字段不会变更。</p><label>当前工序<strong>{activeMachineGroup.name}</strong></label><label>来源机床<strong>{activeMachineInfo.name}</strong></label><label>合并到<select value={machineMergeTargetKey} onChange={(event) => setMachineMergeTargetKey(event.target.value)}>{mergeTargetMachines.map((machine) => <option key={machine.key} value={machine.key}>{machine.name}</option>)}</select></label><p className="split-hint">确认后将把“{activeMachineInfo.name}”下的 {activeMachineInfo.count} 条任务批量转移到目标机床，任务所属工序保持为“{activeMachineGroup.name}”。</p><div className="modal-actions"><button className="secondary" onClick={() => setMachineMergeTargetKey(null)}>取消</button><button className="primary" onClick={confirmMachineMerge}>确认合并</button></div></div></div>}

      {machineChange && (() => {
        const picked = rows.filter((row) => machineChange.rowIds.includes(row.rowid));
        const current = Array.from(picked.reduce((map, row) => map.set(row.machine, (map.get(row.machine) || 0) + 1), new Map()).entries());
        const options = (machinesByProcess.get(machineChange.process) || []).filter((name) => picked.some((row) => row.machine !== name));
        return <div className="modal-backdrop" onMouseDown={() => setMachineChange(null)}><div className="split-modal machine-change-modal" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-title">更换机床</div>
          <p className="modal-record">{machineChange.lane === "queued" ? "未排程" : "已排程"}中勾选的 {picked.length} 条任务</p>
          <label>工序<strong>{machineChange.process}</strong></label>
          <label>当前机床<strong className="machine-change-current">{current.map(([name, count]) => `${name}（${count}）`).join("、")}</strong></label>
          <label>更换为<select value={machineChange.target} onChange={(event) => setMachineChange((old) => ({ ...old, target: event.target.value }))}>{options.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
          <p className="split-hint">只能更换为同工序的机床；任务的工序、状态和排程顺序不变。</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setMachineChange(null)}>取消</button><button className="primary" onClick={confirmMachineChange}>确认更换</button></div>
        </div></div>;
      })()}

      {mergeTarget && (() => {
        const target = rows.find((row) => row.rowid === mergeTarget.rowid) || mergeTarget;
        const own = Number(target.scheduleQuantity) || 0;
        const picked = mergeCandidates.filter((row) => mergePicked.includes(row.rowid));
        const added = picked.reduce((sum, row) => sum + (Number(row.scheduleQuantity) || 0), 0);
        return <div className="modal-backdrop" onMouseDown={() => setMergeTarget(null)}><div className="split-modal merge-modal" onMouseDown={(event) => event.stopPropagation()}>
          <div className="modal-title">合并分拆记录</div>
          <p className="modal-record">{target.orderNo} · {target.productName}</p>
          <label>本记录排程量<strong>{own}</strong></label>
          {mergeCandidates.length ? <div className="merge-list">
            <div className="merge-list-head"><span /><span>被合并记录（机床 / 状态）</span><span>排程量</span></div>
            {mergeCandidates.map((row) => <label key={row.rowid} className="merge-item">
              <input type="checkbox" checked={mergePicked.includes(row.rowid)} onChange={() => setMergePicked((current) => current.includes(row.rowid) ? current.filter((rowId) => rowId !== row.rowid) : [...current, row.rowid])} />
              <span>{row.machine} / {row.status}</span>
              <b>{row.scheduleQuantity}</b>
            </label>)}
          </div> : <p className="danger-text">当前视图里没有找到同一生产单号、同一产品的其他记录，无法合并。</p>}
          <p className="split-hint">合并后排程量：<strong>{own} + {added} = {own + added}</strong><br />勾选的 {picked.length} 条记录合并后移入明道云回收站。</p>
          <div className="modal-actions"><button className="secondary" onClick={() => setMergeTarget(null)}>取消</button><button className="primary" onClick={confirmMergeSplit} disabled={!picked.length}>确认合并</button></div>
        </div></div>;
      })()}

      {deleteTarget && <div className="modal-backdrop" onMouseDown={() => setDeleteTarget(null)}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">确认删除</div><p className="modal-record">{cardData(deleteTarget).title}</p><p className="danger-text">确定删除这条记录吗？删除后会同步移至明道云回收站。</p><div className="modal-actions"><button className="secondary" onClick={() => setDeleteTarget(null)}>取消</button><button className="danger primary" onClick={confirmDelete}>确定删除</button></div></div></div>}

      {detailField && <div className="modal-backdrop" onMouseDown={() => setDetailField(null)}><div className="detail-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">{detailField.label}</div><div className="detail-content">{detailField.value || "—"}</div><div className="modal-actions"><button className="primary" onClick={() => setDetailField(null)}>关闭</button></div></div></div>}

      <footer><span>双击任务可打开记录详情 · 双击中间分隔线可隐藏/还原左右区域</span><span className="footer-status">{syncCount > 0 && <b className="sync-badge">正在后台保存 {syncCount} 项…</b>}{loading ? "正在加载…" : `当前显示 ${visible.filter((row) => !row.__pending).length} 条任务`}</span></footer>
    </main>
  );
}
