#!/bin/bash
# 一键更新并发布「后道机床排程」插件：
#   ① 下载 GitHub 上指定版本的插件代码（默认分支最新版本）；
#   ② 本地插件目录的 src/ 和 .config/ 先备份到 插件目录/.backup/时间/，再用新代码覆盖；
#   ③ mdye sync-params 同步插件参数；④ mdye push 把新版本推送到明道。
# 推送成功后，到明道「插件」→ 后道机床排程 → 提交记录 里点“发布”，刷新页面即用上新版本。
#
# 用法：bash publish.sh [版本(commit 或分支)] [插件目录]
# 注意：mdye sync-params / mdye push 失败时退出码也是 0，所以这里按输出文字判断是否成功。

COMMIT="${1:-claude/mdye-view-directory-dkpgm4}"
PLUGIN_DIR="${2:-$HOME/Documents/Codex/2026-07-26/mdye_view_6a661c92b731e5e5c64abe17}"
REPO="zzzzzzzzli999-droid/hap-auto-maker"
SUBDIR="mdye_view_6a661c92b731e5e5c64abe17"

if [ ! -f "$PLUGIN_DIR/mdye.json" ]; then
  echo "找不到插件目录：$PLUGIN_DIR（里面应该有 mdye.json）"
  exit 1
fi
if ! command -v mdye >/dev/null 2>&1; then
  echo "没有找到 mdye 命令，请先安装：npm i -g mdye-cli"
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "① 下载 ${COMMIT} 的插件代码…"
if ! curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$COMMIT" | tar -xz -C "$tmp"; then
  echo "下载失败，请检查网络后重试"
  exit 1
fi
src_root=$(find "$tmp" -maxdepth 2 -type d -name "$SUBDIR" | head -1)
if [ ! -f "$src_root/src/App.js" ] || [ ! -f "$src_root/.config/params-config.json" ]; then
  echo "下载的代码不完整，已停止（本地插件没有改动）"
  exit 1
fi

echo "② 备份并覆盖本地插件 $PLUGIN_DIR"
backup="$PLUGIN_DIR/.backup/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup" "$PLUGIN_DIR/src" "$PLUGIN_DIR/.config"
cp -R "$PLUGIN_DIR/src" "$PLUGIN_DIR/.config" "$backup/" 2>/dev/null
if ! cp -R "$src_root/src/." "$PLUGIN_DIR/src/" || ! cp -R "$src_root/.config/." "$PLUGIN_DIR/.config/"; then
  echo "覆盖失败（原文件备份在 $backup）"
  exit 1
fi
echo "   已覆盖，原文件备份在 $backup"
version=$(grep -o 'PLUGIN_VERSION = "[^"]*"' "$PLUGIN_DIR/src/App.js" | head -1 | cut -d'"' -f2)
echo "   本地插件版本：${version:-未知}"
MESSAGE="${PUBLISH_MESSAGE:-后道机床排程 插件版本 ${version:-未知}（${COMMIT:0:7}）}"

cd "$PLUGIN_DIR" || exit 1
# 从终端读输入（mdye 未登录时会要求登录）；用 curl ... | bash 运行时标准输入不是终端
input=/dev/stdin
if [ ! -t 0 ] && (exec < /dev/tty) 2>/dev/null; then input=/dev/tty; fi

# $1 说明，$2 成功时输出里必须出现的文字（中/繁/英/日），其余为 mdye 参数
run_mdye() {
  local label="$1" success="$2"; shift 2
  local log="$tmp/mdye.log"
  : > "$log"
  echo "$label"
  mdye "$@" < "$input" 2>&1 | tee "$log"
  if ! grep -Eiq "$success" "$log" || grep -Eiq "失败|失敗|failed|error|请先登录|請先登錄" "$log"; then
    echo "✗ 没有成功（见上面的提示）。本地代码已是新版本，处理好后在插件目录重新运行：mdye $*"
    exit 1
  fi
}

run_mdye "③ 同步插件参数（mdye sync-params）…" "同步成功|synced successfully|同期に成功" sync-params
run_mdye "④ 推送新版本到明道（mdye push）…" "push ?成功|push successful" push -m "$MESSAGE"

echo ""
echo "✓ 完成：本地插件已覆盖为 ${COMMIT:0:7}，新版本已推送到明道。"
echo "  最后一步：明道「插件」→ 后道机床排程 → 提交记录，点最新一条的“发布”，然后刷新页面（Command + Shift + R）。"
[ -n "$version" ] && echo "  刷新后插件左下角应显示「插件版本 ${version}」；不是这个版本号，说明明道还在用旧版本。"
exit 0
