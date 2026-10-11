import { randomUUID } from "node:crypto";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, describe, expect, inject, it } from "vitest";
import type { ProposalBroadcast } from "../shared/src/voting.ts";

// This repo's brief: anyone can speak freely — chat, or add a song — because
// neither takes anything away from anyone else, so neither needs a vote.
// Anything that would interrupt what the room is already doing (play,
// pause, skip, seek, remove, reorder) takes something away from whoever's
// listening, so it always goes through a vote first (CLAUDE.md's Voting
// section). `server/src/proposals.test.ts` already proves this against the
// in-process engine; this checks the same promise end to end against the
// actual deployed app, over its real HTTP and Socket.IO wire protocol — the
// same running instance every other spec/ check holds to account.
const baseUrl = inject("baseUrl");
const SONG_ID = "dQw4w9WgXcQ";

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function register(displayName: string): Promise<{ accountId: string; clientId: string }> {
  const clientId = randomUUID();
  const { body } = await post("/api/register", { clientId, displayName });
  return { accountId: body.accountId as string, clientId };
}

async function createRoom(who: { accountId: string; clientId: string }): Promise<string> {
  const { status, body } = await post("/api/rooms", { ...who, name: "spec brief", visibility: "PUBLIC" });
  expect(status).toBe(201);
  return body.roomId as string;
}

let sockets: ClientSocket[] = [];
afterEach(() => {
  for (const socket of sockets) socket.close();
  sockets = [];
});

function connect(who: { accountId: string; clientId: string }): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, { auth: who, transports: ["websocket"], forceNew: true });
    sockets.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (err) => reject(err));
  });
}

function joinRoom(socket: ClientSocket, roomId: string): Promise<void> {
  return new Promise((resolve) => {
    socket.once("room:snapshot", () => resolve());
    socket.emit("room:join", { roomId });
  });
}

function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, (payload: T) => resolve(payload)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the brief: adding never votes, interrupting the room always does", () => {
  it("passes Skip after the full window when another connected member abstains", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const roomId = await createRoom(alice);
    const aliceSocket = await connect(alice);
    await joinRoom(aliceSocket, roomId);
    const bobSocket = await connect(bob);
    await joinRoom(bobSocket, roomId);
    const added = await post(`/api/rooms/${roomId}/queue`, { ...alice, input: SONG_ID });
    expect(added.status).toBe(201);

    const opened = Promise.all([
      waitFor<ProposalBroadcast>(aliceSocket, "proposal:update"),
      waitFor<ProposalBroadcast>(bobSocket, "proposal:update"),
    ]);
    aliceSocket.emit("proposal:request", { type: "SKIP" });
    const [aliceOpened, first] = await opened;
    expect(aliceOpened).toEqual(first);
    expect(first.proposal.state).toBe("OPEN");
    expect(first.applied).toBe(false);
    expect(first.proposal.expiresAt - first.proposal.createdAt).toBe(15_000);

    // Bob stays connected and can still vote, but sends no ballot. Both
    // clients must receive the same successful result at the deadline.
    const [aliceResult, bobResult] = await Promise.all([
      waitFor<ProposalBroadcast>(aliceSocket, "proposal:update"),
      waitFor<ProposalBroadcast>(bobSocket, "proposal:update"),
    ]);
    expect(Date.now()).toBeGreaterThanOrEqual(first.proposal.expiresAt);
    expect(aliceResult).toEqual(bobResult);
    expect(bobResult.proposal.proposalId).toBe(first.proposal.proposalId);
    expect(bobResult.proposal.votes).toEqual({ [alice.accountId]: "YES" });
    expect(bobResult.proposal.state).toBe("PASSED");
    expect(bobResult.applied).toBe(true);
    expect(bobSocket.connected).toBe(true);
  }, 25_000);

  it("adding a track to the queue never opens a vote", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const roomId = await createRoom(alice);

    // A REST add requires the adder to already be present in the room (see
    // server/src/index.ts's queue route), so both join over the socket
    // first — exactly how a real client would.
    const aliceSocket = await connect(alice);
    await joinRoom(aliceSocket, roomId);
    const bobSocket = await connect(bob);
    await joinRoom(bobSocket, roomId);

    let sawProposal = false;
    aliceSocket.on("proposal:update", () => {
      sawProposal = true;
    });
    bobSocket.on("proposal:update", () => {
      sawProposal = true;
    });

    const added = await post(`/api/rooms/${roomId}/queue`, { ...alice, input: SONG_ID });
    expect(added.status).toBe(201);

    // Adding the first track also starts it playing (a playback:update, not
    // a vote) — give a wrongly-opened proposal:update time to arrive too.
    await sleep(500);
    expect(sawProposal).toBe(false);
  });

  it("proposing to pause the room opens a vote the other member can see and decide, not an immediate change", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const roomId = await createRoom(alice);

    const aliceSocket = await connect(alice);
    await joinRoom(aliceSocket, roomId);
    const bobSocket = await connect(bob);
    await joinRoom(bobSocket, roomId);

    // Adding the only track starts it PLAYING immediately — no vote needed
    // to add it (checked above), but it leaves something for Alice to
    // propose pausing.
    await post(`/api/rooms/${roomId}/queue`, { ...alice, input: SONG_ID });

    const bobSeesOpenVote = waitFor<{ proposal: { type: string; state: string }; applied: boolean }>(
      bobSocket,
      "proposal:update",
    );
    aliceSocket.emit("proposal:request", { type: "PAUSE" });
    const opened = await bobSeesOpenVote;

    // Two accounts are present, so this cannot be the sole-listener
    // exception (docs/adr/0004) — it has to be a real, undecided vote.
    expect(opened.proposal.type).toBe("PAUSE");
    expect(opened.proposal.state).toBe("OPEN");
  });
});
