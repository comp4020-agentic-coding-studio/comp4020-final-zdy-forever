import { useEffect, useState } from "react";
import type {
  Account,
  HealthResponse,
  YoutubeSearchResult,
  YoutubeVideoMetadata,
} from "../../shared/src/types.ts";
import { getClientId } from "./clientId.ts";
import { YoutubePlayer } from "./YoutubePlayer.tsx";

type HealthState = HealthResponse | "error" | null;

function App() {
  const [health, setHealth] = useState<HealthState>(null);
  const [displayName, setDisplayName] = useState("");
  const [account, setAccount] = useState<Account | "error" | null>(null);

  const [videoId, setVideoId] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<YoutubeSearchResult[] | "error" | null>(null);
  const [demoSongs, setDemoSongs] = useState<YoutubeSearchResult[] | "error" | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth("error"));
  }, []);

  useEffect(() => {
    fetch("/api/youtube/demo-songs")
      .then((res) => res.json() as Promise<YoutubeSearchResult[]>)
      .then(setDemoSongs)
      .catch(() => setDemoSongs("error"));
  }, []);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: getClientId(), displayName }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAccount((await res.json()) as Account);
    } catch {
      setAccount("error");
    }
  };

  // Submitted explicitly, never fired per keystroke.
  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    try {
      const res = await fetch(`/api/youtube/search?q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error(await res.text());
      setSearchResults((await res.json()) as YoutubeSearchResult[]);
    } catch {
      setSearchResults("error");
    }
  };

  const resolveUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setResolveError(null);
    try {
      const res = await fetch("/api/youtube/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: urlInput }),
      });
      const body = (await res.json()) as YoutubeVideoMetadata | { error: string };
      if (!res.ok) {
        setResolveError("error" in body ? body.error : "could not resolve that link");
        return;
      }
      const metadata = body as YoutubeVideoMetadata;
      if (!metadata.embeddable) {
        setResolveError("that video can't be embedded elsewhere");
        return;
      }
      setVideoId(metadata.videoId);
    } catch {
      setResolveError("could not resolve that link");
    }
  };

  return (
    <main>
      <h1>Echo Room</h1>

      <YoutubePlayer videoId={videoId} />

      <section>
        <h2>Paste a YouTube link</h2>
        <form onSubmit={resolveUrl}>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
          />
          <button type="submit">Load</button>
        </form>
        {resolveError && <p role="alert">{resolveError}</p>}
      </section>

      <section>
        <h2>Search YouTube</h2>
        <form onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search…" />
          <button type="submit">Search</button>
        </form>
        {searchResults === "error" && <p>search failed</p>}
        {Array.isArray(searchResults) && (
          <ul>
            {searchResults.map((r) => (
              <li key={r.videoId}>
                <button type="button" onClick={() => setVideoId(r.videoId)}>
                  {r.title} — {r.channelTitle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Demo songs</h2>
        {demoSongs === "error" && <p>demo songs unavailable</p>}
        {Array.isArray(demoSongs) && (
          <ul>
            {demoSongs.map((song) => (
              <li key={song.videoId}>
                <button type="button" onClick={() => setVideoId(song.videoId)}>
                  {song.title} — {song.channelTitle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p>
        {health === null && "checking server…"}
        {health === "error" && "server unreachable"}
        {health !== null && health !== "error" && `server: ${health.status} (up ${Math.round(health.uptime)}s)`}
      </p>

      {account && account !== "error" ? (
        <p>
          signed in as {account.displayName} (accountId: {account.accountId})
        </p>
      ) : (
        <form onSubmit={register}>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="display name"
            required
          />
          <button type="submit">Join</button>
          {account === "error" && <p>registration failed</p>}
        </form>
      )}
    </main>
  );
}

export default App;
