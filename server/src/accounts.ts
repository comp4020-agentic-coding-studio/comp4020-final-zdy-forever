import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Account } from "../../shared/src/types.ts";

function rowToAccount(row: unknown): Account {
  const r = row as { accountId: string; displayName: string; createdAt: string };
  return { accountId: r.accountId, displayName: r.displayName, createdAt: r.createdAt };
}

export function getAccountByClientId(db: DatabaseSync, clientId: string): Account | undefined {
  const row = db
    .prepare("SELECT accountId, displayName, createdAt FROM accounts WHERE clientId = ?")
    .get(clientId);
  return row ? rowToAccount(row) : undefined;
}

export function getAccountById(db: DatabaseSync, accountId: string): Account | undefined {
  const row = db
    .prepare("SELECT accountId, displayName, createdAt FROM accounts WHERE accountId = ?")
    .get(accountId);
  return row ? rowToAccount(row) : undefined;
}

// Registering is idempotent per clientId: a device that already has an
// account gets that same account back (its original displayName included),
// rather than minting a second accountId for the same browser. displayName
// is never treated as identity, so different accounts may share one freely.
export function registerAccount(db: DatabaseSync, clientId: string, displayName: string): Account {
  const existing = getAccountByClientId(db, clientId);
  if (existing) return existing;

  const account: Account = {
    accountId: randomUUID(),
    displayName,
    createdAt: new Date().toISOString(),
  };

  db.prepare(
    "INSERT INTO accounts (accountId, clientId, displayName, createdAt) VALUES (?, ?, ?, ?)",
  ).run(account.accountId, clientId, account.displayName, account.createdAt);

  return account;
}

// Changes the name an account is shown by. accountId stays its identity, so
// everything that looks the name up live (presence on the next connection,
// the DJ label, queue attributions) follows; a reaction keeps the name it was
// sent under, since it's a record of that moment (see db.ts's reactions).
export function renameAccount(db: DatabaseSync, accountId: string, displayName: string): Account | undefined {
  db.prepare("UPDATE accounts SET displayName = ? WHERE accountId = ?").run(displayName, accountId);
  return getAccountById(db, accountId);
}
