// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DjHandoffDialog } from "./DjHandoffDialog.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const choose = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  choose.mockClear();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

it("counts down from the server deadline, submits identities, and waits for server completion", () => {
  act(() => root.render(createElement(DjHandoffDialog, {
    handoff: { requestId: "handoff-1", expiresAt: Date.now() + 10_000 },
    members: [{ accountId: "bob", displayName: "Bob" }], error: null, onChoose: choose,
  })));
  expect(container.querySelector("dialog")!.open).toBe(true);
  expect(container.textContent).toContain("10s");
  act(() => vi.advanceTimersByTime(6_000));
  expect(container.textContent).toContain("4s");
  act(() => container.querySelector("button")!.click());
  expect(choose).toHaveBeenCalledWith("handoff-1", "bob");
  act(() => vi.advanceTimersByTime(4_000));
  expect(container.textContent).toContain("Assigning the next DJ");
  expect(container.querySelector("button")!.disabled).toBe(true);
  expect(choose).toHaveBeenCalledTimes(1); // Random assignment belongs to the server.
});

it("updates available members without restarting the deadline", () => {
  const handoff = { requestId: "handoff-1", expiresAt: Date.now() + 10_000 };
  const render = (members: { accountId: string; displayName: string }[]) => act(() => root.render(createElement(DjHandoffDialog, {
    handoff, members, error: "Choose another member", onChoose: choose,
  })));
  render([{ accountId: "bob", displayName: "Bob" }]);
  act(() => vi.advanceTimersByTime(7_000));
  render([]);
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("3s");
  expect(container.textContent).toContain("No other members remain");
});
