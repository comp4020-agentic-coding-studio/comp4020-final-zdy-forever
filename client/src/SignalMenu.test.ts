// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignalMenu } from "./SignalMenu.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const toggle = () => container.querySelector<HTMLButtonElement>(".signal-menu-toggle")!;
const signalButtons = () => [...container.querySelectorAll<HTMLButtonElement>(".signal-menu-panel button")];

it("opens the eight signals as buttons and sends the chosen one once, at a viewport fraction", () => {
  const onSendSignal = vi.fn();
  act(() => root.render(createElement(SignalMenu, { onSendSignal })));
  expect(signalButtons()).toHaveLength(0);

  act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(signalButtons()).toHaveLength(8);

  act(() => signalButtons().find((b) => b.textContent?.includes("Fire"))!.click());
  expect(onSendSignal).toHaveBeenCalledTimes(1);
  const [signal, x, y] = onSendSignal.mock.calls[0];
  expect(signal).toBe("FIRE");
  expect(x).toBeGreaterThanOrEqual(0);
  expect(x).toBeLessThanOrEqual(1);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(y).toBeLessThanOrEqual(1);
  // Closes after sending and hands focus back, so a keyboard user isn't lost.
  expect(signalButtons()).toHaveLength(0);
  expect(document.activeElement).toBe(toggle());
});

it("closes on Escape without sending and returns focus to the toggle", () => {
  const onSendSignal = vi.fn();
  act(() => root.render(createElement(SignalMenu, { onSendSignal })));
  act(() => toggle().click());
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(signalButtons()).toHaveLength(0);
  expect(document.activeElement).toBe(toggle());
  expect(onSendSignal).not.toHaveBeenCalled();
});
