// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YoutubePlayer, YT_PLAYER_STATE, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakePlayer {
  options: {
    videoId: string;
    width?: string | number;
    height?: string | number;
    playerVars: Record<string, number>;
    events?: {
      onReady?: () => void;
      onAutoplayBlocked?: () => void;
      onPlaybackRateChange?: (event: { data: number; target: { setPlaybackRate: (rate: number) => void } }) => void;
    };
  };
  fireReady: () => void;
  player: Record<string, ReturnType<typeof vi.fn>>;
}

// Like the real IFrame API: the Player exists as soon as it's constructed,
// but its methods are only attached once it becomes ready.
function installFakeYouTube(): FakePlayer[] {
  const created: FakePlayer[] = [];
  class Player {
    constructor(element: HTMLElement, options: FakePlayer["options"]) {
      const iframe = document.createElement("iframe");
      element.replaceWith(iframe);
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
            setPlaybackRate: vi.fn(),
            setSize: vi.fn(),
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
  let resizeObservers: { fire: () => void; observe: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
  const ref = createRef<YoutubePlayerHandle>();

  async function render(videoId: string | null, onReady?: () => void, onSettingsClosed?: () => void) {
    await act(async () => root.render(createElement(YoutubePlayer, { ref, videoId, onReady, onSettingsClosed })));
  }
  const unmuteButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enable sound"));

  beforeEach(() => {
    resizeObservers = [];
    vi.stubGlobal("ResizeObserver", class {
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(readonly fire: () => void) {
        resizeObservers.push(this);
      }
    });
    created = installFakeYouTube();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as { YT?: unknown }).YT;
    vi.unstubAllGlobals();
  });

  it("resizes the ready video with its container without recreating or restarting playback", async () => {
    await render("firstSong01");
    expect(created[0].options).toMatchObject({ width: "100%", height: "100%" });
    expect(resizeObservers).toHaveLength(0);
    const screen = container.querySelector(".youtube-player-screen")!;
    const bounds = vi.spyOn(screen, "getBoundingClientRect").mockReturnValue({ width: 960, height: 540 } as DOMRect);
    act(() => created[0].fireReady());
    const { player } = created[0];
    expect(resizeObservers[0].observe).toHaveBeenCalledWith(screen);
    expect(player.setSize).toHaveBeenLastCalledWith(960, 540);

    for (const [width, height] of [[1280, 720], [640, 360], [1920, 1080]]) {
      bounds.mockReturnValue({ width, height } as DOMRect);
      resizeObservers[0].fire();
      expect(player.setSize).toHaveBeenLastCalledWith(width, height);
    }
    resizeObservers[0].fire();
    bounds.mockReturnValue({ width: 0, height: 0 } as DOMRect);
    resizeObservers[0].fire();
    expect(player.setSize).toHaveBeenCalledTimes(4);
    expect(created).toHaveLength(1);
    expect(player.loadVideoById).not.toHaveBeenCalled();
    expect(player.seekTo).not.toHaveBeenCalled();
    expect(player.playVideo).not.toHaveBeenCalled();

    act(() => root.render(null));
    expect(resizeObservers[0].disconnect).toHaveBeenCalledOnce();
  });

  // Regression: the handle talked to the player as soon as it was
  // constructed, so the drift polls threw "getPlayerState is not a
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

  it("disables direct iframe interaction while keeping local unmute available", async () => {
    await render("firstSong01");
    act(() => created[0].fireReady());

    expect(created[0].options.playerVars).toMatchObject({ controls: 1, disablekb: 1, fs: 0 });
    expect(container.querySelector(".youtube-player-screen")?.hasAttribute("inert")).toBe(true);
    expect(unmuteButton()!.closest("[inert]")).toBeNull();
    act(() => unmuteButton()!.click());
    expect(created[0].player.unMute).toHaveBeenCalledOnce();
    // "Enable sound" itself is gone once unmuted — only the always-present
    // Fullscreen toggle (unrelated to mute state) remains in that row.
    expect(unmuteButton()).toBeUndefined();
    expect(container.querySelectorAll(".player-fallback-row button")).toHaveLength(1);
    expect(created[0].player.mute).not.toHaveBeenCalled();
    expect(created[0].player.playVideo).not.toHaveBeenCalled();
  });

  it("locks the iframe before resync, removes its focus, and stays locked until settings reopen", async () => {
    const resync = vi.fn(() => {
      const iframe = container.querySelector("iframe")!;
      expect(iframe.inert).toBe(true);
      expect(iframe.tabIndex).toBe(-1);
      expect(iframe.style.pointerEvents).toBe("none");
      expect(document.activeElement).not.toBe(iframe);
    });
    await render("firstSong01", undefined, resync);
    const toggle = () => container.querySelector<HTMLButtonElement>(".player-settings-row button")!;
    const screen = () => container.querySelector(".youtube-player-screen")!;
    const iframe = container.querySelector("iframe")!;
    expect(toggle().disabled).toBe(true);
    act(() => created[0].fireReady());
    expect(toggle().disabled).toBe(false);
    expect(iframe.tabIndex).toBe(-1);
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen().hasAttribute("inert")).toBe(false);
    expect(iframe.inert).toBe(false);
    expect(iframe.style.pointerEvents).toBe("auto");
    expect(iframe.tabIndex).toBe(0);
    iframe.focus();
    expect(document.activeElement).toBe(iframe);
    expect(resync).not.toHaveBeenCalled();
    act(() => toggle().click());
    expect(resync).toHaveBeenCalledOnce();
    expect(screen().hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggle());
    await render("firstSong01", undefined, resync);
    expect(iframe.style.pointerEvents).toBe("none");
    expect(toggle().textContent).toBe("⚙ Quality / subtitles");
    expect(created).toHaveLength(1);
    expect(created[0].player.loadVideoById).not.toHaveBeenCalled();
    expect(created[0].player.destroy).not.toHaveBeenCalled();
    act(() => toggle().click());
    expect(iframe.style.pointerEvents).toBe("auto");
    expect(iframe.inert).toBe(false);
  });

  it("locks settings again on track change or when the queue ends", async () => {
    await render("firstSong01");
    act(() => created[0].fireReady());
    act(() => container.querySelector<HTMLButtonElement>(".player-settings-row button")!.click());
    await render("nextSong001");
    expect(container.querySelector(".youtube-player-screen")!.hasAttribute("inert")).toBe(true);
    act(() => container.querySelector<HTMLButtonElement>(".player-settings-row button")!.click());
    await render(null);
    expect(container.querySelector(".youtube-player-screen")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".player-settings-row button")!.disabled).toBe(true);
  });

  it("keeps settings independent between player instances", async () => {
    await act(async () => root.render(createElement("div", null,
      createElement(YoutubePlayer, { videoId: "firstSong01" }),
      createElement(YoutubePlayer, { videoId: "firstSong01" }),
    )));
    act(() => created.forEach((player) => player.fireReady()));
    const toggles = container.querySelectorAll<HTMLButtonElement>(".player-settings-row button");
    act(() => toggles[0].click());
    const screens = container.querySelectorAll(".youtube-player-screen");
    expect(screens[0].hasAttribute("inert")).toBe(false);
    expect(screens[1].hasAttribute("inert")).toBe(true);
    expect(screens[0].id).not.toBe(screens[1].id);
    expect(created[1].player.playVideo).not.toHaveBeenCalled();
    expect(created[1].player.seekTo).not.toHaveBeenCalled();
  });

  it("resets accidental native speed changes so room timing stays at normal speed", async () => {
    await render("firstSong01");
    act(() => created[0].fireReady());
    const setPlaybackRate = vi.fn<(rate: number) => void>();
    created[0].player.setPlaybackRate = setPlaybackRate;
    act(() => created[0].options.events?.onPlaybackRateChange?.({ data: 2, target: { setPlaybackRate } }));
    expect(setPlaybackRate).toHaveBeenCalledWith(1);
    setPlaybackRate.mockClear();
    act(() => created[0].options.events?.onPlaybackRateChange?.({ data: 1, target: { setPlaybackRate } }));
    expect(setPlaybackRate).not.toHaveBeenCalled();
  });

  it("offers a user gesture when autoplay is blocked, but removes it when the room pauses or ends", async () => {
    await render("firstSong01");
    act(() => created[0].fireReady());
    const enableButton = () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Enable playback"));

    act(() => created[0].options.events?.onAutoplayBlocked?.());
    expect(enableButton()).toBeDefined();
    act(() => enableButton()!.click());
    expect(created[0].player.playVideo).toHaveBeenCalledOnce();

    act(() => ref.current!.pauseVideo());
    act(() => created[0].options.events?.onAutoplayBlocked?.());
    expect(enableButton()).toBeUndefined();

    act(() => ref.current!.playVideo());
    act(() => created[0].options.events?.onAutoplayBlocked?.());
    expect(enableButton()).toBeDefined();
    await render(null);
    act(() => created[0].options.events?.onAutoplayBlocked?.());
    expect(enableButton()).toBeUndefined();
    expect(created[0].player.stopVideo).toHaveBeenCalledOnce();
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
