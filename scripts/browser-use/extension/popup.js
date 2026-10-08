import { APP_NAME } from "./config.js";
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];
document.querySelector("#app-name").textContent = APP_NAME;
let busy = false;
function render(result) {
  document.querySelector("#heading").textContent = result.handoff
    ? "Waiting for you"
    : result.connected
      ? "Agent is working"
      : result.appConnected
        ? `${APP_NAME} connected`
        : `Open ${APP_NAME} to connect`;
  document.querySelector("#dot").className =
    `dot ${result.handoff ? "waiting" : result.appConnected ? "ready" : ""}`;
  status.textContent =
    result.error ??
    result.connectionError ??
    (result.handoff
      ? "Complete the waiting step, then allow your Agent to continue."
      : result.shareNextTab
        ? "This page is shared with the next task."
        : result.connected
          ? `${result.tabs} task tab${result.tabs === 1 ? "" : "s"} under Agent control.`
          : result.appConnected
            ? "Ready. New tasks open a dedicated tab group."
            : `Connection starts automatically. Check ${APP_NAME} Settings > Browser control if it stays offline.`);
  document.querySelector("#handoff").hidden = !result.handoff;
  document.querySelector(".actions").hidden = !!result.handoff;
  document.querySelector("#disconnect").disabled = busy || !result.connected;
  document.querySelector("#connect").disabled = busy || !!result.connected || !!result.handoff;
  document.querySelector("#reconnect").hidden = !!result.appConnected;
}
async function request(message) {
  if (busy) return;
  busy = true;
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await chrome.runtime.sendMessage(message);
    busy = false;
    buttons.forEach((button) => {
      button.disabled = false;
    });
    render(result);
  } catch (error) {
    busy = false;
    buttons.forEach((button) => {
      button.disabled = false;
    });
    status.textContent = error.message;
  }
}
document.querySelector("#connect").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await request({ action: "shareNextTab", tabId: tab?.id });
});
document.querySelector("#disconnect").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await request({ action: "disconnect", tabId: tab?.id });
});
for (const [id, action] of [
  ["reconnect", "reconnect"],
  ["discard-handoff", "discardHandoff"],
  ["allow-resume", "allowResume"],
])
  document.querySelector(`#${id}`).addEventListener("click", () => {
    void request({ action });
  });
await request({ action: "status" });
setInterval(() => {
  void request({ action: "status" });
}, 2000);
