// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybackState, RoomSnapshot } from "../../shared/src/types.ts";
import { usePlaybackSync } from "./usePlaybackSync.ts";
import { YT_PLAYER_STATE, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

// A stand-in socket: records what the hook emits and lets a test deliver
// server events by name, with no network involved.
const socket = vi.hoisted(() => ({
  handlers: new Map<string, (payload?: unknown) => void>(),
  emitted: [] as { event: string; payload: unknown }[],
}));

vi.mock("socket.io-client", () => ({
  io: () => ({
    on: (event: string, handler: (payload?: unknown) => void) => socket.handlers.set(event, handler),
    emit: (event: string, payload: unknown) => socket.emitted.push({ event, payload }),
    disconnect: () => {},
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Mirrors YoutubePlayer's handle before and after the IFrame player exists:
// until `ready`, every command is silently dropped, exactly like the real
// handle's `playerRef.current?.…` calls against a player not yet created.
function fakePlayer() {
  const player = {
    ready: false,
    state: YT_PLAYER_STATE.UNSTARTED as number,
    durationSeconds: 0,
    loadedVideoId: "dQw4w9WgXcQ",
    commands: [] as string[],
    handle: {} as YoutubePlayerHandle,
  };
  const command = (name: string) => (arg?: number) => {
    if (player.ready) player.commands.push(arg === undefined ? name : `${name}(${Math.round(arg)})`);
  };
  player.handle = {
    playVideo: command("play"),
    pauseVideo: command("pause"),
    seekTo: command("seekTo"),
    loadVideoById: (_id: string, start?: number) => command("load")(start),
    getCurrentTime: () => 0,
    getDuration: () => (player.ready ? player.durationSeconds : 0),
    getVideoId: () => (player.ready ? player.loadedVideoId : null),
    getPlayerState: () => player.state,
  };
  return player;
}

function playback(overrides: Partial<PlaybackState>): PlaybackState {
  return {
    playbackId: "playback-1",
    queueItemId: "item-1",
    videoId: "dQw4w9WgXcQ",
    title: "Song",
    channelTitle: "Channel",
    thumbnailUrl: "",
    durationMs: null,
    startedAt: new Date(0).toISOString(),
    status: "PLAYING",
    anchorPositionMs: 0,
    anchorServerTimeMs: Date.now(),
    revision: 1,
    dj: { accountId: "acct-dj", displayName: "DJ" },
    ...overrides,
  };
}

function snapshot(current: PlaybackState): RoomSnapshot {
  return {
    room: {
      roomId: "room-1",
      name: "Room",
      creatorAccountId: "acct-dj",
      visibility: "PUBLIC",
      code: null,
      maxUsers: 12,
      autoCloseEnabled: false,
      createdAt: new Date(0).toISOString(),
      lastMeaningfulActivityAt: new Date(0).toISOString(),
      closed: false,
    },
    queue: [],
    presence: [],
    activeProposal: null,
    playback: current,
    reactionHistory: [],
  };
}

describe("usePlaybackSync", () => {
  let root: Root;
  let hook: ReturnType<typeof usePlaybackSync>;
  let player: ReturnType<typeof fakePlayer>;

  beforeEach(() => {
    socket.handlers.clear();
    socket.emitted.length = 0;
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
    player = fakePlayer();
    const playerRef = { current: player.handle };

    function Harness() {
      hook = usePlaybackSync("room-1", "acct-me", "client-me", playerRef);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root.render(createElement(Harness)));
    act(() => socket.handlers.get("connect")!());
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  function deliver(event: string, payload: unknown): void {
    act(() => socket.handlers.get(event)!(payload));
  }

  // Regression: the snapshot lands before the late joiner's player exists,
  // so the seek/pause it triggered were dropped and the new player simply
  // autoplayed from 0 — into a PAUSED room, which the drift loop (PLAYING
  // only) never corrected.
  it("once the player is ready, parks a late joiner at a PAUSED room's anchor instead of letting it autoplay", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PAUSED", anchorPositionMs: 42_000 })));
    expect(player.commands).toEqual([]);

    player.ready = true;
    act(() => hook.handlePlayerReady());

    expect(player.commands).toEqual(["pause", "seekTo(42)"]);
  });

  // Regression: with the room PAUSED (e.g. after a server restart), pressing
  // YouTube's own play button played the track locally to the end while the
  // room never moved — it looked like the room had stopped advancing.
  it("puts a player that starts playing in a PAUSED room straight back where the room is", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PAUSED", anchorPositionMs: 42_000 })));
    player.ready = true;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));

    expect(player.commands).toEqual(["pause", "seekTo(42)"]);
    expect(socket.emitted.some((e) => e.event === "playback:ended")).toBe(false);
  });

  it("leaves a player alone when it plays in a PLAYING room", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PLAYING" })));
    player.ready = true;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));

    expect(player.commands).toEqual([]);
  });

  it("once the player is ready, jumps a late joiner to where a PLAYING room is now", () => {
    deliver(
      "room:snapshot",
      snapshot(playback({ status: "PLAYING", anchorPositionMs: 5_000, anchorServerTimeMs: Date.now() - 10_000 })),
    );

    player.ready = true;
    act(() => hook.handlePlayerReady());

    expect(player.commands).toEqual(["seekTo(15)", "play"]);
  });

  // Regression: any ENDED from the local player was reported, so dragging
  // YouTube's own scrubber to the end skipped the track for the whole room.
  it("does not report an end the room's anchor says can't have happened, and snaps the player back instead", () => {
    deliver("room:snapshot", snapshot(playback({ durationMs: 200_000, anchorServerTimeMs: Date.now() - 30_000 })));
    player.ready = true;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted.some((e) => e.event === "playback:ended")).toBe(false);
    expect(player.commands).toEqual(["seekTo(30)", "play"]);
  });

  // The server usually has no length now (oEmbed reports none), so the
  // local player's own length is what lets an honest client snap back.
  it("uses the local player's own length when the server doesn't know the track's", () => {
    deliver("room:snapshot", snapshot(playback({ durationMs: null, anchorServerTimeMs: Date.now() - 30_000 })));
    player.ready = true;
    player.durationSeconds = 200;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted.some((e) => e.event === "playback:ended")).toBe(false);
    expect(player.commands).toEqual(["seekTo(30)", "play"]);
  });

  it("reports an end of a track neither side knows the length of — the server then asks for a majority", () => {
    deliver("room:snapshot", snapshot(playback({ durationMs: null, anchorServerTimeMs: Date.now() - 30_000 })));

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
  });

  it("reports a genuine end, once the room's anchor has reached the track's length", () => {
    deliver("room:snapshot", snapshot(playback({ durationMs: 200_000, anchorServerTimeMs: Date.now() - 199_000 })));

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
  });

  it("reports a room that closed under it the same way as a failed join", () => {
    deliver("room:snapshot", snapshot(playback({})));
    expect(hook.joinError).toBeNull();

    deliver("room:closed", { roomId: "room-1" });

    expect(hook.joinError).toMatch(/closed/);
    expect(hook.connected).toBe(false);
  });

  it("never aims an anchor at a video other than the room's, e.g. the one still loaded mid-track-change", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PLAYING" })));
    player.ready = true;
    player.loadedVideoId = "previousSong";

    deliver("playback:update", playback({ videoId: "nextSong0001", playbackId: "playback-2", anchorPositionMs: 0 }));
    expect(player.commands).toEqual([]);

    player.loadedVideoId = "nextSong0001"; // the player switched, and says so
    act(() => hook.handlePlayerReady());
    expect(player.commands).toEqual(["seekTo(0)", "play"]);
  });

  it("applies the newest anchor on ready, not the one from the snapshot", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PLAYING" })));
    deliver("playback:update", playback({ status: "PAUSED", anchorPositionMs: 7_000, revision: 2 }));

    player.ready = true;
    act(() => hook.handlePlayerReady());

    expect(player.commands).toEqual(["pause", "seekTo(7)"]);
  });
});
