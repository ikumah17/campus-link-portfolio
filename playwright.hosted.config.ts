import { defineConfig } from "@playwright/test";

// Playwright's automatic failure aria snapshot can include the enrollment key.
// This process-local setting disables that diagnostic in hosted worker processes.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

// .hosted.ts deliberately does not match the default suite's **/*.spec.ts.
// Discover deliberately excludes active connections. Check hide/restore and
// suspension/restore while A and B are still discoverable, then connect them.
// MOD-001: CAMPUS_E2E_HIDE_CONTENT=1 adds the reported-message hide and undo group right after chat, while A and B
// still share the run room. It needs order 33 on hosted, so the default command does not select it.
const hideContent = process.env.CAMPUS_E2E_HIDE_CONTENT === "1";
const groups: (readonly [string, number])[] = [
  ["onboarding", 1], ["verification", 2], ["discover", 3],
  ["privacy", 5], ["moderation", 6], ["chat", 4], ...(hideContent ? [["hide-content", 20] as const] : []), ["roles", 8], ["block", 7],
];
// HOSTED-RET-001: CAMPUS_E2E_RETENTION=prepare|verify runs only the retention flow, as its own invocation.
const retention = process.env.CAMPUS_E2E_RETENTION || undefined;
if (retention !== undefined && retention !== "prepare" && retention !== "verify") throw new Error("CAMPUS_E2E_RETENTION must be prepare or verify");
// ACCOUNT-001: CAMPUS_E2E_ACCOUNT=1 runs only the account pause/resume/deletion flow, as its own invocation.
const account = process.env.CAMPUS_E2E_ACCOUNT === "1";
if (account && retention) throw new Error("CAMPUS_E2E_ACCOUNT and CAMPUS_E2E_RETENTION are separate invocations");
// HOSTED-E2E-005: CAMPUS_E2E_VISIBILITY=1 runs only the visibility-rules flow, as its own invocation.
const visibility = process.env.CAMPUS_E2E_VISIBILITY === "1";
if (visibility && (account || retention)) throw new Error("CAMPUS_E2E_VISIBILITY is a separate invocation");
// A11Y-002: CAMPUS_E2E_A11Y=1 runs only the hosted-only screens' axe check, as its own invocation.
const a11y = process.env.CAMPUS_E2E_A11Y === "1";
if (a11y && (visibility || account || retention)) throw new Error("CAMPUS_E2E_A11Y is a separate invocation");
// HOSTED-E2E-006: CAMPUS_E2E_ADMIN_AFFILIATIONS=1 runs only the admin dashboard and affiliation master flow, as its own invocation.
const affiliations = process.env.CAMPUS_E2E_ADMIN_AFFILIATIONS === "1";
if (affiliations && (a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_ADMIN_AFFILIATIONS is a separate invocation");
// TEST-013: CAMPUS_E2E_POSTGREST=1 runs only the PostgREST rejection-shape checks (plain HTTP, no app server), as its own invocation.
const postgrest = process.env.CAMPUS_E2E_POSTGREST === "1";
if (postgrest && (affiliations || a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_POSTGREST is a separate invocation");
// TEST-014: CAMPUS_E2E_STORAGE=1 runs only the Storage denial checks on both buckets (plain HTTP, no app server), as its own invocation.
const storage = process.env.CAMPUS_E2E_STORAGE === "1";
if (storage && (postgrest || affiliations || a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_STORAGE is a separate invocation");
// TEST-016: CAMPUS_E2E_STAFF_TOTP=1 runs only the staff-role factor-binding flow (order 29), as its own invocation.
const staffTotp = process.env.CAMPUS_E2E_STAFF_TOTP === "1";
if (staffTotp && (storage || postgrest || affiliations || a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_STAFF_TOTP is a separate invocation");
if (hideContent && (staffTotp || storage || postgrest || affiliations || a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_HIDE_CONTENT extends only the default groups");
// MOBILE-API-001: CAMPUS_E2E_MOBILE=1 runs only the app's Bearer-only /api/mobile/* routes (plain HTTP to the app server), as its own invocation.
const mobile = process.env.CAMPUS_E2E_MOBILE === "1";
if (mobile && (hideContent || staffTotp || storage || postgrest || affiliations || a11y || visibility || account || retention)) throw new Error("CAMPUS_E2E_MOBILE is a separate invocation");
export default defineConfig({
  testDir: "tests/e2e-hosted",
  testMatch: "**/*.hosted.ts",
  globalSetup: "./tests/e2e-hosted/setup.ts",
  globalTeardown: "./tests/e2e-hosted/teardown.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: "list",
  outputDir: ".e2e-hosted/results",
  use: {
    baseURL: "http://127.0.0.1:3207", channel: "chrome",
    actionTimeout: 20_000, navigationTimeout: 30_000,
    trace: "off", video: "off", screenshot: "off",
  },
  projects: mobile ? [{ name: "mobile-api", testMatch: "21-mobile-api.hosted.ts" }] : staffTotp ? [{ name: "staff-totp", testMatch: "19-staff-totp.hosted.ts" }] : storage ? [{ name: "storage-denials", testMatch: "18-storage-denials.hosted.ts" }] : postgrest ? [{ name: "postgrest-shapes", testMatch: "17-postgrest-shapes.hosted.ts" }] : affiliations ? [{ name: "admin-affiliations", testMatch: "16-admin-affiliations.hosted.ts" }] : a11y ? [{ name: "a11y", testMatch: "15-a11y.hosted.ts" }] : visibility ? [{ name: "visibility", testMatch: "14-visibility.hosted.ts" }] : account ? [{ name: "account", testMatch: "13-account.hosted.ts" }] : retention ? [{ name: `retention-${retention}`, testMatch: "12-retention.hosted.ts" }] : [
    ...groups.map(([name, file], i) => ({ name, testMatch: `${file}-${name}.hosted.ts`, dependencies: i ? [groups[i - 1][0]] : [] })),
    // HOSTED-E2E-LIKES: fresh run users C and D, so the likes group does not depend on the A/B chain's later groups.
    { name: "likes", testMatch: "22-likes.hosted.ts", dependencies: ["verification"] },
    // Fresh revocation pairs do not depend on the old block pair. A failure of
    // either revocation group must not hide the result of the other one.
    ...(process.env.CAMPUS_E2E_NT21 === "1" ? [
      { name: "realtime-revocation", testMatch: "10-realtime-revocation.hosted.ts", dependencies: ["roles"] },
    ] : []),
    ...(process.env.CAMPUS_E2E_NT19 === "1" ? [
      // HOSTED-E2E-004 adds the verification revoke races as a second NT-19 file.
      { name: "concurrency", testMatch: ["11-concurrency.hosted.ts", "11b-revoke-races.hosted.ts"], dependencies: ["roles"] },
    ] : []),
    { name: "anonymous", testMatch: "9-anonymous.hosted.ts" },
  ],
  webServer: postgrest || storage ? undefined : {
    command: "node tests/e2e-hosted/server.mjs",
    url: "http://127.0.0.1:3207/welcome",
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "ignore", stderr: "ignore",
    env: { CAMPUS_LINK_BACKEND: "supabase" },
  },
});
