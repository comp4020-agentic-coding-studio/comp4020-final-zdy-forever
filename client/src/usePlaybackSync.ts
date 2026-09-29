import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { classifyDrift, computeExpectedPositionMs } from "../../shared/src/playbackSync.ts";
import type {
  PlaybackState,
  PresenceEntry,
  QueueItem,
  ReorderTokenBalance,
  Room,
  RoomSnapshot,
} from "../../shared/src/types.ts";
import type { Proposal, VoteChoice } from "../../shared/src/voting.ts";
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
  // The room's single in-flight PLAY/PAUSE vote, or null if none is open.
  // Seeded from room:snapshot on (re)join so a late joiner or a reconnecting
  // client sees an in-progress vote immediately, then kept current by
  // proposal:update.
  activeProposal: Proposal | null;
  proposalError: string | null;
  // This client's own reorder-token balance in this room, or null before the
  // initial fetch (right after join) has resolved. Always server-computed
  // (see GET /api/rooms/:roomId/reorder-tokens/:accountId) — never tracked
  // or decremented locally; reorderTokens:update is the only thing that ever
  // changes it after the initial fetch.
  reorderTokenBalance: ReorderTokenBalance | null;
}

const EMPTY_STATE: RoomLiveState = {
  connected: false,
  joinError: null,
  room: null,
  queue: [],
  presence: [],
  playback: null,
  activeProposal: null,
  proposalError: null,
  reorderTokenBalance: null,
};

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

  // Applies a freshly-received anchor to the local player exactly once —
  // this, not a continuous stream, is the entire mechanism for late-join and
  // reconnect sync (CLAUDE.md: "reconnect and late join must start from an
  // authoritative room snapshot").
  function applyAnchor(playback: PlaybackState | null) {
    playbackRef.current = playback;
    const player = playerRef.current;
    if (!player || !playback) return;

    const expectedMs = computeExpectedPositionMs(playback, Date.now());
    player.seekTo(expectedMs / 1000);
    if (playback.status === "PLAYING") {
      player.playVideo();
    } else {
      player.pauseVideo();
    }
  }

  useEffect(() => {
    if (!roomId || !accountId || !clientId) {
      setState(EMPTY_STATE);
      return;
    }

    const socket: Socket = io({ auth: { accountId, clientId } });
    socketRef.current = socket;

    socket.on("connect", () => {
      // Fires on the initial connection AND on every automatic reconnect —
      // either way, re-joining is exactly how a late joiner and a
      // reconnecting client both end up with a fresh authoritative snapshot.
      socket.emit("room:join", { roomId });
    });

    socket.on("disconnect", () => {
      setState((s) => ({ ...s, connected: false }));
    });

    socket.on("room:joinError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, connected: false, joinError: error }));
    });

    socket.on("room:snapshot", (snapshot: RoomSnapshot) => {
      setState((s) => ({
        connected: true,
        joinError: null,
        room: snapshot.room,
        queue: snapshot.queue,
        presence: snapshot.presence,
        playback: snapshot.playback,
        activeProposal: snapshot.activeProposal,
        proposalError: null,
        reorderTokenBalance: s.reorderTokenBalance,
      }));
      applyAnchor(snapshot.playback);

      // The snapshot itself carries no reorder-token balance (it's not part
      // of room-shared state, unlike the queue/playback/presence above) — a
      // fresh REST fetch on every (re)join keeps it correct even if this
      // client missed reorderTokens:update broadcasts while disconnected.
      fetch(`/api/rooms/${roomId}/reorder-tokens/${accountId}`)
        .then((res) => (res.ok ? (res.json() as Promise<ReorderTokenBalance>) : null))
        .then((balance) => {
          if (balance) setState((s) => ({ ...s, reorderTokenBalance: balance }));
        })
        .catch(() => {
          // Best-effort: a failed fetch just leaves the last-known (or null)
          // balance in place; reorderTokens:update will correct it on the
          // next successful reorder regardless.
        });
    });

    socket.on("playback:update", (playback: PlaybackState | null) => {
      setState((s) => ({ ...s, playback }));
      applyAnchor(playback);
    });

    // The server's authoritative verdict on the room's single active
    // proposal (open, or just resolved) — never something the client
    // computes itself. A resolved proposal briefly stays visible (e.g. to
    // show "passed") until the next request clears it.
    socket.on("proposal:update", ({ proposal }: { proposal: Proposal; applied: boolean }) => {
      setState((s) => ({ ...s, activeProposal: proposal, proposalError: null }));
    });

    socket.on("proposal:requestError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, proposalError: error }));
    });

    socket.on("proposal:voteError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, proposalError: error }));
    });

    socket.on("queue:itemAdded", (item: QueueItem) => {
      setState((s) => (s.queue.some((q) => q.queueItemId === item.queueItemId) ? s : { ...s, queue: [...s.queue, item] }));
    });

    // A passed REMOVE_QUEUE_ITEM vote actually removed this item (see
    // ProposalManager.resolveRoom) — filtered by queueItemId, never by
    // position, so this can never drop the wrong (unrelated) row even if the
    // local queue array has drifted out of order relative to the server.
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

    // This account's reorder-token balance changed (a token was just spent
    // by a passed reorder this account proposed) — filtered to this client's
    // own accountId, since every client in the room receives every account's
    // update but only cares about its own.
    socket.on("reorderTokens:update", ({ accountId: forId, balance }: { accountId: string; balance: ReorderTokenBalance }) => {
      if (forId !== accountId) return;
      setState((s) => ({ ...s, reorderTokenBalance: balance }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      playbackRef.current = null;
      setState(EMPTY_STATE);
    };
  }, [roomId, accountId, clientId]);

  // Requests a PLAY/PAUSE/SKIP proposal — never mutates local playback state
  // itself; the server's proposal:update/playback:update events are the only
  // source of truth for what happens next.
  const requestPlaybackProposal = useCallback((type: "PLAY" | "PAUSE" | "SKIP") => {
    socketRef.current?.emit("proposal:request", { type });
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

  // Wired to <YoutubePlayer onStateChange>. Only ENDED matters here, and
  // only while a room's own track is actually loaded (playbackRef.current is
  // null whenever the visible video is just a locally-browsed one, not the
  // room's authoritative track) — the server independently re-checks the
  // reported playbackId anyway (see ProposalManager.handleTrackEnded), so
  // this is best-effort, not itself a trust boundary.
  const handlePlayerStateChange = useCallback((playerState: number) => {
    if (playerState !== YT_PLAYER_STATE.ENDED) return;
    const current = playbackRef.current;
    if (!current) return;
    socketRef.current?.emit("playback:ended", { playbackId: current.playbackId });
  }, []);

  // The local drift-correction loop — polls the player's own clock, never
  // the network. Suspended entirely unless the local player itself reports
  // PLAYING (so buffering/an ad/a legitimate pause all silently pause this
  // loop too), and for a short grace period right after PLAYING is (re)entered.
  useEffect(() => {
    const interval = setInterval(() => {
      const player = playerRef.current;
      const playback = playbackRef.current;
      if (!player || !playback || playback.status !== "PLAYING") {
        wasPlayingRef.current = false;
        return;
      }

      const playerState = player.getPlayerState();
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
  }, [playerRef]);

  return {
    ...state,
    requestPlaybackProposal,
    requestSeekProposal,
    requestRemoveQueueItemProposal,
    requestReorderQueueProposal,
    castProposalVote,
    handlePlayerStateChange,
  };
}
