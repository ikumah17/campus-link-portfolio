import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const localDir = resolve(".e2e-hosted");
export type User = { id: string; email: string; password: string; name: string };
export type RunRoom = { path: string; participants: [number, number] };
// HOSTED-RET-001: users[0] is the expiring account U, users[1] the control K; photos are their object names.
export type Retention = { phase: "prepared" | "applying" | "applied" | "verified"; photos: [string[], string[]] };
// TEST-014: every object name the storage gate may create (fixtures and each probe's destination), saved before any request.
export type StorageObject = { bucket: "profile-photos" | "verification-documents"; name: string };
export type State = { runId: string; users: User[]; conversation?: string; profiles?: string[]; submissions?: string[]; revocationRooms?: RunRoom[];
  concurrency?: { adminId: string; roleUsers: number[] }; retention?: Retention; storage?: { objects: StorageObject[] } };
export function retentionMode(value = process.env.CAMPUS_E2E_RETENTION): "prepare" | "verify" | null {
  if (value === undefined || value === "") return null;
  if (value !== "prepare" && value !== "verify") throw new Error("CAMPUS_E2E_RETENTION must be prepare or verify");
  return value;
}
export function readState(): State { return JSON.parse(readFileSync(resolve(localDir, "run.json"), "utf8")); }
export function saveState(state: State) {
  mkdirSync(localDir, { recursive: true });
  writeFileSync(resolve(localDir, "run.json"), JSON.stringify(state), { mode: 0o600 });
}
export function environment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  if (result.NEXT_PUBLIC_SUPABASE_URL !== "https://exampleprojectrefabc.supabase.co") throw new Error("Hosted project is not the authorized dev project");
  return result;
}
export function credentials(): { admin: User; adminTotpSecret?: string } {
  const data = JSON.parse(readFileSync(".e2e-hosted.local.json", "utf8"));
  if (data.admin?.email !== "e2e-admin@example.invalid" || typeof data.admin.password !== "string" || !data.admin.password) throw new Error("Invalid fictional administrator configuration");
  return data;
}
export function evidence(key: string, value: unknown) {
  mkdirSync(localDir, { recursive: true });
  const path = resolve(localDir, "evidence.json");
  let data: Record<string, unknown> = {};
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { /* first entry */ }
  writeFileSync(path, JSON.stringify({ ...data, [key]: value }, null, 2));
}
export function resetEvidence(runId: string) {
  mkdirSync(localDir, { recursive: true });
  writeFileSync(resolve(localDir, "evidence.json"), JSON.stringify({ run: { runId } }, null, 2));
}
