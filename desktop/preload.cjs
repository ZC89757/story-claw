const { contextBridge, ipcRenderer, webUtils } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("storyClaw", {
  getProjects: () => ipcRenderer.invoke("projects:list"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (payload) => ipcRenderer.invoke("settings:save", payload),
  activateSettingsTemplate: (templateName) => ipcRenderer.invoke("settings:activate", templateName),
  getAssets: (novelName) => ipcRenderer.invoke("assets:list", novelName),
  getEpisodePreview: (novelName, episode) => ipcRenderer.invoke("episode:preview", novelName, episode),
  chooseSource: (kind) => ipcRenderer.invoke("source:choose", kind),
  inspectSource: (inputPath) => ipcRenderer.invoke("source:inspect", inputPath),
  getFilePath: (file) => webUtils.getPathForFile(file),
  createProject: (payload) => ipcRenderer.invoke("project:create", payload),
  getProjectConversation: (novelName) => ipcRenderer.invoke("project:conversation:get", novelName),
  updateProjectConversation: (novelName, session) => ipcRenderer.invoke("project:conversation", novelName, session),
  startRun: (selection) => ipcRenderer.invoke("run:start", selection),
  stopRun: () => ipcRenderer.invoke("run:stop"),
  getActiveRun: () => ipcRenderer.invoke("run:active"),
  getVisualPreset: (novelName, episode) => ipcRenderer.invoke("visual-preset:get", novelName, episode),
  approveVisualPreset: (novelName, episode) => ipcRenderer.invoke("visual-preset:approve", novelName, episode),
  sendAgentMessage: (payload) => ipcRenderer.invoke("agent:message", payload),
  sendAgentChoice: (payload) => ipcRenderer.invoke("agent:choice", payload),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),
  openWorkspace: (novelName) => ipcRenderer.invoke("workspace:open", novelName),
  openOutput: (novelName, episode) => ipcRenderer.invoke("output:open", novelName, episode),
  onRunLog: (callback) => subscribe("run:log", callback),
  onRunState: (callback) => subscribe("run:state", callback),
  onRunPhase: (callback) => subscribe("run:phase", callback),
  onRunReview: (callback) => subscribe("run:review", callback),
  onRunReviewApproved: (callback) => subscribe("run:review-approved", callback),
  onAgentEvent: (callback) => subscribe("agent:event", callback),
});
