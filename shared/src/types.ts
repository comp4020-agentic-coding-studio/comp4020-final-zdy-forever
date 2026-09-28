// Domain types shared between client/ and server/. Type-only exports are
// elided at compile time (see verbatimModuleSyntax in each package's
// tsconfig), so importing this file from either side has no runtime cost
// and no build-ordering requirement.

export interface HealthResponse {
  status: "ok";
  uptime: number;
}

// accountId is the permanent server identity; displayName is user-facing and
// may duplicate across accounts. clientId (browser/device identity) is not
// part of the account's public shape — it's only used server-side to look an
// account back up.
export interface Account {
  accountId: string;
  displayName: string;
  createdAt: string;
}

export interface RegisterRequest {
  clientId: string;
  displayName: string;
}
