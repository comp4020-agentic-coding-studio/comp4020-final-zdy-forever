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
  acknowledge: undefined as ((error: Error | null, result?: { ok: boolean; error?: string }) => void) | undefined,
}));

vi.mock("socket.io-client", () => ({
  io: () => ({
    connected: true,
    timeout: () => ({ emit: (event: string, payload: unknown, acknowledge: typeof socket.acknowledge) => {
      socket.emitted.push({ event, payload });
      socket.acknowledge = acknowledge;
    } }),
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
    chatMessages: [],
  };
}

describe("usePlaybackSync", () => {
  let root: Root;
  let hook: ReturnType<typeof usePlaybackSync>;
  let player: ReturnType<typeof fakePlayer>;

  beforeEach(() => {
    vi.useFakeTimers();
    socket.handlers.clear();
    socket.emitted.length = 0;
    socket.acknowledge = undefined;
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
    vi.useRealTimers();
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

    // Never-rendered video: seeks and plays first rather than pausing
    // straight away (see the next test for why), then parks once the real
    // player confirms it actually painted a frame there.
    expect(player.commands).toEqual(["seekTo(42)", "play"]);
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    expect(player.commands).toEqual(["seekTo(42)", "play", "pause"]);
  });

  // Regression: pausing a video the player has never actually played (a
  // fresh load, straight to a PAUSED anchor) can leave YouTube's canvas
  // solid black — it has no decoded frame to show yet, and seeking alone
  // doesn't force one. This is exactly what a sole listener hits returning
  // to an empty room after the server (or a scale-to-zero Fly machine) has
  // restarted and recovered the track as PAUSED.
  it("never leaves a never-played video paused on a blank frame — it plays briefly first, then parks", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PAUSED", anchorPositionMs: 42_000 })));
    player.ready = true;
    act(() => hook.handlePlayerReady());
    expect(player.commands).toEqual(["seekTo(42)", "play"]);

    // The real IFrame API wouldn't confirm PLAYING instantly; nothing else
    // should happen until it does.
    act(() => vi.advanceTimersByTime(500));
    expect(player.commands).toEqual(["seekTo(42)", "play"]);

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    expect(player.commands).toEqual(["seekTo(42)", "play", "pause"]);
  });

  it("pauses a video that was already rendering immediately, with no play-flash nudge needed", () => {
    deliver("room:snapshot", snapshot(playback({ status: "PLAYING", anchorPositionMs: 0 })));
    player.ready = true;
    act(() => hook.handlePlayerReady());
    expect(player.commands).toEqual(["seekTo(0)", "play"]);
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    player.commands.length = 0;

    deliver("playback:update", playback({ status: "PAUSED", anchorPositionMs: 42_000, revision: 2 }));

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

  it("stops playback when the last queued track ends and rejects a local replay", () => {
    player.ready = true;
    deliver("room:snapshot", snapshot(playback({ durationMs: 200_000, anchorServerTimeMs: Date.now() - 200_000 })));
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));
    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
    player.commands.length = 0;

    deliver("playback:update", null);
    expect(player.commands).toEqual(["pause"]);
    expect(hook.playback).toBeNull();
    player.commands.length = 0;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    expect(player.commands).toEqual(["pause"]);

    player.commands.length = 0;
    deliver("playback:update", playback({ playbackId: "playback-2" }));
    expect(player.commands).toEqual(["seekTo(0)", "play"]);
  });

  it("catches a local replay after the queue ends even if the state event was missed", () => {
    player.ready = true;
    deliver("playback:update", null);
    player.commands.length = 0;
    player.state = YT_PLAYER_STATE.PLAYING;

    act(() => vi.advanceTimersByTime(2_000));

    expect(player.commands).toContain("pause");
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
    player.ready = true;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
  });

  it("reports a genuine end, once the room's anchor has reached the track's length", () => {
    deliver("room:snapshot", snapshot(playback({ durationMs: 200_000, anchorServerTimeMs: Date.now() - 199_000 })));
    player.ready = true;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));

    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
  });

  it("holds a finished video while awaiting the server, including repeated ready and play events", () => {
    player.ready = true;
    player.durationSeconds = 160;
    deliver("room:snapshot", snapshot(playback({ anchorServerTimeMs: Date.now() - 159_000 })));
    player.commands.length = 0;

    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));
    act(() => hook.handlePlayerReady()); // Closing local settings must not restart it.
    player.state = YT_PLAYER_STATE.PLAYING;
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    act(() => vi.advanceTimersByTime(12_000));

    expect(player.commands.length).toBeGreaterThan(0);
    expect(player.commands.every((command) => command === "pause")).toBe(true);
    expect(socket.emitted.filter((e) => e.event === "playback:ended")).toHaveLength(1);
    expect(hook.playback?.playbackId).toBe("playback-1"); // Server remains authoritative.
  });

  it("does not seek or load beyond the duration when joining an already finished track", () => {
    player.ready = true;
    player.durationSeconds = 160;
    deliver("room:snapshot", snapshot(playback({ anchorServerTimeMs: Date.now() - 329_000 })));

    expect(player.commands).toEqual(["pause"]);
    expect(socket.emitted).toContainEqual({ event: "playback:ended", payload: { playbackId: "playback-1" } });
  });

  it("recovers the 0:00 replay loop when duration becomes available after the initial anchor", () => {
    player.ready = true;
    deliver("room:snapshot", snapshot(playback({ anchorServerTimeMs: Date.now() - 329_000 })));
    player.commands.length = 0;
    player.durationSeconds = 160;
    player.state = YT_PLAYER_STATE.PLAYING;

    act(() => vi.advanceTimersByTime(12_000));

    expect(player.commands.length).toBeGreaterThan(0);
    expect(player.commands.every((command) => command === "pause")).toBe(true);
    expect(socket.emitted.filter((e) => e.event === "playback:ended")).toHaveLength(1);
  });

  it("recovers a missed ENDED event through the local poll", () => {
    player.ready = true;
    player.durationSeconds = 160;
    deliver("room:snapshot", snapshot(playback({ anchorServerTimeMs: Date.now() - 159_000 })));
    player.state = YT_PLAYER_STATE.ENDED;
    player.commands.length = 0;

    act(() => vi.advanceTimersByTime(4_000));

    expect(player.commands.every((command) => command === "pause")).toBe(true);
    expect(socket.emitted.filter((e) => e.event === "playback:ended")).toHaveLength(1);
  });

  it("allows an authoritative seek and a new playback of the same video after finishing", () => {
    player.ready = true;
    player.durationSeconds = 160;
    deliver("room:snapshot", snapshot(playback({ anchorServerTimeMs: Date.now() - 160_000 })));
    player.commands.length = 0;

    deliver("playback:update", playback({ revision: 2, anchorPositionMs: 20_000 }));
    expect(player.commands).toEqual(["seekTo(20)", "play"]);

    deliver("playback:update", playback({ revision: 3, anchorPositionMs: 160_000 }));
    player.commands.length = 0;
    deliver("playback:update", playback({ playbackId: "playback-2" }));
    expect(player.commands).toEqual(["seekTo(0)", "play"]);
  });

  it("resends an end report after reconnect without replaying the finished video", () => {
    player.ready = true;
    player.durationSeconds = 160;
    const current = playback({ anchorServerTimeMs: Date.now() - 160_000 });
    deliver("room:snapshot", snapshot(current));
    player.commands.length = 0;
    deliver("disconnect", undefined);
    deliver("connect", undefined);
    deliver("room:snapshot", snapshot(current));

    expect(player.commands).toEqual(["pause"]);
    expect(socket.emitted.filter((e) => e.event === "playback:ended")).toHaveLength(2);
  });

  it("ignores an old video's end and drift while switching tracks", () => {
    player.ready = true;
    player.durationSeconds = 160;
    deliver("room:snapshot", snapshot(playback({ videoId: "nextSong0001", playbackId: "playback-2", anchorServerTimeMs: Date.now() - 200_000 })));
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.ENDED));
    player.state = YT_PLAYER_STATE.PLAYING;
    act(() => vi.advanceTimersByTime(6_000));

    expect(player.commands).toEqual([]);
    expect(socket.emitted.filter((e) => e.event === "playback:ended")).toEqual([]);
  });

  it("requests replay by stable queue item id and waits for authoritative playback", () => {
    deliver("playback:update", null);
    player.commands.length = 0;
    act(() => hook.requestReplayQueueProposal("item-2"));
    expect(socket.emitted.at(-1)).toEqual({
      event: "proposal:request", payload: { type: "REPLAY_QUEUE_ITEM", queueItemId: "item-2" },
    });
    expect(hook.playback).toBeNull();
    expect(player.commands).toEqual([]);
  });

  it("waits for the server's DJ handoff before completing a room exit", () => {
    player.ready = true;
    deliver("room:snapshot", snapshot(playback({})));
    act(() => hook.requestLeaveRoom());
    expect(socket.emitted.at(-1)?.event).toBe("room:leave");
    expect(hook.leftRoom).toBe(false);
    const handoff = { requestId: "handoff-1", expiresAt: Date.now() + 10_000 };
    deliver("dj:handoff", handoff);
    expect(hook.djHandoff).toEqual(handoff);
    act(() => hook.chooseNextDj(handoff.requestId, "bob"));
    expect(socket.emitted.at(-1)).toEqual({ event: "dj:choose", payload: { requestId: "handoff-1", accountId: "bob" } });
    deliver("room:leaveError", { error: "Member left" });
    expect(hook.leaveError).toBe("Member left");
    deliver("room:left", { roomId: "other-room" });
    expect(hook.leftRoom).toBe(false);
    deliver("room:left", { roomId: "room-1" });
    expect(hook.leftRoom).toBe(true);
    expect(hook.djHandoff).toBeNull();
    expect(hook.playback).toBeNull();
    expect(player.commands.at(-1)).toBe("pause");
  });

  it("loads chat on join, deduplicates broadcasts, ignores other rooms and clears it on closure", () => {
    const message = { messageId: "m1", roomId: "room-1", accountId: "alice", displayName: "Alice", text: "hi", createdAt: new Date().toISOString() };
    deliver("room:snapshot", { ...snapshot(playback({})), chatMessages: [message] });
    deliver("chat:new", message);
    deliver("chat:new", { ...message, messageId: "m2", roomId: "other" });
    expect(hook.chatMessages).toEqual([message]);
    deliver("chat:new", { ...message, messageId: "m3", text: "hello" });
    expect(hook.chatMessages).toHaveLength(2);
    deliver("room:closed", { roomId: "room-1" });
    deliver("chat:new", { ...message, messageId: "late" });
    expect(hook.chatMessages).toEqual([]);
    expect(hook.playback).toBeNull();
  });

  it("uses server acknowledgement for sends and exposes failure without inventing a message", async () => {
    deliver("room:snapshot", snapshot(playback({})));
    let sent!: Promise<boolean>;
    act(() => { sent = hook.sendChatMessage("hello"); });
    expect(socket.emitted.at(-1)).toEqual({ event: "chat:send", payload: { text: "hello" } });
    await act(async () => { socket.acknowledge!(null, { ok: false, error: "slow down" }); });
    expect(await sent).toBe(false);
    expect(hook.chatError).toBe("slow down");
    expect(hook.chatMessages).toEqual([]);
    act(() => { sent = hook.sendChatMessage("hello"); });
    await act(async () => { socket.acknowledge!(null, { ok: true }); });
    expect(await sent).toBe(true);
    expect(hook.chatError).toBeNull();
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

    expect(player.commands).toEqual(["seekTo(7)", "play"]);
    act(() => hook.handlePlayerStateChange(YT_PLAYER_STATE.PLAYING));
    expect(player.commands).toEqual(["seekTo(7)", "play", "pause"]);
  });
});
