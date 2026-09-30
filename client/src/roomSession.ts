const STORAGE_KEY = "echoRoom.roomId";

// Which room this tab is in, so a refresh comes straight back to it rather
// than dropping to the lobby. Per tab (sessionStorage): another tab can be in
// another room. Only ever a convenience — the server re-checks everything on
// the socket join, and storage can be unavailable (a private window, blocked
// site data), in which case a refresh simply lands in the lobby.
export function loadRoomId(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveRoomId(roomId: string | null): void {
  try {
    if (roomId) sessionStorage.setItem(STORAGE_KEY, roomId);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do: without storage, a refresh lands in the lobby.
  }
}
