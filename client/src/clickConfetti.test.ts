// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const addConfettiAtPosition = vi.fn().mockResolvedValue(undefined);
vi.mock("js-confetti", () => ({
  default: class {
    addConfettiAtPosition = addConfettiAtPosition;
  },
}));

// jsdom has no real Web Audio API — stand in a minimal fake so playClickPop's
// calls (start/stop/connect/the AudioParam setters) are all no-ops that
// never throw, mirroring how voteChime.ts/pingChime.ts are exercised
// elsewhere in this app (those have no dedicated unit test; this one does).
const oscillatorStart = vi.fn();
function fakeAudioContext() {
  return {
    state: "running",
    currentTime: 0,
    resume: vi.fn(),
    createOscillator: () => ({
      type: "sine",
      frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
      start: oscillatorStart,
      stop: vi.fn(),
    }),
    createGain: () => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
  };
}

beforeEach(() => {
  addConfettiAtPosition.mockClear();
  oscillatorStart.mockClear();
  (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn().mockImplementation(fakeAudioContext);
});

afterEach(() => {
  vi.resetModules();
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
});

it("fires a confetti burst at the given coordinates", async () => {
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  fireConfettiAt(12, 34, 1_000);
  expect(addConfettiAtPosition).toHaveBeenCalledTimes(1);
  expect(addConfettiAtPosition).toHaveBeenCalledWith(
    expect.objectContaining({ confettiDispatchPosition: { x: 12, y: 34 } }),
  );
});

it("also plays a click sound alongside the burst", async () => {
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  fireConfettiAt(12, 34, 1_000);
  expect(oscillatorStart).toHaveBeenCalledTimes(1);
});

it("suppresses a second burst (confetti and sound alike) fired within the minimum interval", async () => {
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  fireConfettiAt(0, 0, 2_000);
  fireConfettiAt(10, 10, 2_010);
  expect(addConfettiAtPosition).toHaveBeenCalledTimes(1);
  expect(oscillatorStart).toHaveBeenCalledTimes(1);
});

it("fires again once the minimum interval has elapsed", async () => {
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  fireConfettiAt(0, 0, 3_000);
  fireConfettiAt(10, 10, 3_100);
  expect(addConfettiAtPosition).toHaveBeenCalledTimes(2);
  expect(oscillatorStart).toHaveBeenCalledTimes(2);
});

it("never throws even if the underlying confetti library does", async () => {
  addConfettiAtPosition.mockImplementationOnce(() => {
    throw new Error("boom");
  });
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  expect(() => fireConfettiAt(0, 0, 4_000)).not.toThrow();
  // The sound is independent: a confetti failure must never silence it.
  expect(oscillatorStart).toHaveBeenCalledTimes(1);
});

it("never throws even if the audio API does, and still fires confetti", async () => {
  oscillatorStart.mockImplementationOnce(() => {
    throw new Error("boom");
  });
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  expect(() => fireConfettiAt(0, 0, 5_000)).not.toThrow();
  expect(addConfettiAtPosition).toHaveBeenCalledTimes(1);
});

it("never throws when the Web Audio API is unavailable", async () => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  const { fireConfettiAt } = await import("./clickConfetti.ts");
  expect(() => fireConfettiAt(0, 0, 6_000)).not.toThrow();
  expect(addConfettiAtPosition).toHaveBeenCalledTimes(1);
});
