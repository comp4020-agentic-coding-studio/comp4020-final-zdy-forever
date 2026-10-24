// Slow-link check: profile B reaches the deployed app through a local TLS-
// terminating proxy that delays every chunk by DELAY_MS in each direction,
// so WebSocket frames are slowed too (DevTools throttling skips them).
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { chromium } from "playwright-core";

const TARGET = "comp4020-final-zdy-forever.fly.dev";
const DELAY_MS = Number(process.env.DELAY_MS ?? 300);
const PORT = 8899;
const later = (fn) => setTimeout(fn, DELAY_MS);

const server = http.createServer((req, res) => {
  later(() => {
    const up = https.request({ host: TARGET, path: req.url, method: req.method, headers: { ...req.headers, host: TARGET } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.on("data", (c) => later(() => res.write(c)));
      r.on("end", () => later(() => res.end()));
    });
    req.on("data", (c) => up.write(c));
    req.on("end", () => up.end());
    up.on("error", () => res.destroy());
  });
});
server.on("upgrade", (req, client, head) => {
  const up = tls.connect({ host: TARGET, port: 443, servername: TARGET }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries({ ...req.headers, host: TARGET }).map(([k, v]) => `${k}: ${v}`), "", ""];
    up.write(lines.join("\r\n"));
    if (head.length) up.write(head);
  });
  client.on("data", (c) => later(() => up.write(c)));
  up.on("data", (c) => later(() => client.write(c)));
  client.on("close", () => up.destroy());
  up.on("close", () => client.destroy());
  client.on("error", () => {}); up.on("error", () => {});
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch({ channel: "chrome", headless: true });
const A = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const B = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
const out = [];
const log = (s) => { out.push(s); console.log(s); };

async function register(page, url, name) {
  await page.goto(url, { timeout: 60_000 });
  await page.getByLabel("display name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.waitForFunction(() => !document.querySelector("button.btn--green[disabled]"), null, { timeout: 30_000 });
}
async function chat(page, text) { const b = page.getByLabel("Message", { exact: true }); await b.fill(text); await b.press("Enter"); }
async function seen(page, text, timeout = 15_000) { const t = Date.now(); await page.getByText(text, { exact: true }).first().waitFor({ timeout }); return Date.now() - t; }

try {
  let t = Date.now();
  await register(A, `https://${TARGET}/`, "Fast A");
  await register(B, `http://localhost:${PORT}/`, "Slow B");
  log(`slow profile page ready in ${Date.now() - t} ms (both registrations)`);
  await A.getByLabel("room name").fill("slow link check");
  await A.getByText("Private — join with a 6-digit code").click();
  await A.getByRole("button", { name: /Create room/ }).click();
  const chip = A.locator('[aria-label^="private room code"]'); await chip.waitFor();
  const code = (await chip.getAttribute("aria-label")).match(/\d{6}/)[0];
  await B.getByLabel("room code or number").first().fill(code);
  t = Date.now();
  await B.getByRole("button", { name: /Join/ }).first().click();
  await B.getByLabel("Message", { exact: true }).waitFor({ timeout: 30_000 });
  log(`slow profile joined room ${code} in ${Date.now() - t} ms`);
  const transport = await B.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("transport=websocket")));
  log(`slow profile used websocket: ${transport}`);

  const tag = Date.now().toString(36);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    t = Date.now(); await chat(A, `a${i} ${tag}`); samples.push(["A→B(slow)", await seen(B, `a${i} ${tag}`)]);
    t = Date.now(); await chat(B, `b${i} ${tag}`); samples.push(["B(slow)→A", await seen(A, `b${i} ${tag}`)]);
  }
  for (const [d, ms] of samples) log(`chat ${d}: ${ms} ms`);

  await A.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await A.getByRole("button", { name: /Add to queue/ }).click();
  await B.waitForFunction(() => document.querySelector("iframe"), null, { timeout: 20_000 });
  t = Date.now();
  await B.getByRole("button", { name: /Propose Pause/ }).click();
  await A.getByText(/voting…/).waitFor({ timeout: 15_000 });
  log(`slow profile's Pause proposal visible to A after ${Date.now() - t} ms`);
  t = Date.now();
  await A.getByRole("button", { name: /Vote YES/ }).click();
  await B.getByText(/voting…/).waitFor({ state: "detached", timeout: 20_000 });
  log(`vote resolved for slow profile ${Date.now() - t} ms after A's YES`);
  await B.screenshot({ path: "/tmp/wyt-e2e/slow-B.png" });
  log(`DELAY_MS=${DELAY_MS} per direction per chunk (≈${2 * DELAY_MS} ms added round trip)`);
} catch (e) {
  log(`FAIL ${e.message.split("\n")[0]}`);
  await B.screenshot({ path: "/tmp/wyt-e2e/slow-fail.png" }).catch(() => {});
} finally {
  await browser.close(); server.close();
}
