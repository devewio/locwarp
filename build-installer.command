#!/usr/bin/env bash
#
# LocWarp — macOS 一鍵建置(對應 Windows 的 build-installer.bat)
#
# 產出未簽章、僅 arm64 的 LocWarp.dmg。流程:
#   [1/4] 編譯 macOS 原生定位 helper(swiftc)
#   [2/4] 用 backend/.venv 跑 PyInstaller 把後端凍成 binary(dist-py/)
#   [3/4] 建置前端(Vite)
#   [4/4] electron-builder 打包 .dmg(frontend/release/)
#
# 前置需求(裝一次):
#   - Xcode Command Line Tools(提供 swiftc):xcode-select --install
#   - Python 3.x:backend/.venv 由 LocWarp.command 首次執行時建立;
#     本腳本會自動把 pyinstaller 裝進該 venv。
#   - Node.js 18+:cd frontend && npm install
#
# 雙擊執行,或在終端機 ./build-installer.command。
# 未簽章版首次開啟需右鍵→開啟,或解除隔離(見 README)。

set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"
VENV="$BACKEND/.venv"
HELPER_DIR="$FRONTEND/native/locate-mac"

echo
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   LocWarp — macOS 打包 (arm64, 未簽章)    ║"
echo "  ╚══════════════════════════════════════════╝"
echo

# ── 前置檢查 ──
if ! command -v swiftc >/dev/null 2>&1; then
  echo "  [✗] 找不到 swiftc,請先安裝 Xcode Command Line Tools:"
  echo "      xcode-select --install"
  exit 1
fi
if [ ! -x "$VENV/bin/python" ]; then
  echo "  [✗] 找不到 backend/.venv,請先執行一次 ./LocWarp.command 建立虛擬環境。"
  exit 1
fi
PY="$VENV/bin/python"
if ! command -v npm >/dev/null 2>&1; then
  echo "  [✗] 找不到 npm,請先安裝 Node.js 18+。"
  exit 1
fi

# ── [1/4] 編譯 Swift 定位 helper ──
echo "============================================================"
echo " [1/4] 編譯 macOS 定位 helper (swiftc)"
echo "============================================================"
swiftc -O -o "$HELPER_DIR/locate-mac" "$HELPER_DIR/LocateMac.swift"
echo "  [✓] $HELPER_DIR/locate-mac"
echo

# ── [2/4] PyInstaller 後端 ──
echo "============================================================"
echo " [2/4] PyInstaller 打包後端 (dist-py/)"
echo "============================================================"
# 確保 pyinstaller 在 venv 裡
if ! "$PY" -c "import PyInstaller" >/dev/null 2>&1; then
  echo "  [i] venv 內未安裝 PyInstaller,正在安裝…"
  "$PY" -m pip install --quiet pyinstaller
fi
cd "$BACKEND"
"$PY" -m PyInstaller locwarp-backend.spec --noconfirm \
  --distpath "$ROOT/dist-py" --workpath "$ROOT/build-py/backend"
echo "  [✓] $ROOT/dist-py/locwarp-backend/"
echo

# ── [3/4] 前端 Vite build ──
echo "============================================================"
echo " [3/4] 建置前端 (Vite)"
echo "============================================================"
cd "$FRONTEND"
npm run build
echo

# ── [4/4] electron-builder 打包 dmg ──
echo "============================================================"
echo " [4/4] 打包 .dmg (electron-builder)"
echo "============================================================"
npx electron-builder --mac dmg --arm64
echo

echo "============================================================"
echo " 完成!產物在 frontend/release/"
echo "============================================================"
ls -1 "$FRONTEND/release/"*.dmg 2>/dev/null || echo "(找不到 .dmg,請往上檢查錯誤訊息)"
echo
echo "  ⚠️ 未簽章版首次開啟:在 Finder 對 LocWarp.app 右鍵 → 開啟,"
echo "     或執行  xattr -dr com.apple.quarantine /Applications/LocWarp.app"
echo "  ⚠️ 連 iOS 17+ 裝置需 root:從終端機 sudo 開啟 app,或見 README。"
