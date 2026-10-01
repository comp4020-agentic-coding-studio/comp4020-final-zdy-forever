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
