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
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
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
  getPlayerState(): number;
  loadVideoById(videoId: string, startSeconds?: number): void;
}

export interface YoutubePlayerProps {
  videoId: string | null;
  // Relayed verbatim from the IFrame API's onStateChange — a sync layer
  // uses this to know when to suspend/resume its local drift-correction
  // poll (never while BUFFERING/CUED/ENDED/UNSTARTED) and to time its
  // post-transition grace period.
  onStateChange?: (state: number) => void;
}

// Always rendered, with or without a videoId — CLAUDE.md requires the
// player stay visible rather than only mounting once a track exists.
export const YoutubePlayer = forwardRef<YoutubePlayerHandle, YoutubePlayerProps>(function YoutubePlayer(
  { videoId, onStateChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsManualPlay, setNeedsManualPlay] = useState(false);
  // Every fresh player is created muted (see the mute: 1 playerVars below) —
  // this is what lets a late join / reconnect / track transition autoplay at
  // all in browsers that block unmuted autoplay. It's purely local UI state:
  // never reported to, or affected by, the server's authoritative anchor.
  const [isMuted, setIsMuted] = useState(true);

  useImperativeHandle(
    ref,
    () => ({
      playVideo: () => playerRef.current?.playVideo(),
      pauseVideo: () => playerRef.current?.pauseVideo(),
      seekTo: (seconds: number) => playerRef.current?.seekTo(seconds, true),
      getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState() ?? YT_PLAYER_STATE.UNSTARTED,
      loadVideoById: (id: string, startSeconds?: number) => playerRef.current?.loadVideoById(id, startSeconds),
    }),
    [],
  );

  useEffect(() => {
    if (!videoId || !containerRef.current) return;
    let cancelled = false;
    let attemptingAutoplay = true;
    setError(null);
    setNeedsManualPlay(false);
    setIsMuted(true);

    loadYoutubeIframeApi().then((YT) => {
      if (cancelled || !containerRef.current) return;
      playerRef.current = new YT.Player(containerRef.current, {
        videoId,
        playerVars: { autoplay: 1, playsinline: 1, mute: 1 },
        events: {
          onStateChange: (e) => {
            const state = e.data ?? YT_PLAYER_STATE.UNSTARTED;
            // Many browsers block autoplay outright: no error fires, the
            // player just sits PAUSED/CUED forever. Only the *first*
            // non-PLAYING settle after a fresh load counts as "autoplay was
            // blocked" — a later, legitimate server-driven pause must never
            // re-trigger this fallback button.
            if (state === YT_PLAYER_STATE.PLAYING) {
              attemptingAutoplay = false;
              setNeedsManualPlay(false);
            } else if (attemptingAutoplay && (state === YT_PLAYER_STATE.PAUSED || state === YT_PLAYER_STATE.CUED)) {
              attemptingAutoplay = false;
              setNeedsManualPlay(true);
            }
            onStateChange?.(state);
          },
          onError: (e) => {
            setError(ERROR_MESSAGES[e.data ?? -1] ?? "This video can't be played.");
          },
        },
      });
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    };
    // onStateChange is intentionally excluded: the player is only ever
    // recreated on a track transition (videoId change), never merely
    // because a parent re-renders with a new callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

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
