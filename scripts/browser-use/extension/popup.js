import { APP_NAME } from "./config.js";
const status = document.querySelector("#status");
const buttons = [...document.querySelectorAll("button")];
document.querySelector("#app-name").textContent = APP_NAME;
let busy = false;
let pendingRequest;
const approvalWindow = location.hash === "#website-access";
document.body.classList.toggle("approval-window", approvalWindow);
function render(result) {
  pendingRequest = result.websiteAccess?.pending[0];
  document.querySelector("#website-request").hidden = !pendingRequest;
  document.querySelector("#website-host").textContent = pendingRequest?.host ?? "";
  document.querySelector("#website-policy").textContent = result.websiteAccess?.allowAll
    ? "All websites are allowed, except blocked sites."
    : "New websites ask before your Agent uses them. Allow once lasts until this task ends.";
  const list = document.querySelector("#website-list");
  list.replaceChildren();
  for (const [host, decision] of Object.entries(result.websiteAccess?.sites ?? {}).sort()) {
    const row = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = `${host} · ${decision === "allow" ? "Allowed" : "Blocked"}`;
    const remove = document.createElement("button");
    remove.className = "text-button";
    remove.textContent = "Remove";
    remove.disabled = busy;
    remove.addEventListener("click", () => {
      void request({ action: "revokeWebsite", host });
    });
    row.append(label, remove);
    list.append(row);
  }
  document.querySelector("#heading").textContent = pendingRequest
    ? "Website access requested"
    : result.handoff
      ? result.handoffReady
        ? "Ready to continue"
        : "Waiting for you"
      : result.connected
        ? "Agent is working"
        : result.appConnected
          ? `${APP_NAME} connected`
          : `Open ${APP_NAME} to connect`;
  document.querySelector("#dot").className =
    `dot ${pendingRequest || result.handoff ? "waiting" : result.appConnected ? "ready" : ""}`;
  status.textContent =
    (pendingRequest
      ? "Waiting for website authorization. Your Agent cannot use this website yet."
      : undefined) ??
    result.error ??
    result.connectionError ??
    (result.handoff
      ? result.handoffReady
        ? "Control returned. Your Agent can resume from the original Atlas chat."
        : "Complete the waiting step, then send continue in the original Atlas chat."
      : result.shareNextTab
        ? "This page is shared with the next task."
        : result.connected
          ? `${result.tabs} task tab${result.tabs === 1 ? "" : "s"} under Agent control.`
          : result.appConnected
            ? "Ready. New tasks open a dedicated tab group."
            : `Connection starts automatically. Check ${APP_NAME} Settings > Browser control if it stays offline.`);
  document.querySelector("#handoff").hidden = !result.handoff;
  document.querySelector("section.actions").hidden =
    !!result.handoff || approvalWindow || !!pendingRequest;
  document.querySelector("#disconnect").disabled = busy || !result.connected;
  document.querySelector("#connect").disabled = busy || !!result.connected || !!result.handoff;
  document.querySelector("#reconnect").hidden = !!result.appConnected;
}
for (const button of document.querySelectorAll("[data-choice]"))
  button.addEventListener("click", () => {
    if (pendingRequest)
      void request({
        action: "websiteDecision",
        id: pendingRequest.id,
        choice: button.dataset.choice,
      });
  });
document.querySelector("#reset-websites").addEventListener("click", () => {
  void request({ action: "resetWebsiteAccess" });
});
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
])
  document.querySelector(`#${id}`).addEventListener("click", () => {
    void request({ action });
  });
await request({ action: "status" });
setInterval(() => {
  void request({ action: "status" });
}, 2000);
