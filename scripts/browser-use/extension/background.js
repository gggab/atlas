import { ExtensionController } from "./controller.js";
import { NativeConnection } from "./native-connection.js";
import { SitePermissions } from "./site-permissions.js";
const permissions = new SitePermissions(chrome);
const controller = new ExtensionController(chrome, WebSocket, permissions);
permissions.onRevoked = () => controller.disconnect({ takeover: true });
const native = new NativeConnection(chrome, controller);
const ready = controller
  .recover()
  .then(() => permissions.restore())
  .then(() => native.restore())
  .catch((error) => {
    controller.lastError = error.message;
  });
chrome.runtime.onStartup.addListener(() => {
  void ready;
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const popupUrl = chrome.runtime.getURL("popup.html");
  if (
    sender.id !== chrome.runtime.id ||
    ![popupUrl, `${popupUrl}#website-access`].includes(sender.url)
  )
    return;
  void ready
    .then(async () => {
      if (message.action === "websiteDecision")
        await permissions.respond(message.id, message.choice);
      else if (message.action === "resetWebsiteAccess") await permissions.reset();
      else if (message.action === "revokeWebsite") await permissions.revoke(message.host);
      else if (message.action === "connect") {
        await controller.connect(message.endpoint, message.tabId);
      } else if (message.action === "reconnect") await native.reconnect();
      else if (message.action === "shareNextTab") await native.share(message.tabId);
      else if (message.action === "discardHandoff") await controller.discardHandoff();
      else if (message.action === "disconnect")
        await controller.disconnect({ takeover: true, tabId: message.tabId });
      else if (message.action !== "status") throw new Error("Unknown action");
      const { atlasHandoff } = await chrome.storage.session.get("atlasHandoff");
      return {
        error: controller.lastError ?? controller.accessError ?? permissions.error,
        connected: !!controller.socket,
        tabs: controller.targets.size,
        handoff: !!atlasHandoff?.tabs?.length,
        websiteAccess: permissions.status(),
        ...native.status(),
      };
    })
    .then(reply, (error) => reply({ ...native.status(), error: error.message }));
  return true;
});
