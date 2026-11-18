export function backendMode(): "demo" | "supabase" {
  return process.env.CAMPUS_LINK_BACKEND === "supabase" ? "supabase" : "demo";
}
