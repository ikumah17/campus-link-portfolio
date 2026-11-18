/** SEC-009: browsers send violation reports here; the route logs a minimal summary and stores nothing. */
export const CSP_REPORT_PATH = "/api/csp-report";
/** Names the `report-to` group; send it on every response that carries the CSP. */
export const REPORTING_ENDPOINTS = `csp-endpoint="${CSP_REPORT_PATH}"`;

/** Fresh 128-bit nonce; never reuse it across requests. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export function buildCsp(nonce: string, { dev, supabaseUrl }: { dev: boolean; supabaseUrl?: string }): string {
  const connections = ["'self'"];
  if (supabaseUrl) {
    const url = new URL(supabaseUrl);
    connections.push(url.origin);
    url.protocol = "wss:";
    connections.push(url.origin);
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Next's development CSS injection needs inline styles; production uses nonces.
    `style-src 'self' ${dev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // The shared layout's favicon is a data: SVG. Profile images stay same-origin.
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${connections.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp-endpoint",
  ].join("; ") + ";";
}
