// SEC-009: CSP violation reports. Stores nothing and logs only the directive, the blocked origin, the document path
// and the disposition, never a query, an IP, a user agent or a cookie. The CSP is sent in both backend modes, so this
// route works in both. Every POST answers 204 so a bad body reveals nothing.
const MAX_REPORT_BYTES = 16 * 1024;
const MAX_REPORTS = 20;
const LOG_PREFIX = "[csp-report]";

const done = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
const notAllowed = () => new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });

/** Reads at most MAX_REPORT_BYTES; undefined when the body is larger, whatever Content-Length claimed. */
async function boundedText(request: Request): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REPORT_BYTES)) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done: finished, value } = await reader.read();
    if (finished) break;
    total += value.byteLength;
    if (total > MAX_REPORT_BYTES) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function directive(value: unknown): string {
  // Legacy violated-directive can carry the policy's source list: keep only the directive name.
  const name = typeof value === "string" ? value.trim().split(/\s+/)[0] : "";
  return /^[a-z-]{1,40}$/.test(name) ? name : "unknown";
}

function blockedOrigin(value: unknown): string {
  if (typeof value !== "string" || value === "") return "unknown";
  if (["inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink"].includes(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "ws:" || url.protocol === "wss:") return url.origin;
    // data:, blob: and similar have no useful origin: the scheme alone says enough.
    return /^[a-z][a-z0-9+.-]{0,20}:$/.test(url.protocol) ? url.protocol : "unknown";
  } catch {
    return "unknown";
  }
}

function documentPath(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  try {
    const path = new URL(value).pathname;
    return path.length <= 200 ? path : path.slice(0, 200);
  } catch {
    return "unknown";
  }
}

const disposition = (value: unknown) => (value === "enforce" || value === "report" ? value : "unknown");

function log(fields: { directive: unknown; blocked: unknown; document: unknown; disposition: unknown }) {
  console.warn(`${LOG_PREFIX} ${JSON.stringify({
    directive: directive(fields.directive),
    blocked: blockedOrigin(fields.blocked),
    document: documentPath(fields.document),
    disposition: disposition(fields.disposition),
  })}`);
}

export async function POST(request: Request) {
  try {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/csp-report" && type !== "application/reports+json") return done();
    const text = await boundedText(request);
    if (text === undefined) return done();
    const parsed: unknown = JSON.parse(text);
    if (type === "application/csp-report") {
      const report = record(record(parsed)?.["csp-report"]);
      if (report) log({
        directive: report["effective-directive"] ?? report["violated-directive"],
        blocked: report["blocked-uri"],
        document: report["document-uri"],
        disposition: report.disposition,
      });
    } else if (Array.isArray(parsed)) {
      for (const entry of parsed.slice(0, MAX_REPORTS)) {
        const report = record(entry);
        const body = record(report?.body);
        if (report?.type !== "csp-violation" || !body) continue;
        log({ directive: body.effectiveDirective, blocked: body.blockedURL, document: body.documentURL, disposition: body.disposition });
      }
    }
  } catch {
    // Malformed reports are dropped silently.
  }
  return done();
}

export const GET = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;
export const OPTIONS = notAllowed;
