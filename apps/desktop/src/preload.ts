import { contextBridge, ipcRenderer } from "electron";

// This bridge is loaded only into the packaged phone screen, never the web app.
contextBridge.exposeInMainWorld("hub", {
  status: () => ipcRenderer.invoke("hub:status"),
  share: () => ipcRenderer.invoke("hub:share"),
  lan: () => ipcRenderer.invoke("hub:lan"),
  pair: () => ipcRenderer.invoke("hub:pair"),
  openApp: () => ipcRenderer.invoke("hub:open-app"),
});
