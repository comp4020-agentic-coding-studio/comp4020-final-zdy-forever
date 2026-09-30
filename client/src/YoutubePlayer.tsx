import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

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
      playerVars?: Record<string, number | string>;
      events?: {
        onReady?: (e: YouTubePlayerEvent) => void;
        onStateChange?: (e: YouTubePlayerEvent) => void;
        onError?: (e: YouTubePlayerEvent) => void;
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
export const YoutubePlayer = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function YoutubePlayer(
  { videoId, onStateChange, onReady },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
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
        playerVars: { autoplay: 1, playsinline: 1, mute: 1 },
        events: {
          onReady: () => {
            if (generation !== generationRef.current) return;
            playerRef.current = instance;
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
          onError: (e) => {
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

  return (
    <div className="youtube-player">
      <div ref={containerRef} />
      {!videoId && <p>No track is playing.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="player-fallback-row">
        {needsManualPlay && !error && (
          <button type="button" className="btn btn--yellow" onClick={() => playerRef.current?.playVideo()}>
            ▶ Play
          </button>
        )}
        {videoId && isMuted && !error && (
          <button
            type="button"
            className="btn btn--yellow"
            onClick={() => {
              playerRef.current?.unMute();
              setIsMuted(false);
            }}
          >
            🔇 Tap to unmute
          </button>
        )}
      </div>
    </div>
  );
});
