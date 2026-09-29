import { useEffect, useRef, useState } from "react";
import {
  REACTION_EMOJIS,
  type Account,
  type HealthResponse,
  type YoutubeSearchResult,
  type YoutubeVideoMetadata,
} from "../../shared/src/types.ts";
import { getClientId } from "./clientId.ts";
import { usePlaybackSync } from "./usePlaybackSync.ts";
import { YoutubePlayer, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

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

  const [roomIdInput, setRoomIdInput] = useState("");
  const [liveRoomId, setLiveRoomId] = useState<string | null>(null);
  const [seekSecondsInput, setSeekSecondsInput] = useState("");
  const playerRef = useRef<YoutubePlayerHandle | null>(null);

  // Local drag UI state only — never authoritative. The actual reorder is
  // requested as a REORDER_QUEUE proposal and only ever takes effect via the
  // server's queue:reordered broadcast (see usePlaybackSync); dragQueueItemId
  // just tracks which row's drag is in progress so onDrop knows what to move.
  const [dragQueueItemId, setDragQueueItemId] = useState<string | null>(null);

  const accountId = account && account !== "error" ? account.accountId : null;
  const live = usePlaybackSync(liveRoomId, accountId, getClientId(), playerRef);

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

  // Joining is just handing the roomId to usePlaybackSync — it's the socket
  // itself (via room:join) that actually validates/enters the room, so there
  // is nothing to await here.
  const joinLiveRoom = (e: React.FormEvent) => {
    e.preventDefault();
    const id = roomIdInput.trim();
    if (!id) return;
    setLiveRoomId(id);
  };

  return (
    <main>
      <h1>Echo Room</h1>

      <YoutubePlayer
        ref={playerRef}
        videoId={live.playback?.videoId ?? videoId}
        onStateChange={live.handlePlayerStateChange}
      />

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

      <section>
        <h2>Room (live sync)</h2>
        <form onSubmit={joinLiveRoom}>
          <input value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value)} placeholder="roomId" />
          <button type="submit" disabled={!accountId}>
            Join room
          </button>
        </form>
        {!accountId && <p>register a display name above before joining a room</p>}
        {live.joinError && <p role="alert">{live.joinError}</p>}

        {liveRoomId && (
          <>
            <p>{live.connected ? "connected" : "connecting…"}</p>

            <p>Present: {live.presence.map((p) => p.displayName).join(", ") || "nobody yet"}</p>

            {live.playback ? (
              <div>
                <p>
                  Current track: {live.playback.title} — {live.playback.channelTitle}
                </p>
                <p>DJ: {live.playback.dj.displayName}</p>
                <p>
                  status: {live.playback.status} · playbackId: {live.playback.playbackId} · revision:{" "}
                  {live.playback.revision}
                </p>

                <div className="reactions-bar">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className="reaction-button"
                      onClick={() => live.sendReaction(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
                {live.reactionError && <p role="alert">{live.reactionError}</p>}

                <div className="reactions-feed" aria-live="polite">
                  {live.liveReactions.map((r) => (
                    <span key={r.key} className={`reaction-bubble reaction-bubble--${r.kind.toLowerCase()}`}>
                      {r.reaction.reaction} {r.reaction.displayName}
                      {r.kind === "ECHO" && <> · {new Date(r.reaction.createdAt).toLocaleDateString()}</>}
                    </span>
                  ))}
                </div>

                {live.activeProposal ? (
                  (() => {
                    const proposal = live.activeProposal!;
                    return (
                      <div>
                        <p>
                          Vote in progress: {proposal.type} (
                          {proposal.state === "OPEN" ? "voting…" : proposal.state === "PASSED" ? "passed" : "failed"})
                        </p>
                        <p>
                          YES: {Object.values(proposal.votes).filter((v) => v === "YES").length} · NO:{" "}
                          {Object.values(proposal.votes).filter((v) => v === "NO").length}
                        </p>
                        {proposal.state === "OPEN" && accountId && !(accountId in proposal.votes) && (
                          <>
                            <button type="button" onClick={() => live.castProposalVote(proposal.proposalId, "YES")}>
                              Vote YES
                            </button>
                            <button type="button" onClick={() => live.castProposalVote(proposal.proposalId, "NO")}>
                              Vote NO
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => live.requestPlaybackProposal("PLAY")}
                      disabled={live.playback.status === "PLAYING"}
                    >
                      ▶ Propose Play
                    </button>
                    <button
                      type="button"
                      onClick={() => live.requestPlaybackProposal("PAUSE")}
                      disabled={live.playback.status === "PAUSED"}
                    >
                      ⏸ Propose Pause
                    </button>
                    <button type="button" onClick={() => live.requestPlaybackProposal("SKIP")}>
                      ⏭ Propose Skip
                    </button>
                    {accountId === live.playback.dj.accountId && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          const seconds = Number(seekSecondsInput);
                          if (!Number.isFinite(seconds) || seconds < 0) return;
                          live.requestSeekProposal(Math.round(seconds * 1000));
                        }}
                      >
                        <input
                          type="number"
                          min="0"
                          value={seekSecondsInput}
                          onChange={(e) => setSeekSecondsInput(e.target.value)}
                          placeholder="seconds"
                        />
                        <button type="submit">⏩ Propose Seek</button>
                      </form>
                    )}
                  </>
                )}
                {live.proposalError && <p role="alert">{live.proposalError}</p>}
              </div>
            ) : (
              <p>nothing is currently playing</p>
            )}

            {live.reorderTokenBalance && (
              <p>
                Reorder tokens: {live.reorderTokenBalance.tokens}/{live.reorderTokenBalance.maxTokens}
                {live.reorderTokenBalance.nextRegenAt && (
                  <> (next +1 at {new Date(live.reorderTokenBalance.nextRegenAt).toLocaleTimeString()})</>
                )}
              </p>
            )}

            <p>Queue ({live.queue.length}):</p>
            <ul>
              {live.queue.map((item, index) => (
                <li
                  key={item.queueItemId}
                  draggable
                  onDragStart={() => setDragQueueItemId(item.queueItemId)}
                  onDragEnd={() => setDragQueueItemId(null)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragQueueItemId) live.requestReorderQueueProposal(dragQueueItemId, item.queueItemId);
                    setDragQueueItemId(null);
                  }}
                >
                  {item.title} — {item.channelTitle}
                  {/* Mobile-accessible fallback for drag-and-drop: swaps this
                      item with its immediate neighbor. Both request the exact
                      same REORDER_QUEUE proposal a drag would — no separate
                      code path on the server. */}
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => live.requestReorderQueueProposal(item.queueItemId, live.queue[index - 1].queueItemId)}
                  >
                    ⬆ Move up
                  </button>
                  <button
                    type="button"
                    disabled={index === live.queue.length - 1}
                    onClick={() =>
                      live.requestReorderQueueProposal(
                        item.queueItemId,
                        index + 2 < live.queue.length ? live.queue[index + 2].queueItemId : null,
                      )
                    }
                  >
                    ⬇ Move down
                  </button>
                  {/* The currently-playing item can never be removed via a vote
                      here — see ProposalManager.requestRemoveQueueItem in
                      server/src/proposals.ts; skip is the only way off it. */}
                  {item.queueItemId !== live.playback?.queueItemId && (
                    <button
                      type="button"
                      onClick={() => live.requestRemoveQueueItemProposal(item.queueItemId)}
                    >
                      🗑 Propose Remove
                    </button>
                  )}
                </li>
              ))}
              {/* Drop target for dragging an item to the very end of the queue
                  — beforeQueueItemId: null means "move to the end." */}
              <li
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragQueueItemId) live.requestReorderQueueProposal(dragQueueItemId, null);
                  setDragQueueItemId(null);
                }}
              >
                (drop here to move to end of queue)
              </li>
            </ul>
          </>
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
