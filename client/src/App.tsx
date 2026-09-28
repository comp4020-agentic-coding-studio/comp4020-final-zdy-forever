import { useEffect, useState } from "react";
import type { Account, HealthResponse } from "../../shared/src/types.ts";
import { getClientId } from "./clientId.ts";

type HealthState = HealthResponse | "error" | null;

function App() {
  const [health, setHealth] = useState<HealthState>(null);
  const [displayName, setDisplayName] = useState("");
  const [account, setAccount] = useState<Account | "error" | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth("error"));
  }, []);

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: getClientId(), displayName }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAccount((await res.json()) as Account);
    } catch {
      setAccount("error");
    }
  };

  return (
    <main>
      <h1>Echo Room</h1>
      <p>
        {health === null && "checking server…"}
        {health === "error" && "server unreachable"}
        {health !== null && health !== "error" && `server: ${health.status} (up ${Math.round(health.uptime)}s)`}
      </p>

      {account && account !== "error" ? (
        <p>
          signed in as {account.displayName} (accountId: {account.accountId})
        </p>
      ) : (
        <form onSubmit={register}>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="display name"
            required
          />
          <button type="submit">Join</button>
          {account === "error" && <p>registration failed</p>}
        </form>
      )}
    </main>
  );
}

export default App;
