// Agent-run black-box check of the deployed app: two isolated Chrome contexts
// at the two marking viewports, simultaneous actions, and a throttled network.
import { chromium } from "playwright-core";

const URL = process.env.APP_URL ?? "https://comp4020-final-zdy-forever.fly.dev/";
const OUT = process.env.OUT ?? "/tmp/wyt-e2e/out";
const V1 = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const V2 = "https://www.youtube.com/watch?v=M7lc1UVf-VE";
const V3 = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const results = [];
const log = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errors = { A: [], B: [] };
A.on("pageerror", (e) => errors.A.push(e.message));
B.on("pageerror", (e) => errors.B.push(e.message));

async function register(page, name) {
  await page.goto(URL);
  await page.getByLabel("display name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("button", { name: /Create room/ }).waitFor();
  await page.waitForFunction(() => !document.querySelector("button.btn--green[disabled]"));
}
async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}
async function chat(page, text) {
  const box = page.getByLabel("Message", { exact: true });
  await box.fill(text);
  await box.press("Enter");
}
async function timeUntilVisible(page, text, timeout = 10_000) {
  const t0 = Date.now();
  await page.getByText(text, { exact: true }).first().waitFor({ timeout });
  return Date.now() - t0;
}
async function addTrack(page, url) {
  await page.getByLabel("YouTube link").fill(url);
  await page.getByRole("button", { name: /Add to queue/ }).click();
}
const queueCount = (page) => page.locator('[aria-label^="propose removing"], [aria-label^="restart here"]').count();

try {
  // Lobby at both viewports
  await register(A, "Tester A");
  await register(B, "Tester B");
  log("lobby: desktop no horizontal scroll", await noHorizontalScroll(A));
  log("lobby: phone no horizontal scroll", await noHorizontalScroll(B));
  await A.screenshot({ path: `${OUT}/lobby-1920.png` });
  await B.screenshot({ path: `${OUT}/lobby-390.png`, fullPage: true });

  // A creates a private room, B joins by code (separate profiles: no shared storage)
  await A.getByLabel("room name").fill("e2e check");
  await A.getByText("Private — join with a 6-digit code").click();
  await A.getByRole("button", { name: /Create room/ }).click();
  const chip = A.locator('[aria-label^="private room code"]');
  await chip.waitFor();
  const code = (await chip.getAttribute("aria-label")).match(/\d{6}/)[0];
  await B.getByLabel("room code or number").first().fill(code);
  await B.getByRole("button", { name: /Join/ }).first().click();
  await B.getByLabel("Message", { exact: true }).waitFor();
  log("join private room from second profile", true, `code ${code}`);

  // Real-time chat both directions
  const tag = Date.now().toString(36);
  let t = Date.now(); await chat(A, `hello from A ${tag}`); await timeUntilVisible(B, `hello from A ${tag}`);
  const ab = Date.now() - t;
  t = Date.now(); await chat(B, `hello from B ${tag}`); await timeUntilVisible(A, `hello from B ${tag}`);
  const ba = Date.now() - t;
  log("chat A→B within ~1s", ab < 1500, `${ab} ms`);
  log("chat B→A within ~1s", ba < 1500, `${ba} ms`);

  // Simultaneous adds: both must land, in both views
  await addTrack(A, V1);
  await A.waitForFunction(() => document.querySelector("iframe"), null, { timeout: 15_000 });
  await Promise.all([addTrack(A, V2), addTrack(B, V3)]);
  await A.waitForFunction(() => document.querySelectorAll('[aria-label^="propose removing"]').length >= 2, null, { timeout: 15_000 }).catch(() => {});
  await B.waitForFunction(() => document.querySelectorAll('[aria-label^="propose removing"]').length >= 2, null, { timeout: 15_000 }).catch(() => {});
  const qa = await queueCount(A), qb = await queueCount(B);
  log("simultaneous adds both kept, same in both views", qa >= 2 && qa === qb, `A sees ${qa} removable rows, B sees ${qb}`);

  // Simultaneous conflicting proposals: exactly one vote opens
  await Promise.all([
    A.getByRole("button", { name: /Propose Skip/ }).click(),
    B.getByRole("button", { name: /Propose Skip/ }).click(),
  ]);
  await A.getByText(/voting…/).waitFor({ timeout: 5_000 });
  await B.getByText(/voting…/).waitFor({ timeout: 5_000 });
  const stickersA = await A.getByText(/voting…/).count();
  log("simultaneous proposals: one vote shown to both", stickersA === 1);
  // A votes YES (proposer already YES or votes now); B votes NO -> tie fails
  await A.getByRole("button", { name: /Vote YES/ }).click().catch(() => {});
  await B.getByRole("button", { name: /Vote NO/ }).click().catch(() => {});
  t = Date.now();
  await A.getByText(/voting…/).waitFor({ state: "detached", timeout: 20_000 });
  log("fully cast vote resolves early (well before 15s)", Date.now() - t < 5_000, `${Date.now() - t} ms after both votes`);

  // Layout in room at both viewports
  log("room: desktop no horizontal scroll", await noHorizontalScroll(A));
  log("room: phone no horizontal scroll", await noHorizontalScroll(B));
  const iframeBox = await A.locator("iframe").first().boundingBox();
  log("room: desktop player visible in first screen", !!iframeBox && iframeBox.y + iframeBox.height <= 1080, JSON.stringify(iframeBox));
  const pageH = await A.evaluate(() => document.documentElement.scrollHeight);
  log("room: desktop page fits viewport height", pageH <= 1080 + 2, `scrollHeight ${pageH}`);
  const iframeB = await B.locator("iframe").first().boundingBox();
  log("room: phone player within width", !!iframeB && iframeB.width <= 390 && iframeB.x >= 0, JSON.stringify(iframeB));
  await A.screenshot({ path: `${OUT}/room-1920.png` });
  await B.screenshot({ path: `${OUT}/room-390.png` });
  await B.screenshot({ path: `${OUT}/room-390-full.png`, fullPage: true });

  // Slow network on B (~"Slow 3G": 400 ms RTT, 400 kbps)
  const cdp = await ctxB.newCDPSession(B);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  t = Date.now(); await chat(A, `slow check ${tag}`); await timeUntilVisible(B, `slow check ${tag}`);
  log("slow network: chat reaches throttled viewer", true, `${Date.now() - t} ms`);
  t = Date.now(); await chat(B, `slow send ${tag}`); await timeUntilVisible(A, `slow send ${tag}`);
  log("slow network: throttled viewer's chat reaches others", true, `${Date.now() - t} ms`);
  // Offline blip: B drops, A acts, B returns and converges from snapshot
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await chat(A, `while offline ${tag}`);
  await A.waitForTimeout(3_000);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  t = Date.now();
  await timeUntilVisible(B, `while offline ${tag}`, 30_000).then(
    () => log("offline blip: missed message appears after reconnect", true, `${Date.now() - t} ms after reconnect`),
    () => log("offline blip: missed message appears after reconnect", false, "not seen in 30s"),
  );
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  // Refresh: chat and queue survive
  await B.reload();
  await B.getByLabel("Message", { exact: true }).waitFor({ timeout: 15_000 });
  await B.getByText(`hello from A ${tag}`, { exact: true }).first().waitFor({ timeout: 10_000 }).catch(() => {});
  await B.screenshot({ path: `${OUT}/after-refresh-390.png` });
  const keptChat = await B.getByText(`hello from A ${tag}`, { exact: true }).count();
  const keptQueue = await queueCount(B);
  log("refresh: chat and queue restored", keptChat === 1 && keptQueue >= 2, `chat ${keptChat}, queue rows ${keptQueue}`);

  log("no uncaught page errors", errors.A.length + errors.B.length === 0, JSON.stringify(errors));
  console.log(`ROOM_CODE ${code}`);
} catch (e) {
  log("script", false, e.message.split("\n")[0]);
  await A.screenshot({ path: `${OUT}/fail-A.png` }).catch(() => {});
  await B.screenshot({ path: `${OUT}/fail-B.png` }).catch(() => {});
} finally {
  await browser.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
