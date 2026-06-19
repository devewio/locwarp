const { app, BrowserWindow, Menu, shell, ipcMain } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')
const os = require('os')
const fs = require('fs')

// Directory for user preferences. We deliberately DON'T use
// app.getPath('userData') here: on macOS the app must be launched with
// sudo to connect iOS 17+ devices (RSD tunnel needs root), and under sudo
// Electron resolves userData to root's home (/var/root/...), so a setting
// saved while running elevated would be invisible to a normal double-click
// launch (and vice-versa). Anchoring prefs to the *real* user's
// ~/.locwarp keeps a single, consistent settings location across both
// launch modes (it's also where the backend writes its logs).
function prefsDir() {
  // Under sudo, SUDO_USER is the original user; resolve their home rather
  // than root's. Fall back to os.homedir() when not elevated.
  const sudoUser = process.env.SUDO_USER
  let home = os.homedir()
  if (sudoUser && (home === '/var/root' || home === '/root')) {
    home = process.platform === 'darwin' ? `/Users/${sudoUser}` : `/home/${sudoUser}`
  }
  return path.join(home, '.locwarp')
}

// Render-mode preference (Issue #24). Win 10 stays on software rendering
// by default — v0.2.121/125 hit a Chromium 124 GPU-sandbox crash on
// 22H2 — but users whose hardware works fine can opt in via Settings
// and restart. Win 11 defaults to hardware acceleration as usual.
const RENDER_MODE_FILE = path.join(prefsDir(), 'render-mode.json')

function readRenderModePref() {
  try {
    const raw = fs.readFileSync(RENDER_MODE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && (parsed.mode === 'hardware' || parsed.mode === 'software')) {
      return parsed.mode
    }
  } catch { /* missing or corrupt — fall through to default */ }
  return null
}

function writeRenderModePref(mode) {
  try {
    fs.mkdirSync(path.dirname(RENDER_MODE_FILE), { recursive: true })
    fs.writeFileSync(RENDER_MODE_FILE, JSON.stringify({ mode }, null, 2), 'utf8')
  } catch (e) {
    console.error('[render-mode] failed to save pref:', e && e.message)
  }
}

// Locate-PC source preference. Lets the user choose how "locate this
// computer" resolves a position:
//   'auto'   — try the native OS locator first (CoreLocation / Windows
//              Location), fall back to IP geolocation if it fails. Default.
//   'native' — native only; surface the denial instead of falling back
//              (for users with a signed build / who want precise only).
//   'ip'     — skip the native locator entirely and use IP geolocation.
//              Avoids the "permission denied" prompt on unsigned macOS
//              builds where CoreLocation can't be authorized.
const LOCATE_SOURCE_FILE = path.join(prefsDir(), 'locate-source.json')

function readLocateSourcePref() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCATE_SOURCE_FILE, 'utf8'))
    if (parsed && ['auto', 'native', 'ip'].includes(parsed.source)) {
      return parsed.source
    }
  } catch { /* missing or corrupt — fall through to default */ }
  return null
}

function writeLocateSourcePref(source) {
  try {
    fs.mkdirSync(path.dirname(LOCATE_SOURCE_FILE), { recursive: true })
    fs.writeFileSync(LOCATE_SOURCE_FILE, JSON.stringify({ source }, null, 2), 'utf8')
  } catch (e) {
    console.error('[locate-source] failed to save pref:', e && e.message)
  }
}

if (process.platform === 'win32') {
  const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
  const isWin10 = winBuild > 0 && winBuild < 22000
  const saved = readRenderModePref()
  // Effective mode: saved pref wins; otherwise Win 10 → software, Win 11 → hardware.
  const mode = saved || (isWin10 ? 'software' : 'hardware')
  if (mode === 'software') {
    app.disableHardwareAcceleration()
    app.commandLine.appendSwitch('no-sandbox')
    app.commandLine.appendSwitch('in-process-gpu')
  }
}

// Locate-PC over IPC: shells out to PowerShell + System.Device.Location
// (the Windows Location API). This taps Windows' built-in Wi-Fi
// positioning + GPS without needing a Google API key (which Electron's
// navigator.geolocation requires) or any third-party HTTP service.
// Accuracy in urban areas is typically 30-100m; rural ~500m.
const LOCATE_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Device
  $watcher = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
  $watcher.Start()
  $deadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $deadline) {
    if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
    if ($watcher.Status -eq 'Ready' -and -not $watcher.Position.Location.IsUnknown) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($watcher.Permission -eq 'Denied') { Write-Output 'DENIED'; exit 0 }
  $loc = $watcher.Position.Location
  if ($loc.IsUnknown) { Write-Output ('NODATA,status=' + $watcher.Status); exit 0 }
  Write-Output ('OK,' + $loc.Latitude + ',' + $loc.Longitude + ',' + $loc.HorizontalAccuracy)
  $watcher.Stop()
} catch {
  Write-Output ('ERROR,' + $_.Exception.Message)
}
`

// Run an HTTPS GET from the Electron main process (no renderer CORS,
// no Content-Security-Policy block) and return the parsed JSON. Used
// by the IP-geolocation fallback chain inside the locate-pc handler.
const httpsGetJson = (url) => {
  return new Promise((resolve) => {
    const https = require('https')
    const req = https.get(url, { headers: { 'User-Agent': 'LocWarp-Electron' }, timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return resolve(null)
      }
      let chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { resolve(null) }
      })
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { try { req.destroy() } catch {} ; resolve(null) })
  })
}

const ipFallback = async () => {
  // ipwho.is — no key, no signup, HTTPS, returns latitude/longitude in JSON.
  const a = await httpsGetJson('https://ipwho.is/')
  if (a && typeof a.latitude === 'number' && typeof a.longitude === 'number') {
    return { ok: true, lat: a.latitude, lng: a.longitude, accuracy: 5000, via: 'ipwho.is' }
  }
  // ipapi.co — backup, also no key.
  const b = await httpsGetJson('https://ipapi.co/json/')
  if (b && b.latitude != null && b.longitude != null) {
    const lat = parseFloat(b.latitude); const lng = parseFloat(b.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'ipapi.co' }
    }
  }
  // freeipapi.com — last resort.
  const c = await httpsGetJson('https://freeipapi.com/api/json/')
  if (c && c.latitude != null && c.longitude != null) {
    const lat = parseFloat(c.latitude); const lng = parseFloat(c.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { ok: true, lat, lng, accuracy: 5000, via: 'freeipapi.com' }
    }
  }
  return null
}

const tryWindowsLocation = () => {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', LOCATE_PS_SCRIPT],
      { windowsHide: true },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => console.error('[locate-pc] stderr:', d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, code: 'SPAWN_FAILED', message: e.message }))
    child.on('exit', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('OK,')) {
        const parts = trimmed.split(',')
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        const acc = parseFloat(parts[3])
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return finish({ ok: true, lat, lng, accuracy: Number.isFinite(acc) ? acc : 100 })
        }
      }
      if (trimmed === 'DENIED') return finish({ ok: false, code: 'DENIED', message: 'Windows Location service is off or app access denied' })
      if (trimmed.startsWith('NODATA')) return finish({ ok: false, code: 'NODATA', message: trimmed.slice(0, 200) })
      if (trimmed.startsWith('ERROR,')) return finish({ ok: false, code: 'ERROR', message: trimmed.slice(6, 200) })
      finish({ ok: false, code: 'UNKNOWN', message: trimmed.slice(0, 200) || 'no PowerShell output' })
    })
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', message: 'PowerShell timed out after 18s' })
    }, 18000)
  })
}

// Resolve the macOS CoreLocation helper binary. In dev it lives next to
// its source under frontend/native/locate-mac/; in a packaged build it's
// bundled via extraResources under Contents/Resources/locate-mac/.
function resolveMacLocateHelper() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'locate-mac', 'locate-mac')
  }
  return path.join(__dirname, '..', 'native', 'locate-mac', 'locate-mac')
}

// macOS counterpart of tryWindowsLocation(). Spawns the Swift helper,
// which prints the SAME OK/DENIED/NODATA/ERROR line format, so the parse
// logic mirrors the Windows path exactly.
const tryMacLocation = () => {
  return new Promise((resolve) => {
    let settled = false
    const finish = (payload) => { if (!settled) { settled = true; resolve(payload) } }
    const helper = resolveMacLocateHelper()
    if (!fs.existsSync(helper)) {
      return finish({ ok: false, code: 'NO_HELPER', message: `locate-mac helper not found at ${helper}` })
    }
    const child = spawn(helper, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString('utf8') })
    child.stderr.on('data', (d) => console.error('[locate-pc] mac stderr:', d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, code: 'SPAWN_FAILED', message: e.message }))
    child.on('exit', () => {
      const trimmed = out.trim()
      if (trimmed.startsWith('OK,')) {
        const parts = trimmed.split(',')
        const lat = parseFloat(parts[1])
        const lng = parseFloat(parts[2])
        const acc = parseFloat(parts[3])
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          return finish({ ok: true, lat, lng, accuracy: Number.isFinite(acc) ? acc : 100 })
        }
      }
      if (trimmed === 'DENIED') return finish({ ok: false, code: 'DENIED', message: 'macOS Location Services is off or app access denied' })
      if (trimmed.startsWith('NODATA')) return finish({ ok: false, code: 'NODATA', message: trimmed.slice(0, 200) })
      if (trimmed.startsWith('ERROR,')) return finish({ ok: false, code: 'ERROR', message: trimmed.slice(6, 200) })
      finish({ ok: false, code: 'UNKNOWN', message: trimmed.slice(0, 200) || 'no helper output' })
    })
    setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, code: 'TIMEOUT', message: 'locate-mac helper timed out after 18s' })
    }, 18000)
  })
}

ipcMain.handle('get-render-mode', () => {
  // Surface the current saved mode + whether the OS is the one we
  // originally bypassed (Win 10), so the Settings panel can decide
  // whether to highlight this toggle as relevant.
  let isWin10 = false
  if (process.platform === 'win32') {
    const winBuild = parseInt((os.release() || '0.0.0').split('.')[2] || '0', 10)
    isWin10 = winBuild > 0 && winBuild < 22000
  }
  const saved = readRenderModePref()
  // If no pref exists and we're not on Win 10, the effective mode is
  // hardware (current default for Win 11). On Win 10 with no pref, we
  // already prompted at startup, so this branch shouldn't normally hit.
  const effective = saved || (isWin10 ? 'software' : 'hardware')
  return { mode: effective, saved, isWin10 }
})

ipcMain.handle('set-render-mode', (_e, mode) => {
  if (mode !== 'hardware' && mode !== 'software') return { ok: false }
  writeRenderModePref(mode)
  return { ok: true }
})

ipcMain.handle('relaunch-app', () => {
  app.relaunch()
  app.exit(0)
})

ipcMain.handle('locate-pc', async () => {
  // Resolve the user's preferred source. Default 'auto' = native-then-IP.
  const source = readLocateSourcePref() || 'auto'

  // 'ip' — skip the native locator entirely. Useful on unsigned macOS
  // builds where CoreLocation can't be authorized (avoids the misleading
  // "permission denied" prompt) and anywhere the user just wants a quick
  // coarse fix.
  if (source === 'ip') {
    const ip = await ipFallback()
    if (ip) return ip
    return { ok: false, code: 'ALL_FAILED', message: 'IP geolocation fallback: all 3 services unreachable' }
  }

  // 'native' vs 'auto' only differ in whether a native failure falls back
  // to IP. In 'native' the denial/failure is surfaced as-is.
  const allowIpFallback = source !== 'native'

  // High-accuracy native first layer:
  //   * Windows → Windows Location API via PowerShell
  //   * macOS   → CoreLocation via the bundled Swift helper
  //   * Linux   → no native path
  if (process.platform === 'win32') {
    const win = await tryWindowsLocation()
    if (win.ok) return { ...win, via: 'windows' }
    if (win.code === 'DENIED') return win
    if (allowIpFallback) {
      const ip = await ipFallback()
      if (ip) return ip
    }
    return {
      ok: false,
      code: 'ALL_FAILED',
      message: `Windows Location: ${win.code}${win.message ? ' (' + win.message + ')' : ''}${allowIpFallback ? ' | IP fallback: all 3 services unreachable' : ''}`,
    }
  }

  if (process.platform === 'darwin') {
    const mac = await tryMacLocation()
    if (mac.ok) return { ...mac, via: 'macos' }
    // Permission denied is terminal regardless of mode — IP fallback would
    // hide the fact that the user needs to grant Location access.
    if (mac.code === 'DENIED') return mac
    if (allowIpFallback) {
      const ip = await ipFallback()
      if (ip) return ip
    }
    return {
      ok: false,
      code: 'ALL_FAILED',
      message: `macOS Location: ${mac.code}${mac.message ? ' (' + mac.message + ')' : ''}${allowIpFallback ? ' | IP fallback: all 3 services unreachable' : ''}`,
    }
  }

  // Linux / other: no native path. 'native' mode has nothing to try, so
  // still use IP (the only option) rather than failing outright.
  const ip = await ipFallback()
  if (ip) return ip
  return {
    ok: false,
    code: 'ALL_FAILED',
    message: 'IP geolocation fallback: all 3 services unreachable',
  }
})

ipcMain.handle('get-locate-source', () => {
  return { source: readLocateSourcePref() || 'auto' }
})

ipcMain.handle('set-locate-source', (_e, source) => {
  if (!['auto', 'native', 'ip'].includes(source)) return { ok: false }
  writeLocateSourcePref(source)
  return { ok: true }
})

// LocWarp has its own in-window controls, so the native menubar mostly adds
// noise. On Windows we strip it entirely. On macOS, however, the standard
// Cmd+C/V/X/A clipboard shortcuts are bound to the Edit menu's roles — with
// no menu those shortcuts stop working in our text inputs (e.g. Cmd+V won't
// paste). So on macOS we install a minimal menu that keeps the app + Edit
// menus (Electron's built-in roles wire up the localized clipboard items and
// their accelerators for us) and drops the rest.
function installAppMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      // 介面縮放:沿用 Electron 內建 role,自動綁定 Cmd +/-/0
      // 並提供本地化選單文字。
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
installAppMenu()

let mainWindow
let backendProc = null

function resolveBackendExe() {
  // In a packaged build, extraResources places the PyInstaller bundle under
  // process.resourcesPath/backend/. The executable name is platform-specific
  // (Windows appends .exe; macOS/Linux don't). In dev we don't spawn — the
  // developer runs `python main.py` manually.
  if (app.isPackaged) {
    const exeName = process.platform === 'win32' ? 'locwarp-backend.exe' : 'locwarp-backend'
    return path.join(process.resourcesPath, 'backend', exeName)
  }
  return null
}

function startBackend() {
  const exe = resolveBackendExe()
  if (!exe) return
  console.log('[electron] spawning backend:', exe)
  backendProc = spawn(exe, [], {
    cwd: path.dirname(exe),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  backendProc.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`))
  backendProc.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`))
  backendProc.on('exit', (code) => {
    console.log('[electron] backend exited with code', code)
    backendProc = null
  })
}

function stopBackend() {
  if (!backendProc) return
  try { backendProc.kill() } catch {}
  backendProc = null
}

function waitForBackend(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get('http://127.0.0.1:8777/docs', (res) => {
        res.destroy()
        resolve()
      })
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) return reject(new Error('backend timeout'))
        setTimeout(tick, 500)
      })
    }
    tick()
  })
}

async function createWindow() {
  // OSM tile policy (https://operations.osmfoundation.org/policies/tiles/)
  // requires an identifying User-Agent; Electron's default Chrome UA is
  // blocked with HTTP 418. Rewrite the UA on requests to the OSM tile
  // endpoints so we can use the 'Standard' (Mapnik) style for free.
  try {
    const { session } = require('electron')
    const OSM_HOSTS = [
      'tile.openstreetmap.org',
      'a.tile.openstreetmap.org',
      'b.tile.openstreetmap.org',
      'c.tile.openstreetmap.org',
      'tile.openstreetmap.fr',
      'a.tile.openstreetmap.fr',
      'b.tile.openstreetmap.fr',
      'c.tile.openstreetmap.fr',
    ]
    session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
      try {
        const u = new URL(details.url)
        if (OSM_HOSTS.includes(u.hostname)) {
          details.requestHeaders['User-Agent'] =
            'LocWarp/0.1.49 (+https://github.com/keezxc1223/locwarp)'
          details.requestHeaders['Referer'] = 'https://github.com/keezxc1223/locwarp'
        }
      } catch {}
      cb({ requestHeaders: details.requestHeaders })
    })
  } catch (e) { console.error('[electron] UA hook failed:', e) }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'LocWarp',
    // Match the app's dark theme so the initial frame isn't white while
    // the renderer attaches — previously caused a jarring white flash.
    backgroundColor: '#0f1117',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // Default Chromium blocks AudioContext output until a user gesture
      // happens on the page; that breaks the route-completion alert
      // sound when a long loop finishes while the user is away from the
      // window. LocWarp is a desktop tool (not a random webpage), so
      // disable the gesture gate entirely.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  // Show the window once the first frame is painted. Combined with
  // backgroundColor above, this eliminates the blank/white boot state.
  mainWindow.once('ready-to-show', () => { mainWindow.show() })

  // Open target="_blank" / external links in the user's default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })

  const isDev = process.argv.includes('--dev') || !app.isPackaged
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    // Spawn the backend in parallel and load the UI immediately. The
    // renderer already has fetch-with-retry so it rides out the backend
    // startup race — no need to block loadFile on waitForBackend() and
    // stare at a blank window for seconds.
    startBackend()
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', stopBackend)
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
