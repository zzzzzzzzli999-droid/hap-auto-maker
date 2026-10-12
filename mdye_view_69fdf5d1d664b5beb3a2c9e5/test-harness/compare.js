// 原版 vs 新版：同一组模拟场景各跑一次，输出关键指标。
// 用法：NODE_PATH=$(npm root -g) node compare.js
const { run } = require("./run.js");
const scenarios = [
  ["80条 正常网络", "rows=80&latency=500", { waitBeforeCheck: 5500 }],
  ["80条 通道拥挤(并发2/800ms)", "rows=80&latency=800&conn=2", { waitBeforeCheck: 5500 }],
  ["80条 拥挤+账号需深度查找", "rows=80&latency=800&conn=2&account=deep", { waitBeforeCheck: 5500 }],
  ["250条 正常网络+账号深度查找", "rows=250&latency=500&account=deep", { waitBeforeCheck: 5500 }],
  ["80条 一条写入被明道云吞掉", "rows=80&latency=500&silent=d-0016", { waitBeforeCheck: 5500 }],
];
(async () => {
  const rows = [];
  for (const [label, query, options] of scenarios) {
    for (const [name, bundle] of [["原版", "bundle-orig.js"], ["新版", "bundle-new.js"]]) {
      const r = await run(bundle, query, { pick: [2, 15, 29], gap: 80, ...options });
      rows.push({ 场景: label, 版本: name, 首屏ms: r.firstRowsMs, 打开阶段卡顿ms: r.longTaskMs, 最长卡顿ms: r.longestMs, 勾选响应ms: Math.max(...r.checkLatency), 装载耗时ms: r.loadingMs, 装载阶段卡顿ms: r.loadingLongTaskMs, 已装: r.loaded.length, 未装且被隐藏: r.lost.filter((id) => !r.stillInRelation.includes(id) ? false : r.visibleChecked === 0 && r.loaded.length > 0).length, 状态: r.status.slice(0, 40) });
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
  }
  console.table(rows);
})();
