import type { Response } from "express";
import { YoutubeLookupError } from "./youtube.ts";

// Maps an error caught around a YouTube-touching request to the right HTTP
// response. A YouTube lookup failure gets its own status/message; anything
// else — a DB write failure, or any other unanticipated error — gets a
// generic 500 instead of being rethrown. Every caller of this function is an
// *async* Express route handler: Express only catches a *synchronous*
// handler's throw automatically, so rethrowing here would become an
// unhandled promise rejection that crashes the whole process (every room's
// live connections, not just this one request) under Node's default
// --unhandled-rejections=throw behavior.
export function handleYoutubeError(res: Response, err: unknown): void {
  if (err instanceof YoutubeLookupError) {
    res.status(502).json({ error: err.message });
    return;
  }
  console.error("unexpected error handling a request:", err);
  res.status(500).json({ error: "internal server error" });
}
