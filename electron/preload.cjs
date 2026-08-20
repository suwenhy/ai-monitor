const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiMonitor", {
  getSnapshot: () => ipcRenderer.invoke("monitor:get-snapshot"),
  getSettings: () => ipcRenderer.invoke("monitor:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("monitor:save-settings", settings),
  resetSettings: () => ipcRenderer.invoke("monitor:reset-settings"),
  pickSettingsPath: (provider, key) => ipcRenderer.invoke("monitor:pick-settings-path", provider, key),
  openPath: (targetPath) => ipcRenderer.invoke("monitor:open-path", targetPath),
  openSession: (providerId, sessionId) => ipcRenderer.invoke("monitor:open-session", providerId, sessionId),
  getRuntime: () => ipcRenderer.invoke("monitor:get-runtime"),
  getMiniWindowState: () => ipcRenderer.invoke("monitor:get-mini-state"),
  toggleMiniWindow: () => ipcRenderer.invoke("monitor:toggle-mini"),
  closeMiniWindow: () => ipcRenderer.invoke("monitor:close-mini"),
  subscribe: (listener) => {
    const handler = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("monitor:snapshot", handler);
    return () => ipcRenderer.removeListener("monitor:snapshot", handler);
  },
  subscribeMiniVisibility: (listener) => {
    const handler = (_event, visible) => listener(visible);
    ipcRenderer.on("monitor:mini-visibility", handler);
    return () => ipcRenderer.removeListener("monitor:mini-visibility", handler);
  },
  subscribeMiniAlerts: (listener) => {
    const handler = (_event, alert) => listener(alert);
    ipcRenderer.on("monitor:mini-alert", handler);
    return () => ipcRenderer.removeListener("monitor:mini-alert", handler);
  },
});
