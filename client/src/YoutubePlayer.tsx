import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Minimal ambient shape of the bits of the official YouTube IFrame Player
// API (developers.google.com/youtube/iframe_api_reference) this component
// actually uses — not exhaustive by design. loadVideoById is what a "hard
// resync" (see shared/src/playbackSync.ts's DRIFT_HARD_RESYNC_MS tier) uses
// to reload the video rather than merely seeking a player that's fallen too
// far behind to look like it's "catching up".
interface YouTubePlayerInstance {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  setPlaybackRate(rate: number): void;
  setSize(width: number, height: number): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  stopVideo(): void;
  destroy(): void;
}

interface YouTubePlayerEvent {
  target: YouTubePlayerInstance;
  data?: number;
}

interface YouTubeIframeApi {
  Player: new (
    element: HTMLElement,
    options: {
      videoId: string;
      width?: string | number;
      height?: string | number;
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (e: YouTubePlayerEvent) => void;
        onStateChange?: (e: YouTubePlayerEvent) => void;
        onError?: (e: YouTubePlayerEvent) => void;
        onAutoplayBlocked?: () => void;
        onPlaybackRateChange?: (e: YouTubePlayerEvent) => void;
      };
    },
  ) => YouTubePlayerInstance;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; CUED: number; BUFFERING: number; UNSTARTED: number };
}

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// developers.google.com/youtube/iframe_api_reference#onStateChange — stable
// numeric codes, safe to hardcode rather than wait for the API to load.
export const YT_PLAYER_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

let apiLoadPromise: Promise<YouTubeIframeApi> | null = null;

// Loads the IFrame API script at most once per page load, however many
// <YoutubePlayer> instances mount — the script calls
// window.onYouTubeIframeAPIReady globally, once, not per <script> tag.
function loadYoutubeIframeApi(): Promise<YouTubeIframeApi> {
  if (window.YT) return Promise.resolve(window.YT);
  if (apiLoadPromise) return apiLoadPromise;

  apiLoadPromise = new Promise((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT as YouTubeIframeApi);
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });
  return apiLoadPromise;
}

// developers.google.com/youtube/iframe_api_reference#onError
const ERROR_MESSAGES: Record<number, string> = {
  2: "That video link isn't valid.",
  5: "This video can't be played in this browser.",
  100: "This video was removed or made private.",
  101: "The video owner doesn't allow it to be played on other sites.",
  150: "The video owner doesn't allow it to be played on other sites.",
};

// The imperative control surface a sync layer (see usePlaybackSync.ts) uses
// to apply a server-authoritative anchor to the local player, without the
// component itself knowing anything about rooms, sockets, or anchors.
export interface YoutubePlayerHandle {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number): void;
  getCurrentTime(): number;
  // The loaded video's length in seconds, or 0 until the player knows it.
  getDuration(): number;
  getPlayerState(): number;
  // Which video the ready player has loaded, or null (not ready, or none).
  getVideoId(): string | null;
  loadVideoById(videoId: string, startSeconds?: number): void;
}

export interface YoutubePlayerProps {
  videoId: string | null;
  // Local viewing settings never become room state. Reapply the latest room
  // anchor after the user finishes interacting with YouTube's native menu.
  onSettingsClosed?: () => void;
  // Relayed verbatim from the IFrame API's onStateChange — a sync layer
  // uses this to know when to suspend/resume its local drift-correction
  // poll (never while BUFFERING/CUED/ENDED/UNSTARTED) and to time its
  // post-transition grace period.
  onStateChange?: (state: number) => void;
  // Fired whenever the player can take commands for a newly loaded video:
  // once it's first ready, and again after each switch to another video.
  // Anything a sync layer tried to apply before then (e.g. a late joiner's
  // snapshot, which usually arrives before the player exists) was a silent
  // no-op or aimed at the previous video, so this is its cue to apply the
  // current anchor again.
  onReady?: () => void;
  // Where to portal the quality/subtitles toggle button — its parent wants
  // it sitting in its own header (e.g. top-right of "Now playing") rather
  // than in this component's own layout. Falls back to a plain row above
  // the viewport when not given, so standalone usage (and this component's
  // own tests) keep working without one.
  settingsSlot?: HTMLElement | null;
  // Rendered top-right, inside the black video frame itself (unlike
  // settingsSlot above, this never needs to escape to a different part of
  // the page, so it's a plain node rather than a portal target).
  topRightOverlay?: ReactNode;
}

// Always rendered, with or without a videoId — CLAUDE.md requires the
// player stay visible rather than only mounting once a track exists.
//
// One IFrame player serves the whole page: it's created for the first video
// and then switched with loadVideoById, never torn down and recreated per
// track. A fresh player has to start muted (browsers only autoplay muted
// video), so recreating one on every track change meant tapping "unmute"
// again for every single song. Mute is a property of the player, so keeping
// the one player keeps the listener's choice.
function setPlayerInteraction(container: HTMLDivElement | null, enabled: boolean): void {
  if (!container) return;
  container.inert = !enabled;
  container.style.pointerEvents = enabled ? "auto" : "none";
  const iframe = container.querySelector("iframe");
  if (!iframe) return;
  iframe.inert = !enabled;
  iframe.tabIndex = enabled ? 0 : -1;
  iframe.style.pointerEvents = enabled ? "auto" : "none";
  if (!enabled && document.activeElement === iframe) iframe.blur();
}

export const YoutubePlayer = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function YoutubePlayer(
  { videoId, onStateChange, onReady, onSettingsClosed, settingsSlot, topRightOverlay },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // The outer black frame (never inert, unlike containerRef above) — what
  // actually goes fullscreen, so the toggle button itself (and Share, when
  // present) stays reachable while fullscreen rather than disappearing along
  // with an inert inner screen.
  const playerBoxRef = useRef<HTMLDivElement>(null);
  const screenId = useId();
  const [isReady, setIsReady] = useState(false);
  const [settingsVideoId, setSettingsVideoId] = useState<string | null>(null);
  const settingsOpen = videoId !== null && settingsVideoId === videoId;
  // Only ever a *ready* player: its methods (getPlayerState, seekTo, ...)
  // only exist once the IFrame API fires onReady, and calling one earlier
  // throws "... is not a function". Until then every handle command is a
  // silent no-op.
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const instanceRef = useRef<YouTubePlayerInstance | null>(null);
  // The videoId the parent wants now, and the one the ready player has.
  const wantedVideoIdRef = useRef(videoId);
  const loadedVideoIdRef = useRef<string | null>(null);
  // Bumped on unmount, so a player creation still waiting on the API script
  // knows it's stale (StrictMode mounts, unmounts and remounts in dev).
  const generationRef = useRef(0);
  const creatingRef = useRef(false);
  // Latest callbacks, since the one player outlives any given render.
  const onStateChangeRef = useRef(onStateChange);
  const onReadyRef = useRef(onReady);
  onStateChangeRef.current = onStateChange;
  onReadyRef.current = onReady;

  const [error, setError] = useState<string | null>(null);
  const [needsManualPlay, setNeedsManualPlay] = useState(false);
  // Whether the next non-PLAYING settle should be read as "autoplay was
  // blocked" (see onStateChange below). A deliberate pause through the handle
  // — the room itself being PAUSED — is never that, so it disarms this.
  const autoplayPendingRef = useRef(false);
  // The player starts muted (see the mute: 1 playerVars below) so it can
  // autoplay at all; once the listener unmutes, it stays unmuted for every
  // later track. Purely local: never reported to, or affected by, the
  // server's authoritative anchor.
  const [isMuted, setIsMuted] = useState(true);

  useLayoutEffect(() => {
    // Apply the lock to the API-created iframe too, including its focus and
    // tab order. Its controls must stay inert after a local settings session.
    setPlayerInteraction(containerRef.current, settingsOpen);
  }, [settingsOpen, isReady]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const player = playerRef.current;
    if (!isReady || !container || !player) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      const nextWidth = Math.round(width);
      const nextHeight = Math.round(height);
      if (nextWidth <= 0 || nextHeight <= 0 || (nextWidth === lastWidth && nextHeight === lastHeight)) return;
      lastWidth = nextWidth;
      lastHeight = nextHeight;
      // CSS fits the iframe; the API also updates YouTube's internal video
      // surface, which can otherwise retain its initial 640 × 360 size.
      player.setSize(nextWidth, nextHeight);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    resize();
    return () => observer.disconnect();
  }, [isReady]);

  useImperativeHandle(
    ref,
    () => ({
      playVideo: () => {
        autoplayPendingRef.current = true;
        playerRef.current?.playVideo();
      },
      pauseVideo: () => {
        autoplayPendingRef.current = false;
        setNeedsManualPlay(false);
        playerRef.current?.pauseVideo();
      },
      seekTo: (seconds: number) => playerRef.current?.seekTo(seconds, true),
      getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getDuration: () => playerRef.current?.getDuration() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState() ?? YT_PLAYER_STATE.UNSTARTED,
      getVideoId: () => (playerRef.current ? loadedVideoIdRef.current : null),
      loadVideoById: (id: string, startSeconds?: number) => playerRef.current?.loadVideoById(id, startSeconds),
    }),
    [],
  );

  // Puts the ready player on `id` (or stops it, for null) and tells the sync
  // layer it can apply its anchor to what's now loaded.
  const show = (player: YouTubePlayerInstance, id: string | null) => {
    setError(null);
    setNeedsManualPlay(false);
    if (!id) {
      autoplayPendingRef.current = false;
      loadedVideoIdRef.current = null;
      player.stopVideo();
      return;
    }
    autoplayPendingRef.current = true;
    if (loadedVideoIdRef.current !== id) {
      loadedVideoIdRef.current = id;
      player.loadVideoById(id);
    }
    onReadyRef.current?.();
  };

  useEffect(() => {
    setSettingsVideoId(null);
    wantedVideoIdRef.current = videoId;
    const ready = playerRef.current;
    if (ready) {
      if (videoId !== loadedVideoIdRef.current) show(ready, videoId);
      return;
    }
    if (!videoId || creatingRef.current || !containerRef.current) return;

    creatingRef.current = true;
    autoplayPendingRef.current = true;
    const generation = generationRef.current;
    loadYoutubeIframeApi().then((YT) => {
      if (generation !== generationRef.current || !containerRef.current) return;
      // A host element of its own, since the IFrame API replaces the element
      // it's given with its iframe — never one React is managing.
      const host = document.createElement("div");
      containerRef.current.appendChild(host);
      const firstVideoId = wantedVideoIdRef.current ?? videoId;
      const instance: YouTubePlayerInstance = new YT.Player(host, {
        videoId: firstVideoId,
        width: "100%",
        height: "100%",
        // YouTube no longer supports setPlaybackQuality. Its native menu is
        // needed for quality/caption selection; input stays locked except
        // while this listener explicitly opens their local settings.
        playerVars: { autoplay: 1, playsinline: 1, mute: 1, controls: 1, disablekb: 1, fs: 0 },
        events: {
          onReady: () => {
            if (generation !== generationRef.current) return;
            playerRef.current = instance;
            setIsReady(true);
            loadedVideoIdRef.current = firstVideoId;
            // The wanted video may have changed while this one loaded.
            show(instance, wantedVideoIdRef.current);
          },
          onStateChange: (e) => {
            const state = e.data ?? YT_PLAYER_STATE.UNSTARTED;
            // Many browsers block autoplay outright: no error fires, the
            // player just sits PAUSED/CUED forever. Only the first
            // non-PLAYING settle after a load or a playVideo() counts as
            // "autoplay was blocked" — a legitimate server-driven pause
            // disarms it (see pauseVideo above) and must never trigger this
            // fallback button.
            if (state === YT_PLAYER_STATE.PLAYING) {
              autoplayPendingRef.current = false;
              setNeedsManualPlay(false);
            } else if (
              autoplayPendingRef.current &&
              (state === YT_PLAYER_STATE.PAUSED || state === YT_PLAYER_STATE.CUED)
            ) {
              autoplayPendingRef.current = false;
              setNeedsManualPlay(true);
            }
            onStateChangeRef.current?.(state);
          },
          onAutoplayBlocked: () => {
            if (autoplayPendingRef.current && wantedVideoIdRef.current) {
              autoplayPendingRef.current = false;
              setNeedsManualPlay(true);
            }
          },
          onPlaybackRateChange: (e) => {
            // The native menu also exposes speed. Room synchronization uses
            // normal speed; only quality and captions are local preferences.
            if (e.data !== 1) e.target.setPlaybackRate(1);
          },
          onError: (e) => {
            setPlayerInteraction(containerRef.current, false);
            setSettingsVideoId(null);
            setError(ERROR_MESSAGES[e.data ?? -1] ?? "This video can't be played.");
          },
        },
      });
      instanceRef.current = instance;
    });
    // `show` only touches refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // The one player is torn down only when the component itself goes away.
  useEffect(
    () => () => {
      generationRef.current += 1;
      creatingRef.current = false;
      // Optional call: a player torn down before it was ever ready may not
      // have its methods yet (see playerRef above).
      (instanceRef.current as Partial<YouTubePlayerInstance> | null)?.destroy?.();
      instanceRef.current = null;
      playerRef.current = null;
      loadedVideoIdRef.current = null;
    },
    [],
  );

  // Fullscreens the black frame itself, not the iframe YouTube owns — the
  // frame stays as locked/inert as it already was (see setPlayerInteraction),
  // so going fullscreen can never become a side door around "lock direct
  // YouTube input by default" (CLAUDE.md's Authority section). Known gap:
  // iOS Safari only supports the Fullscreen API on a native <video> element,
  // not an arbitrary div, so this silently does nothing there — there is no
  // official workaround for an embedded IFrame player.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === playerBoxRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void playerBoxRef.current?.requestFullscreen?.().catch(() => {
        // Not supported here (iOS Safari, or a browser blocking it outright)
        // — nothing else to fall back to, so just stay as we were.
      });
    }
  };

  const settingsButton = (
    <button
      type="button"
      className="btn btn--sm player-settings-toggle"
      disabled={!videoId || !isReady || !!error}
      aria-expanded={settingsOpen}
      aria-controls={screenId}
      onClick={(event) => {
        if (settingsOpen) {
          // Lock synchronously BEFORE seeking/playing to the room anchor;
          // React's state update is otherwise committed after the callback.
          setPlayerInteraction(containerRef.current, false);
          event.currentTarget.focus();
          setSettingsVideoId(null);
          onSettingsClosed?.();
        } else {
          setSettingsVideoId(videoId);
        }
      }}
    >
      {settingsOpen ? "Done · sync with room" : "⚙ Quality / subtitles"}
    </button>
  );

  return (
    <div className="youtube-player-region">
      {settingsSlot ? createPortal(settingsButton, settingsSlot) : <div className="player-settings-row">{settingsButton}</div>}
      {settingsOpen && <p className="player-settings-help">Choose Done to return to room playback.</p>}
      <div className="youtube-player-viewport">
      <div className="youtube-player" ref={playerBoxRef}>
        {/* Direct input is allowed only while local viewing settings are open. */}
        <div
          ref={containerRef}
          id={screenId}
          className={`youtube-player-screen${settingsOpen ? " youtube-player-screen--settings" : ""}`}
          inert={!settingsOpen}
        />
        {!videoId && <p>No track is playing.</p>}
        {error && <p role="alert">{error}</p>}
        <div className="player-top-right-row">
          <button
            type="button"
            className="btn btn--sm"
            disabled={!videoId || !!error}
            aria-pressed={isFullscreen}
            onClick={toggleFullscreen}
          >
            {isFullscreen ? "🗗 Exit fullscreen" : "⛶ Fullscreen"}
          </button>
          {topRightOverlay}
        </div>
        <div className="player-fallback-row">
          {videoId && needsManualPlay && !error && (
            <button type="button" className="btn btn--yellow" onClick={() => playerRef.current?.playVideo()}>
              ▶ Enable playback
            </button>
          )}
          {videoId && isMuted && !error && (
            <button
              type="button"
              className="btn btn--yellow"
              onClick={() => {
                if (!playerRef.current) return;
                playerRef.current.unMute();
                setIsMuted(false);
              }}
            >
              🔊 Enable sound
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
});
