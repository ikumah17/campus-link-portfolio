import { defineConfig } from "@playwright/test";

// Uses the locally installed Chrome so no browser download is needed.
export default defineConfig({
  testDir: "tests",
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  // Six concurrent Chrome workers starve initial client navigations on this host.
  // Keep real assertion budgets and retries unchanged; bound browser contention.
  workers: 2,
  use: { baseURL: "http://127.0.0.1:3100", channel: "chrome" },
  webServer: {
    command: "npm run build && npx next start -p 3100 -H 127.0.0.1",
    url: "http://127.0.0.1:3100",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
