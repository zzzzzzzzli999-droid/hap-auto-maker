const fs = require("fs");
const p = JSON.parse(fs.readFileSync(process.argv[2]));
const self = new Map(); const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas; const counts = new Map();
p.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
for (const [id, us] of counts) { const n = byId.get(id); const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber}`; self.set(key, (self.get(key) || 0) + us); }
// inclusive time
const parent = new Map(); p.nodes.forEach((n) => (n.children || []).forEach((c) => parent.set(c, n.id)));
const incl = new Map();
for (const [id, us] of counts) { const seen = new Set(); let cur = id; while (cur) { const n = byId.get(cur); const key = `${n.callFrame.functionName || "(anon)"}:${n.callFrame.lineNumber}`; if (!seen.has(key)) { incl.set(key, (incl.get(key) || 0) + us); seen.add(key); } cur = parent.get(cur); } }
const top = (m, k) => [...m.entries()].filter(([key]) => !/^\((idle|program|root|garbage collector)\)/.test(key)).sort((a, b) => b[1] - a[1]).slice(0, k).map(([key, us]) => `${(us / 1000).toFixed(0).padStart(6)}ms  ${key}`);
console.log("== self"); console.log(top(self, 25).join("\n"));
console.log("== inclusive"); console.log(top(incl, 40).join("\n"));
