import { PING_SIGNALS } from "../../shared/src/types.ts";

// Releasing inside this radius of the anchor cancels, same as lolPing's
// "release near the center cancels" — without a dead zone, the very first
// pixel of mouse movement after opening would always pick a slice.
export const DEAD_ZONE_PX = 28;

// Pure: which slice (0 = top, clockwise) the point falls in relative to the
// anchor — null inside the dead zone (cancel) or exactly at the anchor.
export function sliceAt(anchor: { x: number; y: number }, point: { x: number; y: number }): number | null {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (Math.hypot(dx, dy) < DEAD_ZONE_PX) return null;
  // atan2 is 0 at +x (3 o'clock), increasing clockwise in screen coordinates
  // (y grows downward) — shift by +90° so slice 0 sits at the top.
  const angle = (Math.atan2(dy, dx) * (180 / Math.PI) + 90 + 360) % 360;
  return Math.floor(angle / (360 / PING_SIGNALS.length));
}
