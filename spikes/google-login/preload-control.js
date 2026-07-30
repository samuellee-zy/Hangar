const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  config: () => ipcRenderer.invoke('config'),
  load: (strategyId, serviceId) => ipcRenderer.invoke('load', { strategyId, serviceId }),
  reload: () => ipcRenderer.invoke('reload'),
  devtools: () => ipcRenderer.invoke('devtools'),
  loginWindow: () => ipcRenderer.invoke('login-window'),
  probe: () => ipcRenderer.invoke('probe'),
  verdict: (verdict) => ipcRenderer.invoke('verdict', { verdict }),
  clearSession: () => ipcRenderer.invoke('clear-session'),
  writeMd: () => ipcRenderer.invoke('write-md'),
  onStatus: (fn) => ipcRenderer.on('status', (_e, s) => fn(s)),
});
