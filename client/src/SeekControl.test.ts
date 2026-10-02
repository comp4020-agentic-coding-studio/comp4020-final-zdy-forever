// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SeekControl } from "./SeekControl.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const propose = vi.fn();
beforeEach(() => {
  propose.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(SeekControl, { onPropose: propose })));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it.each([
  ["", "", "", 0],
  ["", "", "90", 90_000],
  ["", "2", "30", 150_000],
  ["", "5", "", 300_000],
  ["1", "2", "3", 3_723_000],
] as const)("converts %s:%s:%s to %i ms, with omitted units defaulting to zero", (hours, minutes, seconds, expected) => {
  expect(container.querySelector("input")).toBeNull();
  act(() => container.querySelector("button")!.click());
  for (const [index, value] of [hours, minutes, seconds].entries()) {
    const input = container.querySelectorAll("input")[index];
    expect(input.placeholder).toBe("00");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(propose).toHaveBeenCalledWith(expected);
});

function typeTime(hours: string, minutes: string, seconds: string) {
  for (const [index, value] of [hours, minutes, seconds].entries()) {
    const input = container.querySelectorAll("input")[index];
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
}

function submit() {
  act(() => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}

it("silently refuses a time past the track's known duration, with no message and no propose call", () => {
  act(() => root.render(createElement(SeekControl, { onPropose: propose, getDurationMs: () => 200_000 }))); // 3:20
  act(() => container.querySelector("button")!.click());
  typeTime("", "5", "0"); // 5:00 — past the 3:20 track
  submit();
  expect(propose).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("accepts a time at exactly the track's duration", () => {
  act(() => root.render(createElement(SeekControl, { onPropose: propose, getDurationMs: () => 200_000 })));
  act(() => container.querySelector("button")!.click());
  typeTime("", "3", "20");
  submit();
  expect(propose).toHaveBeenCalledWith(200_000);
});

it("allows any time while the duration isn't known yet (e.g. the player hasn't reported one)", () => {
  act(() => root.render(createElement(SeekControl, { onPropose: propose, getDurationMs: () => null })));
  act(() => container.querySelector("button")!.click());
  typeTime("1", "0", "0");
  submit();
  expect(propose).toHaveBeenCalledWith(3_600_000);
});

it("collapses back to the plain toggle once a valid seek is proposed", () => {
  act(() => container.querySelector("button")!.click());
  typeTime("", "2", "30");
  submit();
  expect(propose).toHaveBeenCalledWith(150_000);
  // Back to its default, closed state — not sitting open with an empty form.
  expect(container.querySelector("form")).toBeNull();
  expect(container.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");

  // Reopening shows a blank form, not the time that was already sent.
  act(() => container.querySelector("button")!.click());
  for (const input of container.querySelectorAll("input")) {
    expect((input as HTMLInputElement).value).toBe("");
  }
});
