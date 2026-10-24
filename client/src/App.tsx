import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type Account,
  type JoinRoomResult,
  type LobbyRoom,
  type LogEventView,
  type QueueItem,
  type Room,
} from "../../shared/src/types.ts";
import { placementAllowed } from "../../shared/src/queueRules.ts";
import { fireConfettiAt } from "./clickConfetti.ts";
import { LogViewer } from "./LogViewer.tsx";
import { PingWheel, PING_META } from "./PingWheel.tsx";
import { RoomChat } from "./RoomChat.tsx";
import { RoomMembersPopover } from "./RoomMembersPopover.tsx";
import { SeekControl } from "./SeekControl.tsx";
import { SignalMenu } from "./SignalMenu.tsx";
import { DjHandoffDialog } from "./DjHandoffDialog.tsx";
import { getClientId } from "./clientId.ts";
import { loadRoomId, saveRoomId } from "./roomSession.ts";
import { shareRoom } from "./share.ts";
import { usePlaybackSync } from "./usePlaybackSync.ts";
import { YoutubePlayer, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

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
  const [codeInput, setCodeInput] = useState("");
  const [roomActionError, setRoomActionError] = useState<string | null>(null);
  const [liveRoomId, setLiveRoomId] = useState<string | null>(null);
  const playerRef = useRef<YoutubePlayerHandle | null>(null);
  // Portal target for the quality/subtitles toggle, so it renders in the
  // "Now playing" header (top-right) rather than YoutubePlayer's own layout.
  const [settingsSlot, setSettingsSlot] = useState<HTMLDivElement | null>(null);
  // Feedback for the Share button — only ever needs showing for "copied"
  // (the clipboard fallback has no system UI of its own to confirm it).
  // "shared" (native share sheet) and "failed" (which also covers the user
  // simply dismissing that sheet) get no toast: there's nothing useful to
  // say that isn't either redundant or potentially wrong.
  const [shareCopied, setShareCopied] = useState(false);

  // Local drag UI state only — never authoritative. The actual reorder is
  // requested as a REORDER_QUEUE proposal and only ever takes effect via the
  // server's queue:reordered broadcast (see usePlaybackSync); dragQueueItemId
  // just tracks which row's drag is in progress so onDrop knows what to move.
  const [dragQueueItemId, setDragQueueItemId] = useState<string | null>(null);

  // A small confetti burst at the cursor on every left-click, site-wide —
  // purely cosmetic, purely client-local (client/src/clickConfetti.ts never
  // touches the network). Bubble-phase, not capture: this never needs to
  // pre-empt anything a click would otherwise do.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button === 0) fireConfettiAt(event.clientX, event.clientY);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  // The landing page's "View activity log" button/dialog — resolves a room
  // by its code/number (GET /api/rooms/logs) without ever joining it.
  const logDialogRef = useRef<HTMLDialogElement>(null);
  const [logDialogOpen, setLogDialogOpen] = useState(false);
  const [logCodeInput, setLogCodeInput] = useState("");
  const [logEvents, setLogEvents] = useState<LogEventView[] | "error" | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  useEffect(() => {
    const dialog = logDialogRef.current;
    if (!dialog) return;
    if (logDialogOpen) dialog.showModal();
    else dialog.close();
  }, [logDialogOpen]);

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
      list.style.paddingBottom = "";
      return;
    }
    const remainingHeight = last.offsetTop + last.offsetHeight - current.offsetTop;
    // Keep the current track at the top even when only one song remains in
    // the taller queue viewport; the spare space belongs below it, not above.
    const fitted = window.matchMedia("(min-width: 1440px)").matches;
    list.style.height = fitted ? "" : `${remainingHeight}px`;
    const viewportHeight = fitted ? list.clientHeight : parseFloat(getComputedStyle(list).minHeight) || 0;
    list.style.paddingBottom = `${Math.max(0, viewportHeight - remainingHeight)}px`;
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
    const observer = new ResizeObserver(sizeQueueList);
    if (queueListRef.current) observer.observe(queueListRef.current, { box: "border-box" });
    return () => { window.removeEventListener("resize", sizeQueueList); observer.disconnect(); };
  }, [sizeQueueList, liveRoomId]);

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

  // A shared link (see share.ts) carries the room's code/number in `?join=`.
  // Captured once on mount and stripped right away, so neither a refresh nor
  // copying the URL bar again carries a stale code/number forward. Shown in
  // the join input immediately — visible proof of which room this link is
  // for while a first-time visitor is still picking a name — the actual
  // join happens below, once an account exists to join with.
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const join = params.get("join");
    if (join && /^\d{6}$|^\d{7}$/.test(join)) {
      setPendingJoinCode(join);
      setCodeInput(join);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  // Waits for an account — a first-time visitor following a shared link
  // lands on the name-picker first, then joins automatically the moment
  // they register; a returning one joins as soon as /api/session restores
  // their account. Overrides whatever room that restore would otherwise
  // have resumed: a freshly-clicked invite is a clearer signal of intent
  // than a stale previous session.
  useEffect(() => {
    if (!pendingJoinCode || !accountId) return;
    const code = pendingJoinCode;
    setPendingJoinCode(null);
    void joinByCodeValue(code);
    // joinByCodeValue only calls stable state setters; accountId is the only
    // real dependency besides the code itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingJoinCode, accountId]);

  // Not being in the room any more — the socket join refused (room full,
  // closed, gone) or the room closed under us — means back to the lobby,
  // with the reason, rather than a room view that can't do anything.
  useEffect(() => {
    if (liveRoomId && (live.joinError || live.leftRoom)) {
      leaveRoom();
      setRoomActionError(live.joinError);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveRoomId, live.joinError, live.leftRoom]);

  // A rejected ping (most often the server's rate limit) is a transient
  // event, not a standing error — unlike chatError/proposalError (which
  // clear themselves on the next successful send/vote), nothing else would
  // ever clear this, so it self-dismisses after a few seconds like every
  // other toast in this app.
  useEffect(() => {
    if (!live.pingError) return;
    const timer = setTimeout(live.dismissPingError, 3_000);
    return () => clearTimeout(timer);
  }, [live.pingError, live.dismissPingError]);

  const createRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accountId) return;
    const result = await postJson<Room>("/api/rooms", {
      ...credentials(),
      name: newRoomName,
      visibility: newRoomPrivate ? "PRIVATE" : "PUBLIC",
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

  // Shared by the manual "Join a room" form and the ?join= auto-join effect
  // above — same request, same success/failure handling, either way.
  const joinByCodeValue = async (code: string) => {
    const result = await postJson<JoinRoomResult>("/api/rooms/join-by-code", { ...credentials(), code });
    if (!result.ok) {
      setRoomActionError(result.error);
      return;
    }
    setCodeInput("");
    enterRoom(result.data.room.roomId);
  };

  const joinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    await joinByCodeValue(codeInput);
  };

  // Looks a room's activity log up by its code/number, before ever joining
  // it (GET /api/rooms/logs — server/src/index.ts). Requires a registered
  // account (the same accountId/clientId pairing every other call here
  // uses) but never membership/presence in that room.
  const fetchRoomLogs = async (code: string) => {
    if (!accountId) return;
    setLogLoading(true);
    try {
      const params = new URLSearchParams({ accountId, clientId: getClientId(), code });
      const res = await fetch(`/api/rooms/logs?${params}`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setRoomActionError(typeof data?.error === "string" ? data.error : `request failed (${res.status})`);
        setLogEvents("error");
        return;
      }
      setLogEvents((await res.json()) as LogEventView[]);
    } catch {
      setLogEvents("error");
    } finally {
      setLogLoading(false);
    }
  };

  const submitLogLookup = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetchRoomLogs(logCodeInput);
  };

  const handleShare = async () => {
    if (!live.room) return;
    const outcome = await shareRoom(live.room);
    if (outcome === "copied") {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }
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
    <div className="card card--player card--accent-pink">
      <div className="player-heading">
        <h2>🎬 Now playing</h2>
        <div className="player-settings-slot" ref={setSettingsSlot} />
      </div>
      <YoutubePlayer
        ref={playerRef}
        videoId={live.playback?.videoId ?? null}
        onStateChange={live.handlePlayerStateChange}
        onReady={live.handlePlayerReady}
        onSettingsClosed={live.handlePlayerReady}
        settingsSlot={settingsSlot}
      />
      {live.playback && (
        <p>
          <strong>{live.playback.title}</strong> — {live.playback.channelTitle}
        </p>
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
            maxLength={20}
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
            aria-label="room code or number"
            inputMode="numeric"
            pattern="\d{6}|\d{7}"
            maxLength={7}
            required
          />
          <button type="submit" className="btn btn--purple" disabled={!accountId}>
            🔑 Join
          </button>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!accountId}
            onClick={() => {
              setLogCodeInput(codeInput);
              setLogEvents(null);
              setLogDialogOpen(true);
            }}
          >
            📋 View activity log
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
                {room.roomNumber && (
                  <span className="chip" aria-label={`room number ${room.roomNumber}`}>
                    🔢 {room.roomNumber}
                  </span>
                )}
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
      <p className="bug-report">
        🐞 Found a bug? Email <a href="mailto:u7782042@anu.edu.au?subject=Watch%20YouTube%20Together%20bug">u7782042@anu.edu.au</a>
      </p>
    </section>
  );

  // Songs come from pasted links (there's no search — see
  // docs/adr/0003-youtube-metadata-via-oembed.md), added straight to the
  // room's queue (no vote needed).
  const inRoom = liveRoomId !== null;
  const songSection = (
    <section className="section-stack add-link-section">
      <div className="card card--accent-blue">
        <h2>🔗 Add a YouTube link</h2>
        <form onSubmit={addLinkToQueue}>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube link"
          />
          <div className="add-link-actions">
            <button type="submit" className="btn btn--blue">
              ➕ Add to queue
            </button>
            {addStatus && (
              <span role={addStatus.ok ? "status" : "alert"}
                className={`add-link-result add-link-result--${addStatus.ok ? "success" : "failed"}`}
                title={addStatus.ok ? undefined : addStatus.text}>
                {addStatus.ok ? "success" : "failed"}
              </span>
            )}
          </div>
        </form>
      </div>
    </section>
  );

  const roomBar = (
      <div className="room-bar">
        <span className={`status-pill ${live.connected ? "status-pill--ok" : ""}`}>
          {live.connected ? "connected" : "connecting…"}
        </span>
        {live.room && <strong className="room-bar-name">{live.room.name}</strong>}
        {live.room?.visibility === "PRIVATE" && live.room.code && (
          <button
            type="button"
            className="sticker sticker--code"
            aria-label={`private room code ${live.room.code} — click to copy an invite link`}
            onClick={() => void handleShare()}
          >
            🔒 {live.room.code}
          </button>
        )}
        {live.room?.visibility === "PUBLIC" && live.room.roomNumber && (
          <button
            type="button"
            className="sticker sticker--code"
            aria-label={`public room number ${live.room.roomNumber} — click to copy an invite link`}
            onClick={() => void handleShare()}
          >
            #️⃣ {live.room.roomNumber}
          </button>
        )}
        {shareCopied && <span className="sticker sticker--live">copied!</span>}
        {live.room && (
          <RoomMembersPopover key={liveRoomId} members={live.presence}
            capacity={live.room.maxUsers} dj={live.playback?.dj ?? null} />
        )}
        {live.room && <SignalMenu onSendSignal={live.sendPingSignal} />}
        <button type="button" className="btn btn--sm" onClick={live.requestLeaveRoom}>
          🚪 Leave
        </button>
      </div>
  );

  const voteCard = (
    <div className="card card--vote card--accent-blue">
      <h2>🗳️ Vote &amp; controls</h2>
      {live.activeProposal ? (
        (() => {
          const proposal = live.activeProposal!;
          return (
            <>
              <p className="sticker sticker--live">
                {proposal.payload.type === "REPLAY_QUEUE_ITEM"
                  ? `Restart from "${live.queue.find((item) => proposal.payload.type === "REPLAY_QUEUE_ITEM" && item.queueItemId === proposal.payload.queueItemId)?.title ?? "this video"}"`
                  : proposal.type} · voting…
              </p>
              <div className="vote-progress">
                <span className="vote-progress--yes">
                  ✅ YES {Object.values(proposal.votes).filter((v) => v === "YES").length}
                </span>
                <span className="vote-progress--no">
                  ❌ NO {Object.values(proposal.votes).filter((v) => v === "NO").length}
                </span>
              </div>
              {accountId && (
                <div className="btn-row">
                  <button
                    type="button"
                    className={`btn btn--green${proposal.votes[accountId] === "YES" ? " btn--selected" : ""}`}
                    aria-pressed={proposal.votes[accountId] === "YES"}
                    onClick={() => live.castProposalVote(proposal.proposalId, "YES")}
                  >
                    👍 Vote YES
                  </button>
                  <button
                    type="button"
                    className={`btn btn--red${proposal.votes[accountId] === "NO" ? " btn--selected" : ""}`}
                    aria-pressed={proposal.votes[accountId] === "NO"}
                    onClick={() => live.castProposalVote(proposal.proposalId, "NO")}
                  >
                    👎 Vote NO
                  </button>
                  {accountId === proposal.proposer && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => live.cancelProposalVote(proposal.proposalId)}
                    >
                      🛑 Cancel vote
                    </button>
                  )}
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
            <SeekControl
              key={live.playback.playbackId}
              onPropose={live.requestSeekProposal}
              getDurationMs={() => {
                const seconds = playerRef.current?.getDuration() ?? 0;
                return seconds > 0 ? seconds * 1000 : null;
              }}
            />
          )}
        </div>
      )}
      {!live.activeProposal && live.lastProposalResult && (
        <p className="sticker">
          last vote: {live.lastProposalResult.proposal.type} ·{" "}
          {live.lastProposalResult.cancelled
            ? "cancelled by the proposer"
            : live.lastProposalResult.proposal.state === "FAILED"
              ? "failed"
              : live.lastProposalResult.applied
                ? "passed"
                : "passed, but the room had already moved on"}
        </p>
      )}
      {live.proposalError && <p role="alert">{live.proposalError}</p>}
    </div>
  );

  const queueCard = (
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
            className={`queue-item queue-item--${state}${!live.playback ? " queue-item--static" : ""}`}
            draggable={!!live.playback && state !== "current"}
            onDragStart={() => setDragQueueItemId(item.queueItemId)}
            onDragEnd={() => setDragQueueItemId(null)}
            onDragOver={(e) => {
              if (live.playback && dragFrom !== -1 && canMove(dragFrom, index)) e.preventDefault();
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (live.playback && dragQueueItemId && dragFrom !== -1 && canMove(dragFrom, index)) {
                live.requestReorderQueueProposal(dragQueueItemId, item.queueItemId);
              }
              setDragQueueItemId(null);
            }}
          >
            <span className="queue-item-title">
              {state === "current" && "▶ "}
              {item.title} — {item.channelTitle}
            </span>
            {!live.playback ? (
              <button
                type="button"
                className="btn btn--sm"
                disabled={!live.connected || !!live.activeProposal}
                aria-label={`restart here: ${item.title}`}
                onClick={() => live.requestReplayQueueProposal(item.queueItemId)}
              >
                restart here
              </button>
            ) : (
            <>
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
            </>
            )}
          </li>
          );
        })}
      </ul>
    </div>
  );

  const chatCard = (
    <RoomChat
      key={liveRoomId}
      messages={live.chatMessages}
      accountId={accountId}
      connected={live.connected}
      error={live.chatError}
      onSend={live.sendChatMessage}
    />
  );

  return (
    <main className={`app-shell${inRoom ? " app-shell--room" : ""}`}>
      {/* Disarmed while the DJ-handoff dialog is up (the only modal that can
          appear while inRoom) — a native <dialog> doesn't stop document-level
          keydown/keyup from firing, so without this the wheel could open
          "behind" it and a stray release could still spend a real
          rate-limit token on an interaction the user never intended. */}
      <PingWheel active={inRoom && !live.djHandoff} onSendSignal={live.sendPingSignal} />
      {live.incomingPings.map((ping) => (
        <PingPop key={ping.id} ping={ping} onDismiss={() => live.dismissPing(ping.id)} />
      ))}
      {/* A rejected ping (most often the server's real 3-per-10s rate limit
          — see docs/adr/0013) used to vanish silently: the client's own
          local cooldown hint (PingWheel.tsx) never blocks a send, so this is
          the only place a user actually learns a signal didn't go through. */}
      {live.pingError && <p role="alert" className="ping-error-toast">{live.pingError}</p>}
      {live.djHandoff && (
        <DjHandoffDialog key={live.djHandoff.requestId} handoff={live.djHandoff}
          members={live.presence.filter((person) => person.accountId !== accountId)}
          error={live.leaveError} onChoose={live.chooseNextDj} />
      )}
      {live.leaveError && !live.djHandoff && <p role="alert">{live.leaveError}</p>}
      {inRoom ? (
        <>
          {roomBar}
          <div className="room-layout">
            <section className="room-main-column section-stack" aria-label="Video">
              {playerCard}
            </section>
            <aside className="room-social-column section-stack" aria-label="Room controls and chat">
              {voteCard}
              {chatCard}
            </aside>
            <aside className="room-queue-column section-stack" aria-label="Add videos and queue">
              {songSection}
              {queueCard}
            </aside>
          </div>
        </>
      ) : (
        lobbyRegion
      )}
      <dialog ref={logDialogRef} className="card log-viewer-dialog" aria-labelledby="log-viewer-title"
        onClose={() => setLogDialogOpen(false)}>
        <h2 id="log-viewer-title">📋 Room activity log</h2>
        <form className="form--stack" onSubmit={submitLogLookup}>
          <input
            value={logCodeInput}
            onChange={(e) => setLogCodeInput(e.target.value.replace(/\D/g, ""))}
            aria-label="room code or number"
            inputMode="numeric"
            pattern="\d{6}|\d{7}"
            maxLength={7}
            placeholder="6-digit code or 7-digit number"
            required
          />
          <button type="submit" className="btn btn--purple" disabled={logLoading}>
            🔍 Look up
          </button>
        </form>
        {logEvents !== null && (
          <LogViewer events={logEvents} loading={logLoading} onRefresh={() => void fetchRoomLogs(logCodeInput)} />
        )}
        <button type="button" className="btn btn--sm" onClick={() => setLogDialogOpen(false)}>
          Close
        </button>
      </dialog>
    </main>
  );
}

// Pops up exactly where the sender's ping wheel was opened (xRatio/yRatio —
// a fraction of their own viewport, so this lands at the same relative spot
// regardless of either side's window size), holds briefly, then disappears —
// one ping at a time at its own point, never stacked in a corner.
function PingPop({ ping, onDismiss }: { ping: { displayName: string; signal: string; xRatio: number; yRatio: number }; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 1_800);
    return () => clearTimeout(timer);
    // onDismiss is stable for the lifetime of this one ping (it closes over
    // a fixed id — see usePlaybackSync.ts's dismissPing).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="ping-pop"
      style={{ left: `${ping.xRatio * 100}%`, top: `${ping.yRatio * 100}%` }}
      aria-hidden="true"
    >
      <span className="ping-pop-icon">{PING_META[ping.signal as keyof typeof PING_META].icon}</span>
      <span className="ping-pop-name">{ping.displayName}</span>
    </div>
  );
}

export default App;
