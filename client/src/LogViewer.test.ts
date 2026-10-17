// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LogEventView } from "../../shared/src/types.ts";
import { LogViewer } from "./LogViewer.tsx";

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

const onRefresh = vi.fn();
function render(overrides: Partial<{ events: LogEventView[] | "error" | null; loading: boolean }> = {}) {
  act(() => root.render(createElement(LogViewer, { events: null, loading: false, onRefresh, ...overrides })));
}

it("shows the empty state when there is nothing to show", () => {
  render({ events: [] });
  expect(container.textContent).toContain("no activity in the last 20 minutes");
});

it("shows an error state without crashing", () => {
  render({ events: "error" });
  expect(container.querySelector("[role=alert]")?.textContent).toContain("couldn't load");
});

it("renders a readable line, never raw JSON, for a real event", () => {
  const event: LogEventView = {
    timestamp: new Date().toISOString(),
    action: "ROOM_JOIN",
    result: "ok",
    accountDisplayName: "Alice",
  };
  render({ events: [event] });
  expect(container.textContent).toContain("Alice joined the room");
  expect(container.textContent).not.toContain("{");
});

it("never renders chat message text (it is never in the data at all)", () => {
  const event: LogEventView = {
    timestamp: new Date().toISOString(),
    action: "CHAT_SEND",
    result: "ok",
    accountDisplayName: "Alice",
  };
  render({ events: [event] });
  expect(container.textContent).toContain("Alice sent a message");
});

it("calls onRefresh when the refresh button is clicked", () => {
  render({ events: [] });
  act(() => container.querySelector("button")!.click());
  expect(onRefresh).toHaveBeenCalled();
});
