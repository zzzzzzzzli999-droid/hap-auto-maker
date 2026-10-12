import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, apis, config, env, md_emitter } from "mdye";
import styled from "styled-components";

const runtimeApi = api || {};
const worksheetApi = apis?.worksheet || {};
const processApi = apis?.process || {};
const runtimeConfig = config || {};
const runtimeEnv = env || {};
const runtimeEmitter = md_emitter || {};

const CONFIRM_LOADING_BUTTON_NAME = "确认装车";
const SUPPLEMENT_LOADING_BUTTON_NAME = "补装车";
const CONFIRM_LOADING_BUTTON_ALIASES = ["确认装车", "装载", "确认装载", "开始装载"];
const SUPPLEMENT_LOADING_BUTTON_ALIASES = ["补装车", "补装", "确认补装"];
const SUPPLEMENT_ORDER_FIELD_NAMES = ["请选择补装车的单号", "选择补装车的单号", "补装车单号", "补装单号"];
// Live worksheet schema (68bfd2878223fdc4575106b7): “请选择补装车的单号”.
// This must remain the real control ID used when the runtime does not return
// the field template with a row detail request.
const SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID = "69fdfb37f41e1e008c8b94a5";
const SUPPLEMENT_ORDER_REVERSE_CONTROL_ID = "69fdfb37f41e1e008c8b94a4";
const LOADING_ORDER_NO_FIELD_NAMES = ["装车单号", "装车编号", "单号", "编号"];
const LOADING_STATUS_FIELD_NAMES = ["状态", "装车状态", "送货状态"];
const SUPPLEMENT_ORDER_STATUS_TEXTS = ["装车未送", "已送未回"];
const SUPPLEMENT_ORDER_STATUS_LABEL = SUPPLEMENT_ORDER_STATUS_TEXTS.join("、");
const RETURN_PLAN_BUTTON_ALIASES = ["退回计划"];
const RETURN_PLAN_APP_ID = "bc95b483-fa07-469a-9bdc-d5741494280b";
const RETURN_PLAN_WORKSHEET_ID = "6a24c033b6274becb18d68cd";
const RETURN_PLAN_VIEW_ID = "6a24c033b6274becb18d69d6";
const PRODUCTION_STATUS_FIELD_NAMES = ["生产状态", "生产进度", "生产情况", "工单状态"];
const WORK_ORDER_FIELD_NAMES = ["生产工单", "生产工单号", "工单", "工单号"];
const DETAIL_BACKGROUND_HYDRATE_LIMIT = 80;
const DETAIL_HYDRATE_CONCURRENCY = 6;
const RELATION_FETCH_PAGE_SIZE = 500;
const RELATION_FIRST_PAINT_PAGE_SIZE = 80;
const RELATION_BACKGROUND_DELAY = 250;
// Supplement selection must open promptly even when the loading worksheet has
// thousands of records. The first usable page is enough for initial choice;
// filtering narrows that page without blocking the rest of the view.
const SUPPLEMENT_FETCH_PAGE_SIZE = 50;
const ORIGINAL_WORKSHEET_ID = "68bfd2878223fdc4575106b7";
const ORIGINAL_DETAIL_RELATION_CONTROL_ID = "69da5981341ced4fdcf27ce4";
// This plugin is built for 呼市中士达ERP / 送货明细. These IDs were read from
// the live worksheet schema. Child-row fields cannot be mapped reliably by
// params-config because those settings belong to the host view worksheet.
const DELIVERY_DETAIL_WORKSHEET_ID = "6a24c033b6274becb18d68cd";
const DELIVERY_DETAIL_FIELD_IDS = Object.freeze({
  loadedQty: "6776593ce86abfdddb7904dc",
  convertedVolume: "68835959b32711b754eb9ab0",
  unitArea: "69d8550dab5a7577bef739c2",
  checked: "69da6289f7066f665c470856",
  convertedArea: "6a4cb45718106fdb136c34a3",
  giftQty: "6a618e1869025bfb932d7d4f",
  loadedArea: "6aa2cf1f511361c488aeb156",
  loadingUser: "6aa41d644a300a9aee47c40d",
});
const DELIVERY_DETAIL_FIELD_TYPES = Object.freeze({
  loadedQty: 6,
  convertedVolume: 30,
  unitArea: 30,
  checked: 36,
  convertedArea: 30,
  giftQty: 6,
  loadedArea: 31,
  loadingUser: 26,
});
const SUPPLEMENT_OPTIONS_CACHE_TTL = 30000;
// Keep a stale snapshot long enough to make returning to the view instant.
// Runtime events and the normal background validation still refresh it.
const PAGE_SWITCH_CACHE_TTL = 5 * 60 * 1000;
const PAGE_SWITCH_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const worksheetInfoCache = new Map();
const worksheetControlsCache = new Map();
const supplementOptionsCache = new Map();
const pageSwitchCache = new Map();

function getStringHash(value) {
  let hash = 5381;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function getPageSwitchCacheKey({ worksheetId, viewId, recordRowId, filters }) {
  let filterText = "";
  try {
    filterText = JSON.stringify(normalizeSystemFilters(filters));
  } catch (error) {
    filterText = "";
  }
  return `delivery-loading-page-cache-v2:${worksheetId || "worksheet"}:${viewId || "view"}:${recordRowId || "list"}:${getStringHash(filterText)}`;
}

function getLatestPageSwitchCacheKey({ worksheetId, viewId, recordRowId }) {
  return `delivery-loading-page-cache-v2:${worksheetId || "worksheet"}:${viewId || "view"}:${recordRowId || "list"}:latest`;
}

function readPageSwitchCache(cacheKey) {
  const now = Date.now();
  const memoryValue = pageSwitchCache.get(cacheKey);
  if (memoryValue?.expiresAt > now) return memoryValue.snapshot;
  pageSwitchCache.delete(cacheKey);

  if (typeof window === "undefined" || !window.sessionStorage) return null;
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(cacheKey) || "null");
    if (saved?.expiresAt > now && saved.snapshot) {
      pageSwitchCache.set(cacheKey, saved);
      return saved.snapshot;
    }
    window.sessionStorage.removeItem(cacheKey);
  } catch (error) {
    // Storage is only an acceleration layer; a failed read must not affect use.
  }
  return null;
}

function writePageSwitchCache(cacheKey, snapshot) {
  const entry = { expiresAt: Date.now() + PAGE_SWITCH_CACHE_TTL, snapshot };
  pageSwitchCache.set(cacheKey, entry);

  if (typeof window === "undefined" || !window.sessionStorage) return;
  try {
    const serialized = JSON.stringify(entry);
    if (serialized.length <= PAGE_SWITCH_CACHE_MAX_BYTES) {
      window.sessionStorage.setItem(cacheKey, serialized);
    }
  } catch (error) {
    // Large datasets may exceed browser storage. Keep the in-memory cache only.
  }
}
function getLiveRuntimeEnv() {
  return {
    ...(runtimeEnv || {}),
    ...(runtimeConfig?.env || {}),
    ...((typeof window !== "undefined" && window.config?.env) || {}),
    ...((typeof window !== "undefined" && window.env) || {}),
  };
}

function getWindowApiMethod(moduleName, methodName) {
  if (typeof window === "undefined" || !window.api?.call) {
    return null;
  }
  return (params) => window.api.call(moduleName, methodName, params);
}

function getWorksheetApiMethod(methodName) {
  return runtimeApi[methodName] || worksheetApi[methodName] || getWindowApiMethod("worksheet", methodName);
}

function getProcessApiMethod(methodName) {
  return processApi[methodName] || runtimeApi[methodName] || getWindowApiMethod("process", methodName);
}

function getPushUniqueId() {
  if (typeof window === "undefined") return "";
  return window.md?.global?.Config?.pushUniqueId || window.md?.global?.Config?.PushUniqueId || "";
}

function buildControlValue(controlId, value, type, controlName = "") {
  const nextValue = value === null || value === undefined ? "" : String(value);
  return {
    controlId,
    ...(controlName ? { controlName } : {}),
    ...(type ? { type } : {}),
    value: nextValue,
    controlValue: nextValue,
    editType: 0,
  };
}

function buildNumberControlValue(controlId, value, type) {
  return buildControlValue(controlId, Number(value) || 0, type);
}

function buildClearControlValue(controlId, type) {
  return buildControlValue(controlId, "", type);
}

function buildCheckboxControlValue(controlId, checked, type) {
  return buildControlValue(controlId, checked ? "1" : "0", type);
}

function buildCheckedControlValue(controlId, checked, type) {
  const numericType = Number(type);
  if (numericType === 36) {
    return buildControlValue(controlId, checked ? "1" : "0", type);
  }
  if ([6, 8, 28].includes(numericType)) {
    return buildControlValue(controlId, checked ? "1" : "0", type);
  }
  return buildControlValue(controlId, checked ? "是" : "", type);
}

// 性能：表格每渲染一个格子都会经 isRowLoadedByAnotherAccount 调到这里。运行时没有
// 直接给出姓名时，getRuntimeContextValue 会递归遍历整个运行时配置（含字段模板）
// 并逐个尝试 JSON.parse，一次几十毫秒，乘以格子数就是勾选时的明显卡顿。
// 同一个插件页面里登录账号不会变：拿到 accountId 后永久复用；拿不到时 2 秒内复用。
let currentAccountInfoCache = null;
let currentAccountInfoCachedAt = 0;
function getCurrentAccountInfo() {
  const now = Date.now();
  if (
    currentAccountInfoCache &&
    (currentAccountInfoCache.accountId || now - currentAccountInfoCachedAt < 2000)
  ) {
    return currentAccountInfoCache;
  }
  currentAccountInfoCache = Object.freeze(readCurrentAccountInfo());
  currentAccountInfoCachedAt = now;
  return currentAccountInfoCache;
}

function readCurrentAccountInfo() {
  const browserContext = typeof window !== "undefined" ? window : {};
  // Mingdao keeps the signed-in organisation member in one of these runtime
  // objects.  Prefer that member object over generic config values, because a
  // config payload may also contain record owners or other account IDs.
  const memberCandidates = [
    browserContext.md?.global?.Account,
    browserContext.md?.global?.account,
    browserContext.md?.global?.User,
    browserContext.md?.global?.user,
    runtimeConfig?.currentAccount,
    runtimeConfig?.account,
    runtimeConfig?.user,
    browserContext.config?.currentAccount,
    browserContext.config?.account,
    browserContext.config?.user,
  ].filter((item) => item && typeof item === "object");
  const globalAccount =
    memberCandidates.find((item) => item.accountId || item.accountID || item.userId || item.id) ||
    {};
  const accountId =
    globalAccount.accountId ||
    globalAccount.accountID ||
    globalAccount.userId ||
    globalAccount.id ||
    getRuntimeContextValue(["accountId", "currentAccountId", "userId", "userID"]);
  const fullname =
    globalAccount.fullname ||
    globalAccount.fullName ||
    globalAccount.name ||
    getRuntimeContextValue(["fullname", "fullName", "userName", "username"]);
  const avatar = globalAccount.avatar || globalAccount.avatarSmall || "";

  return {
    accountId: String(accountId || "").trim(),
    fullname: String(fullname || "").trim(),
    avatar: String(avatar || "").trim(),
  };
}

// `装载人` is normally returned as a member-control JSON value, but older
// records can contain just the display name.  Compare every stable identity
// we can find without fetching anything per row.
function getLoaderIdentityValues(value) {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed.flatMap((item) => getLoaderIdentityValues(item));
  if (parsed && typeof parsed === "object") {
    return [
      parsed.accountId,
      parsed.accountID,
      parsed.userId,
      parsed.userID,
      parsed.id,
      parsed.fullname,
      parsed.fullName,
      parsed.name,
      parsed.text,
      parsed.value,
    ].flatMap((item) => (item && typeof item === "object" ? getLoaderIdentityValues(item) : [item]));
  }
  return [parsed];
}

function normalizeLoaderIdentity(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function isRowLoadedByAnotherAccount(row) {
  if (!row || (!row.checked && !(Number(row.loadedQty) > 0))) return false;
  const loaderValues = getLoaderIdentityValues(row.loadingUser)
    .map(normalizeLoaderIdentity)
    .filter((value) => value && value !== "-" && value !== "未指定");
  if (!loaderValues.length) return false;
  const currentAccount = getCurrentAccountInfo();
  const currentValues = [currentAccount.accountId, currentAccount.fullname]
    .map(normalizeLoaderIdentity)
    .filter(Boolean);
  // Fail closed only when we know both identities. This avoids incorrectly
  // locking a user's own row in runtimes that do not expose account details.
  return currentValues.length > 0 && !loaderValues.some((value) => currentValues.includes(value));
}

function buildLoaderControlValue(controlId, checked, type) {
  if (!checked) return buildClearControlValue(controlId, type || 26);
  const currentAccount = getCurrentAccountInfo();
  if (!currentAccount.accountId) {
    throw new Error("未获取到当前登录账号，无法写入装载人");
  }
  const member = {
    accountId: currentAccount.accountId,
    ...(currentAccount.fullname ? { fullname: currentAccount.fullname } : {}),
    ...(currentAccount.avatar ? { avatar: currentAccount.avatar } : {}),
  };
  return buildControlValue(controlId, JSON.stringify([member]), type || 26);
}

function isWritableNumberControlType(type) {
  const numericType = Number(type);
  return !numericType || [2, 6, 8, 28].includes(numericType);
}

function isWritableCheckboxControlType(type) {
  const numericType = Number(type);
  return !numericType || [2, 6, 8, 28, 36].includes(numericType);
}

function isWritableMemberControlType(type) {
  const numericType = Number(type);
  return !numericType || numericType === 26;
}

function isCalculatedFieldControlType(type) {
  return [30, 31, 32, 33, 37, 38].includes(Number(type));
}

function buildDateControlValueCandidates(control, dateText) {
  const controlId = getControlIdFromItem(control);
  if (!controlId || !dateText) return [];
  const normalizedDate = normalizeDateInputText(dateText);
  if (!normalizedDate) return [];
  const dateTimeValue = `${normalizedDate} 00:00:00`;
  const type = Number(control?.type) || 15;
  const controlName = getControlName(control) || "送货日期";
  const values = Number(type) === 16
    ? [dateTimeValue, normalizedDate]
    : [normalizedDate];

  return Array.from(
    new Map(
      values
        .map((value) => buildControlValue(controlId, value, type, controlName))
        .map((item) => [JSON.stringify(item), item])
    ).values()
  );
}

function buildRelationControlValueCandidates(controlId, option, type) {
  if (!controlId || !option?.value) return [];
  return [
    buildControlValue(
      controlId,
      JSON.stringify([{ sid: option.value, name: option.label || option.value }]),
      type || 29
    ),
  ];
}

function getWorksheetIdValue(source) {
  return (
    source?.worksheetId ||
    source?.wsId ||
    source?.sourceWorksheetId ||
    source?.relationWorksheetId ||
    source?.worksheet?.worksheetId ||
    ""
  );
}

function getWorksheetIdFromControls(controls) {
  const matched = (Array.isArray(controls) ? controls : []).find((control) =>
    getWorksheetIdValue(control)
  );
  return getWorksheetIdValue(matched);
}

function getButtonId(button) {
  return button?.btnId || button?.btnID || button?.id || button?.buttonId || button?.worksheetBtnId || "";
}

function getButtonName(button) {
  return String(button?.name || button?.btnName || button?.buttonName || button?.title || button?.text || "").trim();
}

function findButtonByName(buttons, buttonName) {
  const targetName = String(buttonName || "").trim();
  return (Array.isArray(buttons) ? buttons : []).find((button) => getButtonName(button) === targetName);
}

function findButtonByAliases(buttons, aliases) {
  const normalizedAliases = (Array.isArray(aliases) ? aliases : [aliases])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const list = Array.isArray(buttons) ? buttons : [];
  for (const alias of normalizedAliases) {
    const exactMatched = list.find((button) => getButtonName(button) === alias);
    if (exactMatched) return exactMatched;
  }
  for (const alias of normalizedAliases) {
    const fuzzyMatched = list.find((button) => getButtonName(button).includes(alias));
    if (fuzzyMatched) return fuzzyMatched;
  }
  return null;
}

function getButtonsFromResponse(response) {
  const candidates = [
    response?.buttons,
    response?.data?.buttons,
    response?.data?.btns,
    response?.data?.list,
    response?.data?.rows,
    response?.data,
    response?.list,
    response?.btns,
    Array.isArray(response) ? response : null,
  ];
  return candidates.find(Array.isArray) || [];
}

function compactApiParams(params) {
  return Object.fromEntries(
    Object.entries(params || {}).filter(([, value]) => {
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value) && !value.length) return false;
      return true;
    })
  );
}

async function callStartProcess(startProcess, payload) {
  let lastError = null;

  try {
    const rawResult = await startProcess(payload);
    assertMingdaoApiSuccess(rawResult, "调用明道云按钮");
    return rawResult || true;
  } catch (error) {
    lastError = error;
    console.warn("start process raw payload failed", payload, error);
  }

  try {
    const wrappedResult = await startProcess({ startProcess: payload });
    assertMingdaoApiSuccess(wrappedResult, "调用明道云按钮");
    return wrappedResult || true;
  } catch (error) {
    throw lastError || error;
  }
}

const TOP_FIELD_NAME_CANDIDATES = {
  detailRelation: ["送货明细", "装车明细", "明细", "未装", "未装明细"],
  truckRelation: ["货车", "选择货车"],
  deliveryDate: ["送货日期"],
  capacityArea: ["可载平方", "可装平方", "载货平方", "车辆平方", "货车平方"],
  loadingArea: ["在装平方", "在装面积", "装载平方", "装载面积"],
  capacityVolume: ["可载立方", "可装立方", "载货立方"],
  loadingVolume: ["在装立方", "在装方数", "在装方量"],
  loadedVolume: ["已载立方", "已装立方"],
  progress: ["进度", "装车进度", "装载进度"],
};

const FILTER_EVENTS = [
  "filters-update",
  "filter-update",
  "quick-filter-update",
  "quickFilters-update",
  "quickFiltersUpdate",
  "fast-filter-update",
  "fastFilters-update",
];

const REFRESH_EVENTS = [
  "data-update",
  "refresh",
  "update-record",
  "delete-record",
  "new-record",
];

const STORAGE_KEYS = {
  personalSettings: "delivery-loading-personal-settings-v3",
  // Bump this only when the published standard layout intentionally changes.
  // A customer's choices remain scoped to their own account after first use.
  personalSettingsPrefix: "delivery-loading-personal-settings-v6",
  draftPrefix: "delivery-loading-draft-v1",
};

const PUBLIC_SETTING_KEY = "deliveryLoadingLayout";
// The published source owns this baseline. It is intentionally independent of
// a user's local choices, so every new use starts from the same view format.
const STANDARD_TEMPLATE_VERSION = "delivery-loading-standard-v4";
const STANDARD_LAYOUT = Object.freeze({ topHeight: 164, leftWidth: 12 });
const DETAIL_ROW_HEIGHT = 42;
const DETAIL_ROW_OVERSCAN = 10;
const ALL_CUSTOMERS_KEY = "__ALL_CUSTOMERS__";
const DEFAULT_HIDDEN_COLUMNS = {
  // Fixed to the approved published view: the two area metrics are shown,
  // while the three cubic-metre metrics remain optional customer fields.
  top: ["loadedVolume", "loadingVolume", "capacityVolume"],
  summary: [
    "inventoryQty",
    "plannedVolume",
    "inventoryVolume",
    "detailCount",
    "selected",
    "clientCode",
    "route",
    "address",
  ],
  detail: [
    "specificationModel",
    "materialCode",
    "plannedVolume",
    "index",
    "clientCode",
    "address",
    "route",
    "productArchive",
    "purchaseOrder",
    "unitPrice",
    "productionStatus",
    "totalPurchaseQty",
    "totalBoardQty",
    "printCompleted",
    "formingCompleted",
    "totalInboundQty",
    "totalOutboundQty",
    "inventoryVolume",
    "loadedVolume",
    "plannedArea",
    "inventoryArea",
    "loadedArea",
  ],
};

function calculateLoadingVolume(row, loadedQty) {
  const nextLoadedQty = Number(loadedQty) || 0;
  if (row?.plannedQty) {
    return (nextLoadedQty / row.plannedQty) * row.plannedVolume;
  }
  return nextLoadedQty * row.convertedVolume;
}

function calculateLoadingArea(row, loadedQty) {
  const nextLoadedQty = Number(loadedQty) || 0;
  const unitArea = Number(row?.unitArea) || 0;
  const convertedArea = Number(row?.convertedArea) || 0;
  const giftQty = Number(row?.giftQty) || 0;
  // Exact live formula on 送货明细:
  // (装载量 + 赠量) * 单位面积 * 平方系数
  if (unitArea && convertedArea) {
    return (nextLoadedQty + giftQty) * unitArea * convertedArea;
  }
  if (row?.plannedQty) {
    return (nextLoadedQty / row.plannedQty) * row.plannedArea;
  }
  return nextLoadedQty * convertedArea;
}

function calculateProgressPercent(loadedValue, capacityValue) {
  const loaded = Number(loadedValue) || 0;
  const capacity = Number(capacityValue) || 0;
  if (!capacity) return 0;
  return Math.round((loaded / capacity) * 100);
}

const TOP_COLUMNS = [
  { key: "deliveryDate", title: "送货日期", width: 120 },
  { key: "truck", title: "货车", width: 112 },
  { key: "driver", title: "司机", width: 92 },
  { key: "capacityArea", title: "可载平方", width: 106 },
  { key: "loadingArea", title: "在装平方", width: 106 },
  { key: "progress", title: "进度", width: 86 },
  { key: "loadingAction", title: "装载", width: 170 },
  { key: "loadedVolume", title: "已载立方", width: 106 },
  { key: "loadingVolume", title: "在装立方", width: 106 },
  { key: "capacityVolume", title: "可载立方", width: 106 },
];

const SUMMARY_COLUMNS = [
  { key: "shortName", title: "客户简称", width: 96 },
  { key: "plannedQty", title: "计划量", width: 76 },
  { key: "inventoryQty", title: "库存数量", width: 76 },
  { key: "plannedVolume", title: "计划立方", width: 84 },
  { key: "inventoryVolume", title: "库存立方", width: 84 },
  { key: "detailCount", title: "明细数", width: 72 },
  { key: "selected", title: "V", width: 44 },
  { key: "clientCode", title: "客户编码", width: 92 },
  { key: "route", title: "送货线路", width: 88 },
  { key: "address", title: "送货地址", width: 124 },
];

const DETAIL_COLUMNS = [
  { key: "shortName", title: "客户简称", width: 96 },
  { key: "workOrder", title: "生产工单", width: 120 },
  { key: "productName", title: "品名", width: 104 },
  { key: "specificationModel", title: "规格型号", width: 120 },
  { key: "materialCode", title: "物料代码", width: 120 },
  { key: "model", title: "楞型", width: 76 },
  { key: "size", title: "尺寸", width: 96 },
  { key: "plannedQty", title: "计划量", width: 72 },
  { key: "checked", title: "勾选", width: 58 },
  { key: "loadedQty", title: "装载量", width: 96 },
  { key: "loadingUser", title: "装载人", width: 86 },
  { key: "unitArea", title: "单位面积", width: 82 },
  { key: "convertedArea", title: "平方系数", width: 82 },
  { key: "convertedVolume", title: "立方系数", width: 82 },
  { key: "inventoryQty", title: "库存数量", width: 72 },
  { key: "remark", title: "备注", width: 160 },
  { key: "plannedVolume", title: "计划立方", width: 84 },
  { key: "index", title: "序号", width: 56 },
  { key: "clientCode", title: "客户编码", width: 92 },
  { key: "address", title: "送货地址", width: 140 },
  { key: "route", title: "路径", width: 96 },
  { key: "productArchive", title: "产品档案", width: 120 },
  { key: "purchaseOrder", title: "采购单号", width: 120 },
  { key: "unitPrice", title: "单价", width: 72 },
  { key: "productionStatus", title: "生产状态", width: 88 },
  { key: "totalPurchaseQty", title: "总采购量", width: 86 },
  { key: "totalBoardQty", title: "总纸板量", width: 86 },
  { key: "printCompleted", title: "印刷完工", width: 86 },
  { key: "formingCompleted", title: "成型完工", width: 86 },
  { key: "totalInboundQty", title: "总入库量", width: 86 },
  { key: "totalOutboundQty", title: "总出库量", width: 86 },
  { key: "inventoryVolume", title: "库存立方", width: 84 },
  { key: "loadedVolume", title: "在装立方", width: 84 },
  { key: "plannedArea", title: "计划平方", width: 84 },
  { key: "inventoryArea", title: "库存平方", width: 84 },
  { key: "loadedArea", title: "在装平方", width: 84 },
  { key: "deleteAction", title: "删除", width: 30, filterable: false },
  { key: "returnAction", title: "退回", width: 30, filterable: false },
];

const REQUIRED_DETAIL_COLUMN_KEYS = [
  "unitPrice",
  "productionStatus",
  "totalPurchaseQty",
  "totalBoardQty",
  "printCompleted",
  "formingCompleted",
  "totalInboundQty",
  "totalOutboundQty",
];

const MODEL_FIELD_NAMES = [
  "楞型",
  "楞形",
  "愣型",
  "棱型",
  "瓦楞",
  "瓦楞类型",
  "纸板楞型",
  "楞别",
  "棱别",
  "坑型",
  "坑别",
];

const Shell = styled.div`
  height: 100vh;
  padding: 10px;
  background: #e6eef8;
  color: #1f2937;
  overflow: hidden;

  ${(props) =>
    props.$busyCursor
      ? `
        cursor: wait;

        * {
          cursor: wait !important;
        }
      `
      : ""}
`;

const Stack = styled.div`
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 0;
`;

const TopPanel = styled.section`
  flex: 0 0 auto;
  background: #f6fbff;
  border: 1px solid #9ebee5;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
  overflow: hidden;
`;

const TopTitle = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 10px;
  border-bottom: 1px solid #b3cbea;
  background: linear-gradient(180deg, #dcebff 0%, #c6def8 100%);
  font-size: 13px;
  font-weight: 700;
  color: #22466d;
`;

const TopStatus = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #42688f;
  font-size: 12px;
  font-weight: 600;
`;

const Split = styled.section`
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  overflow: hidden;
`;

const Panel = styled.section`
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #f8fbff;
  border: 1px solid #9ebee5;
`;

const LeftPanel = styled(Panel)`
  flex: 0 0 34%;
  width: 34%;
  min-width: 160px;
`;

const RightPanel = styled(Panel)`
  flex: 1 1 auto;
  width: 66%;
  min-width: 0;
`;

const ResizeBarHorizontal = styled.div`
  flex: 0 0 10px;
  position: relative;
  cursor: row-resize;
  background: #d8e7f8;
  border-left: 1px solid #9ebee5;
  border-right: 1px solid #9ebee5;

  &::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 56px;
    height: 4px;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background: #a6bdd9;
  }
`;

const ResizeBarVertical = styled.div`
  flex: 0 0 10px;
  position: relative;
  cursor: col-resize;
  background: #d8e7f8;
  border-top: 1px solid #9ebee5;
  border-bottom: 1px solid #9ebee5;

  &::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    width: 4px;
    height: 56px;
    transform: translate(-50%, -50%);
    border-radius: 999px;
    background: #a6bdd9;
  }
`;

const PanelHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  background: linear-gradient(180deg, #dcebff 0%, #c6def8 100%);
  border-bottom: 1px solid #9ebee5;
`;

const PanelTitle = styled.div`
  font-size: 14px;
  font-weight: 700;
  color: #22466d;
`;

const PanelMeta = styled.div`
  font-size: 12px;
  color: #42688f;
`;

const PanelActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
`;

const FieldActionSlot = styled.span`
  display: inline-flex;
  align-items: center;
  margin-left: 12px;
  padding-left: 12px;
  border-left: 1px solid rgba(80, 123, 168, 0.28);
`;

const FieldButton = styled.button`
  border: 1px solid #91b8e4;
  border-radius: 3px;
  background: #f7fbff;
  color: #24527d;
  padding: 2px 8px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;

  &:hover {
    background: #eaf4ff;
  }
`;

const SaveButton = styled(FieldButton)`
  background: ${(props) => (props.$primary ? "#2f80d1" : "#f7fbff")};
  color: ${(props) => (props.$primary ? "#fff" : "#24527d")};
  border-color: ${(props) => (props.$primary ? "#2f80d1" : "#91b8e4")};

  &:hover {
    background: ${(props) => (props.$primary ? "#246faf" : "#eaf4ff")};
  }
`;

const ConfirmButton = styled(SaveButton)`
  position: relative;
  isolation: isolate;
  min-width: 72px;
  flex: 1 1 0;
  padding: 5px 12px;
  border: 0;
  border-radius: 5px;
  background: ${(props) =>
    props.$variant === "supplement"
      ? "linear-gradient(135deg, #22b678 0%, #15935e 48%, #0d7249 100%)"
      : "linear-gradient(135deg, #1d8cff 0%, #1769d2 48%, #0d4fa8 100%)"};
  box-shadow: ${(props) =>
    props.$variant === "supplement"
      ? "0 8px 18px rgba(21, 147, 94, 0.26), inset 0 1px 0 rgba(255, 255, 255, 0.28)"
      : "0 8px 18px rgba(29, 140, 255, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.28)"};
  color: #fff;
  font-size: 13px;
  letter-spacing: 0;
  text-align: center;
  overflow: hidden;
  transform: translateY(0);
  transition: transform 160ms ease, box-shadow 160ms ease, filter 160ms ease;
  cursor: ${(props) => (props.$running ? "wait" : "pointer")};

  &::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    background: linear-gradient(100deg, transparent 0%, rgba(255, 255, 255, 0.34) 45%, transparent 70%);
    transform: translateX(-120%);
    animation: confirmButtonShine 2.8s ease-in-out infinite;
  }

  &:hover {
    background: ${(props) =>
      props.$running
        ? "#b8c2cf"
        : props.$variant === "supplement"
        ? "linear-gradient(135deg, #2ec784 0%, #1ba568 48%, #117d50 100%)"
        : "linear-gradient(135deg, #2696ff 0%, #1c73df 48%, #1258b8 100%)"};
    box-shadow: ${(props) =>
      props.$running
        ? "none"
        : props.$variant === "supplement"
        ? "0 10px 22px rgba(21, 147, 94, 0.32), inset 0 1px 0 rgba(255, 255, 255, 0.32)"
        : "0 10px 22px rgba(29, 140, 255, 0.34), inset 0 1px 0 rgba(255, 255, 255, 0.32)"};
    transform: ${(props) => (props.$running ? "translateY(0)" : "translateY(-1px)")};
  }

  &:active {
    transform: translateY(1px);
    filter: brightness(0.88);
    box-shadow: 0 3px 8px rgba(29, 140, 255, 0.3), inset 0 2px 8px rgba(10, 49, 101, 0.35);
  }

  &:disabled {
    cursor: ${(props) => (props.$disabledReason === "empty" ? "not-allowed" : "wait")};
    background: #b8c2cf;
    color: #f7f9fb;
    filter: none;
    opacity: 1;
    transform: ${(props) => (props.$disabledReason === "empty" ? "translateY(0)" : "translateY(1px)")};
    box-shadow: ${(props) =>
      props.$disabledReason === "empty"
        ? "none"
        : "0 3px 8px rgba(88, 101, 118, 0.22), inset 0 2px 8px rgba(44, 53, 64, 0.2)"};
  }

  &:disabled::before {
    display: none;
  }

  @keyframes confirmButtonShine {
    0% {
      transform: translateX(-120%);
    }
    48%,
    100% {
      transform: translateX(120%);
    }
  }
`;

const ActionButtonGroup = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
`;

const ActionButtonContent = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 50px;
`;

const ActionButtonSpinner = styled.span`
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.45);
  border-top-color: #fff;
  border-radius: 999px;
  animation: actionButtonSpin 780ms linear infinite;

  @keyframes actionButtonSpin {
    to {
      transform: rotate(360deg);
    }
  }
`;

const ModalBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(16, 37, 62, 0.32);
`;

const ModalPanel = styled.div`
  width: min(460px, 100%);
  border: 1px solid #8eb3dd;
  background: #fff;
  box-shadow: 0 16px 42px rgba(16, 37, 62, 0.24);
`;

const ModalHead = styled.div`
  padding: 10px 14px;
  background: linear-gradient(180deg, #dcebff 0%, #c6def8 100%);
  border-bottom: 1px solid #b3cbea;
  color: #22466d;
  font-size: 14px;
  font-weight: 800;
`;

const ModalBody = styled.div`
  display: grid;
  gap: 10px;
  padding: 14px;
`;

const ModalHint = styled.div`
  color: #5b7290;
  font-size: 12px;
`;

const ModalSelect = styled.select`
  width: 100%;
  height: 34px;
  border: 1px solid #c6d8ec;
  border-radius: 3px;
  padding: 4px 6px;
  color: #162f4d;
  font: inherit;
  font-weight: 700;
  text-align: left;
  background: #fff;
`;

const ModalNumberInput = styled.input`
  width: 100%;
  height: 34px;
  border: 1px solid #c6d8ec;
  border-radius: 3px;
  padding: 4px 8px;
  color: #162f4d;
  font: inherit;
  font-weight: 700;
`;

const ModalActions = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 14px 14px;
`;

const FieldPopover = styled.div`
  position: fixed;
  top: ${(props) => props.$top || 42}px;
  right: 18px;
  z-index: 20;
  width: 210px;
  max-height: 60vh;
  overflow: auto;
  border: 1px solid #8eb3dd;
  background: #fff;
  box-shadow: 0 8px 22px rgba(34, 70, 109, 0.18);
`;

const FieldPopoverHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  background: #dcebff;
  border-bottom: 1px solid #b8d0ec;
  color: #22466d;
  font-size: 13px;
  font-weight: 700;
`;

const FieldPopoverActions = styled.div`
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid #edf3fa;
  background: #f8fbff;
`;

const SaveStatus = styled.div`
  padding: 0 10px 8px;
  color: #42688f;
  font-size: 12px;
`;

const FieldGroupTitle = styled.div`
  padding: 9px 10px 5px;
  color: #22466d;
  font-size: 12px;
  font-weight: 700;
  background: #f8fbff;
`;

const FieldOption = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-bottom: 1px solid #edf3fa;
  color: #24415f;
  font-size: 13px;
  cursor: pointer;

  input {
    margin: 0;
  }
`;

const TopTableWrap = styled.div`
  overflow: auto;
  background: #fff;
`;

const TableWrap = styled.div`
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #fff;
`;

const Grid = styled.table`
  width: 100%;
  min-width: ${(props) => props.$minWidth || "100%"};
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;

  th {
    position: sticky;
    top: 0;
    z-index: 6;
    padding: 7px 8px;
    background: #edf5ff;
    border-right: 1px solid #c6d8ec;
    border-bottom: 1px solid #c6d8ec;
    font-size: 12px;
    font-weight: 700;
    color: #294f78;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
  }

  thead tr:nth-child(2) th {
    top: 31px;
  }

  td {
    padding: 6px 8px;
    border-right: 1px solid #d8e5f1;
    border-bottom: 1px solid #d8e5f1;
    font-size: 13px;
    color: #1f3552;
    vertical-align: middle;
    line-height: 1.35;
    background: #fff;
  }

  th:last-child,
  td:last-child {
    border-right: 0;
  }

  tbody tr:hover td {
    background: #f6fbff;
  }
`;

const CompactGrid = styled(Grid)`
  th,
  td {
    text-align: center;
  }

  td {
    font-size: 13px;
    font-weight: 500;
    color: #1f3552;
  }
`;

const HeaderDragButton = styled.button`
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0 10px 0 0;
  font: inherit;
  font-weight: inherit;
  color: inherit;
  text-align: inherit;
  cursor: grab;
`;

const HeaderCellContent = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
`;

const ColumnFilterButton = styled.button`
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 25px;
  border: 0;
  border-radius: 2px;
  padding: 0;
  background: ${(props) => (props.$active ? "#1689e6" : "transparent")};
  color: ${(props) => (props.$active ? "#fff" : "#587b99")};
  cursor: pointer;
  font-size: 11px;

  &:hover {
    background: ${(props) => (props.$active ? "#0878cd" : "#d9edff")};
    color: ${(props) => (props.$active ? "#fff" : "#1987dc")};
  }
`;

const HeaderResizeHandle = styled.span`
  position: absolute;
  top: 0;
  right: -3px;
  width: 8px;
  height: 100%;
  cursor: col-resize;
  z-index: 2;

  &:hover {
    background: rgba(54, 115, 183, 0.16);
  }
`;

const SummaryRow = styled.tr`
  td {
    background: ${(props) =>
      props.$active ? "#fff2bf !important" : props.$total ? "#eef6ff" : "#f8fbff"};
    font-weight: ${(props) => (props.$total || props.$active ? 700 : 600)};
    color: ${(props) => (props.$active ? "#5c4300" : props.$total ? "#315b86" : "inherit")};
    box-shadow: none;
  }

  &:hover td {
    background: ${(props) =>
      props.$active ? "#fff2bf !important" : props.$total ? "#e5f1ff" : "#f6fbff"};
  }
`;

const VirtualDetailRow = styled.tr`
  height: ${DETAIL_ROW_HEIGHT}px;

  td {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  ${(props) => props.$locked ? `
    td { background: #fff3db !important; }
  ` : ""}

  ${(props) => props.$unsaved ? `
    td { background: #ffe4e6 !important; color: #9f1239; }
  ` : ""}
`;

const VirtualSpacerCell = styled.td`
  height: ${(props) => props.$height || 0}px;
  min-height: ${(props) => props.$height || 0}px;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
`;

const IndexCell = styled.td`
  width: 52px;
  text-align: center;
  color: #6683a6 !important;
  font-weight: 700;
`;

const SelectCellButton = styled.button`
  width: 100%;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
`;

const InlineTag = styled.span`
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 3px;
  background: ${(props) => props.$bg || "#eef5ff"};
  color: ${(props) => props.$color || "#2b5a88"};
  border: 1px solid ${(props) => props.$border || "#c7daef"};
  font-size: 12px;
  font-weight: 700;
`;

const ValueText = styled.div`
  font-weight: ${(props) => (props.$strong ? 700 : 500)};
  color: ${(props) => props.$tone || "#1f3552"};
`;

const CellFilterInput = styled.input`
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  border: 1px solid #bdd3ed;
  border-radius: 3px;
  background: #fff;
  padding: 4px 6px;
  color: inherit;
  font: inherit;
  font-weight: inherit;
  outline: none;

  &:focus {
    border-color: #5b9bd8;
    box-shadow: 0 0 0 2px rgba(47, 128, 209, 0.12);
  }
`;

const FilterPopoverBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 40;
`;

const ColumnFilterPopover = styled.div`
  position: fixed;
  z-index: 41;
  top: ${(props) => props.$top}px;
  left: ${(props) => props.$left}px;
  width: ${(props) => props.$width || 300}px;
  max-width: calc(100vw - 20px);
  border: 1px solid #aac7e7;
  border-radius: 4px;
  background: #fff;
  box-shadow: 0 8px 24px rgba(31, 53, 82, 0.22);
  overflow: hidden;
`;

const ColumnFilterTitle = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-bottom: 1px solid #d8e5f1;
  color: #244f7c;
  font-size: 13px;
  font-weight: 700;
`;

const ColumnFilterClearButton = styled.button`
  border: 1px solid #c6d8ec;
  border-radius: 3px;
  padding: 3px 8px;
  background: #fff;
  color: #6a849f;
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    border-color: #7eadd7;
    color: #2f6da7;
  }
`;

const ColumnFilterBody = styled.div`
  padding: 10px 12px 12px;
`;

const ColumnFilterOptionList = styled.div`
  max-height: 220px;
  margin-top: 9px;
  overflow: auto;
  border-top: 1px solid #edf3fa;
`;

const ColumnFilterOptionButton = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 0;
  border-bottom: 1px solid #edf3fa;
  padding: 7px 4px;
  background: ${(props) => (props.$active ? "#eaf5ff" : "#fff")};
  color: #29465f;
  text-align: left;
  cursor: pointer;

  &:hover {
    background: #f0f7ff;
  }
`;

const ColumnFilterCheck = styled.span`
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 1px solid ${(props) => (props.$active ? "#2f80d1" : "#aebed0")};
  border-radius: 2px;
  background: ${(props) => (props.$active ? "#2f80d1" : "#fff")};
  color: #fff;
  font-size: 11px;
`;

const ColumnFilterEmpty = styled.div`
  padding: 28px 8px;
  color: #8599ad;
  text-align: center;
  font-size: 13px;
`;

const ActiveFilterBadge = styled.span`
  color: #2f6da7;
  font-size: 12px;
  font-weight: 700;
`;

const LoadCheckInput = styled.input`
  width: 20px;
  height: 20px;
  margin: 0;
  accent-color: #2f80d1;
  cursor: pointer;
`;

const DeleteCellButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 25px;
  max-width: 100%;
  height: 25px;
  border: 0;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  color: #dc2626;
  font-size: 23px;
  line-height: 1;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 140ms ease;

  &:hover {
    background: #fee2e2;
    color: #b91c1c;
    transform: scale(1.06);
  }

  &:active {
    transform: scale(0.94);
  }

  &:disabled {
    color: #94a3b8;
    background: transparent;
    cursor: wait;
    transform: none;
  }
`;

const ReturnCellButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  max-width: 100%;
  height: 17px;
  min-width: 17px;
  border: 1px solid #4f93d2;
  border-radius: 4px;
  padding: 0;
  background: #edf6ff;
  color: #1f67a8;
  font-size: 11px;
  font-weight: 800;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, transform 140ms ease;

  &:hover {
    background: #d9ecff;
    color: #134f87;
    transform: translateX(-1px);
  }

  &:disabled {
    border-color: #cbd5e1;
    background: #f1f5f9;
    color: #94a3b8;
    cursor: wait;
    transform: none;
  }
`;

const SplitCellButton = styled.button`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  max-width: 100%;
  height: 22px;
  border: 1px solid #d69227;
  border-radius: 4px;
  padding: 0;
  background: #fff8e6;
  color: #a96000;
  font-size: 12px;
  font-weight: 800;
  cursor: pointer;

  &:hover { background: #ffedbf; }
  &:disabled { border-color: #cbd5e1; background: #f1f5f9; color: #94a3b8; cursor: wait; }
`;

const DeleteConfirmButton = styled(SaveButton)`
  background: #dc2626;
  border-color: #dc2626;
  color: #fff;

  &:hover {
    background: #b91c1c;
    border-color: #b91c1c;
  }

  &:disabled {
    background: #cbd5e1;
    border-color: #cbd5e1;
    cursor: wait;
  }
`;

const ReturnConfirmButton = styled(SaveButton)`
  background: #2f80d1;
  border-color: #2f80d1;
  color: #fff;

  &:hover {
    background: #246faf;
    border-color: #246faf;
  }

  &:disabled {
    background: #cbd5e1;
    border-color: #cbd5e1;
    cursor: wait;
  }
`;

const DeleteRecordText = styled.div`
  color: #203b5c;
  font-size: 14px;
  line-height: 1.65;

  strong {
    color: #b91c1c;
  }
`;

const TopInput = styled.input`
  width: 100%;
  border: 1px solid #c6d8ec;
  border-radius: 3px;
  padding: 4px 6px;
  color: #162f4d;
  font: inherit;
  font-weight: 700;
  text-align: center;
  background: #fff;
`;

const TopSelect = styled(TopInput).attrs({ as: "select" })``;

const QtyInput = styled.input`
  width: 100%;
  min-width: 0;
  border: 1px solid #c6d8ec;
  border-radius: 3px;
  padding: 3px 5px;
  color: #1f3552;
  font: inherit;
`;

const RemarkInput = styled(QtyInput)`
  min-width: 120px;
`;

const ProgressWrap = styled.div`
  width: 100%;
  min-width: 72px;
  height: 22px;
  position: relative;
  overflow: hidden;
  border-radius: 999px;
  border: 1px solid ${(props) => props.$border};
  background: ${(props) => props.$track};
  box-shadow: inset 0 1px 2px rgba(31, 53, 82, 0.12);
`;

const ProgressFill = styled.div`
  width: ${(props) => props.$percent}%;
  height: 100%;
  border-radius: inherit;
  background: ${(props) => props.$fill};
  background-size: 180% 100%;
  transition: width 260ms ease, background 260ms ease;
  animation: progress-flow 1.4s linear infinite;

  @keyframes progress-flow {
    0% {
      background-position: 0 0;
    }
    100% {
      background-position: 180% 0;
    }
  }
`;

const ProgressText = styled.span`
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: ${(props) => props.$color};
  font-size: 12px;
  font-weight: 800;
`;

const EmptyTip = styled.div`
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 44px 18px;
  text-align: center;
  color: #7d95b1;
  font-size: 14px;
`;

function getControlIds() {
  const liveRuntimeEnv = getLiveRuntimeEnv();
  const mappingCandidates = {
    detailRelation: ["detailRelation", "送货明细", "明细", "未装"],
    truckRelation: ["truckRelation", "货车", "选择货车"],
    deliveryDate: ["deliveryDate", "送货日期"],
    capacityArea: ["capacityArea", "可载平方", "可装平方", "载货平方"],
    loadingArea: ["loadingArea", "在装平方", "在装面积", "装载平方", "装载面积"],
    capacityVolume: ["capacityVolume", "可载立方", "可装立方", "载货立方"],
    loadingVolume: ["loadingVolume", "在装立方", "在装方数", "在装方量"],
    loadedVolume: ["loadedVolume", "已载立方", "已装立方", "已载平方"],
    progress: ["progress", "进度", "装车进度", "装载进度"],
    supplementOrder: ["supplementOrder", ...SUPPLEMENT_ORDER_FIELD_NAMES],
  };

  function getMappedControlId(candidateKeys) {
    const mappedValue = getRuntimeMappedValue(candidateKeys);
    const mappedControlId = extractMappedControlId(mappedValue);
    if (mappedControlId) return mappedControlId;

    for (const key of candidateKeys) {
      const found = extractMappedControlId(liveRuntimeEnv[key]);
      if (found) return found;
    }
    return "";
  }

  function getGenericKeys(prefix) {
    return Object.keys(liveRuntimeEnv)
      .filter((key) => new RegExp(`^${prefix}\\d*$`, "i").test(key))
      .sort((a, b) => {
        const indexA = Number(String(a).replace(prefix, "") || 0);
        const indexB = Number(String(b).replace(prefix, "") || 0);
        return indexA - indexB;
      });
  }

  const genericRelationKeys = getGenericKeys("relationfield");
  const genericFieldKeys = getGenericKeys("field");

  function getGenericMappedControlId(type, index) {
    const key =
      type === "relation" ? genericRelationKeys[index] : genericFieldKeys[index];
    return key ? extractMappedControlId(liveRuntimeEnv[key]) : "";
  }

  return {
    detailRelation: ORIGINAL_DETAIL_RELATION_CONTROL_ID,
    truckRelation:
      normalizeControlId(getMappedControlId(mappingCandidates.truckRelation)) ||
      getGenericMappedControlId("relation", 1) ||
      getGenericMappedControlId("field", 1),
    deliveryDate:
      normalizeControlId(getMappedControlId(mappingCandidates.deliveryDate)) ||
      getGenericMappedControlId("field", 4),
    capacityArea:
      normalizeControlId(getMappedControlId(mappingCandidates.capacityArea)),
    loadingArea: DELIVERY_DETAIL_FIELD_IDS.loadedArea,
    capacityVolume:
      normalizeControlId(getMappedControlId(mappingCandidates.capacityVolume)) ||
      getGenericMappedControlId("field", 2),
    loadingVolume:
      normalizeControlId(getMappedControlId(mappingCandidates.loadingVolume)),
    loadedVolume:
      normalizeControlId(getMappedControlId(mappingCandidates.loadedVolume)) ||
      getGenericMappedControlId("field", 3),
    progress:
      normalizeControlId(getMappedControlId(mappingCandidates.progress)),
    supplementOrder:
      normalizeControlId(getMappedControlId(mappingCandidates.supplementOrder)) ||
      getGenericMappedControlId("field", 5),
  };
}

function parseMaybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return value;
  }
}

function getRuntimeMappingSources() {
  const windowConfig = typeof window !== "undefined" ? window.config || {} : {};
  const windowEnv = typeof window !== "undefined" ? window.env || {} : {};
  return [
    runtimeEnv,
    runtimeConfig?.env,
    runtimeConfig?.query,
    runtimeConfig?.params,
    runtimeConfig?.customWidgetConfig,
    runtimeConfig?.customWidget,
    runtimeConfig?.view?.advancedSetting,
    runtimeConfig,
    windowConfig?.env,
    windowConfig?.query,
    windowConfig?.params,
    windowConfig?.customWidgetConfig,
    windowConfig?.customWidget,
    windowConfig?.view?.advancedSetting,
    windowConfig,
    windowEnv,
  ].filter(Boolean);
}

function collectRuntimeValuesByKey(source, targetKey, seen = new WeakSet(), depth = 0) {
  if (!source || depth > 6) return [];
  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (!parsed || typeof parsed !== "object") return [];
  if (seen.has(parsed)) return [];
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => collectRuntimeValuesByKey(item, targetKey, seen, depth + 1));
  }

  const normalizedTargetKey = String(targetKey || "").toLowerCase();
  return Object.entries(parsed).flatMap(([key, value]) => {
    const matched = String(key || "").toLowerCase() === normalizedTargetKey ? [value] : [];
    return [
      ...matched,
      ...collectRuntimeValuesByKey(value, targetKey, seen, depth + 1),
    ];
  });
}

function getStringValuesDeep(source, seen = new WeakSet(), depth = 0) {
  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (parsed === null || parsed === undefined || depth > 5) return [];
  if (typeof parsed !== "object") return [String(parsed)];
  if (seen.has(parsed)) return [];
  seen.add(parsed);

  return Object.values(parsed).flatMap((value) => getStringValuesDeep(value, seen, depth + 1));
}

function isRuntimeMappingObjectForKeys(source, candidateKeys) {
  if (!source || typeof source !== "object") return false;
  const ignoredKeys = new Set(["明细", "未装"]);
  const normalizedKeys = candidateKeys
    .map((key) => normalizeFieldName(key).toLowerCase())
    .filter((key) => key && !ignoredKeys.has(key));
  if (!normalizedKeys.length) return false;

  const shallowValues = Object.values(source).flatMap((value) => {
    if (value === null || value === undefined) return [];
    if (typeof value !== "object") return [String(value)];
    return [];
  });
  const textValues = [
    ...Object.keys(source),
    ...shallowValues,
  ].map((value) => normalizeFieldName(value).toLowerCase());

  return normalizedKeys.some((key) => textValues.some((value) => value === key || value.includes(key)));
}

function findMappedControlIdByObjectShape(source, candidateKeys, seen = new WeakSet(), depth = 0) {
  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (!parsed || typeof parsed !== "object" || depth > 6) return "";
  if (seen.has(parsed)) return "";
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findMappedControlIdByObjectShape(item, candidateKeys, seen, depth + 1);
      if (found) return found;
    }
    return "";
  }

  if (isRuntimeMappingObjectForKeys(parsed, candidateKeys)) {
    const preferredKeys = [
      "value",
      "fieldId",
      "fieldID",
      "mappedControlId",
      "mappedControlID",
      "targetControlId",
      "targetControlID",
      "selectedControlId",
      "selectedControlID",
      "realControlId",
      "realControlID",
      "relationControlId",
      "relationControlID",
      "sourceControlId",
      "sourceControlID",
      "id",
      "controlId",
      "controlID",
    ];

    for (const key of preferredKeys) {
      const found = extractMappedControlId(parsed[key]);
      if (found) return found;
    }

    const allValues = getStringValuesDeep(parsed);
    const found = allValues.map(extractMappedControlId).find(Boolean);
    if (found) return found;
  }

  for (const value of Object.values(parsed)) {
    const found = findMappedControlIdByObjectShape(value, candidateKeys, seen, depth + 1);
    if (found) return found;
  }

  return "";
}

function getRuntimeMappedValue(candidateKeys) {
  const sources = getRuntimeMappingSources();
  for (const key of candidateKeys) {
    for (const source of sources) {
      const directValue = source?.[key];
      if (directValue !== undefined && directValue !== null && directValue !== "") {
        return directValue;
      }
    }
  }

  for (const key of candidateKeys) {
    for (const source of sources) {
      const values = collectRuntimeValuesByKey(source, key);
      const found = values.find((value) => extractMappedControlId(value));
      if (found !== undefined) return found;
    }
  }

  for (const source of sources) {
    const found = findMappedControlIdByObjectShape(source, candidateKeys);
    if (found) return found;
  }

  return "";
}

function getRuntimeContextSources() {
  const windowConfig = typeof window !== "undefined" ? window.config || {} : {};
  const windowEnv = typeof window !== "undefined" ? window.env || {} : {};
  return [
    runtimeConfig,
    runtimeConfig?.query,
    runtimeConfig?.params,
    runtimeConfig?.env,
    runtimeConfig?.view,
    runtimeConfig?.worksheet,
    runtimeConfig?.app,
    runtimeConfig?.project,
    runtimeConfig?.customWidgetConfig,
    runtimeConfig?.customWidget,
    windowConfig,
    windowConfig?.query,
    windowConfig?.params,
    windowConfig?.env,
    windowConfig?.view,
    windowConfig?.worksheet,
    windowConfig?.app,
    windowConfig?.project,
    windowConfig?.customWidgetConfig,
    windowConfig?.customWidget,
    runtimeEnv,
    windowEnv,
  ].filter(Boolean);
}

function getObjectValueIgnoreCase(source, key) {
  if (!source || typeof source !== "object") return undefined;
  if (source[key] !== undefined) return source[key];
  const normalizedKey = String(key || "").toLowerCase();
  const matchedEntry = Object.entries(source).find(
    ([sourceKey]) => String(sourceKey || "").toLowerCase() === normalizedKey
  );
  return matchedEntry ? matchedEntry[1] : undefined;
}

function getRuntimeContextValue(candidateKeys) {
  const keys = (Array.isArray(candidateKeys) ? candidateKeys : [candidateKeys]).filter(Boolean);
  const sources = getRuntimeContextSources();

  for (const source of sources) {
    for (const key of keys) {
      const value = getObjectValueIgnoreCase(source, key);
      if (value !== undefined && value !== null && value !== "") {
        if (typeof value === "string" || typeof value === "number") {
          return String(value).trim();
        }
      }
    }
  }

  for (const key of keys) {
    for (const source of sources) {
      const value = collectRuntimeValuesByKey(source, key).find(
        (item) => typeof item === "string" || typeof item === "number"
      );
      if (value !== undefined && value !== null && value !== "") {
        return String(value).trim();
      }
    }
  }

  return "";
}

function getRuntimeDirectContextValue(candidateKeys) {
  const keys = (Array.isArray(candidateKeys) ? candidateKeys : [candidateKeys]).filter(Boolean);
  const sources = getRuntimeContextSources();

  for (const source of sources) {
    for (const key of keys) {
      const value = getObjectValueIgnoreCase(source, key);
      if (value !== undefined && value !== null && value !== "") {
        if (typeof value === "string" || typeof value === "number") {
          return String(value).trim();
        }
      }
    }
  }

  return "";
}

function isMingdaoApiFailure(result) {
  const value = parseMaybeJson(result);
  if (value === false) return true;
  if (!value || typeof value !== "object") return false;
  if (value.data === false || value.result === false) return true;

  const codeKeys = ["resultCode", "code", "errorCode", "error_code"];
  const statusKeys = ["success", "status", "isSuccess", ...codeKeys, "errorMsg", "errorMessage", "error_msg", "exception"];
  const failedByCode = codeKeys.some((key) => {
    if (!(key in value)) return false;
    const numeric = Number(value[key]);
    return Number.isFinite(numeric) && numeric !== 0 && numeric !== 1;
  });
  if (failedByCode) return true;

  if (value.success === false || value.status === false || value.isSuccess === false) return true;
  if (value.errorMsg || value.errorMessage || value.error_msg || value.exception) return true;
  if (
    value.data &&
    typeof value.data === "object" &&
    value.data !== value &&
    statusKeys.some((key) => key in value.data)
  ) {
    return isMingdaoApiFailure(value.data);
  }
  return false;
}

function getMingdaoApiFailureMessage(result) {
  const value = parseMaybeJson(result);
  if (value === false) return "接口返回 false";
  if (!value || typeof value !== "object") return "";

  const directMessage =
    value.errorMsg ||
    value.errorMessage ||
    value.error_msg ||
    value.message ||
    value.msg ||
    value.exception ||
    "";
  if (directMessage) return String(directMessage);
  if (value.data && typeof value.data === "object" && value.data !== value) {
    const nestedMessage = getMingdaoApiFailureMessage(value.data);
    if (nestedMessage) return nestedMessage;
  }

  try {
    return JSON.stringify(value).slice(0, 180);
  } catch (error) {
    return String(value);
  }
}

function assertMingdaoApiSuccess(result, actionName) {
  if (!isMingdaoApiFailure(result)) return;
  const reason = getMingdaoApiFailureMessage(result);
  throw new Error(`${actionName}失败${reason ? `：${reason}` : ""}`);
}

function readStorageJson(key, fallback) {
  if (typeof window === "undefined" || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeStorageJson(key, value) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("save local setting failed", key, error);
  }
}

function getPublicSettingsFromView() {
  const advancedSetting = runtimeConfig?.view?.advancedSetting || {};
  const raw =
    advancedSetting[PUBLIC_SETTING_KEY] ||
    advancedSetting.deliveryLoadingLayout ||
    advancedSetting.customWidgetLayout ||
    "";
  const parsed = parseMaybeJson(raw);
  return parsed && typeof parsed === "object" ? parsed : null;
}

function getPersonalSettingsKey(viewId, worksheetId, userKey) {
  return `${STORAGE_KEYS.personalSettingsPrefix}:${worksheetId || "worksheet"}:${viewId || "view"}:${userKey || "anonymous"}`;
}

function getSavedSettings(viewId, worksheetId, userKey) {
  const scopedPersonal = readStorageJson(getPersonalSettingsKey(viewId, worksheetId, userKey), null);
  return {
    public: null,
    personal:
      scopedPersonal?.templateVersion === STANDARD_TEMPLATE_VERSION ? scopedPersonal : null,
  };
}

function mergeColumns(defaultColumns, savedColumns) {
  if (!Array.isArray(savedColumns) || !savedColumns.length) return defaultColumns;
  const defaultMap = new Map(defaultColumns.map((column) => [column.key, column]));
  const savedKeySet = new Set(savedColumns.map((column) => column?.key).filter(Boolean));
  const next = [];

  savedColumns.forEach((savedColumn) => {
    const base = defaultMap.get(savedColumn?.key);
    if (!base) return;
    next.push({
      ...base,
      width: Number(savedColumn.width) || base.width,
    });
    defaultMap.delete(savedColumn.key);
  });

  defaultColumns.forEach((defaultColumn, defaultIndex) => {
    if (savedKeySet.has(defaultColumn.key)) return;

    const previousKey = [...defaultColumns]
      .slice(0, defaultIndex)
      .reverse()
      .find((column) => next.some((item) => item.key === column.key))?.key;
    const nextKey = defaultColumns
      .slice(defaultIndex + 1)
      .find((column) => next.some((item) => item.key === column.key))?.key;

    if (previousKey) {
      const insertIndex = next.findIndex((item) => item.key === previousKey) + 1;
      next.splice(insertIndex, 0, defaultColumn);
    } else if (nextKey) {
      const insertIndex = next.findIndex((item) => item.key === nextKey);
      next.splice(insertIndex, 0, defaultColumn);
    } else {
      next.push(defaultColumn);
    }
  });

  return next;
}

function areColumnsEqual(leftColumns, rightColumns) {
  if (leftColumns.length !== rightColumns.length) return false;
  return leftColumns.every((column, index) => {
    const nextColumn = rightColumns[index];
    return column.key === nextColumn.key && column.width === nextColumn.width;
  });
}

function getInitialSettings(viewId, worksheetId, userKey) {
  const saved = getSavedSettings(viewId, worksheetId, userKey);
  return saved.personal || {};
}

function getInitialLayout(initialSettings) {
  const saved = initialSettings.layout || {};
  const savedTopHeight = Number(saved.topHeight) || STANDARD_LAYOUT.topHeight;
  return {
    topHeight: Math.max(84, Math.min(STANDARD_LAYOUT.topHeight, savedTopHeight)),
    leftWidth: Number(saved.leftWidth) || STANDARD_LAYOUT.leftWidth,
  };
}

function getInitialHiddenColumns(initialSettings) {
  const saved = initialSettings.hiddenColumns || {};
  return {
    top: Array.isArray(saved.top) ? saved.top : DEFAULT_HIDDEN_COLUMNS.top,
    summary: Array.isArray(saved.summary) ? saved.summary : DEFAULT_HIDDEN_COLUMNS.summary,
    detail: Array.isArray(saved.detail) ? saved.detail : DEFAULT_HIDDEN_COLUMNS.detail,
  };
}

function getInitialColumns(tableName, defaultColumns, initialSettings) {
  const savedColumns = initialSettings.columns?.[tableName];
  return mergeColumns(defaultColumns, savedColumns);
}

function formatDateInputValue(date) {
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(
    date.getDate()
  )}`;
}

function getTodayInputValue() {
  return formatDateInputValue(new Date());
}

function getCurrentUserKey() {
  return (
    getRuntimeContextValue(["accountId", "userId", "userID"]) ||
    "anonymous"
  );
}

async function getWorksheetInfoCached(worksheetId, options = {}) {
  const getWorksheetInfo = runtimeApi.getWorksheetInfo || getWorksheetApiMethod("getWorksheetInfo");
  if (!getWorksheetInfo || !worksheetId) return null;
  const key = `${worksheetId}:${options.getViews ? "views" : "no-views"}`;
  if (!worksheetInfoCache.has(key)) {
    worksheetInfoCache.set(
      key,
      getWorksheetInfo({
        worksheetId,
        getTemplate: true,
        getViews: !!options.getViews,
      }).catch((error) => {
        worksheetInfoCache.delete(key);
        throw error;
      })
    );
  }
  return worksheetInfoCache.get(key);
}

// App 每次渲染都会取这三个 ID；插件页面的应用/工作表/视图在生命周期内不变，
// 取到非空值后复用，避免取不到时每次渲染都深度遍历运行时配置。
const runtimeIdCache = new Map();
function getCachedRuntimeContextValue(cacheKey, candidateKeys) {
  if (runtimeIdCache.has(cacheKey)) return runtimeIdCache.get(cacheKey);
  const value = getRuntimeContextValue(candidateKeys);
  if (value) runtimeIdCache.set(cacheKey, value);
  return value;
}

function getRuntimeAppId() {
  return getCachedRuntimeContextValue("appId", ["appId", "projectId"]);
}

function getRuntimeWorksheetId() {
  return getCachedRuntimeContextValue("worksheetId", ["worksheetId", "worksheetID", "wsId"]);
}

function getRuntimeViewId() {
  return getCachedRuntimeContextValue("viewId", ["viewId", "viewID", "worksheetViewId"]);
}

function getDraftStorageKey(viewId, worksheetId, userKey) {
  return `${STORAGE_KEYS.draftPrefix}:${worksheetId || "worksheet"}:${viewId || "view"}:${userKey}`;
}

function getOptionValue(value) {
  return value === null || value === undefined || value === "" ? "__EMPTY__" : String(value);
}

function getOptionLabel(value) {
  return value === null || value === undefined || value === "" ? "空" : String(value);
}

function normalizeFilterText(value) {
  if (value === "__EMPTY__") return "空";
  return String(value ?? "").trim().toLowerCase();
}

function getFilterCellText(value) {
  return normalizeFilterText(getOptionLabel(value));
}

function matchesFilterText(cellValue, filterValue) {
  const query = normalizeFilterText(filterValue);
  if (!query) return true;
  return getFilterCellText(cellValue).includes(query);
}

function compareCnText(left, right) {
  return String(left || "").localeCompare(String(right || ""), "zh-Hans-CN", {
    numeric: true,
    sensitivity: "base",
  });
}

function getCustomerSortText(source) {
  return source?.clientCode || source?.clientShortName || source?.client || source?.clientName || "";
}

function normalizeCustomerGroupText(value) {
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function getAddressIndependentCustomerText(source) {
  const candidate =
    normalizeCustomerGroupText(source?.clientShortName) ||
    normalizeCustomerGroupText(source?.client) ||
    normalizeCustomerGroupText(source?.clientName);
  const address = normalizeCustomerGroupText(source?.address);
  if (!candidate || !address) return candidate;
  return candidate.replace(address, "") || candidate;
}

function getCustomerGroupKey(source) {
  return getAddressIndependentCustomerText(source) || "未识别客户";
}

function getDetailOrderSortText(row) {
  return row?.workOrder || row?.purchaseOrder || "";
}

function compareCustomerGroups(left, right) {
  return (
    compareCnText(getCustomerSortText(left), getCustomerSortText(right)) ||
    compareCnText(left?.clientShortName, right?.clientShortName) ||
    compareCnText(left?.clientName, right?.clientName) ||
    compareCnText(left?.route, right?.route)
  );
}

function compareDetailRows(left, right) {
  return (
    compareCnText(getCustomerSortText(left), getCustomerSortText(right)) ||
    compareCnText(left?.productName, right?.productName) ||
    compareCnText(getDetailOrderSortText(left), getDetailOrderSortText(right)) ||
    compareCnText(left?.size, right?.size) ||
    compareCnText(left?.model, right?.model) ||
    compareCnText(left?.id, right?.id)
  );
}

function getSearchParam(key) {
  const search = new URLSearchParams(window.location.search);
  if (search.get(key)) return search.get(key);
  const hashQuery = window.location.hash.includes("?")
    ? window.location.hash.split("?")[1]
    : "";
  const hashSearch = new URLSearchParams(hashQuery);
  return hashSearch.get(key);
}

function getCurrentRowId() {
  const fromConfig = getRuntimeDirectContextValue([
    "rowId",
    "rowID",
    "recordId",
    "recordID",
    "activeRowId",
    "currentRowId",
    "sourceId",
    "rowid",
  ]);
  if (fromConfig) return fromConfig;

  const fromQuery =
    getSearchParam("rowId") ||
    getSearchParam("recordId") ||
    getSearchParam("rowid");
  if (fromQuery) return fromQuery;

  return "";
}

function getControlsFromResponse(response) {
  const directControls =
    response?.template?.controls ||
    response?.template?.template?.controls ||
    response?.data?.template?.controls ||
    response?.data?.data?.template?.controls ||
    response?.data?.worksheet?.template?.controls ||
    response?.data?.data?.worksheet?.template?.controls ||
    response?.data?.worksheetInfo?.template?.controls ||
    response?.data?.data?.worksheetInfo?.template?.controls ||
    response?.worksheetInfo?.template?.controls ||
    response?.worksheet?.template?.controls ||
    response?.controls ||
    response?.data?.controls ||
    response?.data?.data?.controls ||
    response?.result?.controls ||
    response?.result?.template?.controls ||
    response?.result?.worksheet?.template?.controls ||
    response?.result?.worksheetInfo?.template?.controls ||
    runtimeConfig?.worksheetInfo?.template?.controls ||
    [];
  if (Array.isArray(directControls) && directControls.length) return directControls;

  const deepControls = findArrayByPreferredKeys(response, CONTROL_ARRAY_KEYS, isControlLikeArray);
  if (deepControls.length) return deepControls;

  return (
    runtimeConfig?.worksheetInfo?.template?.controls ||
    []
  );
}

function getViewsFromResponse(response) {
  return (
    response?.views ||
    response?.worksheetInfo?.views ||
    response?.worksheet?.views ||
    response?.template?.views ||
    runtimeConfig?.worksheetInfo?.views ||
    runtimeConfig?.views ||
    []
  );
}

function getViewName(view) {
  return String(view?.name || view?.viewName || view?.title || "").trim();
}

function getViewIdValue(view) {
  return view?.viewId || view?.id || "";
}

const ROW_ARRAY_KEYS = [
  "rows",
  "list",
  "data",
  "relationRows",
  "rowDatas",
  "rowData",
  "resultData",
  "records",
  "items",
];

const CONTROL_ARRAY_KEYS = ["controls", "rowData", "controlValues", "receiveControls"];

function isControlLikeArray(value) {
  return (
    Array.isArray(value) &&
    value.some(
      (item) =>
        item &&
        typeof item === "object" &&
        getControlIdFromItem(item) &&
        (getControlName(item) || item.type !== undefined || item.valueType !== undefined)
    )
  );
}

function isRowLikeArray(value) {
  return (
    Array.isArray(value) &&
    value.some((item) => {
      if (!item || typeof item !== "object") return false;
      if (getRowIdValue(item)) return true;
      if (Array.isArray(item.rowData) || Array.isArray(item.controlValues) || Array.isArray(item.receiveControls)) {
        return true;
      }
      return !!(item.rowid || item.rowId || item.recordId || item.name || item.rowtitle || item.title);
    })
  );
}

function findArrayByPreferredKeys(source, preferredKeys, validate, seen = new WeakSet(), depth = 0) {
  if (!source || depth > 7) return [];
  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed)) return validate(parsed) ? parsed : [];
  if (seen.has(parsed)) return [];
  seen.add(parsed);

  for (const key of preferredKeys) {
    const value = parsed[key];
    if (Array.isArray(value) && validate(value)) return value;
    const nested = findArrayByPreferredKeys(value, preferredKeys, validate, seen, depth + 1);
    if (nested.length) return nested;
  }

  for (const value of Object.values(parsed)) {
    const nested = findArrayByPreferredKeys(value, preferredKeys, validate, seen, depth + 1);
    if (nested.length) return nested;
  }

  return [];
}

function getRowsFromResponse(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.rows)) return response.rows;
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.data?.rows)) return response.data.rows;
  if (Array.isArray(response?.data?.data)) return response.data.data;
  if (Array.isArray(response?.data?.data?.rows)) return response.data.data.rows;
  if (Array.isArray(response?.data?.data?.list)) return response.data.data.list;
  if (Array.isArray(response?.data?.list)) return response.data.list;
  if (Array.isArray(response?.list)) return response.list;
  if (Array.isArray(response?.relationRows)) return response.relationRows;
  if (Array.isArray(response?.data?.relationRows)) return response.data.relationRows;
  if (Array.isArray(response?.data?.data?.relationRows)) return response.data.data.relationRows;
  if (Array.isArray(response?.rowDatas)) return response.rowDatas;
  if (Array.isArray(response?.data?.rowDatas)) return response.data.rowDatas;
  if (Array.isArray(response?.data?.data?.rowDatas)) return response.data.data.rowDatas;
  if (Array.isArray(response?.rowData)) return response.rowData;
  if (Array.isArray(response?.resultData)) return response.resultData;
  if (Array.isArray(response?.result?.rows)) return response.result.rows;
  if (Array.isArray(response?.result?.data)) return response.result.data;
  if (Array.isArray(response?.result?.list)) return response.result.list;
  if (Array.isArray(response?.result?.relationRows)) return response.result.relationRows;
  const deepRows = findArrayByPreferredKeys(response, ROW_ARRAY_KEYS, isRowLikeArray);
  if (deepRows.length) return deepRows;
  return [];
}

function getTotalCountFromResponse(response) {
  const candidates = [
    response?.total,
    response?.count,
    response?.rowCount,
    response?.totalCount,
    response?.allCount,
    response?.data?.total,
    response?.data?.count,
    response?.data?.rowCount,
    response?.data?.totalCount,
    response?.data?.allCount,
    response?.data?.data?.total,
    response?.data?.data?.count,
    response?.data?.data?.rowCount,
    response?.data?.data?.totalCount,
    response?.data?.data?.allCount,
    response?.result?.total,
    response?.result?.count,
    response?.result?.rowCount,
    response?.result?.totalCount,
  ];
  const numeric = candidates
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0);
  return numeric === undefined ? null : numeric;
}

function getStableRowIdentity(row) {
  return getRowIdValue(row) || row?.sourcevalue || row?.sid || row?.uuid || "";
}

async function fetchAllPagedRows(fetchPage, pageSize) {
  const allRows = [];
  const seenIds = new Set();
  const seenPageSignatures = new Set();
  let controls = [];
  let totalCount = null;

  for (let pageIndex = 1; ; pageIndex += 1) {
    const response = await fetchPage(pageIndex, pageSize);
    const rows = getRowsFromResponse(response);
    const pageControls = getControlsFromResponse(response);
    const stablePageIds = rows.map(getStableRowIdentity).filter(Boolean);
    const pageSignature = stablePageIds.length
      ? stablePageIds.join("|")
      : "";
    controls = mergeControls(controls, pageControls);
    const responseTotal = getTotalCountFromResponse(response);
    if (responseTotal !== null) totalCount = responseTotal;

    let addedCount = 0;
    rows.forEach((row) => {
      const rowIdentity = getStableRowIdentity(row);
      if (rowIdentity && seenIds.has(rowIdentity)) return;
      if (rowIdentity) seenIds.add(rowIdentity);
      allRows.push(row);
      addedCount += 1;
    });

    if (!rows.length || rows.length < pageSize) break;
    if (!addedCount) break;
    if (pageSignature && seenPageSignatures.has(pageSignature)) break;
    if (pageSignature) seenPageSignatures.add(pageSignature);
    if (totalCount !== null && allRows.length >= totalCount) break;
  }

  return { rows: allRows, controls, totalCount };
}

function scheduleAfterFirstPaint(callback, delay = RELATION_BACKGROUND_DELAY) {
  if (typeof window === "undefined") return () => {};

  let timeoutId = 0;
  let idleId = 0;
  const run = () => {
    timeoutId = window.setTimeout(callback, delay);
  };

  if (typeof window.requestIdleCallback === "function") {
    idleId = window.requestIdleCallback(run, { timeout: 900 });
  } else {
    timeoutId = window.setTimeout(callback, delay);
  }

  return () => {
    window.clearTimeout(timeoutId);
    if (idleId && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleId);
    }
  };
}

// 前台操作让路：勾选/装载量保存、主表合计保存、装载流程进行中时，后台逐条补读
// 明细（每条一次 getRowDetail/getRowRelationRows，几十到上百个请求）暂停派发新请求。
// 插件的所有接口都经同一条通道转发给明道云；补读占满通道时，操作员勾选后的
// 保存和装载前的核对都要排队，实测通道拥挤时装载从 2 秒拖到十几秒乃至一分多钟。
let foregroundWorkCount = 0;
let foregroundIdleWaiters = [];
function beginForegroundWork() {
  foregroundWorkCount += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    foregroundWorkCount = Math.max(0, foregroundWorkCount - 1);
    if (foregroundWorkCount) return;
    const waiters = foregroundIdleWaiters;
    foregroundIdleWaiters = [];
    waiters.forEach((resolve) => resolve());
  };
}

function waitForForegroundIdle() {
  if (!foregroundWorkCount) return Promise.resolve();
  return new Promise((resolve) => foregroundIdleWaiters.push(resolve));
}

// Related records can be numerous. Keeping the background enrichment queue
// bounded prevents it from competing with the first screen's rendering.
// 只用于后台补读显示字段；每取一条之前先等前台操作结束。
async function mapWithConcurrency(items, concurrency, mapper, shouldCancel = () => false) {
  const list = Array.isArray(items) ? items : [];
  // Preserve the original row for work that is intentionally skipped after a
  // view is closed. Consumers can keep rendering without a partial-array bug.
  const results = list.slice();
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency || 1), list.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < list.length) {
        if (shouldCancel()) break;
        await waitForForegroundIdle();
        if (shouldCancel() || nextIndex >= list.length) break;
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(list[index], index);
      }
    })
  );
  return results;
}

function getCellsFromRow(row) {
  const candidates = [
    row?.rowData,
    row?.controlValues,
    row?.receiveControls,
    row?.data?.rowData,
    row?.data?.controlValues,
    row?.data?.receiveControls,
    row?.row?.rowData,
    row?.row?.controlValues,
    row?.row?.receiveControls,
    row?.record?.rowData,
    row?.record?.controlValues,
    row?.record?.receiveControls,
    row?.cells,
    row?.fields,
    row?.controls,
  ].filter(Array.isArray);
  const merged = new Map();
  const loose = [];

  candidates.flat().forEach((cell) => {
    if (!cell || typeof cell !== "object") return;
    const key = getCellIdentity(cell);
    if (!key) {
      loose.push(cell);
      return;
    }

    const current = merged.get(key);
    const currentRaw = getRawCellValue(current);
    const nextRaw = getRawCellValue(cell);
    if (
      !current ||
      (currentRaw === "" || currentRaw === null || currentRaw === undefined) ||
      (nextRaw !== "" && nextRaw !== null && nextRaw !== undefined)
    ) {
      merged.set(key, { ...current, ...cell });
    }
  });

  return [...Array.from(merged.values()), ...loose];
}

// Row-detail responses also carry the worksheet template in `controls`.
// That template is useful for rendering, but must never be copied into a new
// record: it includes empty/read-only fields and makes addWorksheetRow both
// slow and unreliable. Splitting needs the source record's real values only.
function getRecordCellsOnly(row) {
  const recordValueContainers = [
    row?.rowData,
    row?.controlValues,
    row?.receiveControls,
    row?.data?.rowData,
    row?.data?.controlValues,
    row?.data?.receiveControls,
    row?.data?.data?.rowData,
    row?.data?.data?.controlValues,
    row?.row?.rowData,
    row?.row?.controlValues,
    row?.row?.receiveControls,
    row?.record?.rowData,
    row?.record?.controlValues,
    row?.record?.receiveControls,
    row?.cells,
    row?.fields,
  ].filter(Array.isArray);

  return getCellsFromRow({ rowData: recordValueContainers.flat() });
}

function getCellByControlId(source, controlId, depth = 0) {
  if (!source || !controlId || depth > 5) return null;

  if (Array.isArray(source)) {
    const directMatches = source.filter(
      (item) =>
        item?.controlId === controlId ||
        item?.sourceControlId === controlId ||
        item?.sourceControl?.controlId === controlId ||
        item?.originControlId === controlId ||
        item?.originControl?.controlId === controlId ||
        item?.cid === controlId ||
        item?.id === controlId
    );
    const directMatch =
      directMatches.find((item) => {
        const raw = getRawCellValue(item);
        return raw !== "" && raw !== null && raw !== undefined;
      }) || directMatches[0];
    if (directMatch) return directMatch;

    for (const item of source) {
      const nested = [
        item?.value,
        item?.controlValue,
        item?.sourceValue,
        item?.originValue,
        item?.originalValue,
        item?.data,
        item?.row,
        item?.record,
      ];
      for (const candidate of nested) {
        const found = getCellByControlId(parseMaybeJson(candidate), controlId, depth + 1);
        if (found) return found;
      }
    }

    return null;
  }

  const cells = getCellsFromRow(source);
  if (Array.isArray(cells) && cells.length) {
    const found = getCellByControlId(cells, controlId, depth + 1);
    if (found) return found;
  }

  if (source[controlId] !== undefined) {
    return { value: source[controlId] };
  }

  const nested = [
    source.value,
    source.controlValue,
    source.sourceValue,
    source.originValue,
    source.originalValue,
    source.data,
    source.row,
    source.record,
  ];
  for (const candidate of nested) {
    const found = getCellByControlId(parseMaybeJson(candidate), controlId, depth + 1);
    if (found) return found;
  }

  return null;
}

function getCellValue(source, controlId) {
  const cell = getCellByControlId(source, controlId);
  if (!cell) return "";
  return (
    cell.value ??
    cell.controlValue ??
    cell.sourceValue ??
    cell.sourcevalue ??
    cell.originValue ??
    cell.text ??
    cell.displayValue ??
    cell.originalValue ??
    ""
  );
}

function getDisplayTextFromParsedValue(value, fallback = "", depth = 0) {
  const fallbackText = getCleanDisplayText(fallback);
  if (value === null || value === undefined || value === "") return fallbackText;
  if (depth > 4) return "";

  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (Array.isArray(parsed)) {
    const labels = parsed
      .map((item) => getDisplayTextFromParsedValue(item, "", depth + 1))
      .filter(Boolean);
    return labels.length ? labels.join("、") : fallbackText;
  }

  if (parsed && typeof parsed === "object") {
    const direct =
      parsed.name ||
      parsed.fullname ||
      parsed.title ||
      parsed.rowtitle ||
      parsed.displayValue ||
      parsed.text ||
      parsed.label ||
      "";
    const directText = direct && typeof direct !== "object" ? String(direct) : "";
    if (isMeaningfulDisplayText(directText)) return directText;

    const nested =
      parsed.sourcevalue ||
      parsed.sourceValue ||
      parsed.originValue ||
      parsed.originalValue ||
      parsed.row ||
      parsed.record ||
      parsed.data ||
      "";
    const nestedText = getDisplayTextFromParsedValue(nested, "", depth + 1);
    if (nestedText) return nestedText;

    const valueText = getDisplayTextFromParsedValue(parsed.value, "", depth + 1);
    if (isMeaningfulDisplayText(valueText)) return valueText;

    const cells = getCellsFromRow(parsed);
    if (Array.isArray(cells) && cells.length) {
      const cellText = cells
        .map((cell) =>
          getDisplayTextFromParsedValue(
            cell?.displayValue ?? cell?.text ?? cell?.value ?? cell?.controlValue,
            "",
            depth + 1
          )
        )
        .find(Boolean);
      if (cellText) return cellText;
    }

    return fallbackText || (isMeaningfulDisplayText(directText) ? directText : "");
  }

  const text = String(parsed).trim();
  if (isPlaceholderDisplayText(text)) return fallbackText;
  if (fallbackText && (isLikelyIdText(text) || /^[a-zA-Z0-9_-]{1,64}$/.test(text))) {
    return fallbackText;
  }
  return text;
}

function getNumericTextFromParsedValue(value, depth = 0) {
  if (value === null || value === undefined || value === "") return "";
  if (depth > 4) return "";

  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => getNumericTextFromParsedValue(item, depth + 1))
      .find(Boolean) || "";
  }

  if (parsed && typeof parsed === "object") {
    const candidates = [
      parsed.displayValue,
      parsed.text,
      parsed.sourcevalue,
      parsed.sourceValue,
      parsed.originValue,
      parsed.originalValue,
      parsed.value,
      parsed.controlValue,
    ];

    for (const candidate of candidates) {
      const text = getNumericTextFromParsedValue(candidate, depth + 1);
      if (text) return text;
    }

    const cells = getCellsFromRow(parsed);
    if (Array.isArray(cells) && cells.length) {
      return cells
        .map((cell) => getNumericTextFromParsedValue(getRawCellValue(cell), depth + 1))
        .find(Boolean) || "";
    }

    return "";
  }

  const text = String(parsed || "").trim();
  return /\d/.test(text) ? text : "";
}

function getTextValue(source, controlId) {
  const cell = getCellByControlId(source, controlId);
  const raw = parseMaybeJson(getCellValue(source, controlId));
  const displayText =
    cell?.displayValue || cell?.text || cell?.label || cell?.name || "";
  return getDisplayTextFromParsedValue(raw, displayText);
}

function getRelationArray(source, controlId) {
  const cell = getCellByControlId(source, controlId);
  const raw = parseMaybeJson(getRawCellValue(cell) || getCellValue(source, controlId));
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return [raw];
  const nestedRows = getRowsFromResponse(cell);
  if (nestedRows.length) return nestedRows;
  return [];
}

function getRelationRowIds(source, controlId) {
  const seen = new Set();
  const visit = (value) => {
    const parsed = parseMaybeJson(value);
    if (Array.isArray(parsed)) {
      parsed.forEach(visit);
      return;
    }
    if (parsed && typeof parsed === "object") {
      const rowId = getRowIdValue(parsed) || parsed.sid || parsed.rowid || parsed.rowId || "";
      if (rowId) seen.add(String(rowId));
      // Some relation APIs return a nested value rather than the row object.
      if (!rowId && parsed.value !== undefined) visit(parsed.value);
      return;
    }
    const text = String(parsed || "").trim();
    if (text) seen.add(text);
  };
  visit(getRelationArray(source, controlId));
  const cell = getCellByControlId(source, controlId);
  visit(cell?.sourceValue);
  visit(cell?.sourcevalue);
  return Array.from(seen);
}

function getNumberValue(source, controlId) {
  const parsed = getNumberValueOrNull(source, controlId);
  return parsed === null ? 0 : parsed;
}

function parseNumberValue(value) {
  const raw = parseMaybeJson(value);
  const text =
    Array.isArray(raw) || (raw && typeof raw === "object")
      ? getNumericTextFromParsedValue(raw)
      : String(raw || "");
  const numeric = Number(String(text).replace(/[^\d.-]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function getNumberValueOrNull(source, controlId) {
  if (!source || !controlId) return null;
  const cell = getCellByControlId(source, controlId);
  if (!cell) return null;

  // Lookup (type 30) and formula (type 31) controls frequently leave `value`
  // empty and place their computed number in displayValue/sourcevalue instead.
  // Try every standard Mingdao representation before deciding the cell is empty.
  const candidates = [
    cell.value,
    cell.controlValue,
    cell.sourceValue,
    cell.sourcevalue,
    cell.originValue,
    cell.originalValue,
    cell.displayValue,
    cell.text,
    getCellValue(source, controlId),
    getRawCellValue(cell),
  ];

  for (const raw of candidates) {
    if (raw === null || raw === undefined || raw === "") continue;
    const numericText = getNumericTextFromParsedValue(raw);
    if (!numericText) continue;
    return parseNumberValue(raw);
  }

  return null;
}

// 性能：normalizeDetailRows 对每条明细、每个字段名候选都要把整张明细表的字段
// （上百个）重新规范化一遍，250 条明细时仅这一项就把浏览器卡住 2 秒以上，
// 是“页面无响应”的主要来源。字段名是有限集合，规范化结果按原文缓存。
const normalizedFieldNameCache = new Map();
function normalizeFieldName(name) {
  const text = String(name || "");
  let normalized = normalizedFieldNameCache.get(text);
  if (normalized === undefined) {
    normalized = text.replace(/\s+/g, "").replace(/棱/g, "楞").trim();
    if (normalizedFieldNameCache.size > 20000) normalizedFieldNameCache.clear();
    normalizedFieldNameCache.set(text, normalized);
  }
  return normalized;
}

function getControlName(control) {
  return String(
    control?.controlName ||
      control?.sourceControlName ||
      control?.sourceName ||
      control?.fieldName ||
      control?.alias ||
      control?.name ||
      control?.title ||
      control?.label ||
      control?.sourceControl?.controlName ||
      control?.sourceControl?.name ||
      control?.sourceControl?.title ||
      control?.originControl?.controlName ||
      control?.originControl?.name ||
      ""
  );
}

function getControlIdFromItem(item) {
  return item?.controlId || item?.cid || item?.id || item?.sourceControlId || item?.sourceControl?.controlId || "";
}

function getRawCellValue(cell) {
  return (
    cell?.value ??
    cell?.controlValue ??
    cell?.sourceValue ??
    cell?.sourcevalue ??
    cell?.originValue ??
    cell?.text ??
    cell?.displayValue ??
    cell?.originalValue ??
    ""
  );
}

function isExcludedFieldName(name, excludeNames = []) {
  const normalizedName = normalizeFieldName(name);
  return excludeNames.some((excludeName) => normalizedName.includes(normalizeFieldName(excludeName)));
}

// 同一个字段模板数组（接口返回或 mergeControls 生成，之后不再修改）按“候选名+排除名”
// 查字段的结果固定不变。normalizeDetailRows 会对每一行用同样的参数重复查询，
// 这里按数组身份缓存，结果与逐次查找完全相同。
const controlsByNamesCache = new WeakMap();
function findControlByNames(controls, names, excludeNames = []) {
  if (!Array.isArray(controls)) return findControlByNamesUncached(controls, names, excludeNames);
  let cache = controlsByNamesCache.get(controls);
  if (!cache) {
    cache = new Map();
    controlsByNamesCache.set(controls, cache);
  }
  const cacheKey = `${names.join("\u0001")}\u0002${excludeNames.join("\u0001")}\u0002${controls.length}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const matched = findControlByNamesUncached(controls, names, excludeNames);
  cache.set(cacheKey, matched);
  return matched;
}

function findControlByNamesUncached(controls, names, excludeNames = []) {
  const safeControls = Array.isArray(controls) ? controls : [];
  const normalizedNames = names.map(normalizeFieldName).filter(Boolean);
  const candidates = safeControls.filter((control) => {
    const controlName = getControlName(control);
    const normalizedControlName = normalizeFieldName(controlName);
    return (
      normalizedControlName &&
      !isExcludedFieldName(controlName, excludeNames) &&
      normalizedNames.some((name) => normalizedControlName.includes(name))
    );
  });

  return (
    candidates.find((control) =>
      normalizedNames.some((name) => normalizeFieldName(getControlName(control)) === name)
    ) ||
    candidates[0] ||
    null
  );
}

function findControlIdByNames(controls, names) {
  const matched = findControlByNames(controls, names);
  return getControlIdFromItem(matched);
}

function findCellControlIdByNames(source, names, excludeNames = []) {
  return getControlIdFromItem(getCellByNames(source, names, excludeNames));
}

function findControlIdByNamesExcluding(controls, names, excludeNames = []) {
  const matched = findControlByNames(controls, names, excludeNames);
  return getControlIdFromItem(matched);
}

function getCellByNames(source, names, excludeNames = []) {
  const cells = getCellsFromRow(source);
  if (!Array.isArray(cells) || !cells.length) return null;
  return (
    // 每次都是新映射出来的数组，缓存命中不了，直接查找。
    findControlByNamesUncached(
      cells.map((cell) => ({
        ...cell,
        controlName: getControlName(cell),
      })),
      names,
      excludeNames
    ) || null
  );
}

function findControlIdByNamesFromRows(rows, names, excludeNames = []) {
  const normalizedNames = names.map(normalizeFieldName).filter(Boolean);
  const safeRows = Array.isArray(rows) ? rows : [];

  for (const row of safeRows) {
    const cells = getCellsFromRow(row);
    if (!Array.isArray(cells) || !cells.length) continue;

    for (const cell of cells) {
      const controlName = getControlName(cell);
      const normalizedControlName = normalizeFieldName(controlName);
      if (
        normalizedControlName &&
        !isExcludedFieldName(controlName, excludeNames) &&
        normalizedNames.some((name) => normalizedControlName.includes(name))
      ) {
        return getControlIdFromItem(cell);
      }
    }
  }

  return "";
}

function findDetailModelControlId(controls, rows) {
  return (
    findControlIdByNames(controls, MODEL_FIELD_NAMES) ||
    findControlIdByNamesFromRows(rows, MODEL_FIELD_NAMES) ||
    ""
  );
}

function findControlIdByHints(controls, rows, controlIds = []) {
  const hints = controlIds.map(normalizeControlId).filter(Boolean);
  if (!hints.length) return "";

  for (const controlId of hints) {
    if (getControlById(controls, controlId)) return controlId;
    if ((Array.isArray(rows) ? rows : []).some((row) => getCellByControlId(row, controlId))) {
      return controlId;
    }
  }

  return "";
}

function resolveDetailControlId(mappedControlId, controls, rows, names, excludeNames = [], hintControlIds = []) {
  // Plugin parameters are selected from the host worksheet and can therefore
  // point at a field that does not exist on the related “装车明细” row.  Only
  // trust an explicit mapping after proving the same control is present in
  // the current detail worksheet; otherwise recover by matching the detail
  // field name itself.
  const verifiedMappedControlId = findControlIdByHints(controls, rows, [mappedControlId]);
  return (
    verifiedMappedControlId ||
    findControlIdByNamesExcluding(controls, names, excludeNames) ||
    findControlIdByNamesFromRows(rows, names, excludeNames) ||
    findControlIdByHints(controls, rows, hintControlIds) ||
    ""
  );
}

function getCellIdentity(cell) {
  return getControlIdFromItem(cell) || cell?.sourceControlId || getControlName(cell);
}

function mergeCells(baseCells, extraCells) {
  const merged = new Map();
  (Array.isArray(baseCells) ? baseCells : []).forEach((cell) => {
    const key = getCellIdentity(cell);
    if (key) merged.set(key, cell);
  });
  (Array.isArray(extraCells) ? extraCells : []).forEach((cell) => {
    const key = getCellIdentity(cell);
    if (!key) return;
    const current = merged.get(key);
    const nextRaw = getRawCellValue(cell);
    if (!current || (nextRaw !== null && nextRaw !== undefined && nextRaw !== "")) {
      merged.set(key, { ...current, ...cell });
    }
  });
  return Array.from(merged.values());
}

function mergeControls(baseControls, extraControls) {
  const merged = new Map();
  [...(Array.isArray(baseControls) ? baseControls : []), ...(Array.isArray(extraControls) ? extraControls : [])]
    .forEach((control) => {
      const key = getControlIdFromItem(control) || getControlName(control);
      if (key && !merged.has(key)) merged.set(key, control);
    });
  return Array.from(merged.values());
}

async function hydrateRelationRowDetails({ rows, controls, appId, worksheetId, viewId, shouldCancel }) {
  const getRowDetail = runtimeApi.getRowDetail || getWorksheetApiMethod("getRowDetail");
  if (!getRowDetail || !worksheetId || !Array.isArray(rows) || !rows.length) {
    return { rows, controls };
  }

  const details = await mapWithConcurrency(rows, DETAIL_HYDRATE_CONCURRENCY, async (row) => {
      if (shouldCancel?.()) return null;
      const rowId = getRowIdValue(row);
      if (!rowId) return null;
      const rowWorksheetId = getWorksheetIdValue(row) || worksheetId;
      const worksheetIds = Array.from(
        new Set([
          rowWorksheetId,
          worksheetId,
        ].filter(Boolean))
      );
      const attempts = [
        ...worksheetIds.map((targetWorksheetId) => ({
          worksheetId: targetWorksheetId,
          rowId,
          getTemplate: true,
        })),
        ...worksheetIds.map((targetWorksheetId) => ({
          appId,
          worksheetId: targetWorksheetId,
          rowId,
          getTemplate: true,
        })),
        ...worksheetIds.map((targetWorksheetId) => ({
          appId,
          worksheetId: targetWorksheetId,
          viewId,
          rowId,
          getTemplate: true,
        })),
      ];
      const mergedDetails = [];

      for (const params of attempts) {
        if (shouldCancel?.()) break;
        try {
          const detail = await getRowDetail(params);
          if (detail) {
            mergedDetails.push(detail);
            // A successful detail response already includes the row payload.
            // Do not refetch the same row with equivalent API signatures.
            break;
          }
        } catch (error) {
          console.warn("hydrate relation row detail failed", rowId, params, error);
        }
      }

      if (!mergedDetails.length) return null;
      const mergedCells = mergedDetails.reduce(
        (cells, detail) => mergeCells(cells, getCellsFromRow(detail)),
        []
      );
      const mergedControls = mergedDetails.reduce(
        (currentControls, detail) => mergeControls(currentControls, getControlsFromResponse(detail)),
        []
      );
      return {
        ...mergedDetails[0],
        rowData: mergedCells,
        controlValues: mergedCells,
        controls: mergedControls,
      };
    }, shouldCancel);

  const hydratedControls = details.reduce(
    (mergedControls, detail) =>
      mergeControls(mergedControls, detail?.controls || getControlsFromResponse(detail)),
    controls
  );
  const hydratedRows = rows.map((row, index) => {
    const detail = details[index];
    if (!detail) return row;
    const mergedCells = mergeCells(getCellsFromRow(row), getCellsFromRow(detail));
    return {
      ...row,
      ...detail,
      id: getRowIdValue(row) || getRowIdValue(detail),
      rowid: getRowIdValue(row) || getRowIdValue(detail),
      worksheetId: getWorksheetIdValue(row) || getWorksheetIdValue(detail) || worksheetId,
      rowData: mergedCells,
      controlValues: mergedCells,
    };
  });

  return { rows: hydratedRows, controls: hydratedControls };
}

function getDetailStatusFromSource(row, controls, controlId, statusNames) {
  return (
    getOptionalTextValue(row, controls, controlId, statusNames) ||
    getTextValueByNames(row, controls, statusNames) ||
    ""
  );
}

async function hydrateProductionStatusFromWorkOrder(rows, controls, detailWorksheetId, statusNames, shouldCancel) {
  if (!runtimeApi.getRowRelationRows || !Array.isArray(rows) || !rows.length) {
    return rows;
  }

  return mapWithConcurrency(rows, DETAIL_HYDRATE_CONCURRENCY, async (row) => {
      if (shouldCancel?.()) return row;
      if (row.productionStatus) return row;
      const workOrderControlId = row?.fieldMap?.workOrder;
      const rowWorksheetId = row.worksheetId || detailWorksheetId;
      if (!row?.id || !rowWorksheetId || !workOrderControlId) return row;

      try {
        const response = await runtimeApi.getRowRelationRows({
          worksheetId: rowWorksheetId,
          rowId: row.id,
          controlId: workOrderControlId,
          pageIndex: 1,
          pageSize: 20,
          keywords: "",
          getWorksheet: true,
          sortId: "",
          isAsc: false,
          shareId: "",
          linkId: "",
          filterControls: [],
          getRules: false,
          fastFilters: [],
        });
        const workOrderRows = getRowsFromResponse(response);
        const workOrderControls = getControlsFromResponse(response);
        const statusText =
          workOrderRows
            .map((workOrderRow) => getTextValueByNames(workOrderRow, workOrderControls, statusNames))
            .find(Boolean) || "";
        return statusText ? { ...row, productionStatus: statusText } : row;
      } catch (error) {
        console.warn("hydrate production status from work order failed", row.id, error);
        return row;
      }
    }, shouldCancel);
}

function getRowSearchText(row) {
  const direct = [
    row?.rowtitle,
    row?.title,
    row?.name,
    row?.workOrder,
    row?.productName,
  ];
  const cellTexts = getCellsFromRow(row).map((cell) =>
    getDisplayTextFromParsedValue(getRawCellValue(cell), cell?.displayValue || cell?.text || "")
  );
  return [...direct, ...cellTexts].filter(Boolean).join(" ");
}

async function fetchWorksheetRowsByKeyword(worksheetId, keyword) {
  const getFilterRows = runtimeApi.getFilterRows || getWorksheetApiMethod("getFilterRows");
  if (!getFilterRows || !worksheetId || !keyword) return { rows: [], controls: [] };

  const attempts = [
    {
      worksheetId,
      pageSize: 20,
      pageIndex: 1,
      sortId: "",
      isAsc: false,
      notGetTotal: true,
      keyWords: keyword,
    },
    {
      worksheetId,
      viewId: "",
      pageSize: 20,
      pageIndex: 1,
      sortId: "",
      isAsc: false,
      notGetTotal: true,
      keyWords: keyword,
    },
    getRuntimeAppId()
      ? {
          appId: getRuntimeAppId(),
          worksheetId,
          pageSize: 20,
          pageIndex: 1,
          sortId: "",
          isAsc: false,
          notGetTotal: true,
          keyWords: keyword,
        }
      : null,
  ].filter(Boolean);

  for (const params of attempts) {
    try {
      const response = await getFilterRows(params);
      const rows = getRowsFromResponse(response);
      if (rows.length) {
        return { rows, controls: getControlsFromResponse(response) };
      }
    } catch (error) {
      console.warn("fetch worksheet rows by keyword failed", params, error);
    }
  }

  return { rows: [], controls: [] };
}

async function fetchLookupRecordTitle(worksheetId, rowId) {
  const getRowDetail = runtimeApi.getRowDetail || getWorksheetApiMethod("getRowDetail");
  if (!getRowDetail || !worksheetId || !rowId) return "";

  const attempts = [
    { worksheetId, rowId, getTemplate: true },
    { appId: getRuntimeAppId(), worksheetId, rowId, getTemplate: true },
  ];

  for (const params of attempts) {
    try {
      const detail = await getRowDetail(params);
      const title = getReadableRowTitle(detail);
      if (title) return title;
    } catch (error) {
      console.warn("fetch lookup record title failed", params, error);
    }
  }

  return "";
}

async function fetchLookupWorksheetControls(worksheetId) {
  const cacheKey = `controls:${worksheetId}`;
  if (worksheetControlsCache.has(cacheKey)) {
    return worksheetControlsCache.get(cacheKey);
  }
  const getWorksheetInfo = runtimeApi.getWorksheetInfo || getWorksheetApiMethod("getWorksheetInfo");
  const getWorksheetControls = runtimeApi.getWorksheetControls || getWorksheetApiMethod("getWorksheetControls");
  if ((!getWorksheetInfo && !getWorksheetControls) || !worksheetId) return [];

  const baseParams = {
    worksheetId,
    relationWorksheetId: "",
    getTemplate: true,
    getViews: false,
    appId: getRuntimeAppId(),
    handleDefault: false,
    worksheetIds: [],
    handControlSource: true,
    getRules: false,
    getSwitchPermit: false,
    getRelationSearch: false,
    resultType: 0,
  };

  const attempts = [
    { method: getWorksheetInfo, params: baseParams },
    { method: getWorksheetInfo, params: { worksheetId, getTemplate: true, handControlSource: true } },
    { method: getWorksheetControls, params: baseParams },
    { method: getWorksheetControls, params: { worksheetId, getTemplate: true, handControlSource: true } },
  ];

  for (const attempt of attempts) {
    if (!attempt.method) continue;
    try {
      const response = await attempt.method(attempt.params);
      const controls = Array.isArray(response) ? response : getControlsFromResponse(response);
      if (controls.length) {
        worksheetControlsCache.set(cacheKey, controls);
        return controls;
      }
    } catch (error) {
      console.warn("fetch lookup worksheet controls failed", attempt.params, error);
    }
  }

  return [];
}

async function hydrateLookupDisplayFields(rows, controls, fields, shouldCancel) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const cache = new Map();
  const worksheetControlsCache = new Map();

  return mapWithConcurrency(rows, DETAIL_HYDRATE_CONCURRENCY, async (row) => {
      if (shouldCancel?.()) return row;
      let nextRow = row;

      for (const field of fields) {
        if (shouldCancel?.()) return nextRow;
        const controlId = nextRow?.fieldMap?.[field.key] || findControlIdByNames(controls, field.names);
        const control = getControlById(controls, controlId);
        const cell = getCellByControlId(nextRow, controlId) || getCellByNames(nextRow, field.names);
        const rawValue = getRawCellValue(cell);
        const currentText = String(nextRow?.[field.key] || "").trim();
        const directText = getLookupDisplayTextFromValue(
          rawValue || currentText,
          control,
          cell,
          controls
        );

        if (isMeaningfulDisplayText(directText)) {
          nextRow = { ...nextRow, [field.key]: directText };
          continue;
        }

        const ids = getLookupIdValues(rawValue || currentText);
        if (!ids.length) continue;

        const sourceControlIds = getLookupSourceControlIds(control, cell);
        const sourceWorksheetIds = getLookupSourceWorksheetIds(control, cell, controls);

        const labels = [];
        for (const id of ids) {
          let label = getLookupOptionLabelByKey(id, control, cell, controls);

          if (!label && sourceWorksheetIds.length) {
            for (const worksheetId of sourceWorksheetIds) {
              if (!worksheetControlsCache.has(worksheetId)) {
                worksheetControlsCache.set(worksheetId, fetchLookupWorksheetControls(worksheetId));
              }
              const sourceControls = await worksheetControlsCache.get(worksheetId);
              const preferredControls = sourceControlIds
                .map((sourceControlId) => getControlById(sourceControls, sourceControlId))
                .filter(Boolean);

              for (const sourceControl of preferredControls) {
                label = getLookupOptionLabelByKey(id, sourceControl, null, sourceControls);
                if (label) break;
              }

              if (!label) {
                label =
                  sourceControls
                    .map((sourceControl) => getLookupOptionLabelByKey(id, sourceControl, null, sourceControls))
                    .find(Boolean) || "";
              }

              if (label) break;
            }
          }

          for (const worksheetId of sourceWorksheetIds) {
            if (label) break;
            const cacheKey = `${worksheetId}:${id}`;
            if (!cache.has(cacheKey)) {
              cache.set(cacheKey, fetchLookupRecordTitle(worksheetId, id));
            }
            label = await cache.get(cacheKey);
            if (label) break;
          }
          if (label) labels.push(label);
        }

        if (labels.length) {
          nextRow = { ...nextRow, [field.key]: labels.join("、") };
        }
      }

      return nextRow;
    }, shouldCancel);
}

function getDirectNumberValueByNames(source, names, excludeNames = []) {
  if (!source || typeof source !== "object") return null;
  const normalizedNames = names.map(normalizeFieldName).filter(Boolean);

  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = normalizeFieldName(key);
    if (
      normalizedNames.some((name) => normalizedKey.includes(name)) &&
      !isExcludedFieldName(key, excludeNames) &&
      value !== null &&
      value !== undefined &&
      value !== ""
    ) {
      return parseNumberValue(value);
    }
  }

  return null;
}

function getNumberValueByNames(source, controls, names, excludeNames = []) {
  const controlId = findControlIdByNamesExcluding(controls, names, excludeNames);
  const valueByControl = getNumberValueOrNull(source, controlId);
  if (valueByControl !== null) return valueByControl;
  const cellByName = getCellByNames(source, names, excludeNames);
  if (cellByName) {
    const raw = getRawCellValue(cellByName);
    if (raw !== null && raw !== undefined && raw !== "") return parseNumberValue(raw);
  }
  return getDirectNumberValueByNames(source, names, excludeNames);
}

function getTextValueByNames(source, controls, names, excludeNames = []) {
  const controlId = findControlIdByNamesExcluding(controls, names, excludeNames);
  const controlText = getTextValue(source, controlId);
  if (controlText && !isLikelyIdText(controlText)) return controlText;
  const cellByName = getCellByNames(source, names, excludeNames);
  if (cellByName) {
    const text = getOptionTextValueByCell(cellByName) || getDisplayTextFromParsedValue(
      getRawCellValue(cellByName),
      cellByName.displayValue || cellByName.text || ""
    );
    if (text && !isLikelyIdText(text)) return text;
  }
  return getDirectTextValue(source, names);
}

function getOptionalNumberValue(source, controls, controlId, names = [], excludeNames = []) {
  const valueByControl = getNumberValueOrNull(source, controlId);
  if (valueByControl !== null) return valueByControl;
  if (names.length) {
    const valueByName = getNumberValueByNames(source, controls, names, excludeNames);
    if (valueByName !== null) return valueByName;
  }
  return "";
}

function getOptionalTextValue(source, controls, controlId, names = [], excludeNames = []) {
  const control = getControlById(controls, controlId);
  const optionText = getOptionTextValueByControl(source, control);
  if (optionText && !isLikelyIdText(optionText)) return optionText;
  const valueByControl = getTextValue(source, controlId);
  if (valueByControl && !isLikelyIdText(valueByControl)) return valueByControl;
  if (!names.length) return "";
  const cellByName = getCellByNames(source, names, excludeNames);
  if (cellByName) {
    const text = getOptionTextValueByCell(cellByName) || getDisplayTextFromParsedValue(
      getRawCellValue(cellByName),
      cellByName.displayValue || cellByName.text || cellByName.label || ""
    );
    if (text && !isLikelyIdText(text)) return text;
  }
  return getTextValueByNames(source, controls, names, excludeNames);
}

function getTextValueByControlIds(source, controls, controlIds = []) {
  for (const controlId of controlIds.map(normalizeControlId).filter(Boolean)) {
    const control = getControlById(controls, controlId);
    const optionText = getOptionTextValueByControl(source, control);
    if (optionText) return optionText;

    const cell = getCellByControlId(source, controlId);
    const cellText =
      getOptionTextValueByCell(cell) ||
      getDisplayTextFromParsedValue(
        getRawCellValue(cell),
        cell?.displayValue || cell?.text || cell?.label || ""
      );
    if (cellText && !isLikelyIdText(cellText)) return cellText;

    const text = getTextValue(source, controlId);
    if (text && !isLikelyIdText(text)) return text;
  }

  return "";
}

function formatOptionalNumber(value, digits = 0) {
  return value === "" || value === null || value === undefined ? "" : formatNumber(value, digits);
}

function getControlTypeById(controls, controlId) {
  return (Array.isArray(controls) ? controls : []).find(
    (control) => getControlIdFromItem(control) === controlId
  )?.type;
}

function getControlById(controls, controlId) {
  return (Array.isArray(controls) ? controls : []).find(
    (control) => getControlIdFromItem(control) === controlId
  ) || null;
}

function isRelationControl(control) {
  return (
    [29, 34, 35].includes(Number(control?.type)) ||
    control?.valueType === "array" ||
    !!getWorksheetIdValue(control)
  );
}

function getOptionKeyByLabel(control, label) {
  const target = String(label || "").trim();
  const matched = getControlOptions(control).find(
    (option) => String(option?.value || option?.label || option?.name || "").trim() === target
  );
  return matched?.key || matched?.value || "";
}

function getOptionLabelByKey(control, key) {
  const target = String(key || "").trim();
  if (!target) return "";
  const matched = getControlOptions(control).find((option) =>
    [option?.key, option?.value, option?.label, option?.name]
      .map((item) => String(item || "").trim())
      .includes(target)
  );
  return getOptionLabelFromOption(matched, target) || findOptionLabelInValue(control, target);
}

function normalizeOptions(value) {
  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  return Array.isArray(parsed) ? parsed : [];
}

function getControlOptions(control) {
  return [
    ...normalizeOptions(control?.options),
    ...normalizeOptions(parseMaybeJson(control?.advancedSetting)?.options),
    ...normalizeOptions(control?.advancedSetting?.options),
    ...normalizeOptions(control?.enumDefault),
    ...normalizeOptions(parseMaybeJson(control?.enumDefault)?.options),
    ...normalizeOptions(control?.sourceControl?.options),
    ...normalizeOptions(parseMaybeJson(control?.sourceControl?.advancedSetting)?.options),
    ...normalizeOptions(control?.sourceControl?.advancedSetting?.options),
    ...normalizeOptions(control?.sourceControl?.enumDefault),
    ...normalizeOptions(control?.originControl?.options),
    ...normalizeOptions(parseMaybeJson(control?.originControl?.advancedSetting)?.options),
    ...normalizeOptions(control?.originControl?.advancedSetting?.options),
    ...normalizeOptions(control?.originControl?.enumDefault),
  ];
}

function getOptionIdentityValues(option) {
  if (!option || typeof option !== "object") return [];
  return [
    option.key,
    option.id,
    option.sid,
    option.value,
    option.controlValue,
    option.optionKey,
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function getOptionLabelFromOption(option, key = "") {
  if (!option || typeof option !== "object") return "";
  const target = String(key || "").trim();
  const identities = getOptionIdentityValues(option);
  if (target && !identities.includes(target)) return "";

  return [
    option.label,
    option.name,
    option.text,
    option.title,
    option.displayValue,
    option.fullname,
    option.rowtitle,
    option.value,
  ]
    .map((item) => (item === null || item === undefined || typeof item === "object" ? "" : String(item).trim()))
    .find((item) => item && item !== target && isMeaningfulDisplayText(item)) || "";
}

function findOptionLabelInValue(source, key, seen = new WeakSet(), depth = 0) {
  const target = String(key || "").trim();
  if (!source || !target || depth > 6) return "";

  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (!parsed || typeof parsed !== "object") return "";

  if (seen.has(parsed)) return "";
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const label = getOptionLabelFromOption(item, target) || findOptionLabelInValue(item, target, seen, depth + 1);
      if (label) return label;
    }
    return "";
  }

  const directLabel = getOptionLabelFromOption(parsed, target);
  if (directLabel) return directLabel;

  const preferredContainers = [
    parsed.options,
    parsed.items,
    parsed.controls,
    parsed.fields,
    parsed.enumDefault,
    parsed.enumDefault2,
    parsed.advancedSetting,
    parsed.sourceControl,
    parsed.originControl,
    parsed.dataSourceControl,
    parsed.sourceControls,
    parsed.originControls,
    parsed.template,
    parsed.data,
    parsed.row,
    parsed.record,
    parsed.value,
    parsed.controlValue,
    parsed.sourceValue,
    parsed.sourcevalue,
    parsed.originValue,
    parsed.originalValue,
  ];

  for (const container of preferredContainers) {
    const label = findOptionLabelInValue(container, target, seen, depth + 1);
    if (label) return label;
  }

  for (const value of Object.values(parsed)) {
    const label = findOptionLabelInValue(value, target, seen, depth + 1);
    if (label) return label;
  }

  return "";
}

function collectValuesByKeyNames(source, keyNames, seen = new WeakSet(), depth = 0) {
  if (!source || depth > 5) return [];
  const parsed = typeof source === "string" ? parseMaybeJson(source) : source;
  if (!parsed || typeof parsed !== "object") return [];

  if (seen.has(parsed)) return [];
  seen.add(parsed);

  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => collectValuesByKeyNames(item, keyNames, seen, depth + 1));
  }

  const normalizedKeyNames = keyNames.map((item) => String(item).toLowerCase());
  return Object.entries(parsed).flatMap(([key, value]) => [
    ...(normalizedKeyNames.includes(String(key).toLowerCase()) ? [value] : []),
    ...collectValuesByKeyNames(value, keyNames, seen, depth + 1),
  ]);
}

function getLookupSourceControlIds(control, cell) {
  const candidates = [
    control?.dataSource,
    control?.sourceControlId,
    control?.originControlId,
    control?.sourceControl?.controlId,
    control?.originControl?.controlId,
    cell?.dataSource,
    cell?.sourceControlId,
    cell?.originControlId,
    cell?.sourceControl?.controlId,
    cell?.originControl?.controlId,
    ...collectValuesByKeyNames(control?.advancedSetting, [
      "dataSource",
      "sourceControlId",
      "sourceControlIds",
      "originControlId",
      "showControls",
    ]),
    ...collectValuesByKeyNames(cell?.advancedSetting, [
      "dataSource",
      "sourceControlId",
      "sourceControlIds",
      "originControlId",
      "showControls",
    ]),
  ];

  return Array.from(new Set(candidates.map(normalizeControlId).filter(Boolean)));
}

function getLookupOptionLabelByKey(key, control, cell, controls = []) {
  const target = String(key || "").trim();
  if (!target) return "";

  const directSources = [
    cell,
    control,
    cell?.sourceControl,
    cell?.originControl,
    control?.sourceControl,
    control?.originControl,
  ];
  for (const source of directSources) {
    const label = getOptionLabelByKey(source, target) || findOptionLabelInValue(source, target);
    if (label) return label;
  }

  const sourceControlIds = getLookupSourceControlIds(control, cell);
  for (const controlId of sourceControlIds) {
    const sourceControl = getControlById(controls, controlId);
    const label = getOptionLabelByKey(sourceControl, target) || findOptionLabelInValue(sourceControl, target);
    if (label) return label;
  }

  for (const sourceControl of Array.isArray(controls) ? controls : []) {
    const label = getOptionLabelByKey(sourceControl, target) || findOptionLabelInValue(sourceControl, target);
    if (label) return label;
  }

  return "";
}

function getLookupDisplayTextFromValue(value, control, cell, controls = []) {
  const directText =
    getOptionTextValueByCell(cell) ||
    getOptionTextValueByControl({ rowData: [cell].filter(Boolean) }, control) ||
    getDisplayTextFromParsedValue(value, cell?.displayValue || cell?.text || cell?.label || "");
  if (isMeaningfulDisplayText(directText)) return directText;

  const ids = getLookupIdValues(value || directText);
  const labels = ids
    .map((id) => getLookupOptionLabelByKey(id, control, cell, controls))
    .filter(Boolean);
  return labels.length ? labels.join("、") : "";
}

function getOptionTextValueByControl(source, control) {
  if (!control?.controlId) return "";
  const cell = getCellByControlId(source, control.controlId);
  const raw = parseMaybeJson(getRawCellValue(cell));
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const optionLabels = rawValues
    .map((item) => {
      const key =
        item && typeof item === "object"
          ? item.key || item.value || item.id || item.name || item.label
          : item;
      const text = getOptionLabelByKey(control, key) || getDisplayTextFromParsedValue(item);
      return isMeaningfulDisplayText(text) ? text : "";
    })
    .filter(Boolean);
  return optionLabels.join("、");
}

function getOptionTextValueByCell(cell) {
  if (!cell) return "";
  const raw = parseMaybeJson(getRawCellValue(cell));
  const rawValues = Array.isArray(raw) ? raw : [raw];
  const fallbackText = cell.displayValue || cell.text || cell.label || "";
  return rawValues
    .map((item) => {
      const key =
        item && typeof item === "object"
          ? item.key || item.value || item.id || item.name || item.label
          : item;
      const text =
        getOptionLabelByKey(cell, key) ||
        findOptionLabelInValue(cell, key) ||
        getDisplayTextFromParsedValue(item, fallbackText);
      return isMeaningfulDisplayText(text) ? text : "";
    })
    .filter(Boolean)
    .join("、");
}

function getLookupIdValues(value) {
  const parsed = typeof value === "string" ? parseMaybeJson(value) : value;
  if (Array.isArray(parsed)) {
    return parsed.flatMap((item) => getLookupIdValues(item));
  }

  if (parsed && typeof parsed === "object") {
    return [
      parsed.rowid,
      parsed.rowId,
      parsed.id,
      parsed.sid,
      parsed.value,
      parsed.key,
    ]
      .filter((item) => isLikelyIdText(item))
      .map((item) => String(item));
  }

  const text = String(parsed || "").trim();
  if (!text) return [];
  return text
    .split(/[,\s、]+/)
    .map((item) => item.trim())
    .filter((item) => isLikelyIdText(item));
}

function getLookupSourceWorksheetIds(control, cell, controls = []) {
  const worksheetCandidates = [
    control?.sourceWorksheetId,
    control?.relationWorksheetId,
    control?.worksheetId,
    control?.enumDefault2,
    control?.searchWorksheetId,
    control?.sourceWorksheetIds,
    control?.relationWorksheetIds,
    control?.worksheetIds,
    control?.sourceControl?.dataSource,
    control?.sourceControl?.sourceWorksheetId,
    control?.sourceControl?.relationWorksheetId,
    control?.sourceControl?.worksheetId,
    control?.sourceControl?.searchWorksheetId,
    control?.originControl?.dataSource,
    control?.originControl?.sourceWorksheetId,
    control?.originControl?.relationWorksheetId,
    control?.originControl?.worksheetId,
    control?.originControl?.searchWorksheetId,
    cell?.sourceWorksheetId,
    cell?.relationWorksheetId,
    cell?.worksheetId,
    cell?.enumDefault2,
    cell?.searchWorksheetId,
    cell?.sourceWorksheetIds,
    cell?.relationWorksheetIds,
    cell?.worksheetIds,
    cell?.sourceControl?.dataSource,
    cell?.sourceControl?.sourceWorksheetId,
    cell?.sourceControl?.relationWorksheetId,
    cell?.sourceControl?.worksheetId,
    cell?.sourceControl?.searchWorksheetId,
    cell?.originControl?.dataSource,
    cell?.originControl?.sourceWorksheetId,
    cell?.originControl?.relationWorksheetId,
    cell?.originControl?.worksheetId,
    cell?.originControl?.searchWorksheetId,
    ...collectValuesByKeyNames(control?.advancedSetting, [
      "sourceWorksheetId",
      "relationWorksheetId",
      "worksheetId",
      "enumDefault2",
      "searchWorksheetId",
      "sourceWorksheetIds",
      "relationWorksheetIds",
      "worksheetIds",
    ]),
    ...collectValuesByKeyNames(cell?.advancedSetting, [
      "sourceWorksheetId",
      "relationWorksheetId",
      "worksheetId",
      "enumDefault2",
      "searchWorksheetId",
      "sourceWorksheetIds",
      "relationWorksheetIds",
      "worksheetIds",
    ]),
  ];
  const relationControlCandidates = [
    control?.dataSource,
    cell?.dataSource,
    ...collectValuesByKeyNames(control?.advancedSetting, ["dataSource", "relationControlId"]),
    ...collectValuesByKeyNames(cell?.advancedSetting, ["dataSource", "relationControlId"]),
  ];
  const relationWorksheetIds = relationControlCandidates.flatMap((candidate) => {
    const relationControl = getControlById(controls, normalizeControlId(candidate));
    return getRelationWorksheetId(relationControl) || "";
  });

  return Array.from(
    new Set(
      [...relationWorksheetIds, ...worksheetCandidates, ...relationControlCandidates]
        .flatMap((candidate) => (Array.isArray(candidate) ? candidate : [candidate]))
        .map(normalizeControlId)
        .filter(Boolean)
    )
  );
}

function getReadableRowTitle(row) {
  const direct = [
    row?.rowtitle,
    row?.title,
    row?.name,
    row?.displayValue,
    row?.text,
    row?.label,
  ]
    .map((item) => String(item || "").trim())
    .find((item) => isMeaningfulDisplayText(item));
  if (direct) return direct;

  return (
    getCellsFromRow(row)
      .map((cell) =>
        getDisplayTextFromParsedValue(
          getRawCellValue(cell),
          cell?.displayValue || cell?.text || cell?.label || ""
        )
      )
      .find((item) => isMeaningfulDisplayText(item)) || ""
  );
}

function getOptionTextValue(source, controls, names) {
  const control = findControlByNames(controls, names);
  if (!control?.controlId) return "";
  return getOptionTextValueByControl(source, control) || getTextValue(source, control.controlId);
}

function findCheckedControlId(controls) {
  const candidates = (Array.isArray(controls) ? controls : []).filter((control) => {
    const name = String(control?.controlName || "");
    if (!["勾选", "是否装载", "是否勾选", "装载"].some((keyword) => name.includes(keyword))) {
      return false;
    }
    return !["装载量", "装载数量", "装载平方", "装载立方"].some((keyword) =>
      name.includes(keyword)
    );
  });
  const matched =
    candidates.find((control) => Number(control?.type) === 36) ||
    candidates.find((control) => !control?.type);
  return matched?.controlId || "";
}

function isLikelyIdText(value) {
  return (
    /^[a-f0-9-]{24,}$/i.test(String(value || "")) ||
    /^[a-f0-9]{24}$/i.test(String(value || ""))
  );
}

function isPlaceholderDisplayText(value) {
  const text = String(value ?? "").trim();
  return !text || ["-", "--", "—", "–", "_", "[]"].includes(text);
}

function getCleanDisplayText(value) {
  const text = String(value ?? "").trim();
  return isPlaceholderDisplayText(text) ? "" : text;
}

function isMeaningfulDisplayText(value) {
  const text = getCleanDisplayText(value);
  return !!text && !isLikelyIdText(text);
}

function getDirectTextValue(source, names) {
  if (!source || typeof source !== "object") return "";

  for (const name of names) {
    const raw = source[name] ?? source[name.toLowerCase()];
    if (raw !== undefined && raw !== null && raw !== "") {
      const parsed = parseMaybeJson(raw);
      if (parsed && typeof parsed === "object") {
        const text = getDisplayTextFromParsedValue(parsed);
        if (text) return String(text);
      }
      return String(parsed);
    }
  }

  return "";
}

function getNamedFieldText(source, controls, names) {
  const controlId = findControlIdByNames(controls, names);
  if (controlId) {
    const text = getTextValue(source, controlId);
    if (text) return text;
  }
  return getDirectTextValue(source, names);
}

function getRowIdValue(row) {
  return row?.rowid || row?.rowId || row?.id || row?.sid || "";
}

function getDisplayNameFromRelationItem(item) {
  return getDisplayTextFromParsedValue(item) || item?.sid || "";
}

function getTruckPlateText(row, controls = []) {
  const plateText = getNamedFieldText(row, controls, [
    "车牌号",
    "车牌",
    "货车牌号",
    "车辆牌号",
    "车号",
    "车辆",
    "货车",
  ]);

  if (plateText && !isLikelyIdText(plateText)) return plateText;

  const displayText = getDisplayNameFromRelationItem(row);
  if (displayText && !isLikelyIdText(displayText)) return displayText;

  return plateText || displayText || getRowIdValue(row);
}

function getTruckDriverText(row, controls = []) {
  return getNamedFieldText(row, controls, [
    "司机",
    "驾驶员",
    "司机姓名",
    "驾驶员姓名",
    "负责人",
  ]);
}

function getTruckCapacityVolume(row, controls = []) {
  return (
    getNumberValueByNames(row, controls, [
      "可载立方",
      "可装立方",
      "载货立方",
      "车辆立方",
      "货车立方",
      "装载立方",
      "容量",
    ], ["平方", "面积"]) || 0
  );
}

function getTruckCapacityArea(row, controls = []) {
  return (
    getNumberValueByNames(row, controls, [
      "可载平方",
      "可装平方",
      "载货平方",
      "车辆平方",
      "货车平方",
      "装载平方",
      "容量平方",
    ], ["立方", "方数", "方量"]) || 0
  );
}

function toTruckOption(row, controls = []) {
  return {
    value: getRowIdValue(row) || row?.sid || getDisplayNameFromRelationItem(row),
    label: getTruckPlateText(row, controls),
    driver: getTruckDriverText(row, controls),
    capacityArea: getTruckCapacityArea(row, controls),
    capacityVolume: getTruckCapacityVolume(row, controls),
  };
}

function getLoadingOrderNoText(row, controls = []) {
  return (
    getTextValueByNames(row, controls, LOADING_ORDER_NO_FIELD_NAMES) ||
    getDisplayNameFromRelationItem(row) ||
    getRowIdValue(row)
  );
}

function getLoadingStatusText(row, controls = []) {
  return (
    getOptionTextValue(row, controls, LOADING_STATUS_FIELD_NAMES) ||
    getTextValueByNames(row, controls, LOADING_STATUS_FIELD_NAMES)
  );
}

function matchesSupplementOrderStatus(status) {
  const normalizedStatus = normalizeFieldName(status);
  return SUPPLEMENT_ORDER_STATUS_TEXTS.some((statusText) =>
    normalizedStatus.includes(normalizeFieldName(statusText))
  );
}

function getSupplementOrderStatusPriority(status) {
  const normalizedStatus = normalizeFieldName(status);
  if (normalizedStatus.includes(normalizeFieldName("装车未送"))) return 0;
  if (normalizedStatus.includes(normalizeFieldName("已送未回"))) return 1;
  return 2;
}

function toSupplementOrderOption(row, controls = []) {
  const rowId = getRowIdValue(row) || row?.sid || "";
  const orderNo = getLoadingOrderNoText(row, controls);
  const status = getLoadingStatusText(row, controls);
  return {
    value: rowId,
    rowId,
    label: orderNo,
    status,
  };
}

function isBetterTruckLabel(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  return isLikelyIdText(current) && !isLikelyIdText(candidate);
}

function mergeTruckOptions(options) {
  const optionMap = new Map();

  options.forEach((option) => {
    if (!option?.value) return;
    const current = optionMap.get(option.value);
    if (!current) {
      optionMap.set(option.value, option);
      return;
    }

    optionMap.set(option.value, {
      ...current,
      label: isBetterTruckLabel(option.label, current.label) ? option.label : current.label,
      driver: option.driver || current.driver || "",
      capacityArea: option.capacityArea || current.capacityArea || 0,
      capacityVolume: option.capacityVolume || current.capacityVolume || 0,
    });
  });

  return Array.from(optionMap.values());
}

function getRelationWorksheetId(control) {
  const advancedSetting = parseMaybeJson(control?.advancedSetting);
  return (
    control?.dataSource ||
    control?.sourceWorksheetId ||
    control?.relationWorksheetId ||
    control?.worksheetId ||
    control?.enumDefault2 ||
    control?.searchWorksheetId ||
    advancedSetting?.dataSource ||
    advancedSetting?.sourceWorksheetId ||
    advancedSetting?.relationWorksheetId ||
    advancedSetting?.worksheetId ||
    advancedSetting?.enumDefault2
    || advancedSetting?.searchWorksheetId
  );
}

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}/${padDatePart(date.getMonth() + 1)}/${padDatePart(
    date.getDate()
  )}`;
}

function getFormattedDateValue(source, controlId) {
  const rawValue = parseMaybeJson(getCellValue(source, controlId));

  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return "";
  }

  if (
    typeof rawValue === "number" ||
    (typeof rawValue === "string" && /^\d{10,13}$/.test(rawValue))
  ) {
    const numeric = Number(rawValue);
    const timestamp = String(rawValue).length === 10 ? numeric * 1000 : numeric;
    const parsedDate = new Date(timestamp);
    if (!Number.isNaN(parsedDate.getTime())) return formatDate(parsedDate);
  }

  const textValue = getTextValue(source, controlId);
  if (!textValue) return "";

  const matched = textValue.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (matched) {
    return `${matched[1]}/${padDatePart(matched[2])}/${padDatePart(matched[3])}`;
  }

  const parsedDate = new Date(textValue);
  if (!Number.isNaN(parsedDate.getTime())) return formatDate(parsedDate);
  return textValue;
}

function normalizeDateInputText(value) {
  if (value === null || value === undefined || value === "") return "";
  const text = String(value).trim();
  const matched = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (matched) {
    return `${matched[1]}-${padDatePart(matched[2])}-${padDatePart(matched[3])}`;
  }

  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    const timestamp = text.length === 10 ? numeric * 1000 : numeric;
    const parsedDate = new Date(timestamp);
    if (!Number.isNaN(parsedDate.getTime())) return formatDateInputValue(parsedDate);
  }

  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) return formatDateInputValue(parsedDate);
  return "";
}

function areSameDateInputValues(left, right) {
  const normalizedLeft = normalizeDateInputText(left);
  const normalizedRight = normalizeDateInputText(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function waitForMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSystemFilters(filters) {
  const next = filters && typeof filters === "object" ? filters : {};
  return {
    filterControls: Array.isArray(next.filterControls) ? next.filterControls : [],
    fastFilters: Array.isArray(next.fastFilters) ? next.fastFilters : [],
    filtersGroup: next.filtersGroup || null,
    sortControls: Array.isArray(next.sortControls) ? next.sortControls : [],
    navGroupFilters: Array.isArray(next.navGroupFilters) ? next.navGroupFilters : [],
    keyWords: next.keyWords || next.keywords || "",
  };
}

function areSystemFiltersEqual(left, right) {
  try {
    return JSON.stringify(normalizeSystemFilters(left)) === JSON.stringify(normalizeSystemFilters(right));
  } catch (error) {
    return false;
  }
}

function getInitialSystemFilters() {
  const liveRuntimeEnv = getLiveRuntimeEnv();
  const runtimeView = runtimeConfig.view || {};

  return [
    runtimeView.filters,
    runtimeView.filterControls ? { filterControls: runtimeView.filterControls } : null,
    runtimeView.fastFilters ? { fastFilters: runtimeView.fastFilters } : null,
    runtimeView.quickFilters ? { fastFilters: runtimeView.quickFilters } : null,
    runtimeView.filtersGroup ? { filtersGroup: runtimeView.filtersGroup } : null,
    runtimeView.navGroupFilters ? { navGroupFilters: runtimeView.navGroupFilters } : null,
    runtimeView.sortControls ? { sortControls: runtimeView.sortControls } : null,
    runtimeView.keyWords ? { keyWords: runtimeView.keyWords } : null,
    runtimeView.keywords ? { keyWords: runtimeView.keywords } : null,
    runtimeConfig.filters,
    runtimeConfig.filterControls ? { filterControls: runtimeConfig.filterControls } : null,
    runtimeConfig.fastFilters ? { fastFilters: runtimeConfig.fastFilters } : null,
    runtimeConfig.quickFilters ? { fastFilters: runtimeConfig.quickFilters } : null,
    runtimeConfig.filtersGroup ? { filtersGroup: runtimeConfig.filtersGroup } : null,
    runtimeConfig.navGroupFilters ? { navGroupFilters: runtimeConfig.navGroupFilters } : null,
    runtimeConfig.sortControls ? { sortControls: runtimeConfig.sortControls } : null,
    runtimeConfig.keyWords ? { keyWords: runtimeConfig.keyWords } : null,
    runtimeConfig.keywords ? { keyWords: runtimeConfig.keywords } : null,
    liveRuntimeEnv.filters,
    liveRuntimeEnv.filterControls ? { filterControls: liveRuntimeEnv.filterControls } : null,
    liveRuntimeEnv.fastFilters ? { fastFilters: liveRuntimeEnv.fastFilters } : null,
    liveRuntimeEnv.quickFilters ? { fastFilters: liveRuntimeEnv.quickFilters } : null,
    liveRuntimeEnv.filtersGroup ? { filtersGroup: liveRuntimeEnv.filtersGroup } : null,
    liveRuntimeEnv.navGroupFilters ? { navGroupFilters: liveRuntimeEnv.navGroupFilters } : null,
    liveRuntimeEnv.sortControls ? { sortControls: liveRuntimeEnv.sortControls } : null,
    liveRuntimeEnv.keyWords ? { keyWords: liveRuntimeEnv.keyWords } : null,
    liveRuntimeEnv.keywords ? { keyWords: liveRuntimeEnv.keywords } : null,
  ].reduce((merged, source) => ({ ...merged, ...normalizeSystemFilters(source) }), {});
}

function getFilterRequestPayload(filters) {
  return {
    ...(filters.filterControls.length ? { filterControls: filters.filterControls } : {}),
    ...(filters.fastFilters.length ? { fastFilters: filters.fastFilters } : {}),
    ...(filters.filtersGroup ? { filtersGroup: filters.filtersGroup } : {}),
    ...(filters.sortControls.length ? { sortControls: filters.sortControls } : {}),
    ...(filters.navGroupFilters.length
      ? { navGroupFilters: filters.navGroupFilters }
      : {}),
    ...(filters.keyWords ? { keyWords: filters.keyWords } : {}),
  };
}

function normalizeBoardFlag(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value > 0;
  if (typeof value === "boolean") return value;
  const text = String(value || "").trim();
  if (!text) return false;
  return !["0", "false", "False", "否", "无", "空"].includes(text);
}

function normalizeCheckedFlag(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  const text = String(value || "").trim();
  return ["1", "true", "True", "是", "已选", "勾选", "选中", "装载"].includes(text);
}

function getMappedDetailControlIds() {
  const liveRuntimeEnv = getLiveRuntimeEnv();
  const candidates = {
    loadingArea: ["detailLoadingArea", "明细在装平方", "明细在装面积"],
    loadingUser: ["detailLoadingUser", "明细装载人", "装载人"],
    convertedArea: ["detailAreaCoefficient", "平方系数", "面积系数", "折算平方"],
    convertedVolume: ["detailVolumeCoefficient", "立方系数", "体积系数", "折算立方"],
    unitPrice: ["detailUnitPrice", "unitPrice", "单价"],
    productionStatus: ["detailProductionStatus", "productionStatus", "生产状态"],
    totalPurchaseQty: ["detailTotalPurchaseQty", "totalPurchaseQty", "总采购量"],
    totalBoardQty: ["detailTotalBoardQty", "totalBoardQty", "总纸板量"],
    printCompleted: ["detailPrintCompleted", "printCompleted", "印刷完工"],
    formingCompleted: ["detailFormingCompleted", "formingCompleted", "成型完工"],
    totalInboundQty: ["detailTotalInboundQty", "totalInboundQty", "总入库量"],
    totalOutboundQty: ["detailTotalOutboundQty", "totalOutboundQty", "总出库量"],
  };

  return Object.fromEntries(
    Object.entries(candidates).map(([fieldKey, keys]) => {
      const controlId = keys
        .map((key) => normalizeControlId(liveRuntimeEnv[key]))
        .find(Boolean) || "";
      return [fieldKey, controlId];
    })
  );
}

function normalizeDetailRows(relationRows, controls) {
  const mappedDetailControlIds = getMappedDetailControlIds();
  // Control IDs are scoped to a worksheet. Never use this implementation's
  // delivery-detail IDs for another customer's worksheet just because a field
  // name was not returned with the relation payload.
  const detectedDetailWorksheetId =
    getWorksheetIdFromControls(controls) || getWorksheetIdValue(relationRows?.[0]) || "";
  const isKnownDeliveryDetail = detectedDetailWorksheetId === DELIVERY_DETAIL_WORKSHEET_ID;
  const knownFieldFallback = (fieldKey) =>
    isKnownDeliveryDetail && DELIVERY_DETAIL_FIELD_IDS[fieldKey]
      ? [DELIVERY_DETAIL_FIELD_IDS[fieldKey]]
      : [];
  const clientCodeNames = ["客户编码", "客户编号", "客户代码", "客户代号", "客户ID"];
  const addressNames = ["送货地址", "收货地址", "客户地址", "地址", "详细地址"];
  const purchaseOrderNames = ["采购单号", "采购订单号", "采购单", "采购订单", "采购编号"];
  const unitPriceNames = ["单价", "销售单价", "含税单价", "采购单价"];
  const productionStatusNames = PRODUCTION_STATUS_FIELD_NAMES;
  const productArchiveNames = ["产品档案", "产品资料", "产品信息", "产品", "档案"];
  const productArchiveExcludes = ["品名", "产品名称"];
  // These are display-only fields.  They are resolved by their Mingdao field names
  // and deliberately do not participate in any save or workflow payloads.
  const specificationModelNames = ["规格型号"];
  const materialCodeNames = ["物料代码"];
  const totalPurchaseQtyNames = ["总采购量", "采购总量", "累计采购量"];
  const totalBoardQtyNames = ["总纸板量", "纸板总量", "累计纸板量"];
  const printCompletedNames = ["印刷完工", "印刷完工量", "印刷完成", "印刷完成量"];
  const formingCompletedNames = ["成型完工", "成型完工量", "成型完成", "成型完成量"];
  const totalInboundQtyNames = ["总入库量", "入库总量", "累计入库量"];
  const totalOutboundQtyNames = ["总出库量", "出库总量", "累计出库量"];
  const inventoryQtyNames = ["库存数量", "库存量", "库存数", "现有库存", "可用库存"];
  const inventoryQtyExcludes = ["库存信息", "库存立方", "库存平方", "库存面积", "库存方数", "库存方量"];
  const plannedVolumeNames = ["计划立方", "计划方数", "计划方量", "计划立方数", "计划m3"];
  const inventoryVolumeNames = ["库存立方", "库存方数", "库存方量", "库存立方数", "库存m3"];
  const loadingAreaNames = [
    "在装平方",
    "在装面积",
    "装载平方",
    "装载面积",
    "已载平方",
    "已装平方",
  ];
  const loadingUserNames = ["装载人", "装车人", "装货人", "装载人员"];
  const loadingAreaExcludes = ["计划", "库存", "可载"];
  const convertedAreaNames = ["平方系数", "面积系数", "折算平方", "单件平方", "单位平方"];
  const convertedVolumeNames = ["立方系数", "体积系数", "折算立方", "单件立方", "单位立方"];
  const coefficientExcludes = ["计划", "库存", "在装", "已装", "已载", "装载", "可载"];
  const unitAreaNames = ["单位面积", "单件面积", "单张面积", "单片面积"];
  const giftQtyNames = ["赠量", "赠送量", "赠送数量", "赠品量"];
  // “勾选”是本插件在装车明细里用来标记是否装载的开关字段。同一个名字在不同工作表
  // 里的 controlId 必然不同，所以优先按名称匹配，写死的历史 controlId 只留作兜底。
  const checkedNames = ["勾选", "是否装载", "是否勾选"];
  const checkedExcludes = [
    "装载量",
    "装载数量",
    "装载平方",
    "装载立方",
    "装载人",
    "装载时间",
    "装载状态",
    "装载日期",
  ];
  const loadedQtyNames = ["装载量", "本次装载量", "实际装载量", "装车数量"];
  const loadedQtyExcludes = ["计划", "库存", "可载", "在装", "装载人"];
  const loadedVolumeNames = [
    "在装立方",
    "在装方数",
    "在装方量",
    "已装立方",
    "已载立方",
    "装载立方",
    "实装立方",
    "已装方数",
    "已载方数",
    "装载方数",
  ];
  const plannedVolumeExcludes = ["库存", "已装", "已载", "装载", "实装", "折算", "可载", "在装"];
  const inventoryVolumeExcludes = ["计划", "已装", "已载", "装载", "实装", "折算", "可载", "在装"];
  const loadedVolumeExcludes = ["计划", "库存", "折算", "可载"];
  const fieldMap = {
    client: findControlIdByNames(controls, ["客户名称", "客户"]),
    clientCode: findControlIdByNames(controls, clientCodeNames),
    clientShortName: findControlIdByNames(controls, ["客户简称", "简称"]),
    address: findControlIdByNames(controls, addressNames),
    route: findControlIdByNames(controls, ["路径", "线路", "配送路径", "送货路径"]),
    productArchive:
      findControlIdByNamesExcluding(controls, productArchiveNames, productArchiveExcludes) ||
      findControlIdByNamesFromRows(relationRows, productArchiveNames, productArchiveExcludes),
    workOrder: findControlIdByNames(controls, ["生产工单", "工单"]),
    purchaseOrder: findControlIdByNames(controls, purchaseOrderNames),
    model: findDetailModelControlId(controls, relationRows),
    productName: findControlIdByNames(controls, ["品名"]),
    specificationModel: findControlIdByNames(controls, specificationModelNames),
    materialCode: findControlIdByNames(controls, materialCodeNames),
    size: findControlIdByNames(controls, ["尺寸"]),
    unitPrice: resolveDetailControlId(
      mappedDetailControlIds.unitPrice,
      controls,
      relationRows,
      unitPriceNames
    ),
    productionStatus: resolveDetailControlId(
      mappedDetailControlIds.productionStatus,
      controls,
      relationRows,
      productionStatusNames
    ),
    plannedQty: findControlIdByNames(controls, ["计划量", "计划数量"]),
    inventoryQty:
      findControlIdByNamesExcluding(controls, inventoryQtyNames, inventoryQtyExcludes) ||
      findControlIdByNamesFromRows(relationRows, inventoryQtyNames, inventoryQtyExcludes),
    convertedVolume: resolveDetailControlId(
      mappedDetailControlIds.convertedVolume,
      controls,
      relationRows,
      convertedVolumeNames,
      coefficientExcludes,
      knownFieldFallback("convertedVolume")
    ),
    plannedVolume: findControlIdByNamesExcluding(controls, plannedVolumeNames, plannedVolumeExcludes),
    inventoryVolume: findControlIdByNamesExcluding(controls, inventoryVolumeNames, inventoryVolumeExcludes),
    loadedVolume: findControlIdByNamesExcluding(controls, loadedVolumeNames, loadedVolumeExcludes),
    // 平方系数：按字段“名称”在当前明细工作表里解析（送货明细 6a24c033b6274becb18d68cd）。
    // 写死的历史 controlId 只作为最后一道兜底，换一张表复用本插件时同名字段也能自动识别。
    convertedArea: resolveDetailControlId(
      mappedDetailControlIds.convertedArea,
      controls,
      relationRows,
      convertedAreaNames,
      coefficientExcludes,
      knownFieldFallback("convertedArea")
    ),
    unitArea: resolveDetailControlId(
      "",
      controls,
      relationRows,
      unitAreaNames,
      coefficientExcludes,
      knownFieldFallback("unitArea")
    ),
    giftQty: resolveDetailControlId(
      "",
      controls,
      relationRows,
      giftQtyNames,
      [],
      knownFieldFallback("giftQty")
    ),
    plannedArea: findControlIdByNames(controls, ["计划平方"]),
    inventoryArea: findControlIdByNames(controls, ["库存平方"]),
    loadedArea: resolveDetailControlId(
      mappedDetailControlIds.loadingArea,
      controls,
      relationRows,
      loadingAreaNames,
      loadingAreaExcludes,
      knownFieldFallback("loadedArea")
    ),
    loadingUser: resolveDetailControlId(
      mappedDetailControlIds.loadingUser,
      controls,
      relationRows,
      loadingUserNames,
      [],
      knownFieldFallback("loadingUser")
    ),
    loadedQty: resolveDetailControlId(
      "",
      controls,
      relationRows,
      loadedQtyNames,
      loadedQtyExcludes,
      knownFieldFallback("loadedQty")
    ),
    remark: findControlIdByNames(controls, ["备注", "明细备注", "装车备注"]),
    totalPurchaseQty: resolveDetailControlId(
      mappedDetailControlIds.totalPurchaseQty,
      controls,
      relationRows,
      totalPurchaseQtyNames
    ),
    totalBoardQty: resolveDetailControlId(
      mappedDetailControlIds.totalBoardQty,
      controls,
      relationRows,
      totalBoardQtyNames
    ),
    printCompleted: resolveDetailControlId(
      mappedDetailControlIds.printCompleted,
      controls,
      relationRows,
      printCompletedNames
    ),
    formingCompleted: resolveDetailControlId(
      mappedDetailControlIds.formingCompleted,
      controls,
      relationRows,
      formingCompletedNames
    ),
    totalInboundQty: resolveDetailControlId(
      mappedDetailControlIds.totalInboundQty,
      controls,
      relationRows,
      totalInboundQtyNames
    ),
    totalOutboundQty: resolveDetailControlId(
      mappedDetailControlIds.totalOutboundQty,
      controls,
      relationRows,
      totalOutboundQtyNames
    ),
    checked: resolveDetailControlId(
      "",
      controls,
      relationRows,
      checkedNames,
      checkedExcludes,
      knownFieldFallback("checked")
    ),
    boardFlag: findControlIdByNames(controls, ["板块", "有板块", "有无板块"]),
  };
  const fieldTypeMap = Object.fromEntries(
    Object.entries(fieldMap).map(([key, controlId]) => [
      key,
      getControlTypeById(controls, controlId) ||
        (isKnownDeliveryDetail && controlId === DELIVERY_DETAIL_FIELD_IDS[key]
          ? DELIVERY_DETAIL_FIELD_TYPES[key]
          : undefined),
    ])
  );

  return relationRows.map((row, index) => {
    const client = getTextValue(row, fieldMap.client);
    const clientCode = getTextValue(row, fieldMap.clientCode) || getTextValueByNames(row, controls, clientCodeNames);
    const clientShortName = getTextValue(row, fieldMap.clientShortName);
    const address = getTextValue(row, fieldMap.address) || getTextValueByNames(row, controls, addressNames);
    const route = getTextValue(row, fieldMap.route);
    const plannedQty = getNumberValue(row, fieldMap.plannedQty);
    const inventoryQty =
      getNumberValueOrNull(row, fieldMap.inventoryQty) ??
      getNumberValueByNames(row, controls, inventoryQtyNames, inventoryQtyExcludes);
    const convertedVolume =
      getNumberValueOrNull(row, fieldMap.convertedVolume) ??
      getNumberValueByNames(row, controls, convertedVolumeNames, coefficientExcludes) ??
      0;
    const convertedArea =
      getNumberValueOrNull(row, fieldMap.convertedArea) ??
      getNumberValueByNames(row, controls, convertedAreaNames, coefficientExcludes) ??
      0;
    const unitArea = getNumberValueOrNull(row, fieldMap.unitArea) ?? 0;
    const giftQty = getNumberValueOrNull(row, fieldMap.giftQty) ?? 0;
    const loadedQty = getNumberValue(row, fieldMap.loadedQty);
    const checkedRaw = fieldMap.checked ? getCellValue(row, fieldMap.checked) : "";
    const plannedVolume =
      getNumberValueByNames(row, controls, plannedVolumeNames, plannedVolumeExcludes) ??
      plannedQty * convertedVolume;
    const inventoryVolume =
      getNumberValueByNames(row, controls, inventoryVolumeNames, inventoryVolumeExcludes) ??
      inventoryQty * convertedVolume;
    const loadedVolume =
      getNumberValueByNames(row, controls, loadedVolumeNames, loadedVolumeExcludes) ??
      loadedQty * convertedVolume;
    const plannedArea =
      getNumberValue(row, fieldMap.plannedArea) || plannedQty * convertedArea;
    const inventoryArea =
      getNumberValue(row, fieldMap.inventoryArea) || inventoryQty * convertedArea;
    const loadedArea =
      getNumberValueOrNull(row, fieldMap.loadedArea) ??
      calculateLoadingArea(
        { plannedQty, plannedArea, convertedArea, unitArea, giftQty },
        loadedQty
      );
    const boardRaw = fieldMap.boardFlag ? getCellValue(row, fieldMap.boardFlag) : "";

    return {
      id: getRowIdValue(row) || String(index + 1),
      worksheetId: getWorksheetIdValue(row) || detectedDetailWorksheetId,
      fieldMap,
      fieldTypeMap,
      client,
      clientCode,
      clientShortName,
      address,
      route,
      productArchive:
        getTextValue(row, fieldMap.productArchive) ||
        getTextValueByNames(row, controls, productArchiveNames, productArchiveExcludes),
      workOrder: getTextValue(row, fieldMap.workOrder),
      purchaseOrder: getTextValueByNames(row, controls, purchaseOrderNames),
      model:
        getTextValue(row, fieldMap.model) ||
        getTextValueByNames(row, controls, MODEL_FIELD_NAMES),
      productName: getTextValue(row, fieldMap.productName),
      specificationModel:
        getTextValue(row, fieldMap.specificationModel) ||
        getTextValueByNames(row, controls, specificationModelNames),
      materialCode:
        getTextValue(row, fieldMap.materialCode) ||
        getTextValueByNames(row, controls, materialCodeNames),
      size: getTextValue(row, fieldMap.size),
      unitPrice: getOptionalNumberValue(row, controls, fieldMap.unitPrice, unitPriceNames),
      productionStatus: getDetailStatusFromSource(row, controls, fieldMap.productionStatus, productionStatusNames),
      plannedQty,
      inventoryQty,
      convertedVolume,
      convertedArea,
      unitArea,
      giftQty,
      loadingUser:
        getTextValue(row, fieldMap.loadingUser) ||
        getTextValueByNames(row, controls, loadingUserNames),
      loadedQty,
      remark: getTextValue(row, fieldMap.remark),
      totalPurchaseQty: getOptionalNumberValue(row, controls, fieldMap.totalPurchaseQty, totalPurchaseQtyNames),
      totalBoardQty: getOptionalNumberValue(row, controls, fieldMap.totalBoardQty, totalBoardQtyNames),
      printCompleted: getOptionalTextValue(row, controls, fieldMap.printCompleted, printCompletedNames),
      formingCompleted: getOptionalTextValue(row, controls, fieldMap.formingCompleted, formingCompletedNames),
      totalInboundQty: getOptionalNumberValue(row, controls, fieldMap.totalInboundQty, totalInboundQtyNames),
      totalOutboundQty: getOptionalNumberValue(row, controls, fieldMap.totalOutboundQty, totalOutboundQtyNames),
      checked: fieldMap.checked ? normalizeCheckedFlag(parseMaybeJson(checkedRaw)) : loadedQty > 0,
      plannedVolume,
      inventoryVolume,
      loadedVolume,
      plannedArea,
      inventoryArea,
      loadedArea,
      hasBoard:
        fieldMap.boardFlag === ""
          ? true
          : normalizeBoardFlag(parseMaybeJson(boardRaw)),
    };
  });
}

function needsStandardDetailHydration(row, sourceRow) {
  // The relation-list response is intentionally lightweight for fast first
  // paint.  It may omit lookup (type 30) and formula (type 31) cells even
  // though the values exist on the "装车明细" record.  Zero is a valid result,
  // so only a genuinely missing cell triggers the background row-detail read.
  const hasMissingComputedValue = [
    "convertedArea",
    "convertedVolume",
    "unitArea",
    "loadedArea",
  ].some(
    (fieldKey) => {
      const controlId = row?.fieldMap?.[fieldKey];
      return !!controlId && getNumberValueOrNull(sourceRow, controlId) === null;
    }
  );

  // These are the non-editable descriptive fields in the approved published
  // template. Their absence still needs the same background hydration.
  const hasMissingDescriptiveValue = ![
    row?.clientShortName,
    row?.workOrder,
    row?.productName,
    row?.model,
    row?.size,
  ].every((value) => String(value || "").trim());

  return hasMissingComputedValue || hasMissingDescriptiveValue;
}

async function hydrateDetailRelationText(rows, options) {
  const { worksheetId, controlId, fieldKey, names, shouldCancel } = options || {};
  if (!runtimeApi.getRowRelationRows || !controlId || !fieldKey) {
    return rows;
  }

  return mapWithConcurrency(rows, DETAIL_HYDRATE_CONCURRENCY, async (row) => {
      if (shouldCancel?.()) return row;
      const currentText = String(row?.[fieldKey] || "").trim();
      if (currentText && !isLikelyIdText(currentText)) return row;
      const rowWorksheetId = row.worksheetId || worksheetId;
      if (!row?.id || !rowWorksheetId) return row;

      try {
        const response = await runtimeApi.getRowRelationRows({
          worksheetId: rowWorksheetId,
          rowId: row.id,
          controlId,
          pageIndex: 1,
          pageSize: 50,
          keywords: "",
          getWorksheet: true,
          sortId: "",
          isAsc: false,
          shareId: "",
          linkId: "",
          filterControls: [],
          getRules: false,
          fastFilters: [],
        });

        const relationRows = getRowsFromResponse(response);
        const relationControls = getControlsFromResponse(response);
        const displayNames = names || [
          "楞型",
          "棱型",
          "楞别",
          "棱别",
          "瓦楞",
          "坑型",
          "名称",
          "编码",
          "代号",
        ];
        const relationText = relationRows
          .map(
            (relationRow) =>
              getNamedFieldText(relationRow, relationControls, displayNames) ||
              getReadableRowTitle(relationRow) ||
              getDisplayNameFromRelationItem(relationRow)
          )
          .filter(Boolean)
          .join("、");

        return relationText ? { ...row, [fieldKey]: relationText } : row;
      } catch (error) {
        console.warn("hydrate detail relation text failed", fieldKey, row.id, error);
        return row;
      }
    }, shouldCancel);
}

async function hydrateDetailRowsInBackground({
  relationRows,
  relationControls,
  appId,
  worksheetId,
  viewId,
  shouldCancel,
}) {
  const initialRows = normalizeDetailRows(relationRows, relationControls);
  const rowsToHydrate = relationRows.filter((row, index) =>
    needsStandardDetailHydration(initialRows[index], row)
  );
  if (!rowsToHydrate.length) {
    return {
      rows: initialRows,
      controls: relationControls,
      detailModelControlId: initialRows[0]?.fieldMap?.model || "",
    };
  }

  const hydratedRelation = await hydrateRelationRowDetails({
    rows: rowsToHydrate,
    controls: relationControls,
    appId,
    worksheetId,
    viewId,
    shouldCancel,
  });
  if (shouldCancel?.()) return { rows: relationRows, controls: relationControls, detailModelControlId: "" };
  const normalizedRows = normalizeDetailRows(
    hydratedRelation.rows,
    hydratedRelation.controls
  );
  const detailModelControlId = normalizedRows[0]?.fieldMap?.model || "";
  const rowsWithProductionStatus = await hydrateProductionStatusFromWorkOrder(
    normalizedRows,
    hydratedRelation.controls,
    worksheetId,
    PRODUCTION_STATUS_FIELD_NAMES,
    shouldCancel
  );
  if (shouldCancel?.()) return { rows: rowsWithProductionStatus, controls: hydratedRelation.controls, detailModelControlId: "" };
  const rowsWithLookupDisplay = await hydrateLookupDisplayFields(
    rowsWithProductionStatus,
    hydratedRelation.controls,
    [
      { key: "productionStatus", names: PRODUCTION_STATUS_FIELD_NAMES },
      {
        key: "productArchive",
        names: ["产品档案", "产品资料", "产品信息", "产品", "档案"],
      },
    ],
    shouldCancel
  );
  if (shouldCancel?.()) return { rows: rowsWithLookupDisplay, controls: hydratedRelation.controls, detailModelControlId: "" };
  const rowsWithProductArchive = await hydrateDetailRelationText(rowsWithLookupDisplay, {
    worksheetId,
    controlId: normalizedRows[0]?.fieldMap?.productArchive || "",
    fieldKey: "productArchive",
    names: ["产品档案", "产品资料", "产品信息", "产品名称", "品名", "名称", "编码"],
    shouldCancel,
  });
  if (shouldCancel?.()) return { rows: rowsWithProductArchive, controls: hydratedRelation.controls, detailModelControlId: "" };
  const hydratedRows = await hydrateDetailRelationText(rowsWithProductArchive, {
    worksheetId,
    controlId: detailModelControlId,
    fieldKey: "model",
    shouldCancel,
  });

  const hydratedById = new Map(hydratedRows.map((row) => [row.id, row]));
  return {
    rows: initialRows.map((row) => hydratedById.get(row.id) || row),
    controls: hydratedRelation.controls,
    detailModelControlId,
  };
}

function formatNumber(value, digits = 0) {
  const numeric = Number(value) || 0;
  return numeric.toFixed(digits);
}

function formatTruckText(options, selectedId) {
  if (!options.length) return "未关联货车";
  const matched = options.find((item) => item.value === selectedId);
  return matched?.label || options[0]?.label || "未选择货车";
}

function formatTruckDriver(options, selectedId) {
  if (!options.length) return "-";
  const matched = options.find((item) => item.value === selectedId);
  return matched?.driver || options[0]?.driver || "-";
}

function extractMappedControlId(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const parsed = parseMaybeJson(trimmed);
      if (parsed !== trimmed) return extractMappedControlId(parsed);
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractMappedControlId(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    const directId =
      value.controlId ||
      value.controlid ||
      value.cid ||
      value.fieldId ||
      value.fieldid ||
      value.sourceControlId ||
      value.sourceControl?.controlId ||
      value.originControlId ||
      value.originControl?.controlId ||
      value.control?.controlId ||
      value.field?.controlId ||
      value.field?.id ||
      value.selectedControlId ||
      "";
    if (directId) return directId;
    return (
      extractMappedControlId(value.value) ||
      extractMappedControlId(value.id) ||
      extractMappedControlId(value.key) ||
      extractMappedControlId(value.data) ||
      extractMappedControlId(value.field) ||
      extractMappedControlId(value.control) ||
      extractMappedControlId(value.selected) ||
      extractMappedControlId(value.selectedField) ||
      ""
    );
  }
  return "";
}

function normalizeControlId(controlId) {
  const extracted = extractMappedControlId(controlId);
  const matched = String(extracted || "").match(/[a-f0-9]{24}/i);
  return matched ? matched[0] : "";
}

function getGenericMappedControlIds(prefix) {
  const liveRuntimeEnv = getLiveRuntimeEnv();
  return Object.keys(liveRuntimeEnv)
    .filter((key) => new RegExp(`^${prefix}\\d*$`, "i").test(key))
    .sort((a, b) => {
      const indexA = Number(String(a).replace(prefix, "") || 0);
      const indexB = Number(String(b).replace(prefix, "") || 0);
      return indexA - indexB;
    })
    .map((key) => normalizeControlId(liveRuntimeEnv[key]))
    .filter(Boolean);
}

function uniqueControlIds(list) {
  const normalized = list.map((item) => normalizeControlId(item)).filter(Boolean);
  return normalized.filter((item, index) => normalized.indexOf(item) === index);
}

function getRelationControlIds(controls) {
  return uniqueControlIds(
    (Array.isArray(controls) ? controls : [])
      .filter((control) => {
        const type = Number(control?.type);
        return (
          [29, 34, 35].includes(type) ||
          String(control?.valueType || "").toLowerCase() === "array" ||
          !!getRelationWorksheetId(control)
        );
      })
      .map(getControlIdFromItem)
  );
}

function resolveTopControlIds(baseControlIds, controls, detectedTruckControlId = "", detail = null) {
  const next = { ...baseControlIds };

  Object.entries(TOP_FIELD_NAME_CANDIDATES).forEach(([key, names]) => {
    const mappedControlId = normalizeControlId(baseControlIds[key]);
    const namedControlId =
      findControlIdByNames(controls, names) ||
      findCellControlIdByNames(detail, names);
    // 日期会直接触发明道云里的日期类工作流。复用到其他工作表时，
    // 旧插件映射仍可能指向一个“存在但不是送货日期”的字段；这里应当
    // 优先采用当前记录模板中名称匹配的真实字段，再使用映射兜底。
    next[key] = key === "deliveryDate"
      ? namedControlId ||
        (mappedControlId && getControlIdFromItem(getControlById(controls, mappedControlId))) ||
        mappedControlId ||
        ""
      : (mappedControlId && getControlIdFromItem(getControlById(controls, mappedControlId))) ||
        namedControlId ||
        mappedControlId ||
        "";
  });

  const detectedTruckControl =
    getControlById(controls, detectedTruckControlId) ||
    getCellByControlId(detail, detectedTruckControlId);
  const resolvedTruckControl =
    getControlById(controls, next.truckRelation) ||
    getCellByControlId(detail, next.truckRelation);
  next.truckRelation = isRelationControl(detectedTruckControl)
    ? normalizeControlId(detectedTruckControlId)
    : isRelationControl(resolvedTruckControl)
      ? next.truckRelation
      : "";

  return next;
}

async function fetchDetailRelationRows({
  worksheetId,
  rowId,
  controlId,
  viewId,
  detail,
  pageSize = RELATION_FIRST_PAINT_PAGE_SIZE,
  fetchAll = false,
}) {
  const rawRows = getRelationArray(detail, controlId);
  const getRowRelationRows = runtimeApi.getRowRelationRows || getWorksheetApiMethod("getRowRelationRows");
  if (!getRowRelationRows) {
    return { rows: rawRows, controls: [], totalCount: rawRows.length, hasMore: false };
  }

  const requestCandidates = [
    { worksheetId, rowId, controlId, pageIndex: 1, pageSize, getWorksheet: true },
    { worksheetId, rowId, controlId, pageIndex: 1, pageSize, keywords: "", getWorksheet: true, viewId, sortId: "", isAsc: false, shareId: "", linkId: "", filterControls: [], getRules: false, fastFilters: [] },
  ].map(compactApiParams);
  let lastError = null;

  for (const params of requestCandidates) {
    try {
      if (fetchAll) {
        const result = await fetchAllPagedRows(
          (pageIndex, currentPageSize) =>
            getRowRelationRows({ ...params, pageIndex, pageSize: currentPageSize }),
          pageSize
        );
        if (result.rows.length || result.controls.length) {
          return { ...result, hasMore: false };
        }
        continue;
      }

      const response = await getRowRelationRows(params);
      const rows = getRowsFromResponse(response);
      const controls = getControlsFromResponse(response);
      const totalCount = getTotalCountFromResponse(response);
      // An empty response is still a successful response. Retrying it with a
      // compatibility payload doubled the wait time every time a relation was empty.
      return {
        rows,
        controls,
        totalCount,
        hasMore: totalCount !== null ? totalCount > rows.length : rows.length >= pageSize,
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (rawRows.length) {
    return { rows: rawRows, controls: [], totalCount: rawRows.length, hasMore: false };
  }
  if (lastError) throw lastError;
  return { rows: [], controls: [], totalCount: 0, hasMore: false };
}

async function probeDetailRelation(runtimeParams) {
  const {
    worksheetId,
    rowId,
    viewId,
    preferredControlIds,
    currentControls,
    detail,
    prefetchedRelation,
    trustedControlId,
  } = runtimeParams;
  const keywordMatchers = ["客户", "产品档案", "工单", "品名", "尺寸", "计划", "库存"];
  let bestMatch = { controlId: preferredControlIds[0] || "", rows: [], controls: [], score: -1, hasMore: false };
  const controlIds = uniqueControlIds([...preferredControlIds, ...getRelationControlIds(currentControls)]);
  const primaryControlId = controlIds[0] || "";

  function scoreRelation(controlId, rows, controls) {
    const controlNames = (Array.isArray(controls) ? controls : []).map((item) =>
      String(item?.controlName || "")
    );
    const matchedKeywordCount = keywordMatchers.filter((keyword) =>
      controlNames.some((name) => name.includes(keyword))
    ).length;
    const currentControlName =
      currentControls.find((item) => item?.controlId === controlId)?.controlName || "";
    return (
      rows.length * 20 +
      matchedKeywordCount * 8 +
      (TOP_FIELD_NAME_CANDIDATES.detailRelation.some((name) =>
        String(currentControlName).includes(name)
      )
        ? 18
        : 0) +
      (String(currentControlName).includes("明细") ? 6 : 0) +
      (String(currentControlName).includes("未装") ? 6 : 0) -
      (String(currentControlName).includes("货车") || String(currentControlName).includes("车辆") ? 50 : 0)
    );
  }

  if (primaryControlId) {
    try {
      const primary =
        prefetchedRelation?.controlId === primaryControlId
          ? prefetchedRelation
          : await fetchDetailRelationRows({
              worksheetId,
              rowId,
              controlId: primaryControlId,
              viewId,
              detail,
            });
      const matchedKeywordCount = keywordMatchers.filter((keyword) =>
        primary.controls.map((item) => String(item?.controlName || "")).some((name) => name.includes(keyword))
      ).length;
      const primaryControlName =
        currentControls.find((item) => getControlIdFromItem(item) === primaryControlId)?.controlName || "";
      const primaryLooksLikeDetail = TOP_FIELD_NAME_CANDIDATES.detailRelation.some((name) =>
        String(primaryControlName).includes(name)
      );
      const primaryLooksLikeTruck =
        String(primaryControlName).includes("货车") || String(primaryControlName).includes("车辆");
      if (
        (primaryControlId === trustedControlId && !primaryLooksLikeTruck) ||
        (primary.rows.length &&
          (matchedKeywordCount >= 2 || primaryLooksLikeDetail || !primaryLooksLikeTruck))
      ) {
        return {
          controlId: primaryControlId,
          rows: primary.rows,
          controls: primary.controls,
          score: scoreRelation(primaryControlId, primary.rows, primary.controls),
          hasMore: !!primary.hasMore,
        };
      }
      bestMatch = {
        controlId: primaryControlId,
        rows: primary.rows,
        controls: primary.controls,
        score: scoreRelation(primaryControlId, primary.rows, primary.controls),
        hasMore: !!primary.hasMore,
      };
    } catch (error) {
      console.warn("probe primary detail relation failed", primaryControlId, error);
    }
  }

  for (const controlId of controlIds.slice(primaryControlId ? 1 : 0)) {
    try {
      const { rows, controls, hasMore } = await fetchDetailRelationRows({
        worksheetId,
        rowId,
        controlId,
        viewId,
        detail,
      });
      const score = scoreRelation(controlId, rows, controls);
      const controlName =
        currentControls.find((item) => getControlIdFromItem(item) === controlId)?.controlName || "";
      const looksLikeDetail = TOP_FIELD_NAME_CANDIDATES.detailRelation.some((name) =>
        String(controlName).includes(name)
      );
      const looksLikeTruck =
        String(controlName).includes("货车") || String(controlName).includes("车辆");

      if (score > bestMatch.score) {
        bestMatch = { controlId, rows, controls, score, hasMore };
      }
      if (rows.length && (looksLikeDetail || !looksLikeTruck)) {
        return { controlId, rows, controls, score, hasMore };
      }
    } catch (error) {
      console.warn("probe detail relation failed", controlId, error);
    }
  }

  return bestMatch;
}

function probeTruckRelation(detail, currentControls, preferredControlIds) {
  // A vehicle row ID can only be saved to a relation control. A same-named
  // dropdown such as “选择货车” must not be treated as the vehicle relation.
  const candidates = uniqueControlIds(preferredControlIds).filter((controlId) => {
    const control = getControlById(currentControls, controlId);
    const cell = getCellByControlId(detail, controlId);
    return isRelationControl(control || cell);
  });
  let bestMatch = { controlId: candidates[0] || "", items: [], score: -1 };

  for (const controlId of candidates) {
    const items = getRelationArray(detail, controlId);
    const labels = items.map((item) => getDisplayNameFromRelationItem(item)).filter(Boolean);
    const readableLabelCount = labels.filter(
      (label) =>
        !/^[a-f0-9-]{24,}$/i.test(String(label)) &&
        !/^[a-f0-9]{24}$/i.test(String(label))
    ).length;
    const controlName =
      currentControls.find((item) => item?.controlId === controlId)?.controlName || "";
    const score =
      items.length * 10 +
      readableLabelCount * 6 +
      (String(controlName).includes("货车") ? 10 : 0);

    if (score > bestMatch.score) {
      bestMatch = { controlId, items, score };
    }
  }

  return bestMatch;
}

function moveColumn(columns, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return columns;
  const fromIndex = columns.findIndex((item) => item.key === fromKey);
  const toIndex = columns.findIndex((item) => item.key === toKey);
  if (fromIndex < 0 || toIndex < 0) return columns;
  const next = columns.slice();
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

function resizeColumn(columns, columnKey, width) {
  return columns.map((column) =>
    column.key === columnKey
      ? { ...column, width: Math.max(1, Math.round(width)) }
      : column
  );
}

function buildHeaderRows(columns) {
  if (!columns.some((column) => column.group)) {
    return {
      topRow: columns.map((column) => ({
        ...column,
        rowSpan: 1,
        colSpan: 1,
        type: "leaf",
      })),
      secondRow: [],
    };
  }

  const topRow = [];
  const secondRow = [];
  let currentGroup = null;

  columns.forEach((column) => {
    if (!column.group) {
      topRow.push({ ...column, rowSpan: 2, colSpan: 1, type: "leaf" });
      return;
    }

    if (!currentGroup || currentGroup.title !== column.group) {
      currentGroup = { title: column.group, colSpan: 0, type: "group" };
      topRow.push(currentGroup);
    }

    currentGroup.colSpan += 1;
    secondRow.push({ ...column, rowSpan: 1, colSpan: 1, type: "leaf" });
  });

  return { topRow, secondRow };
}

function buildDisplayRows(rows, detailRowDrafts) {
  const rowDrafts = detailRowDrafts || {};
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const rowDraft = rowDrafts[row.id] || {};
    const checked =
      rowDraft.checked === undefined ? !!row.checked : !!rowDraft.checked;
    const hasLoadedQtyDraft = rowDraft.loadedQty !== undefined;
    const loadedQty =
      hasLoadedQtyDraft ? Number(rowDraft.loadedQty) || 0 : row.loadedQty;
    return {
      ...row,
      checked,
      loadedQty,
      remark: rowDraft.remark === undefined ? row.remark : rowDraft.remark,
      loadedVolume: calculateLoadingVolume(row, loadedQty),
      loadedArea: hasLoadedQtyDraft
        ? calculateLoadingArea(row, loadedQty)
        : row.loadedArea || calculateLoadingArea(row, loadedQty),
    };
  });
}

function computeLoadingTotals(displayRows) {
  // 顶部"在装平方/在装立方"只统计当前登录人自己装的明细：装载人和当前账号（姓名或
  // 账号ID）对不上的行——包括还没人装、或者是别人之前装的——一律记 0，不计入合计，
  // 避免把别的操作人/别的批次已经装好的数量也算进这一次的进度里。
  const currentAccount = getCurrentAccountInfo();
  const currentLoaderCandidates = [currentAccount.fullname, currentAccount.accountId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return displayRows.reduce(
    (accumulator, row) => {
      const belongsToCurrentLoader =
        currentLoaderCandidates.length > 0 &&
        currentLoaderCandidates.includes(String(row.loadingUser || "").trim());
      return {
        plannedQty: accumulator.plannedQty + row.plannedQty,
        inventoryQty: accumulator.inventoryQty + row.inventoryQty,
        plannedVolume: accumulator.plannedVolume + row.plannedVolume,
        inventoryVolume: accumulator.inventoryVolume + row.inventoryVolume,
        plannedArea: accumulator.plannedArea + row.plannedArea,
        inventoryArea: accumulator.inventoryArea + row.inventoryArea,
        loadedQty: accumulator.loadedQty + (belongsToCurrentLoader ? row.loadedQty : 0),
        loadedVolume: accumulator.loadedVolume + (belongsToCurrentLoader ? row.loadedVolume : 0),
        loadedArea: accumulator.loadedArea + (belongsToCurrentLoader ? row.loadedArea : 0),
      };
    },
    {
      plannedQty: 0,
      inventoryQty: 0,
      plannedVolume: 0,
      inventoryVolume: 0,
      plannedArea: 0,
      inventoryArea: 0,
      loadedQty: 0,
      loadedVolume: 0,
      loadedArea: 0,
    }
  );
}

function describeDetailRows(rows) {
  return rows
    .map((row) => row?.productName || row?.workOrder || row?.model || row?.id || "")
    .filter(Boolean)
    .slice(0, 5)
    .join("、");
}

export default function App() {
  const appId = getRuntimeAppId();
  const worksheetId = getRuntimeWorksheetId();
  const viewId = getRuntimeViewId();
  const controlIds = useMemo(() => getControlIds(), []);
  const recordRowId = getCurrentRowId();
  const [sourceRowId, setSourceRowId] = useState(() => getCurrentRowId());
  const [userKey] = useState(() => getCurrentUserKey());
  const initialSettings = useMemo(
    () => getInitialSettings(viewId, worksheetId, userKey),
    [viewId, worksheetId, userKey]
  );
  const initialDraft = readStorageJson(getDraftStorageKey(viewId, worksheetId, userKey), {});
  const [systemFilters, setSystemFilters] = useState(() => getInitialSystemFilters());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [topHeight, setTopHeight] = useState(() => getInitialLayout(initialSettings).topHeight);
  const [leftWidth, setLeftWidth] = useState(() => getInitialLayout(initialSettings).leftWidth);
  const [topColumns, setTopColumns] = useState(() =>
    getInitialColumns("top", TOP_COLUMNS, initialSettings)
  );
  const [summaryColumns, setSummaryColumns] = useState(() =>
    getInitialColumns("summary", SUMMARY_COLUMNS, initialSettings)
  );
  const [detailColumns, setDetailColumns] = useState(() =>
    getInitialColumns("detail", DETAIL_COLUMNS, initialSettings)
  );
  const [hiddenColumns, setHiddenColumns] = useState(() => getInitialHiddenColumns(initialSettings));
  const [fieldPanel, setFieldPanel] = useState(null);
  const [saveStatus, setSaveStatus] = useState("");
  const [draggingColumn, setDraggingColumn] = useState(null);
  const [debugInfo, setDebugInfo] = useState({});
  const [rows, setRows] = useState([]);
  const rowsRef = useRef(rows);
  const [dateText, setDateText] = useState(() => getTodayInputValue());
  const [capacityArea, setCapacityArea] = useState(0);
  const [loadingArea, setLoadingArea] = useState(0);
  const [capacityVolume, setCapacityVolume] = useState(0);
  const [loadingVolume, setLoadingVolume] = useState(0);
  const [loadedVolume, setLoadedVolume] = useState(0);
  const [truckOptions, setTruckOptions] = useState([]);
  const [selectedTruckId, setSelectedTruckId] = useState("");
  const [topControls, setTopControls] = useState([]);
  const [topFieldIds, setTopFieldIds] = useState(() => controlIds);
  const [activeCustomerKey, setActiveCustomerKey] = useState(() =>
    initialDraft.activeCustomerKey === ALL_CUSTOMERS_KEY ? "" : initialDraft.activeCustomerKey || ""
  );
  const [filters, setFilters] = useState(() => initialDraft.filters || { summary: {}, detail: {} });
  const [activeColumnFilter, setActiveColumnFilter] = useState(null);
  const [draft, setDraft] = useState(() => initialDraft);
  const draftRef = useRef(draft);
  const [buttons, setButtons] = useState([]);
  const [selectedButtonId, setSelectedButtonId] = useState("");
  const [runningActionName, setRunningActionName] = useState("");
  const [supplementModalOpen, setSupplementModalOpen] = useState(false);
  const [supplementOrderOptions, setSupplementOrderOptions] = useState([]);
  const [supplementSearchText, setSupplementSearchText] = useState("");
  const [selectedSupplementOrderId, setSelectedSupplementOrderId] = useState("");
  const [supplementOrderLoading, setSupplementOrderLoading] = useState(false);
  const [supplementOrderSyncing, setSupplementOrderSyncing] = useState(false);
  const [supplementOrderFieldControl, setSupplementOrderFieldControl] = useState(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [deletingRowId, setDeletingRowId] = useState("");
  const [returnCandidate, setReturnCandidate] = useState(null);
  const [returningRowId, setReturningRowId] = useState("");
  const [globalBusyCursor, setGlobalBusyCursor] = useState(false);
  const [detailWorksheetId, setDetailWorksheetId] = useState("");
  const [detailFieldMap, setDetailFieldMap] = useState({});
  const [emptyMessage, setEmptyMessage] = useState("正在读取视图数据");
  const [detailViewport, setDetailViewport] = useState({ top: 0, height: 600 });
  const detailSyncPromisesRef = useRef(new Map());
  const detailSyncErrorsRef = useRef(new Map());
  const detailSyncLimiterRef = useRef({ active: 0, queue: [] });
  // 明细关联字段的 controlId。装载前要用它重新把明细从服务端读回来，
  // 校验“勾选/装载量”是否真的落库（明道云写入接口返回成功 ≠ 已保存）。
  const detailRelationControlIdRef = useRef("");
  // 装载前核对时明道云里没保存上的明细：保留勾选、整行标红，直到操作员重新勾选/
  // 取消，或下一次核对通过。
  const [unsavedRowIds, setUnsavedRowIds] = useState(() => new Set());
  const pendingTopTotalsRef = useRef(null);
  const topTotalsSyncTimerRef = useRef(null);
  const topDateSyncPromiseRef = useRef(null);
  const topDateSyncErrorRef = useRef(null);
  const localDetailOverridesRef = useRef({});
  const workflowHiddenRowIdsRef = useRef(new Set());
  const deletedRowIdsRef = useRef(new Set());
  const refreshTimerRef = useRef(null);
  const detailScrollRafRef = useRef(null);
  const suppressRuntimeRefreshUntilRef = useRef(0);
  // Invalidates an older supplement request as soon as the operator searches
  // again or chooses a different order.
  const supplementSelectionVersionRef = useRef(0);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const normalizedTopColumns = useMemo(() => mergeColumns(TOP_COLUMNS, topColumns), [topColumns]);
  const normalizedSummaryColumns = useMemo(
    () => mergeColumns(SUMMARY_COLUMNS, summaryColumns),
    [summaryColumns]
  );
  const normalizedDetailColumns = useMemo(
    () => mergeColumns(DETAIL_COLUMNS, detailColumns),
    [detailColumns]
  );

  function getCurrentViewSettings() {
    return {
      templateVersion: STANDARD_TEMPLATE_VERSION,
      layout: { topHeight, leftWidth },
      hiddenColumns,
      columns: {
        top: normalizedTopColumns.map(({ key, width }) => ({ key, width })),
        summary: normalizedSummaryColumns.map(({ key, width }) => ({ key, width })),
        detail: normalizedDetailColumns.map(({ key, width }) => ({ key, width })),
      },
    };
  }

  const draftStorageKey = getDraftStorageKey(viewId, worksheetId, userKey);
  const personalSettingsKey = getPersonalSettingsKey(viewId, worksheetId, userKey);

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateDetailDraft(rowId, patch) {
    setDraft((current) => ({
      ...current,
      detailRows: {
        ...(current.detailRows || {}),
        [rowId]: {
          ...((current.detailRows || {})[rowId] || {}),
          ...patch,
        },
      },
    }));
  }

  function clearDetailDraftKeys(rowId, keys) {
    setDraft((current) => {
      const currentRows = current.detailRows || {};
      const currentRow = currentRows[rowId] || {};
      if (!Object.keys(currentRow).length) return current;

      const nextRow = { ...currentRow };
      keys.forEach((key) => {
        delete nextRow[key];
      });

      const nextRows = { ...currentRows };
      if (Object.keys(nextRow).length) {
        nextRows[rowId] = nextRow;
      } else {
        delete nextRows[rowId];
      }

      return {
        ...current,
        detailRows: nextRows,
      };
    });
  }

  function updateLocalDetailRow(rowId, patch) {
    localDetailOverridesRef.current = {
      ...localDetailOverridesRef.current,
      [rowId]: {
        ...(localDetailOverridesRef.current[rowId] || {}),
        ...patch,
      },
    };
    setRows((current) => {
      const next = current.map((row) =>
        row.id === rowId
          ? {
              ...row,
              ...patch,
            }
          : row
      );
      rowsRef.current = next;
      return next;
    });
  }

  function updateLocalDetailLoaded(row, loadedQty, checked, loadingUser) {
    const nextLoadedQty = Number(loadedQty) || 0;
    setUnsavedRowIds((current) => {
      if (!current.has(row.id)) return current;
      const next = new Set(current);
      next.delete(row.id);
      return next;
    });
    updateLocalDetailRow(row.id, {
      checked,
      loadedQty: nextLoadedQty,
      loadedVolume: calculateLoadingVolume(row, nextLoadedQty),
      loadedArea: calculateLoadingArea(row, nextLoadedQty),
      ...(loadingUser === undefined ? {} : { loadingUser }),
    });
  }

  function mergeDetailOverrides(nextRows, overrides = localDetailOverridesRef.current) {
    return nextRows.filter(
      (row) =>
        !deletedRowIdsRef.current.has(row.id) &&
        !workflowHiddenRowIdsRef.current.has(row.id)
    ).map((row) => {
      const patch = overrides[row.id];
      return patch
        ? {
            ...row,
            ...patch,
          }
        : row;
    });
  }

  function trackDetailSync(rowId, promise) {
    const trackedPromise = Promise.resolve(promise);
    detailSyncPromisesRef.current.set(rowId, trackedPromise);
    const cleanup = () => {
      if (detailSyncPromisesRef.current.get(rowId) === trackedPromise) {
        detailSyncPromisesRef.current.delete(rowId);
      }
    };
    trackedPromise.then(
      () => {
        if (detailSyncPromisesRef.current.get(rowId) === trackedPromise) {
          detailSyncErrorsRef.current.delete(rowId);
        }
        cleanup();
      },
      (error) => {
        if (detailSyncPromisesRef.current.get(rowId) === trackedPromise) {
          detailSyncErrorsRef.current.set(rowId, error);
        }
        cleanup();
      }
    );
    return trackedPromise;
  }

  function runDetailSyncWithLimit(task) {
    const limiter = detailSyncLimiterRef.current;
    return new Promise((resolve, reject) => {
      const runNext = () => {
        while (limiter.active < 3 && limiter.queue.length) {
          const next = limiter.queue.shift();
          limiter.active += 1;
          Promise.resolve()
            .then(next.task)
            .then(next.resolve, next.reject)
            .finally(() => {
              limiter.active = Math.max(0, limiter.active - 1);
              runNext();
            });
        }
      };
      limiter.queue.push({ task, resolve, reject });
      runNext();
    });
  }

  function runAfterInteractionPaint(task) {
    return new Promise((resolve, reject) => {
      // A background tab may never receive an animation frame. Yield the event
      // handler without making persistence depend on the next visible paint.
      window.setTimeout(() => Promise.resolve().then(task).then(resolve, reject), 0);
    });
  }

  function queueDetailSync(rowId, task) {
    const previousSync = detailSyncPromisesRef.current.get(rowId);
    detailSyncErrorsRef.current.delete(rowId);
    // 从点下勾选的这一刻起，后台补读就不再派发新请求，保存不用排在补读后面。
    const endForegroundWork = beginForegroundWork();
    const nextSync = runAfterInteractionPaint(async () => {
      if (previousSync) {
        try {
          await previousSync;
        } catch (error) {
          // A newer local value must still be submitted even if an older save failed.
        }
      }
      return runDetailSyncWithLimit(async () => {
        let lastError;
        // Network/API throttling is transient under a quick multi-select. Keep
        // the retry inside this row's ordered queue so an older value can never
        // overwrite a newer value.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            return await task();
          } catch (error) {
            lastError = error;
            if (attempt < 2) await waitForMs(300 * (attempt + 1));
          }
        }
        throw lastError;
      });
    });
    nextSync.then(endForegroundWork, endForegroundWork);
    return trackDetailSync(rowId, nextSync);
  }

  useEffect(() => {
    setTopColumns((current) => {
      const next = mergeColumns(TOP_COLUMNS, current);
      return areColumnsEqual(current, next) ? current : next;
    });
    setSummaryColumns((current) => {
      const next = mergeColumns(SUMMARY_COLUMNS, current);
      return areColumnsEqual(current, next) ? current : next;
    });
    setDetailColumns((current) => {
      const compactActionWidths = new Map(
        DETAIL_COLUMNS
          .filter((column) => ["deleteAction", "returnAction"].includes(column.key))
          .map((column) => [column.key, column.width])
      );
      const next = mergeColumns(DETAIL_COLUMNS, current).map((column) =>
        compactActionWidths.has(column.key)
          ? { ...column, width: compactActionWidths.get(column.key) }
          : column
      );
      return areColumnsEqual(current, next) ? current : next;
    });
  }, []);

  useEffect(() => {
    localDetailOverridesRef.current = {};
    deletedRowIdsRef.current.clear();
    workflowHiddenRowIdsRef.current.clear();
    detailSyncPromisesRef.current.clear();
    detailSyncErrorsRef.current.clear();
    setUnsavedRowIds((current) => (current.size ? new Set() : current));
  }, [sourceRowId, worksheetId]);

  useEffect(() => {
    writeStorageJson(personalSettingsKey, getCurrentViewSettings());
  }, [
    personalSettingsKey,
    topHeight,
    leftWidth,
    hiddenColumns,
    normalizedTopColumns,
    normalizedSummaryColumns,
    normalizedDetailColumns,
  ]);

  useEffect(() => {
    const { dateText: _legacyDateText, ...persistedDraft } = draft || {};
    writeStorageJson(draftStorageKey, {
      ...persistedDraft,
      selectedTruckId,
      activeCustomerKey,
      sourceRowId,
      filters,
    });
  }, [activeCustomerKey, draft, draftStorageKey, filters, selectedTruckId, sourceRowId]);

  function saveSettings() {
    const settings = getCurrentViewSettings();
    writeStorageJson(personalSettingsKey, settings);
    setSaveStatus("");
  }

  // The published column set is the common starting point. This only resets
  // presentation preferences; it never touches selected rows or business data.
  function restoreStandardTemplate() {
    setTopHeight(STANDARD_LAYOUT.topHeight);
    setLeftWidth(STANDARD_LAYOUT.leftWidth);
    setTopColumns(TOP_COLUMNS);
    setSummaryColumns(SUMMARY_COLUMNS);
    setDetailColumns(DETAIL_COLUMNS);
    setHiddenColumns({
      top: [...DEFAULT_HIDDEN_COLUMNS.top],
      summary: [...DEFAULT_HIDDEN_COLUMNS.summary],
      detail: [...DEFAULT_HIDDEN_COLUMNS.detail],
    });
    setSaveStatus("已恢复发布标准模板");
  }

  useEffect(() => {
    function handleMouseMove(event) {
      if (draggingColumn?.type === "pane-horizontal") {
        const nextHeight = Math.max(78, Math.min(window.innerHeight - 220, event.clientY - 20));
        setTopHeight(nextHeight);
      }

      if (draggingColumn?.type === "pane-vertical") {
        const percent = (event.clientX / window.innerWidth) * 100;
        const nextWidth = Math.max(12, Math.min(72, percent));
        setLeftWidth(nextWidth);
      }

      if (draggingColumn?.type === "column-resize") {
        const nextWidth = draggingColumn.startWidth + event.clientX - draggingColumn.startX;
        const setters = {
          top: setTopColumns,
          summary: setSummaryColumns,
          detail: setDetailColumns,
        };
        const setter = setters[draggingColumn.table];
        if (setter) {
          setter((current) => resizeColumn(current, draggingColumn.key, nextWidth));
        }
      }
    }

    function handleMouseUp() {
      setDraggingColumn((current) =>
        current?.type === "pane-horizontal" ||
        current?.type === "pane-vertical" ||
        current?.type === "column-resize"
          ? null
          : current
      );
    }

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [draggingColumn]);

  useEffect(() => {
    function handleFilterUpdate(filters, data) {
      const nextFilters = normalizeSystemFilters(filters || data?.value || data?.filters || data || {});
      setSystemFilters((current) =>
        areSystemFiltersEqual(current, nextFilters) ? current : nextFilters
      );
    }

    function handleWindowMessage(event) {
      const payload = event?.data;
      if (!payload || typeof payload !== "object") return;
      const possible =
        payload.filters ||
        payload.value ||
        payload.data?.filters ||
        payload.data?.value ||
        null;
      if (
        possible &&
        (possible.filterControls ||
          possible.fastFilters ||
          possible.filtersGroup ||
          possible.sortControls ||
          possible.navGroupFilters ||
          possible.keyWords)
      ) {
        const nextFilters = normalizeSystemFilters(possible);
        setSystemFilters((current) =>
          areSystemFiltersEqual(current, nextFilters) ? current : nextFilters
        );
      }
    }

    FILTER_EVENTS.forEach((eventName) => {
      runtimeEmitter.on && runtimeEmitter.on(eventName, handleFilterUpdate);
    });
    window.addEventListener("message", handleWindowMessage);

    return () => {
      FILTER_EVENTS.forEach((eventName) => {
        runtimeEmitter.off && runtimeEmitter.off(eventName, handleFilterUpdate);
      });
      window.removeEventListener("message", handleWindowMessage);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cancelFullRelationLoad = () => {};

    async function loadData() {
      const loadStartedAt = Date.now();
      try {
        setEmptyMessage("正在读取视图数据");
        if (!worksheetId) {
          if (cancelled) return;
          setRows([]);
          setEmptyMessage("未获取到当前工作表，请在明道云视图中打开插件");
          return;
        }
        const pageCacheKey = getPageSwitchCacheKey({
          worksheetId,
          viewId,
          recordRowId,
          filters: systemFilters,
        });
        const latestPageCacheKey = getLatestPageSwitchCacheKey({ worksheetId, viewId, recordRowId });
        const cachedPage = readPageSwitchCache(pageCacheKey) || readPageSwitchCache(latestPageCacheKey);
        const writeCurrentPageCache = (snapshot) => {
          writePageSwitchCache(pageCacheKey, snapshot);
          writePageSwitchCache(latestPageCacheKey, snapshot);
        };
        if (cachedPage) {
          setSourceRowId(cachedPage.sourceRowId || "");
          setRows(mergeDetailOverrides(cachedPage.rows || []));
          setDateText(cachedPage.dateText || getTodayInputValue());
          setCapacityArea(Number(cachedPage.capacityArea) || 0);
          setLoadingArea(Number(cachedPage.loadingArea) || 0);
          setCapacityVolume(Number(cachedPage.capacityVolume) || 0);
          setLoadingVolume(Number(cachedPage.loadingVolume) || 0);
          setLoadedVolume(Number(cachedPage.loadedVolume) || 0);
          setTruckOptions(cachedPage.truckOptions || []);
          setSelectedTruckId(cachedPage.selectedTruckId || "");
          setTopControls(cachedPage.topControls || []);
          setTopFieldIds(cachedPage.topFieldIds || controlIds);
          setDetailWorksheetId(cachedPage.detailWorksheetId || "");
          setDetailFieldMap(cachedPage.detailFieldMap || {});
          setEmptyMessage(cachedPage.rows?.length ? "" : "暂无送货明细数据");
          setDebugInfo((current) => ({
            ...current,
            stage: "page-cache-restored",
            sourceRowId: cachedPage.sourceRowId || "",
          }));
          // Yield once so React can paint the cached page before the server
          // validation requests begin.
          await waitForMs(16);
          if (cancelled) return;
        }
        setDebugInfo({
          stage: "start",
          recordRowId,
          controlIds,
          runtimeMapping: {
            detailRelation: extractMappedControlId(
              getRuntimeMappedValue(["detailRelation", "送货明细", "明细", "未装"])
            ),
            deliveryDate: extractMappedControlId(
              getRuntimeMappedValue(["deliveryDate", "送货日期"])
            ),
            truckRelation: extractMappedControlId(
              getRuntimeMappedValue(["truckRelation", "货车", "选择货车"])
            ),
          },
          runtimeEnvKeys: Object.keys(getLiveRuntimeEnv() || {}),
          systemFilters,
        });

        // Cached content is painted above, but the current first row is still
        // resolved from Mingdao so a longer-lived cache cannot pin stale data.
        let sourceRowId = recordRowId || "";
        if (!sourceRowId) {
          const getFilterRows = runtimeApi.getFilterRows || getWorksheetApiMethod("getFilterRows");
          if (!getFilterRows) {
            setEmptyMessage("当前环境未开放视图数据读取接口");
            return;
          }
          const viewRowsRes = await getFilterRows({
            appId,
            worksheetId,
            viewId,
            pageSize: 1,
            pageIndex: 1,
            sortId: "",
            isAsc: false,
            notGetTotal: true,
            ...getFilterRequestPayload(systemFilters),
          });

          const currentViewRows = getRowsFromResponse(viewRowsRes);
          sourceRowId = getRowIdValue(currentViewRows[0]);
          setSourceRowId(sourceRowId);
          setDebugInfo((current) => ({
            ...current,
            stage: "fetched-view-rows",
            sourceRowId,
            visibleRowCount: currentViewRows.length,
            firstViewRowId: getRowIdValue(currentViewRows[0]),
          }));
        }

        if (!sourceRowId) {
          if (cancelled) return;
          setRows([]);
          setDateText(getTodayInputValue());
          setCapacityArea(0);
          setLoadingArea(0);
          setCapacityVolume(0);
          setLoadingVolume(0);
          setLoadedVolume(0);
          setTruckOptions([]);
          setSelectedTruckId("");
          setDetailWorksheetId("");
          setDetailFieldMap({});
          setEmptyMessage("当前视图暂无记录");
          return;
        }

        setSourceRowId(sourceRowId);

        const getRowDetail = runtimeApi.getRowDetail || getWorksheetApiMethod("getRowDetail");
        if (!getRowDetail) {
          setEmptyMessage("当前环境未开放记录详情读取接口");
          return;
        }
        const mappedDetailControlId = normalizeControlId(controlIds.detailRelation);
        const detailRequest = getRowDetail({
          appId,
          worksheetId,
          viewId,
          rowId: sourceRowId,
          getTemplate: true,
        });
        // A configured relation id is a reliable contract. Start its first page
        // beside the top-row request instead of paying for a second network
        // round trip after the detail response arrives.
        const relationPrefetchRequest = mappedDetailControlId
          ? fetchDetailRelationRows({
              worksheetId,
              rowId: sourceRowId,
              controlId: mappedDetailControlId,
              viewId,
            }).catch((error) => {
              console.warn("prefetch mapped detail relation failed", error);
              return null;
            })
          : Promise.resolve(null);
        const [detail, prefetchedRelationResult] = await Promise.all([
          detailRequest,
          relationPrefetchRequest,
        ]);
        const prefetchedRelation = prefetchedRelationResult
          ? { controlId: mappedDetailControlId, ...prefetchedRelationResult }
          : null;

        if (cancelled) return;

        const currentControls = getControlsFromResponse(detail);
        setTopControls(currentControls);

        const detailRelationCandidates = uniqueControlIds([
          controlIds.detailRelation,
          findControlIdByNames(currentControls, TOP_FIELD_NAME_CANDIDATES.detailRelation),
          findCellControlIdByNames(detail, TOP_FIELD_NAME_CANDIDATES.detailRelation),
          ORIGINAL_DETAIL_RELATION_CONTROL_ID,
          ...getGenericMappedControlIds("relationfield"),
          ...getRelationControlIds(currentControls),
          ...getRelationControlIds(getCellsFromRow(detail)),
          ...getGenericMappedControlIds("field"),
        ]);
        const truckRelationCandidates = uniqueControlIds([
          controlIds.truckRelation,
          findControlIdByNames(currentControls, TOP_FIELD_NAME_CANDIDATES.truckRelation),
          findCellControlIdByNames(detail, TOP_FIELD_NAME_CANDIDATES.truckRelation),
          ...getRelationControlIds(currentControls),
          ...getRelationControlIds(getCellsFromRow(detail)),
        ]);

        const truckProbe = probeTruckRelation(detail, currentControls, truckRelationCandidates);
        const nextTopFieldIds = resolveTopControlIds(
          controlIds,
          currentControls,
          truckProbe.controlId,
          detail
        );
        setTopFieldIds(nextTopFieldIds);
        const nextDateText =
          normalizeDateInputText(getFormattedDateValue(detail, nextTopFieldIds.deliveryDate)) || getTodayInputValue();
        const nextCapacityArea = getNumberValue(detail, nextTopFieldIds.capacityArea);
        const nextLoadingArea = getNumberValue(detail, nextTopFieldIds.loadingArea);
        const nextCapacityVolume = getNumberValue(detail, nextTopFieldIds.capacityVolume);
        const nextLoadingVolume = getNumberValue(detail, nextTopFieldIds.loadingVolume);
        const nextLoadedVolume = getNumberValue(detail, nextTopFieldIds.loadedVolume);
        setDateText(nextDateText);
        setCapacityArea(nextCapacityArea);
        setLoadingArea(nextLoadingArea);
        setCapacityVolume(nextCapacityVolume);
        setLoadingVolume(nextLoadingVolume);
        setLoadedVolume(nextLoadedVolume);

        const truckRelationItems = truckProbe.items;
        const currentTruckOptions = mergeTruckOptions(
          truckRelationItems.map((item) => toTruckOption(item))
        );
        setTruckOptions(currentTruckOptions);
        setSelectedTruckId((current) => {
          const nextTruckId = currentTruckOptions[0]?.value || current || draft.selectedTruckId || "";
          return nextTruckId;
        });

        const detailProbe = await probeDetailRelation({
          appId,
          worksheetId,
          rowId: sourceRowId,
          viewId,
          preferredControlIds: detailRelationCandidates,
          currentControls,
          detail,
          prefetchedRelation,
          trustedControlId: mappedDetailControlId,
        });

        const relationRows = detailProbe.rows;
        const relationControls = detailProbe.controls;
        const detailRelationControl =
          currentControls.find((control) => getControlIdFromItem(control) === detailProbe.controlId) ||
          getCellByControlId(detail, detailProbe.controlId) ||
          getCellByNames(detail, TOP_FIELD_NAME_CANDIDATES.detailRelation);
        const nextDetailWorksheetId =
          getWorksheetIdValue(relationRows[0]) ||
          getWorksheetIdFromControls(relationControls) ||
          getRelationWorksheetId(detailRelationControl) ||
          "";
        const initialRows = normalizeDetailRows(relationRows, relationControls);
        const initialDetailModelControlId = initialRows[0]?.fieldMap?.model || "";
        detailRelationControlIdRef.current = detailProbe.controlId || "";
        setDebugInfo((current) => ({
          ...current,
          stage: "relation-loaded-fast",
          sourceRowId,
          detailControlId: detailProbe.controlId,
          detailModelControlId: initialDetailModelControlId,
          truckControlId: truckProbe.controlId,
          relationRowCount: relationRows.length,
          relationHasMore: !!detailProbe.hasMore,
          relationControlCount: relationControls.length,
          firstPaintReadyMs: Date.now() - loadStartedAt,
          relationSample: relationRows[0]
            ? {
                rowId: getRowIdValue(relationRows[0]),
                rowTitle:
                  relationRows[0]?.rowtitle ||
                  relationRows[0]?.title ||
                  relationRows[0]?.name ||
                  "",
                modelRaw: getCellValue(relationRows[0], initialDetailModelControlId),
                modelText: initialRows[0]?.model || "",
                productionStatusControlId: initialRows[0]?.fieldMap?.productionStatus || "",
                productionStatusRaw: getCellValue(
                  relationRows[0],
                  initialRows[0]?.fieldMap?.productionStatus
                ),
                productionStatusText: initialRows[0]?.productionStatus || "",
              }
            : null,
        }));

        if (cancelled) return;
        const cachedRows =
          cachedPage?.sourceRowId === sourceRowId && Array.isArray(cachedPage?.rows)
            ? cachedPage.rows
            : [];
        const fastRows =
          detailProbe.hasMore && cachedRows.length > initialRows.length
            ? cachedRows
            : initialRows;
        setRows(mergeDetailOverrides(fastRows));
        setDetailWorksheetId(nextDetailWorksheetId);
        setDetailFieldMap(fastRows[0]?.fieldMap || {});
        setEmptyMessage(fastRows.length ? "" : "暂无送货明细数据");
        if (fastRows === initialRows) {
          writeCurrentPageCache({
            sourceRowId,
            rows: initialRows,
            dateText: nextDateText,
            capacityArea: nextCapacityArea,
            loadingArea: nextLoadingArea,
            capacityVolume: nextCapacityVolume,
            loadingVolume: nextLoadingVolume,
            loadedVolume: nextLoadedVolume,
            truckOptions: currentTruckOptions,
            selectedTruckId: currentTruckOptions[0]?.value || draft.selectedTruckId || "",
            topControls: currentControls,
            topFieldIds: nextTopFieldIds,
            detailWorksheetId: nextDetailWorksheetId,
            detailFieldMap: initialRows[0]?.fieldMap || {},
          });
        }

        if (detailProbe.hasMore && detailProbe.controlId) {
          cancelFullRelationLoad();
          cancelFullRelationLoad = scheduleAfterFirstPaint(async () => {
            try {
              const fullRelation = await fetchDetailRelationRows({
                worksheetId,
                rowId: sourceRowId,
                controlId: detailProbe.controlId,
                viewId,
                detail,
                pageSize: RELATION_FETCH_PAGE_SIZE,
                fetchAll: true,
              });
              if (cancelled || !fullRelation.rows.length) return;
              const fullControls = mergeControls(relationControls, fullRelation.controls);
              const fullRows = normalizeDetailRows(fullRelation.rows, fullControls);
              setRows(mergeDetailOverrides(fullRows));
              setDetailFieldMap(fullRows[0]?.fieldMap || {});
              setEmptyMessage(fullRows.length ? "" : "暂无送货明细数据");
              writeCurrentPageCache({
                sourceRowId,
                rows: fullRows,
                dateText: nextDateText,
                capacityArea: nextCapacityArea,
                loadingArea: nextLoadingArea,
                capacityVolume: nextCapacityVolume,
                loadingVolume: nextLoadingVolume,
                loadedVolume: nextLoadedVolume,
                truckOptions: currentTruckOptions,
                selectedTruckId: currentTruckOptions[0]?.value || draft.selectedTruckId || "",
                topControls: currentControls,
                topFieldIds: nextTopFieldIds,
                detailWorksheetId: nextDetailWorksheetId,
                detailFieldMap: fullRows[0]?.fieldMap || {},
              });
              setDebugInfo((current) => ({
                ...current,
                stage: "relation-loaded-complete",
                relationRowCount: fullRows.length,
                fullLoadReadyMs: Date.now() - loadStartedAt,
              }));
            } catch (error) {
              console.warn("background full relation load failed", error);
            }
          });
        }

        if (
          !detailProbe.hasMore &&
          nextDetailWorksheetId &&
          !initialRows[0]?.fieldMap?.checked
        ) {
          window.setTimeout(() => {
            if (cancelled) return;
            fetchLookupWorksheetControls(nextDetailWorksheetId)
              .then((detailTemplateControls) => {
                if (cancelled || !detailTemplateControls.length) return;
                const quickRows = normalizeDetailRows(
                  relationRows,
                  mergeControls(relationControls, detailTemplateControls)
                );
                setRows(mergeDetailOverrides(quickRows));
                setDetailFieldMap(quickRows[0]?.fieldMap || {});
              })
              .catch((error) => {
                console.warn("quick detail controls hydration failed", error);
              });
          }, 800);
        }

        if (!detailProbe.hasMore && relationRows.length <= DETAIL_BACKGROUND_HYDRATE_LIMIT) {
          window.setTimeout(() => {
            if (cancelled) return;
            Promise.resolve(nextDetailWorksheetId ? fetchLookupWorksheetControls(nextDetailWorksheetId) : [])
              .then((detailTemplateControls) =>
                hydrateDetailRowsInBackground({
                  relationRows,
                  relationControls: mergeControls(relationControls, detailTemplateControls),
                  appId,
                  worksheetId: nextDetailWorksheetId,
                  viewId,
                  shouldCancel: () => cancelled,
                })
              )
              .then((hydrated) => {
                if (cancelled) return;
                setRows(mergeDetailOverrides(hydrated.rows));
                setDetailFieldMap(hydrated.rows[0]?.fieldMap || {});
                setDebugInfo((current) => ({
                  ...current,
                  stage: "relation-hydrated",
                  detailModelControlId: hydrated.detailModelControlId,
                  relationControlCount: hydrated.controls.length,
                  relationSample: hydrated.rows[0]
                    ? {
                        ...(current.relationSample || {}),
                        modelText: hydrated.rows[0]?.model || "",
                        productionStatusText: hydrated.rows[0]?.productionStatus || "",
                      }
                    : current.relationSample,
                }));
              })
              .catch((error) => {
                console.warn("background detail hydration failed", error);
              });
          }, 4500);
        } else {
          setDebugInfo((current) => ({
            ...current,
            stage: "relation-loaded-fast-large",
            hydrationSkipped: true,
          }));
        }

        const truckControl = currentControls.find(
          (control) => control?.controlId === truckProbe.controlId
        );
        const truckWorksheetId = getRelationWorksheetId(truckControl);

        if (truckWorksheetId) {
          const getWorksheetInfo = runtimeApi.getWorksheetInfo || getWorksheetApiMethod("getWorksheetInfo");
          const getFilterRows = runtimeApi.getFilterRows || getWorksheetApiMethod("getFilterRows");
          if (!getWorksheetInfo || !getFilterRows) return;
          const truckWorksheetInfo = await getWorksheetInfo({
            worksheetId: truckWorksheetId,
            relationWorksheetId: "",
            getTemplate: true,
            getViews: true,
            appId,
            handleDefault: false,
            worksheetIds: [],
            handControlSource: true,
            getRules: false,
            getSwitchPermit: false,
            getRelationSearch: false,
            resultType: 0,
          });

          const truckView =
            truckWorksheetInfo?.views?.find((item) => !item?.advancedSetting?.hide) ||
            truckWorksheetInfo?.views?.[0];
          const truckControls = getControlsFromResponse(truckWorksheetInfo);

          if (truckView?.viewId) {
            const truckRowsRes = await getFilterRows({
              worksheetId: truckWorksheetId,
              viewId: truckView.viewId,
              pageSize: 200,
              pageIndex: 1,
              sortId: "",
              isAsc: false,
              notGetTotal: true,
            });

            const availableTruckRows = getRowsFromResponse(truckRowsRes);
            const mergedOptions = mergeTruckOptions(
              [
                ...currentTruckOptions,
                ...availableTruckRows.map((row) => toTruckOption(row, truckControls)),
              ]
            );

            if (!cancelled && mergedOptions.length) {
              setTruckOptions(mergedOptions);
              setSelectedTruckId((current) => {
                const nextTruckId = current || mergedOptions[0]?.value || draft.selectedTruckId || "";
                return nextTruckId;
              });
            }
          }
        }
      } catch (error) {
        console.error("load widget data failed", error);
        if (cancelled) return;
        setDebugInfo((current) => ({
          ...current,
          stage: "load-error",
          errorMessage: error?.message || String(error),
        }));
        setRows([]);
        setTruckOptions([]);
        setSelectedTruckId("");
        setEmptyMessage("加载数据失败，请刷新后重试");
      }
    }

    loadData();
    return () => {
      cancelled = true;
      cancelFullRelationLoad();
    };
  }, [appId, controlIds, recordRowId, refreshVersion, systemFilters, viewId, worksheetId]);

  useEffect(() => {
    function refresh() {
      // Saving a checkbox or input can emit several Mingdao record events.
      // The affected row is already rendered optimistically; reloading the
      // whole relation here makes the grid jump and blocks continued input.
      if (Date.now() < suppressRuntimeRefreshUntilRef.current) return;
      // Mingdao may emit several record events for one user action. Coalesce
      // them so opening a view does not restart the same data load repeatedly.
      window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        setRefreshVersion((current) => current + 1);
      }, 180);
    }

    REFRESH_EVENTS.forEach((eventName) => {
      runtimeEmitter.on && runtimeEmitter.on(eventName, refresh);
    });

    return () => {
      window.clearTimeout(refreshTimerRef.current);
      REFRESH_EVENTS.forEach((eventName) => {
        runtimeEmitter.off && runtimeEmitter.off(eventName, refresh);
      });
    };
  }, []);

  useEffect(() => {
    return () => window.cancelAnimationFrame(detailScrollRafRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadButtons() {
      const getButtons = getWorksheetApiMethod("getWorksheetBtns");
      if (!getButtons || !sourceRowId) {
        setButtons([]);
        setSelectedButtonId("");
        return;
      }

      try {
        const requestCandidates = [
          { appId, viewId, rowId: sourceRowId, rowIds: [sourceRowId], worksheetId, btnId: "", btnType: 0, status: 1 },
          { appId, viewId: "", rowId: sourceRowId, rowIds: [sourceRowId], worksheetId, btnId: "", btnType: 0, status: 1 },
          { appId, viewId, rowId: sourceRowId, worksheetId, btnId: "", status: 1 },
          { appId, viewId: "", rowId: sourceRowId, worksheetId, btnId: "", status: 1 },
        ].map(compactApiParams);
        const mergedButtons = new Map();

        for (const params of requestCandidates) {
          try {
            const response = await getButtons(params);
            const candidateButtons = getButtonsFromResponse(response).filter(Boolean);
            candidateButtons.forEach((button) => {
                const key = getButtonId(button) || getButtonName(button) || JSON.stringify(button);
                if (key && !mergedButtons.has(key)) mergedButtons.set(key, button);
              });
            // The runtime normally returns the complete button list on the
            // first valid request. Only try compatibility signatures when it
            // did not return the loading actions we need.
            if (
              findButtonByAliases(candidateButtons, CONFIRM_LOADING_BUTTON_ALIASES) ||
              findButtonByAliases(candidateButtons, SUPPLEMENT_LOADING_BUTTON_ALIASES)
            ) {
              break;
            }
          } catch (error) {
            console.warn("load worksheet buttons candidate failed", params, error);
          }
        }

        const visibleButtons = Array.from(mergedButtons.values());
        if (cancelled) return;
        setButtons(visibleButtons);
        const confirmButton = findButtonByAliases(visibleButtons, CONFIRM_LOADING_BUTTON_ALIASES);
        setSelectedButtonId(getButtonId(confirmButton));
      } catch (error) {
        console.warn("load worksheet buttons failed", error);
        if (!cancelled) {
          setButtons([]);
          setSelectedButtonId("");
        }
      }
    }

    loadButtons();
    return () => {
      cancelled = true;
    };
  }, [appId, sourceRowId, viewId, worksheetId]);

  const displayRows = useMemo(
    () => buildDisplayRows(rows, draft.detailRows),
    [draft.detailRows, rows]
  );

  // 装载流程要跑好几秒，期间数据可能被重新加载。核对和隐藏都必须基于“此刻”的
  // 行，而不是点击装载那一次渲染时闭包里的 displayRows。
  function getLatestDisplayRows() {
    return buildDisplayRows(rowsRef.current, draftRef.current?.detailRows);
  }

  const boardRows = useMemo(
    () => displayRows.filter((row) => row.hasBoard !== false),
    [displayRows]
  );

  const customerGroups = useMemo(() => {
    const groupMap = new Map();

    boardRows.forEach((row) => {
      const key = getCustomerGroupKey(row);
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          clientCode: row.clientCode || "",
          clientShortName: getAddressIndependentCustomerText(row) || "未识别客户",
          clientName: row.address || row.clientName || row.client || "未维护地址",
          routeSet: new Set(),
          detailCount: 0,
          plannedQty: 0,
          inventoryQty: 0,
          plannedVolume: 0,
          inventoryVolume: 0,
          plannedArea: 0,
          inventoryArea: 0,
          loadedArea: 0,
        });
      }

      const current = groupMap.get(key);
      if (!current.clientCode && row.clientCode) current.clientCode = row.clientCode;
      if (current.clientName === "未维护地址" && (row.address || row.clientName || row.client)) {
        current.clientName = row.address || row.clientName || row.client;
      }
      if (row.route) current.routeSet.add(row.route);
      current.detailCount += 1;
      current.plannedQty += row.plannedQty;
      current.inventoryQty += row.inventoryQty;
      current.plannedVolume += row.plannedVolume;
      current.inventoryVolume += row.inventoryVolume;
      current.plannedArea += row.plannedArea;
      current.inventoryArea += row.inventoryArea;
      current.loadedArea += row.loadedArea;
    });

    return Array.from(groupMap.values())
      .map((item) => ({
        ...item,
        route: Array.from(item.routeSet).join("、") || "未维护路径",
      }))
      .sort(compareCustomerGroups);
  }, [boardRows]);

  const allCustomerGroup = useMemo(() => {
    return customerGroups.reduce(
      (accumulator, customer) => ({
        ...accumulator,
        detailCount: accumulator.detailCount + customer.detailCount,
        plannedQty: accumulator.plannedQty + customer.plannedQty,
        inventoryQty: accumulator.inventoryQty + customer.inventoryQty,
        plannedVolume: accumulator.plannedVolume + customer.plannedVolume,
        inventoryVolume: accumulator.inventoryVolume + customer.inventoryVolume,
        plannedArea: accumulator.plannedArea + customer.plannedArea,
        inventoryArea: accumulator.inventoryArea + customer.inventoryArea,
        loadedArea: accumulator.loadedArea + customer.loadedArea,
      }),
      {
        key: ALL_CUSTOMERS_KEY,
        clientCode: "",
        clientShortName: "全部",
        clientName: "全部客户",
        route: "全部",
        detailCount: 0,
        plannedQty: 0,
        inventoryQty: 0,
        plannedVolume: 0,
        inventoryVolume: 0,
        plannedArea: 0,
        inventoryArea: 0,
        loadedArea: 0,
      }
    );
  }, [customerGroups]);
  const effectiveActiveCustomerKey =
    activeCustomerKey === ALL_CUSTOMERS_KEY
      ? ALL_CUSTOMERS_KEY
      : activeCustomerKey || customerGroups[0]?.key || "";

  // Keep the customer's explicit selection stable while a write operation
  // reloads data. During that short reload customerGroups can be empty, and
  // resetting it there used to make the detail panel jump back to the first
  // customer. A selection is now changed only by the user's own click (or by
  // closing/resetting the page draft), never by a transient data refresh.

  const detailRows = useMemo(() => {
    const sourceRows =
      !effectiveActiveCustomerKey || effectiveActiveCustomerKey === ALL_CUSTOMERS_KEY
        ? displayRows
        : displayRows.filter(
            (row) => getCustomerGroupKey(row) === effectiveActiveCustomerKey
          );
    return [...sourceRows].sort(compareDetailRows);
  }, [displayRows, effectiveActiveCustomerKey]);

  const filteredCustomerGroups = useMemo(() => {
    return customerGroups.filter((customer) =>
      Object.entries(filters.summary || {}).every(([key, value]) => {
        return matchesFilterText(getSummaryCellValue(customer, { key }), value);
      })
    );
  }, [customerGroups, filters.summary]);
  const visibleCustomerGroups = useMemo(
    () => (customerGroups.length ? [...filteredCustomerGroups, allCustomerGroup] : []),
    [allCustomerGroup, customerGroups.length, filteredCustomerGroups]
  );

  const filteredDetailRows = useMemo(() => {
    return detailRows.filter((row, index) =>
      Object.entries(filters.detail || {}).every(([key, value]) => {
        return matchesFilterText(getDetailCellValue(row, { key }, index), value);
      })
    );
  }, [detailRows, filters.detail]);
  const virtualDetailRows = useMemo(() => {
    const total = filteredDetailRows.length;
    const start = Math.max(
      0,
      Math.floor(detailViewport.top / DETAIL_ROW_HEIGHT) - DETAIL_ROW_OVERSCAN
    );
    const end = Math.min(
      total,
      Math.ceil((detailViewport.top + detailViewport.height) / DETAIL_ROW_HEIGHT) + DETAIL_ROW_OVERSCAN
    );
    return {
      start,
      rows: filteredDetailRows.slice(start, end),
      beforeHeight: start * DETAIL_ROW_HEIGHT,
      afterHeight: Math.max(0, total - end) * DETAIL_ROW_HEIGHT,
    };
  }, [detailViewport.height, detailViewport.top, filteredDetailRows]);
  const hasCheckedDetailRows = useMemo(
    // Rows loaded by another account are visible, but must never become part
    // of this account's loading action.
    () => filteredDetailRows.some((row) => !!row.checked && !isRowLoadedByAnotherAccount(row)),
    [filteredDetailRows]
  );

  const totals = useMemo(() => computeLoadingTotals(displayRows), [displayRows]);

  const currentTruckText = formatTruckText(truckOptions, selectedTruckId);
  const currentTruckDriver = formatTruckDriver(truckOptions, selectedTruckId);
  const currentTruckCapacityArea =
    truckOptions.find((item) => item.value === selectedTruckId)?.capacityArea || 0;
  const currentTruckCapacityVolume =
    truckOptions.find((item) => item.value === selectedTruckId)?.capacityVolume || 0;
  const effectiveCapacityArea = currentTruckCapacityArea || capacityArea;
  const effectiveLoadingArea = rows.length ? totals.loadedArea : loadingArea;
  const effectiveCapacityVolume = currentTruckCapacityVolume || capacityVolume;
  const progress = effectiveCapacityArea
    ? calculateProgressPercent(effectiveLoadingArea, effectiveCapacityArea)
    : calculateProgressPercent(totals.loadedVolume, effectiveCapacityVolume);
  const progressWidth = Math.max(0, Math.min(100, progress));
  const progressTone =
    progress >= 100
      ? {
          fill: "linear-gradient(90deg, #ef4444, #dc2626, #f87171)",
          track: "#fff1f2",
          border: "#fca5a5",
          color: "#7f1d1d",
        }
      : progress >= 85
        ? {
            fill: "linear-gradient(90deg, #f59e0b, #f97316, #fbbf24)",
            track: "#fff7ed",
            border: "#fdba74",
            color: "#7c2d12",
          }
        : {
            fill: "linear-gradient(90deg, #1d8fff, #145bd7, #52b6ff)",
            track: "#eaf4ff",
            border: "#91b8e4",
            color: "#153f70",
          };

  useEffect(() => {
    if (currentTruckCapacityArea && currentTruckCapacityArea !== capacityArea) {
      setCapacityArea(currentTruckCapacityArea);
    }
  }, [capacityArea, currentTruckCapacityArea]);

  useEffect(() => {
    if (currentTruckCapacityVolume && currentTruckCapacityVolume !== capacityVolume) {
      setCapacityVolume(currentTruckCapacityVolume);
    }
  }, [capacityVolume, currentTruckCapacityVolume]);

  const visibleTopColumns = useMemo(
    () => normalizedTopColumns.filter((column) => !hiddenColumns.top.includes(column.key)),
    [hiddenColumns.top, normalizedTopColumns]
  );
  const visibleSummaryColumns = useMemo(
    () => normalizedSummaryColumns.filter((column) => !hiddenColumns.summary.includes(column.key)),
    [hiddenColumns.summary, normalizedSummaryColumns]
  );
  const visibleDetailColumns = useMemo(
    () => normalizedDetailColumns.filter(
      (column) =>
        ["deleteAction", "returnAction"].includes(column.key) ||
        !hiddenColumns.detail.includes(column.key)
    ),
    [hiddenColumns.detail, normalizedDetailColumns]
  );
  const topHeaders = buildHeaderRows(visibleTopColumns);
  const summaryHeaders = buildHeaderRows(visibleSummaryColumns);
  const detailHeaders = buildHeaderRows(visibleDetailColumns);
  const topMinWidth = `${visibleTopColumns.reduce((sum, column) => sum + (column.width || 96), 0)}px`;
  const summaryMinWidth = `${visibleSummaryColumns.reduce((sum, column) => sum + (column.width || 96), 0)}px`;
  const detailMinWidth = `${visibleDetailColumns.reduce((sum, column) => sum + (column.width || 96), 0)}px`;

  function toggleColumn(tableName, columnKey) {
    setHiddenColumns((current) => {
      const currentHidden = current[tableName] || [];
      const nextHidden = currentHidden.includes(columnKey)
        ? currentHidden.filter((key) => key !== columnKey)
        : [...currentHidden, columnKey];
      return { ...current, [tableName]: nextHidden };
    });
  }

  function getActiveFilterCount(tableName) {
    return Object.values(filters[tableName] || {}).filter((value) => normalizeFilterText(value)).length;
  }

  function clearTableFilters(tableName) {
    setFilters((current) => ({ ...current, [tableName]: {} }));
    setActiveColumnFilter((current) => (current?.tableName === tableName ? null : current));
  }

  function setColumnFilterValue(tableName, columnKey, value) {
    setFilters((current) => {
      const nextTableFilters = { ...(current[tableName] || {}) };
      if (normalizeFilterText(value)) nextTableFilters[columnKey] = value;
      else delete nextTableFilters[columnKey];
      return { ...current, [tableName]: nextTableFilters };
    });
  }

  function renderFieldButton() {
    return (
      <FieldButton
        type="button"
        onClick={() => setFieldPanel((current) => (current ? null : "all"))}
      >
        字段
      </FieldButton>
    );
  }

  function handleDetailTableScroll(event) {
    const target = event.currentTarget;
    const nextViewport = { top: target.scrollTop, height: target.clientHeight };
    window.cancelAnimationFrame(detailScrollRafRef.current);
    detailScrollRafRef.current = window.requestAnimationFrame(() => {
      setDetailViewport((current) =>
        current.top === nextViewport.top && current.height === nextViewport.height
          ? current
          : nextViewport
      );
    });
  }

  function renderFieldPopover() {
    if (!fieldPanel) return null;
    const groups = [
      { key: "top", title: "装车信息", columns: normalizedTopColumns },
      { key: "summary", title: "汇总", columns: normalizedSummaryColumns },
      { key: "detail", title: "明细", columns: normalizedDetailColumns },
    ];

    return (
      <FieldPopover $top={42}>
        <FieldPopoverHead>
          <span>字段设置</span>
          <FieldButton type="button" onClick={() => setFieldPanel(null)}>
            关闭
          </FieldButton>
        </FieldPopoverHead>
        <FieldPopoverActions>
          <FieldButton type="button" onClick={restoreStandardTemplate}>
            恢复标准
          </FieldButton>
          <SaveButton type="button" $primary onClick={saveSettings}>
            保存个人
          </SaveButton>
        </FieldPopoverActions>
        {saveStatus ? <SaveStatus>{saveStatus}</SaveStatus> : null}
        {groups.map((group) => (
          <React.Fragment key={group.key}>
            <FieldGroupTitle>{group.title}</FieldGroupTitle>
            {group.columns.map((column) => (
              <FieldOption key={`${group.key}-${column.key}`}>
                <input
                  type="checkbox"
                  checked={
                    ["deleteAction", "returnAction"].includes(column.key) ||
                    !(hiddenColumns[group.key] || []).includes(column.key)
                  }
                  disabled={["deleteAction", "returnAction"].includes(column.key)}
                  onChange={() => toggleColumn(group.key, column.key)}
                />
                <span>{column.title}</span>
              </FieldOption>
            ))}
          </React.Fragment>
        ))}
      </FieldPopover>
    );
  }

  function getDetailActionRight(columnKey) {
    if (columnKey === "returnAction") return 0;
    if (columnKey === "deleteAction") {
      return normalizedDetailColumns.find((column) => column.key === "returnAction")?.width || 30;
    }
    return null;
  }

  function renderHeaderCell(column, tableName, setter) {
    const filterable = tableName !== "top" && column.filterable !== false;
    const filterActive = !!normalizeFilterText(filters[tableName]?.[column.key]);
    const actionRight = tableName === "detail" ? getDetailActionRight(column.key) : null;
    const baseStyle = column.width ? { width: column.width } : {};
    const actionStyle = actionRight === null
      ? {}
      : {
          ...baseStyle,
          position: "sticky",
          right: actionRight,
          zIndex: 12,
          textAlign: "center",
          padding: "4px 2px",
          background: "#e2effd",
          boxShadow: actionRight ? "-1px 0 0 #b9cfe7" : "-2px 0 5px rgba(37, 76, 116, 0.18)",
        };
    const filterStyle = filterActive
      ? {
          background: "#cfe8ff",
          color: "#075f9e",
          boxShadow: "inset 0 -3px 0 #1689e6",
        }
      : {};
    const headerStyle = { ...baseStyle, ...actionStyle, ...filterStyle };
    return (
      <th
        key={column.key}
        rowSpan={column.rowSpan}
        colSpan={column.colSpan}
        style={Object.keys(headerStyle).length ? headerStyle : undefined}
        onDragOver={(event) => event.preventDefault()}
        onDrop={() => {
          if (draggingColumn?.type === "column" && draggingColumn.table === tableName) {
            setter((current) => moveColumn(current, draggingColumn.key, column.key));
          }
          setDraggingColumn(null);
        }}
      >
        <HeaderCellContent>
          <HeaderDragButton
            type="button"
            draggable={
              column.type === "leaf" &&
              !["deleteAction", "returnAction"].includes(column.key)
            }
            onDragStart={() => setDraggingColumn({ type: "column", table: tableName, key: column.key })}
            onDragEnd={() => setDraggingColumn(null)}
          >
            {column.title}
          </HeaderDragButton>
          {filterable ? (
            <ColumnFilterButton
              type="button"
              $active={filterActive}
              aria-label={`筛选${column.title}`}
              title={`筛选${column.title}`}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                const width = 300;
                setActiveColumnFilter({
                  tableName,
                  columnKey: column.key,
                  title: column.title,
                  top: Math.max(10, Math.min(window.innerHeight - 340, rect.bottom + 1)),
                  left: Math.max(10, Math.min(window.innerWidth - width - 10, rect.left)),
                  width,
                });
              }}
            >
              ▼
            </ColumnFilterButton>
          ) : null}
        </HeaderCellContent>
        <HeaderResizeHandle
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setDraggingColumn({
              type: "column-resize",
              table: tableName,
              key: column.key,
              startX: event.clientX,
              startWidth: column.width || event.currentTarget.parentElement.offsetWidth,
            });
          }}
        />
      </th>
    );
  }

  function getFilterOptions(tableName, column, searchText = "") {
    const sourceRows =
      tableName === "summary"
        ? customerGroups.map((customer) => getSummaryCellValue(customer, column))
        : detailRows.map((row, index) => getDetailCellValue(row, column, index));
    // Filter first, then cap the list. Previously the first 200 values were
    // rendered regardless of what had been typed, so a valid customer could
    // be hidden far down the list and the popover looked unfiltered.
    return Array.from(new Set(sourceRows.map(getOptionLabel).filter(Boolean)))
      .filter((label) => matchesFilterText(label, searchText))
      .sort((left, right) => String(left).localeCompare(String(right), "zh-CN", { numeric: true }))
      .slice(0, 200)
      .map((label) => ({ value: label, label }));
  }

  function renderFilterActions(tableName) {
    const activeCount = getActiveFilterCount(tableName);
    if (!activeCount) return null;
    return (
      <>
        <ActiveFilterBadge>已筛选 {activeCount} 项</ActiveFilterBadge>
        <FieldButton type="button" onClick={() => clearTableFilters(tableName)}>清除筛选</FieldButton>
      </>
    );
  }

  function renderColumnFilterPopover() {
    if (!activeColumnFilter) return null;
    const { tableName, columnKey, title, top, left, width } = activeColumnFilter;
    const columns = tableName === "summary" ? normalizedSummaryColumns : normalizedDetailColumns;
    const column = columns.find((item) => item.key === columnKey) || { key: columnKey, title };
    const value = filters[tableName]?.[columnKey] || "";
    const hasFilterText = !!normalizeFilterText(value);
    const options = hasFilterText ? getFilterOptions(tableName, column, value) : [];
    return (
      <>
        <FilterPopoverBackdrop onClick={() => setActiveColumnFilter(null)} />
        <ColumnFilterPopover $top={top} $left={left} $width={width} role="dialog" aria-label={`筛选${title}`}>
          <ColumnFilterTitle>
            <span>筛选 {title}</span>
            <ColumnFilterClearButton
              type="button"
              onClick={() => setColumnFilterValue(tableName, columnKey, "")}
            >
              清空
            </ColumnFilterClearButton>
          </ColumnFilterTitle>
          <ColumnFilterBody>
            <CellFilterInput
              autoFocus
              value={value === "__EMPTY__" ? "" : value}
              placeholder="手工输入筛选"
              onChange={(event) => setColumnFilterValue(tableName, columnKey, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Enter") setActiveColumnFilter(null);
              }}
            />
            {hasFilterText ? (
              <ColumnFilterOptionList>
                {options.length ? options.map((option) => (
                  <ColumnFilterOptionButton
                    key={option.value}
                    type="button"
                    $active={value === option.value}
                    onClick={() => setColumnFilterValue(tableName, columnKey, option.value)}
                  >
                    <ColumnFilterCheck $active={value === option.value}>
                      {value === option.value ? "✓" : ""}
                    </ColumnFilterCheck>
                    <span>{option.label}</span>
                  </ColumnFilterOptionButton>
                )) : <ColumnFilterEmpty>未找到匹配内容</ColumnFilterEmpty>}
              </ColumnFilterOptionList>
            ) : (
              <ColumnFilterEmpty>输入内容后进行模糊筛选</ColumnFilterEmpty>
            )}
          </ColumnFilterBody>
        </ColumnFilterPopover>
      </>
    );
  }

  function getDetailWorksheetId(row) {
    return row?.worksheetId || detailWorksheetId;
  }

  function getLoadingTotalsWithPatch(rowId, loadedQty) {
    return displayRows.reduce(
      (result, row) => {
        const nextLoadedQty = row.id === rowId ? Number(loadedQty) || 0 : row.loadedQty;
        result.volume += calculateLoadingVolume(row, nextLoadedQty);
        result.area += calculateLoadingArea(row, nextLoadedQty);
        return result;
      },
      { volume: 0, area: 0 }
    );
  }

  function getTopDateInputValueFromDetail(detail, controlId) {
    return (
      normalizeDateInputText(getFormattedDateValue(detail, controlId)) ||
      normalizeDateInputText(getTextValue(detail, controlId)) ||
      normalizeDateInputText(getCellValue(detail, controlId))
    );
  }

  async function fetchTopRowDetail(options = {}) {
    const getRowDetail = getWorksheetApiMethod("getRowDetail");
    if (!getRowDetail || !sourceRowId) {
      throw new Error("当前环境未开放装车单读取接口");
    }

    return getRowDetail(compactApiParams({
      appId,
      worksheetId,
      viewId: options.withViewId === false ? "" : viewId,
      rowId: sourceRowId,
      getTemplate: true,
    }));
  }

  function applyTopDetailFromServer(detail, activeTopFieldIds = topFieldIds || controlIds) {
    const currentControls = getControlsFromResponse(detail);
    if (currentControls.length) {
      setTopControls(currentControls);
    }

    const serverDateText = getTopDateInputValueFromDetail(detail, activeTopFieldIds.deliveryDate);
    if (serverDateText) {
      setDateText(serverDateText);
    }

    if (activeTopFieldIds.capacityArea) {
      setCapacityArea(getNumberValue(detail, activeTopFieldIds.capacityArea));
    }
    if (activeTopFieldIds.loadingArea) {
      setLoadingArea(getNumberValue(detail, activeTopFieldIds.loadingArea));
    }
    if (activeTopFieldIds.capacityVolume) {
      setCapacityVolume(getNumberValue(detail, activeTopFieldIds.capacityVolume));
    }
    if (activeTopFieldIds.loadingVolume) {
      setLoadingVolume(getNumberValue(detail, activeTopFieldIds.loadingVolume));
    }
    if (activeTopFieldIds.loadedVolume) {
      setLoadedVolume(getNumberValue(detail, activeTopFieldIds.loadedVolume));
    }

    return {
      serverDateText,
      controls: currentControls,
    };
  }

  async function verifyTopDateSaved(
    expectedDateText,
    controlId,
    activeTopFieldIds = topFieldIds || controlIds,
    options = {}
  ) {
    const normalizedExpectedDate = normalizeDateInputText(expectedDateText);
    const attempts = options.attempts || 5;
    const intervalMs = options.intervalMs || 700;
    let normalizedServerDate = "";

    for (let index = 0; index < attempts; index += 1) {
      if (index > 0) await waitForMs(intervalMs);
      const detail = await fetchTopRowDetail();
      let serverDateText = getTopDateInputValueFromDetail(detail, controlId);

      // A custom-view `getRowDetail` response may omit a field which is not a
      // native column of that view. Re-read the same record without viewId
      // before deciding that the date is empty; this also prevents a false
      // failure after Mingdao has already saved the field successfully.
      if (!serverDateText && viewId) {
        const worksheetDetail = await fetchTopRowDetail({ withViewId: false });
        serverDateText = getTopDateInputValueFromDetail(worksheetDetail, controlId);
        if (serverDateText) {
          applyTopDetailFromServer(worksheetDetail, activeTopFieldIds);
        }
      } else {
        applyTopDetailFromServer(detail, activeTopFieldIds);
      }
      normalizedServerDate = normalizeDateInputText(serverDateText);
      if (areSameDateInputValues(normalizedServerDate, normalizedExpectedDate)) break;
    }

    setDebugInfo((current) => ({
      ...current,
      deliveryDateSync: {
        rowId: sourceRowId,
        controlId,
        expectedDate: normalizedExpectedDate,
        serverDate: normalizedServerDate || "",
      },
    }));

    if (!areSameDateInputValues(normalizedServerDate, normalizedExpectedDate)) {
      throw new Error(
        `送货日期未写入服务器，字段ID=${controlId}，服务器当前=${normalizedServerDate || "空"}，目标=${normalizedExpectedDate || "空"}`
      );
    }

    return true;
  }

  async function verifyNumberFieldSaved({
    rowWorksheetId,
    rowId,
    controlId,
    expectedValue,
    fieldName,
    activeTopFieldIds,
    applyTopState = false,
  }) {
    const getRowDetail = getWorksheetApiMethod("getRowDetail");
    if (!getRowDetail || !rowWorksheetId || !rowId || !controlId) {
      throw new Error(`${fieldName}无法回读验证：缺少记录或字段信息`);
    }

    const expected = Number(expectedValue) || 0;
    let actual = null;
    let foundField = false;
    // Formula and rollup fields are calculated asynchronously by Mingdao.
    // The UI has already updated optimistically, so these retries run only as
    // background server verification.
    const attempts = 8;

    for (let index = 0; index < attempts; index += 1) {
      if (index > 0) await waitForMs(500);
      const detail = await getRowDetail({
        appId,
        worksheetId: rowWorksheetId,
        viewId: rowWorksheetId === worksheetId ? viewId : "",
        rowId,
        getTemplate: true,
      });
      const cell = getCellByControlId(detail, controlId);
      foundField = !!cell;
      actual = getNumberValueOrNull(detail, controlId);
      if (applyTopState) applyTopDetailFromServer(detail, activeTopFieldIds);
      if (actual !== null && Math.abs(actual - expected) < 0.01) {
        return true;
      }
    }

    const error = new Error(
      foundField
        ? `${fieldName}未保存到明道云：目标 ${expected}，服务器回读 ${actual ?? "空"}`
        : `${fieldName}未在明道云返回的字段中找到（字段 ID：${controlId}）`
    );
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastAreaSync = {
        ...(window.__deliveryLoadingLastAreaSync || {}),
        stage: "verify-failed",
        rowWorksheetId,
        rowId,
        controlId,
        expected,
        actual,
        foundField,
        error: error.message,
      };
    }
    throw error;
  }

  async function updateTopDateCandidate(controlValue, expectedDateText, controlId, activeTopFieldIds) {
    let firstError = null;
    try {
      const updated = await updateWorksheetRecord(worksheetId, sourceRowId, [controlValue]);
      if (updated) {
        await verifyTopDateSaved(expectedDateText, controlId, activeTopFieldIds, {
          attempts: 2,
          intervalMs: 450,
        });
        return true;
      }
    } catch (error) {
      firstError = error;
      console.warn("delivery date save with viewId did not persist, retry without viewId", error);
    }

    // Some Mingdao custom-view runtimes return success for updateWorksheetRow
    // while silently ignoring a mapped field which is outside the native view
    // columns. Submit the exact same field/value without viewId, then verify
    // against the worksheet-level record. No other business field is touched.
    const updateRow = getWorksheetApiMethod("updateWorksheetRow");
    if (!updateRow) throw firstError || new Error("当前环境未开放日期保存接口");
    const result = await updateRow(compactApiParams({
      appId,
      worksheetId,
      rowId: sourceRowId,
      newOldControl: [controlValue],
      pushUniqueId: getPushUniqueId(),
      rowStatus: 1,
    }));
    assertMingdaoApiSuccess(result, "保存送货日期");
    await verifyTopDateSaved(expectedDateText, controlId, activeTopFieldIds, {
      attempts: 5,
      intervalMs: 600,
    });
    return true;
  }

  async function updateWorksheetRecord(rowWorksheetId, rowId, controls, extra = {}) {
    const updateRow = getWorksheetApiMethod("updateWorksheetRow");
    const validControls = (Array.isArray(controls) ? controls : []).filter(
      (control) => control?.controlId
    );

    if (!updateRow || !rowWorksheetId || !rowId || !validControls.length) {
      throw new Error("保存记录失败：接口、记录或字段信息缺失");
    }

    suppressRuntimeRefreshUntilRef.current = Math.max(
      suppressRuntimeRefreshUntilRef.current,
      Date.now() + 10000
    );
    const result = await updateRow({
      appId,
      worksheetId: rowWorksheetId,
      rowId,
      viewId: rowWorksheetId === worksheetId ? viewId : "",
      newOldControl: validControls,
      pushUniqueId: getPushUniqueId(),
      rowStatus: 1,
      ...extra,
    });
    assertMingdaoApiSuccess(result, "保存记录");
    return true;
  }

  async function updateWorksheetRecords(rowWorksheetId, rowIds, controls, extra = {}) {
    const updateRows = getWorksheetApiMethod("updateWorksheetRows");
    const validControls = (Array.isArray(controls) ? controls : []).filter(
      (control) => control?.controlId
    );
    const validRowIds = (Array.isArray(rowIds) ? rowIds : [rowIds]).filter(Boolean);

    if (!updateRows || !rowWorksheetId || !validRowIds.length || !validControls.length) {
      throw new Error("批量保存失败：接口、记录或字段信息缺失");
    }

    suppressRuntimeRefreshUntilRef.current = Math.max(
      suppressRuntimeRefreshUntilRef.current,
      Date.now() + 10000
    );
    const result = await updateRows({
      appId,
      worksheetId: rowWorksheetId,
      viewId: rowWorksheetId === worksheetId ? viewId : "",
      rowIds: validRowIds,
      isAll: false,
      excludeRowIds: [],
      filterControls: [],
      keyWords: "",
      fastFilters: [],
      navGroupFilters: [],
      filtersGroup: [],
      controls: validControls,
      pushUniqueId: getPushUniqueId(),
      ...extra,
    });
    assertMingdaoApiSuccess(result, "批量保存记录");
    return true;
  }

  async function updateTopWorksheetRecord(controls) {
    let lastError = null;

    try {
      const singleSynced = await updateWorksheetRecord(worksheetId, sourceRowId, controls);
      if (singleSynced) return true;
    } catch (error) {
      lastError = error;
      console.warn("single top field update failed", error);
    }

    try {
      const batchSynced = await updateWorksheetRecords(worksheetId, [sourceRowId], controls);
      if (batchSynced) return true;
    } catch (error) {
      lastError = error;
      console.warn("batch top field update failed", error);
    }

    if (lastError) console.warn("all direct supplement relation value candidates failed", lastError);
    return false;
  }

  async function updateTopRelationControl(controlId, option, type, _previousRowId = "") {
    const updateRow = getWorksheetApiMethod("updateWorksheetRow");
    const getRelationRows = getWorksheetApiMethod("getRowRelationRows");
    const control = getControlById(topControls, controlId);
    if (!updateRow || !controlId || !option?.value || !isRelationControl(control)) {
      return false;
    }

    // This mirrors Mingdao's own SheetView field-edit payload. For a single
    // relation field, updateWorksheetRow with the complete JSON array is an
    // atomic replacement. updateRowRelationRows is intentionally not used:
    // its isAdd mode appends and previously left two vehicles selected.
    const relationValue = {
      controlId,
      type: Number(control?.type || type) || 29,
      controlName: getControlName(control),
      ...(control?.dot !== undefined ? { dot: control.dot } : {}),
      editType: 0,
      value: JSON.stringify([
        {
          sid: option.value,
          name: option.label || option.value,
        },
      ]),
    };

    const result = await updateRow({
      appId,
      worksheetId,
      viewId,
      rowId: sourceRowId,
      newOldControl: [relationValue],
    });
    assertMingdaoApiSuccess(result, "更替货车关联");

    if (getRelationRows) {
      const verifyResponse = await getRelationRows({
        appId,
        worksheetId,
        rowId: sourceRowId,
        controlId,
        viewId,
        pageIndex: 1,
        pageSize: 100,
        getWorksheet: false,
      });
      const verifiedIds = uniqueControlIds(
        getRowsFromResponse(verifyResponse).map((row) => getRowIdValue(row))
      );
      if (!verifiedIds.includes(option.value) || verifiedIds.some((rowId) => rowId !== option.value)) {
        throw new Error(`货车更替未完成：${option.label || option.value}`);
      }
    }

    return true;
  }

  async function updateTopDateControl(controlValues, expectedDateText, controlId, activeTopFieldIds) {
    let lastError = null;
    let anySynced = false;

    for (const controlValue of controlValues) {
      try {
        const updated = await updateTopDateCandidate(
          controlValue,
          expectedDateText,
          controlId,
          activeTopFieldIds
        );
        anySynced = updated || anySynced;
        if (updated) return true;
      } catch (error) {
        lastError = error;
        console.warn("sync delivery date candidate failed", {
          controlId: controlValue.controlId,
          type: controlValue.type,
          value: controlValue.value,
          error,
        });
      }
    }

    if (lastError) throw lastError;
    if (anySynced) return true;
    return false;
  }

  function scheduleTopTotalsSync(loadedVolume, loadingArea) {
    const latestRows = rowsRef.current.map((row) => ({
      ...row,
      ...(localDetailOverridesRef.current[row.id] || {}),
    }));
    const latestTotals = latestRows.reduce(
      (result, row) => ({
        volume: result.volume + calculateLoadingVolume(row, row.loadedQty),
        area: result.area + calculateLoadingArea(row, row.loadedQty),
      }),
      { volume: 0, area: 0 }
    );
    pendingTopTotalsRef.current = {
      loadedVolume: Number.isFinite(latestTotals.volume) ? latestTotals.volume : loadedVolume,
      loadingArea: Number.isFinite(latestTotals.area) ? latestTotals.area : loadingArea,
    };
    if (topTotalsSyncTimerRef.current) {
      window.clearTimeout(topTotalsSyncTimerRef.current);
    }
    // Several checkbox clicks share one delayed main-record write. This keeps
    // the detail queue free and submits only the final aggregate.
    topTotalsSyncTimerRef.current = window.setTimeout(() => {
      topTotalsSyncTimerRef.current = null;
      const patch = pendingTopTotalsRef.current;
      pendingTopTotalsRef.current = null;
      if (!patch) return;
      const endForegroundWork = beginForegroundWork();
      syncTopFieldsToMingdao(patch)
        .catch((error) => {
          console.warn("sync aggregated loading totals failed", error);
        })
        .finally(endForegroundWork);
    }, 500);
  }

  async function syncTopFieldsToMingdao(patch = {}) {
    if (!sourceRowId) return false;
    const controls = [];
    const activeTopFieldIds = topFieldIds || controlIds;
    const hasDatePatch = Object.prototype.hasOwnProperty.call(patch, "dateText");
    const hasTruckPatch = Object.prototype.hasOwnProperty.call(patch, "selectedTruckId");
    const hasNumberPatch =
      Object.prototype.hasOwnProperty.call(patch, "loadingArea") ||
      Object.prototype.hasOwnProperty.call(patch, "capacityArea") ||
      Object.prototype.hasOwnProperty.call(patch, "loadedVolume") ||
      Object.prototype.hasOwnProperty.call(patch, "capacityVolume") ||
      Object.prototype.hasOwnProperty.call(patch, "progress");
    const truckOption = truckOptions.find(
      (item) => item.value === (patch.selectedTruckId || selectedTruckId)
    );
    const truckControl = getControlById(topControls, activeTopFieldIds.truckRelation);
    const truckType = truckControl?.type;
    const loadingAreaControl = getControlById(topControls, activeTopFieldIds.loadingArea);
    const hasLoadingAreaPatch = Object.prototype.hasOwnProperty.call(patch, "loadingArea");
    const loadingAreaRequiresDirectWrite =
      hasLoadingAreaPatch &&
      !!loadingAreaControl &&
      isWritableNumberControlType(loadingAreaControl.type) &&
      !isCalculatedFieldControlType(loadingAreaControl.type);
    // “在装平方”在不同客户应用中可能是公式、汇总或其他只读派生字段，
    // 有些视图模板甚至不会把该控件返回给插件。只有确认它是可写数字字段
    // 时才直接提交和回读；其他情况均交给明道云根据明细源字段重算。
    const loadingAreaIsCalculated = hasLoadingAreaPatch && !loadingAreaRequiresDirectWrite;
    const buildTopNumberValue = (fieldKey, value) => {
      const controlId = activeTopFieldIds[fieldKey];
      if (!controlId) return null;
      const control = getControlById(topControls, controlId);
      if (!control) return null;
      const controlType = control.type;
      if (isCalculatedFieldControlType(controlType)) return null;
      // Never send a numeric payload to a dropdown/relation/member field even
      // when an old plugin mapping points at the wrong control. This was the
      // second source of the “字段‘选择货车’的参数格式错误” toast when changing
      // vehicles, because capacity/progress are saved in the same operation.
      if (!isWritableNumberControlType(controlType)) {
        console.warn("skip non-number top control", {
          fieldKey,
          controlId,
          controlName: getControlName(control),
          controlType,
        });
        return null;
      }
      return buildNumberControlValue(controlId, value, controlType);
    };
    const nextLoadedVolume = Object.prototype.hasOwnProperty.call(patch, "loadedVolume")
      ? patch.loadedVolume
      : totals.loadedVolume;
    const nextLoadingArea = Object.prototype.hasOwnProperty.call(patch, "loadingArea")
      ? patch.loadingArea
      : totals.loadedArea;
    const nextCapacityArea = Object.prototype.hasOwnProperty.call(patch, "capacityArea")
      ? patch.capacityArea
      : truckOption?.capacityArea || effectiveCapacityArea;
    const nextCapacityVolume = Object.prototype.hasOwnProperty.call(patch, "capacityVolume")
      ? patch.capacityVolume
      : truckOption?.capacityVolume || effectiveCapacityVolume;
    const nextProgress = Object.prototype.hasOwnProperty.call(patch, "progress")
      ? patch.progress
      : nextCapacityArea
        ? calculateProgressPercent(nextLoadingArea, nextCapacityArea)
        : calculateProgressPercent(nextLoadedVolume, nextCapacityVolume);
    let dateControlValues = [];
    if (hasLoadingAreaPatch && !loadingAreaRequiresDirectWrite) {
      console.info("skip direct write for derived top loading-area field", {
        controlId: activeTopFieldIds.loadingArea || "",
        controlType: loadingAreaControl?.type,
      });
    }
    if (Object.prototype.hasOwnProperty.call(patch, "dateText")) {
      if (!activeTopFieldIds.deliveryDate) {
        throw new Error("未找到装车信息字段：送货日期");
      }
      const dateControlType = getControlById(topControls, activeTopFieldIds.deliveryDate)?.type;
      const dateControl = getControlById(topControls, activeTopFieldIds.deliveryDate) || {
        controlId: activeTopFieldIds.deliveryDate,
        type: dateControlType,
        controlName: "送货日期",
      };
      dateControlValues = buildDateControlValueCandidates(dateControl, patch.dateText);
    }
    if (Object.prototype.hasOwnProperty.call(patch, "loadedVolume")) {
      controls.push(buildTopNumberValue("loadedVolume", nextLoadedVolume));
      controls.push(buildTopNumberValue("loadingVolume", nextLoadedVolume));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "loadingArea")) {
      controls.push(buildTopNumberValue("loadingArea", nextLoadingArea));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "capacityArea")) {
      controls.push(buildTopNumberValue("capacityArea", nextCapacityArea));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "capacityVolume")) {
      controls.push(buildTopNumberValue("capacityVolume", nextCapacityVolume));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "progress")) {
      controls.push(buildTopNumberValue("progress", nextProgress));
    }
    if (hasNumberPatch && !Object.prototype.hasOwnProperty.call(patch, "progress")) {
      controls.push(buildTopNumberValue("progress", nextProgress));
    }
    if (hasTruckPatch) {
      if (!Object.prototype.hasOwnProperty.call(patch, "capacityArea")) {
        controls.push(buildTopNumberValue("capacityArea", nextCapacityArea));
      }
      if (!Object.prototype.hasOwnProperty.call(patch, "capacityVolume")) {
        controls.push(buildTopNumberValue("capacityVolume", nextCapacityVolume));
      }
      if (!Object.prototype.hasOwnProperty.call(patch, "progress")) {
        controls.push(buildTopNumberValue("progress", nextProgress));
      }
    }
    if (!controls.length && !hasDatePatch && !hasTruckPatch && !hasNumberPatch) {
      controls.push(buildTopNumberValue("loadingArea", nextLoadingArea));
      controls.push(buildTopNumberValue("capacityArea", nextCapacityArea));
      controls.push(buildTopNumberValue("loadedVolume", nextLoadedVolume));
      controls.push(buildTopNumberValue("loadingVolume", nextLoadedVolume));
      controls.push(buildTopNumberValue("capacityVolume", nextCapacityVolume));
      controls.push(buildTopNumberValue("progress", nextProgress));
    }

    const validControls = controls.filter((control) => control?.controlId);
    if (typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(patch, "loadingArea")) {
      window.__deliveryLoadingLastAreaSync = {
        stage: "top-request",
        sourceRowId,
        worksheetId,
        fieldName: "在装平方",
        controlId: activeTopFieldIds.loadingArea || "",
        expected: Number(nextLoadingArea) || 0,
        formulaField: loadingAreaIsCalculated,
        controls: validControls,
      };
    }
    const basicSynced = validControls.length
      ? await updateTopWorksheetRecord(validControls)
      : false;
    const dateSynced = dateControlValues.length
      ? await updateTopDateControl(
          dateControlValues,
          patch.dateText,
          activeTopFieldIds.deliveryDate,
          activeTopFieldIds
        )
      : false;

    if (hasLoadingAreaPatch) {
      if (!basicSynced && loadingAreaRequiresDirectWrite) {
        throw new Error("主表在装平方未提交：明道云保存接口未返回成功");
      }
      // “在装平方”是公式字段时，不可也不需要直接写入。明细源字段
      // 更新后由明道云异步重算；不能让短暂的公式回读为空阻断保存流程。
      if (loadingAreaRequiresDirectWrite) {
        await verifyNumberFieldSaved({
          rowWorksheetId: worksheetId,
          rowId: sourceRowId,
          controlId: activeTopFieldIds.loadingArea,
          expectedValue: nextLoadingArea,
          fieldName: "主表在装平方",
          activeTopFieldIds,
          applyTopState: true,
        });
      }
      if (typeof window !== "undefined") {
        window.__deliveryLoadingLastAreaSync = {
          ...(window.__deliveryLoadingLastAreaSync || {}),
          stage: "top-verified",
        };
      }
    }

    if (!hasTruckPatch) {
      return dateSynced || basicSynced;
    }

    if (!activeTopFieldIds.truckRelation) {
      throw new Error(
        "未找到关联记录类型的货车字段；请将插件“货车”映射到关联‘货车设置’的字段，不要映射到“选择货车”下拉字段"
      );
    }
    if (!truckOption) {
      return basicSynced;
    }

    const truckSynced = await updateTopRelationControl(
      activeTopFieldIds.truckRelation,
      truckOption,
      truckType,
      patch.previousTruckId || ""
    );
    return truckSynced || dateSynced || basicSynced;
  }

  async function deleteDetailRowFromMingdao(row) {
    const rowWorksheetId = getDetailWorksheetId(row);
    const rowId = row?.id;
    if (!rowWorksheetId || !rowId) {
      throw new Error("未找到明细工作表或记录 ID，已停止删除以避免误删");
    }

    const attempts = [];
    if (typeof runtimeApi.deleteWorksheetRow === "function") {
      attempts.push({
        name: "deleteWorksheetRow",
        method: runtimeApi.deleteWorksheetRow,
        payload: { appId, worksheetId: rowWorksheetId, rowIds: [rowId] },
      });
    }

    const deleteRows = getWorksheetApiMethod("deleteWorksheetRows");
    if (typeof deleteRows === "function") {
      attempts.push({
        name: "deleteWorksheetRows",
        method: deleteRows,
        payload: {
          appId,
          worksheetId: rowWorksheetId,
          viewId: rowWorksheetId === worksheetId ? viewId : "",
          rowIds: [rowId],
          isAll: false,
          excludeRowIds: [],
          filterControls: [],
          keyWords: "",
          fastFilters: [],
          navGroupFilters: [],
          filtersGroup: [],
          thoroughDelete: false,
        },
      });
    }

    if (!attempts.length) {
      throw new Error("当前环境未开放明道云记录删除接口");
    }

    let lastError = null;
    for (const attempt of attempts) {
      const debugPayload = {
        stage: "request",
        method: attempt.name,
        worksheetId: rowWorksheetId,
        rowId,
      };
      if (typeof window !== "undefined") {
        window.__deliveryLoadingLastDelete = debugPayload;
      }
      try {
        const result = await attempt.method(attempt.payload);
        assertMingdaoApiSuccess(result, "删除明细");
        if (typeof window !== "undefined") {
          window.__deliveryLoadingLastDelete = {
            ...debugPayload,
            stage: "success",
            result,
          };
        }
        return true;
      } catch (error) {
        lastError = error;
        console.warn("delete detail row candidate failed", attempt.name, error);
      }
    }

    throw lastError || new Error("删除明细失败");
  }

  async function splitDetailRowInMingdao(row, splitQty) {
    const rowWorksheetId = getDetailWorksheetId(row);
    const plannedControlId = row?.fieldMap?.plannedQty || detailFieldMap.plannedQty;
    const plannedControlType = row?.fieldTypeMap?.plannedQty;
    const originalQty = Number(row?.plannedQty) || 0;
    const splitNumber = Number(splitQty);
    const remainingQty = originalQty - splitNumber;
    const getRowDetail = runtimeApi.getRowDetail || getWorksheetApiMethod("getRowDetail");
    const addWorksheetRow = getWorksheetApiMethod("addWorksheetRow");

    if (!rowWorksheetId || !row?.id) {
      throw new Error("未识别当前明细工作表或记录，已停止分拆避免写错数据");
    }
    if (!plannedControlId) throw new Error("未找到明细字段：计划量");
    if (!Number.isFinite(splitNumber) || splitNumber <= 0 || splitNumber >= originalQty) {
      throw new Error(`分拆数量必须大于 0 且小于原计划量 ${formatNumber(originalQty)}`);
    }
    if (!getRowDetail || !addWorksheetRow) {
      throw new Error("当前环境未开放明细读取或新增记录接口");
    }

    const detail = await getRowDetail({
      appId,
      worksheetId: rowWorksheetId,
      viewId: rowWorksheetId === worksheetId ? viewId : "",
      rowId: row.id,
      getTemplate: true,
    });
    const sourceControls = getControlsFromResponse(detail);
    const copiedControlIds = new Set();
    const sourceCells = getRecordCellsOnly(detail);
    const receiveControls = sourceCells
      .map((cell) => {
        const controlId = getControlIdFromItem(cell);
        const control = getControlById(sourceControls, controlId);
        const type = cell?.type || control?.type;
        // Formula, lookup and rollup fields are read-only; they will be
        // recalculated from the copied source fields on the new record.
        if (
          !controlId ||
          isCalculatedFieldControlType(type) ||
          cell?.isSystemControl ||
          control?.isSystemControl ||
          control?.systemControl
        ) {
          return null;
        }
        const value = cell?.value ?? cell?.controlValue ?? getRawCellValue(cell);
        copiedControlIds.add(controlId);
        return buildControlValue(
          controlId,
          controlId === plannedControlId ? splitNumber : value,
          type,
          getControlName(control)
        );
      })
      .filter(Boolean);

    if (!copiedControlIds.has(plannedControlId)) {
      receiveControls.push(buildNumberControlValue(plannedControlId, splitNumber, plannedControlType));
    }
    if (!receiveControls.length) throw new Error("未读取到原明细的可复制字段，已停止分拆");

    const createPayload = compactApiParams({
      appId,
      worksheetId: rowWorksheetId,
      viewId: rowWorksheetId === worksheetId ? viewId : "",
      receiveControls,
      rowStatus: 1,
      pushUniqueId: getPushUniqueId(),
    });
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastSplit = {
        stage: "creating",
        sourceRowId: row.id,
        worksheetId: rowWorksheetId,
        originalQty,
        splitQty: splitNumber,
        remainingQty,
        copiedControlIds: receiveControls.map((item) => item.controlId),
        payload: createPayload,
      };
    }
    const createResult = await addWorksheetRow(createPayload);
    assertMingdaoApiSuccess(createResult, "新增分拆明细");
    const createdRow = getRowsFromResponse(createResult)[0] || createResult?.data || createResult;
    const createdRowId = getRowIdValue(createdRow);

    try {
      await updateWorksheetRecord(rowWorksheetId, row.id, [
        buildNumberControlValue(plannedControlId, remainingQty, plannedControlType),
      ]);
    } catch (error) {
      // Do not leave a duplicate allocation if the source row could not be
      // reduced. Roll back the just-created row whenever its id is returned.
      if (createdRowId) {
        try {
          await deleteDetailRowFromMingdao({ id: createdRowId, worksheetId: rowWorksheetId });
        } catch (rollbackError) {
          console.error("split rollback failed", rollbackError);
        }
      }
      throw error;
    }

    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastSplit = {
        ...window.__deliveryLoadingLastSplit,
        stage: "success",
        createdRowId,
        result: createResult,
      };
    }
    return { remainingQty, splitQty: splitNumber, createdRowId };
  }

  async function returnDetailRowToMingdao(row) {
    const getButtons = getWorksheetApiMethod("getWorksheetBtns");
    const startProcess = getProcessApiMethod("startProcess");
    const rowWorksheetId = getDetailWorksheetId(row) || RETURN_PLAN_WORKSHEET_ID;
    const targetAppId = appId || RETURN_PLAN_APP_ID;
    if (!getButtons || !startProcess) {
      throw new Error("当前环境未开放明细按钮或工作流触发接口");
    }
    if (!rowWorksheetId || !row?.id) {
      throw new Error("未找到明细工作表或记录 ID，已停止退回");
    }

    const requestCandidates = [
      { appId: targetAppId, worksheetId: rowWorksheetId, viewId: RETURN_PLAN_VIEW_ID, rowId: row.id, rowIds: [row.id], btnId: "", btnType: 0, status: 1 },
      { appId: targetAppId, worksheetId: rowWorksheetId, viewId: "", rowId: row.id, rowIds: [row.id], btnId: "", btnType: 0, status: 1 },
    ].map(compactApiParams);
    let returnButton = null;
    let availableButtonNames = [];
    let lastError = null;

    for (const params of requestCandidates) {
      try {
        const response = await getButtons(params);
        const candidateButtons = getButtonsFromResponse(response).filter(Boolean);
        availableButtonNames = Array.from(
          new Set([...availableButtonNames, ...candidateButtons.map(getButtonName).filter(Boolean)])
        );
        returnButton = findButtonByAliases(candidateButtons, RETURN_PLAN_BUTTON_ALIASES);
        if (getButtonId(returnButton)) break;
      } catch (error) {
        lastError = error;
        console.warn("load return-plan button failed", params, error);
      }
    }

    const buttonId = getButtonId(returnButton);
    if (!buttonId) {
      const buttonText = availableButtonNames.length
        ? `；当前可用按钮：${availableButtonNames.join("、")}`
        : "";
      throw lastError || new Error(`未找到明细按钮：退回计划${buttonText}`);
    }

    const payload = compactApiParams({
      appId: rowWorksheetId,
      sources: [row.id],
      triggerId: buttonId,
      pushUniqueId: getPushUniqueId(),
      viewId: RETURN_PLAN_VIEW_ID,
      isAll: false,
      dataLog: "退回计划",
    });
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastReturn = {
        stage: "request",
        buttonId,
        buttonName: getButtonName(returnButton),
        payload,
      };
    }
    const result = await callStartProcess(startProcess, payload);
    if (!result) throw new Error("退回计划未执行：记录不满足按钮条件或工作流未启用");
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastReturn = {
        stage: "success",
        buttonId,
        buttonName: getButtonName(returnButton),
        payload,
        result,
      };
    }
    return true;
  }

  function removeDetailRowFromLocalView(row) {
    deletedRowIdsRef.current.add(row.id);
    const remainingRows = displayRows.filter((item) => item.id !== row.id);
    const nextLoadingVolume = remainingRows.reduce(
      (sum, item) => sum + (Number(item.loadedVolume) || 0),
      0
    );
    const nextLoadingArea = remainingRows.reduce(
      (sum, item) => sum + (Number(item.loadedArea) || 0),
      0
    );

    setRows((current) => current.filter((item) => item.id !== row.id));
    setDraft((current) => {
      const nextDetailRows = { ...(current.detailRows || {}) };
      delete nextDetailRows[row.id];
      return { ...current, detailRows: nextDetailRows };
    });
    const nextLocalOverrides = { ...localDetailOverridesRef.current };
    delete nextLocalOverrides[row.id];
    localDetailOverridesRef.current = nextLocalOverrides;
    detailSyncPromisesRef.current.delete(row.id);
    detailSyncErrorsRef.current.delete(row.id);
    setLoadingVolume(nextLoadingVolume);
    setLoadedVolume(nextLoadingVolume);
    setLoadingArea(nextLoadingArea);
    invalidatePageSwitchCache();

    return { nextLoadingVolume, nextLoadingArea };
  }

  function confirmDeleteDetailRow() {
    const row = deleteCandidate;
    if (!row || deletingRowId) return;

    // Make the interaction instant. The authoritative delete still runs in
    // the background; should it fail, a refresh restores the server state.
    setDeletingRowId(row.id);
    const { nextLoadingVolume, nextLoadingArea } = removeDetailRowFromLocalView(row);
    setDeleteCandidate(null);
    setSaveStatus("正在后台删除明细...");

    void (async () => {
      try {
      const pendingSync = detailSyncPromisesRef.current.get(row.id);
      if (pendingSync) {
        try {
          await pendingSync;
        } catch (error) {
          console.warn("pending detail sync failed before delete", error);
        }
      }

      await deleteDetailRowFromMingdao(row);

      try {
        await syncTopFieldsToMingdao({
          loadedVolume: nextLoadingVolume,
          loadingArea: nextLoadingArea,
        });
        setSaveStatus("明细已删除");
      } catch (error) {
        console.warn("sync totals after detail delete failed", error);
        setSaveStatus("明细已删除，顶部汇总字段同步失败，请刷新检查");
      }

      window.setTimeout(() => {
        setRefreshVersion((current) => current + 1);
      }, 350);
    } catch (error) {
      console.warn("delete detail row failed", error);
      deletedRowIdsRef.current.delete(row.id);
      window.setTimeout(() => setRefreshVersion((current) => current + 1), 0);
      setSaveStatus(error?.message || "删除失败，请检查明道云权限");
    } finally {
      setDeletingRowId("");
    }
    })();
  }

  function confirmReturnDetailRow() {
    const row = returnCandidate;
    if (!row || returningRowId) return;

    // The row leaves the panel immediately, while Mingdao's workflow is
    // triggered in the background. This keeps the grid usable during a slow
    // workflow response.
    setReturningRowId(row.id);
    const { nextLoadingVolume, nextLoadingArea } = removeDetailRowFromLocalView(row);
    setReturnCandidate(null);
    setSaveStatus("正在后台退回明细...");

    void (async () => {
      try {
      const pendingSync = detailSyncPromisesRef.current.get(row.id);
      if (pendingSync) {
        try {
          await pendingSync;
        } catch (error) {
          console.warn("pending detail sync failed before return", error);
        }
      }

      await returnDetailRowToMingdao(row);

      try {
        await syncTopFieldsToMingdao({
          loadedVolume: nextLoadingVolume,
          loadingArea: nextLoadingArea,
        });
        setSaveStatus("明细已退回");
      } catch (error) {
        console.warn("sync totals after detail return failed", error);
        setSaveStatus("明细已退回，顶部汇总字段同步失败，请刷新检查");
      }

      window.setTimeout(() => {
        setRefreshVersion((current) => current + 1);
      }, 350);
    } catch (error) {
      console.warn("return detail row failed", error);
      deletedRowIdsRef.current.delete(row.id);
      window.setTimeout(() => setRefreshVersion((current) => current + 1), 0);
      setSaveStatus(error?.message || "退回失败，请检查明道云权限和关联字段配置");
    } finally {
      setReturningRowId("");
    }
    })();
  }

  async function syncDetailLoadedToMingdao(row, loadedQty, options = {}) {
    const shouldSyncChecked = !!options.syncChecked;
    const checked = !!options.checked;
    const loadedControlId = row?.fieldMap?.loadedQty || detailFieldMap.loadedQty;
    const loadingAreaControlId = row?.fieldMap?.loadedArea || detailFieldMap.loadedArea;
    const loadingUserControlId = row?.fieldMap?.loadingUser || detailFieldMap.loadingUser;
    const checkedControlId = row?.fieldMap?.checked || detailFieldMap.checked;
    const loadedControlType = row?.fieldTypeMap?.loadedQty;
    const loadingAreaControlType = row?.fieldTypeMap?.loadedArea;
    const loadingUserControlType = row?.fieldTypeMap?.loadingUser;
    const checkedControlType = row?.fieldTypeMap?.checked;
    const nextLoadedQty = Number(loadedQty) || 0;
    const nextTotals = getLoadingTotalsWithPatch(row.id, nextLoadedQty);
    const nextLoadingTotal = nextTotals.volume;
    const nextLoadingArea = nextTotals.area;
    const nextRowLoadingArea = calculateLoadingArea(row, nextLoadedQty);
    const shouldClearLoaded = loadedQty === "" || loadedQty === null || loadedQty === undefined;
    const canWriteLoadedQty = loadedControlId && isWritableNumberControlType(loadedControlType);
    const canWriteLoadingArea =
      loadingAreaControlId && isWritableNumberControlType(loadingAreaControlType);
    const loadingAreaIsCalculated = isCalculatedFieldControlType(loadingAreaControlType);
    const canWriteLoadingUser =
      shouldSyncChecked &&
      loadingUserControlId &&
      isWritableMemberControlType(loadingUserControlType);
    const canWriteChecked =
      shouldSyncChecked && checkedControlId && isWritableCheckboxControlType(checkedControlType);
    const rowWorksheetId = getDetailWorksheetId(row);
    const loadedControl = canWriteLoadedQty
      ? shouldClearLoaded
        ? buildClearControlValue(loadedControlId, loadedControlType)
        : buildNumberControlValue(loadedControlId, nextLoadedQty, loadedControlType)
      : null;
    const checkedControl = canWriteChecked
      ? buildCheckedControlValue(checkedControlId, checked, checkedControlType)
      : null;
    const loadingAreaControl = canWriteLoadingArea
      ? buildNumberControlValue(
          loadingAreaControlId,
          shouldClearLoaded ? 0 : nextRowLoadingArea,
          loadingAreaControlType
        )
      : null;
    let loadingUserControl = null;
    // 装载人是增强字段。无法取得成员空间账号时，不能阻断“勾选/装载量”本身的保存。
    if (canWriteLoadingUser) {
      try {
        loadingUserControl = buildLoaderControlValue(
          loadingUserControlId,
          checked,
          loadingUserControlType
        );
      } catch (error) {
        console.warn("skip optional loading-user sync", error);
      }
    }
    const controls = [
      loadedControl,
      loadingAreaControl,
      checkedControl,
      loadingUserControl,
    ].filter(Boolean);

    if (!controls.length) {
      throw new Error("未找到可写入的明细装载量字段");
    }
    if (shouldSyncChecked && !checkedControl) {
      throw new Error("未找到可写入的明细勾选字段");
    }
    if (!rowWorksheetId) {
      throw new Error("未识别当前明细工作表，已停止保存避免写错其他客户的数据");
    }

    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastAreaSync = {
        stage: "detail-request",
        rowWorksheetId,
        rowId: row.id,
        fieldName: "明细在装平方",
        controlId: loadingAreaControlId,
        expected: shouldClearLoaded ? 0 : nextRowLoadingArea,
        formulaField: loadingAreaIsCalculated,
        controls,
      };
    }

    try {
      await updateWorksheetRecord(rowWorksheetId, row.id, controls);
    } catch (error) {
      // The row queue retries this task. Use the batch endpoint only as an
      // API-compatibility fallback; do not add read requests per checkbox.
      await updateWorksheetRecords(rowWorksheetId, [row.id], controls);
    }
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastAreaSync = {
        ...(window.__deliveryLoadingLastAreaSync || {}),
        stage: "detail-verified",
      };
    }
    setLoadingVolume(nextLoadingTotal);
    setLoadingArea(nextLoadingArea);
    if (options.syncTop !== false) {
      scheduleTopTotalsSync(nextLoadingTotal, nextLoadingArea);
    }
    // Do not reload the whole relation after a formula recalculation. The UI
    // already has the exact optimistic formula value, and a full refresh here
    // causes scroll jumps and interrupts the next checkbox/input operation.
  }

  async function syncDetailRemarkToMingdao(row, remark) {
    const remarkControlId = row?.fieldMap?.remark || detailFieldMap.remark;
    const remarkControlType = row?.fieldTypeMap?.remark;
    if (!remarkControlId) {
      setSaveStatus("未找到明细备注字段");
      return false;
    }

    await updateWorksheetRecord(getDetailWorksheetId(row), row.id, [
      buildControlValue(remarkControlId, remark, remarkControlType),
    ]);
    return true;
  }

  // 还有行没写进明道云时，不要清空提示，否则失败会被下一次勾选掩盖。
  function clearTransientSaveStatus() {
    if (detailSyncErrorsRef.current.size) return;
    setSaveStatus("");
  }

  async function waitForPendingDetailSyncs() {
    // Take repeated snapshots because a second edit of the same row can replace
    // the promise in the map while the first snapshot is still being awaited.
    for (let round = 0; round < 100; round += 1) {
      const pending = Array.from(detailSyncPromisesRef.current.values());
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
    throw new Error("明细保存队列未结束，请稍后再次点击装载");
  }

  async function retryFailedDetailSyncs() {
    const failedRowIds = Array.from(detailSyncErrorsRef.current.keys());
    if (!failedRowIds.length) return;

    const latestRows = new Map(getLatestDisplayRows().map((row) => [row.id, row]));
    const retryPromises = failedRowIds.map((rowId) => {
      const row = latestRows.get(rowId);
      if (!row) return Promise.reject(new Error(`未找到待重试明细：${rowId}`));
      return queueDetailSync(rowId, () =>
        syncDetailLoadedToMingdao(row, row.loadedQty, {
          syncChecked: true,
          checked: row.checked,
          syncTop: false,
        })
      );
    });
    await Promise.allSettled(retryPromises);
    await waitForPendingDetailSyncs();

    const remainingFailedIds = Array.from(detailSyncErrorsRef.current.keys());
    if (remainingFailedIds.length) {
      throw new Error(
        `${remainingFailedIds.length} 条明细未写入明道云，已停止装载，请重试勾选`
      );
    }
  }

  // 明道云的 updateWorksheetRow 在“字段不属于这张表/被规则拦下”时同样返回成功，
  // 因此写入响应不能作为落库证据。装载前必须把明细重新读回来比对。
  async function readServerDetailCheckedState() {
    const controlId = detailRelationControlIdRef.current;
    if (!worksheetId || !sourceRowId || !controlId) return null;

    const relation = await fetchDetailRelationRows({
      worksheetId,
      rowId: sourceRowId,
      controlId,
      viewId,
      detail: {},
      pageSize: 200,
      fetchAll: true,
    });
    const serverRows = normalizeDetailRows(relation.rows || [], relation.controls || []);
    // 一条都读不回来时无法区分“全部被装走”与“接口没返回”，交给调用方按无法核对处理。
    if (!serverRows.length) return null;
    // 解析不到勾选字段时，serverRow.checked 会退化成“装载量>0”的推断值，
    // 不足以作为判据。此时跳过校验，保持原有行为。
    if (!serverRows[0]?.fieldMap?.checked) return null;

    const stateByRowId = new Map();
    serverRows.forEach((serverRow) => {
      stateByRowId.set(serverRow.id, {
        checked: !!serverRow.checked,
        loadedQty: Number(serverRow.loadedQty) || 0,
      });
    });
    return stateByRowId;
  }

  // 屏幕上勾了几条，明道云里就必须真有几条（勾选=是、装载量一致），否则不触发装载。
  // 装载工作流只认服务器上已勾选的明细。以前这里核对不上只提示、照常装载，随后又把
  // 没装上的行从列表里藏掉——这就是“勾上了记录，点装载却丢了”（视频里的
  // “注意：1 条明细未写入明道云…”）。现在核对不上就停下：勾选全部保留、整行标红。
  // 返回：
  //   { verifiedIds, unsavedRows, missingRows }
  //     verifiedIds  服务器已确认勾选的明细，工作流装走的就是这些
  //     unsavedRows  自动补写一次后，服务器上仍未勾上或装载量不一致
  //     missingRows  已不在本装车单的待装明细里（被别人装走、退回或删除）
  //   null  无法核对（读不回明细或解析不到勾选字段），沿用原有行为
  async function verifyCheckedRowsPersisted() {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedRows = getLatestDisplayRows().filter(
        (row) => !!row.checked && !isRowLoadedByAnotherAccount(row)
      );
      if (!expectedRows.length) return { verifiedIds: [], unsavedRows: [], missingRows: [] };

      let serverState = null;
      let readError = null;
      for (let readAttempt = 0; readAttempt < 2; readAttempt += 1) {
        try {
          serverState = await readServerDetailCheckedState();
          readError = null;
          break;
        } catch (error) {
          readError = error;
          console.warn("read back detail state before loading failed", error);
          if (readAttempt === 0) await waitForMs(600);
        }
      }
      if (readError) {
        // 读不回来就无法保证不丢单：宁可这次不装，也不在不确定时触发工作流。
        throw new Error("暂时无法向明道云核对勾选是否已保存（网络异常），本次未装载，请稍后再点装载");
      }
      if (!serverState) return null;

      const missingRows = expectedRows.filter((row) => !serverState.has(row.id));
      const unsavedRows = expectedRows.filter((row) => {
        const actual = serverState.get(row.id);
        if (!actual) return false;
        if (!actual.checked) return true;
        return Math.abs(actual.loadedQty - (Number(row.loadedQty) || 0)) > 1e-6;
      });
      if (!unsavedRows.length || attempt > 0) {
        if (unsavedRows.length || missingRows.length) {
          console.warn("detail rows not persisted before loading", {
            unsaved: unsavedRows.map((row) => row.id),
            missing: missingRows.map((row) => row.id),
          });
        }
        const problemIds = new Set([...unsavedRows, ...missingRows].map((row) => row.id));
        return {
          verifiedIds: expectedRows.map((row) => row.id).filter((rowId) => !problemIds.has(rowId)),
          unsavedRows,
          missingRows,
        };
      }

      setSaveStatus(`检测到 ${unsavedRows.length} 条明细未写入明道云，正在重写...`);
      await Promise.allSettled(
        unsavedRows.map((row) =>
          queueDetailSync(row.id, () =>
            syncDetailLoadedToMingdao(row, row.loadedQty, {
              syncChecked: true,
              checked: true,
              syncTop: false,
            })
          )
        )
      );
      await waitForPendingDetailSyncs();
    }
    return null;
  }

  function invalidatePageSwitchCache() {
    const pageCacheKey = getPageSwitchCacheKey({
      worksheetId,
      viewId,
      recordRowId,
      filters: systemFilters,
    });
    const latestPageCacheKey = getLatestPageSwitchCacheKey({ worksheetId, viewId, recordRowId });
    pageSwitchCache.delete(pageCacheKey);
    pageSwitchCache.delete(latestPageCacheKey);
    try {
      window.sessionStorage?.removeItem(pageCacheKey);
      window.sessionStorage?.removeItem(latestPageCacheKey);
    } catch (error) {
      // Cache invalidation is best-effort; the server refresh remains authoritative.
    }
  }

  // 核对不通过时停在装载前：标红没保存上的行（勾选保留），移除已不在待装列表的行，
  // 并用一句话告诉操作员哪几条、怎么处理。
  function stopLoadingForUnverifiedRows({ unsavedRows, missingRows }) {
    setUnsavedRowIds(new Set(unsavedRows.map((row) => row.id)));
    if (missingRows.length) {
      const missingIds = new Set(missingRows.map((row) => row.id));
      const nextOverrides = { ...localDetailOverridesRef.current };
      missingIds.forEach((rowId) => {
        delete nextOverrides[rowId];
        detailSyncPromisesRef.current.delete(rowId);
        detailSyncErrorsRef.current.delete(rowId);
      });
      localDetailOverridesRef.current = nextOverrides;
      setRows((current) => current.filter((row) => !missingIds.has(row.id)));
      setDraft((current) => {
        const nextDetailRows = { ...(current.detailRows || {}) };
        missingIds.forEach((rowId) => delete nextDetailRows[rowId]);
        return { ...current, detailRows: nextDetailRows };
      });
      invalidatePageSwitchCache();
      setRefreshVersion((current) => current + 1);
    }
    const parts = [];
    if (unsavedRows.length) {
      parts.push(
        `${unsavedRows.length} 条明细的勾选/装载量没有存进明道云（${describeDetailRows(unsavedRows)}），已标红保留；请重新勾选后再点装载，仍保存不上请先取消这几条`
      );
    }
    if (missingRows.length) {
      parts.push(
        `${missingRows.length} 条明细已不在本装车单的待装列表（${describeDetailRows(missingRows)}，可能已被装走或删除），已从列表移除`
      );
    }
    setSaveStatus(`本次未装载：${parts.join("；")}`);
  }

  async function syncCurrentViewToMingdao() {
    // Checkbox and quantity edits are optimistically rendered and saved by a
    // row-level queue. They do not necessarily create draft entries, so the
    // loading workflow must explicitly wait for every queued row save.
    await waitForPendingDetailSyncs();
    await retryFailedDetailSyncs();

    const draftRows = draftRef.current?.detailRows || {};
    const dirtyRows = getLatestDisplayRows().filter((row) => {
      const rowDraft = draftRows[row.id] || {};
      return rowDraft.loadedQty !== undefined || rowDraft.checked !== undefined || rowDraft.remark !== undefined;
    });

    await Promise.all(dirtyRows.map(async (row) => {
      const rowDraft = draftRows[row.id] || {};
      const pendingSync = detailSyncPromisesRef.current.get(row.id);
      if (pendingSync) {
        await pendingSync;
      }
      if (rowDraft.loadedQty !== undefined || rowDraft.checked !== undefined) {
        if (!pendingSync) {
          await syncDetailLoadedToMingdao(row, row.loadedQty, {
            syncChecked: rowDraft.checked !== undefined,
            checked: row.checked,
            syncTop: false,
          });
          updateLocalDetailLoaded(row, row.loadedQty, row.checked);
          clearDetailDraftKeys(row.id, ["loadedQty", "checked"]);
        }
      }
      if (rowDraft.remark !== undefined) {
        await syncDetailRemarkToMingdao(row, row.remark || "");
        updateLocalDetailRow(row.id, { remark: row.remark || "" });
        clearDetailDraftKeys(row.id, ["remark"]);
      }
    }));

    // 针对“装载 5 个上来 2 个”的静默丢单：对不上先自动补写一次，仍对不上就不装载。
    const verification = await verifyCheckedRowsPersisted();
    if (verification && (verification.unsavedRows.length || verification.missingRows.length)) {
      return verification;
    }

    const latestTotals = computeLoadingTotals(getLatestDisplayRows());
    setLoadingVolume(latestTotals.loadedVolume);
    setLoadingArea(latestTotals.loadedArea);
    await syncTopFieldsToMingdao({
      loadedVolume: latestTotals.loadedVolume,
      loadingArea: latestTotals.loadedArea,
    });
    return verification;
  }

  async function loadSupplementOrderOptions() {
    setSupplementOrderLoading(true);
    setSaveStatus("");
    try {
      const cacheKey = `${worksheetId}:${viewId}:supplement-options`;
      const cached = supplementOptionsCache.get(cacheKey);
      if (cached && Date.now() - cached.time < SUPPLEMENT_OPTIONS_CACHE_TTL) {
        setSupplementOrderFieldControl(cached.fieldControl || null);
        setSupplementOrderOptions(cached.options);
        setSelectedSupplementOrderId(cached.options[0]?.value || "");
        setSaveStatus("");
        return;
      }
      const getRowDetail = runtimeApi.getRowDetail || getWorksheetApiMethod("getRowDetail");
      const [worksheetInfo, sourceDetail] = await Promise.all([
        getWorksheetInfoCached(worksheetId, { getViews: true }),
        getRowDetail && sourceRowId
          ? getRowDetail({ appId, worksheetId, viewId, rowId: sourceRowId, getTemplate: true })
          : Promise.resolve(null),
      ]);
      const currentControls = getControlsFromResponse(worksheetInfo);
      const sourceControls = getControlsFromResponse(sourceDetail);
      const supplementField =
        findControlByNames(sourceControls, SUPPLEMENT_ORDER_FIELD_NAMES) ||
        getCellByNames(sourceDetail, SUPPLEMENT_ORDER_FIELD_NAMES) ||
        findControlByNames(currentControls, SUPPLEMENT_ORDER_FIELD_NAMES) ||
        getCellByNames(worksheetInfo, SUPPLEMENT_ORDER_FIELD_NAMES) ||
        getControlById(sourceControls, SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID) ||
        getControlById(currentControls, SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID) ||
        getControlById(sourceControls, controlIds.supplementOrder) ||
        getControlById(currentControls, controlIds.supplementOrder) ||
        { controlId: SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID, controlName: SUPPLEMENT_ORDER_FIELD_NAMES[0], type: 29 };
      setSupplementOrderFieldControl(supplementField || null);
      const supplementCell = getCellByNames(sourceDetail, SUPPLEMENT_ORDER_FIELD_NAMES);
      const supplementWorksheetCandidates = Array.from(
        new Set([
          worksheetId,
          getRelationWorksheetId(supplementField),
          ...getLookupSourceWorksheetIds(
            supplementField,
            supplementCell,
            mergeControls(currentControls, sourceControls)
          ),
        ].filter(Boolean))
      );

      const getFilterRows = runtimeApi.getFilterRows || getWorksheetApiMethod("getFilterRows");
      const supplementRows = [];
      const supplementRowIds = new Set();
      let controls = [];
      let activeSupplementWorksheetControls = currentControls;
      let lastError = null;

      if (getFilterRows) {
        const pageSize = SUPPLEMENT_FETCH_PAGE_SIZE;
        const attempts = [];
        for (const candidateWorksheetId of supplementWorksheetCandidates) {
          let candidateWorksheetInfo =
            candidateWorksheetId === worksheetId
              ? worksheetInfo
              : null;
          if (!candidateWorksheetInfo) {
            try {
              candidateWorksheetInfo = await getWorksheetInfoCached(candidateWorksheetId, { getViews: true });
            } catch (error) {
              console.warn("load supplement worksheet info failed", candidateWorksheetId, error);
            }
          }
          const candidateControls = getControlsFromResponse(candidateWorksheetInfo);
          const candidateViews = Array.isArray(candidateWorksheetInfo?.views)
            ? candidateWorksheetInfo.views.filter((item) => !item?.advancedSetting?.hide)
            : [];
          const loadingViews = candidateViews.filter((item) =>
            SUPPLEMENT_ORDER_STATUS_TEXTS.some((statusText) =>
              normalizeFieldName(getViewName(item)).includes(normalizeFieldName(statusText))
            )
          );
          const otherViews = candidateViews.filter(
            (item) => !loadingViews.some((viewItem) => getViewIdValue(viewItem) === getViewIdValue(item))
          );

          attempts.push(
            ...loadingViews.map((item) => ({
              appId,
              worksheetId: candidateWorksheetId,
              viewId: getViewIdValue(item),
              controls: candidateControls,
              label: `loading-view:${candidateWorksheetId}:${getViewName(item)}`,
            })),
            { appId, worksheetId: candidateWorksheetId, viewId: "", controls: candidateControls, label: `worksheet:${candidateWorksheetId}` },
            ...otherViews.slice(0, 1).map((item) => ({
              appId,
              worksheetId: candidateWorksheetId,
              viewId: getViewIdValue(item),
              controls: candidateControls,
              label: `view:${candidateWorksheetId}:${getViewName(item)}`,
            }))
          );
        }

        for (const attempt of attempts) {
          activeSupplementWorksheetControls = attempt.controls?.length ? attempt.controls : currentControls;

          try {
            const { controls: _attemptControls, label: _attemptLabel, ...rowRequest } = attempt;
            const response = await getFilterRows({
              ...rowRequest,
              pageIndex: 1,
              pageSize,
              sortId: "",
              isAsc: false,
              notGetTotal: true,
              getWorksheet: true,
              isGetWorksheet: true,
            });
            controls = mergeControls(controls, getControlsFromResponse(response));
            getRowsFromResponse(response).forEach((row) => {
              const identity = getStableRowIdentity(row) || getRowIdValue(row);
              if (identity && supplementRowIds.has(identity)) return;
              if (identity) supplementRowIds.add(identity);
              supplementRows.push(row);
            });
          } catch (error) {
            lastError = error;
            console.warn("load supplement rows failed", attempt.label, error);
          }

        }
      }

      if (!supplementRows.length && lastError) {
        throw lastError;
      }

      const orderControls = controls.length ? controls : activeSupplementWorksheetControls;
      const allOptions = supplementRows
        .map((row) => toSupplementOrderOption(row, orderControls))
        .filter((option) => {
          if (!option.rowId || option.rowId === sourceRowId) return false;
          return true;
        });
      const statusOptions = allOptions.filter((option) => matchesSupplementOrderStatus(option.status));
      const options = (statusOptions.length ? statusOptions : allOptions)
        .sort((left, right) => {
          const priorityDifference =
            getSupplementOrderStatusPriority(left.status) -
            getSupplementOrderStatusPriority(right.status);
          if (priorityDifference) return priorityDifference;
          // Within the same status group, show the newest/largest loading
          // order number first. `numeric: true` keeps NL202609100 ahead of
          // NL20260999 instead of doing a plain character comparison.
          return String(right.label || "").localeCompare(String(left.label || ""), "zh-CN", { numeric: true });
        })
        .slice(0, SUPPLEMENT_FETCH_PAGE_SIZE);

      if (options.length) {
        supplementOptionsCache.set(cacheKey, {
          time: Date.now(),
          fieldControl: supplementField || null,
          options,
        });
      } else {
        supplementOptionsCache.delete(cacheKey);
      }
      setSupplementOrderOptions(options);
      setSelectedSupplementOrderId(options[0]?.value || "");
      setSaveStatus("");
    } catch (error) {
      console.warn("load supplement order options failed", error);
      setSupplementOrderOptions([]);
      setSelectedSupplementOrderId("");
      setSaveStatus("读取补装车单号失败");
    } finally {
      setSupplementOrderLoading(false);
    }
  }

  async function openSupplementModal() {
    if (runningActionName) return;
    if (!hasCheckedDetailRows) {
      setSaveStatus("请先勾选要装载的明细");
      return;
    }
    setSupplementSearchText("");
    // Open the dialog before reading the candidate orders. The request is
    // read-only and the select already has an explicit loading state, so
    // making the whole view wait here only delays visual feedback without
    // protecting any business write. The actual relation write and workflow
    // order in `confirmSupplementOrder` remains unchanged.
    setSupplementModalOpen(true);
    await loadSupplementOrderOptions();
  }

  async function syncSupplementOrderToMingdao(option, options = {}) {
    // Keep the supplement path intentionally small: write the value selected
    // in this dialog into its matching relation field, then start the existing
    // Mingdao “补装车” action. Do not clear, reverse-write or poll the record.
    const sourceControls = getControlsFromResponse(runtimeConfig);
    const runtimeControls = getControlsFromResponse(runtimeConfig);
    const control =
      supplementOrderFieldControl ||
      getControlById(sourceControls, SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID) ||
      getControlById(runtimeControls, SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID) ||
      findControlByNames(sourceControls, SUPPLEMENT_ORDER_FIELD_NAMES) ||
      findControlByNames(runtimeControls, SUPPLEMENT_ORDER_FIELD_NAMES) ||
      { controlId: SUPPLEMENT_ORDER_FALLBACK_CONTROL_ID, controlName: SUPPLEMENT_ORDER_FIELD_NAMES[0], type: 29 };
    const controlId = getControlIdFromItem(control);
    if (!controlId) {
      setSaveStatus("未找到字段：选择补装车的单号");
      return false;
    }
    const selectedRelationValue = JSON.stringify([{ sid: option.rowId }]);
    const saved = await updateWorksheetRecord(worksheetId, sourceRowId, [
      buildControlValue(
        controlId,
        selectedRelationValue,
        Number(control?.type) || 29,
        getControlName(control) || SUPPLEMENT_ORDER_FIELD_NAMES[0]
      ),
    ]);
    if (!saved) throw new Error("当前环境未开放补装车单号保存接口");
    if (typeof window !== "undefined") {
      window.__deliveryLoadingLastSupplementSync = {
        controlId,
        sourceRowId,
        selectedRowId: option.rowId,
        selectedOrderNo: option.label || "",
        value: selectedRelationValue,
      };
    }
    return true;
  }

  function handleSupplementOrderChange(value) {
    supplementSelectionVersionRef.current += 1;
    setSelectedSupplementOrderId(value);
    setSaveStatus("");
  }

  function handleSupplementSearchTextChange(value) {
    supplementSelectionVersionRef.current += 1;
    setSupplementSearchText(value);
    // Filtering is not a selection. Clear the previous order so the operator
    // must explicitly choose one item from the narrowed list before submit.
    setSelectedSupplementOrderId("");
    setSaveStatus("");
  }

  async function confirmSupplementOrder() {
    if (supplementOrderSyncing || runningActionName) return;
    const visibleOptions = supplementOrderOptions.filter((option) =>
      matchesFilterText(`${option.label || ""} ${option.status || ""}`, supplementSearchText)
    );
    // Never submit an option which is hidden by the user's current search.
    // This also protects a very fast type-and-confirm interaction before the
    // select has painted its new option list.
    const selectedOption = visibleOptions.find(
      (option) => option.value === selectedSupplementOrderId
    );
    if (!selectedOption) {
      setSaveStatus("请选择补装车的单号");
      return;
    }

    const operationVersion = ++supplementSelectionVersionRef.current;
    try {
      setSupplementOrderSyncing(true);
      setSaveStatus("正在同步补装车单号...");
      const synced = await syncSupplementOrderToMingdao(selectedOption, { verify: true });
      if (!synced) return;
      if (operationVersion !== supplementSelectionVersionRef.current) return;
      setSupplementModalOpen(false);
      await executeWorkflowButton(SUPPLEMENT_LOADING_BUTTON_NAME);
    } catch (error) {
      console.warn("confirm supplement order failed", error);
      if (operationVersion === supplementSelectionVersionRef.current) {
        setSaveStatus(error?.message || "补装车单号同步失败");
      }
    } finally {
      if (operationVersion === supplementSelectionVersionRef.current) {
        setSupplementOrderSyncing(false);
      }
    }
  }

  // 只隐藏装载前核对时服务器已确认勾选的明细——工作流装走的正是这些。
  // 无法核对时（verifiedIds 为 null）沿用原逻辑：隐藏此刻本账号勾选的明细。
  function hideCompletedLoadingRowsAfterWorkflow(verifiedIds = null) {
    const completedRowIds = (
      Array.isArray(verifiedIds)
        ? verifiedIds
        : getLatestDisplayRows()
            .filter((row) => !!row.checked && !isRowLoadedByAnotherAccount(row))
            .map((row) => row.id)
    ).filter(Boolean);
    if (!completedRowIds.length) return;

    const completedIdSet = new Set(completedRowIds);
    completedRowIds.forEach((rowId) => workflowHiddenRowIdsRef.current.add(rowId));

    setRows((current) => current.filter((row) => !completedIdSet.has(row.id)));
    setDraft((current) => {
      const nextDetailRows = { ...(current.detailRows || {}) };
      completedRowIds.forEach((rowId) => delete nextDetailRows[rowId]);
      return { ...current, detailRows: nextDetailRows };
    });

    const nextOverrides = { ...localDetailOverridesRef.current };
    completedRowIds.forEach((rowId) => {
      delete nextOverrides[rowId];
      detailSyncPromisesRef.current.delete(rowId);
      detailSyncErrorsRef.current.delete(rowId);
    });
    localDetailOverridesRef.current = nextOverrides;
    setLoadingVolume(0);
    setLoadedVolume(0);
    setLoadingArea(0);
    // 已装走的行不能再从页面缓存里“复活”：马上切走再切回时，缓存里还是装载前的行。
    invalidatePageSwitchCache();

    // The workflow response means Mingdao accepted the action, while its row
    // updates can still take a moment. Keep completed rows hidden locally,
    // refresh once for fast top-field feedback, then release the guard and do
    // an authoritative server refresh so a genuinely failed workflow can
    // restore its rows instead of being concealed forever.
    window.setTimeout(() => setRefreshVersion((current) => current + 1), 800);
    window.setTimeout(() => {
      completedRowIds.forEach((rowId) => workflowHiddenRowIdsRef.current.delete(rowId));
      setRefreshVersion((current) => current + 1);
    }, 5000);
  }

  async function executeWorkflowButton(buttonName) {
    if (runningActionName) return;
    if (!hasCheckedDetailRows) {
      setSaveStatus("请先勾选要装载的明细");
      return;
    }
    const buttonAliases =
      buttonName === SUPPLEMENT_LOADING_BUTTON_NAME
        ? SUPPLEMENT_LOADING_BUTTON_ALIASES
        : CONFIRM_LOADING_BUTTON_ALIASES;
    const targetButton =
      findButtonByAliases(buttons, buttonAliases) ||
      findButtonByName(buttons, buttonName);
    const targetButtonName = getButtonName(targetButton) || buttonName;
    const buttonId = getButtonId(targetButton) || (buttonName === CONFIRM_LOADING_BUTTON_NAME ? selectedButtonId : "");
    if (!buttonId) {
      const currentButtonNames = (Array.isArray(buttons) ? buttons : [])
        .map(getButtonName)
        .filter(Boolean)
        .join("、");
      setSaveStatus(
        currentButtonNames
          ? `未找到明道云自定义按钮：${buttonName}；当前按钮：${currentButtonNames}`
          : `未找到明道云自定义按钮：${buttonName}`
      );
      return;
    }

    const startProcess = getProcessApiMethod("startProcess");
    if (!startProcess) {
      setSaveStatus("当前环境未开放工作流触发接口");
      return;
    }

    // 整个装载流程期间后台补读暂停，核对和工作流请求不用排在补读后面。
    const endForegroundWork = beginForegroundWork();
    try {
      setRunningActionName(buttonName);
      setGlobalBusyCursor(true);
      setSaveStatus(
        buttonName === SUPPLEMENT_LOADING_BUTTON_NAME
          ? "正在准备补装..."
          : "正在准备装载..."
      );
      // 先让“装载中”完成一次渲染；后续仍使用原有的明细同步和工作流。
      // 顶部日期的后台校验绝不能阻断装载，避免日期字段异常影响装车业务。
      await runAfterInteractionPaint(() => undefined);
      let verification = null;
      try {
        setSaveStatus("正在同步已勾选的装载明细...");
        verification = await syncCurrentViewToMingdao();
      } catch (syncError) {
        console.warn("sync current view before workflow failed, stop workflow", syncError);
        setSaveStatus(syncError?.message || "明细尚未全部写入，已停止装载，请重试");
        return;
      }
      if (verification && (verification.unsavedRows.length || verification.missingRows.length)) {
        stopLoadingForUnverifiedRows(verification);
        return;
      }
      setUnsavedRowIds((current) => (current.size ? new Set() : current));
      setSaveStatus(
        buttonName === SUPPLEMENT_LOADING_BUTTON_NAME
          ? "正在触发补装流程..."
          : "正在触发装载流程..."
      );

      const processPayload = compactApiParams({
        appId: worksheetId,
        sources: sourceRowId ? [sourceRowId] : [],
        triggerId: buttonId,
        pushUniqueId: getPushUniqueId(),
        viewId,
        isAll: false,
      });
      console.info("trigger worksheet action workflow", {
        buttonName: targetButtonName,
        buttonId,
        payload: processPayload,
      });
      const result = await callStartProcess(startProcess, processPayload);
      if (!result) {
        setSaveStatus(`${buttonName}未执行：记录不满足条件或流程未启用`);
        return;
      }
      hideCompletedLoadingRowsAfterWorkflow(verification ? verification.verifiedIds : null);
      setSaveStatus("");
      setSystemFilters((current) => ({ ...current }));
    } catch (error) {
      console.warn("start custom button workflow failed", error);
      setSaveStatus(error?.message || `${buttonName}执行失败，请检查按钮权限或工作流配置`);
    } finally {
      endForegroundWork();
      setRunningActionName("");
      setGlobalBusyCursor(false);
    }
  }

  function getTopCellValue(column) {
    const topMap = {
      deliveryDate: dateText || "-",
      truck: currentTruckText,
      driver: currentTruckDriver,
      capacityArea: formatNumber(effectiveCapacityArea, 2),
      loadingArea: formatNumber(effectiveLoadingArea, 2),
      loadingVolume: formatNumber(rows.length ? totals.loadedVolume : loadingVolume, 2),
      capacityVolume: formatNumber(effectiveCapacityVolume, 2),
      progress: `${progress}%`,
      loadingAction: "",
    };
    return topMap[column.key] || "-";
  }

  function renderProgressCell() {
    return (
      <ProgressWrap
        $track={progressTone.track}
        $border={progressTone.border}
        title={
          effectiveCapacityArea
            ? `在装平方 ${formatNumber(effectiveLoadingArea, 2)} / 可载平方 ${formatNumber(effectiveCapacityArea, 2)}`
            : `已载立方 ${formatNumber(totals.loadedVolume, 2)} / 可载立方 ${formatNumber(effectiveCapacityVolume, 2)}`
        }
      >
        <ProgressFill $percent={progressWidth} $fill={progressTone.fill} />
        <ProgressText $color={progressTone.color}>{progress}%</ProgressText>
      </ProgressWrap>
    );
  }

  function renderTopCell(column) {
    if (column.key === "deliveryDate") {
      return (
        <TopInput
          type="date"
          value={dateText}
          onChange={(event) => {
            const nextDateText = event.target.value || getTodayInputValue();
            setDateText(nextDateText);
            setSaveStatus("");
            topDateSyncErrorRef.current = null;
            const dateSyncPromise = syncTopFieldsToMingdao({ dateText: nextDateText });
            topDateSyncPromiseRef.current = dateSyncPromise;
            dateSyncPromise
              .then(() => setSaveStatus(""))
              .catch((error) => {
                console.warn("sync date failed", error);
                topDateSyncErrorRef.current = error;
                // 日期回读异常仅保留在控制台诊断，不显示在业务界面，
                // 更不能影响勾选、装载量写入或装车工作流。
              })
              .finally(() => {
                if (topDateSyncPromiseRef.current === dateSyncPromise) {
                  topDateSyncPromiseRef.current = null;
                }
              });
          }}
        />
      );
    }

    if (column.key === "truck") {
      return (
        <TopSelect
          value={selectedTruckId}
          onChange={(event) => {
            const previousTruckId = selectedTruckId;
            const nextTruckId = event.target.value;
            const nextTruck = truckOptions.find((item) => item.value === nextTruckId);
            const nextCapacityArea = nextTruck?.capacityArea || 0;
            const nextCapacityVolume = nextTruck?.capacityVolume || 0;
            setSelectedTruckId(nextTruckId);
            setCapacityArea(nextCapacityArea);
            setCapacityVolume(nextCapacityVolume);
            updateDraft({ selectedTruckId: nextTruckId });
            syncTopFieldsToMingdao({
              selectedTruckId: nextTruckId,
              previousTruckId,
            })
              .then(() => setSaveStatus(""))
              .catch((error) => {
                console.warn("sync truck capacity failed", error);
                setSaveStatus(error?.message || "同步明道云字段失败");
              });
          }}
        >
          {truckOptions.length ? (
            truckOptions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))
          ) : (
            <option value="">未关联货车</option>
          )}
        </TopSelect>
      );
    }

    if (column.key === "progress") {
      return renderProgressCell();
    }

    if (column.key === "loadingAction") {
      const disabledReason = hasCheckedDetailRows ? "running" : "empty";
      const confirmRunning = runningActionName === CONFIRM_LOADING_BUTTON_NAME;
      const supplementRunning = runningActionName === SUPPLEMENT_LOADING_BUTTON_NAME;
      return (
        <ActionButtonGroup>
          <ConfirmButton
            type="button"
            $primary
            $disabledReason={disabledReason}
            $running={confirmRunning}
            disabled={!hasCheckedDetailRows || !!runningActionName}
            onClick={() => executeWorkflowButton(CONFIRM_LOADING_BUTTON_NAME)}
          >
            <ActionButtonContent>
              {confirmRunning && <ActionButtonSpinner aria-hidden="true" />}
              {confirmRunning ? "装载中" : "装载"}
            </ActionButtonContent>
          </ConfirmButton>
          <ConfirmButton
            type="button"
            $primary
            $variant="supplement"
            $disabledReason={disabledReason}
            $running={supplementRunning}
            disabled={!hasCheckedDetailRows || !!runningActionName}
            onClick={openSupplementModal}
          >
            <ActionButtonContent>
              {supplementRunning && <ActionButtonSpinner aria-hidden="true" />}
              {supplementRunning ? "补装中" : "补装"}
            </ActionButtonContent>
          </ConfirmButton>
        </ActionButtonGroup>
      );
    }

    return getTopCellValue(column);
  }

  function getSummaryCellValue(customer, column) {
    const summaryMap = {
      selected: customer.key === effectiveActiveCustomerKey ? "V" : "",
      clientCode: customer.clientCode || "-",
      route: customer.route,
      shortName: customer.clientShortName,
      address: customer.clientName,
      detailCount: formatNumber(customer.detailCount),
      plannedQty: formatNumber(customer.plannedQty),
      inventoryQty: formatNumber(customer.inventoryQty),
      plannedVolume: formatNumber(customer.plannedVolume, 2),
      inventoryVolume: formatNumber(customer.inventoryVolume, 2),
      plannedArea: formatNumber(customer.plannedArea, 2),
      inventoryArea: formatNumber(customer.inventoryArea, 2),
      loadedArea: formatNumber(customer.loadedArea, 2),
    };
    return summaryMap[column.key] || "-";
  }

  function getDetailCellValue(row, column, index) {
    const detailMap = {
      checked: row.checked ? "已选" : "未选",
      index: index + 1,
      clientCode: row.clientCode || "-",
      shortName: row.clientShortName || row.client || "-",
      address: row.address || row.clientName || row.client || "-",
      route: row.route || "-",
      productArchive: row.productArchive || "-",
      workOrder: row.workOrder || "-",
      purchaseOrder: row.purchaseOrder || "-",
      productName: row.productName || "-",
      specificationModel: row.specificationModel || "-",
      materialCode: row.materialCode || "-",
      size: row.size || "-",
      model: row.model || "-",
      unitPrice: formatOptionalNumber(row.unitPrice, 2),
      productionStatus: row.productionStatus || "",
      plannedQty: formatNumber(row.plannedQty),
      inventoryQty: formatNumber(row.inventoryQty),
      loadedQty: formatNumber(row.loadedQty),
      loadingUser: row.loadingUser || "",
      unitArea: formatNumber(row.unitArea, 4),
      convertedArea: formatNumber(row.convertedArea, 4),
      convertedVolume: formatNumber(row.convertedVolume, 4),
      remark: row.remark || "",
      totalPurchaseQty: formatOptionalNumber(row.totalPurchaseQty),
      totalBoardQty: formatOptionalNumber(row.totalBoardQty),
      printCompleted: row.printCompleted || "",
      formingCompleted: row.formingCompleted || "",
      totalInboundQty: formatOptionalNumber(row.totalInboundQty),
      totalOutboundQty: formatOptionalNumber(row.totalOutboundQty),
      plannedVolume: formatNumber(row.plannedVolume, 2),
      inventoryVolume: formatNumber(row.inventoryVolume, 2),
      loadedVolume: formatNumber(row.loadedVolume, 2),
      plannedArea: formatNumber(row.plannedArea, 2),
      inventoryArea: formatNumber(row.inventoryArea, 2),
      loadedArea: formatNumber(row.loadedArea, 2),
    };
    return detailMap[column.key] || "-";
  }

  function setDetailLoaded(row, checked) {
    if (runningActionName) return;
    if (isRowLoadedByAnotherAccount(row)) {
      setSaveStatus(`此明细由【${row.loadingUser}】装载，当前账号不可修改`);
      return;
    }
    const loadedQty = checked ? row.plannedQty : "";
    const currentMember = getCurrentAccountInfo();
    const nextLoadingUser = checked
      ? currentMember.fullname || currentMember.accountId || row.loadingUser || ""
      : "";
    // Exactly one visible state update is made in the event handler. The API
    // chain starts only after React has had a frame to paint this local value.
    updateLocalDetailLoaded(row, loadedQty, checked, nextLoadingUser);
    // 只清掉本行的提示。此前这里无条件清空，连续勾选会把上一行的
    // “同步失败”抹掉，写入丢失因此一直是静默的。
    clearTransientSaveStatus();
    queueDetailSync(row.id, () =>
      syncDetailLoadedToMingdao(row, loadedQty, { syncChecked: true, checked })
    )
      .then(() => {
        // Local state already represents the saved value. Avoid a second
        // render here so the next row remains immediately interactive.
      })
      .catch((error) => {
        console.warn("sync detail load selection failed", error);
        setSaveStatus(error?.message || "勾选和装载量同步失败");
      });
  }

  function toggleDetailLoaded(row) {
    setDetailLoaded(row, !row.checked);
  }

  function renderDetailCell(row, column, index) {
    const lockedByOtherLoader = isRowLoadedByAnotherAccount(row);
    if (column.key === "returnAction") {
      const returning = returningRowId === row.id;
      return (
        <ReturnCellButton
          type="button"
          title="退回：触发明细记录的“退回计划”按钮"
          aria-label={`退回明细 ${row.workOrder || row.productName || row.id}`}
          disabled={returning || deletingRowId === row.id}
          onClick={(event) => {
            event.stopPropagation();
            setSaveStatus("");
            setReturnCandidate(row);
          }}
        >
          {returning ? "…" : "↩"}
        </ReturnCellButton>
      );
    }

    if (column.key === "deleteAction") {
      const deleting = deletingRowId === row.id;
      return (
        <DeleteCellButton
          type="button"
          title="删除此明细"
          aria-label={`删除明细 ${row.workOrder || row.productName || row.id}`}
          disabled={deleting || returningRowId === row.id}
          onClick={(event) => {
            event.stopPropagation();
            setSaveStatus("");
            setDeleteCandidate(row);
          }}
        >
          {deleting ? "…" : "⊖"}
        </DeleteCellButton>
      );
    }

    if (column.key === "checked") {
      return (
        <LoadCheckInput
          type="checkbox"
          checked={!!row.checked}
          disabled={lockedByOtherLoader || !!runningActionName}
          title={lockedByOtherLoader ? `此明细由 ${row.loadingUser} 装载，当前账号不可修改` : ""}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => {
            setDetailLoaded(row, event.target.checked);
          }}
        />
      );
    }

    if (column.key === "loadedQty") {
      return (
        <QtyInput
          type="number"
          min="0"
          value={row.loadedQty || ""}
          disabled={lockedByOtherLoader || !!runningActionName}
          title={lockedByOtherLoader ? `此明细由 ${row.loadingUser} 装载，当前账号不可修改` : ""}
          onChange={(event) => {
            if (lockedByOtherLoader || runningActionName) return;
            const nextLoadedQty = event.target.value;
            const nextChecked = Number(nextLoadedQty) > 0 || row.checked;
            const currentMember = getCurrentAccountInfo();
            const nextLoadingUser = nextChecked
              ? currentMember.fullname || currentMember.accountId || row.loadingUser || ""
              : "";
            updateLocalDetailLoaded(
              row,
              nextLoadedQty,
              nextChecked,
              nextLoadingUser
            );
          }}
          onBlur={(event) => {
            if (lockedByOtherLoader || runningActionName) return;
            const nextLoadedQty = event.target.value;
            const nextChecked = Number(nextLoadedQty) > 0 || row.checked;
            queueDetailSync(row.id, () =>
              syncDetailLoadedToMingdao(row, nextLoadedQty, {
                syncChecked: true,
                checked: nextChecked,
              })
            )
              .then(() => {
                // No server-result state write: the value is already visible.
              })
              .catch((error) => {
                console.warn("sync detail loaded quantity failed", error);
                setSaveStatus(error?.message || "装载量和勾选同步失败");
              });
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      );
    }

    if (column.key === "loadingUser" && lockedByOtherLoader) {
      return <span title="其他账号已装载，此行不可修改" style={{ color: "#a15c00", fontWeight: 800 }}>🔒 {row.loadingUser}</span>;
    }

    if (column.key === "remark") {
      return (
        <RemarkInput
          type="text"
          value={row.remark || ""}
          onChange={(event) =>
            updateDetailDraft(row.id, {
              remark: event.target.value,
            })
          }
          onBlur={(event) =>
            syncDetailRemarkToMingdao(row, event.target.value)
              .then((success) => {
                if (success) {
                  updateLocalDetailRow(row.id, { remark: event.target.value });
                  clearDetailDraftKeys(row.id, ["remark"]);
                  setSaveStatus("");
                }
              })
              .catch((error) => {
                console.warn("sync detail remark failed", error);
                setSaveStatus("同步明道云字段失败");
              })
          }
        />
      );
    }

    if (column.key === "index") {
      return <IndexCell as="div">{getDetailCellValue(row, column, index)}</IndexCell>;
    }

    if (column.key === "shortName") {
      return <InlineTag>{getDetailCellValue(row, column, index)}</InlineTag>;
    }

    return getDetailCellValue(row, column, index);
  }

  function renderSupplementOrderModal() {
    if (!supplementModalOpen) return null;
    const confirmDisabled = supplementOrderLoading || supplementOrderSyncing || !selectedSupplementOrderId || !!runningActionName;
    const visibleSupplementOptions = supplementOrderOptions.filter((option) =>
      matchesFilterText(`${option.label || ""} ${option.status || ""}`, supplementSearchText)
    );

    return (
      <ModalBackdrop>
        <ModalPanel>
          <ModalHead>请选择补装车的单号</ModalHead>
          <ModalBody>
            <ModalHint>优先显示“装车未送”（单号从大到小），再显示“已送未回”；首批仅加载 50 条。</ModalHint>
            <ModalNumberInput
              type="text"
              placeholder="输入单号或状态筛选"
              value={supplementSearchText}
              disabled={supplementOrderLoading || supplementOrderSyncing}
              onChange={(event) => handleSupplementSearchTextChange(event.target.value)}
            />
            <ModalSelect
              value={selectedSupplementOrderId}
              disabled={supplementOrderLoading || supplementOrderSyncing}
              onChange={(event) => handleSupplementOrderChange(event.target.value)}
            >
              {supplementOrderLoading ? (
                <option value="">正在读取...</option>
              ) : visibleSupplementOptions.length ? (
                <>
                  <option value="">请选择补装车单号</option>
                  {visibleSupplementOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.status ? `${option.label}（${option.status}）` : option.label}
                    </option>
                  ))}
                </>
              ) : (
                <option value="">暂无符合条件的装车单号</option>
              )}
            </ModalSelect>
          </ModalBody>
          <ModalActions>
            <FieldButton
              type="button"
              onClick={() => setSupplementModalOpen(false)}
              disabled={supplementOrderSyncing || !!runningActionName}
            >
              取消
            </FieldButton>
            <SaveButton
              type="button"
              $primary
              disabled={confirmDisabled}
              onClick={confirmSupplementOrder}
            >
              确认补装
            </SaveButton>
          </ModalActions>
        </ModalPanel>
      </ModalBackdrop>
    );
  }

  function renderDeleteConfirmModal() {
    if (!deleteCandidate) return null;
    const deleting = deletingRowId === deleteCandidate.id;
    const recordText = [
      deleteCandidate.clientShortName || deleteCandidate.client,
      deleteCandidate.workOrder,
      deleteCandidate.productName,
    ].filter(Boolean).join(" · ");

    return (
      <ModalBackdrop
        role="presentation"
        onClick={() => {
          if (!deleting) setDeleteCandidate(null);
        }}
      >
        <ModalPanel
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-detail-title"
          onClick={(event) => event.stopPropagation()}
        >
          <ModalHead id="delete-detail-title">确认删除</ModalHead>
          <ModalBody>
            <DeleteRecordText>
              是否确认删除这条明细？
              {recordText ? <><br /><strong>{recordText}</strong></> : null}
            </DeleteRecordText>
            <ModalHint>确认后将同步删除明道云中的对应记录并进入回收站。按 Enter 可直接确认。</ModalHint>
          </ModalBody>
          <ModalActions>
            <FieldButton
              type="button"
              disabled={deleting}
              onClick={() => setDeleteCandidate(null)}
            >
              取消
            </FieldButton>
            <DeleteConfirmButton
              autoFocus
              type="button"
              disabled={deleting}
              onClick={confirmDeleteDetailRow}
            >
              {deleting ? "删除中..." : "确认删除"}
            </DeleteConfirmButton>
          </ModalActions>
        </ModalPanel>
      </ModalBackdrop>
    );
  }

  function renderReturnConfirmModal() {
    if (!returnCandidate) return null;
    const returning = returningRowId === returnCandidate.id;
    const recordText = [
      returnCandidate.clientShortName || returnCandidate.client,
      returnCandidate.workOrder,
      returnCandidate.productName,
    ].filter(Boolean).join(" · ");

    return (
      <ModalBackdrop
        role="presentation"
        onClick={() => {
          if (!returning) setReturnCandidate(null);
        }}
      >
        <ModalPanel
          role="dialog"
          aria-modal="true"
          aria-labelledby="return-detail-title"
          onClick={(event) => event.stopPropagation()}
        >
          <ModalHead id="return-detail-title">确认退回</ModalHead>
          <ModalBody>
            <DeleteRecordText>
              是否确认退回这条明细？
              {recordText ? <><br /><strong>{recordText}</strong></> : null}
            </DeleteRecordText>
            <ModalHint>确认后将同步触发该明细记录的“退回计划”按钮。按 Enter 可直接确认。</ModalHint>
          </ModalBody>
          <ModalActions>
            <FieldButton
              type="button"
              disabled={returning}
              onClick={() => setReturnCandidate(null)}
            >
              取消
            </FieldButton>
            <ReturnConfirmButton
              autoFocus
              type="button"
              disabled={returning}
              onClick={confirmReturnDetailRow}
            >
              {returning ? "退回中..." : "确认退回"}
            </ReturnConfirmButton>
          </ModalActions>
        </ModalPanel>
      </ModalBackdrop>
    );
  }

  return (
    <Shell $busyCursor={globalBusyCursor}>
      <Stack>
        <TopPanel style={{ height: topHeight }}>
          <TopTitle>
            <span>装车信息</span>
            {saveStatus ? <TopStatus title={saveStatus}>{saveStatus}</TopStatus> : null}
          </TopTitle>
          <TopTableWrap>
            <CompactGrid $minWidth={topMinWidth}>
              <thead>
                <tr>
                  {topHeaders.topRow.map((column) =>
                    column.type === "group" ? (
                      <th key={column.title} colSpan={column.colSpan}>
                        {column.title}
                      </th>
                    ) : (
                      renderHeaderCell(column, "top", setTopColumns)
                    )
                  )}
                </tr>
                {topHeaders.secondRow.length ? (
                  <tr>
                    {topHeaders.secondRow.map((column) =>
                      renderHeaderCell(column, "top", setTopColumns)
                    )}
                  </tr>
                ) : null}
              </thead>
              <tbody>
                <tr>
                  {visibleTopColumns.map((column) => (
                    <td
                      key={column.key}
                      style={column.width ? { width: column.width } : undefined}
                    >
                      {renderTopCell(column)}
                    </td>
                  ))}
                </tr>
              </tbody>
            </CompactGrid>
          </TopTableWrap>
        </TopPanel>
        <ResizeBarHorizontal onMouseDown={() => setDraggingColumn({ type: "pane-horizontal" })} />

        <Split>
          <LeftPanel style={{ flexBasis: `${leftWidth}%`, width: `${leftWidth}%` }}>
            <PanelHead>
              <PanelTitle>汇总</PanelTitle>
              <PanelActions>
                {renderFilterActions("summary")}
                <PanelMeta>{filteredCustomerGroups.length} 个客户</PanelMeta>
              </PanelActions>
            </PanelHead>

            {customerGroups.length === 0 ? (
              <EmptyTip>{emptyMessage}</EmptyTip>
            ) : (
              <TableWrap>
                <Grid $minWidth={summaryMinWidth}>
                  <thead>
                    <tr>
                      {summaryHeaders.topRow.map((column) =>
                        column.type === "group" ? (
                          <th key={column.title} colSpan={column.colSpan}>
                            {column.title}
                          </th>
                        ) : (
                          renderHeaderCell(column, "summary", setSummaryColumns)
                        )
                      )}
                    </tr>
                    {summaryHeaders.secondRow.length ? (
                      <tr>
                        {summaryHeaders.secondRow.map((column) =>
                          renderHeaderCell(column, "summary", setSummaryColumns)
                        )}
                      </tr>
                    ) : null}
                  </thead>
                  <tbody>
                    {visibleCustomerGroups.map((customer) => (
                      <SummaryRow
                        key={customer.key}
                        $active={customer.key === effectiveActiveCustomerKey}
                        $total={customer.key === ALL_CUSTOMERS_KEY}
                      >
                        {visibleSummaryColumns.map((column) => (
                          <td
                            key={column.key}
                            style={column.width ? { width: column.width } : undefined}
                          >
                            <SelectCellButton
                              type="button"
                              onClick={() => setActiveCustomerKey(customer.key)}
                            >
                              {getSummaryCellValue(customer, column)}
                            </SelectCellButton>
                          </td>
                        ))}
                      </SummaryRow>
                    ))}
                  </tbody>
                </Grid>
              </TableWrap>
            )}
          </LeftPanel>
          <ResizeBarVertical onMouseDown={() => setDraggingColumn({ type: "pane-vertical" })} />

          <RightPanel>
            <PanelHead>
              <PanelTitle>明细</PanelTitle>
              <PanelActions>
                {renderFilterActions("detail")}
                <FieldActionSlot>{renderFieldButton()}</FieldActionSlot>
                <PanelMeta>{filteredDetailRows.length} 条明细</PanelMeta>
              </PanelActions>
            </PanelHead>

            <TableWrap onScroll={handleDetailTableScroll}>
              <Grid $minWidth={detailMinWidth}>
                <thead>
                  <tr>
                    {detailHeaders.topRow.map((column) =>
                      column.type === "group" ? (
                        <th key={column.title} colSpan={column.colSpan}>
                          {column.title}
                        </th>
                      ) : (
                        renderHeaderCell(column, "detail", setDetailColumns)
                      )
                    )}
                  </tr>
                  {detailHeaders.secondRow.length ? (
                    <tr>
                      {detailHeaders.secondRow.map((column) =>
                        renderHeaderCell(column, "detail", setDetailColumns)
                      )}
                    </tr>
                  ) : null}
                </thead>
                <tbody>
                  {filteredDetailRows.length === 0 ? (
                    <tr>
                      <td colSpan={visibleDetailColumns.length || 1}>
                        <EmptyTip>{emptyMessage}</EmptyTip>
                      </td>
                    </tr>
                  ) : (
                    <>
                      {virtualDetailRows.beforeHeight ? (
                        <tr aria-hidden="true">
                          <VirtualSpacerCell
                            colSpan={visibleDetailColumns.length || 1}
                            $height={virtualDetailRows.beforeHeight}
                          />
                        </tr>
                      ) : null}
                      {virtualDetailRows.rows.map((row, offset) => {
                        const index = virtualDetailRows.start + offset;
                        const lockedByOtherLoader = isRowLoadedByAnotherAccount(row);
                        return (
                      <VirtualDetailRow
                        key={row.id}
                        $locked={lockedByOtherLoader}
                        $unsaved={unsavedRowIds.has(row.id)}
                        title={unsavedRowIds.has(row.id) ? "这条明细的勾选/装载量没有存进明道云，本次未装载；请重新勾选后再点装载" : undefined}
                      >
                        {visibleDetailColumns.map((column) => {
                          const isLoadColumn = column.key === "checked";
                          const isLoadedQtyColumn = column.key === "loadedQty";
                          const isDeleteColumn = column.key === "deleteAction";
                          const isReturnColumn = column.key === "returnAction";
                          const actionRight = getDetailActionRight(column.key);
                          const cellStyle = {
                            ...(column.width ? { width: column.width } : {}),
                            ...(isLoadColumn ? {
                              textAlign: "center",
                              cursor: lockedByOtherLoader ? "not-allowed" : "pointer",
                            } : {}),
                            ...(isDeleteColumn || isReturnColumn
                              ? {
                                  position: "sticky",
                                  right: actionRight,
                                  zIndex: 4,
                                  textAlign: "center",
                                  padding: "2px",
                                  background: lockedByOtherLoader ? "#fff3db" : "#f7fbff",
                                  boxShadow: actionRight
                                    ? "-1px 0 0 #c6d8ec"
                                    : "-2px 0 5px rgba(37, 76, 116, 0.16)",
                                }
                              : {}),
                          };

                          return (
                            <td
                              key={column.key}
                              style={Object.keys(cellStyle).length ? cellStyle : undefined}
                              onClick={isLoadColumn && !lockedByOtherLoader ? () => toggleDetailLoaded(row) : undefined}
                              onKeyDown={
                                isLoadColumn && !lockedByOtherLoader
                                  ? (event) => {
                                      if (event.key === "Enter" || event.key === " ") {
                                        event.preventDefault();
                                        toggleDetailLoaded(row);
                                      }
                                    }
                                  : undefined
                              }
                              tabIndex={isLoadColumn && !lockedByOtherLoader ? 0 : undefined}
                              role={isLoadColumn && !lockedByOtherLoader ? "checkbox" : undefined}
                              aria-checked={isLoadColumn ? !!row.checked : undefined}
                              aria-disabled={isLoadColumn || isLoadedQtyColumn ? lockedByOtherLoader : undefined}
                            >
                              {renderDetailCell(row, column, index)}
                            </td>
                          );
                        })}
                      </VirtualDetailRow>
                        );
                      })}
                      {virtualDetailRows.afterHeight ? (
                        <tr aria-hidden="true">
                          <VirtualSpacerCell
                            colSpan={visibleDetailColumns.length || 1}
                            $height={virtualDetailRows.afterHeight}
                          />
                        </tr>
                      ) : null}
                    </>
                  )}
                </tbody>
              </Grid>
            </TableWrap>
          </RightPanel>
        </Split>
      </Stack>
      {renderSupplementOrderModal()}
      {renderDeleteConfirmModal()}
      {renderReturnConfirmModal()}
      {renderFieldPopover()}
      {renderColumnFilterPopover()}
    </Shell>
  );
}
