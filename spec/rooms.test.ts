import { randomUUID } from "node:crypto";
import { describe, expect, inject, it } from "vitest";

// Room and queue REST endpoints, checked against the RUNNING app like the
// rest of spec/. Every account here gets a fresh random clientId, so the
// checks hold however many times they run against the same database.
const baseUrl = inject("baseUrl");

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, query: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

async function register(displayName: string): Promise<{ accountId: string; clientId: string }> {
  const clientId = randomUUID();
  const { body } = await post("/api/register", { clientId, displayName });
  return { accountId: body.accountId as string, clientId };
}

async function createRoom(
  who: { accountId: string; clientId: string },
  visibility: "PUBLIC" | "PRIVATE",
): Promise<{ roomId: string; code: string | null; roomNumber: string | null }> {
  const { status, body } = await post("/api/rooms", { ...who, name: `spec ${visibility}`, visibility, autoCloseEnabled: true });
  expect(status).toBe(201);
  return { roomId: body.roomId as string, code: body.code as string | null, roomNumber: body.roomNumber as string | null };
}

// Regression: these endpoints used to trust a bare accountId, which is public
// (every room broadcasts it via presence, queue addedBy and chat) — so
// anyone could create rooms, join rooms or add tracks as someone else.
describe("acting as an account over REST", () => {
  it("requires the clientId that registered the account", async () => {
    const alice = await register("Alice");
    const mallory = await register("Mallory");
    const room = await createRoom(alice, "PUBLIC");

    const cases: [string, Record<string, unknown>][] = [
      ["/api/rooms", { name: "x", visibility: "PUBLIC" }],
      [`/api/rooms/${room.roomId}/join`, {}],
      ["/api/rooms/join-by-code", { code: "123456" }],
      [`/api/rooms/${room.roomId}/queue`, { input: "dQw4w9WgXcQ" }],
    ];
    for (const [path, body] of cases) {
      // Alice's public accountId with Mallory's own clientId, and with none.
      expect((await post(path, { ...body, accountId: alice.accountId, clientId: mallory.clientId })).status).toBe(401);
      expect((await post(path, { ...body, accountId: alice.accountId })).status).toBe(401);
    }
  });

  it("only lets someone in the room add to its queue", async () => {
    const alice = await register("Alice");
    const room = await createRoom(alice, "PUBLIC");

    // Checked before the YouTube lookup, so this holds with or without an API key.
    const { status } = await post(`/api/rooms/${room.roomId}/queue`, { ...alice, input: "dQw4w9WgXcQ" });
    expect(status).toBe(404);
  });

  it("requires the clientId that registered the account to read a room's logs too", async () => {
    const alice = await register("Alice");
    const mallory = await register("Mallory");
    const room = await createRoom(alice, "PUBLIC");

    const path = `/api/rooms/${room.roomId}/logs`;
    expect((await get(path, { accountId: alice.accountId, clientId: mallory.clientId })).status).toBe(401);
    expect((await get(path, { accountId: alice.accountId, clientId: "" })).status).toBe(401);
  });

  it("only lets someone in the room read its logs — creating it over REST alone isn't enough", async () => {
    const alice = await register("Alice");
    const room = await createRoom(alice, "PUBLIC");

    const { status } = await get(`/api/rooms/${room.roomId}/logs`, alice);
    expect(status).toBe(404);
  });

  it("answers the same not-found status for a room that never existed, so a logs probe can't reveal a private room", async () => {
    const alice = await register("Alice");

    const { status } = await get(`/api/rooms/${randomUUID()}/logs`, alice);
    expect(status).toBe(404);
  });
});

// A page refresh used to lose the account (and so the room): the browser had
// to register again, by name, before it could do anything.
describe("resuming a session", () => {
  it("hands a returning browser its own account back from its clientId alone", async () => {
    const alice = await register("Alice");

    const resumed = await post("/api/session", { clientId: alice.clientId });
    expect(resumed.status).toBe(200);
    expect(resumed.body.account).toMatchObject({ accountId: alice.accountId, displayName: "Alice" });
  });

  it("knows nothing about a browser it has never seen", async () => {
    expect(await post("/api/session", { clientId: randomUUID() })).toEqual({ status: 200, body: { account: null } });
    expect((await post("/api/session", {})).status).toBe(400);
  });
});

// The course can't use the YouTube Data API v3 (docs/adr/0003), so there is
// no search — and an API path that doesn't exist says so as JSON rather than
// falling through to the SPA's HTML.
it("has no search endpoint, and answers an unknown API path with a JSON 404", async () => {
  const res = await fetch(new URL("/api/youtube/search?q=anything", baseUrl));
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "no such API endpoint" });
});

describe("changing your name", () => {
  it("renames the calling account, keeping its accountId, and a refresh picks the new name back up", async () => {
    const alice = await register("Alice");

    const renamed = await post("/api/account/name", { ...alice, displayName: "  Alicia  " });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ accountId: alice.accountId, displayName: "Alicia" });

    expect((await post("/api/session", { clientId: alice.clientId })).body.account).toMatchObject({
      accountId: alice.accountId,
      displayName: "Alicia",
    });
  });

  it("requires the account's own clientId, and a name within the limit", async () => {
    const alice = await register("Alice");
    const mallory = await register("Mallory");

    expect((await post("/api/account/name", { accountId: alice.accountId, clientId: mallory.clientId, displayName: "Pwned" })).status).toBe(401);
    expect((await post("/api/account/name", { ...alice, displayName: "x".repeat(33) })).status).toBe(400);
    expect((await post("/api/account/name", { ...alice, displayName: "   " })).status).toBe(400);
    expect((await post("/api/session", { clientId: alice.clientId })).body.account).toMatchObject({ displayName: "Alice" });
  });
});

describe("rooms", () => {
  it("lists a new public room in the lobby with its live occupancy, and never a private one", async () => {
    const alice = await register("Alice");
    const publicRoom = await createRoom(alice, "PUBLIC");
    const privateRoom = await createRoom(alice, "PRIVATE");

    const lobby = (await (await fetch(new URL("/api/lobby", baseUrl))).json()) as { roomId: string; occupancy: number }[];

    expect(lobby.find((r) => r.roomId === publicRoom.roomId)).toMatchObject({ occupancy: 0, capacity: 12, joinable: true });
    expect(lobby.some((r) => r.roomId === privateRoom.roomId)).toBe(false);
  });

  it("admits someone to a private room with its 6-digit code, and not with a wrong one", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const room = await createRoom(alice, "PRIVATE");
    expect(room.code).toMatch(/^\d{6}$/);

    const joined = await post("/api/rooms/join-by-code", { ...bob, code: room.code });
    expect(joined.status).toBe(200);
    expect((joined.body.room as { roomId: string }).roomId).toBe(room.roomId);

    const wrong = room.code === "000000" ? "000001" : "000000";
    const miss = await post("/api/rooms/join-by-code", { ...bob, code: wrong });
    // Another room could hold the other code; this one's id must never come back for it.
    if (miss.status === 200) expect((miss.body.room as { roomId: string }).roomId).not.toBe(room.roomId);
    else expect(miss.status).toBe(404);
  });

  it("never joins a private room by its id alone", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const room = await createRoom(alice, "PRIVATE");

    expect((await post(`/api/rooms/${room.roomId}/join`, bob)).status).toBe(404);
  });

  it("admits someone to a public room with its 7-digit room number, and 404s on an unknown one", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const room = await createRoom(alice, "PUBLIC");
    expect(room.roomNumber).toMatch(/^\d{7}$/);

    const joined = await post("/api/rooms/join-by-code", { ...bob, code: room.roomNumber });
    expect(joined.status).toBe(200);
    expect((joined.body.room as { roomId: string }).roomId).toBe(room.roomId);

    const unknown = await post("/api/rooms/join-by-code", { ...bob, code: "0000000" });
    if (unknown.status === 200) expect((unknown.body.room as { roomId: string }).roomId).not.toBe(room.roomId);
    else expect(unknown.status).toBe(404);
  });

  it("rejects a code that is neither a 6-digit private code nor a 7-digit public number", async () => {
    const bob = await register("Bob");
    expect((await post("/api/rooms/join-by-code", { ...bob, code: "12345" })).status).toBe(400);
  });

  // A 6-digit private code is only reachable by guessing it, so nothing else
  // bounds how often one account may try — without this, any registered
  // account could enumerate the whole 1,000,000-code space.
  it("throttles repeated code guesses from one account, shared across join-by-code and the logs lookup", async () => {
    const mallory = await register("Mallory");
    let rejected = false;
    for (let i = 0; i < 15 && !rejected; i++) {
      const attempt = await post("/api/rooms/join-by-code", { ...mallory, code: "000000" });
      if (attempt.status === 429) rejected = true;
    }
    expect(rejected).toBe(true);
    // The budget is shared: having just exhausted it via join-by-code, the
    // logs lookup (a different endpoint guessing the same secret space) is
    // throttled too, not given a fresh allowance of its own.
    expect((await get("/api/rooms/logs", { ...mallory, code: "000000" })).status).toBe(429);
  });

  it("rejects over-long display and room names", async () => {
    expect((await post("/api/register", { clientId: randomUUID(), displayName: "x".repeat(33) })).status).toBe(400);

    const alice = await register("Alice");
    const tooLong = await post("/api/rooms", { ...alice, name: "x".repeat(21), visibility: "PUBLIC" });
    expect(tooLong.status).toBe(400);
  });
});

// The landing page's "View activity log" button — reachable before ever
// joining a room, so it looks a room up by its code/number rather than
// requiring membership like GET /api/rooms/:roomId/logs does.
describe("the landing-page activity log lookup", () => {
  it("resolves a private room by its 6-digit code and reflects a real action", async () => {
    const alice = await register("Alice");
    const room = await createRoom(alice, "PRIVATE");

    const { status, body } = await get("/api/rooms/logs", { ...alice, code: room.code! });
    expect(status).toBe(200);
    const events = body as { action: string; roomId: string }[];
    expect(events.some((e) => e.action === "ROOM_CREATE" && e.roomId === room.roomId)).toBe(true);
  });

  it("resolves a public room by its 7-digit room number", async () => {
    const alice = await register("Alice");
    const room = await createRoom(alice, "PUBLIC");

    const { status, body } = await get("/api/rooms/logs", { ...alice, code: room.roomNumber! });
    expect(status).toBe(200);
    const events = body as { roomId: string }[];
    expect(events.every((e) => e.roomId === room.roomId)).toBe(true);
  });

  it("404s on a code/number that matches no active room", async () => {
    const alice = await register("Alice");
    const room = await createRoom(alice, "PRIVATE");
    // A code one digit different from a real, just-created private code
    // could in principle collide with some other test's room, but never
    // with this one's — wrong either way.
    const wrong = room.code === "000000" ? "000001" : "000000";
    const miss = await get("/api/rooms/logs", { ...alice, code: wrong });
    if (miss.status === 200) expect((miss.body as { roomId: string }[]).every((e) => e.roomId !== room.roomId)).toBe(true);
    else expect(miss.status).toBe(404);
  });

  it("400s on neither a 6-digit nor a 7-digit code", async () => {
    const alice = await register("Alice");
    expect((await get("/api/rooms/logs", { ...alice, code: "12345" })).status).toBe(400);
  });

  it("requires the clientId that registered the account", async () => {
    const alice = await register("Alice");
    const mallory = await register("Mallory");
    const room = await createRoom(alice, "PUBLIC");

    expect((await get("/api/rooms/logs", { accountId: alice.accountId, clientId: mallory.clientId, code: room.roomNumber! })).status).toBe(401);
  });

  it("never requires being present in the room — that's the whole point of a pre-join lookup", async () => {
    const alice = await register("Alice");
    const bob = await register("Bob");
    const room = await createRoom(alice, "PUBLIC");

    // Bob has never joined this room at all.
    const { status } = await get("/api/rooms/logs", { ...bob, code: room.roomNumber! });
    expect(status).toBe(200);
  });
});
