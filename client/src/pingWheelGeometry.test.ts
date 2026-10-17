import { describe, expect, it } from "vitest";
import { PING_SIGNALS } from "../../shared/src/types.ts";
import { DEAD_ZONE_PX, sliceAt } from "./pingWheelGeometry.ts";

const ANCHOR = { x: 100, y: 100 };

describe("sliceAt", () => {
  it("returns null inside the dead zone, including exactly at the anchor", () => {
    expect(sliceAt(ANCHOR, ANCHOR)).toBeNull();
    expect(sliceAt(ANCHOR, { x: ANCHOR.x + DEAD_ZONE_PX - 1, y: ANCHOR.y })).toBeNull();
  });

  it("picks slice 0 (top) for a point straight above the anchor", () => {
    expect(sliceAt(ANCHOR, { x: ANCHOR.x, y: ANCHOR.y - 100 })).toBe(0);
  });

  it("picks the slice a quarter turn clockwise (right) for a point directly to the right", () => {
    const quarterIndex = PING_SIGNALS.length / 4;
    expect(sliceAt(ANCHOR, { x: ANCHOR.x + 100, y: ANCHOR.y })).toBe(quarterIndex);
  });

  it("picks the slice a half turn around (bottom) for a point directly below", () => {
    const halfIndex = PING_SIGNALS.length / 2;
    expect(sliceAt(ANCHOR, { x: ANCHOR.x, y: ANCHOR.y + 100 })).toBe(halfIndex);
  });

  it("always returns an index within range just outside the dead zone, all the way around", () => {
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const point = { x: ANCHOR.x + Math.sin(rad) * (DEAD_ZONE_PX + 5), y: ANCHOR.y - Math.cos(rad) * (DEAD_ZONE_PX + 5) };
      const slice = sliceAt(ANCHOR, point);
      expect(slice).not.toBeNull();
      expect(slice as number).toBeGreaterThanOrEqual(0);
      expect(slice as number).toBeLessThan(PING_SIGNALS.length);
    }
  });
});
