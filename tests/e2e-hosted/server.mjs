import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import path from "node:path";

// Run sequentially with the demo suite. Next loads .env.local itself;
// credentials never become command-line arguments.
// TEST-017: CAMPUS_E2E_SERVER_LOG=<file> (opt-in, diagnosis only) appends the build and server output, each line with
// a timestamp, to that file, which must be outside the repository or under the ignored .e2e-hosted/. It also preloads
// server-log.cjs into `next start`, which logs outgoing fetch timings (method, host, path) and event-loop stalls.
// Unset, the output stays ignored.
const logPath = process.env.CAMPUS_E2E_SERVER_LOG ? path.resolve(process.env.CAMPUS_E2E_SERVER_LOG) : undefined;
if (logPath) {
  const inside = path.relative(process.cwd(), logPath);
  const ignored = path.relative(path.resolve(".e2e-hosted"), logPath);
  if (!(inside.startsWith("..") || path.isAbsolute(inside)) && (ignored.startsWith("..") || path.isAbsolute(ignored))) {
    console.error("CAMPUS_E2E_SERVER_LOG must be outside the repository or under .e2e-hosted/");
    process.exit(1);
  }
}
const log = logPath ? createWriteStream(logPath, { flags: "a" }) : undefined;
const write = (stream, line) => log.write(`${new Date().toISOString()} ${stream} ${line}\n`);
function attach(child, name) {
  for (const stream of ["stdout", "stderr"]) {
    let rest = "";
    child[stream].setEncoding("utf8").on("data", chunk => {
      const lines = (rest + chunk).split(/\r?\n/);
      rest = lines.pop();
      for (const line of lines) write(`${name}:${stream}`, line);
    }).on("end", () => { if (rest) write(`${name}:${stream}`, rest); });
  }
  child.on("exit", (code, signal) => write(`${name}:exit`, `code=${code} signal=${signal}`));
}
const env = { ...process.env, NODE_ENV: "production", CAMPUS_LINK_BACKEND: "supabase" };
const options = { env, stdio: log ? ["ignore", "pipe", "pipe"] : "ignore", windowsHide: true };
let child;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child?.kill(signal));
child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], options);
if (log) attach(child, "build");
const built = await new Promise(resolve => child.on("exit", resolve));
if (built !== 0) { console.error("Hosted app build failed (server output suppressed)"); process.exit(1); }
// NODE_OPTIONS reads a backslash in a quoted value as an escape, so the Windows path uses forward slashes.
const preload = path.resolve("tests/e2e-hosted/server-log.cjs").replaceAll("\\", "/");
child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3207", "-H", "127.0.0.1"],
  log ? { ...options, env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require "${preload}"`.trim() } } : options);
if (log) attach(child, "start");
child.on("exit", code => process.exit(code ?? 1));
