const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("storyClaw", {
  getProjects: () => ipcRenderer.invoke("projects:list"),
  getAssets: (novelName) => ipcRenderer.invoke("assets:list", novelName),
  getEpisodePreview: (novelName, episode) => ipcRenderer.invoke("episode:preview", novelName, episode),
  chooseSource: (kind) => ipcRenderer.invoke("source:choose", kind),
  inspectSource: (inputPath) => ipcRenderer.invoke("source:inspect", inputPath),
  createProject: (payload) => ipcRenderer.invoke("project:create", payload),
  startRun: (selection) => ipcRenderer.invoke("run:start", selection),
  stopRun: () => ipcRenderer.invoke("run:stop"),
  getActiveRun: () => ipcRenderer.invoke("run:active"),
  openWorkspace: (novelName) => ipcRenderer.invoke("workspace:open", novelName),
  openOutput: (novelName, episode) => ipcRenderer.invoke("output:open", novelName, episode),
  onRunLog: (callback) => subscribe("run:log", callback),
  onRunState: (callback) => subscribe("run:state", callback),
});
