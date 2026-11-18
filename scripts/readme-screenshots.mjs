// README-001 screenshots of the demo build (fictional data only) for README.md.
// Builds the app with CAMPUS_LINK_BACKEND=demo, starts it on a local port, opens each screen in the
// locally installed Chrome through the existing Playwright, and writes PNG files to docs/assets/readme/.
// Never contacts Supabase: demo mode reads only src/data/demo-*.ts.
//
//   node scripts/readme-screenshots.mjs              # build, then capture
//   node scripts/readme-screenshots.mjs --no-build   # reuse the existing .next build
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { chromium } from "@playwright/test";

const PORT = 3110;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = "docs/assets/readme";
const NEXT = "node_modules/next/dist/bin/next";
const env = { ...process.env, CAMPUS_LINK_BACKEND: "demo", NEXT_TELEMETRY_DISABLED: "1" };

const shots = [
  { file: "discover-1280.png", path: "/", width: 1280, height: 800 },
  { file: "profile-detail-1280.png", path: "/profiles/demo-1", width: 1280, height: 800 },
  { file: "chat-1280.png", path: "/talk/demo-4", width: 1280, height: 800 },
  { file: "privacy-settings-1280.png", path: "/settings/privacy", width: 1280, height: 800 },
  { file: "admin-dashboard-1280.png", path: "/admin", width: 1280, height: 800 },
  { file: "likes-1280.png", path: "/likes", width: 1280, height: 800 },
  { file: "profile-edit-1280.png", path: "/mypage/profile", width: 1280, height: 800 },
  { file: "discover-390.png", path: "/", width: 390, height: 844 },
];

async function waitForServer(server) {
  for (let i = 0; i < 120; i += 1) {
    if (server.exitCode !== null) throw new Error("next start exited early");
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("next start did not answer within 120 s");
}

if (!process.argv.includes("--no-build")) {
  const build = spawnSync(process.execPath, [NEXT, "build"], { stdio: "inherit", env });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, [NEXT, "start", "-p", String(PORT), "-H", "127.0.0.1"], { stdio: "ignore", env });
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({ channel: "chrome" });
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 });
    const response = await page.goto(BASE + shot.path, { waitUntil: "networkidle" });
    if (!response?.ok()) throw new Error(`${shot.path} answered ${response?.status()}`);
    await page.evaluate(() => document.fonts.ready);
    const file = `${OUT}/${shot.file}`;
    await page.screenshot({ path: file });
    console.log(`${file} ${shot.width}x${shot.height} ${Math.round(statSync(file).size / 1024)} KB`);
    await page.close();
  }
} finally {
  await browser?.close();
  server.kill();
}
