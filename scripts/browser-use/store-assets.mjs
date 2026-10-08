// Compose listing assets from actual fixture screenshots and the packaged SVG.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const playwright = path.dirname(require.resolve("playwright-core/package.json"));
const { jpegjs } = require(path.join(playwright, "lib/utilsBundle.js"));
const output = fileURLToPath(
  new URL("../../artifacts/browser-extension/store-assets/", import.meta.url),
);
const captures = fileURLToPath(new URL("../../artifacts/browser-extension/", import.meta.url));
const icon = await readFile(new URL("./extension/icons/icon.svg", import.meta.url));
const logo = `data:image/svg+xml;base64,${icon.toString("base64")}`;
async function capture(name) {
  try {
    return `data:image/png;base64,${(await readFile(path.join(captures, name))).toString("base64")}`;
  } catch {
    throw new Error(
      `Missing actual popup screenshot ${name}; run browser:native-smoke chrome first.`,
    );
  }
}
const ready = await capture("popup-chrome-light.png");
const handoff = await capture("popup-chrome-handoff.png");
const css = `*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:"Segoe UI",sans-serif;color:#18203c}h1,h2,p{margin:0}img{display:block} .brand{display:flex;align-items:center;gap:14px;font-size:28px;font-weight:650;letter-spacing:-.7px}.brand img{width:52px;height:52px}`;
function document(body, styles) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Atlas Browser store asset</title><style>${css}${styles}</style><body>${body}</body></html>`;
}
const browserIllustration = `<svg width="470" height="340" viewBox="0 0 470 340" xmlns="http://www.w3.org/2000/svg"><rect x="14" y="15" width="392" height="252" rx="24" fill="#5d60d6" opacity=".3"/><rect x="42" y="45" width="392" height="252" rx="24" fill="#222750" stroke="#9198ff" stroke-width="2"/><path d="M44 99h388" stroke="#9198ff" stroke-opacity=".45" stroke-width="2"/><circle cx="70" cy="73" r="5" fill="#a7e9ff"/><circle cx="88" cy="73" r="5" fill="#969dff"/><circle cx="106" cy="73" r="5" fill="#6670a2"/><rect x="264" y="125" width="131" height="14" rx="7" fill="#656ec2"/><rect x="264" y="153" width="101" height="10" rx="5" fill="#454e90"/><rect x="264" y="177" width="117" height="10" rx="5" fill="#454e90"/><rect x="264" y="215" width="112" height="32" rx="10" fill="#7e87ed"/><image href="${logo}" x="74" y="113" width="142" height="142"/><circle cx="422" cy="283" r="39" fill="#a7e9ff"/><path d="m422 260 6.5 16.5 16.5 6.5-16.5 6.5-6.5 16.5-6.5-16.5-16.5-6.5 16.5-6.5z" fill="#222750"/></svg>`;

const assets = [
  {
    name: "screenshot-1280x800.jpg",
    width: 1280,
    height: 800,
    html: document(
      `<header class="brand"><img src="${logo}" alt=""/>Atlas Browser</header><main><section class="copy"><p class="eyebrow">THE ATLAS BROWSER COMPANION</p><h1>Work together,<br>in your browser.</h1><p class="intro">Share a page with your Agent.<br>Take over when you need to.<br>Continue when you are ready.</p><div class="note"><span></span><p>Temporary task pages close<br>when the work is done.</p></div></section><section class="shot"><h2><b>01</b> Connected &amp; ready</h2><img src="${ready}" alt="Actual Atlas Browser connected popup"/></section><section class="shot"><h2><b>02</b> Your turn</h2><img src="${handoff}" alt="Actual Atlas Browser handoff popup"/></section></main><footer>Requires the Atlas desktop app and a configured Agent. Actual extension popup shown.</footer>`,
      `body{background:radial-gradient(ellipse at 88% 5%,#e6e9ff 0,transparent 50%),#f4f5fb;padding:48px 56px}header{height:56px}main{display:grid;grid-template-columns:360px 360px 360px;gap:24px;margin-top:64px}.copy{padding-top:33px}.eyebrow{font-size:11px;font-weight:700;letter-spacing:1.8px;color:#555ac4}h1{font-size:42px;line-height:1.14;letter-spacing:-1.7px;margin-top:23px;font-weight:650}.intro{font-size:17px;line-height:1.9;color:#626980;margin-top:26px}.note{display:flex;align-items:flex-start;gap:9px;margin-top:34px;font-size:13px;line-height:1.6;color:#5f6983}.note span{width:6px;height:6px;background:#368e78;border-radius:50%;margin-top:8px;flex-shrink:0}.shot h2{font-size:14px;font-weight:600;margin-bottom:16px;color:#313a57}.shot b{font-size:11px;padding:4px 7px;background:#e4e6f4;border-radius:5px;margin-right:7px;color:#646b94}.shot img{width:360px;height:auto;border:1px solid #dce0ed;border-radius:12px;box-shadow:0 18px 40px #1d245515}footer{position:absolute;bottom:32px;left:56px;font-size:12px;color:#767d93}`,
    ),
  },
  {
    name: "promo-small-440x280.jpg",
    width: 440,
    height: 280,
    html: document(
      `<div class="glow"></div><img class="logo" src="${logo}" alt=""/><div class="title"><h1>Atlas<br>Browser</h1><p>Your browser.<br>Your Agent.</p></div><div class="line"></div>`,
      `body{position:relative;background:linear-gradient(125deg,#403c9a,#1c254d);color:#fff}.glow{position:absolute;width:340px;height:340px;left:-100px;top:-110px;background:radial-gradient(circle,#7f80fa66,transparent 65%)}.logo{position:absolute;left:34px;top:73px;width:120px;height:120px}.title{position:absolute;left:185px;top:57px}h1{font-size:36px;line-height:1.14;font-weight:650;letter-spacing:-1.2px}p{font-size:16px;line-height:1.6;color:#c1c9f6;margin-top:18px}.line{position:absolute;width:250px;height:250px;right:-157px;bottom:-140px;border:1px solid #a7c5ff4a;border-radius:50%}`,
    ),
  },
  {
    name: "promo-marquee-1400x560.jpg",
    width: 1400,
    height: 560,
    html: document(
      `<header class="brand"><img src="${logo}" alt=""/>Atlas Browser</header><section class="copy"><h1>Your browser.<br>Your Agent.</h1><p>Work together. Stay in control.</p></section><div class="illustration">${browserIllustration}</div><div class="orbit"></div>`,
      `body{position:relative;background:radial-gradient(ellipse at 94% 18%,#5557bd70,transparent 65%),linear-gradient(120deg,#332f7c,#172247);color:#fff;padding:68px 84px}header{position:relative;z-index:1}.copy{position:absolute;top:199px;left:84px}h1{font-size:66px;line-height:1.09;letter-spacing:-2.6px;font-weight:650}p{font-size:22px;color:#c3cdf5;margin-top:26px;letter-spacing:-.1px}.illustration{position:absolute;right:105px;top:119px;z-index:1}.orbit{position:absolute;width:760px;height:760px;border:1px solid #99abff27;border-radius:50%;right:-116px;top:-150px}`,
    ),
  },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const asset of assets) {
    await page.setViewportSize({ width: asset.width, height: asset.height });
    await page.setContent(asset.html);
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map((img) => img.decode()));
    });
    const clippedText = await page.locator("h1,h2,p,footer").evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight;
        })
        .map((element) => element.textContent),
    );
    assert.deepEqual(clippedText, [], `Text is clipped in ${asset.name}`);
    const image = await page.screenshot({ type: "jpeg", quality: 96 });
    assert.equal(image.readUInt16BE(0), 0xffd8, "Store images must be opaque JPEG");
    const decoded = jpegjs.decode(image, { useTArray: true });
    assert.equal(decoded.width, asset.width);
    assert.equal(decoded.height, asset.height);
    await writeFile(path.join(output, asset.name), image);
    await writeFile(path.join(output, asset.name.replace(".jpg", ".html")), asset.html);
    console.log(
      `[browser:store-assets] ${asset.name}: ${decoded.width}x${decoded.height}, JPEG, ${image.length} bytes`,
    );
  }
} finally {
  await browser.close();
}
