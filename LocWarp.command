#!/usr/bin/env bash
#
# LocWarp — macOS dev 啟動器(對應 Windows 的 LocWarp.bat)
#
# 雙擊此檔即可在 macOS 上以 dev 模式啟動 LocWarp:
#   1. 建立 / 重用 backend/.venv 虛擬環境(避開 Homebrew Python 的
#      externally-managed-environment 限制,不污染系統 Python)
#   2. 安裝後端依賴到 venv
#   3. 用 venv 的 python 執行 start.py(它會再啟動後端 + 前端 Vite)
#
# 注意:iOS 17+ 建立 RSD tunnel 需要 root 權限。若要連 iOS 17+ 裝置,
#       請改用終端機執行  sudo ./LocWarp.command
#       (Wi-Fi tunnel / 純定位操作在多數情況不需 root,可先直接雙擊試。)

set -euo pipefail

# 切換到此腳本所在目錄,確保相對路徑正確
cd "$(dirname "$0")"

ROOT="$(pwd)"
BACKEND="$ROOT/backend"
VENV="$BACKEND/.venv"

echo
echo "  ╔══════════════════════════════════════════╗"
echo "  ║   LocWarp — iOS 虛擬定位模擬器 (macOS)   ║"
echo "  ╚══════════════════════════════════════════╝"
echo

# --- 1. 找到可用的 python ---
if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "  [✗] 找不到 python3,請先安裝:https://www.python.org/downloads/"
  echo "      或  brew install python"
  read -r -p "  按 Enter 離開..." _
  exit 1
fi
echo "  [✓] 使用 $($PY --version)"

# --- 2. 建立 / 重用 venv ---
if [ ! -d "$VENV" ]; then
  echo "  [1/2] 建立後端虛擬環境 (backend/.venv)..."
  "$PY" -m venv "$VENV"
fi

# venv 內的 python(start.py 會用 sys.executable 沿用它)
VENV_PY="$VENV/bin/python"

# --- 3. 安裝後端依賴(只在缺套件時跑,加速重啟)---
if ! "$VENV_PY" -c "import fastapi, uvicorn, pymobiledevice3" >/dev/null 2>&1; then
  echo "  [2/2] 安裝後端依賴到 venv..."
  "$VENV_PY" -m pip install --upgrade pip -q
  "$VENV_PY" -m pip install -r "$BACKEND/requirements.txt" -q
  echo "        完成 ✓"
else
  echo "  [2/2] 後端依賴已就緒 ✓"
fi

echo
echo "  啟動中…(前端依賴若缺會由 start.py 自動 npm install)"
echo

# 用 venv 的 python 跑 start.py;start.py 內以 sys.executable 啟動
# 後端,因此後端會在這個 venv 下執行,依賴齊全。
exec "$VENV_PY" start.py
