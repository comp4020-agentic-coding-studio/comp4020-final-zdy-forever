// Keyboard-only use and resize-mid-interaction against an app at APP_URL.
import { chromium } from "playwright-core";

const URL = process.env.APP_URL ?? "https://comp4020-final-zdy-forever.fly.dev/";
const OUT = process.env.OUT ?? "/tmp/wyt-e2e/robust";
const results = [];
const log = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const A = await ctxA.newPage();
const B = await ctxB.newPage();
const errors = [];
for (const p of [A, B]) p.on("pageerror", (e) => errors.push(e.message));

// Press Tab until the focused element matches, return false after `max` presses.
async function tabTo(page, predicate, max = 60) {
  // Start from the top of the page, as a keyboard user arriving would.
  await page.evaluate(() => { document.activeElement?.blur(); window.getSelection()?.removeAllRanges(); });
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(predicate)) return true;
  }
  return false;
}
const focusedLabel = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el ? (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 50) : null;
});
const focusVisible = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return false;
  const s = getComputedStyle(el);
  return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
});
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  // ---------- B: keyboard only, from landing to a vote ----------
  // A sets up the room with the mouse.
  await A.goto(URL);
  await A.getByLabel("display name", { exact: true }).fill("Mouse A");
  await A.getByRole("button", { name: "Let's go" }).click();
  await A.waitForFunction(() => !document.querySelector("button.btn--green[disabled]"));
  await A.getByLabel("room name").fill("keyboard check");
  await A.getByText("Private — join with a 6-digit code").click();
  await A.getByRole("button", { name: /Create room/ }).click();
  const chip = A.locator('[aria-label^="private room code"]'); await chip.waitFor();
  const code = (await chip.getAttribute("aria-label")).match(/\d{6}/)[0];
  await A.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=jNQXAC9IVRw");
  await A.getByRole("button", { name: /Add to queue/ }).click();
  await A.waitForFunction(() => document.querySelector("iframe"), null, { timeout: 15_000 });

  await B.goto(URL);
  let ok = await tabTo(B, () => document.activeElement?.getAttribute("aria-label") === "display name");
  log("keyboard: Tab reaches the name field", ok);
  log("keyboard: focused field shows a focus ring", await focusVisible(B));
  await B.keyboard.type("Keys B");
  await B.keyboard.press("Enter");
  await B.waitForFunction(() => !document.querySelector("button.btn--green[disabled]"), null, { timeout: 10_000 });
  ok = await tabTo(B, () => document.activeElement?.getAttribute("aria-label") === "room code or number");
  log("keyboard: Tab reaches the join field", ok);
  await B.keyboard.type(code);
  await B.keyboard.press("Enter");
  await B.getByLabel("Message", { exact: true }).waitFor({ timeout: 15_000 });
  await B.getByText("connected", { exact: true }).waitFor({ timeout: 15_000 });
  log("keyboard: Enter joins the room by code", true);

  ok = await tabTo(B, () => document.activeElement?.getAttribute("aria-label") === "Message");
  log("keyboard: Tab reaches chat", ok);
  await B.keyboard.type("typed only with keys");
  await B.keyboard.press("Enter");
  await A.getByText("typed only with keys", { exact: true }).waitFor({ timeout: 5_000 }).then(
    () => log("keyboard: Enter sends chat, other profile receives it", true),
    () => log("keyboard: Enter sends chat, other profile receives it", false));

  ok = await tabTo(B, () => /Propose Pause/.test(document.activeElement?.textContent ?? ""));
  log("keyboard: Tab reaches Propose Pause", ok);
  log("keyboard: button shows a focus ring", await focusVisible(B));
  await B.keyboard.press("Enter");
  await A.getByText(/voting…/).waitFor({ timeout: 5_000 }).then(
    () => log("keyboard: Enter on Propose Pause opens a vote for both", true),
    () => log("keyboard: Enter on Propose Pause opens a vote for both", false));
  await A.getByRole("button", { name: /Vote NO/ }).click();
  await B.getByText(/voting…/).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});

  // members popover: open with keyboard, close with Escape, focus returns
  ok = await tabTo(B, () => (document.activeElement?.getAttribute("aria-label") ?? "").startsWith("DJ and listeners"));
  log("keyboard: Tab reaches the member-count button", ok);
  await B.keyboard.press("Enter");
  const panelOpen = await B.locator(".room-members-panel").isVisible().catch(() => false);
  await B.keyboard.press("Escape");
  const panelClosed = !(await B.locator(".room-members-panel").isVisible().catch(() => false));
  const backOnToggle = ((await focusedLabel(B)) ?? "").startsWith("DJ and listeners");
  log("keyboard: popover opens on Enter, closes on Escape, focus returns", panelOpen && panelClosed && backOnToggle, `open=${panelOpen} closed=${panelClosed} focusBack=${backOnToggle}`);

  // queue: move buttons are reachable by keyboard (drag has a keyboard alternative)
  await A.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=M7lc1UVf-VE");
  await A.getByRole("button", { name: /Add to queue/ }).click();
  await A.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
  await A.getByRole("button", { name: /Add to queue/ }).click();
  await A.getByLabel("YouTube link").fill("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await A.getByRole("button", { name: /Add to queue/ }).click();
  await B.waitForFunction(() => document.querySelectorAll('[aria-label^="move "]').length >= 8, null, { timeout: 15_000 });
  ok = await tabTo(B, () => /^move ".*" up in the queue$/.test(document.activeElement?.getAttribute("aria-label") ?? "") && !document.activeElement.disabled, 120);
  const moveLabel = await focusedLabel(B);
  if (ok) await B.keyboard.press("Enter");
  const reorderVote = ok && await A.getByText(/voting…/).waitFor({ timeout: 5_000 }).then(() => true, () => false);
  log("keyboard: a queue move button is reachable and opens a reorder vote", reorderVote, moveLabel ?? "");
  await A.getByRole("button", { name: /Vote NO/ }).click().catch(() => {});
  await B.getByText(/voting…/).waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});

  // ---------- resize mid-interaction ----------
  // B starts typing a chat message at desktop size, window shrinks to phone, then grows.
  const box = B.getByLabel("Message", { exact: true });
  await box.click();
  await B.keyboard.type("half a mess");
  const frameBefore = await B.evaluate(() => { const f = document.querySelector("iframe"); f.dataset.probe = "same"; return f.src; });
  await B.setViewportSize({ width: 390, height: 844 });
  await B.waitForTimeout(400);
  const draftKept = (await box.inputValue()) === "half a mess";
  const stillFocused = (await focusedLabel(B)) === "Message";
  const playerSame = await B.evaluate(() => document.querySelector("iframe")?.dataset.probe === "same");
  log("resize to phone while typing: draft kept", draftKept);
  log("resize to phone while typing: focus kept", stillFocused);
  log("resize to phone: player not remounted (no reload)", playerSame);
  log("resize to phone: no horizontal scroll", await noHScroll(B));
  await B.screenshot({ path: `${OUT}/resized-390.png` });
  await B.keyboard.type("age");
  await B.keyboard.press("Enter");
  await A.getByText("half a message", { exact: true }).waitFor({ timeout: 5_000 }).then(
    () => log("resize: message finished after resize still sends", true),
    () => log("resize: message finished after resize still sends", false));

  // resize during an open vote
  await A.getByRole("button", { name: /Propose Skip/ }).click();
  await B.getByText(/voting…/).waitFor({ timeout: 5_000 });
  await B.setViewportSize({ width: 1600, height: 900 });
  await B.waitForTimeout(300);
  await B.setViewportSize({ width: 820, height: 1180 });
  await B.waitForTimeout(300);
  const voteVisible = await B.getByRole("button", { name: /Vote YES/ }).isVisible();
  await B.getByRole("button", { name: /Vote YES/ }).click();
  const resolved = await A.getByText(/voting…/).waitFor({ state: "detached", timeout: 5_000 }).then(() => true, () => false);
  log("resize during an open vote: vote stays usable and resolves", voteVisible && resolved);
  log("resize to tablet: no horizontal scroll", await noHScroll(B));
  const playerSame2 = await B.evaluate(() => document.querySelector("iframe")?.dataset.probe === "same" || document.querySelector("iframe")?.src !== undefined);
  await B.screenshot({ path: `${OUT}/resized-820.png` });

  // desktop: shrink height (short laptop)
  await A.setViewportSize({ width: 1366, height: 640 });
  await A.waitForTimeout(400);
  log("short desktop 1366×640: no horizontal scroll", await noHScroll(A));
  const iframe = await A.locator("iframe").first().boundingBox();
  log("short desktop: player visible", !!iframe && iframe.height > 100, JSON.stringify(iframe));
  await A.screenshot({ path: `${OUT}/short-1366x640.png` });

  log("no uncaught page errors", errors.length === 0, JSON.stringify(errors));
} catch (e) {
  log("script", false, e.message.split("\n")[0]);
  await A.screenshot({ path: `${OUT}/fail-A.png` }).catch(() => {});
  await B.screenshot({ path: `${OUT}/fail-B.png` }).catch(() => {});
} finally {
  await browser.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
}
