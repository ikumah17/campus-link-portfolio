// Creates (once) the fictional hosted test admin e2e-admin@example.invalid on campus-link-dev through the
// Supabase Auth Admin API, with a random password, and stores the credentials in the git-ignored
// .e2e-hosted.local.json. Reads the server key from .env.local and never prints it or the password.
//
//   node scripts/e2e-hosted/admin-user.mjs
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);
const env = Object.fromEntries(readFileSync(new URL(".env.local", ROOT), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!/^https:\/\/exampleprojectrefabc\.supabase\.co$/.test(url ?? "")) throw new Error("unexpected project URL");
if (!/^sb_secret_/.test(key ?? "")) throw new Error("missing server key");

const store = new URL(".e2e-hosted.local.json", ROOT);
const local = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
if (local.admin?.id) { console.log(JSON.stringify({ ok: true, existing: true, id: local.admin.id })); process.exit(0); }

const email = "e2e-admin@example.invalid";
const password = randomBytes(24).toString("base64url");
const res = await fetch(`${url}/auth/v1/admin/users`, {
  method: "POST",
  headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ email, password, email_confirm: true }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok || !body.id) { console.log(JSON.stringify({ ok: false, status: res.status, code: body.error_code ?? body.code ?? null })); process.exit(1); }
local.admin = { id: body.id, email, password };
writeFileSync(store, JSON.stringify(local, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ok: true, id: body.id, email }));
