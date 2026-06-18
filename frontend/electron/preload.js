const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  locatePc: () => ipcRenderer.invoke('locate-pc'),
  getLocateSource: () => ipcRenderer.invoke('get-locate-source'),
  setLocateSource: (source) => ipcRenderer.invoke('set-locate-source', source),
  getRenderMode: () => ipcRenderer.invoke('get-render-mode'),
  setRenderMode: (mode) => ipcRenderer.invoke('set-render-mode', mode),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
})
