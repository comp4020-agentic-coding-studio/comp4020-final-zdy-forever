import express from "express";
import { marked } from "marked";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Account, HealthResponse, RegisterRequest } from "../../shared/src/types.ts";
import { registerAccount } from "./accounts.ts";
import { openDatabase } from "./db.ts";

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
