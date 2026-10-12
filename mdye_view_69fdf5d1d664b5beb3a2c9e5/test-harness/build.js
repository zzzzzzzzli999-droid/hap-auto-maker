// 用 esbuild 把插件源码打成和 mdye build 等价的单文件包，供 index.html 加载。
// 用法：NODE_PATH=<装好 mdye/react/react-dom/styled-components/esbuild 的 node_modules> node build.js <src目录> <输出文件>
const path = require("path");
const esbuild = require("esbuild");
const [srcDir, outFile] = process.argv.slice(2);
esbuild.buildSync({
  entryPoints: [path.resolve(srcDir, "index.js")],
  bundle: true,
  outfile: path.resolve(outFile),
  format: "iife",
  minify: process.env.NO_MINIFY !== "1",
  loader: { ".js": "jsx", ".less": "empty", ".svg": "empty" },
  define: { "process.env.NODE_ENV": '"production"' },
  nodePaths: (process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean),
  logLevel: "warning",
});
console.log("built", outFile);
