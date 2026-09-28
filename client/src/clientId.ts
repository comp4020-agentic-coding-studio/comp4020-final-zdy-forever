const STORAGE_KEY = "echoRoom.clientId";

// clientId identifies this browser/device, not an account — it just lets a
// returning device get its existing account back on re-registration.
export function getClientId(): string {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const clientId = crypto.randomUUID();
  localStorage.setItem(STORAGE_KEY, clientId);
  return clientId;
}
