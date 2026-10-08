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
  if (
    sender.id !== chrome.runtime.id ||
    !sender.url?.startsWith(chrome.runtime.getURL("popup.html"))
  )
    return;
  void ready
    .then(async () => {
      if (message.action === "connect") await controller.connect(message.endpoint, message.tabId);
      else if (message.action === "reconnect") await native.reconnect();
      else if (message.action === "shareNextTab") await native.share(message.tabId);
      else if (message.action === "discardHandoff") await controller.discardHandoff();
      else if (message.action === "allowResume") {
        await controller.allowResume();
        native.error = null;
      } else if (message.action === "disconnect")
        await controller.disconnect({ takeover: true, tabId: message.tabId });
      else if (message.action !== "status") throw new Error("Unknown action");
      if (controller.lastError) throw new Error(controller.lastError);
      const { atlasHandoff } = await chrome.storage.session.get("atlasHandoff");
      return {
        connected: !!controller.socket,
        tabs: controller.targets.size,
        handoff: !!atlasHandoff?.tabs?.length,
        ...native.status(),
      };
    })
    .then(reply, (error) => reply({ error: error.message }));
  return true;
});
