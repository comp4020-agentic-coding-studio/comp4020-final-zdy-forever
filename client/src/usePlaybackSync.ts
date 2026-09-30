import { useCallback, useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { classifyDrift, computeExpectedPositionMs, isPlausibleTrackEnd } from "../../shared/src/playbackSync.ts";
import type {
  PlaybackState,
  PresenceEntry,
  QueueItem,
  Reaction,
  ReactionEmoji,
  ReactionEvent,
  ReorderTokenBalance,
  Room,
  RoomSnapshot,
} from "../../shared/src/types.ts";
import type { Proposal, ProposalBroadcast, VoteChoice } from "../../shared/src/voting.ts";
import { applyProposalUpdate, proposalViewFromSnapshot } from "./proposalView.ts";
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

// How often the local player position is checked against reactionHistory
// looking for a not-yet-fired historical reaction to echo — purely local,
// never a network call, mirroring the drift-poll above (CLAUDE.md's
// Reactions section: echoes are a client-side replay concern, not something
// the server schedules).
const ECHO_POLL_INTERVAL_MS = 1000;

// How close local playback position must come to a stored reaction's
// original positionMs before that reaction is echoed — wide enough to
// tolerate the 1-second poll cadence and ordinary drift, narrow enough that
// an echo still reads as "near its original timestamp."
const ECHO_MATCH_WINDOW_MS = 1500;

// How long a single displayed reaction (live or echo) stays in the feed
// before it's removed.
const REACTION_DISPLAY_MS = 4000;

// A reaction currently shown in the transient feed — kind distinguishes a
// live broadcast from a historical replay at render time (CLAUDE.md's
// Reactions section: "keep live reactions and historical echoes
// distinguishable"), never encoded on the Reaction record itself.
export interface DisplayedReaction {
  key: string;
  kind: "LIVE" | "ECHO";
  reaction: Reaction;
}

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
  // This client's own reorder-token balance in this room, or null before the
  // initial fetch (right after join) has resolved. Always server-computed
  // (see GET /api/rooms/:roomId/reorder-tokens/:accountId) — never tracked
  // or decremented locally; reorderTokens:update is the only thing that ever
  // changes it after the initial fetch.
  reorderTokenBalance: ReorderTokenBalance | null;
  // Every reaction ever recorded against the currently-playing video —
  // seeded from room:snapshot/reactions:history, and what the echo-scanning
  // poll below matches local playback position against.
  reactionHistory: Reaction[];
  // Transient feed of reactions currently on screen (both LIVE broadcasts
  // and ECHO sightings) — never persisted, purely a display concern.
  liveReactions: DisplayedReaction[];
  reactionError: string | null;
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
  reorderTokenBalance: null,
  reactionHistory: [],
  liveReactions: [],
  reactionError: null,
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
  const reactionHistoryRef = useRef<Reaction[]>([]);
  // reactionIds already echoed for the currently-loaded video — cleared
  // whenever reactionHistory is replaced wholesale (a genuine track
  // transition), so the same historical reaction can echo again the next
  // time its video plays.
  const firedEchoIdsRef = useRef<Set<string>>(new Set());

  // Shows a reaction in the transient feed for REACTION_DISPLAY_MS, then
  // removes it — shared by the live broadcast handler and the echo-scanning
  // poll below.
  const pushDisplayedReaction = useCallback((kind: "LIVE" | "ECHO", reaction: Reaction) => {
    const key = `${kind}:${reaction.reactionId}:${Date.now()}:${Math.random()}`;
    setState((s) => ({ ...s, liveReactions: [...s.liveReactions, { key, kind, reaction }] }));
    setTimeout(() => {
      setState((s) => ({ ...s, liveReactions: s.liveReactions.filter((r) => r.key !== key) }));
    }, REACTION_DISPLAY_MS);
  }, []);

  // Applies a freshly-received anchor to the local player exactly once —
  // this, not a continuous stream, is the entire mechanism for late-join and
  // reconnect sync (CLAUDE.md: "reconnect and late join must start from an
  // authoritative room snapshot"). Only refs are read, so it's stable.
  const applyAnchor = useCallback(
    (playback: PlaybackState | null) => {
      playbackRef.current = playback;
      const player = playerRef.current;
      if (!player || !playback) return;
      // Only ever aimed at the room's own video. On a track change this runs
      // before the player has switched, and would otherwise seek and play
      // the previous track for a moment; the player's onReady once it has
      // loaded the new one (handlePlayerReady below) applies it instead.
      if (player.getVideoId() !== playback.videoId) return;

      const expectedMs = computeExpectedPositionMs(playback, Date.now());
      if (playback.status === "PLAYING") {
        player.seekTo(expectedMs / 1000);
        player.playVideo();
      } else {
        // Pause first: a paused YouTube player stays paused when it seeks,
        // so parking it can never itself set it playing again.
        player.pauseVideo();
        player.seekTo(expectedMs / 1000);
      }
    },
    [playerRef],
  );

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

    // The room auto-closed (2 hours with no activity) and the server has
    // already let this socket go — reported like a failed join, since either
    // way this client is no longer in the room.
    socket.on("room:closed", () => {
      setState((s) => ({ ...s, connected: false, joinError: "this room closed after 2 hours with no activity" }));
    });

    socket.on("room:snapshot", (snapshot: RoomSnapshot) => {
      reactionHistoryRef.current = snapshot.reactionHistory;
      firedEchoIdsRef.current = new Set();
      const proposalView = proposalViewFromSnapshot(snapshot.activeProposal);
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
        reorderTokenBalance: s.reorderTokenBalance,
        reactionHistory: snapshot.reactionHistory,
        liveReactions: [],
        reactionError: null,
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
    // computes itself. A resolved one moves out of activeProposal into
    // lastProposalResult, so the controls come back as soon as a vote closes.
    socket.on("proposal:update", (update: ProposalBroadcast) => {
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

    // This account's reorder-token balance changed (a token was just spent
    // by a passed reorder this account proposed) — filtered to this client's
    // own accountId, since every client in the room receives every account's
    // update but only cares about its own.
    socket.on("reorderTokens:update", ({ accountId: forId, balance }: { accountId: string; balance: ReorderTokenBalance }) => {
      if (forId !== accountId) return;
      setState((s) => ({ ...s, reorderTokenBalance: balance }));
    });

    // The full historical reaction list for whatever video just became
    // current — sent only at a genuine track transition (see
    // server/src/reactions.ts's broadcastReactionHistory), never on every
    // PLAY/PAUSE/SEEK update. Replaces reactionHistory wholesale and clears
    // which echoes have already fired, since this is a fresh video.
    socket.on("reactions:history", ({ reactions }: { videoId: string; reactions: Reaction[] }) => {
      reactionHistoryRef.current = reactions;
      firedEchoIdsRef.current = new Set();
      setState((s) => ({ ...s, reactionHistory: reactions }));
    });

    // A reaction just sent by someone in the room, right now — always
    // { kind: "LIVE" } over the wire (CLAUDE.md's Reactions section: live
    // reactions broadcast immediately). It also belongs in reactionHistory
    // so a client already in the room echoes it correctly on a later replay
    // without waiting for the next reactions:history.
    socket.on("reaction:new", (event: ReactionEvent) => {
      reactionHistoryRef.current = [...reactionHistoryRef.current, event.reaction];
      // Mark it as already-fired immediately — it was just shown live, so
      // the echo-scanning poll must not also fire it as an ECHO of itself
      // moments later while this same playthrough is still going.
      firedEchoIdsRef.current.add(event.reaction.reactionId);
      setState((s) => ({ ...s, reactionHistory: [...s.reactionHistory, event.reaction] }));
      pushDisplayedReaction(event.kind, event.reaction);
    });

    socket.on("reaction:sendError", ({ error }: { error: string }) => {
      setState((s) => ({ ...s, reactionError: error }));
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      playbackRef.current = null;
      reactionHistoryRef.current = [];
      firedEchoIdsRef.current = new Set();
      setState(EMPTY_STATE);
    };
  }, [roomId, accountId, clientId, pushDisplayedReaction, applyAnchor]);

  // Wired to <YoutubePlayer onReady>. A late joiner's snapshot (or a track
  // transition's playback:update) usually lands before the player exists or
  // has loaded that video, so applyAnchor had nothing to act on and the
  // player just autoplayed from 0 — even into a PAUSED room, where the drift
  // loop below never runs to correct it. Re-applying the latest anchor once
  // the player is ready with the room's video fixes both.
  const handlePlayerReady = useCallback(() => {
    applyAnchor(playbackRef.current);
  }, [applyAnchor]);

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

  // Sends a reaction — never requires voting (CLAUDE.md's Reactions/Voting
  // sections). The server computes positionMs authoritatively; this call
  // carries only the chosen emoji.
  const sendReaction = useCallback((reaction: ReactionEmoji) => {
    socketRef.current?.emit("reaction:send", { reaction });
  }, []);

  // Wired to <YoutubePlayer onStateChange>. Only ENDED matters here, and
  // only while a room's own track is actually loaded (playbackRef.current is
  // null whenever the visible video is just a locally-browsed one, not the
  // room's authoritative track) — the server independently re-checks the
  // reported playbackId and whether the track can be over yet anyway (see
  // ProposalManager.handleTrackEnded), so this is best-effort, not itself a
  // trust boundary.
  const handlePlayerStateChange = useCallback(
    (playerState: number) => {
      const current = playbackRef.current;
      if (!current) return;
      // The room is paused but this player just started — someone pressed
      // YouTube's own play button. Only the room decides; letting it run
      // meant the track could play (and end) here while the room stayed put.
      if (playerState === YT_PLAYER_STATE.PLAYING && current.status === "PAUSED") {
        applyAnchor(current);
        return;
      }
      if (playerState !== YT_PLAYER_STATE.ENDED) return;
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
      socketRef.current?.emit("playback:ended", { playbackId: current.playbackId });
    },
    [applyAnchor, playerRef],
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
        // A paused room's player playing anyway (see handlePlayerStateChange)
        // is caught here too, should that state change ever be missed.
        if (player && playback?.status === "PAUSED" && player.getPlayerState() === YT_PLAYER_STATE.PLAYING) {
          applyAnchor(playback);
        }
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
  }, [playerRef, applyAnchor]);

  // The historical-echo loop: purely local, checks the player's own current
  // position against reactionHistory looking for a not-yet-fired reaction
  // whose original positionMs is now nearby (CLAUDE.md's Reactions section:
  // "stored reactions can reappear near the original timestamp"). Only
  // scans while genuinely PLAYING, mirroring the drift-poll's own guard.
  useEffect(() => {
    const interval = setInterval(() => {
      const player = playerRef.current;
      const playback = playbackRef.current;
      if (!player || !playback || playback.status !== "PLAYING") return;
      if (player.getPlayerState() !== YT_PLAYER_STATE.PLAYING) return;

      const expectedMs = computeExpectedPositionMs(playback, Date.now());
      for (const reaction of reactionHistoryRef.current) {
        if (firedEchoIdsRef.current.has(reaction.reactionId)) continue;
        if (Math.abs(reaction.positionMs - expectedMs) <= ECHO_MATCH_WINDOW_MS) {
          firedEchoIdsRef.current.add(reaction.reactionId);
          pushDisplayedReaction("ECHO", reaction);
        }
      }
    }, ECHO_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [playerRef, pushDisplayedReaction]);

  return {
    ...state,
    requestPlaybackProposal,
    requestSeekProposal,
    requestRemoveQueueItemProposal,
    requestReorderQueueProposal,
    castProposalVote,
    handlePlayerStateChange,
    handlePlayerReady,
    sendReaction,
  };
}
