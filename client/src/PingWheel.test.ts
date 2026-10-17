// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PingWheel } from "./PingWheel.tsx";

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

function render(props: { active: boolean; onSendSignal: (signal: string, xRatio: number, yRatio: number) => void }) {
  act(() => root.render(createElement(PingWheel, props)));
}

function keydown(key: string, opts: Partial<KeyboardEventInit> = {}) {
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })));
}
function keyup(key: string) {
  act(() => document.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true })));
}
function mousemove(x: number, y: number) {
  act(() => document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true })));
}

it("does nothing while inactive", () => {
  const onSendSignal = vi.fn();
  render({ active: false, onSendSignal });
  mousemove(100, 100);
  keydown("Control");
  keyup("Control");
  expect(container.querySelector(".ping-wheel")).toBeNull();
  expect(onSendSignal).not.toHaveBeenCalled();
});

it("opens the wheel on Ctrl and closes without sending on Escape", () => {
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  expect(container.querySelector(".ping-wheel")).not.toBeNull();
  keydown("Escape");
  expect(container.querySelector(".ping-wheel")).toBeNull();
  expect(onSendSignal).not.toHaveBeenCalled();
});

it("sends the hovered slice's signal exactly once, with the anchor's viewport-relative position", () => {
  const onSendSignal = vi.fn();
  Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  // Straight up from the anchor is slice 0 (QUESTION — see PingWheel.tsx's
  // PING_SIGNALS ordering), well outside the dead zone.
  mousemove(200, 100);
  keyup("Control");
  // Regression: an earlier version placed the send inside a setHovered
  // updater function, which React 18 StrictMode (and even outside it, any
  // double-render) can invoke more than once — it must fire exactly once
  // per gesture regardless.
  expect(onSendSignal).toHaveBeenCalledTimes(1);
  expect(onSendSignal).toHaveBeenCalledWith("QUESTION", 0.2, 0.4);
  expect(container.querySelector(".ping-wheel")).toBeNull();
});

it("moving the mouse after release never sends a second signal", () => {
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  mousemove(200, 100);
  keyup("Control");
  mousemove(300, 300);
  mousemove(400, 400);
  expect(onSendSignal).toHaveBeenCalledTimes(1);
});

it("always sends, even past the local cooldown hint — only the server may actually reject a ping", () => {
  // Regression: an earlier version used the local cooldown counter to
  // suppress sending once "used up," which could disagree with the
  // server's real per-account limit (e.g. two tabs of the same account) and
  // silently drop a signal the server would have accepted. The local
  // counter may still dim slices as a hint, but must never block a send.
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  const sendOne = () => {
    mousemove(200, 200);
    keydown("Control");
    mousemove(200, 100);
    keyup("Control");
  };
  sendOne();
  sendOne();
  sendOne();
  sendOne(); // a 4th, past the 3-free local hint
  expect(onSendSignal).toHaveBeenCalledTimes(4);
});

it("releasing Ctrl near the anchor (dead zone) cancels without sending", () => {
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  // No mousemove away from the anchor — still inside the dead zone.
  keyup("Control");
  expect(onSendSignal).not.toHaveBeenCalled();
});

it("ignores Ctrl while focus is in a text-entry element", () => {
  const input = document.createElement("input");
  document.body.appendChild(input);
  input.focus();
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  expect(container.querySelector(".ping-wheel")).toBeNull();
  input.remove();
});

it("closes the wheel immediately if the room becomes inactive mid-gesture", () => {
  const onSendSignal = vi.fn();
  render({ active: true, onSendSignal });
  mousemove(200, 200);
  keydown("Control");
  expect(container.querySelector(".ping-wheel")).not.toBeNull();
  render({ active: false, onSendSignal });
  expect(container.querySelector(".ping-wheel")).toBeNull();
});
