#!/usr/bin/env bash
#
# LocWarp-App — 以 root 啟動「已安裝的 LocWarp.app」(正式打包版)
#
# 為什麼要這支:iOS 17+ 建立 RSD tunnel(連 iPhone、模擬定位的底層)
# 需要 root 權限,而直接雙擊 .app 無法帶 sudo。此腳本替你:
#   1. 先用 sudo -v 取得授權(只需輸入一次密碼)
#   2. 以 root 在背景啟動 LocWarp.app 的主程式
#   3. 把輸出導到 /tmp/locwarp-app.log 方便排查
#
# 用法:於終端機執行  ./LocWarp-App.command   (雙擊也可,會跳終端輸密碼)
#
# 注意:純定位/Wi-Fi 操作多數情況不需 root,可先直接開 App 試;
#       只有要連 iOS 17+ 裝置才需要這支。

set -euo pipefail

APP="/Applications/LocWarp.app"
BIN="$APP/Contents/MacOS/LocWarp"
LOG="/tmp/locwarp-app.log"

echo
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   LocWarp — 以 root 啟動 (連 iPhone 用)  ║"
echo "  ╚══════════════════════════════════════════╝"
echo

# --- 1. 檢查 App 是否已安裝 ---
if [ ! -x "$BIN" ]; then
  echo "  [✗] 找不到可執行檔:$BIN"
  echo "      請確認已把 LocWarp.app 安裝到 /Applications。"
  read -r -p "  按 Enter 離開..." _
  exit 1
fi

# --- 2. 若已有同名程序在跑,先提醒 ---
if pgrep -f "$BIN" >/dev/null 2>&1; then
  echo "  [!] 偵測到 LocWarp 已在執行中。"
  echo "      若要重開,請先結束既有程序(可在「活動監視器」找 LocWarp)。"
  read -r -p "  仍要繼續啟動?(y/N) " ans
  case "$ans" in
    y|Y) ;;
    *) echo "  已取消。"; exit 0 ;;
  esac
fi

# --- 3. 取得 sudo 授權(只輸一次密碼)---
echo "  需要管理員權限以建立 iPhone 連線通道,請輸入密碼:"
sudo -v

# --- 4. 以 root 在背景啟動,輸出導到 log ---
sudo "$BIN" >"$LOG" 2>&1 &
PID=$!

echo
echo "  [✓] LocWarp 已在背景啟動 (PID $PID)"
echo "      記錄檔:$LOG"
echo
echo "  ── 查看即時記錄 ──"
echo "      tail -f $LOG"
echo
echo "  ── 查看程序 ──"
echo "      pgrep -fl -i locwarp                              # 列出所有 LocWarp 程序"
echo "      ps -axo user,pid,command | grep -i '[l]ocwarp'   # 看是否以 root 執行"
echo "      lsof -nP -iTCP -sTCP:LISTEN | grep -i locwarp     # 確認後端有綁 port"
echo
echo "  ── 結束程式 ──"
echo "      sudo kill $PID            # 結束本次啟動的主程序"
echo "      sudo pkill -i locwarp     # 連同後端/子程序一起溫和關閉"
echo "      sudo pkill -9 -i locwarp  # 關不掉時強制結束"
echo "      (或在「活動監視器」搜尋 locwarp 結束)"
echo
