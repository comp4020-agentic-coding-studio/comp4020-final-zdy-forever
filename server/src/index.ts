import express from "express";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import type {
  Account,
  CreateRoomRequest,
  HealthResponse,
  JoinRoomResult,
  LobbyRoom,
  QueueItem,
  RegisterRequest,
  Room,
  RoomPlaybackSnapshot,
} from "../../shared/src/types.ts";
import { getAccountByClientId, getAccountById, registerAccount, renameAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { handleYoutubeError } from "./httpErrors.ts";
import { listRecentLogs, withAccountDisplayNames } from "./logging.ts";
import {
  ensureCurrentTrack,
  getCurrentPlayback,
  getNextTrack,
  recordServerAlive,
  recoverPlaybackOnStartup,
  SERVER_ALIVE_INTERVAL_MS,
} from "./playback.ts";
import { addTrack, InvalidTrackError, listQueue } from "./queue.ts";
import { attachRealtime } from "./realtime.ts";
import {
  createRoom,
  getActiveRoomByCode,
  getRoomById,
  joinRoom,
  listPublicLobby,
  RoomClosedError,
} from "./rooms.ts";

// Bundled (server/dist/index.js) and unbundled (server/src/index.ts) both
// sit two levels below the repo root, so this resolves correctly either way.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const clientDist = path.join(repoRoot, "client/dist");

// DATABASE_PATH is how deployment configures where the SQLite file lives (the
// Dockerfile points it at the Fly volume mounted at /data); a plain checkout
// falls back to a repo-local file for local dev and manual runs.
const databasePath = process.env.DATABASE_PATH ?? path.join(repoRoot, "data/echo-room.sqlite");
const db = openDatabase(databasePath);

// Per CLAUDE.md's Persistence section: a previously playing track must
// recover at its last saved position as PAUSED, never extrapolated forward
// through the unknown downtime. Must run before any socket can connect.
recoverPlaybackOnStartup(db);

// Keeps server_liveness current so the next restart knows how far each
// playing track had got (see recoverPlaybackOnStartup). Failing to record it
// only makes that recovery less precise, so it must never take the server
// down.
const recordAlive = () => {
  try {
    recordServerAlive(db);
  } catch (err) {
    console.error("failed to record server liveness:", err);
  }
};
recordAlive();
setInterval(recordAlive, SERVER_ALIVE_INTERVAL_MS).unref();

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer);
const { presence, evictIfClosed } = attachRealtime(io, db);

app.get("/api/health", (_req, res) => {
  const body: HealthResponse = { status: "ok", uptime: process.uptime() };
  res.json(body);
});

// Every REST call that acts as an account proves it the way a socket does
// (see realtime.ts's io.use): with the clientId that registered it, which
// only that browser holds. An accountId alone is no proof — it's public,
// broadcast to a whole room via presence, queue addedBy and chat — and
// trusting one used to let anyone add tracks (becoming DJ) or join rooms as
// someone else.
function matchesRegisteredAccount(accountId: string, clientId: string): boolean {
  return Boolean(accountId && clientId && getAccountByClientId(db, clientId)?.accountId === accountId);
}

// For a POST/PUT body. Responds 401 and returns null when the pair doesn't match.
function authenticate(req: express.Request, res: express.Response): string | null {
  const body = req.body as { accountId?: unknown; clientId?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  if (matchesRegisteredAccount(accountId, clientId)) return accountId;
  res.status(401).json({ error: "accountId and clientId must match a registered account" });
  return null;
}

// Same check, for a GET's query string instead of a body.
function authenticateQuery(req: express.Request, res: express.Response): string | null {
  const accountId = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
  const clientId = typeof req.query.clientId === "string" ? req.query.clientId : "";
  if (matchesRegisteredAccount(accountId, clientId)) return accountId;
  res.status(401).json({ error: "accountId and clientId must match a registered account" });
  return null;
}

// Display text is bounded so one client can't store (and have broadcast to a
// whole room) an arbitrarily large name; counted in characters, not bytes.
const MAX_DISPLAY_NAME_LENGTH = 32;
const MAX_ROOM_NAME_LENGTH = 60;
const tooLong = (text: string, max: number) => [...text].length > max;

// Lightweight registration: a browser sends the clientId it persists locally
// plus a chosen displayName, and gets back its account (creating one on first
// contact, or the existing one for a clientId already seen). displayName is
// never used as identity and duplicates across accounts freely.
app.post("/api/register", (req, res) => {
  const body = req.body as Partial<RegisterRequest>;
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";

  if (!clientId || !displayName) {
    res.status(400).json({ error: "clientId and displayName are required" });
    return;
  }
  if (tooLong(displayName, MAX_DISPLAY_NAME_LENGTH)) {
    res.status(400).json({ error: `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters` });
    return;
  }

  const account: Account = registerAccount(db, clientId, displayName);
  res.json(account);
});

// Renames the calling account (proved by its clientId, like every other call
// that acts as one). The same length limit as registering applies.
app.post("/api/account/name", (req, res) => {
  const accountId = authenticate(req, res);
  if (!accountId) return;
  const body = req.body as { displayName?: unknown };
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) {
    res.status(400).json({ error: "displayName is required" });
    return;
  }
  if (tooLong(displayName, MAX_DISPLAY_NAME_LENGTH)) {
    res.status(400).json({ error: `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters` });
    return;
  }
  const account: Account | undefined = renameAccount(db, accountId, displayName);
  res.json(account);
});

// Picks a returning browser's account back up from the clientId it keeps
// locally, so a page refresh doesn't ask for a name again (and can go
// straight back to its room). The clientId is the secret here, exactly as in
// authenticate above; a browser never seen before gets { account: null }.
app.post("/api/session", (req, res) => {
  const body = req.body as { clientId?: unknown };
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  if (!clientId) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  const account: Account | null = getAccountByClientId(db, clientId) ?? null;
  res.json({ account });
});

// Creates a room, owned by the calling account. A PRIVATE room's code is
// handed back here, to its creator (and later to members, in the room
// snapshot) — never in the lobby.
app.post("/api/rooms", (req, res) => {
  const accountId = authenticate(req, res);
  if (!accountId) return;
  const body = req.body as Partial<CreateRoomRequest>;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const visibility = body.visibility;

  if (!name || (visibility !== "PUBLIC" && visibility !== "PRIVATE")) {
    res.status(400).json({ error: "name and visibility (PUBLIC or PRIVATE) are required" });
    return;
  }
  if (tooLong(name, MAX_ROOM_NAME_LENGTH)) {
    res.status(400).json({ error: `name must be at most ${MAX_ROOM_NAME_LENGTH} characters` });
    return;
  }

  const room: Room = createRoom(db, { accountId, name, visibility });
  res.status(201).json(room);
});

// The public lobby only ever lists PUBLIC, open rooms — a PRIVATE room (and
// its code) never appears here.
app.get("/api/lobby", (_req, res) => {
  const rooms: LobbyRoom[] = listPublicLobby(db, (roomId) => presence.count(roomId));
  res.json(rooms);
});

// Records `accountId` as a member of `room` and reports how many people are
// in it right now. The capacity check here is only an early answer for the
// person joining: someone else can still take the last place before their
// socket arrives, and the socket's room:join is where capacity is actually
// enforced (server/src/realtime.ts).
function admit(res: express.Response, room: Room, accountId: string): void {
  if (!presence.canAdmit(room.roomId, accountId, room.maxUsers)) {
    res.status(409).json({ error: "that room is full (12 people max)" });
    return;
  }
  try {
    const joined = joinRoom(db, room.roomId, accountId);
    const result: JoinRoomResult = { room: joined, occupancy: presence.count(room.roomId) };
    res.json(result);
  } catch (err) {
    if (err instanceof RoomClosedError) {
      res.status(409).json({ error: "that room has closed" });
      return;
    }
    throw err;
  }
}

// Joins a PUBLIC room directly by id. A PRIVATE room is reported as
// not-found here (not 403/409) so probing roomIds can't be used to learn
// that a private room exists.
app.post("/api/rooms/:roomId/join", (req, res) => {
  const accountId = authenticate(req, res);
  if (!accountId) return;

  const room = getRoomById(db, req.params.roomId);
  if (!room || room.visibility !== "PUBLIC") {
    res.status(404).json({ error: "room not found" });
    return;
  }

  admit(res, room, accountId);
});

// Joins a PRIVATE (or PUBLIC) room by its 6-digit code — the only way to
// reach a PRIVATE room, since it never appears in the lobby.
app.post("/api/rooms/join-by-code", (req, res) => {
  const accountId = authenticate(req, res);
  if (!accountId) return;
  const body = req.body as { code?: unknown };
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "a 6-digit code is required" });
    return;
  }

  const room = getActiveRoomByCode(db, code);
  if (!room) {
    res.status(404).json({ error: "invalid code" });
    return;
  }

  admit(res, room, accountId);
});

// Lists a room's queue in stable insertion order. queueItemId, not array
// position, is each item's identity.
app.get("/api/rooms/:roomId/queue", (req, res) => {
  const { roomId } = req.params;
  if (!getRoomById(db, roomId)) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  const queue: QueueItem[] = listQueue(db, roomId);
  res.json(queue);
});

// Adds a track from a pasted URL (or bare videoId), always treated as
// untrusted input. Never requires a vote, but does
// require being in the (open) room right now: only people listening can add
// to what everyone hears, and a closed room takes no more changes.
app.post("/api/rooms/:roomId/queue", async (req, res) => {
  const accountId = authenticate(req, res);
  if (!accountId) return;
  const { roomId } = req.params;
  const body = req.body as { input?: unknown };
  const input = typeof body.input === "string" ? body.input.trim() : "";

  if (!input) {
    res.status(400).json({ error: "input is required" });
    return;
  }
  const room = getRoomById(db, roomId);
  if (!room || !presence.isPresent(roomId, accountId)) {
    // Not-present reads as not-found, the same as the socket join, so this
    // can't be used to learn that a private room exists.
    res.status(404).json({ error: "room not found — join it before adding tracks" });
    return;
  }
  if (room.closed) {
    evictIfClosed(roomId);
    res.status(409).json({ error: "that room has closed" });
    return;
  }

  try {
    const item: QueueItem = await addTrack(db, roomId, accountId, input);
    // If nothing is currently playing in this room (e.g. this is the first
    // track ever added, or the queue had drained), it starts playing now —
    // ensureCurrentTrack only returns non-null when this call actually
    // started it, so the broadcast doesn't fire when a track was already
    // playing.
    const started = ensureCurrentTrack(db, roomId, item.queueItemId);
    io.to(roomId).emit("queue:itemAdded", item);
    if (started) {
      io.to(roomId).emit("playback:update", started);
    }
    res.status(201).json(item);
  } catch (err) {
    if (err instanceof InvalidTrackError) {
      res.status(400).json({ error: err.message });
      return;
    }
    handleYoutubeError(res, err);
  }
});

// The current track (with its sync anchor), current DJ, and next track — a
// plain read-only snapshot; the live client gets the same from room:snapshot.
app.get("/api/rooms/:roomId/playback", (req, res) => {
  const { roomId } = req.params;
  if (!getRoomById(db, roomId)) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  const snapshot: RoomPlaybackSnapshot = {
    current: getCurrentPlayback(db, roomId),
    next: getNextTrack(db, roomId),
  };
  res.json(snapshot);
});

// A room's recent activity feed — "what's happening right now" (the
// observability crit asks for; see server/src/logging.ts). Requires being a
// presently-admitted member of the room, the same bar as chat (CLAUDE.md:
// "Only authenticated members currently in the room may send or receive
// messages"), not queue/playback's open-by-roomId read above: a log row
// names who did what (joins, votes, DJ handoff) far more precisely than a
// queue item's addedBy ever does. accountId is decorated with the account's
// current displayName for display only — see withAccountDisplayNames's own
// doc comment for why that can never replace accountId as identity.
app.get("/api/rooms/:roomId/logs", (req, res) => {
  const accountId = authenticateQuery(req, res);
  if (!accountId) return;
  const { roomId } = req.params;
  if (!getRoomById(db, roomId) || !presence.isPresent(roomId, accountId)) {
    // Not-present reads as not-found, the same as the queue route above, so
    // this can't be used to learn that a private room exists.
    res.status(404).json({ error: "room not found — join it before viewing its logs" });
    return;
  }
  res.json(withAccountDisplayNames(db, listRecentLogs(db, { roomId })));
});

// There is no search: YouTube offers none without the Data API v3, which
// this course can't use (docs/adr/0003-youtube-metadata-via-oembed.md).
// Songs come from pasted links, added straight to a room's queue (the queue
// route above looks each one up itself).

// Renders README.md at /readme/, satisfying spec/invariants.test.ts (every
// heading must appear, in order, in the served page).
app.get("/readme/", (_req, res) => {
  const markdown = readFileSync(path.join(repoRoot, "README.md"), "utf8");
  res.type("html").send(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About</title>
  </head>
  <body>
    <main>${marked.parse(markdown)}</main>
  </body>
</html>
`);
});

// An /api path no route above matched (a typo, or a removed endpoint such as
// the old search) answers as an API would, not with the SPA's HTML shell.
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "no such API endpoint" });
});

app.use(express.static(clientDist));

// Anything else falls back to the built SPA shell.
app.use((_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const PORT = Number(process.env.PORT) || 8080;
httpServer.listen(PORT, () => {
  console.log(`Watch YouTube Together server listening on :${PORT}`);
});
