import { ExtensionController } from "./controller.js";
import { NativeConnection } from "./native-connection.js";
const controller = new ExtensionController(chrome);
const native = new NativeConnection(chrome, controller);
const ready = controller
  .recover()
  .then(() => native.restore())
  .catch((error) => {
    controller.lastError = error.message;
  });
chrome.runtime.onStartup.addListener(() => {
  void ready;
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return;
  void ready
    .then(async () => {
      if (message.action === "setConsent") await native.setConsent(message.accepted);
      else if (message.action === "connect") {
        native.requireConsent();
        await controller.connect(message.endpoint, message.tabId);
      } else if (message.action === "reconnect") await native.reconnect();
      else if (message.action === "shareNextTab") await native.share(message.tabId);
      else if (message.action === "discardHandoff") await controller.discardHandoff();
      else if (message.action === "allowResume") {
        native.requireConsent();
        const { atlasHandoff } = await chrome.storage.session.get("atlasHandoff");
        await controller.allowResume(atlasHandoff?.sessionId);
        native.error = null;
      } else if (message.action === "disconnect")
        await controller.disconnect({ takeover: true, tabId: message.tabId });
      else if (message.action !== "status") throw new Error("Unknown action");
      const { atlasHandoff } = await chrome.storage.session.get("atlasHandoff");
      return {
        error: controller.lastError,
        connected: !!controller.socket,
        tabs: controller.targets.size,
        handoff: !!atlasHandoff?.tabs?.length,
        ...native.status(),
      };
    })
    .then(reply, (error) => reply({ ...native.status(), error: error.message }));
  return true;
});
