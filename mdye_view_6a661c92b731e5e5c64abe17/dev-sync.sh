#!/bin/bash
# 边改边测：自动把 GitHub 上最新的插件代码覆盖到本地插件目录。
# Claude 每次推送到 claude/mdye-view-directory-dkpgm4 分支，几秒内这里就会把 src/ 和 .config/
# 覆盖到本地插件目录；mdye start 会自动重新编译，刷新明道页面即可看到。
# 覆盖前会把本地原文件备份到 插件目录/.backup/时间/。按 Control + C 停止。
#
# 用法：bash dev-sync.sh [插件目录]

PLUGIN_DIR="${1:-$HOME/Documents/Codex/2026-07-26/mdye_view_6a661c92b731e5e5c64abe17}"
REPO_DIR="${HAP_SYNC_DIR:-$HOME/Documents/Codex/2026-07-26/hap-sync-auto}"
BRANCH="claude/mdye-view-directory-dkpgm4"
REPO_URL="https://github.com/zzzzzzzzli999-droid/hap-auto-maker.git"
SUBDIR="mdye_view_6a661c92b731e5e5c64abe17"
INTERVAL="${HAP_SYNC_INTERVAL:-5}"

if [ ! -f "$PLUGIN_DIR/mdye.json" ]; then
  echo "找不到插件目录：$PLUGIN_DIR（里面应该有 mdye.json）"
  exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "首次运行，正在下载代码…"
  git clone -q --depth 20 -b "$BRANCH" "$REPO_URL" "$REPO_DIR" || { echo "下载失败，请检查网络后重试"; exit 1; }
fi
cd "$REPO_DIR" || exit 1

echo "自动同步已开启：每 ${INTERVAL} 秒检查一次新代码，有更新就覆盖到"
echo "  $PLUGIN_DIR"
echo "保持这个窗口开着；按 Control + C 停止。"

backed_up_for=""
while true; do
  if git fetch -q --depth 20 origin "$BRANCH" 2>/dev/null; then
    latest=$(git rev-parse "origin/$BRANCH")
    synced=$(cat "$PLUGIN_DIR/.synced-commit" 2>/dev/null)
    if [ "$latest" != "$synced" ]; then
      git reset -q --hard "origin/$BRANCH"
      # 每个新版本只备份一次本地原文件
      if [ "$backed_up_for" != "$latest" ]; then
        backup="$PLUGIN_DIR/.backup/$(date +%Y%m%d-%H%M%S)"
        mkdir -p "$backup" && cp -R "$PLUGIN_DIR/src" "$PLUGIN_DIR/.config" "$backup/" 2>/dev/null
        backed_up_for="$latest"
      fi
      mkdir -p "$PLUGIN_DIR/src" "$PLUGIN_DIR/.config"
      if ! cp -R "$SUBDIR/src/." "$PLUGIN_DIR/src/" || ! cp -R "$SUBDIR/.config/." "$PLUGIN_DIR/.config/"; then
        echo "覆盖失败，稍后重试"; sleep "$INTERVAL"; continue
      fi
      echo "$latest" > "$PLUGIN_DIR/.synced-commit"
      echo "[$(date +%H:%M:%S)] 已更新到 ${latest:0:7}：$(git log -1 --pretty=%s)"
      echo "           → 刷新明道页面（Command + Shift + R）即可测试"
    fi
  fi
  sleep "$INTERVAL"
done
