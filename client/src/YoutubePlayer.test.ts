// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YoutubePlayer, YT_PLAYER_STATE, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakePlayer {
  options: { videoId: string; playerVars: Record<string, number>; events?: { onReady?: () => void } };
  fireReady: () => void;
  player: Record<string, ReturnType<typeof vi.fn>>;
}

// Like the real IFrame API: the Player exists as soon as it's constructed,
// but its methods are only attached once it becomes ready.
function installFakeYouTube(): FakePlayer[] {
  const created: FakePlayer[] = [];
  class Player {
    constructor(_el: HTMLElement, options: FakePlayer["options"]) {
      const player = this as unknown as FakePlayer["player"];
      created.push({
        options,
        player,
        fireReady: () => {
          Object.assign(player, {
            getPlayerState: vi.fn(() => YT_PLAYER_STATE.PLAYING),
            getCurrentTime: vi.fn(() => 12),
            getDuration: vi.fn(() => 200),
            seekTo: vi.fn(),
            playVideo: vi.fn(),
            pauseVideo: vi.fn(),
            stopVideo: vi.fn(),
            loadVideoById: vi.fn(),
            mute: vi.fn(),
            unMute: vi.fn(),
            destroy: vi.fn(),
          });
          options.events?.onReady?.();
        },
      });
    }
  }
  (window as unknown as { YT: unknown }).YT = { Player, PlayerState: {} };
  return created;
}

describe("YoutubePlayer", () => {
  let container: HTMLDivElement;
  let root: Root;
  let created: FakePlayer[];
  const ref = createRef<YoutubePlayerHandle>();

  async function render(videoId: string | null, onReady?: () => void) {
    await act(async () => root.render(createElement(YoutubePlayer, { ref, videoId, onReady })));
  }
  const unmuteButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("unmute"));

  beforeEach(() => {
    created = installFakeYouTube();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { YT?: unknown }).YT;
  });

  // Regression: the handle talked to the player as soon as it was
  // constructed, so the drift/echo polls threw "getPlayerState is not a
  // function" every second until the IFrame API finished loading it.
  it("treats a not-yet-ready player as absent, then hands commands to it once ready", async () => {
    const onReady = vi.fn();
    await render("dQw4w9WgXcQ", onReady);
    expect(created).toHaveLength(1);

    expect(() => ref.current!.getPlayerState()).not.toThrow();
    expect(ref.current!.getPlayerState()).toBe(YT_PLAYER_STATE.UNSTARTED);
    expect(ref.current!.getVideoId()).toBeNull();
    expect(() => ref.current!.seekTo(5)).not.toThrow();
    expect(onReady).not.toHaveBeenCalled();

    act(() => created[0].fireReady());

    expect(onReady).toHaveBeenCalledOnce();
    expect(ref.current!.getPlayerState()).toBe(YT_PLAYER_STATE.PLAYING);
    expect(ref.current!.getVideoId()).toBe("dQw4w9WgXcQ");
    ref.current!.seekTo(5);
    expect(created[0].player.seekTo).toHaveBeenCalledWith(5, true);
  });

  // Regression: every track change destroyed the player and made a fresh
  // one, which has to start muted to autoplay — so the listener had to tap
  // "unmute" again for every single song.
  it("keeps one player across track changes, so unmuting once is enough", async () => {
    const onReady = vi.fn();
    await render("firstSong01", onReady);
    act(() => created[0].fireReady());
    expect(created[0].options.playerVars.mute).toBe(1);

    act(() => unmuteButton()!.click());
    expect(created[0].player.unMute).toHaveBeenCalledOnce();
    expect(unmuteButton()).toBeUndefined();

    await render("nextSong001", onReady);

    expect(created).toHaveLength(1); // no new, muted player
    expect(created[0].player.loadVideoById).toHaveBeenCalledWith("nextSong001");
    expect(created[0].player.mute).not.toHaveBeenCalled();
    expect(unmuteButton()).toBeUndefined();
    expect(ref.current!.getVideoId()).toBe("nextSong001");
    expect(onReady).toHaveBeenCalledTimes(2); // the sync layer re-anchors on the new song
  });

  it("stops the same player when nothing is playing, then reuses it for the next song", async () => {
    await render("firstSong01");
    act(() => created[0].fireReady());

    await render(null);
    expect(created[0].player.stopVideo).toHaveBeenCalledOnce();
    expect(ref.current!.getVideoId()).toBeNull();

    await render("laterSong01");
    expect(created).toHaveLength(1);
    expect(created[0].player.loadVideoById).toHaveBeenCalledWith("laterSong01");
  });

  it("loads the newest song if it changed while the player was still getting ready", async () => {
    await render("firstSong01");
    await render("secondSong1");
    expect(created).toHaveLength(1);

    act(() => created[0].fireReady());

    expect(created[0].player.loadVideoById).toHaveBeenCalledWith("secondSong1");
    expect(ref.current!.getVideoId()).toBe("secondSong1");
  });

  it("can be torn down before its player was ever ready", async () => {
    await render("dQw4w9WgXcQ");
    expect(() => act(() => root.unmount())).not.toThrow();
    root = createRoot(container); // for afterEach
  });
});
