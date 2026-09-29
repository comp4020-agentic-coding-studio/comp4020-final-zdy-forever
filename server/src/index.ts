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
  ReorderTokenBalance,
  Room,
  RoomPlaybackSnapshot,
  YoutubeVideoMetadata,
} from "../../shared/src/types.ts";
import { parseYouTubeVideoId } from "../../shared/src/youtube.ts";
import { getAccountById, registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import { ensureCurrentTrack, getCurrentPlayback, getNextTrack, recoverPlaybackOnStartup } from "./playback.ts";
import { addTrack, InvalidTrackError, listQueue } from "./queue.ts";
import { broadcastReactionHistory } from "./reactions.ts";
import { attachRealtime } from "./realtime.ts";
import { getReorderTokenBalance } from "./reorderTokenStore.ts";
import {
  createRoom,
  getActiveRoomByCode,
  getRoomById,
  joinRoom,
  listPublicLobby,
  RoomClosedError,
  RoomFullError,
} from "./rooms.ts";
import {
  getDemoSongs,
  getVideoMetadata,
  searchVideos,
  YoutubeApiError,
  YoutubeApiKeyMissingError,
} from "./youtube.ts";

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

const app = express();
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer);
attachRealtime(io, db);

app.get("/api/health", (_req, res) => {
  const body: HealthResponse = { status: "ok", uptime: process.uptime() };
  res.json(body);
});

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

  const account: Account = registerAccount(db, clientId, displayName);
  res.json(account);
});

// Creates a room, owned by an already-registered account. No listing or join
// endpoint exists yet, so a PRIVATE room's code is only ever handed back here,
// to its own creator.
app.post("/api/rooms", (req, res) => {
  const body = req.body as Partial<CreateRoomRequest>;
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const visibility = body.visibility;
  const autoCloseEnabled = typeof body.autoCloseEnabled === "boolean" ? body.autoCloseEnabled : false;

  if (!accountId || !name || (visibility !== "PUBLIC" && visibility !== "PRIVATE")) {
    res.status(400).json({ error: "accountId, name, and visibility (PUBLIC or PRIVATE) are required" });
    return;
  }

  if (!getAccountById(db, accountId)) {
    res.status(400).json({ error: "unknown accountId" });
    return;
  }

  const room: Room = createRoom(db, { accountId, name, visibility, autoCloseEnabled });
  res.status(201).json(room);
});

// The public lobby only ever lists PUBLIC, open rooms — a PRIVATE room (and
// its code) never appears here.
app.get("/api/lobby", (_req, res) => {
  const rooms: LobbyRoom[] = listPublicLobby(db);
  res.json(rooms);
});

function handleJoinError(res: express.Response, err: unknown): void {
  if (err instanceof RoomClosedError || err instanceof RoomFullError) {
    res.status(409).json({ error: err.message });
    return;
  }
  throw err;
}

// Joins a PUBLIC room directly by id. A PRIVATE room is reported as
// not-found here (not 403/409) so probing roomIds can't be used to learn
// that a private room exists.
app.post("/api/rooms/:roomId/join", (req, res) => {
  const { roomId } = req.params;
  const body = req.body as { accountId?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";

  if (!accountId) {
    res.status(400).json({ error: "accountId is required" });
    return;
  }

  const room = getRoomById(db, roomId);
  if (!room || room.visibility !== "PUBLIC") {
    res.status(404).json({ error: "room not found" });
    return;
  }
  if (!getAccountById(db, accountId)) {
    res.status(400).json({ error: "unknown accountId" });
    return;
  }

  try {
    const result: JoinRoomResult = joinRoom(db, roomId, accountId);
    res.json(result);
  } catch (err) {
    handleJoinError(res, err);
  }
});

// Joins a PRIVATE (or PUBLIC) room by its 6-digit code — the only way to
// reach a PRIVATE room, since it never appears in the lobby.
app.post("/api/rooms/join-by-code", (req, res) => {
  const body = req.body as { accountId?: unknown; code?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";

  if (!accountId || !/^\d{6}$/.test(code)) {
    res.status(400).json({ error: "accountId and a 6-digit code are required" });
    return;
  }
  if (!getAccountById(db, accountId)) {
    res.status(400).json({ error: "unknown accountId" });
    return;
  }

  const room = getActiveRoomByCode(db, code);
  if (!room) {
    res.status(404).json({ error: "invalid code" });
    return;
  }

  try {
    const result: JoinRoomResult = joinRoom(db, room.roomId, accountId);
    res.json(result);
  } catch (err) {
    handleJoinError(res, err);
  }
});

function handleYoutubeError(res: express.Response, err: unknown): void {
  if (err instanceof YoutubeApiKeyMissingError) {
    res.status(503).json({ error: "YouTube API is not configured" });
    return;
  }
  if (err instanceof YoutubeApiError) {
    res.status(502).json({ error: err.message });
    return;
  }
  throw err;
}

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

// Adds a track — from a pasted URL, a search result, or a demo song, all
// treated identically as untrusted input. Never requires a vote.
app.post("/api/rooms/:roomId/queue", async (req, res) => {
  const { roomId } = req.params;
  const body = req.body as { accountId?: unknown; input?: unknown };
  const accountId = typeof body.accountId === "string" ? body.accountId.trim() : "";
  const input = typeof body.input === "string" ? body.input.trim() : "";

  if (!accountId || !input) {
    res.status(400).json({ error: "accountId and input are required" });
    return;
  }
  if (!getRoomById(db, roomId)) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  if (!getAccountById(db, accountId)) {
    res.status(400).json({ error: "unknown accountId" });
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
      broadcastReactionHistory(io, db, roomId, started.videoId);
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

// The current track, current DJ, and next track — a plain display snapshot.
// No voting or synchronized position/timing is implemented yet.
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

// One account's server-authoritative reorder-token balance in this room (see
// CLAUDE.md's Reorder section and shared/src/reorderTokens.ts) — a plain
// query, never something a client tracks or reports itself. Reordering
// itself isn't wired up yet; this only exposes the balance so a future
// REORDER_QUEUE UI can show it.
app.get("/api/rooms/:roomId/reorder-tokens/:accountId", (req, res) => {
  const { roomId, accountId } = req.params;
  if (!getRoomById(db, roomId)) {
    res.status(404).json({ error: "room not found" });
    return;
  }
  if (!getAccountById(db, accountId)) {
    res.status(400).json({ error: "unknown accountId" });
    return;
  }
  const balance: ReorderTokenBalance = getReorderTokenBalance(db, roomId, accountId);
  res.json(balance);
});

// Search is submit-driven only — the client calls this once per explicit
// search, never per keystroke (see App.tsx's search form).
app.get("/api/youtube/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  try {
    res.json(await searchVideos(q));
  } catch (err) {
    handleYoutubeError(res, err);
  }
});

app.get("/api/youtube/demo-songs", async (_req, res) => {
  try {
    res.json(await getDemoSongs());
  } catch (err) {
    handleYoutubeError(res, err);
  }
});

// Accepts a pasted YouTube URL or a bare videoId, parses it, and looks up
// its metadata (including whether it's actually embeddable) in one step.
app.post("/api/youtube/resolve", async (req, res) => {
  const body = req.body as { input?: unknown };
  const input = typeof body.input === "string" ? body.input : "";
  const videoId = input ? parseYouTubeVideoId(input) : null;

  if (!videoId) {
    res.status(400).json({ error: "not a recognizable YouTube video URL or videoId" });
    return;
  }

  try {
    const metadata: YoutubeVideoMetadata | null = await getVideoMetadata(videoId);
    if (!metadata) {
      res.status(404).json({ error: "video not found" });
      return;
    }
    res.json(metadata);
  } catch (err) {
    handleYoutubeError(res, err);
  }
});

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

app.use(express.static(clientDist));

// Anything else falls back to the built SPA shell.
app.use((_req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

const PORT = Number(process.env.PORT) || 8080;
httpServer.listen(PORT, () => {
  console.log(`Echo Room server listening on :${PORT}`);
});
