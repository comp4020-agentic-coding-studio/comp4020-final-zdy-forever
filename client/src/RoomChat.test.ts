// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoomChat } from "./RoomChat.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); });
const onSend = vi.fn(async () => true);
function render(overrides = {}) {
  act(() => root.render(createElement(RoomChat, { messages: [], accountId: "me", connected: true, error: null, onSend, ...overrides })));
}
function type(text: string) {
  act(() => {
    const textarea = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("renders message content as plain text and identifies the sender", () => {
  render({ messages: [{ messageId: "m1", roomId: "room", accountId: "me", displayName: "Alice", text: "<img src=x onerror=alert(1)>", createdAt: new Date().toISOString() }] });
  expect(container.textContent).toContain("Alice (you)");
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  expect(container.querySelector("img")).toBeNull();
});

it("keeps a failed draft, then clears it only after successful acknowledgement", async () => {
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render({ onSend: send });
  type("Hello room");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledWith("Hello room");
  expect(container.querySelector("textarea")!.value).toBe("Hello room");
  await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(container.querySelector("textarea")!.value).toBe("");
});

it("disables sending blank messages and sending while disconnected", () => {
  render();
  expect(container.querySelector<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
  type("hello");
  expect(container.querySelector<HTMLButtonElement>(".chat-send")!.disabled).toBe(false);
  render({ connected: false });
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>(".chat-send")!.disabled).toBe(true);
});
