import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies API/readme requests to the Express backend, which
// is assumed to be running on the same PORT it uses in production (default
// 8080; see server/src/index.ts and fly.toml).
const backendPort = process.env.PORT ?? "8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://localhost:${backendPort}`,
      "/readme": `http://localhost:${backendPort}`,
      // The client's socket connects to its own origin (io() in
      // usePlaybackSync.ts), so in dev that's Vite — forward it, WebSocket
      // upgrade included, or joining a room never gets past "connecting…".
      "/socket.io": { target: `http://localhost:${backendPort}`, ws: true },
    },
  },
});
