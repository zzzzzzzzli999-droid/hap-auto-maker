import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  changeoverMinutes: ["changeoverMinutes", "换版时间", "换版分钟", "换单时间"],
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
  quantity: ["quantity", "数量", "生产数量"],
  productionSize: ["productionSize", "生产尺寸", "产品尺寸"],
  color: ["color", "颜色", "生产颜色", "印刷颜色"],
  material: ["material", "材质", "生产材质"],
  materialNo: ["materialNo", "料号"],
  processRequirement: ["processRequirement", "工艺要求"],
  processRemark: ["processRemark", "工艺备注"],
  productionRequirement: ["productionRequirement", "生产要求"],
  scheduleSummary: ["scheduleSummary", "排程汇总表"]
};

const STATUS = { queued: "已排序", scheduled: "已排程", produced: "已生产" };
const DEFAULT_MACHINE = "联动线印刷+开槽";

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

function controlsFromConfig() {
  const info = runtimeConfig.worksheetInfo || {};
  const configured = runtimeConfig.controls || info.template && info.template.controls || info.controls || [];
  const merged = new Map();
  [...configured, ...fetchedControls].forEach((control) => {
    if (control && control.controlId) merged.set(control.controlId, { ...(merged.get(control.controlId) || {}), ...control });
  });
  return Array.from(merged.values());
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
  const aliases = FIELD_ALIASES[key];
  for (const alias of aliases) {
    const id = envControlId(alias);
    if (id) return controlsFromConfig().find((c) => c.controlId === id) || { controlId: id, controlName: alias };
  }
  return controlsFromConfig().find((control) => aliases.some((alias) =>
    alias === control.controlId || alias === control.controlName || alias === control.alias
  ));
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
    quantity: cleanText(fieldValue(row, "quantity")) || "—",
    productionSize: cleanText(fieldValue(row, "productionSize")) || "—",
    color: cleanText(fieldValue(row, "color")) || "—",
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

function sortForSchedule(rows) {
  return rows.slice().sort((a, b) => {
    const parsedDateA = a.deliveryDate && a.deliveryDate !== "—" ? new Date(a.deliveryDate).getTime() : NaN;
    const parsedDateB = b.deliveryDate && b.deliveryDate !== "—" ? new Date(b.deliveryDate).getTime() : NaN;
    const dateA = Number.isFinite(parsedDateA) ? parsedDateA : Number.MAX_SAFE_INTEGER;
    const dateB = Number.isFinite(parsedDateB) ? parsedDateB : Number.MAX_SAFE_INTEGER;
    const colorA = a.color && a.color !== "—" ? a.color : "\uffff";
    const colorB = b.color && b.color !== "—" ? b.color : "\uffff";
    const sizeA = a.productionSize && a.productionSize !== "—" ? a.productionSize : "\uffff";
    const sizeB = b.productionSize && b.productionSize !== "—" ? b.productionSize : "\uffff";
    return dateA - dateB
      || colorA.localeCompare(colorB, "zh-CN", { numeric: true, sensitivity: "base" })
      || sizeA.localeCompare(sizeB, "zh-CN", { numeric: true, sensitivity: "base" })
      || a.sequence - b.sequence;
  });
}

function calculateTimedSchedule(rows, startValue) {
  const startTime = new Date(startValue);
  if (Number.isNaN(startTime.getTime())) throw new Error("请输入有效的排程开始时间");
  const groups = new Map();
  rows.forEach((row) => {
    const key = `${row.process}::${row.machine}`;
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

const ScheduleCard = React.memo(function ScheduleCard({ row, index, selected, merging, completing, savingRemark, actionBusy, scheduled, title, fields, actionsRef }) {
  const columnWidths = fields.map((field) => `${field.width}px`);
  const actionWidth = scheduled ? 56 : 62;
  const tableMinWidth = 22 + (scheduled ? 34 : 0) + actionWidth + fields.reduce((sum, field) => sum + field.width, 0);
  const gridTemplateColumns = ["22px", ...(scheduled ? ["34px"] : []), ...columnWidths, `${actionWidth}px`].join(" ");
  return (
    <article
      className={`schedule-row ${scheduled ? "scheduled" : ""} ${selected ? "selected" : ""}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.rowid);
        const preview = document.createElement("div");
        preview.className = `row-drag-preview ${scheduled ? "scheduled-preview" : "queued-preview"}`;
        [scheduled ? "已排程" : "未排程", row.customer || "—", row.orderNo || "—", row.productName || "—"].forEach((text, previewIndex) => {
          const part = document.createElement(previewIndex === 0 ? "strong" : "span");
          part.textContent = text;
          preview.appendChild(part);
        });
        document.body.appendChild(preview);
        event.dataTransfer.setDragImage(preview, 22, 18);
        window.setTimeout(() => preview.remove(), 0);
        actionsRef.current.startDrag(row);
      }}
      onDragEnd={() => actionsRef.current.endDrag()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.stopPropagation(); actionsRef.current.drop(scheduled ? "scheduled" : "queued", event, row); }}
      onClick={(event) => actionsRef.current.select(event, row)}
      onDoubleClick={() => actionsRef.current.open(row)}
      style={{ gridTemplateColumns, "--table-min-width": `${tableMinWidth}px` }}
    >
      <div className="fixed-cell drag-grip" aria-label="拖动排序">⠿</div>
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
          return <div className="data-cell remark-cell" key={`${field.key}-${row.rowid}`}>
            <input
              type="text"
              draggable={false}
              defaultValue={field.value === "—" ? "" : field.value}
              disabled={savingRemark}
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
      <div className="action-cell"><button type="button" className="split-icon" draggable={false} disabled={actionBusy} title="分拆订单" aria-label="分拆订单" onClick={(event) => { event.stopPropagation(); actionsRef.current.split(row); }}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 10h4c3.5 0 3-5 6.5-5H17M13.5 2.5 17 5l-3.5 2.5M7 10c3.5 0 3 5 6.5 5H17M13.5 12.5 17 15l-3.5 2.5" /></svg></button>{scheduled && <button type="button" className="complete-icon" draggable={false} disabled={actionBusy || completing} title="完成生成（更新为已生产）" aria-label="完成生成" onClick={(event) => { event.stopPropagation(); actionsRef.current.complete(row); }}>✓</button>}{!scheduled && row.splitDifference > 0 && <button type="button" className="merge-icon" draggable={false} disabled={actionBusy || merging} title={`合并（分拆差量 ${row.splitDifference}）`} aria-label="合并" onClick={(event) => { event.stopPropagation(); actionsRef.current.merge(row); }}><span aria-hidden="true">⊞</span></button>}{!scheduled && <button type="button" className="delete-icon" draggable={false} disabled={actionBusy} title="删除记录" aria-label="删除记录" onClick={(event) => { event.stopPropagation(); actionsRef.current.delete(row); }}>—</button>}</div>
    </article>
  );
});

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
  const visibleOptions = options.filter((option) => String(option).toLowerCase().includes(keyword.trim().toLowerCase()));

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
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [dragged, setDragged] = useState(null);
  const [selectedRowIds, setSelectedRowIds] = useState([]);
  const [dropping, setDropping] = useState(false);
  const [leftWidth, setLeftWidth] = useState(39);
  const [splitTarget, setSplitTarget] = useState(null);
  const [splitAmount, setSplitAmount] = useState("");
  const [splitting, setSplitting] = useState(false);
  const [confirmingSchedule, setConfirmingSchedule] = useState(false);
  const [confirmStartTime, setConfirmStartTime] = useState("");
  const [mergingRowId, setMergingRowId] = useState("");
  const [machineMergeTargetKey, setMachineMergeTargetKey] = useState(null);
  const [mergingMachines, setMergingMachines] = useState(false);
  const [completingRowId, setCompletingRowId] = useState("");
  const [savingRemarkRowId, setSavingRemarkRowId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
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
      DEFAULT_COLUMNS.forEach((column) => { if (!ordered.some((item) => item.key === column.key)) ordered.push(column); });
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
  const suppressRefreshUntilRef = useRef(0);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const hasLoadedRef = useRef(false);
  const saveQueueRef = useRef(Promise.resolve());
  const dragSaveTimerRef = useRef(null);
  const pendingDragSaveRef = useRef(null);
  const pendingDragOverlayRef = useRef(new Map());
  const rowActionsRef = useRef({});
  const splitGroupRef = useRef(new Map());
  const rowPresentationCacheRef = useRef({ signature: "", entries: new Map() });

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
      let expiredRows = 0;
      const next = extractRows(response).map(normalizeRow).filter((row) => row.rowid)
        .map((row) => {
          const pending = pendingDragOverlayRef.current.get(row.rowid);
          if (!pending) return row;
          if (pending.savedAt && row.status === pending.row.status && row.process === pending.row.process
            && row.machine === pending.row.machine && Math.abs(row.sequence - pending.row.sequence) < .000001) {
            pendingDragOverlayRef.current.delete(row.rowid);
            return row;
          }
          if (pending.savedAt && Date.now() - pending.savedAt > 15000) {
            pendingDragOverlayRef.current.delete(row.rowid);
            expiredRows += 1;
            return row;
          }
          if (pending.savedAt) awaitingSavedRows = true;
          return pending.row;
        });
      setRows(next);
      setNotice(expiredRows ? `${expiredRows} 条记录未能确认保存，请检查明道云数据` : next.length ? "" : "当前视图暂无记录");
    } catch (error) {
      setRows([]);
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
  }, [appId, worksheetId, viewId, filters]);

  const scheduleRefresh = useCallback((delay = 180) => {
    window.clearTimeout(refreshTimerRef.current);
    const suppressionDelay = Math.max(0, suppressRefreshUntilRef.current - Date.now());
    refreshTimerRef.current = window.setTimeout(refresh, Math.max(delay, suppressionDelay));
  }, [refresh]);

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
      if (!groups.has(row.process)) groups.set(row.process, new Map());
      const machines = groups.get(row.process);
      const key = `${row.process}::${row.machine}`;
      const current = machines.get(key) || { key, name: row.machine, count: 0, queuedCount: 0, scheduledCount: 0, sequence: row.machineSequence };
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
    queued: rows.filter((row) => row.status.includes(STATUS.queued) || row.__demo && row.status.includes("未排程")).length,
    scheduled: rows.filter((row) => row.status.includes(STATUS.scheduled)).length
  }), [rows]);

  const activeMachineKey = useMemo(() => {
    if (activeMachine !== "DEFAULT") return activeMachine;
    const defaultMachine = processGroups.flatMap((group) => group.machines)
      .find((machine) => machine.name.includes(DEFAULT_MACHINE));
    return defaultMachine ? defaultMachine.key : "ALL";
  }, [activeMachine, processGroups]);

  const activeMachineGroup = useMemo(() => processGroups.find((group) =>
    group.machines.some((machine) => machine.key === activeMachineKey)
  ), [processGroups, activeMachineKey]);
  const activeMachineInfo = useMemo(() => activeMachineGroup && activeMachineGroup.machines.find((machine) =>
    machine.key === activeMachineKey
  ), [activeMachineGroup, activeMachineKey]);
  const mergeTargetMachines = useMemo(() => activeMachineGroup ? activeMachineGroup.machines.filter((machine) =>
    machine.key !== activeMachineKey
  ) : [], [activeMachineGroup, activeMachineKey]);

  useEffect(() => {
    const exists = processGroups.some((group) => group.machines.some((item) => item.key === activeMachineKey));
    if (activeMachine !== "DEFAULT" && activeMachineKey !== "ALL" && !exists) setActiveMachine("DEFAULT");
  }, [processGroups, activeMachine, activeMachineKey]);

  const visible = useMemo(() => rows.filter((row) => {
    const byMachine = activeMachineKey === "ALL" || `${row.process}::${row.machine}` === activeMachineKey;
    return byMachine;
  }), [rows, activeMachineKey]);

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
  const orderedColumns = columnLayout;
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
      return a.sequence - b.sequence || a.rowid.localeCompare(b.rowid);
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

  const openMachineMerge = () => {
    if (!activeMachineInfo || !mergeTargetMachines.length) return;
    setMachineMergeTargetKey(mergeTargetMachines[0].key);
  };

  const confirmMachineMerge = async () => {
    const targetMachine = mergeTargetMachines.find((machine) => machine.key === machineMergeTargetKey);
    const machineControl = resolveField("machine");
    if (!activeMachineInfo || !targetMachine || !activeMachineGroup || mergingMachines) return;
    if (!machineControl) {
      setNotice("请先在插件设置中映射机床字段");
      return;
    }
    const sourceRows = rows.filter((row) => `${row.process}::${row.machine}` === activeMachineKey && !row.__demo);
    if (!sourceRows.length) {
      setMachineMergeTargetKey(null);
      setNotice("当前机床没有可合并的真实任务");
      return;
    }
    const previousRows = rows;
    const sourceRowIds = new Set(sourceRows.map((row) => row.rowid));
    setMergingMachines(true);
    suppressRefreshUntilRef.current = Date.now() + 3000;
    window.clearTimeout(refreshTimerRef.current);
    setRows((current) => current.map((row) => sourceRowIds.has(row.rowid) ? { ...row, machine: targetMachine.name } : row));
    try {
      const requests = sourceRows.map((row) => () => updateRow({
        appId, worksheetId, viewId, rowId: row.rowid,
        newOldControl: [{
          controlId: machineControl.controlId,
          controlName: machineControl.controlName,
          type: machineControl.type,
          value: encodeValue(machineControl, targetMachine.name)
        }]
      }));
      let nextRequest = 0;
      const workerCount = Math.min(4, requests.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (nextRequest < requests.length) {
          const request = requests[nextRequest++];
          await runWhenIdle(request);
        }
      }));
      setMachineMergeTargetKey(null);
      changeMachine(targetMachine.key);
      setNotice(`已将 ${sourceRows.length} 条任务从“${activeMachineInfo.name}”合并至“${targetMachine.name}”，工序“${activeMachineGroup.name}”保持不变`);
      scheduleRefresh(600);
    } catch (error) {
      setRows(previousRows);
      setNotice(`合并机床失败：${error.message || "请检查机床字段权限"}`);
      scheduleRefresh(800);
    } finally {
      setMergingMachines(false);
    }
  };

  const toggleSelectVisible = (sourceRows) => {
    const rowIds = sourceRows.map((row) => row.rowid);
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
  const queuedColumnOptions = useMemo(() => Object.fromEntries(
    fieldKeys.map((key) => [key, filterOptions(queuedBase, key)])
  ), [fieldKeys, queuedBase, filterOptions]);
  const scheduledColumnOptions = useMemo(() => Object.fromEntries([
    ["sequence", filterOptions(scheduledBase, "sequence")],
    ...fieldKeys.map((key) => [key, filterOptions(scheduledBase, key)])
  ]), [fieldKeys, scheduledBase, filterOptions]);
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
    gridTemplateColumns: ["22px", "34px", ...orderedColumns.map((column) => `${column.width}px`), "56px"].join(" "),
    "--table-min-width": `${112 + orderedColumns.reduce((sum, column) => sum + column.width, 0)}px`
  };
  const queuedTableStyle = {
    gridTemplateColumns: ["22px", ...orderedColumns.map((column) => `${column.width}px`), "62px"].join(" "),
    "--table-min-width": `${84 + orderedColumns.reduce((sum, column) => sum + column.width, 0)}px`
  };

  const persistOrder = async (nextRows, changedIds, previousRows = rows) => {
    const statusControl = resolveField("status");
    const sequenceControl = resolveField("sequence");
    const processControl = resolveField("process");
    const machineControl = resolveField("machine");
    const startTimeControl = resolveField("scheduleStartTime");
    const endTimeControl = resolveField("scheduleEndTime");
    const changed = nextRows.filter((row) => changedIds.includes(row.rowid) && !row.__demo);
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
    setSaving(true);
    suppressRefreshUntilRef.current = Date.now() + Math.max(1800, requests.length * 180);
    try {
      window.__machineSchedulerLastOrderSave = requests;
      for (let index = 0; index < requests.length; index += 4) {
        const results = await Promise.allSettled(requests.slice(index, index + 4)
          .map((request) => runWhenIdle(() => updateRow(request.payload))));
        const failure = results.find((result) => result.status === "rejected");
        if (failure) throw failure.reason;
      }
      setNotice("排程顺序已保存");
      scheduleRefresh(350);
    } catch (error) {
      window.__machineSchedulerLastOrderError = { message: error.message, requests };
      throw new Error(error.message || "请检查排程状态和排程序号字段权限及映射");
    } finally {
      setSaving(false);
    }
  };

  const queueDragSave = (nextRows, previousRows) => {
    const pending = pendingDragSaveRef.current;
    const baselineRows = pending ? pending.previousRows : previousRows;
    const baselineById = new Map(baselineRows.map((row) => [row.rowid, row]));
    const changedIds = nextRows.filter((row) => {
      const previous = baselineById.get(row.rowid);
      return previous && (previous.status !== row.status || previous.process !== row.process || previous.machine !== row.machine || Number(previous.sequence) !== Number(row.sequence));
    }).map((row) => row.rowid);
    const changedIdSet = new Set(changedIds);
    nextRows.forEach((row) => {
      if (changedIdSet.has(row.rowid) && !row.__demo) pendingDragOverlayRef.current.set(row.rowid, { row, savedAt: 0 });
    });
    pendingDragSaveRef.current = { nextRows, previousRows: baselineRows, changedIds };
    window.clearTimeout(dragSaveTimerRef.current);
    dragSaveTimerRef.current = window.setTimeout(() => {
      const save = pendingDragSaveRef.current;
      pendingDragSaveRef.current = null;
      if (!save || !save.changedIds.length) return;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => persistOrder(save.nextRows, save.changedIds, save.previousRows))
        .then(() => {
          save.nextRows.forEach((row) => {
            const pendingRow = pendingDragOverlayRef.current.get(row.rowid);
            if (pendingRow?.row === row) pendingRow.savedAt = Date.now();
          });
        })
        .catch((error) => {
          save.nextRows.forEach((row) => {
            if (pendingDragOverlayRef.current.get(row.rowid)?.row === row) pendingDragOverlayRef.current.delete(row.rowid);
          });
          setNotice(`保存失败：${error.message || "请检查字段权限和映射"}`);
          scheduleRefresh(700);
        });
    }, 1800);
  };

  const selectRow = (event, row) => {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      setSelectedRowIds((current) => current.includes(row.rowid)
        ? current.filter((rowId) => rowId !== row.rowid)
        : [...current, row.rowid]);
      return;
    }
    setSelectedRowIds([row.rowid]);
  };

  const queueRowSelect = (event, row) => {
    if (event.ctrlKey || event.metaKey) {
      selectRow(event, row);
      return;
    }
    window.clearTimeout(rowClickTimerRef.current);
    rowClickTimerRef.current = window.setTimeout(() => setSelectedRowIds([row.rowid]), 160);
  };

  const startRowDrag = (row) => {
    const selectedIds = new Set(selectedRowIds);
    const selected = selectedIds.has(row.rowid)
      ? rows.filter((item) => selectedIds.has(item.rowid) && item.status === row.status)
      : [row];
    if (!selectedIds.has(row.rowid)) setSelectedRowIds([row.rowid]);
    dragGroupRef.current = selected;
    draggedRef.current = row;
    setDragged(row);
  };

  const endRowDrag = () => {
    dragGroupRef.current = [];
    draggedRef.current = null;
    setDragged(null);
  };

  const dropToLane = async (lane, event, targetRow = null) => {
    event.preventDefault();
    event.stopPropagation();
    if (dropping) return;
    const draggedRowId = event.dataTransfer && event.dataTransfer.getData("text/plain");
    const source = draggedRef.current || dragged || rows.find((row) => row.rowid === draggedRowId);
    if (!source) return;
    const movingRows = (dragGroupRef.current.length ? dragGroupRef.current : [source])
      .filter((row, index, list) => list.findIndex((item) => item.rowid === row.rowid) === index);
    const movingIds = new Set(movingRows.map((row) => row.rowid));
    if (targetRow && movingIds.has(targetRow.rowid)) { endRowDrag(); return; }
    setDropping(true);
    const activeParts = activeMachineKey === "ALL" ? [] : activeMachineKey.split("::");
    const targetMachine = activeParts[1] || source.machine;
    const targetProcess = activeParts[0] || source.process;
    const targetStatus = lane === "scheduled" ? STATUS.scheduled : STATUS.queued;
    const destinationBase = (lane === "scheduled" ? scheduledBase : queuedBase).filter((row) => !movingIds.has(row.rowid));
    let targetIndex = targetRow ? destinationBase.findIndex((row) => row.rowid === targetRow.rowid) : destinationBase.length;
    if (targetIndex < 0) targetIndex = destinationBase.length;
    let movedRows = movingRows.map((row) => ({ ...row, process: targetProcess, machine: targetMachine, status: targetStatus }));
    if (lane === "scheduled") {
      const previousRow = destinationBase[targetIndex - 1];
      const nextRow = destinationBase[targetIndex];
      const previousSequence = previousRow ? Number(previousRow.sequence) : null;
      const nextSequence = nextRow ? Number(nextRow.sequence) : null;
      const gap = previousSequence != null && nextSequence != null ? nextSequence - previousSequence : null;
      const step = previousSequence != null && nextSequence != null
        ? gap > 0 ? gap / (movedRows.length + 1) : 0.001
        : previousSequence != null ? 1 : nextSequence != null ? -1 : 1;
      const start = previousSequence != null ? previousSequence : nextSequence != null ? nextSequence - step * (movedRows.length + 1) : 0;
      movedRows = movedRows.map((row, index) => ({ ...row, sequence: start + step * (index + 1) }));
    } else {
      movedRows = movedRows.map((row) => ({ ...row, sequence: 0 }));
    }
    const updateMap = new Map(movedRows.map((row) => [row.rowid, row]));
    const nextRows = rows.map((row) => updateMap.get(row.rowid) || row);
    setRows(nextRows);
    setSelectedRowIds(movedRows.map((row) => row.rowid));
    dragGroupRef.current = [];
    draggedRef.current = null;
    setDragged(null);
    setDropping(false);
    queueDragSave(nextRows, rows);
  };

  const openRecord = (row) => {
    window.clearTimeout(rowClickTimerRef.current);
    if (row.__demo || !mdyeUtils || typeof mdyeUtils.openRecordInfo !== "function") return;
    mdyeUtils.openRecordInfo({ appId, worksheetId, viewId, recordId: row.rowid }).then(refresh);
  };

  const saveScheduleQuantity = async (row, rawValue) => {
    if (!scheduleQuantityControl || row.__demo) return;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0 || value === row.scheduleQuantity) return;
    const original = Number(row.scheduleQuantity) || 0;
    suppressRefreshUntilRef.current = Date.now() + 1200;
    try {
      await updateRow({
        appId, worksheetId, viewId, rowId: row.rowid,
        newOldControl: [{
          controlId: scheduleQuantityControl.controlId,
          controlName: scheduleQuantityControl.controlName,
          type: scheduleQuantityControl.type,
          value: encodeValue(scheduleQuantityControl, value)
        }]
      });
      setRows((old) => old.map((item) => item.rowid === row.rowid ? { ...item, scheduleQuantity: value } : item));
      setNotice("排程量已保存");
      if (original > 0 && value < original) {
        setSplitTarget({ ...row, scheduleQuantity: original, __requestedQuantity: value });
        setSplitAmount(String(value));
      }
    } catch (error) {
      setNotice(`排程量保存失败：${error.message || "请检查字段权限"}`);
      scheduleRefresh(350);
    }
  };

  const saveProcessRemark = async (row, value) => {
    const currentValue = row.processRemark === "—" ? "" : row.processRemark;
    if (value === currentValue || savingRemarkRowId || !processRemarkControl || row.__demo) return;
    setSavingRemarkRowId(row.rowid);
    try {
      await updateRow({
        appId, worksheetId, viewId, rowId: row.rowid,
        newOldControl: [{
          controlId: processRemarkControl.controlId,
          controlName: processRemarkControl.controlName,
          type: processRemarkControl.type,
          value: encodeValue(processRemarkControl, value)
        }]
      });
      setRows((current) => current.map((item) => item.rowid === row.rowid ? { ...item, processRemark: value || "—" } : item));
      setNotice("工艺备注已保存");
    } catch (error) {
      setNotice(`工艺备注保存失败：${error.message || "请检查字段权限"}`);
      scheduleRefresh(350);
    } finally {
      setSavingRemarkRowId("");
    }
  };

  const openSplit = (row) => {
    setSplitTarget(row);
    setSplitAmount(row.scheduleQuantity > 0 ? String(Math.max(0, row.scheduleQuantity - 1)) : "");
  };

  const confirmSplit = async () => {
    if (!splitTarget || splitting) return;
    const retainedAmount = Number(splitAmount);
    const originalAmount = Number(splitTarget.scheduleQuantity) || 0;
    if (!Number.isFinite(retainedAmount) || retainedAmount < 0) {
      setNotice("请输入不小于 0 的调整后排程量");
      return;
    }
    if (originalAmount <= 0 || retainedAmount >= originalAmount) {
      setNotice("调整后排程量必须小于当前排程量");
      return;
    }
    const splitQuantity = originalAmount - retainedAmount;
    setSplitting(true);
    suppressRefreshUntilRef.current = Date.now() + 3000;
    window.clearTimeout(refreshTimerRef.current);
    try {
      if (scheduleQuantityControl) await updateRow({
        appId, worksheetId, viewId, rowId: splitTarget.rowid,
        newOldControl: [{ controlId: scheduleQuantityControl.controlId, controlName: scheduleQuantityControl.controlName, type: scheduleQuantityControl.type, value: encodeValue(scheduleQuantityControl, retainedAmount) }]
      });
      const button = await findWorksheetButton("分拆", { appId, worksheetId, viewId, rowId: splitTarget.rowid });
      const btnId = button && button.btnId;
      if (!btnId) throw new Error("当前视图未找到“分拆”自定义按钮");
      const payload = compact({ appId: worksheetId, sources: [splitTarget.rowid], triggerId: btnId, pushUniqueId: getPushUniqueId(), viewId, isAll: false, dataLog: `原排程量：${originalAmount}；保留排程量：${retainedAmount}；拆出数量：${splitQuantity}` });
      window.__machineSchedulerLastSplitAction = { button, payload };
      await startProcess(payload);
      splitGroupRef.current.set(splitTarget.rowid, `${splitTarget.process}|${splitTarget.machine}|${splitTarget.orderNo}|${splitTarget.productCode}|${splitTarget.productName}`);
      setRows((current) => current.map((row) => row.rowid === splitTarget.rowid
        ? { ...row, scheduleQuantity: retainedAmount }
        : row));
      setNotice(`已提交分拆：保留 ${retainedAmount}，拆出 ${splitQuantity}`);
      setSplitTarget(null);
      scheduleRefresh(1600);
    } catch (error) {
      setNotice(`分拆失败：${error.message || "请检查自定义按钮配置"}`);
    } finally {
      setSplitting(false);
    }
  };

  const completeProduction = async (row) => {
    if (completingRowId || row.status.includes(STATUS.produced)) return;
    const statusControl = resolveField("status");
    if (!row.__demo && !statusControl) {
      setNotice("请先在插件设置中映射排程状态字段");
      return;
    }
    setCompletingRowId(row.rowid);
    suppressRefreshUntilRef.current = Date.now() + 1200;
    try {
      if (!row.__demo) await updateRow({
        appId, worksheetId, viewId, rowId: row.rowid,
        newOldControl: [{
          controlId: statusControl.controlId,
          controlName: statusControl.controlName,
          type: statusControl.type,
          value: encodeValue(statusControl, STATUS.produced)
        }]
      });
      setRows((current) => current.map((item) => item.rowid === row.rowid ? { ...item, status: STATUS.produced } : item));
      setSelectedRowIds((current) => current.filter((rowId) => rowId !== row.rowid));
      setNotice("已更新为已生产");
      scheduleRefresh(350);
    } catch (error) {
      setNotice(`完成生成失败：${error.message || "请检查排程状态字段权限"}`);
    } finally {
      setCompletingRowId("");
    }
  };

  const requestDelete = (row) => {
    if (row.__demo) {
      setNotice("示例记录不能删除");
      return;
    }
    setDeleteTarget(row);
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    suppressRefreshUntilRef.current = Date.now() + 1600;
    window.clearTimeout(refreshTimerRef.current);
    setRows((current) => current.filter((row) => row.rowid !== target.rowid));
    setSelectedRowIds((current) => current.filter((rowId) => rowId !== target.rowid));
    setNotice("记录已移至回收站");
    runWhenIdle(() => deleteWorksheetRows({ appId, worksheetId, viewId, rowIds: [target.rowid] }))
      .then(() => scheduleRefresh(900))
      .catch((error) => {
        setRows((current) => current.some((row) => row.rowid === target.rowid) ? current : [...current, target]);
        setNotice(`删除失败，记录已恢复：${error.message || "请检查删除权限"}`);
      });
  };

  const confirmSchedule = async (startTimeValue) => {
    if (confirmingSchedule || saving || dropping || !scheduled.length) return;
    if (!startTimeValue) {
      setConfirmStartTime(defaultScheduleStartValue());
      return;
    }
    // “确定排程”始终针对当前右侧已排程区域经过机床和字段筛选后实际显示的全部记录。
    const realTargets = scheduled.filter((row) => !row.__demo);
    if (!realTargets.length) {
      setNotice("当前没有可确定排程的真实记录");
      return;
    }
    setConfirmingSchedule(true);
    try {
      const sorted = await autoSort("scheduled", startTimeValue, true);
      if (!sorted) return;
      const firstRowId = realTargets[0].rowid;
      const button = await findWorksheetButton("确定排程", { appId, worksheetId, viewId, rowId: firstRowId });
      const btnId = button && button.btnId;
      if (!btnId) throw new Error("当前视图未找到“确定排程”自定义按钮");
      const rowIds = realTargets.map((row) => row.rowid);
      const payload = compact({
        appId: worksheetId, sources: rowIds, triggerId: btnId,
        pushUniqueId: getPushUniqueId(), viewId, isAll: false,
        dataLog: `机床排程工作台确定当前页面已排程记录，共 ${rowIds.length} 条`
      });
      window.__machineSchedulerLastConfirmAction = { button, payload };
      await startProcess(payload);
      setConfirmStartTime("");
      setNotice(`已对当前页面显示的 ${rowIds.length} 条已排程记录触发确定排程`);
      setSelectedRowIds([]);
      window.setTimeout(refresh, 1000);
    } catch (error) {
      setNotice(`确定排程失败：${error.message || "请检查自定义按钮配置"}`);
    } finally {
      setConfirmingSchedule(false);
    }
  };

  const mergeSplitRow = async (row) => {
    if (mergingRowId || row.__demo || Number(row.splitDifference) <= 0) return;
    setMergingRowId(row.rowid);
    suppressRefreshUntilRef.current = Date.now() + 3000;
    window.clearTimeout(refreshTimerRef.current);
    try {
      const button = await findWorksheetButton("合并", { appId, worksheetId, viewId, rowId: row.rowid });
      const btnId = button && button.btnId;
      if (!btnId) throw new Error("当前视图未找到“合并”自定义按钮");
      const payload = compact({
        appId: worksheetId, sources: [row.rowid], triggerId: btnId,
        pushUniqueId: getPushUniqueId(), viewId, isAll: false,
        dataLog: `机床排程工作台执行合并，分拆差量：${row.splitDifference}`
      });
      window.__machineSchedulerLastMergeAction = { button, payload };
      await startProcess(payload);
      setNotice(`已提交合并，分拆差量 ${row.splitDifference}`);
      scheduleRefresh(1600);
    } catch (error) {
      setNotice(`合并失败：${error.message || "请检查合并按钮和工作流配置"}`);
    } finally {
      setMergingRowId("");
    }
  };

  const autoSort = async (lane = "scheduled", startTimeValue = defaultScheduleStartValue(), quiet = false) => {
    const sourceRows = lane === "scheduled" ? scheduledBase : queuedBase;
    if (saving || dropping || !sourceRows.length) return false;
    let updates;
    let missingRateCount;
    try {
      ({ updates, missingRateCount } = calculateTimedSchedule(sourceRows, startTimeValue));
    } catch (error) {
      setNotice(error.message || "排程开始时间无效");
      return false;
    }
    const updateMap = new Map(updates.map((row) => [row.rowid, row]));
    const nextRows = rows.map((row) => updateMap.get(row.rowid) || row);
    const changedIds = updates.filter((row) => {
      const previous = rows.find((item) => item.rowid === row.rowid);
      return previous && (Number(previous.sequence) !== Number(row.sequence)
        || previous.scheduleStartTime !== row.scheduleStartTime
        || previous.scheduleEndTime !== row.scheduleEndTime);
    }).map((row) => row.rowid);
    setRows(nextRows);
    if (!quiet) setNotice(`已按日期、颜色、尺寸自动排序，并从 ${formatScheduleTime(startTimeValue)} 计算排程时间${missingRateCount ? `；${missingRateCount} 条缺少张/分钟，仅计换版时间` : ""}`);
    try {
      await persistOrder(nextRows, changedIds, rows);
      return true;
    } catch (error) {
      setRows(rows);
      setNotice(`自动排序保存失败：${error.message || "请检查排程序号字段权限和映射"}`);
      window.setTimeout(refresh, 1000);
      return false;
    }
  };

  const beginResize = (event) => {
    event.preventDefault();
    const element = boardsRef.current;
    if (!element) return;
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
    <main className={`scheduler-shell ${loading || saving || dropping || splitting || confirmingSchedule || mergingMachines || Boolean(mergingRowId) || Boolean(completingRowId) || Boolean(savingRemarkRowId) ? "is-busy" : ""}`}>
      <nav className="machine-groups" aria-label="按工序分组的机床分类">
        <button className={`all-machine ${activeMachineKey === "ALL" ? "active" : ""}`} onClick={() => changeMachine("ALL")}><span>全部机床</span><span className="status-counts"><b className="queued-count" title={`未排程 ${allStatusCounts.queued} 条`}>{allStatusCounts.queued}</b><b className="scheduled-count" title={`已排程 ${allStatusCounts.scheduled} 条`}>{allStatusCounts.scheduled}</b></span></button>
        {processGroups.map((group) => <div className="process-group" key={group.process}>
          <div className="process-name"><span>工序</span><strong>{group.name}</strong></div>
          <div className="machine-tabs">
            {group.machines.map((machine) => (
              <button key={machine.key} draggable className={`machine-tab ${activeMachineKey === machine.key ? "active" : ""}`} onClick={() => changeMachine(machine.key)} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/machine-tab", machine.key); }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); event.stopPropagation(); moveMachine(group.process, machine.key, event.dataTransfer.getData("text/machine-tab")); }} title="拖动调整本工序内机床顺序">
                <span>{machine.name}</span><span className="status-counts"><b className="queued-count" title={`未排程 ${machine.queuedCount} 条`}>{machine.queuedCount}</b><b className="scheduled-count" title={`已排程 ${machine.scheduledCount} 条`}>{machine.scheduledCount}</b></span>
              </button>
            ))}
          </div>
        </div>)}
      </nav>

      {notice && <div className="notice">{notice}</div>}

      <section className="boards" ref={boardsRef} style={{ "--left-width": `${leftWidth}%` }}>
        <div className={`board unscheduled-board ${dragged ? "drop-ready" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropToLane("queued", e)}>
          <div className="board-head"><div><span className="dot amber" /><h2>未排程</h2><em>{unscheduled.length}</em>{activeMachineInfo && mergeTargetMachines.length > 0 && <button className="merge-machine-trigger" onClick={openMachineMerge} disabled={mergingMachines}>合并机床</button>}</div><div className="board-tools"><p>将任务拖至右侧开始排程</p><button className="select-visible" onClick={() => toggleSelectVisible(unscheduled)} disabled={!unscheduled.length}>{selectedVisibleCount(unscheduled) === unscheduled.length ? "取消全选" : "全选"}</button><button onClick={() => autoSort("queued")} disabled={saving || dropping || !unscheduled.length}><span>⇅</span> 自动排序</button></div></div>
          <div className="list-table">
            <div className="list-head" style={queuedTableStyle}><span key="drag" />{displayHeaders.map((name, index) => <FilterHeader key={orderedColumns[index].key} columnKey={orderedColumns[index].key} label={name} value={queuedFilters[fieldKeys[index]]} options={queuedColumnOptions[fieldKeys[index]] || []} onChange={(value) => setColumnFilter("queued", fieldKeys[index], value)} onColumnDragStart={setDraggedColumn} onColumnDragEnd={() => setDraggedColumn(null)} onColumnDrop={moveColumn} onResize={beginColumnResize} />)}<span className="actions-header" key="actions">操作</span></div>
            <VirtualCardList rows={unscheduled} resetKey={activeMachineKey} renderRow={(row, index) => <ScheduleCard key={row.rowid} row={row} index={index} {...cardData(row)} selected={selectedRowIdSet.has(row.rowid)} merging={mergingRowId === row.rowid} savingRemark={savingRemarkRowId === row.rowid} actionBusy={splitting || Boolean(mergingRowId) || Boolean(completingRowId) || confirmingSchedule} actionsRef={rowActionsRef} />} empty={!loading && <div className="empty"><strong>没有未排程任务</strong><span>当前机床暂无可排程订单</span></div>} />
          </div>
        </div>

        <div className="board-splitter" onPointerDown={beginResize} title="拖动调整左右区域宽度"><span /></div>

        <div className={`board scheduled-board ${dragged ? "drop-ready" : ""}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => dropToLane("scheduled", e)}>
          <div className="board-head"><div><span className="dot green" /><h2>已排程</h2><em>{scheduled.length}</em></div><div className="board-tools"><p>{saving ? "正在保存顺序…" : "拖动任务可自由调整优先级"}</p><button className="select-visible" onClick={() => toggleSelectVisible(scheduled)} disabled={!scheduled.length}>{selectedVisibleCount(scheduled) === scheduled.length ? "取消全选" : "全选"}</button><button onClick={() => autoSort("scheduled")} disabled={saving || dropping || confirmingSchedule || !scheduled.length}><span>⇅</span> 自动排序</button><button className="confirm-schedule" onClick={() => confirmSchedule()} disabled={saving || dropping || confirmingSchedule || !scheduled.length}><span>✓</span>{confirmingSchedule ? "提交中…" : "确定排程"}</button></div></div>
          <div className="list-table">
            <div className="list-head" style={tableStyle}><span key="drag" /><FilterHeader key="sequence" columnKey="__sequence" label="序号" value={scheduledFilters.sequence} options={scheduledColumnOptions.sequence || []} onChange={(value) => setColumnFilter("scheduled", "sequence", value)} layoutLocked />{displayHeaders.map((name, index) => <FilterHeader key={orderedColumns[index].key} columnKey={orderedColumns[index].key} label={name} value={scheduledFilters[fieldKeys[index]]} options={scheduledColumnOptions[fieldKeys[index]] || []} onChange={(value) => setColumnFilter("scheduled", fieldKeys[index], value)} onColumnDragStart={setDraggedColumn} onColumnDragEnd={() => setDraggedColumn(null)} onColumnDrop={moveColumn} onResize={beginColumnResize} />)}<span className="actions-header" key="actions">操作</span></div>
            <VirtualCardList rows={scheduled} resetKey={activeMachineKey} renderRow={(row, index) => <ScheduleCard key={row.rowid} row={row} index={index} {...cardData(row)} scheduled selected={selectedRowIdSet.has(row.rowid)} completing={completingRowId === row.rowid} savingRemark={savingRemarkRowId === row.rowid} actionBusy={splitting || Boolean(mergingRowId) || Boolean(completingRowId) || confirmingSchedule} actionsRef={rowActionsRef} />} empty={!loading && <div className="empty drop-empty"><strong>拖到这里开始排程</strong><span>任务会自动生成排程序号</span></div>} />
          </div>
        </div>
      </section>

      {splitTarget && <div className="modal-backdrop" onMouseDown={() => !splitting && setSplitTarget(null)}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">调整并分拆排程量</div><p className="modal-record">{cardData(splitTarget).title}</p><label>原排程量<strong>{splitTarget.scheduleQuantity || "—"}</strong></label><label>调整后保留量<input autoFocus type="number" min="0" max={splitTarget.scheduleQuantity} value={splitAmount} onChange={(event) => setSplitAmount(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirmSplit(); }} /></label><p className="split-hint">拆出数量：<strong>{Math.max(0, Number(splitTarget.scheduleQuantity || 0) - Number(splitAmount || 0))}</strong>，确认后调用当前视图的“分拆”按钮。</p><div className="modal-actions"><button className="secondary" onClick={() => setSplitTarget(null)} disabled={splitting}>{splitTarget.__requestedQuantity !== undefined ? "仅保留修改" : "取消"}</button><button className="primary" onClick={confirmSplit} disabled={splitting}>{splitting ? "处理中…" : "修改并分拆"}</button></div></div></div>}

      {confirmStartTime && <div className="modal-backdrop" onMouseDown={() => !confirmingSchedule && setConfirmStartTime("")}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">确定排程时间</div><p className="modal-record">将从指定时间开始，按每条任务的张/分钟和换版时间连续计算开始、结束时间。</p><label>排程开始时间<input autoFocus type="datetime-local" step="60" value={confirmStartTime} onChange={(event) => setConfirmStartTime(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") confirmSchedule(confirmStartTime); }} /></label><p className="split-hint">默认值为明天上午 08:00。不同机床会分别从该时间开始计算；缺少张/分钟的任务只计入换版时间。</p><div className="modal-actions"><button className="secondary" onClick={() => setConfirmStartTime("")} disabled={confirmingSchedule}>取消</button><button className="primary" onClick={() => confirmSchedule(confirmStartTime)} disabled={confirmingSchedule}>{confirmingSchedule ? "计算并提交中…" : "计算时间并确定排程"}</button></div></div></div>}

      {machineMergeTargetKey !== null && activeMachineInfo && activeMachineGroup && <div className="modal-backdrop" onMouseDown={() => !mergingMachines && setMachineMergeTargetKey(null)}><div className="split-modal machine-merge-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">合并机床</div><p className="modal-record">仅合并同一工序内的机床任务，工序字段不会变更。</p><label>当前工序<strong>{activeMachineGroup.name}</strong></label><label>来源机床<strong>{activeMachineInfo.name}</strong></label><label>合并到<select value={machineMergeTargetKey} onChange={(event) => setMachineMergeTargetKey(event.target.value)} disabled={mergingMachines}>{mergeTargetMachines.map((machine) => <option key={machine.key} value={machine.key}>{machine.name}</option>)}</select></label><p className="split-hint">确认后将把“{activeMachineInfo.name}”下的 {activeMachineInfo.count} 条任务批量转移到目标机床，任务所属工序保持为“{activeMachineGroup.name}”。</p><div className="modal-actions"><button className="secondary" onClick={() => setMachineMergeTargetKey(null)} disabled={mergingMachines}>取消</button><button className="primary" onClick={confirmMachineMerge} disabled={mergingMachines}>{mergingMachines ? "合并中…" : "确认合并"}</button></div></div></div>}

      {deleteTarget && <div className="modal-backdrop" onMouseDown={() => setDeleteTarget(null)}><div className="split-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">确认删除</div><p className="modal-record">{cardData(deleteTarget).title}</p><p className="danger-text">确定删除这条记录吗？删除后会同步移至明道云回收站。</p><div className="modal-actions"><button className="secondary" onClick={() => setDeleteTarget(null)}>取消</button><button className="danger primary" onClick={confirmDelete}>确定删除</button></div></div></div>}

      {detailField && <div className="modal-backdrop" onMouseDown={() => setDetailField(null)}><div className="detail-modal" onMouseDown={(event) => event.stopPropagation()}><div className="modal-title">{detailField.label}</div><div className="detail-content">{detailField.value || "—"}</div><div className="modal-actions"><button className="primary" onClick={() => setDetailField(null)}>关闭</button></div></div></div>}

      <footer><span>双击任务可打开记录详情</span><span>{loading ? "正在加载…" : `当前显示 ${visible.length} 条任务`}</span></footer>
    </main>
  );
}
