import { useEffect, useRef, useState } from "react";

// Minimal ambient shape of the bits of the official YouTube IFrame Player
// API (developers.google.com/youtube/iframe_api_reference) this component
// actually uses — not exhaustive by design.
interface YouTubePlayerInstance {
  playVideo(): void;
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
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; CUED: number };
}

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

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

export interface YoutubePlayerProps {
  videoId: string | null;
}

// Always rendered, with or without a videoId — CLAUDE.md requires the
// player stay visible rather than only mounting once a track exists.
export function YoutubePlayer({ videoId }: YoutubePlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YouTubePlayerInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsManualPlay, setNeedsManualPlay] = useState(false);

  useEffect(() => {
    if (!videoId || !containerRef.current) return;
    let cancelled = false;
    setError(null);
    setNeedsManualPlay(false);

    loadYoutubeIframeApi().then((YT) => {
      if (cancelled || !containerRef.current) return;
      playerRef.current = new YT.Player(containerRef.current, {
        videoId,
        playerVars: { autoplay: 1, playsinline: 1 },
        events: {
          onStateChange: (e) => {
            // Many browsers block autoplay outright: no error fires, the
            // player just sits PAUSED/CUED forever. Offer a manual play
            // button instead of a silently stuck player.
            if (e.data === YT.PlayerState.PLAYING) {
              setNeedsManualPlay(false);
            } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.CUED) {
              setNeedsManualPlay(true);
            }
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
    };
  }, [videoId]);

  return (
    <div className="youtube-player">
      <div ref={containerRef} />
      {!videoId && <p>No track is playing.</p>}
      {error && <p role="alert">{error}</p>}
      {needsManualPlay && !error && (
        <button type="button" onClick={() => playerRef.current?.playVideo()}>
          ▶ Play
        </button>
      )}
    </div>
  );
}
