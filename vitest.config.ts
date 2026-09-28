import { defineConfig } from "vitest/config";

// spec/ tests run against the running app (spec/global-setup.ts finds it).
// server/src tests are plain unit tests with no such dependency; globalSetup
// still applies to the whole run, but they don't touch the running app it
// waits for.
export default defineConfig({
  test: {
    include: ["spec/**/*.test.ts", "server/src/**/*.test.ts"],
    globalSetup: ["./spec/global-setup.ts"],
  },
});
