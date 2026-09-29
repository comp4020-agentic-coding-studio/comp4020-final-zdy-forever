import express from "express";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Account,
  CreateRoomRequest,
  HealthResponse,
  JoinRoomResult,
  LobbyRoom,
  RegisterRequest,
  Room,
} from "../../shared/src/types.ts";
import { getAccountById, registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";
import {
  createRoom,
  getActiveRoomByCode,
  getRoomById,
  joinRoom,
  listPublicLobby,
  RoomClosedError,
  RoomFullError,
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

const app = express();
app.use(express.json());

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
app.listen(PORT, () => {
  console.log(`Echo Room server listening on :${PORT}`);
});
