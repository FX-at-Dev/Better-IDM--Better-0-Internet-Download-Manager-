import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AddRequest, LanesApi } from "../shared/types.js";

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const fn = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

// Links sent before the UI subscribed (e.g. the extension woke Lanes from the tray) wait here.
const pendingAdds: AddRequest[] = [];
let addListener: ((r: AddRequest) => void) | null = null;
ipcRenderer.on("focus-add", (_e, r: AddRequest) => (addListener ? addListener(r) : pendingAdds.push(r)));

const api: LanesApi = {
  getState: () => ipcRenderer.invoke("state"),
  onState: (cb) => listen("state", cb),
  onClipboard: (cb) => listen("clipboard", cb),
  onFocusAdd: (cb) => {
    addListener = cb;
    for (const r of pendingAdds.splice(0)) cb(r);
    return () => {
      if (addListener === cb) addListener = null;
    };
  },
  inspect: (url, headers) => ipcRenderer.invoke("inspect", url, headers),
  add: (o) => ipcRenderer.invoke("add", o),
  addTorrentFile: (p, o) => ipcRenderer.invoke("addTorrentFile", p, o),
  action: (ids, a, arg) => ipcRenderer.invoke("action", ids, a, arg),
  moveToQueue: (ids, q) => ipcRenderer.invoke("moveToQueue", ids, q),
  setChecksum: (id, algo, e) => ipcRenderer.invoke("setChecksum", id, algo, e),
  setSettings: (p) => ipcRenderer.invoke("setSettings", p),
  resetSettings: () => ipcRenderer.invoke("resetSettings"),
  addNetwork: (n, a) => ipcRenderer.invoke("addNetwork", n, a),
  removeNetwork: (id) => ipcRenderer.invoke("removeNetwork", id),
  updateNetwork: (id, p) => ipcRenderer.invoke("updateNetwork", id, p),
  pauseAll: () => ipcRenderer.invoke("pauseAll"),
  resumeAll: () => ipcRenderer.invoke("resumeAll"),
  clearCompleted: () => ipcRenderer.invoke("clearCompleted"),
  pickFolder: (c) => ipcRenderer.invoke("pickFolder", c),
  pickTorrent: () => ipcRenderer.invoke("pickTorrent"),
  installTool: (t) => ipcRenderer.invoke("installTool", t),
  openExtensionFolder: (b) => ipcRenderer.invoke("openExtensionFolder", b),
  openSetupPage: () => ipcRenderer.invoke("openSetupPage"),
  checkForUpdates: () => ipcRenderer.invoke("update", "check"),
  downloadUpdate: () => ipcRenderer.invoke("update", "download"),
  installUpdate: () => ipcRenderer.invoke("update", "install"),
  cancelShutdown: () => ipcRenderer.invoke("cancelShutdown"),
  openPath: (p) => ipcRenderer.invoke("openPath", p),
  newToken: () => ipcRenderer.invoke("newToken"),
  windowControl: (cmd) => ipcRenderer.send("window", cmd),
  pathForFile: (f) => webUtils.getPathForFile(f),
};

contextBridge.exposeInMainWorld("lanes", api);
