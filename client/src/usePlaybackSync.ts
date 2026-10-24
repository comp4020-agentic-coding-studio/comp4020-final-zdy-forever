import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { classifyDrift, computeExpectedPositionMs, isPlausibleTrackEnd } from "../../shared/src/playbackSync.ts";
import type {
  PlaybackState,
  PresenceEntry,
  PingBroadcast,
  PingSignal,
  QueueItem,
  ChatMessage,
  ChatSendResult,
  DjHandoff,
  Room,
  RoomSnapshot,
} from "../../shared/src/types.ts";
import type { Proposal, ProposalBroadcast, VoteChoice } from "../../shared/src/voting.ts";
import { applyProposalUpdate, proposalViewFromSnapshot } from "./proposalView.ts";
import { playPingChime } from "./pingChime.ts";
import { playVoteChime } from "./voteChime.ts";
import { YT_PLAYER_STATE, type YoutubePlayerHandle } from "./YoutubePlayer.tsx";

// A local poll against the player's own getCurrentTime(), never a network
// call — this is what "drift is measured" means (CLAUDE.md's Playback sync
// section forbids continuously broadcasting currentTime, but says nothing
// against a client checking its own local player against the anchor it
// already has).
const DRIFT_POLL_INTERVAL_MS = 2000;

// After the local player settles into PLAYING (a fresh track, a resume, or
// the end of buffering/an ad), give it a moment before trusting
// getCurrentTime() again — avoids a false-positive "hard resync" from a
// player that's still catching up to its own seek/load.
const POST_PLAYING_GRACE_MS = 1500;

export interface RoomLiveState {
  connected: boolean;
  joinError: string | null;
  room: Room | null;
  queue: QueueItem[];
  presence: PresenceEntry[];
  playback: PlaybackState | null;
  // The room's single in-flight (OPEN) vote, or null if none is open.
  // Seeded from room:snapshot on (re)join so a late joiner or a reconnecting
  // client sees an in-progress vote immediately, then kept current by
  // proposal:update (see proposalView.ts).
  activeProposal: Proposal | null;
  // The most recent resolved verdict, shown alongside (never instead of) the
  // controls once its vote has closed.
  lastProposalResult: ProposalBroadcast | null;
  proposalError: string | null;
  chatMessages: ChatMessage[];
  chatError: string | null;
  // Ping-wheel signals received from anyone in the room (including this
  // account's own sends) — a short rolling buffer for a toast overlay to
  // render and auto-dismiss, never persisted and never replayed on
  // reconnect/late-join (room:snapshot carries none — see docs/adr/0013).
  // `id` is generated client-side purely for the React key/dismiss timer.
  incomingPings: (PingBroadcast & { id: string })[];
  pingError: string | null;
  djHandoff: DjHandoff | null;
  leaveError: string | null;
  leftRoom: boolean;
}

const EMPTY_STATE: RoomLiveState = {
  connected: false,
  joinError: null,
  room: null,
  queue: [],
  presence: [],
  playback: null,
  activeProposal: null,
  lastProposalResult: null,
  proposalError: null,
  chatMessages: [],
  chatError: null,
  incomingPings: [],
  pingError: null,
  djHandoff: null,
  leaveError: null,
  leftRoom: false,
};

// How many recent pings to keep around for the toast overlay to render —
// older ones are simply dropped rather than growing unbounded; the overlay
// itself auto-dismisses each one individually well before this fills up.
const MAX_INCOMING_PINGS = 20;

// Establishes the client's socket connection, joins (and rejoins on every
// reconnect) the given room, and keeps the local YouTube player converged
// with the server's authoritative anchor — via one-shot corrections applied
// on room:snapshot/playback:update, plus a local drift-correction poll.
// Never sends currentTime to the server; never asks the server for it more
// often than a snapshot/update already provides.
export function usePlaybackSync(
  roomId: string | null,
  accountId: string | null,
  clientId: string | null,
  playerRef: React.RefObject<YoutubePlayerHandle | null>,
) {
  const [state, setState] = useState<RoomLiveState>(EMPTY_STATE);
  const playbackRef = useRef<PlaybackState | null>(null);
  const playingSinceRef = useRef<number | null>(null);
  const wasPlayingRef = useRef(false);
  const socketRef = useRef<Socket | null>(null);
  const finishedRef = useRef<{ playbackId: string; revision: number; reported: boolean } | null>(null);
  // Which videoId the local player has actually rendered a frame of —
  // cleared on every fresh load (handlePlayerReady), not merely every
  // playback/anchor change, since a replayed or re-queued video reloads from
  // scratch with nothing rendered yet even though its videoId repeats. See
  // applyAnchor's PAUSED branch for why this matters.
  const renderedVideoIdRef = useRef<string | null>(null);
  // True while a forced seek+play is only there to make YouTube paint a
  // frame at the target position — the next PLAYING confirmation parks it
  // right back at that position instead of letting it actually resume.
  const pendingParkRef = useRef(false);
  // The currently-open proposal's id, tracked outside React state so the
  // vote chime (see proposal:update below) can tell "a genuinely new vote
  // just opened" from "the same open vote got another ballot" without
  // putting that side effect inside a setState updater, which StrictMode
  // may invoke more than once per real update.
  const activeProposalIdRef = useRef<string | null>(null);

  // While the server gathers end reports, an old PLAYING anchor keeps
  // advancing. Never reload/seek beyond the video's end: YouTube can restart
  // at zero instead. Hold locally until the server changes track or anchor.
  const holdFinishedPlayback = useCallback((playback: PlaybackState, ended = false) => {
    const player = playerRef.current;
    if (!player || player.getVideoId() !== playback.videoId || playback.status !== "PLAYING") return false;
    const previous = finishedRef.current;
    const alreadyFinished = previous?.playbackId === playback.playbackId && previous.revision === playback.revision;
    const durationMs = playback.durationMs ?? player.getDuration() * 1000;
    if (!alreadyFinished && !ended && !(durationMs > 0 && computeExpectedPositionMs(playback, Date.now()) >= durationMs)) {
      return false;
    }
    const finished = alreadyFinished ? previous : { playbackId: playback.playbackId, revision: playback.revision, reported: false };
    finishedRef.current = finished;
    wasPlayingRef.current = false;
    player.pauseVideo();
    if (!finished.reported && socketRef.current) {
      finished.reported = true;
      socketRef.current.emit("playback:ended", { playbackId: playback.playbackId });
    }
    return true;
  }, [playerRef]);

  // Applies a freshly-received anchor to the local player exactly once —
  // this, not a continuous stream, is the entire mechanism for late-join and
  // reconnect sync (CLAUDE.md: "reconnect and late join must start from an
  // authoritative room snapshot"). Only refs are read, so it's stable.
  const applyAnchor = useCallback(
    (playback: PlaybackState | null) => {
      if (!playback || playback.playbackId !== playbackRef.current?.playbackId || playback.revision !== playbackRef.current?.revision) {
        finishedRef.current = null;
        wasPlayingRef.current = false;
        // A superseded anchor invalidates any nudge still waiting on its own
        // PLAYING confirmation — the next one it sees belongs to whatever
        // this call is about to do instead.
        pendingParkRef.current = false;
      }
      playbackRef.current = playback;
      const player = playerRef.current;
      if (!player) return;
      // Queue exhausted: stop local playback immediately, before React has
      // delivered videoId=null to the iframe wrapper.
      if (!playback) {
        player.pauseVideo();
        return;
      }
      // Only ever aimed at the room's own video. On a track change this runs
      // before the player has switched, and would otherwise seek and play
      // the previous track for a moment; the player's onReady once it has
      // loaded the new one (handlePlayerReady below) applies it instead.
      if (player.getVideoId() !== playback.videoId) return;
      if (holdFinishedPlayback(playback)) return;

      const expectedMs = computeExpectedPositionMs(playback, Date.now());
      if (playback.status === "PLAYING") {
        player.seekTo(expectedMs / 1000);
        player.playVideo();
      } else if (renderedVideoIdRef.current === playback.videoId) {
        // This video has already painted at least one frame (it was
        // genuinely playing a moment ago), so pausing in place is instant
        // and safe: a paused player stays paused when it seeks.
        player.pauseVideo();
        player.seekTo(expectedMs / 1000);
      } else {
        // Nothing has ever been rendered for this load (a fresh player, a
        // reconnect, a track switch, or a replay all land here first).
        // Seeking a never-played video straight to a PAUSED position can
        // leave YouTube's canvas solid black — it has no decoded frame to
        // show yet. Seek and let it actually play; the first PLAYING
        // confirmation (handlePlayerStateChange) re-pauses it right there,
        // by which point a real frame exists.
        pendingParkRef.current = true;
        player.seekTo(expectedMs / 1000);
        player.playVideo();
      }
    },
    [playerRef, holdFinishedPlayback],
  );

  useEffect(() => {
    if (!roomId || !accountId || !clientId) {
      setState(EMPTY_STATE);
      return;
    }

    const socket: Socket = io({ auth: { accountId, clientId } });
    socketRef.current = socket;

    socket.on("connect", () => {
      // A reconnect may need to contribute its end report again.
      if (finishedRef.current) finishedRef.current.reported = false;
      // Fires on the initial connection AND on every automatic reconnect —
      // either way, re-joining is exactly how a late joiner and a
      // reconnecting client both end up with a fresh authoritative snapshot.
      socket.emit("room:join", { roomId });
    });

    socket.on("disconnect", () => {
      setState((s) => ({ ...s, connected: false, chatMessages: [], chatError: null, incomingPings: [], pingError: null, djHandoff: null }));
    });

    socket.on("room:joinError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, connected: false, joinError: error }));
    });

    // The room auto-closed (7 days with no activity) and the server has
    // already let this socket go — reported like a failed join, since either
    // way this client is no longer in the room.
    socket.on("room:closed", () => {
      applyAnchor(null);
      setState({ ...EMPTY_STATE, joinError: "this room has closed" });
    });

    socket.on("room:snapshot", (snapshot: RoomSnapshot) => {
      const proposalView = proposalViewFromSnapshot(snapshot.activeProposal);
      // Seeded silently — a late join or reconnect catching an already-open
      // vote should never play the "a new vote just started" chime.
      activeProposalIdRef.current = snapshot.activeProposal?.proposalId ?? null;
      setState((s) => ({
        connected: true,
        joinError: null,
        room: snapshot.room,
        queue: snapshot.queue,
        presence: snapshot.presence,
        playback: snapshot.playback,
        activeProposal: proposalView.active,
        lastProposalResult: proposalView.lastResult,
        proposalError: null,
        chatMessages: snapshot.chatMessages,
        chatError: null,
        // Never seeded from the snapshot — pings are never replayed to a
        // late joiner or a reconnecting client (docs/adr/0013).
        incomingPings: [],
        pingError: null,
        djHandoff: null,
        leaveError: null,
        leftRoom: false,
      }));
      applyAnchor(snapshot.playback);
    });

    socket.on("dj:handoff", (handoff: DjHandoff) => {
      setState((s) => ({ ...s, djHandoff: handoff, leaveError: null }));
    });
    socket.on("room:leaveError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, leaveError: error }));
    });
    socket.on("room:left", ({ roomId: leftRoomId }: { roomId: string }) => {
      if (leftRoomId !== roomId) return;
      applyAnchor(null);
      setState({ ...EMPTY_STATE, leftRoom: true });
    });

    socket.on("playback:update", (playback: PlaybackState | null) => {
      setState((s) => ({ ...s, playback }));
      applyAnchor(playback);
    });

    // The server's authoritative verdict on the room's single active
    // proposal (open, or just resolved) — never something the client
    // computes itself. A resolved one moves out of activeProposal into
    // lastProposalResult, so the controls come back as soon as a vote closes.
    socket.on("proposal:update", (update: ProposalBroadcast) => {
      if (update.proposal.state === "OPEN") {
        if (activeProposalIdRef.current !== update.proposal.proposalId) playVoteChime();
        activeProposalIdRef.current = update.proposal.proposalId;
      } else if (activeProposalIdRef.current === update.proposal.proposalId) {
        activeProposalIdRef.current = null;
      }
      setState((s) => {
        const view = applyProposalUpdate({ active: s.activeProposal, lastResult: s.lastProposalResult }, update);
        return { ...s, activeProposal: view.active, lastProposalResult: view.lastResult, proposalError: null };
      });
    });

    socket.on("proposal:requestError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, proposalError: error }));
    });

    socket.on("proposal:voteError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, proposalError: error }));
    });

    socket.on("proposal:cancelError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, proposalError: error }));
    });

    socket.on("queue:itemAdded", (item: QueueItem) => {
      setState((s) => (s.queue.some((q) => q.queueItemId === item.queueItemId) ? s : { ...s, queue: [...s.queue, item] }));
    });

    // An item left the queue: a passed REMOVE_QUEUE_ITEM vote removed it, or
    // it finished playing (ended or skipped — see ProposalManager). Filtered
    // by queueItemId, never by position, so this can never drop the wrong
    // (unrelated) row even if the local queue array has drifted out of order
    // relative to the server.
    socket.on("queue:itemRemoved", ({ queueItemId }: { queueItemId: string }) => {
      setState((s) => ({ ...s, queue: s.queue.filter((q) => q.queueItemId !== queueItemId) }));
    });

    socket.on("presence:join", (entry: PresenceEntry) => {
      setState((s) => (s.presence.some((p) => p.accountId === entry.accountId) ? s : { ...s, presence: [...s.presence, entry] }));
    });

    socket.on("presence:leave", ({ accountId: leftId }: { accountId: string }) => {
      setState((s) => ({ ...s, presence: s.presence.filter((p) => p.accountId !== leftId) }));
    });

    // A passed REORDER_QUEUE vote actually changed the queue order (see
    // ProposalManager.resolveRoom) — the server sends the whole reordered
    // queue rather than a delta, since "which item moved where" is exactly
    // as cheap to broadcast as any patch would be and leaves no room for the
    // client to reconstruct order incorrectly.
    socket.on("queue:reordered", ({ queue }: { queue: QueueItem[] }) => {
      setState((s) => ({ ...s, queue }));
    });

    socket.on("chat:new", (message: ChatMessage) => {
      setState((s) => {
        if (!s.connected || message.roomId !== s.room?.roomId || s.chatMessages.some((m) => m.messageId === message.messageId)) return s;
        return { ...s, chatMessages: [...s.chatMessages, message] };
      });
    });

    // A ping-wheel signal from anyone currently in the room (including this
    // account's own send, echoed back the same as everyone else's — the
    // server is the single source of truth for who gets to see it). Never
    // deduplicated by content: two identical signals from the same account a
    // moment apart are two separate pings, not one.
    socket.on("ping:new", (ping: PingBroadcast) => {
      playPingChime();
      setState((s) => ({
        ...s,
        incomingPings: [...s.incomingPings, { ...ping, id: crypto.randomUUID() }].slice(-MAX_INCOMING_PINGS),
      }));
    });

    socket.on("ping:sendError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, pingError: error }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      playbackRef.current = null;
      finishedRef.current = null;
      setState(EMPTY_STATE);
    };
  }, [roomId, accountId, clientId, applyAnchor]);

  // Wired to <YoutubePlayer onReady>. A late joiner's snapshot (or a track
  // transition's playback:update) usually lands before the player exists or
  // has loaded that video, so applyAnchor had nothing to act on and the
  // player just autoplayed from 0 — even into a PAUSED room, where the drift
  // loop below never runs to correct it. Re-applying the latest anchor once
  // the player is ready with the room's video fixes both.
  const handlePlayerReady = useCallback(() => {
    // A fresh load, whatever the reason — nothing of this video is on
    // screen yet (see applyAnchor's PAUSED branch).
    renderedVideoIdRef.current = null;
    pendingParkRef.current = false;
    applyAnchor(playbackRef.current);
  }, [applyAnchor]);

  // Requests a PLAY/PAUSE/SKIP proposal — never mutates local playback state
  // itself; the server's proposal:update/playback:update events are the only
  // source of truth for what happens next.
  const requestPlaybackProposal = useCallback((type: "PLAY" | "PAUSE" | "SKIP") => {
    socketRef.current?.emit("proposal:request", { type });
  }, []);

  const requestReplayQueueProposal = useCallback((queueItemId: string) => {
    socketRef.current?.emit("proposal:request", { type: "REPLAY_QUEUE_ITEM", queueItemId });
  }, []);

  const requestLeaveRoom = useCallback(() => {
    if (!socketRef.current?.connected) {
      applyAnchor(null);
      setState({ ...EMPTY_STATE, leftRoom: true });
      return;
    }
    socketRef.current.emit("room:leave");
  }, [applyAnchor]);

  const chooseNextDj = useCallback((requestId: string, accountId: string) => {
    socketRef.current?.emit("dj:choose", { requestId, accountId });
  }, []);

  // Requests a SEEK proposal to `positionMs`. Only the current DJ's own
  // request can pass server-side (see ProposalManager.requestPlaybackProposal
  // in server/src/proposals.ts) — a non-DJ caller still gets to emit this,
  // but the server rejects it with a typed NOT_CURRENT_DJ error rather than
  // ever executing it. Requesting is never the same as seeking: the DJ's own
  // browser does not jump ahead locally, it waits for the same
  // proposal:update/playback:update broadcast as everyone else.
  const requestSeekProposal = useCallback((positionMs: number) => {
    socketRef.current?.emit("proposal:request", { type: "SEEK", positionMs });
  }, []);

  // Requests a REMOVE_QUEUE_ITEM proposal for `queueItemId` — never an
  // index/position (CLAUDE.md's Queue and DJ section). The server rejects a
  // request targeting the currently-playing item with a typed
  // IS_CURRENT_TRACK error (see ProposalManager.requestRemoveQueueItem) —
  // use requestPlaybackProposal("SKIP") to move off the current track
  // instead.
  const requestRemoveQueueItemProposal = useCallback((queueItemId: string) => {
    socketRef.current?.emit("proposal:request", { type: "REMOVE_QUEUE_ITEM", queueItemId });
  }, []);

  // Requests a REORDER_QUEUE proposal moving `queueItemId` to just before
  // `beforeQueueItemId`, or to the end of the queue if null. Never mutates
  // the local queue array itself — queue:reordered (only sent once a vote
  // actually passes and the reorder genuinely changes something) is the only
  // source of truth, exactly like every other proposal type here. A drag
  // dropped back onto its original position, or the server otherwise finding
  // no real change, comes back as a typed NO_OP proposal:requestError rather
  // than ever opening a vote — see ProposalManager.requestReorderQueue.
  const requestReorderQueueProposal = useCallback((queueItemId: string, beforeQueueItemId: string | null) => {
    socketRef.current?.emit("proposal:request", { type: "REORDER_QUEUE", queueItemId, beforeQueueItemId });
  }, []);

  const castProposalVote = useCallback((proposalId: string, choice: VoteChoice) => {
    socketRef.current?.emit("proposal:vote", { proposalId, choice });
  }, []);

  // Only the proposer may do this (server/src/proposals.ts's cancelProposal
  // rejects anyone else) — the client only ever shows the button to them.
  const cancelProposalVote = useCallback((proposalId: string) => {
    socketRef.current?.emit("proposal:cancel", { proposalId });
  }, []);

  // Acknowledgement controls draft clearing; failed sends keep the text.
  const sendChatMessage = useCallback((text: string): Promise<boolean> => {
    const socket = socketRef.current;
    if (!socket?.connected) {
      setState((s) => ({ ...s, chatError: "reconnect before sending a message" }));
      return Promise.resolve(false);
    }
    setState((s) => ({ ...s, chatError: null }));
    return new Promise((resolve) => {
      socket.timeout(5_000).emit("chat:send", { text }, (error: Error | null, result?: ChatSendResult) => {
        if (socket !== socketRef.current) return resolve(false);
        if (error || !result?.ok) {
          const message = error
            ? "message not confirmed — check the chat before retrying"
            : result && !result.ok ? result.error : "could not send message";
          setState((s) => s.connected ? { ...s, chatError: message } : s);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }, []);

  // Requests a ping-wheel broadcast at a viewport-relative position (0..1,
  // see PingWheel.tsx) — never mutates incomingPings itself; the server's own
  // ping:new echoes it straight back, exactly like every other account's
  // signal, so there is only ever one code path that adds a ping to the list.
  const sendPingSignal = useCallback((signal: PingSignal, xRatio: number, yRatio: number) => {
    socketRef.current?.emit("ping:send", { signal, xRatio, yRatio });
  }, []);

  // Drops one ping from the toast buffer once its own auto-dismiss timer
  // fires — the overlay component owns the timing, this just removes it.
  const dismissPing = useCallback((id: string) => {
    setState((s) => ({ ...s, incomingPings: s.incomingPings.filter((p) => p.id !== id) }));
  }, []);

  // Clears a shown ping:sendError once its toast's own auto-dismiss timer
  // fires (App.tsx) — otherwise a rejected ping's message would sit on
  // screen forever, unlike every other transient toast in this app.
  const dismissPingError = useCallback(() => {
    setState((s) => ({ ...s, pingError: null }));
  }, []);

  // Wired to <YoutubePlayer onStateChange>. Reject playback without a room
  // track and report ENDED only for the authoritative track.
  // The server independently re-checks the reported playbackId and whether
  // the track can be over yet anyway (see
  // ProposalManager.handleTrackEnded), so this is best-effort, not itself a
  // trust boundary.
  const handlePlayerStateChange = useCallback(
    (playerState: number) => {
      const current = playbackRef.current;
      if (!current) {
        if (playerState === YT_PLAYER_STATE.PLAYING) playerRef.current?.pauseVideo();
        return;
      }
      if (playerRef.current?.getVideoId() !== current.videoId) return;
      if (playerState === YT_PLAYER_STATE.PLAYING) {
        renderedVideoIdRef.current = current.videoId;
        // Our own forced nudge (applyAnchor's PAUSED branch) confirming it
        // actually painted a frame — park it right here instead of letting
        // it run, and skip straight past every other PLAYING branch below.
        if (pendingParkRef.current) {
          pendingParkRef.current = false;
          playerRef.current?.pauseVideo();
          return;
        }
      }
      // The room is paused but this player just started — someone pressed
      // YouTube's own play button. Only the room decides; letting it run
      // meant the track could play (and end) here while the room stayed put.
      if (playerState === YT_PLAYER_STATE.PLAYING && current.status === "PAUSED") {
        applyAnchor(current);
        return;
      }
      if (playerState === YT_PLAYER_STATE.PLAYING && holdFinishedPlayback(current)) return;
      if (playerState !== YT_PLAYER_STATE.ENDED) return;
      if (current.status !== "PLAYING") return;
      // The server rarely knows a track's length now (YouTube's oEmbed
      // doesn't report one), but this player does once the video has loaded.
      // It only decides what this client does, never what the room does.
      const localDurationSeconds = playerRef.current?.getDuration() ?? 0;
      const durationMs = current.durationMs ?? (localDurationSeconds > 0 ? localDurationSeconds * 1000 : null);
      if (!isPlausibleTrackEnd({ ...current, durationMs }, Date.now())) {
        // This player hit the end long before the room did — typically
        // someone dragged YouTube's own scrubber there. Skipping needs a
        // vote, so rather than report an end the server wouldn't act on,
        // put this player back where the room actually is.
        applyAnchor(current);
        return;
      }
      holdFinishedPlayback(current, true);
    },
    [applyAnchor, playerRef, holdFinishedPlayback],
  );

  // The local drift-correction loop — polls the player's own clock, never
  // the network. Suspended entirely unless the local player itself reports
  // PLAYING (so buffering/an ad/a legitimate pause all silently pause this
  // loop too), and for a short grace period right after PLAYING is (re)entered.
  useEffect(() => {
    const interval = setInterval(() => {
      const player = playerRef.current;
      const playback = playbackRef.current;
      if (!player || !playback || playback.status !== "PLAYING") {
        // An idle or paused room's player playing anyway (see handlePlayerStateChange)
        // is caught here too, should that state change ever be missed.
        if (player && (!playback || playback.status === "PAUSED") && player.getPlayerState() === YT_PLAYER_STATE.PLAYING) {
          applyAnchor(playback);
        }
        wasPlayingRef.current = false;
        return;
      }
      if (player.getVideoId() !== playback.videoId) return;

      const playerState = player.getPlayerState();
      if (playerState === YT_PLAYER_STATE.ENDED) {
        handlePlayerStateChange(playerState);
        return;
      }
      if (playerState !== YT_PLAYER_STATE.PLAYING) {
        wasPlayingRef.current = false;
        return;
      }
      if (!wasPlayingRef.current) {
        wasPlayingRef.current = true;
        playingSinceRef.current = Date.now();
      }
      if (playingSinceRef.current !== null && Date.now() - playingSinceRef.current < POST_PLAYING_GRACE_MS) {
        return;
      }
      if (holdFinishedPlayback(playback)) return;

      const actualMs = player.getCurrentTime() * 1000;
      const expectedMs = computeExpectedPositionMs(playback, Date.now());
      const correction = classifyDrift(actualMs, expectedMs);
      if (correction === "seek") {
        player.seekTo(expectedMs / 1000);
      } else if (correction === "hard-resync") {
        player.loadVideoById(playback.videoId, expectedMs / 1000);
      }
    }, DRIFT_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [playerRef, applyAnchor, handlePlayerStateChange, holdFinishedPlayback]);

  return {
    ...state,
    requestPlaybackProposal,
    requestReplayQueueProposal,
    requestLeaveRoom,
    chooseNextDj,
    requestSeekProposal,
    requestRemoveQueueItemProposal,
    requestReorderQueueProposal,
    castProposalVote,
    cancelProposalVote,
    handlePlayerStateChange,
    handlePlayerReady,
    sendChatMessage,
    sendPingSignal,
    dismissPing,
    dismissPingError,
  };
}
