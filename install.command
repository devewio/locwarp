#!/usr/bin/env bash
#
# LocWarp — macOS 安裝器(把 build 出的 .dmg 裝進 /Applications)
#
# build-installer.command 只產出 .dmg(放在 frontend/release/),不會安裝。
# 此腳本接續那一步,替你:
#   1. 找到 frontend/release/ 裡最新的 LocWarp .dmg
#   2. 掛載 dmg
#   3. 把舊版(若有)移到垃圾桶、拷入新版到 /Applications
#   4. 解除隔離(未簽章版必要,否則 macOS 擋住不讓開)
#   5. 卸載 dmg
#
# 用法:雙擊執行,或於終端機 ./install.command
#
# 注意:未簽章版即使解除隔離,首次開仍可能要在「系統設定 → 隱私權與安全性」
#       按一次「仍要打開」。連 iOS 17+ 裝置需 root,請用 ./LocWarp-App.command。

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
RELEASE_DIR="$ROOT/frontend/release"
APP_DEST="/Applications/LocWarp.app"

echo
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   LocWarp — 安裝到 /Applications          ║"
echo "  ╚══════════════════════════════════════════╝"
echo

# --- 1. 找最新的 .dmg ---
if [ ! -d "$RELEASE_DIR" ]; then
  echo "  [✗] 找不到 $RELEASE_DIR"
  echo "      請先執行 ./build-installer.command 產出 .dmg。"
  read -r -p "  按 Enter 離開..." _
  exit 1
fi

# 依修改時間取最新的 LocWarp*.dmg
DMG="$(ls -t "$RELEASE_DIR"/LocWarp*.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ]; then
  echo "  [✗] $RELEASE_DIR 裡沒有 LocWarp*.dmg"
  echo "      請先執行 ./build-installer.command。"
  read -r -p "  按 Enter 離開..." _
  exit 1
fi
echo "  [✓] 使用安裝檔:$(basename "$DMG")"

# --- 2. 若 App 正在執行,先擋下 ---
if pgrep -f "$APP_DEST/Contents/MacOS/LocWarp" >/dev/null 2>&1; then
  echo "  [!] LocWarp 正在執行中,請先結束再安裝。"
  echo "      可執行  sudo pkill -i locwarp  或在活動監視器結束。"
  read -r -p "  按 Enter 離開..." _
  exit 1
fi

# --- 3. 掛載 dmg ---
echo "  [1/5] 掛載 dmg…"
MOUNT_POINT="$(hdiutil attach "$DMG" -nobrowse -noautoopen | grep -o '/Volumes/.*' | tail -1)"
if [ -z "${MOUNT_POINT:-}" ] || [ ! -d "$MOUNT_POINT/LocWarp.app" ]; then
  echo "  [✗] 掛載失敗或 dmg 內找不到 LocWarp.app"
  [ -n "${MOUNT_POINT:-}" ] && hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  exit 1
fi

# 不論後續成功與否,結束時都卸載 dmg
cleanup() { hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true; }
trap cleanup EXIT

# --- 4. 移除舊版(移到垃圾桶,不用 rm -rf)---
if [ -d "$APP_DEST" ]; then
  TRASHED="$HOME/.Trash/LocWarp.app.old-$$"
  echo "  [2/5] 將舊版移到垃圾桶…"
  mv "$APP_DEST" "$TRASHED"
else
  echo "  [2/5] 無舊版,略過。"
fi

# --- 5. 拷入新版 ---
echo "  [3/5] 拷入新版到 /Applications…"
ditto "$MOUNT_POINT/LocWarp.app" "$APP_DEST"

# --- 6. 解除隔離 ---
echo "  [4/5] 解除隔離 (quarantine)…"
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

# --- 7. 卸載(trap 也會做,這裡先做一次以便顯示驗證)---
echo "  [5/5] 卸載 dmg…"
cleanup
trap - EXIT

# --- 驗證 ---
VER="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP_DEST/Contents/Info.plist" 2>/dev/null || echo '?')"
echo
echo "  [✓] 安裝完成:LocWarp.app  v$VER  →  /Applications"
echo
echo "  ── 開啟方式 ──"
echo "      一般:直接從 Launchpad / 應用程式 開啟"
echo "      連 iPhone(iOS 17+,需 root):./LocWarp-App.command"
echo
