import { useEffect, useRef, useState } from "react";
import { PING_SIGNALS, type PingSignal } from "../../shared/src/types.ts";
import { sliceAt } from "./pingWheelGeometry.ts";

// Icon + label for each signal, in the same order as PING_SIGNALS — the
// wheel's 8 slices are laid out in this order, starting at the top and
// going clockwise.
export const PING_META: Record<PingSignal, { icon: string; label: string }> = {
  QUESTION: { icon: "❓", label: "Confused?" },
  CATCH_UP: { icon: "⏫", label: "Catch me up" },
  FIRE: { icon: "🔥", label: "Fire" },
  THUMBS_UP: { icon: "👍", label: "Nice" },
  LOVE: { icon: "❤️", label: "Love it" },
  THUMBS_DOWN: { icon: "👎", label: "Meh" },
  WOW: { icon: "😮", label: "Whoa" },
  LAUGH: { icon: "😂", label: "Laugh" },
};

const RADIUS_PX = 92;

// How many of this client's own recent sends to remember, purely to grey out
// the wheel as a *hint* that a send is likely to be rejected — never to
// actually block one. The server (server/src/pingRateLimit.ts) enforces the
// real 3-per-10s rule per room+account with a fixed-window algorithm; this is
// a different (sliding-window) approximation kept per component instance, so
// it can disagree with the server — most visibly across two tabs of the same
// account, which share one server-side bucket but would each otherwise think
// they have their own 3 free sends. Letting this merely dim slices rather
// than suppress the send means a wrong guess here only ever costs a visual
// nicety, never a dropped signal — any real rejection still reaches the
// server and comes back as a ping:sendError the user actually sees (see
// usePlaybackSync.ts's pingError / App.tsx's rendering of it).
const COOLDOWN_WINDOW_MS = 10_000;
const COOLDOWN_FREE_SENDS = 3;

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || (element as HTMLElement).isContentEditable;
}

// Hold Ctrl to open a radial picker anchored at the cursor; release over a
// slice to send that signal (at the point Ctrl was first held down — the
// anchor, not wherever the cursor drifted to), release over the center (or
// press Escape) to cancel. Only armed while `active` (the parent only sets
// this while in a room) — Ctrl elsewhere on the page (the lobby, a text
// field) does nothing, guarded both by `active` and by ignoring the keydown
// while focus is in a text-entry element.
//
// `onSendSignal` is called from a plain event handler, never from inside a
// setState updater function — React 18 StrictMode (client/src/main.tsx)
// deliberately invokes updater functions passed to a state setter twice in
// development to surface exactly this kind of impurity, so a side effect
// placed there (an earlier version of this component did) fires more than
// once per gesture. Gesture state lives in refs for that reason; React state
// here exists only to trigger a re-render of what's visible.
export function PingWheel({ active, onSendSignal }: { active: boolean; onSendSignal: (signal: PingSignal, xRatio: number, yRatio: number) => void }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredRef = useRef<number | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const sendTimesRef = useRef<number[]>([]);

  useEffect(() => {
    if (!active) return;

    const trackMouse = (event: MouseEvent) => {
      mouseRef.current = { x: event.clientX, y: event.clientY };
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Control" || event.repeat || anchorRef.current !== null) return;
      if (isTextEntryElement(document.activeElement)) return;
      const point = { ...mouseRef.current };
      anchorRef.current = point;
      hoveredRef.current = null;
      setAnchor(point);
      setHovered(null);
    };

    const onMouseMove = (event: MouseEvent) => {
      trackMouse(event);
      if (anchorRef.current === null) return;
      const slice = sliceAt(anchorRef.current, { x: event.clientX, y: event.clientY });
      hoveredRef.current = slice;
      setHovered(slice);
    };

    const close = () => {
      anchorRef.current = null;
      hoveredRef.current = null;
      setAnchor(null);
      setHovered(null);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control" || anchorRef.current === null) return;
      const anchorAtRelease = anchorRef.current;
      const slice = hoveredRef.current;
      close();
      if (slice === null) return;
      // Always actually sent — the local cooldown tracking below is only
      // ever a greyed-out *hint*, never a gate, precisely because it can
      // disagree with the server's real per-account limit (see its own doc
      // comment above). The server is the only thing allowed to say no, and
      // when it does, onSendSignal's caller surfaces that as pingError.
      const now = Date.now();
      sendTimesRef.current = [...sendTimesRef.current, now].filter((t) => now - t < COOLDOWN_WINDOW_MS);
      // A fraction of the viewport, not raw pixels, so the signal lands in
      // the same relative spot for every member regardless of their own
      // window size (server/src/realtime.ts broadcasts these ratios
      // unchanged to the whole room).
      onSendSignal(
        PING_SIGNALS[slice],
        anchorAtRelease.x / window.innerWidth,
        anchorAtRelease.y / window.innerHeight,
      );
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && anchorRef.current !== null) close();
    };

    document.addEventListener("mousemove", trackMouse);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousemove", trackMouse);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("keydown", onEscape);
    };
  }, [active, onSendSignal]);

  // Leaving the room (or this component being torn down) mid-gesture must
  // never leave the wheel stuck open.
  useEffect(() => {
    if (!active) {
      anchorRef.current = null;
      hoveredRef.current = null;
      setAnchor(null);
      setHovered(null);
    }
  }, [active]);

  if (!anchor) return null;

  const now = Date.now();
  const onCooldown = sendTimesRef.current.filter((t) => now - t < COOLDOWN_WINDOW_MS).length >= COOLDOWN_FREE_SENDS;

  return (
    <div className="ping-wheel" style={{ left: anchor.x, top: anchor.y }} aria-hidden="true">
      <div className="ping-wheel-center" />
      {PING_SIGNALS.map((signal, index) => {
        const angle = (index * 360) / PING_SIGNALS.length;
        const meta = PING_META[signal];
        return (
          <div
            key={signal}
            className={`ping-wheel-slice${hovered === index ? " ping-wheel-slice--hovered" : ""}${onCooldown ? " ping-wheel-slice--cooldown" : ""}`}
            style={{ transform: `rotate(${angle}deg) translateY(-${RADIUS_PX}px) rotate(${-angle}deg)` }}
          >
            <span className="ping-wheel-icon">{meta.icon}</span>
            <span className="ping-wheel-label">{meta.label}</span>
          </div>
        );
      })}
    </div>
  );
}
