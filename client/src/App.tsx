import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  REACTION_EMOJIS,
  type Account,
  type HealthResponse,
  type JoinRoomResult,
  type LobbyRoom,
  type QueueItem,
  type Room,
} from "../../shared/src/types.ts";
import { placementAllowed } from "../../shared/src/queueRules.ts";
import { getClientId } from "./clientId.ts";
import { loadRoomId, saveRoomId } from "./roomSession.ts";
import { usePlaybackSync } from "./usePlaybackSync.ts";
import { YoutubePlayer, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

type HealthState = HealthResponse | "error" | null;

type PostResult<T> = { ok: true; data: T } | { ok: false; error: string };

// POSTs JSON and hands back either the parsed body or the server's own
// { error } message, so every form below can show why something failed.
async function postJson<T>(url: string, body: unknown): Promise<PostResult<T>> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const error = data && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : null;
      return { ok: false, error: error ?? `request failed (${res.status})` };
    }
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "couldn't reach the server" };
  }
}

function App() {
  const [health, setHealth] = useState<HealthState>(null);
  const [displayName, setDisplayName] = useState("");
  const [account, setAccount] = useState<Account | "error" | null>(null);

  // The name being typed in while renaming, or null when not renaming.
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [urlInput, setUrlInput] = useState("");
  // Result of the last "add to queue" in a room — the queue itself only ever
  // changes via the server's queue:itemAdded broadcast.
  const [addStatus, setAddStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const [lobby, setLobby] = useState<LobbyRoom[] | "error" | null>(null);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomPrivate, setNewRoomPrivate] = useState(false);
  const [newRoomAutoClose, setNewRoomAutoClose] = useState(true);
  const [codeInput, setCodeInput] = useState("");
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
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
  // The queue is history (already played), the current track, then what's
  // still to come. -1: nothing is playing, so every track counts as to come.
  const currentIndex = live.queue.findIndex((q) => q.queueItemId === live.playback?.queueItemId);
  // Whether the track at `from` may be moved in front of the one at `to`
  // (queue.length: the very end) — the server's own rule, never a no-op.
  const canMove = (from: number, to: number) => to !== from && to !== from + 1 && placementAllowed(currentIndex, from, to);

  // The queue list shows the current track as its first row, with history
  // scrolled out of sight above it: the list is sized to hold the current
  // track and what's still to come (up to its CSS max-height), and scrolled
  // so the current track sits at the top. Re-anchored whenever the current
  // track, or how much history is above it, changes; the locate button
  // scrolls back to it on demand.
  const queueListRef = useRef<HTMLUListElement>(null);
  const anchoredKeyRef = useRef<string | null>(null);
  const currentRow = () => queueListRef.current?.querySelector<HTMLElement>(".queue-item--current") ?? null;
  const sizeQueueList = useCallback(() => {
    const list = queueListRef.current;
    const current = list?.querySelector<HTMLElement>(".queue-item--current");
    const last = list?.lastElementChild as HTMLElement | null | undefined;
    if (!list) return;
    if (!current || !last || current === list.firstElementChild) {
      list.style.height = "";
      return;
    }
    list.style.height = `${last.offsetTop + last.offsetHeight - current.offsetTop}px`;
  }, []);
  const scrollQueueToCurrent = (behavior: ScrollBehavior) => {
    const current = currentRow();
    if (current) queueListRef.current?.scrollTo({ top: current.offsetTop, behavior });
  };
  const queueKey = live.queue.map((q) => q.queueItemId).join(",");
  useLayoutEffect(() => {
    sizeQueueList();
    const anchorKey = `${live.playback?.queueItemId ?? ""}:${currentIndex}`;
    if (anchoredKeyRef.current !== anchorKey) {
      anchoredKeyRef.current = anchorKey;
      scrollQueueToCurrent("auto");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey, live.playback?.queueItemId, currentIndex, liveRoomId, sizeQueueList]);
  useEffect(() => {
    window.addEventListener("resize", sizeQueueList);
    return () => window.removeEventListener("resize", sizeQueueList);
  }, [sizeQueueList]);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth("error"));
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

  const refreshLobby = useCallback(() => {
    fetch("/api/lobby")
      .then((res) => (res.ok ? (res.json() as Promise<LobbyRoom[]>) : Promise.reject()))
      .then(setLobby)
      .catch(() => setLobby("error"));
  }, []);

  // Fresh on first load and every time someone leaves a room back to here.
  useEffect(() => {
    if (!liveRoomId) refreshLobby();
  }, [liveRoomId, refreshLobby]);

  // Every REST call made as this account carries its clientId too — the
  // server checks the pair, since an accountId alone is public.
  const credentials = () => ({ accountId, clientId: getClientId() });

  // Handing the roomId to usePlaybackSync is what actually enters the room:
  // its socket's room:join is where the server enforces capacity and sends
  // the authoritative snapshot. The REST calls before this only admit the
  // account (and check a private room's code).
  const enterRoom = (roomId: string) => {
    setRoomActionError(null);
    setAddStatus(null);
    saveRoomId(roomId);
    setLiveRoomId(roomId);
  };

  const leaveRoom = () => {
    saveRoomId(null);
    setLiveRoomId(null);
    setAddStatus(null);
  };

  // A refresh used to lose everything: the name had to be typed again, and a
  // private room's code too. This browser's clientId (kept in localStorage)
  // already identifies its account, so pick that back up, then go back to
  // the room this tab was in — a private room's membership is on the server,
  // so no code is needed. If the room can't be re-entered any more (closed,
  // full), the join error below brings the tab back to the lobby.
  useEffect(() => {
    let cancelled = false;
    void postJson<{ account: Account | null }>("/api/session", { clientId: getClientId() }).then((result) => {
      if (cancelled || !result.ok || !result.data.account) return;
      setAccount(result.data.account);
      const roomId = loadRoomId();
      if (roomId) enterRoom(roomId);
    });
    return () => {
      cancelled = true;
    };
    // Runs once, on load; enterRoom only calls state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Not being in the room any more — the socket join refused (room full,
  // closed, gone) or the room closed under us — means back to the lobby,
  // with the reason, rather than a room view that can't do anything.
  useEffect(() => {
    if (liveRoomId && live.joinError) {
      leaveRoom();
      setRoomActionError(live.joinError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRoomId, live.joinError]);

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    const result = await postJson<Room>("/api/rooms", {
      ...credentials(),
      name: newRoomName,
      visibility: newRoomPrivate ? "PRIVATE" : "PUBLIC",
      autoCloseEnabled: newRoomAutoClose,
    });
    if (!result.ok) {
      setRoomActionError(result.error);
      return;
    }
    setNewRoomName("");
    enterRoom(result.data.roomId);
  };

  const joinPublicRoom = async (roomId: string) => {
    const result = await postJson<JoinRoomResult>(`/api/rooms/${encodeURIComponent(roomId)}/join`, credentials());
    if (!result.ok) {
      setRoomActionError(result.error);
      refreshLobby();
      return;
    }
    enterRoom(result.data.room.roomId);
  };

  const joinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await postJson<JoinRoomResult>("/api/rooms/join-by-code", { ...credentials(), code: codeInput });
    if (!result.ok) {
      setRoomActionError(result.error);
      return;
    }
    setCodeInput("");
    enterRoom(result.data.room.roomId);
  };

  // `input` is a pasted link (or a bare videoId) — the
  // server parses and looks it up itself either way.
  const addToQueue = async (input: string): Promise<boolean> => {
    if (!liveRoomId) return false;
    setAddStatus(null);
    const result = await postJson<QueueItem>(`/api/rooms/${encodeURIComponent(liveRoomId)}/queue`, {
      ...credentials(),
      input,
    });
    setAddStatus(result.ok ? { ok: true, text: `added “${result.data.title}” to the queue` } : { ok: false, text: result.error });
    return result.ok;
  };

  // The account keeps its accountId; only the name everyone sees changes
  // (see POST /api/account/name).
  const rename = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameDraft === null) return;
    const result = await postJson<Account>("/api/account/name", { ...credentials(), displayName: nameDraft });
    if (!result.ok) {
      setRenameError(result.error);
      return;
    }
    setAccount(result.data);
    setNameDraft(null);
    setRenameError(null);
  };

  const addLinkToQueue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await addToQueue(urlInput)) setUrlInput("");
  };

  // Shown whenever you're in a room, always at the top (CLAUDE.md: keep the
  // YouTube player visible). The lobby has nothing to play, so no player.
  const playerCard = (
    <div className="card card--accent-pink">
      <h2>🎬 Now playing</h2>
      <YoutubePlayer
        ref={playerRef}
        videoId={live.playback?.videoId ?? null}
        onStateChange={live.handlePlayerStateChange}
        onReady={live.handlePlayerReady}
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

  // Before a room: pick (or change) a name, then create a room, join one by
  // code, or pick one from the public lobby. No player and no song links
  // here: those belong to being in a room.
  const lobbyRegion = (
    <section className="section-stack">
      {/* At the top, where it's seen: this is also why someone just landed
          back here (their room closed, or was full). */}
      {roomActionError && (
        <p role="alert" className="lobby-alert">
          {roomActionError}
        </p>
      )}
      <div className="card card--accent-purple">
        <h2>🙋 Your name</h2>
        {account && account !== "error" ? (
          nameDraft === null ? (
            <div className="btn-row name-row">
              <p>
                signed in as <strong>{account.displayName}</strong>
              </p>
              <button type="button" className="btn btn--sm" onClick={() => setNameDraft(account.displayName)}>
                ✏️ Change name
              </button>
            </div>
          ) : (
            <form onSubmit={rename}>
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="new display name"
                aria-label="new display name"
                maxLength={32}
                required
                autoFocus
              />
              <button type="submit" className="btn btn--purple">
                Save
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setNameDraft(null);
                  setRenameError(null);
                }}
              >
                Cancel
              </button>
              {renameError && <p role="alert">{renameError}</p>}
            </form>
          )
        ) : (
          <form onSubmit={register}>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="display name"
              aria-label="display name"
              maxLength={32}
              required
            />
            <button type="submit" className="btn btn--purple">
              Let's go
            </button>
            {account === "error" && <p role="alert">registration failed</p>}
          </form>
        )}
      </div>

      <div className="card card--accent-green">
        <h2>✨ Create a room</h2>
        <form className="form--stack" onSubmit={createRoom}>
          <input
            value={newRoomName}
            onChange={(e) => setNewRoomName(e.target.value)}
            placeholder="room name"
            aria-label="room name"
            maxLength={60}
            required
          />
          <fieldset className="choice-row">
            <legend>Who can find it?</legend>
            <label className="toggle">
              <input type="radio" name="visibility" checked={!newRoomPrivate} onChange={() => setNewRoomPrivate(false)} />
              🌍 Public — listed in the lobby
            </label>
            <label className="toggle">
              <input type="radio" name="visibility" checked={newRoomPrivate} onChange={() => setNewRoomPrivate(true)} />
              🔒 Private — join with a 6-digit code
            </label>
          </fieldset>
          <label className="toggle">
            <input type="checkbox" checked={newRoomAutoClose} onChange={(e) => setNewRoomAutoClose(e.target.checked)} />
            ⏲ Close automatically after 2 hours with no activity
          </label>
          <button type="submit" className="btn btn--green" disabled={!accountId}>
            ✨ Create room
          </button>
        </form>
      </div>

      <div className="card card--accent-blue">
        <h2>🚪 Join a room</h2>
        <form onSubmit={joinByCode}>
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value.replace(/\D/g, ""))}
            placeholder="6-digit code"
            aria-label="private room code"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
          />
          <button type="submit" className="btn btn--purple" disabled={!accountId}>
            🔑 Join with code
          </button>
        </form>
        <div className="lobby-heading">
          <h3>Public rooms</h3>
          <button type="button" className="btn btn--sm" onClick={refreshLobby} aria-label="refresh the public room list">
            🔄
          </button>
        </div>
        {lobby === "error" && <p role="alert">couldn't load the room list</p>}
        {Array.isArray(lobby) && lobby.length === 0 && <p>no public rooms yet — create one!</p>}
        {Array.isArray(lobby) && lobby.length > 0 && (
          <ul className="queue-list">
            {lobby.map((room) => (
              <li key={room.roomId} className="queue-item queue-item--static">
                <span className="queue-item-title">{room.name}</span>
                <span className="chip">
                  👥 {room.occupancy}/{room.capacity}
                </span>
                <button
                  type="button"
                  className="btn btn--sm btn--green"
                  disabled={!accountId || !room.joinable}
                  onClick={() => void joinPublicRoom(room.roomId)}
                >
                  {room.joinable ? "Join" : "Full"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {!accountId && <p>pick a display name above to create or join a room</p>}
      </div>
    </section>
  );

  // Songs come from pasted links (there's no search — see
  // docs/adr/0003-youtube-metadata-via-oembed.md), added straight to the
  // room's queue (no vote needed).
  const inRoom = liveRoomId !== null;
  const songSection = (
    <section className="section-stack">
      <div className="card card--accent-blue">
        <h2>🔗 Add a YouTube link</h2>
        <form onSubmit={addLinkToQueue}>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube link"
          />
          <button type="submit" className="btn btn--blue">
            ➕ Add to queue
          </button>
        </form>
        {addStatus && (
          <p role={addStatus.ok ? "status" : "alert"} className={addStatus.ok ? "notice" : undefined}>
            {addStatus.text}
          </p>
        )}
      </div>
    </section>
  );

  // The live room: vote > DJ+listeners > queue > reactions — see
  // .room-grid in index.css for how this priority order is kept on both
  // desktop (two columns) and mobile (single column) breakpoints. Every
  // conditional below mirrors the original gating exactly (e.g. reactions
  // and the vote/controls panel only render once live.playback exists;
  // presence and the queue render regardless), just spread
  // across separate cards instead of one big block.
  const roomRegion = liveRoomId && (
    <section className="section-stack">
      <div className="room-bar">
        <span className={`status-pill ${live.connected ? "status-pill--ok" : ""}`}>
          {live.connected ? "connected" : "connecting…"}
        </span>
        {live.room && <strong className="room-bar-name">{live.room.name}</strong>}
        {live.room?.visibility === "PRIVATE" && live.room.code && (
          <span className="sticker sticker--code" aria-label={`private room code ${live.room.code}`}>
            🔒 {live.room.code}
          </span>
        )}
        {live.room && (
          <span className="chip">
            👥 {live.presence.length}/{live.room.maxUsers}
          </span>
        )}
        <button type="button" className="btn btn--sm" onClick={leaveRoom}>
          🚪 Leave
        </button>
      </div>

      <div className="room-grid">
        <div className="card card--vote card--accent-blue">
          <h2>🗳️ Vote &amp; controls</h2>
          {live.activeProposal ? (
            (() => {
              const proposal = live.activeProposal!;
              return (
                <>
                  <p className="sticker sticker--live">{proposal.type} · voting…</p>
                  <div className="vote-progress">
                    <span className="vote-progress--yes">
                      ✅ YES {Object.values(proposal.votes).filter((v) => v === "YES").length}
                    </span>
                    <span className="vote-progress--no">
                      ❌ NO {Object.values(proposal.votes).filter((v) => v === "NO").length}
                    </span>
                  </div>
                  {accountId && !(accountId in proposal.votes) && (
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
          ) : !live.playback ? (
            <p>nothing is currently playing</p>
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
                    aria-label="seek position in seconds"
                  />
                  <button type="submit" className="btn btn--purple">
                    ⏩ Propose Seek
                  </button>
                </form>
              )}
            </div>
          )}
          {/* The room — not just this player — is paused (e.g. after a
              server restart); and alone, there's nobody to vote with. */}
          {live.playback?.status === "PAUSED" && (
            <p className="footer-note">⏸ Paused for everyone in the room — propose Play to resume.</p>
          )}
          {live.playback && live.presence.length < 2 && (
            <p className="footer-note">You're the only one here, so your proposals take effect straight away.</p>
          )}
          {!live.activeProposal && live.lastProposalResult && (
            <p className="sticker">
              last vote: {live.lastProposalResult.proposal.type} ·{" "}
              {live.lastProposalResult.proposal.state === "FAILED"
                ? "failed"
                : live.lastProposalResult.applied
                  ? "passed"
                  : "passed, but the room had already moved on"}
            </p>
          )}
          {live.proposalError && <p role="alert">{live.proposalError}</p>}
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
          <div className="queue-heading">
            <h2>📜 Queue ({live.queue.length})</h2>
            {currentIndex >= 0 && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => scrollQueueToCurrent("smooth")}
                aria-label="scroll the queue back to the track playing now"
              >
                📍 Now playing
              </button>
            )}
          </div>
          <ul className="queue-list" ref={queueListRef}>
            {live.queue.map((item, index) => {
              // History (played, above the current track) can only move
              // down — past the current track it plays again; what's still
              // to come moves only among itself; the current track stays
              // put. The same rule the server enforces (shared/src/queueRules.ts).
              const state =
                currentIndex === -1 || index > currentIndex ? "upcoming" : index === currentIndex ? "current" : "history";
              const dragFrom = dragQueueItemId ? live.queue.findIndex((q) => q.queueItemId === dragQueueItemId) : -1;
              const upTarget = index - 1;
              const downTarget = Math.min(index + 2, live.queue.length);
              return (
              <li
                key={item.queueItemId}
                className={`queue-item queue-item--${state}`}
                draggable={state !== "current"}
                onDragStart={() => setDragQueueItemId(item.queueItemId)}
                onDragEnd={() => setDragQueueItemId(null)}
                onDragOver={(e) => {
                  if (dragFrom !== -1 && canMove(dragFrom, index)) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragQueueItemId && dragFrom !== -1 && canMove(dragFrom, index)) {
                    live.requestReorderQueueProposal(dragQueueItemId, item.queueItemId);
                  }
                  setDragQueueItemId(null);
                }}
              >
                <span className="queue-item-title">
                  {state === "current" && "▶ "}
                  {item.title} — {item.channelTitle}
                </span>
                {/* Mobile-accessible fallback for drag-and-drop: swaps this
                    item with its immediate neighbor. Both request the exact
                    same REORDER_QUEUE proposal a drag would — no separate
                    code path on the server. */}
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={upTarget < 0 || !canMove(index, upTarget)}
                  aria-label={`move "${item.title}" up in the queue`}
                  onClick={() =>
                    live.requestReorderQueueProposal(item.queueItemId, live.queue[index - 1].queueItemId)
                  }
                >
                  ⬆
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={!canMove(index, downTarget)}
                  aria-label={`move "${item.title}" down in the queue`}
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
                    aria-label={`propose removing "${item.title}" from the queue`}
                    onClick={() => live.requestRemoveQueueItemProposal(item.queueItemId)}
                  >
                    🗑
                  </button>
                )}
              </li>
              );
            })}
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
                    aria-label={`send ${emoji} reaction`}
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

      {inRoom ? (
        <>
          {playerCard}
          {roomRegion}
          {songSection}
        </>
      ) : (
        lobbyRegion
      )}
    </main>
  );
}

export default App;
