export class ConfigError extends Error {
  constructor(variable: string) {
    super(`Invalid or missing ${variable}`);
    this.name = "ConfigError";
  }
}

function isPublicKey(key: string): boolean {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const payload = key.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))).role === "anon";
  } catch {
    return false;
  }
}

export function supabasePublicConfig(): { url: string; publishableKey: string } {
  // Static env references are required for Next.js to inline these public values in browser bundles.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !/^(?:https:\/\/[a-z0-9-]+\.supabase\.co|http:\/\/(?:127\.0\.0\.1|localhost):54321)\/?$/.test(url)) {
    throw new ConfigError("NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!publishableKey || !isPublicKey(publishableKey)) {
    throw new ConfigError("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }
  return { url, publishableKey };
}
