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

  // Always visible regardless of room state (CLAUDE.md: keep the YouTube
  // player visible) — sits above both the setup and in-room regions below,
  // never inside a conditional that could unmount it.
  const playerCard = (
    <div className="card card--accent-pink">
      <h2>🎬 Now playing</h2>
      <YoutubePlayer
        ref={playerRef}
        videoId={live.playback?.videoId ?? videoId}
        onStateChange={live.handlePlayerStateChange}
      />
      {live.playback && (
        <>
          <p>
            <strong>{live.playback.title}</strong> — {live.playback.channelTitle}
          </p>
          <p className="footer-note">
            status: {live.playback.status} · playbackId: {live.playback.playbackId} · revision:{" "}
            {live.playback.revision}
          </p>
        </>
      )}
    </div>
  );

  // Pre-room setup: register, add a track, join a room. Not part of the
  // in-room priority hierarchy, so it's ordered after the room region once
  // a room is actually live (see the render below).
  const setupRegion = (
    <section className="section-stack">
      <div className="card card--accent-purple">
        <h2>🙋 Your name</h2>
        {account && account !== "error" ? (
          <p>
            signed in as <strong>{account.displayName}</strong> (accountId: {account.accountId})
          </p>
        ) : (
          <form onSubmit={register}>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="display name"
              required
            />
            <button type="submit" className="btn btn--purple">
              Join
            </button>
            {account === "error" && <p role="alert">registration failed</p>}
          </form>
        )}
      </div>

      <div className="card card--accent-blue">
        <h2>🔗 Paste a YouTube link</h2>
        <form onSubmit={resolveUrl}>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
          />
          <button type="submit" className="btn btn--blue">
            Load
          </button>
        </form>
        {resolveError && <p role="alert">{resolveError}</p>}
      </div>

      <div className="card card--accent-blue">
        <h2>🔍 Search YouTube</h2>
        <form onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search…" />
          <button type="submit" className="btn btn--blue">
            Search
          </button>
        </form>
        {searchResults === "error" && <p role="alert">search failed</p>}
        {Array.isArray(searchResults) && (
          <ul className="queue-list">
            {searchResults.map((r) => (
              <li key={r.videoId} className="queue-item">
                <button type="button" className="btn btn--sm" onClick={() => setVideoId(r.videoId)}>
                  {r.title} — {r.channelTitle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card card--accent-orange">
        <h2>🎵 Demo songs</h2>
        {demoSongs === "error" && <p role="alert">demo songs unavailable</p>}
        {Array.isArray(demoSongs) && (
          <ul className="queue-list">
            {demoSongs.map((song) => (
              <li key={song.videoId} className="queue-item">
                <button type="button" className="btn btn--sm" onClick={() => setVideoId(song.videoId)}>
                  {song.title} — {song.channelTitle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card card--accent-green">
        <h2>🚪 Join a room</h2>
        <form onSubmit={joinLiveRoom}>
          <input value={roomIdInput} onChange={(e) => setRoomIdInput(e.target.value)} placeholder="roomId" />
          <button type="submit" className="btn btn--green" disabled={!accountId}>
            Join room
          </button>
        </form>
        {!accountId && <p>register a display name above before joining a room</p>}
        {live.joinError && <p role="alert">{live.joinError}</p>}
      </div>
    </section>
  );

  // The live room: vote > DJ+listeners > queue(+tokens) > reactions — see
  // .room-grid in index.css for how this priority order is kept on both
  // desktop (two columns) and mobile (single column) breakpoints. Every
  // conditional below mirrors the original gating exactly (e.g. reactions
  // and the vote/controls panel only render once live.playback exists;
  // presence, reorder tokens and the queue render regardless), just spread
  // across separate cards instead of one big block.
  const roomRegion = liveRoomId && (
    <section className="section-stack">
      <div className="chip-row">
        <span className={`status-pill ${live.connected ? "status-pill--ok" : ""}`}>
          {live.connected ? "🟢 connected" : "connecting…"}
        </span>
      </div>
      {live.joinError && <p role="alert">{live.joinError}</p>}

      <div className="room-grid">
        <div className="card card--vote card--accent-blue">
          <h2>🗳️ Vote &amp; controls</h2>
          {!live.playback ? (
            <p>nothing is currently playing</p>
          ) : live.activeProposal ? (
            (() => {
              const proposal = live.activeProposal!;
              return (
                <>
                  <p className="sticker sticker--live">
                    {proposal.type} ·{" "}
                    {proposal.state === "OPEN" ? "voting…" : proposal.state === "PASSED" ? "passed" : "failed"}
                  </p>
                  <div className="vote-progress">
                    <span className="vote-progress--yes">
                      ✅ YES {Object.values(proposal.votes).filter((v) => v === "YES").length}
                    </span>
                    <span className="vote-progress--no">
                      ❌ NO {Object.values(proposal.votes).filter((v) => v === "NO").length}
                    </span>
                  </div>
                  {proposal.state === "OPEN" && accountId && !(accountId in proposal.votes) && (
                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn--green"
                        onClick={() => live.castProposalVote(proposal.proposalId, "YES")}
                      >
                        👍 Vote YES
                      </button>
                      <button
                        type="button"
                        className="btn btn--red"
                        onClick={() => live.castProposalVote(proposal.proposalId, "NO")}
                      >
                        👎 Vote NO
                      </button>
                    </div>
                  )}
                </>
              );
            })()
          ) : (
            <div className="btn-row">
              <button
                type="button"
                className="btn btn--green"
                onClick={() => live.requestPlaybackProposal("PLAY")}
                disabled={live.playback.status === "PLAYING"}
              >
                ▶ Propose Play
              </button>
              <button
                type="button"
                className="btn btn--yellow"
                onClick={() => live.requestPlaybackProposal("PAUSE")}
                disabled={live.playback.status === "PAUSED"}
              >
                ⏸ Propose Pause
              </button>
              <button type="button" className="btn btn--blue" onClick={() => live.requestPlaybackProposal("SKIP")}>
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
                  <button type="submit" className="btn btn--purple">
                    ⏩ Propose Seek
                  </button>
                </form>
              )}
            </div>
          )}
          {live.playback && live.proposalError && <p role="alert">{live.proposalError}</p>}
        </div>

        <div className="card card--dj card--accent-purple">
          <h2>🎧 DJ &amp; listeners</h2>
          {live.playback && <p className="sticker sticker--dj">DJ: {live.playback.dj.displayName}</p>}
          <div className="chip-row">
            {live.presence.length === 0 ? (
              <span>nobody yet</span>
            ) : (
              live.presence.map((p) => (
                <span key={p.accountId} className="chip">
                  <span className="chip-avatar" aria-hidden="true">
                    {p.displayName.slice(0, 1).toUpperCase()}
                  </span>
                  {p.displayName}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="card card--queue card--accent-green">
          <h2>📜 Queue ({live.queue.length})</h2>
          {live.reorderTokenBalance && (
            <div className="token-row">
              {Array.from({ length: live.reorderTokenBalance.maxTokens }).map((_, i) => (
                <span
                  key={i}
                  className={`token-pip ${i < live.reorderTokenBalance!.tokens ? "token-pip--filled" : "token-pip--empty"}`}
                  aria-hidden="true"
                />
              ))}
              <span>
                {live.reorderTokenBalance.tokens}/{live.reorderTokenBalance.maxTokens} reorder tokens
                {live.reorderTokenBalance.nextRegenAt && (
                  <> · next +1 at {new Date(live.reorderTokenBalance.nextRegenAt).toLocaleTimeString()}</>
                )}
              </span>
            </div>
          )}
          <ul className="queue-list">
            {live.queue.map((item, index) => (
              <li
                key={item.queueItemId}
                className={`queue-item ${item.queueItemId === live.playback?.queueItemId ? "queue-item--current" : ""}`}
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
                <span className="queue-item-title">
                  {item.title} — {item.channelTitle}
                </span>
                {/* Mobile-accessible fallback for drag-and-drop: swaps this
                    item with its immediate neighbor. Both request the exact
                    same REORDER_QUEUE proposal a drag would — no separate
                    code path on the server. */}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={index === 0}
                  onClick={() =>
                    live.requestReorderQueueProposal(item.queueItemId, live.queue[index - 1].queueItemId)
                  }
                >
                  ⬆
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={index === live.queue.length - 1}
                  onClick={() =>
                    live.requestReorderQueueProposal(
                      item.queueItemId,
                      index + 2 < live.queue.length ? live.queue[index + 2].queueItemId : null,
                    )
                  }
                >
                  ⬇
                </button>
                {/* The currently-playing item can never be removed via a vote
                    here — see ProposalManager.requestRemoveQueueItem in
                    server/src/proposals.ts; skip is the only way off it. */}
                {item.queueItemId !== live.playback?.queueItemId && (
                  <button
                    type="button"
                    className="btn btn--sm btn--red"
                    onClick={() => live.requestRemoveQueueItemProposal(item.queueItemId)}
                  >
                    🗑
                  </button>
                )}
              </li>
            ))}
            {/* Drop target for dragging an item to the very end of the queue
                — beforeQueueItemId: null means "move to the end." */}
            <li
              className="queue-drop-target"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragQueueItemId) live.requestReorderQueueProposal(dragQueueItemId, null);
                setDragQueueItemId(null);
              }}
            >
              drop here to move to end of queue
            </li>
          </ul>
        </div>

        <div className="card card--reactions card--accent-orange">
          <h2>✨ Reactions</h2>
          {live.playback && (
            <>
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
            </>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-badge" aria-hidden="true">
            🎧
          </span>
          <h1>Echo Room</h1>
        </div>
        <span
          className={`status-pill ${health !== null && health !== "error" ? "status-pill--ok" : health === "error" ? "status-pill--error" : ""}`}
        >
          {health === null && "checking server…"}
          {health === "error" && "server unreachable"}
          {health !== null && health !== "error" && `server up ${Math.round(health.uptime)}s`}
        </span>
      </header>

      {playerCard}
      {roomRegion}
      {setupRegion}

      <p className="footer-note">Echo Room — a shared listening room for up to 12 people.</p>
    </main>
  );
}

export default App;
