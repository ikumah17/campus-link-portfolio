import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrivacySettings, HideTarget } from "@/data/demo-privacy";
import type { Affiliation } from "@/server/affiliation-master";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function privacyTargets(master: Affiliation[]): HideTarget[] {
  // Child labels name their parents: the same department or class name can exist in several branches.
  return master.flatMap(s => [{id:s.id,kind:"school" as const,label:s.name}, ...s.departments.flatMap(d => [{id:d.id,kind:"department" as const,label:`${s.name} / ${d.name}`}, ...d.classes.map(c => ({id:c.id,kind:"class" as const,label:`${s.name} / ${d.name} / ${c.name}`}))])]);
}
export async function loadMyPrivacy(client: Pick<SupabaseClient, "from">): Promise<{status:"ok";settings:PrivacySettings}|{status:"unauthenticated"|"unavailable"}> {
 try {
  const results = await Promise.all([client.from("privacy_settings").select("hide_same_class,hide_same_department,hide_same_school,show_department,show_class").limit(2),client.from("hidden_affiliations").select("school_id,department_id,class_id")]);
  if(results.some(r=>r.status===401 || ["PGRST301","PGRST302"].includes(r.error?.code ?? ""))) return {status:"unauthenticated"};
  if(results.some(r=>r.error || !Array.isArray(r.data))) return {status:"unavailable"};
  const rows=results[0].data!; if(rows.length>1) return {status:"unavailable"};
  const keys=["hide_same_class","hide_same_department","hide_same_school","show_department","show_class"] as const;
  const row=rows[0]; if(rows.length && (!row || typeof row!=="object" || keys.some(k=>typeof row[k]!=="boolean"))) return {status:"unavailable"};
  const settings:PrivacySettings={hideSameClass:row?.hide_same_class ?? true,hideSameDepartment:row?.hide_same_department ?? false,hideSameSchool:row?.hide_same_school ?? false,showDepartment:row?.show_department ?? false,showClass:row?.show_class ?? false,hiddenSchoolIds:[],hiddenDepartmentIds:[],hiddenClassIds:[]};
  for(const hidden of results[1].data!){
   const fields=["school_id","department_id","class_id"] as const;
   if(!hidden || typeof hidden!=="object" || fields.some(k=>hidden[k]!==null && (typeof hidden[k]!=="string" || hidden[k].length!==36 || !uuid.test(hidden[k]))) || fields.filter(k=>hidden[k]!==null).length!==1) return {status:"unavailable"};
   fields.forEach((k,i)=>{if(hidden[k]!==null) settings[(["hiddenSchoolIds","hiddenDepartmentIds","hiddenClassIds"] as const)[i]].push(hidden[k]);});
  }
  return {status:"ok",settings};
 }catch{return {status:"unavailable"};}
}

