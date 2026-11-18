// TEST-017: preloaded into `next start` only when CAMPUS_E2E_SERVER_LOG is set (server.mjs). Diagnosis only: it logs to
// stderr, which server.mjs timestamps into that file. Paths are written without their query, and no header, cookie,
// token or body is ever written. It changes no behavior: no handler is replaced and no error is caught.
const http = require("node:http");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const pathOf = url => { try { return new URL(url, "http://local").pathname; } catch { return "(unparsed path)"; } };
const line = text => process.stderr.write(`[e2e-log pid=${process.pid}] ${text}\n`);
let inFlight = 0, outgoing = 0;

// Incoming requests: start, then finish (status) or close before finishing, with the duration and the count in flight.
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, request, response) {
  if (event === "request" && response) {
    const started = Date.now(), label = `${request.method} ${pathOf(request.url)}`;
    inFlight++;
    line(`in start ${label} inFlight=${inFlight}`);
    let done = false;
    const end = how => { if (done) return; done = true; inFlight--; line(`in ${how} ${label} status=${response.statusCode} ms=${Date.now() - started} inFlight=${inFlight}`); };
    response.on("finish", () => end("finish"));
    response.on("close", () => end("close-before-finish"));
  }
  return emit.apply(this, arguments);
};

// Outgoing fetch (Supabase): method, host and path, then the status or the error class, with the duration.
const fetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
  let host = "(unparsed host)"; try { host = new URL(url).host; } catch { /* relative */ }
  const label = `${method} ${host}${pathOf(url)}`, started = Date.now();
  outgoing++;
  try {
    const response = await fetch.apply(this, arguments);
    line(`out ${label} status=${response.status} ms=${Date.now() - started} outgoing=${outgoing - 1}`);
    return response;
  } catch (error) {
    line(`out ${label} error=${error?.name ?? "unknown"}${error?.cause?.code ? `/${error.cause.code}` : ""} ms=${Date.now() - started} outgoing=${outgoing - 1}`);
    throw error;
  } finally { outgoing--; }
};

// Event-loop stalls: the largest delay in each 2 s window, when it passes 200 ms.
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
setInterval(() => {
  const max = Math.round(delay.max / 1e6);
  if (max >= 200) line(`event-loop max delay ms=${max} inFlight=${inFlight} outgoing=${outgoing} rssMiB=${Math.round(process.memoryUsage.rss() / 2 ** 20)}`);
  delay.reset();
}, 2000).unref();
process.on("uncaughtExceptionMonitor", (error, origin) => line(`uncaught ${origin} ${error?.name ?? "unknown"}`));
line("preload active");
