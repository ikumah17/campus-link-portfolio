"use server";
import "server-only";
import { revalidatePath } from "next/cache";
import { backendMode } from "@/lib/backend";
import { createServerSupabase } from "@/lib/supabase/server";
import { callRpc } from "@/server/rpc";
export type PrivacySaveStatus="ok"|"invalid"|"rate_limited"|"unauthenticated"|"forbidden"|"unavailable";
export async function savePrivacySettings(input:unknown):Promise<{status:PrivacySaveStatus}>{
 try{
  if(backendMode()==="demo")return {status:"unavailable"};
  if(!input || typeof input!=="object")return {status:"invalid"};
  const r=input as Record<string,unknown>;
  const flags=["hideSameClass","hideSameDepartment","hideSameSchool","showDepartment","showClass"];
  const arrays=["hiddenSchoolIds","hiddenDepartmentIds","hiddenClassIds"];
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if(flags.some(k=>typeof r[k]!=="boolean") || arrays.some(k=>!Array.isArray(r[k]) || [...r[k]].some(id=>typeof id!=="string" || id.length!==36 || !uuid.test(id)) || new Set(r[k]).size!==r[k].length))return {status:"invalid"};
  if(arrays.reduce((n,k)=>n+(r[k] as string[]).length,0)>50)return {status:"invalid"};
  const result=await callRpc(await createServerSupabase(),"update_privacy_settings",{p_hide_same_class:r.hideSameClass,p_hide_same_department:r.hideSameDepartment,p_hide_same_school:r.hideSameSchool,p_show_department:r.showDepartment,p_show_class:r.showClass,p_hidden_school_ids:r.hiddenSchoolIds,p_hidden_department_ids:r.hiddenDepartmentIds,p_hidden_class_ids:r.hiddenClassIds});
  const status:PrivacySaveStatus=result.code==="validation"?"invalid":["ok","rate_limited","unauthenticated","forbidden"].includes(result.code)?result.code as PrivacySaveStatus:"unavailable";
  if(status==="ok")revalidatePath("/settings/privacy");return {status};
 }catch{return {status:"unavailable"};}
}
